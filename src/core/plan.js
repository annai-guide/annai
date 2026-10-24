import { dayIn, timeIn, validZone, offsetMinutes } from './time.js';
import { zone, sortWords } from '../ui/format.js';

/**
 * The Plan screen's timetable (spec §16.2): rows by local day with ● fixed and ○ flexible, the
 * legs between stops, and "Check this" for bookings the user hasn't confirmed (§7.3).
 * @typedef {{ path: string, item: Record<string, any> }} PlanFile
 * @typedef {{ path: string, booking: Record<string, any> }} BookingFile
 * @typedef {{ path: string, item: Record<string, any>, at: number | null, day: string | null, time: string, end: string,
 *   endDays: number, endZone: string, bookingPath: string | null, booking: Record<string, any> | null, check: boolean,
 *   missing: boolean, note: string }} PlanRow
 *   time and end: "HH:MM" in the item's own zones ('' when there is none, and for an all-day item); endDays: how many days
 *   after the row's day the end falls, on the end's own clock (a red-eye's 1); endZone: the end's zone, named ("ET"), when
 *   its clock reads differently from the start's ('' when it doesn't, and when there is no end); check: its booking isn't
 *   confirmed (whatever else it says, the user checks it); missing: it names a booking the trip doesn't have; note: what
 *   was wrong with its time
 */

export const LEG_MAX_KM = 1000; // farther than a day's drive: a flight, not a leg

/** Where plan items and bookings live: directly in their folder, which is what the format check and the booking rule cover (§4.4). */
export const PLAN_FILE = /^\/plan\/[^/]+\.json$/;
export const BOOKING_FILE = /^\/bookings\/[^/]+\.json$/;

/** "/trip/bookings/x.json" and "/bookings/x.json" both name the trip's /bookings/x.json. @param {unknown} ref */
export function bookingRef(ref) {
  if (typeof ref !== 'string') return null;
  const p = ref.replace(/^\/trip(?=\/)/, '');
  return BOOKING_FILE.test(p) ? p : null;
}

/**
 * @param {PlanFile[]} items @param {BookingFile[]} bookings
 * @param {{ fallbackTz: string }} o the zone for a time whose own zone annai doesn't know
 * @returns {PlanRow[]}
 */
export function planRows(items, bookings, { fallbackTz }) {
  const byPath = new Map(bookings.map((b) => [b.path, b.booking]));
  return items.filter((x) => x.item && typeof x.item === 'object' && !Array.isArray(x.item)).map(({ path, item }) => {
    const at = Date.parse(item.start?.at ?? '');
    const timed = Number.isFinite(at);
    const own = item.start?.tz;
    const tz = validZone(own) ? own : fallbackTz;
    const endTz = validZone(item.end?.tz) ? item.end.tz : tz;
    const allDay = item.kind === 'all-day';
    const endAt = Date.parse(item.end?.at ?? '');
    const ends = timed && !allDay && Number.isFinite(endAt);
    const day = timed ? dayIn(at, tz) : null;
    const ref = bookingRef(item.booking);
    const booking = ref ? byPath.get(ref) ?? null : null;
    return {
      path, item,
      at: timed ? at : null,
      day,
      time: timed && !allDay ? timeIn(at, tz) ?? '' : '',
      end: ends ? timeIn(endAt, endTz) ?? '' : '',
      endDays: ends && day ? daysApart(day, dayIn(endAt, endTz) ?? day) : 0,
      // Another zone with the same clock (New York and Toronto) needs no name.
      endZone: ends && offsetMinutes(endAt, endTz) !== offsetMinutes(endAt, tz) ? zone(endAt, endTz) : '',
      bookingPath: ref,
      booking,
      check: booking !== null && booking.status !== 'confirmed',
      missing: item.booking !== undefined && item.booking !== '' && !booking,
      note: timed && !validZone(own) ? `Its time zone "${String(own ?? '')}" isn't one annai knows; shown in ${fallbackTz}.` : '',
    };
  });
}

