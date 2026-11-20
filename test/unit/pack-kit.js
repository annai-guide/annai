import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { readFile } from 'node:fs/promises';
import { meters } from '../../src/core/live/geo.js';

/** Two Big Sur stops, 21 km apart. */
export const STOPS = Object.freeze({
  bixby: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2026-11-27T17:45:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
  nepenthe: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: '2026-11-27T20:00:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
});

/** A trip with the two stops, or with other plan items. @param {Record<string, any>} [plan] plan files by path */
export async function packTrip(plan = { '/plan/bixby.json': STOPS.bixby, '/plan/nepenthe.json': STOPS.nepenthe }) {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  for (const [path, item] of Object.entries(plan)) await ws.write(trip, path, item, { author: 'user' });
  return { store, ws, trip };
}

const near = (/** @type {string} */ text, /** @type {number} */ lat) => text.includes(String(lat));

/** What Overpass has around Bixby and Nepenthe, and along the coast between them. @param {string} url @param {any} init */
export function overpass(url, init) {
  const q = decodeURIComponent(String(init?.body ?? '')).replace(/\+/g, ' ');
  if (q.includes('around:3000')) return { elements: [{ type: 'node', id: 3, lat: 36.3066, lon: -121.9017, tags: { name: 'Point Sur Lighthouse', historic: 'lighthouse' } }] };
  if (near(q, 36.3715)) {
    return { elements: [{ type: 'node', id: 1, lat: 36.3712, lon: -121.902, tags: { name: 'Bixby Bridge Vista Point', tourism: 'viewpoint' } }, { type: 'node', id: 2, lat: 36.372, lon: -121.9015, tags: { amenity: 'toilets' } }] };
  }
  return { elements: [{ type: 'way', id: 4, center: { lat: 36.2203, lon: -121.7612 }, tags: { name: 'Nepenthe', amenity: 'restaurant', website: 'https://www.nepenthe.com/' } }, { type: 'node', id: 5, lat: 36.2381, lon: -121.8162, tags: { name: 'Pfeiffer Beach', natural: 'beach' } }] };
}

/** What English Wikipedia has near Bixby and near Nepenthe, in the shape of its real answers (fixtures/places/wiki-pack-*.json). @param {string} url */
export function wikipedia(url) {
  const page = (/** @type {string} */ title, /** @type {number} */ lat, /** @type {number} */ lon, /** @type {string} */ extract) => ({ ns: 0, title, coordinates: [{ lat, lon, primary: true, globe: 'earth' }], pageprops: { wikibase_item: `Q${title.length}${Math.round(lat * 100)}` }, extract });
  if (url.includes('ggscoord=36.3715')) {
    return { query: { pages: [page('Bixby Creek Bridge', 36.3715, -121.9017, 'Bixby Creek Bridge is a reinforced concrete open-spandrel arch bridge in Big Sur.'), page('Big Sur', 36.2704, -121.8081, 'Big Sur is a rugged and mountainous section of the Central Coast of California.')] } };
  }
  return { query: { pages: [page('Nepenthe (restaurant)', 36.2203, -121.7612, 'Nepenthe is a restaurant in Big Sur.'), page('Cambria, California', 36.21, -121.75, 'Cambria is a seaside town.'), page('Big Sur', 36.2704, -121.8081, 'Big Sur is a rugged section of coast.')] } };
}

const GUIDES = /** @type {Record<string, string>} */ ({
  'Big Sur': 'Big Sur is a region.\n\n== Understand ==\nRugged coast.\n\n== Eat ==\nNepenthe.',
  'Cambria (California)': 'Cambria is a town.\n\n== See ==\nMoonstone Beach.',
  'San Simeon': 'San Simeon is a town.\n\n== See ==\nHearst Castle.',
});
/** Titles that are redirects to a guide. */
const REDIRECTS = /** @type {Record<string, string>} */ ({ 'Hearst Castle': 'San Simeon' });
/**
 * The guides' titles in other editions, as English Wikivoyage's links name them, and their texts there: made up for the tests, in the shape of
 * the real answers (2026-11-20: a page with no link in the edition asked has no langlinks key, as Big Sur's has none in Japanese).
 */
