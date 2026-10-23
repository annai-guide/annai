import { SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { forget as forgetHistory } from '../forget.js';
import { sha256Hex } from '../hash.js';
import { safeId, sameOrigin, noRedirect } from './contract.js';
import { anySignal } from '../signals.js';

/**
 * Turns a provider keeps (the Gemini design): a conversation's turn is kept there, and the next sends only what is new.
 * annai remembers each by id, trip and fingerprints, never content, and deletes it when the user removes it (spec §4.9).
 * The file is this device's ("This device", /llm/kept.json), without history, which would name a removed trip's turns.
 *
 * Each turn is tracked as long as the provider may keep one (its type's days), and a chain continued only its type's
 * hours after its first turn: Google silently drops a deleted or expired turn's content from the turns after it
 * (measured 2026-10-19). So too the cap takes whole chains.
 *
 * Under one lock a turn is kept only if it still may be (alive, as things are now), else its call deletes it at once,
 * with its own key; a removal changes that state first, then queues. A turn is deleted only with its key and address (key).
 * @typedef {import('./contract.js').Message} Message
 * @typedef {{ id: string, endpoint: string, scope: string, key: string, chain: string, ends: number, n: number, prefix: string, reply: string, until: number, model?: string, began?: number }} KeptTurn
 *   chain: its first turn's id, continued until ends; n: messages sent, prefix: their fingerprint; until: when it expires;
 *   model: the model that made it, for a provider whose turns only that model continues (OpenAI's); began: when its chain's first turn was made
 * @typedef {{ id: string, endpoint: string, key: string, until: number }} Deletion
 * @typedef {{ id: string, endpoint: string, scope: string, key: string, until: number, at: number }} Pending
 *   a turn the provider has named and its call hasn't settled: written down at once, so a page closed meanwhile still knows it
 * @typedef {{ turns: KeptTurn[], forget: Deletion[], pending: Pending[] }} KeptFile
 * @typedef {{ scope?: string, endpoint?: string, provider?: string | string[] }} Which  none: all
 */

export const MAX_TURNS = 200;
const PATH = '/llm/kept.json';
const HOUR = 3_600_000;
/** A pending turn older than this has no call left that could settle it (a page closed meanwhile): it is deleted at the next drain. */
export const PENDING_MS = 15 * 60_000;

/** FNV-1a, two seeds in one pass: 64 bits as hex. @param {string} s */
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
 * A key and address's fingerprint, never the key. The endpoint's extra headers count too when it has any (OpenAI's project and
 * organization scope what a key stores and deletes); without them the print is what it was. @param {string | null} secret
 * @param {string} baseUrl @param {Record<string, string>} [headers]
 */
export const keyPrint = async (secret, baseUrl, headers = {}) => {
  const extra = Object.entries(headers ?? {}).map(([k, v]) => `${k.toLowerCase()}:${v}`).sort().join('\n');
  return (await sha256Hex(`${baseUrl.replace(/\/+$/, '')}\n${secret ?? ''}${extra ? `\n${extra}` : ''}`)).slice(0, 16);
};

/**
 * Who keeps a provider's turns, in the words the provider page and the warnings use: the protocol's own (keeps.name, holds, note)
 * for the provider it names (keeps.provider), else the provider's own name and no claim about how long, as a server that only
 * speaks the protocol may keep nothing. holds: null where the page says it by key (Gemini's free and paid).
 * @param {{ name?: string, days?: number, hours?: number, provider?: string, holds?: string, note?: string } | undefined} keeps @param {string} plugin the provider's plugin @param {string} providerName
 * @returns {{ name: string, holds: string | null, note: string }}
 */
export function keeperOf(keeps, plugin, providerName) {
  const own = Boolean(keeps) && (!keeps?.provider || keeps.provider === plugin);
  return {
    name: own ? keeps?.name ?? providerName : providerName,
    holds: keeps?.holds ? (own ? keeps.holds : 'as long as that server keeps them') : null,
    note: own ? keeps?.note ?? '' : '',
  };
}

/**
 * A message's fingerprint as sent: words, photos (by hash), audio, documents, calls and results; heard speech by its
 * segment. What only its model reads (signed thoughts, its blocks, a call's extra) is left out. @param {Message} m
 */
export function fingerprint(m) {
  const part = (/** @type {any} */ p) => {
    if (p.heard) return `h${p.heard}`;
    if (p.type === 'text') return `t${p.text}`;
    if (p.type === 'image') return `i${p.hash ?? hash(String(p.data ?? ''))}`;
    if (p.type === 'audio' || p.type === 'document') return `${p.type[0]}${p.mediaType}${hash(String(p.data ?? ''))}`;
    if (p.type === 'tool_call') return `c${safeId(p.id)}\u0001${p.name}\u0001${JSON.stringify(p.input ?? null)}`;
    if (p.type === 'tool_result') return `r${safeId(p.id)}\u0001${p.isError ? 1 : 0}${p.content}`;
    return '';
  };
  return hash(`${m.role}\u0000${m.parts.map(part).filter(Boolean).join('\u0000')}`);
}

/** Each message's fingerprint, and each prefix's. @param {Message[]} messages */
function prints(messages) {
  const each = messages.map(fingerprint);
  const prefix = [''];
  for (const f of each) prefix.push(hash(`${prefix[prefix.length - 1]}\u0001${f}`));
  return { each, prefix };
}

/** An endpoint ("<provider>/<ability>") of the provider. @param {string} endpoint @param {string} provider */
const ofProvider = (endpoint, provider) => endpoint.startsWith(`${provider}/`);
/** @param {{ scope?: string, endpoint: string }} x @param {Which} o */
const matches = (x, o) => (!o.scope || x.scope === o.scope) && (!o.endpoint || x.endpoint === o.endpoint) && (!o.provider || [o.provider].flat().some((p) => ofProvider(x.endpoint, p)));

/** Queues the deletions of the turns that match, each once; how many. @param {KeptFile} f @param {(t: KeptTurn) => boolean} which @param {Set<string>} [owned] pending ids a call still answers */
function take(f, which, owned = new Set()) {
  const hit = f.turns.filter(which);
  for (const t of hit) wait(f, t);
  f.turns = f.turns.filter((t) => !which(t));
  // A turn named but not settled goes too, unless a call of this process still answers it: that call deletes it itself.
  for (const p of f.pending.filter((x) => !owned.has(x.id) && which(/** @type {any} */ (x)))) wait(f, p);
  return hit.length;
}

/** Queues one deletion, once. @param {KeptFile} f @param {Deletion} d */
function wait(f, { id, endpoint, key, until }) {
  if (!f.forget.some((x) => x.id === id)) f.forget.push({ id, endpoint, key, until });
  f.pending = f.pending.filter((x) => x.id !== id);
}

export class Kept {
  /** @type {KeptFile | null} */
  #file = null;
  /** @type {Promise<unknown>} */
  #lock = Promise.resolve();
  /** @type {Promise<unknown>} */
  #draining = Promise.resolve();
  /** @type {Promise<{ done: number, left: number }> | null} */
  #nextDrain = null;
  /** Endpoints a 429 rests, until when. @type {Map<string, number>} */
  #rest = new Map();
  /** Pending ids whose call, in this process, is still answering: a drain leaves them to it. @type {Set<string>} */
  #live = new Set();
  /** Endpoints whose server ignored the turn it was told to continue: nothing is kept there until annai starts again. @type {Set<string>} */
  #off = new Set();

  /** @param {{ ws: import('../workspace.js').Workspace, now?: () => number, alive?: (t: { endpoint: string, scope: string, key: string }) => Promise<boolean> }} c */
  constructor({ ws, now = Date.now, alive = async () => true }) {
    this.ws = ws;
    this.now = now;
    this.alive = alive;
  }

  /** fn on the file, under the lock; written when changed, less what expired, the oldest chains over MAX_TURNS queued. @template T @param {(f: KeptFile, now: number) => T | Promise<T>} fn @returns {Promise<T>} */
  #change(fn) {
    const run = this.#lock.then(async () => {
      const j = this.#file ? null : await this.ws.readJSON(SYS_DEVICE, PATH).catch(() => null);
      const f = (this.#file ??= { turns: Array.isArray(j?.turns) ? j.turns : [], forget: Array.isArray(j?.forget) ? j.forget : [], pending: Array.isArray(j?.pending) ? j.pending : [] });
      const before = JSON.stringify(f);
      const now = this.now();
      f.turns = f.turns.filter((t) => t.until > now);
      f.forget = f.forget.filter((d) => d.until > now);
      f.pending = f.pending.filter((p) => p.until > now);
      const out = await fn(f, now);
      while (f.turns.length > MAX_TURNS) {
        const oldest = f.turns.reduce((a, t) => (t.ends < a.ends ? t : a)).chain;
        take(f, (t) => t.chain === oldest);
      }
      if (JSON.stringify(f) !== before) {
        try {
          await ensureDeviceScope(this.ws.store, now);
          await this.ws.write(SYS_DEVICE, PATH, f, { author: 'system' });
          await forgetHistory(this.ws.store, SYS_DEVICE, { history: (p) => p === PATH });
        } catch (e) {
          this.#file = null;
          throw e;
        }
      }
      return out;
    });
    this.#lock = run.catch(() => {});
    return run;
  }

  /**
   * The kept turn a request continues: the longest whose messages begin it, then its reply, then something new, same
   * trip, endpoint and key, its chain still continued; and its model, where the provider's turns are its model's alone.
   * @param {string} endpointId @param {Message[]} messages as sent
   * @param {{ scope: string, key: string, model?: string, borrow?: boolean }} o borrow: warm housekeeping, which may continue the turn the conversation ends with @returns {Promise<{ id: string, from: number } | null>} from: the first to send
   */
  match(endpointId, messages, { scope, key, model, borrow = false }) {
    return this.#change((f, now) => {
      /** @type {ReturnType<typeof prints> | null} */
      let p = null;
      /** @type {KeptTurn | null} */
      let best = null;
      for (const t of f.turns) {
        if (t.endpoint !== endpointId || t.scope !== scope || t.key !== key || t.model !== model || t.n + 1 > messages.length || (t.n + 1 === messages.length && !borrow) || t.ends <= now) continue;
        p ??= prints(messages);
        if (p.prefix[t.n] !== t.prefix || p.each[t.n] !== t.reply) continue;
        if (!best || t.n > best.n || (t.n === best.n && t.until > best.until)) best = t;
      }
      return best ? { id: best.id, from: best.n + 1 } : null;
    });
  }

  /**
   * A turn the provider kept, in the chain it continued (after). 'now': its call deletes it instead (it failed or was
   * refused, it may not be kept now, or its chain went). @param {{ id: string, endpoint: string, scope: string, key: string, days: number,
   *   messages?: Message[], reply?: Message, hours?: number, after?: string, model?: string, limit?: number }} t
   *   limit: when the chain must end at the latest (the earliest expiry of a photo it points at), carried down the chain @returns {Promise<'kept' | 'now'>}
   */
  record({ id, endpoint, scope, key, days, messages, reply, hours = 0, after, model, limit }) {
    return this.#change(async (f, now) => {
      const prev = after ? f.turns.find((t) => t.id === after) : undefined;
      if (!messages || !reply || (after && !prev) || !(await this.alive({ endpoint, scope, key }))) return 'now';
      f.turns = f.turns.filter((t) => t.id !== id);
      f.pending = f.pending.filter((p) => p.id !== id);
      f.turns.push({ id, endpoint, scope, key, chain: prev?.chain ?? id, ends: Math.min(prev?.ends ?? now + hours * HOUR, limit ?? Infinity), began: prev?.began ?? now, n: messages.length, prefix: prints(messages).prefix[messages.length], reply: fingerprint(reply), until: now + days * 24 * HOUR, ...(model ? { model } : {}) });
      return 'kept';
    });
  }

  /**
   * A turn the provider has named, written down before its call ends. record() replaces it; a call that can't settle it leaves it
   * for the next drain to delete once no call could still be answering. @param {{ id: string, endpoint: string, scope: string, key: string, days: number }} t
   */
  pending({ id, endpoint, scope, key, days }) {
    this.#live.add(id);
    return this.#change((f, now) => {
      f.pending = f.pending.filter((p) => p.id !== id);
      f.pending.push({ id, endpoint, scope, key, until: now + days * 24 * HOUR, at: now });
    });
  }

  /** Its call has ended (settled, deleted or queued): a drain may now take its pending record if it is still there. @param {string} id */
  ended(id) {
    this.#live.delete(id);
  }

  /** Queues the deletion of every pending turn, a call's own too (Erase: nothing is left to settle it after the wipe). */
  release() {
    return this.#change((f) => { for (const p of f.pending.slice()) wait(f, p); });
  }

  /** How long ago the chain a turn is in began, ms; Infinity where it isn't known. @param {string} id */
  ageOf(id) {
    return this.#change((f, now) => {
      const began = f.turns.find((t) => t.id === id)?.began;
      return began === undefined ? Infinity : now - began;
    });
  }

  /** A pending turn its call deleted: nothing is left to track. @param {string} id */
  done(id) {
    return this.#change((f) => { f.pending = f.pending.filter((p) => p.id !== id); });
  }

  /** The server ignored a turn it was told to continue: nothing is kept at this endpoint until annai starts again. @param {string} endpointId */
  off(endpointId) {
    this.#off.add(endpointId);
  }

  /** @param {string} endpointId */
  isOff(endpointId) {
    return this.#off.has(endpointId);
  }

  /** A turn its call couldn't delete: queued. @param {{ id: string, endpoint: string, key: string, days: number }} t */
  wait({ id, endpoint, key, days }) {
    return this.#change((f, now) => wait(f, { id, endpoint, key, until: now + days * 24 * HOUR }));
  }

  /** A turn forgot (drop) or whose chained call was refused: its chain goes, deleted. @param {string} id @param {boolean} drop */
  forget(id, drop) {
    return this.#change((f) => {
      const chain = f.turns.find((t) => t.id === id)?.chain;
      if (chain !== undefined) take(f, (t) => t.chain === chain);
      if (drop) f.forget = f.forget.filter((d) => d.id !== id);
    });
  }

  /** Queues the deletion of the turns that match; how many. @param {Which} [o] */
  queue(o = {}) {
    return this.#change((f) => take(f, (t) => matches(t, o), this.#live));
  }

  /** Lets go of a provider's turns and deletions: its key or address changed, or it went. @param {string} provider */
  drop(provider) {
    return this.#change((f) => {
      f.turns = f.turns.filter((t) => !ofProvider(t.endpoint, provider));
      f.forget = f.forget.filter((d) => !ofProvider(d.endpoint, provider));
      f.pending = f.pending.filter((p) => !ofProvider(p.endpoint, provider));
    });
  }

  /** Turns kept (also those named and not yet settled), deletions waiting, when the last expires (0: none), their endpoints. @param {Which} [o] */
  count(o = {}) {
    return this.#change((f) => {
      // A turn named and not yet settled counts: it is at the provider all the same.
      const turns = [...f.turns, ...f.pending].filter((t) => matches(t, o));
      const waiting = o.scope ? [] : f.forget.filter((d) => matches(d, o));
      return { turns: turns.length, waiting: waiting.length, until: Math.max(0, ...[...turns, ...waiting].map((x) => x.until)), endpoints: [...new Set([...turns, ...waiting].map((x) => x.endpoint))] };
    });
  }

  /**
   * Sends the deletions waiting, one at a time (one asked meanwhile runs after), each only with its key. A 200 or 404 is
   * done; else it waits, a 429 resting its endpoint (a minute, or as asked), no answer the rest of its endpoint's.
   * First, turns whose trip is gone are queued.
   * @param {{ resolve: (endpointId: string) => Promise<{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, key: string | null, print: string } | null>,
   *   fetch: (url: string, init: RequestInit) => Promise<Response>, scopes?: () => Promise<Set<string>>, signal?: AbortSignal,
   *   trace?: ReturnType<typeof import('./trace.js').modelTrace> }} c resolve: as calls see it now; null: not now
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
      await this.#change((f) => take(f, (t) => !here.has(t.scope), this.#live));
    }
    // A turn named but never settled, long enough ago that no call could still be answering: deleted like the rest.
    await this.#change((f, now) => { for (const p of f.pending.filter((x) => x.at + PENDING_MS <= now && !this.#live.has(x.id))) wait(f, p); });
    const list = await this.#change((f) => f.forget.slice());
    /** @type {Set<string>} */
    const done = new Set();
    /** @type {Map<string, Awaited<ReturnType<typeof resolve>>>} */
    const known = new Map();
    for (const d of list) {
      if (signal?.aborted) break;
      if ((this.#rest.get(d.endpoint) ?? 0) > this.now()) continue;
      if (!known.has(d.endpoint)) known.set(d.endpoint, await resolve(d.endpoint).catch(() => null));
      const to = known.get(d.endpoint);
      if (!to || to.print !== d.key) continue;
      const res = await deleteTurn({ ...to, id: d.id, fetch, signal, trace, now: this.now });
      if (res.done) done.add(d.id);
      else if (res.status === 429) this.#rest.set(d.endpoint, this.now() + (res.retryAfter ?? 60_000));
      else if (!res.status) known.set(d.endpoint, null);
    }
    return this.#change((f) => {
      f.forget = f.forget.filter((d) => !done.has(d.id));
      return { done: done.size, left: f.forget.length };
    });
  }
}

