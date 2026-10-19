import { Agent } from './loop.js';
import { TALK_TAG, KOE_TAG } from './log.js';
import { asksOrNotes, quote, cardText, escapeTags, newNonce } from './blocks.js';
import { systemText, nowBlock } from './context.js';
import { ME, newId } from '../scopes.js';
import { candidates, koeList, splitOn, AllFailedError } from '../llm/fallback.js';
import { ProviderError, explain } from '../llm/contract.js';
import { KOKORO_PART, koeSystem } from '../koe/instructions.js';
import { koeTools } from '../koe/tools.js';
import { compactView } from '../koe/context.js';
import { modelOf } from '../llm/config.js';

/**
 * Shiori as two halves (the Koe and Kokoro design): Koe talks with the user at once, Kokoro (Shiori as
 * she was, on Main) thinks and works behind it. Halves runs both as instances of the one loop and is
 * what the app holds, with the Agent's surface. Koe logs what the user types and Kokoro reads it and
 * wakes; the halves pass notes that never wait; Kokoro's output tools are gated in code while Koe
 * talks; Koe's state reaches Kokoro as blocks in its messages, never in its system text or tools.
 * With no Koe model, everything goes to Kokoro: Shiori as one half.
 * @typedef {import('./loop.js').Wake} Wake
 * @typedef {import('./loop.js').TurnEnd} TurnEnd
 * @typedef {'text' | 'down' | 'off'} KoeState  down: Koe failed, or voice is on (Koe types only, for now); off: no Koe model
 * @typedef {'koe-up' | 'koe-down' | 'voice-later'} Told
 * @typedef {'koe' | 'kokoro'} Side
 * @typedef {'tool' | 'gated:speak' | 'gated:show' | 'gated:ask' | 'final-text' | 'kokoro-failed' | 'nothing-to-add'} NoteWhy
 */

