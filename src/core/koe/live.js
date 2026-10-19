import { LiveInput } from '../realtime/input.js';
import { escapeTags, wrapNote } from '../agent/blocks.js';
import { LABELS } from '../agent/loop.js';
import { newId } from '../scopes.js';
import { encodeWav } from '../voice/pcm.js';
import { sha256Hex } from '../hash.js';
import { toBase64 } from '../bytes.js';
import { blobBytes } from '../agent/log.js';
import { spentToday, budgetStop } from '../agent/budgets.js';
import { definitions } from '../agent/tools.js';
import { modelOf } from '../llm/config.js';
import { COOLDOWN_MS } from '../llm/fallback.js';

/**
 * Koe live (the Koe and Kokoro design, "Realtime sessions"; plan K5): Koe as a realtime voice model, one session at a time.
 * - A session opens on a tap, a typed message, or a trigger or note Koe should say; never by itself, so no microphone
 *   stays open between sessions. It closes on voice off, a conversation switch, the page going, Erase, or a quiet spell.
 * - The microphone streams only speech (LiveInput). Koe's voice plays from its first real word (decision 11) and stops
 *   when the user cuts in. What was heard and said is logged per turn, cut where playback stopped, its words cleaned of
 *   markup and escaped, as any text that isn't annai's.
 * - Its tool calls are answered at once (decision 10); Kokoro's notes go in as marked text turns (decision 14).
 * - A drop resumes with the handle, once; failing that, Halves carries on through Koe's next model.
 * @typedef {import('../realtime/open.js').LiveSession} LiveSession
 * @typedef {{ said: string, bytes: number, held: Uint8Array[], stream: import('../voice/platform.js').PlayerStream | null, spoken: boolean,
 *   tools: boolean, cut: boolean, logged: boolean }} Turn  one of Koe's turns: its words, its sound (held until a real word), how it ended
 * @typedef {{ id: string, text: string, at: number, ms: number, pcm: Int16Array[], logged: string | null, answered?: boolean, dismissed?: boolean }} Hearing
 *   what the user said, once; answered: Koe's turn for it has begun, or ended (dismissed: with nothing at all)
 * @typedef {object} LiveHost  what Halves gives it
 * @property {import('../agent/loop.js').Agent} koe  the Koe half: the log, its tools, its conversation
 * @property {any} llm @property {import('../voice/voice.js').Voice | null} voice @property {import('../types.js').Store} store @property {string} nonce
 * @property {() => string | null} model  the realtime model of Koe's pathway now
 * @property {() => Promise<{ instructions: string, context: string }>} setup
 * @property {() => boolean} visible  the page is on screen
 * @property {() => void} release  the speech pipeline lets go of the microphone and the speaker
 * @property {(n: import('../agent/loop.js').Notice) => void} notice
 * @property {(state: 'live-open' | 'live-closed') => void} told  Kokoro's block
 * @property {(cut: boolean) => void} dropped  the session dropped and couldn't resume; cut: Koe was mid-sentence
 * @property {() => void} changed
 * @property {() => Promise<any>} budgets @property {() => string} timeZone @property {number} [secondMs]  a second, in ms (tests pass less)
 */

/** Tool answers that add no speech (decision 10): Koe says what it needs in the same turn. */
const SILENT = ['tell_kokoro', 'show', 'ask'];
/** The most sends kept for a session not ready yet (a tap's first words, a reconnect): about 20 s of speech. */
const WAITING_MAX = 200;

/**
 * A realtime model's transcript as annai keeps it: no markup (measured: `<!-- … -->`, `<no speech>`, `{pause}`, even cut
 * off), and its words escaped like any text not annai's, so no tag survives. @param {string} text
 */
