import { toInput, toolSchema } from './steps.js';
import { levelsFor, thinks } from './levels.js';
import { blockedMessages } from './blocked.js';

/**
 * The `gemini` chat type: annai's request as one Interactions request (`POST /v1beta/interactions`),
 * the key in `x-goog-api-key`, never in the address; the streamed steps read back as annai's events.
 * A thought comes back as reasoning with its signature, a call with its own signature as its extra:
 * both go back unchanged, and only to the model that wrote them (steps.js). Nothing is kept on
 * Google's side (`store: false`): the whole conversation goes each time.
 */
export const TUNABLES = Object.freeze({
  uploads: true, // photos go to Gemini's Files API once, then by their address (spec §4.8); Gemini deletes them after 48 hours
  audioIn: Object.freeze(['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav']), // Gemini takes every format annai makes (spec §10.6)
});
/** An interaction's status at its end, as a stop reason. @type {Record<string, string>} */
const STOP = { completed: 'end', requires_action: 'tool', incomplete: 'length', budget_exceeded: 'length' };

/** @param {string} base @param {string} path */
export const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The key in its header, after the ability's own headers, so none can replace it. @param {any} endpoint @param {string | null} key @returns {Record<string, string>} */
export function auth(endpoint, key) {
  return { ...(endpoint.headers ?? {}), ...(key ? { 'x-goog-api-key': key } : {}) };
}

/**
 * The chat type. Photos go to Gemini's Files API as one multipart request (measured 2026-10-19: a
 * FormData with x-goog-upload-protocol: multipart is taken), and Gemini deletes them after 48 hours.
 * @param {any} annai
 */
export function chatType(annai) {
  const { sse, ProviderError } = annai.helpers;
  const blocked = blockedMessages(annai.settings);
  return {
    type: 'gemini',
    name: 'Gemini API',
    tunables: TUNABLES,
    tail: true,
    /** @param {any} c */
    build: (c) => build(c, (m) => blocked.has(m)),
    /** @param {Response} res @param {any} c */
    read: (res, c) => read(res, { sse, ProviderError, left: () => blocked.add(c?.request?.messages ?? []) }),
    classify,
    retryAfter,
    /**
     * A safety block, which Google sends as an error response: an answer that declines, so no other model is tried. The
     * message blocked stays out of what Gemini is sent from then on (blocked.js). @param {number} _status @param {string} body @param {any} [c]
     */
    refusal: (_status, body, c) => {
      const e = errorOf(body);
      return isBlock(e) ? refusalText(e, blocked.add(c?.request?.messages ?? [])) : null;
    },
    /** @param {{ endpoint: any, key: string | null }} c */
    listRequest: ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/v1beta/models?pageSize=1000'), headers: auth(endpoint, key) }),
    readList,
    /** @param {{ endpoint: any, key: string | null, bytes: Uint8Array, mediaType: string, name: string }} c */
    uploadRequest: ({ endpoint, key, bytes, mediaType, name }) => {
      const body = new FormData();
      body.set('metadata', new Blob([JSON.stringify({ file: { display_name: name } })], { type: 'application/json' }));
      body.set('file', new Blob([/** @type {BlobPart} */ (bytes)], { type: mediaType }), name);
      return { url: join(endpoint.baseUrl, '/upload/v1beta/files'), headers: { ...auth(endpoint, key), 'x-goog-upload-protocol': 'multipart' }, body };
    },
    /** @param {any} j */
    readUpload: (j) => {
      if (typeof j?.file?.uri !== 'string' || !j.file.uri) throw new Error("Gemini's answer to an upload has no address for the file.");
      return { id: j.file.uri, ...(Date.parse(j.file.expirationTime) ? { expiresAt: Date.parse(j.file.expirationTime) } : {}) };
    },
  };
}

