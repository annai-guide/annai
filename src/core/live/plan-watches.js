import { meters, travelMinutes, modeFor, kmText, TRAVEL } from './geo.js';
import { timeIn, validZone } from '../time.js';
import { bookingRef } from '../plan.js';

/**
 * The plan's own watches (spec §11.3: "Plan items create their own watches. The system sets
 * these, so they don't depend on Shiori remembering"): leave in X minutes, arrived, running late,
 * coming up; and off plan (§11.5). They are worked out from the plan whenever it changes and never
 * stored; the log's trigger.fired entries say which have fired. Their fallbacks come from the plan.
 * @typedef {import('./watches.js').Watch} Watch
 * @typedef {import('./triggers.js').Moment} Moment
 * @typedef {import('./triggers.js').Firing} Firing
 * @typedef {{ name: string, lat: number, lng: number }} Place
 */

/** The leave reminder comes this long before the estimated departure ("leave in X minutes"). */
export const LEAVE_LEAD_MIN = 15;
/** A fixed item without coordinates is announced this long before it starts. */
export const COMING_UP_MIN = 15;
/** Arriving up to this long after the start isn't late. */
export const LATE_GRACE_MIN = 5;
/** Arrived: within this many meters of the place; an airport is bigger. */
export const ARRIVE_M = 300;
export const AIRPORT_M = 2000;
/** Arrived: stopped there this long, or inside this long. */
export const ARRIVE_STOP_MIN = 2;
export const ARRIVE_INSIDE_MIN = 5;
/** Arriving counts from this long before the start until the end (or this long after the start); running late, from then. */
export const WINDOW_MIN = 180;
/** Off plan: this far from a flexible item, this long into its time. */
export const OFF_PLAN_KM = 3;
export const OFF_PLAN_AFTER_MIN = 10;
/** Off plan: stopped this long, this far from every plan place. */
export const LINGER_MIN = 20;
export const NOT_PLANNED_M = 500;