export const LINKS = /** @type {Record<string, Record<string, string>>} */ ({ 'Big Sur': { zh: '大蘇爾' }, 'Cambria (California)': { ja: 'カンブリア' }, 'San Simeon': { ja: 'サンシメオン', zh: '聖西蒙' } });
export const EDITION_GUIDES = /** @type {Record<string, Record<string, string>>} */ ({
  ja: { カンブリア: 'カンブリアは海辺の町。\n\n== 見る ==\nムーンストーン・ビーチ。', サンシメオン: 'サンシメオンはハースト・キャッスルの町。' },
  zh: { 大蘇爾: '大蘇爾是加州中部的一段海岸。\n\n== 吃 ==\nNepenthe。', 聖西蒙: '聖西蒙是赫氏古堡所在的小鎮。' },
});

/**
 * Wikivoyage: which titles English's has (Hearst Castle leads to San Simeon), their titles in other editions, and every edition's text. With
 * redirects=1 its pages are the targets of the titles asked, as MediaWiki lists them, not the titles themselves. @param {string} url
 */
export function wikivoyage(url) {
  const u = new URL(url);
  const edition = u.hostname.split('.')[0];
  const titles = (u.searchParams.get('titles') ?? '').split('|');
  // Another edition: the names lookup (a page for each title, missing here: it has none of the trip's names) or a guide's text.
  if (edition !== 'en' && u.searchParams.get('prop')?.startsWith('pageprops')) return { batchcomplete: true, query: { pages: titles.map((t) => ({ title: t, missing: true })) } };
  if (edition !== 'en') return { query: { pages: [EDITION_GUIDES[edition]?.[titles[0]] ? { title: titles[0], extract: EDITION_GUIDES[edition][titles[0]] } : { title: titles[0], missing: true }] } };
  if (u.searchParams.get('prop') === 'pageprops') {
    const redirects = titles.filter((t) => REDIRECTS[t]).map((t) => ({ from: t, to: REDIRECTS[t] }));
    const pages = [...new Set(titles.map((t) => REDIRECTS[t] ?? t))].map((t) => (GUIDES[t] ? { title: t } : t === 'Nepenthe' ? { title: t, pageprops: { disambiguation: '' } } : { title: t, missing: true }));
    return { query: { ...(redirects.length ? { redirects } : {}), pages } };
  }
  if (u.searchParams.get('prop') === 'langlinks') {
    const lang = String(u.searchParams.get('lllang'));
    return { batchcomplete: true, query: { pages: titles.map((t) => (LINKS[t]?.[lang] ? { title: t, langlinks: [{ lang, title: LINKS[t][lang] }] } : { title: t })) } };
  }
  return { query: { pages: [{ title: titles[0], extract: GUIDES[titles[0]] ?? '' }] } };
}

/**
 * Wikivoyage's editions, a table of pages each, answering the guides' three questions as MediaWiki does (in the shape of its real answers, 2026-11-20;
 * what the pages say is made up): the names lookup (pageprops, with each page's link to English in another edition), English's links to an edition,
 * and a page's text. A title leads to its page (`to`: a redirect, or a variant converted); a page has `text`, its title in English (`en`, a page of
 * another edition), its pages in other editions (`links`, an English page), or is a disambiguation page (`list`). A title the table lacks is missing,
 * and a page with no link has no `langlinks` key.
 * @param {Record<string, Record<string, { to?: string, text?: string, en?: string, links?: Record<string, string>, list?: boolean }>>} world by edition
 * @returns {(url: string) => any}
 */
