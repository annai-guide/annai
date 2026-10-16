import { ME, newId } from '../scopes.js';
import { readAppSettings } from '../settings.js';
import { AllFailedError, estimateTokens } from '../llm/fallback.js';
import { ProviderError, explain } from '../llm/contract.js';
import { modelOf, saveModel } from '../llm/config.js';
import { fromBase64, toBase64 } from '../bytes.js';
import { sha256Hex } from '../hash.js';
import { record, storedTexts, blobBytes, TALK_TAG } from './log.js';
import { compactionNeed, cutAt, promptTokens, requestBytes, instruction, renderForSummary, COLD_SYSTEM, KEEP_EXCHANGES, WARM_LEAD_MS, SUMMARY_MAX_CHARS } from './compaction.js';
import { Transcript, resolveEvent, repair } from './transcript.js';
import { toolList, definitions, runTool, Stuck, toolSwitches, resolvePath } from './tools.js';
import { takeSnapshot, nextSnapshot, nowBlock, nextPlanItems, buildRequest, prefixFingerprint } from './context.js';
import { Warmth, TTL_MS, ttlFor, SOON_MS } from './warmth.js';
import { tracedFetch, withoutSecrets } from './net.js';
import { webVia } from './via.js';
import { inQuiet, quietEnds, spentToday, budgetStop } from './budgets.js';
import { PhotoCopies, requestLimits, healRegion } from '../request-photos.js';
import { readRefusal, stricter, tighter, limitImages } from './refusals.js';
import { photoSettings } from '../photos.js';

/**
 * Shiori's loop (spec §6). Wakes go into one queue. A turn builds the context, calls the main
 * role, runs the tool calls in order (sleep last), appends the results and calls again, until she
 * sleeps, calls no tool, or something stops her. She reaches the user only through output tools
 * (§7.1); everything else she writes stays in the trace.
 * @typedef {'user' | 'choice' | 'plugin' | 'file' | 'restart' | 'personality'} WakeKind
 * @typedef {{ path: string, region?: number[] }} SentPhoto a photo the user sends: a path, and a part of it
 * @typedef {{ kind: WakeKind, text: string, plugin?: string, scope?: string, photos?: SentPhoto[] }} Wake scope: the conversation it was meant for, set when it is queued
 * @typedef {'sleeping' | 'thinking' | 'speaking' | 'waiting' | 'away' | 'offline'} StateName
 * @typedef {{ name: StateName, label: string, detail?: string }} State
 * @typedef {{ tone: 'warn' | 'info', title: string, body: string, actions?: { label: string, primary?: boolean, run: () => void | Promise<void> }[] }} Notice
 * @typedef {{ stepsPerWake?: number, spendPerDay?: number, wakesPerHour?: number, quietHours?: { from: string, to: string } }} Budgets
 * @typedef {{ personality: string, cacheTtl: '5m' | '1h', askBeforeTuning: boolean, budgets: Budgets, compaction: { threshold: number, maxRequestMiB: number } }} AgentSettings
 * @typedef {import('./tools.js').Tool & { pluginId: string }} LoopTool
 */

/** The dock's words for each state (spec §16.3). */
export const LABELS = Object.freeze({
  sleeping: 'Tap to talk', thinking: 'Thinking', speaking: 'Tap to interrupt', waiting: 'Waiting for your OK', away: 'Working on …', offline: 'Offline · reminders still work',
});
export const SPEAK_RESULT = "Shown on screen. Voice is off, so you didn't listen; the user may type.";
export const STOPPED = 'Stopped by the user.';

const CARD = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    text: { type: 'string', description: 'Markdown: **bold**, *italic*, lists and [links](https://…).' },
    place: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } }, required: ['name'] },
    links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'] } },
    booking: { type: 'string', description: 'A booking’s path, such as /trip/bookings/hotel.json.' },
    image: { type: 'string', description: 'A photo’s path, such as /trip/files/2026-11-26-1604.webp.' },
    choice: { type: 'array', items: { type: 'string' }, description: 'Buttons. A tap comes back to you as a message.' },
  },
};

