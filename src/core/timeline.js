import { dayIn, deviceZone } from './time.js';

/**
 * Where a trip stands against today, by dates only, in a zone: the one answer for home, the opening rule and live mode. A start with no end is happening on its start day only.
 * @param {{ start?: string, end?: string } | null | undefined} trip @param {number} now @param {string} [zone]
 * @returns {'undated' | 'past' | 'happening' | 'future'}
 */
export function phaseOf(trip, now, zone = deviceZone()) {
  const start = trip?.start;
  if (!start) return 'undated';
  const today = /** @type {string} */ (dayIn(now, zone));
  if (today < start) return 'future';
  return today > (trip?.end ?? start) ? 'past' : 'happening';
}
