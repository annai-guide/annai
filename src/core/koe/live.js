import { LiveInput } from '../realtime/input.js';
import { escapeTags, wrapNote, theirs, koeLine } from '../agent/blocks.js';
import { LABELS, NOTE_UNSAID, isWatched } from '../agent/loop.js';
import { newId, SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { forget } from '../forget.js';
import { resolveEvent } from '../agent/transcript.js';
import { spentToday, budgetStop } from '../agent/budgets.js';
import { definitions } from '../agent/tools.js';
import { modelOf } from '../llm/config.js';
import { COOLDOWN_MS } from '../llm/fallback.js';
import { strayLanguage } from '../languages.js';
import { VoiceLevel } from '../voice/level.js';
import { t } from '../l10n.js';

/**
 * Koe live (the Koe and Kokoro design, "Realtime sessions"; spec §10.8): Koe as a realtime voice model, a session at a time,
 * opened and closed as §10.8 says, never by itself.
 * @typedef {import('../realtime/open.js').LiveSession} LiveSession
 * @typedef {import('../agent/loop.js').Wake} Wake
 * @typedef {{ said: string, bytes: number, held: Uint8Array[], stream: import('../voice/platform.js').PlayerStream | null, spoken: boolean, wordAt: number, soundAt: number, alone?: boolean,
 *   tools: boolean, cut: boolean, whole: boolean, logged: boolean, goesOn: boolean, calls: number, done: boolean, stalled?: boolean, audible?: boolean, endBy?: any }} Turn  one of Koe's; held: its sound until a real word;
 *   stalled: its sound stopped coming out, so its stream was let go, and its words are said by the speech voice;
 *   goesOn: it called a tool it speaks after; calls: its tool calls not answered yet; done: the provider ended it; whole: cut, but all of it was
 *   heard or written; audible: its sound has started playing, so its words may show; endBy: the timer that ends it if no turnComplete comes (#endLater);
 *   soundAt: when its sound began; alone: a call alone, answered silently, which #tool let go of
 * @typedef {{ sent: number, spoke: boolean, timer: any, idle?: boolean }} Mark  an urgent note's (LiveKoe's #urgent); idle: what waited, going in with nothing before it, so its turn is the next to end
 * @typedef {{ text: string, told?: boolean }} Waiting  what waits to go in (LiveKoe's #notes); told: annai's own line, which the log holds none of
 * @typedef {{ text: string, of: object, by: number, more: boolean, timer: any }} Late  the stretch's note waiting (LiveKoe's #late)
 * @typedef {{ id: string, text: string, at: number, ms: number, pcm: Int16Array[], logged: string | null, answered?: boolean, dismissed?: boolean, late?: boolean, own?: boolean, peak?: number, tapped?: boolean }} Hearing
 *   answered: her verdict came (dismissed: answered with nothing); own: its peak was at the user's own level (the level check); peak: its loudest, to learn from if she answers it; tapped: begun in a tap's lift
 * @typedef {{ koe: import('../agent/loop.js').Agent, llm: any, voice: import('../voice/voice.js').Voice | null, store: import('../types.js').Store,
 *   nonce: string, model: () => string | null, setup: () => Promise<{ instructions: string, context: string, languages?: import('../llm/contract.js').Languages, known?: import('../languages.js').LanguageSettings }>, visible: () => boolean,
 *   release: () => void, notice: (n: import('../agent/loop.js').Notice) => void, told: (state: 'live-open' | 'live-closed') => void,
 *   dropped: (cut: boolean) => void, changed: () => void, budgets: () => Promise<any>, timeZone: () => string, asked: () => boolean, secondMs?: number,
 *   unsaid: (notes: Wake[]) => void, owed: (notes: Wake[]) => void, left?: (notes: Wake[]) => void, spoke?: () => void, ws?: import('../workspace.js').Workspace,
 *   held?: () => Promise<void> | null, voiceOut?: () => Promise<void> | null, saying?: (words: string) => void, noisy?: (heard: string) => void }} LiveHost
 *   Halves's: release: the speech pipeline lets go of the voice; asked: Kokoro works on Koe's question; unsaid: Kokoro's notes for the user Koe never
 *   passed on, asked once more; owed: those a session closed on before Koe passed them on, to hand on; left: those a switch to another
 *   conversation leaves, shown there; spoke: the user's spoken turn ended; ws: where this device keeps that the talk-over card was shown;
 *   held: Start fresh runs, until it settles: a session opens only after it, from the fresh start; voiceOut: annai's other voice is saying something, until it settles
 *   (a reminder finishes first); saying: her words so far, while she speaks
 *   them (the dock's bubble), as the transcript grows; her line is written once, at the end; noisy: sound never stopped
 *   (a user turn that began after the quiet spell ran out was let go), with what was heard: Kokoro decides whether Koe sleeps
 */

/** Tool answers that add no speech (decision 10). */
const SILENT = ['tell_kokoro', 'show', 'ask', 'already_told', 'sleep'];
/** Opens the user asked for: they listen with the quiet spell; any other (a trigger, a note, back in view) listens only briefly. */
const ASKED = ['tap', 'typed'];
/** Closes the user (or Kokoro, through Koe's sleep) asked for: Kokoro's waiting notes go in with the next session, which starts fresh. */
const ASLEEP = ['tap', 'sleep'];
/** The ask once more, as a text Koe's (§6.8), in annai's words. */
const CUE = `[annai] ${escapeTags(JSON.stringify(NOTE_UNSAID))}`;
/** The ask once more when sound cut her off: she has generated the words, and believes she has said them (already_told, in the real model's hands, 2026-11-04). */
/* en */ const CUE_CUT = `[annai] ${escapeTags(JSON.stringify("Sound cut you off, so the user didn't hear what Kokoro's note says. Say it again, without changing what it claims."))}`;
/** The ask again when the user's turn got no sound and no word (the watchdog, in a session that is alive). */
/* en */ const UNANSWERED = `[annai] ${escapeTags(JSON.stringify('Nothing you did reached the user after what they said last: answer them aloud.'))}`;
/** Tools that pass a note on to the user, as words do, or settle it as passed on. */
const REACH = ['show', 'ask', 'already_told'];
/** This device's record of the cards about voice it has shown once. */
const HINTS = '/voice-hints.json';
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
/** The quiet spell ran out on a run the detector still holds: it looks again after this. */
const HELD_LOOK_MS = 250;

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
/** Her voice's stop fades out over 12 ms at most; with the output's latencies and this margin after, it is surely silent. */
const STOP_FADE_MS = 12;
const FADED_MARGIN_MS = 20;
/**
 * Her turn's sound all in, its stream is stopped as stalled this long past its length (a context iOS suspends mid-reply never
 * plays it out, which would leave the microphone deaf and Koe busy until a tap).
 */
const STALL_S = 3;
/** A session that gives nothing back this many seconds after the user's turn or a text turn is silent (the iPhone trace, 2026-10-22). */
const SILENT_S = 8;
/** An urgent note's mark ends this long after it went in if no sound of hers has begun, and this long after it however long she talks. */
const URGENT_S = SILENT_S;
const URGENT_MAX_S = 20;
/**
 * The stretch's note (Kokoro's sleep) waits for her verdict on the user's turn going on, or awaiting her, at most this long after that
 * turn ends: on the real clock, as the provider's verdict comes (talk radio's every verdict lands in its next piece, fix pass 6).
 */
const STRETCH_WAIT_MS = 3000;
/** A user turn that begins this soon after one ended at the cap is the same sound going on, not the user beginning. */
const AFTER_CAP_MS = 500;
/** How long a session a trigger or a note opened listens after it speaks (the second-drive design: not silenceSeconds, as a longer open microphone during music costs more). */
export const LIVE_ANSWER_S = 8;
/** "Ignoring" shows this long past the last frame the minimum kept out, so it doesn't flicker. */
const IGNORING_HOLD_S = 3;
/** How long a tap lifts the level check: for a time, not a turn, as the next lyric would take a turn's lift and leave the soft word out. */
const LIFT_S = LIVE_ANSWER_S;
/**
 * A model that needs a thinking level, which annai deliberately never sends (plugins-official/gemini-live), rests this long: asking again can't help until
 * annai or its plugin changes (the second drive: every reminder tried it first, and lost its moment). Any other refusal of a setup rests as a failure does: it may pass.
 */
export const REFUSED_REST_MS = 6 * 3_600_000;
/** Past the end of her sound, the wait for the turnComplete of a turn whose tool call was answered silently (measured: the design, section 3, item 6). */
const TURN_END_S = 2;

/** A realtime model's transcript as annai keeps it: no markup (measured: `<!-- … -->`, `<no speech>`, `{pause}`, even cut off), escaped. @param {string} text */
export const cleanSaid = (text) => escapeTags(String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|\{[^}]*(?:\}|$)/g, ' ').replace(/\s+/g, ' ').trim());
/** Whether a transcript holds a word: a letter or a digit. @param {string} text */
export const realWord = (text) => /[\p{L}\p{N}]/u.test(cleanSaid(text));
/** @param {Uint8Array} b 16-bit PCM */
const samples = (b) => new Int16Array(b.slice(0, b.length & ~1).buffer);
/** @returns {Turn} */
const newTurn = () => ({ said: '', bytes: 0, held: [], stream: null, spoken: false, wordAt: 0, soundAt: 0, tools: false, cut: false, whole: false, logged: false, goesOn: false, calls: 0, done: false });
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
  /** The setup of the session in use, or of the one a kept handle resumes. @type {{ instructions: string, context: string, tools: string[], after: number } | null} */
  #setUp = null;
  /** The turns annai wrote to the session since that setup which the log holds none of (a reminder's), for What each half sees. @type {{ ts: number, text: string }[]} */
  #told = [];
  #wake = '';
  /** What the user speaks, the browser's language where they chose none (phase 2): a very short transcript in another language is flagged against it. @type {import('../languages.js').LanguageSettings | null} */
  #languages = null;
  /** The user is in this session (they typed, or spoke, or turned it on), so what Koe tells Kokoro is watched (isWatched); a session a trigger opened is not, until they do. */
  #watched = false;
  /** @type {LiveInput | null} */
  #input = null;
  /** Speaking may cut her off now: "Cut her off by speaking" is on, and the microphone in use is headphones' or the car's. */
  #duplex = false;
  /** It follows the audio devices coming and going. */
  #devices = false;
  /** Speech begun over her on the speaker this session, let go; whether the card saying a tap talks over her was shown; the route. */
  #overs = 0;
  #hinted = false;
  #routeName = 'unknown';
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
   * answers (the user's turn, and annai's ask again); tools: tool calls came, and nothing else yet; alive: the session gave something back;
   * told: annai's own lines in that text, sent again where a fresh session gets it again.
   * @type {{ timer: any, text: string | null, strict: boolean, tools: boolean, alive: boolean, told: string[] } | null}
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
  /** Playback back once her stopped voice has faded out (close). @type {any} */
  #toPlayback = null;
  /** @type {Turn | null} */
  #trail = null;
  /** What waits for Koe's turn and voice to end, or for the page to be in view: Kokoro's other notes, wrapped, and triggers. @type {Waiting[]} */
  #notes = [];
  /**
   * Kokoro's note for the stretch of non-stop sound (its sleep), waiting to go in (#sleepy): of: that stretch, nothing once it is over;
   * by: the latest it waits for her verdict (0: not known yet, the user's turn goes on); more: the one wait past it was given.
   * @type {Late | null}
   */
  #late = null;
  /** Why the user's last turn ended (a cap: the next began at once, the same sound). @type {import('../realtime/input.js').TurnEnd | null} */
  #endedBy = null;
  /** The user's latest turn began at once after one that ended at the cap: the same sound going on (steady music), not the user. */
  #afterCap = false;
  /**
   * Kokoro's notes for the user (§6.8): waiting to go in, gone in and not passed on, whether Koe was asked once more, and whether
   * that ask waits to go in; when the last went in, and whether words of hers since were cut off before they were heard (she believes she
   * said them). waiting may hold a trigger with reminders (line: its text turn). @type {{ waiting: (Wake & { line?: string })[], sent: Wake[], cued: boolean, cue: boolean, at: number, cutOff: boolean }}
   */
  #owed = { waiting: [], sent: [], cued: false, cue: false, at: 0, cutOff: false };
  /** @type {any} */
  #quiet = null;
  #quietMs = 30_000;
  /** A session a trigger or a note opened listens only this long after it speaks, as Shiori's speak does (K2), until the user taps or types, or she answers what she heard. */
  #answerMs = LIVE_ANSWER_S * 1000;
  /** That window, in seconds. */
  answerSeconds = LIVE_ANSWER_S;
  #brief = false;
  /** The quiet spell ran out while only the user's turn (or its answer) was pending: her answer re-arms it, a dismissed turn closes. */
  #lapsed = false;
  /**
   * The urgent note (immediate) last come, from the moment it comes until her voice begun after it went in has played out, or a cap
   * passes: URGENT_S from the note if no sound of hers begins, URGENT_MAX_S however long she talks; a tap or a close ends it too (a
   * bound, never matching her turns to the note: no turn end can leave it stuck). Meanwhile the microphone is deaf, so sound the
   * detector takes for speech (music) can't cut her, and what waits holds behind it. sent: when it went in (0: not yet); spoke: her
   * voice begun since has started; timer: the cap now running.
   * @type {Mark | null}
   */
  #urgent = null;
  /**
   * The stretch of sound that never stops Kokoro was told of (once): a real exchange (#exchanged), a close, or its note going in ends
   * it. Its notes go in only while it lasts. @type {object | null}
   */
  #stretch = null;
  /** How loud the user's voice has been lately, across sessions, until the audio route changes (the level check). */
  level = new VoiceLevel();
  /** The room's floor last learned, across sessions, until the audio route changes: a session's first second is judged against it. @type {number | null} */
  #floorDb = null;
  /** The minimum is keeping sound out now: its timer, and the time of the last frame it kept out (the dock shows it: a soft word must not just vanish). @type {{ last: number, timer: any } | null} */
  #ignoring = null;
  /** A tap: no minimum until this time (a tap only opens the microphone, so it can't force a turn); Infinity: until LIFT_S after its microphone opens. */
  #liftBy = 0;
  /** A tap's first answered turn says what the user's voice is now (the level resets once); the tap's later ones add to it. */
  #fresh = false;
  /** A turn was ended without its turnComplete (#endLater): one that comes after all, with no new turn of hers, is that one's. */
  #endedEarly = false;
  /** Turns of hers ended so far (#complete). */
  #ends = 0;
  /** The user's turns ended since this connection last gave anything back: two is a dead session. */
  #noBack = 0;
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
    // Whoever found out (a streaming reminder that stalled): the microphone runs on the same context, so the dock must not say Listening, deaf.
    c.voice?.onSound((stuck) => {
      if (!stuck) return;
      this.#soundStuck();
      this.#changed();
    });
  }

  /** Kokoro's notes for the user wait for it, or went in and aren't passed on yet. */
  get owing() {
    return this.#owed.waiting.length > 0 || this.#owed.sent.length > 0;
  }

  /** Opening or reconnecting, Koe's turn or voice, a tool, or the user speaking. */
  get busy() {
    return this.#hers() || Boolean(this.#input?.active);
  }

  /** What is going on that isn't the user's microphone turn: opening or reconnecting, Koe's turn or voice, a tool. */
  #hers() {
    return Boolean(this.#opening || this.#t || this.#sounding || this.#pending || this.#queue.length || this.#tools || (this.state === 'open' && !this.#s));
  }

  /** The dock's state, as a half's (spec §16.3). @returns {import('../agent/loop.js').State} */
  get view() {
    const name = this.state === 'opening' ? 'thinking' : this.state === 'closed' ? 'sleeping' : this.#sounding ? 'speaking'
      : this.#input?.active ? 'hearing' : this.#t || this.#pending || this.#queue.length || this.#urgent || (this.#input && !this.listening) ? 'thinking' : this.listening ? (this.#ignoring ? 'ignoring' : 'listening') : 'sleeping';
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
      // Nobody asked to talk (a trigger, a note): it listens for an answer, not the quiet spell.
      if (this.state === 'closed' && !this.#opening) this.#brief = !ASKED.includes(why);
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

  /** Kokoro was told of a stretch of sound that never stops, and it goes on: no exchange since, no close. */
  get stretching() { return this.#stretch !== null; }

  /** annai's other voice is saying something (a reminder): nothing of a session's plays or is heard over it. */
  #otherVoice() {
    return Boolean(this.c.voice?.speaker?.speaking);
  }

  /** The minimum kept a frame out: "ignoring" shows, until IGNORING_HOLD_S past the last. */
  #kept() {
    const now = Date.now();
    if (this.#ignoring) {
      this.#ignoring.last = now;
      return;
    }
    const hold = IGNORING_HOLD_S * this.#unit();
    const look = () => {
      const left = (this.#ignoring?.last ?? 0) + hold - Date.now();
      if (left <= 0) return this.#notIgnoring();
      /** @type {any} */ (this.#ignoring).timer = setTimeout(look, left);
      return undefined;
    };
    this.#ignoring = { last: now, timer: setTimeout(look, hold) };
    this.#changed();
  }

  /** "Ignoring" ends: no more sound kept out, a turn, a tap, or a close. */
  #notIgnoring() {
    const was = this.#ignoring;
    if (!was) return;
    clearTimeout(was.timer);
    this.#ignoring = null;
    this.#changed();
  }

  /** The least a frame must reach to begin a turn; here because only a learned floor comes through, which the next session starts from. @param {number} floorDb */
  #minimum(floorDb) {
    this.#floorDb = floorDb;
    return Date.now() < this.#liftBy ? null : this.level.minimum(floorDb);
  }

  /** The level check learns only from the turns she answered; one begun in a tap's lift says what the user's voice is now, once a tap. @param {Hearing} h */
  #learn(h) {
    if (h.peak === undefined) return;
    if (h.tapped && this.#fresh) {
      this.#fresh = false;
      this.level.reset();
    }
    this.level.heard(h.peak);
    delete h.peak;
  }

  /** A tap: the next sound is a turn, however soft, for a while from when the microphone hears (the phone's own prompt may take longer than the lift). */
  #lift() {
    this.#fresh = true;
    this.#liftBy = this.listening ? Date.now() + LIFT_S * this.#unit() : Infinity;
  }

  /** @param {number | null} db */
  #rounded(db) {
    return db === null ? null : Math.round(db * 10) / 10;
  }

  /** What a tap's session came to: 'failed' when the connection itself couldn't be made (Halves tells the user), else 'ok' (including a close the user asked for). @type {Promise<'ok' | 'failed'> | null} */
  tapping = null;
  /** The last session start failed to connect (not a close that won). */
  #failed = false;

  /** @param {string} why */
  async #start(why) {
    this.#failed = false;
    // Start fresh runs: a session opens once it is done, its setup from the fresh start; a close meanwhile wins.
    const asked = this.#gen;
    const held = this.c.held?.();
    if (held) await held;
    await this.c.voiceOut?.();
    const id = this.c.model();
    // Never from a page out of view: what comes meanwhile waits for it (shown()).
    if (asked !== this.#gen || !id || !this.c.visible()) return false;
    const gen = ++this.#gen;
    this.state = 'opening'; // a close from now on wins
    this.#changed();
    await this.c.koe.opening.catch(() => {}); // its lines go into Koe's conversation
    // One that can't open rests its model, as a failed call's does: Koe's next model answers meanwhile.
    const over = await this.#over(); // its own card says why; the model isn't at fault
    const s = over ? null : await this.#resume(id, this.#handle, why).catch((e) => { this.c.llm.bench?.bench(id, e?.kind === 'bad-request' && /thinking level/i.test(String(e.message)) ? REFUSED_REST_MS : COOLDOWN_MS); return null; });
    if (s) await this.c.voiceOut?.(); // one that began while the socket connected finishes first too: the session hasn't let go of the speech pipeline yet
    if (gen !== this.#gen || !s) {
      this.#failed = !s && !over && gen === this.#gen;
      s?.close('closed');
      if (gen === this.#gen) this.state = 'closed';
      return false;
    }
    const settings = await this.c.voice?.settings();
    this.#quietMs = (settings?.closeAfterSeconds ?? 30) * (this.c.secondMs ?? 1000);
    this.#answerMs = this.answerSeconds * (this.c.secondMs ?? 1000);
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
    const { instructions, context, languages, known } = await this.c.setup();
    this.#languages = known ?? null;
    const tools = definitions(await this.c.koe.liveTools());
    // Changed instructions start a fresh session: whether the provider applies new text sent with a handle isn't known, and Koe could keep the old rules.
    if (resume && this.#setUp && this.#setUp.instructions !== instructions) {
      resume = undefined;
      this.#handle = undefined;
    }
    // What a session was set up with, for What each half sees: the text it was given every time, and where its conversation began. A resumed
    // one goes on from there: the provider holds the rest, so its context stays with the place it counts from.
    const kept = resume ? this.#setUp : null;
    const [last] = kept ? [] : await this.c.store.tx(['events'], 'readonly', (t) => t.listEvents(this.c.koe.scope, { reverse: true, limit: 1 }));
    if (!kept) this.#told = [];
    const sent = kept ? kept.context : context; // a resume sends what it began with: a provider that reads it again repeats nothing
    this.#setUp = { instructions, context: sent, tools: tools.map((x) => x.name), after: kept ? kept.after : last?.seq ?? 0 };
    this.#wake = newId('w');
    this.#noBack = 0;
    this.#endedEarly = false;
    // The phone's sound, for the Trace's ready line: its rate and the output's own latency (the pops investigation).
    const output = this.c.voice?.platform?.player.output?.() ?? undefined;
    const s = await this.c.llm.live(id, { instructions, context: sent, tools, ...(languages ? { languages } : {}), ...(resume ? { resume } : {}) }, { scope: this.c.koe.scope, wake: this.#wake, output });
    s.on((e) => this.#on(s, e));
    s.closed.then((c) => this.#closed(s, c, why));
    await s.ready;
    this.#s = s;
    this.#rate = s.audioOut.rate || 24_000; // never 0 or missing: her stall wait is worked out from it
    for (const fn of this.#waiting.splice(0)) fn(s);
    this.#arm();
    return s;
  }

  /**
   * What a live session got: its setup as kept, with the last entry before it (after); with none going, the setup the next would get (after: null).
   * @returns {Promise<{ instructions: string, context: string, tools: string[], after: number | null, told: { ts: number, text: string }[] }>}
   */
  async sees() {
    if (this.#setUp && (this.state === 'open' || this.#handle)) return { ...this.#setUp, told: [...this.#told] };
    const { instructions, context } = await this.c.setup();
    return { instructions, context, tools: definitions(await this.c.koe.liveTools()).map((x) => x.name), after: null, told: [] };
  }

  /** Her voice may play now. */
  #maySound() {
    const v = this.c.voice;
    return Boolean(v?.on && v.unlocked && this.c.visible() && v.platform?.player.stream);
  }

  /** An open session's voice plays from now on, where it may. */
  unmute() {
    if (this.state !== 'open') return;
    const was = this.voiced;
    this.voiced = this.#maySound();
    if (this.voiced && !was) this.c.release();
    if (this.#input) this.#route(); // the audio may have changed (Halves asks on every change of the voice)
  }

  /** Whether speaking may cut her off, from the microphone in use (§10.4): read after it opens, and when the audio changes. */
  async #route() {
    const v = this.c.voice;
    const input = this.#input;
    if (!v) return;
    /** @type {[boolean, string]} */
    const [duplex, route] = await Promise.all([v.settings(), v.route()]).then(([{ bargeIn }, r]) => [Boolean(bargeIn && DUPLEX.includes(r)), r], () => [false, 'unknown']);
    if (this.#input !== input) return;
    this.#duplex = duplex;
    if (route !== this.#routeName) { // another microphone: what was learned says nothing about it
      this.level.reset();
      this.#floorDb = null;
    }
    this.#routeName = route;
  }

  /** The microphone opens on the open session; what is said streams live, only while someone speaks. */
  listen() {
    // One at a time: two in flight would open two microphones (review); a close lets go of the one in flight, so the next session starts its own.
    if (this.#listening) return this.#listening;
    const p = this.#listen().finally(() => { if (this.#listening === p) this.#listening = null; });
    this.#listening = p;
    return p;
  }

  async #listen() {
    const v = this.c.voice;
    const p = v?.platform;
    if (this.#input || !this.#s || !p || !v.on || !this.c.visible()) return;
    const { pauseMs } = await v.settings();
    this.#pauseMs = pauseMs;
    await this.c.voiceOut?.(); // a reminder finishes first; a tap has stopped it
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
    const input = (this.#input = new LiveInput({
      // Deaf while her sound plays, not while her turn's end is still to come after it (a quick reply then is heard whole).
      mic: p.mic, rate: this.#inRate, pauseMs, speaking: () => Boolean(this.#sounding?.stream?.queued()), duplex: () => this.#duplex, deaf: () => this.#urgent !== null || this.#otherVoice(), minDb: (floorDb) => this.#minimum(floorDb), floorDb: this.#floorDb, onKept: () => this.#kept(), onOver: () => void this.#talkedOver().catch(() => {}),
      send: { activity: (edge) => this.#activity(edge), audio: (b) => this.#audio(b) }, onLevel: (x) => v.level(x, 'you'), onError: (e) => this.#deaf(e),
      // Each turn's end, why and in numbers only, for the Trace.
      onTurn: (t) => {
        this.#write({ type: 'live.turn', actor: 'system', data: { wake: this.#wake, ...t, voiceDb: this.#rounded(this.level.db) } });
        if (t.end === 'kept') return;
        if (this.#hear) {
          if (t.peakDb !== null) this.#hear.peak = t.peakDb; // a noise thrown away once sent has none
          // The floor before the turn: it creeps up with speech.
          this.#hear.own = this.level.own(t.peakDb, this.#floorDb ?? t.floorDb);
        }
        // One begun after the spell ran out that went on to the cap, 15 s of sound with no pause, is let go now: the next begins at once.
        if (t.end === 'cap' && this.#lapsed && this.#hear?.late) this.#stretched(this.#hear);
        this.#endedBy = t.end;
      },
    }));
    clearTimeout(this.#toPlayback);
    p.session('play-and-record');
    this.#changed(); // the microphone is being asked for: the dock shows her working (view), not listening
    // She listens once it is open, not before: the glow is the user's cue to speak, and getUserMedia and the capture worklet can be slow.
    // A close (or a stop, or a newer microphone) that came meanwhile has let this one go: it listens to nothing, and a failure is its own.
    await input.start().then(() => {
      if (this.#input !== input) return undefined;
      this.listening = true;
      if (this.#liftBy === Infinity) this.#lift();
      this.#changed();
      return this.#route();
    }, (e) => { if (this.#input === input) this.#deaf(e); });
    this.#poke();
  }

  /**
   * Speech begun over her on the phone's speaker was let go: a second time in a session, a quiet card says a tap talks over her, once
   * on this device (kept in its own scope, which no backup carries).
   */
  async #talkedOver() {
    if (this.#routeName !== 'speaker' || ++this.#overs < 2 || this.#hinted) return;
    this.#hinted = true;
    const ws = this.c.ws;
    if (ws && (await ws.readJSON(SYS_DEVICE, HINTS).catch(() => null))?.talkOver) return;
    this.c.notice({ tone: 'info', title: t`Tap Shiori to talk over her`, body: t`On the phone's speaker, annai can't hear you while she speaks, so what you say over her is let go. A tap stops her and listens.` });
    if (!ws) return;
    await ensureDeviceScope(ws.store, ws.now());
    await ws.write(SYS_DEVICE, HINTS, { talkOver: true }, { author: 'system' });
    await forget(ws.store, SYS_DEVICE, { history: (p) => p === HINTS });
  }

  /** The microphone failed (refused, or taken): a card says why; the session goes on without it. @param {unknown} e */
  #deaf(e) {
    if (!this.#input) return;
    if (/** @type {any} */ (e)?.stuck) {
      this.#soundStuck();
      this.#changed();
      return this.#idle();
    }
    clearTimeout(this.#stall);
    this.#input.stop();
    this.#input = null;
    this.listening = false;
    this.c.voice?.platform?.session('playback');
    const p = this.c.voice?.problem(e) ?? { title: t`Listening stopped`, body: String(/** @type {any} */ (e)?.shown ?? /** @type {any} */ (e)?.message ?? e) };
    this.c.notice({ tone: 'warn', title: p.title, body: p.body });
    this.#changed();
    this.#idle();
  }

  /**
   * Closes it: the microphone, her voice (its words kept up to there), and playback back at full quality (§10.1). forget:
   * another conversation, or Erase: the handle and what waited go too. @param {string} why @param {{ forget?: boolean }} [o]
   */
  close(why, { forget = false } = {}) {
    // Another conversation, or a fresh start: Kokoro's notes it owed are shown in the one left, never lost (review S4).
    if (forget && (why === 'switch' || why === 'fresh') && this.owing) this.c.left?.([...this.#owed.sent, ...this.#owed.waiting]);
    this.#closing = null;
    clearTimeout(this.#hearFirst);
    this.#hearFirst = null;
    if (forget) {
      this.#handle = undefined;
      this.#notes = [];
      this.#owed = { waiting: [], sent: [], cued: false, cue: false, at: 0, cutOff: false };
    }
    this.#again();
    this.#owed.cutOff = false;
    this.#liftBy = 0;
    this.#notIgnoring();
    // Kokoro's notes it owes: a page out of view has them go in once back (shown()), and the user's tap with the next session (the
    // iPhone trace, 2026-10-22: a tap had annai read one aloud); any other close, a sleep too, hands them on (Halves).
    if (why !== 'away' && why !== 'tap' && this.#owed.waiting.length) this.c.owed(this.#owed.waiting.splice(0));
    const was = this.state;
    // The user's turn going on ends first: no session is left waiting for its end.
    if (this.#input?.active) this.#s?.activity('end', {});
    this.#answer(undefined);
    this.state = 'closed';
    this.#watched = false;
    this.#unmark();
    this.#lapsed = false;
    this.#stretch = null; // its note ends with it
    this.#sleepy();
    // A microphone is always let go, whatever came before; the user's words it cut off are kept, marked.
    this.#cutHearing();
    const input = this.#input;
    this.#input = null;
    this.#listening = null;
    this.listening = false;
    clearTimeout(this.#stall);
    input?.stop();
    this.#old?.close(why); // one being left for a new connection
    this.#old = null;
    if (was === 'closed') {
      if (this.#opening) this.#gen++; // one waiting for Start fresh to end
      return this.#changed();
    }
    this.#gen++;
    const s = this.#s;
    this.#s = null;
    if (!forget && s?.handle) this.#handle = s.handle;
    if (ASLEEP.includes(why)) this.#handle = undefined; // the user (or Kokoro, through sleep) stopped it: the next one starts fresh, with the last lines
    this.voiced = this.#rotate = false;
    const fading = Boolean(this.#sounding?.stream);
    this.#cut(true);
    this.#t = null;
    this.#flushHeard(false);
    this.#hear = null;
    this.#waiting = [];
    clearTimeout(this.#quiet);
    clearTimeout(this.#holdTimer);
    // Playback again once her stopped voice has faded out: the session switched under the fade might be heard (unverified; the
    // pops investigation). Unless a microphone opened meanwhile, which wants play-and-record; a page going away switches at once.
    const p = this.c.voice?.platform;
    clearTimeout(this.#toPlayback);
    if (!fading || why === 'away') p?.session('playback');
    else {
      const o = p?.player.output?.();
      const ms = STOP_FADE_MS + ((o?.baseLatency ?? 0) + (o?.outputLatency ?? 0)) * 1000 + FADED_MARGIN_MS;
      this.#toPlayback = setTimeout(() => { if (!this.#input && !p?.mic.inUse?.()) p?.session('playback'); }, ms);
    }
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
    this.tapping = null;
    this.#exchanged();
    this.#unmark();
    if (this.#sounding) {
      this.#lift();
      this.interrupt();
      this.listen();
      return 'cut';
    }
    // "Ignoring · tap to talk": the words offer this. The microphone stays open, and the next sound is a turn, however soft.
    if (this.listening && this.#ignoring) {
      this.#lift();
      this.#notIgnoring();
      this.#poke();
      return 'listening';
    }
    if (this.listening || this.#input) { // listening, or its microphone is starting
      this.close('tap');
      return 'stopped';
    }
    if (!this.c.voice?.on) return 'typing';
    this.#lift();
    if (this.#otherVoice()) this.c.release(); // the user asked: a reminder being said stops, and a session opens at once
    if (this.state === 'closed' && this.#owed.waiting.length) this.#hearFirst = setTimeout(() => this.#heardFirst(), 2 * Math.max(500, this.c.secondMs ?? 1000));
    this.tapping = this.open('tap', { mic: true }).then((ok) => ok || !this.#failed ? 'ok' : 'failed', () => 'failed');
    return 'listening';
  }

  /** The user's first turn after a tap ended, or never began: what was kept goes in. */
  #heardFirst() {
    if (!this.#hearFirst) return;
    clearTimeout(this.#hearFirst);
    this.#hearFirst = null;
    this.#idle();
  }

  /**
   * Her voice stops now, and the provider is told where (cut: OpenAI truncates its record there); the session stays. The user stopped her
   * knowing, so what she was saying isn't said again; of a note for them, what they didn't hear is shown, silently, never lost.
   */
  interrupt() {
    const t = this.#sounding;
    if (!t) return;
    const playedMs = this.#stop(t);
    if (!t.whole && this.#owed.sent.length) this.c.left?.([...this.#owed.sent]);
    this.#passed();
    this.#input?.tapped();
    this.#send((s) => s.cut?.(playedMs));
  }

  /**
   * What the user typed or sent, written (Kokoro has it at once): Halves waits for this, so lines are written in the order they were sent.
   * @param {string} text @param {{ photos?: import('../agent/loop.js').SentPhoto[], chose?: boolean, claim?: string, handed?: import('../handover.js').HandedFile[], handover?: string }} [o]
   */
  async write(text, { photos = [], chose = false, claim, handed = [], handover } = {}) {
    this.#exchanged();
    this.#watched = true;
    await this.c.held?.(); // typed while Start fresh runs: written below its divider
    return this.c.koe.logUser(text, photos, { chose, handed, ...(handover ? { handover } : {}), ...(claim ? { claim } : {}) });
  }

  /**
   * What the user sent, written, goes to the session: its photos, each a turn that waits, and its words. Files handed over are Kokoro's to
   * read: the session hears only that they came.
   * @param {any} e its entry (write) @param {string} text
   * @returns {Promise<boolean>} false: no session
   */
  async send(e, text) {
    if (!(await this.open('typed'))) return false;
    const rec = (await this.c.llm.config()).models[this.modelId ?? ''];
    const takes = Boolean(rec && modelOf(rec).input.includes('image'));
    // The request copies Kokoro gets, as its transcript reads them.
    const { images } = await resolveEvent(this.c.store, e);
    for (const im of takes ? images : []) if (im.type === 'image' && im.data) this.#send((s) => s.image({ mediaType: im.mediaType, data: im.data }));
    this.#text(koeLine(e.data, String(text ?? '').trim(), { unseen: !takes }));
    return true;
  }

  /** A wake Koe answers (a trigger, the recap asked aloud), as annai's text turn; not said, its reminders are annai's (Halves). @param {import('../agent/loop.js').Wake} w */
  wake(w) {
    if (isWatched(w)) this.#watched = true;
    const text = `[annai] ${escapeTags(JSON.stringify(String(w.text ?? '')))}`;
    // With reminders, it is owed as a note is: if she doesn't say it, annai does (Halves).
    const owed = w.fallbacks?.length ? { ...w, line: text } : null;
    // An urgent watch fired (drive-test design §7): said now, as an urgent note is; out of view, it waits as any wake does.
    if (w.urgent && this.c.visible()) return this.#now(text, w.kind, owed, true);
    if (!owed) return this.#say(text, w.kind);
    this.#owed.waiting.push(owed);
    return this.#go(w.kind, () => { this.#owed.waiting = this.#owed.waiting.filter((x) => x !== owed); });
  }

  /**
   * A note from Kokoro (decision 14): append after Koe's turn and voice; immediate at once, cutting Koe off. One no session could
   * take is let go here: Halves hands it on (false). @param {string} text @param {'append' | 'immediate'} mode
   * @param {Wake | null} [owed] a note for the user, which Koe owes them
   * @param {{ stretch?: boolean }} [o] stretch: Kokoro's for the stretch of non-stop sound it was woken for (no words for the user: its
   *   sleep), nothing once that stretch is over (a real exchange since, or a close), here or when it would go in (#sleepy); never owed
   */
  note(text, mode, owed = null, { stretch = false } = {}) {
    const note = wrapNote(text, this.c.nonce);
    if (stretch) {
      if (this.#late && this.#late.of === this.#stretch) this.#late.text += `\n${note}`;
      else if (this.#stretch) this.#late = { text: note, of: this.#stretch, by: 0, more: false, timer: null };
      this.#sleepy();
      return Promise.resolve(true);
    }
    if (mode !== 'immediate' || !this.c.visible()) {
      const n = { text: note };
      if (owed) this.#owed.waiting.push(owed);
      else this.#notes.push(n);
      return this.#go('note', () => {
        if (owed) this.#owed.waiting = this.#owed.waiting.filter((w) => w !== owed);
        else this.#notes = this.#notes.filter((x) => x !== n);
      });
    }
    return this.#now(note, 'note', owed);
  }

  /**
   * Urgent (an immediate note, an urgent watch's trigger): said now, whole, before anything that waits (a session it opens lets nothing
   * else in first); the microphone is deaf until she has said it, or the cap. @param {string} text @param {string} why @param {Wake | null} [owed]
   * @param {boolean} [told] annai's own line, which the log holds none of
   */
  async #now(text, why, owed = null, told = false) {
    clearTimeout(this.#urgent?.timer);
    const mark = (this.#urgent = { sent: 0, spoke: false, timer: null });
    this.#changed();
    // No session to take it (none opened, the open failed, or it closed while the microphone opened): no mark is left, and Halves
    // hands it on, as #go does.
    let ok = false;
    try {
      ok = (await this.open(why, { mic: Boolean(this.c.voice?.unlocked) })) && this.state === 'open';
    } finally {
      if (!ok) this.#unmark(mark);
    }
    if (!ok) return false;
    this.#input?.cut('voice'); // the user's turn going on ends here
    const cut = this.#cut();
    if (owed) this.#went([owed]);
    this.#text(text, cut, false, told ? [text] : []);
    // A newer urgent note came meanwhile: its own mark runs once it goes in, after this one.
    if (this.#urgent === mark) this.#capped(mark, (mark.sent = Date.now()) + URGENT_S * this.#unit());
    return true;
  }

  /** A second of the session's waits (the tests' clock, never under 125 ms). */
  #unit() {
    return Math.max(125, this.c.secondMs ?? 1000);
  }

  /** The urgent mark ends at the latest at this time: the microphone hears again, and what waited goes in. @param {Mark} mark @param {number} at */
  #capped(mark, at) {
    clearTimeout(mark.timer);
    mark.timer = setTimeout(() => {
      this.#unmark(mark);
      this.#idle();
    }, Math.max(0, at - Date.now()));
  }

  /**
   * Her voice begun after the urgent note has played out, and nothing more of her answer is to come: no turn of hers goes on or waits,
   * no tool call runs, and the last (not cut) didn't call a tool she speaks after. The microphone hears again (else at the cap).
   */
  #heardOut() {
    if (this.#urgent?.spoke && !this.#hers() && !(this.#trail?.goesOn && !this.#trail.cut)) this.#unmark();
  }

  /** The urgent mark (only this one, where given) ends. @param {Mark | null} [mark] */
  #unmark(mark = this.#urgent) {
    if (!mark || this.#urgent !== mark) return;
    clearTimeout(mark.timer);
    this.#urgent = null;
    this.#changed();
  }

  /** Kokoro's notes for the user went in: Koe's next turns are watched for them. @param {Wake[]} notes */
  #went(notes) {
    this.#owed.sent.push(...notes);
    this.#owed.cued = this.#owed.cue = false;
    this.#owed.at = Date.now();
  }

  /** Koe reached the user since its notes went in (its words heard, a card, a question): they are passed on. */
  #passed() {
    this.#owed.sent = [];
    this.#owed.cued = this.#owed.cue = this.#owed.cutOff = false;
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
    // A turn with words still going out: heard whole, it passes them on (#said); cut, it comes back here.
    if (!o.sent.length || t?.goesOn || (t?.spoken && !t.cut && !t.logged)) return;
    if (!o.cued) {
      o.cued = o.cue = true;
      return;
    }
    this.c.unsaid(o.sent.splice(0));
    o.cued = false;
  }

  /** Words said once Koe's turn and voice end (#go). @param {string} text @param {string} why @returns {Promise<boolean>} */
  #say(text, why) {
    const n = { text, told: true };
    this.#notes.push(n);
    return this.#go(why, () => { this.#notes = this.#notes.filter((x) => x !== n); });
  }

  /**
   * What waits goes in once Koe's turn and voice end, in a session opened for it that listens after where sound was unlocked;
   * out of view, it waits (shown()). With no session, it is let go here (undo), and Halves hands it on (L3: never twice).
   * @param {string} why @param {() => void} undo @returns {Promise<boolean>} whether it will be said
   */
  async #go(why, undo) {
    if (!this.c.visible()) return true;
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

  /**
   * A text turn, which Koe answers; cut: it cuts Koe off, heard this far; strict: only sound, a word, a card or a question answers it;
   * told: the lines in it that are annai's own (a reminder, a cue), which the log holds none of: What each half sees shows them.
   * @param {string} text @param {{ playedMs?: number }} [cut] @param {boolean} [strict] @param {string[]} [told]
   */
  #text(text, cut, strict = false, told = []) {
    this.#trail = null;
    if (this.#hear) delete this.#hear.peak; // a note going in as a lyric ends: her reply to it answers the note, not the lyric
    this.#poke();
    const ts = Date.now();
    for (const line of told) this.#told.push({ ts, text: line });
    this.#send((s) => s.text(text, { interrupt: Boolean(cut), ...cut }));
    this.#answer(text, strict, told);
  }

  /** Waits for the answer to a text turn (its words) or the user's turn (null); undefined: stops. @param {string | null | undefined} text @param {boolean} [strict] @param {string[]} [told] */
  #answer(text, strict = text === null, told = []) {
    clearTimeout(this.#due?.timer);
    this.#due = text === undefined || this.state === 'closed' ? null : { text, timer: null, strict, tools: false, alive: false, told };
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
    if (!due || this.state !== 'open') return;
    // A timer of a connection that has been left: the wait goes on for the one in use (or, mid-move, for the one that comes: #arm).
    if (s !== this.#s || this.#old) {
      due.timer = null;
      return this.#arm();
    }
    if (this.c.asked() || this.#tools) {
      due.timer = null;
      return this.#arm();
    }
    this.#due = null;
    // The user's turn, with nothing at all back: Gemini's way of letting a turn go (measured: the design, section 3, item 6). The model chose: nothing is
    // retried, least of all by a fresh session with the words. A session really dead shows itself at the next note or typed line.
    if (due.text === null && !due.alive) {
      /* en */ this.#write({ type: 'error', actor: 'system', data: { kind: 'live-silent', message: `The live session gave nothing back within ${SILENT_S} seconds of a turn: taken as let go.`, quiet: true } });
      this.#complete();
      // A second turn in a row with nothing back, not even what was heard: a dead connection, not a choice. The same conversation on a new one; no words go
      // again. Once, until an answer, and sound going in is no exchange, so the quiet spell runs on: a session that stays silent closes, and the next keeps its context.
      if (this.#noBack < 2 || this.#rescued || this.state !== 'open') return undefined;
      this.#rescued = true;
      return this.#reconnect('silent', { spell: false }).then((ok) => { if (!ok) this.#gone(false); });
    }
    const again = !this.#rescued;
    /* en */ const how = !again ? '' : due.alive ? ': it is asked again' : ': a fresh one gets it again';
    /* en */ this.#write({ type: 'error', actor: 'system', data: { kind: 'live-silent', message: `The live session gave no answer within ${SILENT_S} seconds${how}.`, quiet: true } });
    // Twice in a row: not a session to keep (its cut flag has Halves give the answer to Koe's next model, or Kokoro).
    if (!again) return this.#gone(true);
    this.#rescued = true;
    if (due.alive) return this.#text(UNANSWERED, undefined, true, [UNANSWERED]);
    // The words go once: a note among them stays sent, and isn't taken for waiting by the move.
    const sent = this.#owed.sent.splice(0);
    const ok = await this.#reconnect('silent', { fresh: true });
    this.#owed.sent.push(...sent);
    if (!ok) return this.#gone(false);
    if (due.text) this.#text(due.text, undefined, false, due.told);
  }

  /** @param {'start' | 'end'} edge */
  #activity(edge) {
    if (this.state === 'closed') return;
    if (!this.c.visible()) return this.close('away'); // a page out of view never streams a sound
    /** @type {{ playedMs?: number }} */
    let cut = {};
    clearTimeout(this.#stall);
    if (edge === 'start') {
      this.#notIgnoring();
      this.#answer(undefined); // the user talks again: no answer is waited for while they do
      this.#turnAt = Date.now();
      this.#afterCap = this.#endedBy === 'cap' && Date.now() - this.#endedAt < AFTER_CAP_MS;
      // The user cut in: her voice stops now, and the provider cuts its turn; one with no word yet too, so it never starts over them.
      if (this.#sounding || this.#t || this.#pending || this.#queue.length) cut = this.#cut();
      this.#flushHeard(false);
      const before = this.#hear;
      this.#hear = hearing();
      if (this.#lapsed) this.#hear.late = true; // the spell ran out before this turn began
      if (Date.now() < this.#liftBy) this.#hear.tapped = true;
      // The turn before, begun after the spell ran out, got nothing back before this one cut it (a sound, a word or a tool call would
      // have re-armed the spell): it was let go.
      if (this.#lapsed && before?.late && !before.answered) this.#stretched(before);
    } else {
      if (this.#hear) this.#hear.ms = Date.now() - this.#hear.at;
      this.#trail = null;
      this.#endedAt = Date.now();
      this.#noBack++;
    }
    // Sound going in is no exchange (music is enough for the detector): only her answer to it re-arms the quiet spell.
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
    this.#send((s) => s.audio(b));
  }

  /** @param {LiveSession} s @param {import('../llm/contract.js').LiveEvent} e */
  #on(s, e) {
    if (s !== this.#s) return; // a connection being left
    if (e.type === 'heard' || e.type === 'said' || e.type === 'audio' || e.type === 'tool' || e.type === 'turn') this.#noBack = 0;
    if (e.type === 'turn' && this.#endedEarly) {
      this.#endedEarly = false;
      if (!this.#t && e.end !== 'interrupted') return; // the turn it ends is over: never an answer to what came since
    }
    // Her sound, words or tool calls are an exchange; what was heard, and turn edges, are not.
    if (e.type === 'audio' || e.type === 'tool' || (e.type === 'said' && realWord(e.text))) this.#poke();
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
      if (this.#owed.sent.length) this.#owed.cutOff = true;
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
      t.soundAt ||= Date.now();
      if (t.stream) t.stream.push(samples(e.data));
      else if (!t.cut) t.held.push(e.data);
      if (t.endBy) this.#endLater(t);
    } else if (e.type === 'said' && !this.#t && this.#trail) {
      const t = this.#trail;
      if (!t.cut && !t.logged) t.said += e.text;
      this.#saying(t); // after the provider's turn ended, while her voice plays
    } else if (e.type === 'said') {
      const t = (this.#t ??= newTurn());
      t.said += e.text;
      if (!t.spoken && realWord(t.said)) this.#speak(t);
      else this.#saying(t);
      if (t.endBy) this.#endLater(t);
    }
    this.#changed();
  }

  /** Her words so far, for the bubble: only once her voice is heard, and never after it was cut. @param {Turn} t */
  #saying(t) {
    if (t.audible && this.#sounding === t && !t.cut) this.c.saying?.(cleanSaid(t.said));
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
    // A voice that won't play waits for nobody: its words are written now, whatever annai's other voice is doing (a clip that never ends, while sound is stuck).
    if (this.#maySound() && this.#otherVoice()) return false;
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
    const u = this.#urgent;
    if (!t.cut && u?.sent && !u.spoke) { // her voice begun after the urgent note: the mark ends once it has played out, or at the ceiling
      u.spoke = true;
      this.#capped(u, u.sent + URGENT_MAX_S * this.#unit());
    }
    this.unmute(); // a tap may have unlocked sound since the session opened
    const v = this.c.voice;
    if (this.voiced && v?.platform?.player.stream && !t.cut) {
      t.stream = v.platform.player.stream({ rate: this.#rate, onLevel: (x) => v.level(x, 'her') });
      for (const a of t.held) t.stream.push(samples(a));
      this.#sounding = t;
      t.stream.done.then((r) => {
        if ((r.stalled || t.stalled) && !t.cut) return this.#soundOut(t, r);
        this.#said(t, r.playedMs);
        return this.#played(t, r);
      });
      t.stream.running?.then((ok) => { if (!ok) this.#stalled(t); }); // the page may not play sound now
      // Her words show as her voice starts (after the player's start buffer), never before it.
      (t.stream.started ?? Promise.resolve(true)).then((ok) => {
        t.audible = ok;
        this.#saying(t);
      });
      if (t.done) this.#ending(t);
    } else if (t.done) this.#said(t, null);
    t.held = [];
  }

  /** All of her turn's sound is in: its stream plays out, or is stopped as stalled STALL_S past its length. @param {Turn} t */
  #ending(t) {
    t.stream?.end();
    // Both on the real clock, as her sound plays: never the test clock, which only the session's own timers keep.
    setTimeout(() => this.#stalled(t), t.bytes / (this.#rate / 500) + STALL_S * 1000);
  }

  /** Her voice isn't coming out: its stream stops, and its done lets go of it (#soundOut). @param {Turn} t */
  #stalled(t) {
    if (t.logged || !t.stream) return;
    t.stalled = true;
    t.stream.stop();
  }

  /**
   * Her sound stopped coming out (the second drive: five replies in a row, on one stuck context, and no line): nothing of it is lost. The
   * stream is let go; her whole words are written at her turn's end and said by the speech voice, in whole clips (#said); the screen says a tap
   * brings sound back. @param {Turn} t @param {import('../voice/platform.js').Played} r
   */
  #soundOut(t, r) {
    t.stalled = true;
    t.stream = null;
    this.#played(t, r);
    if (this.#sounding === t) this.#sounding = null;
    this.#soundStuck();
    if (t.done) this.#said(t, null);
    this.#next();
    this.#heardOut();
    this.#idle();
    this.#changed();
  }

  /** Sound is stuck: bubbles and whole clips, and no microphone, which runs on the same context, until a tap (Voice.unlock). */
  #soundStuck() {
    this.voiced = false;
    this.c.voice?.soundStopped();
    const input = this.#input;
    this.#input = null;
    this.#listening = null;
    this.listening = false;
    clearTimeout(this.#stall);
    input?.stop();
  }

  /** The provider's turn ended: her voice plays out, or her words are a bubble; a turn with no real word is dropped. */
  #complete() {
    this.#ends++;
    const t = (this.#trail = this.#t);
    this.#t = null;
    this.#tries = 0;
    if (t?.stream) this.#ending(t);
    else if (t?.spoken && !this.#waits(t)) this.#said(t, null);
    // Heard, and answered by nothing at all: not meant for Koe (the model's own choice, proactive audio).
    const dismissed = !t?.spoken && !t?.tools;
    if (!dismissed) this.#poke(); // her turn ended: the quiet spell runs from here
    // Nothing for what a session with nobody in it said (#idle): no voice is coming. (An urgent note's mark isn't matched to turns.)
    else if (this.#urgent?.idle && !this.#urgent.spoke) this.#unmark();
    const h = this.#hear;
    this.#answered(dismissed, Boolean(t?.spoken));
    if (t) t.done = true;
    if (!t?.calls) this.#settle(t); // else once its calls are answered: a refused show passes nothing on
    this.#heardOut();
    this.#idle();
    if (!dismissed || !this.#lapsed) return;
    // A turn begun after the spell ran out, let go, is the stretch's (one going on now is decided when it ends), decided before the
    // spell looks again and clears the lapse.
    const late = Boolean(h?.late && !this.#input?.active);
    // The quiet spell ran out on the user's turn, and she let it go: nothing was exchanged. It closes, unless something still goes on.
    this.#quietEnd();
    // Sound goes on (the session stays: the spell re-armed, or looks again): Kokoro decides. Closed, there is nothing to decide.
    if (late && h && this.state !== 'closed') this.#stretched(h);
  }

  /**
   * Koe's turn for what was heard began, or ended with nothing (dismissed): it is written. reaches: it answers the user (words, or a
   * card or question: #tool), so the user is in it and the brief window ends, also after a tool call that answers nobody
   * (already_told), which alone doesn't. @param {boolean} dismissed @param {boolean} [reaches]
   */
  #answered(dismissed, reaches = !dismissed) {
    // One that comes while the user's next turn goes on is the turn before's (let go as this one began), never marked on this one; an
    // answer still ends the stretch (#exchanged): the user was in it.
    if (this.#input?.active) {
      if (reaches) this.#exchanged();
      return this.#chain;
    }
    const h = this.#hear;
    if (!h) return this.#chain;
    if (!h.answered) Object.assign(h, { answered: true, dismissed });
    if (reaches && !h.dismissed) {
      this.#learn(h);
      this.#exchanged();
    }
    return this.#flushHeard(Boolean(h.dismissed));
  }

  /**
   * A real exchange: she answered a heard turn (words, a card or a question, or asking Kokoro), or the user tapped or typed. The brief window ends, and so
   * does a stretch of non-stop sound, its note (Kokoro's sleep) with it: the user is in it.
   */
  #exchanged() {
    this.#brief = false;
    this.#stretch = null;
    this.#sleepy();
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

  /**
   * How her voice played, in numbers only, for the Trace (the pops investigation, 2026-10-23): heard ms; the holes where her sound
   * ran out before more came, and their ms; how long her first sound waited to start; whether it was cut, or stalled; and which player played it.
   * @param {Turn} t @param {import('../voice/platform.js').Played} r
   */
  #played(t, r) {
    const { playedMs, ...rest } = r;
    this.#write({ type: 'live.reply', actor: 'system', data: { wake: this.#wake, ms: playedMs, ...rest, cut: t.cut && !t.whole, ...(t.stalled ? { stalled: true } : {}) } });
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
    if (text) this.#poke(); // she has finished saying it: the quiet spell runs from here
    // Notes pass on when her words for them were heard: the provider's burst, or sound begun, proves nothing, as sound at the microphone may
    // cut her at once (no line, no note: the second drive's silence).
    if (this.#owed.sent.length && t.wordAt >= this.#owed.at) {
      if (!cut && text) this.#passed();
      else if (cut) {
        this.#owed.cutOff = true;
        if (t.done && !t.calls) this.#settle(t);
      }
    }
    const v = this.c.voice;
    const aloud = Boolean(text && !cut && v?.on && (t.stalled || v.stuck));
    const voiced = Boolean(t.stream || aloud);
    const [modelId, wake] = [this.modelId, this.#wake]; // as they are now: a close clears the model before the write below runs
    if (text) this.#write(async () => {
      const rec = (await this.c.llm.config()).models[modelId ?? ''];
      const by = rec ? { name: modelOf(rec).name, first: null, tried: false } : null;
      return { type: 'out.speak', actor: 'shiori', data: { id: newId('s'), wake, live: true, by, ...(voiced ? { voice: true } : {}), ...(cut ? { cut: true } : {}) }, texts: [['text', text]] };
    });
    if (aloud) v?.say(text).catch(() => {});
    if (next) this.#next();
    this.#heardOut();
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
      // A word or two plainly in a language the user doesn't speak is Gemini mishearing a short reply ("¿Qué?" for "What?"): flagged, never a change of language.
      const stray = this.#languages ? strayLanguage(text, this.#languages) : '';
      return { type: 'heard', actor: 'user', blobs: clip.blobs, data: { id: h.id, wake: this.#wake, ms: h.ms, source: 'live', text, ...(dismissed ? { dismissed: true, gate: 'chatter', ...(h.own ? { ownLevel: true } : {}) } : {}), ...(stray ? { strayLanguage: stray } : {}), ...clip.data } };
    });
  }

  /** Writes in order; an entry may be worked out first. @param {any} ev @returns {Promise<unknown>} */
  #write(ev) {
    /* en */ this.#chain = this.#chain.then(async () => this.c.koe.log(typeof ev === 'function' ? await ev() : ev)).catch((e) => console.warn('a live line was not written', e));
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
      await this.#answered(false, false);
      // Always answered: the model waits for it.
      /* en */ const out = await this.c.koe.liveCall(e, this.#wake, this.#watched).catch((err) => ({ content: `Error: ${err?.message ?? err}`, isError: true }));
      // A card or question annai showed passes Kokoro's notes on, and answers the user; one it refused does neither.
      // Her already_told about words sound cut off isn't so: she can't know.
      if (REACH.includes(e.name) && !out.isError && !(e.name === 'already_told' && this.#owed.cutOff)) this.#passed();
      if ((e.name === 'show' || e.name === 'ask') && !out.isError) {
        this.#answered(false); // a card or question answers what was heard
        if (this.#due?.strict) this.#answer(undefined);
      } else if (e.name === 'tell_kokoro' && !out.isError) this.#answered(false); // asking Kokoro about it answers the user too: they are in it
      const silent = SILENT.includes(e.name);
      const answer = (/** @type {LiveSession} */ x) => x.answer(e.id, e.name, theirs(out.content), { silent });
      // To its session, or to the one that resumed it with the handle, which carries the call; a fresh one never saw it.
      if (s === this.#s) answer(s);
      else if (this.state === 'open' && this.#handle) this.#send(answer);
      if (silent && this.#t === t) { // a turn of a call alone, answered silently, is over; its turnComplete may never come either
        if (!t.bytes && !t.said) {
          this.#t = null;
          t.alone = true;
        }
        this.#endLater(t);
      }
      // The user asked her to sleep, or Kokoro said so: it closes as a tap does, once what she is saying has ended.
      if (e.name === 'sleep' && !out.isError) this.closeSoon('sleep');
    } finally {
      t.calls--;
      this.#tools--;
      if (t.done && !t.calls) this.#settle(t);
      this.#poke();
      this.#heardOut();
      this.#changed();
      this.#idle(); // what waited for the call goes in now
    }
  }

  /** Her turn's tool call was answered silently, and its turnComplete may never come: it ends TURN_END_S past her sound, counted from when it began. @param {Turn} t */
  #endLater(t) {
    clearTimeout(t.endBy);
    const ends = this.#ends;
    const began = t.soundAt || Date.now();
    t.endBy = setTimeout(() => {
      // It ended, or the last call's answer sets this again; one let go of (alone) ends only if nothing of hers began or ended since.
      if (t.calls || (this.#t ? this.#t !== t : !t.alone || this.#ends !== ends)) return;
      this.#endedEarly = true;
      this.#complete();
      this.#changed();
    }, Math.max(0, t.bytes / (this.#rate / 500) - (Date.now() - began)) + TURN_END_S * this.#unit());
  }

  /**
   * Between turns: what waits goes in, together, Kokoro's notes and the ask once more among it; a session told to go (GoAway)
   * reconnects with its handle first, as what goes into it now would be answered there and lost.
   */
  #idle() {
    this.#sleepy();
    if (this.busy || this.#urgent || !this.#s || this.#closing) return; // an urgent answer first: what waits goes in after it
    if (this.#rotate) return void this.#reconnect('goaway').then((ok) => { if (!ok) this.#gone(false); });
    const o = this.#owed;
    const kept = this.#hearFirst ? [] : o.waiting;
    const notes = this.#notes.splice(0);
    const cue = o.cue ? [o.cutOff ? CUE_CUT : CUE] : [];
    const text = [...notes.map((n) => n.text), ...kept.map((w) => w.line ?? wrapNote(String(w.note ?? ''), this.c.nonce)), ...cue];
    if (!text.length) return;
    const told = [...notes.filter((n) => n.told).map((n) => n.text), ...kept.flatMap((w) => (w.line ? [w.line] : [])), ...cue];
    o.cue = false;
    if (kept.length) this.#went(o.waiting.splice(0));
    this.#text(text.join('\n'), undefined, false, told);
    // Nobody is in a session a note or a trigger opened: sound at the microphone until she has said it is music, which would cut her.
    if (this.#brief) {
      const mark = (this.#urgent = { sent: Date.now(), spoke: false, timer: null, idle: true });
      this.#capped(mark, mark.sent + URGENT_S * this.#unit());
      this.#changed();
    }
  }

  /**
   * The one place the stretch's note (Kokoro's sleep) is decided. Nothing once the stretch is over: she answered the user since the wake
   * (#exchanged), or it closed. Else it goes in on the urgent path, so the next turn of the music can't cut her sleep call; never owed.
   * Her own turn, a tool call or an urgent note goes first. A user turn going on, or one awaiting her verdict, may be the user talking
   * to her: it waits for that verdict, at most STRETCH_WAIT_MS after that turn ends. Answered, the stretch is over; dismissed, it goes in
   * at once. At that bound a user turn going on is let end, and it or one ended since gets its own STRETCH_WAIT_MS, once; then no
   * verdict, or the next turn going on, holds it no longer (that turn is cut, as an urgent note cuts one).
   */
  #sleepy() {
    const n = this.#late;
    if (!n) return;
    clearTimeout(n.timer);
    if (n.of !== this.#stretch || this.state !== 'open') return void (this.#late = null);
    // Each calls #idle as it ends; a session told to go (GoAway) takes it once the next is ready, never the one being left.
    if (this.#hers() || this.#urgent || this.#closing || this.#rotate) return;
    const going = Boolean(this.#input?.active);
    const due = this.#due?.text === null;
    if (going && !n.by) return; // its end sets the bound (#activity)
    n.by ||= due ? this.#endedAt + STRETCH_WAIT_MS : Date.now();
    // At the bound, a user turn going on is never cut, nor one ended since pre-empted: it gets its own wait for her verdict, once. One
    // the cap's end began at once is the same sound (steady music), not the user beginning: none.
    if ((going || due) && Date.now() >= n.by && !n.more && !this.#afterCap) {
      n.more = true;
      n.by = going ? 0 : this.#endedAt + STRETCH_WAIT_MS;
      return this.#sleepy();
    }
    if ((going || due) && Date.now() < n.by) return void (n.timer = setTimeout(() => this.#sleepy(), n.by - Date.now()));
    this.#late = null;
    this.#stretch = null; // its note is in: a later stretch may wake Kokoro again
    this.#now(n.text, 'note').catch(() => {});
  }

  /** A new connection with the handle (fresh: without), the conversation going on. @param {string} why @param {{ fresh?: boolean, spell?: boolean }} [o] spell: false: the quiet spell isn't begun again @returns {Promise<boolean>} */
  async #reconnect(why, { fresh = false, spell = true } = {}) {
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
    if (spell) this.#poke();
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
    this.#unmark(); // the connection that was to answer it is gone
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

  /**
   * Re-arms the quiet spell: no exchange (her sound, words or tool calls, text going in, a tap or typing) for that long closes it
   * (decision 12; sound going in alone, music, never holds it).
   */
  #poke() {
    clearTimeout(this.#quiet);
    this.#lapsed = false;
    if (this.state !== 'closed') this.#quiet = setTimeout(() => this.#quietEnd(), this.#brief ? this.#answerMs : this.#quietMs);
  }

  /**
   * The quiet spell ran out. Kokoro working on Koe's question isn't quiet: its answer is coming. Nor is her own turn, a tool call, or
   * a text turn's answer still owed (#due; #silent bounds that wait). Only the user's turn going on, or its answer, left: that turn
   * decides (#lapsed): her answer re-arms it, a dismissed turn closes it (#complete), looking here again. Else it closes.
   */
  #quietEnd() {
    clearTimeout(this.#quiet);
    if (this.#hers() || this.c.asked() || (this.#due && this.#due.text !== null)) return this.#poke();
    if (this.#input?.active || this.#due) {
      this.#lapsed = true;
      return undefined;
    }
    // A run the detector still holds (~250 ms before it is a turn, or let go as none): look again, never leave it with no timer.
    if (this.#input?.hearing) {
      this.#quiet = setTimeout(() => this.#quietEnd(), HELD_LOOK_MS);
      return undefined;
    }
    return this.close('quiet');
  }

  /**
   * A user turn that began after the quiet spell ran out was let go (dismissed, cut by the next before any answer, or at the cap, as
   * the next begins at once), and sound goes on (music, other people): Kokoro is woken once a stretch with what that
   * turn's recognition made of it, and decides whether Koe sleeps; annai closes nothing on sound, it may be the user talking on. A turn
   * she answers wakes nobody (#poke clears the lapse). @param {Hearing} h
   */
  #stretched(h) {
    if (this.#stretch) return;
    this.#stretch = {};
    this.c.noisy?.(cleanSaid(h.text));
  }

  /** Today's spend reached (Spend per day): none opens, and one open closes, with the budget card. @returns {Promise<boolean>} */
  async #over() {
    const { spendPerDay } = (await this.c.budgets()) ?? {};
    const stop = spendPerDay ? budgetStop({ budgets: { spendPerDay }, steps: 0, spent: await spentToday(this.c.store, Date.now(), this.c.timeZone()) }) : null;
    if (stop) this.c.notice({ tone: 'warn', title: stop.title, body: stop.body });
    return Boolean(stop);
  }
}
