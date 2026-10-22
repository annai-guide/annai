import { ME, newId } from '../scopes.js';
import { readAppSettings } from '../settings.js';
import { AllFailedError, estimateTokens, candidates, chatCandidates, failedText } from '../llm/fallback.js';
import { ProviderError, explain } from '../llm/contract.js';
import { modelOf, providerOf, saveModel } from '../llm/config.js';
import { fromBase64, toBase64 } from '../bytes.js';
import { sha256Hex } from '../hash.js';
import { record, storedTexts, blobBytes, TALK_TAG } from './log.js';
import { compactionNeed, cutAt, promptTokens, requestBytes, instruction, renderForSummary, coldSystem, summaryLanguage, KEEP_EXCHANGES, WARM_LEAD_MS, SUMMARY_MAX_CHARS } from './compaction.js';
import { Transcript, resolveEvent, repair, NOT_SAID, SAID, STOPPED } from './transcript.js';
import { toolList, definitions, runTool, Stuck, toolSwitches, resolvePath } from './tools.js';
import { takeSnapshot, nextSnapshot, nowBlock, nextPlanItems, buildRequest, prefixFingerprint, systemText } from './context.js';
import { Warmth, TTL_MS, ttlFor, wantedTtl, SOON_MS } from './warmth.js';
import { tracedFetch, withoutSecrets } from './net.js';
import { webVia } from './via.js';
import { inQuiet, quietEnds, spentToday, budgetStop } from './budgets.js';
import { PhotoCopies, requestLimits, healRegion } from '../request-photos.js';
import { readRefusal, stricter, tighter, limitImages } from './refusals.js';
import { photoSettings } from '../photos.js';
import { parsePartialJSON } from '../llm/partial-json.js';
import { spokenText, unspoken } from './listen.js';
import { NOT_TRANSCRIBED } from '../voice/resolve.js';
import { GATE_OPTIONS, gatePrompt } from '../voice/gate.js';
import { cardSchema } from '../ui-slots.js';
import { validate } from '../schema.js';
import { anySignal } from '../signals.js';

/**
 * Shiori's loop (spec §6). Wakes go into one queue. A turn builds the context, calls the main
 * role, runs the tool calls in order (sleep last), appends the results and calls again, until she
 * sleeps, calls no tool, or something stops her. She reaches the user only through output tools
 * (§7.1); everything else she writes stays in the trace.
 * @typedef {'user' | 'choice' | 'plugin' | 'file' | 'restart' | 'personality' | 'heard' | 'trigger' | 'catch-up' | 'live' | 'recap' | 'note' | 'cue' | 'halves'} WakeKind
 *   trigger and catch-up: live mode's watches fired (spec §11.3, §11.4); live: the user turned live mode on; recap: the user asked to hear the trip's recap (spec §13);
 *   note, cue, halves: from the other half, or Halves (the Koe and Kokoro design)
 * @typedef {{ watch: string, text: string, cue?: boolean, title?: string }} Reminder  a watch's fallback (spec §11.3), owed until she tells the user; cue: a cue's for
 *   her (a place, the road), not a reminder: owed only until a model answers; title: what the card calls it, in place of "Reminder"
 * @typedef {{ path: string, region?: number[] }} SentPhoto a photo the user sends: a path, and a part of it
 * @typedef {{ kind: WakeKind, text: string, plugin?: string, scope?: string, photos?: SentPhoto[], heard?: import('../voice/resolve.js').Heard, gate?: string, fallbacks?: Reminder[], aloud?: boolean,
 *   logged?: boolean, from?: 'koe' | 'kokoro', note?: string, mode?: 'append' | 'immediate', again?: boolean, at?: number, input?: boolean, why?: string,
 *   call?: { name: string, input: any }, seq?: number }} Wake
 *   scope: the conversation it was meant for, set when it is queued; heard: what the microphone heard (spec §6.1); gate: what the quick-decision gate made of it;
 *   fallbacks: what annai shows and says by itself if no model answers (spec §11.3); aloud: this turn is spoken even with voice off (the user asked to hear her, spec §13);
 *   logged: its lines are in the log already (the other half's), so only the wake is written; from, note, mode: a note's half, words and mode;
 *   again: the user tapped Try again after a turn that said nothing to them: the turn is theirs; at: when it was queued (GATHER's cap counts from it);
 *   input: it comes from the user's input (Koe answering what was heard), so a turn gathers for it; why: a note's reason (NoteWhy);
 *   call: the call of Kokoro's a gated note stands for (its show or ask); seq: a note's entry in the conversation
 * @typedef {'sleeping' | 'thinking' | 'speaking' | 'listening' | 'hearing' | 'waiting' | 'away' | 'offline'} StateName
 * @typedef {import('../voice/resolve.js').Heard} Heard
 * @typedef {import('./listen.js').Got} Got
 * @typedef {{ id: string, kind: 'ask' | 'wait', resolve: (v: Got) => void, listening?: boolean, hold?: () => void, arm?: () => void, tool?: boolean }} Pending
 *   waiting for the user; listening: an answer may be spoken; hold and arm stop and start the silence limit; tool: the wait tool's
 * @typedef {{ name: StateName, label: string, detail?: string }} State
 * @typedef {{ tone: 'warn' | 'info', title: string, body: string, actions?: { label: string, primary?: boolean, run: () => void | Promise<void> }[], key?: string }} Notice
 *   key: names a card a later turn takes down (the clear event, when that turn works)
 * @typedef {{ stepsPerWake?: number, spendPerDay?: number, wakesPerHour?: number, quietHours?: { from: string, to: string } }} Budgets
 * @typedef {{ personality: string, cacheTtl: '5m' | '1h', askBeforeTuning: boolean, budgets: Budgets, compaction: { threshold: number, maxRequestMiB: number } }} AgentSettings
 * @typedef {import('./tools.js').Tool & { pluginId: string }} LoopTool
 * @typedef {import('./transcript.js').Resolved} Resolved
 * @typedef {object} Half  how the loop runs as a half of Shiori (the Koe and Kokoro plan, "Agent as a half")
 * @property {'one' | 'kokoro' | 'koe'} name @property {string} tag its model.turn tag
 * @property {string} role the role it calls
 * @property {boolean} registryTools false: its own loop tools only @property {() => boolean} voice whether it may use the voice now
 * @property {boolean} logVoice @property {boolean} housekeeping @property {string} [nonce] Koe's, in its notes' marker
 * @property {boolean} [listenLast] its speak doesn't listen when a question to the other half or a wait follows it: they run at once
 * @property {() => import('./transcript.js').HalfName} [rules] whose rules its transcript reads now
 * @property {(snapshot: import('./context.js').Snapshot) => string} [system]
 * @property {(c: { now: number, timeZone: string, voice: string, online: boolean, reasons: string[], place?: string, activity?: string, voiceWhy?: string }) => Promise<string>} [tail] in place of the now block
 * @property {() => string | null} [koe] Koe's state, for Kokoro's now block @property {() => Promise<string[]>} [hidden] loop tools left out now
 * @property {(messages: import('../llm/contract.js').Message[]) => Promise<import('../llm/contract.js').Message[]>} [sendable]
 * @property {(type: string) => Record<string, any>} [mark] what it adds to an event of a type it writes
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} [serial] both halves' writes, one at a time
 * @property {(e: any, r: Resolved) => Promise<void> | void} [logged] an event it wrote, for the other half
 * @property {(call: { id: string, name: string, input: any, wake: string }) => Promise<import('./tools.js').ToolOutput | null>} [gate] a call not run, and its result
 * @property {(why: string, e: unknown) => boolean | string} [failed] true: the other half tells the user (or nobody waited), so no card; words: the
 *   card says these instead (both halves down)
 * @property {(context?: { from: number, to: number }) => void} [calling] a model call starts, with what its request holds
 * @property {() => Promise<unknown>} [ready] waited for before each turn
 * @property {(names: string[]) => void} [replied] a reply's tool calls, before they run
 * @property {() => Promise<boolean>} [restart] whether it takes up what a conversation owes as it opens
 * @property {(t: TurnEnd) => void} [ended] @property {() => boolean} [hushed]  another voice plays (a live session): annai's reminders are shown, not said
 * @property {(notes: Wake[]) => Promise<void>} [unsaid]  Kokoro's notes for the user that its turn never passed on (Koe's): annai shows what it can of them
 * @property {(wakes: Wake[]) => number} [hold]  how long a turn about to start waits for the user, in ms (Infinity: until their input changes); 0: go
 * @typedef {{ wakeId: string, ok: boolean, finalText: string, told: boolean, slept: boolean, spoke: boolean, kinds: string[] }} TurnEnd
 *   finalText: a last reply's text with no tool calls; told: it told the other half (or a gated call did)
 */

/** Shiori as one half, as she always was. @type {Half} */
export const ONE = Object.freeze({
  name: /** @type {const} */ ('one'), tag: TALK_TAG, role: 'main', registryTools: true, voice: () => true, logVoice: true, housekeeping: true,
});
/** No registry: a half with only its own tools. */
const NO_TOOLS = /** @type {any} */ ({ entries: () => [] });

/** The dock's words for each state (spec §16.3). */
export const LABELS = Object.freeze({
  sleeping: 'Tap to talk', thinking: 'Thinking · tap to stop', speaking: 'Tap to interrupt', listening: 'Listening', hearing: 'Hearing you', waiting: 'Waiting for your OK',
  away: 'Working on …', offline: 'Offline · reminders still work',
});
export const SPEAK_RESULT = "Shown on screen. Voice is off, so you didn't listen; the user may type.";
/** Kokoro's notes that aren't for the user: Koe hears them, and may end quietly. */
const NOT_FOR_USER = ['nothing-to-add', 'stopped'];
/** A note from Kokoro that Koe owes the user (spec §6.8): what Kokoro found, or couldn't. @param {Wake} w */
export const isForUser = (w) => w.kind === 'note' && w.from === 'kokoro' && !NOT_FOR_USER.includes(String(w.why));
/** What Koe is asked when Kokoro's note for the user ended its turn unsaid, text or live: only what the note adds (§6.8), or already_told. */
export const NOTE_UNSAID = "Kokoro's note hasn't reached the user. Only what you say, show or ask reaches them; anything you write for yourself never does. Tell them what it adds, in your own words; if you have already told them all of it, call already_told.";
/** How many steps Koe takes after the cue while it still owes the user, before annai's backstop. */
const AFTER_CUE = 2;
/** Her turn for the user's own message ended with nothing said to them: she is asked once more (emulator pass, spec §7.1). */
export const UNANSWERED = "The user hasn't been answered. Only speak, show and ask reach them; anything else you write is your private notes, which they never see.";
/** The words a Try again wakes her with. */
const AGAIN = 'the user tapped Try again: answer their last message';
/**
 * How long a photo's description may take, in seconds (review A5): the same as a role waits for a model's first words (§9.6),
 * as a turn shouldn't wait on a side job longer than on its own model; a description is a few sentences.
 */
export const DESCRIBE_S = 30;
/**
 * And a PDF's telling (the fix pass): its words, up to 3,000 tokens, take a slow model (a local one, at some 35 tokens a second)
 * near 90 seconds, where a photo's few sentences fit in 30. Only Kokoro and one Shiori wait for it; Koe never does.
 */
export const DESCRIBE_PDF_S = 90;
/** What a PDF told only up to the output limit ends with. */
const GOES_ON = ' …(it stops here: the PDF goes on)';
/** What a model that sees photos is asked, for one that can't (emulator pass, 5b). */
const DESCRIBE = 'Describe this photo for someone who can\'t see it, in a few plain sentences: what is in it, any writing in it word for word, and anything a traveller would want to know. Reply with the description only.';
/** And for one that can't read PDFs (the second emulator pass): the PDF's own words, as annai has no PDF library (spec §7.2). */
const DESCRIBE_PDF = "Give the content of this PDF for someone who can't open it: its text word for word as far as it goes (dates, times, names, addresses, prices and numbers exactly), tables as plain lines, and what any picture in it shows. Reply with the content only.";
/**
 * Gathering the user's messages before a turn starts (spec §6.1), in seconds. quiet: how long their input must be still before
 * Kokoro behind Koe starts (a line typed in parts); photo: after a photo on its own, which words often follow; typing: a typing
 * box that holds text stops counting as typing this long after its last keystroke (text left in it); most: the longest any
 * turn waits, from its first wake (they are waiting too). A turn that has started never restarts.
 */
export const GATHER = Object.freeze({ quiet: 1.5, photo: 3, typing: 5, most: 20 });
/** How many turns that worked try to write a segment down before it is written as not transcribed (spec §10.3). */
export const WRITE_TRIES = 3;


/**
 * A wake the user started: what they typed, sent or said (heard words reach a wake only when not dismissed as chatter, review
 * a2), a choice they tapped, or their Try again. @param {Wake} w
 */
export const isTheirs = (w) => w.kind === 'user' || w.kind === 'choice' || (w.kind === 'heard' && w.gate !== 'chatter') || Boolean(w.again);

/** The card types running plugins add (spec §16.4). @param {import('../registry.js').Registry} registry @returns {any[]} */
const cardTypes = (registry) => registry.list('ui:card-type').filter((t) => typeof t?.type === 'string');
/** A link the screen may open: http(s) only. @param {any} l */
const webLink = (l) => {
  try {
    return typeof l?.url === 'string' && ['http:', 'https:'].includes(new URL(l.url).protocol);
  } catch {
    return false;
  }
};
/** A path under one of the roots, with no step out of it. @param {unknown} p @param {RegExp} root */
const inside = (p, root) => typeof p === 'string' && root.test(p) && !p.split('/').some((x) => x === '..' || x === '.');

/**
 * A card as show takes it (spec §7.1, §16.4), Shiori's own or Kokoro's that annai shows itself: a plugin's kind of card must be
 * running and its data valid, or the card is refused; links that aren't http(s), a photo outside the trip or /me, a booking outside
 * the trip, and choices that aren't words are left out. @param {any} card @param {import('../registry.js').Registry} registry
 * @returns {{ card: any } | { error: string }}
 */
