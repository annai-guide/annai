import { dayIn, timeIn, validZone, offsetMinutes, instantAt } from './time.js';
import { checkOf } from './bookings.js';
import { zone, sortWords } from './intl.js';
import { t } from './l10n.js';

/**
 * The Plan screen's timetable (spec §16.2): rows by local day with ● fixed and ○ flexible, the legs between stops, and each booking on
 * its day (the bookings-and-trips design, goal 5). Anything over several days is a set: its start row on its day, a quiet line on each
 * day between, and its end as a row of its own: a stay's check-in, nights and check-out; a car's pick-up, days and return; a red-eye's
 * departure and arrival. A booked flight, train or ride is one whatever the day (a plan item of one that ends the same day stays one row,
 * with its end). A booking with no time is "Not on a day". A plan item that links a booking
 * stands for it on the item's own day, unless it is another thing than the booking (`anotherThing`: a car rental on a flight's): it draws its own set, the booking its own rows.
 * @typedef {{ path: string, item: Record<string, any> }} PlanFile
 * @typedef {{ path: string, booking: Record<string, any> }} BookingFile
 * @typedef {{ path: string, item: Record<string, any>, from: 'item' | 'booking' | 'end' | 'line', at: number | null, day: string | null,
 *   time: string, end: string, endDays: number, endZone: string, set: { kind: string, part: 'start' | 'end' | 'line' } | null,
 *   line: { n: number, of: number } | null, bookingPath: string | null, booking: Record<string, any> | null,
 *   checkFields: string[], missing: boolean, note: string }} PlanRow
 *   from: a plan item, a booking no plan item stands for (at its start), the end of a set (at its end), or a set's quiet line;
 *   path: the plan item's, else the booking's; item: the plan item (without its end when it starts a set), or
 *   a view of the booking ({ title, kind: 'booking' (a ride's own kind for a row that stays one, of an old booking of "other" with a ride item), fixed: null, start, end, place }); an end row's item has the end as its start; fixed: true or false as a
 *   plan item stored it, and null where nobody said (a booking's own rows: a stay's check-out is a plan item's only when that item is
 *   linked to the booking and ends where it does); an end row and a quiet line keep their start's, except a booking's (above); time and end: "HH:MM" in the
 *   item's own zones ('' when there is none, for an all-day item, and for a set's start); endDays: how many days after the row's day
 *   the end falls, on the end's own clock; endZone: the end's zone, named ("ET"), when its clock reads differently from the start's ('' when
 *   it doesn't, and when there is no end); set: the row is part of a set, of what kind (kindOf's: the item's own word annai knows, else its booking's); line: which day
 *   or night of how many (quiet lines); checkFields: the fields Shiori is unsure of, or of an old booking not confirmed, every part it has (checkOf's); bookingPath and booking: the booking a row is or stands for, none for a plan item that is another thing than its booking (anotherThing), whose rows open the item and carry no checks of the booking's; missing: it names a booking the trip doesn't have; note: what was wrong with its time
 */

export const LEG_MAX_KM = 1000; // farther than a day's drive: a flight, not a leg
/** The most quiet lines a set gets: the Plan's day cap. */
export const NIGHTS_MAX = 60;

/** Where plan items and bookings live: directly in their folder, which is what the format check and the booking rule cover (§4.4). */
export const PLAN_FILE = /^\/plan\/[^/]+\.json$/;
export const BOOKING_FILE = /^\/bookings\/[^/]+\.json$/;

/**
 * A plan row's constraint, as every view shows a model it beside the row: what `fixed` means, not the field's name, which she translated
 * and said (「(固定)」, Sonnet and Koe, 2026-11-14). A flexible item gets no words: given "can be moved", she said so unasked (the user's
 * pick, 2026-11-14: only say what can't move). A time Shiori isn't sure of says so, beside "can't be moved" or alone. Only a plan item
 * Shiori stored as fixed can't be moved (planRows): a booking's own rows say nothing of it (asked a hotel's check-out with nothing marked,
 * Koe said it couldn't be moved and Kokoro corrected her; the user's answer, 2026-11-15: only what was said fixed). The stored field keeps
 * its name. @param {unknown} fixed @param {{ unsure: boolean }} o unsure: timeUnsure's, for the row's item
 */
