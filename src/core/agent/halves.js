import { Agent, GATHER, isTheirs, isForUser, checkCard, checkAsk, CAPS, capped } from './loop.js';
import { TALK_TAG, KOE_TAG } from './log.js';
import { asksOrNotes, quote, cardText, escapeTags, newNonce } from './blocks.js';
import { systemText, nowBlock, takeSnapshot } from './context.js';
import { ME, SYS_SETTINGS, newId } from '../scopes.js';
import { storedTexts } from './log.js';
import { chatCandidates, koeWay, AllFailedError, COOLDOWN_MS } from '../llm/fallback.js';
import { LiveKoe } from '../koe/live.js';
import { ProviderError, explain } from '../llm/contract.js';
import { KOKORO_PART, koeSystem } from '../koe/instructions.js';
import { koeTools, ALREADY_TOLD } from '../koe/tools.js';
import { compactView } from '../koe/context.js';
import { readAppSettings } from '../settings.js';
import { languageSettings, modelLanguages } from '../languages.js';
import { modelOf, saveKoeMode, KOE_CLASSIC, KOE_REALTIME } from '../llm/config.js';

/**
 * Shiori as two halves (the Koe and Kokoro design): Koe talks with the user at once, Kokoro (Shiori as
 * she was, on Main) thinks and works behind it. Halves runs both as instances of the one loop and is
 * what the app holds, with the Agent's surface. Koe logs what the user types and Kokoro reads it and
 * wakes; the halves pass notes that never wait; Kokoro's output tools are gated in code while Koe
 * talks; Koe's state reaches Kokoro as blocks in its messages, never in its system text or tools.
 * With no Koe model, everything goes to Kokoro: Shiori as one half.
 * @typedef {import('./loop.js').Wake} Wake
 * @typedef {import('./loop.js').TurnEnd} TurnEnd
 * @typedef {'text' | 'live' | 'down' | 'off'} KoeState  text: Koe talks through the loop; live: in live sessions (K5); down: Koe's list failed, and it rests; off: no Koe model
 * @typedef {'koe-up' | 'koe-down'} Told
 * @typedef {Told | 'live-open' | 'live-closed' | 'live-dropped'} Block
 * @typedef {'koe' | 'kokoro'} Side
 * @typedef {'tool' | 'gated:speak' | 'gated:show' | 'gated:ask' | 'final-text' | 'kokoro-failed' | 'nothing-to-add' | 'stopped'} NoteWhy
 */

/** The events a half marks as its own while Shiori is two halves. */
const MARKED = new Set(['wake', 'tool.call', 'tool.result', 'error', 'out.speak', 'out.show', 'out.ask', 'note', 'model.turn', 'heard']);
const BLOCKS = Object.freeze({
  'koe-down': "Koe can't speak right now; talk to the user directly.",
  'koe-up': 'Koe is speaking again; use tell_koe.',
  'live-open': 'A live voice session opened: Koe speaks natively, and its words reach you as [Koe said aloud].',
  'live-closed': 'The live voice session closed.',
  'live-dropped': "The live voice session dropped and couldn't resume: Koe goes on through its next model.",
});
/** What Koe is told when it asks Kokoro after the user's Stop. */
export const STOP_HELD = "Not sent: the user stopped Kokoro, and hasn't written or spoken since. Don't ask Kokoro again until they do; tell them what you know yourself.";
/** How long Koe rests after its whole list failed, at least. */
export const KOE_REST_MS = 60_000;
const KOKORO_ONLY = ['personality', 'restart'];
/** The user's own wakes, past the budgets. */
const THEIRS = ['user', 'choice', 'file', 'live'];
/** Kokoro reviews the conversation it hasn't read once this much of it has gone by (plan decision 8). */
export const REVIEW_MS = 180_000;
const REVIEW = "a review: 3 minutes or more of conversation since you last looked. If something heard was meant for Shiori and Koe missed it, or Koe said something wrong, tell Koe; otherwise sleep.";
/** Words for the user as annai shows them: a leading "Say:" (an instruction to Koe) goes, and the first letter is a capital. @param {unknown} text */
const forUserText = (text) => String(text ?? '').replace(/^\s*say\s*:\s*/i, '').trim().replace(/^./u, (c) => c.toUpperCase());
/** The conversation's lines, for the review. */
const LINES = ['msg.user', 'heard', 'out.speak', 'out.show', 'out.ask'];

/** The notes between the halves: written into the conversation, then handed over; the sender never waits. */
export class Channel {
  /** @param {{ log: Record<Side, (ev: any) => Promise<any>>, deliver: Record<Side, (w: Wake) => void>, cut: Record<Side, () => void> }} c */
  constructor({ log, deliver, cut }) {
    this.log = log;
    this.deliver = deliver;
    this.cut = cut;
  }

  /**
   * append reaches the other half before its next model call, or starts its turn; immediate also cuts its call.
   * @param {Side} from @param {string} text @param {'append' | 'immediate'} mode @param {NoteWhy} why @param {string} [wake]
   * @param {{ name: string, input: any }} [call] the gated call of Kokoro's it stands for
   * @param {boolean} [watched] Koe's turn that sends it is one the user is watching (isWatched): a note of Koe's is the user's only then
   * @param {string} [forUser] Kokoro's exact words for the user (tell_koe's for_user) @returns {Promise<'sent'>}
   */
  async send(from, text, mode, why, wake, call, watched = false, forUser = '') {
    const to = from === 'koe' ? 'kokoro' : 'koe';
    const e = await this.log[from]({ type: 'note', actor: 'shiori', data: { id: newId('n'), from, mode, why, ...(wake ? { wake } : {}) }, texts: [['text', text], ...(forUser ? /** @type {[string, string][]} */ ([['forUser', forUser]]) : [])] });
    // The other half's "woke for": Koe never mentions Kokoro, so its says only that a note came.
    this.deliver[to]({ kind: 'note', logged: true, from, note: text, mode, why, seq: e?.seq, ...(call ? { call } : {}), ...(from === 'koe' ? { watched } : {}), ...(forUser ? { forUser } : {}), text: from === 'koe' ? `Koe ${asksOrNotes(text)}: ${quote(text.length > 120 ? `${text.slice(0, 120)}…` : text)}` : 'a note from Kokoro' });
    if (mode === 'immediate') this.cut[to]();
    return 'sent';
  }
}

