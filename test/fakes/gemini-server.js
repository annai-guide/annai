import http from 'node:http';
import { readFileSync } from 'node:fs';

/**
 * A stand-in for Gemini's own API (generativelanguage.googleapis.com), answering in the shapes recorded
 * from Google on 2026-10-19 (test/fixtures/gemini): the model list, interactions streamed as `event:`/`data:`
 * steps or whole as JSON (as the request's `stream` says), an interaction deleted, and a photo uploaded to the
 * Files API. It records each request's address, headers and body, so a test can check where the key went.
 * An interaction asked to be stored is kept until it is deleted (or expire() says Google deleted it): a request
 * that continues one it doesn't have is answered with Google's 404, as recorded.
 * Tests and the end-to-end suite run it on 127.0.0.1, on a port of its own (port 0), with CORS for any page.
 * @typedef {{ text?: string, thought?: { summary?: string, signature: string }, calls?: { name: string, input: any, signature?: string }[],
 *   usage?: Record<string, any>, status?: string, error?: { status: number, body: any }, delayMs?: number }} Reply
 *   one answer to an interaction: a thought, words, calls (stop "requires_action"), or an error response; delayMs: a pause after the interaction is named
 * @typedef {{ method: string, url: string, headers: Record<string, any>, body: any }} Seen  body: parsed JSON, else the bytes' length
 * @param {{ key?: string, replies?: (Reply | ((body: any) => Reply))[], models?: any }} [o]
 *   key: the only key it takes (else any); replies: given in turn, the last repeats; none: the default answers
 *   (a call to report_color with red when that tool is offered, else "OK"); models: its model list (the recorded one)
 */
