import { h } from './dom.js';
import { stampsOf, stampLabel, stampCount } from '../core/after/stamps.js';
import { validZone, deviceZone } from '../core/time.js';

/**
 * Station-stamp marks for visited places (spec §13, §16.2): round, vermilion, a little crooked, each
 * with the start of its place's name. A trip card shows the first two and "+N"; the label names them all.
 * @typedef {import('../core/after/stamps.js').Stamp} Stamp
 */

/** A trip's stamps, from its log: worked out each time, never stored (spec §13). @param {{ store: any, ws: any }} ctx @param {string} id @returns {Promise<Stamp[]>} */
export async function tripStamps(ctx, id) {
  const info = await ctx.ws.readJSON(id, '/trip.json').catch(() => null);
  const tz = [info?.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
  const fired = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(id, { types: ['trigger.fired'] }));
  return stampsOf(fired, tz);
}

/** @param {Stamp[]} stamps @param {{ max?: number, big?: boolean }} [o] max: how many show before "+N"; big: the trip page's and the replay's */
export function stampMarks(stamps, { max = 2, big = false } = {}) {
  if (!stamps.length) return null;
  const shown = stamps.length > max + 1 ? stamps.slice(0, max) : stamps;
  return h('span', { class: ['stamps', big ? 'big' : ''], role: 'img', 'aria-label': `${stampCount(stamps.length)}: ${stamps.map((s) => s.name).join(', ')}` },
    ...shown.map((s) => {
      const label = stampLabel(s.name);
      // A longer word gets smaller type (base.css), so it is never cut or broken across lines.
      return h('span', { class: 'stamp', style: { '--n': [...label].length }, title: s.name, text: label });
    }),
    stamps.length > shown.length ? h('span', { class: 'stamp more', text: `+${stamps.length - shown.length}` }) : null);
}
