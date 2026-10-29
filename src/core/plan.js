import { dayIn, timeIn, validZone, offsetMinutes, instantOf } from './time.js';
import { checkOf } from './bookings.js';
import { zone, sortWords } from './intl.js';
import { t } from './l10n.js';

/**
 * The Plan screen's timetable (spec §16.2): rows by local day with ● fixed and ○ flexible, the legs between stops, and each booking on
 * its day (the bookings-and-trips design, goal 5): a flight where it leaves, a stay's check-in, a quiet line for each night between and
 * its check-out, and one with no time "Not on a day". A plan item that links a booking stands for it on the item's own day.
 * @typedef {{ path: string, item: Record<string, any> }} PlanFile
 * @typedef {{ path: string, booking: Record<string, any> }} BookingFile
 * @typedef {{ path: string, item: Record<string, any>, from: 'item' | 'booking' | 'checkout' | 'night', at: number | null, day: string | null,
 *   time: string, end: string, endDays: number, endZone: string, night: { n: number, of: number } | null, bookingPath: string | null,
 *   booking: Record<string, any> | null, check: boolean, checkFields: string[], missing: boolean, note: string }} PlanRow
 *   from: a plan item, a booking no plan item stands for (at its start), a stay's check-out (at its end), or a night of a stay;
 *   path: the plan item's, else the booking's; item: the plan item, or a view of the booking ({ title, kind: 'booking', fixed, start, end,
 *   place }); time and end: "HH:MM" in the item's own zones ('' when there is none, and for an all-day item); endDays: how many days
 *   after the row's day the end falls, on the end's own clock (a red-eye's 1); endZone: the end's zone, named ("ET"), when its clock
 *   reads differently from the start's ('' when it doesn't, and when there is no end); night: which night of how many (night rows);
 *   check: its booking is from before and not confirmed (checkOf's whole); checkFields: the fields Shiori is unsure of (checkOf's);
 *   missing: it names a booking the trip doesn't have; note: what was wrong with its time
 */

export const LEG_MAX_KM = 1000; // farther than a day's drive: a flight, not a leg
/** The most night lines a stay gets: the Plan's day cap. */
export const NIGHTS_MAX = 60;

/** Where plan items and bookings live: directly in their folder, which is what the format check and the booking rule cover (§4.4). */
export const PLAN_FILE = /^\/plan\/[^/]+\.json$/;
export const BOOKING_FILE = /^\/bookings\/[^/]+\.json$/;

/** A booking's title on the Plan when Shiori gave none: its kind's word. */
const KIND_WORDS = /** @type {Record<string, string>} */ ({ flight: t`Flight`, lodging: t`Stay`, car: t`Car`, rail: t`Train`, event: t`Event`, restaurant: t`Restaurant`, other: t`Booking` });

/** "/trip/bookings/x.json" and "/bookings/x.json" both name the trip's /bookings/x.json. @param {unknown} ref */
export function bookingRef(ref) {
  if (typeof ref !== 'string') return null;
  const p = ref.replace(/^\/trip(?=\/)/, '');
  return BOOKING_FILE.test(p) ? p : null;
}

/** An object, or null. @param {unknown} v @returns {Record<string, any> | null} */
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null);

/**
 * A time as an instant: its own offset, or, with none written ("2026-11-20T15:00"), its wall clock in tz. NaN when it isn't a time.
 * @param {unknown} at @param {string} tz
 */
function instant(at, tz) {
  if (typeof at !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(at);
  return m ? instantOf({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0) }, tz) : Date.parse(at);
}

/**
 * One row's times and where it stands: the start in its own zone (else the fallback's, with a note), the end in its own.
 * @param {Record<string, any>} item @param {string} fallbackTz
 */
function timesOf(item, fallbackTz) {
  const own = record(item.start)?.tz;
  const tz = validZone(own) ? own : fallbackTz;
  const at = instant(record(item.start)?.at, tz);
  const timed = Number.isFinite(at);
  const endTz = validZone(record(item.end)?.tz) ? item.end.tz : tz;
  const allDay = item.kind === 'all-day';
  const endAt = instant(record(item.end)?.at, endTz);
  const ends = timed && !allDay && Number.isFinite(endAt);
  const day = timed ? dayIn(at, tz) : null;
  return {
    at: timed ? at : null,
    day,
    time: timed && !allDay ? timeIn(at, tz) ?? '' : '',
    end: ends ? timeIn(endAt, endTz) ?? '' : '',
    endDays: ends && day ? daysApart(day, dayIn(endAt, endTz) ?? day) : 0,
    // Another zone with the same clock (New York and Toronto) needs no name.
    endZone: ends && offsetMinutes(endAt, endTz) !== offsetMinutes(endAt, tz) ? zone(endAt, endTz) : '',
    note: timed && !validZone(own) ? t`Its time zone "${String(own ?? '')}" isn't one annai knows; shown in ${fallbackTz}.` : '',
  };
}

/**
 * The nights of a stay with a good start and end, each in its own zone known, the end after the start: how many, and the days strictly
 * between check-in and check-out. None for anything else. @param {Record<string, any>} b
 */
