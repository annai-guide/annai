/**
 * A fake device and fake voices for the voice tests (the core never touches the DOM, spec §3).
 * Clips are their text as bytes; playing one takes playMs, and a stop is heard halfway through.
 */
import { Bench } from '../../src/core/llm/fallback.js';
import { ProviderError } from '../../src/core/llm/contract.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * @param {{ playMs?: number, blocked?: boolean, dictation?: boolean, micFails?: string, devices?: { kind: string, label: string, deviceId?: string }[],
 *   encoder?: { makes: string[], records?: { type: string, format: string }[], fails?: string[] }, plays?: string[] }} [o]
 *   encoder: an encoder that makes these formats (a file is its format and length in samples, as text), records these with MediaRecorder,
 *   and fails these; plays: what the player plays
 */
export function fakePlatform({ playMs = 20, blocked = false, dictation = false, micFails = '', devices = [], encoder, plays } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const sessions = [];
  /** @type {((pcm: Float32Array, rate: number) => void) | null} */
  let frames = null;
  /** @type {any} */
  let heard = null;
  /** The input in use when the microphone opened. @type {{ label: string, deviceId: string } | null} */
  let openedWith = null;
  let opens = 0;
  let files = 0;
  const platform = {
    /** How much faster than real time a live stream plays here; stalls: it never plays (a context suspended); running: what its running says. */
    streamSpeed: 20,
    streamStalls: false,
    /** @type {boolean | undefined} */
    streamRunning: undefined,
    /**
     * The phone's speaker heard by its own microphone: a live stream's sound, this many dB re as played, comes back into an open
     * microphone as it plays (at 16 kHz); null: none, as with headphones. @type {number | null}
     */
    echoDb: /** @type {number | null} */ (null),
    /** The browser voices, as the browser lists them. @type {{ id: string, name: string, lang: string, local?: boolean, default?: boolean }[]} */
    voiceList: [{ id: 'v-en', name: 'Samantha', lang: 'en-US', local: true }],
    /** What the browser voice was asked to say, and in what language. @type {{ text: string, lang?: string, voice?: string }[]} */
    said: [],
    /** Whether dictation recognizes speech on the phone. */
    dictationLocal: false,
    /** The languages dictation was asked about being on the phone. @type {(string | undefined)[]} */
    dictationAsked: [],
    /** What each dictation was opened with. @type {any[]} */
    dictationOpened: [],
    log,
    sessions,
    get opens() { return opens; },
    session(/** @type {string} */ t) { sessions.push(t); },
    /** @type {{ kind: string, label: string, deviceId?: string }[]} */
    deviceList: devices,
    /** The input an open microphone takes (its track's label and deviceId); null: the newest audio input present, as a phone picks it. @type {{ label: string, deviceId: string } | null} */
    input: /** @type {{ label: string, deviceId: string } | null} */ (null),
    /** inUse gives the input as it was when the microphone opened, as a plugin that reads its track once would. */
    snapshot: false,
    /** @type {(() => void)[]} */
    deviceChanges: [],
    async devices() { return platform.deviceList; },
    /** @param {() => void} fn */
    onDeviceChange(fn) { platform.deviceChanges.push(fn); },
    /** Plugs in or unplugs audio devices. @param {{ kind: string, label: string, deviceId?: string }[]} list */
    setDevices(list) {
      platform.deviceList = list;
      for (const fn of platform.deviceChanges) fn();
    },
    ...(encoder ? {
      encoder: {
        makes: async () => encoder.makes,
        records: () => encoder.records ?? [],
        /** @param {Int16Array} pcm @param {number} rate @param {string} format */
        async encode(pcm, rate, format) {
          log.push(`encode ${format}`);
          if (encoder.fails?.includes(format)) throw new Error(`no ${format} today`);
          return enc.encode(`${format}<${pcm.length}@${rate}>`);
        },
        /** A clip this encoder made, read back: its length in samples. @param {Uint8Array} data */
        async decode(data) {
          log.push('decode');
          return { pcm: new Float32Array(Number(/<(\d+)@/.exec(dec.decode(data))?.[1] ?? 0) * 3), rate: 48_000 };
        },
      },
    } : {}),
    /** Each live stream: what was pushed (ms of sound), and how it ended. @type {{ rate: number, ms: number, ended: boolean, stopped: boolean, playedMs: number | null }[]} */
    streams: [],
    player: {
      async unlock() { log.push('unlock'); return true; },
      output: () => ({ sampleRate: 48_000, baseLatency: 0.01 }),
      ...(plays ? { plays: () => plays } : {}),
      /** A live session's voice: it "plays" streamSpeed times faster than real time, from its first piece. @param {{ rate: number }} o */
      stream({ rate }) {
        const s = { rate, ms: 0, ended: false, stopped: false, playedMs: /** @type {number | null} */ (null) };
        platform.streams.push(s);
        log.push('stream');
        let started = 0;
        /** @type {(r: { playedMs: number }) => void} */
        let settle = () => {};
        const done = new Promise((r) => { settle = r; });
        const played = () => (started ? Math.min(s.ms, (Date.now() - started) * platform.streamSpeed) : 0);
        /** The player's own numbers, as the worklet's are: no holes, a start at once. @type {any} */
        let result = null;
        const finish = () => {
          if (result) return result;
          clearInterval(timer);
          s.playedMs = Math.round(played());
          result = { playedMs: s.playedMs, holes: 0, holeMs: 0, waitMs: 0, player: 'fake' };
          settle(result);
          return result;
        };
        const timer = setInterval(() => { if (s.ended && played() >= s.ms) finish(); }, 2);
        return {
          push(/** @type {Int16Array} */ pcm) {
            if (s.playedMs !== null) return;
            if (!platform.streamStalls) started ||= Date.now();
            const at = s.ms;
            s.ms += (pcm.length / rate) * 1000;
            // Heard when it plays (never before the player has it), as loud as echoDb is then.
            setTimeout(() => {
              if (s.playedMs !== null || platform.echoDb === null) return;
              const gain = 10 ** (platform.echoDb / 20) / 0x8000;
              platform.mic.feed(Float32Array.from({ length: Math.floor((pcm.length * 16_000) / rate) }, (_, i) => pcm[Math.floor((i * rate) / 16_000)] * gain), 16_000);
            }, Math.max(0, started + at / platform.streamSpeed - Date.now()));
          },
          end() { s.ended = true; log.push('stream end'); },
          stop() { s.stopped = true; log.push('stream stop'); return finish(); },
          queued: () => (s.playedMs === null && played() < s.ms ? 1 : 0), // what is still to play
          done,
          ...(platform.streamRunning === undefined ? {} : { running: Promise.resolve(platform.streamRunning) }),
        };
      },
      /** @param {{ data: Uint8Array }} clip @param {{ signal: AbortSignal, onLevel?: (x: number) => void }} o */
      play(clip, { signal, onLevel }) {
        const name = dec.decode(clip.data);
        log.push(`play ${name}`);
        if (blocked) return Promise.reject(Object.assign(new Error('The page may not play sound yet.'), { name: 'NotAllowedError' }));
        onLevel?.(0.5);
        return new Promise((resolve) => {
          const stop = () => { clearTimeout(t); log.push(`stop ${name}`); resolve({ ended: false, fraction: 0.5 }); };
          const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve({ ended: true, fraction: 1 }); }, playMs);
          signal.addEventListener('abort', stop, { once: true });
        });
      },
    },
    synth: {
      available: () => true,
      voices: () => platform.voiceList,
      /** @param {string} text @param {{ signal: AbortSignal, lang?: string, voice?: string }} o */
      say(text, { signal, lang, voice }) {
        log.push(`browser ${text}`);
        platform.said.push({ text, lang, voice });
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ended: true, charIndex: text.length }), playMs);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve({ ended: false, charIndex: text.indexOf(' ') + 1 }); }, { once: true });
        });
      },
    },
    mic: {
      /** The input in use while open. */
      inUse() {
        if (!frames) return null;
        if (platform.snapshot && openedWith) return openedWith;
        const last = platform.deviceList.filter((d) => d.kind === 'audioinput').at(-1);
        return platform.input ?? (last ? { label: last.label, deviceId: last.deviceId ?? '' } : null);
      },
      /** @param {{ onFrames: (pcm: Float32Array, rate: number) => void, onError: (e: Error) => void, record?: string }} o */
      async open({ onFrames, record }) {
        if (micFails) throw Object.assign(new Error('Permission denied'), { name: micFails });
        opens++;
        log.push(record ? `mic open, recording ${record}` : 'mic open');
        frames = onFrames;
        openedWith = null;
        openedWith = platform.mic.inUse();
        return {
          close() { log.push('mic close'); frames = null; },
          ...(record ? {
            take: async () => { log.push('mic take'); return enc.encode(`${record} file ${++files}`); },
            again: () => { log.push('mic again'); },
          } : {}),
        };
      },
      /** What the microphone hears now, in chunks. @param {Float32Array} pcm @param {number} rate */
      feed(pcm, rate) {
        for (let i = 0; i < pcm.length && frames; i += 2048) frames(pcm.subarray(i, i + 2048), rate);
      },
    },
    dictation: {
      available: () => dictation,
      local: async (/** @type {string} */ lang) => {
        platform.dictationAsked.push(lang);
        return platform.dictationLocal;
      },
      /** @param {{ onSegment: (text: string) => void, onSpeech?: () => void, onQuiet?: () => void, onError: (e: Error) => void }} o */
      open(o) {
        log.push('dictation open');
        platform.dictationOpened.push(o);
        heard = o;
        return { close() { log.push('dictation close'); heard = null; } };
      },
      /** Dictation hears someone say this. @param {string} text */
      say(text) { heard?.onSpeech?.(); heard?.onSegment(text); },
      /** Dictation hears a sound that gives no words (road noise): speech starts, then it says so. */
      noise() { heard?.onSpeech?.(); heard?.onQuiet?.(); },
      /** Dictation fails, as the browser's recognition does. @param {string} code */
      fail(code) { heard?.onError(Object.assign(new Error(`Phone dictation stopped (${code}).`), { code })); },
    },
  };
  return platform;
}

