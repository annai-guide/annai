/**
 * Searching annai's catalog and what is installed (spec §16.2): a few lines of annai's own, no search
 * library. Case, spaces and punctuation don't count ("lm studio" is "lmstudio"), and a query matches
 * from the start of a word. A name match ranks above a keyword match ("Also for: LM Studio"), and a
 * keyword above the description, an ability or "free".
 * @typedef {import('./catalog-facts.js').CatalogFacts & { official?: boolean, featured?: string }} SearchEntry
 * @typedef {{ kind?: string, ability?: string, free?: boolean, local?: boolean, source?: 'official' | 'third-party' }} Filters
 * @typedef {{ score: 0 | 1 | 2 | 3, why?: string }} Rank  why: the keyword, as written, that matched
 */

/** Lower case, letters and digits only, and where each word began. @param {string} s */
export function squash(s) {
  let text = '';
  /** @type {Set<number>} */
  const starts = new Set();
  let prev = ''; // the last letter or digit; none after a space or punctuation
  for (const c of String(s).normalize('NFKC')) {
    if (!/[\p{L}\p{N}]/u.test(c)) {
      prev = '';
      continue;
    }
    // A word starts after a space or punctuation, and where a capital follows a small letter ("OpenRouter").
    if (!prev || (/\p{Lu}/u.test(c) && /\p{Ll}/u.test(prev))) starts.add(text.length);
    text += c.toLowerCase();
    prev = c;
  }
  return { text, starts };
}

/** Whether the query, squashed, is in the field at the start of one of its words. @param {string} query @param {string} field */
export function matchAt(query, field) {
  const q = squash(query).text;
  if (!q) return false;
  const f = squash(field);
  for (let i = f.text.indexOf(q); i >= 0; i = f.text.indexOf(q, i + 1)) if (f.starts.has(i)) return true;
  return false;
}

/** How one query, whole, matches an entry. @param {SearchEntry} e @param {string} q @returns {Rank} */
function rankWhole(e, q) {
  if (matchAt(q, e.name)) return { score: 3 };
  const why = e.keywords.find((k) => matchAt(q, k));
  if (why) return { score: 2, why };
  // "voices" finds a voice: the plural holds the singular too.
  if (matchAt(q, e.description) || e.abilities.some((a) => matchAt(q, `${a}s`)) || (e.free && matchAt(q, 'free'))) return { score: 1 };
  return { score: 0 };
}

/**
 * How a query matches an entry: 3 its name, 2 a keyword, 1 its description, an ability or "free".
 * A query with spaces that matches nowhere whole needs each of its words to match somewhere ("free
 * voice"), and ranks by the weakest. @param {SearchEntry} e @param {string} query @returns {Rank}
 */
export function rankEntry(e, query) {
  const whole = rankWhole(e, query);
  const words = query.trim().split(/\s+/).filter((w) => squash(w).text);
  if (whole.score || words.length < 2) return whole;
  const ranks = words.map((w) => rankWhole(e, w));
  const score = /** @type {Rank['score']} */ (Math.min(...ranks.map((r) => r.score)));
  const why = score ? ranks.find((r) => r.why)?.why : undefined;
  return why ? { score, why } : { score };
}

/** Whether the filters keep an entry. @param {SearchEntry} e @param {Filters} f */
const keeps = (e, f) => (!f.kind || e.category === f.kind) && (!f.ability || e.abilities.includes(f.ability))
  && (!f.free || e.free) && (!f.local || e.local) && (!f.source || (f.source === 'official') === Boolean(e.official));

/**
 * The entries the filters keep that match the query, best first: by score, then featured, then
 * official, then name. An empty query keeps every entry the filters keep.
 * @template {SearchEntry} T @param {T[]} entries @param {string} query @param {Filters} [filters]
 * @returns {({ entry: T } & Rank)[]}
 */
export function searchCatalog(entries, query, filters = {}) {
  const q = squash(query).text ? query : '';
  /** @type {({ entry: T } & Rank)[]} */
  const out = [];
  for (const entry of entries) {
    if (!keeps(entry, filters)) continue;
    const r = q ? rankEntry(entry, q) : { score: /** @type {const} */ (0) };
    if (!q || r.score) out.push({ entry, ...r });
  }
  const yes = (/** @type {unknown} */ v) => (v ? 1 : 0);
  return out.sort((a, b) => b.score - a.score || yes(b.entry.featured) - yes(a.entry.featured)
    || yes(b.entry.official) - yes(a.entry.official) || a.entry.name.localeCompare(b.entry.name));
}
