import { readAppSettings, updateAppSettings } from '../settings.js';
import { voiceMode, routeOf } from './mode.js';
import { SYS } from '../scopes.js';
import { ProviderError } from '../llm/contract.js';
import { COOLDOWN_MS } from '../llm/fallback.js';
import { speechKind, modelOf, STAND_INS } from '../llm/config.js';
import { Speaker, speechOutEntries } from './speaker.js';
import { voicePlatform } from './platform.js';
import { voiceSettings } from './settings.js';
import { record } from './recorder.js';
import { HeardMemory, listenKind, resolveSpeech, textVersion } from './resolve.js';
import { listen } from './listening.js';
import { micProblem } from './mic.js';
import { browserVoiceFor } from './where.js';
import { blobBytes, record as logEvent } from '../agent/log.js';
import { toBase64 } from '../bytes.js';

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

/** What the model that heard a segment as audio is asked, to write it down (spec §10.3). */
export const WRITE_DOWN = 'Write down exactly what is said in this audio, in the language it is spoken. Reply with the words only, nothing else. If nothing clear is said, reply with nothing.';

export class Voice {
  /** The conversation speech requests are traced in. */
  scope = SYS;
  /** Heard segments, until the turn that used them succeeds (spec §10.3). */
  memory = new HeardMemory();
  /** Phone dictation failed in this session: listening records instead (spec §10.3). */
  dictationFailed = false;
  /** The voice mode now (spec §10.5); refresh() works it out again. @type {import('./mode.js').VoiceMode} */
  mode = { setting: 'auto', on: false, why: 'not sure' };
  /** @type {Set<(m: import('./mode.js').VoiceMode) => void>} */
  #changes = new Set();
  #watching = false;
  /** @type {Set<LevelListener>} */
  #levels = new Set();
  /** Sound may play: a tap unlocked it (spec §10.1). */
  #unlocked = false;

