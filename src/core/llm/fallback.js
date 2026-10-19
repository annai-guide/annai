import { callOnce, enabledProviderTools } from './call.js';
import { ProviderError } from './contract.js';
import { NO_USAGE, addUsage, addCost } from './cost.js';
import { modelOf, endpointOf, providerOf, sendKey, abilityOf, CHAT_ROLES, KOE_ROLES } from './config.js';
import { ROLE_LEVELS } from './reasoning.js';
import { adjusted } from './setup.js';
import { formatRefused } from '../voice/formats.js';

/**
 * Roles and fallback (spec §9.6). A role's models are tried front to back; an empty chat role uses
 * the main list. Models that can't take the request are skipped, a model that fails rests (it is
 * "benched") for a while, and a model that answers, even to decline, is the answer.
 * @typedef {import('./config.js').ModelConfig} ModelConfig
 * @typedef {import('./config.js').Model} Model
 * @typedef {import('./contract.js').Request} Request
 * @typedef {import('./contract.js').EndpointType} EndpointType
 * @typedef {import('./call.js').Reply} Reply
 * @typedef {import('./trace.js').Attempt} Attempt
 */

export const COOLDOWN_MS = 3 * 60_000;
export const SHORT_WAIT_MS = 10_000;
export const OVERLOAD_RETRIES = Object.freeze([500, 1500]);
export const NETWORK_RETRIES = Object.freeze([1000, 3000]);

/** Models resting after a failure, until a time. One per run of annai. */
export class Bench {
  /** @type {Map<string, number>} */
  #until = new Map();
  /** Why a model rests, when that is worth saying while it does. @type {Map<string, string>} */
  #why = new Map();
  /** @param {string} id @param {number} ms @param {number} [now] @param {string} [why] */
  bench(id, ms, now = Date.now(), why) {
    this.#until.set(id, Math.max(this.#until.get(id) ?? 0, now + ms));
    if (why) this.#why.set(id, why);
    else this.#why.delete(id);
  }
  /** @param {string} id */
  until(id) {
    return this.#until.get(id) ?? 0;
  }
  /** @param {string} id */
  why(id) {
    return this.#why.get(id);
  }
  /** @param {string} id */
  clear(id) {
    this.#until.delete(id);
    this.#why.delete(id);
  }
}

/** A rest longer than this is a provider's day limit, said plainly (not in its billing words). */
export const LONG_REST_MS = 10 * 60_000;

/** A long rest in plain words, with the local time it ends. @param {number} until @param {number} now */
export function restText(until, now) {
  const end = new Date(until);
  const time = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `its daily limit is used up; it rests until ${end.toDateString() === new Date(now).toDateString() ? time : `${end.toLocaleDateString([], { weekday: 'long' })} ${time}`}`;
}

/** Every model of a role failed. attempts says how; said is any text a reply had already given. */
export class AllFailedError extends Error {
  /** @param {Attempt[]} attempts @param {string} [said] */
  constructor(attempts, said = '') {
    super("Shiori can't reach her model.");
    this.name = 'AllFailedError';
    this.attempts = attempts;
    this.said = said;
  }
}

/**
 * The models a role tries, in order: its own, or the main list for an empty chat role. An empty Koe
 * list uses the other Koe list, and never Main: no Koe model means no Koe. @param {ModelConfig} config @param {string} role
 */
export function candidates(config, role) {
  const own = config.roles?.[role]?.models ?? [];
  if (own.length || role === 'main') return own;
  if (KOE_ROLES.includes(role)) return config.roles?.[KOE_ROLES.find((r) => r !== role) ?? '']?.models ?? [];
  if (!CHAT_ROLES.includes(role)) return own;
  return config.roles.main?.models ?? [];
}

/** Koe's list (the Koe and Kokoro design): voice on uses "Koe for talking", else "Koe for typing", an empty one the other. @param {ModelConfig} cfg @param {boolean} voiceOn */
export function koeList(cfg, voiceOn) {
  const role = voiceOn ? 'koe-talk' : 'koe-type';
  return { role, models: candidates(cfg, role) };
}

/** Whether Shiori is two halves: a Koe list holds a model. @param {ModelConfig} cfg */
export const splitOn = (cfg) => KOE_ROLES.some((r) => (cfg.roles?.[r]?.models ?? []).length > 0);

