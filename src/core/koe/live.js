import { LiveInput } from '../realtime/input.js';
import { escapeTags, wrapNote, theirs } from '../agent/blocks.js';
import { LABELS, NOTE_UNSAID, isWatched } from '../agent/loop.js';
import { newId } from '../scopes.js';
import { resolveEvent } from '../agent/transcript.js';
import { spentToday, budgetStop } from '../agent/budgets.js';
import { definitions } from '../agent/tools.js';
import { modelOf } from '../llm/config.js';
import { COOLDOWN_MS } from '../llm/fallback.js';

/**
 * Koe live (the Koe and Kokoro design, "Realtime sessions"; spec §10.8): Koe as a realtime voice model, a session at a time,
 * opened and closed as §10.8 says, never by itself.
 * @typedef {import('../realtime/open.js').LiveSession} LiveSession
 * @typedef {import('../agent/loop.js').Wake} Wake
 * @typedef {{ said: string, bytes: number, held: Uint8Array[], stream: import('../voice/platform.js').PlayerStream | null, spoken: boolean, wordAt: number,
 *   tools: boolean, cut: boolean, whole: boolean, logged: boolean, goesOn: boolean, calls: number, done: boolean }} Turn  one of Koe's; held: its sound until a real word;
 *   goesOn: it called a tool it speaks after; calls: its tool calls not answered yet; done: the provider ended it; whole: cut, but all of it was
 *   heard or written
 * @typedef {{ id: string, text: string, at: number, ms: number, pcm: Int16Array[], logged: string | null, answered?: boolean, dismissed?: boolean }} Hearing
 * @typedef {{ koe: import('../agent/loop.js').Agent, llm: any, voice: import('../voice/voice.js').Voice | null, store: import('../types.js').Store,
 *   nonce: string, model: () => string | null, setup: () => Promise<{ instructions: string, context: string }>, visible: () => boolean,
 *   release: () => void, notice: (n: import('../agent/loop.js').Notice) => void, told: (state: 'live-open' | 'live-closed') => void,
 *   dropped: (cut: boolean) => void, changed: () => void, budgets: () => Promise<any>, timeZone: () => string, asked: () => boolean, secondMs?: number,
 *   unsaid: (notes: Wake[]) => void, owed: (notes: Wake[]) => void, left?: (notes: Wake[]) => void, spoke?: () => void }} LiveHost
 *   Halves's: release: the speech pipeline lets go of the voice; asked: Kokoro works on Koe's question; unsaid: Kokoro's notes for the user Koe never
 *   passed on, asked once more; owed: those a session closed on before Koe passed them on, to hand on; left: those a switch to another
 *   conversation leaves, shown there; spoke: the user's spoken turn ended
 */

/** Tool answers that add no speech (decision 10). */
const SILENT = ['tell_kokoro', 'show', 'ask', 'already_told'];
/** The ask once more, as a text Koe's (§6.8), in annai's words. */
const CUE = `[annai] ${escapeTags(JSON.stringify(NOTE_UNSAID))}`;
/** The ask again when the user's turn got no sound and no word (the watchdog, in a session that is alive). */
const UNANSWERED = `[annai] ${escapeTags(JSON.stringify('Nothing you did reached the user after what they said last: answer them aloud.'))}`;
/** Tools that pass a note on to the user, as words do, or settle it as passed on. */
const REACH = ['show', 'ask', 'already_told'];
/** Where her voice doesn't reach the microphone, so speaking may cut her off (spec §10.4): elsewhere, half-duplex. */
const DUPLEX = ['headphones', 'car'];
/** A turn ends once its streamed transcript (heardLive) stops growing this long past the pause, 3 s at least, if the microphone agrees. */
const STALL_MS = 1500;
const STALL_MIN_MS = 3000;
const HEARD_AFTER_MS = 1000;
/**
 * After the user's turn ends (in half-duplex), her answer's voice waits at least this long from that end (mayPlay), the user's pause
 * setting before it: a thinking pause ended the turn, and they may go on. The realtime check (2026-10-22): its pause clip's 1.74 s gap
 * goes on about 1.05 s after the turn's end, and Gemini's first sound came 0.75 to 1.4 s after it (0.9 s, the median): 500 ms and
 * 1 s let one in over the user.
 */
export const HOLD_MS = 1200;
/** Her waiting voice starts once the microphone has been quiet this long, or this much past the wait, whatever it hears. */
const STILL_MS = 100;
const CAP_MS = 1000;

/**
 * Whether her waiting voice may start (half-duplex only): never while speech has begun (held, or a turn: bounded by the turn); else
 * once HOLD_MS have passed since the user's turn ended and the microphone is quiet now (a word's first frames come before the
 * detector is sure of it), or CAP_MS past the later of that and her first word, whatever it hears. In full duplex the user cuts her
 * by speaking, and in a noisy room (frames over the floor that never became speech since the turn ended) a wait would only let the
 * noise's turns cut more answers: she plays at once, as before the wait.
 * @param {{ hearing: boolean, stillMs: number, noisy: boolean } | null} input @param {{ duplex: boolean, sinceEndMs: number, sinceWordMs: number }} o
 */
