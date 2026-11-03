import { kindOf } from './scopes.js';
import { BOOKING_FILE, record } from './plan.js';
import { validZone, instantAt, isoInZone, offsetMinutes } from './time.js';

/**
 * Shiori's writes to bookings (spec §4.4, §7.3). There is no confirming step (the bookings-and-trips design, My call 1): a booking she
 * writes lists in `unsure` just the fields she isn't sure of (`[]` when none), and only those are marked for the user to check. A
 * booking without the `unsure` key is from before: an unverified one is marked whole until she is told it's right. She still never sets
 * `confirmed`.
 */

/** What Shiori is told to do with a booking she reads (a hand-over, and files added on the trip screen). */
/* en */ export const FILE_BOOKING = "If one is a booking (a confirmation, ticket, Wallet pass or reservation), read it, write a booking in /trip/bookings/ with source set to its path and unsure listing just the fields you are not sure of (an empty list when you are sure of them all), add the fixed plan items it implies with booking set to the booking's path, and ask only about the fields in unsure.";

/** A booking's own fields, besides those in its `fields` object, that `unsure` may name. */
const TOP = ['title', 'start', 'end', 'place', 'confirmation', 'cost'];

/**
 * What of a booking the screens mark for the user to check: `whole`, an old record (no `unsure` key) not confirmed; `fields`, the names
 * in `unsure` of fields it has (its own, or keys of `fields`, as written), once each. Anything odd marks nothing, and nothing throws.
 * @param {any} b @returns {{ whole: boolean, fields: string[] }}
 */
export function checkOf(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { whole: false, fields: [] };
  if (!('unsure' in b)) return { whole: b.status !== 'confirmed', fields: [] };
  if (!Array.isArray(b.unsure)) return { whole: false, fields: [] };
  const extra = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : {};
  const has = (/** @type {string} */ k) => (TOP.includes(k) ? b[k] !== undefined && b[k] !== null && b[k] !== '' : Object.hasOwn(extra, k));
  /** @type {string[]} */
  const fields = [];
  for (const k of b.unsure) if (typeof k === 'string' && !fields.includes(k) && has(k)) fields.push(k);
  return { whole: false, fields };
}

/** A trip's booking record. @param {string} scope @param {string} path */
export function isBookingPath(scope, path) {
  return kindOf(scope) === 'trip' && BOOKING_FILE.test(path);
}


/**
 * Other names models write a booking's fields under (a small model wrote checkin, pickup, flights, name, total: the drive-test follow-ups,
 * section 3). Times go to start and end; a location and an address are the place; a total or price with an amount and currency is the
 * cost; the details models also write at the top level are kept in fields, where anything reads them.
 */
const TIMES = /** @type {Record<string, string>} */ ({
  checkin: 'start', check_in: 'start', checkIn: 'start', pickup: 'start', pick_up: 'start', pickUp: 'start', depart: 'start', departure: 'start',
  checkout: 'end', check_out: 'end', checkOut: 'end', dropoff: 'end', drop_off: 'end', dropOff: 'end', return: 'end', arrive: 'end', arrival: 'end',
});
const COSTS = ['total', 'price'];
const EXTRAS = ['notes', 'room', 'phone', 'guests', 'passengers', 'airline', 'company', 'seat', 'flight', 'flights'];
const ALIASES = [...Object.keys(TIMES), 'name', 'location', 'address', ...COSTS, ...EXTRAS];
const AT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))?$/;
/** Kinds whose times are in the place they leave or arrive: the trip's only zone says nothing about them. */
const FAR = ['flight', 'rail'];

/**
 * A time written under another name, as the format's { at, tz }: a string, or { at } (or { time }) with its own tz; its zone from beside
 * it, else the trip's only one, which a flight or train never takes. Refused in words when it is no real date and time, its zone isn't
 * known, or its offset isn't its zone's at that moment.
 * @param {string} name what it was written as @param {unknown} v @param {unknown} beside the zone written beside it
 * @param {string[]} zones the trip's @param {string} to the field it stands for @param {boolean} far a flight's or train's
 */
