import { meters, kmText } from './geo.js';

/**
 * Trigger types (spec §11.3): what makes a watch fire. A type checks a watch's `when` against the
 * moment, and keeps what it must remember between checks in the watch's mem. Plugins add types
 * with register('trigger', type) (spec §5.4).
 * @typedef {import('./geo.js').Fix} Fix
 * @typedef {{ lat: number, lng: number, since: number }} Stop  where the user has stayed, and since when
 * @typedef {{ now: number, fix: Fix | null, newFix: boolean, past: boolean, live: boolean, activity: string,
 *   change: { from: string, to: string } | null, odometer: number, stop: Stop | null,
 *   gap: { since: number | null, from: Fix | null } | null, fired: (id: string) => boolean }} Moment
 *   fix: where the user is, when annai knows (live mode on, and not too old); newFix: this check came with that fix;
 *   past: a catch-up's first look, from where the user was when annai went off screen (spec §11.4): only what the clock makes due fires;
 *   change: the activity just changed; odometer: km travelled while live; stop: where the user has stayed, while live;
 *   gap: annai was off screen, or closed, and is catching up; fired: whether a watch of this conversation has fired
 * @typedef {{ name?: string, lat: number, lng: number }} Place
 * @typedef {{ text: string, at?: number, place?: Place, fallback?: string }} Firing
 *   text: what happened, for Shiori; at: when it came due (for "late by"); fallback: this firing's own words for the user
 * @typedef {{ type: string, gps: boolean, summary: string, validate: (when: any) => string | null, describe: (when: any) => string,
 *   start?: (when: any, m: Moment, mem: Record<string, any>) => void,
 *   check: (when: any, m: Moment, mem: Record<string, any>) => Firing | null,
 *   next?: (when: any, m: Moment, mem: Record<string, any>) => number | null }} TriggerType
 *   gps: it needs live mode; summary: its line in watch_set's description; start: sets mem from the moment the watch is first seen,
 *   without firing; next: when the clock alone could make it fire (spec §11.2: one timer, for the next due watch)
 */

/** A stop this far from the last one is somewhere new (arrived). */
export const NEW_PLACE_M = 500;
const MIN = 60_000;

/** @param {unknown} v @param {number} lo @param {number} hi */
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/** @param {any} w */
const minutesWrong = (w) => (num(w?.minutes, 1, 1440) ? null : 'minutes must be a number from 1 to 1440');
/** @param {any} w */
function placeWrong(w) {
  if (!num(w?.lat, -90, 90) || !num(w?.lng, -180, 180)) return 'it needs lat and lng';
  if (w.radius !== undefined && !num(w.radius, 25, 50_000)) return 'radius is in meters, from 25 to 50000';
  return null;
}
/** @param {any} w @returns {number} */
const radius = (w) => w.radius ?? 200;
/** GPS jitter at the edge doesn't refire a circle (spec §11.3): inside within the radius, outside only beyond this margin. @param {number} r */
export const margin = (r) => Math.max(25, r / 4);
/** @param {any} w */
const named = (w) => (w.name ? String(w.name) : `the place at ${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}`);
/** @param {any} w @returns {Place} */
const placeOf = (w) => ({ ...(w.name ? { name: String(w.name) } : {}), lat: w.lat, lng: w.lng });
/** @param {string} a */
const words = (a) => (a === 'moving-fast' ? 'moving fast' : a === 'unknown' ? 'not known yet' : a);

/** Inside, outside, or can't tell (in the margin, or the fix too vague for this circle). @param {any} w @param {Fix} fix */
function side(w, fix) {
  const r = radius(w);
  if (fix.accuracy > Math.max(r, 100)) return null;
  const d = meters(w, fix);
  return d <= r ? true : d > r + margin(r) ? false : null;
}

/**
 * Follows inside and outside with each new fix and says which way it crossed. A fix that can't
 * tell changes nothing; the first one only sets where it is.
 * @param {any} w @param {Moment} m @param {Record<string, any>} mem @returns {'in' | 'out' | null}
 */
function crossing(w, m, mem) {
  if (!m.newFix || !m.fix) return null;
  const s = side(w, m.fix);
  if (s === null) return null;
  const was = mem.inside;
  mem.inside = s;
  if (s && was !== true) {
    mem.since = m.fix.at;
    mem.done = false;
  }
  if (!s) mem.since = null;
  if (was === undefined) return null;
  return was === s ? null : s ? 'in' : 'out';
}

/** Inside or outside, from where the user is when the watch is first seen. @param {any} w @param {Moment} m @param {Record<string, any>} mem */
function startSide(w, m, mem) {
  if (!m.fix) return;
  const s = side(w, m.fix);
  if (s === null) return;
  mem.inside = s;
  mem.since = s ? m.now : null;
}

/** @type {TriggerType} */
const TIME = {
  type: 'time', gps: false, summary: 'time {at}: once, at an ISO date-time with an offset',
  validate: (w) => (typeof w?.at === 'string' && /(?:[zZ]|[+-]\d\d:\d\d)$/.test(w.at) && Number.isFinite(Date.parse(w.at))
    ? null : 'at must be an ISO date-time with an offset, like 2026-11-27T18:00:00-08:00'),
  describe: (w) => `at ${w.at}`,
  next: (w) => Date.parse(w.at),
  check: (w, m) => (m.now >= Date.parse(w.at) ? { text: `the time came: ${w.at}`, at: Date.parse(w.at) } : null),
};

