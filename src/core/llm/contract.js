import { t, plural } from '../l10n.js';
import { list } from '../intl.js';

/**
 * The provider contract (spec §9.1): annai's own message format in and out, the events a
 * streamed reply is made of, normalized usage and normalized errors. Endpoint-type plugins
 * translate between this and one wire protocol; the core contains no protocol.
 *
 * @typedef {{ type: 'text', text: string, heard?: string, now?: true }
 *   | { type: 'image', mediaType: string, data: string, hash?: string, path?: string, region?: number[], page?: number, fileId?: string, missing?: boolean }
 *   | { type: 'document', mediaType: string, data: string, hash?: string, name?: string, missing?: boolean }
 *   | { type: 'audio', mediaType: string, data: string, heard?: string }
 *   | { type: 'speech', id: string, text?: string, clip?: string }
 *   | { type: 'provider', block: any, model: string }
 *   | { type: 'tool_call', id: string, name: string, input: any, extra?: any, model?: string }
 *   | { type: 'tool_result', id: string, content: string, isError?: boolean }
 *   | { type: 'reasoning', text: string, signature?: string, redacted?: string, model?: string }
 *   | { type: 'native', endpoint: string, content: any, covers: number, prefix: string }} Part
 *   image.data and document.data are base64 (a document is a PDF). An image's or a document's hash is its bytes' fingerprint, path and
 *   region where it came from (for stubs), page the PDF page it shows (a drawn page's picture), fileId a provider upload (spec §4.8); endpoint types use mediaType and data,
 *   or fileId when they upload. missing marks one whose bytes are gone: annai never sends it. provider is a provider's own block (a server
 *   tool's call or result), sent back unchanged, and only to the model that wrote it (spec §9.5). reasoning.model is the provider model id that wrote it: a signed block
 *   (signature or redacted) is only ever sent back to that model. audio.data is base64, sent only to a model that takes audio. speech is a heard
 *   segment (spec §10.3): annai resolves it for each model attempt into audio or words; text is its words once written down, clip a kept voice clip's hash.
 *   heard: the segment a text or audio part was resolved from (G2); sent as any text or audio. now: an earlier step's now block, kept where it
 *   was sent within a turn (the keep-reasoning design §2); a type that returns natives renders it exactly as it rendered the request's tail.
 *   native: a reply as its provider returned it (Anthropic Messages' content array, Chat Completions' reasoning_details), first among the reply's parts,
 *   standing for the covers parts after it; endpoint: the endpoint and key it came from (call.js nativeKey), the only one it is sent to;
 *   prefix: a fingerprint of what was sent before it (call.js). Only the transcript puts one there, and only for a turn (the design §4).
 *   A tool_call's extra is what its provider wrote on it to have back (Gemini 3's thought signature), and model the provider model id
 *   that wrote it: it goes back only to that model.
 * @typedef {{ role: 'user' | 'assistant', parts: Part[] }} Message
 * @typedef {{ name: string, description: string, input: Record<string, any> }} ToolDef  input: a JSON Schema
 * @typedef {{ system?: string, messages: Message[], tools?: ToolDef[], maxOutput?: number, cacheTtl?: '5m' | '1h',
 *   tail?: string, toolChoice?: string, logprobs?: number, providerTools?: { kinds: string[], off?: string[] }, needsProviderTool?: string, newestPhoto?: boolean, newestDocument?: boolean, toolRequired?: boolean, cacheAt?: number }} Request
 *   cacheAt: the index of the message where the previous turn began: a type that places cache markers marks its last block too, before any
 *   now block kept in it (the keep-reasoning design §7).
 *   tail: the now block, last, after any cache marker: in the final user message, or where the type puts it (OpenAI Responses: a developer message).
 *   toolChoice: a tool the model must call. logprobs: how many alternatives to report for the first token. toolRequired: the model must call
 *   one of the tools, any (Shiori's turns: she reaches the user only through tools), where its endpoint type can say so; toolChoice wins.
 *   providerTools: turn on the model's own tools of these kinds, except the ids switched off (spec §9.5);
 *   needsProviderTool: only models with such a tool of this kind may answer.
 *   newestPhoto: the user's newest message holds a photo, so a model that takes none can't answer (older photos go to it as words).
 *   newestDocument: the newest message holds a PDF (else read from it); false sends one to a model that reads none as a note, as newestPhoto: false does a photo.
 * @typedef {{ input: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, output: number, reasoning: number, cost?: number,
 *   serverTools?: Record<string, number>, audioIn?: number, audioOut?: number, image?: number, cacheReadAudio?: number, cacheReadImage?: number }} Usage
 *   Tokens. input leaves out cache reads and writes; output includes reasoning, which is also
 *   counted on its own. cost is in USD, when the provider reports it. serverTools: the provider's own tool calls it
 *   counted, by its usage key (such as web_search_requests). audioIn, audioOut and image: a realtime model's audio, and
 *   image and video, tokens, counted apart from input and output (K4); cacheReadAudio, cacheReadImage: cached audio and images (K6).
 * @typedef {'end' | 'tool' | 'length' | 'refusal' | 'pause' | 'other'} StopReason
 *   pause: the provider paused a long turn; send the reply back as it is, and it continues.
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'reasoning', text: string, signature?: string, redacted?: string }
 *   | { type: 'reasoning_delta', text: string }
 *   | { type: 'tool_input', id: string, name: string, partial: string }
 *   | { type: 'tool_call', id: string, name: string, input: any, extra?: any }
 *   | { type: 'usage', usage: Partial<Usage> }
 *   | { type: 'logprobs', top: { token: string, logprob: number }[] }
 *   | { type: 'provider', block: any }
 *   | { type: 'citation', url: string, title?: string }
 *   | { type: 'stop', reason: StopReason }
 *   | { type: 'restart', by?: { name: string, first: string | null, tried: boolean } }
 *   | { type: 'kept', id: string }
 *   | { type: 'native', content: any }
 *   | { type: 'attribution', source: string, text: string, links: { url: string, title?: string }[], html?: string }} StreamEvent
 *   reasoning is one whole block; reasoning_delta is a piece of it as it streams and tool_input a tool call's
 *   arguments so far, both to show progress: a model that is thinking is not a model that never started. restart: annai starts over, on another
 *   model or the same one; what streamed before is void (only callRole sends it). kept: the provider keeps this turn under id (G2), for annai alone.
 *   native: the whole reply as the provider returned it, once, at the end of a reply that finished, for annai to send back within the turn
 *   (Reply.native); opaque to the core, which never shows or stores it.
 *   attribution: a reply the provider's search grounded, to show the user as it came (G4), once, at its end.
 * @typedef {'auth' | 'credit' | 'rate' | 'overloaded' | 'context' | 'image' | 'upload' | 'blocked' | 'unreachable'
 *   | 'bad-request' | 'not-found' | 'server' | 'network' | 'timeout' | 'cancelled' | 'plugin' | 'type-missing' | 'redirect' | 'forgotten' | 'reasoning'} ErrorKind
 *   type-missing: the protocol plugin a model's ability needs isn't running, and a call never installs one; redirect: see noRedirect;
 *   forgotten: the provider no longer has the kept turn a call continued (G2);
 *   reasoning: the provider refused the reasoning annai sent back (a native), so the same model is asked again without it (the keep-reasoning design §8)
 */