/**
 * API voices by id. A voice in failing fails every clip (or, given a word, only clips with that word).
 * @param {string[]} ids @param {{ failing?: Record<string, string | true>, fetchMs?: number, browser?: boolean }} [o]
 */
export function fakeVoices(ids, { failing = {}, fetchMs = 2, browser = false } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const benched = [];
  const all = [...ids.map((id) => ({ id, name: id, kind: /** @type {const} */ ('api') })), ...(browser ? [{ id: 'browser-voice', name: 'Browser voice', kind: /** @type {const} */ ('browser') }] : [])];
  return {
    log,
    benched,
    entries: async () => all.filter((e) => !benched.includes(e.id)),
    /** @param {string} id */
    bench: (id) => { benched.push(id); },
    /** @param {{ id: string }} entry @param {string} text @param {AbortSignal} signal */
    synthesize(entry, text, signal) {
      log.push(`fetch ${entry.id} ${text}`);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          const f = failing[entry.id];
          if (f === true || (typeof f === 'string' && text.includes(f))) reject(Object.assign(new Error(`${entry.id} failed`), { kind: 'server' }));
          else resolve({ data: enc.encode(`${entry.id}:${text}`), mediaType: 'audio/mpeg' });
        }, fetchMs);
        signal.addEventListener('abort', () => { clearTimeout(t); log.push(`aborted ${entry.id} ${text}`); reject(new DOMException('Stopped.', 'AbortError')); }, { once: true });
      });
    },
  };
}

