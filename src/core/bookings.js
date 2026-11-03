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
 * Other names models write a booking's fields under (a small model wrote checkin, pickup, name, total: the drive-test follow-ups,
 * section 3), and the format's own field each stands for. flights, a flight's legs, is read apart. The order matters: a location is
 * the place before an address is added to it.
 */
const ALIASES = /** @type {Record<string, string>} */ ({
  checkin: 'start', check_in: 'start', checkIn: 'start', pickup: 'start', pick_up: 'start', pickUp: 'start', depart: 'start', departure: 'start',
  checkout: 'end', check_out: 'end', checkOut: 'end', dropoff: 'end', drop_off: 'end', dropOff: 'end', return: 'end', arrive: 'end', arrival: 'end',
  name: 'title', location: 'place', address: 'place', total: 'cost', price: 'cost',
  // What models also write at the top level; a booking keeps these in fields, which is where anything reads them.
  notes: 'fields.notes', room: 'fields.room', phone: 'fields.phone', guests: 'fields.guests', passengers: 'fields.passengers',
  airline: 'fields.airline', company: 'fields.company', seat: 'fields.seat', flight: 'fields.flight',
});
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
/** Kinds whose times are in the place they leave or arrive: the trip's only zone says nothing about them. */
const FAR = ['flight', 'rail'];

/**
 * A time written under another name, as the format's { at, tz }: a string, or { at } (or { time }) with its own tz; its zone from beside
 * it, else (when comparing) the field it stands for, else the trip's only one, which a flight or train never takes. Refused in words
 * when it is no date and time, its zone isn't known, or its offset isn't its zone's at that moment.
 * @param {string} name what it was written as @param {unknown} v @param {string} beside the booking's own tz, if it gave one
 * @param {string[]} zones the trip's @param {string} to the field it stands for
 * @param {{ far?: boolean, ownTz?: unknown }} [o] far: never take the trip's zone; ownTz: the zone of the field it is compared with
 */
function timeOf(name, v, beside, zones, to, { far = false, ownTz } = {}) {
  const o = record(v);
  const raw = o ? o.at ?? o.time : v;
  const at = typeof raw === 'string' ? raw.trim().replace(' ', 'T') : '';
  const tz = [o?.tz, beside, ownTz, !far && zones.length === 1 ? zones[0] : ''].find((z) => typeof z === 'string' && z) ?? '';
  /* en */ const how = `write ${to} as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }`;
  const offset = /(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(at);
  /* en */ if (!AT.test(at) || !Number.isFinite(Date.parse(offset ? at : `${at}Z`))) throw new Error(`${name} ${JSON.stringify(raw ?? null)} isn't a date with a time: ${how}.`);
  if (!validZone(tz)) {
    /* en */ const why = far && !tz ? ` (a flight's or train's time is in the place it leaves or arrives, so the trip's time zone isn't assumed)` : zones.length > 1 ? ` (this trip has ${zones.join(', ')})` : '';
    /* en */ throw new Error(`${name} ${JSON.stringify(raw)} has no time zone annai knows${why}: ${how}.${name.startsWith('flights[') ? ` Or give the leg a "tz".` : ` If the booking already has the right ${to}, write ${name} as null to drop this.`}`);
  }
  if (offset) {
    const given = offset[1] ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
    /* en */ if (given !== offsetMinutes(Date.parse(at), tz)) throw new Error(`${name} ${JSON.stringify(raw)} has an offset ${tz} doesn't have then (it is ${isoInZone(Date.parse(at), tz).slice(-6)}): ${how}.`);
    return { at, tz };
  }
  return { at: isoInZone(instantAt(at, tz), tz), tz };
}

/** "123.45 USD", "USD 123.45" or { amount, currency } as the format's cost, or null. @param {unknown} v */
function costOf(v) {
  const o = record(v);
  let [amount, currency] = o ? [o.amount, o.currency] : [undefined, undefined];
  const m = typeof v === 'string' ? /^\s*([A-Za-z]{3})?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*$/.exec(v) : null;
  if (m && Boolean(m[1]) !== Boolean(m[3])) [amount, currency] = [m[2], m[1] ?? m[3]];
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' && /^[\d,]+(\.\d+)?$/.test(amount.trim()) ? Number(amount.replaceAll(',', '')) : NaN;
  return Number.isFinite(n) && typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? { amount: n, currency: currency.toUpperCase() } : null;
}

/**
 * The same value: objects with the same keys in any order, times at the same instant in the same zone (when both are times), anything
 * else equal as written. @param {unknown} a @param {unknown} b @returns {boolean}
 */
export function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  const p = record(a);
  const q = record(b);
  if (!p || !q) return Object.is(a, b);
  if (typeof p.at === 'string' && typeof q.at === 'string') {
    const [x, y] = [instantAt(p.at, p.tz), instantAt(q.at, q.tz)];
    if (Number.isFinite(x) && Number.isFinite(y)) return p.tz === q.tz && x === y;
  }
  const keys = Object.keys(p);
  return keys.length === Object.keys(q).length && keys.every((k) => Object.hasOwn(q, k) && same(p[k], q[k]));
}