/** @type {TriggerType} */
const EVERY = {
  type: 'every', gps: false, summary: 'every {minutes}: at an interval, until cancelled or expired',
  validate: minutesWrong,
  describe: (w) => `every ${w.minutes} min`,
  next: (w, m, mem) => (mem.lastAt ?? mem.set) + w.minutes * MIN,
  check: (w, m, mem) => {
    const due = (mem.lastAt ?? mem.set) + w.minutes * MIN;
    return m.now >= due ? { text: `${w.minutes} min since ${mem.lastAt ? 'it last fired' : 'you set it'}`, at: due } : null;
  },
};

/** @type {TriggerType} */
const ENTER = {
  type: 'enter', gps: true, summary: 'enter {lat, lng, radius?, name?}: on coming inside a circle around a place (radius in meters, 200 if not given)',
  validate: placeWrong,
  describe: (w) => `on entering ${named(w)} (${radius(w)} m)`,
  start: startSide,
  check: (w, m, mem) => (crossing(w, m, mem) === 'in' ? { text: `you entered ${named(w)}`, place: placeOf(w) } : null),
};

/** @type {TriggerType} */
const LEAVE = {
  type: 'leave', gps: true, summary: 'leave {lat, lng, radius?, name?}: on going out of that circle',
  validate: placeWrong,
  describe: (w) => `on leaving ${named(w)} (${radius(w)} m)`,
  start: startSide,
  check: (w, m, mem) => (crossing(w, m, mem) === 'out' && m.fix ? { text: `you left ${named(w)}, now ${kmText(meters(w, m.fix))} away`, place: placeOf(w) } : null),
};

/** @type {TriggerType} */
const DWELL = {
  type: 'dwell', gps: true, summary: 'dwell {lat, lng, radius?, minutes, name?}: after that long inside a place, once a visit',
  validate: (w) => placeWrong(w) ?? minutesWrong(w),
  describe: (w) => `after ${w.minutes} min at ${named(w)}`,
  start: startSide,
  next: (w, m, mem) => (mem.inside && !mem.done && mem.since ? mem.since + w.minutes * MIN : null),
  check: (w, m, mem) => {
    crossing(w, m, mem);
    if (m.past || !mem.inside || mem.done || !mem.since || m.now - mem.since < w.minutes * MIN) return null;
    mem.done = true;
    return { text: `you've been at ${named(w)} for ${w.minutes} min`, at: mem.since + w.minutes * MIN, place: placeOf(w) };
  },
};

/** @type {TriggerType} */
const ARRIVED = {
  type: 'arrived', gps: true, summary: 'arrived {minutes?}: on stopping somewhere new for that long (5 min if not given)',
  validate: (w) => (w?.minutes === undefined || num(w.minutes, 1, 240) ? null : 'minutes must be a number from 1 to 240'),
  describe: (w) => `on stopping somewhere new for ${w.minutes ?? 5} min`,
  start: (w, m, mem) => {
    if (m.fix && !mem.from) mem.from = { lat: m.fix.lat, lng: m.fix.lng }; // where it was set isn't new
  },
  next: (w, m) => (m.stop ? m.stop.since + (w.minutes ?? 5) * MIN : null),
  check: (w, m, mem) => {
    const s = m.stop;
    const need = (w.minutes ?? 5) * MIN;
    if (m.past || !s || m.now - s.since < need) return null;
    const from = mem.from ?? mem.lastPlace;
    if (from && meters(from, s) < NEW_PLACE_M) return null;
    mem.from = { lat: s.lat, lng: s.lng };
    return { text: `you've stopped for ${Math.round((m.now - s.since) / MIN)} min somewhere new`, at: s.since + need, place: { lat: s.lat, lng: s.lng } };
  },
};

/** @type {TriggerType} */
const MOVED = {
  type: 'moved', gps: true, summary: 'moved {km}: after travelling that far since your last wake',
  validate: (w) => (num(w?.km, 0.1, 1000) ? null : 'km must be a number from 0.1 to 1000'),
  describe: (w) => `after ${w.km} km travelled`,
  check: (w, m, mem) => {
    const done = m.odometer - (mem.km0 ?? m.odometer);
    return done >= w.km ? { text: `you have travelled ${done.toFixed(1)} km since your last wake` } : null;
  },
};

/** @type {TriggerType} */
const ACTIVITY = {
  type: 'activity', gps: true, summary: 'activity {activity: still | walking | moving-fast, edge?: start | stop}: when it starts (or, with edge stop, stops)',
  validate: (w) => {
    if (!['still', 'walking', 'moving-fast'].includes(w?.activity)) return 'activity is still, walking or moving-fast';
    return w.edge === undefined || w.edge === 'start' || w.edge === 'stop' ? null : 'edge is start or stop';
  },
  describe: (w) => `when ${words(w.activity)} ${w.edge === 'stop' ? 'stops' : 'starts'}`,
  check: (w, m) => {
    const c = m.change;
    if (!c || (w.edge === 'stop' ? c.from !== w.activity : c.to !== w.activity)) return null;
    return { text: `the activity is now ${words(c.to)} (it was ${words(c.from)})` };
  },
};

/** The built-in types, in the order watch_set lists them. */
export const TRIGGERS = Object.freeze([TIME, EVERY, ENTER, LEAVE, DWELL, ARRIVED, MOVED, ACTIVITY]);
