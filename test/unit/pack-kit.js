import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';

/** Two Big Sur stops, 21 km apart. */
export const STOPS = Object.freeze({
  bixby: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2026-11-27T17:45:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
  nepenthe: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: '2026-11-27T20:00:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
});

/** A trip with the two stops. */
export async function packTrip() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(trip, '/plan/bixby.json', STOPS.bixby, { author: 'user' });
  await ws.write(trip, '/plan/nepenthe.json', STOPS.nepenthe, { author: 'user' });
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

/** What Wikipedia has near Bixby and near Nepenthe. @param {string} url */
export function wikipedia(url) {
  const page = (/** @type {string} */ title, /** @type {number} */ lat, /** @type {number} */ lon, /** @type {string} */ extract) => ({ title, coordinates: [{ lat, lon }], extract });
  if (url.includes('ggscoord=36.3715')) {
    return { query: { pages: [page('Bixby Creek Bridge', 36.3715, -121.9017, 'Bixby Creek Bridge is a reinforced concrete open-spandrel arch bridge in Big Sur.'), page('Big Sur', 36.2704, -121.8081, 'Big Sur is a rugged and mountainous section of the Central Coast of California.')] } };
  }
  return { query: { pages: [page('Nepenthe (restaurant)', 36.2203, -121.7612, 'Nepenthe is a restaurant in Big Sur.'), page('Cambria, California', 36.21, -121.75, 'Cambria is a seaside town.'), page('Big Sur', 36.2704, -121.8081, 'Big Sur is a rugged section of coast.')] } };
}

const GUIDES = /** @type {Record<string, string>} */ ({
  'Big Sur': 'Big Sur is a region.\n\n== Understand ==\nRugged coast.\n\n== Eat ==\nNepenthe.',
  'Cambria (California)': 'Cambria is a town.\n\n== See ==\nMoonstone Beach.',
});

/** Wikivoyage: which titles it has (Hearst Castle leads to San Simeon), and their text. @param {string} url */
export function wikivoyage(url) {
  const u = new URL(url);
  const titles = (u.searchParams.get('titles') ?? '').split('|');
  if (u.searchParams.get('prop') === 'pageprops') {
    return { query: { redirects: [{ from: 'Hearst Castle', to: 'San Simeon' }], pages: titles.map((t) => (GUIDES[t] ? { title: t } : t === 'Nepenthe' ? { title: t, pageprops: { disambiguation: '' } } : { title: t, missing: true })) } };
  }
  return { query: { pages: [{ title: titles[0], extract: GUIDES[titles[0]] ?? '' }] } };
}

/**
 * Stand-ins for Overpass, Wikipedia and Wikivoyage, answering as they do; each request is noted.
 * @param {{ overpass?: (url: string, init: any) => any, wikipedia?: (url: string, init: any) => any, wikivoyage?: (url: string, init: any) => any }} [o]
 */
export function services(o = {}) {
  /** @type {{ url: string, init: any, at: number }[]} */
  const asked = [];
  /** @param {string} url @param {any} [init] */
  const fetch = async (url, init = {}) => {
    asked.push({ url, init, at: Date.now() });
    const host = new URL(url).hostname;
    const answer = host.includes('overpass') ? o.overpass ?? overpass : host === 'en.wikipedia.org' ? o.wikipedia ?? wikipedia : host === 'en.wikivoyage.org' ? o.wikivoyage ?? wikivoyage : () => new Response('', { status: 404 });
    const a = await answer(url, init);
    return a instanceof Response ? a : new Response(JSON.stringify(a));
  };
  return { fetch, asked };
}

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