/** @param {any} c @param {(m: any) => boolean} leave a user message Google blocked */
function build({ endpoint, model, key, request }, leave) {
  /** @type {Record<string, any>} */
  const config = {};
  const max = request.maxOutput ?? model.maxOutput;
  if (max) config.max_output_tokens = max;
  // Thought summaries show progress, so a thinking model never looks stalled; the reasoning level's patch adds thinking_level.
  if (Object.keys(model.reasoning ?? {}).length || thinks(model.providerId)) config.thinking_summaries = 'auto';
  if (request.toolChoice) config.tool_choice = { allowed_tools: { mode: 'any', tools: [request.toolChoice] } };
  // An id from the OpenAI-compatible endpoint's list, before provider-gemini 2.0, is "models/<id>".
  /** @type {Record<string, any>} */
  const body = { model: String(model.providerId).replace(/^models\//, ''), store: false, stream: true };
  if (request.system) body.system_instruction = request.system;
  if (request.tools?.length) body.tools = request.tools.map(toolSchema);
  body.generation_config = config;
  body.input = toInput(request.messages, { model: model.providerId, tail: request.tail, leave });
  return { url: join(endpoint.baseUrl, '/v1beta/interactions'), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body };
}

/** Google's error codes, as kinds. @type {Record<string, string>} */
const CODES = {
  too_many_requests: 'rate', resource_exhausted: 'rate', unavailable: 'overloaded', overloaded: 'overloaded',
  unauthenticated: 'auth', permission_denied: 'auth', not_found: 'not-found', invalid_request: 'bad-request', invalid_argument: 'bad-request',
  internal: 'server', gateway_timeout: 'server', deadline_exceeded: 'server',
};

/**
 * The kind of an error Google names by its code, or null for a code annai doesn't know. A file it can't
 * find (one it deleted after 48 hours) is an upload to send again (measured 2026-10-19: 403 permission_denied).
 * @param {unknown} code @param {unknown} message @returns {string | null}
 */
export function codeKind(code, message) {
  if (/\bfile\b/i.test(String(message ?? '')) && /not exist|not found|permission to access/i.test(String(message ?? ''))) return 'upload';
  return CODES[String(code ?? '').toLowerCase()] ?? null;
}

/** The error in a body Google sent: one object, or a list of one. @param {string} body @returns {any} */
function errorOf(body) {
  try {
    const j = JSON.parse(body);
    return (Array.isArray(j) ? j[0] : j)?.error ?? null;
  } catch {
    return null;
  }
}

/**
 * A sharper kind for an error response, or null for core's own reading. A 429 is too many requests,
 * whatever its words say ("quota"), and its daily free limit too; a 400 core reads as it is, so a photo
 * Gemini refused is repaired and an audio format it refused is sent again as WAV (spec §10.6).
 * @param {number} status @param {string} body
 */
export function classify(status, body) {
  const e = errorOf(body) ?? {};
  const message = String(e.message ?? body);
  if (status === 429) return 'rate';
  if (status === 503) return 'overloaded';
  if (/api key not valid|api_key_invalid/i.test(message)) return 'auth';
  const kind = codeKind(e.status ?? e.code, message);
  if (kind === 'upload') return kind;
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) return /token count|maximum number of tokens|context window/i.test(message) ? 'context' : null;
  return kind;
}

/** A Go duration's units, in ms; ms before m, so the m of "500ms" isn't minutes. */
const UNITS = /** @type {Record<string, number>} */ ({ h: 3600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, 'µs': 0.001, ns: 0.000001 });

/**
 * The wait a 429 asks for in its words, in ms, or undefined. Google writes a Go duration: "Please retry in 44s",
 * "retry in 7h40m31s", "500ms", "1.5s".
 * @param {string} body
 */
export function retryAfter(body) {
  const d = /retry in ((?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+)/i.exec(String(body))?.[1];
  if (!d) return undefined;
  let ms = 0;
  for (const [, n, unit] of d.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gi)) ms += Number(n) * UNITS[unit.toLowerCase()];
  return Math.round(ms);
}

/** Models that generate content but aren't for chat: speech, live, images, music, embeddings, agents and the like. */
const NOT_CHAT = /tts|live|embedding|image|native-audio|transcribe|translate|robotics|lyria|nano-banana|veo|computer-use|deep-research|antigravity|aqa/;

/**
 * The chat models a model list names, with their windows, output limits and thinking levels (spec §9.2).
 * @param {any} json @returns {import('../../src/core/llm/contract.js').ListedModel[]}
 */
export function readList(json) {
  return (Array.isArray(json?.models) ? json.models : []).flatMap((/** @type {any} */ m) => {
    const id = String(m?.name ?? '').replace(/^models\//, '');
    if (!id || !m.supportedGenerationMethods?.includes?.('generateContent') || NOT_CHAT.test(id)) return [];
    const reasoning = m.thinking ? levelsFor(id) : undefined;
    return [{
      providerId: id, ...(m.displayName ? { name: String(m.displayName) } : {}),
      ...(Number.isInteger(m.inputTokenLimit) ? { contextWindow: m.inputTokenLimit } : {}), ...(Number.isInteger(m.outputTokenLimit) ? { maxOutput: m.outputTokenLimit } : {}),
      // Google says Gemini's own models take PDFs and audio; another family (Gemma) words and photos.
      input: id.startsWith('gemini-') ? ['text', 'image', 'pdf', 'audio'] : ['text', 'image'], ...(reasoning ? { reasoning } : {}),
    }];
  });
}

/** Whether an error Google sent is its safety filter's block (measured 2026-10-19: a 400, streamed too). @param {any} e */
function isBlock(e) {
  return isObject(e) && /blocked due to safety|prohibited use/i.test(`${e.message ?? ''} ${e.code ?? ''}`);
}

/** Google's reason for a block, in words, and that the message stays out from now on. @param {any} e @param {boolean} left */
function refusalText(e, left) {
  const why = String(e.message ?? '').match(/\(([^)]{1,80})\)/)?.[1];
  return `Google blocked this reply for safety${why ? ` (${why})` : ''}.${left ? ' That message stays out of what Gemini is sent from now on.' : ''}`;
}

/**
 * Usage, normalized: Google's input counts cached tokens and every modality, which annai counts apart;
 * thinking is billed as output, and counted on its own too.
 * @param {any} u
 */
export function usageOf(u) {
  const by = (/** @type {any} */ list, /** @type {string[]} */ kinds) => (Array.isArray(list) ? list : []).reduce((n, m) => n + (kinds.includes(String(m?.modality).toLowerCase()) ? Number(m.tokens) || 0 : 0), 0);
  const cached = Number(u.total_cached_tokens) || 0;
  const cachedAudio = by(u.cached_tokens_by_modality, ['audio']);
  const cachedImage = by(u.cached_tokens_by_modality, ['image', 'video']);
  const audio = Math.max(0, by(u.input_tokens_by_modality, ['audio']) - cachedAudio);
  const image = Math.max(0, by(u.input_tokens_by_modality, ['image', 'video']) - cachedImage);
  const thought = Number(u.total_thought_tokens) || 0;
  return {
    // A tool's tokens Google counts apart (total_tool_use_tokens) are input too.
    input: Math.max(0, (Number(u.total_input_tokens) || 0) - cached - audio - image) + (Number(u.total_tool_use_tokens) || 0),
    cacheRead: Math.max(0, cached - cachedAudio - cachedImage),
    ...(cachedAudio ? { cacheReadAudio: cachedAudio } : {}),
    ...(cachedImage ? { cacheReadImage: cachedImage } : {}),
    ...(audio ? { audioIn: audio } : {}),
    ...(image ? { image } : {}),
    output: (Number(u.total_output_tokens) || 0) + thought,
    reasoning: thought,
  };
}

/** A call's arguments; the raw text when they aren't valid JSON, for the tool to refuse. @param {string} args @param {any} started */
function parseArgs(args, started) {
  if (!args) return isObject(started) ? started : {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Each step as it streams: a thought gathers its summary and signature, a call its arguments, and
 * each is given whole at its step.stop; the words as they come.
 */
class Steps {
  /** @type {Map<number, any>} */
  #open = new Map();
  called = false;
  /** Whether any words were given: a block's then start a new paragraph. */
  said = false;

  /** @param {number} index @param {any} step @returns {any[]} */
  start(index, step) {
    const s = { ...step, summary: [], args: '' };
    this.#open.set(index, s);
    if (s.type === 'function_call') return [{ type: 'tool_input', id: String(s.id ?? ''), name: String(s.name ?? ''), partial: '' }];
    if (s.type === 'model_output') return (Array.isArray(step.content) ? step.content : []).filter((c) => c?.type === 'text' && c.text).map((c) => this.#words(c.text));
    return [];
  }

  /** @param {number} index @param {any} d @returns {any[]} */
  delta(index, d) {
    const s = this.#open.get(index) ?? this.#open.set(index, { type: d?.type === 'text' ? 'model_output' : '', summary: [], args: '' }).get(index);
    if (d?.type === 'text') return d.text ? [this.#words(d.text)] : [];
    if (d?.type === 'thought_signature') s.signature = String(d.signature ?? '');
    if (d?.type === 'thought_summary' && d.content?.text) {
      s.summary.push(String(d.content.text));
      return [{ type: 'reasoning_delta', text: String(d.content.text) }];
    }
    if (d?.type === 'arguments_delta' && typeof d.arguments === 'string') {
      s.args += d.arguments;
      return [{ type: 'tool_input', id: String(s.id ?? ''), name: String(s.name ?? ''), partial: s.args }];
    }
    return [];
  }

  /** @param {unknown} text */
  #words(text) {
    this.said = true;
    return { type: 'text', text: String(text) };
  }

  /** @param {number} index @returns {any[]} */
  stop(index) {
    const s = this.#open.get(index);
    this.#open.delete(index);
    if (s?.type === 'thought') {
      const text = s.summary.join('');
      return s.signature || text ? [{ type: 'reasoning', text, ...(s.signature ? { signature: s.signature } : {}) }] : [];
    }
    if (s?.type === 'function_call') {
      this.called = true;
      return [{ type: 'tool_call', id: String(s.id ?? ''), name: String(s.name ?? ''), input: parseArgs(s.args, s.arguments), ...(s.signature ? { extra: { signature: s.signature } } : {}) }];
    }
    return [];
  }
}

/**
 * The events of a streamed interaction, or of a whole one from a server that ignores stream: only
 * application/json, and only when it isn't a stream after all.
 * @param {Response} res @param {{ sse: any, ProviderError: any, left: () => boolean }} h left: leaves the request's
 *   last user message out from now on, after a safety block (blocked.js); false when it has none
 */
async function* read(res, h) {
  let body = res.body;
  if (/^application\/json\s*(;|$)/i.test(res.headers.get('content-type') ?? '')) {
    /** @type {string} */
    let text;
    try {
      text = await res.text();
    } catch (e) {
      // A connection that drops on the way is a dropped connection, as a stream's is: never a bug of the plugin's.
      if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
      throw new h.ProviderError('network', 'The connection dropped.', { cause: e });
    }
    if (!/^\s*(data:|event:|:)/.test(text)) {
      yield* readWhole(text, h);
      return;
    }
    body = new Response(text).body;
  }
  const steps = new Steps();
  for await (const { event, data } of h.sse(/** @type {ReadableStream<Uint8Array>} */ (body))) {
    if (data === '[DONE]') break;
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    const type = e.event_type ?? event;
    if (type === 'step.start') yield* steps.start(e.index, e.step ?? {});
    else if (type === 'step.delta') yield* steps.delta(e.index, e.delta);
    else if (type === 'step.stop') yield* steps.stop(e.index);
    else if (type === 'error') {
      yield* failed(e.error ?? e, h, steps.said);
      return;
    } else if (type === 'interaction.completed') {
      yield* end(e.interaction ?? {}, steps, h);
      return;
    }
  }
  throw new h.ProviderError('network', 'The reply stopped before it finished.');
}

/** A safety block as a refusal, its words a paragraph of their own; any other error as the error it is. @param {any} err @param {any} h @param {boolean} said */
function* failed(err, h, said) {
  if (isBlock(err)) {
    yield { type: 'text', text: `${said ? '\n\n' : ''}${refusalText(err, h.left())}` };
    yield { type: 'stop', reason: 'refusal' };
    return;
  }
  throw new h.ProviderError(codeKind(err?.code, err?.message) ?? 'server', String(err?.message ?? 'Gemini reported an error.'));
}

/** Usage and the stop reason of a finished interaction; a failed one is its error. @param {any} it @param {Steps} steps @param {any} h */
function* end(it, steps, h) {
  if (it.status === 'failed') {
    yield* failed((Array.isArray(it.errors) ? it.errors[0] : it.error) ?? {}, h, steps.said);
    return;
  }
  if (isObject(it.usage)) yield { type: 'usage', usage: usageOf(it.usage) };
  const reason = it.status === 'completed' && steps.called ? 'tool' : STOP[it.status] ?? 'other';
  yield { type: 'stop', reason };
}

/**
 * The events of one whole interaction, in a stream's order: each step's own, then usage and the
 * stop reason. An error in its place is that error, as an HTTP error's would be.
 * @param {string} text @param {any} h
 */
function* readWhole(text, h) {
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw new h.ProviderError('server', "Gemini answered with a whole reply annai can't read, rather than a stream.");
  }
  if (isObject(r?.error) && !Array.isArray(r.steps)) {
    yield* failed(r.error, h, false);
    return;
  }
  if (!isObject(r) || (!Array.isArray(r.steps) && r.status !== 'failed')) throw new h.ProviderError('server', 'Gemini answered with a whole reply that had no answer in it.');
  const steps = new Steps();
  for (const [i, step] of (r.steps ?? []).entries()) {
    if (!isObject(step)) continue;
    const { summary, signature, content, ...rest } = step;
    yield* steps.start(i, step.type === 'model_output' ? rest : step);
    if (step.type === 'thought') {
      for (const s of Array.isArray(summary) ? summary : []) yield* steps.delta(i, { type: 'thought_summary', content: s });
      if (signature) yield* steps.delta(i, { type: 'thought_signature', signature });
    }
    if (step.type === 'model_output') for (const c of Array.isArray(content) ? content : []) if (c?.type === 'text') yield* steps.delta(i, c);
    yield* steps.stop(i);
  }
  yield* end(r, steps, h);
}
