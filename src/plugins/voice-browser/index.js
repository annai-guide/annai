import { encodeWav } from '../../core/voice/pcm.js';
import { oggOpus, webmOpus, adts, flacFile, cat } from '../../core/voice/mux.js';
import { CODEC_ORDER, mediaTypeOf } from '../../core/voice/formats.js';

/**
 * The device side of voice (spec §10), a built-in plugin (§19): one audio player for every voice
 * clip, unlocked by the first tap of each session (an iPhone rule, §10.1); the browser's own
 * voice; the microphone, through an AudioWorklet (§10.2); the phone's dictation; the audio devices,
 * for voice Auto (§10.5); the audio session type where the browser has one (Safari); and its audio
 * encoders (§10.6). The core reaches it as 'voice-platform'.
 * @typedef {import('../../core/voice/platform.js').VoicePlatform} VoicePlatform
 */

/** AudioEncoder's codecs, at 16 kHz mono: bitrate, and the files each makes. */
const CODECS = /** @type {[string, number, string[]][]} */ ([['opus', 24_000, ['ogg', 'webm']], ['mp4a.40.2', 32_000, ['aac']], ['mp3', 32_000, ['mp3']], ['flac', 0, ['flac']]]);
/** @param {string} format */
const codecFor = (format) => CODECS.find((c) => c[2].includes(format))?.[0];
/** MediaRecorder's types; plain audio/mp4 in case iOS refuses the codec string. */
const RECORDS = [['audio/ogg;codecs=opus', 'ogg'], ['audio/webm;codecs=opus', 'webm'], ['audio/mp4;codecs=mp4a.40.2', 'mp4'], ['audio/mp4', 'mp4']];
const PARAMS = /** @type {Record<string, string>} */ ({ ogg: '; codecs=opus', webm: '; codecs=opus', mp4: '; codecs=mp4a.40.2' });

/**
 * One codec's packets for 16-bit PCM, and its description (OpusHead, AAC's config, FLAC's
 * metadata). An encoder that hasn't finished in ms has failed. @param {Int16Array} pcm @param {number} rate @param {string} codec @param {number} ms
 * @returns {Promise<{ packets: Uint8Array[], description: Uint8Array | null }>}
 */
async function encodeWith(pcm, rate, codec, ms) {
  /** @type {Uint8Array[]} */
  const packets = [];
  /** @type {Uint8Array | null} */
  let description = null;
  /** @type {unknown} */
  let failed = null;
  /** @type {any} */
  let timer;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push(b);
      const d = /** @type {any} */ (meta?.decoderConfig?.description);
      if (d) description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
    },
    error: (e) => { failed = e; },
  });
  try {
    const bitrate = CODECS.find((c) => c[0] === codec)?.[1];
    enc.configure({ codec, sampleRate: rate, numberOfChannels: 1, ...(bitrate ? { bitrate } : {}) });
    const data = new AudioData({ format: 's16', sampleRate: rate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: 0, data: /** @type {Int16Array<ArrayBuffer>} */ (pcm) });
    enc.encode(data);
    data.close();
    const flushed = enc.flush();
    flushed.catch(() => {}); // closed below when it took too long
    await Promise.race([flushed, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`The ${codec} encoder took too long.`)), ms); })]);
  } finally {
    clearTimeout(timer);
    if (enc.state !== 'closed') enc.close();
  }
  if (failed) throw failed;
  if (!packets.length) throw new Error(`The ${codec} encoder made nothing.`);
  return { packets, description };
}
export const manifest = { id: 'voice-browser', name: 'Voice on this device', version: '0.1.0', api: 1, description: "The phone's speaker, microphone, voice and dictation." };

/** @param {any} annai */
export function activate(annai) {
  return annai.register('voice-platform', browserPlatform());
}

/**
 * What the player worklet tells (player-worklet.js), about every 50 ms and at once as it starts, runs dry or is done. frame: the
 * context's frame it is true at; played: frames of sound played; read: samples it has played past; dry: it ran dry and faded out,
 * so what it had then (had) will not sound until more comes (had is all it was given, when not dry); level: loudness (RMS) since
 * the last; holes: times it ran dry and played on, holeFrames how long they were; waited: frames its first sound waited to play.
 * @typedef {{ frame: number, played: number, read: number, had: number, level: number, playing: boolean, dry: boolean, done: boolean, holes: number,
 *   holeFrames: number, waited: number }} Report
 * @typedef {import('../../core/voice/platform.js').PlayerStream} PlayerStream
 * @typedef {import('../../core/voice/platform.js').Played} Played
 */

