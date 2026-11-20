import { meters } from '../live/geo.js';
import { PLAN_FILE, LEG_MAX_KM } from '../plan.js';

/**
 * What a trip's offline pack holds (spec §11.5), worked out from its plan. The stops are the plan's
 * items with a place, in the order of their times. Around each stop, OpenStreetMap places within
 * 5 km; between one stop and the next, within 3 km of the straight line (legs are straight lines:
 * there is no routing); Wikipedia summaries at each stop and every 15 km on the way (each edition's nearest 20, and with more than one
 * edition, each edition's summary of the articles the others' lists hold). Wikivoyage guides are found when downloading, from the names here
 * and Wikipedia's.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {[lat: number, lng: number]} LatLng
 * @typedef {{ how: 'around' | 'near' | 'between', names: string[] }} Place  where a part is, as data: around or near a stop, or between two
 * @typedef {{ id: string, kind: 'osm', label: string, place: Place, points: LatLng[], radius: number, km: number }} OsmPart
 *   label: where it is, in annai's English (the log's); points: one (around a stop) or two (a stretch of a leg); km: the stretch's length, 0 around a stop
 * @typedef {{ id: string, kind: 'wikipedia', label: string, place: Place, at: LatLng }} WikiPart
 * @typedef {OsmPart | WikiPart} Part
 * @typedef {{ name: string, lat: number, lng: number }} Stop
 * @typedef {{ key: string, stops: Stop[], parts: Part[], names: string[] }} PackPlan
 *   key: changes when the parts or the names do; names: what to look for in Wikivoyage, the trip's
 *   places first. Every stop and leg is in it, however long the trip: a long one takes longer to download (Overpass answers a part in
 *   about 35 to 54 s), and a download that stops goes on from there the next time.
 */

export const STOP_M = 5000;
export const CORRIDOR_M = 3000;
export const STRETCH_KM = 40;
export const WIKI_EVERY_KM = 15;
export const WIKI_APART_KM = 7;
export const WIKI_RADIUS_M = 10000; // the largest Wikipedia searches

/**
 * Rough sizes for the estimate shown before downloading, as stored (the editions design's measurements, 2026-11-20, real answers at made-up
 * stops at real places):
 * - osmStop: the mean of the 82 stop parts of three made-up trips (Taipei and Jiufen; Tokyo to Hiroshima; a US road trip), partly inferred:
 *   sized from one measured town's part (Takayama, the pack's own query: 514 places, 36.6 KB) and a city's at Overpass's 3000 places (about
 *   240 KB at Takayama's 71 bytes a place, not downloaded: every kind within 1 km is already 1,150 places at Tokyo Station).
 * - osmPerKm: a stretch's bytes a kilometre, not measured (both built-up stretches asked timed out): kept from the first estimate, made
 *   from a real Big Sur pack (October 2026, 143 KB for 19 parts and 4 guides), open coast, not town.
 * - wikipedia: an English part's 20 summaries, the mean of 6 measured parts (7.0 to 8.8 KB), rounded.
 * - wikiEdition: another edition's part, Japanese and Chinese parts measured at 10.0 to 12.3 KB (3 bytes a character), rounded.
 * - guide: an English guide, the mean of 7 measured (11 to 130 KB), rounded.
 * - guideEdition: another edition's guide, wanted for each English one: the 13 Japanese and Chinese guides measured were 1.5 to 35 KB
 *   (mean 13 KB), and 7 of 12 English guides have a Japanese one, 7 of 12 a Chinese one, so 13 × 7/12, rounded up.
 * - wikiMore: a Wikipedia part's second stage, for each edition read past the first: stored at Tokyo Station (a real check of the pack's second
 *   stage, 2026-11-20) as 11.6 KiB with Japanese and English (22 summaries) and 24.0 KiB with Japanese, Chinese and English (49), in KiB as the
 *   figures here are (the same two files as 11.9 and 24.5 kB): 12 KiB an edition past the first, as each edition added brings its 20 articles'
 *   summaries in the others (the editions design's by-title answers at Tokyo, 2.7, 6.2 and 4.6 KB in zh, ja and en, before rows and ids). Four
 *   and five editions are not measured: taken as linear, 12 KiB for each past the first.
 */
export const SIZES = Object.freeze({ osmPerKm: 512, osmStop: 110 * 1024, wikipedia: 8 * 1024, wikiEdition: 11 * 1024, wikiMore: 12 * 1024, guide: 65 * 1024, guideEdition: 8 * 1024 });

const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
const pt = (/** @type {LatLng} */ p) => ({ lat: p[0], lng: p[1] });
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);

