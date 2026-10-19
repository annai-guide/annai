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
 * clientContent comes before that, and then the cut turn's turnComplete.
 * The `openai` flavour (K6) answers as OpenAI Realtime's docs describe it (developers.openai.com, read 2026-10-19), as
 * no OpenAI key was at hand: /v1/realtime?model=…, the key as the subprotocol openai-insecure-api-key.<key> beside
 * `realtime`; its JSON in text frames; session.created at once, session.updated for each session.update (a bad
 * field is an error event, and the session goes on); a wrong or missing key, or an unknown model, an error and then
 * a close 3000 "invalid_request_error", as one was seen (community.openai.com, 2025); turns only by hand
 * (input_audio_buffer.commit, response.create), with the commit's transcript when transcription is on; each
 * response in a burst, its audio and transcript deltas, a tool call's function_call_arguments.done, then
 * response.done with its usage when generation ends; response.cancel, conversation.item.truncate within the
 * audio, and the errors for a second response, an empty commit and a cancel with nothing to cancel.
 * Unit tests reach it with Node's WebSocket, and end-to-end tests from the page, at ws://127.0.0.1:<port> (WebKit
 * can't stand in for a page's own requests).
 * @typedef {{ heard?: string, said?: string, audio?: Uint8Array, tool?: { name: string, args: any }, goAway?: number, handle?: string,
 *   usage?: Record<string, any>, interruptOn?: 'text' | 'activity', refuse?: string, heardAfter?: string, heardFirst?: boolean, saidAfter?: string }} Turn
 *   one answer, played when a clientContent turn or an activityEnd comes (openai: a response.create); turns are given in order,
 *   and the last repeats. audio: 24 kHz 16-bit PCM (openai: in the session's output format); tool: a call it makes after its words;
 *   goAway, handle: Gemini's, seconds left, sent after the turn; usage: Gemini's usageMetadata, or OpenAI's response usage;
 *   interruptOn: only this cuts a Gemini turn off (default: either); refuse: OpenAI refuses the response.create with this error code;
 *   Gemini's (K5): heardAfter: the last words heard, sent after turnComplete, as Gemini's input transcript sometimes comes; heardFirst:
 *   heard is sent as the user starts speaking, not with the answer; saidAfter: the last words said, sent after turnComplete
 * @typedef {{ flavour: 'gemini' | 'openai', turns: Turn[], key?: string, models?: string[], closeWith?: { code: number, reason: string },
 *   pace?: number, chunkBytes?: number }} Options
 *   key: the one key it takes (none: any); models: the ids it knows (none: any); closeWith: how it closes each session at its setup (openai: its session.update);
 *   pace: how long a turn stays open, as a share of its audio's real time (1, as Gemini; 0: at once); openai: how long generating it takes; chunkBytes: audio per message
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

/**
 * One session's link: its messages, as JSON, in binary frames (Gemini) or text frames (OpenAI), and its close.
 * @param {import('node:stream').Duplex} socket @param {boolean} text
 */
function link(socket, text) {
  let closing = false;
  return {
    get closing() { return closing; },
    set closing(v) { closing = v; },
    /** @param {any} m */
    send(m) { if (!closing && !socket.destroyed) socket.write(frame(text ? 1 : 2, Buffer.from(JSON.stringify(m)))); },
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
}

/** @param {Options} o */
export async function startRealtimeServer(o) {
  const { turns, key, models, closeWith, pace = 1, chunkBytes = 9600 } = o;
  /** @type {any[]} */
  const received = [];
  /** @type {{ version: string | null, path: string, model?: string | null, key: string | null, origin: string | undefined, protocols: string[] }[]} */
  const connections = [];
  /** @type {Set<{ close(code: number, reason: string): void }>} */
  const open = new Set();
  const counter = { next: 0, calls: 0, ids: 0 };
  /** Turns whose words heard first were sent: once, whatever connection. @type {Set<Turn>} */
  const early = new Set();
  const turnAt = () => turns[Math.min(counter.next, turns.length - 1)];
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This is a WebSocket server.');
  });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const version = /^\/ws\/google\.ai\.generativelanguage\.(v1alpha|v1beta)\.GenerativeService\.BidiGenerateContent$/.exec(url.pathname)?.[1];
    const isOpenai = o.flavour === 'openai' && /\/realtime$/.test(url.pathname);
    const wsKey = req.headers['sec-websocket-key'];
    if ((o.flavour === 'openai' ? !isOpenai : !version) || typeof wsKey !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const given = isOpenai ? protocols.find((p) => p.startsWith('openai-insecure-api-key.'))?.slice(24) ?? null : url.searchParams.get('key');
    connections.push({ version: version ?? null, path: url.pathname, ...(isOpenai ? { model: url.searchParams.get('model') } : {}), key: given, origin: req.headers.origin, protocols });
    const accept = createHash('sha1').update(wsKey + GUID).digest('base64');
    const chosen = isOpenai ? (protocols.includes('realtime') ? 'realtime' : '') : protocols[0];
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
      ...(chosen ? [`Sec-WebSocket-Protocol: ${chosen}`] : []), '', ''].join('\r\n'));
    /** @type {import('node:net').Socket} */ (socket).setNoDelay(true);
    const conn = link(socket, isOpenai);
    open.add(conn);
    socket.on('close', () => open.delete(conn));
    socket.on('error', () => {});
    const c = { conn, received, turns, turnAt, counter, early, key, given, models, closeWith, pace, chunkBytes, url, version: version ?? '' };
    const session = isOpenai ? openaiSession(c) : geminiSession(c);
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
          if (!conn.closing) {
            conn.closing = true;
            socket.end(frame(8, f.payload.subarray(0, 2)));
          }
          session.stop();
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
        /** @type {any} */
        let m;
        try {
          m = JSON.parse(text);
        } catch {
          conn.close(1007, `Invalid JSON payload received (opcode ${opcode}).`);
          continue;
        }
        received.push(m);
        session.handle(m);
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
    /** Each connection: its API version (Gemini), path, model (OpenAI), the key it gave, its Origin and subprotocols. */
    connections: () => connections.slice(),
    /** Closes every open session with this code and reason, as a dropped or failing server does. @param {number} code @param {string} reason */
    close(code, reason) {
      for (const x of [...open]) x.close(code, reason);
    },
    async stop() {
      for (const x of [...open]) x.close(1001, 'Going away.');
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * @typedef {{ conn: ReturnType<typeof link>, received: any[], turns: Turn[], turnAt: () => Turn | undefined, counter: { next: number, calls: number, ids: number }, early: Set<Turn>,
 *   key?: string, given: string | null, models?: string[], closeWith?: { code: number, reason: string }, pace: number, chunkBytes: number, url: URL, version: string }} Ctx
 */

/** Gemini Live, as measured. @param {Ctx} c @returns {{ handle(m: any): void, stop(): void }} */
function geminiSession(c) {
  const { conn, turns, turnAt, counter, early, key, models, closeWith, pace, chunkBytes, url, version } = c;
  const send = conn.send;
  let ready = false;
  /** The turn being played: its timers, and what cuts it off. @type {{ timers: NodeJS.Timeout[], turn: Turn } | null} */
  let playing = null;
  const stopTurn = () => {
    for (const t of playing?.timers ?? []) clearTimeout(t);
    playing = null;
  };
  const play = () => {
    stopTurn();
    const turn = turns[Math.min(counter.next++, turns.length - 1)];
    if (!turn) return;
    if (turn.heard && !turn.heardFirst) send({ serverContent: { inputTranscription: { text: turn.heard } } });
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
    if (turn.tool) send({ toolCall: { functionCalls: [{ name: turn.tool.name, args: turn.tool.args, id: `call_${++counter.calls}` }] } });
    send({ serverContent: { generationComplete: true } });
    const ms = Math.round(((audio.length / 2 / 24_000) * 1000) * pace);
    const done = () => {
      playing = null;
      send({ serverContent: { turnComplete: true }, ...(turn.usage ? { usageMetadata: turn.usage } : {}) });
      if (turn.heardAfter) send({ serverContent: { inputTranscription: { text: turn.heardAfter } } });
      if (turn.saidAfter) send({ serverContent: { outputTranscription: { text: turn.saidAfter } } });
      if (turn.handle) send({ sessionResumptionUpdate: { newHandle: turn.handle, resumable: true } });
      if (turn.goAway !== undefined) send({ goAway: { timeLeft: `${turn.goAway}s` } });
    };
    if (ms <= 0) done();
    else playing = { turn, timers: [setTimeout(done, ms)] };
  };
  /** Something the user did while a turn plays cuts it off; the cut turn still ends, with its usage, as Gemini's do. @param {'text' | 'activity'} by */
  const cut = (by) => {
    if (!playing || (playing.turn.interruptOn && playing.turn.interruptOn !== by)) return;
    const { turn } = playing;
    stopTurn();
    send({ serverContent: { interrupted: true } });
    send({ serverContent: { turnComplete: true }, ...(turn.usage ? { usageMetadata: turn.usage } : {}) });
  };
  return {
    stop: stopTurn,
    handle(m) {
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
        send({ sessionResumptionUpdate: { newHandle: s.sessionResumption?.handle ?? `stand-in-${++counter.ids}`, resumable: true } });
        return undefined;
      }
      const input = m?.realtimeInput;
      const coming = turnAt();
      if (input?.activityStart && coming?.heardFirst && coming.heard && !early.has(coming)) {
        early.add(coming);
        send({ serverContent: { inputTranscription: { text: coming.heard } } });
      }
      if (input?.activityStart) cut('activity');
      else if (input?.activityEnd) play();
      else if (m?.clientContent) {
        cut('text');
        if (m.clientContent.turnComplete) play();
      }
      return undefined;
    },
  };
}