export const fixedWords = (fixed, { unsure }) => /* en */ [fixed ? "can't be moved" : '', unsure ? 'not sure the time was read right' : ''].filter(Boolean).join('; ');

/** A stored time as an instant: in its own zone when annai knows it, else the fallback's. @param {any} t @param {string} fallbackTz */
const momentOf = (t, fallbackTz) => instantAt(t?.at, validZone(t?.tz) ? t.tz : fallbackTz);

/**
 * Whether a time a plan row shows is one Shiori isn't sure of, as the screens mark it (checkOf): one of those times is the same moment as
 * its booking's start or end, and the booking marks that time (an old booking not confirmed marks every part it has). Only the times the row shows count: a sure check-in beside
 * an unsure check-out is a sure row when the view shows the start alone. An end row's item has the end as its start (planRows).
 * @param {unknown[]} shown the row's times: its start, and its end where the view shows it @param {unknown} booking the booking it stands for, if any
 * @param {{ fallbackTz: string }} o the zone for a time whose own zone annai doesn't know
 */
export function timeUnsure(shown, booking, { fallbackTz }) {
  const b = record(booking);
  if (!b) return false;
  const moment = (/** @type {any} */ t) => momentOf(t, fallbackTz);
  const marks = checkOf(b);
  // A booking with no end has no moment there: NaN, which a row with no time would also read as.
  const marked = ['start', 'end'].filter((k) => marks.fields.includes(k)).map((k) => moment(b[k])).filter(Number.isFinite);
  return shown.some((t) => marked.includes(moment(t)));
}

/** A booking's title on the Plan when Shiori gave none: its kind's word. */
const KIND_WORDS = /** @type {Record<string, string>} */ ({
  flight: t`Flight`, lodging: t`Stay`, car: t`Car`, rail: t`Train`, ferry: t`Ferry`, bus: t`Bus`, coach: t`Coach`, event: t`Event`, restaurant: t`Restaurant`, other: t`Booking`,
});

/** "/trip/bookings/x.json" and "/bookings/x.json" both name the trip's /bookings/x.json. @param {unknown} ref */
export function bookingRef(ref) {
  if (typeof ref !== 'string') return null;
  const p = ref.replace(/^\/trip(?=\/)/, '');
  return BOOKING_FILE.test(p) ? p : null;
}

/** An object, or null. @param {unknown} v @returns {Record<string, any> | null} */
export const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null);

/**
 * What a kind word is: one table of the words written for a plan item's kind (free text) and a booking's (a fixed list), in any case,
 * read by the Plan's sets, Kokoro's view of today, the reminders and an item's details alike. The booking format's kinds, as the
 * instructions name them and an item may carry its booking's, the rides that carry the traveller as a train does among them (a booking of
 * its own kind since booking-next; before, a ferry's was "other"); their everyday words (an item "hotel" on a stay's booking stays a stay:
 * the plan check's); and "meal", the plan-a-trip skill's own example.
 */
export const KINDS = new Map(Object.entries({
  flight: 'flight', lodging: 'lodging', car: 'car', rail: 'rail', ferry: 'ferry', bus: 'bus', coach: 'coach', event: 'event', restaurant: 'restaurant', other: 'other',
  plane: 'flight', hotel: 'lodging', stay: 'lodging', train: 'rail',
  meal: 'meal',
}));
/** A kind word as the table reads it: "Train" and " hotel " too; undefined for a word it doesn't have. @param {unknown} k */
export const kindWord = (k) => (typeof k === 'string' ? KINDS.get(k.trim().toLowerCase()) : undefined);
/**
 * A plan item's kind: its own word when the table knows it, else its booking's, else ''. Its own decides, so a car pick-up or a
 * check-out on a flight's booking is no flight; an unknown word or none takes the booking's, so a flight written "transport" on its
 * booking keeps the 2-hour margin (leave-next's fix round 2, Call 3). A booking's own rows: kindOf(null, booking).
 * @param {any} it @param {any} booking @returns {string}
 */
