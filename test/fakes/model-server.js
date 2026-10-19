import http from 'node:http';

/**
 * Stand-ins for the model servers people run themselves: llama.cpp, vLLM, SGLang, Ollama and LM Studio,
 * and a router that never streams, as the user's own does ("whole"). Each answers as its documents say
 * (the provider plan's "Facts relied on", 2026-10-18): its model list's shape, the field its reasoning
 * streams in, how it streams a tool call, usage when stream_options asks for it, and its CORS. The
 * llama.cpp one also answers as the user's own llama.cpp server (Unsloth Studio) did when measured on
 * 2026-10-19: an empty content beside each piece of reasoning, a tool call's id and name in its first
 * piece, and usage with timings in a last chunk with no choices. Tests and the end-to-end suite run it on
 * 127.0.0.1, on a port of its own (port 0).
 * @typedef {'llamacpp' | 'vllm' | 'sglang' | 'ollama' | 'lmstudio' | 'whole'} Flavour
 * @typedef {{ text?: string, reasoning?: string, calls?: { name: string, input: any }[], forced?: { name: string, input: any },
 *   usage?: { input: number, output: number, cached?: number } }} Reply
 *   one answer to a chat request; replies are given in turn, and the last repeats. forced: the call the model makes, in place
 *   of its words, when the server forces a tool call: llama.cpp only for tool_choice "required", which its code parses (a named
 *   function it drops, as measured on 2026-10-19; the user's Unsloth Studio server forced neither); Ollama never, as it doesn't
 *   support tool_choice; the others for "required" or a named function
 * @typedef {{ method: string, path: string, headers: Record<string, any>, body: any }} Seen
 *   body: parsed JSON, or the text ('' for none)
 * @typedef {{ flavour: Flavour, key?: string, cors?: '*' | string[] | false, spa?: boolean, authEverywhere?: boolean,
 *   models?: object[], replies?: Reply[], gapMs?: number, props?: object, show?: Record<string, object>, running?: object[], native?: object[] }} Options
 *   key: asked for as a bearer token; cors: '*' allows any origin (reflected, as llama.cpp does), a list those origins,
 *   false none (default: the flavour's own); spa: 200 text/html for any unknown path, as a web app's fallback does;
 *   authEverywhere: 401 for every /v1 path without the key, real or not, as auth in front of a server does;
 *   gapMs: a pause between a stream's chunks, as a model writing at its own pace makes; props: llama.cpp's /props;
 *   show and running: Ollama's /api/show by model and /api/ps's models; native: LM Studio's /api/v1/models's models
 */

/** Hosts Ollama allows by default (OLLAMA_ORIGINS adds to them), whatever the scheme and port. */
const OLLAMA_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0'];
const CREATED = 1792400000;
const CHAT = '/v1/chat/completions';

/**
 * Each flavour: its routes, its reasoning field, its default CORS, its model list, which tool_choice forces a call, and the
 * models that can't think (Ollama refuses a named thinking level for them).
 * @type {Record<Flavour, { post: string[], get: string[], reasoning: string, cors: '*' | 'ollama' | false, whole?: boolean, timings?: boolean, callsWhole?: boolean,
 *   forces: 'required' | 'any' | 'never', noThinking?: string[], models: () => object[] }>}
 */
const FLAVOURS = {
  llamacpp: {
    post: [CHAT, '/v1/completions', '/v1/responses', '/v1/messages', '/v1/embeddings'], get: ['/v1/models', '/props', '/health'],
    reasoning: 'reasoning_content', cors: '*', timings: true, forces: 'required',
    models: () => [{
      id: 'qwen3.8-flash', object: 'model', created: CREATED, owned_by: 'llamacpp',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      meta: { vocab_type: 2, n_vocab: 151936, n_ctx_train: 262144, n_embd: 2048, n_params: 30532122624, size: 21740000000 },
    }],
  },
  vllm: {
    post: [CHAT, '/v1/completions', '/v1/responses', '/v1/messages', '/v1/audio/transcriptions'], get: ['/v1/models'],
    reasoning: 'reasoning', cors: '*', forces: 'any',
    models: () => [{ id: 'Qwen/Qwen3-8B', object: 'model', created: CREATED, owned_by: 'vllm', root: 'Qwen/Qwen3-8B', parent: null, max_model_len: 32768, permission: [] }],
  },
  sglang: {
    post: [CHAT, '/v1/completions'], get: ['/v1/models'],
    reasoning: 'reasoning_content', cors: '*', forces: 'any',
    models: () => [{ id: 'Qwen/Qwen3-8B', object: 'model', created: CREATED, owned_by: 'sglang', root: 'Qwen/Qwen3-8B', max_model_len: 32768 }],
  },
  ollama: {
    post: [CHAT, '/v1/completions', '/v1/responses', '/v1/messages', '/v1/embeddings', '/api/show'], get: ['/v1/models', '/api/ps'],
    reasoning: 'reasoning', cors: 'ollama', callsWhole: true, forces: 'never', noThinking: ['llama3.2:latest'],
    models: () => [{ id: 'qwen3:8b', object: 'model', created: CREATED, owned_by: 'library' }, { id: 'llama3.2:latest', object: 'model', created: CREATED, owned_by: 'library' }],
  },
  lmstudio: {
    post: [CHAT, '/v1/completions', '/v1/responses', '/v1/messages', '/v1/embeddings'], get: ['/v1/models', '/api/v1/models'],
    reasoning: 'reasoning_content', cors: false, forces: 'any',
    models: () => [{ id: 'qwen/qwen3-8b', object: 'model', owned_by: 'organization_owner' }],
  },
  whole: {
    post: [CHAT, '/v1/responses', '/v1/embeddings'], get: ['/v1/models'],
    reasoning: 'reasoning_content', cors: '*', whole: true, forces: 'any',
    models: () => [{ id: 'router-model', object: 'model', created: CREATED, owned_by: 'router' }],
  },
};