export class Agent {
  scope = ME;
  /** @type {string | null} */
  trip = null;
  /** @type {State} */
  state = { name: 'sleeping', label: LABELS.sleeping };
  transcript = new Transcript();
  /** The conversation being opened, if any: screens wait for it before they read it. @type {Promise<void>} */
  opening = Promise.resolve();
  /** @type {import('./context.js').Snapshot | null} */
  #snapshot = null;
  #warmth = new Warmth();
  /** @type {Wake[]} */
  #queue = [];
  #busy = false;
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {{ id: string, kind: 'ask' | 'wait', resolve: (v: { text?: string, chosen?: string, stopped?: boolean }) => void } | null} */
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
  /** @type {(() => void)[]} waiting for the running turn or housekeeping to end */
  #free = [];
  /** The page is being left. */
  #leaving = false;
  /** @type {PhotoCopies | null} */
  #photos = null;
  /** The wake whose photo couldn't be sent: its card already says why. */
  #photoCard = '';
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set() };

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, llm: any, registry: import('../registry.js').Registry,
   *   now?: () => number, online?: () => boolean, timeZone?: () => string, fetch?: (url: string, init?: RequestInit) => Promise<Response>, secondMs?: number,
   *   codec?: ConstructorParameters<typeof PhotoCopies>[0]['codec'],
   *   timers?: { set: (fn: () => void, ms: number) => any, clear: (handle: any) => void } }} c
   */
  constructor({ store, ws, llm, registry, codec, now = Date.now, online = () => globalThis.navigator?.onLine !== false, timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone, fetch: get, secondMs = 1000,
    timers = { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => /** @type {any} */ (setTimeout(fn, ms)), clear: (/** @type {any} */ h) => clearTimeout(h) } }) {
    this.store = store;
    this.ws = ws;
    /** @type {any} the llm service: call(), config(), decide() */
    this.llm = llm;
    this.registry = registry;
    this.now = now;
    this.online = online;
    this.timeZone = timeZone;
    this.secondMs = secondMs;
    /** How housekeeping waits for the cache (tests pass their own). */
    this.timers = timers;
    this.get = get ?? ((/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => fetch(url, init));
    /** The browser's photo codec: request copies and crops (spec §4.8). Without one, photos go as they are. */
    this.codec = codec ?? null;
    this.#photos = codec ? new PhotoCopies({ codec, read: (hash) => blobBytes(this.store, hash) }) : null;
    this.#loopTools = this.#talkTools();
  }

  /**
   * The photo limits of every main model that takes photos, the stricter of each (spec §9.2): any
   * of them may answer after a fallback, so what is sent fits them all.
   */
  async #mainImages() {
    const cfg = await this.llm.config();
    /** @type {import('./refusals.js').Learned} */
    let images = {};
    for (const id of cfg.roles?.main?.models ?? []) {
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

  /** @param {'state' | 'event' | 'notice'} kind @param {(x: any) => void} fn */
  on(kind, fn) {
    this.#on[kind].add(fn);
    return () => this.#on[kind].delete(fn);
  }

  /** A system card, with any key annai keeps blanked from what it says (spec §9.9). @param {Notice} n */
  async #notice(n) {
    this.#emit('notice', { ...n, title: await withoutSecrets(this.store, n.title), body: await withoutSecrets(this.store, n.body) });
  }

  /** @param {'state' | 'event' | 'notice'} kind @param {any} x */
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
  }

  /** @param {LoopTool[]} tools Self tools (spec §7.2), offered after the talk tools */
  addLoopTools(tools) {
    this.#loopTools = [...this.#loopTools, ...tools];
  }

  /** @returns {Promise<AgentSettings>} */
  async settings() {
    const s = (await readAppSettings(this.ws)).shiori ?? {};
    return {
      personality: s.personality ?? 'shiori', cacheTtl: s.cacheTtl === '1h' ? '1h' : '5m', askBeforeTuning: Boolean(s.askBeforeTuning),
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
    this.#target = trip;
    this.#opens++;
    const generation = ++this.#generation;
    if (this.#busy) this.interrupt();
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
    const transcript = await Transcript.load(this.store, scope);
    if (generation !== this.#generation) return;
    const repaired = await repair(this.store, scope, transcript);
    if (generation !== this.#generation) return;
    await this.#keepElsewhere(scope);
    if (generation !== this.#generation) return;
    this.trip = trip;
    this.scope = scope;
    this.transcript = transcript;
    this.#snapshot = null;
    // The last conversation's housekeeping stays with it: it is checked again at its next turn.
    this.#due = false;
    this.#lastPrompt = 0;
    this.#clearTimer();
    if (repaired || transcript.unanswered) {
      const text = repaired ? 'annai restarted while you were working, so your unfinished tool calls were stopped.'
        : transcript.waiting === 'wake' ? "You haven't answered this yet: it came while this conversation was closed, or before annai restarted."
          : 'The conversation closed before you answered (annai restarted, or another one was opened).';
      this.#queue.push({ kind: 'restart', text, scope }); // it runs once the open is done
    }
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
      await this.#logWakes(elsewhere.filter((w) => w.scope === s), newId('w'), false, (ev) => record(this.store, s, ev), s === ME ? null : s);
    }
  }

  /** Writes a wake into a conversation that isn't open. idle() waits for it, and so can the caller. @param {string} scope @param {Wake} w */
  #keepFor(scope, w) {
    this.#checking++;
    return this.#logWakes([{ ...w, scope }], newId('w'), false, (ev) => record(this.store, scope, ev), scope === ME ? null : scope)
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
    this.#queue.push({ ...w, scope: this.#target ?? ME });
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
    if (w.kind === 'user' || w.kind === 'choice' || w.kind === 'restart' || w.kind === 'file') {
      this.#push(w);
      this.#drain();
      return Promise.resolve();
    }
    this.#checking++;
    this.settings().then(({ budgets }) => {
      const now = this.now();
      if (budgets.quietHours && inQuiet(now, budgets.quietHours, this.timeZone())) {
        const held = setTimeout(() => this.wake(w), Math.max(1000, quietEnds(now, budgets.quietHours, this.timeZone()) - now));
        /** @type {any} */ (held).unref?.(); // in Node (tests), a held wake must not keep the process alive
        return;
      }
      this.#recentWakes = this.#recentWakes.filter((t) => t > now - 3_600_000);
      if (budgets.wakesPerHour && this.#recentWakes.length >= budgets.wakesPerHour) {
        this.#notice({ tone: 'info', title: 'Shiori skipped a wake', body: `${w.plugin ? `The plugin ${w.plugin}` : 'Something'} woke her more than the ${budgets.wakesPerHour} times an hour you allow: ${w.text}` });
        return;
      }
      this.#recentWakes.push(now);
      this.#push(w);
      this.#drain();
    }).finally(() => {
      this.#checking--;
      this.#settle();
    });
    return Promise.resolve();
  }

  /**
   * The page is being left (pagehide): a request cut off now (WebKit cancels it while the page can
   * still write) is not a failed turn, so nothing is logged and the next start answers (spec §6.7).
   * @param {boolean} [yes] false when the page comes back from the back-forward cache
   */
  leaving(yes = true) {
    this.#leaving = yes;
  }

  /** Tapping Shiori while she works: stops the stream, the running tool, and the turn (spec §6.7). */
  interrupt() {
    this.#abort?.abort();
    const p = this.#pending;
    this.#pending = null;
    p?.resolve({ stopped: true });
  }

  /** Settles when no turn is running and nothing is queued. */
  idle() {
    if (!this.#busy && !this.#queue.length && !this.#checking) return Promise.resolve();
    return new Promise((resolve) => { this.#idle.push(() => resolve(undefined)); });
  }

  /** The queued wakes for the open conversation, the user's first. */
  #take() {
    const all = this.#queue.filter((w) => w.scope === this.scope);
    this.#queue = this.#queue.filter((w) => w.scope !== this.scope);
    return [...all.filter((w) => w.kind === 'user' || w.kind === 'choice'), ...all.filter((w) => w.kind !== 'user' && w.kind !== 'choice')];
  }

  async #drain() {
    if (this.#busy || this.#opens) return;
    this.#busy = true;
    this.#clearTimer();
    try {
      while (!this.#opens && this.#queue.some((w) => w.scope === this.scope)) await this.#turn(this.#take());
    } catch (e) {
      await this.#notice({ tone: 'warn', title: 'Shiori stopped', body: `Something went wrong: ${String(/** @type {any} */ (e)?.message ?? e)}` });
    } finally {
      this.#busy = false;
      this.#abort = null;
      this.#setState(this.online() ? 'sleeping' : 'offline');
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
    const via = webVia({ web, model: await this.#mainModel(), switches });
    const tools = toolList({ registry: this.registry, switches, loop: this.#loopTools }).filter((t) => !via.hide.includes(t.name));
    const providerTools = via.kinds.length ? { providerTools: { kinds: via.kinds, off: via.off } } : {};
    return { tools, via, providerTools };
  }

  /**
   * The conversation as it is sent: no photo whose bytes are gone, and the oldest photos over the
   * main models' count as stubs (spec §4.8).
   */
  async #sendable() {
    const messages = this.transcript.messages.map((m) => ({ role: m.role, parts: m.parts.filter((p) => !/** @type {any} */ (p).missing) }));
    return limitImages(messages, (await this.#mainImages()).maxCount);
  }

  /** Whether the main role's first model gets photos by upload, so they count as their id (spec §6.5). */
  async #uploading() {
    const id = (await this.llm.config()).roles?.main?.models?.[0];
    return Boolean(id && this.llm.uploading && (await this.llm.uploading(id)));
  }

  /** The main role's first model. */
  #mainModel() {
    return this.#roleModel('main');
  }

  /** A role's first model (the main role's when it has none). @param {string} role */
  async #roleModel(role) {
    const cfg = await this.llm.config();
    const id = cfg.roles?.[role]?.models?.[0] ?? cfg.roles?.main?.models?.[0];
    return id && cfg.models[id] ? modelOf(cfg.models[id]) : null;
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
    const events = (await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.scope, latest ? { after: latest.data.to } : {}))).filter((e) => e.type !== 'compaction');
    const items = [];
    for (const e of events) {
      const texts = await storedTexts(this.store, e);
      const size = JSON.stringify(e.data ?? {}).length + Object.values(texts).reduce((n, s) => n + s.length, 0);
      items.push({ seq: e.seq, tokens: Math.ceil(size / 3.5) + (e.data?.images?.length ?? 0) * 1600, exchange: e.type === 'wake' && !e.data?.meanwhile });
    }
    const cut = cutAt(items, { keepTokens, minExchanges: o.forced ? 1 : KEEP_EXCHANGES });
    if (cut === null) return false;
    const after = events.filter((e) => e.seq >= cut);
    const first = after.find((e) => e.type === 'msg.user')?.data?.text ?? after.find((e) => e.type === 'wake')?.data?.reasons?.[0]?.text ?? '';
    const marker = first ? `the exchange that begins "${first.slice(0, 80)}"` : `event ${cut}`;
    this.#setState('away', 'tidying up the conversation');
    const summary = mode === 'warm' ? await this.#warmSummary(marker, settings) : await this.#coldSummary(cut);
    if (!summary) return false;
    await record(this.store, this.scope, { type: 'compaction', actor: 'system', data: { from: this.transcript.from || 1, to: cut - 1, mode }, texts: [['summary', summary]] });
    this.transcript = await Transcript.load(this.store, this.scope);
    this.#snapshot = null;
    this.#due = false;
    return true;
  }

  /** Warm: the cached conversation, the housekeeping instruction as the tail; memory moves only. @param {string} marker @param {AgentSettings} settings */
  async #warmSummary(marker, settings) {
    const { tools, providerTools } = await this.#toolsNow();
    if (!this.#snapshot) this.#snapshot = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
    /** @type {import('../llm/contract.js').Message[]} */
    let messages = await this.#sendable();
    for (let step = 0; step < 4; step++) {
      const request = { ...buildRequest({ snapshot: this.#snapshot, tools: definitions(tools), transcript: { messages }, tail: instruction(marker), cacheTtl: settings.cacheTtl }), ...providerTools };
      const r = await this.llm.call({ role: 'main', request, scope: this.scope, prefer: this.#warmth.last?.modelId, record: { tag: 'compaction' } });
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
        await record(this.store, this.scope, { type: 'tool.result', actor: 'system', data: { id: c.id, name: c.name, ok: !out.isError, ms: 0, wake: 'housekeeping' }, texts: [['content', out.content]] });
        results.push({ type: 'tool_result', id: c.id, content: out.content, ...(out.isError ? { isError: true } : {}) });
      }
      messages = [...messages, { role: 'assistant', parts: r.reply.parts }, { role: 'user', parts: results }];
    }
    return null;
  }

  /** Cold: the utility model, from the older part as text. @param {number} cut */
  async #coldSummary(cut) {
    const old = await Transcript.load(this.store, this.scope, { before: cut });
    // Half the utility model's window, in characters, leaves room for the instructions and the summary.
    const window = (await this.#roleModel('utility'))?.contextWindow;
    const text = renderForSummary(old.messages, window ? Math.floor(window * 3.5 * 0.5) : SUMMARY_MAX_CHARS);
    const r = await this.llm.call({ role: 'utility', request: { system: COLD_SYSTEM, messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, scope: this.scope, record: { tag: 'compaction' } });
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

  /** Writes a conversation event, adds it to the transcript, and tells the screen. @param {Parameters<typeof record>[2]} ev */
  async #log(ev) {
    const stored = await record(this.store, this.scope, ev);
    this.transcript.apply(stored, await resolveEvent(this.store, stored));
    this.#emit('event', stored);
    return stored;
  }

  /** @param {Wake} w */
  #reason(w) {
    if (w.kind === 'user') return 'the user wrote';
    if (w.kind === 'choice') return 'the user tapped a choice';
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
      const others = wakes.filter((w) => w.kind !== 'user' && w.kind !== 'choice');
      if (others.length) await log({ type: 'wake', actor: 'system', data: { id: wakeId, meanwhile: true, reasons: others.map((w) => ({ kind: w.kind, text: w.text })) } });
    }
    for (const w of wakes) {
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
    const wakeId = newId('w');
    const abort = new AbortController();
    this.#abort = abort;
    await this.#logWakes(wakes, wakeId, false);
    const settings = await this.settings();
    const last = this.#warmth.last;
    const cold = !last || this.now() >= last.at + last.ttlMs - SOON_MS;
    const fresh = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
    this.#snapshot = nextSnapshot(this.#snapshot, fresh, { cold });
    // Housekeeping that came due waits for a pause; by now the cache is cold, so the utility model does it (spec §6.5).
    if (cold && this.#due && (await this.#tidyUp('cold', {}, wakeId))) this.#snapshot = nextSnapshot(null, await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality }), { cold: true });
    const reasons = wakes.map((w) => this.#reason(w));
    const stuck = new Stuck();
    let steps = 0;
    let triedCompacting = false;
    let spent = await spentToday(this.store, this.now(), this.timeZone());
    for (;;) {
      if (abort.signal.aborted) break;
      const over = budgetStop({ budgets: settings.budgets, steps, spent });
      if (over) {
        await this.#notice({ tone: 'warn', title: over.title, body: over.body });
        await this.#log({ type: 'error', actor: 'system', data: { kind: 'budget', which: over.which, wake: wakeId, message: over.body } });
        break;
      }
      // After housekeeping the prefix starts over, with a fresh snapshot (spec §6.5).
      if (!this.#snapshot) this.#snapshot = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
      const { tools, via, providerTools } = await this.#toolsNow();
      const plan = await nextPlanItems(this.ws, this.trip, this.now());
      const tail = nowBlock({ now: this.now(), timeZone: this.timeZone(), voice: 'off', online: this.online(), reasons, plan });
      const request = { ...buildRequest({ snapshot: /** @type {any} */ (this.#snapshot), tools: definitions(tools), transcript: { messages: await this.#sendable() }, tail, cacheTtl: settings.cacheTtl }), ...providerTools };
      const fingerprint = await prefixFingerprint(request, this.transcript.compaction);
      const window = (await this.#mainModel())?.contextWindow ?? null;
      const maxBytes = settings.compaction.maxRequestMiB * 2 ** 20;
      const uploaded = await this.#uploading();
      const need = compactionNeed({ tokens: Math.max(estimateTokens(request), this.#lastPrompt), window, bytes: requestBytes(request, { uploaded }), maxBytes, threshold: settings.compaction.threshold });
      if (need === 'forced') {
        // The next request would overflow: housekeeping first, warm if the cache still is (spec §6.4, §6.5).
        const warm = this.#warmth.last ? this.#warmth.state(this.#warmth.last.modelId, fingerprint, this.now()).warm : false;
        const done = await this.#tidyUp(warm ? 'warm' : 'cold', { forced: true }, wakeId);
        if (done === null) break;
        if (done) {
          this.#lastPrompt = 0;
          this.#snapshot = nextSnapshot(null, await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality }), { cold: true });
          continue;
        }
      }
      const prefer = this.#warmth.last && this.#warmth.state(this.#warmth.last.modelId, fingerprint, this.now()).warm ? this.#warmth.last.modelId : undefined;
      this.#setState('thinking');
      /** @type {any} */
      let result;
      try {
        result = await this.llm.call({
          role: 'main', request, signal: abort.signal, scope: this.scope, prefer,
          record: { tag: TALK_TAG, wake: wakeId, prefix: fingerprint.slice(0, 16), context: { from: this.transcript.from, to: this.transcript.to }, keepParts: true },
          repairImages: (/** @type {ProviderError} */ err, /** @type {string} */ modelId, /** @type {any} */ req) => this.#repair(err, modelId, req, wakeId),
        });
      } catch (e) {
        // "Request too long" from every model: compact first, then try once more (spec §9.6).
        const tooLong = e instanceof AllFailedError && e.attempts.some((a) => a.outcome === 'context' || a.outcome === 'too-long');
        if (tooLong && !triedCompacting) {
          triedCompacting = true;
          const done = await this.#tidyUp('cold', { forced: true }, wakeId);
          if (done === null) break;
          if (done) {
            this.#lastPrompt = 0;
            continue;
          }
        }
        await this.#failed(e, wakeId);
        break;
      }
      steps++;
      this.#lastPrompt = promptTokens(result.usage);
      spent += result.cost ?? 0;
      const model = await this.#model(result.modelId);
      if (model) this.#warmth.note(result.modelId, fingerprint, TTL_MS[ttlFor(model, settings.cacheTtl)], this.now());
      if (compactionNeed({ tokens: this.#lastPrompt, window: model?.contextWindow ?? null, bytes: requestBytes(request, { uploaded }), maxBytes, threshold: settings.compaction.threshold })) this.#due = true;
      await this.#applyTurn(result.reply.parts, wakeId);
      const calls = result.reply.parts.filter((/** @type {any} */ p) => p.type === 'tool_call');
      if (!calls.length) {
        if (result.reply.stop === 'pause') continue;
        break;
      }
      const sleeping = calls.some((/** @type {any} */ c) => c.name === 'sleep');
      const ordered = [...calls.filter((/** @type {any} */ c) => c.name !== 'sleep'), ...calls.filter((/** @type {any} */ c) => c.name === 'sleep')];
      let stop = false;
      for (const c of ordered) {
        const output = await this.#runCall(c, tools, { wakeId, signal: abort.signal, model, sleeping, providerOff: via.off });
        if (stuck.see(c.name, c.input, output.content)) stop = true;
      }
      if (stop) {
        await this.#notice({ tone: 'warn', title: 'Shiori stopped repeating herself', body: 'She called the same tool three times with the same result, so this turn ended. Ask again in other words.' });
        await this.#log({ type: 'error', actor: 'system', data: { kind: 'stuck', wake: wakeId, message: 'Three identical tool calls in a row with identical results.' } });
        break;
      }
      if (sleeping || abort.signal.aborted) break;
      const more = this.#take();
      if (more.length) {
        await this.#logWakes(more, wakeId, true);
        reasons.push(...more.map((w) => this.#reason(w)));
      }
    }
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
      ? (e.attempts.length ? e.attempts.map((a) => `${a.name}: ${a.error ?? a.outcome}`).join('; ') : `No model is set for the ${role} role. Add one in Settings → Models.`)
      : e instanceof ProviderError ? explain(e) : String(/** @type {any} */ (e)?.message ?? e);
  }

  /** @param {unknown} e @param {string} wakeId */
  async #failed(e, wakeId) {
    if (this.#leaving || (e instanceof ProviderError && e.kind === 'cancelled')) return;
    const body = await withoutSecrets(this.store, this.#explain(e));
    const last = e instanceof AllFailedError ? e.attempts.at(-1) : undefined;
    if (this.#photoCard === wakeId) {
      // its card already says why
    } else if (last?.outcome === 'image') await this.#cantSend(refusedText(readRefusal(last.error ?? '')), wakeId); // repairs ran out
    else await this.#notice({ tone: 'warn', title: "Shiori can't reach her model", body });
    await this.#log({ type: 'error', actor: 'system', data: { kind: 'model', wake: wakeId, message: body } });
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

  /** Adds the reply to the transcript from the model.turn the trace just wrote, or from the reply itself if that write failed. @param {any[]} parts @param {string} wakeId */
  async #applyTurn(parts, wakeId) {
    const [turn] = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(this.scope, { types: ['model.turn'], reverse: true, limit: 1 }));
    if (turn && turn.data?.wake === wakeId && turn.data?.tag === TALK_TAG && turn.data?.stored?.includes('parts')) {
      this.transcript.apply(turn, await resolveEvent(this.store, turn));
      this.#emit('event', turn);
    } else {
      this.transcript.apply({ seq: this.transcript.to + 1, type: 'model.turn', data: { tag: TALK_TAG } }, { texts: { parts: JSON.stringify(parts) }, images: [] });
    }
  }

  /**
   * Runs one tool call and records it: tool.call, then tool.result with any photo or document it
   * returned kept as blobs the event names (spec §4.9).
   * @param {any} c @param {LoopTool[]} tools @param {{ wakeId: string, signal: AbortSignal, model: any, sleeping: boolean, providerOff?: string[] }} o
   */
  async #runCall(c, tools, o) {
    const input = typeof c.input === 'object' && c.input !== null ? c.input : {};
    const inputText = JSON.stringify(input);
    await this.#log({ type: 'tool.call', actor: 'shiori', data: { id: c.id, name: c.name, wake: o.wakeId, ...(inputText.length <= 2000 ? { input } : {}) }, texts: inputText.length > 2000 ? [['input', inputText]] : [] });
    const tool = tools.find((t) => t.name === c.name);
    /** @type {import('./tools.js').ToolOutput} */
    let output;
    let ms = 0;
    if (o.signal.aborted) output = { content: STOPPED, isError: true };
    else if (!tool) output = { content: `Error: there is no tool called ${c.name}, or it is switched off.`, isError: true };
    else if (typeof c.input !== 'object' || c.input === null) output = { content: `Error: the input for ${c.name} wasn't valid JSON.`, isError: true };
    else {
      const call = {
        id: c.id, scope: this.scope, trip: this.trip, signal: o.signal, model: o.model, wake: o.wakeId, llm: this.llm, author: /** @type {const} */ ('shiori'),
        sleeping: o.sleeping, providerOff: o.providerOff ?? [], fetch: tracedFetch(this.store, this.scope, { tool: c.name, wake: o.wakeId }, this.get),
        photos: { copy: (/** @type {any} */ source, /** @type {any} */ crop) => this.#copy(source, crop) },
      };
      ({ output, ms } = await runTool(tool, input, call));
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
    const images = [];
    for (const m of output.images ?? []) images.push(await media(m));
    const document = output.document ? await media(output.document) : null;
    await this.#log({
      type: 'tool.result', actor: 'system',
      data: { id: c.id, name: c.name, ok: !output.isError, ms, wake: o.wakeId, ...(images.length ? { images } : {}), ...(document ? { document } : {}) },
      texts: [['content', output.content]], blobs,
    });
    return output;
  }

  /** The output tools (spec §7.1). @returns {LoopTool[]} */
  #talkTools() {
    const core = /** @type {const} */ ('core');
    return [
      {
        name: 'speak', pluginId: core, group: 'Talk',
        description: 'Say something to the user: a short message, as you would say it aloud. With voice off it shows as a bubble.',
        input: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
        run: async (/** @type {{ text: string }} */ i, /** @type {any} */ call) => {
          await this.#log({ type: 'out.speak', actor: 'shiori', data: { id: call.id, wake: call.wake }, texts: [['text', String(i.text ?? '')]] });
          this.#setState('speaking');
          return call.sleeping ? 'shown' : SPEAK_RESULT;
        },
      },
      {
        name: 'show', pluginId: core, group: 'Talk',
        description: 'Show the user a card: text, a place, links, a booking, a photo, or a choice of buttons.',
        input: { type: 'object', properties: { card: CARD }, required: ['card'] },
        run: async (/** @type {{ card: any }} */ i, /** @type {any} */ call) => {
          if (!i.card || typeof i.card !== 'object') throw new Error('show needs a card.');
          await this.#log({ type: 'out.show', actor: 'shiori', data: { id: call.id, wake: call.wake, card: i.card } });
          return 'shown';
        },
      },
      {
        name: 'ask', pluginId: core, group: 'Talk',
        description: 'Ask the user a question with buttons and wait for the answer: a tap, or what they type.',
        input: { type: 'object', properties: { question: { type: 'string', minLength: 1 }, options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } }, required: ['question', 'options'] },
        run: async (/** @type {{ question: string, options: string[] }} */ i, /** @type {any} */ call) => {
          // Checked here, since a model may send anything: the screen shows these as buttons.
          const options = Array.isArray(i.options) ? i.options : [];
          if (!options.length || options.length > 6 || options.some((o) => typeof o !== 'string' || !o.trim())) {
            return { content: 'Error: ask needs options: a list of 1 to 6 short texts, one per button.', isError: true };
          }
          if (typeof i.question !== 'string' || !i.question.trim()) return { content: 'Error: ask needs a question.', isError: true };
          await this.#log({ type: 'out.ask', actor: 'shiori', data: { id: call.id, wake: call.wake, question: i.question, options: i.options } });
          const got = await this.#waitFor(call.id, 'ask', 0);
          if (got.stopped) return { content: STOPPED, isError: true };
          if (got.chosen !== undefined) {
            await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.chosen]] });
            return `The user chose: ${got.chosen}`;
          }
          await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.text ?? '']] });
          return `The user wrote: ${got.text}`;
        },
      },
      {
        name: 'wait', pluginId: core, group: 'Talk',
        description: 'Keep listening for the user’s answer for a while.',
        input: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: 600 } }, required: ['seconds'] },
        run: async (/** @type {{ seconds: number }} */ i, /** @type {any} */ call) => {
          const seconds = Math.min(600, Math.max(1, Number(i.seconds) || 8));
          const got = await this.#waitFor(call.id, 'wait', seconds * this.secondMs);
          if (got.stopped) return { content: STOPPED, isError: true };
          if (got.text === undefined) return `Nothing yet (${seconds} seconds).`;
          await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.text]] });
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
   * @returns {Promise<{ text?: string, chosen?: string, stopped?: boolean }>}
   */
  #waitFor(id, kind, ms) {
    const queued = this.#queue.findIndex((w) => w.kind === 'user' && w.scope === this.scope);
    if (queued >= 0) return Promise.resolve({ text: this.#queue.splice(queued, 1)[0].text });
    this.#setState('waiting');
    if (kind === 'wait') this.state = { name: 'waiting', label: 'Your turn' };
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      this.#pending = { id, kind, resolve: (v) => { clearTimeout(timer); resolve(v); } };
      if (ms > 0) timer = setTimeout(() => {
        if (this.#pending?.id === id) this.#pending = null;
        resolve({});
      }, ms);
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
