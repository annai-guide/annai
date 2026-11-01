import { t, plural, messageOf } from './dom.js';
import { list, BOOKING_KINDS } from './format.js';
import { parseHash } from './router.js';
import { explainStorageFull } from './storage-full.js';
import { deletionOf } from '../core/trip-files.js';

/**
 * "2 bookings", "1 plan item": the parts saying what else a Delete removes along with a file; none when nothing.
 * @param {number} bookings @param {number} items @returns {string[]}
 */
export function countParts(bookings, items) {
  return [bookings ? plural(bookings, '# booking', '# bookings') : '', items ? plural(items, '# plan item', '# plan items') : ''].filter(Boolean);
}

/**
 * Where Delete goes: back, unless back is a screen of something just deleted (its route's `path` param, `/trip` stripped, is one of
 * gone: a plan item's details, this file's raw or details screen), then the trip.
 * @param {string} back @param {string[]} gone @param {string} id
 */
export function afterDelete(back, gone, id) {
  const path = parseHash(back).params.path;
  const shown = typeof path === 'string' ? path.replace(/^\/trip(?=\/)/, '') : '';
  return shown && gone.includes(shown) ? `#/trip/${encodeURIComponent(id)}` : back;
}

/**
 * Deletes what a details screen showed (the file-details design, goal 4): deletionOf(d)'s paths that are still in the trip, in one
 * ws.writeMany of null contents (author 'user', so the workspace's listeners hear of each: Shiori's short name, live mode, the offline
 * pack), history kept, then toasts what went. Returns the paths deleted. A failure is explained (explainStorageFull, else a toast of
 * messageOf(e)) and deletes nothing. @param {any} ctx @param {string} id @param {import('../core/trip-files.js').Details} d
 * @returns {Promise<string[] | null>} null when it failed
 */
export async function deleteGroup(ctx, id, d) {
  const want = deletionOf(d);
  const there = new Set((await ctx.ws.list(id, '/')).map((/** @type {{ path: string }} */ f) => f.path));
  const [file, bookings, items] = [want.file, want.bookings, want.items].map((x) => [x].flat().filter((p) => p && there.has(p)));
  const paths = /** @type {string[]} */ ([...file, ...bookings, ...items]);
  try {
    await ctx.ws.writeMany(id, paths.map((path) => ({ path, content: null })), { author: 'user' });
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.toast(messageOf(e));
    return null;
  }
  ctx.notices.toast(t`Deleted ${list([nameOf(d), ...countParts(file.length ? bookings.length : 0, items.length)])}`);
  return paths;
}

/** What the toast calls it: the file's name, else the lone booking's title, else its kind. @param {import('../core/trip-files.js').Details} d */
function nameOf(d) {
  const b = d.blocks[0]?.booking;
  return d.file?.name ?? (typeof b?.title === 'string' && b.title.trim() ? b.title : BOOKING_KINDS[b?.kind] ?? t`Booking`);
}