export function voyageWorld(world) {
  return (url) => {
    const u = new URL(url);
    const table = world[u.hostname.split('.')[0]] ?? {};
    const prop = String(u.searchParams.get('prop'));
    const titles = (u.searchParams.get('titles') ?? '').split('|');
    /** The page a title leads to: [its title, its entry], none for a missing one. @param {string} t @returns {[string, typeof table[string]] | null} */
    const lead = (t) => {
      const to = table[t]?.to ?? t;
      return table[to] && !table[to].to ? [to, table[to]] : null;
    };
    if (prop.startsWith('pageprops')) {
      const redirects = titles.filter((t) => table[t]?.to).map((t) => ({ from: t, to: /** @type {string} */ (table[t].to) }));
      /** @type {any[]} */
      const pages = [];
      for (const t of titles) {
        const page = lead(t);
        if (!page) pages.push({ ns: 0, title: table[t]?.to ?? t, missing: true });
        else if (!pages.some((x) => x.title === page[0])) {
          pages.push({ pageid: 1 + Object.keys(table).indexOf(page[0]), ns: 0, title: page[0], ...(page[1].list ? { pageprops: { disambiguation: '' } } : {}),
            ...(prop.includes('langlinks') && page[1].en ? { langlinks: [{ lang: 'en', title: page[1].en }] } : {}) });
        }
      }
      return { batchcomplete: true, query: { ...(redirects.length ? { redirects } : {}), pages } };
    }
    if (prop === 'langlinks') {
      const lang = String(u.searchParams.get('lllang'));
      return { batchcomplete: true, query: { pages: titles.map((t) => (!table[t] ? { title: t, missing: true } : table[t].links?.[lang] ? { title: t, langlinks: [{ lang, title: table[t].links?.[lang] }] } : { title: t })) } };
    }
    // A page's text and links: the pack's text request (extracts alone) and the guide tool's page query (extract, langlinks, pageprops, or without the extract).
    const page = lead(titles[0]);
    if (!page) return { batchcomplete: true, query: { pages: [{ ns: 0, title: titles[0], missing: true }] } };
    const [title, p] = page;
    const langlinks = [...Object.entries(p.links ?? {}), ...(p.en ? [['en', p.en]] : [])].map(([lang, to]) => ({ lang, title: to }));
    return { batchcomplete: true, query: { pages: [{ pageid: 1, ns: 0, title, ...(prop.includes('extracts') ? { extract: p.text ?? '' } : {}), ...(prop.includes('langlinks') && langlinks.length ? { langlinks } : {}), ...(p.list ? { pageprops: { disambiguation: '' } } : {}) }] } };
  };
}

/** Wikidata's real answer naming 50 items' titles in ja, en and zh: the 24 articles near Kiyomizu-dera only Japanese listed, and the 26 of Yufuin's two lists (2026-11-20; CC0). */
export const SITELINKS = JSON.parse(await readFile(new URL('../fixtures/places/wikidata-sitelinks.json', import.meta.url), 'utf8'));
/**
 * Wikidata answering wbgetentities from a table of items, as it answers (the shape of SITELINKS): each id asked, with its titles in the sites the
 * filter names; an item the table lacks has none (as if no edition but its lists' had it). @param {Record<string, any>} [table] items by id
 * @returns {(url: string) => any}
 */
export const wikidataOf = (table = SITELINKS.entities) => (url) => {
  const u = new URL(url).searchParams;
  const sites = new Set(String(u.get('sitefilter')).split('|'));
  const entities = Object.fromEntries(String(u.get('ids')).split('|').map((id) => [id, { type: 'item', id,
    sitelinks: Object.fromEntries(Object.entries(table[id]?.sitelinks ?? {}).filter(([site]) => sites.has(site))) }]));
  return { entities, success: 1 };
};

/**
 * An edition's Wikipedia answering the second stage's request by titles (prop=extracts|pageprops, as it answers: formatversion 2, each page its
 * title, its item and a summary) from Wikidata's items: a title no item has there is missing. The summaries are made up for the tests.
 * @param {Record<string, any>} [table] Wikidata's items by id @returns {(url: string) => any}
 */
export const summariesFrom = (table = SITELINKS.entities) => (url) => {
  const u = new URL(url);
  const site = `${u.hostname.split('.')[0].replace(/-/g, '_')}wiki`;
  const pages = String(u.searchParams.get('titles')).split('|').map((title, k) => {
    const id = Object.keys(table).find((x) => table[x].sitelinks?.[site]?.title === title);
    return id ? { pageid: 5000 + k, ns: 0, title, extract: `${title}: its summary on ${u.hostname}.`, pageprops: { wikibase_item: id } } : { ns: 0, title, missing: true };
  });
  return { batchcomplete: true, query: { pages } };
};
/** Yufuin's Wikipedia: the saved lists (yufuinAnswer), and articles by title from Wikidata's real titles (summariesFrom). @param {string} url */
export const yufuinWikipedia = (url) => (new URL(url).searchParams.has('titles') ? summariesFrom()(url) : yufuinAnswer(url));

