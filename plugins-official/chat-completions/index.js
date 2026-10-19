/**
 * The Chat Completions endpoint type (spec §9.1): annai's request in, an OpenAI-style streamed
 * chat completion out. Used by OpenAI, OpenRouter, Gemini's OpenAI-compatible endpoint, Groq,
 * DeepSeek, Mistral and local servers; their differences are tunables (spec §9.2). Audio a model takes goes as
 * input_audio (OpenRouter, Gemini, OpenAI's audio models). A server that never streams answers with one
 * whole JSON completion, which is read as the same events (item 24, 2026-10-18).
 */
const TUNABLES = Object.freeze({
  path: '/chat/completions',
  maxTokensField: 'max_tokens', // OpenAI's newer models want "max_completion_tokens"
  systemRole: 'system', // or "developer"
  usageInStream: true, // ask for usage in the stream (stream_options.include_usage)
  reasoningField: 'auto', // where reasoning text comes back: "reasoning" (OpenRouter), "reasoning_content" (DeepSeek), or either
  imageDetail: null, // e.g. "high"
  enforceToolCall: false, // a tool the model must call, when it is the one offered, goes as tool_choice "required": llama.cpp ignores one named
  audioIn: ['wav', 'mp3'], // what input_audio takes: OpenAI's and Gemini's take only these; OpenRouter's say more (spec §10.6)
});
const STOP = /** @type {Record<string, string>} */ ({ stop: 'end', tool_calls: 'tool', function_call: 'tool', length: 'length', content_filter: 'refusal' });
const CODES = /** @type {Record<string, string>} */ ({ context_length_exceeded: 'context', insufficient_quota: 'credit', invalid_api_key: 'auth', model_not_found: 'not-found' });
const AUDIO = /** @type {Record<string, string>} */ ({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/mp4': 'm4a' });

/** @param {any} annai */
export function activate(annai) {
  const { sse, ProviderError, errorFromResponse } = annai.helpers;
  return annai.providers.register({
    type: 'chat-completions',
    name: 'Chat Completions',
    tunables: TUNABLES,
    tail: true,
    /** @param {any} c */
    build: (c) => build(c),
    /** @param {Response} res @param {any} c */
    read: (res, c) => read(res, c, { sse, ProviderError, errorFromResponse }),
    classify,
    /** @param {{ endpoint: any, key: string | null }} c */
    listRequest: ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/models'), headers: auth(endpoint, key) }),
    readList,
  });
}

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {unknown} x @returns {x is Record<string, unknown>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/** @param {any} endpoint @param {string | null} key @returns {Record<string, string>} */
function auth(endpoint, key) {
  return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(endpoint.headers ?? {}) };
}

/** @param {any} c */
function build({ endpoint, model, key, tunables: t, request }) {
  /** @type {any[]} */
  const messages = [];
  if (request.system) messages.push({ role: t.systemRole, content: request.system });
  for (const m of request.messages) messages.push(...wire(m, t));
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, messages, stream: true };
  if (t.usageInStream) body.stream_options = { include_usage: true };
  const max = request.maxOutput ?? model.maxOutput;
  if (max) body[t.maxTokensField] = max;
  if (request.tools?.length) {
    body.tools = request.tools.map((/** @type {any} */ x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.input } }));
  }
  if (request.toolChoice) {
    // "required" forces a call to some tool: the one named, when it is the only one offered (the user, 2026-10-19).
    const only = request.tools?.length === 1 && request.tools[0].name === request.toolChoice;
    body.tool_choice = t.enforceToolCall && only ? 'required' : { type: 'function', function: { name: request.toolChoice } };
  }
  if (request.logprobs) {
    body.logprobs = true;
    body.top_logprobs = request.logprobs;
  }
  if (request.tail) addTail(messages, request.tail);
  return { url: join(endpoint.baseUrl, t.path), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body };
}