/**
 * Koe's pathway now (K5): the first model that can answer, in its list, then the other Koe list (a live model that can't go
 * on falls back to the typing models and the speech pipeline: the design, "Failures"). A realtime one runs a live session;
 * a chat one, the loop, with the list it is in (whose realtime models it passes over). A realtime model off, resting or
 * without its protocol running is passed over, and a chat model resting. null: none can. @param {ModelConfig} cfg
 * @param {{ voiceOn: boolean, types: Map<string, { realtime?: boolean }>, until: (id: string) => number, now: number }} o
 * @returns {{ kind: 'live', modelId: string } | { kind: 'text', role: string } | null}
 */
export function koePath(cfg, { voiceOn, types, until, now }) {
  const own = koeList(cfg, voiceOn).role;
  for (const role of [own, KOE_ROLES.find((r) => r !== own) ?? own]) {
    for (const id of candidates(cfg, role)) {
      const a = abilityOf(cfg, id);
      if (!cfg.models[id] || until(id) > now) continue;
      if (a?.kind !== 'realtime') return { kind: 'text', role };
      if (a.on && types.get(a.type)?.realtime) return { kind: 'live', modelId: id };
    }
  }
  return null;
}

/** A rough token count, enough to skip models whose window is clearly too small. @param {Request} request */
export function estimateTokens(request) {
  let chars = (request.system ?? '').length + JSON.stringify(request.tools ?? []).length;
  let images = 0;
  for (const m of request.messages) {
    for (const p of m.parts) {
      if (p.type === 'image') images++;
      else chars += JSON.stringify(p).length;
    }
  }
  return Math.ceil(chars / 3.5) + images * 1600 + (request.maxOutput ?? 0);
}

/** Why a model can't take this request, or null (spec §9.6: the list also handles capability gaps). @param {Model} model @param {Request} request */
export function gap(model, request) {
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'image')) && !model.input.includes('image')) return 'no-images';
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'audio')) && !model.input.includes('audio')) return 'no-audio';
  if (request.tools?.length && model.tools === false) return 'no-tools';
  if (request.needsProviderTool && !enabledProviderTools(model, request).some((t) => t.kind === request.needsProviderTool)) return 'no-provider-tool';
  if (model.contextWindow && estimateTokens(request) > model.contextWindow) return 'too-long';
  return null;
}

/** The request again, telling the next model what the cut-off reply had said. @param {Request} request @param {string} said @returns {Request} */
export function continueAfter(request, said) {
  const note = `[annai: your reply was cut off by a connection problem. You had already said: "${said}✂". Continue exactly where it stops, without repeating any of it.]`;
  return { ...request, messages: [...request.messages, { role: 'user', parts: [{ type: 'text', text: note }] }] };
}

/** @param {ProviderError} err @param {number} retry @returns {{ wait?: number, bench?: number }} */
function nextStep(err, retry) {
  switch (err.kind) {
    case 'overloaded':
      return retry < OVERLOAD_RETRIES.length ? { wait: OVERLOAD_RETRIES[retry] } : { bench: COOLDOWN_MS };
    case 'rate':
      return err.retryAfter !== undefined && err.retryAfter <= SHORT_WAIT_MS && retry === 0 ? { wait: err.retryAfter } : { bench: err.retryAfter ?? COOLDOWN_MS };
    case 'network':
    case 'server':
      return retry < NETWORK_RETRIES.length ? { wait: NETWORK_RETRIES[retry] } : { bench: COOLDOWN_MS };
    case 'context':
    case 'image':
    case 'upload':
    case 'bad-request':
      return {};
    default:
      return { bench: COOLDOWN_MS };
  }
}

/** The reply with what an earlier, cut-off reply had said in front of its text. @param {Reply} reply @param {string} said @returns {Reply} */
function prefixed(reply, said) {
  const parts = reply.parts.slice();
  const i = parts.findIndex((p) => p.type === 'text');
  if (i >= 0) parts[i] = { type: 'text', text: said + /** @type {any} */ (parts[i]).text };
  else parts.unshift({ type: 'text', text: said });
  return { ...reply, parts, text: said + reply.text };
}

const defaultSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls a role's models in order until one answers (spec §9.6), and records the whole call as
 * one model.turn in the trace.
 * @param {{ role: string, request: Request, level?: string, config: ModelConfig, types: Map<string, EndpointType>,
 *   keyFor: (providerId: string) => Promise<string | null>, bench: Bench, fetch?: import('./call.js').Fetch, signal?: AbortSignal,
 *   onEvent?: (e: import('./contract.js').StreamEvent) => void, trace?: import('./call.js').ModelTrace, registry?: import('../registry.js').Registry,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, firstOutputMs?: number,
 *   prefer?: string, record?: { tag?: string, wake?: string, prefix?: string, context?: { from: number, to: number }, keepParts?: boolean },
 *   repairImages?: (err: ProviderError, modelId: string, request: Request) => Promise<Request | null>, uploads?: import('./uploads.js').Uploads,
 *   speech?: (model: Model, request: Request, plain?: boolean, signal?: AbortSignal) => Promise<Request>, models?: string[] }} c
 *   models: the models to try in place of the role's list ("Try this model" passes one: no fallback)
 *   record: what the model.turn notes besides the call; keepParts keeps the reply's parts so the conversation can be rebuilt
 *   repairImages: asked for a repaired request when a model refuses a photo; the same model is then tried again, at most twice (spec §9.9)
 *   uploads: photos uploaded to providers; an upload a provider no longer knows is forgotten, and the same model tried once more
 *   speech: resolves heard speech for the model about to be called (spec §10.3); a throw means nothing in the speech-in list can reach it, and the model is skipped;
 *   plain: the model refused the audio format it was sent, so send WAV; signal: the call's
 * @returns {Promise<{ reply: Reply, attempts: Attempt[], usage: import('./contract.js').Usage, cost: number | undefined, answeredBy: string, modelId: string }>}
 */
