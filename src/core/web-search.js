import { decodeEntities } from './html-text.js';

/**
 * Web search's shared parts (spec §7.2): the order of search providers, the rows every provider's
 * answer is made into, and how long a provider that failed is left alone. The web plugin runs the
 * chain; Settings → Tools and the welcome draw the same list.
 * @typedef {{ id: string, name: string, kind?: 'web' | 'knowledge', free?: boolean, always?: boolean, note?: string, limitMs?: number,
 *   ready?: () => Promise<{ ok: boolean, why?: string }>, search: (query: string, c: { fetch: any, signal: AbortSignal, limit: number, session?: string }) => Promise<any[]> }} SearchProvider
 */

/** annai's own free search services (the user, 2026-10-23): each can be unticked, all start on. */
export const FREE_SERVICES = Object.freeze([
  { id: 'exa', name: 'Exa' },
  { id: 'parallel', name: 'Parallel' },
  { id: 'firecrawl', name: 'Firecrawl' },
]);

/** How long a provider's ready() may take before it is passed over as one that can't say (ms). */
export const READY_MS = { ms: 3_000 };

/** A search's whole time, and what is kept of it for the floor (ms): the rungs before the floor share the rest. */
export const CHAIN = { ms: 45_000, reserve: 10_000 };

/** Rows in an answer, and a snippet's and a title's length. */
export const ROWS = 8;
const SNIPPET = 400;
const TITLE = 160;

/** The providers the user can reorder and tick are the web plugin's own and those of other plugins; only the web plugin's may call itself always on, free or knowledge. */
const BUILT_IN = 'web';

/**
 * The search providers of a registry's entries ({ pluginId, item }) as the chain treats them: another plugin's provider is
 * always a keyed or self-hosted web one that can be unticked, whatever it says of itself (it can't make itself impossible to switch off).
 * @template {Record<string, any>} T @param {{ pluginId: string, item: T }[]} entries @returns {T[]}
 */
export function trusted(entries) {
  return entries.map(({ pluginId, item }) => (pluginId === BUILT_IN ? item
    : Object.create(item, { always: { value: false }, free: { value: false }, kind: { value: 'web' } })));
}

/**
 * Providers in the order they are tried: the user's list (web.search) first, as saved. A provider that isn't in it (a plugin installed
 * since) takes its place by its rank among those that are: keyed before the first saved free or knowledge one, free before the first
 * saved knowledge one, knowledge last. Switched-off ones are in it.
 * @template {{ id: string, kind?: string, free?: boolean }} T @param {T[]} list @param {{ search?: unknown } | undefined} web @returns {T[]}
 */
export function orderSearch(list, web) {
  const rank = (/** @type {T} */ p) => (p.kind === 'knowledge' ? 2 : p.free ? 1 : 0);
  const base = list.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
  const set = Array.isArray(web?.search) ? web.search.map(String) : [];
  const out = [...new Set(set)].map((id) => base.find((p) => p.id === id)).filter((p) => p !== undefined);
  for (const p of base) {
    if (out.includes(p)) continue;
    const at = out.findIndex((q) => rank(q) > rank(p));
    out.splice(at < 0 ? out.length : at, 0, p);
  }
  return out;
}

/** The ids the user switched off, among those that can be (not a provider that is always on). @param {{ searchOff?: unknown } | undefined} web @param {readonly { id: string, always?: boolean }[]} list */
export function searchOffIn(web, list) {
  const off = Array.isArray(web?.searchOff) ? web.searchOff.map(String) : [];
  return list.filter((p) => !p.always && off.includes(p.id)).map((p) => p.id);
}

/** Tracking parameters a result's address is cleaned of. */
const TRACKING = /^(utm_|srsltid$|msockid$|fbclid$|gclid$|igshid$|mc_[ce]id$)/i;
/** The most of a field read before any pattern runs on it, and of rows looked at. */
const FIELD = 4000;
const ROWS_READ = 200;

