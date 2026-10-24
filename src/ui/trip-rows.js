import { planRows, PLAN_FILE, BOOKING_FILE } from '../core/plan.js';
import { validZone, deviceZone } from '../core/time.js';

/**
 * A trip's plan as the Plan screen's rows, for Now and Driving: its scope record, trip.json, the zone
 * for a time whose own zone annai doesn't know, and the rows. A file that can't be read is left out.
 * @param {any} ctx @param {string} id
 */
export async function tripRows(ctx, id) {
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  const trip = (await ctx.ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
  const tz = [trip.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  /** @param {string} prefix @param {RegExp} shape */
  const read = async (prefix, shape) => {
    /** @type {{ path: string, value: any }[]} */
    const out = [];
    for (const f of await ctx.ws.list(id, prefix)) {
      if (!shape.test(f.path)) continue;
      const value = await ctx.ws.readJSON(id, f.path).catch(() => null);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push({ path: f.path, value });
    }
    return out;
  };
  const items = (await read('/plan/', PLAN_FILE)).map((x) => ({ path: x.path, item: x.value }));
  const bookings = (await read('/bookings/', BOOKING_FILE)).map((x) => ({ path: x.path, booking: x.value }));
  return { scope, trip, tz, rows: planRows(items, bookings, { fallbackTz: tz }) };
}
