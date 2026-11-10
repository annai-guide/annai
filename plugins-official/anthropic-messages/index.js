/**
 * The Anthropic Messages endpoint type (spec §9.1). Browsers may call Anthropic only with the
 * "anthropic-dangerous-direct-browser-access" header. Thinking comes back as signed blocks; their words are kept for
 * the trace (no signature, no redacted block, no empty block). A reply that finished, with thinking in it, is also given whole as it
 * came (a native: its content array), which annai sends back within the turn in place of the reply's parts: Claude 5.5 binds each
 * block to the system prompt, the tools and everything before it, its own reply's earlier blocks included, so only the reply exactly
 * as returned can go back (the keep-reasoning design §4). annai keeps the rest of the turn's requests as they were sent; a refusal
 * anyway is a bad request like another, and annai (callOnce) asks again without them, whatever the error's words (§8). A server tool (web search
 * or fetch) called beside one of annai's tools is left to the next request, which the API lets hold nothing but tool results there: settle.
 */
const TUNABLES = Object.freeze({ path: '/v1/messages', version: '2023-06-01', browserAccess: true, beta: '', defaultMaxTokens: 8192, uploads: true });
const STOP = /** @type {Record<string, string>} */ ({ end_turn: 'end', stop_sequence: 'end', tool_use: 'tool', max_tokens: 'length', refusal: 'refusal', pause_turn: 'pause' });
/** The stops whose reply is whole and can go back as it came. */
const WHOLE = new Set(['end_turn', 'stop_sequence', 'tool_use', 'pause_turn']);
/** The deltas read here: any other means a block might not be rebuilt as it came. */
const DELTAS = new Set(['text_delta', 'thinking_delta', 'signature_delta', 'input_json_delta', 'citations_delta']);
/** Marks the blocks of cacheAt's message, for its cache marker to find after the messages are joined and sorted. */
const AT = Symbol('cacheAt');
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
    /** A photo to the files API, expiring as asked (spec §4.8). @param {any} c */
    uploadRequest: ({ endpoint, key, tunables, bytes, mediaType, name, expiresInSeconds }) => {
      const headers = headersFor(endpoint, key, { ...TUNABLES, ...tunables });
      delete headers['content-type']; // FormData sets its own, with the boundary
      const body = new FormData();
      body.set('file', new Blob([bytes], { type: mediaType }), name);
      body.set('expires_in_seconds', String(expiresInSeconds));
      return { url: join(endpoint.baseUrl, '/v1/files'), headers, body };
    },
    /** @param {any} j */
    readUpload: (j) => ({ id: String(j.id), ...(j.expires_at ? { expiresAt: Date.parse(j.expires_at) } : {}) }),
    /** @param {{ endpoint: any, key: string | null }} c */
    listRequest: ({ endpoint, key }) => ({ url: join(endpoint.baseUrl, '/v1/models'), headers: headersFor(endpoint, key, { ...TUNABLES, ...endpoint.tunables }) }),
    readList,
  });
}

/** @param {string} base @param {string} path */
const join = (base, path) => String(base).replace(/\/+$/, '') + path;
/** @param {unknown} x @returns {x is Record<string, unknown>} */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
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
  const { messages, waiting } = settle(wire(request.messages, model.providerId, request.cacheAt), serverTools(model, request));
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, max_tokens: request.maxOutput ?? model.maxOutput ?? t.defaultMaxTokens, messages, stream: true };
  if (request.system) body.system = [{ type: 'text', text: request.system, ...(request.cacheTtl ? { cache_control: cacheControl(request.cacheTtl) } : {}) }];
  if (request.tools?.length) body.tools = request.tools.map((/** @type {any} */ x) => ({ name: x.name, description: x.description, input_schema: x.input }));
  if (request.toolChoice) body.tool_choice = { type: 'tool', name: request.toolChoice };
  const last = body.messages.at(-1);
  if (request.cacheTtl && last) {
    mark(last.content, last.content.length - 1, request.cacheTtl);
    // Where the previous turn began, as the request then marked it: the next turn's cache entry, within reach (the keep-reasoning design §7).
    const at = body.messages.find((/** @type {any} */ m) => m.content.some((/** @type {any} */ b) => b[AT]));
    if (at) mark(at.content, at.content.findLastIndex((/** @type {any} */ b) => b[AT]), request.cacheTtl);
  }
  // The marks were for finding blocks: none is sent.
  for (const m of body.messages) m.content = m.content.map((/** @type {any} */ b) => { const { [AT]: _at, ...rest } = b; return rest; });
  // The now block comes after the marker, so the cached prefix of this request is a prefix of the next one (spec §6.3).
  // A request that ends with Shiori's own message is a paused turn being continued, so it gets no tail; nor does one that runs a server
  // tool left waiting (settle): its last message holds the tool results alone.
  if (request.tail && !waiting) {
    if (last?.role === 'user') last.content.push({ type: 'text', text: request.tail });
    else if (!last) body.messages.push({ role: 'user', content: [{ type: 'text', text: request.tail }] });
  }
  return { url: join(endpoint.baseUrl, t.path), headers: headersFor(endpoint, key, t), body };
}