/** What a model and the log are told, by kind of error (spec §9.9): annai's English, whatever the screens' language. */
/* en */
const PLAIN = Object.freeze({
  auth: 'The key was rejected. Check it in Settings → Models.',
  credit: 'This account is out of credit.',
  rate: 'The provider says too many requests for now.',
  overloaded: 'The provider is overloaded right now.',
  context: 'The conversation is too long for this model.',
  image: "This model didn't accept the photo.",
  upload: 'A photo uploaded earlier has expired.',
  blocked: "This address doesn't allow web apps like annai to call it.",
  unreachable: "annai couldn't reach this address. It may be down, or it may not allow web apps.",
  'bad-request': "The provider didn't accept the request. Check the tunables on its provider's page.",
  'not-found': "The provider doesn't know this model or address. Check the model id and the base URL.",
  server: 'The provider had a problem on its side.',
  network: 'The connection dropped.',
  timeout: 'The model took too long to start answering.',
  cancelled: 'Stopped.',
  plugin: "The plugin for this model's protocol failed.",
  'type-missing': "This model's protocol plugin isn't running. Open its provider in Settings → Models to install it.",
  forgotten: 'The provider no longer has the earlier turns; annai sends the conversation whole.',
  reasoning: 'The provider refused the reasoning annai sent back.',
});