/** OpenAI Realtime's voices (client events reference). */
const VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
/** Audio bytes a millisecond, by OpenAI's format type. @param {any} f */
const bytesPerMs = (f) => (f?.type === 'audio/pcmu' || f?.type === 'audio/pcma' ? 8 : 48);

/** OpenAI Realtime, as its docs describe it. @param {Ctx} c @returns {{ handle(m: any): void, stop(): void }} */
function openaiSession(c) {
  const { conn, turns, turnAt, counter, key, given, models, closeWith, pace, chunkBytes, url } = c;
  let n = 0;
  const id = (/** @type {string} */ prefix) => `${prefix}_${String(++counter.ids).padStart(3, '0')}`;
  /** @param {any} m */
  const send = (m) => conn.send({ type: m.type, event_id: `event_${++n}`, ...m });
  /** The client event being handled: an error names it, as OpenAI's do. @type {any} */
  let current = null;
  /** @param {string} code @param {string} message @param {string | null} [param] @param {string} [type] */
  const error = (code, message, param = null, type = 'invalid_request_error') => send({ type: 'error', error: { type, code, message, param, event_id: current?.event_id ?? null } });
  const model = url.searchParams.get('model') ?? '';
  /** The session as the client set it, from OpenAI's defaults. @type {any} */
  const session = {
    type: 'realtime', object: 'realtime.session', id: id('sess'), model, output_modalities: ['audio'], instructions: '', tools: [], tool_choice: 'auto', max_output_tokens: 'inf',
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: null, noise_reduction: null, turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200, create_response: true, interrupt_response: true } },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'alloy', speed: 1 },
    },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  // The refusals come at once, as an error and then a close.
  const refuse = !given && key !== undefined ? ['missing_api_key', 'Missing bearer or basic authentication in header'] : key && given !== key
    ? ['invalid_api_key', `Incorrect API key provided: ${given}. You can find your API key at https://platform.openai.com/account/api-keys.`]
    : models && !models.includes(model) ? ['model_not_found', `The model '${model}' does not exist or you do not have access to it.`] : null;
  if (refuse) {
    error(refuse[0], refuse[1]);
    conn.close(3000, 'invalid_request_error');
  } else send({ type: 'session.created', session });
  let buffer = 0;
  let last = /** @type {string | null} */ (null);
  /** Audio by item, in ms, for truncation. @type {Map<string, number>} */
  const audioMs = new Map();
  /** The response in progress. @type {{ id: string, timer: NodeJS.Timeout | null, output: any[], usage: any } | null} */
  let active = null;
  /** @param {any} item */
  const add = (item) => {
    send({ type: 'conversation.item.added', previous_item_id: last, item });
    send({ type: 'conversation.item.done', previous_item_id: last, item });
    last = item.id;
  };
  /** @param {'completed' | 'cancelled'} status */
  const finish = (status) => {
    if (!active) return;
    const r = active;
    if (r.timer) clearTimeout(r.timer);
    active = null;
    send({ type: 'response.done', response: { id: r.id, object: 'realtime.response', status, status_details: status === 'cancelled' ? { type: 'cancelled', reason: 'client_cancelled' } : null, output: r.output, usage: r.usage ?? null } });
  };
  const respond = () => {
    const turn = turns[Math.min(counter.next++, turns.length - 1)];
    if (turn?.refuse) return error(turn.refuse, 'The response could not be created.');
    const r = { id: id('resp'), timer: /** @type {NodeJS.Timeout | null} */ (null), output: /** @type {any[]} */ ([]), usage: turn?.usage };
    active = r;
    send({ type: 'response.created', response: { id: r.id, object: 'realtime.response', status: 'in_progress', output: [], usage: null } });
    const audio = turn?.audio ?? new Uint8Array(0);
    if (turn && (turn.said || audio.length)) {
      const item = { id: id('item'), object: 'realtime.item', type: 'message', role: 'assistant', status: 'in_progress', content: /** @type {any[]} */ ([]) };
      const at = { response_id: r.id, item_id: item.id, output_index: 0, content_index: 0 };
      send({ type: 'response.output_item.added', response_id: r.id, output_index: 0, item });
      send({ type: 'response.content_part.added', ...at, part: { type: 'audio', transcript: '' } });
      const words = turn.said ? turn.said.match(/\S+\s*/g) ?? [] : [];
      const pieces = Math.max(1, Math.ceil(audio.length / chunkBytes));
      for (let i = 0; i < pieces; i++) {
        const part = audio.subarray(i * chunkBytes, (i + 1) * chunkBytes);
        if (part.length) send({ type: 'response.output_audio.delta', ...at, delta: Buffer.from(part).toString('base64') });
        const from = Math.floor((i * words.length) / pieces);
        const to = Math.floor(((i + 1) * words.length) / pieces);
        if (to > from) send({ type: 'response.output_audio_transcript.delta', ...at, delta: words.slice(from, to).join('') });
      }
      send({ type: 'response.output_audio.done', ...at });
      send({ type: 'response.output_audio_transcript.done', ...at, transcript: turn.said ?? '' });
      send({ type: 'response.content_part.done', ...at, part: { type: 'audio', transcript: turn.said ?? '' } });
      const whole = { ...item, status: 'completed', content: [{ type: 'output_audio', transcript: turn.said ?? '' }] };
      send({ type: 'response.output_item.done', response_id: r.id, output_index: 0, item: whole });
      r.output.push(whole);
      audioMs.set(item.id, audio.length / bytesPerMs(session.audio.output.format));
      last = item.id;
    }
    if (turn?.tool) {
      const args = JSON.stringify(turn.tool.args);
      const item = { id: id('item'), object: 'realtime.item', type: 'function_call', status: 'completed', call_id: `call_${++counter.calls}`, name: turn.tool.name, arguments: args };
      const output = r.output.length;
      send({ type: 'response.output_item.added', response_id: r.id, output_index: output, item: { ...item, status: 'in_progress', arguments: '' } });
      send({ type: 'response.function_call_arguments.delta', response_id: r.id, item_id: item.id, output_index: output, call_id: item.call_id, delta: args });
      send({ type: 'response.function_call_arguments.done', response_id: r.id, item_id: item.id, output_index: output, call_id: item.call_id, name: item.name, arguments: args });
      send({ type: 'response.output_item.done', response_id: r.id, output_index: output, item });
      r.output.push(item);
      last = item.id;
    }
    const ms = Math.round((audio.length / bytesPerMs(session.audio.output.format)) * pace);
    if (ms <= 0) finish('completed');
    else r.timer = setTimeout(() => finish('completed'), ms);
  };
  /** A session.update's audio formats, checked as OpenAI's are. @param {any} f @param {string} param */
  const badFormat = (f, param) => {
    if (f === undefined) return null;
    if (!['audio/pcm', 'audio/pcmu', 'audio/pcma'].includes(f?.type)) return `${param}.type`;
    return f.type === 'audio/pcm' && f.rate !== undefined && f.rate !== 24000 ? `${param}.rate` : null;
  };
  return {
    stop: () => { if (active?.timer) clearTimeout(active.timer); },
    handle(m) {
      if (refuse) return;
      current = m;
      switch (m?.type) {
        case 'session.update': {
          const s = m.session ?? {};
          if (closeWith) return conn.close(closeWith.code, closeWith.reason);
          if (s.type !== undefined && s.type !== 'realtime') return error('invalid_value', `Invalid value: '${s.type}'.`, 'session.type');
          const voice = s.audio?.output?.voice;
          if (voice !== undefined && !VOICES.has(voice)) return error('invalid_value', `Invalid value: '${voice}'. Supported values are: ${[...VOICES].join(', ')}.`, 'session.audio.output.voice');
          const wrong = badFormat(s.audio?.input?.format, 'session.audio.input.format') ?? badFormat(s.audio?.output?.format, 'session.audio.output.format');
          if (wrong) return error('invalid_value', 'Invalid value for the audio format.', wrong);
          const { audio, ...rest } = s;
          Object.assign(session, rest);
          for (const side of /** @type {const} */ (['input', 'output'])) Object.assign(session.audio[side], audio?.[side] ?? {});
          return send({ type: 'session.updated', session });
        }
        case 'input_audio_buffer.append':
          buffer += Buffer.from(String(m.audio ?? ''), 'base64').length;
          return undefined;
        case 'input_audio_buffer.clear':
          buffer = 0;
          return send({ type: 'input_audio_buffer.cleared' });
        case 'input_audio_buffer.commit': {
          if (!buffer) return error('input_audio_buffer_commit_empty', 'Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio.');
          const item = { id: id('item'), object: 'realtime.item', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', transcript: null }] };
          const seconds = buffer / bytesPerMs(session.audio.input.format) / 1000;
          buffer = 0;
          send({ type: 'input_audio_buffer.committed', previous_item_id: last, item_id: item.id });
          add(item);
          const heard = turnAt()?.heard;
          if (session.audio.input.transcription && heard) {
            for (const w of heard.match(/\S+\s*/g) ?? []) send({ type: 'conversation.item.input_audio_transcription.delta', item_id: item.id, content_index: 0, delta: w });
            send({ type: 'conversation.item.input_audio_transcription.completed', item_id: item.id, content_index: 0, transcript: heard, usage: { type: 'duration', seconds } });
          }
          return undefined;
        }
        case 'conversation.item.create': {
          const item = { id: id('item'), object: 'realtime.item', status: 'completed', ...m.item };
          return add(item);
        }
        case 'conversation.item.truncate': {
          const ms = audioMs.get(m.item_id);
          if (ms === undefined) return error('invalid_value', `Item with item_id '${m.item_id}' not found or is not an assistant message with audio.`, 'item_id');
          if (!(m.audio_end_ms >= 0 && m.audio_end_ms <= ms)) return error('invalid_value', `audio_end_ms (${m.audio_end_ms}) is greater than the audio content length (${ms}ms).`, 'audio_end_ms');
          audioMs.set(m.item_id, m.audio_end_ms);
          return send({ type: 'conversation.item.truncated', item_id: m.item_id, content_index: m.content_index ?? 0, audio_end_ms: m.audio_end_ms });
        }
        case 'response.create':
          if (active) return error('conversation_already_has_active_response', `Conversation already has an active response in progress: ${active.id}. Wait until the response is finished before creating a new one.`);
          return respond();
        case 'response.cancel':
          if (!active) return error('response_cancel_not_active', 'Cancellation failed: no active response found');
          return finish('cancelled');
        default:
          return error('invalid_event', `Invalid event type: '${m?.type}'.`, 'type');
      }
    },
  };
}