/** The events a half marks as its own while Shiori is two halves. */
const MARKED = new Set(['wake', 'tool.call', 'tool.result', 'error', 'out.speak', 'out.show', 'out.ask', 'note', 'model.turn']);
const BLOCKS = Object.freeze({
  'koe-down': "Koe can't speak right now; talk to the user directly.",
  'voice-later': "Voice is on, and Koe can't speak aloud yet; talk to the user directly.",
  'koe-up': 'Koe is speaking again; use tell_koe.',
});
/** How long Koe rests after its whole list failed, at least. */
export const KOE_REST_MS = 60_000;
const KOKORO_ONLY = ['personality', 'recap', 'restart'];
/** The user's own wakes, past the budgets. */
const THEIRS = ['user', 'choice', 'file', 'live'];

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
    this.deliver[to]({ kind: 'note', logged: true, from, text: from === 'koe' ? `Koe ${asksOrNotes(text)}: ${quote(text.length > 120 ? `${text.slice(0, 120)}…` : text)}` : 'a note from Kokoro' });
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
  #downUntil = 0;
  /** What Kokoro was told last, in which conversation. @type {{ scope: string | null, state: Told }} */
  #told = { scope: null, state: 'koe-up' };
  /** @type {Promise<unknown>} both halves' writes, one at a time */
  #lock = Promise.resolve();
  /** @type {Promise<unknown>} what the user typed and what woke Shiori, in order */
  #routing = Promise.resolve();
  #routes = 0;
  /** @type {string | null | undefined} the trip Koe has open; undefined: none yet */
  #koeTrip = undefined;
  /** Kokoro told Koe since the user last typed: Koe asking about it again wakes nobody. */
  #answered = false;
  /** @type {string[]} what Kokoro told Koe that Koe hasn't said since */
  #unsaid = [];
  #failTold = false;
  #nothingTold = false;
  #working = false;
  /** @type {KoeState | null} */
  #lastKoe = null;
  #lastCard = { key: '', at: 0 };
  /** The open conversation's next reminder, for Koe's view (set by the app). @type {(() => Promise<{ due: number, text: string } | null>) | null} */
  next = null;
  /** The settings read as annai starts: no turn runs before. @type {Promise<unknown>} */
  #ready;
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set(), open: new Set(), halves: new Set() };

  /** @param {ConstructorParameters<typeof Agent>[0]} c what each half is made with (Koe has no voice yet) */
  constructor(c) {
    this.nonce = newNonce();
    this.clock = c.now ?? Date.now;
    this.channel = new Channel({
      log: { koe: (ev) => this.koe.log(ev), kokoro: (ev) => this.kokoro.log(ev) },
      deliver: {
        koe: (w) => {
          if (w.from === 'kokoro') this.#unsaid.push(w.text);
          this.#koeOpen();
          this.koe.enqueue(w);
        },
        kokoro: (w) => { if (!(w.from === 'koe' && this.#answered)) this.kokoro.enqueue(w); },
      },
      cut: { koe: () => this.koe.cutIn(), kokoro: () => this.kokoro.cutIn() },
    });
    const serial = (/** @type {() => Promise<any>} */ fn) => this.#serial(fn);
    const ready = () => this.#ready;
    this.kokoro = new Agent({
      ...c,
      half: {
        name: 'kokoro', tag: TALK_TAG, role: async () => ({ role: 'main' }), registryTools: true, logVoice: true, housekeeping: true, serial, ready,
        voice: () => this.koeState !== 'text',
        rules: () => (this.#split ? 'kokoro' : 'one'),
        system: (s) => systemText(s, this.#split ? KOKORO_PART : ''),
        koe: () => (this.#split ? (this.koeState === 'text' ? 'text' : 'down') : null),
        hidden: async () => (this.#split ? [] : ['tell_koe']),
        // Its errors while Koe talks are set aside: Koe tells the user, and a card says what needs saying.
        mark: (type) => (this.#split && MARKED.has(type) ? { half: 'kokoro', ...(type === 'error' && this.koeState === 'text' ? { aside: true } : {}) } : {}),
        logged: async (e, r) => { if (this.#split) await this.koe.observe(e, r); },
        gate: (call) => this.#gate(call),
        failed: (why, e) => this.#kokoroFailed(why, e),
        calling: () => { this.#nothingTold = false; },
        ended: (t) => this.#kokoroEnded(t),
      },
    });
    this.koe = new Agent({
      ...c,
      voice: null,
      half: {
        name: 'koe', tag: KOE_TAG, registryTools: false, logVoice: false, housekeeping: false, nonce: this.nonce, serial, ready,
        role: async (voiceOn) => ({ role: koeList(await this.llm.config(), voiceOn).role }),
        voice: () => false,
        system: (s) => koeSystem(s),
        tail: (now) => this.#koeTail(now),
        sendable: (messages) => this.#koeSendable(messages),
        mark: (type) => (type === 'msg.user' ? { split: true } : MARKED.has(type) ? { half: 'koe' } : {}),
        // After a restart Kokoro takes up what is owed, and tells Koe; Koe's open calls are answered quietly.
        restart: async () => {
          await this.kokoro.opening.catch(() => {});
          return !this.kokoro.owed;
        },
        logged: (e, r) => this.#koeLogged(e, r),
        failed: () => this.#koeFailed(),
        ended: (t) => { if (t.ok) this.#unsaid = []; },
      },
    });
    this.kokoro.addLoopTools([channelTool('kokoro', this.channel, () => (this.koeState === 'text' ? null : "Koe can't speak right now: talk to the user yourself, with speak, show and ask."))]);
    // Koe's quick tools are Shiori's own, by name: Kokoro's (timers, recall), else the plugins'.
    const find = (/** @type {string} */ name) => this.kokoro.loopTools().find((t) => t.name === name) ?? c.registry.entries('tool').find((e) => e.item?.name === name)?.item;
    this.koe.addLoopTools([...koeTools({ find, ws: c.ws }), channelTool('koe', this.channel)]);
    for (const a of [this.kokoro, this.koe]) {
      a.on('event', (x) => this.#emit('event', x));
      a.on('notice', (n) => this.#notice(n));
      a.on('state', (s) => this.#stateOf(a, s));
    }
    this.kokoro.on('open', (x) => this.#emit('open', x));
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
  get state() { return this.talking.state; }
  /** The dock's sign. */
  get kokoroWorking() { return this.koeState === 'text' && this.kokoro.busy; }
  get busy() { return this.#routes > 0 || this.kokoro.busy || this.koe.busy; }
  /** @param {(() => { place?: string, activity?: string }) | null} fn */
  set sense(fn) { this.kokoro.sense = fn; this.koe.sense = fn; }
  get sense() { return this.kokoro.sense; }

  /** Whether Shiori is two halves: a Koe list holds a model. */
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
    if (half === this.talking) this.#emit('state', s);
    if (half === this.kokoro) this.#emitHalves();
    // Koe waits on a Kokoro with nothing to do: nothing to add (the wait is set up right after its state).
    if (half === this.koe && s.name === 'waiting') queueMicrotask(() => { if (this.koe.waiting && !this.kokoro.busy && this.koeState === 'text') this.#nothingToAdd(); });
  }

  #emitHalves() {
    const now = { koe: this.koeState, kokoroWorking: this.kokoroWorking };
    if (now.kokoroWorking === this.#working && this.#lastKoe === now.koe) return;
    this.#working = now.kokoroWorking;
    this.#lastKoe = now.koe;
    this.#emit('halves', now);
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
    const cfg = await this.llm.config();
    this.#split = splitOn(cfg);
    const koe = candidates(cfg, 'koe-type');
    const benched = koe.length > 0 && koe.every((id) => (this.llm.bench?.until(id) ?? 0) > Date.now());
    /** @type {Told} */
    const told = this.voice?.on ? 'voice-later' : this.clock() < this.#downUntil || benched ? 'koe-down' : 'koe-up';
    const was = this.talking;
    this.koeState = !this.#split ? 'off' : told === 'koe-up' ? 'text' : 'down';
    if (this.talking !== was) this.#emit('state', this.talking.state);
    if (this.#split && tell) await this.#tell(told);
    this.#emitHalves();
  }

  /** Kokoro's block, when its state differs from what it was told last in this conversation. @param {Told} state */
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

  #koeOpen() {
    if (this.#koeTrip === this.kokoro.target) return;
    this.#koeTrip = this.kokoro.target;
    this.koe.open(this.kokoro.target).catch((e) => console.warn('Koe could not open the conversation', e));
  }

  /** A Koe with a conversation open follows at once, so neither half writes into one being left. @param {string | null} trip */
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

  /** To Koe while it talks (Kokoro reads it and wakes), else to Kokoro; a half waiting for an answer gets it. @param {string} text @param {{ photos?: import('./loop.js').SentPhoto[] }} [o] */
  send(text, o = {}) {
    this.#route(async () => {
      await this.#refresh();
      if (this.koeState !== 'text' || this.kokoro.pendingId) return this.kokoro.send(text, o);
      this.#koeOpen();
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
    this.send(option);
  }

  /** Both halves get it while Koe talks, budgets checked once, its reminders with Koe (plan decision 16). @param {Wake} w @returns {Promise<void>} */
  wake(w) {
    if (w.scope && w.scope !== (this.kokoro.target ?? ME)) return this.kokoro.wake(w);
    this.#route(async () => {
      await this.#refresh();
      if (this.koeState !== 'text' || KOKORO_ONLY.includes(w.kind)) return void (await this.kokoro.wake(w));
      if (!THEIRS.includes(w.kind) && !(await this.kokoro.admit(w, (x) => this.wake(x)))) return;
      this.#koeOpen();
      this.koe.enqueue(w);
      this.kokoro.enqueue({ ...w, fallbacks: [] });
    });
    return Promise.resolve();
  }

  /** The half that talks; sound may play from here on (an iPhone rule). */
  tap() {
    this.voice?.unlock();
    return this.talking.tap();
  }

  interrupt() { this.talking.interrupt(); }
  /** The sign's Stop: Kokoro's turn alone. */
  stopKokoro() { this.kokoro.interrupt(); }

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

  /** A photo reaches Koe only when every model of its list takes photos (plan decision 22). @param {import('../llm/contract.js').Message[]} messages */
  async #koeSendable(messages) {
    const cfg = await this.llm.config();
    if (candidates(cfg, koeList(cfg, false).role).every((id) => cfg.models[id] && modelOf(cfg.models[id]).input.includes('image'))) return messages;
    return messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'image' ? { type: /** @type {const} */ ('text'), text: '[a photo; Kokoro sees it]' } : p)) }));
  }

  /** @param {any} e @param {import('./loop.js').Resolved} r */
  async #koeLogged(e, r) {
    await this.kokoro.observe(e, r);
    if (e.type === 'msg.user' && e.data?.split) {
      this.#answered = false;
      this.#failTold = false;
      this.kokoro.enqueue({ kind: 'user', text: String(r.texts.text ?? e.data.text ?? ''), logged: true });
    }
  }

  /** Kokoro's speak, show and ask while Koe talks become notes to Koe; its wait is answered (plan decision 15). @param {{ id: string, name: string, input: any, wake: string }} call */
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

  /** Koe tells the user Kokoro couldn't check, once, in plain words; no card (plan decision 21). @param {string} why @param {unknown} e */
  #kokoroFailed(why, e) {
    if (this.koeState !== 'text') return false;
    if (!this.#failTold) {
      this.#failTold = true;
      const attempts = e instanceof AllFailedError ? e.attempts : [];
      const rest = attempts.find((a) => a.error?.startsWith('its daily limit'));
      const kind = attempts.map((a) => a.outcome).find((o) => o !== 'benched' && o !== 'ok');
      const plain = rest ? `${rest.name}: ${rest.error}.` : kind ? explain(new ProviderError(/** @type {any} */ (kind), why)) : attempts.length ? 'its models are resting after errors.' : why;
      this.channel.send('kokoro', `Kokoro couldn't check: ${plain} Tell the user you couldn't check, and offer to try again.`, 'append', 'kokoro-failed').catch(() => {});
    }
    return true;
  }

  /** Koe rests; Kokoro is told to talk directly, and wakes to (its notes may not have reached the user). No card. */
  #koeFailed() {
    if (!this.#split) return false;
    this.#downUntil = this.clock() + KOE_REST_MS;
    this.#route(async () => {
      await this.#refresh();
      this.kokoro.enqueue({ kind: 'halves', text: BLOCKS['koe-down'], logged: true });
    });
    return true;
  }

  /**
   * Final text goes to Koe (decision 20); a waiting Koe hears there's nothing to add, or that Kokoro
   * was stopped. Once Kokoro has told Koe, Koe's question about the same message takes no turn.
   * @param {TurnEnd} t
   */
  #kokoroEnded(t) {
    if (this.koeState !== 'text') return;
    let told = t.told;
    if (t.ok && t.finalText && !t.told && !t.slept) {
      told = true;
      this.channel.send('kokoro', t.finalText, 'append', 'final-text', t.wakeId).catch(() => {});
    } else if (!told && this.koe.waiting) this.#nothingToAdd(t.ok ? 'Kokoro has nothing to add.' : 'Kokoro was stopped.');
    if (told) {
      this.#answered = true;
      this.kokoro.drop((w) => w.kind === 'note' && w.from === 'koe');
    }
  }

  #nothingToAdd(text = 'Kokoro has nothing to add.') {
    if (this.#nothingTold) return;
    this.#nothingTold = true;
    this.channel.send('kokoro', text, 'append', 'nothing-to-add').catch(() => {});
  }
}
