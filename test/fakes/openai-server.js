import http from 'node:http';

/**
 * A stand-in for OpenAI's Responses API (api.openai.com/v1), in the shapes OpenAI documents (2026-10-23, the API reference and
 * the conversation-state guide):
 * - `POST /v1/responses`, streamed as `event:`/`data:` events (response.created, output items, text deltas, response.completed
 *   with usage) or whole as JSON, as the request's `stream` says. `store` defaults to true, as OpenAI's does; a response is
 *   kept only when it is true, and `previous_response_id` continues one that is kept, its whole context first: what was sent
 *   before and what it answered (its `instructions` are not carried over). A response it doesn't have is answered with an
 *   error whose message is OpenAI's own, "Previous response with id '…' not found." (code previous_response_not_found; the
 *   status is an option, as reports of it differ: 400, else 404).
 * - A `function_call_output` whose call isn't in the context is refused, as OpenAI refuses it.
 * - Usage counts the whole context as input (OpenAI bills the earlier turns' tokens again), a chained request's earlier part as
 *   cached; `chars / 4` stands for tokens.
 * - `DELETE /v1/responses/{id}`: `{ id, object: 'response.deleted', deleted: true }`; a response it doesn't have is a 404
 *   ("Response with id '…' not found.").
 * - `GET /v1/models`.
 * It records each request's address, headers and body, so a test can check what was sent. Tests and the end-to-end suite run it
 * on 127.0.0.1, on a port of its own (port 0), with CORS for any page.
 * @typedef {{ text?: string, calls?: { name: string, input: any }[], error?: { status: number, body: any }, delayMs?: number }} Reply
 *   one answer: words, or calls (a function_call each), or an error response; delayMs: a pause after the response is named
 * @typedef {{ method: string, url: string, headers: Record<string, any>, body: any }} Seen  body: parsed JSON, else its length
 * @param {{ key?: string, replies?: (Reply | ((body: any) => Reply))[], notFoundStatus?: number }} [o]
 *   key: the only key it takes (else any); replies: given in turn, the last repeats; none: "OK";
 *   notFoundStatus: the status of an unknown previous_response_id (400)
 */