/**
 * One kept turn's deletion, traced as every request is (spec §9.8), without its id: done on a 200 or 404.
 * @param {{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, key: string | null, id: string,
 *   fetch: (url: string, init: RequestInit) => Promise<Response>, signal?: AbortSignal, trace?: ReturnType<typeof import('./trace.js').modelTrace>, now: () => number }} c
 * @returns {Promise<{ done: boolean, status: number, retryAfter?: number }>}
 */
export async function deleteTurn({ type, endpoint, key, id, fetch, signal, trace, now }) {
  if (!type.forgetRequest) return { done: false, status: 0 };
  if (key) trace?.secret(key);
  const r = type.forgetRequest({ endpoint, key, id });
  const started = now();
  let status = 0;
  /** @type {number | undefined} */
  let retryAfter;
  try {
    sameOrigin(endpoint, r.url);
    const res = await fetch(r.url, { method: r.method, headers: r.headers, redirect: 'manual', signal: anySignal([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]) });
    status = res.status;
    retryAfter = Number(res.headers.get('retry-after')) * 1000 || undefined;
    noRedirect(res, endpoint);
  } catch {
    // no answer: it waits
  }
  const done = (status >= 200 && status < 300) || status === 404;
  await trace?.request({ kind: 'forget', endpoint: endpoint.name, model: '', providerModel: '', url: r.url.replace(encodeURIComponent(id), '…'), status, ms: now() - started, firstMs: null, outcome: done ? 'ok' : 'waiting', usage: null });
  return { done, status, ...(retryAfter ? { retryAfter } : {}) };
}

