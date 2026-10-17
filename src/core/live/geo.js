/**
 * Where the user is, worked out on the phone (spec §11): distances, which GPS points are kept
 * (§4.5), and the rough travel-time estimate the plan's reminders use (§11.3).
 * @typedef {'gps' | 'manual' | 'sim'} FixSource  manual: the user said where they are (spec §17); sim: a simulation (§13)
 * @typedef {{ lat: number, lng: number, accuracy: number, at: number, speed: number | null, heading: number | null, source: FixSource }} Fix
 *   accuracy: meters; at: ms; speed: m/s, from the GPS, when it gives one
 * @typedef {{ lat: number, lng: number }} Point
 */

const EARTH_M = 6_371_000;
const rad = (/** @type {number} */ d) => (d * Math.PI) / 180;

/** Meters between two points (haversine). @param {Point} a @param {Point} b */
export function meters(a, b) {
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return EARTH_M * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** A number that is finite and not negative, else null. @param {unknown} v */
const plain = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** A sensor's position as a Fix, or null when it isn't one. @param {any} raw @param {number} now @returns {Fix | null} */
export function fixOf(raw, now) {
  const lat = raw?.lat;
  const lng = raw?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const source = raw.source === 'manual' || raw.source === 'sim' ? raw.source : 'gps';
  return { lat, lng, accuracy: plain(raw.accuracy) ?? 50, at: plain(raw.at) ?? now, speed: plain(raw.speed), heading: plain(raw.heading), source };
}

/** A point is kept after moving about this far (spec §4.5)… */
export const KEEP_M = 20;
/** …or after this long while moving. */
export const KEEP_MS = 60_000;

/**
 * Whether a fix is kept as a location point (spec §4.5): after moving about 20 m, or the GPS
 * accuracy if worse, or after a minute while moving.
 * @param {Fix | null} last the last point kept @param {Fix} fix @param {boolean} moving
 */
export function keep(last, fix, moving) {
  if (!last) return true;
  if (meters(last, fix) >= Math.max(KEEP_M, fix.accuracy)) return true;
  return moving && fix.at - last.at >= KEEP_MS;
}

/** The rough travel estimate (spec §11.3): straight-line distance × a detour factor ÷ a typical speed, so reminders err early. */
export const TRAVEL = Object.freeze({ drive: { detour: 1.4, kmh: 50, words: 'by car' }, walk: { detour: 1.3, kmh: 4.5, words: 'on foot' } });

/** Minutes to travel km in a straight line, by mode, rounded up. @param {number} km @param {'drive' | 'walk'} mode */
export function travelMinutes(km, mode) {
  const t = TRAVEL[mode];
  return Math.ceil(((km * t.detour) / t.kmh) * 60);
}

/** On foot for 2 km or less unless moving fast; anything else by car. @param {number} km @param {string} activity @returns {'drive' | 'walk'} */
export function modeFor(km, activity) {
  return km <= 2 && activity !== 'moving-fast' ? 'walk' : 'drive';
}

/** "850 m", "12.3 km": for Shiori, who gives the user their own units (§14.3). @param {number} m meters */
export function kmText(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** "42 min", "2 h 5 min". @param {number} ms */
export function span(ms) {
  if (ms < 60_000) return 'less than a minute';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}