/** A cache marker on blocks[i], or on the nearest block before it that may carry one (never a thinking block). @param {any[]} blocks @param {number} i @param {string} ttl */
function mark(blocks, i, ttl) {
  let at = i;
  while (at >= 0 && (blocks[at].type === 'thinking' || blocks[at].type === 'redacted_thinking')) at--;
  if (at >= 0) blocks[at] = { ...blocks[at], cache_control: cacheControl(ttl) };
}

/**
 * annai's messages as Messages API messages: one message per turn (messages of the same role are
 * joined), tool results first in a user turn, a native's content in place of the parts it covers, and no other thinking (see the top).
 * @param {any[]} messages @param {string} providerId @param {number} [cacheAt] the message whose blocks are marked AT
 */
function wire(messages, providerId, cacheAt) {
  /** @type {{ role: string, content: any[] }[]} */
  const out = [];
  for (const [i, m] of messages.entries()) {
    let covered = 0;
    const blocks = m.parts.flatMap((/** @type {any} */ p) => {
      if (p.type === 'native') {
        covered = p.covers;
        return Array.isArray(p.content) ? p.content.map((/** @type {any} */ b) => ({ ...b })) : [];
      }
      if (covered > 0) {
        covered--;
        return [];
      }
      if (p.type === 'text') return [{ type: 'text', text: p.text }]; // a kept now block (now) is written as the tail was
      if (p.type === 'image') return [p.fileId ? { type: 'image', source: { type: 'file', file_id: p.fileId } } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }];
      if (p.type === 'document') return [{ type: 'document', source: { type: 'base64', media_type: p.mediaType, data: p.data }, ...(p.name ? { title: p.name } : {}) }];
      if (p.type === 'provider') return p.model === providerId ? [p.block] : [];
      // A call whose arguments were cut short kept them as text; the API takes only an object, so it gets an empty one.
      if (p.type === 'tool_call') return [{ type: 'tool_use', id: p.id, name: p.name, input: isObject(p.input) ? p.input : {} }];
      if (p.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: p.id, content: p.content, ...(p.isError ? { is_error: true } : {}) }];
      return [];
    });
    if (!blocks.length) continue;
    if (i === cacheAt) for (const b of blocks) b[AT] = true;
    const prev = out.at(-1);
    if (prev && prev.role === m.role) prev.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  return out;
}

/** A server tool's result block (a web search's or fetch's), not a client tool's. @param {any} b */
const isResult = (b) => typeof b.type === 'string' && b.type !== 'tool_result' && b.type.endsWith('_tool_result');
/** A reply's server tool calls that its own blocks don't answer. @param {{ role: string, content: any[] }} m */
const unanswered = (m) => m.role === 'assistant' ? m.content.filter((/** @type {any} */ b) => b.type === 'server_tool_use' && !m.content.some((/** @type {any} */ r) => isResult(r) && r.tool_use_id === b.id)) : [];

/**
 * The names of the server tools this request defines: the model's provider tools that the request asks for and doesn't switch off, as annai's
 * call.js (enabledProviderTools) picks them, each by the name of the tool its patch adds to the body's tools once build is done. Wrong
 * about a tool it can't see (an endpoint's own extra body), it only leaves out a call that would have run.
 * @param {any} model @param {any} request
 */
function serverTools(model, request) {
  const want = request.providerTools;
  const picked = want ? (model.providerTools ?? []).filter((/** @type {any} */ t) => want.kinds.includes(t.kind) && !(want.off ?? []).includes(t.id)) : [];
  return new Set(picked.flatMap((/** @type {any} */ t) => (t.patch?.['tools+'] ?? []).map((/** @type {any} */ x) => x.name)));
}