export const kindOf = (it, booking) => kindWord(it?.kind) ?? kindWord(booking?.kind) ?? '';
/**
 * The kinds that carry the traveller, so one ends somewhere else than it starts, whatever the day: the Plan and Kokoro's view draw a booking
 * of one, and an item of one that spans days, as its departure at its place and an "Arrive" with no place (planRows), Driving's strip
 * drops its place once it leaves (routeStrip), and the reminders count what comes after it from nothing and wait for a fixed one. A booking of one of them is too, with no item linked
 * (bookings.js reads a time of one in the place it leaves or arrives, never in the trip's only zone); one of "other" written before
 * booking-next, when a booking had no kind for a ride, takes it from a ride item linked to it (planRows).
 */
export const CARRIERS = new Set(['flight', 'rail', 'ferry', 'bus', 'coach']);
/** Whether a Plan row is of what carries the traveller: one with a place is its departure. A set's kind is planRows'. @param {PlanRow} r */
export const carries = (r) => CARRIERS.has(r.set?.kind ?? kindOf(r.item, r.booking));
/**
 * The rides a booking had no kind for before booking-next, so a booking of "other" takes one from a ride item linked to it. Kept for the
 * bookings already stored that way: Shiori writes a ride's own kind now, and nothing rewrites an old record (lessons.md, 2026-11-14:
 * when a mode goes, keep only what old data needs).
 */
const RIDES = new Set(['ferry', 'bus', 'coach']);
/** The kinds with a day, a place and an end of their own: a plan item of one on a booking of another is not that booking's (anotherThing). */
const THINGS = new Set(['flight', 'rail', 'car', 'lodging']);
/**
 * Whether a plan item is another thing than the booking it links: both are in THINGS and not the same (a car rental on a flight's
 * booking). It draws its own set, keeps its own end, stands for none of the booking's rows, and carries none of the booking's marks: the
 * Plan's rows (planRows) and the reminders' wakes (planWatches) both ask here. Any other word for the booking (a ferry on an "other"
 * booking, a "meal" on its restaurant's) is the booking's thing. @param {any} it @param {any} booking
 */
export const anotherThing = (it, booking) => {
  const [a, b] = [kindOf(it, booking), kindOf(null, booking)];
  return a !== b && THINGS.has(a) && THINGS.has(b);
};

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

/**
 * A good span that ends on a later day: a set; a carrier booking's also the same day (`sameDay`), never a plan item's, so an item is the
 * row it was. One that ends on an earlier local day (an eastbound flight over the date line) stays one row. @param {Record<string, any>} x @param {boolean} [sameDay]
 */