export function checkCard(card, registry) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return { error: 'Error: show needs a card.' };
  if (card.type !== undefined) {
    const types = cardTypes(registry);
    const type = types.find((t) => t.type === card.type);
    if (!type) return { error: `Error: there is no card type ${card.type}. Types: ${types.map((t) => t.type).join(', ') || 'none'}.` };
    const wrong = type.schema ? validate(type.schema, card.data ?? {}) : [];
    if (wrong.length) return { error: `Error: the ${type.type} card's data isn't valid: ${wrong.join('; ')}` };
  }
  const { links, image, booking, choice, ...rest } = card;
  const kept = {
    links: Array.isArray(links) ? links.filter(webLink) : [],
    choice: Array.isArray(choice) ? choice.filter((c) => typeof c === 'string' && c.trim()) : [],
  };
  return {
    card: {
      ...rest, ...(kept.links.length ? { links: kept.links } : {}), ...(inside(image, /^\/(trip|me)\//) ? { image } : {}),
      ...(inside(booking, /^\/trip\//) ? { booking } : {}), ...(kept.choice.length ? { choice: kept.choice } : {}),
    },
  };
}

/** An ask as the ask tool takes it: a question, and 1 to 6 options that are words, else why not. @param {any} i @returns {{ question: string, options: string[] } | { error: string }} */
export function checkAsk(i) {
  const options = Array.isArray(i?.options) ? i.options : [];
  if (!options.length || options.length > 6 || options.some((/** @type {unknown} */ o) => typeof o !== 'string' || !o.trim())) return { error: 'Error: ask needs options: a list of 1 to 6 short texts, one per button.' };
  if (typeof i.question !== 'string' || !i.question.trim()) return { error: 'Error: ask needs a question.' };
  return { question: i.question, options };
}

export class Agent {
  scope = ME;
  /** @type {string | null} */
  trip = null;
  /** @type {State} */
  state = { name: 'sleeping', label: LABELS.sleeping };
  transcript = new Transcript();
  /** The conversation being opened, if any: screens wait for it before they read it. @type {Promise<void>} */
  opening = Promise.resolve();
  /** The conversation opened last owed an answer (a restart wake takes it up). */
  owed = false;
  /** @type {import('./context.js').Snapshot | null} */
  #snapshot = null;
  #warmth = new Warmth();
  /** @type {Wake[]} */
  #queue = [];
  #busy = false;
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {Pending | null} */
  #pending = null;
  /** @type {(() => void)[]} */
  #idle = [];
  /** @type {number[]} times of the wakes in the last hour that weren't the user's (spec §6.6) */
  #recentWakes = [];
  /** Wakes whose budgets are being checked: idle() waits for them. */
  #checking = 0;
  /** Housekeeping is due (spec §6.5): it waits for a pause. */
  #due = false;
  /** @type {any} the timer that runs warm housekeeping shortly before the cache expires */
  #timer = null;
  /** The prompt the last call sent, in tokens, as the provider counted it. */
  #lastPrompt = 0;
  /** @type {LoopTool[]} */
  #loopTools;
  /** The trip of the conversation being opened, or open: what the user is looking at. @type {string | null} */
  #target = null;
  /** Opens asked for and not finished: no turn starts meanwhile. */
  #opens = 0;
  /** Counts opens: only the latest one does anything. */
  #generation = 0;
  /** Reminders and the other half's events written while a conversation was being opened, for it once open. @type {{ scope: string, e: any, r?: Resolved }[]} */
  #late = [];
  /** @type {(() => void)[]} waiting for the running turn or housekeeping to end */
  #free = [];
  /** The page is being left. */
  #leaving = false;
  /** @type {PhotoCopies | null} */
  #photos = null;
  /** The wake whose photo couldn't be sent: its card already says why. */
  #photoCard = '';
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set(), open: new Set(), clear: new Set() };
  /** Speaking and hearing (spec §10); null: no voice here. @type {import('../voice/voice.js').Voice | null} */
  voice = null;
  /** Where the user is and what they are doing, for the now block (spec §6.3): live mode's. @type {(() => { place?: string, activity?: string }) | null} */
  sense = null;
  /** Speech streaming in, by speak call (spec §10.1). @type {Map<string, import('../voice/speaker.js').Utterance>} */
  #utterances = new Map();
  /**
   * The listening window (spec §10.4), and who opened it: a tap (until the first thing said, or a
   * silence) or the turn (until it ends). @type {{ owner: 'tap' | 'turn', session: { stop(): void } | null } | null}
   */
  #ear = null;
  /** Openings of the window, one at a time. @type {Promise<unknown>} */
  #earLock = Promise.resolve();
  /** Heard segments are handled one at a time, in order. @type {Promise<void>} */
  #hearing = Promise.resolve();
  /** Closes a tap's window nobody spoke into. @type {any} */
  #quiet = null;
  /** Voice for the turn running now (spec §10.5). */
  #voiceNow = false;
  /** Heard while she worked and judged not meant for her: written at her next step. @type {Heard[]} */
  #chatter = [];
  /** What she said aloud last, for the gate. */
  #lastSaid = '';
  /** A card said she can't hear: until listening works again, it isn't said again for every speak. */
  #toldDeaf = false;
  /** The user stopped her during this step: nothing more is said until she has listened. */
  #cut = false;
  /** Chatter sent her back to sleep during this step: a later speak in the reply isn't said (spec §10.4). */
  #wentToSleep = false;
  /** The speak whose words play as the reply streams in; a later speak in the reply plays after this one has listened. */
  #streaming = '';
  /** The model that answered last in this turn: it heard any audio sent (spec §10.3). @type {string | null} */
  #heardBy = null;
  /** The device's clock and zone, which a simulation's (useClock) never replaces: budgets and other conversations are measured by them. @type {{ now: () => number, timeZone: () => string }} */
  #real;
  /** While a simulation's clock is in use, its own conversation: only that one is stamped in its time. @type {string | null} */
  #simScope = null;
  /** This turn speaks because the user asked to hear her, with voice mode off: it doesn't listen (spec §10.5, §6.2). */
  #aloudOnly = false;
  /** Write-downs that failed, by segment id (WRITE_TRIES). @type {Map<string, number>} */
  #writeTries = new Map();
  /** @type {Half} */
  #half = ONE;
  /** The last entry its transcript took. */
  #seen = 0;
  /** During a model call the other half's events wait in the inbox, so the call's own turn goes first. */
  #calling = false;
  /** @type {{ e: any, r: Resolved }[]} */
  #inbox = [];
  /** The other half tidied up during a model call: read the conversation again after its turn. */
  #rereadDue = false;
  /** The seq of its last model turn taken. */
  #lastTurn = 0;
  /** @type {AbortController | null} cuts the model call running now, not the turn */
  #callCut = null;
  /** A note cut her speech: speak says so, and doesn't listen. */
  #noteCut = false;
  /** A turn runs. */
  #turning = false;
  /** Whether the half might use the voice when its turn's voice was last worked out. */
  #mayVoice = true;
  /** What the running turn did (Half.ended). */
  #facts = { finalText: '', told: false, slept: false, spoke: false, wrote: false, kinds: /** @type {string[]} */ ([]) };
  /** The user stopped the running turn (a tap, or the sign's Stop), not annai opening another conversation. */
  #userStop = false;
  /** Counts what reached the user (speak, show, ask, a reply shown as written): what was owed before it is settled. */
  #reached = 0;
  /** The typing box holds text (the dock says so): a turn of theirs waits for them (GATHER). */
  #typing = false;
  /** Ends #typing GATHER.typing after the last keystroke. @type {any} */
  #typingTimer = null;
  /** The camera's photo is being made, and its timer. @type {any} */
  #photoTimer = null;
  #coming = false;
  /** Wakes a turn waiting for the user to look again. @type {(() => void) | null} */
  #poke = null;
  /** A turn is gathering the user's messages (GATHER): it hasn't started. */
  #gathering = false;
  /** The microphone hears the user now: from speech starting until its segment comes, or it wasn't speech (GATHER). */
  #speaking = false;
  /** The role's list as the last turn found it: the warm model goes first only while the user hasn't changed it. @type {string | null} */
  #order = null;
  /**
   * PDFs told in words in the open conversation, by its scope and the hash of the bytes told: a second read isn't sent again. A
   * conversation switch and Erase forget them. @type {Map<string, string>}
   */
  #toldPdfs = new Map();
  /** The last entry a request read whose reply then reached the user: notes up to it were answered (Koe's). */
  #reachedTo = { scope: '', to: 0 };

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, llm: any, registry: import('../registry.js').Registry,
   *   now?: () => number, online?: () => boolean, timeZone?: () => string, fetch?: (url: string, init?: RequestInit) => Promise<Response>, secondMs?: number,
   *   codec?: ConstructorParameters<typeof PhotoCopies>[0]['codec'], voice?: import('../voice/voice.js').Voice | null,
   *   timers?: { set: (fn: () => void, ms: number) => any, clear: (handle: any) => void }, half?: Half }} c
   */
  constructor({ store, ws, llm, registry, codec, voice, half = ONE, now = Date.now, online = () => globalThis.navigator?.onLine !== false, timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone, fetch: get, secondMs = 1000,
    timers = { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => /** @type {any} */ (setTimeout(fn, ms)), clear: (/** @type {any} */ h) => clearTimeout(h) } }) {
    this.store = store;
    this.ws = ws;
    /** @type {any} the llm service: call(), config(), decide() */
    this.llm = llm;
    this.registry = registry;
    this.now = now;
    this.online = online;
    this.timeZone = timeZone;
    this.#real = { now, timeZone };
    this.secondMs = secondMs;
    /** How housekeeping waits for the cache (tests pass their own). */
    this.timers = timers;
    this.get = get ?? ((/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => fetch(url, init));
    /** The browser's photo codec: request copies and crops (spec §4.8). Without one, photos go as they are. */
    this.codec = codec ?? null;
    this.#photos = codec ? new PhotoCopies({ codec, read: (hash) => blobBytes(this.store, hash) }) : null;
    this.#half = half;
    this.transcript = new Transcript({ half: this.#rules(), nonce: half.nonce });
    this.#loopTools = this.#talkTools();
    this.voice = voice ?? null;
    // The mode read as annai starts is no change: only changes are logged (spec §4.5).
    this.voice?.onChange((m, first) => { if (!first) this.#voiceChanged(m); });
    if (!online()) this.state = { name: 'offline', label: LABELS.offline };
    // The connection coming and going: the dock says so at once, not only when a turn ends (emulator pass m2b #10).
    for (const type of ['online', 'offline']) globalThis.addEventListener?.(type, () => this.#connection());
  }

  /** While she rests, her state follows the connection (spec §16.3). */
  #connection() {
    if (!this.#busy && (this.state.name === 'sleeping' || this.state.name === 'offline')) this.#setState(this.online() ? 'sleeping' : 'offline');
  }

  #rules() {
    return this.#half.rules?.() ?? this.#half.name;
  }

  /** @param {string} scope @param {{ before?: number }} [o] */
  #load(scope, o = {}) {
    return Transcript.load(this.store, scope, { ...o, half: this.#rules(), nonce: this.#half.nonce });
  }

  /** @param {string} type */
  #mark(type) {
    return this.#half.mark?.(type) ?? {};
  }

  /** A tapped answer is marked chosen for the other half; one half's log is as it was. */
  #chose() {
    return this.#rules() === 'one' ? {} : { chose: true };
  }

  /**
   * The photo limits of every main model that takes photos, the stricter of each (spec §9.2): any
   * of them may answer after a fallback, so what is sent fits them all.
   */
  async #mainImages() {
    const cfg = await this.llm.config();
    /** @type {import('./refusals.js').Learned} */
    let images = {};
    // Koe's copies of the user's photos are Kokoro's too.
    const role = this.#half.role;
    for (const id of [...candidates(cfg, role), ...(role === 'main' ? [] : candidates(cfg, 'main'))]) {
      const m = cfg.models[id] ? modelOf(cfg.models[id]) : null;
      if (m?.input?.includes('image')) images = stricter(images, m.images ?? {});
    }
    return images;
  }

  /** What photos sent now must fit: the stricter of the request settings and the main models' limits (spec §4.8, §9.2). */
  async #limits() {
    return requestLimits(photoSettings(await readAppSettings(this.ws)).request, await this.#mainImages());
  }

  /** A request copy of a stored photo, or a crop of it (spec §4.8). @param {import('../request-photos.js').Source} source @param {import('../request-photos.js').Crop} [crop] */
  async #copy(source, crop) {
    if (!this.#photos) return { hash: source.hash, mediaType: source.type, width: source.width ?? null, height: source.height ?? null, made: false };
    return this.#photos.copy(source, await this.#limits(), crop);
  }

  /** open: another conversation was opened ({ trip, scope }), for live mode to follow (spec §11); clear: a card's key, to take down. @param {'state' | 'event' | 'notice' | 'open' | 'clear'} kind @param {(x: any) => void} fn */
  on(kind, fn) {
    this.#on[kind].add(fn);
    return () => this.#on[kind].delete(fn);
  }

  /** Erase: what it keeps in memory of the conversations' files goes. */
  forgetTold() {
    this.#toldPdfs.clear();
  }

  /** The user's Try again after a turn that said nothing to them: her turn again, answering their last message. */
  tryAgain() {
    this.wake({ kind: 'cue', text: AGAIN, again: true, scope: this.scope });
  }

  /** A system card, with any key annai keeps blanked from what it says (spec §9.9). @param {Notice} n */
  async #notice(n) {
    this.#emit('notice', { ...n, title: await withoutSecrets(this.store, n.title), body: await withoutSecrets(this.store, n.body) });
  }

  /** @param {'state' | 'event' | 'notice' | 'open' | 'clear'} kind @param {any} x */
  #emit(kind, x) {
    for (const fn of this.#on[kind]) {
      try {
        fn(x);
      } catch (e) {
        console.warn('a listener failed', e);
      }
    }
  }

  /** @param {StateName} name @param {string} [detail] */
  #setState(name, detail) {
    const label = name === 'away' && detail ? `Working on ${detail}` : LABELS[name];
    this.state = { name, label, ...(detail ? { detail } : {}) };
    this.#emit('state', this.state);
    this.poke(); // a turn waiting while the user speaks looks again
  }

  /** @param {LoopTool[]} tools Self tools (spec §7.2), offered after the talk tools */
  addLoopTools(tools) {
    this.#loopTools = [...this.#loopTools, ...tools];
  }

  /** @returns {Promise<AgentSettings>} */
  async settings() {
    const s = (await readAppSettings(this.ws)).shiori ?? {};
    return {
      personality: s.personality ?? 'shiori', cacheTtl: wantedTtl(s.cacheTtl), askBeforeTuning: Boolean(s.askBeforeTuning),
      budgets: s.budgets ?? {}, compaction: { threshold: 0.7, maxRequestMiB: 8, ...(s.compaction ?? {}) },
    };
  }

  /** The trip of the conversation being opened, or open (trip and scope change only once it is read). */
  get target() {
    return this.#target;
  }

  /**
   * Opens the conversation of a trip (or of "me" when none is open). A turn in progress is stopped
   * at once. Opens run one after another and only the latest counts; until it is done no turn
   * starts, so what the user types meanwhile goes to the conversation being opened. Tool calls
   * left open by a crash get results, and a catch-up wake runs (spec §6.7).
   * @param {string | null} trip
   */
  open(trip) {
    this.#closeEar();
    this.voice?.speaker.stop();
    this.#target = trip;
    this.#toldPdfs.clear(); // a conversation's told PDFs are its own
    this.#opens++;
    this.poke(); // a turn still gathering the user's messages doesn't start (review A2)
    const generation = ++this.#generation;
    if (this.#busy) this.#halt();
    this.#clearTimer();
    this.opening = this.opening.catch(() => {}).then(() => this.#open(trip, generation)).finally(() => {
      this.#opens--;
      if (!this.#opens) this.#drain();
    });
    return this.opening;
  }

  /** @param {string | null} trip @param {number} generation */
  async #open(trip, generation) {
    if (generation !== this.#generation) return;
    await this.#whenFree();
    const scope = trip ?? ME;
    const transcript = await this.#load(scope);
    if (generation !== this.#generation) return;
    const repaired = await repair(this.store, scope, transcript, this.#mark('tool.result'));
    if (generation !== this.#generation) return;
    await this.#keepElsewhere(scope);
    if (generation !== this.#generation) return;
    // Something owed when it opens: a restart wake, unless the other half takes it up (Half.restart).
    const owed = Boolean(repaired || transcript.unanswered) && (await (this.#half.restart?.() ?? true));
    if (generation !== this.#generation) return;
    this.trip = trip;
    this.scope = scope;
    this.transcript = transcript;
    this.#seen = transcript.through;
    this.#inbox = [];
    this.#lastTurn = 0; // seqs are each conversation's own
    for (const l of this.#late.splice(0)) if (l.scope === scope) this.#joinLate(l.e, l.r);
    this.#snapshot = null;
    // The last conversation's housekeeping stays with it: it is checked again at its next turn.
    this.#due = false;
    this.#lastPrompt = 0;
    this.#clearTimer();
    this.owed = owed;
    if (owed) {
      const text = repaired ? 'annai restarted while you were working, so your unfinished tool calls were stopped.'
        : transcript.waiting === 'wake' ? "You haven't answered this yet: it came while this conversation was closed, or before annai restarted."
          : transcript.waiting === 'turn' ? 'The conversation closed in the middle of your turn (annai restarted, or another one was opened): your tool calls had come back, and you had not gone on yet.'
            : 'The conversation closed before you answered (annai restarted, or another one was opened).';
      this.#queue.push({ kind: 'restart', text, scope }); // it runs once the open is done
    }
    this.#emit('open', { trip, scope });
  }

  /**
   * Wakes still queued for another conversation than the one opening (typed there before the user
   * left it) are written into it, so nothing is lost: it catches up when it is opened again.
   * @param {string} scope
   */
  async #keepElsewhere(scope) {
    const elsewhere = this.#queue.filter((w) => w.scope !== scope);
    if (!elsewhere.length) return;
    this.#queue = this.#queue.filter((w) => w.scope === scope);
    for (const s of new Set(elsewhere.map((w) => /** @type {string} */ (w.scope)))) {
      await this.#logWakes(elsewhere.filter((w) => w.scope === s), newId('w'), false, (ev) => record(this.store, s, { now: this.#stamp(s), ...ev }), s === ME ? null : s);
    }
  }

  /** Writes a wake into a conversation that isn't open. idle() waits for it, and so can the caller. @param {string} scope @param {Wake} w */
  #keepFor(scope, w) {
    this.#checking++;
    return this.#logWakes([{ ...w, scope }], newId('w'), false, (ev) => record(this.store, scope, { now: this.#stamp(scope), ...ev }), scope === ME ? null : scope)
      .catch(() => {})
      .finally(() => {
        this.#checking--;
        this.#settle();
      });
  }

  /** Settles when no turn or housekeeping is running (queued wakes may wait). */
  #whenFree() {
    if (!this.#busy) return Promise.resolve();
    return new Promise((resolve) => { this.#free.push(() => resolve(undefined)); });
  }

  /** After a turn or housekeeping: tells whoever waits for it to end, and for everything to be done. */
  #settle() {
    if (this.#busy) return;
    for (const fn of this.#free.splice(0)) fn();
    if (!this.#queue.length && !this.#checking) for (const fn of this.#idle.splice(0)) fn();
  }

  #clearTimer() {
    if (this.#timer !== null) this.timers.clear(this.#timer);
    this.#timer = null;
  }

  /** @param {Wake} w */
  #push(w) {
    this.#queue.push({ ...w, scope: this.#target ?? ME, at: Date.now() });
    if (w.kind === 'note') this.#noted();
    this.poke();
  }

  /** The user is typing (the typing box holds text, called at each keystroke) or has stopped (GATHER). @param {boolean} on */
  typing(on) {
    clearTimeout(this.#typingTimer);
    this.#typing = on;
    // Text left in the box with no keystroke stops counting as typing (review A3).
    if (on) this.#typingTimer = setTimeout(() => this.typing(false), GATHER.typing * this.secondMs);
    this.#typingTimer?.unref?.(); // in Node (tests), it must not keep the process alive
    this.poke();
  }

  /** The typing box holds text, and a keystroke came lately. */
  get typingNow() {
    return this.#typing;
  }

  /** The camera came back, and its photo is still being made: a turn of the user's waits for it (at most the GATHER cap). @param {boolean} on */
  photoComing(on) {
    clearTimeout(this.#photoTimer);
    this.#coming = on;
    if (on) this.#photoTimer = setTimeout(() => this.photoComing(false), GATHER.most * this.secondMs);
    this.#photoTimer?.unref?.();
    this.poke();
  }

  /** The camera's photo is on its way. */
  get photoNow() {
    return this.#coming;
  }

  /** The microphone hears the user now. */
  get speakingNow() {
    return this.#speaking;
  }

  /** What the user is doing changed: a turn waiting for them looks again. */
  poke() {
    this.#poke?.();
  }

  /** Before a turn starts (GATHER): one Shiori waits only while a turn of theirs finds them typing or speaking; a half may say otherwise. */
  async #gather() {
    this.#gathering = true;
    try {
      await this.#gatherNow();
    } finally {
      this.#gathering = false;
    }
  }

  async #gatherNow() {
    for (;;) {
      const wakes = this.#queue.filter((w) => w.scope === this.scope);
      // From the first wake (review a5): a wake that waited out a long turn doesn't wait again.
      const left = Math.min(...wakes.map((w) => w.at ?? Date.now())) + GATHER.most * this.secondMs - Date.now();
      const hold = this.#half.hold ? this.#half.hold(wakes) : wakes.some(isTheirs) && (this.#typing || this.#speaking || this.#coming) ? Infinity : 0;
      const wait = wakes.length && !this.#opens && left > 0 ? Math.min(hold, left) : 0;
      if (wait <= 0) return;
      await new Promise((resolve) => {
        const go = () => {
          clearTimeout(timer);
          if (this.#poke === go) this.#poke = null;
          resolve(undefined);
        };
        const timer = setTimeout(go, wait);
        this.#poke = go;
      });
    }
  }

  /**
   * A note queued ends a wait for one (Koe's wait means "Kokoro is working"), and Koe's listening after
   * it spoke, so the note is said with no dead air; while the user speaks, their words come first.
   */
  #noted() {
    const p = this.#pending;
    const note = this.#queue.find((w) => w.kind === 'note' && w.scope === this.scope);
    if (!note || !p || !(p.tool || (p.listening && p.kind === 'wait')) || this.state.name === 'hearing') return;
    this.#pending = null;
    p.resolve({ note: note.from ?? 'kokoro' });
  }

  /**
   * The user wrote, or sent photos (spec §4.8, §16.2). It answers a pending ask or wait; otherwise
   * it wakes Shiori, or reaches her next call. Photos sent with an answer reach her right after it.
   * @param {string} text @param {{ photos?: SentPhoto[] }} [o]
   */
  send(text, o = {}) {
    const photos = (o.photos ?? []).filter((x) => x && typeof x.path === 'string');
    const t = String(text ?? '').trim() || (photos.length ? '(a photo)' : '');
    if (!t) return;
    const p = this.#pending;
    if (p) {
      this.#pending = null;
      p.resolve({ text: t });
      if (photos.length) this.#push({ kind: 'user', text: '(a photo)', photos });
      return;
    }
    this.#push({ kind: 'user', text: t, ...(photos.length ? { photos } : {}) });
    this.#drain();
  }

  /** A tap on one of an ask's options. @param {string} callId @param {string} option */
  answer(callId, option) {
    const p = this.#pending;
    if (p && p.id === callId) {
      this.#pending = null;
      p.resolve({ chosen: option });
    } else {
      this.send(option);
    }
  }

  /**
   * A wake that isn't the user typing: a plugin, a new file, a choice tapped later (spec §6.1).
   * Quiet hours hold one that isn't the user's; a per-hour limit can drop it (§6.6).
   * @param {Wake} w
   * @returns {Promise<void>} settles once a wake for a conversation that isn't open is written; at once for any other
   */
  wake(w) {
    // A wake for another conversation than the one open (files added to another trip) is written
    // into it now, and answered when it opens (spec §6.1, §7.3).
    if (w.scope && w.scope !== (this.#target ?? ME)) return this.#keepFor(w.scope, w);
    if (['user', 'choice', 'restart', 'file', 'live', 'recap', 'note', 'cue', 'halves'].includes(w.kind)) {
      this.enqueue(w);
      return Promise.resolve();
    }
    this.#checking++;
    this.admit(w).then((ok) => { if (ok) this.enqueue(w); }).finally(() => {
      this.#checking--;
      this.#settle();
    });
    return Promise.resolve();
  }

  /** @param {(w: Wake) => boolean} which queued wakes to take out @returns {Wake[]} those taken out */
  drop(which) {
    const out = this.#queue.filter(which);
    this.#queue = this.#queue.filter((w) => !which(w));
    return out;
  }

  /** Queues a wake and starts a turn, past the budgets (admit). @param {Wake} w */
  enqueue(w) {
    this.#push(w);
    this.#drain();
  }

  /**
   * The budgets of a wake not the user's (spec §6.6): quiet hours hold it, the hourly limit drops it with
   * a card; its reminders are said either way. @param {Wake} w @param {(w: Wake) => unknown} [again] wakes it after quiet hours
   * @returns {Promise<boolean>} whether it may wake her now
   */
  async admit(w, again = (x) => this.wake(x)) {
    const { budgets } = await this.settings();
    const now = this.now(); // quiet hours follow the day as lived, a simulation's too
    if (budgets.quietHours && inQuiet(now, budgets.quietHours, this.timeZone())) {
      // Quiet hours hold Shiori, not the reminders (spec §11.3).
      if (w.fallbacks?.length) this.remind(w.fallbacks).catch(() => {});
      const later = { ...w, fallbacks: [] };
      const held = setTimeout(() => again(later), Math.max(1000, quietEnds(now, budgets.quietHours, this.timeZone()) - now));
      /** @type {any} */ (held).unref?.(); // in Node (tests), a held wake must not keep the process alive
      return false;
    }
    // Wakes an hour count real hours, even during a simulation (review 2a).
    const real = this.#real.now();
    this.#recentWakes = this.#recentWakes.filter((t) => t > real - 3_600_000 && t <= real);
    if (budgets.wakesPerHour && this.#recentWakes.length >= budgets.wakesPerHour) {
      this.#notice({ tone: 'info', title: 'Shiori skipped a wake', body: `${w.plugin ? `The plugin ${w.plugin}` : 'Something'} woke her more than the ${budgets.wakesPerHour} times an hour you allow: ${w.text}` });
      if (w.fallbacks?.length) this.remind(w.fallbacks).catch(() => {});
      return false;
    }
    this.#recentWakes.push(real);
    return true;
  }

  /** An immediate note: the model call or speech running now stops; the turn goes on with what is queued. */
  cutIn() {
    this.#callCut?.abort();
    if (this.voice && this.#half.voice() && this.voice.speaker.speaking) {
      this.#noteCut = true;
      this.voice.speaker.stop();
      for (const u of this.#utterances.values()) u.stop();
    }
  }

  /** A live session takes the microphone and the speaker (K5): this half lets go of both now. */
  release() {
    this.#voiceNow = false;
    this.#closeEar();
    this.voice?.speaker.stop();
  }

  /**
   * What the user typed or sent to a live session (K5), written as a turn writes it, photos as request copies.
   * @param {string} text @param {SentPhoto[]} photos @param {boolean} [chose] a tap on a live ask's buttons
   */
  async logUser(text, photos, chose = false) {
    const { images, blobs } = photos.length ? await this.#userPhotos(photos, this.trip) : { images: [], blobs: [] };
    return this.#log({ type: 'msg.user', actor: 'user', data: { ...(images.length ? { images } : {}), ...(chose ? { chose: true } : {}) }, texts: [['text', String(text ?? '').trim() || '(a photo)']], blobs });
  }

  /** A live session's tools (K5): this half's now, less speak, wait and sleep (plan decision 29). */
  async liveTools() {
    return (await this.#toolsNow()).tools.filter((t) => !['speak', 'wait', 'sleep'].includes(t.name));
  }

  /** A live session's tool call, run and recorded as this half's own, and answered at once (plan decision 10). @param {{ id: string, name: string, input: any }} c @param {string} wake */
  async liveCall(c, wake) {
    return this.#runCall(c, await this.liveTools(), { wakeId: wake, signal: new AbortController().signal, model: null, sleeping: false, live: true });
  }

  /** Its turn has the voice, or its tap's window is open: the other half waits to take the voice. */
  get voicing() {
    return (this.#turning && this.#voiceNow) || Boolean(this.#ear);
  }

  /** A turn runs (not one still gathering the user's messages, GATHER). */
  get turning() {
    return this.#turning;
  }

  /** The wait tool runs (not speak's listening). */
  get waiting() {
    return Boolean(this.#pending?.tool);
  }

  get pendingId() {
    return this.#pending?.id ?? null;
  }

  /** The other half's event, added once by this half's rules, in the log's order (plan decision 2). @param {any} e @param {Resolved} r */
  async observe(e, r) {
    if (this.#opens && e.scope === (this.#target ?? ME)) {
      this.#late.push({ scope: e.scope, e, r });
      return;
    }
    if (e.scope !== this.scope) return;
    if (e.type === 'compaction') {
      if (this.#half.name !== 'koe') return;
      if (this.#calling) this.#rereadDue = true;
      else await this.reread();
      return;
    }
    if (this.#calling) this.#inbox.push({ e, r });
    else this.#apply(e, r);
  }

  async reread() {
    this.transcript = await this.#load(this.scope);
    this.#seen = this.transcript.through;
    this.#inbox = [];
  }

  /** @param {any} e @param {Resolved} r */
  #apply(e, r) {
    this.#flush(e.seq);
    if (e.seq <= this.#seen) return;
    this.#seen = e.seq;
    this.transcript.apply(e, r);
  }

  /** @param {number} [before] */
  #flush(before = Infinity) {
    if (!this.#inbox.length) return;
    const ready = this.#inbox.filter((x) => x.e.seq < before).sort((a, b) => a.e.seq - b.e.seq);
    this.#inbox = this.#inbox.filter((x) => x.e.seq >= before);
    for (const x of ready) {
      if (x.e.seq <= this.#seen) continue;
      this.#seen = x.e.seq;
      this.transcript.apply(x.e, x.r);
    }
  }

  /**
   * The page is being left (pagehide): a request cut off now (WebKit cancels it while the page can
   * still write) is not a failed turn, so nothing is logged and the next start answers (spec §6.7).
   * @param {boolean} [yes] false when the page comes back from the back-forward cache
   */
  leaving(yes = true) {
    this.#leaving = yes;
  }

  /** Tapping Shiori while she works: stops the stream, the running tool, and the turn (spec §6.7), and her voice if it is this half's. */
  interrupt() {
    this.#userStop = true;
    if (this.#gathering) this.#stopGathered();
    this.#halt();
  }

  /**
   * The user stopped a turn still gathering their messages (review a3): it never starts; what they sent is written into the
   * conversation all the same, with a quiet "stopped", so nothing is lost and opening it again takes nothing up.
   */
  #stopGathered() {
    const wakes = this.#queue.filter((w) => w.scope === this.scope);
    this.#queue = this.#queue.filter((w) => w.scope !== this.scope);
    this.poke();
    if (!wakes.length) return;
    const wakeId = newId('w');
    this.#checking++;
    this.#logWakes(wakes, wakeId, false)
      .then(() => this.#log({ type: 'error', actor: 'system', data: { kind: 'stopped', wake: wakeId, message: STOPPED, quiet: true } }))
      .catch((e) => console.warn('a stopped message was not written', e))
      .finally(() => {
        this.#checking--;
        this.#settle();
      });
  }

  /** Stops the turn: the user's stop, or another conversation opening. */
  #halt() {
    this.#abort?.abort();
    if (this.#half.voice()) this.voice?.speaker.stop();
    const p = this.#pending;
    this.#pending = null;
    p?.resolve({ stopped: true });
  }

  /** Settles when no turn is running, nothing is queued, and what was heard has been handled. */
  async idle() {
    await this.#hearing;
    if (!this.#busy && !this.#queue.length && !this.#checking) return;
    await new Promise((resolve) => { this.#idle.push(() => resolve(undefined)); });
  }

  /** Whether she is busy: a turn or housekeeping runs, wakes wait, or a wake's budgets are being checked. */
  get busy() {
    return this.#busy || this.#queue.length > 0 || this.#checking > 0;
  }

  /**
   * A simulation's clock, zone and connection in place of the device's (spec §13, choice 11), until the
   * returned function puts them back: its own conversation (scope) is stamped in its time, so a replay
   * lines up; any other conversation's entries, and the budgets, keep the real world's (review 2).
   * @param {{ now: () => number, online: () => boolean, timeZone: () => string, scope?: string }} c @returns {() => void}
   */
  useClock({ now, online, timeZone, scope }) {
    const was = { now: this.now, online: this.online, timeZone: this.timeZone };
    this.now = now;
    this.online = online;
    this.timeZone = timeZone;
    this.#simScope = scope ?? null;
    return () => {
      this.now = was.now;
      this.online = was.online;
      this.timeZone = was.timeZone;
      this.#simScope = null;
    };
  }

  /** When an entry in scope happened: a simulation's time in its own conversation, the real time anywhere else. @param {string} scope */
  #stamp(scope) {
    return this.#simScope !== null && scope !== this.#simScope ? this.#real.now() : this.now();
  }

  /** The queued wakes for the open conversation, the user's first. */
  #take() {
    const all = this.#queue.filter((w) => w.scope === this.scope);
    this.#queue = this.#queue.filter((w) => w.scope !== this.scope);
    const theirs = (/** @type {Wake} */ w) => w.kind === 'user' || w.kind === 'choice' || w.kind === 'heard';
    return [...all.filter(theirs), ...all.filter((w) => !theirs(w))];
  }

  async #drain() {
    if (this.#busy || this.#opens) return;
    this.#busy = true;
    this.#clearTimer();
    try {
      while (!this.#opens && this.#queue.some((w) => w.scope === this.scope)) {
        await this.#gather();
        if (this.#opens) break;
        const wakes = this.#take();
        if (wakes.length) await this.#turn(wakes);
      }
    } catch (e) {
      await this.#notice({ tone: 'warn', title: 'Shiori stopped', body: `Something went wrong: ${String(/** @type {any} */ (e)?.message ?? e)}` });
    } finally {
      this.#busy = false;
      this.#abort = null;
      // A tap's listening window outlives the turn until something is said, or a silence (spec §10.4).
      const tapped = this.#ear?.owner === 'tap';
      this.#setState(tapped ? 'listening' : this.online() ? 'sleeping' : 'offline');
      if (tapped) this.#armQuiet();
      this.#settle();
      this.#schedule();
    }
  }

  /** A due housekeeping waits for this pause, then runs warm shortly before the cache expires, or cold now (spec §6.5). */
  #schedule() {
    this.#clearTimer();
    if (!this.#due || this.#opens) return;
    const last = this.#warmth.last;
    const wait = last ? last.at + last.ttlMs - WARM_LEAD_MS - this.now() : 0;
    if (wait <= 0) this.#housekeep('cold');
    else this.#timer = this.timers.set(() => { this.#timer = null; this.#housekeep('warm'); }, wait);
  }

  /** @param {'warm' | 'cold'} mode */
  async #housekeep(mode) {
    if (this.#busy || this.#opens) return;
    this.#busy = true;
    try {
      await this.compact(mode);
    } catch (e) {
      await this.#notice({ tone: 'info', title: "Shiori couldn't tidy up the conversation", body: `${this.#explain(e, mode === 'cold' ? 'utility' : 'main')} She will try again later.` });
    } finally {
      this.#busy = false;
      this.#setState(this.online() ? 'sleeping' : 'offline');
      this.#settle();
      if (this.#queue.length) this.#drain();
    }
  }

  /**
   * The tools Shiori has now, and the provider's own tools a request turns on: annai's and the
   * provider's never compete (spec §9.5). Turns and warm housekeeping use the same list, so the
   * cached prefix matches.
   */
  async #toolsNow() {
    const switches = await toolSwitches(this.ws);
    const web = (await readAppSettings(this.ws)).web ?? {};
    const model = this.#half.registryTools ? await this.#mainModel() : null;
    const via = this.#half.registryTools ? webVia({ web, model, switches }) : { hide: [], kinds: [], off: [] };
    const hidden = [...via.hide, ...((await this.#half.hidden?.()) ?? [])];
    const tools = toolList({ registry: this.#half.registryTools ? this.registry : NO_TOOLS, switches, loop: this.#loopTools }).filter((t) => !hidden.includes(t.name));
    const providerTools = via.kinds.length ? { providerTools: { kinds: via.kinds, off: via.off } } : {};
    // A search whose replies are shown as written (Google Search, G4): one Shiori writes them for the user, while it is on.
    const t = this.#rules() === 'one' ? model?.providerTools.find((x) => x.shows && via.kinds.includes(x.kind) && !via.off.includes(x.id)) : undefined;
    const shows = t ? `\n\n# ${t.name}\nA reply in which you search with ${t.name} is shown to the user as you write it, under "${t.shows}", with its sources. Write that reply for the user, with no private notes in it. You may still speak or show a shorter version of it, as usual.` : '';
    return { tools, via, providerTools, shows };
  }

  /**
   * The conversation as it is sent: no photo whose bytes are gone, and the oldest photos over the
   * main models' count as stubs (spec §4.8).
   */
  async #sendable() {
    const messages = this.transcript.messages.map((m) => ({ role: m.role, parts: m.parts.filter((p) => !/** @type {any} */ (p).missing) }));
    const out = limitImages(messages, (await this.#mainImages()).maxCount);
    return this.#half.sendable ? this.#half.sendable(out) : out;
  }

  /** Whether the main role's first model gets photos by upload, so they count as their id (spec §6.5). */
  async #uploading() {
    const id = chatCandidates(await this.llm.config(), this.#half.role)[0];
    return Boolean(id && this.llm.uploading && (await this.llm.uploading(id)));
  }

  /** The first model of this half's role. */
  async #mainModel() {
    return this.#roleModel(this.#half.role);
  }

  /** A role's first chat model, by its fallback (spec §9.6). @param {string} role */
  async #roleModel(role) {
    const cfg = await this.llm.config();
    const id = chatCandidates(cfg, role)[0];
    const m = id && cfg.models[id] ? modelOf(cfg.models[id]) : null;
    // A key on the free tier has no paid-only provider tools (G4): there, annai's own search stays.
    const p = m && cfg.providers[m.provider];
    return m && p && providerOf(p).free ? { ...m, providerTools: m.providerTools.filter((t) => !t.paidOnly) } : m;
  }

  /**
   * Housekeeping (spec §6.5): the older part of the conversation becomes a compaction event; the
   * most recent part stays word for word. Returns whether anything was compacted.
   * @param {'warm' | 'cold'} mode @param {{ forced?: boolean }} [o]
   */
  async compact(mode, o = {}) {
    const settings = await this.settings();
    const window = (await this.#mainModel())?.contextWindow ?? null;
    const keepTokens = window
      ? (settings.compaction.threshold * window) / 3
      : (settings.compaction.threshold * settings.compaction.maxRequestMiB * 2 ** 20) / 3.5 / 3;
    const [latest] = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.scope, { types: ['compaction'], reverse: true, limit: 1 }));
    // The conversation only, by type (A6): what the summary is made of, and what the cut is measured on (not Koe's).
    const split = this.#rules() === 'kokoro';
    const events = (await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.scope, { types: [...SAID], ...(latest ? { after: latest.data.to } : {}) })))
      .filter((e) => !NOT_SAID.has(e.type) && (e.data?.half !== 'koe' || e.type === 'heard') && e.data?.tag !== 'koe' && (split || !['note', 'halves'].includes(e.type)) && !e.type.startsWith('out.'));
    const items = [];
    /** What the user wrote last, their last few messages, for the summary's language. @type {string[]} */
    const said = [];
    for (const e of events) {
      const texts = await storedTexts(this.store, e);
      const text = texts.text ?? e.data?.text; // a short text is kept in data
      if (e.type === 'msg.user' && typeof text === 'string' && text !== '(a photo)' && said.push(text) > 3) said.shift();
      const size = JSON.stringify(e.data ?? {}).length + Object.values(texts).reduce((n, s) => n + s.length, 0);
      items.push({ seq: e.seq, tokens: Math.ceil(size / 3.5) + (e.data?.images?.length ?? 0) * 1600, exchange: e.type === 'wake' && !e.data?.meanwhile });
    }
    const cut = cutAt(items, { keepTokens, minExchanges: o.forced ? 1 : KEEP_EXCHANGES });
    if (cut === null) return false;
    // What was heard in the part summarized is written down first, the last time its sound is at hand (spec §10.3): the
    // summary and the log both have the words. While it can't be, housekeeping waits, unless the next request would overflow.
    const unwritten = (await this.#load(this.scope, { before: cut })).unwritten();
    if (unwritten.length && (await this.#writeDown('housekeeping', unwritten, { final: Boolean(o.forced) })).length) return false;
    const after = events.filter((e) => e.seq >= cut);
    const first = after.find((e) => e.type === 'msg.user')?.data?.text ?? after.find((e) => e.type === 'wake')?.data?.reasons?.[0]?.text ?? '';
    const marker = first ? `the exchange that begins "${first.slice(0, 80)}"` : `event ${cut}`;
    this.#setState('away', 'tidying up the conversation');
    const language = summaryLanguage(said);
    const summary = mode === 'warm' ? await this.#warmSummary(marker, settings, language) : await this.#coldSummary(cut, language);
    if (!summary) return false;
    const done = await record(this.store, this.scope, { now: this.#stamp(this.scope), type: 'compaction', actor: 'system', data: { from: this.transcript.from || 1, to: cut - 1, mode }, texts: [['summary', summary]] });
    await this.#serially(async () => {
      await this.reread();
      await this.#half.logged?.(done, { texts: {}, images: [] }); // Koe reads its window again from here
    });
    this.#snapshot = null;
    this.#due = false;
    return true;
  }

  /** Warm: the cached conversation, the housekeeping instruction as the tail; memory moves only. @param {string} marker @param {AgentSettings} settings @param {string} language */
  async #warmSummary(marker, settings, language) {
    const { tools, providerTools, shows } = await this.#toolsNow();
    if (!this.#snapshot) this.#snapshot = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
    /** @type {import('../llm/contract.js').Message[]} */
    let messages = await this.#sendable();
    for (let step = 0; step < 4; step++) {
      const request = { ...buildRequest({ snapshot: this.#snapshot, ...(shows ? { system: systemText(this.#snapshot) + shows } : {}), tools: definitions(tools), transcript: { messages }, tail: instruction(marker, language), cacheTtl: settings.cacheTtl }), ...providerTools };
      const r = await this.llm.call({ role: 'main', request, scope: this.scope, prefer: this.#warmth.last?.modelId, record: { tag: 'compaction' }, ...(this.voice ? { speech: this.voice.resolver(this.scope) } : {}) });
      const calls = r.reply.parts.filter((/** @type {any} */ p) => p.type === 'tool_call');
      if (!calls.length) return r.reply.text.trim() || null;
      /** @type {import('../llm/contract.js').Part[]} */
      const results = [];
      for (const c of calls) {
        const memory = ['write', 'edit', 'patch'].includes(c.name) && /^\/(me|trip)\/memory\.md$/.test(String(c.input?.path ?? ''));
        const tool = tools.find((t) => t.name === c.name);
        const out = memory && tool
          ? (await runTool(tool, c.input, { id: c.id, scope: this.scope, trip: this.trip, signal: new AbortController().signal, model: null, wake: 'housekeeping', llm: this.llm, author: 'shiori', fetch: this.get })).output
          : { content: 'Not during housekeeping: only memory moves work now.', isError: true };
        await record(this.store, this.scope, { now: this.#stamp(this.scope), type: 'tool.result', actor: 'system', data: { id: c.id, name: c.name, ok: !out.isError, ms: 0, wake: 'housekeeping' }, texts: [['content', out.content]] });
        results.push({ type: 'tool_result', id: c.id, content: out.content, ...(out.isError ? { isError: true } : {}) });
      }
      messages = [...messages, { role: 'assistant', parts: r.reply.parts }, { role: 'user', parts: results }];
    }
    return null;
  }

  /** Cold: the utility model, from the older part as text. @param {number} cut @param {string} language */
  async #coldSummary(cut, language) {
    const old = await this.#load(this.scope, { before: cut });
    // Words written down since (by housekeeping, just now) count for the part summarized.
    for (const e of await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.scope, { types: ['heard.text'], after: cut - 1 }))) old.apply(e, { texts: {}, images: [] });
    // Half the utility model's window, in characters, leaves room for the instructions and the summary.
    const window = (await this.#roleModel('utility'))?.contextWindow;
    const text = renderForSummary(old.messages, window ? Math.floor(window * 3.5 * 0.5) : SUMMARY_MAX_CHARS);
    const r = await this.llm.call({ role: 'utility', request: { system: coldSystem(language), messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, scope: this.scope, record: { tag: 'compaction' } });
    return r.reply.text.trim() || null;
  }

  /** Writes a conversation event in the open conversation (for Self tools). @param {Parameters<typeof record>[2]} ev */
  log(ev) {
    return this.#log(ev);
  }

  /** Shiori steps out of her seat to work on something, or comes back (spec §16.3). @param {string | null} detail */
  working(detail) {
    this.#setState(detail ? 'away' : 'thinking', detail ?? undefined);
  }

  /** The prefix cache of the model she used last (spec §6.4: plugins can read TTL and warmth). */
  cacheState() {
    const l = this.#warmth.last;
    if (!l) return null;
    const expiresAt = l.at + l.ttlMs;
    return { modelId: l.modelId, ttlMs: l.ttlMs, expiresAt, warm: this.now() < expiresAt };
  }

  /** The loop's own tools: talk, then Self (for Settings → Tools). */
  loopTools() {
    return this.#loopTools;
  }

  /** A system card (spec §16.1). @param {Notice} n */
  notify(n) {
    return this.#notice(n);
  }

  /**
   * Reminders annai says or shows by itself (spec §11.3: when a watch fires and the model can't be
   * reached, "the fallback is shown or spoken directly"; §17: with no connection, and no model): a
   * card, the words aloud with voice on, and an entry in the conversation they belong to. They are
   * never in Shiori's voice (§16.1).
   * @param {Reminder[]} list @param {string} [scope] their conversation; the open one if not given
   * @param {{ unsaid?: boolean }} [o] unsaid: she answered, but her turn ended without telling the user
   */
  async remind(list, scope = this.#target ?? ME, o = {}) {
    const open = scope === (this.#target ?? ME);
    for (const r of list) {
      const text = String(r?.text ?? '').trim();
      if (!text) continue;
      // Said with voice on, whichever conversation it is for (choice 3), after whatever is being said (the speaker queues), never over a live session.
      const aloud = Boolean(this.voice?.on) && !this.#half.hushed?.();
      const ev = { type: 'reminder', actor: 'system', data: { watch: String(r.watch ?? ''), text, ...(r.title ? { title: r.title } : {}), ...(aloud ? { aloud: true } : {}), ...(o.unsaid ? { unsaid: true } : {}) } };
      if (open && scope === this.scope) await this.#log(ev);
      else {
        const e = await record(this.store, scope, { now: this.#stamp(scope), ...ev });
        // The conversation being opened (as annai starts) may have read its log already: its
        // transcript takes the reminder once open, so Shiori knows and doesn't say it again.
        if (open) {
          if (scope === this.scope) this.#joinLate(e);
          else this.#late.push({ scope, e });
        }
      }
      await this.#notice({ tone: 'info', title: r.title || 'Reminder', body: text });
      if (aloud) this.voice?.say(text).catch(() => {});
    }
  }

  /** An entry written while the open conversation was being read: added unless the reading had it. @param {any} e @param {Resolved} [r] the other half's */
  #joinLate(e, r) {
    if (e.seq <= this.transcript.through) return;
    if (r) {
      this.#apply(e, r);
      return;
    }
    this.transcript.apply(e, { texts: {}, images: [] });
    this.#emit('event', e);
  }

  /** Writes a conversation event, adds it to the transcript, and tells the screen and the other half. @param {Parameters<typeof record>[2]} ev */
  #log(ev) {
    const write = async () => {
      const mark = this.#mark(ev.type);
      const stored = await record(this.store, this.scope, { now: this.#stamp(this.scope), ...ev, data: { ...ev.data, ...mark } });
      const r = await resolveEvent(this.store, stored);
      this.#apply(stored, r);
      if (ev.type.startsWith('out.')) this.#facts.spoke = true;
      if (ev.type.startsWith('out.') || ev.type === 'grounded') this.#reached++;
      this.#emit('event', stored);
      await this.#half.logged?.(stored, r);
      return stored;
    };
    return this.#serially(write);
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #serially(fn) {
    return this.#half.serial ? this.#half.serial(fn) : fn();
  }

  /** @param {Wake} w */
  #reason(w) {
    if (w.kind === 'user') return 'the user wrote';
    if (w.kind === 'choice') return 'the user tapped a choice';
    if (w.kind === 'heard') return 'the user spoke';
    if (w.kind === 'plugin') return `the plugin ${w.plugin ?? ''}: ${w.text}`;
    return w.text;
  }

  /**
   * Logs wakes: a user's text as msg.user, anything else as a wake reason. Into the open conversation,
   * or with log, into another one. @param {Wake[]} wakes @param {string} wakeId @param {boolean} meanwhile
   * @param {(ev: Parameters<typeof record>[2]) => Promise<unknown>} [log] @param {string | null} [trip] the trip paths in photos refer to
   */
  async #logWakes(wakes, wakeId, meanwhile, log = (ev) => this.#log(ev), trip = this.trip) {
    if (!meanwhile) await log({ type: 'wake', actor: 'system', data: { id: wakeId, reasons: wakes.map((w) => ({ kind: w.kind, text: w.text, ...(w.plugin ? { plugin: w.plugin } : {}) })) } });
    else {
      const others = wakes.filter((w) => w.kind !== 'user' && w.kind !== 'choice' && w.kind !== 'heard' && !w.logged);
      if (others.length) await log({ type: 'wake', actor: 'system', data: { id: wakeId, meanwhile: true, reasons: others.map((w) => ({ kind: w.kind, text: w.text })) } });
    }
    for (const w of wakes) {
      if (w.logged) continue;
      if (w.kind === 'heard' && w.heard) {
        await this.#logHeard(w.heard, { wake: wakeId, meanwhile, gate: w.gate }, log);
        continue;
      }
      if (w.kind !== 'user' && w.kind !== 'choice') continue;
      const { images, blobs } = w.photos?.length ? await this.#userPhotos(w.photos, trip) : { images: [], blobs: [] };
      await log({ type: 'msg.user', actor: 'user', data: { wake: wakeId, ...(meanwhile ? { meanwhile: true } : {}), ...(images.length ? { images } : {}) }, texts: [['text', w.text]], blobs });
    }
  }

  /**
   * The request copies of the photos a user sent (a crop when they chose a part), and the bytes to
   * keep with their message (spec §4.8, §4.9). A path that isn't a stored photo is left out.
   * @param {SentPhoto[]} photos @param {string | null} trip
   */
  async #userPhotos(photos, trip) {
    /** @type {{ hash: string, mediaType: string, path: string, region?: number[] }[]} */
    const images = [];
    /** @type {{ hash?: string, bytes?: Uint8Array, type: string }[]} */
    const blobs = [];
    for (const p of photos) {
      try {
        const { scope, path } = resolvePath(p.path, trip);
        const got = await this.ws.read(scope, path);
        if (!got || !got.entry.type.startsWith('image/')) continue;
        const m = got.entry.meta ?? {};
        const source = { hash: got.entry.hash, type: got.entry.type, width: m.width ?? null, height: m.height ?? null, size: got.entry.size };
        const healed = p.region && m.width && m.height ? healRegion(p.region, m.width, m.height) : null;
        const sent = await this.#copy(source, healed?.crop);
        images.push({ hash: sent.hash, mediaType: sent.mediaType, path: p.path, ...(healed ? { region: healed.used } : {}) });
        blobs.push(sent.data ? { bytes: fromBase64(sent.data), type: sent.mediaType } : { hash: sent.hash, type: sent.mediaType });
      } catch (e) {
        // Not dropped quietly: the user hears which photo didn't go, and why (spec §17).
        await this.#notice({ tone: 'warn', title: "A photo wasn't sent to Shiori", body: `${p.path}: ${String(/** @type {any} */ (e)?.message ?? e)} The message went without it.` });
      }
    }
    return { images, blobs };
  }

  /** @param {Wake[]} wakes */
  async #turn(wakes) {
    await this.#half.ready?.(); // the half's rules are known (Halves reads the settings as annai starts)
    const wakeId = newId('w');
    const abort = new AbortController();
    this.#abort = abort;
    await this.#workOutVoice(wakes);
    this.#heardBy = null;
    this.#facts = { finalText: '', told: false, slept: false, spoke: false, wrote: false, kinds: wakes.map((w) => w.kind) };
    this.#userStop = false;
    // Shiori became two halves, or one again.
    if (this.transcript.half !== this.#rules()) await this.#serially(() => this.reread());
    let ok = false;
    this.#turning = true;
    try {
      ok = await this.#steps(wakes, wakeId, abort);
    } finally {
      await this.#afterTurn(ok, wakeId).catch((e) => console.warn('the end of a turn failed', e));
      // A turn that worked takes down the cards about a model failing; one that then spoke, the card about her saying nothing.
      if (ok) {
        this.#emit('clear', 'model');
        if (this.#facts.spoke) this.#emit('clear', 'silent');
      }
      this.#turning = false;
      try {
        this.#half.ended?.({ wakeId, ok, ...this.#facts });
      } catch (e) {
        console.warn('the end of a turn failed', e);
      }
    }
  }

  /**
   * A turn's steps (spec §6.2). @param {Wake[]} wakes @param {string} wakeId @param {AbortController} abort
   * @returns {Promise<boolean>} whether it worked: a model answered, and none failed
   */
  async #steps(wakes, wakeId, abort) {
    await this.#logWakes(wakes, wakeId, false);
    const settings = await this.settings();
    const last = this.#warmth.last;
    const cold = !last || this.now() >= last.at + last.ttlMs - SOON_MS;
    const fresh = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
    this.#snapshot = nextSnapshot(this.#snapshot, fresh, { cold });
    // Housekeeping that came due waits for a pause; by now the cache is cold, so the utility model does it (spec §6.5).
    if (cold && this.#due && (await this.#tidyUp('cold', {}, wakeId))) this.#snapshot = nextSnapshot(null, await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality }), { cold: true });
    /** What woke her, then what joins her turn, until a request of hers has said it (the now block says each once). */
    const reasons = wakes.map((w) => this.#reason(w));
    // The user reordered the list (or changed it) since: their order applies from this turn, warm cache or not (emulator pass).
    const order = chatCandidates(await this.llm.config(), this.#half.role).join('\n');
    const reordered = this.#order !== null && order !== this.#order;
    this.#order = order;
    /**
     * The fallbacks of this turn's wakes that annai shows itself if no model answers (spec §11.3); a reminder's stays owed until
     * she reaches the user after it came, with speak, show or ask (emulator pass: a turn that only slept dropped them).
     */
    let owed = wakes.flatMap((w) => w.fallbacks ?? []);
    /** The user's own message (or tap) is in this turn, and nothing has reached them since. */
    let theirs = wakes.some(isTheirs);
    let reached = this.#reached;
    /** What had reached the user when the turn began: a tool call is asked for only until something more has (review A4). */
    const begun = this.#reached;
    /** She reached the user: what was owed before is settled. Checked before more wakes join, and at the end. */
    const settle = () => {
      if (this.#reached !== reached) {
        owed = [];
        theirs = false;
        notes = [];
        wrote = false;
      }
      reached = this.#reached;
    };
    /**
     * What Koe owes the user, told or not (spec §6.8), which only reaching them settles: Kokoro's notes meant for them, and a
     * message of theirs that reached it inside its wait. @type {Wake[]}
     */
    let notes = [];
    let wrote = false;
    const owes = () => notes.length > 0 || wrote;
    /** The user's own words wait for an answer: their message (unless the turn told the other half), or what they wrote in Koe's wait. */
    const unanswered = () => wrote || (theirs && !this.#facts.told);
    /** Wakes joining the turn: what they owe; not a note a reply that reached the user had read already (a wake can trail its note). @param {Wake[]} more */
    const join = (more) => {
      theirs ||= more.some(isTheirs);
      const read = this.#reachedTo.scope === this.scope ? this.#reachedTo.to : 0;
      notes.push(...more.filter((w) => isForUser(w) && !((w.seq ?? Infinity) <= read)));
    };
    join(wakes);
    let nudged = false;
    let silent = false;
    /** Steps since the cue that still owed the user (Koe's). */
    let after = 0;
    /** She is asked once more, in the same turn: what is owed, in words. */
    const cue = async () => {
      nudged = true;
      this.#facts.finalText = '';
      const cues = [...(notes.length ? [NOTE_UNSAID] : []), ...(unanswered() ? [UNANSWERED] : [])];
      await this.#logWakes(cues.map((text) => ({ kind: /** @type {const} */ ('cue'), text })), wakeId, true);
      reasons.push(...cues);
    };
    /**
     * A turn that ends owing the user (spec §7.1): she is asked once more; true when she is. A second silent end is a card for
     * their own words, and annai's backstop for Kokoro's notes. Not for the half behind Koe.
     */
    const nudge = async () => {
      settle();
      if (abort.signal.aborted || !this.#half.voice() || !(owes() || unanswered())) return false;
      if (nudged) {
        silent = true;
        return false;
      }
      await cue();
      return true;
    };
    const stuck = new Stuck();
    let steps = 0;
    let triedCompacting = false;
    // Today's spend is the real day's: model calls are traced in real time (review 2b).
    let spent = await spentToday(this.store, this.#real.now(), this.#real.timeZone());
    let answered = false;
    let failed = false;
    for (;;) {
      if (abort.signal.aborted) break;
      const over = budgetStop({ budgets: settings.budgets, steps, spent });
      if (over) {
        await this.#notice({ tone: 'warn', title: over.title, body: over.body });
        await this.#log({ type: 'error', actor: 'system', data: { kind: 'budget', which: over.which, wake: wakeId, message: over.body } });
        break;
      }
      // The voice changed hands mid-turn (Koe down, or back): this step follows it.
      if (this.#half.voice() !== this.#mayVoice) await this.#workOutVoice(wakes);
      // After housekeeping the prefix starts over, with a fresh snapshot (spec §6.5).
      if (!this.#snapshot) this.#snapshot = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
      settle();
      const owing = owes();
      const { tools, via, providerTools, shows } = await this.#toolsNow();
      const { role } = this.#half;
      const voiceWhy = this.voice?.mode.setting === 'auto' ? `auto: ${this.voice.mode.why}` : '';
      const here = this.sense?.() ?? {};
      const now = { now: this.now(), timeZone: this.timeZone(), voice: this.#voiceNow ? 'on' : 'off', voiceWhy, online: this.online(), reasons, place: here.place, activity: here.activity };
      const koe = this.#half.koe?.() ?? null;
      const tail = this.#half.tail ? await this.#half.tail(now) : nowBlock({ ...now, plan: await nextPlanItems(this.ws, this.trip, this.now()), ...(koe ? { koe } : {}) });
      const snapshot = /** @type {import('./context.js').Snapshot} */ (this.#snapshot);
      // What the request holds: the other half's later lines follow this reply.
      const context = { from: this.transcript.from, to: this.transcript.to };
      const request = {
        ...buildRequest({ snapshot, ...(this.#half.system || shows ? { system: (this.#half.system?.(snapshot) ?? systemText(snapshot)) + shows } : {}), tools: definitions(tools), transcript: { messages: await this.#sendable() }, tail, cacheTtl: settings.cacheTtl }),
        ...providerTools, newestPhoto: this.transcript.newestPhoto, // a model that takes no photos gets older ones as words
        // She reaches the user only through tools: the model must call one, where its endpoint can say so (item 15; the nudge stays
        // the backstop). Not with the model's own search on: it answers in words, shown as written (G4).
        // Only until she has reached the user (or told the other half): after that, she may end in words.
        // Koe owing the user (Kokoro's note, their message in its wait) is forced until it reaches them, told or not.
        ...(providerTools.providerTools || (!(owes() && this.#half.voice()) && (this.#reached !== begun || this.#facts.told)) ? {} : { toolRequired: true }),
      };
      const fingerprint = await prefixFingerprint(request, this.transcript.compaction);
      const window = (await this.#mainModel())?.contextWindow ?? null;
      const maxBytes = settings.compaction.maxRequestMiB * 2 ** 20;
      const uploaded = await this.#uploading();
      const need = this.#half.housekeeping ? compactionNeed({ tokens: Math.max(estimateTokens(request, (await this.#mainModel())?.providerId), this.#lastPrompt), window, bytes: requestBytes(request, { uploaded }), maxBytes, threshold: settings.compaction.threshold }) : null;
      if (need === 'forced') {
        // The next request would overflow: housekeeping first, warm if the cache still is (spec §6.4, §6.5).
        const warm = this.#warmth.last ? this.#warmth.state(this.#warmth.last.modelId, fingerprint, this.now()).warm : false;
        const done = await this.#tidyUp(warm ? 'warm' : 'cold', { forced: true }, wakeId);
        if (done === null) {
          failed = true;
          break;
        }
        if (done) {
          this.#lastPrompt = 0;
          this.#snapshot = nextSnapshot(null, await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality }), { cold: true });
          continue;
        }
      }
      const prefer = !reordered && this.#warmth.last && this.#warmth.state(this.#warmth.last.modelId, fingerprint, this.now()).warm ? this.#warmth.last.modelId : undefined;
      this.#cut = false;
      this.#noteCut = false;
      this.#wentToSleep = false;
      this.#streaming = '';
      this.#setState('thinking');
      /** @type {any} */
      let result;
      const cut = new AbortController();
      const before = this.#reached;
      try {
        this.#half.calling?.(context);
        this.#calling = true;
        this.#callCut = cut;
        result = await this.llm.call({
          role, request, signal: anySignal([abort.signal, cut.signal]), scope: this.scope, prefer,
          record: { tag: this.#half.tag, ...this.#mark('model.turn'), wake: wakeId, prefix: fingerprint.slice(0, 16), context, keepParts: true },
          repairImages: (/** @type {ProviderError} */ err, /** @type {string} */ modelId, /** @type {any} */ req) => this.#repair(err, modelId, req, wakeId),
          onEvent: (/** @type {any} */ ev) => this.#streamed(ev, wakeId),
          ...(this.voice ? { speech: this.voice.resolver(this.scope, wakeId) } : {}),
          ...(this.#voiceNow ? { firstOutputMs: await this.#firstWordsMs(role) } : {}),
        });
      } catch (e) {
        this.#callCut = null;
        this.#calling = false;
        this.#flush();
        if (this.#rereadDue) {
          this.#rereadDue = false;
          await this.#serially(() => this.reread());
        }
        // Cut in by an immediate note: the turn goes on with what is queued, and knows what it had said.
        if (cut.signal.aborted && !abort.signal.aborted) {
          const said = await this.#cutSpeech(wakeId);
          if (said && this.#noteCut) this.#push({ kind: 'cue', text: `a note stopped you after: ${said}` });
          this.#noteCut = false;
          const more = this.#take();
          settle();
          if (more.length) {
            await this.#logWakes(more, wakeId, true);
            reasons.push(...more.map((w) => this.#reason(w)));
            owed.push(...more.flatMap((w) => w.fallbacks ?? []));
            join(more);
          }
          continue;
        }
        // "Request too long" from every model: compact first, then try once more (spec §9.6).
        const tooLong = this.#half.housekeeping && e instanceof AllFailedError && e.attempts.some((a) => a.outcome === 'context' || a.outcome === 'too-long');
        if (tooLong && !triedCompacting) {
          triedCompacting = true;
          const done = await this.#tidyUp('cold', { forced: true }, wakeId);
          if (done === null) {
            failed = true;
            break;
          }
          if (done) {
            this.#lastPrompt = 0;
            continue;
          }
        }
        await this.#failed(e, wakeId);
        failed = true;
        break;
      }
      this.#callCut = null;
      reasons.length = 0; // the model has read them
      steps++;
      this.#heardBy = result.modelId;
      answered = true;
      owed = owed.filter((r) => !r.cue);
      this.#lastPrompt = promptTokens(result.usage);
      spent += result.cost ?? 0;
      const model = await this.#model(result.modelId);
      if (model) this.#warmth.note(result.modelId, fingerprint, TTL_MS[ttlFor(model, settings.cacheTtl)], this.now());
      if (this.#half.housekeeping && compactionNeed({ tokens: this.#lastPrompt, window: model?.contextWindow ?? null, bytes: requestBytes(request, { uploaded }), maxBytes, threshold: settings.compaction.threshold })) this.#due = true;
      await this.#applyTurn(result.reply.parts, wakeId);
      await this.#grounded(result.reply.attribution, wakeId);
      const calls = result.reply.parts.filter((/** @type {any} */ p) => p.type === 'tool_call');
      this.#half.replied?.(calls.map((/** @type {any} */ c) => c.name));
      if (!calls.length) {
        if (result.reply.stop === 'pause') continue;
        this.#facts.finalText = String(result.reply.text ?? '').trim();
        if (await nudge()) continue;
        break;
      }
      const sleeping = calls.some((/** @type {any} */ c) => c.name === 'sleep');
      if (sleeping) this.#facts.slept = true;
      const ordered = [...calls.filter((/** @type {any} */ c) => c.name !== 'sleep'), ...calls.filter((/** @type {any} */ c) => c.name === 'sleep')];
      let stop = false;
      let endTurn = false;
      for (const [i, c] of ordered.entries()) {
        const more = Boolean(this.#half.listenLast) && ordered.slice(i + 1).some((/** @type {any} */ x) => x.name === 'tell_kokoro' || x.name === 'wait');
        const output = await this.#runCall(c, tools, { wakeId, signal: abort.signal, model, sleeping, providerOff: via.off, more });
        if (output.endTurn) endTurn = this.#wentToSleep = true;
        if (stuck.see(c.name, c.input, output.content)) stop = true;
      }
      if (this.#reached !== before) this.#reachedTo = { scope: this.scope, to: context.to };
      // Koe has told the user what Kokoro's notes say already: they are settled, and annai doesn't show them.
      if (ordered.some((/** @type {any} */ c) => c.name === 'already_told')) notes = [];
      // The user wrote inside Koe's wait: its answer is owed, whatever Koe asked of Kokoro meanwhile.
      if (this.#facts.wrote) {
        this.#facts.wrote = false;
        settle();
        wrote = true;
      }
      if (stop) {
        await this.#notice({ tone: 'warn', title: 'Shiori stopped repeating herself', body: 'She called the same tool three times with the same result, so this turn ended. Ask again in other words.' });
        await this.#log({ type: 'error', actor: 'system', data: { kind: 'stuck', wake: wakeId, message: 'Three identical tool calls in a row with identical results.' } });
        break;
      }
      // A step that began owing the user and went on without reaching them: the cue comes now, not only when Koe ends, and two
      // steps more at most follow it before annai's backstop (the fix pass: a Koe that kept asking Kokoro was forced 25 times).
      if (owing && !sleeping && !endTurn && !abort.signal.aborted && this.#half.voice()) {
        settle();
        if (owes() && !nudged) await cue();
        else if (owes() && ++after >= AFTER_CUE) {
          silent = true;
          break;
        }
      }
      if (abort.signal.aborted || ((sleeping || endTurn) && !(await nudge()))) break;
      await this.#writeChatter(wakeId);
      const more = this.#take();
      settle();
      if (more.length) {
        await this.#logWakes(more, wakeId, true);
        reasons.push(...more.map((w) => this.#reason(w)));
        owed.push(...more.flatMap((w) => w.fallbacks ?? []));
        this.#facts.kinds.push(...more.map((w) => w.kind));
        join(more);
      }
    }
    settle();
    // Kokoro's notes for the user, and Koe never passed them on: annai shows what it can of them itself (spec §6.8).
    if (notes.length && !abort.signal.aborted && !this.#leaving && !failed) await this.#half.unsaid?.(notes);
    if (silent && unanswered()) {
      // Asked once more, she still said nothing: the user isn't left waiting in silence.
      const body = 'Her model finished without saying anything to you.';
      const scope = this.scope;
      await this.#notice({ tone: 'warn', title: "Shiori didn't answer", body, key: 'silent', actions: [{ label: 'Try again', primary: true, run: () => { this.wake({ kind: 'cue', text: AGAIN, again: true, scope }); } }] });
      await this.#log({ type: 'error', actor: 'system', data: { kind: 'silent', wake: wakeId, message: body } });
    }
    settle();
    if (owed.length && !abort.signal.aborted && !this.#leaving) await this.remind(owed, this.scope, { unsaid: answered && !failed });
    // The user stopped her: the turn is over, and opening the conversation again doesn't take it up (spec §6.7). Nothing to show.
    if (abort.signal.aborted && this.#userStop) await this.#log({ type: 'error', actor: 'system', data: { kind: 'stopped', wake: wakeId, message: STOPPED, quiet: true } });
    return answered && !failed;
  }

  /**
   * Housekeeping within a turn. When it fails a card says why; when the turn can't go on without it
   * (the next request would overflow), an error event ends the turn.
   * @param {'warm' | 'cold'} mode @param {{ forced?: boolean }} o @param {string} wakeId
   * @returns {Promise<boolean | null>} whether anything was compacted; null: it failed and the turn ends
   */
  async #tidyUp(mode, o, wakeId) {
    try {
      return await this.compact(mode, o);
    } catch (e) {
      if (this.#leaving) return null;
      const why = await withoutSecrets(this.store, this.#explain(e, mode === 'cold' ? 'utility' : 'main'));
      if (!o.forced) {
        await this.#notice({ tone: 'info', title: "Shiori couldn't tidy up the conversation", body: `${why} She will try again later.` });
        return false;
      }
      const body = `${why} Until it is tidied up, the conversation is too long for her model. Check the models in Settings → Models, or try again later.`;
      await this.#notice({ tone: 'warn', title: "Shiori couldn't tidy up the conversation", body });
      await this.#log({ type: 'error', actor: 'system', data: { kind: 'compaction', wake: wakeId, message: body } });
      return null;
    }
  }

  /** What went wrong with a model call, in words for a card. @param {unknown} e @param {string} [role] */
  #explain(e, role = 'main') {
    return e instanceof AllFailedError
      ? (e.attempts.length ? failedText(e.attempts, { offline: !this.online() }) : `No model is set for the ${role} role. Add one in Settings → Models.`)
      : e instanceof ProviderError ? explain(e) : String(/** @type {any} */ (e)?.message ?? e);
  }

  /** @param {unknown} e @param {string} wakeId */
  async #failed(e, wakeId) {
    if (this.#leaving || (e instanceof ProviderError && e.kind === 'cancelled')) return;
    const body = await withoutSecrets(this.store, this.#explain(e));
    const last = e instanceof AllFailedError ? e.attempts.at(-1) : undefined;
    // The other half tells the user: no card.
    const said = this.#half.failed?.(body, e) ?? false;
    const quiet = said === true;
    const why = typeof said === 'string' ? said : body;
    if (quiet || this.#photoCard === wakeId) {
      // said elsewhere, or its card already says why
    } else if (last?.outcome === 'image') await this.#cantSend(refusedText(readRefusal(last.error ?? '')), wakeId); // repairs ran out
    else await this.#notice({ tone: 'warn', title: "Shiori can't reach her model", body: why, key: 'model' });
    await this.#log({ type: 'error', actor: 'system', data: { kind: 'model', wake: wakeId, message: why, ...(quiet ? { quiet: true } : {}) } });
  }

  /**
   * Fixes a refused photo (spec §4.8, §9.9): learns the limit, saves it on the model, makes new
   * copies of what no longer fits from the stored photos, and records the swap. Too many photos go
   * as stubs instead. Null when it can't: a card says why, in plain words.
   * @param {ProviderError} err @param {string} modelId @param {import('../llm/contract.js').Request} request @param {string} wakeId
   */
  async #repair(err, modelId, request, wakeId) {
    const cfg = await this.llm.config();
    const rec = cfg.models[modelId];
    if (!rec || !this.#photos || !this.codec) return this.#cantSend(refusedText(null), wakeId);
    const before = modelOf(rec).images ?? {};
    let learned = readRefusal(err.message) ?? (await this.#askLimits(err.message));
    // A refusal that states the size annai already keeps: the provider measures photos another way
    // (as encoded text, a third larger), so a quarter less, once.
    if (learned?.maxBytes && before.maxBytes && !tighter(before, learned)) {
      const less = Math.floor((learned.maxBytes * 3) / 4);
      if (less < before.maxBytes) learned = { ...learned, maxBytes: less };
    }
    if (!learned || !tighter(before, learned)) return this.#cantSend(refusedText(learned), wakeId);
    const images = stricter(before, learned);
    const canMake = this.codec.canMake?.bind(this.codec);
    if (images.formats?.length && canMake && !(await Promise.all(images.formats.map((x) => canMake(x)))).some(Boolean)) {
      const names = images.formats.map((x) => x.replace('image/', '').toUpperCase()).join(' or ');
      return this.#cantSend(`This model takes photos only as ${names}, which this browser can't make. A plugin that adds ${names} would fix it (Settings → Plugins).`, wakeId);
    }
    await saveModel(this.ws, { ...rec, user: { ...(rec.user ?? {}), images } });
    // Too many photos: the oldest go as stubs, and no photo is made again.
    if (learned.maxCount && !learned.maxBytes && !learned.maxEdge && !learned.formats?.length) {
      return { ...request, messages: limitImages(request.messages, images.maxCount) };
    }
    const limits = await this.#limits(); // now with what this model just taught
    /** @type {Map<string, import('../request-photos.js').Copy>} */
    const swaps = new Map();
    for (const p of request.messages.flatMap((m) => m.parts)) {
      if (p.type !== 'image' || !p.hash || swaps.has(p.hash)) continue;
      // Made again from the stored photo it came from, with its part (spec §4.8); else from what was sent.
      const from = (await this.#storedSource(p)) ?? { source: { hash: p.hash, type: p.mediaType, size: Math.floor((p.data.length * 3) / 4) }, crop: undefined };
      const copy = await this.#photos.copy(from.source, limits, from.crop);
      if (copy.hash !== p.hash) swaps.set(p.hash, copy);
    }
    if (!swaps.size) return this.#cantSend(refusedText(learned), wakeId);
    for (const [old, copy] of swaps) {
      await this.#log({ type: 'photo.replace', actor: 'system', data: { old, new: copy.hash, mediaType: copy.mediaType, wake: wakeId }, blobs: [copy.data ? { bytes: fromBase64(copy.data), type: copy.mediaType } : { hash: copy.hash, type: copy.mediaType }] });
      await this.store.tx(['files', 'events', 'blobs'], 'readwrite', async (t) => {
        // The refused copy goes, unless a file is that photo or another conversation sent it too (spec §4.9).
        if (!(await t.blobInUse(old, { exceptScope: this.scope }))) await t.deleteBlob(old);
      });
    }
    // A copy made before, or a stored photo sent as it is, has no data with it: its bytes come from storage.
    for (const [old, copy] of swaps) {
      if (copy.data) continue;
      const bytes = await blobBytes(this.store, copy.hash);
      if (bytes) swaps.set(old, { ...copy, data: toBase64(bytes) });
    }
    return { ...request, messages: limitImages(replaceImages(request.messages, swaps), images.maxCount) };
  }

  /** The stored photo an image part was made from, with its part, while it is still a file. @param {any} p */
  async #storedSource(p) {
    if (!p.path) return null;
    try {
      const { scope, path } = resolvePath(p.path, this.trip);
      const got = await this.ws.read(scope, path);
      if (!got || !got.entry.type.startsWith('image/')) return null;
      const m = got.entry.meta ?? {};
      const source = { hash: got.entry.hash, type: got.entry.type, width: m.width ?? null, height: m.height ?? null, size: got.entry.size };
      return { source, crop: p.region && m.width && m.height ? healRegion(p.region, m.width, m.height).crop : undefined };
    } catch {
      return null;
    }
  }

  /** A card for a photo that couldn't be sent; the turn's error then shows no second card. @param {string} why @param {string} wakeId */
  async #cantSend(why, wakeId) {
    this.#photoCard = wakeId;
    await this.#notice({ tone: 'warn', title: "Shiori couldn't send the photo", body: why });
    return null;
  }

  /**
   * The utility model reads a refusal annai has no rule for; no clear answer, no limits (fails
   * closed). It never sees a key annai keeps, even one the provider echoed (spec §9.9).
   * @param {string} said
   */
  async #askLimits(said) {
    const message = await withoutSecrets(this.store, said);
    const ask = (/** @type {boolean} */ forced) => this.llm.call({
      role: 'utility', level: 'off', scope: this.scope, record: { tag: 'refusal' },
      request: {
        system: 'A model refused a photo. Read its error message and give the limit it states, by calling limits. Call it with none: true if the message states no limit.',
        ...(forced ? { toolChoice: 'limits' } : {}), maxOutput: 200,
        tools: [{ name: 'limits', description: 'The limits the error states.', input: { type: 'object', properties: { maxBytes: { type: 'integer' }, maxEdge: { type: 'integer' }, maxCount: { type: 'integer' }, formats: { type: 'array', items: { type: 'string' } }, none: { type: 'boolean' } } } }],
        messages: [{ role: 'user', parts: [{ type: 'text', text: message }] }],
      },
    });
    try {
      /** @type {any} */
      let r;
      try {
        r = await ask(true);
      } catch {
        // A model that thinks refuses a forced tool (Opus and Sonnet 5.5): asked again, the tool offered but not forced.
        r = await ask(false);
      }
      const call = r.reply.parts.find((/** @type {any} */ p) => p.type === 'tool_call' && p.name === 'limits');
      if (!call || call.input?.none) return null;
      const { maxBytes, maxEdge, maxCount } = call.input ?? {};
      const formats = Array.isArray(call.input?.formats) ? call.input.formats.filter((/** @type {unknown} */ x) => typeof x === 'string' && x.startsWith('image/')) : undefined;
      // A limit no model sets is a misreading, kept for good if saved: no clear answer (fails closed).
      if ((maxEdge !== undefined && !(maxEdge >= 256)) || (maxBytes !== undefined && !(maxBytes >= 65_536)) || (maxCount !== undefined && !(maxCount >= 1))) return null;
      const out = Object.fromEntries(Object.entries({ maxBytes, maxEdge, maxCount, formats: formats?.length ? formats : undefined }).filter(([, v]) => v !== undefined));
      return Object.keys(out).length ? out : null;
    } catch {
      return null;
    }
  }

  /** @param {string} id */
  async #model(id) {
    const rec = (await this.llm.config()).models[id];
    return rec ? modelOf(rec) : null;
  }

  /**
   * Adds the reply from the model.turn the trace just wrote (this half's, by tag and wake), or from the
   * reply itself if that write failed; then the other half's events of the call. @param {any[]} parts @param {string} wakeId
   */
  async #applyTurn(parts, wakeId) {
    await this.#serially(async () => {
      const recent = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.scope, { types: ['model.turn'], reverse: true, limit: 8 }));
      const turn = recent.find((x) => x.data?.wake === wakeId && x.data?.tag === this.#half.tag && x.data?.stored?.includes('parts'));
      if (turn && turn.seq > this.#lastTurn) {
        // Taken once: a reading of the log since may have it.
        this.#lastTurn = turn.seq;
        if (turn.seq > this.#seen) this.#apply(turn, await resolveEvent(this.store, turn));
        this.#emit('event', turn);
      } else {
        // Only when its write failed: the stored turn found is an earlier step's.
        this.#flush();
        this.transcript.apply({ seq: this.transcript.to + 1, type: 'model.turn', data: { tag: this.#half.tag } }, { texts: { parts: JSON.stringify(parts) }, images: [] });
      }
      this.#calling = false;
      this.#flush();
      if (this.#rereadDue) {
        this.#rereadDue = false;
        await this.reread();
      }
    });
  }

  /**
   * A reply grounded in the provider's own search, for the conversation as it came (G4): Google's terms ask it shown to the
   * user who asked, with its suggestions, so it is, even while Koe talks; the suggestions are a blob the entry names. Only
   * web addresses go as its links. @param {import('../llm/call.js').Attribution | undefined} a @param {string} wakeId
   */
  async #grounded(a, wakeId) {
    if (!a) return;
    const links = (Array.isArray(a.links) ? a.links : []).filter((l) => /^https?:\/\//i.test(String(l?.url ?? ''))).map((l) => ({ url: String(l.url), ...(l.title ? { title: String(l.title) } : {}) }));
    await this.#log({ type: 'grounded', actor: 'shiori', data: { wake: wakeId, source: String(a.source ?? ''), links }, texts: [['text', String(a.text ?? '')], ['html', String(a.html ?? '')]] });
  }

  /**
   * Runs one tool call and records it: tool.call, then tool.result with any photo or document it
   * returned kept as blobs the event names (spec §4.9).
   * @param {any} c @param {LoopTool[]} tools @param {{ wakeId: string, signal: AbortSignal, model: any, sleeping: boolean, providerOff?: string[], more?: boolean, live?: boolean }} o
   */
  async #runCall(c, tools, o) {
    const input = typeof c.input === 'object' && c.input !== null ? c.input : {};
    const inputText = JSON.stringify(input);
    await this.#log({ type: 'tool.call', actor: 'shiori', data: { id: c.id, name: c.name, wake: o.wakeId, ...(inputText.length <= 2000 ? { input } : {}) }, texts: inputText.length > 2000 ? [['input', inputText]] : [] });
    const tool = tools.find((t) => t.name === c.name);
    /** @type {import('./tools.js').ToolOutput} */
    let output;
    let ms = 0;
    // Kokoro's output tools while Koe talks (plan decision 15).
    const gated = tool && !o.signal.aborted && this.#half.gate ? await this.#half.gate({ id: c.id, name: c.name, input, wake: o.wakeId }) : null;
    if (c.name === 'tell_koe' || c.name === 'tell_kokoro' || gated?.told) this.#facts.told = true;
    if (o.signal.aborted) output = { content: STOPPED, isError: true };
    else if (gated) output = { content: gated.content, ...(gated.isError ? { isError: true } : {}) };
    else if (!tool) output = { content: `Error: there is no tool called ${c.name}, or it is switched off.`, isError: true };
    else if (typeof c.input !== 'object' || c.input === null) output = { content: `Error: the input for ${c.name} wasn't valid JSON.`, isError: true };
    else {
      const call = {
        id: c.id, scope: this.scope, trip: this.trip, signal: o.signal, model: o.model, wake: o.wakeId, llm: this.llm, author: /** @type {const} */ ('shiori'),
        sleeping: o.sleeping, ...(o.more ? { more: true } : {}), ...(o.live ? { live: true } : {}), voice: this.#voiceNow, providerOff: o.providerOff ?? [], fetch: tracedFetch(this.store, this.scope, { tool: c.name, wake: o.wakeId }, this.get),
        photos: { copy: (/** @type {any} */ source, /** @type {any} */ crop) => this.#copy(source, crop) },
      };
      ({ output, ms } = await runTool(tool, input, call));
      // Koe answers at once (the fix pass): a PDF its model can't read (a live one reads none) is Kokoro's to read, not told for it.
      if (output.document && this.#half.name === 'koe' && !o.model?.input?.includes('pdf')) {
        const { document, ...rest } = output;
        output = { ...rest, content: `${output.content}\nYou can't read PDFs; ask Kokoro about it.` };
      }
      // A model that can't see photos gets what a tool's photos show in words, from one that can (the tools stay the same).
      if ((output.images?.length && o.model && !o.model.input?.includes('image')) || (output.document && o.model && !o.model.input?.includes('pdf'))) output = await this.#described(output, o.wakeId, o.signal, o.model);
    }
    /** @type {{ hash?: string, bytes?: Uint8Array, type: string }[]} */
    const blobs = [];
    const media = async (/** @type {any} */ m) => {
      const where = { ...(m.path ? { path: m.path } : {}), ...(m.region ? { region: m.region } : {}), ...(m.name ? { name: m.name } : {}) };
      if (m.data) {
        // New bytes (a request copy made now, a crop, an image a page had): stored with this event, by the hash of what is stored.
        const bytes = fromBase64(m.data);
        const hash = await sha256Hex(bytes);
        blobs.push({ hash, bytes, type: m.mediaType });
        return { hash, mediaType: m.mediaType, ...where };
      }
      blobs.push({ hash: m.hash, type: m.mediaType });
      return { hash: m.hash, mediaType: m.mediaType, ...where };
    };
    let images = [];
    /** @type {any} */
    let document = null;
    try {
      for (const m of output.images ?? []) images.push(await media(m));
      document = output.document ? await media(output.document) : null;
    } catch {
      // An image or document annai can't read is the tool's error, not the turn's (fix pass 8c-1).
      blobs.length = 0;
      images = [];
      document = null;
      output = { content: `Error: ${c.name} gave back an image annai can't read, so its answer was left out.`, isError: true };
    }
    await this.#log({
      type: 'tool.result', actor: 'system',
      data: { id: c.id, name: c.name, ok: !output.isError, ms, wake: o.wakeId, ...(images.length ? { images } : {}), ...(document ? { document } : {}), ...(output.heard?.length ? { heard: output.heard } : {}), ...(output.endTurn ? { end: true } : {}) },
      texts: [['content', output.content]], blobs,
    });
    return output;
  }

  /**
   * A tool's photos and PDF in words, for a model that can't see photos or read PDFs (emulator pass, 5b; the second pass, a PDF):
   * described by the utility role's models, then Main's, that can (the utility list first: a side job, like a summary, on the
   * cheaper model); the crop when a part was asked for, as that is what the tool returned. It stops with the turn, and within
   * DESCRIBE_S; either way the result says so in words. @param {import('./tools.js').ToolOutput} output @param {string} wakeId
   * @param {AbortSignal} signal @param {{ input?: string[] }} [model] the model the result is for
   */
  async #described(output, wakeId, signal, model) {
    const cfg = await this.llm.config();
    const roles = [...(cfg.roles?.utility?.models?.length ? ['utility'] : []), 'main'];
    /** @type {string[]} */
    const said = [];
    /** @param {'image' | 'pdf'} kind @param {any} m */
    const tell = async (kind, m) => {
      const pdf = kind === 'pdf';
      if (!roles.some((role) => chatCandidates(cfg, role).some((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes(kind)))) {
        said.push(pdf ? "No model here can read PDFs, so what it says can't be told." : "No model here can see photos, so what it shows can't be told.");
        return;
      }
      const bytes = m.data ? null : await blobBytes(this.store, m.hash ?? '');
      // A PDF told already in this conversation is told from those words, not sent again (the fix pass): keyed by the bytes told,
      // their own hash, or the one the store gave them by (never a hash a tool claims beside bytes of its own).
      const told = !pdf ? '' : m.data ? `${this.scope}\n${await sha256Hex(fromBase64(m.data))}` : bytes ? `${this.scope}\n${m.hash}` : '';
      if (told && this.#toldPdfs.has(told)) return void said.push(/** @type {string} */ (this.#toldPdfs.get(told)));
      const data = m.data ?? (bytes ? toBase64(bytes) : '');
      const part = pdf ? { type: /** @type {const} */ ('document'), mediaType: m.mediaType, data, ...(m.name ? { name: m.name } : {}) } : { type: /** @type {const} */ ('image'), mediaType: m.mediaType, data };
      let why = '';
      // The turn's stop, and the time limit, end it (without AbortSignal.any, which older browsers lack).
      const stop = new AbortController();
      const end = () => stop.abort();
      const late = setTimeout(end, (pdf ? DESCRIBE_PDF_S : DESCRIBE_S) * this.secondMs);
      signal.addEventListener('abort', end, { once: true });
      try {
        for (const role of roles) {
          if (stop.signal.aborted) break;
          try {
            const r = await this.llm.call({ role, level: 'off', signal: stop.signal, scope: this.scope, record: { tag: 'describe', wake: wakeId }, request: { system: pdf ? DESCRIBE_PDF : DESCRIBE, maxOutput: pdf ? 3000 : 600, messages: [{ role: 'user', parts: [part, { type: 'text', text: pdf ? 'Give this PDF\'s content.' : 'Describe this photo.' }] }] } });
            why = r.reply.text.trim() ? `${pdf ? 'What it says' : 'What it shows'} (${pdf ? 'told' : 'described'} by ${r.answeredBy}, as you can't ${pdf ? 'read PDFs' : 'see photos'}): ${r.reply.text.trim()}${pdf && r.reply.stop === 'length' ? GOES_ON : ''}` : '';
          } catch (e) {
            why ||= `It couldn't be described: ${this.#explain(e, role)}`;
            continue;
          }
          if (why) break;
        }
      } finally {
        clearTimeout(late);
        signal.removeEventListener('abort', end);
      }
      if (stop.signal.aborted && !/^What it (shows|says)/.test(why)) why = signal.aborted ? `It wasn't described: ${STOPPED}` : `It couldn't be described in time (${pdf ? DESCRIBE_PDF_S : DESCRIBE_S} seconds).`;
      if (told && why.startsWith('What it says')) this.#toldPdfs.set(told, why);
      said.push(why || "It couldn't be described.");
    };
    if (!model || !model.input?.includes('image')) for (const m of output.images ?? []) await tell('image', m);
    if (output.document && !model?.input?.includes('pdf')) await tell('pdf', output.document);
    const { images, document, ...rest } = output;
    return { ...rest, ...(model?.input?.includes('image') ? { images } : {}), content: `${output.content}\n${said.join('\n')}` };
  }

  /** The output tools (spec §7.1). @returns {LoopTool[]} */
  #talkTools() {
    const core = /** @type {const} */ ('core');
    const registry = this.registry;
    return [
      {
        name: 'speak', pluginId: core, group: 'Talk',
        description: 'Say something to the user: a short message, as you would say it aloud. With voice on it plays aloud, then listens: the result is what the user said, where they stopped you, or that nothing was heard. With voice off it shows as a bubble.',
        input: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
        run: async (/** @type {{ text: string }} */ i, /** @type {any} */ call) => {
          const text = String(i.text ?? '');
          // The other half may have the voice now; words already playing are said to the end.
          const voiced = call.voice && this.voice && (this.#half.voice() || this.#utterances.has(call.id));
          const unsaid = voiced ? this.#unsaid(call.id) : '';
          await this.#log({ type: 'out.speak', actor: 'shiori', data: { id: call.id, wake: call.wake, ...(voiced && !unsaid ? { voice: true } : {}) }, texts: [['text', text]] });
          if (unsaid) return unsaid;
          if (voiced) return this.#say(text, call);
          this.#setState('speaking');
          return call.sleeping ? 'shown' : SPEAK_RESULT;
        },
      },
      {
        name: 'show', pluginId: core, group: 'Talk',
        // Plugins' card types join the card as they come and go (spec §16.4, milestone 8b choice 7).
        get description() {
          const types = cardTypes(registry);
          return `Show the user a card: text, a place, links, a booking, a photo, or a choice of buttons.${types.length ? ` Card types plugins add: ${types.map((t) => `${t.type} (${t.name}): ${t.description}`).join('; ')}` : ''}`;
        },
        get input() {
          return { type: 'object', properties: { card: cardSchema(cardTypes(registry)) }, required: ['card'] };
        },
        run: async (/** @type {{ card: any }} */ i, /** @type {any} */ call) => {
          if (!i.card || typeof i.card !== 'object') throw new Error('show needs a card.');
          const ok = checkCard(i.card, registry);
          if ('error' in ok) return { content: ok.error, isError: true };
          await this.#log({ type: 'out.show', actor: 'shiori', data: { id: call.id, wake: call.wake, card: ok.card } });
          return 'shown';
        },
      },
      {
        name: 'ask', pluginId: core, group: 'Talk',
        description: 'Ask the user a question with buttons and wait for the answer: a tap, or what they type.',
        input: { type: 'object', properties: { question: { type: 'string', minLength: 1 }, options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } }, required: ['question', 'options'] },
        run: async (/** @type {{ question: string, options: string[] }} */ i, /** @type {any} */ call) => {
          // Checked here, since a model may send anything: the screen shows these as buttons.
          const ok = checkAsk(i);
          if ('error' in ok) return { content: ok.error, isError: true };
          await this.#log({ type: 'out.ask', actor: 'shiori', data: { id: call.id, wake: call.wake, question: ok.question, options: ok.options } });
          if (call.live) return 'Shown; their tap comes as their next turn.';
          if (call.voice && this.voice && !this.#aloudOnly && this.#half.voice()) return this.#askAloud(i.question, call);
          const got = await this.#waitFor(call.id, 'ask', 0);
          if (got.stopped) return { content: STOPPED, isError: true };
          if (got.chosen !== undefined) {
            await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id, ...this.#chose() }, texts: [['text', got.chosen]] });
            return `The user chose: ${got.chosen}`;
          }
          await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.text ?? '']] });
          return `The user wrote: ${got.text}`;
        },
      },
      {
        name: 'wait', pluginId: core, group: 'Talk',
        description: 'Keep listening for the user’s answer for a while (with voice off, wait for typing).',
        input: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: 600 } }, required: ['seconds'] },
        run: async (/** @type {{ seconds: number }} */ i, /** @type {any} */ call) => {
          const seconds = Math.min(600, Math.max(1, Number(i.seconds) || 8));
          if (call.voice && this.voice && !this.#aloudOnly) {
            const heard = await this.#listenFor(call.id, 'wait', seconds, true);
            if (!heard.deaf) return this.#answer('', heard, call, `Nothing yet (${seconds} seconds).`);
          }
          const got = await this.#waitFor(call.id, 'wait', seconds * this.secondMs);
          if (got.stopped) return { content: STOPPED, isError: true };
          if (got.note) return `${got.note === 'koe' ? 'Koe' : 'Kokoro'}: see the note below.`;
          if (got.text === undefined) return `Nothing yet (${seconds} seconds).`;
          await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.text]] });
          if (this.#half.listenLast) this.#facts.wrote = true; // Koe's: a message of theirs it owes an answer
          return `The user wrote: ${got.text}`;
        },
      },
      {
        name: 'sleep', pluginId: core, group: 'Talk',
        description: 'End your turn. Nothing more happens until the user or the app wakes you.',
        input: { type: 'object', properties: {} },
        run: async () => 'asleep',
      },
    ];
  }

  /**
   * Waits for the user: a tap or typing, or a time limit (0: none). A message already queued answers at once.
   * @param {string} id @param {'ask' | 'wait'} kind @param {number} ms
   * @returns {Promise<Got>}
   */
  #waitFor(id, kind, ms) {
    const queued = this.#queue.findIndex((w) => w.kind === 'user' && w.scope === this.scope);
    if (queued >= 0) return Promise.resolve({ text: this.#queue.splice(queued, 1)[0].text });
    // A note already queued answers a wait.
    const note = kind === 'wait' ? this.#queue.find((w) => w.kind === 'note' && w.scope === this.scope) : undefined;
    if (note) return Promise.resolve({ note: note.from ?? 'kokoro' });
    this.#setState('waiting');
    if (kind === 'wait') this.state = { name: 'waiting', label: 'Your turn' };
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      this.#pending = { id, kind, tool: kind === 'wait', resolve: (v) => { clearTimeout(timer); resolve(v); } };
      if (ms > 0) timer = setTimeout(() => {
        if (this.#pending?.id === id) this.#pending = null;
        resolve({});
      }, ms);
    });
  }

  /**
   * The voice mode changed (spec §4.5, §10.5): written in the log. Voice going off closes the
   * microphone, stops her voice, and turns the rest of this turn to bubbles; voice coming on takes
   * effect at her next turn. @param {import('../voice/mode.js').VoiceMode} m
   */
  #voiceChanged(m) {
    if (this.#half.logVoice) record(this.store, this.scope, { now: this.#stamp(this.scope), type: 'state', actor: 'system', data: { voice: m.on ? 'on' : 'off', setting: m.setting, why: m.why } }).catch(() => {});
    if (m.on) return;
    this.#voiceNow = false;
    this.#closeEar();
    this.voice?.speaker.stop();
    if (!this.#busy) this.#setState(this.online() ? 'sleeping' : 'offline'); // a tap's window was listening: the dock says she sleeps again
    const p = this.#pending?.listening ? this.#pending : null;
    if (p) p.listening = false; // a wait for an answer goes on, for typing
  }

  /**
   * The turn's voice, and whether it only speaks: asked to hear her with voice mode off, she speaks, and the
   * microphone stays off (spec §10.5, §6.2). Always worked out together. @param {Wake[]} wakes
   */
  async #workOutVoice(wakes) {
    const asked = wakes.some((w) => w.aloud);
    this.#mayVoice = this.#half.voice();
    this.#voiceNow = await this.#voiceOn(asked);
    this.#aloudOnly = this.#voiceNow && asked && !this.voice?.on;
  }

  /**
   * Whether voice is on for this turn (spec §10.5): it is on, and speak isn't switched off (§7.2). A
   * wake that asks for her voice (the recap told aloud) has it whatever the mode (choice 6).
   * @param {boolean} [asked]
   */
  async #voiceOn(asked = false) {
    // While Koe talks, the microphone and the speaker are Koe's (plan decision 17).
    if (!this.voice || !this.#half.voice()) return false;
    await this.voice.refresh();
    return (this.voice.on || asked) && (await toolSwitches(this.ws)).speak !== false;
  }

  /** How long her first words may take with voice on (spec §9.6: tighter for voice); the role's own limit when lower. @param {string} role */
  async #firstWordsMs(role) {
    const { firstWordsSeconds } = await /** @type {import('../voice/voice.js').Voice} */ (this.voice).settings();
    const own = (await this.llm.config()).roles?.[role]?.firstOutputSeconds;
    return Math.min(firstWordsSeconds, own ?? Infinity) * 1000;
  }

  /**
   * Speech streams in while the model writes it, and plays sentence by sentence (spec §10.1). A
   * call that starts over (another model) drops what it had begun to say.
   * @param {any} ev a stream event @param {string} wakeId
   */
  #streamed(ev, wakeId) {
    if (ev.type === 'restart') {
      this.#cutSpeech(wakeId).catch(() => {});
      return;
    }
    if (!this.#voiceNow || !this.#half.voice() || !this.voice || (ev.type !== 'tool_input' && ev.type !== 'tool_call') || ev.name !== 'speak') return;
    let u = this.#utterances.get(ev.id);
    if (!u) {
      // Only the reply's first speak plays as it streams: a later one plays when its turn comes, after the first has listened.
      if (this.#streaming && this.#streaming !== ev.id) return;
      this.#streaming = ev.id;
      u = this.voice.speaker.begin();
      this.#utterances.set(ev.id, u);
      if (this.#cut) u.stop(); // she was stopped: nothing more until she has listened
      else {
        this.#closeEar('speaking'); // half-duplex (spec §10.4)
        this.#setState('speaking');
      }
    }
    if (ev.type === 'tool_input') {
      const text = parsePartialJSON(ev.partial)?.text;
      if (typeof text === 'string') u.feed(text);
    } else {
      u.end(String(ev.input?.text ?? ''));
    }
  }

  /**
   * Speech that streamed in and played but whose call never ran (the call was cut, or started over): what
   * was said aloud is written into the conversation, marked cut. @param {string} wakeId @returns {Promise<string>} what was said
   */
  async #cutSpeech(wakeId) {
    const begun = [...this.#utterances];
    this.#utterances.clear();
    this.#streaming = '';
    let said = '';
    for (const [id, u] of begun) {
      u.stop();
      const spoken = await u.done;
      if (!spoken.heard) continue;
      said = spoken.heard;
      await this.#log({ type: 'out.speak', actor: 'shiori', data: { id, wake: wakeId, voice: true, ...(spoken.cut ? { cut: true } : {}) }, texts: [['text', said]] });
    }
    return said;
  }

  /**
   * A later speak in a reply after the user stopped her, or after chatter sent her back to sleep, isn't
   * said and doesn't listen (spec §10.4); it shows as a bubble. A speak that had begun to play is said up to the stop.
   * @param {string} id @returns {string} the result, or '' when it is said
   */
  #unsaid(id) {
    if (this.#utterances.has(id) || (!this.#cut && !this.#wentToSleep)) return '';
    return `Not said aloud: ${this.#wentToSleep ? 'you went back to sleep' : 'the user stopped you'}. It was shown on screen.`;
  }

  /**
   * speak with voice on (spec §7.1, §10.1): plays what streamed in, then listens, unless sleep came
   * in the same reply. @param {string} text @param {any} call
   * @returns {Promise<import('./tools.js').ToolOutput | string>}
   */
  async #say(text, call) {
    const voice = /** @type {import('../voice/voice.js').Voice} */ (this.voice);
    let u = this.#utterances.get(call.id);
    this.#utterances.delete(call.id);
    if (!u) {
      u = voice.speaker.begin();
      if (this.#cut) u.stop();
    }
    if (!u.stopped) {
      this.#closeEar('speaking');
      this.#setState('speaking');
    }
    u.end(text);
    const spoken = await u.done;
    if (spoken.heard) this.#lastSaid = spoken.heard; // only what was said aloud
    if (spoken.failed) {
      await this.#notice(spoken.failed === 'blocked'
        ? { tone: 'info', title: 'Tap the screen so Shiori can speak', body: 'This browser plays sound only after a tap. Her words are in the conversation.' }
        : { tone: 'warn', title: "Shiori couldn't speak aloud", body: 'No voice in Settings → Models → Speech out worked; the Trace says why. Her words are in the conversation.' });
      return unspoken(spoken.failed);
    }
    if (spoken.cut && this.#noteCut) {
      // Cut in for a note, which follows: the turn goes on without listening.
      this.#noteCut = false;
      return spoken.heard ? `A note stopped you after: "${spoken.heard}". It follows.` : 'A note stopped you before you said anything. It follows.';
    }
    if (spoken.cut) this.#cut = true;
    const before = spokenText(spoken);
    if (call.sleeping) return spoken.cut ? `${before} The microphone is open: what they say next wakes you.` : before;
    if (call.more) return before;
    if (this.#aloudOnly) return `${before} Voice mode is off, so you didn't listen; the user may type.`;
    const { silenceSeconds } = await voice.settings();
    return this.#answer(before, await this.#listenFor(call.id, 'wait', silenceSeconds), call, `Heard nothing (${silenceSeconds} seconds).`);
  }

  /**
   * ask with voice on (spec §7.1): the question is spoken; the answer is a tap, typing, or speech.
   * Listening stops after the silence limit; the buttons keep waiting.
   * @param {string} question @param {any} call
   */
  async #askAloud(question, call) {
    const voice = /** @type {import('../voice/voice.js').Voice} */ (this.voice);
    const u = voice.speaker.begin();
    this.#closeEar('speaking');
    this.#setState('speaking');
    u.end(question);
    const spoken = await u.done;
    if (spoken.heard) this.#lastSaid = spoken.heard;
    /** @type {Got} */
    let got = spoken.failed ? {} : await this.#listenFor(call.id, 'ask', (await voice.settings()).silenceSeconds);
    if (got.dismissed) {
      this.#chatter.push(got.dismissed); // written in at her next step; the buttons keep waiting
      got = {};
    }
    if (got.heard || got.dismissed || got.text !== undefined || got.chosen !== undefined || got.stopped) {
      if (got.chosen === undefined) return this.#answer('', got, call, '');
    } else {
      if (this.#ear?.owner === 'turn') this.#closeEar();
      got = await this.#waitFor(call.id, 'ask', 0);
    }
    if (got.stopped) return { content: STOPPED, isError: true };
    if (got.chosen !== undefined) {
      await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id, ...this.#chose() }, texts: [['text', got.chosen]] });
      return `The user chose: ${got.chosen}`;
    }
    return this.#answer('', got, call, '');
  }

  /**
   * What a listen got, as a tool's result (spec §7.1). Heard speech is written to the log and
   * follows the result. @param {string} before what speak says happened first ('' for wait and ask)
   * @param {Got} got @param {any} call @param {string} silence the words for nothing heard
   * @returns {Promise<import('./tools.js').ToolOutput | string>}
   */
  async #answer(before, got, call, silence) {
    const lead = before ? `${before} ` : '';
    if (got.stopped) return { content: STOPPED, isError: true };
    if (got.heard) {
      await this.#logHeard(got.heard, { wake: call.wake, answer: call.id, gate: got.gate });
      return { content: `${lead}The user said:`, heard: [got.heard.id] };
    }
    if (got.dismissed) {
      await this.#logHeard(got.dismissed, { wake: call.wake, answer: call.id, dismissed: true, gate: 'chatter' });
      return { content: `${lead}Someone spoke, but not to you; it is below. You went back to sleep.`, heard: [got.dismissed.id], endTurn: true };
    }
    if (got.text !== undefined) {
      await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.text]] });
      return `${lead}The user wrote: ${got.text}`;
    }
    if (got.deaf) return `${lead}annai couldn't listen: ${got.deaf} The user may type.`;
    if (got.note) return `${lead}${got.note === 'koe' ? 'Koe' : 'Kokoro'}: see the note below.`;
    if (got.earlier) return `${lead}Not listening for an answer: the user spoke while you were thinking; it follows.`;
    return `${lead}${silence}`;
  }

  /**
   * Listens for the user's answer (spec §10.4): the first thing heard, typing, or a tap; or a
   * silence of seconds. Speech heard before isn't an answer: it reaches her as heard while she was
   * thinking, and with such speech waiting, speak and wait don't listen: it reaches her at once.
   * @param {string} id @param {'wait' | 'ask'} kind @param {number} seconds @param {boolean} [tool] the wait tool's @returns {Promise<Got>}
   */
  async #listenFor(id, kind, seconds, tool = false) {
    const typed = this.#queue.findIndex((w) => w.kind === 'user' && w.scope === this.scope);
    if (typed >= 0) return { text: this.#queue.splice(typed, 1)[0].text };
    if (kind === 'wait' && this.#queue.some((w) => w.kind === 'heard' && w.scope === this.scope)) return { earlier: true };
    const note = kind === 'wait' ? this.#queue.find((w) => w.kind === 'note' && w.scope === this.scope) : undefined;
    if (note) return { note: note.from ?? 'kokoro' };
    if (!this.#half.voice()) return { deaf: 'the other half has the microphone now.' };
    const deaf = await this.#openEar('turn');
    if (deaf) return { deaf };
    this.#setState('listening');
    return new Promise((resolve) => {
      /** @type {any} */
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.#pending?.id !== id) return;
          this.#pending = null;
          resolve({});
        }, seconds * this.secondMs);
      };
      this.#pending = { id, kind, listening: true, tool, arm, hold: () => clearTimeout(timer), resolve: (v) => { clearTimeout(timer); resolve(v); } };
      arm();
    });
  }

  /**
   * Opens the listening window (spec §10.2, §10.4) if voice can listen: recording or phone
   * dictation, as the speech-in list says. A window already open stays as it is.
   * @param {'tap' | 'turn'} owner @returns {Promise<string | null>} null when listening; otherwise why not
   */
  #openEar(owner) {
    const run = this.#earLock.then(() => this.#openEarNow(owner));
    this.#earLock = run.catch(() => {});
    return run;
  }

  /** @param {'tap' | 'turn'} owner @returns {Promise<string | null>} */
  async #openEarNow(owner) {
    const voice = this.voice;
    if (!voice) return "voice isn't available here.";
    if (this.#ear) return null; // a tap's window stays the tap's until the first thing said: that needs no gate (choice 3)
    const how = await voice.howToListen(this.#half.role);
    if ('why' in how) {
      // The mic button explains what to add (spec §10.3): on every tap, and once for her own listening.
      if (owner === 'tap' || !this.#toldDeaf) await this.#notice({ tone: 'warn', title: "Shiori can't hear you yet", body: how.why });
      this.#toldDeaf = true;
      return how.why;
    }
    /** @type {{ owner: 'tap' | 'turn', session: { stop(): void } | null }} */
    const ear = { owner, session: null };
    this.#ear = ear;
    try {
      const session = await voice.open({
        kind: how.kind, scope: this.scope,
        onSegment: (h) => this.#heard(h),
        onSpeech: () => this.#speechStarted(),
        onQuiet: () => this.#speechStopped(),
        onError: (e) => this.#earFailed(e),
      });
      if (this.#ear === ear) {
        ear.session = session;
        this.#toldDeaf = false;
      } else {
        session.stop(); // closed while it opened
      }
      return null;
    } catch (e) {
      if (this.#ear === ear) this.#ear = null;
      const problem = voice.problem(e); // denied: steps for this phone (spec §17 rule 3)
      await this.#notice({ tone: 'warn', title: problem.title, body: problem.body });
      return `${problem.title}.`;
    }
  }

  /** Closes the listening window; speech still going on becomes a segment first. @param {'playback' | 'speaking'} [next] */
  #closeEar(next = 'playback') {
    clearTimeout(this.#quiet);
    if (this.#speaking) {
      this.#speaking = false;
      this.poke();
    }
    const ear = this.#ear;
    if (!ear) return;
    this.#ear = null;
    ear.session?.stop();
    if (next === 'playback') this.voice?.platform?.session('playback'); // full-quality Bluetooth audio again (spec §10.1)
  }

  /** What the microphone heard (spec §10.4), handled in order. @param {Heard} h */
  #heard(h) {
    this.#speaking = false; // its segment came: they stopped
    this.poke();
    this.#hearing = this.#hearing.then(() => this.#route(h)).catch((e) => { console.warn('heard speech was not handled', e); });
  }

  /**
   * Where a segment goes (spec §10.4): the answer she listens for; a tap's first words, which wake
   * her; or, while she works, her next call ("heard while you were thinking"), which a new turn
   * takes if this one ends first: nothing heard is lost. @param {Heard} h
   */
  async #route(h) {
    const tapped = this.#ear?.owner === 'tap';
    const p = this.#pending?.listening ? this.#pending : null;
    if (p) {
      const verdict = tapped ? null : await this.#gate(h);
      if (this.#pending === p) {
        this.#pending = null;
        if (this.#ear) this.#ear.owner = 'turn';
        this.#setState('thinking');
        p.resolve(verdict === 'chatter' ? { dismissed: h } : { heard: h, ...(verdict ? { gate: verdict } : {}) });
        return;
      }
    }
    if (tapped && !this.#busy) {
      // A tap's window: the first thing said wakes her, and the window is the turn's from then on.
      clearTimeout(this.#quiet);
      if (this.#ear) this.#ear.owner = 'turn';
      this.#push({ kind: 'heard', text: '', heard: h });
      this.#drain();
      return;
    }
    const verdict = await this.#gate(h);
    if (this.state.name === 'hearing') this.#setState(this.#busy ? 'thinking' : 'listening');
    if (verdict === 'chatter') {
      // Chatter: recorded, and she sleeps on (spec §10.4).
      if (this.#busy) this.#chatter.push(h);
      else await this.#logHeard(h, { dismissed: true, gate: 'chatter' });
      return;
    }
    this.#push({ kind: 'heard', text: '', heard: h, ...(verdict ? { gate: verdict } : {}) });
    this.#drain();
  }

  /**
   * The quick-decision gate for one segment (spec §10.4). It runs only when a quick-decision model
   * is configured (falling back to the main model would double the calls): what was heard goes to
   * the decide role, as audio or words like any speech. A gate that fails is unsure.
   * @param {Heard} h @returns {Promise<'shiori' | 'chatter' | 'unsure' | null>} null: no gate ran
   */
  async #gate(h) {
    const cfg = await this.llm.config();
    if (!cfg.roles?.decide?.models?.length || !this.llm.gate || !this.voice) return null;
    try {
      const r = await this.llm.gate({
        prompt: gatePrompt(this.#lastSaid), options: GATE_OPTIONS, scope: this.scope, speech: this.voice.resolver(this.scope),
        parts: [{ type: 'speech', id: h.id, ...(typeof h.text === 'string' ? { text: h.text } : {}) }],
      });
      if (r.by === 'unsure') return 'unsure';
      return (r.probabilities.chatter ?? 0) > (r.probabilities.shiori ?? 0) ? 'chatter' : 'shiori';
    } catch {
      return 'unsure'; // the gate never loses speech: unsure goes to the main model
    }
  }

  /** Chatter heard while she worked, written in now (spec §10.4: dismissed speech still goes into the transcript). @param {string} wakeId */
  async #writeChatter(wakeId) {
    for (const h of this.#chatter.splice(0)) await this.#logHeard(h, { wake: wakeId, meanwhile: true, dismissed: true, gate: 'chatter' });
  }

  /** Someone started speaking: Hearing you, and no silence limit while they speak. */
  #speechStarted() {
    this.#speaking = true;
    clearTimeout(this.#quiet);
    this.#pending?.hold?.();
    if (!this.voice?.speaker.speaking) this.#setState('hearing');
  }

  /** What began like speech wasn't (a click): the silence limit starts again, or a note waiting is taken. */
  #speechStopped() {
    this.#speaking = false;
    this.#pending?.arm?.();
    const tapped = this.#ear?.owner === 'tap' && !this.#busy;
    if (tapped) this.#armQuiet();
    if (this.state.name === 'hearing') this.#setState(this.#pending?.listening || tapped ? 'listening' : 'thinking');
    this.#noted();
  }

  /** The microphone stopped while listening (another app took it, say): a card says why, and a wait for an answer ends. @param {Error} e */
  #earFailed(e) {
    const problem = this.voice?.problem(e) ?? { title: 'Listening stopped', body: String(e?.message ?? e) };
    this.#closeEar();
    this.#notice({ tone: 'warn', title: problem.title, body: problem.body });
    const p = this.#pending?.listening ? this.#pending : null;
    if (p) {
      this.#pending = null;
      p.resolve({ deaf: `${problem.title}.` });
    }
  }

  /**
   * Tapping Shiori (spec §6.7, §10.4): while she speaks, stops her, keeps where, and opens the
   * microphone; while she listens, stops listening and her turn; while she works, stops her turn;
   * otherwise, with voice on, starts listening (and with voice off, typing opens).
   * @returns {'cut' | 'stopped' | 'listening' | 'typing'}
   */
  tap() {
    this.voice?.unlock(); // inside the tap: sound may play from now on (spec §10.1)
    const voiceOn = Boolean(this.voice?.on);
    if (this.voice?.speaker.speaking) {
      this.voice.speaker.stop();
      for (const u of this.#utterances.values()) u.stop();
      this.#cut = true;
      if (voiceOn) this.#tapListen();
      return 'cut';
    }
    if (this.#gathering) {
      // A turn of theirs that hasn't started yet (GATHER): a tap stops it, as the sign's Stop does Kokoro's.
      this.#closeEar();
      this.interrupt();
      return 'stopped';
    }
    const s = this.state.name;
    if (s === 'listening' || s === 'hearing') {
      this.#closeEar();
      if (this.#busy) this.interrupt();
      else this.#setState(this.online() ? 'sleeping' : 'offline');
      return 'stopped';
    }
    if (s === 'thinking' || s === 'away') {
      this.interrupt();
      return 'stopped';
    }
    if (!voiceOn) return 'typing';
    this.#tapListen();
    return 'listening';
  }

  /** The user tapped to talk (spec §10.4): the microphone opens; a silence closes it again. */
  #tapListen() {
    this.#openEar('tap').then(async (deaf) => {
      if (deaf) return; // the card said why
      const p = this.#pending;
      if (p?.kind === 'ask') p.listening = true; // an ask's answer may be spoken
      if (this.#busy) return; // she is speaking or working: the window serves her turn
      this.#setState('listening');
      this.#armQuiet();
    });
  }

  /** A tap's window that hears nothing closes after the silence limit. */
  async #armQuiet() {
    clearTimeout(this.#quiet);
    const seconds = this.voice ? (await this.voice.settings()).silenceSeconds : 8;
    clearTimeout(this.#quiet);
    this.#quiet = setTimeout(() => {
      if (this.#ear?.owner !== 'tap' || this.#busy) return;
      this.#closeEar();
      this.#setState(this.online() ? 'sleeping' : 'offline');
    }, seconds * this.secondMs);
  }

  /**
   * The end of a turn: speech streamed but never said stops; the microphone closes unless the user
   * tapped to talk (spec §6.2, §10.4); after a turn that worked, the half that hears writes down what was heard.
   * @param {boolean} ok @param {string} wakeId
   */
  async #afterTurn(ok, wakeId) {
    for (const u of this.#utterances.values()) u.stop();
    this.#utterances.clear();
    if (this.#ear?.owner === 'turn') this.#closeEar();
    else if (!this.#ear && this.#voiceNow) this.voice?.platform?.session('playback'); // after speaking (spec §10.1)
    await this.#writeChatter(wakeId);
    if (ok && this.#half.voice()) await this.#writeDown(wakeId);
  }

  /**
   * The words of what was heard are written down, and the sound is let go (spec §10.3: each
   * segment stays in memory until the turn that used it succeeds; text versions are made then, the
   * last time the sound is at hand). When nothing could write it down, the sound stays for the next
   * turn that works; after WRITE_TRIES of them it is written as not transcribed. final: this is the last chance (housekeeping
   * that must summarize them now). @param {string} wakeId @param {string[]} [ids] @param {{ final?: boolean }} [o]
   * @returns {Promise<string[]>} the segments still not written down, whose sound is kept
   */
  async #writeDown(wakeId, ids = this.transcript.unwritten(), { final = false } = {}) {
    const voice = this.voice;
    if (!voice) return [];
    const { role } = this.#half;
    const hearer = await this.#hearer(role);
    /** @type {string[]} */
    const left = [];
    for (const id of ids) {
      if (!voice.memory.get(id)) {
        // Its sound went with an earlier start, and no clip was kept: it can never be written down (its bubble says so).
        const clip = this.transcript.messages.some((m) => m.parts.some((p) => p.type === 'speech' && p.id === id && p.clip));
        if (!clip) await this.#log({ type: 'heard.text', actor: 'system', data: { of: id, wake: wakeId, text: NOT_TRANSCRIBED, by: null } });
        continue;
      }
      const r = await voice.writeDown(id, { scope: this.scope, wake: wakeId, ...(hearer ? { hearer } : {}), ...(role === 'main' ? {} : { role }) }).catch(() => null);
      if (!r && !final) {
        // Nothing wrote it down this time (a rate limit, say): the sound stays, and the next turn that works tries again.
        const tries = (this.#writeTries.get(id) ?? 0) + 1;
        this.#writeTries.set(id, tries);
        if (tries < WRITE_TRIES) {
          left.push(id);
          continue;
        }
      }
      this.#writeTries.delete(id);
      await this.#log({ type: 'heard.text', actor: 'system', data: { of: id, wake: wakeId, text: r ? r.text : NOT_TRANSCRIBED, by: r?.by ?? null } });
      voice.memory.drop(id, r?.text);
    }
    return left;
  }

  /**
   * Who writes heard sound down for "Send audio to the model" (spec §10.3): the model that heard it
   * in this turn, else (housekeeping) the half's role's first model that takes audio.
   * @param {string} role @returns {Promise<string | undefined>}
   */
  async #hearer(role) {
    if (this.#heardBy) return this.#heardBy;
    const cfg = await this.llm.config();
    return chatCandidates(cfg, role).find((/** @type {string} */ id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes('audio'));
  }

  /**
   * Writes what was heard (spec §10.2: transcripts go into the log). @param {Heard} h
   * @param {{ wake?: string, meanwhile?: boolean, answer?: string, dismissed?: boolean, gate?: string }} o
   * @param {(ev: Parameters<typeof record>[2]) => Promise<unknown>} [log]
   */
  async #logHeard(h, o, log = (ev) => this.#log(ev)) {
    // The sound is kept only with "keep voice clips" (spec §10.2), as a blob the event names (§4.9), in the smallest format this phone makes and plays.
    const clip = this.voice ? await this.voice.keep(h) : { data: {}, blobs: [] };
    await log({
      type: 'heard', actor: 'user',
      data: {
        id: h.id, ...(o.wake ? { wake: o.wake } : {}), ms: h.ms, source: h.source, ...(typeof h.text === 'string' ? { text: h.text } : {}),
        ...(o.meanwhile ? { meanwhile: true } : {}), ...(o.answer ? { answer: o.answer } : {}), ...(o.dismissed ? { dismissed: true } : {}), ...(o.gate ? { gate: o.gate } : {}),
        ...clip.data,
      },
      blobs: clip.blobs,
    });
  }
}

/** The messages with each swapped photo replaced by its new copy. @param {import('../llm/contract.js').Message[]} messages @param {Map<string, any>} swaps */
function replaceImages(messages, swaps) {
  return messages.map((m) => ({
    role: m.role,
    parts: m.parts.map((p) => {
      const c = p.type === 'image' && p.hash ? swaps.get(p.hash) : null;
      return c ? { ...p, hash: c.hash, mediaType: c.mediaType, ...(c.data ? { data: c.data } : {}) } : p;
    }),
  }));
}

/** A refused photo in plain words, with what to try (spec §17). @param {import('./refusals.js').Learned | null} learned */
function refusedText(learned) {
  /** @type {string[]} */
  const takes = [];
  if (learned?.maxBytes) takes.push(`at most ${(learned.maxBytes / 1_000_000).toFixed(1)} MB`);
  if (learned?.maxEdge) takes.push(`at most ${learned.maxEdge} pixels on a side`);
  if (learned?.maxCount) takes.push(`at most ${learned.maxCount} photos at a time`);
  if (learned?.formats?.length) takes.push(`only ${learned.formats.map((x) => x.replace('image/', '').toUpperCase()).join(' or ')}`);
  const why = takes.length ? ` (it takes ${takes.join(', ')})` : '';
  return `The model refused a photo${why}, and annai couldn't make a copy it takes. Try smaller photos in Settings → Photos → Photos for Shiori, or another model in Settings → Models.`;
}
