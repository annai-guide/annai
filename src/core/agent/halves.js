import { Agent, GATHER, isTheirs } from './loop.js';
import { TALK_TAG, KOE_TAG } from './log.js';
import { asksOrNotes, quote, cardText, escapeTags, newNonce } from './blocks.js';
import { systemText, nowBlock, takeSnapshot } from './context.js';
import { ME, newId } from '../scopes.js';
import { storedTexts } from './log.js';
import { chatCandidates, koePath, splitOn, AllFailedError, COOLDOWN_MS } from '../llm/fallback.js';
import { LiveKoe } from '../koe/live.js';
import { ProviderError, explain } from '../llm/contract.js';
import { KOKORO_PART, koeSystem } from '../koe/instructions.js';
import { koeTools } from '../koe/tools.js';
import { compactView } from '../koe/context.js';
import { modelOf, KOE_ROLE } from '../llm/config.js';

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
/** How long Koe rests after its whole list failed, at least. */
export const KOE_REST_MS = 60_000;
const KOKORO_ONLY = ['personality', 'restart'];
/** The user's own wakes, past the budgets. */
const THEIRS = ['user', 'choice', 'file', 'live'];
/** Kokoro reviews the conversation it hasn't read once this much of it has gone by (plan decision 8). */
export const REVIEW_MS = 180_000;
const REVIEW = "a review: 3 minutes or more of conversation since you last looked. If something heard was meant for Shiori and Koe missed it, or Koe said something wrong, tell Koe; otherwise sleep.";
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
   * @param {Side} from @param {string} text @param {'append' | 'immediate'} mode @param {NoteWhy} why @param {string} [wake] @returns {Promise<'sent'>}
   */
  async send(from, text, mode, why, wake) {
    const to = from === 'koe' ? 'kokoro' : 'koe';
    await this.log[from]({ type: 'note', actor: 'shiori', data: { id: newId('n'), from, mode, why, ...(wake ? { wake } : {}) }, texts: [['text', text]] });
    // The other half's "woke for": Koe never mentions Kokoro, so its says only that a note came.
    this.deliver[to]({ kind: 'note', logged: true, from, note: text, mode, text: from === 'koe' ? `Koe ${asksOrNotes(text)}: ${quote(text.length > 120 ? `${text.slice(0, 120)}…` : text)}` : 'a note from Kokoro' });
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
      : 'Tell Koe, who talks with the user, what to say or know: an answer, or a correction with the fact and its source. Koe says it in its own words. It returns at once. mode immediate cuts Koe off mid-sentence: use it only when something really should be cut off, such as a wrong claim.',
    input: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, mode: { enum: ['append', 'immediate'] } }, required: ['text'] },
    run: async (/** @type {{ text: string, mode?: string }} */ i, /** @type {any} */ call) => {
      const text = String(i.text ?? '').trim();
      const no = text ? refuse() : `Error: ${name} needs the text to pass on.`;
      if (no) return { content: no, isError: true };
      return channel.send(from, text, i.mode === 'immediate' ? 'immediate' : 'append', 'tool', call.wake);
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
  /** @type {string[]} what Kokoro told Koe that Koe hasn't said since */
  #unsaid = [];
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
  #lastHalves = '';
  #lastView = '';
  /** The realtime model of Koe's pathway now, and whether voice was on when it was worked out. @type {string | null} */
  #liveId = null;
  #voiceWas = false;
  #lastCard = { key: '', at: 0 };
  /** The open conversation's next reminder, for Koe's view (set by the app). @type {(() => Promise<{ due: number, text: string } | null>) | null} */
  next = null;
  /** The settings read as annai starts: no turn runs before. @type {Promise<unknown>} */
  #ready;
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set(), open: new Set(), halves: new Set() };

  /** @param {ConstructorParameters<typeof Agent>[0]} c what each half is made with: one voice, the talking half's (plan decision 17) */
  constructor(c) {
    this.nonce = newNonce();
    this.clock = c.now ?? Date.now;
    this.secondMs = c.secondMs ?? 1000;
    this.channel = new Channel({
      log: { koe: (ev) => this.koe.log(ev), kokoro: (ev) => this.kokoro.log(ev) },
      deliver: {
        koe: (w) => {
          if (w.from === 'kokoro') this.#unsaid.push(w.text);
          this.#koeOpen();
          if (this.koeState === 'live') this.#live(() => this.live.note(String(w.note), w.mode === 'immediate' ? 'immediate' : 'append'), w);
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
        name: 'koe', tag: KOE_TAG, role: KOE_ROLE, registryTools: false, logVoice: false, housekeeping: false, listenLast: true, nonce: this.nonce, serial, ready,
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
          if (!t.ok) return;
          this.#unsaid = [];
          this.#up('koe');
        },
      },
    });
    this.kokoro.addLoopTools([channelTool('kokoro', this.channel, () => (this.#works() ? null : "Koe can't speak right now: talk to the user yourself, with speak, show and ask."))]);
    // Koe's quick tools are Shiori's own, by name: Kokoro's (timers, recall), else the plugins'.
    const find = (/** @type {string} */ name) => this.kokoro.loopTools().find((t) => t.name === name) ?? c.registry.entries('tool').find((e) => e.item?.name === name)?.item;
    this.koe.addLoopTools([...koeTools({ find, ws: c.ws }), channelTool('koe', this.channel)]);
    for (const a of [this.kokoro, this.koe]) {
      a.on('event', (x) => this.#emit('event', x));
      a.on('notice', (n) => this.#notice(n));
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
      asked: () => this.#asked && this.kokoro.busy,
    });
    this.voice?.onChange((_, first) => { if (!first) this.#route(() => this.#refresh()); });
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
  /** The dock's sign. */
  get kokoroWorking() { return this.#works() && this.kokoro.busy; }
  #visible() { return globalThis.document?.visibilityState !== 'hidden'; }
  /** Koe talks with the user: through the loop, or live. */
  #works() { return this.koeState === 'text' || this.koeState === 'live'; }
  get busy() { return this.#routes > 0 || this.kokoro.busy || this.koe.busy || this.live.busy; }
  /** @param {(() => { place?: string, activity?: string }) | null} fn */
  set sense(fn) { this.kokoro.sense = fn; this.koe.sense = fn; }
  get sense() { return this.kokoro.sense; }

  /** Whether Shiori is two halves: Koe's list holds a model. */
  async split() {
    await this.#refresh();
    return this.#split;
  }

  /** @param {'state' | 'event' | 'notice' | 'open' | 'halves'} kind @param {(x: any) => void} fn */
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

  /** The sign, and the chip's "Listening live" (a session's microphone is open) or "Live" (a session is open). */
  #emitHalves() {
    const now = { koe: this.koeState, kokoroWorking: this.kokoroWorking, live: this.live.listening ? 'listening' : this.live.state === 'open' ? 'open' : null };
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
    this.#split = splitOn(cfg);
    const voiceOn = Boolean(this.voice?.on);
    const path = koePath(cfg, { voiceOn, types: this.llm.types?.() ?? new Map(), until: (id) => this.llm.bench?.until(id) ?? 0, now: Date.now() });
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
    if (this.live.state !== 'closed' && (!this.#liveId || (model && model !== this.#liveId) || voiceOff)) this.live.close(voiceOff ? 'voice off' : 'pathway');
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
    if (this.koeState !== 'down') return void (w.fallbacks?.length && this.kokoro.remind(w.fallbacks));
    this.#notice({ tone: 'warn', title: "Koe's live voice couldn't start", body: 'Shiori answers you directly for now. The Trace (Models) says why; Koe tries again in a few minutes.' });
    this.#talkDirectly(w.fallbacks);
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
    const s = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.koe.trip, personalityName: (await this.kokoro.settings()).personality });
    const { place, activity } = this.sense?.() ?? {};
    const voice = this.voice?.on ? 'on: you speak aloud in this live session' : 'off: what you say shows as text';
    const tail = await this.#koeTail({ now: this.koe.now(), timeZone: this.koe.timeZone(), voice, online: this.koe.online(), reasons: ['a live session opened'], place, activity });
    return { instructions: koeSystem(s, true), context: [await this.#recent(), tail].filter(Boolean).join('\n') };
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

  /** A Koe with a conversation open follows at once, so neither half writes into one being left. @param {string | null} trip */
  open(trip) {
    this.#stopped = { on: false, seq: Infinity }; // a Stop belongs to the conversation it was in
    if (trip !== this.kokoro.target) this.live.close('switch', { forget: true });
    const opening = this.kokoro.open(trip);
    if (this.#koeTrip !== undefined) {
      this.#koeTrip = trip;
      return Promise.all([opening, this.koe.open(trip)]).then(() => {});
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
    this.#stopped.on = false;
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

  interrupt() {
    if (this.koeState === 'live') this.live.interrupt();
    else this.talking.interrupt();
  }

  /**
   * The page went (hidden, or left), or everything is being erased: a live session closes now, its microphone with it.
   * Erase forgets its handle too. @param {'away' | 'erase'} why
   */
  hush(why) {
    this.live.close(why, { forget: why === 'erase' });
    this.typing(false); // the page went: nobody types into it (review A3)
  }

  /** The page is back in view: what waited for it is said; the microphone opens only at a tap. */
  shown() {
    if (this.koeState === 'live') this.#route(() => this.live.shown());
  }
  /** The typing box holds text, or not: Kokoro waits while the user types (GATHER). @param {boolean} on */
  typing(on) {
    this.kokoro.typing(on);
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
    const typing = this.kokoro.typingNow;
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
    if (chatCandidates(cfg, KOE_ROLE).every((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes('image'))) return messages;
    return messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'image' ? { type: /** @type {const} */ ('text'), text: '[a photo; Kokoro sees it]' } : p)) }));
  }

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
    if (e.type === 'out.speak' && e.data?.live) this.#unsaid = []; // a live Koe said what it was told
    if (e.type === 'heard' && !e.data?.dismissed) this.#heardNow(false);
    if (typed || (e.type === 'heard' && !e.data?.dismissed)) {
      this.#answered = false;
      this.#failTold = false;
      this.#bothTold = false;
      this.#stopped.on = false;
    }
    if (e.type.startsWith('out.')) this.#up('koe'); // a live Koe that spoke works
    // A reply that asks Kokoro wakes it with the question, not the answer before it; with the answer, if the question fails.
    const out = e.type.startsWith('out.') && this.#cue;
    const failed = e.type === 'tool.result' && e.data?.name === 'tell_kokoro' && e.data.ok === false && this.#owed;
    if (e.type === 'tool.result' && e.data?.name === 'tell_kokoro') this.#asking = false;
    const answered = (out && !(this.#owed = this.#asking)) || failed;
    if (typed) this.#wakeKokoro({ kind: 'user', text: String(r.texts.text ?? e.data.text ?? ''), logged: true });
    else if (answered) this.#wakeKokoro({ kind: 'cue', text: 'Koe answered the user', logged: true, input: true });
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
    await this.channel.send('kokoro', text, 'append', /** @type {any} */ (`gated:${name}`), wake);
    return { content: 'Koe is speaking for you; use tell_koe.', told: true };
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
      this.channel.send('kokoro', `Kokoro couldn't check: ${this.#why || 'its models are resting after errors.'} Tell the user you couldn't check, and offer to try again.`, 'append', 'kokoro-failed').catch(() => {});
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
      this.channel.send('kokoro', t.finalText, 'append', 'final-text', t.wakeId).catch(() => {});
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
    this.channel.send('kokoro', text, 'append', why).catch(() => {});
  }
}