/** How long the player worklet's module may take to load, and how many times it is tried on a context. */
const PLAYER_LOAD_MS = 1500;
const PLAYER_TRIES = 3;
/** A player that tells nothing this long, or whose clock stands still, has stalled (a context suspended, the audio thread gone). */
const STALL_MS = 1000;

/** A promise and the function that settles it. @template T @returns {[Promise<T>, (v: T) => void]} */
function settled() {
  /** @type {(v: T) => void} */
  let settle = () => {};
  return [new Promise((r) => { settle = r; }), (v) => settle(v)];
}

/**
 * A stream whose player is known once made settles: what comes meanwhile is held, then handed on.
 * @param {Promise<PlayerStream>} made @param {Promise<boolean>} running @returns {PlayerStream}
 */
function heldStream(made, running) {
  /** @type {PlayerStream | null} */
  let inner = null;
  /** @type {Int16Array[]} */
  const held = [];
  let ended = false;
  /** @type {Played | null} */
  let stopped = null;
  const [done, settle] = /** @type {[Promise<Played>, (r: Played) => void]} */ (settled());
  const [started, start] = /** @type {[Promise<void>, () => void]} */ (settled());
  made.then((s) => {
    if (stopped) return void s.stop();
    inner = s;
    for (const p of held.splice(0)) s.push(p);
    if (ended) s.end();
    s.done.then(settle);
    s.started?.then(start);
  });
  return {
    push(pcm) {
      if (inner) inner.push(pcm);
      else if (!stopped) held.push(pcm);
    },
    end() {
      ended = true;
      inner?.end();
    },
    queued: () => (inner ? inner.queued() : held.length),
    stop() {
      if (inner) return inner.stop();
      held.length = 0;
      stopped ??= { playedMs: 0 };
      settle(stopped);
      return stopped;
    },
    done,
    started,
    running,
  };
}

/**
 * A stream through a player worklet's node: the page's side, apart so that it is tested without sound. Its reports are at most
 * 50 ms old, and come at once when it runs dry or is done: so queued() says a piece is still to play from its push until a report
 * has it played (a half-duplex microphone is deaf no shorter than her sound), and stop() adds what has played since the last report.
 * A node that tells nothing for stallMs, or fails, is stopped: done, stalled.
 * @param {{ port: { postMessage(m: any, t?: Transferable[]): void, onmessage: ((e: MessageEvent) => void) | null, close(): void }, disconnect(): void, onprocessorerror?: any }} node
 * @param {{ rate: number, sampleRate: number, now: () => number, onLevel?: (x: number) => void, running: Promise<boolean>, stallMs?: number }} o
 *   rate: the stream's; sampleRate: the context's; now: the context's time, in seconds
 * @returns {PlayerStream}
 */
