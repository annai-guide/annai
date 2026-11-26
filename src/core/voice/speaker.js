import { Sentences } from './sentences.js';
import { readyToStart, estimateSeconds } from './stream-start.js';
import { modelOf, speechKind, SPEECH_DEFAULTS } from '../llm/config.js';
import { anySignal } from '../signals.js';
import { t } from '../l10n.js';
import { STAND_IN_NAMES } from './where.js';

/**
 * Speaking (spec §10.1). What Shiori says arrives as text, a piece at a time; each complete sentence goes to the first working entry of the
 * speech-out list, an API voice or the browser's. An API voice's next sentence is fetched while one plays, so there are no gaps. A voice
 * that fails partway is benched (not when the phone is offline: voice.js restFor) and the same sentence plays on the next one. When the user cuts her off, playing stops at once and what
 * she had said is kept: by sentence and the fraction played, or by word with the browser voice. A voice that streams is played as it
 * comes, once the start rule says it won't stutter; the next sentence's stream reads ahead.
 * @typedef {import('./platform.js').VoicePlatform} VoicePlatform
 * @typedef {import('./platform.js').Clip} Clip
 * @typedef {import('../llm/contract.js').SpeechStream} SpeechStream
 * @typedef {{ id: string, name: string, kind: 'browser' | 'api' }} VoiceEntry
 * @typedef {{ sentences: string[], said: number, cut: { index: number, at: number } | null, heard: string, failed: null | 'no-voice' | 'blocked', voices: string[], failedVoices: { name: string, why: string, error: unknown }[] }} Spoken
 *   said: sentences spoken whole; cut: where she was stopped (a sentence, and characters into it); heard: what the user heard; voices: who spoke, in order;
 *   failedVoices: the voices that failed, each once, with why in the provider's own plain words, so the Voice test can say the first voice failed;
 *   failed: no voice could speak ('no-voice'), or the page may not play sound yet ('blocked', an iPhone before the first tap)
 * @typedef {{ entries: () => Promise<VoiceEntry[]>, synthesize: (entry: VoiceEntry, text: string, signal: AbortSignal) => Promise<Clip | SpeechStream>,
 *   platform: () => VoicePlatform | null, session?: (type: import('./platform.js').SessionType) => void, bench: (id: string, error: unknown) => void,
 *   browserOptions?: (text: string, o: { before: string[] }) => Promise<{ voice?: string, rate?: number, lang?: string, system?: import('./platform.js').SystemVoice | null }>, onLevel?: (x: number) => void, locale?: string,
 *   onVoice?: (entry: VoiceEntry, system: import('./platform.js').SystemVoice | null) => void, now?: () => number, onBlocked?: () => void, stallMs?: number }} SpeakerDeps
 *   browserOptions' before: her reply's sentences before this one (Speaker.begin), not joined, so a sentence that shows no language takes her reply's; its system: the browser voice it speaks with; onVoice: a voice starts speaking an utterance (spec §11.7: the trace notes a browser voice not on this phone);
 *   synthesize: a clip, or a stream; now: the clock a stream's arrivals are timed by (ms); onBlocked: the page may not play sound now, so a tap
 *   should unlock it again; stallMs: how long past its end a stream may go unplayed (playStream); session: sets the audio session type as her first sentence starts (Voice.session, spec §10.1)
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
      if (browser) out.push({ id, name: STAND_IN_NAMES['browser-voice'], kind: 'browser' }); // its name in the screens' words: only they show it
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

/**
 * A voice's stream read as it arrives, each piece kept with when the first came, so playing can start once it
 * won't stutter. Reading starts at once, and goes on while another sentence plays.
 */
export class Arrivals {
  /** @type {Int16Array[]} */
  pieces = [];
  /** Samples in, all told; the first piece's alone. */
  samples = 0;
  head = 0;
  /** When the first piece came (ms). */
  firstAt = 0;
  ended = false;
  /** @type {unknown} */
  error = null;
  /** @type {(() => void)[]} */
  #waiting = [];

  /** @param {SpeechStream} stream @param {() => number} now */
  constructor(stream, now) {
    this.rate = stream.rate;
    (async () => {
      try {
        for await (const pcm of stream.chunks) {
          if (!this.pieces.length) [this.firstAt, this.head] = [now(), pcm.length];
          this.pieces.push(pcm);
          this.samples += pcm.length;
          this.#wake();
        }
      } catch (e) {
        this.error = e;
      }
      this.ended = true;
      this.#wake();
    })();
  }

  #wake() {
    for (const w of this.#waiting.splice(0)) w();
  }

