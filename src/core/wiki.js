import { LANGUAGES, readingOrder } from './languages.js';
import { readAppSettings } from './settings.js';
import { ADDRESS_ENDS } from './address-ends.js';

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

/**
 * Wikivoyage's editions among the hosts annai's languages read (Wikimedia's sitematrix, 2026-11-20: 28 editions; 25 of annai's 42 languages have
 * one, on these 24 hosts, both Chinese rows on zh). A language without one is never asked: its host redirects to the Incubator's page (ko's
 * is a 302, checked 2026-11-20), not an API's answer.
 */
const VOYAGE = new Set(['bn', 'cs', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'id', 'it', 'ja', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'vi', 'zh']);
/** How many Wikivoyage editions annai asks: the most guides a search of the floor can give. */
export const VOYAGE_COUNT = VOYAGE.size;
/** The editions of these (in the reading order, as editionsOf gives them) that have a Wikivoyage: English, and each listed language's that has one. @param {string[]} editions */
export const guideEditions = (editions) => editions.filter((e) => VOYAGE.has(e));
/** An edition's Wikivoyage API. @param {string} edition */
export const voyageApi = (edition) => `https://${edition}.wikivoyage.org/w/api.php`;
/** An edition's language, in English, for a model: "Japanese" for ja, "Chinese" for zh; the edition itself where the engine has no name for it. @param {string} edition */
export const editionName = (edition) => new Intl.DisplayNames(['en'], { type: 'language' }).of(edition) ?? edition;

/** How annai names itself to Wikimedia (MediaWiki's API:Etiquette). @param {string} version */
export const agentHeader = (version) => ({ 'Api-User-Agent': /* en */ `annai/${version} (https://annai.guide)` });

/**
 * Wikimedia asks for 3 requests or fewer at once from a client, across all its sites (mediawiki.org, "Wikimedia APIs/Rate limits", read
 * 2026-11-20: "Limit the number of concurrent requests to 3 or fewer"). Every request annai sends to a Wikipedia or Wikivoyage host, or to
 * Wikidata, takes a turn here, as Nominatim's do in nominatim.js: the places tools, free search's floor and the offline pack, whichever runs
 * beside which.
 */
export const WIKIMEDIA_AT_ONCE = 3;
const WIKIMEDIA = /^(?:[a-z0-9-]+\.(?:wikipedia|wikivoyage)\.org|www\.wikidata\.org)$/;
/** Whether a url is to a Wikipedia or Wikivoyage host or to Wikidata: the ones that take turns, and that the pack gives the foreground's time. @param {string} url */
export const isWikimedia = (url) => WIKIMEDIA.test(hostOf(url));
/** A url's host, '' for one that isn't a whole address (URL.canParse came in Safari 17: annai's floor is iOS 16.4). @param {string} url */
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
let running = 0;
/** @type {{ go: () => void }[]} the requests waiting for a turn, in the order asked */
const turns = [];

/**
 * Runs job (a request to url and the reading of its answer, ended by signal) at its turn when url is Wikimedia's, WIKIMEDIA_AT_ONCE at once,
 * in the order asked; any other url's at once. A turn ends when its job does, or when its signal aborts, whichever is first (an aborted
 * fetch has stopped asking, so a job that is slow to settle holds no turn); an ended turn passes to the next waiting, so no request can take
 * it in between. The signal ends a wait too, throwing its reason. The job's own answer or failure is what this gives.
 * @template T @param {string} url @param {() => Promise<T>} job @param {AbortSignal} [signal] @returns {Promise<T>}
 */
