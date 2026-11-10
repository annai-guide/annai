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
 * stage 5's card: readTrip(id) teaches it to answer a question that names Testville (a "[Koe asks]" or the user's own line, in the newest message)
 * with a read_trip call for that trip, and a read_trip result with one line: what it read, or that it was not allowed. The voice path is
 * then measured alone, and no chat model's mood blurs it. Its voice (/voice/audio/speech, a Custom provider's Voice ability) says annai's
 * card question with a clip (askClip, a WAV): a stand-in speech-out whose sound plays through the page, so the harness hears it and can mix it back.
 * Its /asr/v1/audio/transcriptions passes a transcription request on to a real speech-to-text server (asr: its origin), one at a time, and
 * nothing else (annai calls only https addresses, or http on this device: a server on the network is reached through this address on 127.0.0.1);
 * each is logged with the words that came back and how long it took.
 * @param {{ delayMs?: number, port?: number, askClip?: Buffer, asr?: string }} [o] delayMs: how long Kokoro "thinks" before its note
 * @returns {Promise<{ origin: string, wakes: () => number, repeatNote: (on: boolean) => void, readTrip: (id: string | null) => void, log: { at: number, kind: string, text?: string, heard?: string[] }[], stop: () => Promise<void> }>}
 */
export async function startKokoro({ delayMs = 1500, port = 0, askClip, asr } = {}) {
  let wakes = 0;
  /** The trip a marked question has read_trip read (null: none), and every request seen (kind, the newest message's start). @type {string | null} */
  let tripId = null;
  /** @type {{ at: number, kind: string, text?: string, heard?: string[], ms?: number, status?: number, bytes?: number }[]} */
  const log = [];
  /** The user's lines Shiori-alone has been answered with the note (classic voice). @type {Set<string>} */
  const answeredLines = new Set();
  /** The transcription requests, one at a time (the user's server takes one at a time). */
  let asrQueue = Promise.resolve();
  /** Sends its note again once Koe has said it (the second drive's item 11). */
  let repeat = false;
  let noted = false;
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type') };
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      // The user's speech-to-text server: only a transcription request, one at a time, with the content type and the body as they came.
      if (path.startsWith('/asr/')) {
        if (req.method !== 'POST' || path !== '/asr/v1/audio/transcriptions' || !asr) return void res.writeHead(404, cors).end('not found');
        const body = Buffer.concat(chunks);
        asrQueue = asrQueue.then(async () => {
          const at = Date.now();
          try {
            const r = await fetch(`${asr}/v1/audio/transcriptions`, { method: 'POST', headers: { 'content-type': String(req.headers['content-type'] ?? 'application/octet-stream') }, body, signal: AbortSignal.timeout(60_000) });
            const text = await r.text();
            let said = '';
            try {
              said = String(JSON.parse(text)?.text ?? '');
            } catch {
              said = text.slice(0, 120);
            }
            log.push({ at, kind: 'asr', text: said, ms: Date.now() - at, status: r.status, bytes: body.length });
            res.writeHead(r.status, { ...cors, 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(text);
          } catch (e) {
            log.push({ at, kind: 'asr', text: `failed: ${String(e).slice(0, 100)}`, ms: Date.now() - at, bytes: body.length });
            res.writeHead(502, cors).end('the speech-to-text server did not answer');
          }
        });
        return;
      }
      // The stand-in voice: annai's card question is a clip; anything else is a short quiet WAV (nothing else is said aloud in these runs).
      if (req.method === 'POST' && path === '/voice/audio/speech') {
        let input = '';
        /** @type {any} */
        let said = null;
        try {
          said = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // not JSON
        }
        // An empty request, as Custom provider's look sends, is refused as a real server refuses it (which is how the look knows the path is there).
        if (!said || typeof said !== 'object' || !('model' in said)) return void res.writeHead(400, { ...cors, 'content-type': 'application/json' }).end('{"error":{"type":"invalid_request_error","message":"model: Field required"}}');
        input = String(said.input ?? '');
        log.push({ at: Date.now(), kind: 'speech', text: input.slice(0, 120) });
        const wav = /^Read /.test(input) && askClip ? askClip : quietWav();
        return void res.writeHead(200, { ...cors, 'content-type': 'audio/wav', 'content-length': String(wav.length) }).end(wav);
      }
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
      // The user's lines as she was given them in this request (every "[heard...] text"), so a line that went to her twice, or not at all, shows.
      const chat = flat(body.messages ?? []);
      const heardLines = [...chat.matchAll(/^\[heard[^\]]*\][ \t]*\n?(.+)$/gm)].map((m) => m[1].trim());
      log.push({ at: Date.now(), kind: 'request', heard: heardLines, text: chat.slice(-6000) });
      const tools = new Set((body.tools ?? []).map((/** @type {any} */ t) => t?.name));
      // Koe's half is there (tell_koe), or Shiori speaks for herself (speak): where her one line goes.
      const toUser = (/** @type {string} */ text) => (tools.has('tell_koe') || !tools.has('speak') ? { name: 'tell_koe', input: { text, for_user: text } } : { name: 'speak', input: { text } });
      // stage 5: the result of a read_trip, said as what it was; a question that names Testville, asked for with read_trip.
      const result = readTripResult(body.messages ?? []);
      if (tripId && result !== null) {
        const said = result.denied ? 'I was not allowed to read Testville.' : `I read Testville: ${result.text.replace(/\s+/g, ' ').slice(0, 120)}`;
        log.push({ at: Date.now(), kind: result.denied ? 'read_trip denied' : 'read_trip read', text: result.text.slice(0, 160) });
        return void setTimeout(() => { if (!res.destroyed) res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(toolReply([toUser(said), { name: 'sleep', input: {} }])); }, 300);
      }
      // Only a question put to her (Koe's ask, or the user's own line in classic voice) that names Testville: what Koe says aloud afterwards may name it too.
      if (tripId && /Testville/.test(last) && /\[Koe asks\]|\[heard\]|Koe asks:|The user wrote/.test(last) && !/"tool_result"/.test(last)) {
        log.push({ at: Date.now(), kind: 'read_trip asked', text: last.slice(0, 160) });
        return void setTimeout(() => { if (!res.destroyed) res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(toolReply([{ name: 'read_trip', input: { trip: tripId } }])); }, 300);
      }
      // Shiori alone (no tell_koe): a line of the user's that names no trip is answered with the note, spoken.
      // (A new line of the user's may arrive in the message that carries a tool's result: each distinct line is answered once.)
      const fresh = [...flat(body.messages?.slice(-1) ?? []).matchAll(/^\[heard[^\]]*\][ \t]*\n?(.+)$/gm)].map((m) => m[1].trim()).filter((x) => !answeredLines.has(x));
      if (tools.has('speak') && !tools.has('tell_koe') && fresh.length) {
        for (const x of fresh) answeredLines.add(x);
        log.push({ at: Date.now(), kind: 'note', text: last.slice(0, 100) });
        return void setTimeout(() => { if (!res.destroyed) res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(toolReply([{ name: 'speak', input: { text: 'What you asked about is about twenty minutes ahead on Highway 1.' } }, { name: 'sleep', input: {} }])); }, delayMs);
      }
      log.push({ at: Date.now(), kind: heard ? 'note' : 'sleep', text: last.slice(0, 100) });
      const note = { name: 'tell_koe', input: { text: 'What you asked about is about twenty minutes ahead on Highway 1 (source: example.org).', for_user: 'About twenty minutes ahead on Highway 1.' } };
      // repeat: the note, then its next step the same note again once Koe has had time to say it.
      const again = repeat && noted;
      if (again) repeat = noted = false;
      if (repeat && heard) noted = true;
      const calls = noted ? [note] : heard || again ? [note, { name: 'sleep', input: {} }] : [{ name: 'sleep', input: {} }];
      setTimeout(() => { if (!res.destroyed) res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).end(toolReply(calls)); }, again ? delayMs + 8000 : delayMs);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    wakes: () => wakes,
    repeatNote: (on) => { repeat = on; noted = false; },
    readTrip: (id) => { tripId = id; },
    log,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}

