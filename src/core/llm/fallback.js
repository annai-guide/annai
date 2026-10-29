import { callOnce, enabledProviderTools } from './call.js';
import { t } from '../l10n.js';
import { when, sentences } from '../intl.js';
import { dayIn, timeIn, deviceZone } from '../time.js';
import { ProviderError, portable, explain, explainPlain, saidWords } from './contract.js';
import { NO_USAGE, addUsage, addCost } from './cost.js';
import { modelOf, endpointOf, providerOf, sendKey, abilityOf, CHAT_ROLES, KOE_REALTIME, KOE_CLASSIC } from './config.js';
import { ROLE_LEVELS } from './reasoning.js';
import { adjusted } from './setup.js';
import { formatRefused } from '../voice/formats.js';
import { SYS } from '../scopes.js';
import { NOT_TRANSCRIBED } from '../voice/resolve.js';
import { shownFor } from '../errors.js';
import { limitImages } from '../agent/refusals.js';

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
  /** What failed, for a rest only the user can end (a refused key, no credit): such a model isn't asked anyway. @type {Map<string, string>} */
  #kind = new Map();
  /** @param {string} id @param {number} ms @param {number} [now] @param {string} [why] @param {string} [kind] the failure's kind */
  bench(id, ms, now = Date.now(), why, kind) {
    if (kind) this.#kind.set(id, kind);
    else this.#kind.delete(id);
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
  /** Whether it rests after a failure only the user can end: its key refused, or out of credit. @param {string} id */
  usersToEnd(id) {
    return ['auth', 'credit'].includes(this.#kind.get(id) ?? '');
  }
  /** @param {string} id */
  clear(id) {
    this.#until.delete(id);
    this.#kind.delete(id);
    this.#why.delete(id);
  }
  /** Models that refused a required tool call (Request.toolRequired): they aren't asked for one again this run. */
  unforced = new Set();
}

/** A refusal of a required tool call, by its words: "tool_choice", or "required" about a tool. @param {string} message */
const refusesRequired = (message) => /tool_?choice/i.test(message) || (/\brequired\b/i.test(message) && /\btool/i.test(message));

/** A rest longer than this is a provider's day limit, said plainly (not in its billing words). */
export const LONG_REST_MS = 10 * 60_000;

/**
 * A long rest in plain English, with the time it ends on a 24-hour clock ("17:00", "Friday 17:00"): models read it (Koe's note, a photo's
 * stand-in) and code finds the attempt by its restsUntil, so no language changes it. The user's sentence is made in failedText.
 * @param {number} until @param {number} now
 */
export function restText(until, now) {
  const tz = deviceZone();
  const day = dayIn(until, tz) === dayIn(now, tz) ? '' : `${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(until)} `;
  return /* en */ `its daily limit is used up; it rests until ${day}${timeIn(until, tz)}`;
}

/** Every model of a role failed. attempts says how; said is any text a reply had already given. */
export class AllFailedError extends Error {
  /** @param {Attempt[]} attempts @param {string} [said] */
  constructor(attempts, said = '') {
    super(/* en */ "Shiori can't reach her model.");
    this.name = /* en */ 'AllFailedError';
    this.shown = shownFor(this.name);
    this.attempts = attempts;
    this.said = said;
  }
}

/** Why a model was passed over without being asked, in words a model reads (the codes stay in the Trace). */
/* en */
const PASSED = Object.freeze({
  benched: 'It is resting for a few minutes after an error.', 'no-images': "It doesn't take photos.", 'no-documents': "It doesn't read PDFs.", 'no-audio': "It doesn't take audio.",
  'no-tools': "It can't use tools.", 'too-long': 'The conversation is too long for it.', 'no-provider-tool': "It doesn't have the provider tool this needs.",
  'not-chat': "It isn't a chat model.", off: 'It is switched off.', removed: 'It was removed.', 'no-speech': "The speech couldn't be sent to it.",
});

/** The same, for the user, in the screens' language. @param {string} outcome */
function passedShown(outcome) {
  switch (outcome) {
    case 'benched': return t`It is resting for a few minutes after an error.`;
    case 'no-images': return t`It doesn't take photos.`;
    case 'no-documents': return t`It doesn't read PDFs.`;
    case 'no-audio': return t`It doesn't take audio.`;
    case 'no-tools': return t`It can't use tools.`;
    case 'too-long': return t`The conversation is too long for it.`;
    case 'no-provider-tool': return t`It doesn't have the provider tool this needs.`;
    case 'not-chat': return t`It isn't a chat model.`;
    case 'off': return t`It is switched off.`;
    case 'removed': return t`It was removed.`;
    case 'no-speech': return t`The speech couldn't be sent to it.`;
    default: return null;
  }
}

/**
 * Why one model failed, in words: a provider's own as it gave them; annai's by kind, or from what one of its own was (said), in the screens'
 * language unless a model reads them (plain). The "Try this model" panel says it too.
 * @param {{ name: string, outcome: string, error?: string, said?: import('./contract.js').Said, restsUntil?: number, [k: string]: unknown }} a
 * @param {{ now?: number, plain?: boolean }} [o] @returns {string}
 */
export function attemptWhy(a, { now = Date.now(), plain = false } = {}) {
  const said = a.outcome === 'unreachable' ? '' : !plain && a.said ? saidWords(a.said, a.outcome) : a.error ?? '';
  const kind = new ProviderError(/** @type {any} */ (a.outcome), a.outcome);
  let why = said || (plain ? /** @type {Record<string, string>} */ (PASSED)[a.outcome] ?? explainPlain(kind) : passedShown(a.outcome) ?? explain(kind));
  if (a.restsUntil && !plain) {
    // A day limit: the user's sentence is a whole message, with the time as their phone writes it.
    const clock = when(a.restsUntil, undefined, { hour: '2-digit', minute: '2-digit' });
    const at = dayIn(a.restsUntil, deviceZone()) === dayIn(now, deviceZone()) ? clock : `${when(a.restsUntil, undefined, { weekday: 'long' })} ${clock}`;
    why = t`Its daily limit is used up; it rests until ${at}.`;
  } else if (said) {
    // A provider's words as a sentence, though annai's name stays lower case.
    if (!why.startsWith('annai')) why = why.charAt(0).toUpperCase() + why.slice(1);
    if (!/[.!?。！？]$/u.test(why)) why += '.';
  }
  return why;
}

/**
 * Why every model failed, for a card (emulator pass): one line per model, each reason once and in words; a failure to
 * connect is annai's words, not the browser's, and with no connection on the device, that is said once instead.
 * @param {Parameters<typeof attemptWhy>[0][]} attempts @param {{ offline?: boolean, now?: number, plain?: boolean }} [o] plain: for a model to read, in annai's English and never the screens' words
 */
export function failedText(attempts, { offline = false, now = Date.now(), plain = false } = {}) {
  /** @type {Map<string, Set<string>>} */
  const lines = new Map();
  for (const [i, a] of attempts.entries()) {
    if (a.outcome === 'ok' || (offline && (a.outcome === 'unreachable' || a.outcome === 'network'))) continue;
    // A model passed over for a file it can't take, then asked again with the file read (callRole's second pass): its later reason is
    // the one that counts; the Trace keeps both.
    if ((a.outcome === 'no-images' || a.outcome === 'no-documents' || a.outcome === 'benched') && attempts.slice(i + 1).some((b) => b.name === a.name)) continue;
    if (!lines.has(a.name)) lines.set(a.name, new Set());
    lines.get(a.name)?.add(attemptWhy(a, { now, plain }));
  }
  /* en */
  const offlineLine = plain ? 'This device is offline.' : t`This device is offline.`;
  return [...(offline ? [offlineLine] : []), ...[...lines].map(([name, why]) => named(name, plain ? [...why].join(' ') : sentences(...why), plain))].join('\n');
}

/** "Name: words", a label and what it says: in the screens' punctuation, or annai's English for a model. @param {string} name @param {string} words @param {boolean} plain */
const named = (name, words, plain) => (plain ? `${name}: ${words}` : t`${name}: ${words}`);

/**
 * Why a model call failed, as data a card, the log and a model each make their words from (the design, "Store data, not words"):
 * how each model failed (attempts), that no model is set for a role, an error's kind, or another error's own message; halves: both of
 * Shiori's halves are down, each for its reasons.
 * @typedef {{ attempts?: Pick<Attempt, 'name' | 'outcome' | 'error' | 'said' | 'restsUntil'>[], offline?: boolean, role?: string, kind?: string, message?: string,
 *   provider?: string, said?: import('./contract.js').Said, name?: string, halves?: { koe: Why, kokoro: Why } }} Why  name: an error annai has words for (errors.js shownFor)
 */

/** @param {unknown} e @param {{ role?: string, online?: boolean }} [o] @returns {Why} */
export function whyOf(e, { role = 'main', online = true } = {}) {
  if (e instanceof AllFailedError) {
    if (!e.attempts.length) return { role };
    return { attempts: e.attempts.map((a) => ({ name: a.name, outcome: a.outcome, ...(a.error ? { error: a.error } : {}), ...(a.said ? { said: a.said } : {}), ...(a.restsUntil ? { restsUntil: a.restsUntil } : {}) })), ...(online ? {} : { offline: true }) };
  }
  if (e instanceof ProviderError) return { kind: e.kind, message: e.message, ...(e.provider ? { provider: e.provider } : {}), ...(e.said ? { said: e.said } : {}) };
  // An error annai names keeps its name, from which a screen makes its words; any other, its message as it was.
  const name = /** @type {any} */ (e)?.name;
  return { message: String(/** @type {any} */ (e)?.message ?? e), ...(typeof name === 'string' && shownFor(name) ? { name } : {}) };
}

/**
 * Why's words: for the user in the screens' language, or (plain) annai's English for a model and the log. @param {Why} why @param {boolean} [plain]
 * @returns {string}
 */
export function whyWords(why, plain = false) {
  if (why.halves) {
    const lines = (/** @type {string} */ name, /** @type {Why} */ w) => whyWords(w, plain).split('\n').map((l) => named(name, l, plain));
    return [...lines(/* en */ 'Koe', why.halves.koe), ...lines(/* en */ 'Kokoro', why.halves.kokoro)].join('\n');
  }
  if (why.attempts) return failedText(why.attempts, { offline: why.offline, plain });
  if (why.role !== undefined) return noModel(why.role, plain);
  if (why.kind) {
    const e = new ProviderError(/** @type {any} */ (why.kind), String(why.message ?? ''), { provider: why.provider, said: why.said });
    return plain ? explainPlain(e) : explain(e);
  }
  return String((!plain && why.name ? shownFor(why.name) : undefined) ?? why.message ?? '');
}

/** No model is set for a role. @param {string} role @param {boolean} plain */
function noModel(role, plain) {
  /* en */
  if (plain) return `No model is set for the ${role} role. Add one in Settings → Models.`;
  if (role === 'utility') return t`No model is set for the utility role. Add one in Settings → Models.`;
  if (role === 'koe-classic') return t`No model is set for Koe · Classic. Add one in Settings → Models.`;
  return t`No model is set for the main role. Add one in Settings → Models.`;
}

/**
 * The models a role tries, in order: its own, or the main list for an empty chat role. An empty Koe list
 * never uses Main: no Koe model means no Koe. @param {ModelConfig} config @param {string} role
 */
export function candidates(config, role) {
  const own = config.roles?.[role]?.models ?? [];
  if (own.length || !CHAT_ROLES.includes(role)) return own;
  return config.roles?.main?.models ?? [];
}

/** The models of a role a chat call can use: those of a chat ability switched on (Koe's realtime models are passed over). @param {ModelConfig} cfg @param {string} role */
export const chatCandidates = (cfg, role) => candidates(cfg, role).filter((id) => { const a = abilityOf(cfg, id); return a?.on && a.kind !== 'realtime'; });

/**
 * @typedef {{ mode: import('./config.js').KoeMode, using: import('./config.js').KoeMode, why: '' | 'voice off' | 'none' | 'resting' | 'off', koe: boolean,
 *   split: boolean, path: { kind: 'live', modelId: string } | { kind: 'text' } | null }} KoeWay
 *   mode: the one chosen; using: the list Koe runs on now; why: why Classic stands in for a chosen Realtime ('none': its list is empty;
 *   'resting': a model of it rests after a failure, and will answer again; 'off': none can, switched off or without its protocol running); koe: a Koe list holds a model; split: Shiori is two halves; path: Koe's
 *   pathway (a live session, or the loop), null when Koe is down
 */

/**
 * Koe's way now (the user, 2026-10-22: two lists, Realtime and Classic, and a switch on the voice chip). Realtime runs when it is
 * chosen, voice is on, and a model in its list can answer: the first one (a model off, resting or without its protocol running is
 * passed over, as callRole has it). Otherwise Classic: its chat models in the loop, with the speech lists; with voice off always,
 * since a live reply would be sound nobody hears. Shiori is two halves while Classic holds a model, or Realtime is wanted and holds
 * one: then Koe is down when nothing can answer. Otherwise Shiori is one, as for an empty Koe list.
 * @param {ModelConfig} cfg @param {{ voiceOn: boolean, types: Map<string, { realtime?: boolean }>, until: (id: string) => number, now: number }} o
 * @returns {KoeWay}
 */
export function koeWay(cfg, { voiceOn, types, until, now }) {
  const realtime = candidates(cfg, KOE_REALTIME);
  const classic = candidates(cfg, KOE_CLASSIC);
  const mode = cfg.koeMode ?? (realtime.length ? 'realtime' : 'classic');
  /** Its ability, when the model can answer now. @param {string} id */
  const can = (id) => {
    const a = abilityOf(cfg, id);
    return cfg.models[id] && a?.on && types.get(a.type) && until(id) <= now ? a : null;
  };
  const koe = realtime.length > 0 || classic.length > 0;
  const wanted = mode === 'realtime' && voiceOn;
  const live = wanted ? realtime.find((id) => { const a = can(id); return a?.kind === 'realtime' && types.get(a.type)?.realtime; }) : undefined;
  if (live) return { mode, using: 'realtime', why: '', koe, split: true, path: { kind: 'live', modelId: live } };
  const rests = (/** @type {string} */ id) => { const a = abilityOf(cfg, id); return Boolean(cfg.models[id] && a?.on && a.kind === 'realtime' && types.get(a.type)?.realtime && until(id) > now); };
  /** @type {KoeWay['why']} */
  const why = mode !== 'realtime' ? '' : !voiceOn ? /* en */ 'voice off' : !realtime.length ? 'none' : realtime.some(rests) ? 'resting' : 'off';
  const text = classic.some((id) => { const a = can(id); return a && a.kind !== 'realtime'; });
  return { mode, using: 'classic', why, koe, split: classic.length > 0 || (wanted && realtime.length > 0), path: text ? { kind: 'text' } : null };
}

/**
 * A rough token count, enough to skip models whose window is clearly too small: of the messages as this model is sent
 * them (another's search steps aren't). @param {Request} request @param {string} [modelKey] its provider model id
 */
export function estimateTokens(request, modelKey) {
  let chars = (request.system ?? '').length + JSON.stringify(request.tools ?? []).length;
  let images = 0;
  for (const m of modelKey ? portable(request.messages, modelKey) : request.messages) {
    for (const p of m.parts) {
      if (p.type === 'image') images++;
      else chars += JSON.stringify(p).length;
    }
  }
  return Math.ceil(chars / 3.5) + images * 1600 + (request.maxOutput ?? 0);
}

/**
 * Whether the user's newest message holds a photo: the loop says (newestPhoto); else whether the last user message has a
 * photo of the user's (a tool result's own photos follow it). @param {Request} request
 */
function newestPhoto(request) {
  if (request.newestPhoto !== undefined) return request.newestPhoto;
  let ofResult = false;
  for (const p of request.messages.findLast((m) => m.role === 'user')?.parts ?? []) {
    if (p.type === 'tool_result') ofResult = true;
    else if (p.type !== 'image') ofResult = false;
    else if (!ofResult) return true;
  }
  return false;
}

/**
 * Whether the newest message holds a PDF (a tool's result brought it): a model that reads none can't answer it. @param {Request} request
 */
function newestDocument(request) {
  if (request.newestDocument !== undefined) return request.newestDocument;
  return Boolean(request.messages.findLast((m) => m.role === 'user')?.parts.some((p) => p.type === 'document'));
}

/**
 * What a conversation has kept of a file a model can't take (the review of reading-files, finding 1), by the file's hash: what it says
 * in words, for any model, or its pages, for one that sees photos (sees); null when nothing was kept.
 * @typedef {(hash: string, sees: boolean) => { text: string, images: { mediaType: string, data: string, hash?: string, page?: number }[] } | null} Readings
 */

/**
 * The request for a model that takes no photos or no PDFs (emulator pass): each as words, "[a photo: /trip/files/….webp]" or
 * "[a PDF: booking.pdf]", so a conversation that once held one can still go on with it; followed by what the conversation kept of it
 * (readings), and its pages for a model that sees photos. @param {Request} request
 * @param {{ photos?: boolean, documents?: boolean, sees?: boolean, readings?: Readings, kept?: boolean }} [which] what to word (both when not
 *   given); sees: the model sees photos (a reading's pages go to it); kept: word only those with a kept reading, and leave the rest
 * @returns {Request}
 */
export function photosAsWords(request, { photos = true, documents = true, sees = false, readings, kept = false } = {}) {
  /** @param {import('./contract.js').Part} p @returns {import('./contract.js').Part[]} */
  const word = (p) => {
    if (!((photos && p.type === 'image') || (documents && p.type === 'document'))) return [p];
    const r = p.hash && readings ? readings(p.hash, sees) : null;
    if (kept && !r) return [p];
    /* en */
    const stub = p.type === 'image' ? `[a photo${p.path ? `: ${p.path}` : ''}]` : `[a PDF${p.type === 'document' && p.name ? `: ${p.name}` : ''}]`;
    if (!r) return [{ type: 'text', text: stub }];
    // A picture already in the request goes once: callRole sends every request through limitImages (the photo limit, each picture once).
    const pages = sees ? r.images : [];
    // With their hashes, so a provider's files API can take them by upload rather than as bytes in every request.
    return [{ type: 'text', text: `${stub} ${r.text}` }, ...pages.map((i) => ({ type: /** @type {const} */ ('image'), mediaType: i.mediaType, data: i.data, ...(i.hash ? { hash: i.hash } : {}), ...(i.page ? { page: i.page } : {}) }))];
  };
  return { ...request, messages: request.messages.map((m) => ({ ...m, parts: m.parts.flatMap(word) })) };
}

/**
 * What to send in place of a photo or PDF a model can't take, for the model about to be called; it never throws.
 * @typedef {(part: Extract<import('./contract.js').Part, { type: 'image' | 'document' }>, model: Model, signal?: AbortSignal) => Promise<import('./contract.js').Part[]>} ReadFor
 */

/**
 * The request for the second pass's model: each photo or PDF of the newest user message that it can't take, as read gives it, and
 * older ones as words (whatever newestPhoto says). The request passed in is not changed.
 * @param {Request} request @param {Model} model @param {ReadFor} read @param {AbortSignal} [signal] @param {Readings} [readings] @returns {Promise<Request>}
 */
async function readFor(request, model, read, signal, readings) {
  const newest = request.messages.findLastIndex((m) => m.role === 'user');
  const cant = (/** @type {import('./contract.js').Part} */ p) => (p.type === 'image' && !model.input.includes('image')) || (p.type === 'document' && !model.input.includes('pdf'));
  const messages = await Promise.all(request.messages.map(async (m, i) => (i !== newest ? m : {
    ...m, parts: (await Promise.all(m.parts.map((p) => (cant(p) ? read(/** @type {any} */ (p), model, signal) : [p])))).flat(),
  })));
  const sees = model.input.includes('image');
  const out = photosAsWords({ ...request, messages }, { photos: !sees, documents: !model.input.includes('pdf'), sees, readings });
  return { ...out, messages: limitImages(out.messages, model.images?.maxCount) };
}

/**
 * Why a model can't take this request, or null (spec §9.6: the list also handles capability gaps). @param {Model} model @param {Request} request
 * @param {{ free?: boolean }} [provider] its provider: a key on the free tier has no paid-only provider tools
 */
export function gap(model, request, provider) {
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'image')) && !model.input.includes('image')) return 'no-images';
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'document')) && !model.input.includes('pdf')) return 'no-documents';
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'audio')) && !model.input.includes('audio')) return 'no-audio';
  if (request.tools?.length && model.tools === false) return 'no-tools';
  if (request.needsProviderTool && !enabledProviderTools(model, request, provider).some((t) => t.kind === request.needsProviderTool)) return 'no-provider-tool';
  if (model.contextWindow && estimateTokens(request, model.providerId) > model.contextWindow) return 'too-long';
  return null;
}

