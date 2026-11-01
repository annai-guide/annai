import { t, plural, messageOf } from './dom.js';
import { list, size } from './format.js';
import { parseHash } from './router.js';
import { explainStorageFull } from './storage-full.js';
import { deletionOf } from '../core/trip-files.js';
import { forget } from '../core/forget.js';
import { readNames, NAMES_FILE } from '../core/names.js';

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
 * Deletes what a details screen showed (the file-details design, goal 4) and frees it at once (the user, 2026-11-01, "Free it at once"):
 * deletionOf(d)'s paths that are still in the trip go in one ws.writeMany of null contents (author 'user', so the live watches, the
 * backup marks and the rest hear of it), then forget() takes their history and the content nothing else names, and the file's short name
 * goes with it, names.json's history included, as dropWaiting does. Toasts what went and what was freed. Returns the paths deleted. A
 * failure is explained (explainStorageFull, else a toast of messageOf(e)).
 * @param {any} ctx @param {string} id @param {import('../core/trip-files.js').Details} d @param {string} name what the toast calls it
 * @returns {Promise<string[] | null>} null when it failed
 */
export async function deleteDetails(ctx, id, d, name) {
  const want = deletionOf(d);
  const there = new Set((await ctx.ws.list(id, '/')).map((/** @type {{ path: string }} */ f) => f.path));
  const [file, bookings, items] = [want.file, want.bookings, want.items].map((x) => [x].flat().filter((p) => p && there.has(p)));
  const paths = /** @type {string[]} */ ([...file, ...bookings, ...items]);
  let freed = 0;
  try {
    const own = String(file[0] ?? '');
    const named = Boolean(own) && Object.hasOwn(await readNames(ctx.ws, id), own);
    if (named) await ctx.ws.patch(id, NAMES_FILE, { [own]: null }, { author: 'system' });
    await ctx.ws.writeMany(id, paths.map((path) => ({ path, content: null })), { author: 'user' });
    const gone = new Set(paths);
    freed = (await forget(ctx.ws.store, id, { files: (p) => gone.has(p), history: (p) => gone.has(p) })).bytes;
    if (named) freed += (await forget(ctx.ws.store, id, { history: (p) => p === NAMES_FILE })).bytes;
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.toast(messageOf(e));
    return null;
  }
  ctx.notices.toast(t`Deleted ${list([name, ...countParts(file.length ? bookings.length : 0, items.length)])}. ${size(freed)} freed.`);
  return paths;
}
