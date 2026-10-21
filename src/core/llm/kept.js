import { SYS_DEVICE, ensureDeviceScope } from '../scopes.js';
import { forget as forgetHistory } from '../forget.js';
import { safeId, sameOrigin, noRedirect } from './contract.js';

/**
 * Turns a provider keeps on its side (the Gemini design): a conversation's turn is kept there, and the next sends only
 * what is new. annai remembers each by id, trip and fingerprints, never content, and deletes it when the user removes
 * it here (spec §4.9); deletions wait in the same file. It is this device's ("This device", /llm/kept.json): no backup
 * carries it, a restore never replaces it, and it has no history, which would name a removed trip's turns.
 *
 * Two lifetimes, whatever a key is marked: each turn is tracked as long as the provider may keep one (its type's days),
 * and a chain is continued only its type's hours after its first turn, as Google silently drops a deleted or expired
 * turn's content from the turns after it (measured 2026-10-19). So too the cap takes whole chains, and a forgotten turn its chain.
 *
 * A removal can race a call: a turn kept after a removal that covers it, begun after the call's mark (or lasting), is
 * deleted, at once with the call's key when its provider or everything goes.
 * @typedef {import('./contract.js').Message} Message
 * @typedef {{ id: string, endpoint: string, scope: string, chain: string, ends: number, n: number, prefix: string, reply: string, until: number }} KeptTurn
 *   chain: its first turn's id, continued until ends; n: messages sent, prefix: their fingerprint, reply: its reply's;
 *   until: when the provider has deleted it anyway
 * @typedef {{ turns: KeptTurn[], forget: { id: string, endpoint: string, until: number }[] }} KeptFile
 * @typedef {{ scope?: string, endpoint?: string, provider?: string }} Which  none: all
 * @typedef {'kept' | 'queued' | 'now'} Settled  now: delete it at once, with the call's key
 */

export const MAX_TURNS = 200;
const PATH = '/llm/kept.json';
const HOUR = 3_600_000;

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
const matches = (x, o) => (!o.scope || x.scope === o.scope) && (!o.endpoint || x.endpoint === o.endpoint) && (!o.provider || ofProvider(x.endpoint, o.provider));