export function workletStream(node, { rate, sampleRate, now, onLevel = () => {}, running, stallMs = STALL_MS }) {
  /** Where each piece pushed ends, in samples: those played are let go. @type {number[]} */
  const ends = [];
  let pushed = 0;
  /** @type {Report} */
  let last = { frame: 0, played: 0, read: 0, had: 0, level: 0, playing: false, dry: false, done: false, holes: 0, holeFrames: 0, waited: 0 };
  /** @type {Played | null} */
  let result = null;
  const [done, settle] = /** @type {[Promise<Played>, (r: Played) => void]} */ (settled());
  const [started, start] = /** @type {[Promise<void>, () => void]} */ (settled());
  const ms = (/** @type {number} */ frames) => Math.round((frames / sampleRate) * 1000);
  /** @param {number} playedMs @param {boolean} [stalled] */
  const finish = (playedMs, stalled = false) => {
    if (result) return result;
    result = { playedMs, holes: last.holes, holeMs: ms(last.holeFrames), waitMs: ms(last.waited), player: 'worklet', ...(stalled ? { stalled } : {}) };
    onLevel(0);
    settle(result);
    return result;
  };
  /** Heard so far: the last report, and what has played since if it was playing. */
  const heard = () => Math.round(Math.min(ms(last.played) + (last.playing ? Math.max(0, now() - last.frame / sampleRate) * 1000 : 0), (pushed / rate) * 1000));
  const letGo = () => {
    clearTimeout(watch);
    node.port.onmessage = null;
    node.onprocessorerror = null;
    node.port.close();
    node.disconnect();
  };
  const stall = () => {
    node.port.postMessage('stop');
    const r = finish(heard(), true);
    ends.length = 0;
    letGo();
    return r;
  };
  let watch = setTimeout(stall, stallMs);
  node.onprocessorerror = stall;
  node.port.onmessage = (e) => {
    /** @type {Report} */
    const r = e.data;
    if (r?.frame === undefined) return; // a sync's answer
    last = r;
    clearTimeout(watch);
    watch = setTimeout(stall, stallMs);
    if (r.playing) start();
    // Run dry, what it had will not sound unless more comes: her sound has stopped (what came after it stays queued).
    const past = r.done ? Infinity : r.dry ? r.had : r.read;
    while (ends.length && ends[0] <= past) ends.shift();
    if (r.done) {
      letGo();
      finish(ms(r.played));
    } else if (!result) onLevel(Math.min(1, r.level * 4));
  };
  return {
    push(pcm) {
      if (result || !pcm.length) return;
      const copy = pcm.slice();
      node.port.postMessage(copy, [copy.buffer]);
      ends.push((pushed += pcm.length));
    },
    end() {
      if (!result) node.port.postMessage('end');
    },
    queued: () => ends.length,
    stop() {
      if (result) return result;
      node.port.postMessage('stop'); // it fades out over 12 ms at most: the sound's tail, not counted
      return finish(heard());
    },
    done,
    started,
    running,
  };
}

/**
 * The player where AudioWorklet isn't, or its module didn't load: a buffer a piece, scheduled back to back on the context. Each
 * piece is resampled alone and stopped at once, so an edge or a stop can click (the pops investigation, 2026-10-23). A clock that
 * stands still for STALL_MS (a suspended context) stops it: done, stalled.
 * @param {AudioContext} c @param {{ rate: number, onLevel: (x: number) => void, running: Promise<boolean> }} o @returns {PlayerStream}
 */
function bufferStream(c, { rate, onLevel, running }) {
  /** The pieces still to play: when on the context's clock, their source, and their loudness. @type {{ at: number, end: number, src: AudioBufferSourceNode, level: number }[]} */
  const pieces = [];
  let heard = 0; // seconds of the pieces already played and let go
  let next = 0;
  let ended = false;
  let holes = 0;
  let holeS = 0;
  let clock = c.currentTime;
  let movedAt = Date.now();
  /** @type {Played | null} */
  let result = null;
  const [done, settle] = /** @type {[Promise<Played>, (r: Played) => void]} */ (settled());
  const [started, start] = /** @type {[Promise<void>, () => void]} */ (settled());
  const finish = (stalled = false) => {
    if (result) return result;
    clearInterval(ticker);
    onLevel(0);
    // What was heard: sound only, never the gaps when pieces came late.
    const playedMs = Math.round((heard + pieces.reduce((s, p) => s + Math.max(0, Math.min(c.currentTime, p.end) - p.at), 0)) * 1000);
    result = { playedMs, holes, holeMs: Math.round(holeS * 1000), waitMs: 30, player: 'buffers', ...(stalled ? { stalled } : {}) };
    settle(result);
    return result;
  };
  const stop = (stalled = false) => {
    const r = finish(stalled);
    for (const p of pieces) p.src.stop();
    pieces.length = 0;
    return r;
  };
  // Its ticker runs until end() has played out or stop(): a caller always ends a stream one way or the other.
  const ticker = setInterval(() => {
    const now = c.currentTime;
    if (now !== clock) [clock, movedAt] = [now, Date.now()];
    else if (Date.now() - movedAt >= STALL_MS) return void stop(true);
    while (pieces.length && pieces[0].end <= now) {
      const p = /** @type {{ at: number, end: number }} */ (pieces.shift());
      heard += p.end - p.at;
    }
    if (pieces[0]?.at <= now) start();
    onLevel(pieces.find((p) => p.at <= now)?.level ?? 0);
    if (ended && now >= next) finish();
  }, 50);
  return {
    push(pcm) {
      if (result || !pcm.length) return;
      const buf = c.createBuffer(1, pcm.length, rate);
      const ch = buf.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += (ch[i] = pcm[i] / 0x8000) ** 2;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const at = Math.max(next, c.currentTime + 0.03);
      if (next && at > next + 0.001) {
        holes++;
        holeS += at - next;
      }
      src.start(at);
      next = at + buf.duration;
      pieces.push({ at, end: next, src, level: Math.min(1, Math.sqrt(sum / pcm.length) * 4) });
    },
    end() { ended = true; },
    queued: () => pieces.length,
    running,
    stop: () => stop(),
    done,
    started,
  };
}