/**
 * The same words for the user, in the screens' language (the design: a provider's words can't be translated, its kind can).
 * @param {string} kind @param {string} [provider] its name, where the words give it
 */
function shown(kind, provider) {
  switch (kind) {
    case 'auth': return t`The key was rejected. Check it in Settings → Models.`;
    case 'credit': return t`This account is out of credit.`;
    case 'rate': return t`The provider says too many requests for now.`;
    case 'overloaded': return t`The provider is overloaded right now.`;
    case 'context': return t`The conversation is too long for this model.`;
    case 'image': return t`This model didn't accept the photo.`;
    case 'upload': return t`A photo uploaded earlier has expired.`;
    case 'blocked': return t`This address doesn't allow web apps like annai to call it.`;
    case 'unreachable': return t`annai couldn't reach this address. It may be down, or it may not allow web apps.`;
    case 'bad-request': return t`The provider didn't accept the request. Check the tunables on its provider's page.`;
    case 'not-found': return t`The provider doesn't know this model or address. Check the model id and the base URL.`;
    case 'server': return t`The provider had a problem on its side.`;
    case 'network': return t`The connection dropped.`;
    case 'timeout': return t`The model took too long to start answering.`;
    case 'cancelled': return t`Stopped.`;
    case 'plugin': return t`The plugin for this model's protocol failed.`;
    case 'type-missing': return t`This model's protocol plugin isn't running. Open its provider in Settings → Models to install it.`;
    case 'forgotten': return t`The provider no longer has the earlier turns; annai sends the conversation whole.`;
    case 'reasoning': return t`The provider refused the reasoning annai sent back.`;
    case 'redirect': return provider ? t`${provider} answered with a redirect, which annai doesn't follow with your key. Check its address.`
      : t`The provider answered with a redirect, which annai doesn't follow with your key. Check its address.`;
    default: return null;
  }
}

/**
 * One of annai's own provider errors, as data: a call's attempt keeps it, and the screens make its words (saidWords), while message
 * is the log's and a model's English (the shown rule; the design's "Store data, not words"). kind: the kind's words say it.
 * @typedef {{ code: 'kind' | 'late' | 'paused' | 'stalled' | 'held' | 'zdr' | 'model-gone' | 'no-plugin' | 'not-in' | 'not-out' | 'not-live'
 *   | 'provider-gone' | 'provider-off' | 'provider-removed' | 'cors' | 'unreachable' | 'no-list' | 'formats' | 'origin' | 'not-heard',
 *   name?: string, ability?: string, abilityKind?: string, host?: string, formats?: string[], to?: string, want?: string, seconds?: number }} Said
 * ability: the ability's name where its description gives one; abilityKind: its kind, which the screens name otherwise.
 */

/**
 * What each kind of ability is called in the screens' words, when its description gives no name: annai's own descriptive name
 * (decision 10), as the Add screen names them. @param {string | undefined} kind @returns {string | undefined}
 */
export const kindWords = (kind) => (/** @type {Record<string, string>} */ ({ chat: t`Chat`, transcription: t`Transcription`, voice: t`Voice`, realtime: t`Live voice` }))[kind ?? ''];

/**
 * What one of annai's own provider errors says, in the screens' words, from its data. @param {Said} s @param {string} kind
 * @param {string} [provider] its name, for the words of a kind that names it @returns {string}
 */
