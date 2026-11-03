import { dayIn, timeIn, validZone, offsetMinutes, instantAt } from './time.js';
import { checkOf } from './bookings.js';
import { zone, sortWords } from './intl.js';
import { t } from './l10n.js';

/**
 * The Plan screen's timetable (spec §16.2): rows by local day with ● fixed and ○ flexible, the legs between stops, and each booking on
 * its day (the bookings-and-trips design, goal 5). Anything that runs over several days (the drive-test follow-ups, section 2) is a set:
 * its start row on its day, a quiet line on each day between, and its end as a row of its own on its day: a stay's check-in, nights and
 * check-out; a car's pick-up, days and return; a red-eye's departure and arrival. A booking with no time is "Not on a day". A plan item
 * that links a booking stands for it on the item's own day.
 * @typedef {{ path: string, item: Record<string, any> }} PlanFile
 * @typedef {{ path: string, booking: Record<string, any> }} BookingFile
 * @typedef {{ path: string, item: Record<string, any>, from: 'item' | 'booking' | 'end' | 'line', at: number | null, day: string | null,
 *   time: string, end: string, endDays: number, endZone: string, set: { kind: string, part: 'start' | 'end' | 'line' } | null,
 *   line: { n: number, of: number } | null, bookingPath: string | null, booking: Record<string, any> | null, check: boolean,
 *   checkFields: string[], missing: boolean, note: string }} PlanRow
 *   from: a plan item, a booking no plan item stands for (at its start), the end of a set (at its end), or a set's quiet line;
 *   path: the plan item's, else the booking's; item: the plan item (without its end when it starts a set), or a view of the booking
 *   ({ title, kind: 'booking', fixed, start, end, place }); an end row's item has the end as its start; time and end: "HH:MM" in the
 *   item's own zones ('' when there is none, for an all-day item, and for a set's start); endDays: how many days after the row's day
 *   the end falls, on the end's own clock; endZone: the end's zone, named ("ET"), when its clock reads differently from the start's ('' when
 *   it doesn't, and when there is no end); set: the row is part of a set, of what kind (the booking's, else the item's); line: which day
 *   or night of how many (quiet lines); check: its booking is from before and not confirmed (checkOf's whole); checkFields: the fields
 *   Shiori is unsure of (checkOf's); missing: it names a booking the trip doesn't have; note: what was wrong with its time
 */

export const LEG_MAX_KM = 1000; // farther than a day's drive: a flight, not a leg
/** The most quiet lines a set gets: the Plan's day cap. */
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
export const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null);

/**
 * One row's times and where it stands: the start in its own zone (else the fallback's, with a note), the end in its own.
 * @param {Record<string, any>} item @param {string} fallbackTz
 */
