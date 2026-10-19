import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A stand-in realtime voice server (the Koe and Kokoro plan, K4): a WebSocket server of annai's own, with no
 * dependencies (the handshake, masked client frames, fragments, pings and close frames), on 127.0.0.1 port 0.
 * The `gemini` flavour answers as Gemini Live was measured to on 2026-10-19 (gemini-3.8-live): its JSON in
 * binary frames; setupComplete after a valid setup; a wrong key closed with 1007 "API key not valid", an
 * unknown model with 1008, and `proactivity` on v1beta with 1007 "Unknown name"; a resumption handle at once
 * and after each turn; each turn's audio in a burst, its transcripts beside it, and turnComplete, with the
 * turn's usage, only when playing it in real time would end; `interrupted` when an activityStart or a
 * clientContent comes before that. Unit tests reach it with Node's WebSocket, and end-to-end tests from the
 * page, at ws://127.0.0.1:<port> (WebKit can't stand in for a page's own requests).
 * @typedef {{ heard?: string, said?: string, audio?: Uint8Array, tool?: { name: string, args: any }, goAway?: number, handle?: string,
 *   usage?: Record<string, any>, interruptOn?: 'text' | 'activity' }} Turn
 *   one answer, played when a clientContent turn or an activityEnd comes; turns are given in order, and the last repeats.
 *   audio: 24 kHz 16-bit PCM; tool: a call it makes after its words; goAway: seconds left, sent after the turn;
 *   usage: Gemini's usageMetadata; interruptOn: only this cuts it off (default: either)
 * @typedef {{ flavour: 'gemini', turns: Turn[], key?: string, models?: string[], closeWith?: { code: number, reason: string },
 *   pace?: number, chunkBytes?: number }} Options
 *   key: the one key it takes (none: any); models: the ids it knows (none: any); closeWith: how it closes each session at its setup;
 *   pace: how long a turn stays open, as a share of its audio's real time (1, as Gemini; 0: turnComplete at once); chunkBytes: audio per message
 */

