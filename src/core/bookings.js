import { kindOf } from './scopes.js';
// plan.js imports this module too: its names are read only inside functions here, never while the modules load.
import { BOOKING_FILE, record, CARRIERS } from './plan.js';
import { validZone, instantAt, isoInZone, offsetMinutes } from './time.js';

/**
 * Shiori's writes to bookings (spec §4.4, §7.3). There is no confirming step: a booking she writes lists in `unsure` just the fields she
 * isn't sure of (`[]` when none), and only those are marked for the user to check. A booking without the `unsure` key is from before: an
 * unverified one is read as if `unsure` named every part it has (checkOf), until she is told which are right. She still never sets `confirmed`.
 */

/** What Shiori is told to do with a booking she reads (a hand-over, and files added on the trip screen). */
/* en */ export const FILE_BOOKING = "If one is a booking (a confirmation, ticket, Wallet pass or reservation), read it, write a booking in /trip/bookings/ with source set to its path and unsure listing just the fields you are not sure of (an empty list when you are sure of them all), add the fixed plan items it implies with booking set to the booking's path, and ask only about the fields in unsure.";

/** A booking's own fields, besides those in its `fields` object, that `unsure` may name. */
export const TOP = ['title', 'start', 'end', 'place', 'confirmation', 'cost'];

/**
 * Whether a value is there: not null, no blank text, and a list or an object only when one of its items is (`['']` and a place `{ name: ' ' }`
 * are not). The one rule for a booking's own fields and the keys of `fields`: what is marked (checkOf) and what the details draw (format.js
 * bookingFacts, which draws a list's items that are there, and a place by its name or its address). @param {unknown} v @returns {boolean}
 */
export const there = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(typeof v === 'object' && !(Array.isArray(v) ? v : Object.values(v)).some(there));

/**
 * Whether a booking has a value of its own for one of its own fields (TOP): its place by its name or its address, as the details draw it (a
 * name of spaces with only coordinates is not there), any other by its value. A name that is no such field: false.
 * @param {any} b @param {string} k @returns {boolean}
 */
const ownPart = (b, k) => TOP.includes(k) && (k === 'place' ? there(b.place?.name) || there(b.place?.address) : there(b[k]));

/**
 * What of a booking the screens mark for the user to check: the names in `unsure` of fields it has (its own, or keys of `fields`, as
 * written), once each. A key of `fields` named like one of its own fields is that part when the booking has none of its own (a model wrote
 * `fields.place`), and the same part, marked once, when it has (the details draw one line for it, bookingFacts). A record from before (no
 * `unsure` key) not confirmed reads as if `unsure` named every part it has: its own fields that `unsure` may name, then the keys of
 * `fields`, through the same rule as a new booking. Reading only: nothing is stored, so the
 * file keeps no `unsure` until she writes one (booking-say's round 4: a mark of the whole booking was a second answer for one old
 * shape, and every reader carried a branch for it). Anything odd marks nothing, and nothing throws.
 * @param {any} b @returns {{ fields: string[] }}
 */
export function checkOf(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { fields: [] };
  const extra = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : {};
  const named = 'unsure' in b ? b.unsure : b.status !== 'confirmed' ? [...TOP, ...Object.keys(extra)] : [];
  if (!Array.isArray(named)) return { fields: [] };
  const has = (/** @type {string} */ k) => ownPart(b, k) || (Object.hasOwn(extra, k) && there(extra[k]));
  /** @type {string[]} */
  const fields = [];
  for (const k of named) if (typeof k === 'string' && !fields.includes(k) && has(k)) fields.push(k);
  return { fields };
}

/**
 * A booking's parts as a model is told them: by what each is, never the field's name, which a model says, translated (「未確認」, 2026-11-14).
 * Its times by its kind, as people say them (the user's words, 2026-11-14: "how people will actually say"): the screens' own words for what
 * carries the traveller (a flight, a train or a ride: Departs, Arrives) and a stay (Check-in, Check-out), and for a car the Plan's (Pick up,
 * Return), though the booking screen says Starts and Ends there. Only annai's own words, from its own tables: a key of `fields` is the booking's text, which can hold a
 * line break, brackets or 40,000 characters, so a key annai has no words for is one phrase and never itself (booking-say's fix 3). The keys of
 * `fields` here are the details screen's (format.js FIELD_WORDS), each named as its label there, so the user finds the line she asks about.
 */
