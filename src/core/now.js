import { meters, travelMinutes, modeFor } from './live/geo.js';

/**
 * What the Now and Driving screens show (spec §16.2), from the Plan screen's rows: what is next,
 * and the stops ahead with how far each is from where the user is.
 * @typedef {import('./plan.js').PlanRow} PlanRow
 * @typedef {{ lat: number, lng: number }} Point
 */

const MIN = 60_000;
/** @param {any} p @returns {p is Point} */
const hasPoint = (p) => Boolean(p) && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
/** When an item is over: its end, or half an hour after its start. @param {PlanRow} r */
function over(r) {
  const start = /** @type {number} */ (r.at);
  const end = Date.parse(r.item.end?.at ?? '');
  return Number.isFinite(end) && end > start ? end : start + 30 * MIN;
}

/** The plan's next items: those not over yet, soonest first; all-day and untimed items aren't "next". @param {PlanRow[]} rows @param {number} now */
export function upcoming(rows, now, limit = 4) {
  return rows.filter((r) => r.at !== null && r.item.kind !== 'all-day' && over(r) >= now)
    .sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at))
    .slice(0, limit);
}

/**
 * The route strip (spec §16.2): the next stops with places, with the straight-line distance from
 * where the user is and about how long it takes, by the rough estimate (§11.3).
 * @param {PlanRow[]} rows @param {Point | null} here @param {number} now @param {string} activity
 * @returns {{ row: PlanRow, name: string, place: Point, km: number | null, minutes: number | null }[]}
 */
export function routeStrip(rows, here, now, activity, limit = 3) {
  return upcoming(rows.filter((r) => hasPoint(r.item.place)), now, limit).map((row) => {
    const p = row.item.place;
    const km = here ? meters(here, p) / 1000 : null;
    return { row, name: String(p.name ?? row.item.title), place: { lat: p.lat, lng: p.lng }, km, minutes: km === null ? null : travelMinutes(km, modeFor(km, activity)) };
  });
}

/** Where the sun chips are worked out (choice 6): where the user is, else the next stop with a place. @param {Point | null} here @param {PlanRow[]} rows @param {number} now */
export function sunPlace(here, rows, now) {
  if (here) return { lat: here.lat, lng: here.lng };
  return routeStrip(rows, null, now, 'unknown', 1)[0]?.place ?? null;
}