  /** Settles at the next piece, the end or a failure. @returns {Promise<void>} */
  changed() {
    return this.ended ? Promise.resolve() : new Promise((r) => { this.#waiting.push(r); });
  }
}

/** What a stream player that can't play sound gives: the page may not play sound now, as a refused clip says. */
const notAllowed = () => new DOMException(/* en */ 'The page may not play sound now.', 'NotAllowedError');

/**
 * A stream played through the stream player, started once readyToStart says the rest will be in before playback reaches it. It ends
 * played, or stopped by signal, with the fraction heard (the length estimated while the rest is still coming). A stream that fails stops
 * its player and throws, so the sentence can go to the next voice. A player whose sound doesn't play (an iPhone's audio suspended by an
 * interruption or a locked screen) says so, or isn't done stallMs after it should have been: then it is stopped, as a page that may not play sound.
 * @param {import('./platform.js').Player} player @param {Arrivals} a
 * @param {{ signal: AbortSignal, onLevel?: (x: number) => void, estimatedS: number, now: () => number, stallMs?: number }} o
 * @returns {Promise<{ ended: boolean, fraction: number }>}
 */
export async function playStream(player, a, { signal, onLevel, estimatedS, now, stallMs = 3000 }) {
  if (!player.stream) throw Object.assign(new Error(/* en */ "This browser can't play a voice as it arrives."), { shown: t`This browser can't play a voice as it arrives.` });
  /** @type {import('./platform.js').PlayerStream | null} */
  let out = null;
  let pushed = 0;
  let openedAt = 0;
  const stopped = new Promise((r) => { signal.addEventListener('abort', r, { once: true }); });
  /** @type {(e: unknown) => void} */
  let refuse = () => {};
  /** @type {Promise<never>} */
  const refused = new Promise((_, r) => { refuse = r; });
  refused.catch(() => {});
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let watchdog;
  try {
    while (!signal.aborted) {
      if (a.error) throw a.error;
      if (!out && readyToStart({ bufferedS: a.samples / a.rate, receivedS: (a.samples - a.head) / a.rate, elapsedS: (now() - a.firstAt) / 1000, estimatedS, ended: a.ended })) {
        out = player.stream({ rate: a.rate, onLevel });
        openedAt = now();
        out.running?.then((ok) => { if (!ok) refuse(notAllowed()); });
        out.done.then((r) => { if (r.stalled) refuse(notAllowed()); }); // its player stopped it: the sound never came out
      }
      while (out && pushed < a.pieces.length) out.push(a.pieces[pushed++]);
      if (out && a.ended) {
        out.end();
        const left = Math.max(0, (a.samples / a.rate) * 1000 - (now() - openedAt));
        const stalled = new Promise((_, r) => { watchdog = setTimeout(() => r(notAllowed()), left + stallMs); });
        if ((/** @type {any} */ (await Promise.race([out.done, stopped, refused, stalled])))?.stalled) throw notAllowed();
        break;
      }
      await Promise.race([a.changed(), stopped, refused]);
    }
  } catch (e) {
    out?.stop();
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
  if (!signal.aborted) return { ended: true, fraction: 1 };
  const heard = out ? out.stop().playedMs : 0;
  const totalS = a.ended ? a.samples / a.rate : Math.max(a.samples / a.rate, estimatedS);
  return { ended: false, fraction: totalS ? heard / (totalS * 1000) : 0 };
}

export class Speaker {
  /** @type {Set<Utterance>} */
  #live = new Set();
  /** @type {Promise<unknown>} */
  #last = Promise.resolve();
  /** Her reply under way: its key, and each of its utterances' sentences. @type {{ key: string, sentences: string[][] }} */
  #reply = { key: '', sentences: [] };

  /** @param {SpeakerDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * Something to say. It plays after what is already being said. reply: the reply it is part of (the loop's turn, its wake id), whose earlier
   * sentences come before its own (browserOptions' before); a new key is a new reply. Without one (a reminder) nothing comes before it.
   * @param {{ reply?: string }} [o]
   */
  begin({ reply = '' } = {}) {
    if (reply && reply !== this.#reply.key) this.#reply = { key: reply, sentences: [] };
    const u = new Utterance(this.deps, this.#last, reply ? this.#reply.sentences : []);
    this.#live.add(u);
    this.#last = u.done;
    const gone = () => this.#live.delete(u);
    u.done.then(gone, gone); // however it ends, it is no longer being said
    return u;
  }

  /** Whether something is being said, or waits to be. */
  get speaking() {
    return this.#live.size > 0;
  }

  /** Settles once nothing is being said, or waits to be. */
  async quiet() {
    while (this.speaking) await this.#last?.catch(() => {});
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
  /** Read-aheads, each stoppable on its own. @type {Map<number, { entry: string, clip: Promise<Clip | Arrivals>, stop: AbortController }>} */
  #prefetched = new Map();
  /** @type {{ index: number, entry: VoiceEntry } | null} */
  #playing = null;
  /** The voices that spoke, in order. @type {string[]} */
  #voices = [];
  /** The voices that failed, and why. @type {{ name: string, why: string, error: unknown }[]} */
  #failedVoices = [];
  /** The sentences of its reply's earlier utterances. @type {string[][]} */
  #before;
  /** @type {Promise<Spoken>} */
  done;

  /** @param {SpeakerDeps} deps @param {Promise<unknown>} after what is said first @param {string[][]} [reply] its reply's utterances' sentences, which its own join */
  constructor(deps, after, reply = []) {
    this.#deps = deps;
    this.#before = [...reply];
    reply.push(this.#texts);
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
        // Speaking: heard with the iPhone's silent switch on and music pauses; with Keep my music playing on (the door maps it to ambient) she is silent in silent mode and music plays on (spec §10.1). Not under an open microphone, which needs play-and-record.
        if (i === 0 && !this.#deps.platform()?.mic.inUse?.()) this.#deps.session?.('playback');
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
    return { sentences: [...this.#texts], said, cut, heard: heardText(this.#texts, said, cut), failed, voices: this.#voices, failedVoices: this.#failedVoices };
  }

  /**
   * Sentence i on the first voice that can say it. A voice that fails is benched (nothing offline: voice.js restFor) and the next one
   * says the same sentence (spec §10.1); a page that may not play sound yet is nobody's fault.
   * @param {number} i @param {string} text @returns {Promise<Said>}
   */
  async #say(i, text) {
    /** @type {Set<string>} */
    const tried = new Set();
    for (;;) {
      if (this.#stopped) return { ended: false, at: 0 };
      const platform = this.#deps.platform();
      // A list that can't be read gives no voice: the line ends failed, as with none, never rejected (that stayed "being said").
      const entry = platform ? (await this.#deps.entries().catch(() => [])).find((e) => !tried.has(e.id)) : undefined;
      if (!platform || !entry) return { ended: false, at: 0, failed: 'no-voice' };
      tried.add(entry.id);
      try {
        if (entry.kind === 'browser') {
          const { system = null, ...o } = (await this.#deps.browserOptions?.(text, { before: [...this.#before.flat(), ...this.#texts.slice(0, i)] })) ?? {};
          this.#spoke(entry, system);
          const r = await platform.synth.say(text, { ...o, signal: this.#abort.signal, onLevel: this.#deps.onLevel });
          return { ended: r.ended, at: r.ended ? text.length : r.charIndex };
        }
        const clip = await this.#clip(i, entry, text);
        if (this.#stopped) return { ended: false, at: 0 };
        this.#spoke(entry);
        this.#playing = { index: i, entry };
        this.#prefetch(i + 1, entry);
        const o = { signal: this.#abort.signal, onLevel: this.#deps.onLevel };
        const r = clip instanceof Arrivals
          ? await playStream(platform.player, clip, { ...o, estimatedS: estimateSeconds(text), now: this.#deps.now ?? Date.now, ...(this.#deps.stallMs ? { stallMs: this.#deps.stallMs } : {}) })
          : await platform.player.play(clip, o);
        return { ended: r.ended, at: r.ended ? text.length : wordStart(text, r.fraction) };
      } catch (e) {
        if (this.#stopped) return { ended: false, at: 0 };
        if (/** @type {any} */ (e)?.name === 'NotAllowedError') {
          this.#deps.onBlocked?.();
          return { ended: false, at: 0, failed: 'blocked' };
        }
        // What this voice read ahead goes too, unpaid (traced cancelled): the next voice says those sentences.
        for (const [k, ahead] of this.#prefetched) {
          if (ahead.entry !== entry.id) continue;
          ahead.stop.abort();
          this.#prefetched.delete(k);
        }
        if (!this.#failedVoices.some((f) => f.name === entry.name)) this.#failedVoices.push({ name: entry.name, why: String(/** @type {any} */ (e)?.message ?? e).slice(0, 300), error: e });
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

  /**
   * Sentence i's clip or stream: fetched ahead by the same voice, or now. A read-ahead of another voice (the first, asked again for each sentence
   * offline, failed) is aborted, unpaid, as when its voice fails (#say). @param {number} i @param {VoiceEntry} entry @param {string} text
   */
  #clip(i, entry, text) {
    const ahead = this.#prefetched.get(i);
    this.#prefetched.delete(i);
    if (ahead && ahead.entry === entry.id) return ahead.clip;
    ahead?.stop.abort();
    return this.#fetch(entry, text);
  }

  /** A voice's clip, or its stream, read from the moment it starts. @param {VoiceEntry} entry @param {string} text @param {AbortSignal} [signal] @returns {Promise<Clip | Arrivals>} */
  #fetch(entry, text, signal = this.#abort.signal) {
    return this.#deps.synthesize(entry, text, signal).then((x) => ('chunks' in x ? new Arrivals(x, this.#deps.now ?? Date.now) : x));
  }

  /** Fetches sentence i's clip while the one before it plays (spec §10.1: no gaps). @param {number} i @param {VoiceEntry} entry */
  #prefetch(i, entry) {
    if (entry.kind !== 'api' || i >= this.#texts.length || this.#prefetched.has(i) || this.#stopped) return;
    const stop = new AbortController();
    const clip = this.#fetch(entry, this.#texts[i], anySignal([this.#abort.signal, stop.signal]));
    clip.catch(() => {}); // a failure counts when the clip is wanted
    this.#prefetched.set(i, { entry: entry.id, clip, stop });
  }
}