/** Koe's tell_kokoro, Kokoro's tell_koe. @param {Side} from @param {Channel} channel @param {() => string | null} [refuse] why not now @returns {import('./loop.js').LoopTool} */
export function channelTool(from, channel, refuse = () => null) {
  const koe = from === 'koe';
  const name = koe ? 'tell_kokoro' : 'tell_koe';
  return {
    name, pluginId: 'core', group: 'Talk',
    description: koe
      ? "Ask or tell Kokoro, your other half, who looks things up and works behind you. It returns at once; Kokoro's answer comes as a note. mode immediate cuts Kokoro off mid-task: use it only when something really should be cut off."
      : 'Tell Koe, who talks with the user, what to say or know: an answer, or a correction with the fact and its source. Koe says it in its own words. It returns at once. mode immediate cuts Koe off mid-sentence: use it only when something really should be cut off, such as a wrong claim. for_user: when you have an answer for the user, the exact words for them; annai shows them only if Koe never says it.',
    input: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, mode: { enum: ['append', 'immediate'] }, ...(koe ? {} : { for_user: { type: 'string' } }) }, required: ['text'] },
    run: async (/** @type {{ text: string, mode?: string, for_user?: string }} */ i, /** @type {any} */ call) => {
      const text = String(i.text ?? '').trim();
      const no = text ? refuse() : `Error: ${name} needs the text to pass on.`;
      if (no) return { content: no, isError: true };
      return channel.send(from, text, i.mode === 'immediate' ? 'immediate' : 'append', 'tool', call.wake, undefined, Boolean(call.watched), koe ? '' : String(i.for_user ?? '').trim());
    },
  };
}