export const cleanSaid = (text) => escapeTags(String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|\{[^}]*(?:\}|$)/g, ' ').replace(/\s+/g, ' ').trim());
/** Whether a transcript holds a word: a letter or a digit, once its markup is gone. @param {string} text */
export const realWord = (text) => /[\p{L}\p{N}]/u.test(cleanSaid(text));
/** Words not annai's, as a live Koe reads them: no tag, and no line that starts like one of annai's labels. @param {string} text */
const theirs = (text) => escapeTags(text).replace(/^(\s*)\[/gm, '$1\\[');
/** @param {Uint8Array} b raw 16-bit PCM */
const samples = (b) => new Int16Array(b.slice(0, b.length & ~1).buffer);

export class LiveKoe {
  /** @type {'closed' | 'opening' | 'open'} */
  state = 'closed';
  /** The microphone is open: what is said streams to the provider (the chip says so). */
  listening = false;
  /** Koe's voice plays in this session (voice on, sound unlocked, the page in view). */
  voiced = false;
  /** The model the session runs. @type {string | null} */
  modelId = null;
  /** @type {LiveSession | null} */
  #s = null;
  /** The latest resume handle, in memory only (decision 28). @type {string | undefined} */
  #handle;
  /** The session's id: its entries' wake. */
  #wake = '';
  /** @type {LiveInput | null} */
  #input = null;
  /** Sends waiting for the session to be ready. @type {((s: LiveSession) => void)[]} */
  #waiting = [];
  /** @type {Hearing | null} */
  #hear = null;
  /** The turn Koe is giving now. @type {Turn | null} */
  #t = null;
  /** The turn whose sound still plays. @type {Turn | null} */
  #sounding = null;
  /** The turn just ended: words still coming for it, until new sound comes, are its own (dropped once it was cut). @type {Turn | null} */
  #trail = null;
  /** What waits for Koe's turn and its sound to end, or for the page to be in view: Kokoro's notes as Koe reads them, a trigger's words. @type {string[]} */
  #notes = [];
  /** @type {any} */
  #quiet = null;
  #quietMs = 30_000;
  #keep = false;
  #rotate = false;
  #tools = 0;
  /** Each open or close: an opening that outlived it is let go. */
  #gen = 0;
  /** @type {Promise<boolean> | null} */
  #opening = null;
  /** What it writes, in order. @type {Promise<unknown>} */
  #chain = Promise.resolve();
  /** @type {(() => void)[]} */
  #idlers = [];

  /** @param {LiveHost} c */
  constructor(c) {
    this.c = c;
  }

  /** Something is going on: opening or reconnecting, Koe's turn or sound, a tool, or the user speaking. */
  get busy() {
    return Boolean(this.#opening || this.#t || this.#sounding || this.#tools || this.#input?.active || (this.state === 'open' && !this.#s));
  }

  /** The dock's state (spec §16.3), as a half's. @returns {import('../agent/loop.js').State} */
  get view() {
    const name = this.state === 'opening' ? 'thinking' : this.state === 'closed' ? 'sleeping' : this.#sounding ? 'speaking'
      : this.#input?.active ? 'hearing' : this.#t ? 'thinking' : this.listening ? 'listening' : 'sleeping';
    return { name, label: LABELS[name] };
  }

  /** Settles once nothing is going on, and everything heard and said is written. */
  async idle() {
    while (this.busy) await new Promise((r) => { this.#idlers.push(() => r(undefined)); });
    await this.#chain;
  }

  #changed() {
    if (!this.busy) for (const fn of this.#idlers.splice(0)) fn();
    this.c.changed();
  }

  /**
   * Opens a session, or keeps the one open. mic: the microphone opens too, where voice is on and the page is in view (a
   * tap; a trigger or a note once sound was unlocked). @param {string} why @param {{ mic?: boolean }} [o]
   * @returns {Promise<boolean>} whether one is open
   */
  async open(why, { mic = false } = {}) {
    if (this.state !== 'open') {
      this.#opening ??= this.#start(why).finally(() => {
        this.#opening = null;
        this.#changed();
      });
    }
    const opening = this.#opening;
    const ok = opening ? await opening : this.state === 'open';
    if (ok && mic) await this.listen();
    return ok;
  }

  /** @param {string} why */
  async #start(why) {
    const id = this.c.model();
    // Never from a page out of view: what comes meanwhile waits for it (shown()).
    if (!id || !this.c.visible()) return false;
    const gen = ++this.#gen;
    this.state = 'opening'; // a close from now on wins
    this.#changed();
    // A session that can't open rests its model, as a failed call's does: Koe's next model answers meanwhile.
    const s = (await this.#over()) ? null : await this.#connect(id, this.#handle, why).catch(() => { this.c.llm.bench?.bench(id, COOLDOWN_MS); return null; });
    if (gen !== this.#gen || !s) {
      s?.close('closed');
      if (gen === this.#gen) this.state = 'closed';
      return false;
    }
    const v = this.c.voice;
    const settings = v ? await v.settings() : null;
    this.#quietMs = (settings?.closeAfterSeconds ?? 30) * (this.c.secondMs ?? 1000);
    this.#keep = Boolean(settings?.keepClips);
    this.modelId = id;
    this.state = 'open';
    this.c.told('live-open');
    this.unmute();
    this.#poke();
    this.#idle();
    return true;
  }

  /**
   * One connection, ready, its events handled while it is the session's. @param {string} id @param {string | undefined} resume @param {string} why
   * @returns {Promise<LiveSession>}
   */
  async #connect(id, resume, why) {
    const { instructions, context } = await this.c.setup();
    const tools = definitions(await this.c.koe.liveTools());
    this.#wake = newId('w');
    const s = await this.c.llm.live(id, { instructions, context, tools, ...(resume ? { resume } : {}) }, { scope: this.c.koe.scope, wake: this.#wake });
    s.on((e) => this.#on(s, e));
    s.closed.then((c) => this.#closed(s, c, why));
    await s.ready;
    this.#s = s;
    for (const fn of this.#waiting.splice(0)) fn(s);
    return s;
  }

  /** An open session's sound out now where voice is on, sound was unlocked and the page is in view; else Koe's words are bubbles. */
  unmute() {
    if (this.state !== 'open') return;
    const v = this.c.voice;
    const was = this.voiced;
    this.voiced = Boolean(v?.on && v.unlocked && this.c.visible() && v.platform?.player.stream);
    if (this.voiced && !was) this.c.release();
  }

  /** The microphone opens on the session open: what is said streams live, only while someone speaks. */
  async listen() {
    const v = this.c.voice;
    const p = v?.platform;
    if (this.#input || !this.#s || !p || !v.on || !this.c.visible()) return;
    this.unmute();
    this.c.release();
    const { pauseMs, bargeIn } = await v.settings();
    const input = new LiveInput({
      mic: p.mic, rate: 16_000, pauseMs, bargeInDb: bargeIn ? 6 : Infinity, speaking: () => Boolean(this.#sounding),
      send: { activity: (edge) => this.#activity(edge), audio: (b) => this.#audio(b) },
      onLevel: (x) => v.level(x, 'you'),
      onError: (e) => this.#deaf(e),
    });
    this.#input = input;
    this.listening = true;
    p.session('play-and-record');
    this.#changed();
    try {
      await input.start();
    } catch (e) {
      this.#deaf(e);
    }
    this.#poke();
  }

  /** The microphone failed (refused, or taken by another app): a card says why; the session goes on without it. @param {unknown} e */
  #deaf(e) {
    if (!this.#input) return;
    this.#input.stop();
    this.#input = null;
    this.listening = false;
    this.c.voice?.platform?.session('playback');
    const p = this.c.voice?.problem(e) ?? { title: 'Listening stopped', body: String(e) };
    this.c.notice({ tone: 'warn', title: p.title, body: p.body });
    this.#changed();
  }

  /**
   * Closes the session: the microphone closes, her voice stops (what it said is kept up to there), and full-quality
   * playback comes back (spec §10.1). forget: the conversation changed, or everything was erased: the handle goes too.
   * @param {string} why @param {{ forget?: boolean }} [o]
   */
  close(why, { forget = false } = {}) {
    if (forget) {
      this.#handle = undefined;
      this.#notes = [];
    }
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.#gen++;
    const s = this.#s;
    this.#s = null;
    if (!forget && s?.handle) this.#handle = s.handle;
    this.#hush();
    s?.close(why);
    this.modelId = null;
    this.c.told('live-closed');
    this.#changed();
  }

  /** Everything of a session stops: the microphone, her voice (its words kept up to there), and the waits. */
  #hush() {
    this.#input?.stop();
    this.#input = null;
    this.listening = false;
    this.voiced = false;
    for (const t of [this.#t, this.#sounding]) if (t) this.#stop(t);
    this.#t = null;
    this.#flushHeard(false);
    this.#hear = null;
    this.#waiting = [];
    this.#rotate = false;
    clearTimeout(this.#quiet);
    this.c.voice?.platform?.session('playback');
  }

  /**
   * A tap on Shiori (spec §10.4): while she speaks, it stops her and listens; while she listens, it closes the session;
   * otherwise, with voice on, it opens one and listens. @returns {'cut' | 'stopped' | 'listening' | 'typing'}
   */
  tap() {
    if (this.#sounding) {
      this.#stop(this.#sounding);
      this.listen();
      return 'cut';
    }
    if (this.listening) {
      this.close('tap');
      return 'stopped';
    }
    if (!this.c.voice?.on) return 'typing';
    this.open('tap', { mic: true });
    return 'listening';
  }

  /** Her voice stops now; the session stays. */
  interrupt() {
    if (this.#sounding) this.#stop(this.#sounding);
  }

  /**
   * What the user typed or sent (written first, so Kokoro has it at once), as a text turn; photos go first, each a turn
   * that waits for the next. @param {string} text @param {{ photos?: import('../agent/loop.js').SentPhoto[], chose?: boolean }} [o]
   * @returns {Promise<boolean>} false: no session could open, and nothing was sent
   */
  async send(text, { photos = [], chose = false } = {}) {
    const e = await this.c.koe.logUser(text, photos, chose);
    if (!(await this.open('typed'))) return false;
    const rec = (await this.c.llm.config()).models[this.modelId ?? ''];
    const takes = Boolean(rec && modelOf(rec).input.includes('image'));
    const images = e.data.images ?? [];
    for (const im of takes ? images : []) {
      const bytes = await blobBytes(this.c.store, im.hash);
      if (bytes) this.#send((s) => s.image({ mediaType: im.mediaType, data: toBase64(bytes) }));
    }
    const words = String(text ?? '').trim();
    this.#text(chose ? `[the user chose] ${theirs(JSON.stringify(words))}`
      : images.length && (!words || words === '(a photo)') ? (takes ? '[the user sent a photo]' : '[the user sent a photo; Kokoro sees it]') : theirs(words));
    return true;
  }

  /** A wake Koe answers (a trigger, the recap asked aloud), as a text turn from annai. @param {import('../agent/loop.js').Wake} w */
  async wake(w) {
    const text = `[annai] ${escapeTags(JSON.stringify(String(w.text ?? '')))}`;
    if (!this.c.visible()) return this.#hold(text);
    if (!(await this.open(w.kind, { mic: Boolean(this.c.voice?.unlocked) }))) return false;
    this.#text(text);
    return true;
  }

  /** The page is out of view: no session opens, and the words wait for it. @param {string} text @returns {true} */
  #hold(text) {
    this.#notes.push(text);
    return true;
  }

  /**
   * The page is back in view: what waited (a trigger, Kokoro's notes) is said in a session that opens for it, without the
   * microphone: a tap opens that (security review).
   */
  async shown() {
    if (this.#notes.length && (await this.open('shown'))) this.#idle();
  }

  /**
   * A note from Kokoro (decision 14): append waits for Koe's turn to end and its voice to finish; immediate goes at once
   * and cuts Koe off. A note when no session is open opens one first. @param {string} text @param {'append' | 'immediate'} mode
   */
  async note(text, mode) {
    const note = wrapNote(text, this.c.nonce);
    if (!this.c.visible()) return this.#hold(note);
    if (mode === 'immediate') {
      if (!(await this.open('note', { mic: Boolean(this.c.voice?.unlocked) }))) return false;
      this.#text(note, this.#cut());
      return true;
    }
    this.#notes.push(note);
    if (!(await this.open('note', { mic: Boolean(this.c.voice?.unlocked) }))) return false;
    this.#idle();
    return true;
  }

  /** @param {(s: LiveSession) => void} fn */
  #send(fn) {
    if (this.#s && this.state === 'open') fn(this.#s);
    else if (this.#waiting.length < WAITING_MAX) this.#waiting.push(fn);
  }

  /** A text turn: Koe answers it. cut: it cuts Koe off, which was heard this far. @param {string} text @param {{ playedMs?: number }} [cut] */
  #text(text, cut) {
    this.#trail = null;
    this.#poke();
    this.#send((s) => s.text(text, { interrupt: Boolean(cut), ...cut }));
  }

  /** @param {'start' | 'end'} edge */
  #activity(edge) {
    if (!this.c.visible()) return this.close('away'); // a page out of view never streams a sound
    const now = Date.now();
    /** @type {{ playedMs?: number }} */
    let cut = {};
    if (edge === 'start') {
      // The user cut in: her voice stops now; the provider cuts its turn too.
      if (this.#sounding) cut = this.#cut();
      this.#flushHeard(false);
      this.#hear = { id: newId('h'), text: '', at: now, ms: 0, pcm: [], logged: null };
    } else {
      if (this.#hear) this.#hear.ms = now - this.#hear.at;
      this.#trail = null;
    }
    this.#poke();
    this.#send((s) => s.activity(edge, cut));
    this.#changed();
  }

  /** @param {Uint8Array} b */
  #audio(b) {
    if (!this.c.visible()) return this.close('away');
    if (this.#keep && this.#hear) this.#hear.pcm.push(samples(b));
    this.#poke();
    this.#send((s) => s.audio(b));
  }

  /** @param {LiveSession} s @param {import('../llm/contract.js').LiveEvent} e */
  #on(s, e) {
    if (s !== this.#s) return; // a connection being left
    if (e.type !== 'usage' && e.type !== 'resume') this.#poke();
    if (e.type === 'heard') {
      const h = (this.#hear ??= { id: newId('h'), text: '', at: Date.now(), ms: 0, pcm: [], logged: null });
      h.text += e.text;
      if (h.answered) this.#flushHeard(Boolean(h.dismissed)); // the last words can come after Koe's turn: they are added
    } else if (e.type === 'usage') this.#spend();
    else if (e.type === 'goaway') {
      this.#rotate = true;
      this.#idle();
    } else if (e.type === 'turn') {
      if (e.end === 'interrupted') {
        // Cut off: what was said stops where it played; words still coming for it are dropped.
        if (this.#t) this.#stop(this.#t);
        this.#trail = this.#t ?? newTurn();
        this.#trail.cut = true;
        this.#t = null;
      } else this.#complete();
    } else if (e.type === 'tool') this.#tool(s, (this.#t ??= newTurn()), e);
    else if (e.type === 'audio') {
      this.#trail = null;
      const t = (this.#t ??= newTurn());
      t.bytes += e.data.length;
      if (t.stream) t.stream.push(samples(e.data));
      else if (!t.cut) t.held.push(e.data);
    } else if (e.type === 'said' && !this.#t && this.#trail) {
      if (!this.#trail.cut && !this.#trail.logged) this.#trail.said += e.text;
    } else if (e.type === 'said') {
      const t = (this.#t ??= newTurn());
      t.said += e.text;
      if (!t.spoken && realWord(t.said)) this.#speak(t);
    }
    this.#changed();
  }

  /** Koe's first real word: what was heard is written, and its voice starts (decision 11). @param {Turn} t */
  #speak(t) {
    t.spoken = true;
    this.#answered(false);
    const p = this.c.voice?.platform;
    if (this.voiced && p?.player.stream && !t.cut) {
      const v = /** @type {import('../voice/voice.js').Voice} */ (this.c.voice);
      t.stream = p.player.stream({ rate: 24_000, onLevel: (x) => v.level(x, 'her') });
      for (const a of t.held) t.stream.push(samples(a));
      this.#sounding = t;
      t.stream.done.then(({ playedMs }) => this.#said(t, playedMs));
    }
    t.held = [];
  }

  /** The provider's turn is over: her voice plays out, or her words are a bubble; a turn with none is dropped. */
  #complete() {
    const t = this.#t;
    this.#t = null;
    this.#trail = t;
    if (t?.stream) t.stream.end();
    else if (t?.spoken) this.#said(t, null);
    // Heard, and answered by nothing at all: it wasn't meant for Koe (the model's own choice, proactive audio).
    this.#answered(!t?.spoken && !t?.tools);
    this.#idle();
  }

  /** Koe's turn for what was heard has begun, or ended with nothing (dismissed): what was heard is written. @param {boolean} dismissed */
  #answered(dismissed) {
    const h = this.#hear;
    if (h && !h.answered) Object.assign(h, { answered: true, dismissed });
    return this.#flushHeard(dismissed);
  }

  /** Koe was cut off: its voice stops, and its words are kept up to where it was heard. @param {Turn} t @returns {number | undefined} how much of it was heard, in ms */
  #stop(t) {
    t.cut = true;
    if (t.stream) return t.stream.stop().playedMs; // its done writes it
    if (t.spoken) this.#said(t, null);
    return undefined;
  }

  /** Koe's voice stops now, wherever it is; how much of its turn was heard, for a protocol that cuts its record there (OpenAI's truncate). */
  #cut() {
    let playedMs;
    for (const t of [this.#t, this.#sounding]) if (t) playedMs = this.#stop(t) ?? playedMs;
    return playedMs === undefined ? {} : { playedMs };
  }

  /**
   * What Koe said, written once: whole, or cut where its voice stopped (✂). @param {Turn} t @param {number | null} playedMs null: nothing played (muted)
   */
  #said(t, playedMs) {
    if (t.logged) return;
    t.logged = true;
    if (this.#sounding === t) this.#sounding = null;
    let text = cleanSaid(t.said);
    const share = !t.cut || playedMs === null ? 1 : Math.min(1, playedMs / Math.max(1, t.bytes / 48));
    if (share < 1) {
      const end = Math.round(text.length * share);
      const space = text.lastIndexOf(' ', end);
      text = text.slice(0, space > 0 ? space : end).trim();
    }
    if (text && t.cut) text += '✂';
    if (text) this.#write({ type: 'out.speak', actor: 'shiori', data: { id: newId('s'), wake: this.#wake, live: true, ...(t.stream ? { voice: true } : {}), ...(t.cut ? { cut: true } : {}) }, texts: [['text', text]] });
    this.#idle();
    this.#changed();
  }

  /**
   * What the user said, written once its words are known: as Koe answers, or as its turn ends (dismissed when nothing
   * answered it); words that come later are added (heard.text). @param {boolean} dismissed @returns {Promise<unknown>}
   */
  #flushHeard(dismissed) {
    const h = this.#hear;
    const text = h ? cleanSaid(h.text) : '';
    if (!h || !text || text === h.logged) return this.#chain;
    const first = h.logged === null;
    h.logged = text;
    return this.#write(async () => {
      if (!first) return { type: 'heard.text', actor: 'system', data: { of: h.id, wake: this.#wake, text, by: this.modelId } };
      const clip = await this.#clip(h);
      return {
        type: 'heard', actor: 'user', blobs: clip.blobs,
        data: { id: h.id, wake: this.#wake, ms: h.ms, source: 'live', text, ...(dismissed ? { dismissed: true, gate: 'chatter' } : {}), ...clip.data },
      };
    });
  }

  /** Writes in order; an entry may be worked out first. @param {any} ev @returns {Promise<unknown>} */
  #write(ev) {
    this.#chain = this.#chain.then(async () => this.c.koe.log(typeof ev === 'function' ? await ev() : ev)).catch((e) => console.warn('a live line was not written', e));
    return this.#chain;
  }

  /** With "keep voice clips" (spec §10.2), what was said, in the smallest format this phone makes and plays. @param {Hearing} h */
  async #clip(h) {
    const v = this.c.voice;
    if (!h.pcm.length || !v) return { data: {}, blobs: [] };
    const pcm = new Int16Array(h.pcm.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of h.pcm) {
      pcm.set(x, at);
      at += x.length;
    }
    const kept = await v.clipOf(/** @type {any} */ ({ id: h.id, source: 'mic', ms: h.ms, at: h.at, audio: { data: encodeWav(pcm, 16_000), mediaType: 'audio/wav', seconds: pcm.length / 16_000 }, pcm: Promise.resolve({ pcm, rate: 16_000 }) })).catch(() => null);
    if (!kept) return { data: {}, blobs: [] };
    const hash = await sha256Hex(kept.data);
    return { data: { clip: hash, clipFormat: kept.format, clipBytes: kept.data.length }, blobs: [{ hash, bytes: kept.data, type: kept.mediaType }] };
  }

  /**
   * A tool call, answered at once (decision 10): run as Koe's own, with what was heard written first; tell_kokoro, show
   * and ask add no speech. @param {LiveSession} s @param {Turn} t @param {{ id: string, name: string, input: any }} e
   */
  async #tool(s, t, e) {
    t.tools = true;
    this.#tools++;
    try {
      await this.#answered(false);
      const out = await this.c.koe.liveCall(e, this.#wake);
      const silent = SILENT.includes(e.name);
      // Escaped, as a text Koe reads a result: no file can carry a note, nor start a line like annai's.
      if (s === this.#s) s.answer(e.id, e.name, theirs(out.content), { silent });
      // Answered without more speech, a turn of a call alone is over.
      if (silent && this.#t === t && !t.bytes && !t.said) this.#t = null;
    } finally {
      this.#tools--;
      this.#poke();
      this.#changed();
    }
  }

  /** Between turns: Kokoro's append notes go in together, and a session told to go reconnects with its handle. */
  #idle() {
    if (this.busy || !this.#s) return;
    if (this.#notes.length) this.#text(this.#notes.splice(0).join('\n'));
    else if (this.#rotate) this.#reconnect('goaway').then((ok) => { if (!ok) this.#gone(false); });
  }

  /** A new connection with the handle, the conversation going on (GoAway, a drop). @param {string} why @returns {Promise<boolean>} */
  async #reconnect(why) {
    const old = this.#s;
    const gen = this.#gen;
    this.#rotate = false;
    this.#s = null; // what is said meanwhile waits for the new one, speech going on starting again there first
    if (this.#input?.active) this.#waiting.unshift((x) => x.activity('start'));
    const s = await this.#connect(/** @type {string} */ (this.modelId), old?.handle ?? this.#handle, why).catch(() => null);
    old?.close(why);
    if (gen !== this.#gen) {
      s?.close('closed');
      return false;
    }
    this.#poke();
    this.#changed();
    this.#idle();
    return Boolean(s);
  }

  /**
   * A close annai didn't ask for: the lines it cut are kept, marked cut; it resumes with its handle, once, at once; failing
   * that, Halves carries on through Koe's next model. @param {LiveSession} s @param {{ kind: string | null }} c @param {string} why
   */
  async #closed(s, { kind }, why) {
    if (s !== this.#s || !kind) return;
    const cut = Boolean(this.#sounding || this.#t?.spoken);
    for (const t of [this.#t, this.#sounding]) if (t) this.#stop(t);
    this.#t = null;
    // The user's words cut off are kept, marked; what they say next is a line of its own.
    const h = this.#input?.active ? this.#hear : null;
    if (h?.text.trim()) h.text += '✂';
    this.#flushHeard(false);
    if (h) this.#hear = { ...h, id: newId('h'), text: '', at: Date.now(), pcm: [], logged: null };
    if (s.handle) this.#handle = s.handle;
    if (kind !== 'auth' && kind !== 'not-found' && this.#handle && (await this.#reconnect(why))) {
      this.c.llm.bench?.clear(/** @type {string} */ (this.modelId)); // resumed: the close is no reason to rest
      return;
    }
    this.#gone(cut);
  }

  /** It couldn't go on: Halves carries on through Koe's next model. @param {boolean} cut */
  #gone(cut) {
    if (this.state === 'closed') return;
    this.close('dropped');
    this.c.dropped(cut);
  }

  /** Re-arms the quiet spell: no speech either way and no tool call for that long closes the session (decision 12). */
  #poke() {
    clearTimeout(this.#quiet);
    if (this.state === 'closed') return;
    this.#quiet = setTimeout(() => (this.busy ? this.#poke() : this.close('quiet')), this.#quietMs);
  }

  /** Today's spend reached: no session opens, and an open one closes, with the budget card. @returns {Promise<boolean>} */
  async #over() {
    const budgets = await this.c.budgets();
    if (!budgets?.spendPerDay) return false;
    const stop = budgetStop({ budgets: { spendPerDay: budgets.spendPerDay }, steps: 0, spent: await spentToday(this.c.store, Date.now(), this.c.timeZone()) });
    if (stop) this.c.notice({ tone: 'warn', title: stop.title, body: stop.body });
    return Boolean(stop);
  }

  async #spend() {
    if (await this.#over()) this.close('budget');
  }
}

/** @returns {Turn} */
const newTurn = () => ({ said: '', bytes: 0, held: [], stream: null, spoken: false, tools: false, cut: false, logged: false });
