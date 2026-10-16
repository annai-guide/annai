import { ME, newId } from '../scopes.js';
import { readAppSettings } from '../settings.js';
import { AllFailedError, estimateTokens } from '../llm/fallback.js';
import { ProviderError, explain } from '../llm/contract.js';
import { modelOf } from '../llm/config.js';
import { fromBase64 } from '../bytes.js';
import { sha256Hex } from '../hash.js';
import { record, storedTexts, TALK_TAG } from './log.js';
import { compactionNeed, cutAt, promptTokens, requestBytes, instruction, renderForSummary, COLD_SYSTEM, KEEP_EXCHANGES, WARM_LEAD_MS } from './compaction.js';
import { Transcript, resolveEvent, repair } from './transcript.js';
import { toolList, definitions, runTool, Stuck, toolSwitches } from './tools.js';
import { takeSnapshot, nextSnapshot, nowBlock, nextPlanItems, buildRequest, prefixFingerprint } from './context.js';
import { Warmth, TTL_MS, ttlFor, SOON_MS } from './warmth.js';
import { tracedFetch } from './net.js';
import { webVia } from './via.js';
import { inQuiet, quietEnds, spentToday, budgetStop } from './budgets.js';

/**
 * Shiori's loop (spec §6). Wakes go into one queue. A turn builds the context, calls the main
 * role, runs the tool calls in order (sleep last), appends the results and calls again, until she
 * sleeps, calls no tool, or something stops her. She reaches the user only through output tools
 * (§7.1); everything else she writes stays in the trace.
 * @typedef {'user' | 'choice' | 'plugin' | 'file' | 'restart' | 'personality'} WakeKind
 * @typedef {{ kind: WakeKind, text: string, plugin?: string }} Wake
 * @typedef {'sleeping' | 'thinking' | 'speaking' | 'waiting' | 'away' | 'offline'} StateName
 * @typedef {{ name: StateName, label: string, detail?: string }} State
 * @typedef {{ tone: 'warn' | 'info', title: string, body: string }} Notice
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
  /** @type {Record<string, Set<(x: any) => void>>} */
  #on = { state: new Set(), event: new Set(), notice: new Set() };

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, llm: any, registry: import('../registry.js').Registry,
   *   now?: () => number, online?: () => boolean, timeZone?: () => string, fetch?: (url: string, init?: RequestInit) => Promise<Response>, secondMs?: number,
   *   timers?: { set: (fn: () => void, ms: number) => any, clear: (handle: any) => void } }} c
   */
  constructor({ store, ws, llm, registry, now = Date.now, online = () => globalThis.navigator?.onLine !== false, timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone, fetch: get, secondMs = 1000,
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
    this.#loopTools = this.#talkTools();
  }

  /** @param {'state' | 'event' | 'notice'} kind @param {(x: any) => void} fn */
  on(kind, fn) {
    this.#on[kind].add(fn);
    return () => this.#on[kind].delete(fn);
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

  /**
   * Opens the conversation of a trip (or of "me" when none is open). A turn in progress is stopped
   * first. Tool calls left open by a crash get results, and a catch-up wake runs (spec §6.7).
   * @param {string | null} trip
   */
  async open(trip) {
    if (this.#busy) {
      this.interrupt();
      await this.idle();
    }
    this.trip = trip;
    this.scope = trip ?? ME;
    this.#snapshot = null;
    this.transcript = await Transcript.load(this.store, this.scope);
    const repaired = await repair(this.store, this.scope, this.transcript);
    if (repaired || this.transcript.unanswered) {
      this.wake({ kind: 'restart', text: repaired ? 'annai restarted while you were working, so your unfinished tool calls were stopped.' : 'annai restarted before you answered.' });
    }
  }

  /** The user typed. It answers a pending ask or wait; otherwise it wakes Shiori, or reaches her next call. @param {string} text */
  send(text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    const p = this.#pending;
    if (p) {
      this.#pending = null;
      p.resolve({ text: t });
      return;
    }
    this.#queue.push({ kind: 'user', text: t });
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
   */
  wake(w) {
    if (w.kind === 'user' || w.kind === 'choice' || w.kind === 'restart' || w.kind === 'file') {
      this.#queue.push(w);
      this.#drain();
      return;
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
        this.#emit('notice', { tone: 'info', title: 'Shiori skipped a wake', body: `${w.plugin ? `The plugin ${w.plugin}` : 'Something'} woke her more than the ${budgets.wakesPerHour} times an hour you allow: ${w.text}` });
        return;
      }
      this.#recentWakes.push(now);
      this.#queue.push(w);
      this.#drain();
    }).finally(() => {
      this.#checking--;
      if (!this.#busy && !this.#queue.length && !this.#checking) for (const fn of this.#idle.splice(0)) fn();
    });
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

  /** The queued wakes, the user's first. */
  #take() {
    const all = this.#queue.splice(0);
    return [...all.filter((w) => w.kind === 'user' || w.kind === 'choice'), ...all.filter((w) => w.kind !== 'user' && w.kind !== 'choice')];
  }

  async #drain() {
    if (this.#busy) return;
    this.#busy = true;
    if (this.#timer !== null) {
      this.timers.clear(this.#timer);
      this.#timer = null;
    }
    try {
      while (this.#queue.length) await this.#turn(this.#take());
    } catch (e) {
      this.#emit('notice', { tone: 'warn', title: 'Shiori stopped', body: `Something went wrong: ${String(/** @type {any} */ (e)?.message ?? e)}` });
    } finally {
      this.#busy = false;
      this.#abort = null;
      this.#setState(this.online() ? 'sleeping' : 'offline');
      if (!this.#checking) for (const fn of this.#idle.splice(0)) fn();
      this.#schedule();
    }
  }

  /** A due housekeeping waits for this pause, then runs warm shortly before the cache expires, or cold now (spec §6.5). */
  #schedule() {
    if (this.#timer !== null) this.timers.clear(this.#timer);
    this.#timer = null;
    if (!this.#due) return;
    const last = this.#warmth.last;
    const wait = last ? last.at + last.ttlMs - WARM_LEAD_MS - this.now() : 0;
    if (wait <= 0) this.#housekeep('cold');
    else this.#timer = this.timers.set(() => { this.#timer = null; this.#housekeep('warm'); }, wait);
  }

  /** @param {'warm' | 'cold'} mode */
  async #housekeep(mode) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.compact(mode);
    } catch (e) {
      this.#emit('notice', { tone: 'info', title: "Shiori couldn't tidy up the conversation", body: `${String(/** @type {any} */ (e)?.message ?? e)} She will try again later.` });
    } finally {
      this.#busy = false;
      this.#setState(this.online() ? 'sleeping' : 'offline');
      if (this.#queue.length) this.#drain();
      else for (const fn of this.#idle.splice(0)) fn();
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

  /** The main role's first model. */
  async #mainModel() {
    const cfg = await this.llm.config();
    const id = cfg.roles?.main?.models?.[0];
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
    let messages = this.transcript.messages;
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
    const text = renderForSummary(old.messages);
    const r = await this.llm.call({ role: 'utility', request: { system: COLD_SYSTEM, messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }, scope: this.scope, record: { tag: 'compaction' } });
    return r.reply.text.trim() || null;
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

  /** Logs wakes: a user's text as msg.user, anything else as a wake reason. @param {Wake[]} wakes @param {string} wakeId @param {boolean} meanwhile */
  async #logWakes(wakes, wakeId, meanwhile) {
    if (!meanwhile) await this.#log({ type: 'wake', actor: 'system', data: { id: wakeId, reasons: wakes.map((w) => ({ kind: w.kind, text: w.text, ...(w.plugin ? { plugin: w.plugin } : {}) })) } });
    else {
      const others = wakes.filter((w) => w.kind !== 'user' && w.kind !== 'choice');
      if (others.length) await this.#log({ type: 'wake', actor: 'system', data: { id: wakeId, meanwhile: true, reasons: others.map((w) => ({ kind: w.kind, text: w.text })) } });
    }
    for (const w of wakes) {
      if (w.kind === 'user' || w.kind === 'choice') await this.#log({ type: 'msg.user', actor: 'user', data: { wake: wakeId, ...(meanwhile ? { meanwhile: true } : {}) }, texts: [['text', w.text]] });
    }
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
    if (cold && this.#due && (await this.compact('cold'))) this.#snapshot = nextSnapshot(null, await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality }), { cold: true });
    const reasons = wakes.map((w) => this.#reason(w));
    const stuck = new Stuck();
    let steps = 0;
    let triedCompacting = false;
    let spent = await spentToday(this.store, this.now(), this.timeZone());
    for (;;) {
      if (abort.signal.aborted) break;
      const over = budgetStop({ budgets: settings.budgets, steps, spent });
      if (over) {
        this.#emit('notice', { tone: 'warn', title: over.title, body: over.body });
        await this.#log({ type: 'error', actor: 'system', data: { kind: 'budget', which: over.which, wake: wakeId, message: over.body } });
        break;
      }
      // After housekeeping the prefix starts over, with a fresh snapshot (spec §6.5).
      if (!this.#snapshot) this.#snapshot = await takeSnapshot({ ws: this.ws, registry: this.registry, trip: this.trip, personalityName: settings.personality });
      const { tools, via, providerTools } = await this.#toolsNow();
      const plan = await nextPlanItems(this.ws, this.trip, this.now());
      const tail = nowBlock({ now: this.now(), timeZone: this.timeZone(), voice: 'off', online: this.online(), reasons, plan });
      const request = { ...buildRequest({ snapshot: /** @type {any} */ (this.#snapshot), tools: definitions(tools), transcript: this.transcript, tail, cacheTtl: settings.cacheTtl }), ...providerTools };
      const fingerprint = await prefixFingerprint(request, this.transcript.compaction);
      const window = (await this.#mainModel())?.contextWindow ?? null;
      const maxBytes = settings.compaction.maxRequestMiB * 2 ** 20;
      const need = compactionNeed({ tokens: Math.max(estimateTokens(request), this.#lastPrompt), window, bytes: requestBytes(request), maxBytes, threshold: settings.compaction.threshold });
      if (need === 'forced') {
        // The next request would overflow: housekeeping first, warm if the cache still is (spec §6.4, §6.5).
        const warm = this.#warmth.last ? this.#warmth.state(this.#warmth.last.modelId, fingerprint, this.now()).warm : false;
        if (await this.compact(warm ? 'warm' : 'cold', { forced: true })) {
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
        });
      } catch (e) {
        // "Request too long" from every model: compact first, then try once more (spec §9.6).
        const tooLong = e instanceof AllFailedError && e.attempts.some((a) => a.outcome === 'context' || a.outcome === 'too-long');
        if (tooLong && !triedCompacting) {
          triedCompacting = true;
          if (await this.compact('cold', { forced: true })) {
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
      if (compactionNeed({ tokens: this.#lastPrompt, window: model?.contextWindow ?? null, bytes: requestBytes(request), maxBytes, threshold: settings.compaction.threshold })) this.#due = true;
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
        this.#emit('notice', { tone: 'warn', title: 'Shiori stopped repeating herself', body: 'She called the same tool three times with the same result, so this turn ended. Ask again in other words.' });
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

  /** @param {unknown} e @param {string} wakeId */
  async #failed(e, wakeId) {
    if (e instanceof ProviderError && e.kind === 'cancelled') return;
    const body = e instanceof AllFailedError
      ? (e.attempts.length ? e.attempts.map((a) => `${a.name}: ${a.error ?? a.outcome}`).join('; ') : 'No model is set for the main role. Add one in Settings → Models.')
      : e instanceof ProviderError ? explain(e) : String(/** @type {any} */ (e)?.message ?? e);
    this.#emit('notice', { tone: 'warn', title: "Shiori can't reach her model", body });
    await this.#log({ type: 'error', actor: 'system', data: { kind: 'model', wake: wakeId, message: body } });
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
      };
      ({ output, ms } = await runTool(tool, input, call));
    }
    /** @type {{ hash?: string, bytes?: Uint8Array, type: string }[]} */
    const blobs = [];
    const media = async (/** @type {any} */ m) => {
      if (m.hash) {
        blobs.push({ hash: m.hash, type: m.mediaType });
        return { hash: m.hash, mediaType: m.mediaType, ...(m.path ? { path: m.path } : {}), ...(m.name ? { name: m.name } : {}) };
      }
      const bytes = fromBase64(m.data);
      const hash = await sha256Hex(bytes);
      blobs.push({ hash, bytes, type: m.mediaType });
      return { hash, mediaType: m.mediaType, ...(m.name ? { name: m.name } : {}) };
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
    const queued = this.#queue.findIndex((w) => w.kind === 'user');
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