/** A short fingerprint of some text (cyrb53), in digits and letters. @param {string} s */
export function hashId(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The point a fraction of the way from a to b in a straight line, the short way across the date line. @param {Stop} a @param {Stop} b @param {number} f @returns {LatLng} */
function between(a, b, f) {
  let d = b.lng - a.lng;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  let lng = a.lng + d * f;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return [r4(a.lat + (b.lat - a.lat) * f), r4(lng)];
}

/** Where a part is, in annai's English. @param {Place} place */
export const labelOf = ({ how, names }) => /* en */ (how === 'between' ? `between ${names[0]} and ${names[1]}` : `${how} ${names[0]}`);

/** @param {LatLng[]} points @param {number} radius @param {number} km @param {Place} place @returns {OsmPart} */
function osmPart(points, radius, km, place) {
  return { id: `o${hashId(`osm ${radius} ${points.map((p) => p.join(',')).join(' ')}`)}`, kind: 'osm', label: labelOf(place), place, points, radius, km };
}

/** @param {LatLng} at @param {Place} place @returns {WikiPart} */
function wikiPart(at, place) {
  return { id: `w${hashId(`wikipedia ${at.join(',')}`)}`, kind: 'wikipedia', label: labelOf(place), place, at };
}

/**
 * The plan's stops in time order (items without a time last), the same place twice in a row once.
 * @param {{ path: string, item: any }[]} items @returns {Stop[]}
 */
export function planStops(items) {
  const placed = items.filter(({ item }) => item && typeof item === 'object' && isNum(item.place?.lat) && isNum(item.place?.lng)
    && Math.abs(item.place.lat) <= 90 && Math.abs(item.place.lng) <= 180);
  const at = (/** @type {any} */ it) => {
    const t = Date.parse(it.start?.at ?? '');
    return Number.isFinite(t) ? t : Infinity;
  };
  placed.sort((a, b) => at(a.item) - at(b.item) || a.path.localeCompare(b.path));
  /** @type {Stop[]} */
  const out = [];
  for (const { item } of placed) {
    const s = { name: String(item.place.name ?? item.title ?? '').trim() || 'a plan stop', lat: item.place.lat, lng: item.place.lng };
    const last = out[out.length - 1];
    if (!last || meters(last, s) >= 50) out.push(s);
  }
  return out;
}

/** @param {{ trip: any, items: { path: string, item: any }[] }} o @returns {PackPlan} */
export function packPlan({ trip, items }) {
  const stops = planStops(items);
  /** @type {OsmPart[]} */
  const osm = [];
  /** @type {WikiPart[]} */
  const wiki = [];
  const wikiNear = (/** @type {LatLng} */ p) => wiki.some((w) => meters(pt(w.at), pt(p)) < WIKI_APART_KM * 1000);
  // The stops first, then the way between them, in OpenStreetMap's parts and then Wikipedia's. A download takes every Wikipedia part's lists first,
  // then the guides, the second stages, and OpenStreetMap's parts (download.js), each in this order: one stopped partway has the stops' before the way's.
  for (const s of stops) {
    const here = /** @type {LatLng} */ ([r4(s.lat), r4(s.lng)]);
    if (!osm.some((o) => o.km === 0 && meters(pt(o.points[0]), s) < 1000)) osm.push(osmPart([here], STOP_M, 0, { how: 'around', names: [s.name] }));
    if (!wikiNear(here)) wiki.push(wikiPart(here, { how: 'near', names: [s.name] }));
  }
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, b] = [stops[i], stops[i + 1]];
    const km = meters(a, b) / 1000;
    if (km > LEG_MAX_KM || km * 1000 <= STOP_M) continue; // a flight; or the stops' own circles reach
    /** @type {Place} */
    const place = { how: 'between', names: [a.name, b.name] };
    const n = Math.ceil(km / STRETCH_KM);
    for (let k = 0; k < n; k++) {
      const part = osmPart([between(a, b, k / n), between(a, b, (k + 1) / n)], CORRIDOR_M, Math.round((km / n) * 10) / 10, place);
      if (!osm.some((o) => o.id === part.id)) osm.push(part);
    }
    for (let d = WIKI_EVERY_KM; d < km - WIKI_APART_KM / 2; d += WIKI_EVERY_KM) {
      const p = between(a, b, d / km);
      if (!wikiNear(p)) wiki.push(wikiPart(p, place));
    }
  }
  const places = (Array.isArray(trip?.places) ? trip.places : []).filter((/** @type {unknown} */ x) => typeof x === 'string' && x.trim());
  const names = [...new Set([...places.map((/** @type {string} */ x) => x.trim().replace(/\s+/g, ' ')), ...stops.map((s) => s.name)])];
  const parts = [...osm, ...wiki];
  return { key: hashId(JSON.stringify([parts.map((p) => p.id), names])), stops, parts, names };
}

/** A trip's pack plan, from its files. @param {Workspace} ws @param {string} scope @returns {Promise<PackPlan>} */
export async function planFor(ws, scope) {
  const trip = await ws.readJSON(scope, '/trip.json').catch(() => null);
  /** @type {{ path: string, item: any }[]} */
  const items = [];
  for (const f of await ws.list(scope, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const item = await ws.readJSON(scope, f.path).catch(() => null);
    if (item) items.push({ path: f.path, item });
  }
  return packPlan({ trip, items });
}

/**
 * About how many bytes some of a pack's files and guides take (spec §11.5: shown before downloading).
 * @param {{ part: Part, edition: string | null, editions?: string[] }[]} files as wanted() in download.js gives them @param {number} guides how many guides
 * @param {string[]} editions the guides' Wikivoyage editions to count (English's at SIZES.guide, another's at SIZES.guideEdition)
 */
export function estimate(files, guides, editions) {
  let n = guides * editions.reduce((sum, e) => sum + (e === 'en' ? SIZES.guide : SIZES.guideEdition), 0);
  for (const { part: p, edition, editions: read } of files) {
    n += read ? (read.length - 1) * SIZES.wikiMore : p.kind === 'wikipedia' ? (edition === 'en' ? SIZES.wikipedia : SIZES.wikiEdition) : p.km > 0 ? p.km * SIZES.osmPerKm : SIZES.osmStop;
  }
  return Math.round(n);
}

/** About how many guides a plan's pack gets: one for every two names it looks for. @param {PackPlan} plan */
export function likelyGuides(plan) {
  return Math.ceil(plan.names.length / 2);
}

/** The Wikivoyage titles a name may be under: as it is, and "Cambria (California)" for "Cambria, California". @param {string} name */
export function guideTitles(name) {
  const n = String(name).trim().replace(/\s+/g, ' ');
  if (!n) return [];
  const m = /^(.+?), ([^,]+)$/.exec(n);
  return m ? [n, `${m[1]} (${m[2]})`] : [n];
}