/* en */ const TIME_PARTS = /** @type {Record<string, [string, string]>} */ ({ lodging: ['the check-in time', 'the check-out time'], car: ['the pick-up time', 'the return time'] });
/** What carries the traveller (plan.js CARRIERS: a flight, a train, a ferry, a bus or a coach) leaves and arrives. */
/* en */ const CARRIED = /** @type {[string, string]} */ (['the departure time', 'the arrival time']);
/* en */ const PARTS = /** @type {Record<string, string>} */ ({
  title: 'the name', confirmation: 'the confirmation number', place: 'the place', cost: 'the cost', // its own fields (TOP)
  flight: 'the flight number', from: 'where it leaves from', to: 'where it arrives', class: 'the cabin', nights: 'the number of nights',
  pickup: 'the pick-up place', dropoff: 'the drop-off place', party: 'the party size', travellers: 'the travellers', bags: 'the bags',
  terminal: 'the terminal', gate: 'the gate', train: 'the train', car: 'the car',
  // Inside the bags, and a leg's meal (booking-next: the keys the details drew in English).
  checked: 'the checked bags', carry_on: 'the carry-on bags', meal: 'the meal',
  // The names annai files into `fields` itself (EXTRAS; `total` and `price` a cost she gave in words; `arrival` is the word a model writes
  // itself, a place or a time: "the arrival" fits both), and her instructions' example (`rooms`).
  notes: 'the notes', room: 'the room', phone: 'the phone number', guests: 'the guests', passengers: 'the passengers', airline: 'the airline',
  company: 'the company', seat: 'the seat', flights: 'the flights', arrival: 'the arrival', total: 'the total', price: 'the price',
  rooms: 'the number of rooms',
});
/** The parts that are plural, so a model reads "were", not "was" (a plural noun read with "was" is English that a model takes as a slip). */
/* en */ const MANY = new Set(['the travellers', 'the bags', 'the notes', 'the guests', 'the passengers', 'the flights', 'the checked bags', 'the carry-on bags']);
/** What any other key is: its text is the booking's, and never goes into annai's words. */
/* en */ const OTHER = 'some other detail';

/** One part of a booking in words. @param {string} key @param {unknown} kind */
function partWords(key, kind) {
  /* en */ if (key === 'start' || key === 'end') return (CARRIERS.has(String(kind)) ? CARRIED : TIME_PARTS[String(kind)] ?? ['the start time', 'the end time'])[key === 'start' ? 0 : 1];
  return Object.hasOwn(PARTS, key) ? PARTS[key] : OTHER;
}

/**
 * What a model is shown of a booking's check, beside it: what the screens mark (checkOf), never the `status` word, which Koe translated
 * (「未確認」 on bookings with nothing to check, 2026-11-14). It names each part marked, as the screens mark each beside its value, so she can
 * say which to check: an old booking's parts too, with no phrase for the whole booking (a phrase for the whole record hides which part to
 * check). Nothing when nothing is marked, as for a confirmed one. @param {any} b
 */