  /**
   * @param {{ llm: any, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry, store?: import('../types.js').Store,
   *   now?: () => number, locale?: string, where?: 'ios' | 'android' | 'desktop' }} c  store: for kept voice clips; where: which phone, for the steps of a microphone problem
   */
  constructor({ llm, ws, registry, store, now = Date.now, locale, where = 'desktop' }) {
    this.llm = llm;
    this.store = store ?? null;
    this.where = where;
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
        const system = this.browserVoice(s.browserVoice);
        return { voice: system?.id, rate: s.rate, lang: this.locale, system };
      },
      onLevel: (x) => this.#level(x, 'her'),
      onVoice: (entry, system) => {
        if (entry.kind !== 'browser' || system?.local) return;
        // The browser sends her words to the voice's service itself: the trace says so (spec §11.7), without the words.
        const named = system ? `The browser voice ${system.name} spoke` : "The browser voice spoke, with the browser's choice of voice";
        this.#trace(this.scope, { kind: 'voice', voice: system?.name ?? null, local: false, message: `${named}: the browser sends her words to that voice's service; annai can't see that request.` });
      },
    });
  }

  /**
   * The browser voice she speaks with (spec §10.1, §11.7): the one chosen; else one on this phone
   * for the language; else the browser's default. @param {string} [chosen] @returns {import('./platform.js').SystemVoice | null}
   */
  browserVoice(chosen = '') {
    try {
      return browserVoiceFor(this.platform?.synth.voices() ?? [], { chosen, lang: this.locale });
    } catch {
      return null;
    }
  }

  /** Whether phone dictation recognizes speech on this phone, for this language, now (spec §11.7). @returns {Promise<boolean>} */
  async dictationLocal() {
    try {
      return Boolean(await this.platform?.dictation.local?.(this.locale));
    } catch {
      return false;
    }
  }

  /** A trace line about speech the browser handles itself (spec §11.7): never audio or words. @param {string} scope @param {Record<string, any>} data */
  #trace(scope, data) {
    if (this.store) logEvent(this.store, scope, { type: 'speech.browser', actor: 'system', data }).catch(() => {});
  }

  get platform() {
    return voicePlatform(this.registry);
  }

  /**
   * Unlocks sound (an iPhone rule, spec §10.1): call it inside a tap. Once it worked it does
   * nothing, so a tap never plays the silent clip over her voice. @returns {Promise<boolean>} whether sound may play
   */
  unlock() {
    if (this.#unlocked) return Promise.resolve(true);
    /** @type {Promise<boolean> | undefined} */
    let tried;
    try {
      tried = this.platform?.player.unlock();
    } catch {
      tried = undefined;
    }
    if (!tried) return Promise.resolve(false);
    return tried.then((ok) => {
      if (ok) this.#unlocked = true;
      return Boolean(ok);
    }, () => false);
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
    platform.session('playback');
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

  /** Settings → Voice. */
  async settings() {
    return voiceSettings(await readAppSettings(this.ws));
  }

  /** Whether voice is on now. */
  get on() {
    return this.mode.on;
  }

  /**
   * Works out the voice mode (spec §10.5): the setting; for Auto, the activity sensor and the
   * audio devices' names; and, where it can't tell, the last explicit choice. Listeners hear a change.
   * @returns {Promise<boolean>} whether voice is on
   */
  async refresh() {
    const s = await this.settings();
    const route = s.mode === 'auto' ? await this.route() : 'unknown';
    const next = voiceMode({ setting: s.mode, activity: this.activity(), route, lastChoices: s.lastChoices });
    this.#watch();
    if (next.on !== this.mode.on || next.why !== this.mode.why || next.setting !== this.mode.setting) {
      this.mode = next;
      for (const fn of this.#changes) {
        try {
          fn(next);
        } catch (e) {
          console.warn('a voice listener failed', e);
        }
      }
    }
    return next.on;
  }

  /** What the activity sensor says (live mode's, spec §11.2); unknown without one. @returns {string} */
  activity() {
    try {
      return this.registry.list('activity')[0]?.now?.() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** What audio is connected, from the devices' names (spec §10.5). */
  async route() {
    try {
      return routeOf((await this.platform?.devices?.()) ?? []);
    } catch {
      return 'unknown';
    }
  }

  /**
   * An explicit choice of Auto, On or Off (spec §10.5). On or Off, where annai can't tell what audio
   * is connected, is remembered for this activity: Auto follows it there.
   * @param {'auto' | 'on' | 'off'} setting
   */
  async choose(setting) {
    this.unlock(); // a choice is a tap (spec §10.1)
    /** @type {Record<string, any>} */
    const change = { mode: setting };
    if (setting !== 'auto' && (await this.route()) === 'unknown') change.lastChoices = { [this.activity()]: setting };
    await updateAppSettings(this.ws, { voice: change });
    await this.refresh();
  }

  /** Hears when the voice mode changes. @param {(m: import('./mode.js').VoiceMode) => void} fn @returns {() => void} */
  onChange(fn) {
    this.#changes.add(fn);
    return () => this.#changes.delete(fn);
  }

  /** Devices coming and going, and the activity changing, work out the mode again. */
  #watch() {
    if (this.#watching) return;
    const platform = this.platform;
    if (!platform) return;
    this.#watching = true;
    const again = () => { this.refresh().catch(() => {}); };
    platform.onDeviceChange?.(again);
    this.registry.list('activity')[0]?.onChange?.(again);
  }

  /** How to listen now (spec §10.3), against the first main model that isn't resting: it is expected to hear. */
  async howToListen() {
    const cfg = await this.llm.config();
    const types = this.llm.types();
    const now = this.now();
    const free = (/** @type {string} */ id) => this.llm.bench.until(id) <= now;
    const mainId = (cfg.roles.main?.models ?? []).find((/** @type {string} */ id) => cfg.models[id] && free(id));
    return listenKind({
      list: cfg.roles['speech-in']?.models ?? [],
      model: mainId ? modelOf(cfg.models[mainId]) : null,
      asr: (id) => speechKind(cfg, types, id) === 'in' && free(id),
      dictation: Boolean(this.platform?.dictation.available()) && !this.dictationFailed,
    });
  }

  /**
   * Opens a listening session (spec §10.2): what it hears is kept in memory and handed on; the
   * audio session is play-and-record while it listens (§10.1).
   * Phone dictation stays on the phone where it can; the trace notes it either way (spec §11.7).
   * @param {{ kind: 'record' | 'dictation', onSegment: (h: import('./resolve.js').Heard) => void, onSpeech?: () => void, onQuiet?: () => void, onError: (e: Error) => void, scope?: string }} o
   *   scope: the conversation it listens for, for the trace
   */
  async open({ kind, onSegment, onSpeech, onQuiet, onError, scope = this.scope }) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't use the microphone here.");
    const { pauseMs } = await this.settings();
    const local = kind === 'dictation' && (await this.dictationLocal());
    platform.session('play-and-record');
    try {
      const session = await listen({
        platform, kind, pauseMs, lang: this.locale, now: this.now, onSpeech, onQuiet, onError, local,
        onLevel: (x) => this.#level(x, 'you'),
        onSegment: (h) => {
          this.memory.keep(h);
          onSegment(h);
        },
        onSwitch: () => { this.dictationFailed = true; },
      });
      if (session.kind === 'dictation') {
        this.#trace(scope, { kind: 'dictation', local, message: local ? 'Phone dictation listened, on this phone only.' : "Phone dictation listened: the browser sends the audio to its own speech service; annai can't see that request." });
      }
      return session;
    } catch (e) {
      platform.session('playback'); // the microphone didn't open: full-quality Bluetooth audio again (spec §10.1)
      throw e;
    }
  }

  /**
   * The speech hook for llm.call (spec §10.3): heard speech resolved for each model attempt.
   * Transcriptions are traced in scope, for the wake.
   * @param {string} scope @param {string} [wake]
   * @returns {(model: { name: string, input: string[] }, request: import('../llm/contract.js').Request) => Promise<import('../llm/contract.js').Request>}
   */
  resolver(scope, wake) {
    return async (model, request) => resolveSpeech(request, model, await this.#resolve(scope, wake));
  }

  /** @param {string} scope @param {string} [wake] @returns {Promise<import('./resolve.js').Resolve>} */
  async #resolve(scope, wake) {
    const cfg = await this.llm.config();
    const types = this.llm.types();
    return {
      list: cfg.roles['speech-in']?.models ?? [],
      memory: this.memory,
      asr: (id) => speechKind(cfg, types, id) === 'in' && this.llm.bench.until(id) <= this.now(),
      transcribe: async (id, kept) => String((await this.llm.transcribe({ modelId: id, audio: kept.audio, scope, wake })).text ?? ''),
      clip: (hash) => (this.store ? blobBytes(this.store, hash) : Promise.resolve(null)),
      onFail: (id, e) => this.llm.bench.bench(id, restFor(e), this.now()),
    };
  }

  /**
   * A segment's words, for the log (spec §10.3): a transcript made already, dictation's, or the
   * first entry that can write it down; for "Send audio to the model", the model that heard it
   * (hearer) is asked. null when nothing could, or the segment isn't in memory.
   * @param {string} id @param {{ scope: string, wake?: string, hearer?: string }} o
   * @returns {Promise<{ text: string, by: string } | null>} by: who wrote it down, by name
   */
  async writeDown(id, { scope, wake, hearer }) {
    const kept = this.memory.get(id);
    if (!kept) return null;
    let who = hearer ?? '';
    const r = await textVersion(kept, {
      ...(await this.#resolve(scope, wake)),
      ...(hearer ? {
        hearer: async (/** @type {import('./resolve.js').Kept} */ k) => {
          const audio = /** @type {NonNullable<typeof k.audio>} */ (k.audio);
          const out = await this.llm.call({
            role: 'main', prefer: hearer, level: 'off', scope, record: { tag: 'transcribe', ...(wake ? { wake } : {}) },
            request: { system: WRITE_DOWN, messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: audio.mediaType, data: toBase64(audio.data) }] }], maxOutput: 400 },
          });
          who = out.modelId ?? hearer;
          return String(out.reply.text ?? '').trim();
        },
      } : {}),
    });
    if (!r) return null;
    const by = r.by === 'send-audio' ? who : r.by;
    const cfg = await this.llm.config();
    return { text: r.text, by: STAND_INS[by]?.name ?? (cfg.models[by] ? modelOf(cfg.models[by]).name : by) };
  }

  /** What went wrong with the microphone, with this phone's steps (spec §17 rule 3). @param {unknown} e */
  problem(e) {
    return micProblem(e, this.where);
  }
}