const setOf = (x, sameDay = false) => {
  const s = spanOf(x);
  return s && (s.apart > 0 || (sameDay && s.apart === 0)) ? s : null;
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
  const own = items.filter((x) => record(x.item)).map((x) => {
    const ref = bookingRef(x.item.booking);
    return { ...x, ref, other: anotherThing(x.item, ref ? byPath.get(ref) : null) };
  });
  /** @type {Map<string, { path: string, at: number | null }[]>} the plan items that stand for each booking, with their instants */
  const linked = new Map();
  for (const x of own) {
    if (x.ref && byPath.has(x.ref) && !x.other) linked.set(x.ref, [...(linked.get(x.ref) ?? []), { path: x.path, at: timesOf(x.item, fallbackTz).at }]);
  }
  // One set per thing. A booking with a good start and end draws its own; one without has the earliest item standing for it that runs
  // over several days draw it, and adds no rows of its own. An item that is another thing than its booking draws its own set (below).
  /** @type {Map<string, string>} booking path → the plan item that draws its set */
  const drawer = new Map();
  for (const [path, b] of byPath) {
    if (spanOf(b)) continue;
    const by = own.filter((x) => x.ref === path && !x.other && setOf(x.item))
      .sort((p, q) => instantAt(p.item.start.at, p.item.start.tz) - instantAt(q.item.start.at, q.item.start.tz))[0];
    if (by) drawer.set(path, by.path);
  }
  /**
   * Whether a plan item standing for the booking is on this row's day, taken in the row's own zone (an item written in the arrival's
   * zone, or UTC, is still that flight). Each item stands for one row: the first it is on the day of. A row with no day is stood for by
   * any item. @param {string} path the booking @param {PlanRow} r @param {string} [not] the item drawing the set, which stands for none
   * @param {PlanRow} [also] a row the item must be on the day of too: a same-day carrier's Arrive is stood for only by an item on its
   * departure's day as well (across zones, an item can be on the arrival's day and not on the departure's, both ways: one written the evening before the departure is already the arrival's day there, and one after landing is already the next day at the departure's clock; the arrival showed nowhere)
   */
  const standsFor = (path, r, not, also) => {
    const on = linked.get(path);
    if (!on) return false;
    if (!r.day) return true;
    const onDay = (/** @type {{ at: number | null }} */ x, /** @type {PlanRow} */ row) => dayIn(/** @type {number} */ (x.at), validZone(row.item.start?.tz) ? row.item.start.tz : fallbackTz) === row.day;
    const k = on.findIndex((x) => x.path !== not && x.at !== null && onDay(x, r) && (!also || onDay(x, also)));
    if (k >= 0) on.splice(k, 1);
    return k >= 0;
  };
  /** @type {PlanRow[]} */
  const out = [];
  /**
   * A set's end row and its quiet lines. @param {Pick<PlanRow, 'path' | 'bookingPath' | 'booking' | 'checkFields' | 'missing'>} base
   * @param {Record<string, any>} view the start's view @param {Record<string, any>} endAt the end's time @param {string} kind
   * @param {{ apart: number, between: string[] } | null} span
   * @param {(end: PlanRow) => boolean} [stands] whether a plan item stands for the end row, which then isn't drawn; none for another thing's set
   */
  const rest = (base, view, endAt, kind, span, stands) => {
    // The end isn't where the start is for a flight, a train or a ride, nor for a car dropped somewhere else (named, when fields says where).
    const drop = record(base.booking?.fields)?.dropoff;
    const dropped = typeof drop === 'string' && drop.trim() ? { name: drop } : record(drop)?.name ? record(drop) : undefined;
    const place = CARRIERS.has(kind) ? undefined : kind === 'car' && drop !== undefined && drop !== null ? dropped : view.place;
    const item = { ...view, start: endAt, place }; // as fixed as its start's view: a plan item's own, or null where nobody said
    /** @type {PlanRow} */
    const end = { ...base, item, from: 'end', ...timesOf(item, fallbackTz), set: { kind, part: 'end' }, line: null };
    // An end in another zone than the start's names it (an Arrive at 07:30 ET after a departure in PT).
    const [from, to] = [view.start?.tz, endAt?.tz].map((z) => (validZone(z) ? z : fallbackTz));
    if (end.at !== null && offsetMinutes(end.at, to) !== offsetMinutes(end.at, from)) end.endZone = zone(end.at, to);
    if (end.day && !stands?.(end)) out.push(end);
    const title = view.title;
    span?.between.forEach((day, k) => out.push({
      ...base, item: { title, kind: view.kind, fixed: view.fixed, place: view.place }, from: 'line', at: null, day, time: '', end: '', endDays: 0, endZone: '',
      set: { kind, part: 'line' }, line: { n: k + 2, of: kind === 'lodging' ? span.apart : span.apart + 1 }, checkFields: [], missing: false, note: '',
    }));
  };
  for (const { path, item, ref, other } of own) {
    const booking = ref ? byPath.get(ref) ?? null : null;
    const span = setOf(item);
    // An item that is another thing than its booking is not that booking's: its rows carry no booking, so a tap opens the item and no chip
    // counts the booking's facts. Its link stays in the file, and `missing` still reads it.
    const held = other ? null : booking;
    const base = {
      path, bookingPath: other ? null : ref, booking: held, checkFields: checkOf(held).fields,
      missing: item.booking !== undefined && item.booking !== '' && !booking,
    };
    const kind = kindOf(item, booking); // as the reminders read it: a car on a flight's booking is a car's set
    const draws = span && (!booking || other || (ref && drawer.get(ref) === path));
    // Its end is its own row, or its booking's; an item that is neither keeps its end (a second one for a booking with no times).
    const view = draws || (span && booking && spanOf(booking)) ? withoutEnd(item) : item;
    out.push({ ...base, item: view, from: 'item', ...timesOf(view, fallbackTz), set: draws ? { kind, part: 'start' } : null, line: null });
    if (draws) rest(base, view, item.end, kind, span, ref && booking && !other ? (end) => standsFor(ref, end, path) : undefined);
  }
  for (const [path, b] of byPath) {
    if (drawer.has(path)) continue;
    const marks = checkOf(b);
    const place = record(b.place) ? b.place : undefined;
    // A booking of kind "other" (written before booking-next, when the format had no kind for a ferry, a bus or a coach) is the ride a plan
    // item linked to it says it is, so its end is an Arrive with no place (CARRIERS); with no such item, or a flight or train item on it (a
    // package), it is the booking's own kind (a flight, a train and a ride have their own booking kinds).
    const ride = kindOf(null, b) === 'other' ? own.find((x) => x.ref === path && RIDES.has(kindOf(x.item, b))) : undefined;
    const kind = kindOf(ride?.item, b);
    // Untitled, it is named by its kind: the ride an item says it is, as a ride booking's own kind (not "Booking").
    const title = typeof b.title === 'string' && b.title.trim() ? b.title : KIND_WORDS[ride ? kind : b.kind] ?? t`Booking`;
    // A stay is always its check-in and its check-out (as before); anything else that ends on a later day, its start and its end, and a
    // booked flight, train or ride whatever the day.
    const split = kind === 'lodging' || setOf(b, CARRIERS.has(kind));
    const base = { path, bookingPath: path, booking: b, checkFields: marks.fields, missing: false };
    // A booking says nothing of what can move (null: nobody said): a plan item Shiori stored as fixed does (the user's answer, 2026-11-15).
    // A row that stays one is a booking's ('booking'), but of a ride an item says it is, the ride's own kind: Driving's strip reads it (carries).
    const view = { title, kind: !split && ride ? kind : 'booking', fixed: null, start: b.start, ...(split ? {} : { end: b.end }), place };
    /** @type {PlanRow} */
    const start = { ...base, item: view, from: 'booking', ...timesOf(view, fallbackTz), set: split ? { kind, part: 'start' } : null, line: null };
    if (!standsFor(path, start)) out.push(start);
    if (!split) continue;
    // The end is a plan item's when one standing for the booking ends where it does (a same-day one keeps its end on its own row): as fixed
    // as that item, true or false. With none, nobody said.
    const said = own.find((x) => x.ref === path && !x.other && momentOf(x.item.end, fallbackTz) === momentOf(b.end, fallbackTz));
    rest(base, { ...view, fixed: said ? said.item.fixed : null }, b.end, kind, spanOf(b), (end) => standsFor(path, end, undefined, CARRIERS.has(kind) && end.day === start.day ? start : undefined));
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
 * Rows by day: every day of the trip (even empty), then any other day with something on it, in order; each day's quiet lines first, then
 * its rows by time. Plan items without a time are apart (untimed), and so are bookings without one ("Not on a day", notOnDay).
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
 * What Undo does for a file whose last changes are Shiori's (spec §11.5): brings back the version from before all her writes in a row,
 * or, when those began by adding it, removes it. Null when the user changed it last, or her last change was a delete.
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