/** Days from one "YYYY-MM-DD" to another. @param {string} from @param {string} to */
function daysApart(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Every date from start to end, at most 60; just start when there is no good end. @param {unknown} start @param {unknown} end */
function tripDays(start, end) {
  const date = (/** @type {unknown} */ d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN);
  const s = date(start);
  if (!Number.isFinite(s)) return [];
  const e = Number.isFinite(date(end)) && date(end) >= s ? date(end) : s;
  /** @type {string[]} */
  const out = [];
  for (let t = s; t <= e && out.length < 60; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Rows by day: every day of the trip (even empty), then any other day with something on it, in
 * order; each day's rows by time. Rows without a time are apart.
 * @param {PlanRow[]} rows @param {{ start?: unknown, end?: unknown }} trip
 * @returns {{ days: { key: string, rows: PlanRow[] }[], untimed: PlanRow[] }}
 */
export function planDays(rows, trip) {
  const keys = new Set(tripDays(trip.start, trip.end));
  for (const r of rows) if (r.day) keys.add(r.day);
  const byTitle = (/** @type {PlanRow} */ a, /** @type {PlanRow} */ b) => sortWords(String(a.item.title ?? ''), String(b.item.title ?? ''));
  return {
    days: [...keys].sort().map((key) => ({ key, rows: rows.filter((r) => r.day === key).sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || byTitle(a, b)) })),
    untimed: rows.filter((r) => !r.day).sort(byTitle),
  };
}

/** Straight-line km between two stops with places, or null (no places, the same place, or a flight apart). @param {PlanRow} a @param {PlanRow} b */
export function legKm(a, b) {
  const p = a.item.place;
  const q = b.item.place;
  if (![p?.lat, p?.lng, q?.lat, q?.lng].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const r = (/** @type {number} */ d) => (d * Math.PI) / 180;
  const x = Math.sin(r(q.lat - p.lat) / 2) ** 2 + Math.cos(r(p.lat)) * Math.cos(r(q.lat)) * Math.sin(r(q.lng - p.lng) / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return km >= 0.05 && km <= LEG_MAX_KM ? km : null;
}

/**
 * What Undo does for a file whose last changes are Shiori's (spec §11.5: "every replan is a set of
 * patches to the plan files, so it can be undone"): brings back the version from before all her
 * writes in a row, or, when those began by adding it, removes it. Null when the user changed it
 * last, or her last change was a delete.
 * @param {{ actor: string, type: string, old: string | null, was?: { old?: string } }[]} history oldest first
 * @returns {{ restore: string } | { remove: true } | null}
 */
export function beforeShiori(history) {
  let k = history.length;
  while (k > 0 && history[k - 1].actor === 'shiori' && history[k - 1].type === 'file.write') k--;
  if (k === history.length) return null;
  const first = history[k];
  if (first.old) return { restore: first.old };
  // A version from before hers that an import didn't carry (spec §12.3): she didn't add the item, and it can't come back.
  return first.was?.old ? null : { remove: true };
}

/**
 * What Undo does for each plan file Shiori changed last, from one read of the log (B7: not one for
 * each item). @param {import('./workspace.js').Workspace} ws @param {string} scope
 * @param {{ path: string, author: string }[]} files the plan's files, with who wrote each last
 * @returns {Promise<Map<string, { restore: string } | { remove: true }>>}
 */
export async function shioriUndos(ws, scope, files) {
  /** @type {Map<string, { restore: string } | { remove: true }>} */
  const out = new Map();
  const hers = files.filter((f) => f.author === 'shiori');
  if (!hers.length) return out;
  const all = await ws.histories(scope);
  for (const f of hers) {
    const u = beforeShiori(all.get(f.path) ?? []);
    if (u) out.set(f.path, u);
  }
  return out;
}