/**
 * A booking with its fields written under other names moved to the format's own (the drive-test follow-ups, section 3), so a small
 * model's first try is stored right; what it was given when nothing was. An alias beside the field it stands for is dropped when they
 * say the same, and refused, naming both, when they don't. A flight's or train's times never take the trip's only zone.
 * @param {Record<string, any>} next @param {string[]} zones the trip's time zones (trip.json) @param {unknown} [kind] the booking's
 * @returns {Record<string, any>}
 */
export function unalias(next, zones, kind = next.kind) {
  // In the table's order: a location is a place before an address joins it, a pick-up's before a drop-off is compared with it.
  const keys = [...Object.keys(ALIASES), 'flights'].filter((k) => Object.hasOwn(next, k));
  if (!keys.length) return next;
  const far = typeof kind === 'string' && FAR.includes(kind);
  const out = { ...next };
  for (const k of keys) delete out[k];
  const besideKey = ['tz', 'timezone'].find((k) => typeof out[k] === 'string');
  const beside = besideKey ? out[besideKey] : '';
  // A fields that isn't an object is left to the format check to refuse; nothing is filed over it.
  const filable = out.fields === undefined || record(out.fields) !== null;
  const fields = { ...(record(out.fields) ?? {}) };
  let filed = false;
  let fromAlias = false; // the place is one an alias made, so another alias may add to it
  /** @type {Record<string, string>} unsure's names for them, as stored */
  const stored = {};
  /** @param {string} alias @param {string} to "start", or "fields.dropoff" @param {(ownTz: unknown) => unknown} make */
  const put = (alias, to, make) => {
    const sub = to.startsWith('fields.') ? to.slice(7) : '';
    if (sub && !filable) return;
    const now = sub ? fields[sub] : out[to];
    if (now === undefined || now === null) {
      if (sub) [fields[sub], filed] = [make(undefined), true];
      else out[to] = make(undefined);
      stored[alias] = sub || to;
      if (to === 'place') fromAlias = true;
      return;
    }
    // Her own alias error first: a time that is no time is that, whatever it sits beside.
    const v = make(record(now)?.tz);
    /* en */ if (!same(now, v)) throw new Error(`${alias} and ${to} are both given and differ: keep one and remove the other (write it as null in a patch).`);
    stored[alias] = sub || to;
  };
  const title = [next.title, next.name].find((x) => typeof x === 'string' && x.trim());
  for (const k of keys) {
    const v = next[k];
    const to = ALIASES[k];
    if (v === undefined || v === null) continue; // nothing written under it
    if (k === 'flights') {
      // A flight's legs: it leaves with the first and arrives with the last, unless the booking says when; the legs are kept as written.
      const legs = Array.isArray(v) ? v.map(record) : [];
      if (legs.length && legs.every(Boolean)) {
        const [first, last] = [legs[0], legs[legs.length - 1]];
        const opt = { far: true };
        if (out.start === undefined || out.start === null) put('flights', 'start', (ownTz) => timeOf('flights[0].departure', first?.departure ?? first?.depart, first?.tz ?? beside, zones, 'start', { ...opt, ownTz }));
        if (out.end === undefined || out.end === null) put('flights', 'end', (ownTz) => timeOf(`flights[${legs.length - 1}].arrival`, last?.arrival ?? last?.arrive, last?.tz ?? beside, zones, 'end', { ...opt, ownTz }));
      }
      put('flights', 'fields.flights', () => v);
    } else if (to === 'start' || to === 'end') {
      put(k, to, (ownTz) => timeOf(k, v, beside, zones, to, { far, ownTz }));
      // A car's pick-up place is its place; a drop-off or arrival elsewhere is kept in fields, named as it was written.
      const o = record(v);
      const where = o ? o.location ?? o.place ?? o.address : undefined;
      if (typeof where === 'string' ? where.trim() : record(where)) {
        const place = typeof where === 'string' ? { name: where } : where;
        if (to === 'start') {
          put(k, 'place', () => place);
          stored[k] = 'start';
        } else if (!same(place, out.place) && !same(where, out.place?.name)) {
          put(k, `fields.${/^arriv/.test(k) ? 'arrival' : 'dropoff'}`, () => where);
          stored[k] = 'end';
        }
      }
    } else if (to === 'place') {
      // An address, or a location, beside a place with none of it is that place's: any place for an address, one an alias made for a location.
      const p = record(out.place);
      const joins = p && typeof v === 'string' && (k === 'address' || fromAlias);
      if (p && typeof v === 'string' && ((k !== 'address' && p.name === v) || (joins && p.address === v))) stored[k] = 'place'; // it says so already
      else if (joins && p.address === undefined) [out.place, stored[k]] = [{ ...p, address: v }, 'place'];
      else put(k, 'place', () => (typeof v === 'string' ? (k === 'address' ? { name: title ?? v, address: v } : { name: v }) : v));
    } else if (to === 'cost') {
      const cost = costOf(v);
      if (cost) put(k, 'cost', () => cost);
      else put(k, `fields.${k}`, () => v);
    } else put(k, to, () => v);
  }
  if (filed) out.fields = fields;
  if (besideKey) delete out[besideKey];
  // unsure names the fields as stored.
  if (Array.isArray(out.unsure)) out.unsure = [...new Set(out.unsure.map((n) => (typeof n === 'string' && Object.hasOwn(stored, n) ? stored[n] : n)))];
  return out;
}