function timeOf(name, v, beside, zones, to, far) {
  const o = record(v);
  const raw = o ? o.at ?? o.time : v;
  const at = typeof raw === 'string' ? raw.trim().replace(' ', 'T') : '';
  const tz = [o?.tz, beside, !far && zones.length === 1 ? zones[0] : ''].find((z) => typeof z === 'string' && z) ?? '';
  /* en */ const how = `write ${to} as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }`;
  const m = AT.exec(at);
  const day = m ? Date.parse(`${m[1]}T00:00Z`) : NaN;
  // Date.parse reads Nov 31 as Dec 1: the day must read back as written.
  const real = m && Number.isFinite(day) && new Date(day).toISOString().startsWith(m[1]) && +m[2] < 24 && +m[3] < 60 && +(m[4] ?? 0) < 60;
  /* en */ if (!m || !real) throw new Error(`${name} ${JSON.stringify(raw ?? null)} isn't a date with a time: ${how}.`);
  if (!validZone(tz)) {
    /* en */ const why = far && !tz ? ` (a flight's or train's time is in the place it leaves or arrives, so the trip's time zone isn't assumed)` : zones.length > 1 ? ` (this trip has ${zones.join(', ')})` : '';
    /* en */ throw new Error(`${name} ${JSON.stringify(raw)} has no time zone annai knows${why}: ${how}.${name.startsWith('flights[') ? ' Or give the leg a "tz".' : ''}`);
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
 * This write's own keys, written under other names, renamed to the format's own before it is stored (the drive-test follow-ups, section
 * 3): the write tool's whole value, or the patch tool's changes (with append, "notes+" too). What is stored is never read or changed
 * here, so this write wins over it. A key the booking schema in force lists is never renamed. The same write giving an alias and the
 * field it stands for, differently, is refused naming both; a time is refused in words when it can't be read (timeOf).
 * @param {any} own @param {{ zones?: string[], schema?: any, kind?: unknown, append?: boolean }} [o] the trip's time zones; the booking
 * schema in force; the stored booking's kind, if this write doesn't give one; a patch's appends
 * @returns {any}
 */
export function unalias(own, { zones = [], schema, kind, append = false } = {}) {
  const listed = record(record(schema)?.properties) ?? {};
  const base = (/** @type {string} */ k) => (append && k.endsWith('+') && EXTRAS.includes(k.slice(0, -1)) ? k.slice(0, -1) : k);
  const keys = record(own) ? Object.keys(own).filter((k) => ALIASES.includes(base(k)) && !Object.hasOwn(listed, base(k)) && own[k] !== null) : [];
  if (!keys.length) return own;
  const out = { ...own };
  for (const k of keys) delete out[k];
  const what = own.kind ?? kind;
  const far = FAR.includes(what);
  const besideKey = ['tz', 'timezone'].find((k) => typeof own[k] === 'string');
  const beside = besideKey && own[besideKey];
  // A fields that isn't an object is the format check's to refuse: nothing is filed into it, and its aliases stay as written.
  const fields = out.fields === undefined ? {} : record(out.fields) && { ...out.fields };
  /** @type {Record<string, string>} unsure's names for them, as stored */
  const named = {};
  /** @param {string} alias @param {string} to "start", or "fields.dropoff" @param {unknown} v */
  const put = (alias, to, v) => {
    const sub = to.startsWith('fields.') ? to.slice(7) : '';
    if (sub && !fields) return void (out[alias] = own[alias]);
    const at = sub ? fields : out;
    /* en */ if (at[sub || to] != null && !eq(at[sub || to], v)) throw new Error(`${alias} and ${to} are both given and differ: keep one and remove the other.`);
    at[sub || to] = v;
    named[alias] = sub || to;
  };
  /** @type {[string, unknown][]} where a time says it ends (a drop-off, an arrival) */
  const ends = [];
  /** @type {[string, unknown][]} the place's parts, in order: a pick-up's place, a location, an address */
  const parts = [];
  for (const k of keys.filter((x) => Object.hasOwn(TIMES, x))) {
    put(k, TIMES[k], timeOf(k, own[k], beside, zones, TIMES[k], far));
    const where = record(own[k]) && (own[k].location ?? own[k].place ?? own[k].address);
    if (where) (TIMES[k] === 'start' ? parts : ends).push([k, where]);
  }
  const legs = keys.includes('flights') && Array.isArray(own.flights) ? own.flights.map(record) : [];
  if (legs.length && legs.every(Boolean)) {
    // A flight leaves with its first leg and arrives with its last, unless this write says when; the legs are kept as written.
    const [first, last, n] = [legs[0], legs[legs.length - 1], legs.length - 1];
    if (out.start == null) put('flights', 'start', timeOf('flights[0].departure', first?.departure ?? first?.depart, first?.tz ?? beside, zones, 'start', true));
    if (out.end == null) put('flights', 'end', timeOf(`flights[${n}].arrival`, last?.arrival ?? last?.arrive, last?.tz ?? beside, zones, 'end', true));
  }
  for (const k of ['location', 'address']) if (keys.includes(k)) parts.push([k, own[k]]);
  if (parts.length) {
    // One place from its parts and any place this write gives: a second name is the address of an alias-made one.
    const place = { ...(record(out.place) ?? {}) };
    /** @type {Record<string, string>} */
    const from = Object.fromEntries(Object.keys(place).map((x) => [x, 'place']));
    /** @param {string} alias @param {string} key @param {unknown} v */
    const part = (alias, key, v) => {
      /* en */ if (place[key] !== undefined && !eq(place[key], v)) throw new Error(`${alias} and ${from[key]} are both given and differ: keep one and remove the other.`);
      [place[key], from[key]] = [v, from[key] ?? alias];
    };
    for (const [k, v] of parts) {
      named[k] = TIMES[k] ?? 'place';
      if (record(v)) for (const [key, x] of Object.entries(/** @type {object} */ (v))) part(k, key, x);
      else if (k === 'address' || (place.name !== undefined && place.name !== v && from.name !== 'place')) part(k, 'address', v);
      else part(k, 'name', v);
    }
    place.name ??= [own.title, own.name].find((x) => typeof x === 'string' && x.trim()) ?? place.address;
    out.place = place;
  }
  for (const [k, where] of ends) {
    // An end elsewhere than the place is kept in fields: a car's is its drop-off, whatever it was called; an arrival's, its arrival.
    if (where !== out.place?.name && !eq(where, out.place)) put(k, `fields.${/^arriv/.test(k) && what !== 'car' ? 'arrival' : 'dropoff'}`, where);
    named[k] = 'end';
  }
  for (const k of keys) {
    const cost = COSTS.includes(k) && costOf(own[k]);
    if (k === 'name') put(k, 'title', own[k]);
    else if (cost) put(k, 'cost', cost);
    else if (COSTS.includes(k) || EXTRAS.includes(base(k))) put(k, `fields.${k}`, own[k]);
  }
  if (fields && Object.keys(fields).length) out.fields = fields;
  if (besideKey && (legs.length || keys.some((k) => Object.hasOwn(TIMES, k)))) delete out[besideKey];
  if (Array.isArray(out.unsure)) out.unsure = [...new Set(out.unsure.map((n) => (typeof n === 'string' && Object.hasOwn(named, n) ? named[n] : n)))];
  return out;
}

/**
 * What to store when Shiori writes a booking: the value as it will be read (her write's other names already renamed by unalias), or a
 * refusal in words. She never sets `confirmed`; a change of hers to a booking the user confirmed keeps it confirmed (with no confirming
 * step, nothing would ever clear it again). A top-level key her write brings that the booking schema in force doesn't list is refused
 * (the drive-test follow-ups, section 3): nothing would read it. Keys already stored never block her. The schema itself stays open, so
 * the user's own edits, Undo, Restore and imports work as before; a plugin adds fields in `fields`, or as properties of a booking schema
 * it registers.
 * @param {any} before the booking as stored, or undefined @param {any} next what she would store
 * @param {{ schema?: any }} [o] the booking schema in force
 * @returns {any}
 */
export function shioriBooking(before, next, { schema } = {}) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next; // the format check says what is wrong
  const old = record(before);
  if (next.status === 'confirmed' && old?.status !== 'confirmed') {
    /* en */ throw new Error('Only the user confirms a booking. Write it with status "unverified", and list in unsure the fields you are not sure of.');
  }
  // A new booking, and one written with unsure, always carry it (LESSONS 2026-10-27): without it, it would read as one from before.
  if (!('unsure' in next) && (!old || 'unsure' in old)) {
    /* en */ throw new Error('A new booking lists the fields you are unsure of in unsure (an empty list when you are sure of all of them), so the user sees what to check.');
  }
  const own = record(record(schema)?.properties);
  const added = own ? Object.keys(next).filter((k) => !Object.hasOwn(own, k) && !(old && Object.hasOwn(old, k))) : [];
  if (added.length) {
    /* en */ throw new Error(`${added.map((k) => JSON.stringify(k)).join(', ')} ${added.length === 1 ? "isn't a booking field" : "aren't booking fields"}, so nothing was written. A booking's own fields are ${Object.keys(own ?? {}).join(', ')}; put anything else in fields.`);
  }
  return next;
}
