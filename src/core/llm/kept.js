import { SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { forget as forgetHistory } from '../forget.js';
import { safeId, sameOrigin, noRedirect } from './contract.js';

/**
 * Turns a provider keeps on its side (the Gemini design, "Kept on Google's side"): a conversation's own turn is kept there,
 * and the next sends only what is new after it. annai remembers each turn's id, trip and fingerprints of what it covered,
 * never the conversation, and deletes what the provider keeps when the user removes it here (spec §4.9). Deletions wait
 * in the same file until done. The file is this device's ("This device", /llm/kept.json): no backup carries it, a
 * restore never replaces its queue, and it has no history, which would still name a removed trip's turns.
 *
 * A chain holds only while its first turn is there: Google silently drops a deleted or expired turn's content from the
 * turns after it (measured 2026-10-19). So a chain is continued only until its first turn expires, the cap takes whole
 * chains, and a turn the provider forgot takes its chain with it.
 * @typedef {import('./contract.js').Message} Message
 * @typedef {{ id: string, endpoint: string, model: string, scope: string, chain: string, since: number, ends: number, n: number, prefix: string,
 *   reply: string, at: number, days: number }} KeptTurn
 *   chain: its chain's first turn's id, kept at since, deleted by the provider at ends; n: the messages it was sent with,
 *   prefix: their fingerprint; reply: its reply's; at: when it was kept, for days
 * @typedef {{ id: string, endpoint: string, until: number }} Deletion  until: when the provider deletes it anyway
 * @typedef {{ turns: KeptTurn[], forget: Deletion[] }} KeptFile
 */

/** The most turns remembered: past it, the oldest chains are deleted whole. */
export const MAX_TURNS = 200;
const PATH = '/llm/kept.json';
const DAY = 86_400_000;
/** So close to the provider deleting it, a turn isn't continued: the request might arrive after. */
const MARGIN_MS = 3_600_000;

/** FNV-1a with two seeds in one pass: 64 bits, as hex. @param {string} s */
function hash(s) {
  let a = 0x811c9dc5;
  let b = 0x2166136a;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * A message's fingerprint as sent: words, photos (by hash), audio, documents, calls and results; heard speech by its
 * segment. What only its model reads (signed thoughts, its blocks, a call's extra) is left out. @param {Message} m
 */
export function fingerprint(m) {
  const part = (/** @type {any} */ p) => {
    if (p.heard) return `h${p.heard}`; // heard speech, as sound or its words
    if (p.type === 'text') return `t${p.text}`;
    if (p.type === 'image') return `i${p.hash ?? hash(String(p.data ?? ''))}`;
    if (p.type === 'audio' || p.type === 'document') return `${p.type[0]}${p.mediaType}${hash(String(p.data ?? ''))}`;
    if (p.type === 'tool_call') return `c${safeId(p.id)}\u0001${p.name}\u0001${JSON.stringify(p.input ?? null)}`;
    if (p.type === 'tool_result') return `r${safeId(p.id)}\u0001${p.isError ? 1 : 0}${p.content}`;
    if (p.type === 'speech') return `s${p.id}`;
    return '';
  };
  return hash(`${m.role}\u0000${m.parts.map(part).filter(Boolean).join('\u0000')}`);
}

/** Each message's fingerprint, and each prefix's (the first i messages' as one). @param {Message[]} messages */
function prints(messages) {
  const each = messages.map(fingerprint);
  const prefix = [''];
  for (const f of each) prefix.push(hash(`${prefix[prefix.length - 1]}\u0001${f}`));
  return { each, prefix };
}

/** @param {any} j @returns {KeptFile} */
const fileOf = (j) => ({ turns: Array.isArray(j?.turns) ? j.turns : [], forget: Array.isArray(j?.forget) ? j.forget : [] });
/** @param {{ at: number, days: number }} t */
const expiry = (t) => t.at + t.days * DAY;
/** An endpoint ("<provider>/<ability>") of the provider. @param {string} endpoint @param {string} provider */
const ofProvider = (endpoint, provider) => endpoint.startsWith(`${provider}/`);
/** @typedef {{ scope?: string, endpoint?: string, provider?: string }} Which  none: all */
/** @param {{ scope?: string, endpoint: string }} x @param {Which} o */
const matches = (x, o) => (!o.scope || x.scope === o.scope) && (!o.endpoint || x.endpoint === o.endpoint) && (!o.provider || ofProvider(x.endpoint, o.provider));

/** Stops remembering the turns that match, and queues their deletions, each once; how many. @param {KeptFile} f @param {(t: KeptTurn) => boolean} which */
function take(f, which) {
  const hit = f.turns.filter(which);
  const have = new Set(f.forget.map((d) => d.id));
  f.forget.push(...hit.filter((t) => !have.has(t.id)).map((t) => ({ id: t.id, endpoint: t.endpoint, until: expiry(t) })));
  f.turns = f.turns.filter((t) => !which(t));
  return hit.length;
}

export class Kept {
  /** @type {KeptFile | null} */
  #file = null;
  /** @type {Promise<unknown>} changes, one at a time */
  #lock = Promise.resolve();
  /** @type {Promise<unknown>} the drain running, if any */
  #draining = Promise.resolve();
  /** @type {Promise<{ done: number, left: number }> | null} the one waiting to run after it */
  #nextDrain = null;

  /** @param {{ ws: import('../workspace.js').Workspace, now?: () => number }} c */
  constructor({ ws, now = Date.now }) {
    this.ws = ws;
    this.now = now;
  }

  /**
   * fn on the file, one change at a time; written when changed, without what the provider has deleted by now (no call
   * needed), the oldest chains over MAX_TURNS queued. @template T @param {(f: KeptFile, now: number) => T} fn @returns {Promise<T>}
   */
  #change(fn) {
    const run = this.#lock.then(async () => {
      const f = (this.#file ??= fileOf(await this.ws.readJSON(SYS_DEVICE, PATH).catch(() => null)));
      const before = JSON.stringify(f);
      const now = this.now();
      f.turns = f.turns.filter((t) => expiry(t) > now);
      f.forget = f.forget.filter((d) => d.until > now);
      const out = fn(f, now);
      while (f.turns.length > MAX_TURNS) {
        const oldest = f.turns.reduce((a, t) => (t.since < a.since ? t : a)).chain;
        take(f, (t) => t.chain === oldest);
      }
      if (JSON.stringify(f) !== before) {
        await ensureDeviceScope(this.ws.store, now);
        await this.ws.write(SYS_DEVICE, PATH, f, { author: 'system' });
        await forgetHistory(this.ws.store, SYS_DEVICE, { history: (p) => p === PATH });
      }
      return out;
    });
    this.#lock = run.catch(() => {});
    return run;
  }

  /**
   * The kept turn a request continues: the longest whose messages begin it, then its reply, then something new, in the same
   * trip on the same endpoint, while its chain's first turn is there. @param {string} endpointId @param {Message[]} messages as sent
   * @param {{ free: boolean, keepDays: number, scope: string }} o free: kept a day @returns {Promise<{ id: string, from: number } | null>} from: the first to send
   */
  match(endpointId, messages, { free, keepDays, scope }) {
    return this.#change((f, now) => {
      const days = free ? 1 : keepDays;
      /** @type {ReturnType<typeof prints> | null} */
      let p = null;
      /** @type {KeptTurn | null} */
      let best = null;
      for (const t of f.turns) {
        if (t.endpoint !== endpointId || t.scope !== scope || t.n + 1 >= messages.length) continue;
        if (Math.min(t.ends, t.since + days * DAY) - MARGIN_MS <= now) continue;
        p ??= prints(messages);
        if (p.prefix[t.n] !== t.prefix || p.each[t.n] !== t.reply) continue;
        if (!best || t.n > best.n || (t.n === best.n && t.at > best.at)) best = t;
      }
      return best ? { id: best.id, from: best.n + 1 } : null;
    });
  }

  /**
   * A turn the provider kept, in the chain of the one it continued (after), else a chain's first. One whose chain went
   * meanwhile has lost what came before it, so it is deleted.
   * @param {{ id: string, endpoint: string, model: string, scope: string, messages: Message[], reply: Message, days: number, after?: string }} t
   *   messages: as sent, the whole conversation; days: how long the provider keeps it
   */
  record({ id, endpoint, model, scope, messages, reply, days, after }) {
    return this.#change((f, now) => {
      const prev = after ? f.turns.find((t) => t.id === after) : undefined;
      f.turns = f.turns.filter((t) => t.id !== id);
      if (after && !prev) return void f.forget.push({ id, endpoint, until: now + days * DAY });
      f.turns.push({
        id, endpoint, model, scope, chain: prev?.chain ?? id, since: prev?.since ?? now, ends: prev?.ends ?? now + days * DAY,
        n: messages.length, prefix: prints(messages).prefix[messages.length], reply: fingerprint(reply), at: now, days,
      });
    });
  }

  /** A turn the provider no longer has: its chain is no use now, so it goes, the rest of it deleted. @param {string} id */
  forget(id) {
    return this.#change((f) => {
      const chain = f.turns.find((t) => t.id === id)?.chain;
      if (chain === undefined) return;
      take(f, (t) => t.chain === chain);
      f.forget = f.forget.filter((d) => d.id !== id);
    });
  }

  /** A turn the provider kept for a call that then failed: deleted. @param {string} id @param {string} endpoint @param {number} days */
  discard(id, endpoint, days) {
    return this.#change((f, now) => {
      if (!f.forget.some((d) => d.id === id)) f.forget.push({ id, endpoint, until: now + days * DAY });
    });
  }

  /** Queues the deletion of the turns that match; how many. @param {Which} [o] */
  queue(o = {}) {
    return this.#change((f) => take(f, (t) => matches(t, o)));
  }

  /** Forgets a provider's turns and deletions without a call: its key is going. @param {string} provider */
  drop(provider) {
    return this.#change((f) => {
      f.turns = f.turns.filter((t) => !ofProvider(t.endpoint, provider));
      f.forget = f.forget.filter((d) => !ofProvider(d.endpoint, provider));
    });
  }

  /** Turns kept and deletions waiting, when the last expires (ms, 0: none), and their endpoints. @param {Which} [o] */
  count(o = {}) {
    return this.#change((f) => {
      const turns = f.turns.filter((t) => matches(t, o));
      const waiting = o.scope ? [] : f.forget.filter((d) => matches(d, o));
      return { turns: turns.length, waiting: waiting.length, until: Math.max(0, ...turns.map(expiry), ...waiting.map((d) => d.until)), endpoints: [...new Set([...turns, ...waiting].map((x) => x.endpoint))] };
    });
  }

  /**
   * Sends the deletions that wait, one at a time; one asked for meanwhile runs once after. A 200 or 404 is done; another
   * answer, or none, leaves it and the rest of its endpoint's for next time. First a turn whose trip is gone is queued (a
   * call that ended after its trip went); a provider that is gone takes its deletions with it.
   * @param {{ resolve: (endpointId: string) => Promise<{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, key: string | null } | 'gone' | null>,
   *   fetch: (url: string, init: RequestInit) => Promise<Response>, scopes?: () => Promise<Set<string>>, signal?: AbortSignal,
   *   trace?: ReturnType<typeof import('./trace.js').modelTrace> }} c resolve: as calls see it; null: its type isn't running
   * @returns {Promise<{ done: number, left: number }>}
   */
  drain(c) {
    if (this.#nextDrain) return this.#nextDrain;
    const run = this.#draining.then(() => {
      this.#nextDrain = null;
      return this.#drainOnce(c);
    });
    this.#nextDrain = run;
    this.#draining = run.catch(() => {});
    return run;
  }

  /** @param {Parameters<Kept['drain']>[0]} c */
  async #drainOnce({ resolve, fetch, scopes, signal, trace }) {
    if (scopes) {
      const here = await scopes();
      await this.#change((f) => take(f, (t) => !here.has(t.scope)));
    }
    const list = await this.#change((f) => f.forget.slice());
    /** @type {Set<string>} */
    const done = new Set();
    /** @type {Set<string>} endpoints left for next time */
    const later = new Set();
    /** @type {Map<string, Awaited<ReturnType<typeof resolve>>>} */
    const known = new Map();
    for (const d of list) {
      if (signal?.aborted) break;
      if (later.has(d.endpoint)) continue;
      if (!known.has(d.endpoint)) known.set(d.endpoint, await resolve(d.endpoint).catch(() => null));
      const to = known.get(d.endpoint);
      if (to === 'gone') {
        done.add(d.id);
        continue;
      }
      if (!to?.type.forgetRequest) {
        later.add(d.endpoint);
        continue;
      }
      if (to.key) trace?.secret(to.key);
      const r = to.type.forgetRequest({ endpoint: to.endpoint, key: to.key, id: d.id });
      const started = this.now();
      let status = 0;
      try {
        sameOrigin(to.endpoint, r.url);
        const res = await fetch(r.url, { method: r.method, headers: r.headers, redirect: 'manual', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]) });
        status = res.status;
        noRedirect(res, to.endpoint);
        if (res.ok || res.status === 404) done.add(d.id);
        else later.add(d.endpoint);
      } catch {
        later.add(d.endpoint);
      }
      // In the trace as every request is (spec §9.8), named without the turn's id.
      await trace?.request({ kind: 'forget', endpoint: to.endpoint.name, model: '', providerModel: '', url: r.url.replace(encodeURIComponent(d.id), '…'), status, ms: this.now() - started, firstMs: null, outcome: done.has(d.id) ? 'ok' : 'waiting', usage: null });
    }
    return this.#change((f) => {
      f.forget = f.forget.filter((d) => !done.has(d.id));
      return { done: done.size, left: f.forget.length };
    });
  }
}