export class Halves {
  /** @type {KoeState} */
  koeState = 'off';
  #split = false;
  /** Until when Koe rests, after its list failed whole. */
  #downUntil = 0;
  /** Koe is back, but waits for Kokoro's turn with the voice to end. */
  #later = false;
  /** What Kokoro was told last, in which conversation. @type {{ scope: string | null, state: Told }} */
  #told = { scope: null, state: 'koe-up' };
  /** The user's last input (typed, sent or heard), and whether it was a photo on its own: Kokoro waits for it to go quiet (GATHER). */
  #input = { at: 0, photo: false };
  /** @type {Promise<unknown>} both halves' writes, one at a time */
  #lock = Promise.resolve();
  /** @type {Promise<unknown>} what the user typed and what woke Shiori, in order */
  #routing = Promise.resolve();
  #routes = 0;
  /** @type {Set<Promise<unknown>>} annai's own notes from Kokoro to Koe, being written: idle() waits for them */
  #sending = new Set();
  /** @type {string | null | undefined} the trip Koe has open; undefined: none yet */
  #koeTrip = undefined;
  /** Kokoro told Koe since the user last typed or spoke: Koe asking about it again wakes nobody. */
  #answered = false;
  /** Heard words Kokoro hasn't woken for: Koe answering them wakes it. */
  #cue = false;
  /** Koe's reply asks Kokoro, so its question wakes Kokoro, not its answer (owed: unless the question fails). */
  #asking = false;
  #owed = false;
  /** A question of Koe's reached Kokoro, unanswered yet: someone waits for Kokoro. */
  #asked = false;
  /** Why Kokoro's list last failed, in plain words: what its models rest for. */
  #why = '';
  /** When the first line Kokoro hasn't read came; 0: none. */
  #unseen = 0;
  /** @type {string[]} what Kokoro told Koe for the user that Koe hasn't passed on since */
  #unsaid = [];
  /** Kokoro's notes with no words for the user that Koe never passed on: each goes to Koe once more, with the user's next words (§7.1). @type {Wake[]} */
  #retell = [];
  #failTold = false;
  #nothingTold = false;
  /** Why each half's list last failed, while it is down (a failure only of models resting keeps the reason before). */
  #lost = { koe: '', kokoro: '' };
  /** The card for both halves down was shown: once, until the user writes again or a half works again. */
  #bothTold = false;
  /**
   * The user stopped Kokoro (the sign's Stop), and Koe hasn't heard of it: Koe's notes start no Kokoro turn until the user writes
   * or speaks again, or Koe's model has seen "Kokoro was stopped" (the seq of that note; Infinity: not written yet).
   */
  #stopped = { on: false, seq: Infinity };
  /** The user stopped Kokoro and hasn't written or spoken since: Koe's tell_kokoro is refused. */
  #stopHeld = false;
  #lastHalves = '';
  #lastView = '';
  /** The realtime model of Koe's pathway now, and whether voice was on when it was worked out. @type {string | null} */
  #liveId = null;
  #voiceWas = false;
  /** Koe's way now (the voice chip's words and switch): the mode chosen, the list in use, and why Classic stands in. @type {import('../llm/fallback.js').KoeWay | null} */
  #way = null;
  /** A refresh for when a resting realtime model can answer again, so the chosen Realtime comes back. @type {ReturnType<typeof setTimeout> | undefined} */
  #back;
  /** The page went with that refresh waiting: it asks again when the page is back. */
  #backAway = false;
  /** Realtime can talk, but waits for Classic's turn with the voice to end (one voice at a time): Koe's ended asks again. */
  #koeLater = false;
  /** A refresh for writes under /llm/ is waiting to run: more writes meanwhile (a provider and its models) join it. */
  #llmChanged = false;
  #lastCard = { key: '', at: 0 };
  /** The open conversation's next reminder, for Koe's view (set by the app). @type {(() => Promise<{ due: number, text: string } | null>) | null} */
  next = null;
  /** The settings read as annai starts: no turn runs before. @type {Promise<unknown>} */
  #ready;
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set(), open: new Set(), halves: new Set(), clear: new Set() };

  /** @param {ConstructorParameters<typeof Agent>[0]} c what each half is made with: one voice, the talking half's (plan decision 17) */
  constructor(c) {
    this.nonce = newNonce();
    this.clock = c.now ?? Date.now;
    this.secondMs = c.secondMs ?? 1000;
    this.channel = new Channel({
      log: { koe: (ev) => this.koe.log(ev), kokoro: (ev) => this.kokoro.log(ev) },
      deliver: {
        koe: (w) => {
          if (isForUser(w) && !w.retold) this.#unsaid.push(w.text);
          this.#koeOpen();
          if (this.koeState === 'live') this.#live(() => this.live.note(String(w.note), w.mode === 'immediate' ? 'immediate' : 'append', isForUser(w) ? w : null), w);
          else this.koe.enqueue(w);
        },
        kokoro: (w) => {
          if (w.from === 'koe' && (this.#answered || this.#stopped.on)) return;
          this.#asked ||= w.from === 'koe';
          this.#wakeKokoro(w);
        },
      },
      // A live session's immediate note cuts Koe off itself.
      cut: { koe: () => { if (this.koeState !== 'live') this.koe.cutIn(); }, kokoro: () => this.kokoro.cutIn() },
    });
    const serial = (/** @type {() => Promise<any>} */ fn) => this.#serial(fn);
    const ready = () => this.#ready;
    this.kokoro = new Agent({
      ...c,
      half: {
        name: 'kokoro', tag: TALK_TAG, role: 'main', registryTools: true, logVoice: true, housekeeping: true, serial, ready,
        voice: () => !this.#works(),
        rules: () => (this.#split ? 'kokoro' : 'one'),
        system: (s) => systemText(s, this.#split ? KOKORO_PART : ''),
        koe: () => (this.#split ? (this.#works() ? this.koeState : 'down') : null),
        hidden: async () => (this.#split ? [] : ['tell_koe']),
        // Its errors while Koe talks are set aside: Koe tells the user, and a card says what needs saying.
        mark: (type) => (this.#split && MARKED.has(type) ? { half: 'kokoro', ...(type === 'error' && this.#works() ? { aside: true } : {}) } : {}),
        logged: async (e, r) => {
          if (e.type === 'note' && e.data?.why === 'stopped') this.#stopped.seq = e.seq;
          if (this.#split) await this.koe.observe(e, r);
        },
        gate: (call) => this.#gate(call),
        failed: (why, e) => this.#down('kokoro', why, e) ?? this.#kokoroFailed(why, e),
        calling: () => {
          this.#nothingTold = false;
          this.#unseen = 0; // it reads every line so far
        },
        ended: (t) => this.#kokoroEnded(t),
        hushed: () => this.live.voiced,
        hold: (wakes) => this.#hold(wakes),
      },
    });
    this.koe = new Agent({
      ...c,
      half: {
        name: 'koe', tag: KOE_TAG, role: KOE_CLASSIC, registryTools: false, logVoice: false, housekeeping: false, listenLast: true, nonce: this.nonce, serial, ready,
        voice: () => this.koeState === 'text',
        system: (s) => koeSystem(s),
        tail: (now) => this.#koeTail(now),
        sendable: (messages) => this.#koeSendable(messages),
        mark: (type) => (type === 'msg.user' ? { split: true } : MARKED.has(type) ? { half: 'koe' } : {}),
        // After a restart Kokoro takes up what is owed, and tells Koe; Koe's open calls are answered quietly.
        restart: async () => {
          await this.kokoro.opening.catch(() => {});
          return !this.kokoro.owed && this.koeState !== 'live';
        },
        logged: (e, r) => this.#koeLogged(e, r),
        replied: (names) => { this.#asking = names.includes('tell_kokoro'); },
        // A call that saw "Kokoro was stopped": what Koe asks from now on, it asks knowing.
        calling: (context) => { if (context && context.to >= this.#stopped.seq) this.#stopped.on = false; },
        hold: () => 0, // Koe answers at once (GATHER)
        failed: (why, e) => {
          const both = this.#down('koe', why, e);
          return this.#koeFailed() && (both ?? true);
        },
        ended: (t) => {
          if (this.#koeLater) this.#route(() => this.#refresh());
          if (!t.ok) return;
          this.#unsaid = [];
          this.#up('koe');
        },
        unsaid: (notes) => this.#backstop(notes),
      },
    });
    this.kokoro.addLoopTools([channelTool('kokoro', this.channel, () => (this.#works() ? null : "Koe can't speak right now: talk to the user yourself, with speak, show and ask."))]);
    // Koe's quick tools are Shiori's own, by name: Kokoro's (timers, recall), else the plugins'.
    const find = (/** @type {string} */ name) => this.kokoro.loopTools().find((t) => t.name === name) ?? c.registry.entries('tool').find((e) => e.item?.name === name)?.item;
    this.koe.addLoopTools([...koeTools({ find, ws: c.ws }), channelTool('koe', this.channel, () => (this.#stopHeld ? STOP_HELD : null)), ALREADY_TOLD]);
    for (const a of [this.kokoro, this.koe]) {
      a.on('event', (x) => this.#emit('event', x));
      a.on('notice', (n) => this.#notice(n));
      a.on('clear', (key) => this.#emit('clear', key));
      a.on('state', (s) => this.#stateOf(a, s));
    }
    this.kokoro.on('open', (x) => this.#emit('open', x));
    // Koe live (K5): its sessions log as Koe, and only Halves opens and closes them.
    this.live = new LiveKoe({
      koe: this.koe, llm: c.llm, voice: c.voice ?? null, store: c.store, nonce: this.nonce,
      model: () => this.#liveId,
      setup: () => this.#liveSetup(),
      visible: () => this.#visible(),
      release: () => { this.kokoro.release(); this.koe.release(); },
      notice: (n) => this.#notice(n),
      told: (state) => this.#block(state),
      dropped: (cut) => this.#dropped(cut),
      changed: () => this.#liveChanged(),
      budgets: async () => (await this.kokoro.settings()).budgets,
      timeZone: () => this.kokoro.timeZone(), secondMs: c.secondMs,
      asked: () => this.#asked && this.kokoro.busy, ws: c.ws,
      unsaid: (notes) => { this.#route(() => this.#backstop(notes)); },
      owed: (notes) => this.#handOn(notes),
      spoke: () => this.#retold(),
      // Kokoro's words for the user that a switch left unsaid: shown in the conversation left, not aloud (Koe is in another now).
      left: (notes) => {
        const list = notes.filter((w) => w.forUser).map((w) => ({ watch: '', text: capped(forUserText(String(w.forUser)), CAPS.text), title: "Shiori's answer" }));
        if (list.length) this.kokoro.remind(list, this.kokoro.target ?? ME, { unsaid: true, silent: true }).catch(() => {});
      },
    });
    this.voice?.onChange((_, first) => { if (!first) this.#route(() => this.#refresh()); });
    // A change to the models, Koe's lists or its mode (Settings → Models, the voice chip) applies at once, not at the next voice change.
    // Writes that come together (a provider saved with its models) make one refresh, which reads them all.
    this.ws.onChange((/** @type {{ scope: string, path: string }} */ x) => {
      if (x.scope !== SYS_SETTINGS || !/^\/llm\/(roles\.json$|models\/|providers\/)/.test(x.path) || this.#llmChanged) return;
      this.#llmChanged = true;
      this.#route(async () => {
        await new Promise((r) => setTimeout(r, 0)); // the rest of the writes' changes come in meanwhile
        this.#llmChanged = false;
        await this.#refresh();
      });
    });
    this.#ready = this.#refresh({ tell: false }).catch(() => {});
  }

  get store() { return this.kokoro.store; }
  get ws() { return this.kokoro.ws; }
  get llm() { return this.kokoro.llm; }
  get registry() { return this.kokoro.registry; }
  get voice() { return this.kokoro.voice; }
  get now() { return this.kokoro.now; }
  get get() { return this.kokoro.get; }
  get scope() { return this.kokoro.scope; }
  get trip() { return this.kokoro.trip; }
  get target() { return this.kokoro.target; }
  get transcript() { return this.kokoro.transcript; }
  get opening() { return Promise.all([this.kokoro.opening, this.koe.opening]).then(() => {}); }
  /** The half that talks with the user now. */
  get talking() { return this.koeState === 'text' ? this.koe : this.kokoro; }
  get state() { return this.koeState === 'live' ? this.live.view : this.talking.state; }
  /** The dock's sign: never for a turn still stopping in the conversation being left. */
  get kokoroWorking() { return this.#works() && this.kokoro.busy && !this.kokoro.switching; }
  #visible() { return globalThis.document?.visibilityState !== 'hidden'; }
  /** Koe talks with the user: through the loop, or live. */
  #works() { return this.koeState === 'text' || this.koeState === 'live'; }
  get busy() { return this.#routes > 0 || this.#sending.size > 0 || this.kokoro.busy || this.koe.busy || this.live.busy; }
  /** @param {(() => { place?: string, activity?: string }) | null} fn */
  set sense(fn) { this.kokoro.sense = fn; this.koe.sense = fn; }
  get sense() { return this.kokoro.sense; }

  /** Koe's way, for the voice chip: the mode chosen, the list Koe runs on, and why Classic stands in for Realtime. */
  get way() { return this.#way; }

  /** The voice chip's switch: Koe · Realtime or Koe · Classic, kept with the lists; it applies at once. @param {import('../llm/config.js').KoeMode} mode */
  async chooseKoe(mode) {
    await saveKoeMode(this.ws, mode);
    await this.#route(() => this.#refresh());
  }

  /** Whether Shiori is two halves: Koe's list in use holds a model (koeWay). */
  async split() {
    await this.#refresh();
    return this.#split;
  }

  /** @param {'state' | 'event' | 'notice' | 'open' | 'halves' | 'clear'} kind @param {(x: any) => void} fn */
  on(kind, fn) {
    this.#on[kind].add(fn);
    return () => this.#on[kind].delete(fn);
  }

  /** @param {string} kind @param {any} x */
  #emit(kind, x) {
    for (const fn of this.#on[kind]) {
      try {
        fn(x);
      } catch (e) {
        console.warn('a listener failed', e);
      }
    }
  }

  /** A card, once: both halves stopped by one budget say it once. @param {any} n */
  #notice(n) {
    const key = `${n.title}\n${n.body}`;
    if (this.#lastCard.key === key && Date.now() - this.#lastCard.at < 5000) return;
    this.#lastCard = { key, at: Date.now() };
    this.#emit('notice', n);
  }

  /** @param {Agent} half @param {any} s */
  #stateOf(half, s) {
    if (half === this.koe) this.kokoro.poke(); // the user speaking to Koe holds Kokoro
    if (half === this.talking && this.koeState !== 'live') this.#emit('state', s);
    if (half === this.kokoro) this.#emitHalves();
    // Koe waits on a Kokoro with nothing to do: nothing to add (the wait is set up right after its state).
    if (half === this.koe && (s.name === 'waiting' || s.name === 'listening')) queueMicrotask(() => { if (this.koe.waiting && !this.kokoro.busy && this.koeState === 'text') this.#nothingToAdd(); });
  }

  /** The sign, and the chip's "Listening live" (a session's microphone is open) and Koe's way (which list talks, and why). */
  #emitHalves() {
    const w = this.#way;
    const now = { koe: this.koeState, kokoroWorking: this.kokoroWorking, live: this.live.listening ? 'listening' : this.live.state === 'open' ? 'open' : null,
      way: w ? { mode: w.mode, using: w.using, why: w.why, koe: w.koe, split: w.split, path: this.koeState === 'down' ? null : w.path?.kind ?? null } : null };
    const key = JSON.stringify(now);
    if (key === this.#lastHalves) return;
    this.#lastHalves = key;
    this.#emit('halves', now);
  }

  /** A live session's state changed: the dock's, and the chip's. */
  #liveChanged() {
    this.kokoro.poke(); // the user speaking into it holds Kokoro
    const name = this.live.view.name;
    if (this.koeState === 'live' && name !== this.#lastView) this.#emit('state', this.live.view);
    this.#lastView = name;
    this.#emitHalves();
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #serial(fn) {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  /** @param {() => unknown} fn @param {(e: unknown) => unknown} [failed] */
  #route(fn, failed = (e) => console.warn('routing failed', e)) {
    this.#routes++;
    this.#routing = this.#routing.then(fn).catch(failed).finally(() => { this.#routes--; });
    return this.#routing;
  }

  /** Koe's state from the settings, the voice and Koe's rest; Kokoro is told when it changed. @param {{ tell?: boolean }} [o] */
  async #refresh({ tell = true } = {}) {
    await this.voice?.refresh().catch(() => {}); // Auto follows the car's audio: read now
    await this.llm.ready; // a realtime model needs its protocol running
    const cfg = await this.llm.config();
    const voiceOn = Boolean(this.voice?.on);
    const until = (/** @type {string} */ id) => this.llm.bench?.until(id) ?? 0;
    const way = koeWay(cfg, { voiceOn, types: this.llm.types?.() ?? new Map(), until, now: Date.now() });
    this.#way = way;
    this.#split = way.split;
    // One voice at a time: a Classic turn going (speaking, listening, waiting) ends whole before Realtime takes over (S1).
    this.#koeLater = way.path?.kind === 'live' && this.koeState === 'text' && (this.koe.turning || this.koe.voicing);
    const path = this.#koeLater ? { kind: /** @type {const} */ ('text') } : way.path;
    // The chosen Realtime resting: it is used again once a model of its list can answer.
    this.#stopBack();
    const back = way.why === 'resting' ? Math.min(...(cfg.roles[KOE_REALTIME]?.models ?? []).map(until).filter((t) => t > Date.now())) : Infinity;
    if (Number.isFinite(back)) {
      this.#back = setTimeout(() => { this.#back = undefined; this.#route(() => this.#refresh()); }, back - Date.now() + 50);
      /** @type {any} */ (this.#back).unref?.();
    }
    // A text Koe whose list failed whole rests a while.
    const resting = path?.kind === 'text' && this.clock() < this.#downUntil;
    /** @type {Told} */
    let told = resting || !path ? 'koe-down' : 'koe-up';
    // One voice at a time: Kokoro keeps it to the end of a turn that has it, then Koe takes over (#kokoroEnded asks again).
    this.#later = told === 'koe-up' && this.koeState === 'down' && this.kokoro.voicing;
    if (this.#later) told = 'koe-down';
    const was = this.state.name;
    this.koeState = !this.#split ? 'off' : told === 'koe-down' ? 'down' : path?.kind === 'live' ? 'live' : 'text';
    this.#liveId = path?.kind === 'live' && this.koeState === 'live' ? path.modelId : null;
    // A live session closes when voice goes off, or Koe's pathway leaves its model: its microphone never stays open otherwise.
    const model = this.live.modelId;
    const voiceOff = this.#voiceWas && !voiceOn;
    // One closed with Kokoro's notes waiting for the page lets go of them too (they are handed on).
    // Auto turning voice off (AirPods out) lets Koe's sentence end whole; the user's Off, or another pathway, closes at once.
    if ((this.live.state !== 'closed' || this.live.owing) && (!this.#liveId || (model && model !== this.#liveId) || voiceOff)) {
      if (voiceOff && this.voice?.mode.setting === 'auto') this.live.closeSoon('voice off');
      else this.live.close(voiceOff ? 'voice off' : 'pathway');
    }
    else if (voiceOn) this.live.unmute();
    this.#voiceWas = voiceOn;
    if (this.state.name !== was) this.#emit('state', this.state);
    if (this.#split && tell) await this.#tell(told);
    this.#emitHalves();
  }

  /** Kokoro's block, when its state differs from what it was told last in this conversation. @param {Told} state */
  async #tell(state) {
    await this.kokoro.opening.catch(() => {});
    const scope = this.kokoro.scope;
    if (this.#told.scope !== scope) {
      const last = (await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['halves'], reverse: true, limit: 200 }))).find((e) => /^koe-/.test(e.data?.state));
      this.#told = { scope, state: last?.data?.state ?? 'koe-up' };
    }
    if (this.#told.state === state) return;
    this.#told = { scope, state };
    const unsaid = state !== 'koe-up' && this.#unsaid.splice(0).length ? " What you last told Koe didn't reach the user." : '';
    await this.kokoro.log({ type: 'halves', actor: 'system', data: { state }, texts: [['text', `${BLOCKS[state]}${unsaid}`]] });
  }

  /** One of Kokoro's instruction blocks: a live session opened, closed or dropped (Review Focus 2: messages, never its system text or tools). @param {Block} state */
  #block(state) {
    this.kokoro.log({ type: 'halves', actor: 'system', data: { state }, texts: [['text', BLOCKS[state]]] }).catch(() => {});
  }

  /**
   * A live session's part (a message, a wake, a note) once Koe has the conversation open. When no session can open, Koe's
   * next model takes it; with none left, a card says so, and Kokoro talks directly at once, told so (with what it last told
   * Koe that didn't reach the user), the wake's reminders said by annai only if it can't (review); a session that closed
   * meanwhile leaves them to annai. @param {() => Promise<boolean>} fn @param {Wake} w
   */
  async #live(fn, w) {
    await this.koe.opening.catch(() => {});
    if (await fn()) return;
    await this.#refresh();
    if (this.koeState === 'text') return this.koe.enqueue(w);
    if (this.koeState !== 'down') {
      // No session could take Kokoro's note for the user, and Koe stays live (today's spend reached): annai shows it.
      if (isForUser(w)) await this.#backstop([w]);
      return void (w.fallbacks?.length && this.kokoro.remind(w.fallbacks));
    }
    this.#notice({ tone: 'warn', title: "Koe's live voice couldn't start", body: 'Shiori answers you directly for now. The Trace (Models) says why; Koe tries again in a few minutes.' });
    this.#talkDirectly(w.fallbacks);
  }

  /**
   * Kokoro's notes for the user a live session closed on before Koe passed them on (L1: a close, a drop it didn't come back from,
   * Koe moving to text): the text Koe owes them as its own (§6.8); while Koe stays live with no session, or is down, annai shows them.
   * @param {Wake[]} notes
   */
  #handOn(notes) {
    this.#route(async () => {
      await this.#refresh();
      if (this.koeState === 'text') for (const w of notes) this.koe.enqueue(w);
      else await this.#backstop(notes);
    });
  }

  /**
   * A live session dropped and couldn't resume (plan Task 7): its model rests, Kokoro is told, and when Koe was cut off
   * mid-sentence, its next model finishes the answer (through the speech pipeline), or Kokoro does while Koe is down.
   * @param {boolean} cut
   */
  #dropped(cut) {
    if (this.#liveId) this.llm.bench?.bench(this.#liveId, COOLDOWN_MS);
    this.#block('live-dropped');
    this.#route(async () => {
      await this.#refresh();
      if (!cut) return;
      if (this.koeState === 'text') this.koe.enqueue({ kind: 'cue', text: 'the live session dropped while you were answering; finish briefly' });
      else if (this.koeState === 'down') this.#talkDirectly();
    });
  }

  /** A live session's setup: Koe's live instructions and Shiori's personality; the conversation's last lines, the now block and the trip's view. */
  async #liveSetup() {
    const s = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.koe.trip, personalityName: (await this.kokoro.settings()).personality, locale: this.voice?.locale });
    const { place, activity } = this.sense?.() ?? {};
    const voice = this.voice?.on ? 'on: you speak aloud in this live session' : 'off: what you say shows as text';
    const tail = await this.#koeTail({ now: this.koe.now(), timeZone: this.koe.timeZone(), voice, online: this.koe.online(), reasons: ['a live session opened'], place, activity });
    // The protocol's own language fields (Gemini Live's transcription hints, OpenAI's transcription language) get the setting; the words are in the instructions.
    const languages = languageSettings(await readAppSettings(this.ws), this.voice?.locale);
    return { instructions: koeSystem(s, true), context: [await this.#recent(), tail].filter(Boolean).join('\n'), languages: modelLanguages(languages), known: languages };
  }

  /** The conversation's last 12 lines, for a live session that starts without a handle: annai's labels, every word quoted and escaped. */
  async #recent() {
    const events = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.koe.scope, { types: [...LINES, 'heard.text'], reverse: true, limit: 40 }));
    /** @type {Map<string, string>} */
    const later = new Map();
    /** @type {string[]} */
    const lines = [];
    for (const e of events) {
      const d = { ...e.data, ...(await storedTexts(this.store, e)) };
      if (e.type === 'heard.text') later.set(d.of, later.get(d.of) ?? d.text);
      const text = e.type === 'heard' ? later.get(d.id) ?? d.text : e.type === 'out.show' ? cardText(d.card) : e.type === 'out.ask' ? d.question : d.text;
      if (e.type === 'heard.text' || !text || d.dismissed || lines.length >= 12) continue;
      const who = e.type === 'msg.user' ? 'the user typed' : e.type === 'heard' ? 'heard' : d.half === 'koe' ? 'you said' : 'said to the user';
      lines.unshift(`[${who}] ${escapeTags(quote(text))}`);
    }
    return lines.length ? `The conversation so far:\n${lines.join('\n')}` : '';
  }

  #koeOpen() {
    if (this.#koeTrip === this.kokoro.target) return;
    this.#koeTrip = this.kokoro.target;
    this.koe.open(this.kokoro.target).catch((e) => console.warn('Koe could not open the conversation', e));
  }

  /** A Koe with a conversation open follows at once, so neither half writes into one being left. @param {string | null} trip @param {{ quiet?: boolean }} [o] */
  open(trip, o) {
    this.#stopped = { on: false, seq: Infinity }; // a Stop belongs to the conversation it was in
    this.#stopHeld = false;
    if (trip !== this.kokoro.target) {
      this.live.close('switch', { forget: true });
      this.#retell = [];
      // Realtime coming back is worked out again in the conversation opened.
      if (this.#back !== undefined) {
        this.#stopBack();
        this.#route(() => this.#refresh());
      }
    }
    const opening = this.kokoro.open(trip, o);
    this.#emitHalves(); // the left one's turn isn't this one's sign
    opening.finally(() => this.#emitHalves()).catch(() => {});
    if (this.#koeTrip !== undefined) {
      this.#koeTrip = trip;
      return Promise.all([opening, this.koe.open(trip, o)]).then(() => {});
    }
    this.#route(async () => {
      await this.#refresh();
      await opening.catch(() => {}); // Koe opens once Kokoro knows what is owed
      if (this.#split) this.#koeOpen();
    });
    return opening;
  }

  /**
   * To Koe while it talks (Kokoro reads it and wakes), else to Kokoro; a half waiting for an answer gets it.
   * @param {string} text @param {{ photos?: import('./loop.js').SentPhoto[], chose?: boolean }} [o] chose: a tap on a live ask's buttons
   */
  send(text, o = {}) {
    this.#bothTold = false;
    this.#stopped.on = this.#stopHeld = false;
    this.#heardNow(Boolean(o.photos?.length) && !String(text ?? '').trim());
    this.#route(async () => {
      await this.#refresh();
      if (!this.#works() || this.kokoro.pendingId) return this.kokoro.send(text, o);
      this.#koeOpen();
      if (this.koeState === 'live') return this.#live(() => this.live.send(text, o), { kind: 'user', text, logged: true });
      this.koe.send(text, o);
    }, (e) => {
      this.kokoro.send(text, o); // never dropped
      this.#notice({ tone: 'warn', title: 'Shiori answers as one half for now', body: `annai couldn't pass your message to Koe: ${String(/** @type {any} */ (e)?.message ?? e)}` });
    });
  }

  /** @param {string} callId @param {string} option */
  answer(callId, option) {
    if (this.koe.pendingId === callId) return this.koe.answer(callId, option);
    if (this.kokoro.pendingId === callId) return this.kokoro.answer(callId, option);
    this.send(option, { chose: true });
  }

  /** Both halves get it while Koe talks, budgets checked once, its reminders with Koe (plan decision 16); asked to hear her, Koe alone. @param {Wake} w @returns {Promise<void>} */
  wake(w) {
    if (w.scope && w.scope !== (this.kokoro.target ?? ME)) return this.kokoro.wake(w);
    this.#route(async () => {
      await this.#refresh();
      if (!this.#works() || KOKORO_ONLY.includes(w.kind)) return void (await this.kokoro.wake(w));
      if (!w.aloud && !THEIRS.includes(w.kind) && !(await this.kokoro.admit(w, (x) => this.wake(x)))) return;
      this.#koeOpen();
      // Asked to hear her (the recap told aloud): the half with the voice tells it.
      if (!w.aloud) this.#wakeKokoro({ ...w, fallbacks: [] });
      // From a page out of view, a session waits for it; its reminders show now, as annai's always do (review).
      if (this.koeState === 'live' && !this.#visible() && w.fallbacks?.length) this.kokoro.remind(w.fallbacks);
      if (this.koeState === 'live') await this.#live(() => this.live.wake(w), w);
      else this.koe.enqueue(w);
    });
    return Promise.resolve();
  }

  /** The half that talks (its tap unlocks sound, an iPhone rule); a live Koe's session. */
  tap() {
    if (this.koeState !== 'live') return this.talking.tap();
    this.voice?.unlock();
    this.#koeOpen();
    return this.live.tap();
  }

  /** The user's Try again: the half that talks answers their last message; a Stop holds no more, as when they write again. */
  tryAgain() {
    this.#stopped.on = this.#stopHeld = false;
    this.talking.tryAgain();
  }

  interrupt() {
    if (this.koeState === 'live') this.live.interrupt();
    else this.talking.interrupt();
  }

  /**
   * The page went (hidden, or left), or everything is being erased: a live session closes now, its microphone with it.
   * Erase forgets its handle too. @param {'away' | 'erase'} why
   */
  hush(why) {
    this.#backAway ||= this.#back !== undefined && why === 'away';
    this.#stopBack();
    this.live.close(why, { forget: why === 'erase' });
    if (why === 'erase') {
      for (const a of [this.kokoro, this.koe]) a.forgetTold();
      this.#retell = [];
    }
    this.typing(false); // the page went: nobody types into it (review A3)
  }

  /** The page is back in view: what waited for it is said; the microphone opens only at a tap. */
  shown() {
    if (this.koeState === 'live') this.#route(() => this.live.shown());
    // The page went while the chosen Realtime rested: ask again now.
    if (this.#backAway) {
      this.#backAway = false;
      this.#route(() => this.#refresh());
    }
  }

  /** The refresh for Realtime coming back is let go (a refresh sets it again, the page back asks again). */
  #stopBack() {
    clearTimeout(this.#back);
    this.#back = undefined;
  }
  /** The typing box holds text, or not: Kokoro waits while the user types (GATHER). @param {boolean} on */
  typing(on) {
    this.kokoro.typing(on);
  }

  /** The camera's photo is being made, or is ready (the dock's hook): Kokoro waits for it (GATHER). @param {boolean} on */
  photoComing(on) {
    this.kokoro.photoComing(on);
  }

  /** The user typed, sent or said something now. @param {boolean} photo a photo on its own */
  #heardNow(photo) {
    this.#input = { at: Date.now(), photo };
    this.kokoro.poke();
  }

  /**
   * How long Kokoro's turn waits for the user (GATHER): behind Koe, until their input is quiet and they neither type nor speak;
   * with Koe down or off, as one Shiori. @param {Wake[]} wakes @returns {number} ms; Infinity: until something changes
   */
  #hold(wakes) {
    const speaking = this.kokoro.speakingNow || this.koe.speakingNow || this.live.view.name === 'hearing';
    const typing = this.kokoro.typingNow || this.kokoro.photoNow;
    if (!this.#works()) return wakes.some(isTheirs) && (typing || speaking) ? Infinity : 0;
    // Only what comes from the user's input gathers: their messages, and Koe's questions and answers about them (review A3).
    if (!wakes.some((w) => isTheirs(w) || (w.kind === 'note' && w.from === 'koe') || w.input)) return 0;
    if (typing || speaking) return Infinity;
    return Math.max(0, this.#input.at + (this.#input.photo ? GATHER.photo : GATHER.quiet) * this.secondMs - Date.now());
  }

  /**
   * The sign's Stop: Kokoro's turn alone (spec §16.2), and what Koe asked of it meanwhile; Koe's notes start no new turn until Koe
   * has heard of the Stop or the user asks again (emulator pass K1 #8: a live Koe's late question started the plan over).
   */
  stopKokoro() {
    this.#stopped = { on: true, seq: Infinity };
    this.#stopHeld = true;
    this.#cue = this.#owed = false; // what was heard before it wakes Kokoro no more, answered or not
    // Still gathering the user's messages (GATHER): its turn never starts, and a waiting Koe hears so.
    const started = this.kokoro.turning;
    const scope = this.kokoro.target ?? ME;
    this.kokoro.drop((w) => (w.kind === 'note' && w.from === 'koe') || (!started && w.scope === scope));
    this.kokoro.poke();
    this.kokoro.interrupt();
    // Koe hears of it, waiting or not (review a1): once its model has seen this, its questions reach Kokoro again.
    this.#nothingTold = false;
    this.#nothingToAdd('Kokoro was stopped.', 'stopped');
  }

  async idle() {
    do {
      await this.#routing;
      await Promise.all(this.#sending);
      await this.kokoro.idle();
      await this.koe.idle();
      await this.live.idle();
    } while (this.busy);
  }

  /** @param {boolean} [yes] */
  leaving(yes = true) {
    this.kokoro.leaving(yes);
    this.koe.leaving(yes);
  }

  /** @param {Parameters<Agent['useClock']>[0]} c */
  useClock(c) {
    const a = this.kokoro.useClock(c);
    const b = this.koe.useClock(c);
    return () => { a(); b(); };
  }

  settings() { return this.kokoro.settings(); }
  /** @param {any} n */
  notify(n) { return this.kokoro.notify(n); }
  /** @param {any} ev */
  log(ev) { return this.kokoro.log(ev); }
  /** @param {string | null} detail */
  working(detail) { this.kokoro.working(detail); }
  cacheState() { return this.kokoro.cacheState(); }
  /** Kokoro's notes held for the user's next words go to Koe again, as appends. */
  #retold() {
    for (const w of this.#retell.splice(0)) this.channel.deliver.koe({ ...w, retold: true, mode: 'append' });
  }

  /** For Settings → Tools: tell_koe only while Shiori is two halves. */
  loopTools() { return this.kokoro.loopTools().filter((t) => this.#split || t.name !== 'tell_koe'); }
  /** @param {import('./loop.js').LoopTool[]} tools Shiori's own, which are Kokoro's */
  addLoopTools(tools) { this.kokoro.addLoopTools(tools); }
  /** @param {import('./loop.js').Reminder[]} list @param {string} [scope] */
  remind(list, scope) { return this.kokoro.remind(list, scope); }

  /** The now block, the trip's view, and the nonce (never in Koe's cached prefix). @param {Parameters<NonNullable<import('./loop.js').Half['tail']>>[0]} now */
  async #koeTail(now) {
    const block = nowBlock({ ...now, plan: null, reasons: now.reasons.map(escapeTags), place: escapeTags(now.place ?? 'unknown'), activity: escapeTags(now.activity ?? 'unknown') });
    // Live mode's reminders wait for its own work: Koe never waits long on them.
    const next = this.next ? await Promise.race([this.next().catch(() => null), new Promise((r) => { setTimeout(() => r(null), 150); })]) : null;
    const view = await compactView({ ws: this.ws, trip: this.koe.trip, now: now.now, timeZone: now.timeZone, next: /** @type {any} */ (next) });
    return `${block}\n${view}\nKokoro's notes carry id="${this.nonce}".`;
  }

  /** A photo reaches a text Koe only when every chat model of its list takes photos (plan decision 22). @param {import('../llm/contract.js').Message[]} messages */
  async #koeSendable(messages) {
    const cfg = await this.llm.config();
    if (chatCandidates(cfg, KOE_CLASSIC).every((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes('image'))) return messages;
    return messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'image' ? { type: /** @type {const} */ ('text'), text: '[a photo; Kokoro sees it]' } : p)) }));
  }

  /** The user is watching Koe's turn (or its live session) that is answering now. */
  #koeWatched() { return this.koeState === 'live' ? this.live.watched : this.koe.watched; }

  /** Its next call reads every line so far. @param {Wake} w */
  #wakeKokoro(w) {
    this.#cue = this.#owed = false;
    this.#unseen = 0;
    this.kokoro.enqueue(w);
    this.#emitHalves(); // the sign, while it still gathers the user's messages too
  }

  /**
   * Kokoro hears all and wakes on cue (the design): what the user typed, or sent; Koe answering what was
   * heard (chatter wakes nobody); and a review once 3 minutes of conversation have gone by unread.
   * @param {any} e @param {import('./loop.js').Resolved} r
   */
  async #koeLogged(e, r) {
    await this.kokoro.observe(e, r);
    const typed = e.type === 'msg.user' && e.data?.split;
    if (e.type.startsWith('out.')) this.#unsaid = []; // Koe reached the user: what it was told is passed on
    if (e.type === 'heard' && !e.data?.dismissed) this.#heardNow(false);
    // The user's next words: Kokoro's notes Koe left unsaid go to Koe again, with them (live, as their turn ends: spoke); Koe
    // reaching the user meanwhile has passed them on.
    if (e.type.startsWith('out.')) this.#retell = [];
    if (typed || (e.type === 'heard' && !e.data?.dismissed && this.koeState !== 'live')) this.#retold();
    if (typed || (e.type === 'heard' && !e.data?.dismissed)) {
      this.#answered = false;
      this.#failTold = false;
      this.#bothTold = false;
      this.#stopped.on = this.#stopHeld = false;
    }
    if (e.type.startsWith('out.')) this.#up('koe'); // a live Koe that spoke works
    // A reply that asks Kokoro wakes it with the question, not the answer before it; with the answer, if the question fails
    // (refused while the user's Stop holds, it didn't fail: the user stopped Kokoro).
    const out = e.type.startsWith('out.') && this.#cue;
    const failed = e.type === 'tool.result' && e.data?.name === 'tell_kokoro' && e.data.ok === false && this.#owed && !this.#stopHeld;
    if (e.type === 'tool.result' && e.data?.name === 'tell_kokoro') this.#asking = false;
    const answered = (out && !(this.#owed = this.#asking)) || failed;
    if (typed) this.#wakeKokoro({ kind: 'user', text: String(r.texts.text ?? e.data.text ?? ''), logged: true });
    else if (answered) this.#wakeKokoro({ kind: 'cue', text: 'Koe answered the user', logged: true, input: true, watched: this.#koeWatched() });
    else if (e.type === 'heard') this.#cue ||= !e.data?.dismissed;
    if (typed || answered || !LINES.includes(e.type) || !this.#works()) return;
    const now = this.clock();
    if (!this.#unseen) this.#unseen = now;
    else if (now - this.#unseen >= REVIEW_MS) this.#wakeKokoro({ kind: 'cue', text: REVIEW, logged: true });
  }

  /** Kokoro's speak, show and ask while Koe talks become notes to Koe; its wait is answered (plan decision 15). @param {{ id: string, name: string, input: any, wake: string }} call */
  async #gate({ name, input, wake }) {
    if (!this.#works()) return null;
    if (name === 'wait') return { content: "Koe is talking with the user; what they say reaches you. Call sleep when you're done." };
    const text = name === 'speak' ? String(input?.text ?? '')
      : name === 'show' ? `Kokoro wants to show: ${cardText(input?.card)}`
        : name === 'ask' ? `Kokoro wants to ask: ${String(input?.question ?? '')} (${(Array.isArray(input?.options) ? input.options : []).join(', ')})` : null;
    if (text === null) return null;
    await this.channel.send('kokoro', text, 'append', /** @type {any} */ (`gated:${name}`), wake, { name, input });
    return { content: 'Koe is speaking for you; use tell_koe.', told: true };
  }

  /**
   * Kokoro's notes for the user that Koe never passed on, asked once more (spec §6.8): annai shows what Kokoro meant the user to
   * have, a note's words for them (tell_koe's for_user) or a gated speak as "Shiori's answer", a gated card or question as itself,
   * checked as show and ask check Shiori's own (a tap on its buttons comes to Koe as the user's choice); one they would refuse, as
   * its words, or with none only a Trace line, never a card that says nothing. A note's own text is for Koe, never shown or said:
   * with no for_user, it goes to Koe once more with the user's next words, then only the Trace has it. "Kokoro couldn't check" and a final text were words for Koe: it
   * was asked once more, and that is all (plan decision 21: no card). @param {Wake[]} notes
   */
  async #backstop(notes) {
    this.#unsaid = [];
    for (const w of notes) {
      const i = w.call?.input ?? {};
      const card = w.why === 'gated:show' ? checkCard(i.card, this.registry) : null;
      const ask = w.why === 'gated:ask' ? checkAsk(i) : null;
      if (card && !('error' in card)) await this.kokoro.log({ type: 'out.show', actor: 'shiori', data: { id: newId('c'), card: card.card } });
      else if (ask && !('error' in ask)) await this.kokoro.log({ type: 'out.ask', actor: 'shiori', data: { id: newId('c'), question: ask.question, options: ask.options } });
      else if (card || ask) {
        // Too broken to show: its words instead, as long as a card's text at most; with none, only the Trace has it.
        const said = card ? [i.card?.title, i.card?.text].filter((x) => typeof x === 'string' && x.trim()).join(': ')
          : typeof i.question === 'string' && i.question.trim() ? `${i.question}${Array.isArray(i.options) && i.options.length ? ` (${i.options.map(String).join(', ')})` : ''}` : '';
        if (said) await this.kokoro.remind([{ watch: '', text: capped(said, CAPS.text), title: "Shiori's answer" }], undefined, { unsaid: true });
        else await this.kokoro.log({ type: 'error', actor: 'system', data: { kind: 'unshown', message: `Kokoro's ${card ? 'card' : 'question'} wasn't shown: annai couldn't show it, and it had no words to give instead.`, quiet: true } });
      } else if (forUserText(w.forUser || (w.why === 'gated:speak' ? w.note : ''))) await this.kokoro.remind([{ watch: '', text: capped(forUserText(w.forUser || w.note), CAPS.text), title: "Shiori's answer" }], undefined, { unsaid: true });
      else if (w.why === 'gated:speak') await this.kokoro.log({ type: 'error', actor: 'system', data: { kind: 'unshown', message: "Kokoro's speak wasn't shown: it had no words.", quiet: true } });
      else if (w.why === 'tool' && !w.retold) this.#retell.push(w);
      else if (w.why === 'tool') await this.kokoro.log({ type: 'error', actor: 'system', data: { kind: 'unshown', message: "Kokoro's note wasn't passed on: Koe didn't say it, twice, and it had no words for the user (for_user).", quiet: true } });
    }
  }

  /**
   * A half's list failed (emulator pass: both halves failed, each quietly, and the user heard nothing). When the other is down
   * too, the card says why for each, once: its words, for the loop's card and error (Half.failed); true, said already; null:
   * the half's own rule. @param {'koe' | 'kokoro'} side @param {string} why @param {unknown} e @returns {string | true | null}
   */
  #down(side, why, e) {
    if (!this.#split) return null;
    const resting = e instanceof AllFailedError && e.attempts.every((a) => a.outcome === 'benched');
    if (!resting || !this.#lost[side]) this.#lost[side] = why;
    if (!this.#lost.koe || !this.#lost.kokoro) return null;
    if (this.#bothTold) return true;
    this.#bothTold = true;
    const lines = (/** @type {string} */ name, /** @type {string} */ text) => text.split('\n').map((l) => `${name}: ${l}`);
    return [...lines('Koe', this.#lost.koe), ...lines('Kokoro', this.#lost.kokoro)].join('\n');
  }

  /** A half works again. @param {'koe' | 'kokoro'} side */
  #up(side) {
    this.#lost[side] = '';
    this.#bothTold = false;
  }

  /**
   * Koe tells the user Kokoro couldn't check, once, in plain words; no card (plan decision 21). Only while
   * someone waits for Kokoro (Koe asked it, or waits): a check nobody waited for stays in the Trace. @param {string} why @param {unknown} e
   */
  #kokoroFailed(why, e) {
    if (!this.#works()) return false;
    const attempts = e instanceof AllFailedError ? e.attempts : [];
    const rest = attempts.find((a) => a.error?.startsWith('its daily limit'));
    const kind = attempts.map((a) => a.outcome).find((o) => o !== 'benched' && o !== 'ok');
    // Only resting models: why they rest is the failure before.
    if (rest || kind || !attempts.length) this.#why = rest ? `${rest.name}: ${rest.error}.` : kind ? explain(new ProviderError(/** @type {any} */ (kind), why)) : why;
    if (!this.#failTold && (this.#asked || this.koe.waiting)) {
      this.#failTold = true;
      this.#asked = false;
      this.#note(`Kokoro couldn't check: ${this.#why || 'its models are resting after errors.'} Tell the user you couldn't check, and offer to try again.`, 'kokoro-failed');
    }
    return true;
  }

  /** Koe's list rests; Kokoro is told to talk directly, and wakes to (its notes may not have reached the user). No card. */
  #koeFailed() {
    if (!this.#split) return false;
    this.#downUntil = this.clock() + KOE_REST_MS;
    this.#route(async () => {
      await this.#refresh();
      // Down, Kokoro talks. Gone on to a live model in its list (voice off, its text model resting), Kokoro's answer, gated,
      // reaches the live session as a note: what it told the failed Koe isn't lost.
      this.#talkDirectly();
    });
    return true;
  }

  /**
   * Kokoro wakes to talk to the user directly: once, however many failures ask it to (emulator pass: two near-identical
   * bubbles, one from the turn that saw Koe go down and one from the wake that came meanwhile). @param {import('./loop.js').Reminder[]} [fallbacks]
   */
  #talkDirectly(fallbacks = []) {
    const was = this.kokoro.drop((w) => w.kind === 'halves' && w.text === BLOCKS['koe-down']);
    this.kokoro.enqueue({ kind: 'halves', text: BLOCKS['koe-down'], logged: true, ...(fallbacks.length || was.length ? { fallbacks: [...was.flatMap((w) => w.fallbacks ?? []), ...fallbacks] } : {}) });
  }

  /**
   * Final text goes to Koe (decision 20); a waiting Koe hears there's nothing to add, or that Kokoro
   * was stopped. Once Kokoro has told Koe, Koe's question about the same message takes no turn.
   * @param {TurnEnd} t
   */
  #kokoroEnded(t) {
    if (this.#later) this.#route(() => this.#refresh());
    if (t.ok) {
      this.#why = '';
      this.#up('kokoro');
    }
    // It talked to the user itself (Koe down): a "Koe can't speak" wake that came meanwhile is answered already.
    if (t.spoke) this.kokoro.drop((w) => w.kind === 'halves' && w.text === BLOCKS['koe-down'] && !w.fallbacks?.length);
    if (!this.#works()) return;
    let told = t.told;
    if (t.ok && t.finalText && !t.told && !t.slept) {
      told = true;
      this.#note(t.finalText, 'final-text', t.wakeId);
    } else if (!told && this.koe.waiting) this.#nothingToAdd(...(t.ok && !this.#stopped.on ? [] : /** @type {const} */ (['Kokoro was stopped.', 'stopped'])));
    if (told) {
      this.#answered = true;
      this.#asked = false;
      this.kokoro.drop((w) => w.kind === 'note' && w.from === 'koe');
    }
  }

  /** @param {string} [text] @param {NoteWhy} [why] */
  #nothingToAdd(text = 'Kokoro has nothing to add.', why = /** @type {NoteWhy} */ ('nothing-to-add')) {
    if (this.#nothingTold) return;
    this.#nothingTold = true;
    this.#note(text, why);
  }

  /** A note annai sends Koe from Kokoro, not waited for here; idle() waits for it (the fix pass). @param {string} text @param {NoteWhy} why @param {string} [wake] */
  #note(text, why, wake) {
    const p = this.channel.send('kokoro', text, 'append', why, wake).catch(() => {});
    this.#sending.add(p);
    p.finally(() => this.#sending.delete(p));
  }
}