/**
 * A fake llm service for the Voice: chat models in the main role (with their inputs), a voice (v1),
 * transcription models, and the two speech lists. calls records what was asked.
 * @param {{ main?: { id: string, input: string[] }[], asr?: string[], speechIn?: string[], speechOut?: string[], hears?: string[], failing?: string[], reply?: string,
 *   audioIn?: Record<string, string[]>, refuses?: Record<string, string>, flaky?: Record<string, number> }} [o]
 *   hears: what transcription answers, in turn (the last repeats); failing: transcription models that fail; reply: what a chat call answers;
 *   audioIn: the formats a model takes; refuses: a transcription model that refuses this media type ('*': every file); flaky: one whose upload fails this many times first
 * The transcription models' type takes webm, mp4, mp3 and wav unless a model says otherwise, as OpenAI's does.
 */
export function fakeLlm({ main = [{ id: 'm1', input: ['text'] }], asr = ['t1'], speechIn = ['send-audio', 't1', 'dictation'], speechOut = ['v1', 'browser-voice'], hears = ['what was said'], failing = [], reply = 'the words', audioIn = {}, refuses = {}, flaky = {} } = {}) {
  const bench = new Bench();
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const cfg = {
    providers: {
      pc: { id: 'pc', plugin: 'p', template: null, user: { abilities: { chat: { kind: 'chat', type: 'chat' } } }, created: 0 },
      po: { id: 'po', plugin: 'p', template: null, user: { abilities: { voice: { kind: 'voice', type: 'say' } } }, created: 0 },
      pi: { id: 'pi', plugin: 'p', template: null, user: { abilities: { transcription: { kind: 'transcription', type: 'hear' } } }, created: 0 },
    },
    models: { v1: { id: 'v1', provider: 'po', ability: 'voice', template: null, user: { providerId: 'tts' }, created: 0 } },
    roles: { main: { models: main.map((m) => m.id), level: 'off' }, 'speech-in': { models: speechIn, level: 'off' }, 'speech-out': { models: speechOut, level: 'off' } },
  };
  for (const m of main) cfg.models[m.id] = { id: m.id, provider: 'pc', ability: 'chat', template: null, user: { providerId: m.id, input: m.input }, created: 0 };
  for (const id of asr) cfg.models[id] = { id, provider: 'pi', ability: 'transcription', template: null, user: { providerId: id }, created: 0 };
  for (const [id, formats] of Object.entries(audioIn)) cfg.models[id].user.tunables = { audioIn: formats };
  let heard = 0;
  /** What each transcription upload carried. @type {{ modelId: string, mediaType: string, data: Uint8Array, signal?: AbortSignal, languages?: any }[]} */
  const uploads = [];
  /** The system text of each call a model answered. @type {string[]} */
  const systems = [];
  return {
    bench,
    calls,
    uploads,
    systems,
    types: () => new Map([['chat', {}], ['say', { speech: 'out' }], ['hear', { speech: 'in', tunables: { audioIn: ['webm', 'mp4', 'mp3', 'wav'] } }]]),
    config: async () => cfg,
    /** @param {{ modelId: string, text: string }} c */
    async synthesize({ modelId, text }) {
      calls.push(`say ${modelId} ${text}`);
      return { clip: { data: enc.encode(`${modelId}:${text}`), mediaType: 'audio/mpeg' } };
    },
    /** @param {{ modelId: string, audio: any, scope?: string, wake?: string, signal?: AbortSignal, languages?: any }} c */
    async transcribe({ modelId, audio, scope, wake, signal, languages }) {
      calls.push(['hear', modelId, audio.mediaType, scope, wake].filter(Boolean).join(' '));
      uploads.push({ modelId, mediaType: audio.mediaType, data: audio.data, signal, languages });
      if (failing.includes(modelId)) throw new ProviderError('server', `${modelId} is down`);
      // whisper.cpp's server: any refusal comes back as "Invalid request" (its error handler replaces the body); '*' refuses every file.
      if (refuses[modelId] === audio.mediaType || refuses[modelId] === '*') throw new ProviderError('bad-request', 'Invalid request');
      if (flaky[modelId]) {
        flaky[modelId]--;
        throw new ProviderError('network', "annai couldn't reach the provider.");
      }
      return { text: hears[Math.min(heard++, hears.length - 1)] };
    },
    /** The request as the model that answers gets it: heard speech resolved for it, as callRole does. @param {any} c */
    async call(c) {
      const to = main.find((m) => m.id === c.prefer) ?? main[0];
      const request = c.speech ? await c.speech({ id: to.id, name: to.id, input: to.input }, c.request) : c.request;
      systems.push(request.system);
      calls.push(`call ${c.role} ${c.prefer ?? ''} ${c.record?.tag ?? ''} ${request.messages[0].parts.map((/** @type {any} */ p) => p.type).join(',')}`);
      return { reply: { text: reply, parts: [{ type: 'text', text: reply }] }, modelId: c.prefer ?? main[0].id };
    },
  };
}
