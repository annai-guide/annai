import { callOnce, enabledProviderTools } from './call.js';
import { ProviderError } from './contract.js';
import { NO_USAGE, addUsage, addCost } from './cost.js';
import { modelOf, endpointOf, CHAT_ROLES } from './config.js';
import { ROLE_LEVELS } from './reasoning.js';

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
  /** @param {string} id @param {number} ms */
  bench(id, ms, now = Date.now()) {
    this.#until.set(id, Math.max(this.#until.get(id) ?? 0, now + ms));
  }
  /** @param {string} id */
  until(id) {
    return this.#until.get(id) ?? 0;
  }
  /** @param {string} id */
  clear(id) {
    this.#until.delete(id);
  }
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

/** The models a role tries, in order: its own, or the main list for an empty chat role. @param {ModelConfig} config @param {string} role */
export function candidates(config, role) {
  const own = config.roles[role]?.models ?? [];
  if (own.length || role === 'main' || !CHAT_ROLES.includes(role)) return own;
  return config.roles.main?.models ?? [];
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
 *   keyFor: (endpointId: string) => Promise<string | null>, bench: Bench, fetch?: import('./call.js').Fetch, signal?: AbortSignal,
 *   onEvent?: (e: import('./contract.js').StreamEvent) => void, trace?: import('./call.js').ModelTrace, registry?: import('../registry.js').Registry,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, firstOutputMs?: number,
 *   prefer?: string, record?: { tag?: string, wake?: string, prefix?: string, context?: { from: number, to: number }, keepParts?: boolean },
 *   repairImages?: (err: ProviderError, modelId: string, request: Request) => Promise<Request | null>, uploads?: import('./uploads.js').Uploads }} c
 *   record: what the model.turn notes besides the call; keepParts keeps the reply's parts so the conversation can be rebuilt
 *   repairImages: asked for a repaired request when a model refuses a photo; the same model is then tried again, at most twice (spec §9.9)
 *   uploads: photos uploaded to providers; an upload a provider no longer knows is forgotten, and the same model tried once more
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
  /**
   * @param {string | null} answeredBy @param {string} text @param {string} [stop] @param {string} [reasoning]
   * @param {import('./contract.js').Part[]} [parts] @param {{ url: string, title?: string }[]} [citations]
   */
  const record = (answeredBy, text, stop, reasoning, parts, citations) => c.trace?.turn(
    { role, level, answeredBy, attempts, usage, cost, ...meta, ...(stop ? { stop } : {}), ...(citations?.length ? { citations } : {}) },
    text, reasoning, keepParts ? parts : undefined);
  // How long to wait for the first words: the caller's limit, else the role's own setting (spec §9.6: configurable).
  const firstOutputMs = c.firstOutputMs ?? (config.roles[role]?.firstOutputSeconds ?? 30) * 1000;
  const list = candidates(config, role);
  // The model holding a warm cache goes first: switching back waits until its cache is cold (spec §9.6).
  const ordered = c.prefer && list.includes(c.prefer) ? [c.prefer, ...list.filter((x) => x !== c.prefer)] : list;
  for (const id of ordered) {
    const rec = config.models[id];
    const epRec = rec ? config.endpoints[rec.endpoint] : undefined;
    const type = epRec ? types.get(epRec.type) : undefined;
    const model = rec ? modelOf(rec) : null;
    const skip = !rec || !epRec || !model ? 'removed' : !type ? 'type-missing' : bench.until(id) > now() ? 'benched' : gap(model, request);
    if (skip || !model || !type || !epRec) {
      attempts.push({ model: id, name: model?.name ?? id, outcome: skip ?? 'removed', ms: 0 });
      continue;
    }
    const endpoint = endpointOf(epRec, type.tunables);
    const key = await c.keyFor(endpoint.id);
    let repairs = 0;
    let uploadRetries = 0;
    for (let retry = 0; ; retry++) {
      const started = now();
      try {
        const reply = await callOnce({
          type, endpoint, model, key, request, level, fetch: c.fetch, signal: c.signal, onEvent: c.onEvent,
          trace: c.trace, registry: c.registry, now, firstOutputMs, uploads: c.uploads,
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
          await c.uploads.forget(epRec.id);
          uploadRetries++;
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
        if (step.bench !== undefined) bench.bench(id, step.bench, now());
        break;
      }
    }
  }
  await record(null, said);
  throw new AllFailedError(attempts, said);
}