/** limitMs: how long a codec's trial may take; an encoding gets that and 0.3 s a second of speech. @returns {VoicePlatform} */
export function browserPlatform({ limitMs = 2000 } = {}) {
  /** @type {AudioContext | null} */
  let ctx = null;
  const context = () => (ctx ??= new AudioContext());
  /** @type {HTMLAudioElement | null} */
  let element = null;
  const player = () => (element ??= new Audio());
  /** @type {Promise<void> | null} */
  let worklet = null;
  /** @type {Promise<boolean> | null} */
  let playerModule = null;
  let playerTries = 0;
  /**
   * The player worklet's module on the context, loaded at a tap or as the microphone opens: whether it is in, within
   * PLAYER_LOAD_MS (a stream meanwhile plays on buffers). A load that failed or hung is tried again by the next stream, PLAYER_TRIES
   * times in all.
   */
  const playerReady = () => {
    if (!playerModule && playerTries < PLAYER_TRIES && typeof AudioWorkletNode !== 'undefined' && context().audioWorklet) {
      playerTries++;
      const loading = context().audioWorklet.addModule(new URL('./player-worklet.js', import.meta.url).href).then(() => true, () => false);
      const late = new Promise((r) => { setTimeout(() => r(false), PLAYER_LOAD_MS); });
      const mine = (playerModule = Promise.race([loading, late]));
      mine.then((ok) => { if (!ok && playerModule === mine) playerModule = null; });
    }
    return playerModule ?? Promise.resolve(false);
  };
  /** Each open microphone's track (§10.5): the newest is the one in use, read afresh each time (AirPods taken out). @type {MediaStreamTrack[]} */
  const inputs = [];
  /** @type {Promise<string[]> | null} */
  let made = null;
  /** Codecs whose encoding failed or hung: WAV and the rest until annai restarts. */
  const broken = new Set();
  /** A segment's packets by codec, so its Ogg and its WebM share one encoding. @type {WeakMap<ArrayBufferLike, Map<string, ReturnType<typeof encodeWith>>>} */
  const packets = new WeakMap();
  /** @param {Int16Array} pcm @param {number} rate @param {string} codec */
  const packetsOf = (pcm, rate, codec) => {
    let m = packets.get(pcm.buffer);
    if (!m) packets.set(pcm.buffer, (m = new Map()));
    const key = `${codec} ${rate} ${pcm.byteOffset} ${pcm.length}`;
    let p = m.get(key);
    if (!p) m.set(key, (p = encodeWith(pcm, rate, codec, limitMs + (pcm.length / rate) * 300)));
    return p;
  };

  /**
   * The clip's loudness every 50 ms, 0..1, for the glow (spec §16.3), read with Web Audio's
   * decoder: playback itself stays on the audio element. @param {{ data: Uint8Array }} clip
   */
  async function envelope(clip) {
    const buf = await context().decodeAudioData(clip.data.slice().buffer);
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.round(buf.sampleRate * 0.05));
    /** @type {number[]} */
    const rms = [];
    for (let i = 0; i < ch.length; i += step) {
      let s = 0;
      const end = Math.min(ch.length, i + step);
      for (let j = i; j < end; j++) s += ch[j] * ch[j];
      rms.push(Math.sqrt(s / (end - i)));
    }
    const peak = Math.max(1e-6, ...rms);
    return rms.map((x) => Math.min(1, x / peak));
  }

  return {
    player: {
      unlock() {
        // Inside a tap: the player, the microphone's context and the browser voice may start. Each is
        // started now, in the tap; after a wait it would no longer count. Until the player played, every tap tries again.
        /** @type {Promise<boolean>} */
        let played;
        try {
          const a = player();
          a.src = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (encodeWav(new Float32Array(800), 16000))], { type: 'audio/wav' }));
          played = a.play().then(() => true, () => false);
        } catch {
          played = Promise.resolve(false);
        }
        context().resume().catch(() => {});
        playerReady(); // loaded before her first word
        try {
          const quiet = new SpeechSynthesisUtterance(' ');
          quiet.volume = 0;
          speechSynthesis.speak(quiet);
        } catch {
          // no browser voice here
        }
        return played;
      },
      // A live session's voice (K4), and a streamed voice's (G3): through the player worklet, or, where it can't load, pieces
      // scheduled back to back on the one unlocked context. What is pushed before the worklet is known to load or not is held.
      stream({ rate, onLevel = () => {} }) {
        const c = context();
        // Whether it will sound: a context an interruption or a locked screen suspended may not resume without a tap (fix pass).
        const running = c.state === 'running' ? Promise.resolve(true) : c.resume().then(() => c.state === 'running', () => false);
        return heldStream(playerReady().then((ok) => {
          if (ok) {
            try {
              const node = new AudioWorkletNode(c, 'annai-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { rate } });
              node.connect(c.destination);
              return workletStream(node, { rate, sampleRate: c.sampleRate, now: () => c.currentTime, onLevel, running });
            } catch {
              // the buffers below
            }
          }
          return bufferStream(c, { rate, onLevel, running });
        }), running);
      },
      output: () => (ctx ? { sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency } : null),
      plays: () => CODEC_ORDER.flat().filter((f) => f !== 'opus' && player().canPlayType(mediaTypeOf(f) + (PARAMS[f] ?? '')) !== ''),
      async play(clip, { signal, onLevel = () => {} }) {
        if (signal.aborted) return { ended: false, fraction: 0 };
        const a = player();
        const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (clip.data)], { type: clip.mediaType }));
        /** @type {number[] | null} */
        let levels = null;
        envelope(clip).then((l) => { levels = l; }, () => {});
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let ticker;
        /** @type {() => void} */
        let stop = () => {};
        try {
          a.src = url;
          await a.play(); // a NotAllowedError: the page may not play sound yet
          if (signal.aborted) {
            a.pause();
            return { ended: false, fraction: 0 };
          }
          ticker = setInterval(() => { if (levels) onLevel(levels[Math.floor(a.currentTime / 0.05)] ?? 0); }, 50);
          return await new Promise((resolve, reject) => {
            a.onended = () => resolve({ ended: true, fraction: 1 });
            a.onerror = () => reject(new Error("The voice's audio couldn't be played."));
            stop = () => {
              const fraction = a.duration > 0 ? a.currentTime / a.duration : 0;
              a.pause();
              resolve({ ended: false, fraction });
            };
            signal.addEventListener('abort', stop, { once: true });
          });
        } finally {
          // A stop that comes later must not pause the next clip on this one player.
          signal.removeEventListener('abort', stop);
          clearInterval(ticker);
          a.onended = null;
          a.onerror = null;
          onLevel(0);
          URL.revokeObjectURL(url);
        }
      },
    },
    synth: {
      available: () => typeof speechSynthesis !== 'undefined',
      // localService false: the browser sends the words to the voice's service (spec §11.7).
      voices: () => (typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: Boolean(v.localService), default: Boolean(v.default) }))),
      say(text, { signal, voice, rate = 1, lang, onLevel = () => {} }) {
        return new Promise((resolve, reject) => {
          const u = new SpeechSynthesisUtterance(text);
          const chosen = voice ? speechSynthesis.getVoices().find((v) => v.voiceURI === voice) : undefined;
          if (chosen) u.voice = chosen;
          else if (lang) u.lang = lang;
          u.rate = rate;
          let charIndex = 0;
          let level = 0;
          let settled = false;
          // The browser voice gives no audio to measure: the glow pulses with each word (spec §16.3).
          const pulse = setInterval(() => { level = Math.max(0.3, level * 0.7); onLevel(level); }, 60);
          // Some voices never say they finished: a generous limit ends the wait.
          const limit = setTimeout(() => finish({ ended: true, charIndex: text.length }), 4000 + text.length * 150);
          const stop = () => {
            speechSynthesis.cancel();
            finish({ ended: false, charIndex });
          };
          /** @param {{ ended: boolean, charIndex: number } | null} r @param {Error} [err] */
          const finish = (r, err) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', stop); // a later stop must not cancel the next sentence
            clearInterval(pulse);
            clearTimeout(limit);
            onLevel(0);
            if (err || !r) reject(err);
            else resolve(r);
          };
          u.onboundary = (e) => {
            if (!e.name || e.name === 'word') {
              charIndex = e.charIndex;
              level = 0.8;
            }
          };
          u.onend = () => finish(signal.aborted ? { ended: false, charIndex } : { ended: true, charIndex: text.length });
          u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? finish({ ended: false, charIndex }) : finish(null, new Error(`The browser voice couldn't speak (${e.error}).`)));
          signal.addEventListener('abort', stop, { once: true });
          speechSynthesis.speak(u);
        });
      },
    },
    encoder: {
      // Each codec tried once, side by side, on a tenth of a second: one the browser says it has may still fail or hang.
      async makes() {
        made ??= typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' ? Promise.resolve([])
          : Promise.all(CODECS.map(([codec, , formats]) => encodeWith(new Int16Array(1600), 16_000, codec, limitMs).then(() => formats, () => []))).then((l) => l.flat());
        return (await made).filter((f) => !broken.has(codecFor(f)));
      },
      records: () => (typeof MediaRecorder === 'undefined' ? [] : RECORDS.filter(([t]) => MediaRecorder.isTypeSupported(t)).map(([type, format]) => ({ type, format }))
        .filter((r, i, all) => all.findIndex((x) => x.format === r.format) === i)),
      async encode(pcm, rate, format) {
        const codec = codecFor(format);
        if (!codec) throw new Error(`annai can't make ${format} here.`);
        const { packets: p, description: d } = await packetsOf(pcm, rate, codec).catch((e) => {
          broken.add(codec);
          throw e;
        });
        if (codec === 'opus') {
          const head = d && String.fromCharCode(...d.subarray(0, 8)) === 'OpusHead' ? d : null;
          // 312: libopus's usual look-ahead. Chromium gives it at the input's rate (104 at 16 kHz); the file wants 48 kHz.
          const ps = head ? head[10] | (head[11] << 8) : 312;
          const o = { rate, channels: 1, samples: pcm.length, preSkip: ps < 120 ? Math.round((ps * 48_000) / rate) : ps };
          return format === 'ogg' ? oggOpus(p, o) : webmOpus(p, o);
        }
        if (codec === 'mp4a.40.2') return adts(p, { rate, channels: 1 });
        if (codec === 'flac') return flacFile(d, p);
        return cat(p); // MP3 frames are a file as they are
      },
      async decode(data) {
        const buf = await context().decodeAudioData(data.slice().buffer);
        return { pcm: buf.getChannelData(0), rate: buf.sampleRate };
      },
    },
    mic: {
      inUse: () => {
        const t = inputs.at(-1);
        return t ? { label: t.label ?? '', deviceId: t.getSettings?.().deviceId ?? '' } : null;
      },
      async open({ onFrames, onError, record }) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        try {
          const c = context();
          if (c.state !== 'running') await c.resume().catch(() => {});
          playerReady();
          worklet ??= c.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
          try {
            await worklet;
          } catch (e) {
            worklet = null;
            throw e;
          }
          const source = c.createMediaStreamSource(stream);
          const node = new AudioWorkletNode(c, 'annai-capture');
          const silent = c.createGain();
          silent.gain.value = 0;
          node.port.onmessage = (e) => onFrames(e.data, c.sampleRate);
          source.connect(node);
          node.connect(silent).connect(c.destination); // some browsers run a node only when it leads somewhere
          for (const t of stream.getAudioTracks()) t.onended = () => onError(new Error('The microphone stopped.'));
          const input = stream.getAudioTracks()[0];
          if (input) inputs.push(input);
          // A MediaRecorder alongside (decision 24), in files cut by take().
          /** @type {MediaRecorder | null} */
          let rec = null;
          /** @type {Blob[]} */
          let parts = [];
          const begin = () => {
            if (!record) return;
            const mine = (parts = []);
            try {
              rec = new MediaRecorder(stream, { mimeType: record, audioBitsPerSecond: 32_000 });
              rec.ondataavailable = (e) => { if (e.data.size) mine.push(e.data); };
              rec.start();
            } catch {
              rec = null; // the segment is sent as the encoder or WAV make it
            }
          };
          /** keep: read the file; else it is thrown away unread. @returns {Promise<Uint8Array | null>} */
          const end = (keep = false) => new Promise((resolve) => {
            const r = rec;
            const mine = parts;
            rec = null;
            if (!r || r.state === 'inactive') return resolve(null);
            r.onstop = () => (keep ? new Blob(mine).arrayBuffer().then((b) => resolve(b.byteLength ? new Uint8Array(b) : null), () => resolve(null)) : resolve(null));
            r.onerror = () => resolve(null);
            r.stop();
          });
          begin();
          return {
            ...(record ? {
              take() {
                const file = end(true);
                begin();
                return file;
              },
              again() {
                end();
                begin();
              },
            } : {}),
            close() {
              end();
              if (inputs.includes(input)) inputs.splice(inputs.indexOf(input), 1);
              node.port.onmessage = null;
              for (const t of stream.getTracks()) {
                t.onended = null;
                t.stop();
              }
              source.disconnect();
              node.disconnect();
              silent.disconnect();
            },
          };
        } catch (e) {
          for (const t of stream.getTracks()) t.stop();
          throw e;
        }
      },
    },
    dictation: {
      available: () => Boolean(/** @type {any} */ (globalThis).SpeechRecognition || /** @type {any} */ (globalThis).webkitSpeechRecognition),
      // No local(): on-device recognition (Web Speech's processLocally) is asked for with SpeechRecognition.available(), and in
      // Chrome 153 that call crashed the page (seen in Playwright's Chromium). Until it is safe, dictation is the browser's service.
      open({ lang, onSegment, onSpeech, onQuiet, onError }) {
        const Recognition = /** @type {any} */ (globalThis).SpeechRecognition ?? /** @type {any} */ (globalThis).webkitSpeechRecognition;
        const r = new Recognition();
        r.continuous = true;
        r.interimResults = true;
        r.lang = lang || navigator.language;
        let closed = false;
        // Speech started and no words came for it yet: a noise ends as quiet, so the silence limit starts again.
        let speaking = false;
        const quiet = () => {
          if (!speaking) return;
          speaking = false;
          onQuiet?.();
        };
        r.onspeechstart = () => {
          speaking = true;
          onSpeech?.();
        };
        r.onresult = (/** @type {any} */ e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (!res.isFinal) continue;
            const text = String(res[0]?.transcript ?? '').trim();
            if (!text) quiet();
            else {
              speaking = false;
              onSegment(text);
            }
          }
        };
        r.onerror = (/** @type {any} */ e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          closed = true;
          onError(Object.assign(new Error(`Phone dictation stopped (${e.error}).`), { code: String(e.error) }));
        };
        // Dictation ends by itself after a silence; while listening goes on, it starts again.
        r.onend = () => {
          if (closed) return;
          quiet(); // it ended without words (no-speech)
          try {
            r.start();
          } catch {
            // started too soon: the next end tries again
          }
        };
        r.start();
        return {
          close() {
            closed = true;
            try {
              r.abort();
            } catch {
              // already stopped
            }
          },
        };
      },
    },
    async devices() {
      // Names come only once the microphone was allowed (spec §10.5: without them Auto can't tell).
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      return (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }));
    },
    onDeviceChange(fn) {
      navigator.mediaDevices?.addEventListener?.('devicechange', fn);
    },
    session(type) {
      // Where the browser has one (Safari): playback while speaking and after, play-and-record while listening (spec §10.1).
      try {
        const s = /** @type {any} */ (navigator).audioSession;
        if (s && s.type !== type) s.type = type;
      } catch {
        // not here
      }
    },
  };
}