const MIN = 60_000;
/** @param {any} p @returns {p is { lat: number, lng: number }} */
const hasPoint = (p) => Boolean(p) && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
/** "/plan/nepenthe.json" → "nepenthe". @param {string} path */
const slug = (path) => path.replace(/^\/plan\//, '').replace(/\.json$/, '');

/**
 * @param {{ path: string, item: any }[]} items the plan files @param {Map<string, any>} bookings by path, such as "/bookings/hearst.json"
 * @param {{ fallbackTz: string }} o the zone for an item whose own zone annai doesn't know
 * @returns {Watch[]}
 */
export function planWatches(items, bookings, { fallbackTz }) {
  const timed = items
    .filter((x) => x.item && typeof x.item === 'object' && !Array.isArray(x.item) && x.item.kind !== 'all-day')
    .map((x) => ({ ...x, at: Date.parse(x.item.start?.at ?? '') }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  /** @type {Watch[]} */
  const out = [];
  /** @type {Place | null} */
  let prev = null;
  /** @type {Place[]} */
  const places = [];
  const zone = (/** @type {any} */ it) => (validZone(it.start?.tz) ? it.start.tz : fallbackTz);
  for (const x of timed) {
    const it = x.item;
    const tz = zone(it);
    const title = String(it.title ?? slug(x.path));
    const end = Date.parse(it.end?.at ?? '');
    const place = hasPoint(it.place) ? { name: String(it.place.name ?? title), lat: it.place.lat, lng: it.place.lng } : null;
    const booking = bookings.get(bookingRef(it.booking) ?? '') ?? null;
    const flight = it.kind === 'flight' || booking?.kind === 'flight';
    const base = {
      type: 'plan', item: slug(x.path), title, at: x.at, end: Number.isFinite(end) && end > x.at ? end : null, tz, fixed: it.fixed === true,
      what: what(title, booking, flight, x.at, tz, place?.name ?? ''),
    };
    /** @param {string} event @param {string} fallback @param {Record<string, any>} [extra] */
    const add = (event, fallback, extra = {}) => out.push({ id: `plan:${base.item}:${event}`, owner: 'system', repeat: false, fallback, when: { ...base, event, ...extra } });
    if (place) {
      const there = { place, radius: flight ? AIRPORT_M : ARRIVE_M };
      if (base.fixed) {
        add('leave', `Leave soon: ${base.what}.`, { ...there, from: prev });
        add('late', `Running late: ${base.what}.`, there);
      } else {
        add('off-plan', `Planned now: ${title}, at ${place.name}.`, there);
      }
      add('arrived', `${place.name}: ${title}.${typeof it.notes === 'string' && it.notes.trim() ? ` ${it.notes.trim()}` : ''}`, there);
      prev = place;
      places.push(place);
    } else if (base.fixed) {
      add('coming-up', `In ${COMING_UP_MIN} min: ${base.what}.`);
    }
  }
  if (places.length) {
    out.push({
      id: 'plan:linger', owner: 'system', repeat: true, fallback: "You've stopped somewhere that isn't on the plan.",
      when: {
        type: 'plan', event: 'linger', places, from: timed[0].at - 12 * 60 * MIN, to: /** @type {any} */ (timed.at(-1)).at + 12 * 60 * MIN,
        upcoming: timed.map((x) => ({ title: String(x.item.title ?? slug(x.path)), at: x.at, tz: zone(x.item) })),
      },
    });
  }
  return out;
}

/**
 * The item in a few words for a reminder (spec §11.3: "Flight UA123 departs 14:05, SFO T3").
 * @param {string} title @param {any} booking @param {boolean} flight @param {number} at @param {string} tz @param {string} placeName
 */
function what(title, booking, flight, at, tz, placeName) {
  const time = timeIn(at, tz);
  const terminal = typeof booking?.fields?.terminal === 'string' && booking.fields.terminal.trim() ? ` ${booking.fields.terminal.trim()}` : '';
  if (flight) return `Flight ${String(booking?.title ?? title)} departs ${time}${placeName ? `, ${placeName}${terminal}` : ''}`;
  const where = placeName && !title.toLowerCase().includes(placeName.toLowerCase()) ? `, ${placeName}` : '';
  return `${title} at ${time}${where}`;
}

/** @param {any} w @param {number} [t] */
const hhmm = (w, t = w.at) => timeIn(t, w.tz);
/** @param {any} w */
const kind = (w) => (w.fixed ? 'fixed' : 'flexible');
/** Where the user is now (not on a catch-up's first look). @param {Moment} m */
const now = (m) => (m.fix && !m.past ? m.fix : null);
/** @param {number} km @param {string} activity */
const trip = (km, activity) => {
  const mode = modeFor(km, activity);
  return { mode, minutes: travelMinutes(km, mode), words: TRAVEL[mode].words };
};

/**
 * When to leave for an item: from where the user is (or was, on a catch-up's first look), else
 * from the plan's stop before; with neither, half an hour before. Null once the user is there.
 * @param {any} w @param {Moment} m
 */
function leaving(w, m) {
  const from = m.fix ?? w.from ?? null;
  if (!from) return { due: w.at - 30 * MIN, km: null, minutes: null, words: '' };
  const km = meters(from, w.place) / 1000;
  if (km * 1000 <= w.radius) return null;
  const t = trip(km, m.activity);
  return { due: w.at - (t.minutes + LEAVE_LEAD_MIN) * MIN, km, minutes: t.minutes, words: t.words };
}

/** @type {Record<string, (w: any, m: Moment, mem: Record<string, any>) => Firing | null>} */
const CHECK = {
  leave(w, m) {
    const l = leaving(w, m);
    if (!l || m.now < l.due || m.now >= w.at) return null;
    const how = l.km === null ? '' : `: ${kmText(l.km * 1000)} away in a straight line, about ${l.minutes} min ${l.words}`;
    return {
      text: `Plan: time to leave soon for "${w.title}" (${kind(w)}, ${hhmm(w)})${how}`, at: l.due,
      fallback: l.km === null ? `Leave soon: ${w.what}.` : `Leave in about ${LEAVE_LEAD_MIN} min: ${w.what}. About ${l.minutes} min ${l.words}.`,
    };
  },
  'coming-up'(w, m) {
    const due = w.at - COMING_UP_MIN * MIN;
    if (m.now < due || m.now >= w.at) return null;
    return { text: `Plan: "${w.title}" (${kind(w)}) starts at ${hhmm(w)}, in ${Math.max(1, Math.round((w.at - m.now) / MIN))} min`, at: due };
  },
  arrived(w, m, mem) {
    const fix = now(m);
    if (!fix || m.now < w.at - WINDOW_MIN * MIN || m.now > (w.end ?? w.at + WINDOW_MIN * MIN)) return null;
    const inside = fix.accuracy <= Math.max(w.radius, 200) && meters(fix, w.place) <= w.radius;
    if (!inside) {
      if (m.newFix) mem.since = null;
      return null;
    }
    if (m.newFix && !mem.since) mem.since = fix.at;
    const stop = m.stop;
    const stopped = stop !== null && meters(stop, w.place) <= w.radius && m.now - stop.since >= ARRIVE_STOP_MIN * MIN;
    const long = Boolean(mem.since) && m.now - mem.since >= ARRIVE_INSIDE_MIN * MIN;
    // Arriving is inferred from where the user was against where they are now (spec §11.4).
    const gap = m.gap;
    const back = gap !== null && gap.since !== null && m.newFix && m.now - gap.since >= ARRIVE_STOP_MIN * MIN;
    if (!stopped && !long && !back) return null;
    return { text: `Plan: you arrived at ${w.place.name} for "${w.title}" (${kind(w)}, ${hhmm(w)})${back && !stopped && !long ? ', inferred on coming back on screen' : ''}`, place: w.place };
  },
  late(w, m) {
    const fix = now(m);
    if (!fix || m.fired(`plan:${w.item}:arrived`) || m.now < w.at - WINDOW_MIN * MIN || m.now > w.at + 60 * MIN) return null;
    const km = meters(fix, w.place) / 1000;
    if (km * 1000 <= w.radius) return null;
    const t = trip(km, m.activity);
    const eta = m.now + t.minutes * MIN;
    if (eta <= w.at + LATE_GRACE_MIN * MIN) return null;
    return {
      text: `Plan: running late for "${w.title}" (${kind(w)}, ${hhmm(w)}): ${kmText(km * 1000)} away, about ${t.minutes} min ${t.words}, so about ${Math.round((eta - w.at) / MIN)} min late`,
      fallback: `Running late: ${w.what}. About ${t.minutes} min away.`,
    };
  },
  'off-plan'(w, m) {
    const fix = now(m);
    const end = w.end ?? w.at + 60 * MIN;
    if (!fix || m.fired(`plan:${w.item}:arrived`) || m.now < w.at + OFF_PLAN_AFTER_MIN * MIN || m.now > end) return null;
    const km = meters(fix, w.place) / 1000;
    if (km <= OFF_PLAN_KM) return null;
    return { text: `Off plan: "${w.title}" (flexible) is planned for ${hhmm(w)}–${hhmm(w, end)} at ${w.place.name}, and the user is ${kmText(km * 1000)} away. The replanning skill says what to do` };
  },
  linger(w, m, mem) {
    const fix = now(m);
    if (!fix) return null;
    if (!mem.home) mem.home = { lat: fix.lat, lng: fix.lng }; // where live mode first found the user isn't a detour
    const s = m.stop;
    if (!s || m.now < w.from || m.now > w.to || m.now - s.since < LINGER_MIN * MIN) return null;
    const far = (/** @type {any} */ p) => !p || meters(p, s) > NOT_PLANNED_M;
    if (!w.places.every(far) || !far(mem.home) || !far(mem.lastPlace)) return null;
    const next = w.upcoming.find((/** @type {any} */ u) => u.at > m.now);
    const nextText = next ? `"${next.title}" at ${timeIn(next.at, next.tz)}` : '';
    return {
      text: `Off plan: the user has been stopped for ${Math.round((m.now - s.since) / MIN)} min at a place that isn't on the plan (${s.lat.toFixed(4)}, ${s.lng.toFixed(4)})${next ? `; next on the plan: ${nextText}` : ''}. The replanning skill says what to do`,
      at: s.since + LINGER_MIN * MIN, place: { lat: s.lat, lng: s.lng },
      fallback: next ? `Next on the plan: ${next.title} at ${timeIn(next.at, next.tz)}.` : 'Nothing more is on the plan.',
    };
  },
};

/** @type {Record<string, (w: any, m: Moment, mem: Record<string, any>) => number | null>} */
const NEXT = {
  leave: (w, m) => {
    const l = leaving(w, m);
    return l && l.due < w.at ? l.due : null;
  },
  'coming-up': (w) => w.at - COMING_UP_MIN * MIN,
  arrived: (w, m, mem) => {
    const t = [mem.since ? mem.since + ARRIVE_INSIDE_MIN * MIN : Infinity, m.stop ? m.stop.since + ARRIVE_STOP_MIN * MIN : Infinity];
    const first = Math.min(...t);
    return first === Infinity ? null : first;
  },
  late: (w, m) => {
    const fix = now(m);
    if (!fix) return null;
    const t = trip(meters(fix, w.place) / 1000, m.activity);
    return Math.max(w.at - WINDOW_MIN * MIN, w.at + (LATE_GRACE_MIN - t.minutes) * MIN + 1000);
  },
  'off-plan': (w) => w.at + OFF_PLAN_AFTER_MIN * MIN,
  linger: (w, m) => (m.stop ? m.stop.since + LINGER_MIN * MIN : null),
};

/** @type {Record<string, (w: any) => string>} */
const DESCRIBE = {
  leave: (w) => `${LEAVE_LEAD_MIN} min before leaving for "${w.title}" at ${hhmm(w)}`,
  'coming-up': (w) => `${COMING_UP_MIN} min before "${w.title}" at ${hhmm(w)}`,
  arrived: (w) => `on arriving at ${w.place.name} for "${w.title}"`,
  late: (w) => `when running late for "${w.title}" at ${hhmm(w)}`,
  'off-plan': (w) => `when far from "${w.title}" while it is planned`,
  linger: () => `on stopping ${LINGER_MIN} min somewhere not on the plan`,
};

/** The plan's trigger type. It isn't for watch_set: the plan sets these itself. @type {import('./triggers.js').TriggerType} */
export const PLAN = {
  type: 'plan', gps: false, summary: '',
  validate: () => 'the plan sets its own watches',
  describe: (w) => DESCRIBE[w.event]?.(w) ?? String(w.event),
  check: (w, m, mem) => CHECK[w.event]?.(w, m, mem) ?? null,
  next: (w, m, mem) => NEXT[w.event]?.(w, m, mem) ?? null,
};
