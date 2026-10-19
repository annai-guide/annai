/**
 * The catalog's search (spec §16.2): a few lines of annai's own, no search library.
 * @typedef {import('./catalog-facts.js').CatalogFacts & { official?: boolean, featured?: string }} SearchEntry
 * @typedef {{ kind?: string, ability?: string, free?: boolean, local?: boolean, source?: 'official' | 'third-party' }} Filters
 * @typedef {{ score: 0 | 1 | 2 | 3, why?: string }} Rank  why: the keyword, as written, that matched
 * @typedef {{ text: string, starts: Set<number> }} Squashed
 */

/** A query past this many characters is cut there: matching is read once per field, but a pasted page needn't be. */
const MAX_QUERY = 100;

/** Lower case, letters and digits only, and where each word began. @param {string} s @returns {Squashed} */
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
    // A capital after a small letter starts a word too ("KoboldCpp").
    if (!prev || (/\p{Lu}/u.test(c) && /\p{Ll}/u.test(prev))) starts.add(text.length);
    text += c.toLowerCase();
    prev = c;
  }
  return { text, starts };
}

/** Whether squashed text q is in a squashed field at the start of one of its words. @param {string} q @param {Squashed} f */
function at(q, f) {
  for (let i = f.text.indexOf(q); i >= 0; i = f.text.indexOf(q, i + 1)) if (f.starts.has(i)) return true;
  return false;
}

/** @param {string} query @param {string} field */
export const matchAt = (query, field) => {
  const q = squash(query).text;
  return Boolean(q) && at(q, squash(field));
};

/** Each entry's fields, squashed the first time it is searched: typing searches the same entries again. @type {WeakMap<object, { name: Squashed, keywords: Squashed[], description: Squashed, abilities: Squashed[] }>} */
const squashed = new WeakMap();
const FREE = squash('free');

/** How squashed text q matches an entry. @param {SearchEntry} e @param {string} q @returns {Rank} */
function rankWhole(e, q) {
  let f = squashed.get(e);
  // "voices" finds a voice: the plural holds the singular too.
  if (!f) squashed.set(e, f = { name: squash(e.name), keywords: e.keywords.map(squash), description: squash(e.description), abilities: e.abilities.map((a) => squash(`${a}s`)) });
  if (at(q, f.name)) return { score: 3 };
  const k = f.keywords.findIndex((x) => at(q, x));
  if (k >= 0) return { score: 2, why: e.keywords[k] };
  return { score: at(q, f.description) || f.abilities.some((a) => at(q, a)) || (e.free && at(q, FREE)) ? 1 : 0 };
}

/** A query squashed once: whole, and word by word (split where squash splits). @param {string} query */
function read(query) {
  const s = String(query).slice(0, MAX_QUERY);
  return { whole: squash(s).text, words: s.split(/[^\p{L}\p{N}]+/u).map((w) => squash(w).text).filter(Boolean) };
}

/** @param {SearchEntry} e @param {ReturnType<typeof read>} q @returns {Rank} */
function rankRead(e, q) {
  if (!q.whole) return { score: 0 };
  const whole = rankWhole(e, q.whole);
  if (whole.score || q.words.length < 2) return whole;
  // Words that match nowhere together must each match somewhere ("free voice"); the weakest decides.
  const ranks = q.words.map((w) => rankWhole(e, w));
  const score = /** @type {Rank['score']} */ (Math.min(...ranks.map((r) => r.score)));
  const why = score ? ranks.find((r) => r.why)?.why : undefined;
  return why ? { score, why } : { score };
}

/** 3 its name, 2 a keyword, 1 its description, an ability or "free"; 0 no match. @param {SearchEntry} e @param {string} query */
export const rankEntry = (e, query) => rankRead(e, read(query));

/** Whether the filters keep an entry. @param {SearchEntry} e @param {Filters} f */
const keeps = (e, f) => (!f.kind || e.category === f.kind) && (!f.ability || e.abilities.includes(f.ability))
  && (!f.free || e.free) && (!f.local || e.local) && (!f.source || (f.source === 'official') === Boolean(e.official));

/**
 * What the filters keep and the query matches, by score, then featured, then official, then name; an
 * empty query keeps all the filters keep.
 * @template {SearchEntry} T @param {T[]} entries @param {string} query @param {Filters} [filters]
 * @returns {({ entry: T } & Rank)[]}
 */
export function searchCatalog(entries, query, filters = {}) {
  const q = read(query);
  /** @type {({ entry: T } & Rank)[]} */
  const out = [];
  for (const entry of entries) {
    if (!keeps(entry, filters)) continue;
    const r = q.whole ? rankRead(entry, q) : { score: /** @type {const} */ (0) };
    if (!q.whole || r.score) out.push({ entry, ...r });
  }
  const yes = (/** @type {unknown} */ v) => (v ? 1 : 0);
  return out.sort((a, b) => b.score - a.score || yes(b.entry.featured) - yes(a.entry.featured)
    || yes(b.entry.official) - yes(a.entry.official) || a.entry.name.localeCompare(b.entry.name));
}