/**
 * Stand-ins for Overpass, Wikipedia, Wikidata and Wikivoyage, answering as they do; each request is noted. Wikidata, unless given, knows no
 * item's other editions: a second stage asks it and nothing more.
 * @param {{ overpass?: (url: string, init: any) => any, wikipedia?: (url: string, init: any) => any, wikidata?: (url: string, init: any) => any, wikivoyage?: (url: string, init: any) => any }} [o]
 */
export function services(o = {}) {
  /** @type {{ url: string, init: any, at: number }[]} */
  const asked = [];
  /** @param {string} url @param {any} [init] */
  const fetch = async (url, init = {}) => {
    asked.push({ url, init, at: Date.now() });
    const host = new URL(url).hostname;
    // Every Overpass server answers at /api/interpreter: overpass-api.de's, and VK's at maps.mail.ru/osm/tools/overpass.
    // Wikipedia at any edition's host: the stand-in for Big Sur answers in English only, as an edition with nothing there answers; Wikivoyage at any edition's.
    const answer = url.endsWith('/api/interpreter') ? o.overpass ?? overpass : host.endsWith('.wikipedia.org') ? o.wikipedia ?? (host === 'en.wikipedia.org' ? wikipedia : () => ({ batchcomplete: true }))
      : host === 'www.wikidata.org' ? o.wikidata ?? wikidataOf({}) : host.endsWith('.wikivoyage.org') ? o.wikivoyage ?? wikivoyage : () => new Response('', { status: 404 });
    const a = await answer(url, init);
    return a instanceof Response ? a : new Response(JSON.stringify(a));
  };
  return { fetch, asked };
}

/** Wikipedia's real answers to the pack's query at Yufuin Station, 10 km, 20 at most, by edition (2026-11-19; text under CC BY-SA 4.0). */
export const YUFUIN_WIKI = Object.fromEntries(await Promise.all(['ja', 'en'].map(async (e) => [e, JSON.parse(await readFile(new URL(`../fixtures/places/wiki-pack-yufuin-${e}.json`, import.meta.url), 'utf8'))])));
export const YUFUIN = { lat: 33.2627, lng: 131.3553 };
export const yufuinStop = (/** @type {string} */ id, /** @type {{ lat: number, lng: number }} */ at, /** @type {number} */ hour) => ({ id, title: id, fixed: false, start: { at: `2026-12-01T0${hour}:00:00Z`, tz: 'Asia/Tokyo' }, place: { name: id, ...at } });
/**
 * An edition's saved answer by the host asked, as geosearch gives it for the point asked about: the saved articles (taken at Yufuin Station) within
 * the radius of the request's point, nearest first, at most its limit; less the pages named. @param {string} url @param {string[]} [without]
 */
export const yufuinAnswer = (url, without = []) => {
  const u = new URL(url).searchParams;
  const [lat, lng] = String(u.get('ggscoord')).split('|').map(Number);
  const r = YUFUIN_WIKI[new URL(url).hostname.split('.')[0]];
  if (!r) return { batchcomplete: true };
  const dist = (/** @type {any} */ p) => meters({ lat, lng }, { lat: p.coordinates[0].lat, lng: p.coordinates[0].lon });
  const pages = r.query.pages.filter((/** @type {any} */ p) => !without.includes(p.title) && dist(p) <= Number(u.get('ggsradius')))
    .sort((a, b) => dist(a) - dist(b)).slice(0, Number(u.get('ggslimit')));
  return { ...r, query: { pages } };
};
/** Shiori as the pack keeper sees her: the open trip, and an "open" event. @param {string | null} target */
export function fakeAgent(target) {
  /** @type {Set<() => void>} */
  const fns = new Set();
  return {
    target,
    on(/** @type {string} */ kind, /** @type {() => void} */ fn) {
      if (kind === 'open') fns.add(fn);
      return () => fns.delete(fn);
    },
    open(/** @type {string | null} */ t) {
      this.target = t;
      for (const fn of fns) fn();
    },
  };
}
