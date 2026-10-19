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
 * Koe live (the Koe and Kokoro design, "Realtime sessions"; plan K5): Koe as a realtime voice model, a session at a time.
 * It opens on a tap, a typed message, or a trigger or note to say, never by itself, and closes on voice off, a conversation
 * switch, the page going, Erase or a quiet spell. The microphone streams only speech; Koe's voice plays from its first
 * real word; what was heard and said is logged per turn, cut where it was heard, cleaned and escaped. Tools answer at once,
 * Kokoro's notes go in as marked text turns, and a drop resumes with the handle, once, else Halves goes on without it.
 * @typedef {import('../realtime/open.js').LiveSession} LiveSession
 * @typedef {{ said: string, bytes: number, held: Uint8Array[], stream: import('../voice/platform.js').PlayerStream | null, spoken: boolean,
 *   tools: boolean, cut: boolean, logged: boolean }} Turn  one of Koe's: its words, its sound (held until a real word), how it ended
 * @typedef {{ id: string, text: string, at: number, ms: number, pcm: Int16Array[], logged: string | null, answered?: boolean, dismissed?: boolean }} Hearing
 *   what the user said; answered: Koe's turn for it began, or ended (dismissed: with nothing)
 * @typedef {{ koe: import('../agent/loop.js').Agent, llm: any, voice: import('../voice/voice.js').Voice | null, store: import('../types.js').Store,
 *   nonce: string, model: () => string | null, setup: () => Promise<{ instructions: string, context: string }>, visible: () => boolean,
 *   release: () => void, notice: (n: import('../agent/loop.js').Notice) => void, told: (state: 'live-open' | 'live-closed') => void,
 *   dropped: (cut: boolean) => void, changed: () => void, budgets: () => Promise<any>, timeZone: () => string, secondMs?: number }} LiveHost
 *   what Halves gives it: model, the realtime model of Koe's pathway; release: the speech pipeline lets go of the microphone and speaker;
 *   told: Kokoro's block; dropped: it couldn't resume (cut: mid-sentence)
 */

/** Tool answers that add no speech (decision 10). */
const SILENT = ['tell_kokoro', 'show', 'ask'];

