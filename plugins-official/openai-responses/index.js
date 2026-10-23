/**
 * The OpenAI Responses endpoint type (spec §9.1): annai's request in, a streamed `POST /responses`
 * out. A conversation's own turn is kept on OpenAI's side when annai asks (`store: true`), and the next one then sends
 * only what is new after it (`previous_response_id`; docs/plugins.md "Kept turns"). Every other call keeps nothing
 * (`store: false`), and a conversation sent whole carries its reasoning as encrypted items.
 * Reasoning comes back as encrypted items. Each is kept as a signed reasoning part, the item itself
 * as its signature, and sent back unchanged to the model that wrote it. A web search the model
 * made is a provider part, sent back the same way (spec §9.5). A server that never streams answers with
 * the whole response object as JSON, which is read as the same events (item 24, 2026-10-18).
 */
const TUNABLES = Object.freeze({
  path: '/responses',
  nowRole: 'developer', // the now block's role: a developer message isn't where OpenAI's cache breakpoint goes, so the cached prefix ends before it (spec §6.3); "user" for servers without developer messages
  phase: true, // labels Shiori's words as "commentary" or "final_answer", as OpenAI's newer models want; false for servers that refuse it
  reasoningSummary: 'auto', // reasoning summaries, for models with reasoning levels; false where they aren't allowed (OpenAI may want a verified organization)
  encryptedReasoning: true, // asks models with reasoning levels for their reasoning as encrypted items, to send back (OpenAI sends them anyway); false for one that refuses it
  imageDetail: null, // e.g. "low", "high" or "original"; unset, the server chooses ("auto")
  uploads: true, // photos go to the files API once, then by id (spec §4.8)
  keep: false, // OpenAI's own provider turns it on (provider-openai): keeping the conversation between turns, so each sends only what is new, needs a server that honors store and previous_response_id
});
// Responses refuses a smaller max_output_tokens (plan choice 14).
const MIN_OUTPUT = 16;
const CODES = /** @type {Record<string, string>} */ ({
  context_length_exceeded: 'context',
  insufficient_quota: 'credit', credit_balance_exhausted: 'credit', billing_hard_limit_reached: 'credit',
  organization_spend_limit_exceeded: 'credit', project_spend_limit_exceeded: 'credit', organization_usage_limit_exceeded: 'credit',
  rate_limit_exceeded: 'rate', slow_down: 'rate',
  server_is_overloaded: 'overloaded',
  server_error: 'server', vector_store_timeout: 'server',
  invalid_api_key: 'auth',
  // A kept turn OpenAI no longer has (30 days, or deleted): annai sends the conversation whole, once.
  previous_response_not_found: 'forgotten',
  model_not_found: 'not-found',
  image_file_not_found: 'upload',
  // Blocked by policy: not a bad key, and not worth sending again.
  invalid_prompt: 'bad-request', bio_policy: 'bad-request', misalignment_policy_violation: 'bad-request', image_content_policy_violation: 'bad-request',
});
const INCOMPLETE = /** @type {Record<string, string>} */ ({ max_output_tokens: 'length', content_filter: 'refusal' });