function nightsOf(b) {
  const s = record(b.start);
  const e = record(b.end);
  if (b.kind !== 'lodging' || !s || !e || !validZone(s.tz) || !validZone(e.tz)) return { of: 0, days: [] };
  const from = instant(s.at, s.tz);
  const to = instant(e.at, e.tz);
  const first = Number.isFinite(from) ? dayIn(from, s.tz) : null;
  const last = Number.isFinite(to) ? dayIn(to, e.tz) : null;
  if (!first || !last || !(to > from)) return { of: 0, days: [] };
  const of = daysApart(first, last);
  /** @type {string[]} */
  const days = [];
  for (let k = 1; k < of && days.length < NIGHTS_MAX; k++) days.push(new Date(Date.parse(`${first}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10));
  return { of, days };
}

/**
 * @param {PlanFile[]} items @param {BookingFile[]} bookings
 * @param {{ fallbackTz: string }} o the zone for a time whose own zone annai doesn't know
 * @returns {PlanRow[]}
 */
export function planRows(items, bookings, { fallbackTz }) {
  const byPath = new Map(bookings.filter((b) => record(b.booking)).map((b) => [b.path, b.booking]));
  /** @type {Map<string, string[]>} the days of the plan items that stand for each booking */
  const linked = new Map();
  /** @type {PlanRow[]} */
  const out = [];
  for (const { path, item } of items) {
    if (!record(item)) continue;
    const ref = bookingRef(item.booking);
    const booking = ref ? byPath.get(ref) ?? null : null;
    const times = timesOf(item, fallbackTz);
    if (ref && booking) linked.set(ref, [...(linked.get(ref) ?? []), ...(times.day ? [times.day] : [])]);
    const marks = checkOf(booking);
    out.push({
      path, item, from: 'item', ...times, night: null, bookingPath: ref, booking,
      check: booking !== null && marks.whole, checkFields: booking ? marks.fields : [],
      missing: item.booking !== undefined && item.booking !== '' && !booking,
    });
  }
  for (const [path, b] of byPath) {
    const marks = checkOf(b);
    const title = typeof b.title === 'string' && b.title.trim() ? b.title : KIND_WORDS[b.kind] ?? t`Booking`;
    const place = record(b.place) ? b.place : undefined;
    const stay = b.kind === 'lodging';
    /** @param {PlanRow['from']} from @param {Record<string, any>} view @returns {PlanRow} */
    const row = (from, view) => ({
      path, item: view, from, ...timesOf(view, fallbackTz), night: null, bookingPath: path, booking: b, check: marks.whole, checkFields: marks.fields, missing: false,
    });
    // A plan item that links the booking stands for it on the item's own day: a check-out or a breakfast item leaves the check-in, and
    // a flight on its day, as rows of their own. A booking with no time that an item stands for is no "Not on a day" row too.
    const on = linked.get(path);
    const standsFor = (/** @type {PlanRow} */ r) => Boolean(on && (r.day ? on.includes(r.day) : true));
    // A stay's check-in is at its own time, with no end: its end is the check-out's row.
    const start = row('booking', { title, kind: 'booking', fixed: true, start: b.start, ...(stay ? {} : { end: b.end }), place });
    if (!standsFor(start)) out.push(start);
    const checkout = stay ? row('checkout', { title, kind: 'booking', fixed: true, start: b.end, place }) : null;
    if (checkout?.day && !standsFor(checkout)) out.push(checkout);
    const nights = nightsOf(b);
    nights.days.forEach((day, k) => out.push({
      path, item: { title, kind: 'booking', fixed: true, place }, from: 'night', at: null, day, time: '', end: '', endDays: 0, endZone: '',
      night: { n: k + 2, of: nights.of }, bookingPath: path, booking: b, check: false, checkFields: [], missing: false, note: '',
    }));
  }
  return out;
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
 * order; each day's nights first (mockup 2b), then its rows by time. Plan items without a time are
 * apart (untimed), and so are bookings without one ("Not on a day", notOnDay).
 * @param {PlanRow[]} rows @param {{ start?: unknown, end?: unknown }} trip
 * @returns {{ days: { key: string, rows: PlanRow[] }[], untimed: PlanRow[], notOnDay: PlanRow[] }}
 */
export function planDays(rows, trip) {
  const keys = new Set(tripDays(trip.start, trip.end));
  for (const r of rows) if (r.day) keys.add(r.day);
  const byTitle = (/** @type {PlanRow} */ a, /** @type {PlanRow} */ b) => sortWords(String(a.item.title ?? ''), String(b.item.title ?? ''));
  return {
    days: [...keys].sort().map((key) => ({ key, rows: rows.filter((r) => r.day === key).sort((a, b) => Number(b.from === 'night') - Number(a.from === 'night') || (a.at ?? 0) - (b.at ?? 0) || byTitle(a, b)) })),
    untimed: rows.filter((r) => !r.day && r.from === 'item').sort(byTitle),
    notOnDay: rows.filter((r) => !r.day && r.from !== 'item').sort(byTitle),
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
