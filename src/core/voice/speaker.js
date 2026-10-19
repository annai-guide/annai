import { Sentences } from './sentences.js';
import { modelOf, speechKind, SPEECH_DEFAULTS } from '../llm/config.js';

/**
 * Speaking (spec §10.1). What Shiori says arrives as text, a piece at a time; each complete
 * sentence goes to the first working entry of the speech-out list, an API voice or the browser's.
 * An API voice's next sentence is fetched while one plays, so there are no gaps. When a voice fails
 * partway through, it is benched and the same sentence plays on the next one. When the user cuts
 * her off, playing stops at once and what she had said is kept: by sentence and the fraction of it
 * played, or by word with the browser voice.
 * @typedef {import('./platform.js').VoicePlatform} VoicePlatform
 * @typedef {import('./platform.js').Clip} Clip
 * @typedef {{ id: string, name: string, kind: 'browser' | 'api' }} VoiceEntry
 * @typedef {{ sentences: string[], said: number, cut: { index: number, at: number } | null, heard: string, failed: null | 'no-voice' | 'blocked', voices: string[] }} Spoken
 *   said: sentences spoken whole; cut: where she was stopped (a sentence, and characters into it); heard: what the user heard; voices: who spoke, in order;
 *   failed: no voice could speak ('no-voice'), or the page may not play sound yet ('blocked', an iPhone before the first tap)
 * @typedef {{ entries: () => Promise<VoiceEntry[]>, synthesize: (entry: VoiceEntry, text: string, signal: AbortSignal) => Promise<Clip>,
 *   platform: () => VoicePlatform | null, bench: (id: string, error: unknown) => void,
 *   browserOptions?: () => Promise<{ voice?: string, rate?: number, lang?: string, system?: import('./platform.js').SystemVoice | null }>, onLevel?: (x: number) => void, locale?: string,
 *   onVoice?: (entry: VoiceEntry, system: import('./platform.js').SystemVoice | null) => void }} SpeakerDeps
 *   browserOptions' system: the browser voice it speaks with; onVoice: a voice starts speaking an utterance (spec §11.7: the trace notes a browser voice not on this phone)
 * @typedef {{ ended: boolean, at: number, failed?: 'no-voice' | 'blocked' }} Said
 */

/**
 * The speech-out entries that can speak now, in the user's order (spec §9.6, §10.1): the browser
 * voice where the browser has one, and voices whose ability is on, whose type runs and that aren't resting.
 * @param {import('../llm/config.js').ModelConfig} cfg
 * @param {{ types: Map<string, { speech?: string }>, until: (id: string) => number, now: number, browser: boolean }} c
 * @returns {VoiceEntry[]}
 */
export function speechOutEntries(cfg, { types, until, now, browser }) {
  /** @type {VoiceEntry[]} */
  const out = [];
  for (const id of cfg.roles?.['speech-out']?.models ?? SPEECH_DEFAULTS['speech-out']) {
    if (until(id) > now) continue;
    if (id === 'browser-voice') {
      if (browser) out.push({ id, name: 'Browser voice', kind: 'browser' });
      continue;
    }
    const rec = cfg.models[id];
    if (rec && speechKind(cfg, types, id) === 'out') out.push({ id, name: modelOf(rec).name, kind: 'api' });
  }
  return out;
}

/** Where the word at the playing position starts: the fraction played, back to a space. @param {string} text @param {number} fraction */
export function wordStart(text, fraction) {
  const n = Math.floor(text.length * Math.max(0, Math.min(1, fraction)));
  if (n >= text.length) return text.length;
  const i = text.lastIndexOf(' ', n);
  return i < 0 ? 0 : i;
}

/** What the user heard: the sentences said whole, then the start of the one she was cut off in. @param {string[]} texts @param {number} said @param {Spoken['cut']} cut */
function heardText(texts, said, cut) {
  const part = cut && cut.at > 0 ? `${texts[cut.index].slice(0, cut.at).trimEnd()}…` : '';
  return [texts.slice(0, said).join(' '), part].filter(Boolean).join(' ');
}

export class Speaker {
  /** @type {Set<Utterance>} */
  #live = new Set();
  /** @type {Promise<unknown>} */
  #last = Promise.resolve();

