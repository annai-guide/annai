import { kindOf } from './scopes.js';
import { BOOKING_FILE, record } from './plan.js';
import { validZone, instantAt, isoInZone } from './time.js';

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
 * section 3), and the format's own field each stands for. flights, a flight's legs, is read apart.
 */
const ALIASES = /** @type {Record<string, string>} */ ({
  checkin: 'start', check_in: 'start', checkIn: 'start', pickup: 'start', pick_up: 'start', pickUp: 'start', depart: 'start', departure: 'start',
  checkout: 'end', check_out: 'end', checkOut: 'end', dropoff: 'end', drop_off: 'end', dropOff: 'end', return: 'end', arrive: 'end', arrival: 'end',
  name: 'title', address: 'place', location: 'place', total: 'cost', price: 'cost',
});
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * A time written under another name, as the format's { at, tz }: a string, or { at } (or { time }) with its own tz; its zone from beside
 * it, else the trip's only one. Refused in words when it is no date and time, or its zone isn't known.
 * @param {string} name what it was written as @param {unknown} v @param {string} beside the booking's own tz, if it gave one
 * @param {string[]} zones the trip's @param {string} to the field it stands for
 */
function timeOf(name, v, beside, zones, to) {
  const o = record(v);
  const raw = o ? o.at ?? o.time : v;
  const at = typeof raw === 'string' ? raw.trim().replace(' ', 'T') : '';
  const tz = [o?.tz, beside, zones.length === 1 ? zones[0] : ''].find((z) => typeof z === 'string' && z) ?? '';
  /* en */ const how = `write ${to} as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }`;
  /* en */ if (!AT.test(at)) throw new Error(`${name} ${JSON.stringify(raw ?? null)} isn't a date with a time: ${how}.`);
  /* en */ if (!validZone(tz)) throw new Error(`${name} ${JSON.stringify(raw)} has no time zone annai knows${zones.length > 1 ? ` (this trip has ${zones.join(', ')})` : ''}: ${how}.`);
  return { at: /(Z|[+-]\d{2}:\d{2})$/.test(at) ? at : isoInZone(instantAt(at, tz), tz), tz };
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

/** The same value: times at the same instant in the same zone, anything else written the same. @param {unknown} a @param {unknown} b */
function same(a, b) {
  const p = record(a);
  const q = record(b);
  if (p && q && 'at' in p && 'at' in q) return p.tz === q.tz && instantAt(p.at, p.tz) === instantAt(q.at, q.tz);
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A booking with its fields written under other names moved to the format's own (the drive-test follow-ups, section 3), so a small
 * model's first try is stored right; what it was given when nothing was. An alias beside the field it stands for is dropped when they
 * say the same, and refused, naming both, when they don't.
 * @param {Record<string, any>} next @param {string[]} zones the trip's time zones (trip.json)
 * @returns {Record<string, any>}
 */
export function unalias(next, zones) {
  // In the table's order: a car's pick-up place is known before its drop-off is compared with it.
  const keys = [...Object.keys(ALIASES), 'flights'].filter((k) => Object.hasOwn(next, k));
  if (!keys.length) return next;
  const out = { ...next };
  for (const k of keys) delete out[k];
  const besideKey = ['tz', 'timezone'].find((k) => typeof out[k] === 'string');
  const beside = besideKey ? out[besideKey] : '';
  const fields = { ...(record(out.fields) ?? {}) };
  let filed = false;
  /** @param {string} alias @param {string} to "start", or "fields.dropoff" @param {() => unknown} make */
  const put = (alias, to, make) => {
    const sub = to.startsWith('fields.') ? to.slice(7) : '';
    const now = sub ? fields[sub] : out[to];
    if (now === undefined || now === null) {
      if (sub) [fields[sub], filed] = [make(), true];
      else out[to] = make();
      return;
    }
    let v;
    try {
      v = make();
    } catch {
      v = undefined;
    }
    /* en */ if (!same(now, v)) throw new Error(`${alias} and ${to} are both given and differ: keep one and remove the other (write it as null in a patch).`);
  };
  const title = [next.title, next.name].find((x) => typeof x === 'string' && x.trim());
  for (const k of keys) {
    const v = next[k];
    const to = ALIASES[k];
    if (v === undefined || v === null) continue; // nothing written under it
    if (k === 'flights') {
      // A flight's legs: it leaves with the first and arrives with the last; the legs are kept as written.
      const legs = Array.isArray(v) ? v.map(record) : [];
      if (legs.length && legs.every(Boolean)) {
        const [first, last] = [legs[0], legs[legs.length - 1]];
        put('flights', 'start', () => timeOf('flights[0].departure', first?.departure ?? first?.depart, first?.tz ?? beside, zones, 'start'));
        put('flights', 'end', () => timeOf(`flights[${legs.length - 1}].arrival`, last?.arrival ?? last?.arrive, last?.tz ?? beside, zones, 'end'));
      }
      put('flights', 'fields.flights', () => v);
    } else if (to === 'start' || to === 'end') {
      put(k, to, () => timeOf(k, v, beside, zones, to));
      // A car's pick-up place is its place; a drop-off elsewhere is kept in fields.
      const o = record(v);
      const where = o ? o.location ?? o.place ?? o.address : undefined;
      if (typeof where === 'string' ? where.trim() : record(where)) {
        const place = typeof where === 'string' ? { name: where } : where;
        if (to === 'start') put(k, 'place', () => place);
        else if (!same(place, out.place) && !same(where, out.place?.name)) put(k, 'fields.dropoff', () => where);
      }
    } else if (to === 'place') {
      // An address beside a place with none (a location, a pick-up's) is that place's address.
      const p = record(out.place);
      if (k === 'address' && typeof v === 'string' && p && p.address === undefined) out.place = { ...p, address: v };
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
  if (Array.isArray(out.unsure)) out.unsure = [...new Set(out.unsure.map((n) => (keys.includes(n) && ALIASES[n]) || n))];
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
  const value = unalias(next, zones);
  const own = record(record(schema)?.properties);
  const unknown = own ? Object.keys(value).filter((k) => !Object.hasOwn(own, k)) : [];
  if (unknown.length) {
    /* en */ throw new Error(`${unknown.map((k) => JSON.stringify(k)).join(', ')} ${unknown.length === 1 ? "isn't a booking field" : "aren't booking fields"}, so nothing was written. A booking's own fields are ${Object.keys(own ?? {}).join(', ')}; put anything else in fields.`);
  }
  return value;
}