/**
 * What the newest message answers when it is the result of read_trip: its text, and whether it was refused (a tap on Not now, or no yes heard). Null for any other message.
 * @param {any[]} messages @returns {{ text: string, denied: boolean } | null}
 */
export function readTripResult(messages) {
  const last = messages.at(-1);
  const before = messages.at(-2);
  const results = Array.isArray(last?.content) ? last.content.filter((/** @type {any} */ b) => b?.type === 'tool_result') : [];
  if (!results.length || !Array.isArray(before?.content)) return null;
  const read = before.content.find((/** @type {any} */ b) => b?.type === 'tool_use' && b.name === 'read_trip' && results.some((/** @type {any} */ r) => r.tool_use_id === b.id));
  if (!read) return null;
  const r = results.find((/** @type {any} */ x) => x.tool_use_id === read.id);
  const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
  return { text, denied: r.is_error === true || /^Not read:|tapped Not now|was stopped|^The user/.test(text) };
}

/** A short quiet WAV (16 kHz mono, 0.5 s). */
function quietWav() {
  const n = 8000;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24); buf.writeUInt32LE(32_000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/** The conversation of an Anthropic request, flat: one line a message block, so what she was given can be read and counted. @param {any[]} messages */
export function flat(messages) {
  return messages.flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content ?? []).map((/** @type {any} */ b) => (b.type === 'text' ? String(b.text) : b.type === 'tool_use' ? `TOOL_USE ${b.name} ${JSON.stringify(b.input)}` : b.type === 'tool_result' ? `TOOL_RESULT ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}` : `(${b.type})`)))).join('\n');
}
