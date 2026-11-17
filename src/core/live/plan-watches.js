import { meters, travelMinutes, modeFor, kmText, TRAVEL } from './geo.js';
import { timeIn, validZone, instantAt, dayIn, dueWords, isoInZone } from '../time.js';
import { bookingRef, fixedWords, timeUnsure } from '../plan.js';
import { t } from '../l10n.js';
import { sentences, num, when as clockAt, dayClock } from '../intl.js';

/**
 * The plan's own watches (spec §11.3): leave in X minutes, arrived, running late, coming up; and off plan (§11.5). Worked out from the plan
 * whenever it changes and never stored; the log's trigger.fired entries say which have fired. fallback is annai's English for Shiori; say is
 * the data the user's words are made from where they are shown (planWords).
 * @typedef {import('./watches.js').Watch} Watch
 * @typedef {import('./triggers.js').Moment} Moment
 * @typedef {import('./triggers.js').Firing} Firing
 * @typedef {{ name: string, lat: number, lng: number }} Place
 * @typedef {{ title: string, at: number, tz: string, flight?: string, place?: string }} What  an item in a few words: a flight by its name
 * @typedef {{ event: string, what?: What, title?: string, place?: string, notes?: string, minutes?: number, left?: number, mode?: string,
 *   next?: { title: string, at: number, tz: string, later?: true } | null }} PlanSay  what a plan reminder says, as data: its event, the item, and for
 *   one worked out as it fired, the minutes it names (minutes: a trip's, away for a late, the trip there for a leave, with how: mode; left: the
 *   minutes left, to the time to leave for a leave, to the start for a coming-up), or what is next on the plan (null: nothing; later: it isn't
 *   on the moment's day). One with none of these (an older entry, or the words made for the due time) says: a coming-up, the lead it comes with,
 *   15 min; a leave, "soon" (it has no trip to count from). A leave with its trip and no left (an older entry) says "about 15 min".
 */

/** The leave reminder comes this long before the estimated departure ("leave in X minutes"; one that fires later says the minutes left). */
export const LEAVE_LEAD_MIN = 15;
/** A fixed item without coordinates is announced this long before it starts (the words made for that moment; one that fires later says the minutes left). */
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
/**
 * Off plan: asked until this long after the start (or the item's end, if sooner). The hour running late gives a fixed item, and the one
 * an item with no end always had. Past it nothing asks about that item: annai sees the traveller only while it is on screen (spec §11.1),
 * so being far late in an item proves little (they may have been and gone). The linger watch wakes her only for a stop made after annai
 * saw them somewhere else (it takes the first place it sees as home): opened 14 km from a 13:00-17:00 item at 14:25, nothing wakes her.
 * Not the whole item: a stay until the next morning woke her "off plan" at the traveller's dinner (the main session's call, 2026-11-16).
 */
