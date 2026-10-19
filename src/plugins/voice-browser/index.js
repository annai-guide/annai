import { encodeWav } from '../../core/voice/pcm.js';
import { oggOpus, webmOpus, adts, flacFile, cat } from '../../core/voice/mux.js';

/**
 * The device side of voice (spec §10), a built-in plugin (§19): one audio player for every voice
 * clip, unlocked by the first tap of each session (an iPhone rule, §10.1); the browser's own
 * voice; the microphone, through an AudioWorklet (§10.2); the phone's dictation; the audio devices,
 * for voice Auto (§10.5); the audio session type where the browser has one (Safari); and the encoders that make speech small
 * (Koe and Kokoro design, "Audio formats"). The core reaches it as 'voice-platform'.
 * @typedef {import('../../core/voice/platform.js').VoicePlatform} VoicePlatform
 */

/** What AudioEncoder is asked for, at 16 kHz mono, and the files each codec makes. */
const CODECS = /** @type {[string, number, string[]][]} */ ([['opus', 24_000, ['ogg', 'webm']], ['mp4a.40.2', 32_000, ['aac']], ['mp3', 32_000, ['mp3']], ['flac', 0, ['flac']]]);
/** What MediaRecorder may record, where the encoder can't make what a receiver takes (decision 24). */
const RECORDS = [['audio/ogg;codecs=opus', 'ogg'], ['audio/webm;codecs=opus', 'webm'], ['audio/mp4;codecs=mp4a.40.2', 'mp4']];
/** What the player is asked it plays. */
const PLAYS = [['ogg', 'audio/ogg; codecs=opus'], ['webm', 'audio/webm; codecs=opus'], ['mp4', 'audio/mp4; codecs=mp4a.40.2'], ['aac', 'audio/aac'],
  ['mp3', 'audio/mpeg'], ['flac', 'audio/flac'], ['wav', 'audio/wav']];

/**
 * One codec's packets for a stretch of 16-bit PCM, and the encoder's description (OpusHead, AAC's
 * config, FLAC's STREAMINFO). @param {Int16Array} pcm @param {number} rate @param {string} codec
 * @returns {Promise<{ packets: Uint8Array[], description: Uint8Array | null }>}
 */
async function encodeWith(pcm, rate, codec) {
  const E = /** @type {any} */ (globalThis).AudioEncoder;
  /** @type {Uint8Array[]} */
  const packets = [];
  /** @type {Uint8Array | null} */
  let description = null;
  /** @type {unknown} */
  let failed = null;
  const enc = new E({
    output: (/** @type {any} */ chunk, /** @type {any} */ meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push(b);
      const d = meta?.decoderConfig?.description;
      if (d) description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
    },
    error: (/** @type {unknown} */ e) => { failed = e; },
  });
  try {
    const bitrate = CODECS.find((c) => c[0] === codec)?.[1];
    enc.configure({ codec, sampleRate: rate, numberOfChannels: 1, ...(bitrate ? { bitrate } : {}) });
    const data = new (/** @type {any} */ (globalThis).AudioData)({ format: 's16', sampleRate: rate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: 0, data: pcm });
    enc.encode(data);
    data.close();
    await enc.flush();
  } finally {
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

/** @returns {VoicePlatform} */
export function browserPlatform() {
  /** @type {AudioContext | null} */
  let ctx = null;
  const context = () => (ctx ??= new AudioContext());
  /** @type {HTMLAudioElement | null} */
  let element = null;
  const player = () => (element ??= new Audio());
  /** @type {Promise<void> | null} */
  let worklet = null;
  /** @type {Promise<string[]> | null} */
  let makes = null;
  /** A segment's packets by codec, so its Ogg and its WebM share one encoding. @type {WeakMap<ArrayBufferLike, Map<string, ReturnType<typeof encodeWith>>>} */
  const packets = new WeakMap();
  /** @param {Int16Array} pcm @param {number} rate @param {string} codec */
  const packetsOf = (pcm, rate, codec) => {
    let m = packets.get(pcm.buffer);
    if (!m) packets.set(pcm.buffer, (m = new Map()));
    const key = `${codec} ${rate} ${pcm.byteOffset} ${pcm.length}`;
    let p = m.get(key);
    if (!p) m.set(key, (p = encodeWith(pcm, rate, codec)));
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
        try {
          const quiet = new SpeechSynthesisUtterance(' ');
          quiet.volume = 0;
          speechSynthesis.speak(quiet);
        } catch {
          // no browser voice here
        }
        return played;
      },
      plays: () => PLAYS.filter(([, t]) => player().canPlayType(t) !== '').map(([f]) => f),
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
      // What really encodes here, tried once on a tenth of a second: a codec the browser says it has may still fail.
      makes: () => (makes ??= (async () => {
        /** @type {string[]} */
        const out = [];
        if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return out;
        for (const [codec, , formats] of CODECS) {
          try {
            const { description } = await encodeWith(new Int16Array(1600), 16_000, codec);
            if (codec !== 'flac' || description) out.push(...formats);
          } catch {
            // not on this device
          }
        }
        return out;
      })()),
      records: () => (typeof MediaRecorder === 'undefined' ? [] : RECORDS.filter(([t]) => MediaRecorder.isTypeSupported(t)).map(([type, format]) => ({ type, format }))),
      async encode(pcm, rate, format) {
        const codec = CODECS.find((c) => c[2].includes(format))?.[0];
        if (!codec) throw new Error(`annai can't make ${format} here.`);
        const { packets: p, description: d } = await packetsOf(pcm, rate, codec);
        if (codec === 'opus') {
          const head = d && String.fromCharCode(...d.subarray(0, 8)) === 'OpusHead' ? d : null;
          const o = { rate, channels: 1, samples: pcm.length, preSkip: head ? head[10] | (head[11] << 8) : 312 }; // 312: libopus's usual look-ahead
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
      async open({ onFrames, onError, record }) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        try {
          const c = context();
          if (c.state !== 'running') await c.resume().catch(() => {});
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
          // A MediaRecorder alongside, where the encoder can't make what a receiver takes (decision 24), in files cut by take().
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
          /** @returns {Promise<Uint8Array | null>} */
          const end = () => new Promise((resolve) => {
            const r = rec;
            const mine = parts;
            rec = null;
            if (!r || r.state === 'inactive') return resolve(null);
            r.onstop = () => new Blob(mine).arrayBuffer().then((b) => resolve(b.byteLength ? new Uint8Array(b) : null), () => resolve(null));
            r.onerror = () => resolve(null);
            r.stop();
          });
          begin();
          return {
            ...(record ? {
              take() {
                const file = end();
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
      return (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label }));
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