export function checkWords(b) {
  const c = checkOf(b);
  if (!c.fields.length) return '';
  const parts = [...new Set(c.fields.map((k) => partWords(k, b.kind)))]; // the other-detail phrase once, however many keys
  // With several parts the verb agrees with the last, as it does after "or".
  /* en */ return `not sure ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}` : parts[0]} ${MANY.has(parts.at(-1) ?? '') ? 'were' : 'was'} read right`;
}

/** A trip's booking record. @param {string} scope @param {string} path */
export function isBookingPath(scope, path) {
  return kindOf(scope) === 'trip' && BOOKING_FILE.test(path);
}

/**
 * What a model reads after a booking's file, apart from its JSON: the check the screens mark, in words (checkWords), so she never works it out
 * from the fields (a missing `unsure` and an empty one read alike to a model). Nothing when nothing is marked or it is no booking's record. Used
 * by the two tools that show a booking's file whole, the files plugin's `read` and `read_trip`; not by a write, a patch or a search (their
 * results show no file, so a booking she wrote with `unsure` comes back with no note: FILE_BOOKING and her instructions say what she asks then,
 * and their no-note line is of a booking she read). @param {string} scope @param {string} path @param {string} text its text
 */
export function checkNote(scope, path, text) {
  if (!isBookingPath(scope, path)) return '';
  let booking;
  try {
    booking = JSON.parse(text);
  } catch {
    return '';
  }
  const words = checkWords(booking);
  /* en */ return words ? `(annai marks this booking for the user to check: ${words}.)` : '';
}


/**
 * Other names models write a booking's fields under (a small model wrote checkin, pickup, flights, name, total). Times go to start and
 * end; a location and an address are the place; a total or price with an amount and currency is the cost; the details models also write
 * at the top level are kept in fields, where anything reads them.
 */
/** The names for a time of arriving and of leaving (a stay reads them the other way round than a carrier: fieldOf). */
const ARRIVING = ['arrive', 'arrival'];
const LEAVING = ['depart', 'departure'];
const TIMES = /** @type {Record<string, string>} */ ({
  checkin: 'start', check_in: 'start', checkIn: 'start', pickup: 'start', pick_up: 'start', pickUp: 'start', depart: 'start', departure: 'start',
  checkout: 'end', check_out: 'end', checkOut: 'end', dropoff: 'end', drop_off: 'end', dropOff: 'end', return: 'end', arrive: 'end', arrival: 'end',
});
/**
 * The field a time written under another name stands for, by the booking's kind: leaving starts and arriving ends, except for a stay, as a
 * hotel's confirmation says it: the arrival is the check-in and the departure the check-out (they were swapped). A car or a tour filed as
 * "other" moves the traveller, so it keeps leaving as the start. @param {string} key @param {unknown} kind @returns {string | undefined}
 */
const fieldOf = (key, kind) => (kind === 'lodging' && ARRIVING.includes(key) ? 'start' : kind === 'lodging' && LEAVING.includes(key) ? 'end' : TIMES[key]);
const COSTS = ['total', 'price'];
const EXTRAS = ['notes', 'room', 'phone', 'guests', 'passengers', 'airline', 'company', 'seat', 'flight', 'flights'];
const ALIASES = [...Object.keys(TIMES), 'name', 'location', 'address', ...COSTS, ...EXTRAS];
/* en */ const WHEN = '{ "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }';
/** The format's field an alias stands for, and how that field is written (for the refusal of an edit that adds one). */
const OWN = /** @type {Record<string, [string, string]>} */ ({
  ...Object.fromEntries(Object.entries(TIMES).map(([k, to]) => [k, [to, WHEN]])),
  /* en */ name: ['title', 'text'], location: ['place', '{ "name": "...", "address": "..." }'], address: ['place', '{ "name": "...", "address": "..." }'],
  /* en */ ...Object.fromEntries(COSTS.map((k) => [k, ['cost', '{ "amount": 245, "currency": "EUR" }']])),
});
const AT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))?$/;

/**
 * A date with a time as it is written: trimmed, a space read as the T, and a day that exists (Nov 31 is none, as Date.parse would read it
 * as Dec 1) with an hour under 24 and a minute and second under 60; null for anything else. `at` is that text, and `m` its parts: [1] the
 * day, [2] the hour, [3] the minute, [4] the second, [5] the Z or the offset when there is one, [6] its sign, [7] and [8] its hours and minutes.
 * The one reading of it: a write is accepted by it (timeOf), and the details draw a flight leg's times by it (format.js bookingFacts), so
 * what is accepted and what is drawn as a time never differ. Its zone is not read: that is the caller's, from where it came.
 * @param {unknown} v @returns {{ at: string, m: RegExpExecArray } | null}
 */
export function written(v) {
  const at = typeof v === 'string' ? v.trim().replace(' ', 'T') : '';
  const m = AT.exec(at);
  const day = m ? Date.parse(`${m[1]}T00:00Z`) : NaN;
  const real = m && Number.isFinite(day) && new Date(day).toISOString().startsWith(m[1]) && +m[2] < 24 && +m[3] < 60 && +(m[4] ?? 0) < 60;
  return m && real ? { at, m } : null;
}

/**
 * A time written under another name, or a start or end written as { at, tz }, as the format's { at, tz }: a string, or { at } (or { time })
 * with its own tz; its zone from beside it, else the trip's only one, which what carries the traveller (CARRIERS) never takes. It leaves in
 * one place and arrives in another, so the zone beside a departure (a top-level tz, a leg's tz) serves the departure only: an arrival takes
 * its own { tz } (an offset says no zone) or is refused asking for it. Refused in words when it is no real date and time, its zone isn't
 * known, or its offset isn't its zone's at that moment.
 * @param {string} name what it was written as @param {unknown} v @param {unknown} beside the zone written beside it
 * @param {string[]} zones the trip's @param {string} to the field it stands for @param {boolean} far a flight's, train's or ride's (CARRIERS)
 */
function timeOf(name, v, beside, zones, to, far) {
  const o = record(v);
  const raw = o ? o.at ?? o.time : v;
  const arrives = far && to === 'end';
  const tz = [o?.tz, arrives ? '' : beside, !far && zones.length === 1 ? zones[0] : ''].find((z) => typeof z === 'string' && z) ?? '';
  /* en */ const how = `write ${to} as ${WHEN}${name.includes('[') || name === to ? '' : ` in place of ${name}`}`;
  const w = written(raw);
  /* en */ if (!w) throw new Error(`${name} ${JSON.stringify(raw ?? null)} isn't a date with a time: ${how}.`);
  const { at, m } = w;
  if (!validZone(tz)) {
    /* en */ const why = arrives && !tz ? ` (the time of a flight, a train, a ferry, a bus or a coach is in the place it leaves or arrives, and an arrival can be in another time zone than the departure, so the arrival needs a tz of its own)` : far && !tz ? ` (the time of a flight, a train, a ferry, a bus or a coach is in the place it leaves or arrives, so the trip's time zone isn't assumed)` : zones.length > 1 ? ` (this trip has ${zones.join(', ')})` : '';
    /* en */ throw new Error(`${name} ${JSON.stringify(raw)} has no time zone annai knows${why}: ${how}.${/^flights\+?\[/.test(name) ? (arrives ? ' Give the arrival its own "tz": the leg\'s "tz" is the zone it leaves in.' : ' Or give the leg a "tz".') : ''}`);
  }
  if (!m[5]) return { at: isoInZone(instantAt(at, tz), tz), tz };
  const given = m[6] ? (m[6] === '-' ? -1 : 1) * (+m[7] * 60 + +m[8]) : 0;
  /* en */ if (given !== offsetMinutes(Date.parse(at), tz)) throw new Error(`${name} ${JSON.stringify(raw)} has an offset ${tz} doesn't have then (it is ${isoInZone(Date.parse(at), tz).slice(-6)}): ${how}.`);
  return { at, tz };
}

