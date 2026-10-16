import { readAppSettings } from '../settings.js';
import { SYS } from '../scopes.js';
import { ProviderError } from '../llm/contract.js';
import { COOLDOWN_MS } from '../llm/fallback.js';
import { speechKind } from '../llm/config.js';
import { Speaker, speechOutEntries } from './speaker.js';
import { voicePlatform } from './platform.js';
import { voiceSettings } from './settings.js';
import { record } from './recorder.js';

/**
 * Voice (spec §10): annai's speaking and hearing, for the screens, and in milestone 3b for
 * Shiori. Speech goes through the speech-out list; hearing through the microphone and the
 * end-of-sentence detector. The device side is the voice-browser plugin's.
 * @typedef {import('./speaker.js').Spoken} Spoken
 * @typedef {import('./recorder.js').Segment} Segment
 * @typedef {(level: number, who: 'her' | 'you') => void} LevelListener
 */

/** How long a failed voice rests: what the provider asked for, else the usual cooldown (spec §9.6). @param {unknown} e */
export function restFor(e) {
  return e instanceof ProviderError && e.retryAfter !== undefined ? e.retryAfter : COOLDOWN_MS;
}

export class Voice {
  /** The conversation speech requests are traced in. */
  scope = SYS;
  /** @type {Set<LevelListener>} */
  #levels = new Set();

  /** @param {{ llm: any, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry, now?: () => number, locale?: string }} c */
  constructor({ llm, ws, registry, now = Date.now, locale }) {
    this.llm = llm;
    this.ws = ws;
    this.registry = registry;
    this.now = now;
    this.locale = locale;
    this.speaker = new Speaker({
      locale,
      entries: () => this.outEntries(),
      synthesize: async (entry, text, signal) => (await this.llm.synthesize({ modelId: entry.id, text, signal, scope: this.scope })).clip,
      platform: () => this.platform,
      bench: (id, error) => this.llm.bench.bench(id, restFor(error), this.now()),
      browserOptions: async () => {
        const s = voiceSettings(await readAppSettings(this.ws));
        return { voice: s.browserVoice || undefined, rate: s.rate, lang: this.locale };
      },
      onLevel: (x) => this.#level(x, 'her'),
    });
  }

  get platform() {
    return voicePlatform(this.registry);
  }

  /** The glow follows the sound (spec §16.3): her voice, or yours. @param {LevelListener} fn @returns {() => void} */
  onLevel(fn) {
    this.#levels.add(fn);
    return () => this.#levels.delete(fn);
  }

  /** @param {number} x @param {'her' | 'you'} who */
  #level(x, who) {
    for (const fn of this.#levels) {
      try {
        fn(x, who);
      } catch (e) {
        console.warn('a level listener failed', e);
      }
    }
  }

  /** The speech-out entries that can speak now. */
  async outEntries() {
    const cfg = await this.llm.config();
    return speechOutEntries(cfg, { types: this.llm.types(), until: (id) => this.llm.bench.until(id), now: this.now(), browser: Boolean(this.platform?.synth.available()) });
  }

  /** The speech-in list's transcription models, in order. @returns {Promise<string[]>} */
  async transcribers() {
    const cfg = await this.llm.config();
    return (cfg.roles['speech-in']?.models ?? []).filter((/** @type {string} */ id) => speechKind(cfg, this.llm.types(), id) === 'in');
  }

  /** Says a text, start to end, through the speech-out list (Settings → Voice). @param {string} text @returns {Promise<Spoken>} */
  say(text) {
    const u = this.speaker.begin();
    u.end(text);
    return u.done;
  }

  /** One voice's clip of a text, played: that voice's Test. @param {string} modelId @param {string} text */
  async sample(modelId, text) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't play sound here.");
    platform.session('transient');
    const { clip } = await this.llm.synthesize({ modelId, text, scope: this.scope });
    return platform.player.play(clip, { signal: new AbortController().signal, onLevel: (x) => this.#level(x, 'her') });
  }

  /**
   * Listens until one segment is heard, or for seconds; null when nothing was (Settings → Voice,
   * and a transcription model's Test). The mic is open only meanwhile (spec §10.2).
   * @param {{ seconds?: number, onSpeech?: () => void, signal?: AbortSignal }} [o] @returns {Promise<Segment | null>}
   */
  async listenOnce({ seconds = 15, onSpeech, signal } = {}) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't use the microphone here.");
    const { pauseMs } = voiceSettings(await readAppSettings(this.ws));
    return new Promise((resolve, reject) => {
      /** @type {{ close(): void } | null} */
      let session = null;
      let done = false;
      /** @param {Segment | null} seg @param {unknown} [err] */
      const finish = (seg, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        session?.close();
        platform.session('playback'); // afterwards: full-quality Bluetooth audio again (spec §10.1)
        if (err) reject(err);
        else resolve(seg);
      };
      const timer = setTimeout(() => finish(null), seconds * 1000);
      signal?.addEventListener('abort', () => finish(null), { once: true });
      platform.session('play-and-record');
      record({ mic: platform.mic, pauseMs, now: this.now, onSpeech, onLevel: (x) => this.#level(x, 'you'), onSegment: (s) => finish(s), onError: (e) => finish(null, e) })
        .then((s) => {
          session = s;
          if (done) s.close();
        }, (e) => finish(null, e));
    });
  }

  /** What a transcription model hears in a segment. @param {Segment} segment @param {string} modelId */
  async transcribe(segment, modelId) {
    return (await this.llm.transcribe({ modelId, audio: segment.audio, scope: this.scope })).text;
  }
}
