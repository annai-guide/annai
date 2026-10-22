import { parseHash } from './router.js';
import { plainStart } from './welcome.js';
import { listTrips } from '../core/scopes.js';
import { readAppSettings } from '../core/settings.js';

/**
 * Where annai opens (the user, 2026-10-21: "the trip you had open"): a fresh start at "/" goes to the trip's screen that was
 * open, and shows Trips only when that trip is gone, archived or removed. The screen is noted as it is drawn: a screen of a trip
 * (its page, plan, files, booking, recap, replay, a plugin's tab) or the Now, Plan and Conversation tabs, which are the open
 * trip's; Trips clears it, since leaving for Trips is leaving the trip. A link, a share or a notification that points at a
 * screen is never redirected (plainStart), and the welcome comes first at the first start.
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 */
const KEY = 'annai.resume';
const OF_TRIP = new Set(['trip', 'file', 'plan', 'booking', 'recap', 'replay', 'trip-ext', 'now', 'talk']);

/** Notes the screen being shown. @param {string} hash @param {KeyValue} [storage] */
export function noteScreen(hash, storage = localStorage) {
  try {
    const route = parseHash(hash);
    if (route.name === 'trips') storage.removeItem(KEY);
    else if (OF_TRIP.has(route.name)) storage.setItem(KEY, JSON.stringify({ hash, trip: route.parts[0] === 'trip' ? route.parts[1] ?? null : null }));
  } catch { /* nothing is kept without storage: Trips opens */ }
}

/**
 * The screen to open instead of Trips, or null. @param {{ ws: any, store: any }} c @param {{ hash: string, search: string }} at @param {KeyValue} [storage]
 * @returns {Promise<string | null>}
 */
export async function screenToResume({ ws, store }, at, storage = localStorage) {
  if (!plainStart(at)) return null;
  /** @type {{ hash?: string, trip?: string | null } | null} */
  let noted = null;
  try {
    noted = JSON.parse(storage.getItem(KEY) ?? 'null');
  } catch { /* none */ }
  if (typeof noted?.hash !== 'string') return null;
  const trip = noted.trip ?? (await readAppSettings(ws)).activeTrip;
  const { active } = await listTrips(store);
  return trip && active.some((t) => t.id === trip) ? noted.hash : null;
}