/** The now block, last: on the final user message, or as its own after tool results (spec §6.3). @param {any[]} messages @param {string} tail */
function addTail(messages, tail) {
  const last = messages.at(-1);
  if (last?.role !== 'user') messages.push({ role: 'user', content: tail });
  else if (typeof last.content === 'string') last.content = `${last.content}\n\n${tail}`;
  else last.content.push({ type: 'text', text: tail });
}

/** One of annai's messages as chat messages: tool results become "tool" messages ahead of the rest. @param {any} m @param {any} t */
function wire(m, t) {
  if (m.role === 'assistant') {
    const text = m.parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text).join('');
    const calls = m.parts.filter((/** @type {any} */ p) => p.type === 'tool_call');
    if (!text && !calls.length) return []; // only reasoning: an empty assistant message is refused by some servers
    /** @type {any} */
    const out = { role: 'assistant', content: text || null };
    if (calls.length) out.tool_calls = calls.map((/** @type {any} */ c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(isObject(c.input) ? c.input : {}) } }));
    return [out];
  }
  const results = m.parts.filter((/** @type {any} */ p) => p.type === 'tool_result').map((/** @type {any} */ p) => ({ role: 'tool', tool_call_id: p.id, content: p.content }));
  const rest = m.parts.filter((/** @type {any} */ p) => p.type === 'text' || p.type === 'image' || p.type === 'document' || p.type === 'audio');
  if (!rest.length) return results;
  const content = rest.every((/** @type {any} */ p) => p.type === 'text')
    ? rest.map((/** @type {any} */ p) => p.text).join('\n')
    : rest.map((/** @type {any} */ p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      if (p.type === 'document') return { type: 'file', file: { filename: p.name ?? 'document.pdf', file_data: `data:${p.mediaType};base64,${p.data}` } };
      if (p.type === 'audio') return { type: 'input_audio', input_audio: { data: p.data, format: AUDIO[p.mediaType] ?? 'wav' } };
      return { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}`, ...(t.imageDetail ? { detail: t.imageDetail } : {}) } };
    });
  return [...results, { role: 'user', content }];
}

/**
 * The events of a streamed chat completion. Reasoning is gathered into one block, given before the
 * first text or tool call; tool calls are given whole at the end, with their arguments as they arrive.
 * @param {Response} res @param {any} c @param {any} helpers
 */
async function* read(res, { tunables: t }, { sse, ProviderError, errorFromResponse }) {
  let body = res.body;
  if (whole(res)) {
    const text = await textOf(res, ProviderError);
    // A stream sent as JSON is still a stream.
    if (!STREAMED.test(text)) {
      yield* readWhole(jsonOf(text, ProviderError), t, { ProviderError, errorFromResponse });
      return;
    }
    body = new Response(text).body;
  }
  /** @type {Map<number, { id: string, name: string, args: string }>} */
  const calls = new Map();
  let reasoning = '';
  /** @type {string | null} */
  let finish = null;
  let done = false;
  let sentLogprobs = false;
  const flush = () => {
    const r = reasoning;
    reasoning = '';
    return r ? [{ type: 'reasoning', text: r }] : [];
  };
  for await (const { data } of sse(/** @type {ReadableStream<Uint8Array>} */ (body))) {
    if (data === '[DONE]') {
      done = true;
      break;
    }
    /** @type {any} */
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw errorIn(chunk.error, { ProviderError, errorFromResponse });
    const choice = chunk.choices?.[0];
    const d = choice?.delta ?? {};
    const lp = choice?.logprobs?.content?.[0];
    if (lp && !sentLogprobs) {
      sentLogprobs = true;
      const top = Array.isArray(lp.top_logprobs) && lp.top_logprobs.length ? lp.top_logprobs : [lp];
      yield { type: 'logprobs', top: top.map((/** @type {any} */ x) => ({ token: String(x.token), logprob: Number(x.logprob) })) };
    }
    const r = t.reasoningField === 'auto' ? d.reasoning_content ?? d.reasoning : d[t.reasoningField];
    if (typeof r === 'string' && r) {
      reasoning += r;
      yield { type: 'reasoning_delta', text: r };
    }
    if (typeof d.content === 'string' && d.content) {
      yield* flush();
      yield { type: 'text', text: d.content };
    }
    for (const tc of d.tool_calls ?? []) {
      yield* flush();
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name && !cur.name) cur.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
      calls.set(i, cur);
      yield { type: 'tool_input', id: cur.id, name: cur.name, partial: cur.args };
    }
    for (const a of [...(d.annotations ?? []), ...(choice?.message?.annotations ?? [])]) {
      const c = a?.url_citation;
      if (a?.type === 'url_citation' && c?.url) yield { type: 'citation', url: c.url, ...(c.title ? { title: c.title } : {}) };
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) yield { type: 'usage', usage: usageOf(chunk.usage) };
  }
  if (!done && !finish) throw new ProviderError('network', 'The reply stopped before it finished.');
  yield* flush();
  for (const [i, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args) };
  }
  yield { type: 'stop', reason: STOP[finish ?? 'stop'] ?? 'other' };
}

/** An error the reply holds, as an HTTP error's would be: by its code, sharpened by classify. @param {any} error @param {any} helpers */
function errorIn(error, { ProviderError, errorFromResponse }) {
  const e = errorFromResponse(typeof error.code === 'number' ? error.code : 500, JSON.stringify({ error }));
  const sharper = classify(e.status ?? 500, JSON.stringify({ error }));
  return new ProviderError(sharper ?? e.kind, e.message, { status: e.status });
}

/** What a stream's text starts with: an event's data or name, or a comment. */
const STREAMED = /^\s*(data:|event:|:)/;

/**
 * Whether an answer is one whole JSON reply rather than a stream: a server that ignores stream: true.
 * Only application/json, not NDJSON or problem+json. @param {Response} res
 */
function whole(res) {
  return /^application\/json\s*(;|$)/i.test(res.headers.get('content-type') ?? '');
}

/**
 * A whole reply's text. A connection that drops on the way is a dropped connection, tried elsewhere, as a
 * stream's is (sse.js): never a bug of the plugin's. @param {Response} res @param {any} ProviderError
 */
async function textOf(res, ProviderError) {
  try {
    return await res.text();
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
    throw new ProviderError('network', 'The connection dropped.', { cause: e });
  }
}

/** A whole reply's JSON. @param {string} text @param {any} ProviderError */
function jsonOf(text, ProviderError) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('server', "The endpoint answered with a whole reply annai can't read, rather than a stream.");
  }
}

/**
 * The events of one whole chat completion, in a stream's order: logprobs, reasoning, words, calls, sources, usage, the stop reason.
 * @param {any} j @param {any} t @param {any} helpers
 */
function* readWhole(j, t, helpers) {
  if (isObject(j?.error)) throw errorIn(j.error, helpers);
  const choice = j?.choices?.[0];
  const m = choice?.message;
  if (!isObject(m)) throw new helpers.ProviderError('server', 'The endpoint answered with a whole reply that had no answer in it.');
  const lp = choice.logprobs?.content?.[0];
  if (lp) {
    const top = Array.isArray(lp.top_logprobs) && lp.top_logprobs.length ? lp.top_logprobs : [lp];
    yield { type: 'logprobs', top: top.map((/** @type {any} */ x) => ({ token: String(x.token), logprob: Number(x.logprob) })) };
  }
  const r = t.reasoningField === 'auto' ? m.reasoning_content ?? m.reasoning : m[t.reasoningField];
  if (typeof r === 'string' && r) {
    yield { type: 'reasoning_delta', text: r };
    yield { type: 'reasoning', text: r };
  }
  const text = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((/** @type {any} */ p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  if (text) yield { type: 'text', text };
  for (const [i, tc] of (Array.isArray(m.tool_calls) ? m.tool_calls : []).entries()) {
    const id = String(tc?.id || `call_${i}`);
    const name = String(tc?.function?.name ?? '');
    const args = tc?.function?.arguments;
    yield { type: 'tool_input', id, name, partial: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
    yield { type: 'tool_call', id, name, input: typeof args === 'string' ? parseArgs(args) : isObject(args) ? args : {} };
  }
  for (const a of Array.isArray(m.annotations) ? m.annotations : []) {
    const c = a?.url_citation;
    if (a?.type === 'url_citation' && c?.url) yield { type: 'citation', url: c.url, ...(c.title ? { title: c.title } : {}) };
  }
  if (isObject(j.usage)) yield { type: 'usage', usage: usageOf(j.usage) };
  yield { type: 'stop', reason: STOP[choice.finish_reason ?? 'stop'] ?? 'other' };
}

/** A tool call's arguments; the raw text when they aren't valid JSON, for the tool to refuse. @param {string} args */
function parseArgs(args) {
  try {
    return JSON.parse(args || '{}');
  } catch {
    return args;
  }
}

/** Chat Completions usage, normalized: input leaves out cached tokens. @param {any} u */
function usageOf(u) {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached - written),
    cacheRead: cached,
    cacheWrite: written,
    output: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    ...(typeof u.cost === 'number' ? { cost: u.cost } : {}),
    ...(u.server_tool_use && typeof u.server_tool_use === 'object' ? { serverTools: { ...u.server_tool_use } } : {}),
  };
}

/** A sharper kind for an error, by its OpenAI-style code, or null. A provider's own limits are its plugin's (decision 15). @param {number} _status @param {string} body */
function classify(_status, body) {
  try {
    const e = JSON.parse(body)?.error;
    return CODES[String(e?.code ?? e?.type ?? '')] ?? null;
  } catch {
    return null;
  }
}

/** USD per token, as OpenRouter writes it, to USD per million tokens. @param {any} v */
const perMillion = (v) => (v === undefined || v === null || v === '' ? undefined : Number((Number(v) * 1e6).toPrecision(6)));

/** @param {any} p */
function pricesOf(p) {
  if (!p) return undefined;
  /** @type {Record<string, any>} */
  const out = { input: perMillion(p.prompt), output: perMillion(p.completion) };
  const extra = { cacheRead: p.input_cache_read, cacheWrite: p.input_cache_write, cacheWrite1h: p.input_cache_write_1h };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = perMillion(v);
  if (Array.isArray(p.overrides) && p.overrides.length) {
    out.tiers = p.overrides.map((/** @type {any} */ o) => {
      /** @type {Record<string, any>} */
      const tier = { above: (o.min_prompt_tokens ?? 1) - 1 };
      const pairs = { input: o.prompt, output: o.completion, cacheRead: o.input_cache_read, cacheWrite: o.input_cache_write, cacheWrite1h: o.input_cache_write_1h };
      for (const [k, v] of Object.entries(pairs)) if (v !== undefined) tier[k] = perMillion(v);
      return tier;
    });
  }
  return out;
}

/**
 * The models an endpoint lists. OpenRouter's list says much more than OpenAI's, which gives ids only; vLLM's and
 * SGLang's give the context they serve as max_model_len. llama.cpp's n_ctx_train is what the model was trained on,
 * not what the server serves, so it is left alone. @param {any} json
 */
function readList(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string').map((/** @type {any} */ m) => {
    /** @type {Record<string, any>} */
    const out = { providerId: m.id };
    if (m.name) out.name = m.name;
    const window = m.context_length ?? m.max_model_len ?? m.top_provider?.context_length;
    if (window) out.contextWindow = window;
    if (m.top_provider?.max_completion_tokens) out.maxOutput = m.top_provider.max_completion_tokens;
    const kinds = m.architecture?.input_modalities;
    if (Array.isArray(kinds)) out.input = ['text', 'image', 'audio'].filter((k) => kinds.includes(k));
    if (Array.isArray(m.supported_parameters)) out.tools = m.supported_parameters.includes('tools');
    const prices = pricesOf(m.pricing);
    if (prices) out.prices = prices;
    return out;
  });
}