export async function wikimediaTurn(url, job, signal) {
  if (!isWikimedia(url)) return job();
  signal?.throwIfAborted();
  if (running < WIKIMEDIA_AT_ONCE) running++;
  else {
    await new Promise((resolve, reject) => {
      const turn = { go: () => (signal?.removeEventListener('abort', stop), resolve(undefined)) };
      const stop = () => (turns.splice(turns.indexOf(turn), 1), reject(signal?.reason));
      turns.push(turn);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener('abort', end);
    const next = turns.shift();
    if (next) next.go();
    else running--;
  };
  signal?.addEventListener('abort', end, { once: true });
  try {
    return await job();
  } finally {
    end();
  }
}

/**
 * An edition's nearest articles, with coordinates, Wikidata ids and, with extracts, 400 characters of summary. MediaWiki's limits (paraminfo,
 * 2026-11-19): geosearch 500 within 10 km; coordinates 10 unless colimit asks; extracts 20. No distance comes with this form.
 * @param {string} edition @param {[number, number]} at @param {number} radius @param {number} limit @param {{ extracts?: boolean }} [o]
 */
export function nearUrl(edition, [lat, lng], radius, limit, { extracts = false } = {}) {
  return `https://${edition}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=${radius}`
    + `&ggslimit=${limit}&prop=${extracts ? 'extracts%7C' : ''}coordinates%7Cpageprops&ppprop=wikibase_item&colimit=${limit}${extracts ? `&exintro=1&explaintext=1&exlimit=${limit}&exchars=400` : ''}`;
}

/** The summaries one request may ask for by title: TextExtracts' most (exlimit, paraminfo 2026-11-19). */
export const SUMMARIES_PER_ASK = 20;
/**
 * An edition's articles by their titles (SUMMARIES_PER_ASK at most), each with its 400 characters of summary, as nearUrl's, and its Wikidata id;
 * redirects followed. @param {string} edition @param {string[]} titles
 */
export const summariesUrl = (edition, titles) => `https://${edition}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&redirects=1`
  + `&prop=extracts%7Cpageprops&ppprop=wikibase_item&exintro=1&explaintext=1&exlimit=${SUMMARIES_PER_ASK}&exchars=400&titles=${encodeURIComponent(titles.join('|'))}`;

const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);

/** What an error answer says ({"error": {code, info}}, its HTTP status "usually still 200 OK": mediawiki.org API:Errors_and_warnings), without its full stop; '' for none. @param {any} r */
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
 * Each article once: by Wikidata id, the order's first edition's row (one outside it last), with `also`, the same item's rows in the later
 * editions, one an edition, in the order; without an id, once in its edition by title, with none.
 * @template {Article} A @param {A[]} rows @param {string[]} editions @returns {(A & { also: A[] })[]}
 */
export function merged(rows, editions) {
  const rank = (/** @type {A} */ a) => (editions.includes(a.edition) ? editions.indexOf(a.edition) : editions.length);
  /** @type {Map<string, A & { also: A[] }>} */
  const by = new Map();
  for (const a of [...rows].sort((x, y) => rank(x) - rank(y))) {
    const key = a.id ?? `${a.edition} ${a.title}`;
    const first = by.get(key);
    if (!first) by.set(key, { ...a, also: [] });
    else if (first.edition !== a.edition && !first.also.some((x) => x.edition === a.edition)) first.also.push(a);
  }
  return [...by.values()];
}

/**
 * The most Wikipedia articles nearby lists, and each edition is asked for: one Wikidata request names 50 items (`wbgetentities`' `ids`, without
 * bot rights: paraminfo, 2026-11-20). It lists the whole kilometre at 20 of 34 stops measured (the editions design, 2026-11-20: zh, ja and en
 * merged); a city centre holds 200 to 560 articles there, past what one tool result carries (tools.js RESULT_MAX, 40,000 characters), so it is a
 * list to choose from, and nearby says how far it reaches when it is cut.
 */
export const ARTICLES = 50;
/** An edition's Wikidata site: its host label with `-` as `_`, then `wiki` (jawiki, zh_yuewiki, tlwiki: checked on Q1490, 2026-11-20). @param {string} edition */
export const siteOf = (edition) => `${edition.replace(/-/g, '_')}wiki`;
/**
 * Wikidata's request for which of these editions have an article about each of these items (ARTICLES at most), and its title there.
 * @param {string[]} ids @param {string[]} editions
 */
export const sitelinksUrl = (ids, editions) => 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&props=sitelinks'
  + `&sitefilter=${editions.map(siteOf).join('%7C')}&ids=${ids.join('%7C')}`;
/**
 * Wikidata's answer as titles: each item asked, by its id, to its title in each of these editions that has it (an item it names as another,
 * merged into it, under the id asked too). An item missing, or an edition without it, has none.
 * @param {any} r @param {string[]} editions @returns {Map<string, Map<string, string>>}
 */
export function titlesOf(r, editions) {
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  const entities = r?.entities && typeof r.entities === 'object' ? Object.entries(r.entities) : [];
  for (const [asked, item] of entities) {
    /** @type {Map<string, string>} */
    const titles = new Map();
    for (const e of editions) {
      const t = /** @type {any} */ (item)?.sitelinks?.[siteOf(e)]?.title;
      if (typeof t === 'string' && t) titles.set(e, t);
    }
    out.set(asked, titles);
    if (typeof (/** @type {any} */ (item)?.id) === 'string') out.set(/** @type {any} */ (item).id, titles);
  }
  return out;
}

const hex = (/** @type {string} */ c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
const ENDS = new RegExp(`[${ADDRESS_ENDS}]`, 'g');
/**
 * A Wikipedia or Wikivoyage page's address, its title as written (as %XX a model reads 9 characters for one). Encoded: what a browser would read as another
 * part of it (`%`, `?`, `#`, `\`), and what chat's bare links (src/ui/markdown.js) would take for the end of the address or leave out of it: the brackets (an
 * unpaired one ends a link; kept encoded, as before), a last `.,;:!'"` and any of ADDRESS_ENDS, the last as UTF-8 bytes (`%E3%80%82`; `hex` is for ASCII).
 * @param {string} host @param {string} title
 */
export const pageUrl = (host, title) => `https://${host}/wiki/${title.replace(/ /g, '_').replace(/[%?#\\()]/g, hex).replace(ENDS, encodeURIComponent).replace(/[.,;:!'"]$/, hex)}`;
/** An article's address on an edition's Wikipedia. @param {string} edition @param {string} title */
export const articleUrl = (edition, title) => pageUrl(`${edition}.wikipedia.org`, title);
