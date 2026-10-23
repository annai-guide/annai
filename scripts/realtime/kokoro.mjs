// A stand-in for Kokoro, Shiori's thinking half (an Anthropic Messages server on this machine), for a check of the voice
// path alone: Gemini Live is the real thing, and Kokoro answers every wake at once with one short note for Koe and a sleep,
// so a slow or refused chat model (a free key's 429 and 503) never muddies the timing of the voice. The conversation
// the real Gemini chat model gives Kokoro is `--kokoro gemini`.
import http from 'node:http';

/** An Anthropic Messages SSE reply that calls tools. @param {{ name: string, input: any }[]} calls */
export function toolReply(calls) {
  const ev = (/** @type {string} */ type, /** @type {any} */ data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', { message: { id: 'msg_rt', type: 'message', role: 'assistant', usage: { input_tokens: 400, output_tokens: 1 } } });
  for (const [i, c] of calls.entries()) {
    out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_rt_${i}_${Math.random().toString(36).slice(2, 8)}`, name: c.name, input: {} } });
    out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    out += ev('content_block_stop', { index: i });
  }
  out += ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
  return out + ev('message_stop', {});
}

/**
 * @param {{ delayMs?: number, port?: number }} [o] delayMs: how long Kokoro "thinks" before its note
 * @returns {Promise<{ origin: string, wakes: () => number, stop: () => Promise<void> }>}
 */
export async function startKokoro({ delayMs = 1500, port = 0 } = {}) {
  let wakes = 0;
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type') };
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method !== 'POST' || path !== '/kokoro/v1/messages') return void res.writeHead(404, cors).end('not found');
      /** @type {any} */
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // not JSON
      }
      // An empty request, as Custom provider sends to look for what a server offers, is refused as a real server refuses it.
      if (!body || typeof body !== 'object' || !('model' in body)) return void res.writeHead(400, { ...cors, 'content-type': 'application/json' }).end('{"error":{"type":"invalid_request_error","message":"model: Field required"}}');
      wakes++;
      // Koe's question reaches Kokoro as a wake ("[Koe asks]" in the conversation, or "Koe notes:" as the wake's reason): one note back.
      const last = JSON.stringify((body.messages ?? []).at(-1) ?? '');
      const heard = /Koe asks|Koe notes/.test(last);
      const calls = heard
        ? [{ name: 'tell_koe', input: { text: 'What you asked about is about twenty minutes ahead on Highway 1 (source: example.org).', for_user: 'About twenty minutes ahead on Highway 1.' } }, { name: 'sleep', input: {} }]
        : [{ name: 'sleep', input: {} }];
      setTimeout(() => { if (!res.destroyed) res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(toolReply(calls)); }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    wakes: () => wakes,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}