export function mayPlay(input, { duplex, sinceEndMs, sinceWordMs }) {
  if (!input || duplex || input.noisy) return true;
  if (input.hearing || sinceEndMs < HOLD_MS) return false;
  return input.stillMs >= STILL_MS || Math.min(sinceEndMs - HOLD_MS, sinceWordMs) >= CAP_MS;
}
/** A session that gives nothing back this many seconds after the user's turn or a text turn is silent (the iPhone trace, 2026-10-22). */
const SILENT_S = 8;

/** A realtime model's transcript as annai keeps it: no markup (measured: `<!-- … -->`, `<no speech>`, `{pause}`, even cut off), escaped. @param {string} text */
export const cleanSaid = (text) => escapeTags(String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|\{[^}]*(?:\}|$)/g, ' ').replace(/\s+/g, ' ').trim());
/** Whether a transcript holds a word: a letter or a digit. @param {string} text */
export const realWord = (text) => /[\p{L}\p{N}]/u.test(cleanSaid(text));
/** @param {Uint8Array} b 16-bit PCM */
const samples = (b) => new Int16Array(b.slice(0, b.length & ~1).buffer);
/** @returns {Turn} */
const newTurn = () => ({ said: '', bytes: 0, held: [], stream: null, spoken: false, wordAt: 0, tools: false, cut: false, whole: false, logged: false, goesOn: false, calls: 0, done: false });
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
  /** The user is in this session (they typed, or spoke, or turned it on), so what Koe tells Kokoro is watched (isWatched); a session a trigger opened is not, until they do. */
  #watched = false;
  /** @type {LiveInput | null} */
  #input = null;
  /** Speaking may cut her off now: "Cut her off by speaking" is on, and the microphone in use is headphones' or the car's. */
  #duplex = false;
  /** It follows the audio devices coming and going. */
  #devices = false;
  /** Speech begun over her on the speaker this session, let go; and whether the card saying a tap talks over her was shown. */
  #overs = 0;
  #hinted = false;
  /** Why it closes once Koe's sentence has ended (Auto turned voice off), the microphone closed already. @type {string | null} */
  #closing = null;
  /** A tap opened it to talk: Kokoro's kept notes wait for the user's first turn to end, or 2 s with no speech (review S3). @type {any} */
  #hearFirst = null;
  /** @type {any} */
  #stall = null;
  /** When the user's turn began, and ended; the pause that ends a sentence. */
  #turnAt = 0;
  #endedAt = 0;
  #pauseMs = 700;
  /**
   * Waiting for an answer: to a text turn's words, or the user's turn (null). strict: only sound, a word, or a card or question shown
   * answers (the user's turn, and annai's ask again); tools: tool calls came, and nothing else yet; alive: the session gave something back.
   * @type {{ timer: any, text: string | null, strict: boolean, tools: boolean, alive: boolean } | null}
   */
  #due = null;
  /** A silent session was replaced already, with no answer since: the next silence is only traced. */
  #rescued = false;
  /** Sends waiting for the session to be ready (a tap's first words, a reconnect). @type {((s: LiveSession) => void)[]} */
  #waiting = [];
  /** @type {Hearing | null} */
  #hear = null;
  /** Koe's turn now, the one whose voice plays, and the one just ended (words trailing it are its own, dropped once cut). @type {Turn | null} */
  #t = null;
  /** @type {Turn | null} */
  #sounding = null;
  /** Koe's turn with a word, its voice waiting while the user may still speak (HOLD_MS); and its turns that came after, in order. @type {Turn | null} */
  #pending = null;
  /** @type {Turn[]} */
  #queue = [];
  /** @type {any} */
  #holdTimer = null;
  /** @type {Turn | null} */
  #trail = null;
  /** What waits for Koe's turn and voice to end, or for the page to be in view: Kokoro's other notes, wrapped, and triggers. @type {string[]} */
  #notes = [];
  /**
   * Kokoro's notes for the user (§6.8): waiting to go in, gone in and not passed on, whether Koe was asked once more, and whether
   * that ask waits to go in. @type {{ waiting: Wake[], sent: Wake[], cued: boolean, cue: boolean }}
   */
  #owed = { waiting: [], sent: [], cued: false, cue: false };
  /** @type {any} */
  #quiet = null;
  #quietMs = 30_000;
  /** A session a trigger or a note opened listens only this long after it speaks, as Shiori's speak does (K2), until the user speaks or taps. */
  #answerMs = 8_000;
  #brief = false;
  /** Koe's sound's sample rate, and the microphone's as the session takes it. */
  #rate = 24_000;
  #inRate = 16_000;
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

  /** Kokoro's notes for the user wait for it, or went in and aren't passed on yet. */
  get owing() {
    return this.#owed.waiting.length > 0 || this.#owed.sent.length > 0;
  }

  /** Opening or reconnecting, Koe's turn or voice, a tool, or the user speaking. */
  get busy() {
    return Boolean(this.#opening || this.#t || this.#sounding || this.#pending || this.#queue.length || this.#tools || this.#input?.active || (this.state === 'open' && !this.#s));
  }

  /** The dock's state, as a half's (spec §16.3). @returns {import('../agent/loop.js').State} */
  get view() {
    const name = this.state === 'opening' ? 'thinking' : this.state === 'closed' ? 'sleeping' : this.#sounding ? 'speaking'
      : this.#input?.active ? 'hearing' : this.#t || this.#pending || this.#queue.length ? 'thinking' : this.listening ? 'listening' : 'sleeping';
    return { name, label: LABELS[name] };
  }

  /** Settles once nothing is going on, and all heard and said is written. */
  async idle() {
    while (this.busy) await new Promise((r) => { this.#idlers.push(() => r(undefined)); });
    await this.#chain;
  }

  #changed() {
    if (this.#closing && !this.#sounding && !this.#t && !this.#pending && !this.#queue.length) {
      const why = this.#closing;
      this.#closing = null;
      return this.close(why);
    }
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
    if (ok && this.state === 'open') this.#idle(); // what waited for a session (Kokoro's notes kept at a tap's close) goes in
    return ok;
  }

  get watched() { return this.#watched; }

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
    const s = (await this.#over()) ? null : await this.#resume(id, this.#handle, why).catch(() => { this.c.llm.bench?.bench(id, COOLDOWN_MS); return null; });
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
    this.#rescued = false;
    this.#overs = 0;
    this.c.told('live-open');
    this.#toldOpen = true;
    this.unmute();
    this.#poke();
    this.#arm();
    this.#idle();
    return true;
  }

  /** A connection with the handle, or a fresh one where the provider no longer keeps it (1008): never a rest. @param {string} id @param {string | undefined} handle @param {string} why */
  async #resume(id, handle, why) {
    try {
      return await this.#connect(id, handle, why);
    } catch (e) {
      if (!handle || /** @type {any} */ (e)?.kind !== 'not-found') throw e;
      this.#handle = undefined;
      return this.#connect(id, undefined, why);
    }
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
    this.#arm();
    return s;
  }

  /** An open session's voice plays from now on, where it may. */
  unmute() {
    if (this.state !== 'open') return;
    const v = this.c.voice;
    const was = this.voiced;
    this.voiced = Boolean(v?.on && v.unlocked && this.c.visible() && v.platform?.player.stream);
    if (this.voiced && !was) this.c.release();
    if (this.#input) this.#route(); // the audio may have changed (Halves asks on every change of the voice)
  }

  /** Whether speaking may cut her off, from the microphone in use (§10.4): read after it opens, and when the audio changes. */
  async #route() {
    const v = this.c.voice;
    const input = this.#input;
    if (!v) return;
    const duplex = await Promise.all([v.settings(), v.route()]).then(([{ bargeIn }, route]) => bargeIn && DUPLEX.includes(route), () => false);
    if (this.#input === input) this.#duplex = duplex;
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
    const { pauseMs } = await v.settings();
    this.#pauseMs = pauseMs;
    // A close may have come meanwhile.
    if (this.#input || !this.#s || this.state !== 'open' || !this.c.visible()) return;
    this.unmute();
    this.c.release();
    this.#inRate = this.#s.audioIn.rate; // what is said is kept at it too
    this.#duplex = false; // half-duplex until the microphone in use says otherwise
    if (!this.#devices) {
      this.#devices = true;
      // AirPods taken out: half-duplex at once, before the route is read again (review S1).
      p.onDeviceChange?.(() => {
        if (!this.#input) return;
        this.#duplex = false;
        this.#route();
      });
    }
    this.#input = new LiveInput({
      // Deaf while her sound plays, not while her turn's end is still to come after it (a quick reply then is heard whole).
      mic: p.mic, rate: this.#inRate, pauseMs, speaking: () => Boolean(this.#sounding?.stream?.queued()), duplex: () => this.#duplex, onOver: () => this.#talkedOver(),
      send: { activity: (edge) => this.#activity(edge), audio: (b) => this.#audio(b) }, onLevel: (x) => v.level(x, 'you'), onError: (e) => this.#deaf(e),
      // Each turn's end, why and in numbers only, for the Trace.
      onTurn: (t) => { this.#write({ type: 'live.turn', actor: 'system', data: { wake: this.#wake, ...t } }); },
    });
    this.listening = true;
    p.session('play-and-record');
    this.#changed();
    await this.#input.start().then(() => this.#route(), (e) => this.#deaf(e));
    this.#poke();
  }

  /** Speech begun over her on the speaker was let go: a second time in a session, a quiet card says a tap talks over her, once. */
  #talkedOver() {
    if (++this.#overs < 2 || this.#hinted) return;
    this.#hinted = true;
    this.c.notice({ tone: 'info', title: 'Tap Shiori to talk over her', body: "On the phone's speaker, annai can't hear you while she speaks, so what you say over her is let go. A tap stops her and listens." });
  }

  /** The microphone failed (refused, or taken): a card says why; the session goes on without it. @param {unknown} e */
  #deaf(e) {
    if (!this.#input) return;
    clearTimeout(this.#stall);
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
   * Closes it: the microphone, her voice (its words kept up to there), and playback back at full quality (§10.1). forget:
   * another conversation, or Erase: the handle and what waited go too. @param {string} why @param {{ forget?: boolean }} [o]
   */
  close(why, { forget = false } = {}) {
    // Another conversation: Kokoro's notes it owed are shown in the one left, never lost (review S4).
    if (forget && why === 'switch' && this.owing) this.c.left?.([...this.#owed.sent, ...this.#owed.waiting]);
    this.#closing = null;
    clearTimeout(this.#hearFirst);
    this.#hearFirst = null;
    if (forget) {
      this.#handle = undefined;
      this.#notes = [];
      this.#owed = { waiting: [], sent: [], cued: false, cue: false };
    }
    this.#again();
    // Kokoro's notes it owes: a page out of view has them go in once back (shown()), and the user's tap with the next session (the
    // iPhone trace, 2026-10-22: a tap had annai read one aloud); any other close hands them on (Halves).
    if (why !== 'away' && why !== 'tap' && this.#owed.waiting.length) this.c.owed(this.#owed.waiting.splice(0));
    const was = this.state;
    // The user's turn going on ends first: no session is left waiting for its end.
    if (this.#input?.active) this.#s?.activity('end', {});
    this.#answer(undefined);
    this.state = 'closed';
    this.#watched = false;
    // A microphone is always let go, whatever came before; the user's words it cut off are kept, marked.
    this.#cutHearing();
    const input = this.#input;
    this.#input = null;
    this.listening = false;
    clearTimeout(this.#stall);
    input?.stop();
    this.#old?.close(why); // one being left for a new connection
    this.#old = null;
    if (was === 'closed') return this.#changed();
    this.#gen++;
    const s = this.#s;
    this.#s = null;
    if (!forget && s?.handle) this.#handle = s.handle;
    if (why === 'tap') this.#handle = undefined; // the user stopped it: the next one starts fresh, with the last lines
    this.voiced = this.#rotate = false;
    this.#cut(true);
    this.#t = null;
    this.#flushHeard(false);
    this.#hear = null;
    this.#waiting = [];
    clearTimeout(this.#quiet);
    clearTimeout(this.#holdTimer);
    this.c.voice?.platform?.session('playback');
    s?.close(why);
    this.modelId = null;
    if (this.#toldOpen) this.c.told('live-closed');
    this.#toldOpen = false;
    this.#changed();
  }

  /**
   * Closes once Koe's sentence has ended, whole: the microphone closes now, and nothing more goes in (Auto turning voice off as
   * AirPods come out, review S1). @param {string} why
   */
  closeSoon(why) {
    if (this.state === 'closed' || !(this.#sounding || this.#t || this.#pending)) return this.close(why);
    this.#closing = why;
    const input = this.#input;
    this.#input = null;
    this.listening = false;
    clearTimeout(this.#stall);
    input?.stop();
    if (this.#pending) this.#release(); // nobody can go on now: what waited is said at once
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
    if (this.state === 'closed' && this.#owed.waiting.length) this.#hearFirst = setTimeout(() => this.#heardFirst(), 2 * Math.max(500, this.c.secondMs ?? 1000));
    this.open('tap', { mic: true }).catch(() => {});
    return 'listening';
  }

  /** The user's first turn after a tap ended, or never began: what was kept goes in. */
  #heardFirst() {
    if (!this.#hearFirst) return;
    clearTimeout(this.#hearFirst);
    this.#hearFirst = null;
    this.#idle();
  }

  /** Her voice stops now, and the provider is told where (cut: OpenAI truncates its record there); the session stays. */
  interrupt() {
    if (!this.#sounding) return;
    const playedMs = this.#stop(this.#sounding);
    this.#input?.tapped();
    this.#send((s) => s.cut?.(playedMs));
  }

  /**
   * What the user typed or sent: written first (Kokoro has it at once), then its photos, each a turn that waits, and its words.
   * @param {string} text @param {{ photos?: import('../agent/loop.js').SentPhoto[], chose?: boolean }} [o] @returns {Promise<boolean>} false: no session
   */
  async send(text, { photos = [], chose = false } = {}) {
    this.#brief = false;
    this.#watched = true;
    const e = await this.c.koe.logUser(text, photos, chose);
    if (!(await this.open('typed'))) return false;
    const rec = (await this.c.llm.config()).models[this.modelId ?? ''];
    const takes = Boolean(rec && modelOf(rec).input.includes('image'));
    // The request copies Kokoro gets, as its transcript reads them.
    const { images } = await resolveEvent(this.c.store, e);
    for (const im of takes ? images : []) if (im.type === 'image' && im.data) this.#send((s) => s.image({ mediaType: im.mediaType, data: im.data }));
    const words = String(text ?? '').trim();
    this.#text(chose ? `[the user chose] ${theirs(JSON.stringify(words))}`
      : images.length && (!words || words === '(a photo)') ? `[the user sent a photo${takes ? '' : '; Kokoro sees it'}]` : theirs(words));
    return true;
  }

  /** A wake Koe answers (a trigger, the recap asked aloud), as annai's text turn; not said, its reminders are annai's (Halves). @param {import('../agent/loop.js').Wake} w */
  wake(w) {
    if (isWatched(w)) this.#watched = true;
    return this.#say(`[annai] ${escapeTags(JSON.stringify(String(w.text ?? '')))}`, w.kind);
  }

  /**
   * A note from Kokoro (decision 14): append after Koe's turn and voice; immediate at once, cutting Koe off. One no session could
   * take is let go here: Halves hands it on (false). @param {string} text @param {'append' | 'immediate'} mode
   * @param {Wake | null} [owed] a note for the user, which Koe owes them
   */
  note(text, mode, owed = null) {
    const note = wrapNote(text, this.c.nonce);
    if (mode !== 'immediate' || !this.c.visible()) {
      if (owed) this.#owed.waiting.push(owed);
      else this.#notes.push(note);
      return this.#go('note', () => {
        if (owed) this.#owed.waiting = this.#owed.waiting.filter((w) => w !== owed);
        else this.#notes = this.#notes.filter((x) => x !== note);
      });
    }
    return this.open('note', { mic: Boolean(this.c.voice?.unlocked) }).then((ok) => {
      if (ok) {
        if (owed) this.#went([owed]);
        this.#text(note, this.#cut());
      }
      return ok;
    });
  }

  /** Kokoro's notes for the user went in: Koe's next turns are watched for them. @param {Wake[]} notes */
  #went(notes) {
    this.#owed.sent.push(...notes);
    this.#owed.cued = this.#owed.cue = false;
  }

  /** Koe reached the user since its notes went in (a real word, a card, a question): they are passed on. */
  #passed() {
    this.#owed.sent = [];
    this.#owed.cued = this.#owed.cue = false;
  }

  /**
   * The connection Koe's notes went into is gone (a drop, a GoAway, a close): what it may never have heard goes in again, and a
   * word on the next connection counts only once they have.
   */
  #again() {
    const o = this.#owed;
    o.waiting.unshift(...o.sent.splice(0));
    o.cued = o.cue = false;
  }

  /**
   * A turn ended with Kokoro's notes for the user gone in and not passed on (§6.8, as a text Koe's): Koe is asked once more, in
   * the text cue's words; when its next turn says nothing too, annai shows them. A turn that called a tool it speaks after waits.
   * @param {Turn | null} t
   */
  #settle(t) {
    const o = this.#owed;
    if (!o.sent.length || t?.goesOn) return;
    if (!o.cued) {
      o.cued = o.cue = true;
      return;
    }
    this.c.unsaid(o.sent.splice(0));
    o.cued = false;
  }

  /** Words said once Koe's turn and voice end (#go). @param {string} text @param {string} why @returns {Promise<boolean>} */
  #say(text, why) {
    this.#notes.push(text);
    return this.#go(why, () => { this.#notes = this.#notes.filter((x) => x !== text); });
  }

  /**
   * What waits goes in once Koe's turn and voice end, in a session opened for it that listens after where sound was unlocked;
   * out of view, it waits (shown()). With no session, it is let go here (undo), and Halves hands it on (L3: never twice).
   * @param {string} why @param {() => void} undo @returns {Promise<boolean>} whether it will be said
   */
  async #go(why, undo) {
    if (!this.c.visible()) return true;
    if (this.state === 'closed') this.#brief = true; // nobody asked to talk: it listens for an answer, not the quiet spell
    if ((await this.open(why, { mic: Boolean(this.c.voice?.unlocked) })) && this.state === 'open') {
      this.#idle();
      return true;
    }
    undo();
    return false;
  }

  /** The page is back in view: what waited is said, in a session without the microphone, which a tap opens (security review). */
  async shown() {
    if ((this.#notes.length || this.#owed.waiting.length) && (await this.open('shown'))) this.#idle();
  }

  /** @param {(s: LiveSession) => void} fn */
  #send(fn) {
    if (this.#s && this.state === 'open') fn(this.#s);
    else if (this.#waiting.length < 200) this.#waiting.push(fn); // about 20 s of speech
  }

  /** A text turn, which Koe answers; cut: it cuts Koe off, heard this far; strict: only sound, a word, a card or a question answers it. @param {string} text @param {{ playedMs?: number }} [cut] */
  #text(text, cut, strict = false) {
    this.#trail = null;
    this.#poke();
    this.#send((s) => s.text(text, { interrupt: Boolean(cut), ...cut }));
    this.#answer(text, strict);
  }

  /** Waits for the answer to a text turn (its words) or the user's turn (null); undefined: stops. @param {string | null | undefined} text */
  #answer(text, strict = text === null) {
    clearTimeout(this.#due?.timer);
    this.#due = text === undefined || this.state === 'closed' ? null : { text, timer: null, strict, tools: false, alive: false };
    this.#arm();
  }

  /** The wait runs only on a connection that is ready and not being left; one being made arms it once ready. */
  #arm() {
    const due = this.#due;
    const s = this.#s;
    if (!due || due.timer || !s || this.#old || this.state !== 'open') return;
    due.timer = setTimeout(() => this.#silent(s), SILENT_S * Math.max(125, this.c.secondMs ?? 1000));
  }

  /** The connection goes (a drop, a GoAway): the wait holds until the next is ready. */
  #hold() {
    clearTimeout(this.#due?.timer);
    if (this.#due) this.#due.timer = null;
    clearTimeout(this.#stall);
  }

  /**
   * No answer in SILENT_S: while Kokoro works on Koe's question, or a tool call runs, the wait goes on. Else traced, and once, the
   * session is asked again in annai's words where it gave something back (a tool call alone), or a fresh session gets the words
   * where it gave nothing (a session gone silent); silent again, Koe's next model answers. @param {LiveSession} s
   */
  async #silent(s) {
    const due = this.#due;
    if (!due || this.state !== 'open' || s !== this.#s || this.#old) return;
    if (this.c.asked() || this.#tools) {
      due.timer = null;
      return this.#arm();
    }
    this.#due = null;
    const again = !this.#rescued;
    const how = !again ? '' : due.alive ? ': it is asked again' : ': a fresh one gets it again';
    this.#write({ type: 'error', actor: 'system', data: { kind: 'live-silent', message: `The live session gave no answer within ${SILENT_S} seconds${how}.`, quiet: true } });
    // Twice in a row: not a session to keep (its cut flag has Halves give the answer to Koe's next model, or Kokoro).
    if (!again) return this.#gone(true);
    this.#rescued = true;
    if (due.alive) return this.#text(UNANSWERED, undefined, true);
    const heard = cleanSaid(this.#hear?.text ?? '');
    const words = due.text ?? (heard ? theirs(heard) : null);
    if (!(await this.#reconnect('silent', { fresh: true }))) return this.#gone(false);
    if (words) this.#text(words);
  }

  /** @param {'start' | 'end'} edge */
  #activity(edge) {
    if (this.state === 'closed') return;
    if (!this.c.visible()) return this.close('away'); // a page out of view never streams a sound
    /** @type {{ playedMs?: number }} */
    let cut = {};
    clearTimeout(this.#stall);
    if (edge === 'start') {
      this.#answer(undefined); // the user talks again: no answer is waited for while they do
      this.#turnAt = Date.now();
      this.#brief = false; // the user talks: the quiet spell holds
      // The user cut in: her voice stops now, and the provider cuts its turn; one with no word yet too, so it never starts over them.
      if (this.#sounding || this.#t || this.#pending || this.#queue.length) cut = this.#cut();
      this.#flushHeard(false);
      this.#hear = hearing();
    } else {
      if (this.#hear) this.#hear.ms = Date.now() - this.#hear.at;
      this.#trail = null;
      this.#endedAt = Date.now();
    }
    this.#poke();
    this.#send((s) => s.activity(edge, cut));
    this.#changed();
    if (edge === 'end') {
      this.#answer(null);
      this.c.spoke?.(); // what waited for the user's next words goes to Koe with them
      if (this.#hearFirst) this.#heardFirst();
      else this.#idle(); // what waited for the user to finish goes in now, not after Koe's answer
    }
  }

  /** The user's turn ends after ms with no more of its transcript, if the microphone agrees then; else it is asked again. @param {LiveInput} input @param {number} ms */
  #stalls(input, ms) {
    clearTimeout(this.#stall);
    this.#stall = setTimeout(() => {
      if (input !== this.#input || !input.active) return;
      if (input.quietMs >= this.#pauseMs) input.cut('transcript');
      else this.#stalls(input, Math.max(100, this.#pauseMs - input.quietMs));
    }, ms);
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
    if (this.#answers(e)) {
      this.#answer(undefined); // it answers
      this.#rescued = false;
    }
    if (e.type === 'heard') {
      const h = (this.#hear ??= hearing());
      h.text += e.text;
      if (this.#input?.active && e.text && s.heardLive && Date.now() - this.#turnAt >= HEARD_AFTER_MS) this.#stalls(this.#input, Math.max(STALL_MIN_MS, this.#pauseMs + STALL_MS));
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

  /**
   * Whether it answers: a text turn, anything; the user's, sound or a word, a card or question shown (#tool), or an empty turn (not
   * meant for Shiori), never other tool calls alone (already_told left a "yes" in silence: the realtime check, 2026-10-22).
   * @param {import('../llm/contract.js').LiveEvent} e
   */
  #answers(e) {
    const due = this.#due;
    if (e.type === 'audio' || (e.type === 'said' && realWord(e.text))) return true;
    if (e.type !== 'tool' && e.type !== 'turn') return false;
    if (due) due.alive = true; // the model answers something: a session to ask again, not to replace
    if (!due?.strict) return true;
    if (e.type === 'tool') due.tools = true;
    return e.type === 'turn' && !due.tools && due.text === null;
  }

  /** Koe's first real word: what was heard is written, and its voice starts (decision 11), once the user may have stopped. @param {Turn} t */
  #speak(t) {
    t.spoken = true;
    t.wordAt = Date.now();
    this.#answered(false);
    if (this.#pending || this.#sounding) return void this.#queue.push(t); // after the one before it
    if (t.cut || this.#mayPlay(t)) return this.#play(t);
    this.#pending = t;
    this.#later();
  }

  /** @param {Turn} t */
  #mayPlay(t) {
    const now = Date.now();
    return mayPlay(this.#input, { duplex: this.#duplex, sinceEndMs: now - this.#endedAt, sinceWordMs: now - t.wordAt });
  }

  /** Her waiting voice starts once it may; speech the user began meanwhile starts their turn, which cuts it (#activity). */
  #later() {
    clearTimeout(this.#holdTimer);
    this.#holdTimer = setTimeout(() => {
      if (!this.#pending) return;
      if (this.#sounding || !this.#mayPlay(this.#pending)) return this.#later();
      this.#release();
    }, Math.max(50, this.#endedAt + HOLD_MS - Date.now()));
  }

  /** What waited plays now. */
  #release() {
    clearTimeout(this.#holdTimer);
    const t = this.#pending;
    this.#pending = null;
    if (t) this.#play(t);
    this.#changed();
  }

  /** The turn after the one just said, if one came meanwhile, as its first word would have. */
  #next() {
    const t = this.#queue.shift();
    if (!t) return;
    if (t.cut || this.#mayPlay(t)) return this.#play(t);
    this.#pending = t;
    this.#later();
  }

  /** @param {Turn} t */
  #play(t) {
    if (!t.cut) this.#passed();
    this.unmute(); // a tap may have unlocked sound since the session opened
    const v = this.c.voice;
    if (this.voiced && v?.platform?.player.stream && !t.cut) {
      t.stream = v.platform.player.stream({ rate: this.#rate, onLevel: (x) => v.level(x, 'her') });
      for (const a of t.held) t.stream.push(samples(a));
      this.#sounding = t;
      t.stream.done.then(({ playedMs }) => this.#said(t, playedMs));
      if (t.done) t.stream.end();
    } else if (t.done) this.#said(t, null);
    t.held = [];
  }

  /** The provider's turn ended: her voice plays out, or her words are a bubble; a turn with no real word is dropped. */
  #complete() {
    const t = (this.#trail = this.#t);
    this.#t = null;
    this.#tries = 0;
    if (t?.stream) t.stream.end();
    else if (t?.spoken && !this.#waits(t)) this.#said(t, null);
    // Heard, and answered by nothing at all: not meant for Koe (the model's own choice, proactive audio).
    this.#answered(!t?.spoken && !t?.tools);
    if (t) t.done = true;
    if (!t?.calls) this.#settle(t); // else once its calls are answered: a refused show passes nothing on
    this.#idle();
  }

  /** Koe's turn for what was heard began, or ended with nothing (dismissed): it is written. @param {boolean} dismissed */
  #answered(dismissed) {
    const h = this.#hear;
    if (h && !h.answered) Object.assign(h, { answered: true, dismissed });
    return this.#flushHeard(dismissed);
  }

  /** Its voice waits: to start, or behind another of hers. @param {Turn} t */
  #waits(t) {
    return t === this.#pending || this.#queue.includes(t);
  }

  /**
   * Koe cut off: its voice stops, its words kept up to where they were heard; one all of whose sound had played is whole. One still
   * waiting was never heard: let go by the user going on, or, shown, written as her answer (a close or a drop: never an answer lost).
   * @param {Turn} t @param {boolean} [shown] @returns {number | undefined} ms heard
   */
  #stop(t, shown = false) {
    if (t.stream && !t.cut) t.whole = !t.stream.queued();
    t.cut = true;
    if (t.stream) return t.stream.stop().playedMs; // its done writes it
    if (this.#waits(t)) {
      t.whole = t.done;
      this.#said(t, shown ? null : 0);
      return 0;
    }
    if (t.spoken) this.#said(t, null);
    return undefined;
  }

  /** Koe's voice stops wherever it is; how much of its turn was heard, for a protocol that cuts its record there (OpenAI's truncate). @param {boolean} [shown] what waited is written */
  #cut(shown = false) {
    const waiting = [this.#pending, ...this.#queue].filter((t) => t !== null);
    this.#pending = null; // none of them plays meanwhile
    this.#queue = [];
    clearTimeout(this.#holdTimer);
    let playedMs = waiting.length ? 0 : undefined;
    for (const t of [this.#t, this.#sounding]) if (t && !waiting.includes(t)) playedMs = this.#stop(t) ?? playedMs;
    for (const t of waiting) {
      Object.assign(t, { cut: true, whole: t.done });
      this.#said(t, shown ? null : 0);
    }
    return playedMs === undefined ? {} : { playedMs };
  }

  /** What Koe said, written once: whole, or cut where its voice stopped (✂). @param {Turn} t @param {number | null} playedMs null: none played */
  #said(t, playedMs) {
    if (t.logged) return;
    t.logged = true;
    const next = this.#sounding === t || this.#pending === t;
    if (this.#sounding === t) this.#sounding = null;
    if (this.#pending === t) this.#pending = null;
    this.#queue = this.#queue.filter((x) => x !== t);
    let text = cleanSaid(t.said);
    const share = !t.cut || playedMs === null ? 1 : Math.min(1, playedMs / Math.max(1, t.bytes / (this.#rate / 500))); // 2 bytes a sample
    if (share < 1) {
      const end = Math.round(text.length * share);
      const space = text.lastIndexOf(' ', end);
      text = text.slice(0, space > 0 ? space : end).trim();
    }
    const cut = t.cut && !t.whole;
    if (text && cut) text += '✂';
    if (text) this.#write({ type: 'out.speak', actor: 'shiori', data: { id: newId('s'), wake: this.#wake, live: true, ...(t.stream ? { voice: true } : {}), ...(cut ? { cut: true } : {}) }, texts: [['text', text]] });
    if (next) this.#next();
    this.#idle();
    this.#changed();
  }

  /**
   * What the user said, written once its words are known: as Koe answers, or its turn ends (dismissed: unanswered); later
   * words are added (heard.text). @param {boolean} dismissed @returns {Promise<unknown>}
   */
  #flushHeard(dismissed) {
    const h = this.#hear;
    const text = h ? cleanSaid(h.text) : '';
    if (!h || !text || text === h.logged) return this.#chain;
    const first = h.logged === null;
    h.logged = text;
    if (first && !dismissed) this.#watched = true;
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

  /** With "keep voice clips" (§10.2), what was said, as any heard sound is kept. @param {Hearing} h */
  #clip(h) {
    const pcm = new Int16Array(h.pcm.reduce((n, x) => n + x.length, 0));
    h.pcm.reduce((at, x) => (pcm.set(x, at), at + x.length), 0);
    return pcm.length && this.c.voice ? this.c.voice.keep({ id: h.id, pcm, rate: this.#inRate }) : { data: {}, blobs: [] };
  }

  /**
   * A tool call, answered at once (decision 10) as Koe's own, what was heard written first, its result escaped as a text
   * Koe's is. @param {LiveSession} s @param {Turn} t @param {{ id: string, name: string, input: any }} e
   */
  async #tool(s, t, e) {
    t.tools = true;
    if (!REACH.includes(e.name) && !SILENT.includes(e.name)) t.goesOn = true;
    t.calls++;
    this.#tools++;
    try {
      await this.#answered(false);
      // Always answered: the model waits for it.
      const out = await this.c.koe.liveCall(e, this.#wake, this.#watched).catch((err) => ({ content: `Error: ${err?.message ?? err}`, isError: true }));
      // A card or question annai showed passes Kokoro's notes on, and answers the user; one it refused does neither.
      if (REACH.includes(e.name) && !out.isError) this.#passed();
      if ((e.name === 'show' || e.name === 'ask') && !out.isError && this.#due?.strict) this.#answer(undefined);
      const silent = SILENT.includes(e.name);
      const answer = (/** @type {LiveSession} */ x) => x.answer(e.id, e.name, theirs(out.content), { silent });
      // To its session, or to the one that resumed it with the handle, which carries the call; a fresh one never saw it.
      if (s === this.#s) answer(s);
      else if (this.state === 'open' && this.#handle) this.#send(answer);
      if (silent && this.#t === t && !t.bytes && !t.said) this.#t = null; // a turn of a call alone, answered silently, is over
    } finally {
      t.calls--;
      this.#tools--;
      if (t.done && !t.calls) this.#settle(t);
      this.#poke();
      this.#changed();
      this.#idle(); // what waited for the call goes in now
    }
  }

  /**
   * Between turns: what waits goes in, together, Kokoro's notes and the ask once more among it; a session told to go (GoAway)
   * reconnects with its handle first, as what goes into it now would be answered there and lost.
   */
  #idle() {
    if (this.busy || !this.#s || this.#closing) return;
    if (this.#rotate) return void this.#reconnect('goaway').then((ok) => { if (!ok) this.#gone(false); });
    const o = this.#owed;
    const kept = this.#hearFirst ? [] : o.waiting;
    const text = [...this.#notes.splice(0), ...kept.map((w) => wrapNote(String(w.note ?? ''), this.c.nonce)), ...(o.cue ? [CUE] : [])];
    if (!text.length) return;
    o.cue = false;
    if (kept.length) this.#went(o.waiting.splice(0));
    this.#text(text.join('\n'));
  }

  /** A new connection with the handle (fresh: without), the conversation going on. @param {string} why @param {{ fresh?: boolean }} [o] @returns {Promise<boolean>} */
  async #reconnect(why, { fresh = false } = {}) {
    this.#again();
    this.#hold();
    if (fresh) this.#handle = undefined;
    const old = (this.#old = this.#s);
    const gen = this.#gen;
    this.#rotate = false;
    this.#s = null; // what is said meanwhile waits for the new one, speech going on starting again there first
    if (this.#input?.active) this.#waiting.unshift((x) => x.activity('start'));
    const s = await this.#resume(/** @type {string} */ (this.modelId), fresh ? undefined : old?.handle ?? this.#handle, why).catch(() => null);
    old?.close(why);
    this.#old = null;
    if (gen !== this.#gen) {
      s?.close('closed');
      return false;
    }
    this.#poke();
    this.#changed();
    this.#arm();
    this.#idle();
    return Boolean(s);
  }

  /**
   * A close annai didn't ask for: what it cut is kept, marked ✂, and it connects again, with its handle where it has one
   * (else fresh), three times at most with no turn between, waiting longer each time; then Halves goes on without it.
   * @param {LiveSession} s @param {{ kind: string | null }} c @param {string} why
   */
  async #closed(s, { kind }, why) {
    if (s !== this.#s || !kind) return;
    this.#hold();
    const cut = Boolean(this.#sounding || this.#t?.spoken || this.#pending);
    this.#cut(true);
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
    // Kokoro working on Koe's question isn't quiet: its answer is coming.
    if (this.state !== 'closed') this.#quiet = setTimeout(() => (this.busy || this.c.asked() ? this.#poke() : this.close('quiet')), this.#brief ? this.#answerMs : this.#quietMs);
  }

  /** Today's spend reached (Spend per day): none opens, and one open closes, with the budget card. @returns {Promise<boolean>} */
  async #over() {
    const { spendPerDay } = (await this.c.budgets()) ?? {};
    const stop = spendPerDay ? budgetStop({ budgets: { spendPerDay }, steps: 0, spent: await spentToday(this.c.store, Date.now(), this.c.timeZone()) }) : null;
    if (stop) this.c.notice({ tone: 'warn', title: stop.title, body: stop.body });
    return Boolean(stop);
  }
}
