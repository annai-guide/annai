import { Agent } from './loop.js';
import { TALK_TAG, KOE_TAG } from './log.js';
import { Channel, channelTool } from './channel.js';
import { cardText, escapeTags, newNonce } from './blocks.js';
import { systemText, nowBlock } from './context.js';
import { ME } from '../scopes.js';
import { candidates, AllFailedError } from '../llm/fallback.js';
import { ProviderError, explain } from '../llm/contract.js';
import { koeList, splitOn } from '../koe/path.js';
import { KOKORO_PART, koeSystem } from '../koe/instructions.js';
import { koeTools } from '../koe/tools.js';
import { compactView } from '../koe/context.js';
import { modelOf } from '../llm/config.js';

/**
 * Shiori as two halves (the Koe and Kokoro design): Koe talks with the user at once, Kokoro thinks and
 * works behind it. Halves runs both as instances of the one loop (plan decision 1) and is what the
 * app and the screens hold, with the Agent's surface. Everything reaches both halves: Koe logs what
 * the user typed and Kokoro reads it, woken for it; the halves pass notes that never wait; Kokoro's
 * output tools are gated in code while Koe works; and Kokoro learns of Koe's state from instruction
 * blocks in its messages, so its system text and tools never change with modes (decision 4).
 * With no Koe model, everything goes to Kokoro, which is Shiori as she always was.
 * @typedef {import('./loop.js').Wake} Wake
 * @typedef {import('./loop.js').TurnEnd} TurnEnd
 * @typedef {'text' | 'down' | 'off'} KoeState  text: Koe talks; down: it can't now (failed, or voice is on, which Koe can't use yet); off: no Koe model
 * @typedef {'koe-up' | 'koe-down' | 'voice-later'} Told  what Kokoro was told last
 */

/** The events each half marks as its own while Shiori is two halves. */
const MARKED = new Set(['wake', 'tool.call', 'tool.result', 'error', 'out.speak', 'out.show', 'out.ask', 'note', 'model.turn']);
/** The blocks Kokoro reads when Koe's state changes. */
const BLOCKS = Object.freeze({
  'koe-down': "Koe can't speak right now; talk to the user directly.",
  'voice-later': "Voice is on, and Koe can't speak aloud yet; talk to the user directly.",
  'koe-up': 'Koe is speaking again; use tell_koe.',
});
/** How long Koe rests after its whole list failed, at least. */
export const KOE_REST_MS = 60_000;
/** Wakes only Kokoro takes: its personality, and a recap told aloud (Koe types only, for now). */
const KOKORO_ONLY = ['personality', 'recap', 'restart'];
/** Wakes that are the user's, past the budgets. */
const THEIRS = ['user', 'choice', 'file', 'live'];

