import { readAppSettings, updateAppSettings } from '../settings.js';
import { voiceMode, routeOf } from './mode.js';
import { SYS, SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { ProviderError } from '../llm/contract.js';
import { COOLDOWN_MS, NETWORK_RETRIES, chatCandidates } from '../llm/fallback.js';
import { speechKind, modelOf, abilityOf, STAND_INS } from '../llm/config.js';
import { Speaker, speechOutEntries, Arrivals, playStream } from './speaker.js';
import { estimateSeconds } from './stream-start.js';
import { voicePlatform } from './platform.js';
import { voiceSettings } from './settings.js';
import { record } from './recorder.js';
import { HeardMemory, listenKind, resolveSpeech, textVersion, audioFor } from './resolve.js';
import { pickFormat, pickOut, CODEC_ORDER } from './formats.js';
import { listen } from './listening.js';
import { micProblem } from './mic.js';
import { browserVoiceFor } from './where.js';
import { languageSettings, modelLanguages, speakerLine, speechLocale, dictationLocale } from '../languages.js';
import { record as logEvent } from '../agent/log.js';
import { encodeWav } from './pcm.js';
import { sha256Hex } from '../hash.js';

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

/** A model's tunables as its calls get them: its type's, its ability's, its own. @param {any} cfg @param {Map<string, { tunables?: Record<string, any> }>} types @param {string} id */
export function tunablesOf(cfg, types, id) {
  const a = abilityOf(cfg, id);
  const rec = cfg.models?.[id];
  return { ...types.get(a?.type ?? '')?.tunables, ...a?.tunables, ...(rec ? modelOf(rec).tunables : {}) };
}

/** The formats a model takes (spec §10.6); WAV, as before, where none says. @param {any} cfg @param {Map<string, any>} types @param {string} id @returns {string[]} */
export function audioIn(cfg, types, id) {
  const a = tunablesOf(cfg, types, id).audioIn;
  return Array.isArray(a) ? a.map(String) : ['wav'];
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
  /** The waits before a failed upload's same bytes go again. */
  retryMs = NETWORK_RETRIES;
  /** Models that refused a format they said they take: WAV until annai restarts. @type {Set<string>} */
  wavOnly = new Set();
  /** Voices that refused the format they offered: what to say the phone plays to them, until annai restarts. @type {Map<string, string[]>} */
  voicePlays = new Map();
  /** The voices that answered a 400 naming instructions: asked without their style from then on (until annai restarts). @type {Set<string>} */
  unstyled = new Set();
  /** The transcription models that answered a 400 naming language: asked without the user's languages from then on (until annai restarts). @type {Set<string>} */
  unhinted = new Set();
  /** The voice mode now (spec §10.5); refresh() works it out again. @type {import('./mode.js').VoiceMode} */
  mode = { setting: 'auto', on: false, why: 'not sure' };
  /** @type {Set<(m: import('./mode.js').VoiceMode, first: boolean) => void>} */
  #changes = new Set();
  /** The mode has been read once: the first reading, as annai starts, is no change of mode. */
  #read = false;
  #watching = false;
  /** The last route decision traced. */
  #routed = '';
  /** @type {Set<LevelListener>} */
  #levels = new Set();
  /** Sound may play: a tap unlocked it (spec §10.1). */
  #unlocked = false;
  /** @type {Promise<unknown>} */
  #unlocking = Promise.resolve();
  /** @type {Promise<boolean> | null} the unlock still starting, which no other starts over (unlock) */
  #trying = null;

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
      synthesize: (entry, text, signal) => this.#clip(entry.id, text, signal),
      platform: () => this.platform,
      now: () => this.now(),
      // A stream the page couldn't play (an iPhone's audio suspended): whole clips until a tap unlocks sound again.
      onBlocked: () => { this.#unlocked = false; },
      bench: (id, error) => this.llm.bench.bench(id, restFor(error), this.now()),
      browserOptions: async (text) => {
        const app = await readAppSettings(this.ws);
        const s = voiceSettings(app);
        // The sentence's own language among those listed (a fixed answer language wins): a voice chosen by hand still speaks as it does.
        const lang = speechLocale(languageSettings(app, this.locale), text);
        const system = this.browserVoice(s.browserVoice, lang);
        return { voice: system?.id, rate: s.rate, lang, system };
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
   * for the language; else the browser's default. @param {string} [chosen] @param {string} [lang] the language (the browser's by default)
   * @returns {import('./platform.js').SystemVoice | null}
   */
  browserVoice(chosen = '', lang = this.locale) {
    try {
      return browserVoiceFor(this.platform?.synth.voices() ?? [], { chosen, lang });
    } catch {
      return null;
    }
  }

  /** What the user speaks (Settings → Shiori), the browser's language until they choose. */
  async languages() {
    return languageSettings(await readAppSettings(this.ws), this.locale);
  }

  /**
   * How Shiori sounds, in the words of the first Gemini voice in her voices' list: its style, the description's default or the user's own,
   * in plain words; '' once the user has cleared it, for a voice that takes none, or with no Gemini voice. Koe live is told it, so it sounds
   * as she does in Classic.
   */
  async speakingStyle() {
    const cfg = await this.llm.config();
    const id = (cfg.roles['speech-out']?.models ?? []).find((/** @type {string} */ i) => abilityOf(cfg, i)?.type === 'gemini-speech');
    if (!id) return '';
    const t = tunablesOf(cfg, this.llm.types(), id);
    return t.styled === false ? '' : String(t.style ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\s.,;:!?]+$/, '');
  }

  /** The language phone dictation listens in: the first the user speaks (it takes one), whatever Shiori answers in. */
  async dictationLocale() {
    return dictationLocale(await this.languages());
  }

  /** Whether phone dictation recognizes speech on this phone, for the language it listens in, now (spec §11.7). @returns {Promise<boolean>} */
  async dictationLocal() {
    try {
      return Boolean(await this.platform?.dictation.local?.(await this.dictationLocale()));
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

  /** What this phone plays (spec §10.6); every browser plays MP3 and WAV. @returns {string[]} */
  plays() {
    return this.platform?.player.plays?.() ?? ['mp3', 'wav'];
  }

  /** @returns {Promise<string[]>} */
  async makes() {
    return [...(await this.platform?.encoder?.makes().catch(() => []) ?? []), 'wav'];
  }

  /** A heard segment as it is kept (spec §10.2): the smallest format the phone makes and plays. @param {import('./resolve.js').Heard} h */
  async clipOf(h) {
    const kept = this.memory.get(h.id) ?? { ...h, transcripts: new Map(), encoded: new Map(h.encoded) };
    return audioFor(kept, CODEC_ORDER.flat().filter((f) => this.plays().includes(f)), this.platform?.encoder);
  }

  /**
   * What a heard entry keeps with "keep voice clips" (spec §10.2): a blob it names (§4.9), as clipOf makes it; nothing without
   * the setting. A live session's speech (K5) comes as its samples. @param {import('./resolve.js').Heard | { id: string, pcm: Int16Array, rate: number }} h
   * @returns {Promise<{ data: Record<string, any>, blobs: { hash: string, bytes: Uint8Array, type: string }[] }>}
   */
  async keep(h) {
    const seg = 'pcm' in h ? { id: h.id, audio: { data: encodeWav(h.pcm, h.rate), mediaType: 'audio/wav', seconds: h.pcm.length / h.rate } } : h;
    const kept = seg.audio && (await this.settings()).keepClips ? await this.clipOf(/** @type {any} */ (seg)).catch(() => null) : null;
    if (!kept) return { data: {}, blobs: [] };
    const hash = await sha256Hex(kept.data);
    return { data: { clip: hash, clipFormat: kept.format, clipBytes: kept.data.length }, blobs: [{ hash, bytes: kept.data, type: kept.mediaType }] };
  }

  /** A MediaRecorder type to record alongside, when some receiver would take its format over the encoder's (decision 24). */
  async #recordWith() {
    const enc = this.platform?.encoder;
    const records = enc?.records?.() ?? [];
    if (!records.length) return undefined;
    const cfg = await this.llm.config();
    const types = this.llm.types();
    const list = cfg.roles['speech-in']?.models ?? [];
    const takers = [...(list.includes('send-audio') ? cfg.roles.main?.models ?? [] : []), ...list.filter((/** @type {string} */ id) => speechKind(cfg, types, id) === 'in')];
    const makes = await this.makes();
    return records.find((r) => takers.some((/** @type {string} */ id) => {
      const accepts = audioIn(cfg, types, id);
      return pickFormat(accepts, [...makes, r.format]) === r.format && pickFormat(accepts, makes) !== r.format;
    }));
  }

  /**
   * Unlocks sound (an iPhone rule, spec §10.1): call it inside a tap. Once it worked it does
   * nothing, so a tap never plays the silent clip over her voice. @returns {Promise<boolean>} whether sound may play
   */
  unlock() {
    if (this.#unlocked) return Promise.resolve(true);
    // One at a time: a tap is pointerup, touchend and click, and a tap on Shiori unlocks too; loading the silent clip
    // again over itself wedges WebKit on Linux (the welcome's keyboard test). Taps wait on one still starting, however long (review m5).
    if (this.#trying) return this.#trying;
    /** @type {Promise<boolean> | boolean | undefined} */
    let tried;
    try {
      tried = this.platform?.player.unlock();
    } catch {
      tried = undefined;
    }
    if (!tried) return Promise.resolve(false);
    // A platform's unlock may give a plain boolean rather than a promise of one.
    const trying = (this.#unlocking = Promise.resolve(tried).then((ok) => {
      if (ok) this.#unlocked = true;
      return Boolean(ok);
    }, () => false));
    this.#trying = trying;
    trying.then(() => { if (this.#trying === trying) this.#trying = null; });
    return trying;
  }

  /**
   * Settles once the unlock in progress has started its silent clip or failed, at most after limitMs. A page that
   * goes away while the clip starts deadlocks WebKit on Linux, so a tap that leaves the page waits for it.
   * @param {number} [limitMs]
   */
  settled(limitMs = 1000) {
    /** @type {any} */
    let t;
    return Promise.race([this.#unlocking, new Promise((r) => { t = setTimeout(r, limitMs); })]).then(() => clearTimeout(t));
  }

  /** Whether a tap has unlocked sound (spec §10.1). */
  get unlocked() {
    return this.#unlocked;
  }

  /** A live session's sound, for the glow (K5). @param {number} x @param {'her' | 'you'} who */
  level(x, who) {
    this.#level(x, who);
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

  /** One voice's clip of a text, or its stream, played: that voice's Test. @param {string} modelId @param {string} text */
  async sample(modelId, text) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't play sound here.");
    platform.session('playback');
    const got = await this.#clip(modelId, text);
    const o = { signal: new AbortController().signal, onLevel: (/** @type {number} */ x) => this.#level(x, 'her') };
    return 'chunks' in got ? playStream(platform.player, new Arrivals(got, this.now), { ...o, estimatedS: estimateSeconds(text), now: this.now }) : platform.player.play(got, o);
  }

  /**
   * One voice's clip, in the smallest format it offers that the phone plays (spec §10.6). A voice
   * that refuses it (Speaches refuses opus and aac) is asked for MP3, then WAV, until annai restarts; one that refuses its
   * style (a 400 naming instructions) is asked without it, as long.
   * A voice that streams gives its stream once a tap has unlocked sound (G3): before then, the stream
   * player might never sound (an iPhone), where a whole clip's refusal says so.
   * @param {string} id @param {string} text @param {AbortSignal} [signal]
   * @returns {Promise<import('./platform.js').Clip | import('../llm/contract.js').SpeechStream>}
   */
  async #clip(id, text, signal) {
    const t = tunablesOf(await this.llm.config(), this.llm.types(), id);
    const asked = (/** @type {string[]} */ plays) => (t.format === 'auto' ? pickOut([].concat(t.audioOut ?? []), plays) : t.format);
    const stream = Boolean(this.#unlocked && this.platform?.player.stream);
    for (let plays = this.voicePlays.get(id) ?? this.plays(); ;) {
      try {
        const r = await this.llm.synthesize({ modelId: id, text, signal, scope: this.scope, plays, ...(stream ? { stream } : {}), ...(this.unstyled.has(id) ? { unstyled: true } : {}) });
        return r.stream ?? r.clip;
      } catch (e) {
        // A server that has no instructions field says so in a 400: asked again without the style, once.
        if (e instanceof ProviderError && e.kind === 'bad-request' && /instructions/i.test(e.message) && (t.style || t.instructions) && !this.unstyled.has(id)) {
          this.unstyled.add(id);
          continue;
        }
        const order = ['mp3', 'wav'];
        const next = order.slice(order.indexOf(asked(plays) ?? '') + 1).find((f) => asked([f]) === f);
        if (!(e instanceof ProviderError && e.kind === 'bad-request') || t.format !== 'auto' || !next) throw e;
        this.voicePlays.set(id, (plays = [next]));
      }
    }
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
    const recording = await this.#recordWith();
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
      record({ mic: platform.mic, pauseMs, now: this.now, recording, onSpeech, onLevel: (x) => this.#level(x, 'you'), onSegment: (s) => finish(s), onError: (e) => finish(null, e) })
        .then((s) => {
          session = s;
          if (done) s.close();
        }, (e) => finish(null, e));
    });
  }

  /** What a transcription model hears in a segment, sent in its smallest format. @param {Segment} segment @param {string} modelId */
  async transcribe(segment, modelId) {
    return this.#hear(modelId, { ...segment, source: 'mic', transcripts: new Map(), encoded: new Map(segment.encoded) }, this.scope);
  }

  /**
   * One transcription, in the smallest format both sides handle (spec §10.6). A failed upload goes
   * again with the same bytes. Any refusal of another format is answered with WAV once (whisper.cpp
   * says only "Invalid request"): WAV from then on if that works.
   * @param {string} id @param {import('./resolve.js').Kept} kept @param {string} scope @param {string} [wake] @param {AbortSignal} [signal] @param {boolean} [plain]
   * @returns {Promise<string>}
   */
  async #hear(id, kept, scope, wake, signal, plain = this.wavOnly.has(id)) {
    const cfg = await this.llm.config();
    const accepts = plain ? ['wav'] : audioIn(cfg, this.llm.types(), id);
    const audio = await audioFor(kept, accepts, this.platform?.encoder);
    if (!audio) throw new ProviderError('bad-request', `${modelOf(cfg.models[id]).name} takes no audio format this phone makes (${accepts.join(', ')}).`);
    for (let retry = 0; ; retry++) {
      try {
        const hints = modelLanguages(await this.languages());
        const languages = this.unhinted.has(id) ? { ...hints, spoken: [] } : hints;
        const text = String((await this.llm.transcribe({ modelId: id, audio: { ...audio, seconds: kept.audio?.seconds }, scope, wake, signal, languages })).text ?? '');
        if (plain) this.wavOnly.add(id);
        return text;
      } catch (e) {
        const kind = e instanceof ProviderError ? e.kind : '';
        // A 400 naming the language field: asked again without the user's languages, and not hinted again (as a refused style is dropped).
        if (kind === 'bad-request' && /language/i.test(/** @type {Error} */ (e).message) && !this.unhinted.has(id) && modelLanguages(await this.languages()).spoken.length) {
          this.unhinted.add(id);
          return this.#hear(id, kept, scope, wake, signal, plain);
        }
        if (kind === 'bad-request' && audio.format !== 'wav' && audioIn(cfg, this.llm.types(), id).includes('wav')) return this.#hear(id, kept, scope, wake, signal, true);
        if (!['network', 'server', 'overloaded'].includes(kind) || retry >= this.retryMs.length || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, this.retryMs[retry]));
        if (signal?.aborted) throw e;
      }
    }
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
   * audio devices' names; and, where it can't tell, the last explicit choice. Listeners hear a change,
   * and whether it is the first reading (as annai starts, nothing changed: the log doesn't record it).
   * @returns {Promise<boolean>} whether voice is on
   */
  async refresh() {
    const s = await this.settings();
    const route = s.mode === 'auto' ? await this.route() : 'unknown';
    const next = voiceMode({ setting: s.mode, activity: this.activity(), route, lastChoices: s.lastChoices });
    this.#watch();
    const first = !this.#read;
    this.#read = true;
    if (next.on !== this.mode.on || next.why !== this.mode.why || next.setting !== this.mode.setting) {
      this.mode = next;
      for (const fn of this.#changes) {
        try {
          fn(next, first);
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

  /**
   * What audio is in use, from the devices' names (spec §10.5): while the microphone is open, the one input it takes (its track's
   * label, else its deviceId's); else those present. Each new decision goes in this device's own Trace, with the names.
   */
  async route() {
    try {
      const devices = (await this.platform?.devices?.()) ?? [];
      const used = this.platform?.mic.inUse?.() ?? null;
      const using = used && (used.label || devices.find((d) => d.deviceId && d.deviceId === used.deviceId)?.label || '');
      // An input no longer among the devices (AirPods taken out, its track still named for them) is unknown.
      const gone = used?.deviceId && devices.some((d) => d.deviceId) && !devices.some((d) => d.deviceId === used.deviceId);
      const route = gone ? 'unknown' : routeOf(used ? [{ kind: 'audioinput', label: /** @type {string} */ (using) }] : devices);
      const data = { route, using, devices: devices.map((d) => d.label) };
      const key = JSON.stringify(data);
      if (key !== this.#routed && this.store) {
        this.#routed = key;
        const store = this.store;
        ensureDeviceScope(store).then(() => logEvent(store, SYS_DEVICE, { type: 'voice.route', actor: 'system', data })).catch(() => {});
      }
      return route;
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

  /** Hears when the voice mode changes; first: it was the first reading. @param {(m: import('./mode.js').VoiceMode, first: boolean) => void} fn @returns {() => void} */
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
    // The activity sensor comes with live mode (spec §11.2), maybe after voice started: followed once it is there.
    /** @type {any} */
    let followed = null;
    const follow = (/** @type {boolean} */ late) => {
      const sensor = this.registry.list('activity')[0] ?? null;
      if (!sensor || sensor === followed) return;
      followed = sensor;
      sensor.onChange?.(again);
      if (late) again(); // one that came later may already say something
    };
    follow(false); // called from refresh(), which reads the activity itself
    this.registry.onChange(() => follow(true));
  }

  /** How to listen now (spec §10.3), against the first model of the role that hears (Koe's, or main) that isn't resting. @param {string} [role] */
  async howToListen(role = 'main') {
    const cfg = await this.llm.config();
    const types = this.llm.types();
    const now = this.now();
    const free = (/** @type {string} */ id) => this.llm.bench.until(id) <= now;
    const mainId = chatCandidates(cfg, role).find((/** @type {string} */ id) => cfg.models[id] && free(id));
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
    const recording = kind === 'record' ? await this.#recordWith() : undefined;
    platform.encoder?.makes().catch(() => {}); // tried while she listens, not when the first segment goes
    platform.session('play-and-record');
    try {
      const session = await listen({
        // Web Speech takes one language: the first the user speaks (Settings → Shiori), else the browser's own.
        platform, kind, pauseMs, lang: await this.dictationLocale(), now: this.now, onSpeech, onQuiet, onError, local, recording,
        onLevel: (x) => this.#level(x, 'you'),
        onSegment: (h) => {
          this.memory.keep(h, scope);
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
   * Transcriptions are traced in scope, for the wake, and stop with the call's signal. plain: the model
   * refused the audio format it was sent: WAV until annai restarts.
   * @param {string} scope @param {string} [wake] @param {string[]} [list] the speech-in list, when not the role's
   * @returns {(model: { id?: string, name: string, input: string[] }, request: import('../llm/contract.js').Request, plain?: boolean, signal?: AbortSignal) => Promise<import('../llm/contract.js').Request>}
   */
  resolver(scope, wake, list) {
    return async (model, request, plain, signal) => {
      if (plain && model.id) this.wavOnly.add(model.id);
      const c = await this.#resolve(scope, wake, signal);
      return resolveSpeech(request, model, { ...c, ...(list ? { list } : {}), plain: Boolean(model.id && this.wavOnly.has(model.id)) });
    };
  }

  /** @param {string} scope @param {string} [wake] @param {AbortSignal} [signal] @returns {Promise<import('./resolve.js').Resolve>} */
  async #resolve(scope, wake, signal) {
    const cfg = await this.llm.config();
    const types = this.llm.types();
    return {
      list: cfg.roles['speech-in']?.models ?? [],
      memory: this.memory,
      asr: (id) => speechKind(cfg, types, id) === 'in' && this.llm.bench.until(id) <= this.now(),
      transcribe: (id, kept) => this.#hear(id, kept, scope, wake, signal),
      clip: async (hash) => {
        const b = await this.store?.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
        return b ? { data: new Uint8Array(b.data), mediaType: b.type } : null;
      },
      onFail: (id, e) => this.llm.bench.bench(id, restFor(e), this.now()),
      accepts: (id) => audioIn(cfg, types, id),
      encoder: this.platform?.encoder,
    };
  }

  /**
   * A segment's words, for the log (spec §10.3): a transcript made already, dictation's, or the
   * first entry that can write it down; for "Send audio to the model", the model that heard it
   * (hearer), of its role, is asked. null when nothing could, or the segment isn't in memory.
   * @param {string} id @param {{ scope: string, wake?: string, hearer?: string, role?: string }} o
   * @returns {Promise<{ text: string, by: string } | null>} by: who wrote it down, by name
   */
  async writeDown(id, { scope, wake, hearer, role = 'main' }) {
    const kept = this.memory.get(id);
    if (!kept) return null;
    let who = hearer ?? '';
    const r = await textVersion(kept, {
      ...(await this.#resolve(scope, wake)),
      ...(hearer ? {
        hearer: async (/** @type {import('./resolve.js').Kept} */ k) => {
          // The sound goes as each model it reaches takes it, and only as sound.
          const out = await this.llm.call({
            role, prefer: hearer, level: 'off', scope, record: { tag: 'transcribe', ...(wake ? { wake } : {}) }, speech: this.resolver(scope, wake, ['send-audio']),
            request: { system: [WRITE_DOWN, speakerLine(await this.languages())].filter(Boolean).join(' '), messages: [{ role: 'user', parts: [{ type: 'speech', id: k.id }] }], maxOutput: 400 },
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