/**
 * A reply that calls a server tool (a web search or fetch) and a client tool together ends for the client tool with the server tool not
 * run: no result block comes with it. The API runs it when the next user message holds nothing but the client tools' results, and the reply
 * after begins with its result (Anthropic, "Mixing server tools and client tools in one turn"). Any other block in that message is a 400,
 * "`web_search` tool use with id ... was found without a corresponding `web_search_tool_result` block", at the end of the history and in the
 * middle of it, though the reply after carries the result; and a call that no reply after answers fails the same way (the real API, Opus,
 * Sonnet and Haiku 5.5, 2026-11-10). So, whatever is stored, in the messages sent:
 * - a call whose user message holds the tool results alone is run by this request, which then has no tail; once the reply after it
 *   answers it, that user message goes as it went, the tool results alone (a now block kept there since was never sent);
 * - any other call is left out of its reply: one whose user message holds anything else (the user's line or Koe's, a photo, a heard
 *   line: the model reads it all at once and searches again if it still wants to; that search is the only one, as the call left out
 *   never ran), one no reply after it answers (another model's or Koe's words came next, as in a conversation stored by 0.5.0 whose
 *   request was refused), or one this request would run with its tool missing (the API refuses that too: "but no `web_search` tool was
 *   provided"; web search switched off since). A reply left with nothing but thinking goes.
 * Nothing waits and nothing moves. A last message that is the reply is a paused turn, which continues as it is. What is sent before a
 * message is the same in every later request, so the thinking and the cache bound to it stay valid.
 * @param {{ role: string, content: any[] }[]} out the messages, tool results first in a user message
 * @param {Set<string>} defined the names of the server tools this request defines (serverTools)
 * @returns {{ messages: { role: string, content: any[] }[], waiting: boolean }} waiting: this request runs such a call (its last message holds the results alone)
 */
