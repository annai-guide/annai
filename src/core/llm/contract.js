/**
 * The provider contract (spec §9.1): annai's own message format in and out, the events a
 * streamed reply is made of, normalized usage and normalized errors. Endpoint-type plugins
 * translate between this and one wire protocol; the core contains no protocol.
 *
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'image', mediaType: string, data: string }
 *   | { type: 'tool_call', id: string, name: string, input: any }
 *   | { type: 'tool_result', id: string, content: string, isError?: boolean }
 *   | { type: 'reasoning', text: string, signature?: string, redacted?: string, model?: string }} Part
 *   image.data is base64. reasoning.model is the provider model id that wrote it: a signed block
 *   (signature or redacted) is only ever sent back to that model.
 * @typedef {{ role: 'user' | 'assistant', parts: Part[] }} Message
 * @typedef {{ name: string, description: string, input: Record<string, any> }} ToolDef  input: a JSON Schema
 * @typedef {{ system?: string, messages: Message[], tools?: ToolDef[], maxOutput?: number, cacheTtl?: '5m' | '1h' }} Request
 * @typedef {{ input: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, output: number, reasoning: number, cost?: number }} Usage
 *   Tokens. input leaves out cache reads and writes; output includes reasoning, which is also
 *   counted on its own. cost is in USD, when the provider reports it.
 * @typedef {'end' | 'tool' | 'length' | 'refusal' | 'other'} StopReason
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'reasoning', text: string, signature?: string, redacted?: string }
 *   | { type: 'tool_input', id: string, name: string, partial: string }
 *   | { type: 'tool_call', id: string, name: string, input: any }
 *   | { type: 'usage', usage: Partial<Usage> }
 *   | { type: 'stop', reason: StopReason }} StreamEvent
 *   reasoning is one whole block; tool_input is a tool call's arguments so far, to show progress.
 * @typedef {'auth' | 'credit' | 'rate' | 'overloaded' | 'context' | 'image' | 'upload' | 'blocked' | 'unreachable'
 *   | 'bad-request' | 'not-found' | 'server' | 'network' | 'timeout' | 'cancelled' | 'plugin'} ErrorKind
 */

/** What the user is told, by kind of error (spec §9.9). */
const PLAIN = Object.freeze({
  auth: 'The key was rejected. Check it in Settings → Models.',
  credit: 'This account is out of credit.',
  rate: 'The provider says too many requests for now.',
  overloaded: 'The provider is overloaded right now.',
  context: 'The conversation is too long for this model.',
  image: "This model didn't accept the photo.",
  upload: 'A photo uploaded earlier has expired.',
  blocked: "This endpoint doesn't allow web apps like annai to call it.",
  unreachable: "annai couldn't reach this endpoint. It may be down, or it may not allow web apps.",
  'bad-request': "The provider didn't accept the request. Check the endpoint's tunables.",
  'not-found': "The provider doesn't know this model or address. Check the model id and the base URL.",
  server: 'The provider had a problem on its side.',
  network: 'The connection dropped.',
  timeout: 'The model took too long to start answering.',
  cancelled: 'Stopped.',
  plugin: 'The plugin for this endpoint type failed.',
});

export class ProviderError extends Error {
  /**
   * @param {ErrorKind} kind @param {string} message
   * @param {{ status?: number, retryAfter?: number, partial?: string, cause?: unknown }} [more]
   *   retryAfter: ms the provider asked to wait; partial: what the reply had already said
   */
  constructor(kind, message, more = {}) {
    super(message, more.cause === undefined ? undefined : { cause: more.cause });
    this.name = 'ProviderError';
    /** @type {ErrorKind} */
    this.kind = kind;
    this.status = more.status;
    this.retryAfter = more.retryAfter;
    this.partial = more.partial ?? '';
  }
}

/** Plain words for an error, by its kind. @param {ProviderError} e */
export function explain(e) {
  return PLAIN[e.kind] ?? e.message;
}

/**
 * The core's reading of an error response. Endpoint types refine the kind with their own codes.
 * @param {number} status @param {string} body @param {Headers} [headers]
 * @returns {ProviderError}
 */
export function errorFromResponse(status, body, headers) {
  const message = messageOf(body) || `HTTP ${status}`;
  return new ProviderError(kindOf(status, message), message, { status, retryAfter: retryAfterOf(headers) });
}

/** @param {number} status @param {string} message @returns {ErrorKind} */
function kindOf(status, message) {
  if (status === 401 || status === 403) return 'auth';
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
    const j = JSON.parse(body);
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
 * dropped, and tool-call ids are rewritten into a form every provider accepts.
 * @param {Message[]} messages @param {string} modelKey the provider model id the request goes to
 * @returns {Message[]}
 */
export function portable(messages, modelKey) {
  /** @type {(p: Part) => Part[]} */
  const keep = (p) => {
    if (p.type === 'reasoning') return (p.signature || p.redacted) && p.model !== modelKey ? [] : [p];
    if (p.type === 'tool_call' || p.type === 'tool_result') return [{ ...p, id: safeId(p.id) }];
    return [p];
  };
  return messages.map((m) => ({ role: m.role, parts: m.parts.flatMap(keep) })).filter((m) => m.parts.length);
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
 * @typedef {{ providerId: string, name?: string, contextWindow?: number, maxOutput?: number, input?: string[], tools?: boolean,
 *   prices?: import('./cost.js').Prices }} ListedModel
 * @typedef {object} EndpointType  what an endpoint-type plugin registers (spec §9.1)
 * @property {string} type  its id, e.g. "chat-completions"
 * @property {string} name  shown in Settings
 * @property {string} pluginId  set by annai
 * @property {Record<string, any>} [tunables]  defaults for the type's tunables (spec §9.2)
 * @property {(c: CallSpec) => { url: string, headers: Record<string, string>, body: any }} [build]  the HTTP request for annai's request
 * @property {(res: Response, c: CallSpec) => AsyncIterable<StreamEvent>} [read]  the events of a successful streamed response
 * @property {(c: CallSpec) => AsyncIterable<StreamEvent>} [run]  instead of build and read, for types that need no network
 * @property {(status: number, body: string) => ErrorKind | null} [classify]  a sharper kind for an error response, or null
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null }) => { url: string, headers: Record<string, string> }} [listRequest]
 * @property {(json: any) => ListedModel[]} [readList]
 * @property {(c: { endpoint: import('./config.js').Endpoint, key: string | null }) => Promise<ListedModel[]>} [list]  for types with run
 */

/**
 * The endpoint types running plugins provide, by type id; the first plugin to provide a type wins.
 * @param {import('../registry.js').Registry} registry @returns {Map<string, EndpointType>}
 */
export function endpointTypes(registry) {
  /** @type {Map<string, EndpointType>} */
  const out = new Map();
  for (const t of registry.list('endpoint-type')) if (!out.has(t.type)) out.set(t.type, t);
  return out;
}