function timesOf(item, fallbackTz) {
  const own = record(item.start)?.tz;
  const tz = validZone(own) ? own : fallbackTz;
  const at = instantAt(record(item.start)?.at, tz);
  const timed = Number.isFinite(at);
  const endTz = validZone(record(item.end)?.tz) ? item.end.tz : tz;
  const allDay = item.kind === 'all-day';
  const endAt = instantAt(record(item.end)?.at, endTz);
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
 * A good start and end: each in its own zone annai knows, the end after the start, not all day. How many days apart they fall, each
 * on its own clock, and the days strictly between (at most NIGHTS_MAX); null when either is missing or odd. @param {Record<string, any>} x
 */
function spanOf(x) {
  const s = record(x.start);
  const e = record(x.end);
  if (x.kind === 'all-day' || !s || !e || !validZone(s.tz) || !validZone(e.tz)) return null;
  const from = instantAt(s.at, s.tz);
  const to = instantAt(e.at, e.tz);
  const first = Number.isFinite(from) ? dayIn(from, s.tz) : null;
  const last = Number.isFinite(to) ? dayIn(to, e.tz) : null;
  if (!first || !last || !(to > from)) return null;
  const apart = daysApart(first, last);
  /** @type {string[]} */
  const between = [];
  for (let k = 1; k < apart && between.length < NIGHTS_MAX; k++) between.push(new Date(Date.parse(`${first}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10));
  return { apart, between };
}

/** A good span that ends on a later day than it starts: a set. @param {Record<string, any>} x */
const setOf = (x) => {
  const s = spanOf(x);
  return s && s.apart > 0 ? s : null;
};

/** The item without its end: a set's start row. @param {Record<string, any>} x */
const withoutEnd = (x) => {
  const { end: _, ...rest } = x;
  return rest;
};

/**
 * @param {PlanFile[]} items @param {BookingFile[]} bookings
 * @param {{ fallbackTz: string }} o the zone for a time whose own zone annai doesn't know
 * @returns {PlanRow[]}
 */
export function planRows(items, bookings, { fallbackTz }) {
  const byPath = new Map(bookings.filter((b) => record(b.booking)).map((b) => [b.path, b.booking]));
  const own = items.filter((x) => record(x.item)).map((x) => ({ ...x, ref: bookingRef(x.item.booking) }));
  /** @type {Map<string, { path: string, at: number | null }[]>} the plan items that stand for each booking, with their instants */
  const linked = new Map();
  for (const x of own) {
    if (x.ref && byPath.has(x.ref)) linked.set(x.ref, [...(linked.get(x.ref) ?? []), { path: x.path, at: timesOf(x.item, fallbackTz).at }]);
  }
  // One set per thing. A booking with a good start and end draws its own; one without has the earliest item standing for it that runs
  // over several days draw it, and adds no rows of its own.
  /** @type {Map<string, string>} booking path → the plan item that draws its set */
  const drawer = new Map();
  for (const [path, b] of byPath) {
    if (spanOf(b)) continue;
    const by = own.filter((x) => x.ref === path && setOf(x.item))
      .sort((p, q) => instantAt(p.item.start.at, p.item.start.tz) - instantAt(q.item.start.at, q.item.start.tz))[0];
    if (by) drawer.set(path, by.path);
  }
  /**
   * Whether a plan item standing for the booking is on this row's day, taken in the row's own zone (an item written in the arrival's
   * zone, or UTC, is still that flight). Each item stands for one row: the first it is on the day of. A row with no day is stood for by
   * any item. @param {string} path the booking @param {PlanRow} r @param {string} [not] the item drawing the set, which stands for none
   */
  const standsFor = (path, r, not) => {
    const on = linked.get(path);
    if (!on) return false;
    if (!r.day) return true;
    const tz = validZone(r.item.start?.tz) ? r.item.start.tz : fallbackTz;
    const k = on.findIndex((x) => x.path !== not && x.at !== null && dayIn(x.at, tz) === r.day);
    if (k >= 0) on.splice(k, 1);
    return k >= 0;
  };
  /** @type {PlanRow[]} */
  const out = [];
  /**
   * A set's end row and its quiet lines. @param {Pick<PlanRow, 'path' | 'bookingPath' | 'booking' | 'check' | 'checkFields' | 'missing'>} base
   * @param {Record<string, any>} view the start's view @param {Record<string, any>} endAt the end's time @param {string} kind
   * @param {{ apart: number, between: string[] } | null} span @param {string} [not] the item drawing the set
   */
  const rest = (base, view, endAt, kind, span, not) => {
    // The end isn't where the start is for a flight or train, nor for a car dropped somewhere else (named, when fields says where).
    const drop = record(base.booking?.fields)?.dropoff;
    const dropped = typeof drop === 'string' && drop.trim() ? { name: drop } : record(drop)?.name ? record(drop) : undefined;
    const place = kind === 'flight' || kind === 'rail' ? undefined : kind === 'car' && drop !== undefined && drop !== null ? dropped : view.place;
    const item = { ...view, fixed: true, start: endAt, place };
    /** @type {PlanRow} */
    const end = { ...base, item, from: 'end', ...timesOf(item, fallbackTz), set: { kind, part: 'end' }, line: null };
    // An end in another zone than the start's names it (an Arrive at 07:30 ET after a departure in PT).
    const [from, to] = [view.start?.tz, endAt?.tz].map((z) => (validZone(z) ? z : fallbackTz));
    if (end.at !== null && offsetMinutes(end.at, to) !== offsetMinutes(end.at, from)) end.endZone = zone(end.at, to);
    if (end.day && !(base.bookingPath && base.booking && standsFor(base.bookingPath, end, not))) out.push(end);
    const title = view.title;
    span?.between.forEach((day, k) => out.push({
      ...base, item: { title, kind: view.kind, fixed: true, place: view.place }, from: 'line', at: null, day, time: '', end: '', endDays: 0, endZone: '',
      set: { kind, part: 'line' }, line: { n: k + 2, of: kind === 'lodging' ? span.apart : span.apart + 1 }, check: false, checkFields: [], missing: false, note: '',
    }));
  };
  for (const { path, item, ref } of own) {
    const booking = ref ? byPath.get(ref) ?? null : null;
    const span = setOf(item);
    const marks = checkOf(booking);
    const base = {
      path, bookingPath: ref, booking, check: booking !== null && marks.whole, checkFields: booking ? marks.fields : [],
      missing: item.booking !== undefined && item.booking !== '' && !booking,
    };
    const kind = String(booking?.kind ?? item.kind ?? '');
    const draws = span && (!booking || (ref && drawer.get(ref) === path));
    // Its end is its own row, or its booking's; an item that is neither keeps its end (a second one for a booking with no times).
    const view = draws || (span && booking && spanOf(booking)) ? withoutEnd(item) : item;
    out.push({ ...base, item: view, from: 'item', ...timesOf(view, fallbackTz), set: draws ? { kind, part: 'start' } : null, line: null });
    if (draws) rest(base, view, item.end, kind, span, path);
  }
  for (const [path, b] of byPath) {
    if (drawer.has(path)) continue;
    const marks = checkOf(b);
    const title = typeof b.title === 'string' && b.title.trim() ? b.title : KIND_WORDS[b.kind] ?? t`Booking`;
    const place = record(b.place) ? b.place : undefined;
    const kind = String(b.kind ?? '');
    // A stay is always its check-in and its check-out (as before); anything else that ends on a later day, its start and its end.
    const split = kind === 'lodging' || setOf(b);
    const base = { path, bookingPath: path, booking: b, check: marks.whole, checkFields: marks.fields, missing: false };
    const view = { title, kind: 'booking', fixed: true, start: b.start, ...(split ? {} : { end: b.end }), place };
    /** @type {PlanRow} */
    const start = { ...base, item: view, from: 'booking', ...timesOf(view, fallbackTz), set: split ? { kind, part: 'start' } : null, line: null };
    if (!standsFor(path, start)) out.push(start);
    if (split) rest(base, view, b.end, kind, spanOf(b));
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
 * order; each day's quiet lines first (mockup 2b), then its rows by time. Plan items without a time are
 * apart (untimed), and so are bookings without one ("Not on a day", notOnDay).
 * @param {PlanRow[]} rows @param {{ start?: unknown, end?: unknown }} trip
 * @returns {{ days: { key: string, rows: PlanRow[] }[], untimed: PlanRow[], notOnDay: PlanRow[] }}
 */
export function planDays(rows, trip) {
  const keys = new Set(tripDays(trip.start, trip.end));
  for (const r of rows) if (r.day) keys.add(r.day);
  const byTitle = (/** @type {PlanRow} */ a, /** @type {PlanRow} */ b) => sortWords(String(a.item.title ?? ''), String(b.item.title ?? ''));
  return {
    days: [...keys].sort().map((key) => ({ key, rows: rows.filter((r) => r.day === key).sort((a, b) => Number(b.from === 'line') - Number(a.from === 'line') || (a.at ?? 0) - (b.at ?? 0) || byTitle(a, b)) })),
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
