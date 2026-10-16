/**
 * The Anthropic Messages endpoint type (spec §9.1). Browsers may call Anthropic only with the
 * "anthropic-dangerous-direct-browser-access" header. Thinking comes back as signed blocks, which
 * are sent back unchanged to the model that wrote them (annai's core drops them for any other).
 */
const TUNABLES = Object.freeze({ path: '/v1/messages', version: '2023-06-01', browserAccess: true, beta: '', defaultMaxTokens: 8192 });
const STOP = /** @type {Record<string, string>} */ ({ end_turn: 'end', stop_sequence: 'end', tool_use: 'tool', max_tokens: 'length', refusal: 'refusal', pause_turn: 'pause' });
const TYPES = /** @type {Record<string, string>} */ ({
  authentication_error: 'auth', permission_error: 'auth', billing_error: 'credit', rate_limit_error: 'rate', overloaded_error: 'overloaded',
  request_too_large: 'context', not_found_error: 'not-found', api_error: 'server', timeout_error: 'server',
});

/** @param {any} annai */
export function activate(annai) {
  const { sse, ProviderError } = annai.helpers;
  return annai.providers.register({
    type: 'anthropic-messages',
    name: 'Anthropic Messages',
    tunables: TUNABLES,
    tail: true,
    /** @param {any} c */
    build: (c) => build(c),
    /** @param {Response} res */
    read: (res) => read(res, sse, ProviderError),
    classify,
    /** @param {{ endpoint: any, key: string | null }} c */
    listRequest: ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/v1/models'), headers: headersFor(endpoint, key, { ...TUNABLES, ...endpoint.tunables }) }),
    readList,
  });
}

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {string} ttl */
const cacheControl = (ttl) => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });

/** @param {any} endpoint @param {string | null} key @param {any} t @returns {Record<string, string>} */
function headersFor(endpoint, key, t) {
  return {
    'content-type': 'application/json',
    'anthropic-version': t.version,
    ...(key ? { 'x-api-key': key } : {}),
    ...(t.browserAccess ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    ...(t.beta ? { 'anthropic-beta': t.beta } : {}),
    ...(endpoint.headers ?? {}),
  };
}

/** @param {any} c */
function build({ endpoint, model, key, tunables: t, request }) {
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, max_tokens: request.maxOutput ?? model.maxOutput ?? t.defaultMaxTokens, messages: wire(request.messages, model.providerId), stream: true };
  if (request.system) body.system = [{ type: 'text', text: request.system, ...(request.cacheTtl ? { cache_control: cacheControl(request.cacheTtl) } : {}) }];
  if (request.tools?.length) body.tools = request.tools.map((/** @type {any} */ x) => ({ name: x.name, description: x.description, input_schema: x.input }));
  if (request.toolChoice) body.tool_choice = { type: 'tool', name: request.toolChoice };
  const last = body.messages.at(-1);
  if (request.cacheTtl && last) {
    const blocks = last.content;
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: cacheControl(request.cacheTtl) };
  }
  // The now block comes after the marker, so the cached prefix of this request is a prefix of the next one (spec §6.3).
  // A request that ends with Shiori's own message is a paused turn being continued, so it gets no tail.
  if (request.tail) {
    if (last?.role === 'user') last.content.push({ type: 'text', text: request.tail });
    else if (!last) body.messages.push({ role: 'user', content: [{ type: 'text', text: request.tail }] });
  }
  return { url: join(endpoint.baseUrl, t.path), headers: headersFor(endpoint, key, t), body };
}

/**
 * annai's messages as Messages API messages: one message per turn (messages of the same role are
 * joined), tool results first in a user turn, and thinking only when this model signed it.
 * @param {any[]} messages @param {string} providerId
 */
function wire(messages, providerId) {
  /** @type {{ role: string, content: any[] }[]} */
  const out = [];
  for (const m of messages) {
    const blocks = m.parts.flatMap((/** @type {any} */ p) => {
      if (p.type === 'text') return [{ type: 'text', text: p.text }];
      if (p.type === 'image') return [{ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }];
      if (p.type === 'document') return [{ type: 'document', source: { type: 'base64', media_type: p.mediaType, data: p.data }, ...(p.name ? { title: p.name } : {}) }];
      if (p.type === 'tool_call') return [{ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} }];
      if (p.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: p.id, content: p.content, ...(p.isError ? { is_error: true } : {}) }];
      if (p.type === 'reasoning' && p.model === providerId) {
        if (p.redacted) return [{ type: 'redacted_thinking', data: p.redacted }];
        if (p.signature) return [{ type: 'thinking', thinking: p.text, signature: p.signature }];
      }
      return [];
    });
    if (!blocks.length) continue;
    const prev = out.at(-1);
    if (prev && prev.role === m.role) prev.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  return out;
}