export async function startGeminiServer({ key, replies = [], models } = {}) {
  const list = models ?? JSON.parse(readFileSync(new URL('../fixtures/gemini/models.json', import.meta.url), 'utf8'));
  /** @type {Seen[]} */
  const seen = [];
  /** @type {string[]} */
  const deleted = [];
  /** @type {Set<string>} the interactions it keeps */
  const stored = new Set();
  let n = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type, x-goog-api-key'),
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
        // a multipart upload: only its length is kept
      }
      seen.push({ method: String(req.method), url: String(req.url), headers: req.headers, body });
      const json = (/** @type {number} */ status, /** @type {any} */ j) => res.writeHead(status, { ...cors, 'content-type': 'application/json; charset=UTF-8' }).end(JSON.stringify(j));
      if (key && req.headers['x-goog-api-key'] !== key) return void json(400, { error: { message: 'API key not valid. Please pass a valid API key.', code: 'invalid_request' } });
      const path = new URL(String(req.url), 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/v1beta/models') return void json(200, list);
      if (req.method === 'DELETE' && path.startsWith('/v1beta/interactions/')) {
        const id = decodeURIComponent(path.slice('/v1beta/interactions/'.length));
        deleted.push(id);
        stored.delete(id);
        return void json(200, {}); // 200 again for one already gone, as Google answers
      }
      if (req.method === 'POST' && path === '/upload/v1beta/files') {
        const id = `stand-in-${++n}`;
        return void json(200, { file: { name: `files/${id}`, uri: `http://${req.headers.host}/v1beta/files/${id}`, mimeType: 'image/png', expirationTime: new Date(Date.now() + 48 * 3600_000).toISOString(), state: 'ACTIVE' } });
      }
      if (req.method !== 'POST' || path !== '/v1beta/interactions') return void json(404, { error: { message: 'Requested entity was not found.', code: 'not_found' } });
      if (body?.previous_interaction_id && !stored.has(body.previous_interaction_id)) return void json(404, { error: { message: 'Requested entity was not found.', code: 'not_found' } });
      const pick = replies.length ? replies[Math.min(seen.filter((s) => s.url === req.url && s.method === 'POST').length - 1, replies.length - 1)] : answer;
      const reply = typeof pick === 'function' ? pick(body) : pick;
      if (reply.error) return void json(reply.error.status, reply.error.body);
      const id = `v1_stand-in-${++n}`;
      if (body?.store) stored.add(id);
      if (body?.stream) {
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
        const [created, ...rest] = events(id, body.model, reply).map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.write(created);
        return void setTimeout(() => {
          if (!res.destroyed) res.end(`${rest.join('')}event: done\ndata: [DONE]\n\n`);
        }, reply.delayMs ?? 0);
      }
      json(200, whole(id, body?.model, reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    /** Every request, in order. */
    requests: () => seen.slice(),
    /** The interactions' bodies, in order. */
    bodies: () => seen.filter((s) => s.method === 'POST' && s.url.startsWith('/v1beta/interactions')).map((s) => s.body),
    deleted: () => deleted.slice(),
    /** The interactions it keeps now. */
    stored: () => [...stored],
    /** Google deleted it by itself (it expired). @param {string} id */
    expire: (id) => { stored.delete(id); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}

/** The default answer: the test tool called with red, else OK. @param {any} body @returns {Reply} */
function answer(body) {
  const tool = (body?.tools ?? []).find((/** @type {any} */ t) => t.name === 'report_color');
  return tool ? { calls: [{ name: 'report_color', input: { color: 'red' }, signature: 'CALLSIG' }] } : { text: 'OK' };
}

/** @param {Reply} r */
const usageOf = (r) => r.usage ?? { total_tokens: 110, total_input_tokens: 100, input_tokens_by_modality: [{ modality: 'text', tokens: 100 }], total_cached_tokens: 0, total_output_tokens: 10, total_tool_use_tokens: 0, total_thought_tokens: 0 };
/** @param {Reply} r */
const statusOf = (r) => r.status ?? (r.calls?.length ? 'requires_action' : 'completed');

/** The steps of a reply, whole. @param {Reply} r @returns {any[]} */
function steps(r) {
  return [
    ...(r.thought ? [{ type: 'thought', signature: r.thought.signature, ...(r.thought.summary ? { summary: [{ type: 'text', text: r.thought.summary }] } : {}) }] : []),
    ...(r.text ? [{ type: 'model_output', content: [{ type: 'text', text: r.text }] }] : []),
    ...(r.calls ?? []).map((c, i) => ({ type: 'function_call', id: `call_${i + 1}`, name: c.name, arguments: c.input, ...(c.signature ? { signature: c.signature } : {}) })),
  ];
}

/** A reply as Google streams it. @param {string} id @param {string} model @param {Reply} r */
function events(id, model, r) {
  /** @type {any[]} */
  const out = [
    { event_type: 'interaction.created', interaction: { id, object: 'interaction', model } },
    { event_type: 'interaction.status_update', interaction_id: id, status: 'in_progress' },
  ];
  for (const [index, s] of steps(r).entries()) {
    if (s.type === 'thought') {
      out.push({ event_type: 'step.start', index, step: { type: 'thought' } });
      for (const c of s.summary ?? []) out.push({ event_type: 'step.delta', index, delta: { type: 'thought_summary', content: c } });
      out.push({ event_type: 'step.delta', index, delta: { type: 'thought_signature', signature: s.signature } });
    } else if (s.type === 'model_output') {
      out.push({ event_type: 'step.start', index, step: { type: 'model_output' } });
      // In two pieces, as Google sends words.
      const t = s.content[0].text;
      const half = Math.ceil(t.length / 2);
      for (const text of [t.slice(0, half), t.slice(half)].filter(Boolean)) out.push({ event_type: 'step.delta', index, delta: { type: 'text', text } });
    } else {
      out.push({ event_type: 'step.start', index, step: { id: s.id, ...(s.signature ? { signature: s.signature } : {}), type: 'function_call', name: s.name, arguments: {} } });
      out.push({ event_type: 'step.delta', index, delta: { type: 'arguments_delta', arguments: JSON.stringify(s.arguments) } });
    }
    out.push({ event_type: 'step.stop', index });
  }
  out.push({ event_type: 'interaction.completed', interaction: { id, status: statusOf(r), usage: usageOf(r), object: 'interaction', model } });
  return out;
}

/** A reply as Google sends it whole. @param {string} id @param {string} model @param {Reply} r */
function whole(id, model, r) {
  return { id, status: statusOf(r), usage: usageOf(r), steps: steps(r), object: 'interaction', model };
}