  /** @param {SpeakerDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** Something to say. It plays after what is already being said. */
  begin() {
    const u = new Utterance(this.deps, this.#last);
    this.#live.add(u);
    this.#last = u.done;
    u.done.then(() => this.#live.delete(u));
    return u;
  }

  /** Whether something is being said, or waits to be. */
  get speaking() {
    return this.#live.size > 0;
  }

  /** The user cut her off (spec §10.4): everything stops. @returns {boolean} whether she was speaking */
  stop() {
    const was = this.#live.size > 0;
    for (const u of this.#live) u.stop();
    return was;
  }
}

export class Utterance {
  /** @type {SpeakerDeps} */
  #deps;
  /** @type {Sentences} */
  #sentences;
  /** @type {string[]} */
  #texts = [];
  #ended = false;
  #stopped = false;
  #abort = new AbortController();
  /** @type {(() => void)[]} */
  #waiting = [];
  /** @type {Map<number, { entry: string, clip: Promise<Clip> }>} */
  #prefetched = new Map();
  /** @type {{ index: number, entry: VoiceEntry } | null} */
  #playing = null;
  /** The voices that spoke, in order. @type {string[]} */
  #voices = [];
  /** @type {Promise<Spoken>} */
  done;

  /** @param {SpeakerDeps} deps @param {Promise<unknown>} after what is said first */
  constructor(deps, after) {
    this.#deps = deps;
    this.#sentences = new Sentences(deps.locale);
    this.done = after.then(() => this.#run(), () => this.#run());
  }

  /** The text so far, as it streams in. @param {string} text */
  feed(text) {
    if (!this.#ended) this.#add(this.#sentences.take(text));
  }

  /** All of the text: the rest is said. @param {string} text */
  end(text) {
    if (this.#ended) return;
    this.#add(this.#sentences.take(text, true));
    this.#ended = true;
    this.#wake();
  }

  /** Stops now (spec §10.4); done settles with what was said. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    this.#wake();
  }

  get stopped() {
    return this.#stopped;
  }

  /** @param {string[]} list */
  #add(list) {
    if (!list.length) return;
    this.#texts.push(...list);
    if (this.#playing) this.#prefetch(this.#playing.index + 1, this.#playing.entry);
    this.#wake();
  }

  #wake() {
    for (const w of this.#waiting.splice(0)) w();
  }

  /** Sentence i once it is known; null when there is none: the text ended, or she was stopped. @param {number} i @returns {Promise<string | null>} */
  async #sentence(i) {
    for (;;) {
      if (this.#stopped) return null;
      if (i < this.#texts.length) return this.#texts[i];
      if (this.#ended) return null;
      await new Promise((r) => { this.#waiting.push(() => r(undefined)); });
    }
  }

  /** @returns {Promise<Spoken>} */
  async #run() {
    /** @type {Spoken['cut']} */
    let cut = null;
    /** @type {Spoken['failed']} */
    let failed = null;
    let i = 0;
    try {
      for (;; i++) {
        const text = await this.#sentence(i);
        if (text === null) break;
        if (i === 0) this.#deps.platform()?.session('playback'); // speaking: heard with the iPhone's silent switch on; music pauses (spec §10.1)
        const r = await this.#say(i, text);
        if (r.failed) {
          failed = r.failed;
          break;
        }
        if (!r.ended) {
          cut = { index: i, at: r.at };
          break;
        }
      }
      if (this.#stopped && !cut && !failed && (i < this.#texts.length || !this.#ended)) cut = { index: i, at: 0 };
    } finally {
      this.#abort.abort(); // nothing fetched ahead is left running
      this.#deps.onLevel?.(0);
    }
    const said = cut ? cut.index : failed ? i : this.#texts.length;
    return { sentences: [...this.#texts], said, cut, heard: heardText(this.#texts, said, cut), failed, voices: this.#voices };
  }

  /**
   * Sentence i on the first voice that can say it. A voice that fails is benched and the next one
   * says the same sentence (spec §10.1); a page that may not play sound yet is nobody's fault.
   * @param {number} i @param {string} text @returns {Promise<Said>}
   */
  async #say(i, text) {
    /** @type {Set<string>} */
    const tried = new Set();
    for (;;) {
      if (this.#stopped) return { ended: false, at: 0 };
      const platform = this.#deps.platform();
      const entry = platform ? (await this.#deps.entries()).find((e) => !tried.has(e.id)) : undefined;
      if (!platform || !entry) return { ended: false, at: 0, failed: 'no-voice' };
      tried.add(entry.id);
      try {
        if (entry.kind === 'browser') {
          const { system = null, ...o } = (await this.#deps.browserOptions?.()) ?? {};
          this.#spoke(entry, system);
          const r = await platform.synth.say(text, { ...o, signal: this.#abort.signal, onLevel: this.#deps.onLevel });
          return { ended: r.ended, at: r.ended ? text.length : r.charIndex };
        }
        const clip = await this.#clip(i, entry, text);
        if (this.#stopped) return { ended: false, at: 0 };
        this.#spoke(entry);
        this.#playing = { index: i, entry };
        this.#prefetch(i + 1, entry);
        const r = await platform.player.play(clip, { signal: this.#abort.signal, onLevel: this.#deps.onLevel });
        return { ended: r.ended, at: r.ended ? text.length : wordStart(text, r.fraction) };
      } catch (e) {
        if (this.#stopped) return { ended: false, at: 0 };
        if (/** @type {any} */ (e)?.name === 'NotAllowedError') return { ended: false, at: 0, failed: 'blocked' };
        this.#deps.bench(entry.id, e);
      } finally {
        this.#playing = null;
      }
    }
  }

  /** @param {VoiceEntry} entry @param {import('./platform.js').SystemVoice | null} [system] */
  #spoke(entry, system = null) {
    if (this.#voices.at(-1) === entry.name) return;
    this.#voices.push(entry.name);
    this.#deps.onVoice?.(entry, system);
  }

  /** Sentence i's clip: fetched ahead by the same voice, or now. @param {number} i @param {VoiceEntry} entry @param {string} text */
  #clip(i, entry, text) {
    const ahead = this.#prefetched.get(i);
    this.#prefetched.delete(i);
    return ahead && ahead.entry === entry.id ? ahead.clip : this.#deps.synthesize(entry, text, this.#abort.signal);
  }

  /** Fetches sentence i's clip while the one before it plays (spec §10.1: no gaps). @param {number} i @param {VoiceEntry} entry */
  #prefetch(i, entry) {
    if (entry.kind !== 'api' || i >= this.#texts.length || this.#prefetched.has(i) || this.#stopped) return;
    const clip = this.#deps.synthesize(entry, this.#texts[i], this.#abort.signal);
    clip.catch(() => {}); // a failure counts when the clip is wanted
    this.#prefetched.set(i, { entry: entry.id, clip });
  }
}