export async function startOpenAIServer({ key, replies = [], notFoundStatus = 400 } = {}) {
  /** @type {Seen[]} */
  const seen = [];
  /** @type {string[]} */
  const deleted = [];
  /** @type {Map<string, any[]>} the responses it keeps: id, and the context it holds */
  const stored = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type, authorization'),
    };
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
      const raw = Buffer.concat(chunks);
      /** @type {any} */
      let body = raw.length;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        // not JSON: only its length is kept
      }
      seen.push({ method: String(req.method), url: String(req.url), headers: req.headers, body });
      const json = (/** @type {number} */ status, /** @type {any} */ j) => res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(j));
      const fail = (/** @type {number} */ status, /** @type {string} */ message, /** @type {string | null} */ code, /** @type {string | null} */ param = null) =>
        json(status, { error: { message, type: 'invalid_request_error', param, code } });
      if (key && req.headers.authorization !== `Bearer ${key}`) return void json(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } });
      const path = new URL(String(req.url), 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/v1/models') return void json(200, { object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', created: 1790000000, owned_by: 'openai' }] });
      if (req.method === 'DELETE' && path.startsWith('/v1/responses/')) {
        const id = decodeURIComponent(path.slice('/v1/responses/'.length));
        if (!stored.has(id)) return void fail(404, `Response with id '${id}' not found.`, null);
        deleted.push(id);
        stored.delete(id);
        return void json(200, { id, object: 'response.deleted', deleted: true });
      }
      if (req.method !== 'POST' || path !== '/v1/responses') return void json(404, { error: { message: `Invalid URL (${req.method} ${path})`, type: 'invalid_request_error', param: null, code: null } });
      const prev = body?.previous_response_id;
      if (prev && !stored.has(prev)) return void fail(notFoundStatus, `Previous response with id '${prev}' not found.`, 'previous_response_not_found', 'previous_response_id');
      /** @type {any[]} */
      const context = [...(prev ? stored.get(prev) ?? [] : [])];
      const items = typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body?.input) ? body.input : [];
      for (const it of items) {
        if (it?.type === 'function_call_output' && !context.concat(items).some((c) => c?.type === 'function_call' && c.call_id === it.call_id)) {
          return void fail(400, `No tool call found for function call output with call_id ${it.call_id}.`, null, 'input');
        }
      }
      context.push(...items);
      const pick = replies.length ? replies[Math.min(seen.filter((s) => s.method === 'POST' && s.url === req.url).length - 1, replies.length - 1)] : { text: 'OK' };
      const reply = typeof pick === 'function' ? pick(body) : pick;
      if (reply.error) return void json(reply.error.status, reply.error.body);
      const id = `resp_stand-in-${++n}`;
      /** @type {any[]} */
      const output = [
        ...(reply.text !== undefined ? [{ id: `msg_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: reply.text, annotations: [], logprobs: [] }], phase: 'final_answer' }] : []),
        ...(reply.calls ?? []).map((c, i) => ({ id: `fc_${n}_${i}`, type: 'function_call', status: 'completed', call_id: `call_${n}_${i}`, name: c.name, arguments: JSON.stringify(c.input) })),
      ];
      const tokens = (/** @type {any} */ x) => Math.ceil(JSON.stringify(x).length / 4);
      const before = prev ? tokens(stored.get(prev)) : 0;
      const all = tokens([body?.instructions ?? '', context]);
      const usage = {
        input_tokens: all, input_tokens_details: { cached_tokens: Math.floor(before / 128) * 128, cache_write_tokens: 0 },
        output_tokens: tokens(output), output_tokens_details: { reasoning_tokens: 0 }, total_tokens: all + tokens(output),
      };
      if (body?.store !== false) stored.set(id, [...context, ...output]);
      const object = (/** @type {string} */ status, /** @type {any[]} */ out) => ({
        id, object: 'response', created_at: 1792310400, status, error: null, incomplete_details: null, instructions: body?.instructions ?? null,
        model: body?.model, output: out, previous_response_id: prev ?? null, store: body?.store !== false, usage: status === 'completed' ? usage : null, metadata: {},
      });
      if (!body?.stream) return void json(200, object('completed', output));
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      let seq = 0;
      const send = (/** @type {string} */ type, /** @type {any} */ data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: seq++ })}\n\n`);
      send('response.created', { response: object('in_progress', []) });
      send('response.in_progress', { response: object('in_progress', []) });
      const rest = () => {
        output.forEach((item, i) => {
          if (item.type === 'message') {
            const text = item.content[0].text;
            const half = Math.ceil(text.length / 2);
            send('response.output_item.added', { output_index: i, item: { ...item, status: 'in_progress', content: [] } });
            for (const delta of [text.slice(0, half), text.slice(half)].filter(Boolean)) send('response.output_text.delta', { item_id: item.id, output_index: i, content_index: 0, delta, logprobs: [] });
          } else {
            send('response.output_item.added', { output_index: i, item: { ...item, status: 'in_progress', arguments: '' } });
            send('response.function_call_arguments.delta', { item_id: item.id, output_index: i, delta: item.arguments });
          }
          send('response.output_item.done', { output_index: i, item });
        });
        send('response.completed', { response: object('completed', output) });
        res.end();
      };
      if (reply.delayMs) setTimeout(rest, reply.delayMs);
      else rest();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1`;
  return {
    url, seen,
    /** The ids deleted. */
    deleted: () => [...deleted],
    /** The request bodies of the responses calls, in order. */
    bodies: () => seen.filter((s) => s.method === 'POST' && s.url === '/v1/responses').map((s) => s.body),
    /** The ids it keeps now. */
    stored: () => [...stored.keys()],
    /** OpenAI has deleted these (30 days passed), or all. @param {string[]} [ids] */
    expire: (ids) => { for (const id of ids ?? [...stored.keys()]) stored.delete(id); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}
