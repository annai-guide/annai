import { dayIn, deviceZone, instantOf } from './time.js';

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

/** The days with a heading each: before them, months. */
export const RECENT_DAYS = 30;
/** A month before them with more chats than this folds them; cards never fold. */
export const FOLD_OVER = 3;
const DAY = 86_400_000;

/** The first day with a heading of its own: 30 days back, by the calendar in zone. A row before it sits under a month's. @param {number} now @param {string} zone */
export const recentFrom = (now, zone) => /** @type {string} */ (dayIn(now - RECENT_DAYS * DAY, zone));

/**
 * @typedef {{ id: string, title: string, phase: 'undated' | 'past' | 'happening' | 'future', at: number, card: boolean }} Row
 *   at: where it sits, in ms (a date sits at noon of that day in the zone, so it falls in the right day beside a chat's moments); card: dated
 * @typedef {{ heading?: { kind: 'day' | 'month', key: string }, row?: Row, fold?: { month: string, rows: Row[] } }} Entry  one of the three
 */

/** Noon of a "YYYY-MM-DD" in zone. @param {string} d @param {string} zone */
const noonOf = (d, zone) => instantOf({ year: +d.slice(0, 4), month: +d.slice(5, 7), day: +d.slice(8, 10), hour: 12 }, zone);

/**
 * The timeline: old to new, the trips happening at the now line, and only dated trips below it. Pure: what each row shows beyond this is read for cards alone.
 * @param {{ id: string, title: string, created: number, start?: string, end?: string, talked?: number | null }[]} trips @param {number} now @param {string} zone
 * @returns {{ above: Entry[], happening: Row[], below: Row[] }}
 */
export function timelineRows(trips, now, zone) {
  /** @type {Row[]} */
  const all = trips.map((s) => {
    const phase = phaseOf(s, now, zone);
    const at = phase === 'undated' ? (s.talked ?? s.created) : noonOf(/** @type {string} */ (phase === 'past' ? s.end ?? s.start : s.start), zone);
    return { id: s.id, title: s.title, phase, at, card: phase !== 'undated' };
  });
  const order = (/** @type {Row} */ a, /** @type {Row} */ b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const past = all.filter((r) => r.phase === 'past' || r.phase === 'undated').sort(order);
  const recent = recentFrom(now, zone);
  /** Its heading: the day in the last 30 days, else the month. @param {Row} r */
  const headOf = (r) => {
    const day = /** @type {string} */ (dayIn(r.at, zone));
    return day >= recent ? `day ${day}` : `month ${day.slice(0, 7)}`;
  };
  /** @type {Entry[]} */
  const above = [];
  for (let i = 0, j = 0; i < past.length; i = j) {
    const head = headOf(past[i]);
    while (j < past.length && headOf(past[j]) === head) j++;
    const [kind, key] = /** @type {['day' | 'month', string]} */ (head.split(' '));
    const group = past.slice(i, j);
    const lines = group.filter((r) => !r.card);
    const folds = kind === 'month' && lines.length > FOLD_OVER;
    if (!folds || lines.length < group.length) above.push({ heading: { kind, key } }); // a fold of chats alone names its month itself
    for (const r of group) {
      if (!folds || r.card) above.push({ row: r });
      else if (r === lines[0]) above.push({ fold: { month: key, rows: lines } });
    }
  }
  return { above, happening: all.filter((r) => r.phase === 'happening').sort(order), below: all.filter((r) => r.phase === 'future').sort(order) };
}

/**
 * Which day of a trip today is, by its dates in a zone: "Day 3 of 8". Null without both dates, or outside them.
 * @param {{ start?: string, end?: string } | null | undefined} trip @param {number} now @param {string} zone @returns {{ day: number, of: number } | null}
 */
export function dayOfTrip(trip, now, zone) {
  if (!trip?.start || !trip.end || phaseOf(trip, now, zone) !== 'happening') return null;
  const n = (/** @type {string} */ d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;
  const today = n(/** @type {string} */ (dayIn(now, zone)));
  return { day: today - n(trip.start) + 1, of: n(trip.end) - n(trip.start) + 1 };
}
