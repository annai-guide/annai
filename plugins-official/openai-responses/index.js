/**
 * The OpenAI Responses endpoint type (spec §9.1): annai's request in, a streamed `POST /responses`
 * out. Nothing is kept on the server (`store: false`): the whole conversation goes each time.
 * Reasoning comes back as encrypted items. Each is kept as a signed reasoning part, the item itself
 * as its signature, and sent back unchanged to the model that wrote it. A web search the model
 * made is a provider part, sent back the same way (spec §9.5).
 */
const TUNABLES = Object.freeze({
  path: '/responses',
  nowRole: 'developer', // the now block's role: a developer message isn't where OpenAI's cache breakpoint goes, so the cached prefix ends before it (spec §6.3); "user" for servers without developer messages
  phase: true, // labels Shiori's words as "commentary" or "final_answer", as OpenAI's newer models want; false for servers that refuse it
  reasoningSummary: 'auto', // reasoning summaries, for models with reasoning levels; false where they aren't allowed (OpenAI may want a verified organization)
  encryptedReasoning: true, // asks models with reasoning levels for their reasoning as encrypted items, to send back (OpenAI sends them anyway); false for one that refuses it
  imageDetail: null, // e.g. "low", "high" or "original"; unset, the server chooses ("auto")
  uploads: true, // photos go to the files API once, then by id (spec §4.8)
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
  model_not_found: 'not-found',
  image_file_not_found: 'upload',
  // Blocked by policy: not a bad key, and not worth sending again.
  invalid_prompt: 'bad-request', bio_policy: 'bad-request', misalignment_policy_violation: 'bad-request', image_content_policy_violation: 'bad-request',
});
const INCOMPLETE = /** @type {Record<string, string>} */ ({ max_output_tokens: 'length', content_filter: 'refusal' });

/** @param {any} annai */
export function activate(annai) {
  const { sse, ProviderError } = annai.helpers;
  return annai.providers.register({
    type: 'openai-responses',
    name: 'OpenAI Responses',
    tunables: TUNABLES,
    tail: true,
    /** @param {any} c */
    build: (c) => build(c),
    /** @param {Response} res */
    read: (res) => read(res, sse, ProviderError),
    classify,
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
  const input = request.messages.flatMap((/** @type {any} */ m) => wire(m, model.providerId, t));
  // The now block, last, in a message of its own (plan choice 5).
  if (request.tail) input.push({ role: t.nowRole || 'developer', content: request.tail });
  /** @type {Record<string, any>} */
  const body = { model: model.providerId, input, stream: true, store: false };
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
 * The events of a streamed response. Text, reasoning summaries and a call's arguments arrive as
 * they stream; each output item is given whole when it is done.
 * @param {Response} res @param {any} sse @param {any} ProviderError
 */
async function* read(res, sse, ProviderError) {
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
  for await (const { event, data } of sse(/** @type {ReadableStream<Uint8Array>} */ (res.body))) {
    if (data === '[DONE]') break;
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    const type = e.type ?? event;
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