/** The events of a streamed Messages API reply. @param {Response} res @param {any} sse @param {any} ProviderError */
async function* read(res, sse, ProviderError) {
  /** @type {Map<number, any>} */
  const blocks = new Map();
  /** @type {string | null} */
  let stop = null;
  let finished = false;
  for await (const { event, data } of sse(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    const type = e.type ?? event;
    if (type === 'error') {
      throw new ProviderError(TYPES[e.error?.type] ?? 'server', String(e.error?.message ?? 'The provider reported an error.'));
    } else if (type === 'message_start') {
      const u = e.message?.usage;
      if (u) yield { type: 'usage', usage: usageOf(u) };
    } else if (type === 'content_block_start') {
      const b = { ...e.content_block, json: '', thinking: e.content_block?.thinking ?? '', signature: e.content_block?.signature ?? '' };
      blocks.set(e.index, b);
      if (b.type === 'text' && b.text) yield { type: 'text', text: b.text };
    } else if (type === 'content_block_delta') {
      const b = blocks.get(e.index) ?? {};
      const d = e.delta ?? {};
      if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
      else if (d.type === 'thinking_delta') {
        b.thinking = (b.thinking ?? '') + d.thinking;
        if (d.thinking) yield { type: 'reasoning_delta', text: d.thinking };
      }
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
      else if (d.type === 'input_json_delta') {
        b.json = (b.json ?? '') + d.partial_json;
        yield { type: 'tool_input', id: b.id, name: b.name, partial: b.json };
      }
    } else if (type === 'content_block_stop') {
      const b = blocks.get(e.index);
      if (b?.type === 'thinking') yield { type: 'reasoning', text: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
      else if (b?.type === 'redacted_thinking') yield { type: 'reasoning', text: '', redacted: b.data };
      else if (b?.type === 'tool_use') yield { type: 'tool_call', id: b.id, name: b.name, input: parseArgs(b.json) };
    } else if (type === 'message_delta') {
      if (e.delta?.stop_reason) stop = e.delta.stop_reason;
      if (e.usage) yield { type: 'usage', usage: usageOf(e.usage) };
    } else if (type === 'message_stop') {
      finished = true;
      break;
    }
  }
  if (!finished) throw new ProviderError('network', 'The reply stopped before it finished.');
  yield { type: 'stop', reason: STOP[stop ?? 'end_turn'] ?? 'other' };
}

/** @param {string} json */
function parseArgs(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return json;
  }
}

/** Anthropic usage, normalized; only the numbers this report gives. @param {any} u */
function usageOf(u) {
  /** @type {Record<string, number>} */
  const out = {};
  if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation) {
    out.cacheWrite = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
    out.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else if (typeof u.cache_creation_input_tokens === 'number') {
    out.cacheWrite = u.cache_creation_input_tokens;
  }
  if (typeof u.output_tokens === 'number') out.output = u.output_tokens;
  return out;
}

/** @param {number} _status @param {string} body */
function classify(_status, body) {
  /** @type {any} */
  let e;
  try {
    e = JSON.parse(body)?.error;
  } catch {
    return null;
  }
  if (!e?.type) return null;
  if (TYPES[e.type]) return TYPES[e.type];
  if (e.type !== 'invalid_request_error') return null;
  const m = String(e.message ?? '');
  if (/prompt is too long|too many tokens|context/i.test(m)) return 'context';
  if (/credit balance/i.test(m)) return 'credit';
  if (/image/i.test(m)) return 'image';
  return 'bad-request';
}

/** @param {any} json */
function readList(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string').map((/** @type {any} */ m) => {
    /** @type {Record<string, any>} */
    const out = { providerId: m.id };
    if (m.display_name) out.name = m.display_name;
    if (m.max_input_tokens) out.contextWindow = m.max_input_tokens;
    if (m.max_tokens) out.maxOutput = m.max_tokens;
    return out;
  });
}