/** "1,245.00 USD", "USD 12.5" or { amount, currency } as the format's cost, or null: a comma only groups thousands. @param {unknown} v */
function costOf(v) {
  const o = record(v);
  let [amount, currency] = o ? [o.amount, o.currency] : [];
  const m = typeof v === 'string' ? /^\s*([A-Za-z]{3})?\s*([\d,.]+)\s*([A-Za-z]{3})?\s*$/.exec(v) : null;
  if (m && Boolean(m[1]) !== Boolean(m[3])) [amount, currency] = [m[2], m[1] ?? m[3]];
  const ok = typeof amount === 'string' && /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(amount.trim());
  const n = typeof amount === 'number' ? amount : ok ? Number(amount.replaceAll(',', '')) : NaN;
  return Number.isFinite(n) && typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? { amount: n, currency: currency.toUpperCase() } : null;
}

/** The same value, objects in any key order. @param {unknown} a @param {unknown} b @returns {boolean} */
function eq(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]));
  const [p, q] = [record(a), record(b)];
  return p && q ? Object.keys(p).length === Object.keys(q).length && Object.keys(p).every((k) => Object.hasOwn(q, k) && eq(p[k], q[k])) : Object.is(a, b);
}

/**
 * The same value, or the same time (its instant and zone) written two ways. A time with no offset is read in the zone it is written in
 * (instantAt, the reading every screen uses), never the phone's, so whether two times conflict is the same on every phone.
 * @param {unknown} a @param {unknown} b
 */
