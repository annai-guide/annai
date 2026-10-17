import { meters } from '../live/geo.js';
import { PLAN_FILE, LEG_MAX_KM } from '../plan.js';

/**
 * What a trip's offline pack holds (spec §11.5), worked out from its plan. The stops are the plan's
 * items with a place, in the order of their times. Around each stop, OpenStreetMap places within
 * 5 km; between one stop and the next, within 3 km of the straight line (legs are straight lines:
 * there is no routing); Wikipedia summaries at each stop and every 15 km on the way. Wikivoyage
 * guides are found when downloading, from the names here and Wikipedia's (choice 3).
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {[lat: number, lng: number]} LatLng
 * @typedef {{ id: string, kind: 'osm', label: string, points: LatLng[], radius: number, km: number }} OsmPart
 *   points: one (around a stop) or two (a stretch of a leg); km: the stretch's length, 0 around a stop
 * @typedef {{ id: string, kind: 'wikipedia', label: string, at: LatLng }} WikiPart
 * @typedef {OsmPart | WikiPart} Part
 * @typedef {{ name: string, lat: number, lng: number }} Stop
 * @typedef {{ key: string, stops: Stop[], parts: Part[], names: string[], cut: number }} PackPlan
 *   key: changes when the parts or the names do; names: what to look for in Wikivoyage, the trip's
 *   places first; cut: stops and legs left out, all or in part, because the pack would be too large
 */

export const STOP_M = 5000;
export const CORRIDOR_M = 3000;
export const STRETCH_KM = 40;
export const WIKI_EVERY_KM = 15;
export const WIKI_APART_KM = 7;
export const WIKI_RADIUS_M = 10000; // the largest Wikipedia searches
export const MAX_OSM = 100;
export const MAX_WIKI = 100;
export const MAX_GUIDES = 12;

/** Rough sizes, from real answers along Big Sur in October 2026, for the estimate shown before downloading (choice 9). */
export const SIZES = Object.freeze({ osmPerKm: 1024, osmStop: 20 * 1024, wikipedia: 11 * 1024, guide: 30 * 1024 });

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

/** @param {LatLng[]} points @param {number} radius @param {number} km @param {string} label @returns {OsmPart} */
function osmPart(points, radius, km, label) {
  return { id: `o${hashId(`osm ${radius} ${points.map((p) => p.join(',')).join(' ')}`)}`, kind: 'osm', label, points, radius, km };
}

/** @param {LatLng} at @param {string} label @returns {WikiPart} */
function wikiPart(at, label) {
  return { id: `w${hashId(`wikipedia ${at.join(',')}`)}`, kind: 'wikipedia', label, at };
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
  let cut = 0;
  const wikiNear = (/** @type {LatLng} */ p) => wiki.some((w) => meters(pt(w.at), pt(p)) < WIKI_APART_KM * 1000);
  // The stops first, so a long plan keeps them all before the way between them.
  for (const s of stops) {
    const here = /** @type {LatLng} */ ([r4(s.lat), r4(s.lng)]);
    const osmDone = osm.some((o) => o.km === 0 && meters(pt(o.points[0]), s) < 1000);
    const wikiDone = wikiNear(here);
    if ((!osmDone && osm.length >= MAX_OSM) || (!wikiDone && wiki.length >= MAX_WIKI)) cut++;
    if (!osmDone && osm.length < MAX_OSM) osm.push(osmPart([here], STOP_M, 0, `around ${s.name}`));
    if (!wikiDone && wiki.length < MAX_WIKI) wiki.push(wikiPart(here, `near ${s.name}`));
  }
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, b] = [stops[i], stops[i + 1]];
    const km = meters(a, b) / 1000;
    if (km > LEG_MAX_KM || km * 1000 <= STOP_M) continue; // a flight; or the stops' own circles reach
    const label = `between ${a.name} and ${b.name}`;
    const n = Math.ceil(km / STRETCH_KM);
    let whole = true;
    for (let k = 0; k < n; k++) {
      const part = osmPart([between(a, b, k / n), between(a, b, (k + 1) / n)], CORRIDOR_M, Math.round((km / n) * 10) / 10, label);
      if (osm.some((o) => o.id === part.id)) continue;
      if (osm.length >= MAX_OSM) whole = false;
      else osm.push(part);
    }
    for (let d = WIKI_EVERY_KM; d < km - WIKI_APART_KM / 2; d += WIKI_EVERY_KM) {
      const p = between(a, b, d / km);
      if (wikiNear(p)) continue;
      if (wiki.length >= MAX_WIKI) whole = false;
      else wiki.push(wikiPart(p, label));
    }
    if (!whole) cut++;
  }
  const places = (Array.isArray(trip?.places) ? trip.places : []).filter((/** @type {unknown} */ x) => typeof x === 'string' && x.trim());
  const names = [...new Set([...places.map((/** @type {string} */ x) => x.trim().replace(/\s+/g, ' ')), ...stops.map((s) => s.name)])];
  const parts = [...osm, ...wiki];
  return { key: hashId(JSON.stringify([parts.map((p) => p.id), names])), stops, parts, names, cut };
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

/** About how many bytes some parts and guides take (spec §11.5: shown before downloading). @param {Part[]} parts @param {number} guides */
export function estimate(parts, guides) {
  let n = guides * SIZES.guide;
  for (const p of parts) n += p.kind === 'wikipedia' ? SIZES.wikipedia : p.km > 0 ? p.km * SIZES.osmPerKm : SIZES.osmStop;
  return Math.round(n);
}

/** About how many guides a plan's pack gets: one for every two names it looks for, at most 12. @param {PackPlan} plan */
export function likelyGuides(plan) {
  return Math.min(MAX_GUIDES, Math.ceil(plan.names.length / 2));
}

/** The Wikivoyage titles a name may be under: as it is, and "Cambria (California)" for "Cambria, California". @param {string} name */
export function guideTitles(name) {
  const n = String(name).trim().replace(/\s+/g, ' ');
  if (!n) return [];
  const m = /^(.+?), ([^,]+)$/.exec(n);
  return m ? [n, `${m[1]} (${m[2]})`] : [n];
}
