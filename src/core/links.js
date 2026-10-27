import { SYS_SETTINGS } from './scopes.js';

/**
 * The link catalog (spec §7.2): URL formats for directions and for flight, hotel and car searches,
 * fetched from annai's site and kept for offline use, so a site's new URL format reaches every
 * copy of annai without a release.
 * @typedef {{ id: string, name: string, directions: string, modes: Record<string, string> }} MapsFormat
 * @typedef {{ id: string, name: string, url: string, needs: string[] }} SearchFormat
 * @typedef {{ format: 1, maps: MapsFormat[], search: Record<string, SearchFormat[]> }} LinkCatalog
 * @typedef {{ label: string, url: string }} Link
 */

export const LINKS_CACHE = '/catalog/links.json';
const DATE_PARAMS = new Set(['depart', 'return', 'checkin', 'checkout', 'pickup', 'dropoff']);
const https = (/** @type {unknown} */ u) => typeof u === 'string' && u.startsWith('https://');

/** @param {any} j @returns {j is LinkCatalog} */
export function validLinks(j) {
  return j?.format === 1 && Array.isArray(j.maps)
    && j.maps.every((/** @type {any} */ m) => typeof m?.id === 'string' && typeof m.name === 'string' && https(m.directions) && m.modes && typeof m.modes === 'object')
    && Boolean(j.search) && typeof j.search === 'object'
    && Object.values(j.search).every((list) => Array.isArray(list) && list.every((/** @type {any} */ f) => typeof f?.id === 'string' && typeof f.name === 'string' && https(f.url) && Array.isArray(f.needs)));
}

/** @type {WeakMap<object, Promise<LinkCatalog | null>>} the catalog of each workspace, fetched once a session */
const loaded = new WeakMap();

/**
 * The catalog: fetched once a session when online and kept for offline use; null when annai
 * never got it.
 * @param {{ ws: { write: Function, readJSON: Function }, fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string }} c
 * @returns {Promise<LinkCatalog | null>}
 */
export function loadLinks({ ws, fetch: get = (url, init) => fetch(url, init), base = '' }) {
  let p = loaded.get(ws);
  if (!p) {
    p = fetchLinks(ws, get, base);
    loaded.set(ws, p);
    // Not got: the next call tries again (the app may be online by then).
    p.then((c) => { if (!c) loaded.delete(ws); }, () => loaded.delete(ws));
  }
  return p;
}

/** @param {{ write: Function, readJSON: Function }} ws @param {(url: string, init?: RequestInit) => Promise<Response>} get @param {string} base */
async function fetchLinks(ws, get, base) {
  try {
    const res = await get(`${base}/catalog/links.json`, { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      if (validLinks(json)) {
        await ws.write(SYS_SETTINGS, LINKS_CACHE, json, { author: 'system' }).catch(() => {});
        return json;
      }
    }
  } catch {
    // offline: the copy from last time
  }
  const cached = await ws.readJSON(SYS_SETTINGS, LINKS_CACHE).catch(() => null);
  return validLinks(cached) ? cached : null;
}

/**
 * A URL from a format: {name} is the value, URI-encoded; a [part] is dropped when a value in it
 * is missing or blank.
 * @param {string} format @param {Record<string, unknown>} values
 */
export function expandLink(format, values) {
  const value = (/** @type {string} */ k) => {
    const v = values[k];
    return v === undefined || v === null || String(v).trim() === '' ? null : encodeURIComponent(String(v).trim());
  };
  return format
    .replace(/\[([^[\]]*)\]/g, (_, part) => ([...part.matchAll(/\{(\w+)\}/g)].every((m) => value(m[1]) !== null) ? part : ''))
    .replace(/\{(\w+)\}/g, (_, k) => value(k) ?? '');
}

/**
 * Directions to a place in each maps app that has the mode (spec §7.2 maps_link).
 * @param {LinkCatalog} catalog @param {{ destination: string, origin?: string, mode?: string }} o @returns {Link[]}
 */
export function mapsLinks(catalog, { destination, origin, mode = 'drive' }) {
  if (!String(destination ?? '').trim()) /* en */ throw new Error('maps_link needs a destination: a name, an address, or "lat,lng".');
  // Own keys only: the mode comes from the model, and "toString" isn't a mode.
  const value = (/** @type {MapsFormat} */ m) => (Object.hasOwn(m.modes, mode) ? m.modes[mode] : null);
  const out = catalog.maps.filter((m) => value(m)).map((m) => ({ label: m.name, url: expandLink(m.directions, { destination, origin, mode: value(m) }) }));
  if (!out.length) /* en */ throw new Error(`No maps app here gives ${mode} directions. Try drive, walk or transit.`);
  return out;
}

/**
 * Prefilled searches on booking sites (spec §7.2 search_link): every format whose needs are met.
 * @param {LinkCatalog} catalog @param {string} kind @param {Record<string, unknown>} params @returns {Link[]}
 */
export function searchLinks(catalog, kind, params = {}) {
  const formats = Object.hasOwn(catalog.search, kind) ? catalog.search[kind] : null;
  if (!formats?.length) /* en */ throw new Error(`search_link knows ${Object.keys(catalog.search).join(', ')} searches, not "${kind}".`);
  for (const [k, v] of Object.entries(params)) {
    if (DATE_PARAMS.has(k) && v !== undefined && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) /* en */ throw new Error(`${k} must be a date written YYYY-MM-DD, like 2026-11-25.`);
  }
  const usable = formats.filter((f) => f.needs.every((n) => String(params[n] ?? '').trim()));
  if (!usable.length) /* en */ throw new Error(`A ${kind} search needs ${formats[0].needs.join(', ')}.`);
  return usable.map((f) => ({ label: f.name, url: expandLink(f.url, params) }));
}