export async function callRole(c) {
  const { role, config, types, bench, now = Date.now, sleep = defaultSleep } = c;
  const level = c.level ?? config.roles[role]?.level ?? /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off';
  /** @type {Attempt[]} */
  const attempts = [];
  let request = c.request;
  let said = '';
  let usage = { ...NO_USAGE };
  /** @type {number | undefined} */
  let cost;
  const { keepParts, ...meta } = c.record ?? {};
  // A plugin's call is its own in the trace too, so its hooks don't get the requests it caused (fix pass 8b-1).
  const trace = c.trace && typeof meta.tag === 'string' && meta.tag.startsWith('plugin:')
    ? { ...c.trace, request: (/** @type {any} */ i) => /** @type {any} */ (c.trace).request({ ...i, tag: meta.tag }) } : c.trace;
  /**
   * @param {string | null} answeredBy @param {string} text @param {string} [stop] @param {string} [reasoning]
   * @param {import('./contract.js').Part[]} [parts] @param {{ url: string, title?: string }[]} [citations]
   */
  const record = (answeredBy, text, stop, reasoning, parts, citations) => c.trace?.turn(
    { role, level, answeredBy, attempts, usage, cost, ...meta, ...(stop ? { stop } : {}), ...(citations?.length ? { citations } : {}) },
    text, reasoning, keepParts ? parts : undefined);
  // How long to wait for the first words: the caller's limit, else the role's own setting (spec §9.6: configurable); Koe answers at once.
  const firstOutputMs = c.firstOutputMs ?? (config.roles[role]?.firstOutputSeconds ?? (KOE_ROLES.includes(role) ? 8 : 30)) * 1000;
  const list = c.models ?? candidates(config, role);
  // The model holding a warm cache goes first: switching back waits until its cache is cold (spec §9.6).
  const ordered = c.prefer && list.includes(c.prefer) ? [c.prefer, ...list.filter((x) => x !== c.prefer)] : list;
  let began = false;
  for (const id of ordered) {
    const rec = config.models[id];
    const pRec = rec ? config.providers[rec.provider] : undefined;
    const provider = pRec ? providerOf(pRec) : null;
    const ability = rec && provider ? provider.abilities[rec.ability] : undefined;
    const type = ability ? types.get(ability.type) : undefined;
    const model = rec ? modelOf(rec) : null;
    // A model of a switched-off ability is skipped as off; calls never install a missing type (decision 9).
    const skip = !rec || !ability || !model ? 'removed' : !ability.on ? 'off' : !type ? 'type-missing' : type.speech || type.realtime ? 'not-chat' : bench.until(id) > now() ? 'benched' : gap(model, request);
    if (skip || !model || !type || !pRec || !provider) {
      const why = skip === 'benched' ? bench.why(id) : undefined;
      attempts.push({ model: id, name: model?.name ?? id, outcome: skip ?? 'removed', ms: 0, ...(why ? { error: why } : {}) });
      continue;
    }
    // One key per provider; a provider with keyHeader sends it in that header (decision 25). The trace learns it
    // first, whatever the header's name, as the protocol then gets none to tell it (fix pass). Its plugin's
    // setup may add headers and sharpen error kinds (decision 15).
    const own = await c.keyFor(pRec.id);
    if (own) c.trace?.secret(own);
    const set = adjusted(c.registry, pRec.plugin, type, endpointOf(pRec, rec.ability, type.tunables), provider.keyHeader);
    const { endpoint, key } = sendKey(set.endpoint, own, provider.keyHeader);
    let repairs = 0;
    let uploadRetries = 0;
    let plain = false;
    for (let retry = 0; ; retry++) {
      // Heard speech is resolved against the model actually receiving it, at every attempt (spec §10.3).
      let sendable = request;
      if (c.speech) {
        try {
          sendable = await c.speech(model, request, plain, c.signal);
        } catch (e) {
          attempts.push({ model: id, name: model.name, outcome: 'no-speech', ms: 0, error: String(/** @type {any} */ (e)?.message ?? e) });
          break;
        }
      }
      if (began) c.onEvent?.({ type: 'restart' });
      began = true;
      const started = now();
      try {
        const reply = await callOnce({
          type: set.type, endpoint, model, key, request: sendable, level, fetch: c.fetch, signal: c.signal, onEvent: c.onEvent,
          trace, registry: c.registry, now, firstOutputMs, uploads: c.uploads,
        });
        usage = addUsage(usage, reply.usage);
        cost = addCost(cost, reply.cost);
        attempts.push({ model: id, name: model.name, outcome: 'ok', ms: now() - started, ...(reply.cost !== undefined ? { cost: reply.cost } : {}) });
        const full = said ? prefixed(reply, said) : reply;
        const reasoning = full.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).filter(Boolean).join('\n\n');
        await record(model.name, full.text, reply.stop, reasoning, full.parts, reply.citations);
        return { reply: full, attempts, usage, cost, answeredBy: model.name, modelId: id };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e));
        attempts.push({ model: id, name: model.name, outcome: err.kind, ms: now() - started, error: err.message });
        if (err.kind === 'cancelled') {
          await record(null, said + err.partial);
          throw err;
        }
        if (err.partial) {
          // Handled like an interruption: the next model continues from here.
          said += err.partial;
          request = continueAfter(c.request, said);
          break;
        }
        if (err.kind === 'upload' && c.uploads && uploadRetries < 1) {
          // An expired or unknown upload (spec §9.9): upload again, once.
          await c.uploads.forget(endpoint.id);
          uploadRetries++;
          continue;
        }
        if (err.kind === 'bad-request' && !plain && formatRefused(err.message) && sendable.messages.some((m) => m.parts.some((p) => p.type === 'audio' && p.mediaType !== 'audio/wav'))) {
          // An audio format the model refused (spec §10.6): the same model again, with WAV, once.
          plain = true;
          continue;
        }
        if (err.kind === 'image' && c.repairImages && repairs < 2) {
          const fixed = await c.repairImages(err, id, request).catch((/** @type {unknown} */ x) => { console.warn('the photo repair failed', x); return null; });
          if (fixed) {
            repairs++;
            request = fixed;
            continue; // the same model again (spec §9.9)
          }
        }
        const step = nextStep(err, retry);
        if (step.wait !== undefined) {
          await sleep(step.wait);
          continue;
        }
        if (step.bench !== undefined) {
          const long = err.kind === 'rate' && step.bench > LONG_REST_MS ? restText(now() + step.bench, now()) : undefined;
          if (long) attempts[attempts.length - 1].error = long;
          bench.bench(id, step.bench, now(), long);
        }
        break;
      }
    }
  }
  await record(null, said);
  throw new AllFailedError(attempts, said);
}