/** s cut to at most n characters, never in the middle of a surrogate pair. @param {string} s @param {number} n */
export function cut(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}
/** A field as plain one-line text. Cut first and matched by bounded patterns (as html-text.js does), so a hostile answer costs linear time. @param {unknown} s */
const text = (s) => decodeEntities(cut(String(s ?? ''), FIELD).replace(/<[^<>]*>/g, ' ')).replace(/\[([^[\]]*)\]\(([^()]*)\)/g, '$1').replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
/** @param {string} s */
const words = (s) => [...new Set(cut(s, FIELD).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];

/** The sentences of an excerpt that share the most words with the query, in their order, within the limit. @param {string} s @param {string[]} want */
function best(s, want) {
  if (s.length <= SNIPPET) return s;
  const parts = s.match(/[^.!?]+[.!?]*\s*/g) ?? [s];
  const score = parts.map((x, i) => ({ i, x: x.trim(), n: want.filter((w) => x.toLowerCase().includes(w)).length }));
  const keep = new Set();
  let used = 0;
  for (const c of [...score].sort((a, b) => b.n - a.n || a.i - b.i)) {
    if (!c.x || (c.n === 0 && keep.size)) continue;
    const add = c.x.length + (keep.size ? 1 : 0);
    if (used + add > SNIPPET) {
      if (!keep.size) return `${cut(c.x, SNIPPET - 1).trimEnd()}…`;
      continue;
    }
    keep.add(c.i);
    used += add;
  }
  return score.filter((c) => keep.has(c.i)).map((c) => c.x).join(' ');
}

/**
 * What a provider answered, made into rows once, here: tags and entities out, whitespace folded, http(s)
 * addresses only and cleaned of tracking parameters, one row per host and path, the sentences that answer
 * the query kept, and at most limit rows.
 * @param {unknown} rows @param {string} query @param {number} [limit] @returns {{ title: string, url: string, snippet: string }[]}
 */
export function normalizeRows(rows, query, limit = ROWS) {
  const want = words(query);
  const seen = new Set();
  /** @type {{ title: string, url: string, snippet: string }[]} */
  const out = [];
  for (const r of Array.isArray(rows) ? rows.slice(0, ROWS_READ) : []) {
    if (out.length >= limit) break;
    /** @type {URL} */
    let u;
    try {
      u = new URL(String(r?.url ?? '').trim());
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    // One row per page: host, path (its case counts) and the query without tracking, in order.
    u.searchParams.sort();
    const key = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}?${u.searchParams}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: cut(text(r?.title), TITLE), url: u.href, snippet: best(text(r?.snippet ?? r?.description ?? r?.content), want) });
  }
  return out;
}

/** Whether a failure means the provider should be left alone for a while: a limit, a server down, no answer, no way to reach it (not while this device is offline, which is no provider's doing). @param {any} e */
export function restsOn(e) {
  if (globalThis.navigator?.onLine === false) return false;
  const s = Number(e?.status);
  return Boolean(e?.late) || Boolean(e?.rest) || s === 429 || s === 402 || s >= 500 || e instanceof TypeError || e?.kind === 'cors' || e?.kind === 'network';
}

/** Providers that failed and are left alone: a minute, doubling at each failure in a row to 30 minutes, in memory, ended by a success. */
export class Cooldowns {
  /** @type {Map<string, { until: number, n: number }>} */ #m = new Map();
  /** @param {() => number} [now] */
  constructor(now = Date.now) {
    this.now = now;
  }

  /**
   * Leaves a provider alone. One already resting is not made to rest again (two failures at once count once); escalate false is for a
   * failure that may be the connection's, not the provider's, and keeps the level it had.
   * @param {string} id @param {boolean} [escalate]
   */
  rest(id, escalate = true) {
    if (this.left(id) > 0) return;
    const was = this.#m.get(id)?.n ?? 0;
    const n = escalate ? Math.min(6, was + 1) : Math.max(1, was);
    this.#m.set(id, { n, until: this.now() + Math.min(30 * 60_000, 60_000 * 2 ** (n - 1)) });
  }

  /** Milliseconds left of its rest; 0 when it is not resting. @param {string} id */
  left(id) {
    return Math.max(0, (this.#m.get(id)?.until ?? 0) - this.now());
  }

  /** @param {string} id */
  clear(id) {
    this.#m.delete(id);
  }
}

/** The one set of rests the app has; Settings → Tools reads it to say who is resting. */
export const cooldowns = new Cooldowns();
