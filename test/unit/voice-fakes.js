/**
 * A fake device and fake voices for the voice tests (the core never touches the DOM, spec §3).
 * Clips are their text as bytes; playing one takes playMs, and a stop is heard halfway through.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {{ playMs?: number, blocked?: boolean }} [o] */
export function fakePlatform({ playMs = 20, blocked = false } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const sessions = [];
  /** @type {((pcm: Float32Array, rate: number) => void) | null} */
  let frames = null;
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
    dictation: { available: () => false, open() { return { close() {} }; } },
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