export class Halves {
  /** @type {KoeState} */
  koeState = 'off';
  #split = false;
  /** Koe's whole list failed: it rests until then. */
  #downUntil = 0;
  /** @type {{ scope: string | null, state: Told }} what Kokoro was told last, in which conversation */
  #told = { scope: null, state: 'koe-up' };
  /** Writes of both halves, one at a time. @type {Promise<unknown>} */
  #lock = Promise.resolve();
  /** Routing of what the user typed and what woke Shiori, in order. @type {Promise<unknown>} */
  #routing = Promise.resolve();
  #routes = 0;
  /** The trip Koe's conversation is open on; undefined: none yet. @type {string | null | undefined} */
  #koeTrip = undefined;
  /** Koe's turn now answers what the user typed. */
  #koeUser = false;
  /** Koe said something to the user that no model call of Kokoro's has seen yet. */
  #unseen = false;
  /** What Kokoro told Koe that no turn of Koe's has said since. @type {string[]} */
  #unsaid = [];
  /** Koe was told Kokoro couldn't check, and nothing new was asked since. */
  #failTold = false;
  /** Koe heard there was nothing to add, and Kokoro hasn't worked since: a wait again just waits. */
  #nothingTold = false;
  /** What the sign showed last: Kokoro working, and Koe's state. */
  #working = false;
  /** @type {KoeState | null} */
  #lastKoe = null;
  /** The next reminder of the open conversation, for Koe's view (live mode's, set by the app). @type {(() => Promise<{ due: number, text: string } | null>) | null} */
  next = null;
  /** The settings read as annai starts: no turn runs before. @type {Promise<unknown>} */
  #ready;
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set(), open: new Set(), halves: new Set() };

  /**
   * @param {ConstructorParameters<typeof Agent>[0]} c what each half is made with; Koe has no voice of its own yet (K1)
   */
  constructor(c) {
    this.nonce = newNonce();
    /** @type {() => number} the real clock, for how long Koe rests */
    this.clock = c.now ?? Date.now;
    this.channel = new Channel({
      log: { koe: (ev) => this.koe.log(ev), kokoro: (ev) => this.kokoro.log(ev) },
      deliver: {
        koe: (w) => {
          if (w.from === 'kokoro') this.#unsaid.push(w.text);
          this.#koeOpen();
          this.koe.enqueue(w);
        },
        kokoro: (w) => this.kokoro.enqueue(w),
      },
      cut: { koe: () => this.koe.cutIn(), kokoro: () => this.kokoro.cutIn() },
    });
    const serial = (/** @type {() => Promise<any>} */ fn) => this.#serial(fn);
    this.kokoro = new Agent({
      ...c,
      half: {
        name: 'kokoro', tag: TALK_TAG, role: async () => ({ role: 'main' }), registryTools: true, logVoice: true, housekeeping: true,
        voice: () => this.koeState !== 'text',
        rules: () => (this.#split ? 'kokoro' : 'one'),
        system: (s) => systemText(s, this.#split ? KOKORO_PART : ''),
        koe: () => (this.#split ? (this.koeState === 'text' ? 'text' : 'down') : null),
        hidden: async () => (this.#split ? [] : ['tell_koe']),
        mark: (type) => (this.#split && MARKED.has(type) ? { half: 'kokoro' } : {}),
        serial,
        ready: () => this.#ready,
        logged: async (e, r) => { if (this.#split) await this.koe.observe(e, r); },
        gate: (call) => this.#gate(call),
        failed: (why, e) => this.#kokoroFailed(why, e),
        calling: () => {
          this.#unseen = false;
          this.#nothingTold = false;
        },
        ended: (t) => this.#kokoroEnded(t),
      },
    });
    this.koe = new Agent({
      ...c,
      voice: null,
      half: {
        name: 'koe', tag: KOE_TAG, registryTools: false, logVoice: false, housekeeping: false, nonce: this.nonce,
        role: async (voiceOn) => ({ role: koeList(await this.llm.config(), voiceOn).role }),
        voice: () => false,
        system: (s) => koeSystem(s),
        tail: (now) => this.#koeTail(now),
        sendable: (messages) => this.#koeSendable(messages),
        mark: (type) => (type === 'msg.user' ? { split: true } : MARKED.has(type) ? { half: 'koe' } : {}),
        serial,
        ready: () => this.#ready,
        // After a restart, Kokoro takes up what is owed and tells Koe; Koe's calls left open are answered quietly.
        restart: async () => {
          await this.kokoro.opening.catch(() => {});
          return !this.kokoro.owed;
        },
        logged: (e, r) => this.#koeLogged(e, r),
        failed: () => this.#koeFailed(),
        ended: (t) => this.#koeEnded(t),
      },
    });
    this.kokoro.addLoopTools([channelTool('kokoro', this.channel, () => (this.koeState === 'text' ? null : "Koe can't speak right now: talk to the user yourself, with speak, show and ask."))]);
    // Koe's quick tools are Shiori's own, found by name: Kokoro's (timers, recall), else the plugins' (reads, places, light changes).
    const find = (/** @type {string} */ name) => this.kokoro.loopTools().find((t) => t.name === name) ?? c.registry.entries('tool').find((e) => e.item?.name === name)?.item;
    this.koe.addLoopTools([...koeTools({ find, ws: c.ws }), channelTool('koe', this.channel)]);
    for (const a of [this.kokoro, this.koe]) {
      a.on('event', (x) => this.#emit('event', x));
      a.on('notice', (n) => this.#notice(n));
    }
    this.kokoro.on('open', (x) => this.#emit('open', x));
    this.kokoro.on('state', (s) => this.#stateOf(this.kokoro, s));
    this.koe.on('state', (s) => this.#stateOf(this.koe, s));
    // Voice turned on or off: Kokoro is told (K1: Koe types only), and the dock follows the half that talks.
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
  /** The conversation being opened, by both halves. */
  get opening() { return Promise.all([this.kokoro.opening, this.koe.opening]).then(() => {}); }
  /** The half that talks with the user now. */
  get talking() { return this.koeState === 'text' ? this.koe : this.kokoro; }
  get state() { return this.talking.state; }
  /** Kokoro works behind Koe now: the dock's sign. */
  get kokoroWorking() { return this.koeState === 'text' && this.kokoro.busy; }
  get busy() { return this.#routes > 0 || this.kokoro.busy || this.koe.busy; }
  /** @param {(() => { place?: string, activity?: string }) | null} fn */
  set sense(fn) { this.kokoro.sense = fn; this.koe.sense = fn; }
  get sense() { return this.kokoro.sense; }

  /** Whether Shiori is two halves now: a Koe list holds a model. */
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

  /** A card, once: both halves stopped by the same budget say it once. @param {any} n */
  #notice(n) {
    const key = `${n.title}\n${n.body}`;
    const now = Date.now();
    if (this.#lastCard.key === key && now - this.#lastCard.at < 5000) return;
    this.#lastCard = { key, at: now };
    this.#emit('notice', n);
  }

  #lastCard = { key: '', at: 0 };

  /** A half's state: the dock follows the half that talks; Kokoro's working shows as the sign. @param {Agent} half @param {any} s */
  #stateOf(half, s) {
    if (half === this.talking) this.#emit('state', s);
    if (half === this.kokoro) this.#emitHalves();
    // Koe waits for Kokoro, which has nothing left to do: there is nothing to add.
    // (The wait is set up right after its state is said.)
    if (half === this.koe && s.name === 'waiting') queueMicrotask(() => { if (this.koe.waiting && !this.kokoro.busy && this.koeState === 'text') this.#nothingToAdd(); });
  }

  #emitHalves() {
    const now = { koe: this.koeState, kokoroWorking: this.kokoroWorking };
    if (now.kokoroWorking === this.#working && this.#lastKoe === now.koe) return;
    this.#working = now.kokoroWorking;
    this.#lastKoe = now.koe;
    this.#emit('halves', now);
  }

  /** Runs fn when neither half is writing. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #serial(fn) {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  /** In order with what the user typed before. @param {() => unknown} fn */
  #route(fn) {
    this.#routes++;
    this.#routing = this.#routing.then(fn).catch((e) => console.warn('routing failed', e)).finally(() => {
      this.#routes--;
    });
    return this.#routing;
  }

  /**
   * Koe's state from the settings, the voice and Koe's rest; Kokoro is told when it changed (an
   * instruction block in its messages, never its system text). @param {{ tell?: boolean }} [o] tell: false as annai starts, before a conversation is open
   */
  async #refresh({ tell = true } = {}) {
    await this.voice?.refresh().catch(() => {}); // Auto follows the car's audio and the drive: read now, not at Kokoro's next turn
    const cfg = await this.llm.config();
    this.#split = splitOn(cfg);
    const benched = candidates(cfg, 'koe-type').length > 0 && candidates(cfg, 'koe-type').every((id) => (this.llm.bench?.until(id) ?? 0) > Date.now());
    /** @type {Told} */
    const told = this.voice?.on ? 'voice-later' : this.clock() < this.#downUntil || benched ? 'koe-down' : 'koe-up';
    const was = this.talking;
    this.koeState = !this.#split ? 'off' : told === 'koe-up' ? 'text' : 'down';
    if (this.talking !== was) this.#emit('state', this.talking.state); // the dock follows the half that talks now
    if (this.#split && tell) await this.#tell(told);
    this.#emitHalves();
  }

  /** Writes Kokoro's block when its state differs from what it was told last in this conversation. @param {Told} state */
  async #tell(state) {
    await this.kokoro.opening.catch(() => {});
    const scope = this.kokoro.scope;
    if (this.#told.scope !== scope) {
      const [last] = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['halves'], reverse: true, limit: 1 }));
      this.#told = { scope, state: last?.data?.state ?? 'koe-up' };
    }
    if (this.#told.state === state) return;
    this.#told = { scope, state };
    const unsaid = state !== 'koe-up' && this.#unsaid.splice(0).length ? " What you last told Koe didn't reach the user." : '';
    await this.kokoro.log({ type: 'halves', actor: 'system', data: { state }, texts: [['text', `${BLOCKS[state]}${unsaid}`]] });
  }

  /** Koe's conversation opens on the one Kokoro has open, once. */
  #koeOpen() {
    if (this.#koeTrip === this.kokoro.target) return;
    this.#koeTrip = this.kokoro.target;
    this.koe.open(this.kokoro.target).catch((e) => console.warn('Koe could not open the conversation', e));
  }

  /**
   * Opens a trip's conversation (or "me"'s). A Koe that has a conversation open stops and follows at
   * once, so neither half writes into the one being left (a trip being removed, say).
   * @param {string | null} trip
   */
  open(trip) {
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
   * The user typed, or sent photos: to Koe while it talks, which logs it, and Kokoro reads it and
   * wakes; else to Kokoro, as Shiori. A half waiting for an answer gets it.
   * @param {string} text @param {{ photos?: import('./loop.js').SentPhoto[] }} [o]
   */
  send(text, o = {}) {
    this.#route(async () => {
      await this.#refresh();
      if (this.koeState !== 'text' || this.kokoro.pendingId) return this.kokoro.send(text, o);
      this.#koeOpen();
      this.koe.send(text, o);
    });
  }

  /** A tap on an ask's option: the half that asked. @param {string} callId @param {string} option */
  answer(callId, option) {
    if (this.koe.pendingId === callId) return this.koe.answer(callId, option);
    if (this.kokoro.pendingId === callId) return this.kokoro.answer(callId, option);
    this.send(option);
  }

  /**
   * A wake that isn't the user typing (spec §6.1): both halves get it while Koe talks, checked against
   * the budgets once, its reminders going with the half that talks (plan decision 16).
   * @param {Wake} w @returns {Promise<void>}
   */
  wake(w) {
    if (w.scope && w.scope !== (this.kokoro.target ?? ME)) return this.kokoro.wake(w);
    this.#route(async () => {
      await this.#refresh();
      if (this.koeState !== 'text' || KOKORO_ONLY.includes(w.kind)) {
        await this.kokoro.wake(w);
        return;
      }
      if (!THEIRS.includes(w.kind) && !(await this.kokoro.admit(w, (x) => this.wake(x)))) return;
      this.#koeOpen();
      this.koe.enqueue(w);
      this.kokoro.enqueue({ ...w, fallbacks: [] });
    });
    return Promise.resolve();
  }

  /** Tapping Shiori: the half that talks (spec §10.4). Sound may play from here on (an iPhone rule). */
  tap() {
    this.voice?.unlock();
    return this.talking.tap();
  }

  interrupt() {
    this.talking.interrupt();
  }

  /** The sign's Stop: Kokoro's turn ends, and Koe goes on. */
  stopKokoro() {
    this.kokoro.interrupt();
  }

  /** Settles when neither half works, nothing is queued, and nothing is being routed. */
  async idle() {
    do {
      await this.#routing;
      await this.kokoro.idle();
      await this.koe.idle();
    } while (this.busy);
  }

  /** @param {boolean} [yes] */
  leaving(yes = true) {
    this.kokoro.leaving(yes);
    this.koe.leaving(yes);
  }

  /** A simulation's clock for both halves. @param {Parameters<Agent['useClock']>[0]} c */
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
  loopTools() { return this.kokoro.loopTools(); }
  /** @param {import('./loop.js').LoopTool[]} tools Shiori's own tools, which are Kokoro's */
  addLoopTools(tools) { this.kokoro.addLoopTools(tools); }
  /** @param {import('./loop.js').Reminder[]} list @param {string} [scope] */
  remind(list, scope) { return this.kokoro.remind(list, scope); }

  /**
   * Koe's tail: the now block, what its notes carry, and (K1 Task 7) its compact view of the trip.
   * The nonce is here, never in Koe's cached prefix: it changes each time annai starts.
   * @param {Parameters<NonNullable<import('./loop.js').Half['tail']>>[0]} now
   */
  async #koeTail(now) {
    const block = nowBlock({ ...now, plan: null, reasons: now.reasons.map(escapeTags), place: escapeTags(now.place ?? 'unknown'), activity: escapeTags(now.activity ?? 'unknown') });
    // Live mode's reminders wait for its own work: a slow answer is none, so Koe never waits on it.
    const next = this.next ? await Promise.race([this.next().catch(() => null), new Promise((r) => { setTimeout(() => r(null), 150); })]) : null;
    const view = await compactView({ ws: this.ws, trip: this.koe.trip, now: now.now, timeZone: now.timeZone, next: /** @type {any} */ (next) });
    return `${block}\n${view}\nKokoro's notes carry id="${this.nonce}".`;
  }

  /**
   * What Koe is sent: a photo only when every model of its list takes photos (plan decision 22), else a
   * line saying Kokoro sees it, so no model of Koe's is skipped for a photo it can't take.
   * @param {import('../llm/contract.js').Message[]} messages
   */
  async #koeSendable(messages) {
    const cfg = await this.llm.config();
    const ids = candidates(cfg, koeList(cfg, false).role);
    if (ids.every((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes('image'))) return messages;
    return messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'image' ? { type: /** @type {const} */ ('text'), text: '[a photo; Kokoro sees it]' } : p)) }));
  }

  /** What Koe wrote: Kokoro reads it, and wakes for what the user typed to Koe. @param {any} e @param {import('./loop.js').Resolved} r */
  async #koeLogged(e, r) {
    await this.kokoro.observe(e, r);
    if (e.type === 'wake' && !e.data?.meanwhile) this.#koeUser = false;
    if (e.type === 'msg.user' && e.data?.split) {
      this.#koeUser = true;
      this.#failTold = false;
      this.kokoro.enqueue({ kind: 'user', text: String(r.texts.text ?? e.data.text ?? ''), logged: true });
    }
    if (e.type.startsWith('out.') && this.#koeUser) this.#unseen = true;
  }

  /**
   * Kokoro's output tools while Koe talks (plan decision 15): not run. speak, show and ask become
   * notes to Koe, so nothing is lost; wait would open the microphone, which is Koe's.
   * @param {{ id: string, name: string, input: any, wake: string }} call
   */
  async #gate({ name, input, wake }) {
    if (this.koeState !== 'text') return null;
    if (name === 'wait') return { content: "Koe is talking with the user; what they say reaches you. Call sleep when you're done." };
    const text = name === 'speak' ? String(input?.text ?? '')
      : name === 'show' ? `Kokoro wants to show: ${cardText(input?.card)}`
        : name === 'ask' ? `Kokoro wants to ask: ${String(input?.question ?? '')} (${(Array.isArray(input?.options) ? input.options : []).join(', ')})` : null;
    if (text === null) return null;
    await this.channel.send('kokoro', text, 'append', /** @type {any} */ (`gated:${name}`), wake);
    return { content: 'Koe is speaking for you; use tell_koe.', told: true };
  }

  /**
   * Kokoro's whole list failed while Koe talks: Koe tells the user, once, and no card (plan decision 21).
   * Koe gets the reason in plain words, never the provider's own (long, and not Koe's business).
   * @param {string} why @param {unknown} e
   */
  #kokoroFailed(why, e) {
    if (this.koeState !== 'text') return false;
    if (!this.#failTold) {
      this.#failTold = true;
      const kind = e instanceof AllFailedError ? e.attempts.map((a) => a.outcome).find((o) => o !== 'benched' && o !== 'ok') : undefined;
      const plain = kind ? explain(new ProviderError(/** @type {any} */ (kind), why)) : e instanceof AllFailedError ? 'its models are resting after errors.' : why;
      this.channel.send('kokoro', `Kokoro couldn't check: ${plain} Tell the user you couldn't check, and offer to try again.`, 'append', 'kokoro-failed').catch(() => {});
    }
    return true;
  }

  /**
   * Koe's whole list failed: it rests, Kokoro is told to talk directly, and wakes to do so (what it
   * told Koe may not have reached the user). No card: Kokoro answers.
   */
  #koeFailed() {
    if (!this.#split) return false;
    this.#downUntil = this.clock() + KOE_REST_MS;
    this.#route(async () => {
      await this.#refresh();
      this.kokoro.enqueue({ kind: 'halves', text: BLOCKS['koe-down'], logged: true });
    });
    return true;
  }

  /** @param {TurnEnd} t */
  #koeEnded(t) {
    if (t.ok) this.#unsaid = [];
    // Koe answered the user by itself, after Kokoro last looked: Kokoro checks what it said.
    if (this.#unseen && !this.kokoro.busy && this.koeState === 'text') this.#review();
  }

  /**
   * Kokoro's turn ended while Koe talks: plain final text goes to Koe (decision 20); a Koe waiting
   * for it hears there's nothing to add; what Koe said meanwhile, unseen, is looked at next.
   * @param {TurnEnd} t
   */
  #kokoroEnded(t) {
    if (this.koeState !== 'text') return;
    let told = t.told;
    if (t.ok && t.finalText && !t.told && !t.slept) {
      told = true;
      this.channel.send('kokoro', t.finalText, 'append', 'final-text', t.wakeId).catch(() => {});
    } else if (!told && this.koe.waiting) this.#nothingToAdd();
    if (this.#unseen && !told) this.#review();
  }

  #nothingToAdd() {
    if (this.#nothingTold) return;
    this.#nothingTold = true;
    this.channel.send('kokoro', 'Kokoro has nothing to add.', 'append', 'nothing-to-add').catch(() => {});
  }

  #review() {
    this.#unseen = false;
    this.kokoro.enqueue({ kind: 'cue', text: 'Koe answered the user; check what it said', logged: true });
  }
}