function same(a, b) {
  const [p, q] = [record(a), record(b)];
  return eq(a, b) || Boolean(p && q && typeof p.at === 'string' && typeof q.at === 'string' && p.tz === q.tz && validZone(p.tz) && instantAt(p.at, p.tz) === instantAt(q.at, q.tz));
}

/**
 * This write's own keys, written under other names, renamed to the format's own before it is stored: the write tool's whole value, or the
 * patch tool's changes (with append, "notes+" too). What is stored is never read or changed here, so this write wins over it. A key the
 * booking schema in force lists is never renamed. An alias and the field it stands for, given differently, are refused naming both; a
 * time is refused in words when it can't be read (timeOf).
 * @param {any} own @param {{ zones?: string[], schema?: any, kind?: unknown, append?: boolean }} [o] the trip's time zones; the booking
 * schema in force; the stored booking's kind, if this write doesn't give one; a patch's appends
 * @returns {any}
 */
export function unalias(own, { zones = [], schema, kind, append = false } = {}) {
  const listed = record(record(schema)?.properties) ?? {};
  const base = (/** @type {string} */ k) => (append && k.endsWith('+') && EXTRAS.includes(k.slice(0, -1)) ? k.slice(0, -1) : k);
  const isAlias = (/** @type {string} */ k) => ALIASES.includes(base(k)) && !Object.hasOwn(listed, base(k));
  // A null alias in a patch deletes its own field and the alias key as stored; in a whole write, a null is the same as not there (but
  // unsure: the format check says what is wrong with it, so a booking never silently loses its marking list).
  const gone = record(own) ? Object.keys(own).filter((k) => own[k] === null && (append ? isAlias(k) : k !== 'unsure')) : [];
  const keys = record(own) ? Object.keys(own).filter((k) => isAlias(k) && own[k] !== null) : [];
  if (!keys.length && !gone.length) return own;
  const out = { ...own };
  for (const k of [...keys, ...gone]) delete out[k];
  const what = own.kind ?? kind;
  /** @param {string} k a time alias @returns {string} the field it stands for, by this booking's kind */
  const field = (k) => fieldOf(k, what) ?? '';
  // A flight's, a train's or a ride's times are in the place it leaves or arrives: the trip's only zone says nothing about them.
  const far = CARRIERS.has(what);
  const besideKey = ['tz', 'timezone'].find((k) => typeof own[k] === 'string');
  const beside = besideKey && own[besideKey];
  // A fields that isn't an object is the format check's to refuse: nothing is filed into it, and its aliases stay as written.
  const fields = out.fields === undefined ? {} : record(out.fields) && { ...out.fields };
  /** @type {Record<string, string>} unsure's names for them, as stored */
  const named = {};
  /** @type {Set<string>} aliases kept as written, for the format check to refuse */
  const kept = new Set();
  /** @param {string} alias @param {string} to "start", or "fields.dropoff" @param {unknown} v */
  const put = (alias, to, v) => {
    const sub = to.startsWith('fields.') ? to.slice(7) : '';
    if (sub && !fields) return void (kept.add(alias), (out[alias] = own[alias]));
    const at = sub ? fields : out;
    /* en */ if (at[sub || to] != null && !same(at[sub || to], v)) throw new Error(`${alias} and ${to} are both given and differ: keep one and remove the other.`);
    at[sub || to] = v;
    named[alias] = sub || to;
  };
  /** @type {[string, unknown][]} where a time says it ends (a drop-off, an arrival) */
  const ends = [];
  /** @type {[string, string, unknown][]} the place's parts, in order, as [alias, key of place, value]: a pick-up's place, a location, an address */
  const parts = [];
  /** @param {string} alias @param {unknown} v a name or address, or an object with the place's keys @param {string} key what a string is */
  const note = (alias, v, key) => void (record(v) ? Object.entries(/** @type {object} */ (v)).forEach(([x, y]) => parts.push([alias, x, y])) : parts.push([alias, key, v]));
  for (const k of keys.filter((x) => Object.hasOwn(TIMES, x))) {
    put(k, field(k), timeOf(k, own[k], beside, zones, field(k), far));
    const o = record(own[k]);
    // An empty name or address says nothing: it never replaces the stored one.
    const said = (/** @type {unknown} */ x) => x != null && x !== '';
    const where = o && [o.location, o.place, o.address].find(said);
    if (where && field(k) !== 'start') ends.push([k, where]);
    else if (o) {
      const name = [o.location, o.place].find(said);
      if (name !== undefined) note(k, name, 'name');
      if (said(o.address)) note(k, o.address, 'address');
    }
  }
  const fk = keys.find((k) => base(k) === 'flights');
  const legs = fk ? (Array.isArray(own[fk]) ? own[fk] : fk.endsWith('+') ? [own[fk]] : []).map(record) : [];
  if (legs.length && legs.every(Boolean)) {
    // A flight leaves with its first leg and arrives with its last, unless this write says when; the legs are kept as written. A leg's tz is
    // where it leaves: the arrival takes only its own, or is refused (a whole write's, and an appended leg's that has an arrival written).
    // An appended leg with no arrival still appends, and the end stays as it was: it says no time to move it to.
    const [first, last, n] = [legs[0], legs[legs.length - 1], legs.length - 1];
    if (out.start == null && fk === 'flights') put(fk, 'start', timeOf('flights[0].departure', first?.departure ?? first?.depart, first?.tz ?? beside, zones, 'start', true));
    if (out.end == null) {
      const arrival = last?.arrival ?? last?.arrive;
      const o = record(arrival);
      try {
        put(fk ?? '', 'end', timeOf(`${fk}[${n}].arrival`, arrival, undefined, zones, 'end', true));
      } catch (e) {
        // An arrival with a time written (timeOf's own reading: its `at`, else its `time`, else the text) that can't be placed is refused.
        if (fk === 'flights' || there(o ? o.at ?? o.time : arrival)) throw e;
      }
    }
  }
  for (const k of ['location', 'address']) if (keys.includes(k) && own[k] !== '') note(k, own[k], k === 'address' ? 'address' : 'name');
  // In a patch a null address is the place's address null, and a null location is no place.
  const wipe = append && gone.includes('location');
  if (append && gone.includes('address')) parts.push(['address', 'address', null]);
  if (wipe || out.place === null) {
    const live = parts.find((x) => x[2] !== null)?.[0];
    const [a, b] = wipe ? ['location', live ?? (out.place != null ? 'place' : '')] : [live ?? '', 'place'];
    /* en */ if (a && b) throw new Error(`${a} and ${b} are both given and differ: keep one and remove the other.`);
    out.place = null;
  } else if (parts.length) {
    // The place's parts merge into the place this write gives, as a merge patch would; what the stored place keeps or loses is
    // shioriBooking's to say, who sees it. A second name is the address of an alias-made one.
    const place = { ...(record(out.place) ?? {}) };
    /** @type {Record<string, string>} */
    const from = Object.fromEntries(Object.keys(place).map((x) => [x, 'place']));
    for (const [k, key0, v] of parts) {
      named[k] = Object.hasOwn(TIMES, k) ? field(k) : 'place';
      const key = key0 === 'name' && typeof v === 'string' && place.name !== undefined && place.name !== v && from.name !== 'place' ? 'address' : key0;
      /* en */ if (place[key] !== undefined && !eq(place[key], v)) throw new Error(`${k} and ${from[key]} are both given and differ: keep one and remove the other.`);
      [place[key], from[key]] = [v, from[key] ?? k];
    }
    const title = [own.title, own.name].find((x) => typeof x === 'string' && x.trim());
    if (!append && place.name === undefined && title) place.name = title;
    out.place = place;
  }
  for (const [k, where] of ends) {
    // An end elsewhere than the place is kept in fields: a car's is its drop-off, whatever it was called; an arrival's is where it arrives
    // (`to`, read "To", 到着地: `arrival` is the word for a time, "Arrival" 到着, which the details draw beside it as "Arrives").
    if (![record(out.place)?.name, record(out.place)?.address].includes(where) && !eq(where, out.place)) put(k, `fields.${/^arriv/.test(k) && what !== 'car' ? 'to' : 'dropoff'}`, where);
    named[k] = 'end';
  }
  for (const k of keys) {
    const cost = COSTS.includes(k) && costOf(own[k]);
    if (k === 'name') put(k, 'title', own[k]);
    else if (cost) {
      put(k, 'cost', cost);
      if (append && fields) fields[k] ??= null; // a total kept in words before goes, now it is a cost
    }
    else if (COSTS.includes(k) || EXTRAS.includes(base(k))) put(k, `fields.${k}`, own[k]);
  }
  for (const k of append ? gone.filter((x) => !x.endsWith('+')) : []) {
    const to = (Object.hasOwn(TIMES, k) ? field(k) : '') || (k === 'name' ? 'title' : COSTS.includes(k) ? 'cost' : EXTRAS.includes(k) ? `fields.${k}` : '');
    out[k] = null;
    if (to.startsWith('fields.')) {
      if (fields) fields[to.slice(7)] ??= null;
    } else if (to) out[to] ??= null;
    if (COSTS.includes(k) && fields) fields[k] ??= null;
  }
  // A renamed key of a patch also nulls its own name, so a copy stored under it goes at once ("+" only appends: it never deletes).
  if (append) for (const k of keys) if (!k.endsWith('+') && !kept.has(k)) out[k] = null;
  if (fields && Object.keys(fields).length) out.fields = fields;
  if (besideKey && (legs.length || keys.some((k) => Object.hasOwn(TIMES, k)))) delete out[besideKey];
  /** @param {unknown} n */
  const renamed = (n) => (typeof n === 'string' && Object.hasOwn(named, n) ? named[n] : n);
  if (Array.isArray(out.unsure)) out.unsure = [...new Set(out.unsure.map(renamed))];
  if (append && out['unsure+'] != null) out['unsure+'] = Array.isArray(out['unsure+']) ? [...new Set(out['unsure+'].map(renamed))] : renamed(out['unsure+']);
  return out;
}