/** A realtime model's transcript as annai keeps it: no markup (measured: `<!-- … -->`, `<no speech>`, `{pause}`, even cut off), escaped. @param {string} text */
export const cleanSaid = (text) => escapeTags(String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|\{[^}]*(?:\}|$)/g, ' ').replace(/\s+/g, ' ').trim());
/** Whether a transcript holds a word: a letter or a digit. @param {string} text */
export const realWord = (text) => /[\p{L}\p{N}]/u.test(cleanSaid(text));
/** Words not annai's, as Koe reads them: no tag, and no line that starts like one of annai's labels. @param {string} text */
const theirs = (text) => escapeTags(text).replace(/^(\s*)\[/gm, '$1\\[');
/** @param {Uint8Array} b 16-bit PCM */
const samples = (b) => new Int16Array(b.slice(0, b.length & ~1).buffer);
/** @returns {Turn} */
const newTurn = () => ({ said: '', bytes: 0, held: [], stream: null, spoken: false, tools: false, cut: false, logged: false });
/** @returns {Hearing} */
const hearing = () => ({ id: newId('h'), text: '', at: Date.now(), ms: 0, pcm: [], logged: null });

export class LiveKoe {
  /** @type {'closed' | 'opening' | 'open'} */
  state = 'closed';
  /** The microphone is open: what is said streams to the provider (the chip says so). */
  listening = false;
  /** Koe's voice plays (voice on, sound unlocked, the page in view); else its words are bubbles. */
  voiced = false;
  /** @type {string | null} */
  modelId = null;
  /** @type {LiveSession | null} */
  #s = null;
  /** The resume handle, in memory only (decision 28). @type {string | undefined} */
  #handle;
  #wake = '';
  /** @type {LiveInput | null} */
  #input = null;
  /** Sends waiting for the session to be ready (a tap's first words, a reconnect). @type {((s: LiveSession) => void)[]} */
  #waiting = [];
  /** @type {Hearing | null} */
  #hear = null;
  /** Koe's turn now, the one whose voice plays, and the one just ended (words trailing it are its own, dropped once cut). @type {Turn | null} */
  #t = null;
  /** @type {Turn | null} */
  #sounding = null;
  /** @type {Turn | null} */
  #trail = null;
  /** What waits for Koe's turn and voice to end, or for the page to be in view: Kokoro's notes, wrapped, and triggers. @type {string[]} */
  #notes = [];
  /** @type {any} */
  #quiet = null;
  #quietMs = 30_000;
  /** A session a trigger or a note opened listens only this long after it speaks, as Shiori's speak does (K2), until the user speaks or taps. */
  #answerMs = 8_000;
  #brief = false;
  /** Koe's sound's sample rate. */
  #rate = 24_000;
  #keep = false;
  #rotate = false;
  #tools = 0;
  /** Connections tried again since Koe's last turn ended. */
  #tries = 0;
  /** Kokoro was told it opened. */
  #toldOpen = false;
  /** The connection being left for a new one. @type {LiveSession | null} */
  #old = null;
  /** Each open or close: an opening that outlived it is let go. */
  #gen = 0;
  /** @type {Promise<boolean> | null} */
  #opening = null;
  /** @type {Promise<void> | null} */
  #listening = null;
  /** What it writes, in order. @type {Promise<unknown>} */
  #chain = Promise.resolve();
  /** @type {(() => void)[]} */
  #idlers = [];

  /** @param {LiveHost} c */
  constructor(c) {
    this.c = c;
  }

  /** Opening or reconnecting, Koe's turn or voice, a tool, or the user speaking. */
  get busy() {
    return Boolean(this.#opening || this.#t || this.#sounding || this.#tools || this.#input?.active || (this.state === 'open' && !this.#s));
  }

  /** The dock's state, as a half's (spec §16.3). @returns {import('../agent/loop.js').State} */
  get view() {
    const name = this.state === 'opening' ? 'thinking' : this.state === 'closed' ? 'sleeping' : this.#sounding ? 'speaking'
      : this.#input?.active ? 'hearing' : this.#t ? 'thinking' : this.listening ? 'listening' : 'sleeping';
    return { name, label: LABELS[name] };
  }

  /** Settles once nothing is going on, and all heard and said is written. */
  async idle() {
    while (this.busy) await new Promise((r) => { this.#idlers.push(() => r(undefined)); });
    await this.#chain;
  }

  #changed() {
    if (!this.busy) for (const fn of this.#idlers.splice(0)) fn();
    this.c.changed();
  }

  /**
   * Opens a session, or keeps the one open. mic: the microphone too, where voice is on and the page in view.
   * @param {string} why @param {{ mic?: boolean }} [o] @returns {Promise<boolean>} whether one is open
   */
  async open(why, { mic = false } = {}) {
    if (this.state !== 'open') {
      this.#opening ??= this.#start(why).finally(() => {
        this.#opening = null;
        this.#changed();
      });
    }
    const ok = this.#opening ? await this.#opening : this.state === 'open';
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
    await this.c.koe.opening.catch(() => {}); // its lines go into Koe's conversation
    // One that can't open rests its model, as a failed call's does: Koe's next model answers meanwhile.
    const s = (await this.#over()) ? null : await this.#connect(id, this.#handle, why).catch(() => { this.c.llm.bench?.bench(id, COOLDOWN_MS); return null; });
    if (gen !== this.#gen || !s) {
      s?.close('closed');
      if (gen === this.#gen) this.state = 'closed';
      return false;
    }
    const settings = await this.c.voice?.settings();
    this.#quietMs = (settings?.closeAfterSeconds ?? 30) * (this.c.secondMs ?? 1000);
    this.#answerMs = (settings?.silenceSeconds ?? 8) * (this.c.secondMs ?? 1000);
    this.#keep = Boolean(settings?.keepClips);
    this.modelId = id;
    this.state = 'open';
    this.c.told('live-open');
    this.#toldOpen = true;
    this.unmute();
    this.#poke();
    this.#idle();
    return true;
  }

  /** One connection, ready, its events handled while it is the session's. @param {string} id @param {string | undefined} resume @param {string} why @returns {Promise<LiveSession>} */
  async #connect(id, resume, why) {
    const { instructions, context } = await this.c.setup();
    const tools = definitions(await this.c.koe.liveTools());
    this.#wake = newId('w');
    const s = await this.c.llm.live(id, { instructions, context, tools, ...(resume ? { resume } : {}) }, { scope: this.c.koe.scope, wake: this.#wake });
    s.on((e) => this.#on(s, e));
    s.closed.then((c) => this.#closed(s, c, why));
    await s.ready;
    this.#s = s;
    this.#rate = s.audioOut.rate;
    for (const fn of this.#waiting.splice(0)) fn(s);
    return s;
  }

  /** An open session's voice plays from now on, where it may. */
  unmute() {
    if (this.state !== 'open') return;
    const v = this.c.voice;
    const was = this.voiced;
    this.voiced = Boolean(v?.on && v.unlocked && this.c.visible() && v.platform?.player.stream);
    if (this.voiced && !was) this.c.release();
  }

  /** The microphone opens on the open session; what is said streams live, only while someone speaks. */
  listen() {
    // One at a time: two in flight would open two microphones (review).
    return (this.#listening ??= this.#listen().finally(() => { this.#listening = null; }));
  }

  async #listen() {
    const v = this.c.voice;
    const p = v?.platform;
    if (this.#input || !this.#s || !p || !v.on || !this.c.visible()) return;
    const { pauseMs, bargeIn } = await v.settings();
    // A close may have come meanwhile.
    if (this.#input || !this.#s || this.state !== 'open' || !this.c.visible()) return;
    this.unmute();
    this.c.release();
    this.#input = new LiveInput({
      mic: p.mic, rate: this.#s.audioIn.rate, pauseMs, bargeInDb: bargeIn ? 6 : Infinity, speaking: () => Boolean(this.#sounding),
      send: { activity: (edge) => this.#activity(edge), audio: (b) => this.#audio(b) }, onLevel: (x) => v.level(x, 'you'), onError: (e) => this.#deaf(e),
    });
    this.listening = true;
    p.session('play-and-record');
    this.#changed();
    await this.#input.start().catch((e) => this.#deaf(e));
    this.#poke();
  }

  /** The microphone failed (refused, or taken): a card says why; the session goes on without it. @param {unknown} e */
  #deaf(e) {
    if (!this.#input) return;
    this.#input.stop();
    this.#input = null;
    this.listening = false;
    this.c.voice?.platform?.session('playback');
    const p = this.c.voice?.problem(e) ?? { title: 'Listening stopped', body: String(e) };
    this.c.notice({ tone: 'warn', title: p.title, body: p.body });
    this.#changed();
    this.#idle();
  }

  /**
   * Closes it: the microphone closes, her voice stops (its words kept up to there), full-quality playback comes back (§10.1).
   * forget: another conversation, or Erase: the handle and what waited go too. @param {string} why @param {{ forget?: boolean }} [o]
   */
  close(why, { forget = false } = {}) {
    if (forget) {
      this.#handle = undefined;
      this.#notes = [];
    }
    const was = this.state;
    this.state = 'closed';
    // A microphone is always let go, whatever came before; the user's words it cut off are kept, marked.
    this.#cutHearing();
    const input = this.#input;
    this.#input = null;
    this.listening = false;
    input?.stop();
    this.#old?.close(why); // one being left for a new connection
    this.#old = null;
    if (was === 'closed') return this.#changed();
    this.#gen++;
    const s = this.#s;
    this.#s = null;
    if (!forget && s?.handle) this.#handle = s.handle;
    this.voiced = this.#rotate = false;
    this.#cut();
    this.#t = null;
    this.#flushHeard(false);
    this.#hear = null;
    this.#waiting = [];
    clearTimeout(this.#quiet);
    this.c.voice?.platform?.session('playback');
    s?.close(why);
    this.modelId = null;
    if (this.#toldOpen) this.c.told('live-closed');
    this.#toldOpen = false;
    this.#changed();
  }

  /** A tap on Shiori (§10.4): while she speaks, stops her and listens; while she listens, closes; else, with voice on, opens and listens. */
  tap() {
    if (this.#sounding) {
      this.interrupt();
      this.listen();
      return 'cut';
    }
    if (this.listening) {
      this.close('tap');
      return 'stopped';
    }
    this.#brief = false;
    if (!this.c.voice?.on) return 'typing';
    this.open('tap', { mic: true }).catch(() => {});
    return 'listening';
  }

  /** Her voice stops now, and the provider is told where (cut: OpenAI truncates its record there); the session stays. */
  interrupt() {
    if (!this.#sounding) return;
    const playedMs = this.#stop(this.#sounding);
    this.#send((s) => s.cut?.(playedMs));
  }

  /**
   * What the user typed or sent: written first (so Kokoro has it at once), then a text turn, after its photos, each a turn
   * that waits for the next. @param {string} text @param {{ photos?: import('../agent/loop.js').SentPhoto[], chose?: boolean }} [o]
   * @returns {Promise<boolean>} false: no session could open
   */
  async send(text, { photos = [], chose = false } = {}) {
    this.#brief = false;
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
      : images.length && (!words || words === '(a photo)') ? `[the user sent a photo${takes ? '' : '; Kokoro sees it'}]` : theirs(words));
    return true;
  }

  /** A wake Koe answers (a trigger, the recap asked aloud), as annai's text turn; not said, its reminders are annai's (Halves). @param {import('../agent/loop.js').Wake} w */
  wake(w) {
    return this.#say(`[annai] ${escapeTags(JSON.stringify(String(w.text ?? '')))}`, w.kind, false);
  }

  /**
   * A note from Kokoro (decision 14): append waits for Koe's turn and voice to end; immediate goes at once and cuts Koe off.
   * One that comes while no session is open opens one. @param {string} text @param {'append' | 'immediate'} mode
   */
  note(text, mode) {
    const note = wrapNote(text, this.c.nonce);
    if (mode !== 'immediate' || !this.c.visible()) return this.#say(note, 'note', true);
    return this.open('note', { mic: Boolean(this.c.voice?.unlocked) }).then((ok) => {
      if (ok) this.#text(note, this.#cut());
      return ok;
    });
  }

  /**
   * Words to say once Koe's turn and voice have ended; from a page out of view, nothing opens, and they wait for it
   * (shown()). Otherwise a session opens, and listens after where sound was unlocked. Not said, they wait for the next
   * session where keep (a note), else go. @param {string} text @param {string} why @param {boolean} keep @returns {Promise<boolean>} whether they will be said
   */
  async #say(text, why, keep) {
    this.#notes.push(text);
    if (!this.c.visible()) return true;
    if (this.state === 'closed') this.#brief = true; // nobody asked to talk: it listens for an answer, not the quiet spell
    if ((await this.open(why, { mic: Boolean(this.c.voice?.unlocked) })) && this.state === 'open') {
      this.#idle();
      return true;
    }
    if (!keep) this.#notes = this.#notes.filter((x) => x !== text);
    return false;
  }

  /** The page is back in view: what waited is said, in a session without the microphone, which a tap opens (security review). */
  async shown() {
    if (this.#notes.length && (await this.open('shown'))) this.#idle();
  }

  /** @param {(s: LiveSession) => void} fn */
  #send(fn) {
    if (this.#s && this.state === 'open') fn(this.#s);
    else if (this.#waiting.length < 200) this.#waiting.push(fn); // about 20 s of speech
  }

  /** A text turn, which Koe answers; cut: it cuts Koe off, heard this far. @param {string} text @param {{ playedMs?: number }} [cut] */
  #text(text, cut) {
    this.#trail = null;
    this.#poke();
    this.#send((s) => s.text(text, { interrupt: Boolean(cut), ...cut }));
  }

  /** @param {'start' | 'end'} edge */
  #activity(edge) {
    if (this.state === 'closed') return;
    if (!this.c.visible()) return this.close('away'); // a page out of view never streams a sound
    /** @type {{ playedMs?: number }} */
    let cut = {};
    if (edge === 'start') {
      this.#brief = false; // the user talks: the quiet spell holds
      // The user cut in: her voice stops now, and the provider cuts its turn.
      if (this.#sounding) cut = this.#cut();
      this.#flushHeard(false);
      this.#hear = hearing();
    } else {
      if (this.#hear) this.#hear.ms = Date.now() - this.#hear.at;
      this.#trail = null;
    }
    this.#poke();
    this.#send((s) => s.activity(edge, cut));
    this.#changed();
  }

  /** @param {Uint8Array} b */
  #audio(b) {
    if (this.state === 'closed') return;
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
      const h = (this.#hear ??= hearing());
      h.text += e.text;
      if (h.answered) this.#flushHeard(Boolean(h.dismissed)); // the last words can come after Koe's turn: added
    } else if (e.type === 'usage') this.#over().then((over) => { if (over) this.close('budget'); }, () => {});
    else if (e.type === 'goaway') {
      this.#rotate = true;
      this.#idle();
    } else if (e.type === 'turn' && e.end === 'interrupted') {
      // Cut off: what was said stops where it was heard; words still coming for it are dropped.
      if (this.#t) this.#stop(this.#t);
      this.#trail = this.#t ?? newTurn();
      this.#trail.cut = true;
      this.#t = null;
    } else if (e.type === 'turn') this.#complete();
    else if (e.type === 'tool') this.#tool(s, (this.#t ??= newTurn()), e);
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
    this.unmute(); // a tap may have unlocked sound since the session opened
    const v = this.c.voice;
    if (this.voiced && v?.platform?.player.stream && !t.cut) {
      t.stream = v.platform.player.stream({ rate: this.#rate, onLevel: (x) => v.level(x, 'her') });
      for (const a of t.held) t.stream.push(samples(a));
      this.#sounding = t;
      t.stream.done.then(({ playedMs }) => this.#said(t, playedMs));
    }
    t.held = [];
  }

  /** The provider's turn ended: her voice plays out, or her words are a bubble; a turn with no real word is dropped. */
  #complete() {
    const t = (this.#trail = this.#t);
    this.#t = null;
    this.#tries = 0;
    if (t?.stream) t.stream.end();
    else if (t?.spoken) this.#said(t, null);
    // Heard, and answered by nothing at all: not meant for Koe (the model's own choice, proactive audio).
    this.#answered(!t?.spoken && !t?.tools);
    this.#idle();
  }

  /** Koe's turn for what was heard began, or ended with nothing (dismissed): it is written. @param {boolean} dismissed */
  #answered(dismissed) {
    const h = this.#hear;
    if (h && !h.answered) Object.assign(h, { answered: true, dismissed });
    return this.#flushHeard(dismissed);
  }

  /** Koe cut off: its voice stops, its words kept up to where they were heard. @param {Turn} t @returns {number | undefined} ms heard */
  #stop(t) {
    t.cut = true;
    if (t.stream) return t.stream.stop().playedMs; // its done writes it
    if (t.spoken) this.#said(t, null);
    return undefined;
  }

  /** Koe's voice stops wherever it is; how much of its turn was heard, for a protocol that cuts its record there (OpenAI's truncate). */
  #cut() {
    let playedMs;
    for (const t of [this.#t, this.#sounding]) if (t) playedMs = this.#stop(t) ?? playedMs;
    return playedMs === undefined ? {} : { playedMs };
  }

  /** What Koe said, written once: whole, or cut where its voice stopped (✂). @param {Turn} t @param {number | null} playedMs null: none played */
  #said(t, playedMs) {
    if (t.logged) return;
    t.logged = true;
    if (this.#sounding === t) this.#sounding = null;
    let text = cleanSaid(t.said);
    const share = !t.cut || playedMs === null ? 1 : Math.min(1, playedMs / Math.max(1, t.bytes / (this.#rate / 500))); // 2 bytes a sample
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
   * What the user said, written once its words are known: as Koe answers, or its turn ends (dismissed when nothing answered);
   * words that come later are added (heard.text). @param {boolean} dismissed @returns {Promise<unknown>}
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
      return { type: 'heard', actor: 'user', blobs: clip.blobs, data: { id: h.id, wake: this.#wake, ms: h.ms, source: 'live', text, ...(dismissed ? { dismissed: true, gate: 'chatter' } : {}), ...clip.data } };
    });
  }

  /** Writes in order; an entry may be worked out first. @param {any} ev @returns {Promise<unknown>} */
  #write(ev) {
    this.#chain = this.#chain.then(async () => this.c.koe.log(typeof ev === 'function' ? await ev() : ev)).catch((e) => console.warn('a live line was not written', e));
    return this.#chain;
  }

  /** With "keep voice clips" (§10.2), what was said, in the smallest format this phone makes and plays. @param {Hearing} h */
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
   * A tool call, answered at once (decision 10), as Koe's own, with what was heard written first; its result escaped, as a
   * text Koe reads one (no file can carry a note). @param {LiveSession} s @param {Turn} t @param {{ id: string, name: string, input: any }} e
   */
  async #tool(s, t, e) {
    t.tools = true;
    this.#tools++;
    try {
      await this.#answered(false);
      // Always answered: the model waits for it.
      const out = await this.c.koe.liveCall(e, this.#wake).catch((err) => ({ content: `Error: ${err?.message ?? err}` }));
      const silent = SILENT.includes(e.name);
      const answer = (/** @type {LiveSession} */ x) => x.answer(e.id, e.name, theirs(out.content), { silent });
      // To its session, or to the one that resumed it with the handle, which carries the call; a fresh one never saw it.
      if (s === this.#s) answer(s);
      else if (this.state === 'open' && this.#handle) this.#send(answer);
      if (silent && this.#t === t && !t.bytes && !t.said) this.#t = null; // a turn of a call alone, answered silently, is over
    } finally {
      this.#tools--;
      this.#poke();
      this.#changed();
      this.#idle(); // what waited for the call goes in now
    }
  }

  /** Between turns: what waits goes in, together; a session told to go (GoAway) reconnects with its handle. */
  #idle() {
    if (this.busy || !this.#s) return;
    if (this.#notes.length) this.#text(this.#notes.splice(0).join('\n'));
    else if (this.#rotate) this.#reconnect('goaway').then((ok) => { if (!ok) this.#gone(false); });
  }

  /** A new connection with the handle, the conversation going on. @param {string} why @returns {Promise<boolean>} */
  async #reconnect(why) {
    const old = (this.#old = this.#s);
    const gen = this.#gen;
    this.#rotate = false;
    this.#s = null; // what is said meanwhile waits for the new one, speech going on starting again there first
    if (this.#input?.active) this.#waiting.unshift((x) => x.activity('start'));
    const s = await this.#connect(/** @type {string} */ (this.modelId), old?.handle ?? this.#handle, why).catch(() => null);
    old?.close(why);
    this.#old = null;
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
   * A close annai didn't ask for: the lines it cut are kept, marked ✂, and it connects again, with its handle where it has
   * one (OpenAI has none: a fresh session), the model not resting for it. Three tries with no turn between them, waiting
   * longer each time; then Halves goes on without it. @param {LiveSession} s @param {{ kind: string | null }} c @param {string} why
   */
  async #closed(s, { kind }, why) {
    if (s !== this.#s || !kind) return;
    const cut = Boolean(this.#sounding || this.#t?.spoken);
    this.#cut();
    this.#t = null;
    this.#cutHearing();
    if (s.handle) this.#handle = s.handle;
    this.#s = null; // what is said meanwhile waits
    const n = ++this.#tries;
    const gen = this.#gen;
    if (kind !== 'auth' && kind !== 'not-found' && n <= 3) {
      await new Promise((r) => setTimeout(r, (250 * 2 ** (n - 1) * (this.c.secondMs ?? 1000)) / 1000));
      if (gen === this.#gen && (await this.#reconnect(why))) {
        this.c.llm.bench?.clear(/** @type {string} */ (this.modelId));
        return;
      }
    }
    this.#gone(cut);
  }

  /** The user's words cut off as they spoke are kept, marked ✂; what they say next is a line of its own. */
  #cutHearing() {
    const h = this.#input?.active ? this.#hear : null;
    if (h?.text.trim()) h.text += '✂';
    this.#flushHeard(false);
    if (h) this.#hear = hearing();
  }

  /** @param {boolean} cut */
  #gone(cut) {
    if (this.state === 'closed') return;
    this.close('dropped');
    this.c.dropped(cut);
  }

  /** Re-arms the quiet spell: no speech either way and no tool call for that long closes it (decision 12). */
  #poke() {
    clearTimeout(this.#quiet);
    if (this.state !== 'closed') this.#quiet = setTimeout(() => (this.busy ? this.#poke() : this.close('quiet')), this.#brief ? this.#answerMs : this.#quietMs);
  }

  /** Today's spend reached (Spend per day): none opens, and one open closes, with the budget card. @returns {Promise<boolean>} */
  async #over() {
    const { spendPerDay } = (await this.c.budgets()) ?? {};
    const stop = spendPerDay ? budgetStop({ budgets: { spendPerDay }, steps: 0, spent: await spentToday(this.c.store, Date.now(), this.c.timeZone()) }) : null;
    if (stop) this.c.notice({ tone: 'warn', title: stop.title, body: stop.body });
    return Boolean(stop);
  }
}
