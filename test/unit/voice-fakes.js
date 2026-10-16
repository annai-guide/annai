/**
 * A fake device and fake voices for the voice tests (the core never touches the DOM, spec §3).
 * Clips are their text as bytes; playing one takes playMs, and a stop is heard halfway through.
 */
import { Bench } from '../../src/core/llm/fallback.js';
import { ProviderError } from '../../src/core/llm/contract.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {{ playMs?: number, blocked?: boolean, dictation?: boolean }} [o] */
export function fakePlatform({ playMs = 20, blocked = false, dictation = false } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const sessions = [];
  /** @type {((pcm: Float32Array, rate: number) => void) | null} */
  let frames = null;
  /** @type {any} */
  let heard = null;
  let opens = 0;
  const platform = {
    log,
    sessions,
    get opens() { return opens; },
    session(/** @type {string} */ t) { sessions.push(t); },
    player: {
      async unlock() { log.push('unlock'); },
      /** @param {{ data: Uint8Array }} clip @param {{ signal: AbortSignal, onLevel?: (x: number) => void }} o */
      play(clip, { signal, onLevel }) {
        const name = dec.decode(clip.data);
        log.push(`play ${name}`);
        if (blocked) return Promise.reject(Object.assign(new Error('The page may not play sound yet.'), { name: 'NotAllowedError' }));
        onLevel?.(0.5);
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ended: true, fraction: 1 }), playMs);
          signal.addEventListener('abort', () => { clearTimeout(t); log.push(`stop ${name}`); resolve({ ended: false, fraction: 0.5 }); }, { once: true });
        });
      },
    },
    synth: {
      available: () => true,
      voices: () => [{ id: 'v-en', name: 'Samantha', lang: 'en-US' }],
      /** @param {string} text @param {{ signal: AbortSignal }} o */
      say(text, { signal }) {
        log.push(`browser ${text}`);
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ended: true, charIndex: text.length }), playMs);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve({ ended: false, charIndex: text.indexOf(' ') + 1 }); }, { once: true });
        });
      },
    },
    mic: {
      /** @param {{ onFrames: (pcm: Float32Array, rate: number) => void, onError: (e: Error) => void }} o */
      async open({ onFrames }) {
        opens++;
        log.push('mic open');
        frames = onFrames;
        return { close() { log.push('mic close'); frames = null; } };
      },
      /** What the microphone hears now, in chunks. @param {Float32Array} pcm @param {number} rate */
      feed(pcm, rate) {
        for (let i = 0; i < pcm.length && frames; i += 2048) frames(pcm.subarray(i, i + 2048), rate);
      },
    },
    dictation: {
      available: () => dictation,
      /** @param {{ onSegment: (text: string) => void, onSpeech?: () => void, onError: (e: Error) => void }} o */
      open(o) {
        log.push('dictation open');
        heard = o;
        return { close() { log.push('dictation close'); heard = null; } };
      },
      /** Dictation hears someone say this. @param {string} text */
      say(text) { heard?.onSpeech?.(); heard?.onSegment(text); },
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
 * @param {{ main?: { id: string, input: string[] }[], asr?: string[], speechIn?: string[], speechOut?: string[], hears?: string[], failing?: string[], reply?: string }} [o]
 *   hears: what transcription answers, in turn (the last repeats); failing: transcription models that fail; reply: what a chat call answers
 */
export function fakeLlm({ main = [{ id: 'm1', input: ['text'] }], asr = ['t1'], speechIn = ['send-audio', 't1', 'dictation'], speechOut = ['v1', 'browser-voice'], hears = ['what was said'], failing = [], reply = 'the words' } = {}) {
  const bench = new Bench();
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const cfg = {
    endpoints: { ec: { id: 'ec', type: 'chat' }, eo: { id: 'eo', type: 'say' }, ei: { id: 'ei', type: 'hear' } },
    models: { v1: { id: 'v1', endpoint: 'eo', template: null, user: { providerId: 'tts' }, created: 0 } },
    roles: { main: { models: main.map((m) => m.id), level: 'off' }, 'speech-in': { models: speechIn, level: 'off' }, 'speech-out': { models: speechOut, level: 'off' } },
  };
  for (const m of main) cfg.models[m.id] = { id: m.id, endpoint: 'ec', template: null, user: { providerId: m.id, input: m.input }, created: 0 };
  for (const id of asr) cfg.models[id] = { id, endpoint: 'ei', template: null, user: { providerId: id }, created: 0 };
  let heard = 0;
  return {
    bench,
    calls,
    types: () => new Map([['chat', {}], ['say', { speech: 'out' }], ['hear', { speech: 'in' }]]),
    config: async () => cfg,
    /** @param {{ modelId: string, text: string }} c */
    async synthesize({ modelId, text }) {
      calls.push(`say ${modelId} ${text}`);
      return { clip: { data: enc.encode(`${modelId}:${text}`), mediaType: 'audio/mpeg' } };
    },
    /** @param {{ modelId: string, audio: any, scope?: string, wake?: string }} c */
    async transcribe({ modelId, audio, scope, wake }) {
      calls.push(['hear', modelId, audio.mediaType, scope, wake].filter(Boolean).join(' '));
      if (failing.includes(modelId)) throw new ProviderError('server', `${modelId} is down`);
      return { text: hears[Math.min(heard++, hears.length - 1)] };
    },
    /** @param {any} c */
    async call(c) {
      calls.push(`call ${c.role} ${c.prefer ?? ''} ${c.record?.tag ?? ''} ${c.request.messages[0].parts.map((/** @type {any} */ p) => p.type).join(',')}`);
      return { reply: { text: reply, parts: [{ type: 'text', text: reply }] }, modelId: c.prefer ?? main[0].id };
    },
  };
}