function settle(out, defined) {
  out.forEach((m, i) => {
    const next = out[i + 1];
    const open = next ? unanswered(m) : [];
    if (!open.length) return;
    const after = out[i + 2];
    const results = next.content.filter((/** @type {any} */ b) => b.type === 'tool_result');
    // Answered by the reply after, a call was run as a pair; run by this request, its message holds the results alone and its tool is defined.
    const runs = (/** @type {any} */ b) => results.length > 0 && (after ? after.content.some((/** @type {any} */ r) => isResult(r) && r.tool_use_id === b.id) : results.length === next.content.length && defined.has(b.name));
    const gone = new Set(open.filter((b) => !runs(b)).map((b) => b.id));
    if (gone.size < open.length) next.content = results;
    if (!gone.size) return;
    const rest = m.content.filter((/** @type {any} */ b) => !(b.type === 'server_tool_use' && gone.has(b.id)));
    m.content = rest.some((/** @type {any} */ b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') ? rest : [];
  });
  // A reply left empty goes, and the user messages around it are one.
  const messages = out.filter((m) => m.content.length).reduce((/** @type {typeof out} */ all, m) => {
    if (all.at(-1)?.role === m.role) all.at(-1)?.content.push(...m.content);
    else all.push(m);
    return all;
  }, []);
  const last = messages.at(-1);
  return { messages, waiting: last?.role === 'user' && unanswered(messages.at(-2) ?? { role: '', content: [] }).length > 0 };
}

/**
 * The events of a streamed Messages API reply; at its end, when it finished with thinking in it, the reply as it came (native).
 * @param {Response} res @param {any} sse @param {any} ProviderError
 */
async function* read(res, sse, ProviderError) {
  /** @type {Map<number, any>} what each block holds so far, as the API sent it */
  const blocks = new Map();
  /** @type {Map<number, { json: string }>} a tool block's arguments so far */
  const args = new Map();
  /** @type {string | null} */
  let stop = null;
  let finished = false;
  /** A delta this doesn't read: the reply can't be rebuilt as it came. */
  let odd = false;
  /** The hour's writes, once the stream gave the write split by lifetime: a later total holds them, and only the rest is 5-minute. */
  /** @type {number | null} */
  let hour = null;
  /** @type {Set<string>} */
  const cited = new Set();
  /** A source, once. @param {any} c */
  const cite = (c) => {
    if (!c?.url || cited.has(c.url)) return [];
    cited.add(c.url);
    return [{ type: 'citation', url: c.url, ...(c.title ? { title: c.title } : {}) }];
  };
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
      if (u?.cache_creation) hour = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
      if (u) yield { type: 'usage', usage: usageOf(u, hour) };
    } else if (type === 'content_block_start') {
      const b = structuredClone(e.content_block ?? {});
      blocks.set(e.index, b);
      if (b.type === 'tool_use' || b.type === 'server_tool_use') args.set(e.index, { json: '' });
      if (b.type === 'text' && b.text) yield { type: 'text', text: b.text };
      if (typeof b.type === 'string' && b.type.endsWith('_tool_result')) {
        // A server tool's result arrives whole: kept to send back unchanged, and its sources reported (spec §9.5).
        const block = { ...e.content_block };
        yield { type: 'provider', block };
        for (const r of Array.isArray(block.content) ? block.content : [block.content]) yield* cite(r);
      }
    } else if (type === 'content_block_delta') {
      const b = blocks.get(e.index) ?? {};
      const d = e.delta ?? {};
      if (!DELTAS.has(d.type)) odd = true;
      if (d.type === 'text_delta' && d.text) {
        b.text = (b.text ?? '') + d.text;
        yield { type: 'text', text: d.text };
      } else if (d.type === 'thinking_delta') {
        b.thinking = (b.thinking ?? '') + d.thinking;
        if (d.thinking) yield { type: 'reasoning_delta', text: d.thinking };
      } else if (d.type === 'signature_delta') {
        b.signature = (b.signature ?? '') + d.signature;
      } else if (d.type === 'input_json_delta') {
        const a = args.get(e.index) ?? { json: '' };
        a.json += d.partial_json;
        args.set(e.index, a);
        if (b.type === 'tool_use') yield { type: 'tool_input', id: b.id, name: b.name, partial: a.json };
      } else if (d.type === 'citations_delta') {
        b.citations = [...(Array.isArray(b.citations) ? b.citations : []), d.citation];
        yield* cite(d.citation);
      }
    } else if (type === 'content_block_stop') {
      const b = blocks.get(e.index);
      if (b?.type === 'tool_use' || b?.type === 'server_tool_use') b.input = parseArgs(args.get(e.index)?.json ?? '');
      if (b?.type === 'thinking') {
        if (b.thinking) yield { type: 'reasoning', text: b.thinking };
      } else if (b?.type === 'tool_use') yield { type: 'tool_call', id: b.id, name: b.name, input: b.input };
      else if (b?.type === 'server_tool_use') yield { type: 'provider', block: { type: 'server_tool_use', id: b.id, name: b.name, input: b.input } };
    } else if (type === 'message_delta') {
      if (e.delta?.stop_reason) stop = e.delta.stop_reason;
      if (e.usage?.cache_creation) hour = e.usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
      if (e.usage) yield { type: 'usage', usage: usageOf(e.usage, hour) };
    } else if (type === 'message_stop') {
      finished = true;
      break;
    }
  }
  if (!finished) throw new ProviderError('network', 'The reply stopped before it finished.');
  const content = [...blocks].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  const parsed = content.every((b) => (b.type !== 'tool_use' && b.type !== 'server_tool_use') || isObject(b.input));
  if (WHOLE.has(stop ?? 'end_turn') && !odd && parsed && content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) yield { type: 'native', content };
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

/**
 * Anthropic usage, normalized; only the numbers this report gives. The API's last report repeats the cache write as one total, without
 * the split by lifetime its first gave: once split, a total less the hour's writes is the 5-minute ones, not the whole total on top of
 * the hour's (the real check, 2026-10-30).
 * @param {any} u @param {number | null} [hour] the hour's writes, when the stream already gave the write split
 */
function usageOf(u, hour = null) {
  /** @type {Record<string, any>} */
  const out = {};
  if (u.server_tool_use && typeof u.server_tool_use === 'object') out.serverTools = { ...u.server_tool_use };
  if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation) {
    out.cacheWrite = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
    out.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else if (typeof u.cache_creation_input_tokens === 'number') {
    out.cacheWrite = hour === null ? u.cache_creation_input_tokens : Math.max(0, u.cache_creation_input_tokens - hour);
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
  // An uploaded photo that expired or is unknown: upload it again (spec §9.9).
  if (/\bfile\b[^.]*\b(not found|expired)/i.test(String(e.message ?? ''))) return 'upload';
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