/**
 * Whether the provider has a kept turn: its look-up (the protocol's lookRequest), traced like a deletion without the id. 'there' on a
 * 200, 'gone' on a 404, 'unknown' on anything else or no answer.
 * @param {{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, key: string | null, id: string,
 *   fetch: (url: string, init: RequestInit) => Promise<Response>, signal?: AbortSignal, trace?: ReturnType<typeof import('./trace.js').modelTrace>, now: () => number, missing?: string }} c
 * missing: what the Trace says when it isn't there
 * @returns {Promise<'there' | 'gone' | 'unknown'>}
 */
export async function lookTurn({ type, endpoint, key, id, fetch, signal, trace, now, missing }) {
  if (!type.lookRequest) return 'unknown';
  if (key) trace?.secret(key);
  const r = type.lookRequest({ endpoint, key, id });
  const started = now();
  let status = 0;
  try {
    sameOrigin(endpoint, r.url);
    const res = await fetch(r.url, { method: 'GET', headers: r.headers, redirect: 'manual', signal: anySignal([signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) });
    status = res.status;
    noRedirect(res, endpoint);
  } catch {
    // no answer
  }
  const found = status >= 200 && status < 300 ? 'there' : status === 404 ? 'gone' : 'unknown';
  await trace?.request({ kind: 'look', endpoint: endpoint.name, model: '', providerModel: '', url: r.url.replace(encodeURIComponent(id), '…'), status, ms: now() - started, firstMs: null, outcome: found === 'unknown' ? 'waiting' : 'ok', usage: null, ...(found === 'gone' && missing ? { error: missing } : {}) });
  return found;
}