/** @param {any} annai */
export function activate(annai) {
  const { sse, ProviderError, errorFromResponse } = annai.helpers;
  return annai.providers.register({
    type: 'openai-responses',
    name: 'OpenAI Responses',
    tunables: TUNABLES,
    tail: true,
    // OpenAI keeps a stored response at least 30 days, whatever the key, so annai tracks each 35 (its deletion waits that long) and
    // continues a chain 29 days after its first turn (a day short of 30, as an earlier response going would break the chain);
    // a chain with a photo in it ends sooner, before the photo's upload expires (call.js).
    keeps: { name: 'OpenAI', provider: 'provider-openai', days: 35, hours: 29 * 24, minLife: 10 * 60_000, holds: 'at least 30 days', note: "OpenAI also shows stored responses in your organization's dashboard logs, to its other members.", perModel: true },
    /** @param {any} c */
    build: (c) => build(c),
    /** @param {Response} res @param {any} c */
    read: (res, c) => read(res, sse, ProviderError, errorFromResponse, c?.keep === true, c?.kept?.id ?? null),
    classify,
    /** OpenAI's delete call for one kept response (200 with `deleted: true`; a response already gone is a 404, which annai counts as done). @param {{ endpoint: any, key: string | null, id: string }} c */
    forgetRequest: ({ endpoint, key, id }) => ({ url: join(endpoint.baseUrl, `/responses/${encodeURIComponent(id)}`), headers: auth(endpoint, key), method: /** @type {const} */ ('DELETE') }),
    /** A photo to the files API, for vision, expiring as asked (spec §4.8). @param {any} c */
    uploadRequest: ({ endpoint, key, bytes, mediaType, name, expiresInSeconds }) => {
      const body = new FormData();
      body.set('purpose', 'vision');
      body.set('expires_after[anchor]', 'created_at');
      body.set('expires_after[seconds]', String(expiresInSeconds));
      body.set('file', new Blob([bytes], { type: mediaType }), name);
      return { url: join(endpoint.baseUrl, '/files'), headers: auth(endpoint, key), body };
    },
    /** @param {any} j */
    readUpload: (j) => ({ id: String(j.id), ...(typeof j.expires_at === 'number' ? { expiresAt: j.expires_at * 1000 } : {}) }),
    /** Whether OpenAI has a response: 200 when it does, 404 when it doesn't (annai asks before it takes a missing one for a sign the account stores nothing). @param {{ endpoint: any, key: string | null, id: string }} c */
    lookRequest: ({ endpoint, key, id }) => ({ url: join(endpoint.baseUrl, `/responses/${encodeURIComponent(id)}`), headers: auth(endpoint, key) }),
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

/** @param {any} c keep: OpenAI keeps this turn; kept: the turn it continues, and the first message after it */
function build({ endpoint, model, key, tunables: t, request, keep, kept }) {
  /** @type {any[]} */
  const input = request.messages.slice(kept?.from ?? 0).flatMap((/** @type {any} */ m) => wire(m, model.providerId, t));
  // The now block, last, in a message of its own (plan choice 5).
  if (request.tail) input.push({ role: t.nowRole || 'developer', content: request.tail });
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, input, stream: true, store: keep === true };
  // The turn it continues (OpenAI doesn't carry `instructions` over from it, so they go every time).
  if (kept) body.previous_response_id = kept.id;
  if (request.system) body.instructions = request.system;
  // Only a model with reasoning levels takes a reasoning field or the include for it; each level's patch adds its effort (spec §9.3).
  const thinks = Object.keys(model.reasoning ?? {}).length > 0;
  /** @type {string[]} */
  const include = thinks && t.encryptedReasoning ? ['reasoning.encrypted_content'] : [];
  const max = request.maxOutput ?? model.maxOutput;
  if (max) body.max_output_tokens = Math.max(MIN_OUTPUT, max);
  if (request.tools?.length) {
    // strict false: left out, Responses makes a schema strict where it can, and every optional property required.
    body.tools = request.tools.map((/** @type {any} */ x) => ({ type: 'function', name: x.name, description: x.description, parameters: x.input, strict: false }));
  }
  if (request.toolChoice) body.tool_choice = { type: 'function', name: request.toolChoice };
  else if (request.toolRequired && body.tools) body.tool_choice = 'required';
  if (thinks && t.reasoningSummary) body.reasoning = { summary: t.reasoningSummary };
  if (request.logprobs) {
    body.top_logprobs = request.logprobs;
    include.push('message.output_text.logprobs');
  }
  if (include.length) body.include = include;
  return { url: join(endpoint.baseUrl, t.path), headers: { 'content-type': 'application/json', ...auth(endpoint, key) }, body };
}

/**
 * One of annai's messages as Responses input items. A user message's tool results come first. An
 * assistant message keeps its order: reasoning this model signed, its words with their phase, its
 * calls, and its own searches.
 * @param {any} m @param {string} providerId @param {any} t @returns {any[]}
 */
function wire(m, providerId, t) {
  const parts = /** @type {any[]} */ (m.parts);
  if (m.role === 'assistant') {
    const acts = (/** @type {any} */ p) => p.type === 'tool_call' || (p.type === 'provider' && p.model === providerId);
    const sent = (/** @type {any} */ p) => (p.type === 'text' && p.text) || acts(p);
    // Words before a call or a search of this reply are commentary; words after the last one, the final answer (OpenAI's own definition).
    const phase = (/** @type {number} */ i) => (t.phase ? { phase: parts.slice(i + 1).some(acts) ? 'commentary' : 'final_answer' } : {});
    return parts.flatMap((p, i) => {
      if (p.type === 'text') return p.text ? [{ role: 'assistant', content: p.text, ...phase(i) }] : [];
      // A call whose arguments were cut short kept them as text; the API takes a JSON object, so it gets an empty one.
      if (p.type === 'tool_call') return [{ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(isObject(p.input) ? p.input : {}) }];
      if (p.type === 'provider') return p.model === providerId ? [p.block] : [];
      if (p.type === 'reasoning' && p.model === providerId && p.signature) {
        // A reasoning item must be followed by what it led to: one that ended a reply cut short stays out.
        const item = replayable(p.signature);
        return item && parts.slice(i + 1).some(sent) ? [item] : [];
      }
      return [];
    });
  }
  const results = parts.filter((p) => p.type === 'tool_result').map((p) => ({ type: 'function_call_output', call_id: p.id, output: p.content }));
  const detail = t.imageDetail ? { detail: t.imageDetail } : {};
  const content = parts.flatMap(/** @returns {Record<string, any>[]} */ (p) => {
    if (p.type === 'text') return [{ type: 'input_text', text: p.text }];
    if (p.type === 'image') return [p.fileId ? { type: 'input_image', file_id: p.fileId, ...detail } : { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}`, ...detail }];
    if (p.type === 'document') return [{ type: 'input_file', filename: p.name ?? 'document.pdf', file_data: `data:${p.mediaType};base64,${p.data}` }];
    return []; // Responses has no audio input, so its models are added as taking none, and annai sends audio elsewhere (spec §9.6)
  });
  return content.length ? [...results, { role: 'user', content }] : results;
}

/**
 * The reasoning item a signature holds, when it can go back: with store false, one with neither
 * encrypted content nor its text would be looked up by id, and fail.
 * @param {string} signature @returns {any}
 */
function replayable(signature) {
  try {
    const item = JSON.parse(signature);
    return item?.type === 'reasoning' && (item.encrypted_content || (Array.isArray(item.content) && item.content.length)) ? item : null;
  } catch {
    return null;
  }
}

/**
 * Names a response once, from the first object that carries it: a `kept` event when the call keeps it and the server did
 * (an organization with Zero Data Retention answers `store: false`), then a check that the server continued the response it
 * was told to: one that echoes none, or another, ignored it (a proxy that drops the field), and answered without the
 * conversation. That is a turn forgotten, sent whole, and keeping stays off for the server until annai starts again.
 * @param {any} ProviderError @param {boolean} keep @param {string | null} chained
 */
function namer(ProviderError, keep, chained) {
  let named = false;
  return function* (/** @type {any} */ r) {
    if (named || !r || typeof r.id !== 'string' || !r.id) return;
    named = true;
    if (keep && r.store !== false) yield { type: 'kept', id: r.id };
    if (chained && r.previous_response_id !== undefined && r.previous_response_id !== chained) {
      throw new ProviderError('forgotten', 'The server ignored the conversation it was asked to continue, so annai sends it the whole conversation, and keeps nothing there until annai starts again.', { noChain: true });
    }
  };
}

/**
 * The events of a streamed response. Text, reasoning summaries and a call's arguments arrive as
 * they stream; each output item is given whole when it is done.
 * @param {Response} res @param {any} sse @param {any} ProviderError @param {any} errorFromResponse
 * @param {boolean} keep OpenAI keeps this turn, so its response is named first, as a `kept` event
 * @param {string | null} chained the response this one continues
 */
async function* read(res, sse, ProviderError, errorFromResponse, keep, chained) {
  const name = namer(ProviderError, keep, chained);
  let body = res.body;
  // One whole response object, from a server that ignores stream: true: only application/json, not NDJSON or problem+json.
  if (/^application\/json\s*(;|$)/i.test(res.headers.get('content-type') ?? '')) {
    /** @type {string} */
    let text;
    try {
      text = await res.text();
    } catch (e) {
      // A connection that drops on the way is a dropped connection, tried elsewhere, as a stream's is (sse.js): never a bug of the plugin's.
      if (/** @type {any} */ (e)?.name === 'AbortError' || /** @type {any} */ (e)?.name === 'TimeoutError') throw e;
      throw new ProviderError('network', 'The connection dropped.', { cause: e });
    }
    // A stream sent as JSON is still a stream.
    if (!/^\s*(data:|event:|:)/.test(text)) {
      yield* readWhole(text, ProviderError, errorFromResponse, name);
      return;
    }
    body = new Response(text).body;
  }
  /** @type {Map<number, { id: string, name: string, args: string }>} */
  const calls = new Map();
  /** @type {Set<string>} */
  const cited = new Set();
  /** A source, once. @param {any} a */
  const cite = (a) => {
    if (a?.type !== 'url_citation' || !a.url || cited.has(a.url)) return [];
    cited.add(a.url);
    return [{ type: 'citation', url: a.url, ...(a.title ? { title: a.title } : {}) }];
  };
  let searches = 0;
  let called = false;
  let refused = false;
  let sentLogprobs = false;
  /** @type {any} */
  let done = null;
  let incomplete = false;
  for await (const { event, data } of sse(/** @type {ReadableStream<Uint8Array>} */ (body))) {
    if (data === '[DONE]') break;
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    const type = e.type ?? event;
    // Whichever event first carries the response names it (created, normally; a proxy may drop that one).
    yield* name(e.response);
    if (type === 'response.output_text.delta') {
      const lp = Array.isArray(e.logprobs) ? e.logprobs[0] : null;
      if (lp && !sentLogprobs) {
        sentLogprobs = true;
        const top = Array.isArray(lp.top_logprobs) && lp.top_logprobs.length ? lp.top_logprobs : [lp];
        yield { type: 'logprobs', top: top.map((/** @type {any} */ x) => ({ token: String(x.token), logprob: Number(x.logprob) })) };
      }
      if (e.delta) yield { type: 'text', text: String(e.delta) };
    } else if (type === 'response.refusal.delta') {
      refused = true;
      if (e.delta) yield { type: 'text', text: String(e.delta) };
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (e.delta) yield { type: 'reasoning_delta', text: String(e.delta) };
    } else if (type === 'response.output_text.annotation.added') {
      yield* cite(e.annotation);
    } else if (type === 'response.output_item.added') {
      if (e.item?.type === 'function_call') {
        const cur = { id: String(e.item.call_id ?? ''), name: String(e.item.name ?? ''), args: String(e.item.arguments ?? '') };
        calls.set(e.output_index, cur);
        yield { type: 'tool_input', id: cur.id, name: cur.name, partial: cur.args };
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const cur = calls.get(e.output_index);
      if (cur && typeof e.delta === 'string') {
        cur.args += e.delta;
        yield { type: 'tool_input', id: cur.id, name: cur.name, partial: cur.args };
      }
    } else if (type === 'response.output_item.done') {
      yield* itemDone(e.item ?? {}, calls.get(e.output_index));
      if (e.item?.type === 'function_call') called = true;
      if (e.item?.type === 'web_search_call' && (!e.item.action || e.item.action.type === 'search')) searches++;
      if (e.item?.type === 'message') for (const c of e.item.content ?? []) for (const a of c?.annotations ?? []) yield* cite(a);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      done = e.response ?? {};
      incomplete = type === 'response.incomplete' || done.status === 'incomplete';
      break;
    } else if (type === 'response.failed') {
      const err = e.response?.error ?? {};
      throw new ProviderError(streamKind(err.code, err.message), String(err.message ?? 'The response failed.'));
    } else if (type === 'error') {
      const code = e.code ?? e.error?.code;
      const message = e.message ?? e.error?.message;
      throw new ProviderError(streamKind(code, message), String(message ?? 'The provider reported an error.'));
    }
  }
  if (!done) throw new ProviderError('network', 'The reply stopped before it finished.');
  if (done.usage || searches) yield { type: 'usage', usage: { ...(done.usage ? usageOf(done.usage) : {}), ...(searches ? { serverTools: { web_search_requests: searches } } : {}) } };
  const reason = incomplete ? INCOMPLETE[done.incomplete_details?.reason] ?? 'other' : refused ? 'refusal' : called ? 'tool' : 'end';
  yield { type: 'stop', reason };
}

/**
 * The events of one whole response object (a server that ignores stream: true), in a stream's order:
 * each output item's own, then usage and the stop reason. An error in its place is that error, as an
 * HTTP error's would be.
 * @param {string} text @param {any} ProviderError @param {any} errorFromResponse @param {ReturnType<typeof namer>} name
 */
function* readWhole(text, ProviderError, errorFromResponse, name) {
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw new ProviderError('server', "The endpoint answered with a whole reply annai can't read, rather than a stream.");
  }
  // Named first, even a failed response: the call deletes what it kept.
  yield* name(r);
  if (isObject(r?.error) && !Array.isArray(r.output)) {
    const e = errorFromResponse(typeof r.error.code === 'number' ? r.error.code : 500, JSON.stringify({ error: r.error }));
    throw new ProviderError(classify(e.status ?? 500, JSON.stringify({ error: r.error })) ?? e.kind, e.message, { status: e.status });
  }
  if (r?.status === 'failed') throw new ProviderError(streamKind(r.error?.code, r.error?.message), String(r.error?.message ?? 'The response failed.'));
  if (!Array.isArray(r?.output)) throw new ProviderError('server', 'The endpoint answered with a whole reply that had no answer in it.');
  let searches = 0;
  let called = false;
  let refused = false;
  let sentLogprobs = false;
  /** @type {Set<string>} */
  const cited = new Set();
  for (const item of /** @type {any[]} */ (r.output)) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning') {
      const said = /** @type {any[]} */ (itemDone(item, undefined));
      for (const e of said) if (e.text) yield { type: 'reasoning_delta', text: e.text };
      yield* said;
    } else if (item.type === 'message') {
      for (const c of Array.isArray(item.content) ? item.content : []) {
        const lp = Array.isArray(c?.logprobs) ? c.logprobs[0] : null;
        if (lp && !sentLogprobs) {
          sentLogprobs = true;
          const top = Array.isArray(lp.top_logprobs) && lp.top_logprobs.length ? lp.top_logprobs : [lp];
          yield { type: 'logprobs', top: top.map((/** @type {any} */ x) => ({ token: String(x.token), logprob: Number(x.logprob) })) };
        }
        if (c?.type === 'output_text' && c.text) yield { type: 'text', text: String(c.text) };
        if (c?.type === 'refusal' && c.refusal) {
          refused = true;
          yield { type: 'text', text: String(c.refusal) };
        }
        for (const a of Array.isArray(c?.annotations) ? c.annotations : []) {
          if (a?.type !== 'url_citation' || !a.url || cited.has(a.url)) continue;
          cited.add(a.url);
          yield { type: 'citation', url: a.url, ...(a.title ? { title: a.title } : {}) };
        }
      }
    } else {
      if (item.type === 'function_call') {
        called = true;
        yield { type: 'tool_input', id: String(item.call_id ?? ''), name: String(item.name ?? ''), partial: String(item.arguments ?? '') };
      }
      if (item.type === 'web_search_call' && (!item.action || item.action.type === 'search')) searches++;
      yield* itemDone(item, undefined);
    }
  }
  if (r.usage || searches) yield { type: 'usage', usage: { ...(r.usage ? usageOf(r.usage) : {}), ...(searches ? { serverTools: { web_search_requests: searches } } : {}) } };
  const incomplete = r.status === 'incomplete';
  yield { type: 'stop', reason: incomplete ? INCOMPLETE[r.incomplete_details?.reason] ?? 'other' : refused ? 'refusal' : called ? 'tool' : 'end' };
}

/**
 * The events of one output item, given whole: a call, reasoning (its summary as text, the item
 * as its signature when it can go back), or a search.
 * @param {any} item @param {{ args: string } | undefined} streamed
 */
function itemDone(item, streamed) {
  if (item.type === 'function_call') return [{ type: 'tool_call', id: String(item.call_id), name: String(item.name), input: parseArgs(item.arguments ?? streamed?.args ?? '') }];
  if (item.type === 'web_search_call') return [{ type: 'provider', block: item }];
  if (item.type !== 'reasoning') return [];
  const texts = (Array.isArray(item.summary) && item.summary.length ? item.summary : item.content ?? []).map((/** @type {any} */ s) => s?.text).filter(Boolean);
  const { status: _status, ...kept } = item;
  const json = JSON.stringify(kept);
  const signature = replayable(json) ? json : '';
  if (!texts.length && !signature) return [];
  return [{ type: 'reasoning', text: texts.join('\n\n'), ...(signature ? { signature } : {}) }];
}

/** A call's arguments; the raw text when they aren't valid JSON, for the tool to refuse. @param {string} args */
function parseArgs(args) {
  try {
    return JSON.parse(args || '{}');
  } catch {
    return args;
  }
}

/** Responses usage, normalized: input_tokens counts cache reads and writes, which annai counts apart. @param {any} u */
function usageOf(u) {
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const written = u.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cached - written),
    cacheRead: cached,
    cacheWrite: written,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** The kind for an OpenAI error code, or for its words about a photo or a file; null when neither says. @param {unknown} code @param {unknown} message */
function kindOf(code, message) {
  const c = String(code ?? '');
  if (CODES[c]) return CODES[c];
  // The words alone, as a 400 sends them (reports differ on its code): the earlier turn is gone.
  if (/previous response with id\b.*\bnot found/i.test(String(message ?? ''))) return 'forgotten';
  if (/image/.test(c)) return 'image';
  // An uploaded photo that expired or is unknown: upload it again (spec §9.9).
  const m = String(message ?? '');
  if (/\bfile\b/i.test(m) && /not found|expired|no such|does not exist/i.test(m)) return 'upload';
  return null;
}

/**
 * The kind of an error reported inside a stream. A code annai doesn't know is a bad request when it
 * says the request was wrong (not worth sending again), else a problem on the provider's side.
 * @param {unknown} code @param {unknown} message
 */
function streamKind(code, message) {
  return kindOf(code, message) ?? (/^(invalid|unsupported)_/.test(String(code ?? '')) ? 'bad-request' : 'server');
}

/** A sharper kind for an error response, or null. @param {number} _status @param {string} body */
function classify(_status, body) {
  try {
    const e = JSON.parse(body)?.error;
    return /** @type {any} */ (kindOf(e?.code ?? e?.type, e?.message));
  } catch {
    return null;
  }
}

/** The models an endpoint lists. OpenAI's gives ids only. @param {any} json */
function readList(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((/** @type {any} */ m) => typeof m?.id === 'string').map((/** @type {any} */ m) => ({ providerId: m.id }));
}
