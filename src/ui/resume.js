import { plainStart } from './welcome.js';
import { talkHref } from './format.js';
import { readAppSettings } from '../core/settings.js';
import { phaseOf } from '../core/timeline.js';
import { deviceZone } from '../core/time.js';

/** The timeline design's opening rule: "used" for the 12 hours means the last user line (its Calls), and the user's pick was "Last chat if recent, else timeline". */
const RECENT_MS = 12 * 3_600_000;

/**
 * Where a plain start opens: the conversation that was open (activeTrip), when the user talked in it under 12 hours ago or its trip is happening; else home
 * (null). Only an active trip or chat counts, never the standing draft. A link, a share or a notification that points at a screen is never redirected
 * (plainStart), and the welcome comes first at the first start (main.js asks shouldWelcome before this).
 * @param {{ ws: any, store: any }} c @param {{ hash: string, search: string }} at @param {{ now?: number, zone?: string }} [o]
 * @returns {Promise<string | null>}
 */
export async function screenToResume({ ws, store }, at, { now = Date.now(), zone = deviceZone() } = {}) {
  if (!plainStart(at)) return null;
  const id = (await readAppSettings(ws)).activeTrip;
  const rec = id ? await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id)) : null;
  if (rec?.kind !== 'trip' || rec.draft || rec.status !== 'active') return null;
  const recent = typeof rec.talked === 'number' && now - rec.talked < RECENT_MS;
  return recent || phaseOf(rec, now, zone) === 'happening' ? talkHref(rec.id) : null;
}