/**
 * What to store when Shiori writes a booking: what she wrote, with other names for its fields moved to the format's own (unalias), or a
 * refusal in words. She never sets `confirmed`; a change of hers to a booking the user confirmed keeps it confirmed (with no confirming
 * step, nothing would ever clear it again). A top-level field the booking schema in force doesn't list is refused (the drive-test
 * follow-ups, section 3): nothing would read it. The schema itself stays open, so the user's own edits, Undo, Restore and imports work
 * as before; a plugin adds fields in `fields`, or as properties of a booking schema it registers.
 * @param {any} before the booking as stored, or undefined @param {any} next what she would store
 * @param {{ zones?: string[], schema?: any }} [o] the trip's time zones; the booking schema in force
 * @returns {any}
 */
export function shioriBooking(before, next, { zones = [], schema } = {}) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next; // the format check says what is wrong
  const old = before && typeof before === 'object' && !Array.isArray(before) ? before : null;
  if (next.status === 'confirmed' && old?.status !== 'confirmed') {
    /* en */ throw new Error('Only the user confirms a booking. Write it with status "unverified", and list in unsure the fields you are not sure of.');
  }
  // A new booking, and one written with unsure, always carry it (LESSONS 2026-10-27): without it, it would read as one from before.
  if (!('unsure' in next) && (!old || 'unsure' in old)) {
    /* en */ throw new Error('A new booking lists the fields you are unsure of in unsure (an empty list when you are sure of all of them), so the user sees what to check.');
  }
  const value = unalias(next, zones, next.kind ?? old?.kind);
  const own = record(record(schema)?.properties);
  const odd = own ? Object.keys(value).filter((k) => !Object.hasOwn(own, k)) : [];
  // A key already stored, unchanged (the user's raw edit, an import, a booking from before this rule), isn't hers to be refused for: it
  // moves to fields, where a screen can read it. Only a key this write brings is refused.
  const carried = odd.filter((k) => old && Object.hasOwn(old, k) && same(old[k], value[k]));
  const unknown = odd.filter((k) => !carried.includes(k));
  if (unknown.length) {
    /* en */ throw new Error(`${unknown.map((k) => JSON.stringify(k)).join(', ')} ${unknown.length === 1 ? "isn't a booking field" : "aren't booking fields"}, so nothing was written. A booking's own fields are ${Object.keys(own ?? {}).join(', ')}; put anything else in fields.`);
  }
  if (carried.length && (value.fields === undefined || record(value.fields))) {
    const fields = { ...(record(value.fields) ?? {}) };
    const moved = { ...value };
    for (const k of carried) {
      if (fields[k] === undefined) fields[k] = moved[k];
      if (same(fields[k], moved[k])) delete moved[k];
    }
    return { ...moved, fields };
  }
  return value;
}