export function saidWords(s, kind, provider) {
  const { name, host, formats } = s;
  const ability = s.ability ?? kindWords(s.abilityKind) ?? s.abilityKind;
  switch (s.code) {
    case 'late': return t`No output started in time.`;
    case 'paused': return plural(Number(s.seconds) || 0, 'Its output stopped for # second.', 'Its output stopped for # seconds.');
    case 'stalled': return t`The voice stopped arriving for longer than its wait.`;
    case 'held': return t`annai needs a reload: it opened without its offline service, so its plugins can't start.`;
    case 'zdr': return t`The server no longer had a conversation annai stored minutes ago, so it is probably not storing for this account (Zero Data Retention): annai keeps nothing there until it starts again, and sends the whole conversation.`;
    case 'model-gone': return t`That model no longer exists.`;
    case 'no-plugin': return t`${name}'s ${ability} needs its plugin, which isn't running. Open ${name} in Settings → Models to install it.`;
    case 'not-in': return t`${name} isn't a transcription model.`;
    case 'not-out': return t`${name} isn't a voice.`;
    case 'not-live': return t`${name} isn't a live voice model.`;
    case 'provider-gone': return t`That provider or ability no longer exists.`;
    case 'provider-off': return t`That provider no longer exists, or its plugin isn't running.`;
    case 'provider-removed': return t`That provider no longer exists.`;
    case 'cors': return t`${host} doesn't allow web apps like annai to call it (no CORS headers), so annai can't list or use its models from a browser. If the provider has another address, try it, or ask the provider to allow browser access.`;
    case 'unreachable': return t`annai couldn't reach ${host}. Check the address and your connection.`;
    case 'no-list': return t`${ability} can't list its models here. Add them by id.`;
    case 'formats': return t`${name} takes no audio format this phone makes (${list(formats ?? [], 'plain')}).`;
    case 'origin': return s.to ? t`${name}'s ${ability} built a request to ${s.to}, not its address ${s.want}. Check its tunables.`
      : t`${name}'s ${ability} built a request to an address that isn't one, not its address ${s.want}. Check its tunables.`;
    case 'not-heard': return t`Nothing in the speech-in list can hear it for ${name}.`;
    default: return shown(kind, provider) ?? '';
  }
}

/** Every error kind, for checking one a plugin gives. */
export const KINDS = new Set([...Object.keys(PLAIN), 'redirect']);

export class ProviderError extends Error {
  /**
   * @param {ErrorKind} kind @param {string} message the provider's own words, or annai's English for a model and the log
   * @param {{ status?: number, retryAfter?: number, partial?: string, cause?: unknown, noChain?: boolean, provider?: string, said?: Said }} [more]
   *   retryAfter: ms the provider asked to wait; partial: what the reply had already said; noChain: the server ignored the kept turn it was told to continue;
   *   provider: the provider's name, for the words of a kind that names it (redirect); said: what one annai wrote was, as data (saidWords)
   */
  constructor(kind, message, more = {}) {
    super(message, more.cause === undefined ? undefined : { cause: more.cause });
    this.name = /* en */ 'ProviderError';
    /** What one of annai's own was, which a call's attempt keeps; the screens' words are made from it (the shown rule). */
    this.said = more.said;
    this.shown = more.said ? saidWords(more.said, kind, more.provider) : undefined;
    /** @type {ErrorKind} */
    this.kind = kind;
    this.status = more.status;
    this.retryAfter = more.retryAfter;
    this.partial = more.partial ?? '';
    this.provider = more.provider;
    /** A kept turn the call continued failed: annai sends the conversation whole, once (G2). */
    this.whole = false;
    /** The server ignored the kept turn it was told to continue: annai keeps nothing there until it starts again. */
    this.noChain = more.noChain === true;
    /** A kept turn the server said it lacked is there when looked up: the same call is tried once more, chained. */
    this.again = false;
    /** What the call had used when it failed, and its cost, set by callOnce (a stopped call is billed for it). @type {import('./contract.js').Usage | undefined} */
    this.usage = undefined;
    /** @type {number | undefined} */
    this.cost = undefined;
    /** A stopped call's model, for the line its cut speech is written as (callRole). @type {{ name: string, first: string | null, tried: boolean } | undefined} */
    this.by = undefined;
  }
}

