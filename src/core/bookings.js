import { kindOf } from './scopes.js';
import { BOOKING_FILE } from './plan.js';

/**
 * Shiori's writes to bookings (spec §4.4: "New records must be unverified"; §7.3: the plan shows
 * unconfirmed bookings as "Check this"). Only the user confirms a booking, and a change she makes
 * to a confirmed one sends it back to the user to check.
 */

/** A trip's booking record. @param {string} scope @param {string} path */
export function isBookingPath(scope, path) {
  return kindOf(scope) === 'trip' && BOOKING_FILE.test(path);
}

/** JSON with sorted keys, so records compare by what they hold. @param {any} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * What to store when Shiori writes a booking, and what to tell her.
 * @param {any} before the booking as stored, or undefined @param {any} next what she would store
 * @returns {{ value: any, note: string }}
 */
export function shioriBooking(before, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return { value: next, note: '' }; // the format check says what is wrong
  const was = before && typeof before === 'object' ? before.status : undefined;
  if (next.status === 'confirmed' && was !== 'confirmed') {
    /* en */ throw new Error('Only the user confirms a booking. Write it with status "unverified"; the plan shows it as "Check this" until they confirm it.');
  }
  if (was === 'confirmed' && canonical({ ...before, status: null }) !== canonical({ ...next, status: null })) {
    /* en */ return { value: { ...next, status: 'unverified' }, note: ' The user had confirmed it; after your change it is unverified again, so they check it.' };
  }
  return { value: next, note: '' };
}
