import { t, plural, messageOf } from './dom.js';
import { list, size, BOOKING_KINDS } from './format.js';
import { parseHash } from './router.js';
import { explainStorageFull } from './storage-full.js';
import { deletionOf } from '../core/trip-files.js';
import { forget } from '../core/forget.js';
import { inTrip } from '../core/paths.js';

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
  const shown = inTrip(parseHash(back).params.path);
  return shown && gone.includes(shown) ? `#/trip/${encodeURIComponent(id)}` : back;
}

/**
 * Deletes what a details screen showed (the file-details design, goal 4): deletionOf(d)'s paths that are still in the trip, in one
 * ws.writeMany of null contents (author 'user', so the workspace's listeners hear of each: Shiori's short name, live mode, the offline
 * pack), each marked with the file it went with. Then, for a file the user gave, it frees the group (its history and the content nothing
 * else names) when nothing else names the file's own versions; else the file is kept, history and all, and listed under Deleted (Task 7:
 * "if we are not freeing bytes anyway, I would prefer we can see / recover them"). The toast says what went, and how much was freed or
 * why it was kept. Returns the paths deleted. A failure is explained (explainStorageFull, else a toast of messageOf(e)) and deletes
 * nothing. @param {any} ctx @param {string} id @param {import('../core/trip-files.js').Details} d
 * @returns {Promise<string[] | null>} null when it failed
 */
export async function deleteGroup(ctx, id, d) {
  const want = deletionOf(d);
  const there = new Set((await ctx.ws.list(id, '/')).map((/** @type {{ path: string }} */ f) => f.path));
  const [file, bookings, items] = [want.file, want.bookings, want.items].map((x) => [x].flat().filter((p) => p && there.has(p)));
  const paths = /** @type {string[]} */ ([...file, ...bookings, ...items]);
  try {
    await ctx.ws.writeMany(id, paths.map((path) => ({ path, content: null })), { author: 'user', ...(file.length ? { with: file[0] } : {}) });
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.toast(messageOf(e));
    return null;
  }
  const what = list([nameOf(d), ...countParts(file.length ? bookings.length : 0, items.length)]);
  // A booking with no file keeps its history (its JSON is tiny), and isn't listed under Deleted. If the page goes before the forget, the
  // file is simply kept, listed and restorable.
  const r = file.length ? await forget(ctx.store, id, { history: (p) => paths.includes(p), mustFree: (p) => p === file[0] }).catch(() => null) : null;
  ctx.notices.toast(!r ? t`Deleted ${what}`
    : r.kept === 'here' ? t`Deleted ${what}. The conversation still has it, so it's under Deleted, where you can restore it.`
      : r.kept === 'elsewhere' ? t`Deleted ${what}. Another trip or file has the same content, so it's under Deleted, where you can restore it.`
        : t`Deleted ${what}. ${size(r.bytes)} freed.`);
  return paths;
}

/** What the toast calls it: the file's name, else the lone booking's title, else its kind. @param {import('../core/trip-files.js').Details} d */
function nameOf(d) {
  const b = d.blocks[0]?.booking;
  return d.file?.name ?? (typeof b?.title === 'string' && b.title.trim() ? b.title : BOOKING_KINDS[b?.kind] ?? t`Booking`);
}