/** @param {string} url */
const originOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch {
    return '';
  }
};

/**
 * A request a protocol built goes only to its ability's address (fix pass, Critical): tunables such as
 * path and listPath are joined into the URL, so a description could otherwise send the key to another
 * host while every check names the right one. annai calls this before it fetches what a protocol built.
 * @param {{ name?: string, ability?: string, baseUrl: string }} endpoint @param {string} url
 */
export function sameOrigin(endpoint, url) {
  const want = originOf(endpoint.baseUrl);
  const got = originOf(url);
  if (want && got === want) return;
  const where = want || endpoint.baseUrl || /* en */ '(none)';
  throw new ProviderError('bad-request', /* en */ `${endpoint.name ?? 'This provider'}'s ${endpoint.ability ?? 'ability'} built a request to ${got || "an address that isn't one"}, not its address ${where}. Check its tunables.`,
    { said: { code: 'origin', name: endpoint.name ?? '', ability: endpoint.ability ?? '', to: got, want: where } });
}

/** A keyed request never follows a redirect: it'd take x-api-key and the body elsewhere (fix pass). @param {Response} res @param {{ name?: string }} endpoint */
export function noRedirect(res, endpoint) {
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new ProviderError('redirect', /* en */ `${endpoint.name ?? 'The provider'} answered with a redirect, which annai doesn't follow with your key. Check its address.`, { status: res.status, provider: endpoint.name, said: { code: 'kind' } });
  }
}

/**
 * Plain words for an error, for the user, in the screens' language: the words it carries (shown), else those of what one of annai's own
 * was (said), else its kind's. @param {ProviderError} e
 */
export function explain(e) {
  return e.shown ?? (e.said ? saidWords(e.said, e.kind, e.provider) : null) ?? shown(e.kind, e.provider) ?? e.message;
}

/** The same, for a model to read or the log to keep: annai's English. @param {ProviderError} e */
export function explainPlain(e) {
  return /** @type {Record<string, string>} */ (PLAIN)[e.kind] ?? e.message;
}

/**
 * The core's reading of an error response. Endpoint types refine the kind with their own codes.
 * @param {number} status @param {string} body @param {Headers} [headers]
 * @returns {ProviderError}
 */
export function errorFromResponse(status, body, headers) {
  const message = messageOf(body) || `HTTP ${status}`;
  return new ProviderError(kindOf(status, message, body), message, { status, retryAfter: retryAfterOf(headers) ?? retryDelayOf(body) });
}

/**
 * An error response as a ProviderError: core's reading, then its endpoint type's sharper kind, and the wait
 * its words ask for when no header or RetryInfo says (Gemini's "Please retry in 7h40m31s").
 * @param {EndpointType} type @param {number} status @param {string} body @param {Headers} [headers]
 */
export function typeError(type, status, body, headers) {
  const err = errorFromResponse(status, body, headers);
  const sharper = type.classify?.(status, body);
  if (sharper) err.kind = sharper;
  err.retryAfter ??= type.retryAfter?.(body);
  return err;
}

/** The wait a Google API error asks for in its RetryInfo ("23s"), in ms, when no header says. @param {string} body @returns {number | undefined} */
function retryDelayOf(body) {
  try {
    const j = JSON.parse(body);
    const details = (Array.isArray(j) ? j[0] : j)?.error?.details;
    const delay = Array.isArray(details) ? details.find((d) => typeof d?.retryDelay === 'string')?.retryDelay : undefined;
    const s = Number.parseFloat(delay ?? '');
    return Number.isFinite(s) && /^\d+(\.\d+)?s$/.test(delay ?? '') ? Math.round(s * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A 400 that says the key is wrong, as Google answers one: the error's own words, side by side ("Invalid Auth key.",
 * "API key not valid"), or its reason API_KEY_INVALID; never words elsewhere in the body, such as a model's (review R2).
 */
const BAD_KEY = /\binvalid (?:api|auth)[ _-]?key\b|\b(?:api|auth)[ _-]?key (?:is )?(?:not valid|invalid)\b/i;
const BAD_KEY_REASON = /"reason"\s*:\s*"API_KEY_INVALID"/;

/** @param {number} status @param {string} message @param {string} [body] @returns {ErrorKind} */
function kindOf(status, message, body = '') {
  if (status === 401 || status === 403 || (status === 400 && (BAD_KEY.test(message) || BAD_KEY_REASON.test(body)))) return 'auth';
  if (status === 402) return 'credit';
  if (status === 404) return 'not-found';
  if (status === 413) return 'context';
  if (status === 429) return /quota|billing|credit|balance/i.test(message) ? 'credit' : 'rate';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  if (/context|too long|too many tokens|maximum.*tokens/i.test(message)) return 'context';
  if (/image/i.test(message)) return 'image';
  return 'bad-request';
}

/** The message in an error body: JSON's error.message or message, else the start of the text. @param {string} body */
function messageOf(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const j = Array.isArray(parsed) ? parsed[0] : parsed; // Google's APIs send a list of one
    const m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : '');
    if (typeof m === 'string' && m) return m.slice(0, 500);
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 300);
}

