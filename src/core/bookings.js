import { kindOf } from './scopes.js';
import { BOOKING_FILE } from './plan.js';

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
 * What to store when Shiori writes a booking: what she wrote, or a refusal in words. She never sets `confirmed`; a change of hers to a
 * booking the user confirmed keeps it confirmed (with no confirming step, nothing would ever clear it again).
 * @param {any} before the booking as stored, or undefined @param {any} next what she would store
 * @returns {any}
 */
export function shioriBooking(before, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next; // the format check says what is wrong
  const old = before && typeof before === 'object' && !Array.isArray(before) ? before : null;
  if (next.status === 'confirmed' && old?.status !== 'confirmed') {
    /* en */ throw new Error('Only the user confirms a booking. Write it with status "unverified", and list in unsure the fields you are not sure of.');
  }
  // A new booking, and one written with unsure, always carry it (LESSONS 2026-10-27): without it, it would read as one from before.
  if (!('unsure' in next) && (!old || 'unsure' in old)) {
    /* en */ throw new Error('A new booking lists the fields you are unsure of in unsure (an empty list when you are sure of all of them), so the user sees what to check.');
  }
  return next;
}