/** Ollama's /api/show, by model: one that thinks and one that can't; the second's Modelfile sets its context. */
const SHOW = {
  'qwen3:8b': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, parameters: 'stop "<|im_start|>"\nstop "<|im_end|>"', details: { family: 'qwen3' } },
  'llama3.2:latest': { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, parameters: 'num_ctx 8192\nstop "<|eot_id|>"', details: { family: 'llama' } },
};
/** LM Studio's /api/v1/models: a model loaded with a context smaller than it could take. */
const NATIVE = [{ type: 'llm', publisher: 'qwen', key: 'qwen/qwen3-8b', display_name: 'Qwen3 8B', max_context_length: 40960,
  capabilities: { vision: false, trained_for_tool_use: true }, loaded_instances: [{ id: 'qwen/qwen3-8b', config: { context_length: 8192 } }] }];

/** An OpenAI-shaped error. @param {string} message @param {string} type */
const error = (message, type) => JSON.stringify({ error: { message, type, param: null, code: null } });
/** Words and the spaces after them, as a stream gives text. @param {string} s */
const pieces = (s) => s.match(/\S+\s*|\s+/g) ?? [];

/** @param {Options} o */
export async function startFakeServer(o) {
  const f = FLAVOURS[o.flavour];
  if (!f) throw new Error(`No such flavour: ${o.flavour}`);
  const models = o.models ?? f.models();
  const replies = o.replies?.length ? o.replies : [{ text: 'OK' }];
  const cors = o.cors ?? f.cors;
  /** @type {Seen[]} */
  const requests = [];
  let served = 0;
  let calls = 0;
  /** Whether a page at this origin may read the answers. @param {string | undefined} origin */
  const allowed = (origin) => {
    if (!origin || cors === false) return false;
    if (cors === '*') return true;
    if (Array.isArray(cors) && cors.includes(origin)) return true;
    // Ollama's own origins are allowed, and OLLAMA_ORIGINS adds to them.
    if (f.cors !== 'ollama') return false;
    try {
      return OLLAMA_HOSTS.includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  };

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const raw = Buffer.concat(parts).toString('utf8');
      /** @type {any} */
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : '';
      } catch {
        // not JSON: kept as text
      }
      requests.push({ method, path, headers: { ...req.headers }, body });
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      /** @type {Record<string, string>} */
      const allow = allowed(origin) ? { 'access-control-allow-origin': /** @type {string} */ (origin), 'access-control-allow-credentials': 'true', vary: 'Origin' } : {};
      /** @param {number} status @param {string} type @param {string} text */
      const send = (status, type, text) => res.writeHead(status, { ...allow, 'content-type': type }).end(text);
      if (method === 'OPTIONS') {
        res.writeHead(204, allow['access-control-allow-origin'] ? {
          ...allow, 'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type'),
        } : {}).end();
        return;
      }
      const keyed = !o.key || req.headers.authorization === `Bearer ${o.key}`;
      const isPost = f.post.includes(path);
      const isGet = f.get.includes(path);
      if (o.authEverywhere && path.startsWith('/v1/') && !keyed) return send(401, 'application/json', error('Invalid API Key', 'authentication_error'));
      if (!isPost && !isGet) {
        if (o.spa) return send(200, 'text/html; charset=utf-8', '<!doctype html><title>App</title><div id="app"></div>');
        return send(404, 'text/plain; charset=utf-8', 'Not Found');
      }
      if ((isPost && method !== 'POST') || (isGet && method !== 'GET')) return send(405, 'text/plain; charset=utf-8', 'Method Not Allowed');
      if (!keyed) return send(401, 'application/json', error('Not authenticated', 'authentication_error'));
      if (path === '/v1/models') return send(200, 'application/json', JSON.stringify({ object: 'list', data: models }));
      // llama.cpp's server properties: the context each conversation gets, what the loaded model takes in, and its name.
      if (path === '/props') return send(200, 'application/json', JSON.stringify(o.props ?? { default_generation_settings: { n_ctx: 32768 }, total_slots: 1, modalities: { vision: true, audio: false }, model_alias: 'qwen3.8-flash' }));
      // Ollama's models loaded now, each with the context it was given, and what one model can do (its docs, api/types.go).
      if (path === '/api/ps') return send(200, 'application/json', JSON.stringify({ models: o.running ?? [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 6e9, size_vram: 6e9, context_length: 4096 }] }));
      if (path === '/api/show') {
        const shown = (o.show ?? SHOW)[body?.model];
        return shown ? send(200, 'application/json', JSON.stringify(shown)) : send(404, 'application/json', JSON.stringify({ error: `model '${body?.model}' not found` }));
      }
      // LM Studio's own list: capabilities, and each loaded instance's context.
      if (path === '/api/v1/models') return send(200, 'application/json', JSON.stringify({ models: o.native ?? NATIVE }));
      if (path === '/health') return send(200, 'application/json', '{"status":"ok"}');
      if (!body || typeof body !== 'object') return send(400, 'application/json', error('missing required field: model', 'invalid_request_error'));
      if (path !== CHAT) return send(501, 'application/json', error('This stand-in answers only chat completions.', 'not_implemented'));
      if (!Array.isArray(body.messages)) return send(400, 'application/json', error("'messages' is required", 'invalid_request_error'));
      const effort = body.reasoning_effort;
      if (f.noThinking?.includes(body.model) && typeof effort === 'string' && effort !== 'none') return send(400, 'application/json', error(`"${body.model}" does not support thinking`, 'invalid_request_error'));
      const queued = replies[Math.min(served++, replies.length - 1)];
      const choice = body.tool_choice;
      const forcing = f.forces === 'required' ? choice === 'required' : f.forces === 'any' ? choice === 'required' || Boolean(choice?.function?.name) : false;
      /** @type {Reply} */
      const reply = forcing && queued.forced ? { ...queued, text: undefined, calls: [queued.forced] } : queued;
      const ids = (reply.calls ?? []).map(() => `call_${++calls}`);
      if (f.whole || body.stream !== true) return send(200, 'application/json', JSON.stringify(completion(f, body, reply, ids)));
      res.writeHead(200, { ...allow, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const out = [...[...streamed(f, body, reply, ids)].map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
      const next = (/** @type {number} */ i) => {
        if (res.destroyed) return;
        if (i === out.length - 1) return void res.end(out[i]);
        res.write(out[i]);
        if (o.gapMs) setTimeout(() => next(i + 1), o.gapMs);
        else next(i + 1);
      };
      next(0);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}

/** A reply's usage, in Chat Completions' words. @param {Reply} reply @param {any} body */
function usageOf(reply, body) {
  const u = reply.usage ?? { input: JSON.stringify(body.messages).length >> 2, output: 12 };
  return { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output, prompt_tokens_details: { cached_tokens: u.cached ?? 0 } };
}

/** One whole chat completion. @param {any} f @param {any} body @param {Reply} reply @param {string[]} ids */
function completion(f, body, reply, ids) {
  /** @type {Record<string, any>} */
  const message = { role: 'assistant', content: reply.text ?? null };
  if (reply.reasoning) message[f.reasoning] = reply.reasoning;
  if (reply.calls?.length) message.tool_calls = reply.calls.map((c, i) => ({ id: ids[i], type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
  return {
    id: 'chatcmpl-stand-in', object: 'chat.completion', created: CREATED, model: body.model,
    choices: [{ index: 0, message, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop' }],
    usage: usageOf(reply, body),
  };
}

/** A streamed chat completion's chunks, in the flavour's shape. @param {any} f @param {any} body @param {Reply} reply @param {string[]} ids */
function* streamed(f, body, reply, ids) {
  const chunk = (/** @type {any} */ delta, /** @type {string | null} */ finish = null) => ({
    id: 'chatcmpl-stand-in', object: 'chat.completion.chunk', created: CREATED, model: body.model,
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  });
  yield chunk({ role: 'assistant' });
  // llama.cpp sends an empty content beside each piece of reasoning (measured).
  for (const p of pieces(reply.reasoning ?? '')) yield chunk({ ...(f.timings ? { content: '' } : {}), [f.reasoning]: p });
  for (const p of pieces(reply.text ?? '')) yield chunk({ content: p });
  for (const [i, c] of (reply.calls ?? []).entries()) {
    const args = JSON.stringify(c.input);
    // Ollama gives each call whole; the others give its id and name first, then its arguments in pieces.
    const cuts = f.callsWhole ? [args] : [args.slice(0, 1), args.slice(1, Math.ceil(args.length / 2)), args.slice(Math.ceil(args.length / 2))];
    for (const [n, a] of cuts.entries()) {
      yield chunk({ tool_calls: [{ index: i, ...(n ? {} : { id: ids[i], type: 'function' }), function: { ...(n ? {} : { name: c.name }), arguments: a } }] });
    }
  }
  yield chunk({}, reply.calls?.length ? 'tool_calls' : 'stop');
  if (body.stream_options?.include_usage) {
    const usage = usageOf(reply, body);
    yield {
      id: 'chatcmpl-stand-in', object: 'chat.completion.chunk', created: CREATED, model: body.model, choices: [], usage,
      ...(f.timings ? { timings: { cache_n: 0, prompt_n: usage.prompt_tokens, prompt_ms: 40, predicted_n: usage.completion_tokens, predicted_ms: 300 } } : {}),
    };
  }
}
