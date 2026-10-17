import { dayIn, validZone } from '../time.js';

/**
 * Stamps (spec §13), like a station stamp book: each arrival at a plan place or a named point of
 * interest earns one. They are worked out from the log's trigger.fired entries whenever they are
 * shown, and never stored. Live mode writes an arrival's place name into its entry as it fires
 * (choice 1); one place earns one stamp a day (choice 2).
 * @typedef {{ name: string, lat: number, lng: number, at: number, plan: boolean }} Stamp
 *   plan: the arrival was the plan's own, at a plan item's place
 */

/**
 * Whether a trigger.fired entry's data is an arrival: the plan's "arrived", the plan's "stopped
 * somewhere not on the plan", or an arrived watch (choice 1). @param {any} d
 */
export function isArrival(d) {
  return d?.type === 'arrived' || (d?.type === 'plan' && (d.event === 'arrived' || d.event === 'linger'));
}

/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The stamps a trip has earned, oldest first.
 * @param {{ ts: number, data?: any }[]} fired its trigger.fired entries
 * @param {string} tz the trip's zone, for an arrival that doesn't name its own: a place earns one stamp a day, in the zone it was earned in
 * @returns {Stamp[]}
 */
export function stampsOf(fired, tz) {
  /** @type {Stamp[]} */
  const out = [];
  const seen = new Set();
  for (const e of [...fired].sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0))) {
    const d = e?.data;
    const p = d?.place;
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!isArrival(d) || !name || !finite(p.lat) || !finite(p.lng) || !finite(e.ts)) continue;
    const key = `${name.toLowerCase()}\n${dayIn(e.ts, validZone(d.tz) ? d.tz : tz)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, lat: p.lat, lng: p.lng, at: e.ts, plan: d.type === 'plan' && d.event === 'arrived' });
  }
  return out;
}

const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The words on a stamp (choice 3): two characters of a Chinese, Japanese or Korean name; otherwise
 * the first word (spaces and hyphens part words), with the next when the first has three letters or
 * fewer, at most 12 characters.
 * @param {string} name
 */
export function stampLabel(name) {
  const n = String(name ?? '').trim();
  if (CJK.test(n)) return [...n].slice(0, 2).join('');
  const words = n.split(/[\s-]+/).filter(Boolean); // a hyphen parts words too (Kiyomizu-dera)
  let label = words[0] ?? '';
  if ([...label].length <= 3 && words[1]) label = `${label} ${words[1]}`;
  return [...label].slice(0, 12).join('');
}

/** "1 stamp", "5 stamps". @param {number} n */
export const stampCount = (n) => `${n} ${n === 1 ? 'stamp' : 'stamps'}`;