/** Gemini Live's path, by API version. @param {string} version */
export const GEMINI_PATH = (version) => `/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * One frame, unmasked, as a server sends it. @param {number} opcode @param {Uint8Array} payload
 */
function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65_536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.alloc(10);
  if (n >= 65_536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * The frames in a buffer, as many as are whole, unmasked; the rest waits for more bytes.
 * @param {Buffer} buf @returns {{ frames: { fin: boolean, opcode: number, payload: Buffer }[], rest: Buffer }}
 */
function readFrames(buf) {
  const frames = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const fin = (buf[at] & 0x80) !== 0;
    const opcode = buf[at] & 0x0f;
    const masked = (buf[at + 1] & 0x80) !== 0;
    let n = buf[at + 1] & 0x7f;
    let p = at + 2;
    if (n === 126) {
      if (buf.length - p < 2) break;
      n = buf.readUInt16BE(p);
      p += 2;
    } else if (n === 127) {
      if (buf.length - p < 8) break;
      n = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length - p < n) break;
    const payload = Buffer.from(buf.subarray(p, p + n));
    if (mask) for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, payload });
    at = p + n;
  }
  return { frames, rest: buf.subarray(at) };
}

/** @param {Options} o */
export async function startRealtimeServer(o) {
  const { turns, key, models, closeWith, pace = 1, chunkBytes = 9600 } = o;
  /** @type {any[]} */
  const received = [];
  /** @type {{ version: string, path: string, key: string | null, origin: string | undefined, protocols: string[] }[]} */
  const connections = [];
  /** @type {Set<{ close(code: number, reason: string): void }>} */
  const open = new Set();
  let next = 0;
  let calls = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This is a WebSocket server.');
  });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const version = /^\/ws\/google\.ai\.generativelanguage\.(v1alpha|v1beta)\.GenerativeService\.BidiGenerateContent$/.exec(url.pathname)?.[1];
    const wsKey = req.headers['sec-websocket-key'];
    if (!version || typeof wsKey !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    connections.push({ version, path: url.pathname, key: url.searchParams.get('key'), origin: req.headers.origin, protocols });
    const accept = createHash('sha1').update(wsKey + GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
      ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols[0]}`] : []), '', ''].join('\r\n'));
    /** @type {import('node:net').Socket} */ (socket).setNoDelay(true);
    let closing = false;
    /** @param {any} m */
    const send = (m) => { if (!closing && !socket.destroyed) socket.write(frame(2, Buffer.from(JSON.stringify(m)))); };
    const conn = {
      /** @param {number} code @param {string} reason */
      close(code, reason) {
        if (closing || socket.destroyed) return;
        closing = true;
        // A control frame holds at most 125 bytes, so a long reason is cut, as Gemini's are.
        const words = Buffer.from(reason).subarray(0, 123);
        const body = Buffer.alloc(2 + words.length);
        body.writeUInt16BE(code, 0);
        words.copy(body, 2);
        socket.write(frame(8, body));
        setTimeout(() => socket.destroy(), 200).unref();
      },
    };
    open.add(conn);
    socket.on('close', () => open.delete(conn));
    socket.on('error', () => {});
    let ready = false;
    /** The turn being played: its timers, and what cuts it off. @type {{ timers: NodeJS.Timeout[], turn: Turn } | null} */
    let playing = null;
    const stopTurn = () => {
      for (const t of playing?.timers ?? []) clearTimeout(t);
      playing = null;
    };
    const play = () => {
      stopTurn();
      const turn = turns[Math.min(next++, turns.length - 1)];
      if (!turn) return;
      if (turn.heard) send({ serverContent: { inputTranscription: { text: turn.heard } } });
      const audio = turn.audio ?? new Uint8Array(0);
      const words = turn.said ? turn.said.match(/\S+\s*/g) ?? [] : [];
      const pieces = Math.max(1, Math.ceil(audio.length / chunkBytes));
      // The audio and its words in a burst, interleaved, as Gemini sends them.
      for (let i = 0; i < pieces; i++) {
        const part = audio.subarray(i * chunkBytes, (i + 1) * chunkBytes);
        if (part.length) send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(part).toString('base64') } }] } } });
        const from = Math.floor((i * words.length) / pieces);
        const to = Math.floor(((i + 1) * words.length) / pieces);
        if (to > from) send({ serverContent: { outputTranscription: { text: words.slice(from, to).join('') } } });
      }
      if (turn.tool) send({ toolCall: { functionCalls: [{ name: turn.tool.name, args: turn.tool.args, id: `call_${++calls}` }] } });
      send({ serverContent: { generationComplete: true } });
      const ms = Math.round(((audio.length / 2 / 24_000) * 1000) * pace);
      const done = () => {
        playing = null;
        send({ serverContent: { turnComplete: true }, ...(turn.usage ? { usageMetadata: turn.usage } : {}) });
        if (turn.handle) send({ sessionResumptionUpdate: { newHandle: turn.handle, resumable: true } });
        if (turn.goAway !== undefined) send({ goAway: { timeLeft: `${turn.goAway}s` } });
      };
      if (ms <= 0) done();
      else playing = { turn, timers: [setTimeout(done, ms)] };
    };
    /** Something the user did while a turn plays cuts it off. @param {'text' | 'activity'} by */
    const cut = (by) => {
      if (!playing || (playing.turn.interruptOn && playing.turn.interruptOn !== by)) return;
      stopTurn();
      send({ serverContent: { interrupted: true } });
    };
    /** @param {any} m */
    const handle = (m) => {
      received.push(m);
      if (!ready) {
        const s = m?.setup;
        if (!s) return conn.close(1007, 'Invalid JSON payload received. The first message must be setup.');
        if (closeWith) return conn.close(closeWith.code, closeWith.reason);
        if (key && url.searchParams.get('key') !== key) return conn.close(1007, 'API key not valid. Please pass a valid API key.');
        const id = String(s.model ?? '').replace(/^models\//, '');
        if (!s.model || (models && !models.includes(id))) {
          return conn.close(1008, `${s.model} is not found for API version ${version}, or is not supported for bidiGenerateContent. Call ModelService.ListModels to see the list of available models and their supported methods.`);
        }
        if (version === 'v1beta' && s.proactivity) return conn.close(1007, 'Invalid JSON payload received. Unknown name "proactivity" at \'setup\': Cannot find field.');
        ready = true;
        send({ setupComplete: {} });
        send({ sessionResumptionUpdate: { newHandle: s.sessionResumption?.handle ?? `stand-in-${connections.length}`, resumable: true } });
        return undefined;
      }
      const input = m?.realtimeInput;
      if (input?.activityStart) cut('activity');
      else if (input?.activityEnd) play();
      else if (m?.clientContent) {
        cut('text');
        if (m.clientContent.turnComplete) play();
      }
      return undefined;
    };
    /** @type {Buffer} */
    let buf = Buffer.alloc(0);
    /** @type {Buffer[]} */
    let parts = [];
    let opcode = 0;
    socket.on('data', (chunk) => {
      const r = readFrames(Buffer.concat([buf, chunk]));
      buf = r.rest;
      for (const f of r.frames) {
        if (f.opcode === 8) {
          if (!closing) {
            closing = true;
            socket.end(frame(8, f.payload.subarray(0, 2)));
          }
          stopTurn();
          return;
        }
        if (f.opcode === 9) {
          socket.write(frame(10, f.payload));
          continue;
        }
        if (f.opcode === 10) continue;
        if (f.opcode !== 0) opcode = f.opcode;
        parts.push(f.payload);
        if (!f.fin) continue;
        const text = Buffer.concat(parts).toString('utf8');
        parts = [];
        try {
          handle(JSON.parse(text));
        } catch {
          conn.close(1007, `Invalid JSON payload received (opcode ${opcode}).`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    /** Every message it got, parsed, in order. */
    received: () => received.slice(),
    /** Each connection: its API version, path, the key in its address, its Origin and subprotocols. */
    connections: () => connections.slice(),
    /** Closes every open session with this code and reason, as a dropped or failing server does. @param {number} code @param {string} reason */
    close(code, reason) {
      for (const c of [...open]) c.close(code, reason);
    },
    async stop() {
      for (const c of [...open]) c.close(1001, 'Going away.');
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