/**
 * What to store when Shiori writes a booking: the value as it will be read (other names already renamed by unalias), or a refusal in
 * words. She never sets `confirmed`; a change of hers to a booking the user confirmed keeps it confirmed (with no confirming step, nothing
 * would ever clear it again). A top-level key her write brings that the booking schema in force doesn't list is refused: nothing would
 * read it. Keys already stored never block her. The schema itself stays open, so the user's own edits, Undo, Restore and imports work as
 * before; a plugin adds fields in `fields`, or as properties of a booking schema it registers.
 * @param {any} before the booking as stored, or undefined @param {any} next what she would store
 * @param {{ schema?: any, changes?: any }} [o] the booking schema in force; a patch's changes (as renamed), which decide what of a
 * renamed place is stale
 * @returns {any}
 */
export function shioriBooking(before, next, { schema, changes } = {}) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next; // the format check says what is wrong
  const old = record(before);
  if (next.status === 'confirmed' && old?.status !== 'confirmed') {
    /* en */ throw new Error('Only the user confirms a booking. Write it with status "unverified", and list in unsure the fields you are not sure of.');
  }
  // A new booking, and one written with unsure, always carry it: without it, it would read as one from before.
  if (!('unsure' in next) && (!old || 'unsure' in old)) {
    /* en */ throw new Error('A new booking lists the fields you are unsure of in unsure (an empty list when you are sure of all of them), so the user sees what to check.');
  }
  // A start or an end written as stored gets the check its aliases get (timeOf), when this write changes it: next is the value as it will be
  // stored (a patch merged in), so a stored time a write leaves alone or carries back as it was is never refused.
  for (const k of ['start', 'end']) {
    const time = record(next[k]);
    if (typeof time?.at === 'string' && typeof time.tz === 'string' && !same(time, old?.[k])) timeOf(k, time, undefined, [], k, false);
  }
  // A booking is one stretch of time: a write that changes its start or its end must not leave the end before the start (a round trip's
  // arrival and departure, written under one booking, came out with Nov 25 for its start and Nov 20 for its end). Instants, each in its own zone.
  const [from, to] = [next.start, next.end].map((x) => (record(x) && validZone(record(x)?.tz) ? instantAt(record(x)?.at, record(x)?.tz) : NaN));
  if (to < from && (!same(next.start, old?.start) || !same(next.end, old?.end))) {
    /* en */ throw new Error(`end ${JSON.stringify(record(next.end)?.at)} is before start ${JSON.stringify(record(next.start)?.at)}: a booking is one stretch of time, so write the earlier time as start and the later as end (a round trip is two bookings, one for each way).`);
  }
  // `unsure+` on a booking with no unsure key adds to the parts marked now (checkOf), so the rest stay marked.
  const patch = record(changes);
  if (patch && Object.hasOwn(patch, 'unsure+') && !Object.hasOwn(patch, 'unsure') && old && !('unsure' in old) && Array.isArray(next.unsure)) {
    next = { ...next, unsure: [...new Set([...checkOf(old).fields, ...next.unsure])] };
  }
  const own = record(record(schema)?.properties);
  const place = record(next.place);
  if (place) {
    const p = { ...place };
    const was = record(old?.place);
    // A patch that gives another name for the place leaves its address and position as the old place's, and another address its
    // position, unless the patch gives them.
    if (changes && was) {
      const given = record(record(changes)?.place) ?? {};
      const moved = (/** @type {string} */ k) => typeof was[k] === 'string' && typeof p[k] === 'string' && p[k] !== was[k];
      // A name that was only a copy of the address (named from it below) is no real name: naming the place keeps its address, and
      // another address takes the copy with it.
      const copy = was.name === was.address;
      if (copy && moved('address') && p.name === was.name) p.name = p.address;
      const stale = moved('name') && !copy ? ['address', 'lat', 'lng'] : moved('address') ? ['lat', 'lng'] : [];
      for (const k of stale) if (!Object.hasOwn(given, k)) delete p[k];
    }
    if (!(typeof p.name === 'string' && p.name.trim()) && typeof p.address === 'string' && p.address.trim()) p.name = p.address;
    const { place: _, ...rest } = next;
    next = Object.keys(p).length ? { ...next, place: p } : rest;
  }
  // A patch that only cleared extras leaves no empty fields behind.
  if (record(next.fields) && !Object.keys(next.fields).length && !record(old?.fields)) {
    const { fields: _, ...rest } = next;
    next = rest;
  }
  const added = own ? Object.keys(next).filter((k) => !Object.hasOwn(own, k) && !(old && Object.hasOwn(old, k))) : [];
  if (added.length) {
    // A name from the other format is told its field (an edit has no renaming, and a model would file it in fields).
    const kind = next.kind ?? old?.kind;
    const is = added.filter((k) => Object.hasOwn(OWN, k)).map((k) => { const to = Object.hasOwn(TIMES, k) ? fieldOf(k, kind) : OWN[k][0]; return ` ${k} is ${to}: write ${to} as ${OWN[k][1]}.`; }).join('');
    /* en */ throw new Error(`${added.map((k) => JSON.stringify(k)).join(', ')} ${added.length === 1 ? "isn't a booking field" : "aren't booking fields"}, so nothing was written.${is} A booking's own fields are ${Object.keys(own ?? {}).join(', ')}; put anything else in fields.`);
  }
  return next;
}