/** The request again, telling the next model what the cut-off reply had said. @param {Request} request @param {string} said @returns {Request} */
export function continueAfter(request, said) {
  const note = /* en */ `[annai: your reply was cut off by a connection problem. You had already said: "${said}✂". Continue exactly where it stops, without repeating any of it.]`;
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
/** The browser's word on the connection: false is reliable, true can be wrong (a network with no internet). */
const deviceOnline = () => globalThis.navigator?.onLine !== false;

/** Parts made from heard speech keep its id (G2): as sound or words, the same to a kept turn; not words nothing wrote down. @param {Request} was @param {Request} now @returns {Request} */
const heardIds = (was, now) => (was === now ? now : {
  ...now, messages: now.messages.map((m, i) => ({ ...m, parts: m.parts.map((p, j) => { const h = was.messages[i]?.parts[j]; return h?.type === 'speech' && !(p.type === 'text' && p.text === NOT_TRANSCRIBED) ? /** @type {any} */ ({ ...p, heard: h.id }) : p; }) })),
});

/** How long a role waits for a model's first words, in ms: its own setting, else 8 seconds for Koe and 30 for the rest. @param {ModelConfig} config @param {string} role */
export const firstWordsMs = (config, role) => (config.roles?.[role]?.firstOutputSeconds ?? (role === KOE_CLASSIC ? 8 : 30)) * 1000;

/**
 * Calls a role's models in order until one answers (spec §9.6), and records the whole call as
 * one model.turn in the trace.
 * @param {{ role: string, request: Request, level?: string, config: ModelConfig, types: Map<string, EndpointType>,
 *   keyFor: (providerId: string) => Promise<string | null>, bench: Bench, fetch?: import('./call.js').Fetch, signal?: AbortSignal,
 *   onEvent?: (e: import('./contract.js').StreamEvent) => void, trace?: import('./call.js').ModelTrace, registry?: import('../registry.js').Registry,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, firstOutputMs?: number, online?: () => boolean,
 *   prefer?: string, borrow?: boolean, record?: { tag?: string, wake?: string, prefix?: string, context?: { from: number, to: number }, keepParts?: boolean },
 *   repairImages?: (err: ProviderError, modelId: string, request: Request) => Promise<Request | null>, uploads?: import('./uploads.js').Uploads,
 *   speech?: (model: Model, request: Request, plain?: boolean, signal?: AbortSignal) => Promise<Request>, models?: string[],
 *   kept?: import('./kept.js').Kept, scope?: string, tally?: import('../workspace.js').Workspace, missing?: string, read?: ReadFor, readings?: Readings,
 *   askResting?: boolean }} c
 *   models: the models to try in place of the role's list ("Try this model" passes one: no fallback); missing: why a
 *   model's protocol plugin can't be running, when annai knows (no service worker took the page, spec §5.3)
 *   record: what the model.turn notes besides the call; keepParts keeps the reply's parts so the conversation can be rebuilt
 *   repairImages: asked for a repaired request when a model refuses a photo; the same model is then tried again, at most twice (spec §9.9)
 *   uploads: photos uploaded to providers; an upload a provider no longer knows is forgotten, and the same model tried once more
 *   speech: resolves heard speech for the model about to be called (spec §10.3); a throw means nothing in the speech-in list can reach it, and the model is skipped;
 *   plain: the model refused the audio format it was sent, so send WAV; signal: the call's
 *   kept: turns kept on the provider's side (G2): only a conversation's own, Main's or Koe's (record.keepParts); scope: its
 *   borrow: warm housekeeping, which continues the conversation's live kept chain (if it has one) and deletes its own response, recording nothing
 *   tally: where this device counts provider tools with a monthly allowance (call.js billMonth)
 *   online: whether the device has a connection: a failure to connect while it has none says nothing about the model
 *   read: after every model was tried, those passed over for a photo or PDF in the newest message are tried again, in order, each with what
 *   read makes of those files (§9.6; without it, as for plugins' calls, there is no second pass)
 *   readings: what the conversation has kept of its files, put in place of a file a model can't take wherever it is (§7.2)
 *   askResting: a turn's own call (Shiori's): a resting model goes to the end of the list, whose rest ends soonest first, and at most one is asked; side jobs
 *   (readers, housekeeping, plugins', quick decisions) never are (round 6)
 * @returns {Promise<{ reply: Reply, attempts: Attempt[], usage: import('./contract.js').Usage, cost: number | undefined, answeredBy: string, modelId: string,
 *   first: string | null, tried: boolean }>} first: the role's first model, by name; tried: whether it was asked (a warm model may answer first)
 */
export async function callRole(c) {
  const { role, config, types, bench, now = Date.now, sleep = defaultSleep, online = deviceOnline } = c;
  const level = c.level ?? config.roles[role]?.level ?? /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off';
  /** @type {Attempt[]} */
  const attempts = [];
  let request = c.request;
  /** What a model is sent before what a cut-off reply said is added: the request, or the second pass's for its model. */
  let base = c.request;
  let said = '';
  let usage = { ...NO_USAGE };
  /** @type {number | undefined} */
  let cost;
  const { keepParts, ...meta } = c.record ?? {};
  const keeps = c.kept && (keepParts || c.borrow) && (role === 'main' || role === KOE_CLASSIC) ? c.kept : null;
  // A plugin's call is its own in the trace too, so its hooks don't get the requests it caused (fix pass 8b-1).
  const trace = c.trace && typeof meta.tag === 'string' && meta.tag.startsWith('plugin:')
    ? { ...c.trace, request: (/** @type {any} */ i) => /** @type {any} */ (c.trace).request({ ...i, tag: meta.tag }) } : c.trace;
  /**
   * @param {string | null} answeredBy @param {string} text @param {string} [stop] @param {string} [reasoning]
   * @param {import('./contract.js').Part[]} [parts] @param {{ url: string, title?: string }[]} [citations]
   */
  const record = (answeredBy, text, stop, reasoning, parts, citations) => c.trace?.turn(
    { role, level, answeredBy, first, attempts, usage, cost, ...meta, ...(stop ? { stop } : {}), ...(citations?.length ? { citations } : {}) },
    text, reasoning, keepParts ? parts : undefined);
  // How long to wait for the first words: the caller's limit, else the role's own setting (spec §9.6: configurable); Koe answers at once.
  const firstOutputMs = c.firstOutputMs ?? firstWordsMs(config, role);
  const list = c.models ?? candidates(config, role);
  // The role's first model that can answer (its chat ability on), by name, whichever is tried first: Shiori's lines say when another
  // answered, and whether it was tried (null: none).
  const firstId = c.models ? list[0] : chatCandidates(config, role)[0];
  /** The models the request went to: one passed over before it (no PDFs, too long) was never asked. */
  const sentTo = new Set();
  /** What a line written from a model's words says of it: the model, the role's first, and whether that was asked (a resting one was). @param {string} name */
  const byOf = (name) => ({ name, first, tried: sentTo.has(firstId) || restingNow.has(firstId) || attempts.some((a) => a.model === firstId && a.outcome === 'benched') });
  const first = firstId && config.models[firstId] ? modelOf(config.models[firstId]).name : null;
  // The model holding a warm cache goes first: switching back waits until its cache is cold (spec §9.6).
  const preferred = c.prefer && list.includes(c.prefer) ? [c.prefer, ...list.filter((x) => x !== c.prefer)] : list;
  // In a turn's own call (Shiori's), a model resting after an error isn't passed over: it goes after every model that isn't resting has had
  // both passes (round 9), the one whose rest ends soonest first, and at most one is asked in the call, so a turn doesn't fail while something might answer (§9.6; the real-PDF
  // check and round 8). Not Koe's list (Kokoro answers when she can't), and not a rest only the user can end (a refused key, no credit)
  // or a long rest the provider stated (it won't answer, and asking sends the whole request again). Side jobs pass resting models over.
  const restingNow = new Set(c.askResting && role !== KOE_CLASSIC ? list.filter((id) => bench.until(id) > now() && !bench.usersToEnd(id) && !bench.why(id)) : []);
  const awake = preferred.filter((id) => !restingNow.has(id));
  const resting = preferred.filter((id) => restingNow.has(id)).sort((a, b) => bench.until(a) - bench.until(b));
  /** The resting model asked in this call, when one was. @type {string | null} */
  let restingAsked = null;
  let began = false;
  /** The model the request last went to: what it had begun to say is its (not a model passed over since). */
  let last = '';
  /**
   * Tries one model, its retries and repairs included: its answer, or null when it was passed over or failed (an attempt says why).
   * @param {string} id @returns {Promise<Awaited<ReturnType<typeof callRole>> | null>}
   */
  const one = async (id) => {
    const rec = config.models[id];
    const pRec = rec ? config.providers[rec.provider] : undefined;
    const provider = pRec ? providerOf(pRec) : null;
    const ability = rec && provider ? provider.abilities[rec.ability] : undefined;
    const type = ability ? types.get(ability.type) : undefined;
    const model = rec ? modelOf(rec) : null;
    const sees = Boolean(model?.input.includes('image'));
    const reads = Boolean(model?.input.includes('pdf'));
    const forModel = (/** @type {Request} */ r) => {
      // A file the conversation has kept a reading of goes as that reading, wherever it is, the newest message's too (the review of
      // reading-files): it was read once, so it no longer keeps a model out.
      let sent = model && c.readings && !(sees && reads) ? photosAsWords(r, { photos: !sees, documents: !reads, sees, readings: c.readings, kept: true }) : r;
      // A model that takes no photos gets them as words, unless the user's newest message is one: only that needs a model that sees.
      const words = Boolean(model && !sees && !newestPhoto(sent) && sent.messages.some((m) => m.parts.some((p) => p.type === 'image')));
      // The same for a PDF: an older one goes as a note; only one in the newest message needs a model that reads it.
      const notes = Boolean(model && !reads && !newestDocument(sent) && sent.messages.some((m) => m.parts.some((p) => p.type === 'document')));
      if (words || notes) sent = photosAsWords(sent, { photos: words, documents: notes, sees, readings: c.readings });
      // The model's photo limit of the request's distinct pictures, kept pages included, each once (spec §4.8; round 8).
      sent = { ...sent, messages: limitImages(sent.messages, model?.images?.maxCount) };
      if (!sent.toolRequired || !bench.unforced.has(id)) return sent;
      const { toolRequired, ...rest } = sent;
      return rest;
    };
    // A model of a switched-off ability is skipped as off; calls never install a missing type (decision 9).
    const skip = !rec || !ability || !model ? 'removed' : !ability.on ? 'off' : !type ? 'type-missing' : type.speech || type.realtime ? 'not-chat' : bench.until(id) > now() && !(restingNow.has(id) && (!restingAsked || restingAsked === id)) ? 'benched' : gap(model, forModel(request), provider ?? undefined);
    if (skip || !model || !type || !pRec || !provider) {
      const why = skip === 'benched' ? bench.why(id) : skip === 'type-missing' ? c.missing : undefined;
      attempts.push({
        model: id, name: model?.name ?? id, outcome: skip ?? 'removed', ms: 0, ...(why ? { error: why } : {}), ...(why && skip === 'benched' ? { restsUntil: bench.until(id) } : {}),
        ...(why && skip === 'type-missing' ? { said: /** @type {import('./contract.js').Said} */ ({ code: 'held' }) } : {}),
      });
      return null;
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
    let whole = false;
    let again = false;
    for (let retry = 0; ; retry++) {
      // Heard speech is resolved against the model actually receiving it, at every attempt (spec §10.3).
      const asked = forModel(request);
      let sendable = asked;
      if (c.speech) {
        try {
          sendable = await c.speech(model, asked, plain, c.signal);
          if (keeps) sendable = heardIds(asked, sendable);
        } catch (e) {
          const said = /** @type {any} */ (e)?.said;
          attempts.push({ model: id, name: model.name, outcome: 'no-speech', ms: 0, error: String(/** @type {any} */ (e)?.message ?? e), ...(said ? { said } : {}) });
          break;
        }
      }
      // Another model starts over: what the last one had begun to say is cut, and named by it.
      if (began) c.onEvent?.({ type: 'restart', by: byOf(last) });
      sentTo.add(id);
      if (restingNow.has(id)) restingAsked = id;
      last = model.name;
      began = true;
      const started = now();
      try {
        const reply = await callOnce({
          type: set.type, endpoint, model, key, request: sendable, level, fetch: c.fetch, signal: c.signal, onEvent: c.onEvent,
          trace, registry: c.registry, now, firstOutputMs, uploads: c.uploads, tally: c.tally, ...(keeps ? { keep: { kept: keeps, scope: c.scope ?? SYS, chain: !whole, secret: own, ...(c.borrow ? { borrow: true } : {}), ...(again ? { again: true } : {}) } } : {}),
        });
        usage = addUsage(usage, reply.usage);
        cost = addCost(cost, reply.cost);
        // The resting models it never reached are in the Trace too, as passed over (round 9).
        for (const x of resting) if (x !== id && !attempts.some((a) => a.model === x)) attempts.push({ model: x, name: config.models[x] ? modelOf(config.models[x]).name : x, outcome: 'benched', ms: 0 });
        attempts.push({ model: id, name: model.name, outcome: 'ok', ms: now() - started, ...(reply.cost !== undefined ? { cost: reply.cost } : {}) });
        // Asked while it rested, and it answered: it rests no more, so the next call asks it in its place again (round 7).
        if (restingAsked === id) bench.clear(id);
        const full = said ? prefixed(reply, said) : reply;
        const reasoning = full.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).filter(Boolean).join('\n\n');
        await record(model.name, full.text, reply.stop, reasoning, full.parts, reply.citations);
        return { reply: full, attempts, usage, cost, answeredBy: model.name, modelId: id, first, tried: byOf(model.name).tried };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e));
        // What a call that failed had used is spent, stopped, timed out or cut off part-way: the turn's record (the Trace, the day's
        // spend) counts it (the reviews of phone-fixes-1).
        const spent = Boolean(err.usage && Object.values(err.usage).some((v) => typeof v === 'number' && v > 0));
        if (spent) {
          usage = addUsage(usage, /** @type {any} */ (err.usage));
          cost = addCost(cost, err.cost);
        }
        attempts.push({ model: id, name: model.name, outcome: err.kind, ms: now() - started, error: err.message, ...(err.said ? { said: err.said } : {}), ...(spent && err.cost !== undefined ? { cost: err.cost } : {}) });
        if (err.kind === 'cancelled') {
          err.by = byOf(model.name); // what it had begun to say is cut, and named by this model
          await record(null, said + err.partial);
          throw err;
        }
        if (err.partial) {
          // Handled like an interruption: the next model continues from here.
          said += err.partial;
          request = continueAfter(base, said);
          break;
        }
        if (err.again && !again) {
          // The server said it lacked the kept turn, and has it: a passing error. The same chained call, once more.
          again = true;
          continue;
        }
        if (err.whole && !whole) {
          // The kept turn this continued failed: the same model again, whole, once.
          whole = true;
          continue;
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
        if (err.kind === 'bad-request' && request.toolRequired && !bench.unforced.has(id) && refusesRequired(err.message)) {
          // A model or server that refuses a required tool call (review A1): the same model again without it, and never again with it.
          bench.unforced.add(id);
          continue;
        }
        if (err.kind === 'image' && c.repairImages && repairs < 2) {
          // The request as the model received it (its kept pages and limit in it), so a learned limit applies to all of it (round 9).
          const fixed = await c.repairImages(err, id, forModel(request)).catch((/** @type {unknown} */ x) => { console.warn(/* en */ 'the photo repair failed', x); return null; });
          if (fixed) {
            repairs++;
            request = fixed;
            continue; // the same model again (spec §9.9)
          }
        }
        // No connection on this device (airplane mode, say): the model did nothing wrong, so it doesn't rest, and
        // waiting won't help. It is asked again as soon as the connection is back (emulator pass).
        if ((err.kind === 'unreachable' || err.kind === 'network') && !online()) break;
        const step = nextStep(err, retry);
        if (step.wait !== undefined) {
          await sleep(step.wait);
          continue;
        }
        if (step.bench !== undefined) {
          const long = err.kind === 'rate' && step.bench > LONG_REST_MS ? restText(now() + step.bench, now()) : undefined;
          if (long) Object.assign(attempts[attempts.length - 1], { error: long, restsUntil: now() + step.bench });
          bench.bench(id, step.bench, now(), long, err.kind);
        }
        break;
      }
    }
    return null;
  };
  /**
   * Both passes over some models: the first with the request as it is; the second (the bookings design, goal 11) for those a photo or PDF
   * in the newest message kept out, with each one it can't take read by whoever can (c.read), and older ones as words.
   * @param {string[]} ids
   */
  const passes = async (ids) => {
    base = c.request;
    request = said ? continueAfter(base, said) : base;
    for (const id of ids) {
      const r = await one(id);
      if (r) return r;
    }
    const passed = c.read ? [...new Set(attempts.filter((a) => ids.includes(a.model) && (a.outcome === 'no-images' || a.outcome === 'no-documents')).map((a) => a.model))] : [];
    for (const id of passed) {
      // Only one resting model is asked in a call: none is read for once one was (round 9).
      if (restingAsked && restingAsked !== id && restingNow.has(id)) continue;
      const model = modelOf(config.models[id]);
      // What else keeps it out (too long, no tools…) is checked before anything is read for it, on what it would be sent (rounds 8, 9).
      const pRec = config.providers[config.models[id].provider];
      const worded = photosAsWords(c.request, { photos: !model.input.includes('image'), documents: !model.input.includes('pdf') });
      const other = gap(model, { ...worded, messages: limitImages(worded.messages, model.images?.maxCount) }, pRec ? providerOf(pRec) : undefined);
      if (other) {
        attempts.push({ model: id, name: model.name, outcome: other, ms: 0 });
        continue;
      }
      base = await readFor(c.request, model, /** @type {NonNullable<typeof c.read>} */ (c.read), c.signal, c.readings);
      request = said ? continueAfter(base, said) : base;
      const r = await one(id);
      if (r) return r;
    }
    return null;
  };
  // Every model that isn't resting has both passes before a resting one is asked (round 9: a dead photo model at rest held up every photo turn).
  const answer = (await passes(awake)) ?? (await passes(resting));
  if (answer) return answer;
  await record(null, said);
  throw new AllFailedError(attempts, said);
}