/** Queues the deletions of the turns that match, each once; how many. @param {KeptFile} f @param {(t: KeptTurn) => boolean} which */
function take(f, which) {
  const hit = f.turns.filter(which);
  const have = new Set(f.forget.map((d) => d.id));
  f.forget.push(...hit.filter((t) => !have.has(t.id)).map((t) => ({ id: t.id, endpoint: t.endpoint, until: t.until })));
  f.turns = f.turns.filter((t) => !which(t));
  return hit.length;
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
  /** @type {{ which: Which, end: number }[]} */
  #removals = [];
  #seq = 0;
  /** Endpoints a 429 rests, until when. @type {Map<string, number>} */
  #rest = new Map();

  /** @param {{ ws: import('../workspace.js').Workspace, now?: () => number }} c */
  constructor({ ws, now = Date.now }) {
    this.ws = ws;
    this.now = now;
  }

  /** fn on the file, one at a time; written when changed, less what expired, the oldest chains over MAX_TURNS queued. @template T @param {(f: KeptFile, now: number) => T} fn @returns {Promise<T>} */
  #change(fn) {
    const run = this.#lock.then(async () => {
      const j = this.#file ? null : await this.ws.readJSON(SYS_DEVICE, PATH).catch(() => null);
      const f = (this.#file ??= { turns: Array.isArray(j?.turns) ? j.turns : [], forget: Array.isArray(j?.forget) ? j.forget : [] });
      const before = JSON.stringify(f);
      const now = this.now();
      f.turns = f.turns.filter((t) => t.until > now);
      f.forget = f.forget.filter((d) => d.until > now);
      const out = fn(f, now);
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

  /** A call's mark, as it starts. */
  mark() {
    return this.#seq;
  }

  /** A removal begins; it lasts until the function it gives is called. @param {Which} [which] none: everything @returns {() => void} */
  removing(which = {}) {
    const r = { which, end: Infinity };
    this.#seq++;
    this.#removals.push(r);
    return () => { r.end = ++this.#seq; };
  }

  /**
   * The kept turn a request continues: the longest whose messages begin it, then its reply, then something new, same
   * trip and endpoint, its chain still continued. @param {string} endpointId @param {Message[]} messages as sent
   * @param {{ scope: string }} o @returns {Promise<{ id: string, from: number } | null>} from: the first to send
   */
  match(endpointId, messages, { scope }) {
    return this.#change((f, now) => {
      /** @type {ReturnType<typeof prints> | null} */
      let p = null;
      /** @type {KeptTurn | null} */
      let best = null;
      for (const t of f.turns) {
        if (t.endpoint !== endpointId || t.scope !== scope || t.n + 1 >= messages.length || t.ends <= now) continue;
        p ??= prints(messages);
        if (p.prefix[t.n] !== t.prefix || p.each[t.n] !== t.reply) continue;
        if (!best || t.n > best.n || (t.n === best.n && t.until > best.until)) best = t;
      }
      return best ? { id: best.id, from: best.n + 1 } : null;
    });
  }

  /**
   * A turn the provider kept, in the chain of the one it continued (after). Deleted instead: one without messages (its
   * call failed or was refused), one whose chain went meanwhile (it lost what came before), one a removal since its call's
   * mark covers: at once with the call's key ('now') when its provider or everything is going.
   * @param {{ id: string, endpoint: string, scope: string, days: number, mark: number, messages?: Message[], reply?: Message, hours?: number, after?: string }} t
   * @returns {Promise<Settled>}
   */
  record({ id, endpoint, scope, days, mark, messages, reply, hours = 0, after }) {
    return this.#change((f, now) => {
      const until = now + days * 24 * HOUR;
      const r = this.#removals.find((x) => mark < x.end && matches({ endpoint, scope }, x.which));
      if (r && (r.which.provider || !(r.which.scope || r.which.endpoint))) return 'now';
      const prev = after ? f.turns.find((t) => t.id === after) : undefined;
      f.turns = f.turns.filter((t) => t.id !== id);
      if (r || !messages || !reply || (after && !prev)) {
        if (!f.forget.some((d) => d.id === id)) f.forget.push({ id, endpoint, until });
        return 'queued';
      }
      f.turns.push({ id, endpoint, scope, chain: prev?.chain ?? id, ends: prev?.ends ?? now + hours * HOUR, n: messages.length, prefix: prints(messages).prefix[messages.length], reply: fingerprint(reply), until });
      return 'kept';
    });
  }

  /** A turn the provider forgot: its chain goes, the rest deleted. @param {string} id */
  forget(id) {
    return this.#change((f) => {
      const chain = f.turns.find((t) => t.id === id)?.chain;
      if (chain === undefined) return;
      take(f, (t) => t.chain === chain);
      f.forget = f.forget.filter((d) => d.id !== id);
    });
  }

  /** Queues the deletion of the turns that match; how many. @param {Which} [o] */
  queue(o = {}) {
    return this.#change((f) => take(f, (t) => matches(t, o)));
  }

  /** Lets go of a provider's turns and deletions: the key that made them is going. @param {string} provider */
  drop(provider) {
    return this.#change((f) => {
      f.turns = f.turns.filter((t) => !ofProvider(t.endpoint, provider));
      f.forget = f.forget.filter((d) => !ofProvider(d.endpoint, provider));
    });
  }

  /** Turns kept, deletions waiting, when the last expires (0: none), their endpoints. @param {Which} [o] */
  count(o = {}) {
    return this.#change((f) => {
      const turns = f.turns.filter((t) => matches(t, o));
      const waiting = o.scope ? [] : f.forget.filter((d) => matches(d, o));
      return { turns: turns.length, waiting: waiting.length, until: Math.max(0, ...[...turns, ...waiting].map((x) => x.until)), endpoints: [...new Set([...turns, ...waiting].map((x) => x.endpoint))] };
    });
  }

  /**
   * Sends the deletions waiting, one at a time (one asked for meanwhile runs after). A 200 or 404 is done; else its
   * endpoint's wait, a 429's as long as it asks (a minute); one that can't be sent (no type, provider or key) waits till
   * it expires. First, turns whose trip is gone are queued.
   * @param {{ resolve: (endpointId: string) => Promise<{ type: import('./contract.js').EndpointType, endpoint: import('./config.js').Endpoint, key: string | null } | null>,
   *   fetch: (url: string, init: RequestInit) => Promise<Response>, scopes?: () => Promise<Set<string>>, signal?: AbortSignal,
   *   trace?: ReturnType<typeof import('./trace.js').modelTrace> }} c resolve: as calls see it, with its key; null: not now
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
    /** @type {Map<string, Awaited<ReturnType<typeof resolve>>>} */
    const known = new Map();
    for (const d of list) {
      if (signal?.aborted) break;
      if ((this.#rest.get(d.endpoint) ?? 0) > this.now()) continue;
      if (!known.has(d.endpoint)) known.set(d.endpoint, await resolve(d.endpoint).catch(() => null));
      const to = known.get(d.endpoint);
      const res = to ? await deleteTurn({ ...to, id: d.id, fetch, signal, trace, now: this.now }) : null;
      if (res?.done) done.add(d.id);
      else {
        known.set(d.endpoint, null);
        if (res?.status === 429) this.#rest.set(d.endpoint, this.now() + (res.retryAfter ?? 60_000));
      }
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
    const res = await fetch(r.url, { method: r.method, headers: r.headers, redirect: 'manual', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]) });
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
