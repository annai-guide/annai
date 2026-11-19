import { LANGUAGES, readingOrder } from './languages.js';
import { readAppSettings } from './settings.js';

/**
 * Wikipedia in the traveller's languages (spec §8): each language's edition, an edition's nearest articles, and several editions' merged.
 * @typedef {{ title: string, lat: number, lng: number, summary: string, id: string | null, edition: string }} Article  id: its Wikidata item
 */

/** Hosts other than the language's id (Wikimedia's sitematrix, 2026-11-19: every other language annai lists is its own). */
const HOST = /** @type {Record<string, string>} */ ({ 'zh-Hant': 'zh', yue: 'zh-yue', fil: 'tl' });
const LISTED = new Set(LANGUAGES.map((l) => l.id));

/** An order's editions, each once, by host label; none for a language annai has no row for (no host was checked). @param {import('./languages.js').Language[]} order */
export const editionsOf = (order) => [...new Set(order.filter((l) => LISTED.has(l.id)).map((l) => HOST[l.id] ?? l.id))];
/** The editions the traveller's languages read now. @param {import('./workspace.js').Workspace} ws @param {string} locale the phone's */
export const readingEditions = async (ws, locale) => editionsOf(readingOrder(await readAppSettings(ws), locale));

/** How annai names itself to Wikimedia (MediaWiki's API:Etiquette). @param {string} version */
export const agentHeader = (version) => ({ 'Api-User-Agent': /* en */ `annai/${version} (https://annai.guide)` });

/**
 * An edition's nearest articles, with coordinates, Wikidata ids and, with extracts, 400 characters of summary. MediaWiki's limits (paraminfo,
 * 2026-11-19): geosearch 500 within 10 km; coordinates 10 unless colimit asks; extracts 20. No distance comes with this form.
 * @param {string} edition @param {[number, number]} at @param {number} radius @param {number} limit @param {{ extracts?: boolean }} [o]
 */
export function nearUrl(edition, [lat, lng], radius, limit, { extracts = false } = {}) {
  return `https://${edition}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=${radius}`
    + `&ggslimit=${limit}&prop=${extracts ? 'extracts%7C' : ''}coordinates%7Cpageprops&ppprop=wikibase_item&colimit=${limit}${extracts ? `&exintro=1&explaintext=1&exlimit=${limit}&exchars=400` : ''}`;
}

const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);

/** What an edition's error answer says (MediaWiki sends 200 with {"error": {code, info}}), without its full stop; '' for none. @param {any} r */
export const wikiSaid = (r) => (r?.error ? String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '') : '');

/** An answer's articles: a page without coordinates left out. @param {any} r @param {string} edition @returns {Article[]} */
export function articlesOf(r, edition) {
  /** @type {Article[]} */
  const out = [];
  for (const g of Array.isArray(r?.query?.pages) ? r.query.pages : []) {
    const c = Array.isArray(g?.coordinates) ? g.coordinates[0] : null;
    if (typeof g?.title !== 'string' || !isNum(c?.lat) || !isNum(c?.lon)) continue;
    const id = g.pageprops?.wikibase_item;
    out.push({ title: g.title, lat: c.lat, lng: c.lon, summary: typeof g.extract === 'string' ? g.extract.trim() : '', id: typeof id === 'string' && id ? id : null, edition });
  }
  return out;
}

/**
 * Each article once: by Wikidata id, the order's first edition's; without an id, once in its edition by title. Rows of an edition outside the
 * order are for the caller to leave out.
 * @template {Article} A @param {A[]} rows @param {string[]} editions @returns {A[]}
 */
export function merged(rows, editions) {
  const seen = new Set();
  return [...rows].sort((a, b) => editions.indexOf(a.edition) - editions.indexOf(b.edition)).filter((a) => {
    const key = a.id ?? `${a.edition} ${a.title}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

/** An article's address, its title as written (as %XX a model reads 9 characters for one): only `%`, `?`, `#`, `\` and the brackets (chat's links end at one) encoded. @param {string} edition @param {string} title */
export const articleUrl = (edition, title) => `https://${edition}.wikipedia.org/wiki/${title.replace(/ /g, '_').replace(/[%?#\\()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