export const OFF_PLAN_FOR_MIN = 60;
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
  const zone = (/** @type {any} */ it) => (validZone(it.start?.tz) ? it.start.tz : fallbackTz);
  // Read as every screen reads a stored time (instantAt): a time with no offset is on its zone's clock.
  const timed = items
    .filter((x) => x.item && typeof x.item === 'object' && !Array.isArray(x.item) && x.item.kind !== 'all-day')
    .map((x) => ({ ...x, at: instantAt(x.item.start?.at, zone(x.item)) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  /** @type {Watch[]} */
  const out = [];
  /** @type {Place | null} */
  let prev = null;
  /** @type {Place[]} */
  const places = [];
  for (const x of timed) {
    const it = x.item;
    const tz = zone(it);
    const title = String(it.title ?? slug(x.path));
    const end = instantAt(it.end?.at, validZone(it.end?.tz) ? it.end.tz : tz);
    const place = hasPoint(it.place) ? { name: String(it.place.name ?? title), lat: it.place.lat, lng: it.place.lng } : null;
    const booking = bookings.get(bookingRef(it.booking) ?? '') ?? null;
    const flight = it.kind === 'flight' || booking?.kind === 'flight';
    const short = whatOf(title, booking, flight, x.at, tz, place?.name ?? '');
    const base = {
      type: 'plan', item: slug(x.path), title, at: x.at, end: Number.isFinite(end) && end > x.at ? end : null, tz, fixed: it.fixed === true,
      unsure: timeUnsure([it.start], booking, { fallbackTz }), // the start: the time a wake says (the off-plan wake reads the end too, when it says one)
      what: whatText(short), short,
    };
    const notes = typeof it.notes === 'string' && it.notes.trim() ? it.notes.trim() : '';
    /** @param {string} event @param {string} fallback @param {PlanSay} say @param {Record<string, any>} [extra] */
    const add = (event, fallback, say, extra = {}) => out.push({ id: `plan:${base.item}:${event}`, owner: 'system', repeat: false, fallback, say, when: { ...base, event, ...extra } });
    // fallback: annai's English, for Shiori; say: the data the user's words are made from.
    /* en */
    if (place) {
      const there = { place, radius: flight ? AIRPORT_M : ARRIVE_M };
      if (base.fixed) {
        add('leave', `Leave soon: ${base.what}.`, { event: 'leave', what: short }, { ...there, from: prev });
        add('late', `Running late: ${base.what}.`, { event: 'late', what: short }, there);
      } else {
        add('off-plan', `Planned now: ${title}, at ${place.name}.`, { event: 'off-plan', title, place: place.name }, { ...there, unsure: timeUnsure(base.end === null ? [it.start] : [it.start, it.end], booking, { fallbackTz }) });
      }
      add('arrived', `${place.name}: ${title}.${notes ? ` ${notes}` : ''}`, { event: 'arrived', title, place: place.name, ...(notes ? { notes } : {}) }, there);
      prev = place;
      places.push(place);
    } else if (base.fixed) {
      add('coming-up', `In ${COMING_UP_MIN} min: ${base.what}.`, { event: 'coming-up', what: short });
    }
  }
  /* en */
  if (places.length) {
    out.push({
      id: 'plan:linger', owner: 'system', repeat: true, fallback: "You've stopped somewhere that isn't on the plan.", say: { event: 'linger' },
      when: {
        type: 'plan', event: 'linger', places, from: timed[0].at - 12 * 60 * MIN, to: /** @type {any} */ (timed.at(-1)).at + 12 * 60 * MIN,
        upcoming: timed.map((x) => ({ title: String(x.item.title ?? slug(x.path)), at: x.at, tz: zone(x.item) })),
      },
    });
  }
  return out;
}

/**
 * The item for a reminder, as data (spec §11.3): a flight by its name, the place where it says more than the title.
 * @param {string} title @param {any} booking @param {boolean} flight @param {number} at @param {string} tz @param {string} placeName
 * @returns {What}
 */
function whatOf(title, booking, flight, at, tz, placeName) {
  const terminal = typeof booking?.fields?.terminal === 'string' && booking.fields.terminal.trim() ? ` ${booking.fields.terminal.trim()}` : '';
  if (flight) return { title, at, tz, flight: String(booking?.title ?? title), ...(placeName ? { place: `${placeName}${terminal}` } : {}) };
  return { title, at, tz, ...(placeName && !title.toLowerCase().includes(placeName.toLowerCase()) ? { place: placeName } : {}) };
}

/** The item in a few words, as Shiori reads it: annai's English. @param {What} w */
function whatText(w) {
  const time = timeIn(w.at, w.tz);
  /* en */
  if (w.flight) return `Flight ${w.flight} departs ${time}${w.place ? `, ${w.place}` : ''}`;
  return `${w.title} at ${time}${w.place ? `, ${w.place}` : ''}`;
}

/** A plan time on a 24-hour clock, as the screens' language writes it. @param {number} at @param {string} tz */
const clock = (at, tz) => clockAt(at, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The item in a few words, for the user. @param {What} w */
function whatWords(w) {
  const time = clock(w.at, w.tz);
  if (w.flight) return w.place ? t`Flight ${w.flight} departs ${time}, ${w.place}` : t`Flight ${w.flight} departs ${time}`;
  return w.place ? t`${w.title} at ${time}, ${w.place}` : t`${w.title} at ${time}`;
}

/**
 * What a plan reminder says to the user, made from its data where it is shown (the Conversation, Now, its card, a push): in the
 * screens' language. @param {PlanSay} say @returns {string}
 */
export function planWords(say) {
  const what = say.what ? whatWords(say.what) : '';
  switch (say.event) {
    case 'leave':
      if (say.minutes === undefined) return t`Leave soon: ${what}.`;
      return sentences(t`Leave in about ${num(say.left ?? LEAVE_LEAD_MIN)} min: ${what}.`, say.mode === 'walk' ? t`About ${num(say.minutes)} min on foot.` : t`About ${num(say.minutes)} min by car.`);
    case 'late': return say.minutes === undefined ? t`Running late: ${what}.` : sentences(t`Running late: ${what}.`, t`About ${num(say.minutes)} min away.`);
    case 'off-plan': return t`Planned now: ${String(say.title)}, at ${String(say.place)}.`;
    case 'arrived': return sentences(t`${String(say.place)}: ${String(say.title)}.`, say.notes ?? '');
    case 'coming-up': return t`In ${num(say.left ?? COMING_UP_MIN)} min: ${what}.`;
    case 'linger':
      if (say.next === undefined) return t`You've stopped somewhere that isn't on the itinerary.`;
      if (!say.next) return t`Nothing more is on the itinerary.`;
      return t`Next on the itinerary: ${say.next.title} at ${say.next.later ? dayClock(say.next.at, say.next.tz) : clock(say.next.at, say.next.tz)}.`;
    default: return '';
  }
}

/** The item a coming-up reminder is about, for the user: a push that counts down to it says the minutes itself. @param {PlanSay} say */
export const planItemWords = (say) => (say.what ? whatWords(say.what) : '');

/** @param {any} w @param {number} [t] */
const hhmm = (w, t = w.at) => timeIn(t, w.tz);
/**
 * An item's planned time, on its own clock, as the off-plan wake says it: "for 09:45–10:05"; "for 09:45" with no end (none is made up);
 * and an end on a later day names both days, in the words a reminder's time is read in (dueWords), so it can't be read as one day.
 * @param {any} w
 */
/* en */
const span = (w) => {
  if (w.end === null) return `for ${hhmm(w)}`;
  if (dayIn(w.end, w.tz) === dayIn(w.at, w.tz)) return `for ${hhmm(w)}–${hhmm(w, w.end)}`;
  const day = (/** @type {number} */ t) => dueWords(isoInZone(t, w.tz));
  return `from ${day(w.at)} to ${day(w.end)}`;
};
/**
 * What a wake says of an item beside its title: "(can't be moved, 12:00)", "(09:45)" for a flexible one, and a time Shiori isn't sure of
 * says so (fixedWords). @param {any} w @param {(string | null)[]} more
 */
const tag = (w, ...more) => { const p = [fixedWords(w.fixed, { unsure: w.unsure === true }), ...more].filter(Boolean); return p.length ? ` (${p.join(', ')})` : ''; };
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
  if (!from) return { due: w.at - 30 * MIN, km: null, minutes: null, words: '', mode: '' };
  const km = meters(from, w.place) / 1000;
  if (km * 1000 <= w.radius) return null;
  const t = trip(km, m.activity);
  return { due: w.at - (t.minutes + LEAVE_LEAD_MIN) * MIN, km, minutes: t.minutes, words: t.words, mode: t.mode };
}

/** What fired, for Shiori, and its fallback: annai's English. @type {Record<string, (w: any, m: Moment, mem: Record<string, any>) => Firing | null>} */
/* en */
const CHECK = {
  leave(w, m) {
    const l = leaving(w, m);
    if (!l || m.now < l.due || m.now >= w.at) return null;
    const how = l.km === null ? '' : `: ${kmText(l.km * 1000)} away in a straight line, about ${l.minutes} min ${l.words}`;
    // The words name the minutes left to the time to leave as of now (the reminder may fire late: annai was closed, or the user moved away).
    // With no estimate to count from, or once the time is here or past, they say "soon"; so they do on a catch-up's first look, which
    // counts from where the user was when annai went away: a count from there may be false by the time they read it.
    const left = l.km === null ? 0 : Math.round((w.at - l.minutes * MIN - m.now) / MIN);
    const lead = l.km !== null && !m.past && left >= 1;
    return {
      text: `Plan: time to leave soon for "${w.title}"${tag(w, hhmm(w))}${how}`, at: l.due,
      fallback: lead ? `Leave in about ${left} min: ${w.what}. About ${l.minutes} min ${l.words}.` : `Leave soon: ${w.what}.`,
      say: lead ? { event: 'leave', what: w.short, minutes: l.minutes, mode: l.mode, left } : { event: 'leave', what: w.short },
    };
  },
  'coming-up'(w, m) {
    const due = w.at - COMING_UP_MIN * MIN;
    if (m.now < due || m.now >= w.at) return null;
    // The minutes left now (it may fire late), for Shiori's text, her fallback and the user's words alike.
    const left = Math.max(1, Math.round((w.at - m.now) / MIN));
    return { text: `Plan: "${w.title}"${tag(w)} starts at ${hhmm(w)}, in ${left} min`, at: due, fallback: `In ${left} min: ${w.what}.`, say: { event: 'coming-up', what: w.short, left } };
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
    return { text: `Plan: you arrived at ${w.place.name} for "${w.title}"${tag(w, hhmm(w))}${back && !stopped && !long ? ', inferred on coming back on screen' : ''}`, place: w.place };
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
      text: `Plan: running late for "${w.title}"${tag(w, hhmm(w))}: ${kmText(km * 1000)} away, about ${t.minutes} min ${t.words}, so about ${Math.round((eta - w.at) / MIN)} min late`,
      fallback: `Running late: ${w.what}. About ${t.minutes} min away.`,
      say: { event: 'late', what: w.short, minutes: t.minutes },
    };
  },
  'off-plan'(w, m) {
    const fix = now(m);
    // Its first hour, or until it ends if sooner: when it may fire, never an end she is told (span).
    if (!fix || m.fired(`plan:${w.item}:arrived`) || m.now < w.at + OFF_PLAN_AFTER_MIN * MIN || m.now > Math.min(w.end ?? Infinity, w.at + OFF_PLAN_FOR_MIN * MIN)) return null;
    const km = meters(fix, w.place) / 1000;
    if (km <= OFF_PLAN_KM) return null;
    return { text: `Off plan: "${w.title}"${tag(w)} is planned ${span(w)} at ${w.place.name}, and the user is ${kmText(km * 1000)} away. The replanning skill says what to do` };
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
    // A next item on another day than the moment's names its day (its time alone reads as today's): worked out once, for Shiori's words and the user's.
    const later = Boolean(next) && dayIn(next.at, next.tz) !== dayIn(m.now, next.tz);
    const nextAt = next ? (later ? dueWords(isoInZone(next.at, next.tz)) : timeIn(next.at, next.tz)) : '';
    return {
      text: `Off plan: the user has been stopped for ${Math.round((m.now - s.since) / MIN)} min at a place that isn't on the plan (${s.lat.toFixed(4)}, ${s.lng.toFixed(4)})${next ? `; next on the plan: "${next.title}" at ${nextAt}` : ''}. The replanning skill says what to do`,
      at: s.since + LINGER_MIN * MIN, place: { lat: s.lat, lng: s.lng },
      fallback: next ? `Next on the plan: ${next.title} at ${nextAt}.` : 'Nothing more is on the plan.',
      say: { event: 'linger', next: next ? { title: next.title, at: next.at, tz: next.tz, ...(later ? { later: /** @type {const} */ (true) } : {}) } : null },
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
/* en */
const DESCRIBE = {
  leave: (w) => `${LEAVE_LEAD_MIN} min before leaving for "${w.title}" at ${hhmm(w)}`,
  'coming-up': (w) => `${COMING_UP_MIN} min before "${w.title}" at ${hhmm(w)}`,
  arrived: (w) => `on arriving at ${w.place.name} for "${w.title}"`,
  late: (w) => `when running late for "${w.title}" at ${hhmm(w)}`,
  'off-plan': (w) => `when far from "${w.title}" in the first ${OFF_PLAN_FOR_MIN} min of its time`,
  linger: () => `on stopping ${LINGER_MIN} min somewhere not on the plan`,
};

/** The plan's trigger type. It isn't for watch_set: the plan sets these itself. @type {import('./triggers.js').TriggerType} */
export const PLAN = {
  type: 'plan', gps: false, summary: '',
  validate: () => /* en */ 'the plan sets its own watches',
  describe: (w) => DESCRIBE[w.event]?.(w) ?? String(w.event),
  check: (w, m, mem) => CHECK[w.event]?.(w, m, mem) ?? null,
  next: (w, m, mem) => NEXT[w.event]?.(w, m, mem) ?? null,
};