/** How long the provider asked to wait, in ms. @param {Headers} [headers] @returns {number | undefined} */
function retryAfterOf(headers) {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const v = headers?.get('retry-after');
  if (!v) return undefined;
  if (Number.isFinite(Number(v))) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * The transcript as one model may see it (spec §9.6): reasoning signed by another model is
 * dropped, and so is what another model wrote on a tool call; tool-call ids are rewritten into a form every provider accepts.
 * A native stays, and so do the parts it covers as they are (ids made safe): they are its endpoint's, where it goes to any model,
 * and the count must stay true (callOnce takes out other endpoints' natives first).
 * @param {Message[]} messages @param {string} modelKey the provider model id the request goes to
 * @returns {Message[]}
 */
export function portable(messages, modelKey) {
  /** @type {(p: Part) => Part[]} */
  const keep = (p) => {
    if (p.type === 'speech') return [{ type: 'text', text: p.text || /* en */ '[audio, not transcribed]' }]; // resolved before sending; never sent as it is
    if (p.type === 'reasoning') return (p.signature || p.redacted) && p.model !== modelKey ? [] : [p];
    if (p.type === 'provider') return p.model === modelKey ? [p] : [];
    if (p.type === 'tool_call') {
      const { extra, model, ...call } = p;
      return [{ ...call, id: safeId(p.id), ...(extra !== undefined && model === modelKey ? { extra, model } : {}) }];
    }
    if (p.type === 'tool_result') return [{ ...p, id: safeId(p.id) }];
    return [p];
  };
  return messages.map((m) => {
    let covered = 0;
    const parts = m.parts.flatMap((p) => {
      if (p.type === 'native') {
        covered = p.covers;
        return [p];
      }
      if (covered <= 0) return keep(p);
      covered--;
      return p.type === 'reasoning' || p.type === 'provider' ? [p] : keep(p);
    });
    return { role: m.role, parts };
  }).filter((m) => m.parts.length);
}

/** A tool-call id every provider accepts: letters, digits, "_" and "-", at most 64. @param {string} id */
export function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call';
}

/**
 * @typedef {object} CallSpec  what an endpoint type is given for one call
 * @property {import('./config.js').Endpoint} endpoint
 * @property {import('./config.js').Model} model
 * @property {string | null} key
 * @property {Record<string, any>} tunables  the endpoint's tunables with the model's over them
 * @property {Request} request
 * @property {AbortSignal} [signal]
 * @property {boolean} [keep]  the provider keeps this turn (G2)
 * @property {{ id: string, from: number } | null} [kept]  the kept turn this one continues: send request.messages.slice(from)
 * @typedef {{ providerId: string, name?: string, contextWindow?: number, maxOutput?: number, input?: string[], tools?: boolean,
 *   prices?: import('./cost.js').Prices, reasoning?: Record<string, any>, loaded?: boolean }} ListedModel  reasoning: its level map (spec §9.3); loaded: a server you run has it loaded now
 * @typedef {{ endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, key: string | null, tunables: Record<string, any> }} SpeechSpec
 *   what a speech endpoint type is given for one call; a request's body is sent as given (a string or a FormData)
 * @typedef {object} EndpointType  what an endpoint-type plugin registers (spec §9.1)
 * @property {string} type  its id, e.g. "chat-completions"
 * @property {string} name  shown in Settings
 * @property {string} pluginId  set by annai
 * @property {Record<string, any>} [tunables]  defaults for the type's tunables (spec §9.2)
 * @property {string[]} [voices]  a voice type's own voices, suggested in a model's Voice field (a model's own `voices` tunable, such as a provider's list gives, comes first)
 * @property {boolean} [tail]  true when build() places request.tail; else annai adds it as the last text
 * @property {(c: CallSpec) => { url: string, headers: Record<string, string>, body: any }} [build]  the HTTP request for annai's request
 * @property {(res: Response, c: CallSpec) => AsyncIterable<StreamEvent>} [read]  the events of a successful streamed response
 * @property {(c: CallSpec) => AsyncIterable<StreamEvent>} [run]  instead of build and read, for types that need no network
 * @property {(status: number, body: string) => ErrorKind | null} [classify]  a sharper kind for an error response, or null
 * @property {(body: string) => number | undefined} [retryAfter]  ms an error response's words ask to wait, when no header says
 * @property {(status: number, body: string, c: CallSpec) => string | null} [refusal]  an error response that is the model declining (a safety block):
 *   its words, which end the turn as a reply that stops with 'refusal', so no other model is tried; null for any other error. c: the call,
 *   so the type can keep what was blocked out of its later requests (Gemini's)
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null }) => { url: string, headers: Record<string, string> }} [listRequest]
 * @property {(json: any) => ListedModel[]} [readList]
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null, tunables: Record<string, any>, bytes: Uint8Array, mediaType: string, name: string, expiresInSeconds: number }) => { url: string, headers: Record<string, string>, body: FormData }} [uploadRequest]
 *   a photo upload to the provider's files API (spec §4.8)
 * @property {(json: any) => { id: string, expiresAt?: number }} [readUpload]
 * @property {{ name?: string, days: number, hours: number, holds?: string, note?: string, provider?: string, perModel?: boolean, minLife?: number }} [keeps]  it keeps turns on the provider's side (G2; docs/plugins.md "Kept turns"):
 *   who, for the switch's words; the longest annai tracks one; how long a chain is continued; holds: how long it keeps one on any key, for the page (else the page tells free from paid keys); note: more for the page to say;
 *   provider: the plugin these words are for (another provider using the protocol gets its own name); perModel: only the model that made a turn continues it; minLife: ms within which a turn is never gone (gone sooner, the server isn't keeping them)
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null, id: string }) => { url: string, headers: Record<string, string>, method: 'DELETE' }} [forgetRequest]
 *   its delete call for one kept turn
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null, id: string }) => { url: string, headers: Record<string, string> }} [lookRequest]
 *   its look-up of one kept turn (200: it is there, 404: it is not), asked before a missing one is read as a server that stores nothing
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null }) => Promise<ListedModel[]>} [list]  for types with run
 * @property {'in' | 'out'} [speech]  a speech type (spec §9.1, §10): 'in' transcribes speech, 'out' is a voice
 * @property {(c: SpeechSpec & { audio: { data: Uint8Array, mediaType: string }, languages?: Languages }) => { url: string, headers: Record<string, string>, body: any }} [transcribeRequest]  languages: what the user speaks (phase 2)
 * @property {(res: Response, c: SpeechSpec) => Promise<{ text: string }>} [readTranscript]
 * @property {(c: SpeechSpec & { text: string }) => { url: string, headers: Record<string, string>, body: any }} [speechRequest]
 * @property {(res: Response, c: SpeechSpec) => Promise<{ data: Uint8Array, mediaType: string }>} [readSpeech]
 * @property {(c: SpeechSpec) => number} [extraChars]  characters a voice request carries besides the text (its style), billed with it
 * @property {(res: Response, c: SpeechSpec) => AsyncIterable<{ pcm: Int16Array, rate: number }>} [readSpeechStream]  a voice that streams (G3): its
 *   16-bit PCM as it comes, at its rate; annai plays it once it won't stutter, unless the ability's tunable stream is false (then readSpeech)
 * @property {Record<string, { label: string, options?: Record<string, string> }>} [choices]  tunables the provider page offers in words (G3):
 *   with options, one of them (value → its words); without, a switch for a tunable that is on unless false
 * @property {true} [realtime]  a realtime voice type (K4), with audio, open and attach: annai opens the socket, the type drives it;
 *   its tunable heardLive says its transcript of the user streams in while they speak, not after their turn (a live session's heardLive)
 * @property {{ in: AudioFormat[], out: AudioFormat[] }} [audio]  what it sends and takes, preferred first (tunables input, output pick, K6)
 * @property {(c: SpeechSpec) => { url: string, protocols?: string[] }} [open]  a session's address and subprotocols
 * @property {(socket: LiveSocket, c: { endpoint: import('./config.js').Endpoint, model: import('./config.js').Model, tunables: Record<string, any>,
 *   setup: LiveSetup, emit: (e: LiveEvent) => void }) => LiveDriver} [attach]  its ready may fail with a ProviderError saying why (K6); audio both ways is 16-bit PCM at the formats' rates
 * @property {(code: number, reason: string) => ErrorKind | null} [classifyClose]
 * @property {(code: number, reason: string, tunables: Record<string, any>) => Record<string, any> | null} [reopen]  tunables to open with once more, before ready
 * @typedef {{ rate: number, chunks: AsyncIterable<Int16Array> }} SpeechStream  a voice's 16-bit PCM as it arrives, at rate (G3)
 * @typedef {{ format: 'pcm16' | 'pcmu' | 'pcma', rate: number }} AudioFormat
 * @typedef {{ spoken: import('../languages.js').Language[], answer: import('../languages.js').Language | null }} Languages  the languages the user speaks, in order, each with the
 *   codes models take (iso, live, google, locale), and the one Shiori answers in (null: she follows the user) (phase 2; spec §10.9)
 * @typedef {{ instructions: string, context: string, tools: ToolDef[], resume?: string, audioIn: AudioFormat, audioOut: AudioFormat, languages?: Languages }} LiveSetup  languages: for the
 *   protocol's own language fields (the words it is told are in instructions); resume: a handle
 * @typedef {{ send(data: string | Uint8Array): void, on(fn: (data: string | Uint8Array) => void): void }} LiveSocket  on: set as it attaches
 * @typedef {{ ready: Promise<void>, audio(chunk: Uint8Array): void, activity(edge: 'start' | 'end', o?: { playedMs?: number }): void, text(t: string, o?: { interrupt?: boolean, playedMs?: number }): void,
 *   image(i: { mediaType: string, data: string }): void, answer(id: string, name: string, output: string, o?: { silent?: boolean }): void,
 *   cancel?(): void, cut?(playedMs?: number): void, close?(): void }} LiveDriver
 *   ready: the setup was taken; audio: 16-bit PCM in audioIn; image: base64; silent: no more speech for that answer; playedMs: when the user or a
 *   note cuts Koe off, how much of its turn was heard (a protocol may cut its record of the turn there); cut: a tap stopped Koe's voice there,
 *   with nothing else said (K5)
 * @typedef {{ type: 'audio', data: Uint8Array } | { type: 'heard' | 'said', text: string, final?: boolean } | { type: 'tool', id: string, name: string, input: any }
 *   | { type: 'turn', end: 'complete' | 'interrupted' } | { type: 'usage', usage: Partial<Usage> } | { type: 'resume', handle: string }
 *   | { type: 'goaway', ms: number }} LiveEvent  audio: 16-bit PCM in audioOut; heard, said: transcripts in pieces; usage: a turn's
 */

/**
 * The endpoint types running plugins provide, by type id: each type's owner, annai's own first, then by install time.
 * @param {import('../registry.js').Registry} registry @returns {Map<string, EndpointType>}
 */
export function endpointTypes(registry) {
  return new Map(registry.list('endpoint-type').map((t) => [t.type, t]));
}
