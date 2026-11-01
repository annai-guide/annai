import { t, plural, messageOf } from './dom.js';
import { list, size, BOOKING_KINDS, bookingHref } from './format.js';
import { parseHash } from './router.js';
import { explainStorageFull } from './storage-full.js';
import { deletionOf, deletesOf, deletedGroup, restoreGroup } from '../core/trip-files.js';
import { BOOKING_FILE, PLAN_FILE } from '../core/plan.js';
import { forget } from '../core/forget.js';
import { inTrip, isGivenFile } from '../core/paths.js';

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
    await ctx.ws.writeMany(id, paths.map((path) => ({ path, content: null })), { author: 'user', ...(file.length ? { with: file[0], ...(d.file && d.file.name !== d.file.real ? { name: d.file.name } : {}) } : {}) });
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.toast(messageOf(e));
    return null;
  }
  const what = list([nameOf(d), ...countParts(file.length ? bookings.length : 0, items.length)]);
  // A booking with no file keeps its history (its JSON is tiny), and isn't listed under Deleted. If the page goes before the forget, the
  // file is simply kept, listed and restorable.
  const r = file.length ? await forget(ctx.store, id, { history: await ownLife(ctx.store, id, paths), mustFree: (p) => p === file[0] }).catch(() => null) : null;
  ctx.notices.toast(!r ? t`Deleted ${what}`
    : r.kept === 'here' ? t`Deleted ${what}. The conversation still has it, so it's under Deleted, where you can restore it.`
      : r.kept === 'history' ? t`Deleted ${what}. The same content is still used elsewhere in this trip, so it's under Deleted, where you can restore it.`
        : r.kept === 'elsewhere' ? t`Deleted ${what}. Another trip or file has the same content, so it's under Deleted, where you can restore it.`
          : t`Deleted ${what}. ${size(r.bytes)} freed.`);
  return paths;
}

/**
 * Which history entries this Delete dooms: for the file, all of them (mustFree guards it); for each booking or plan item, only its
 * current life, as those paths are reused by design (bookings are named by short name, calendar items by UID): the entries after its
 * newest earlier delete that went with another file or none, which a kept group's Restore still needs, and this Delete's own. An
 * earlier delete that went with this same file is no boundary: it's part of the file's history, which this Delete dooms whole (or,
 * when the file is kept, rolls back whole).
 * @param {any} store @param {string} id @param {string[]} paths what this Delete took, the file first
 * @returns {Promise<(path: string, e: import('../core/types.js').EventRecord) => boolean>}
 */
async function ownLife(store, id, paths) {
  /** @type {Map<string, number[]>} */
  const seqs = new Map();
  for (const e of await deletesOf(store, id)) {
    if (paths.includes(e.data?.path) && e.data.with !== paths[0]) seqs.set(e.data.path, [...(seqs.get(e.data.path) ?? []), e.seq]);
  }
  const earlier = (/** @type {string} */ p) => (seqs.get(p) ?? []).at(-1) ?? -Infinity;
  return (p, e) => paths.includes(p) && (isGivenFile(p) || e.seq > earlier(p));
}

/** What the toast calls it: the file's name, else the lone booking's title, else its kind. @param {import('../core/trip-files.js').Details} d */
function nameOf(d) {
  const b = d.blocks[0]?.booking;
  return d.file?.name ?? (typeof b?.title === 'string' && b.title.trim() ? b.title : BOOKING_KINDS[b?.kind] ?? t`Booking`);
}

/**
 * Restore on a deleted file's screen (Task 7): the file and what its Delete took with it (restoreGroup), a toast of what came back and
 * of what couldn't, as something new is at its path; then the file's details screen. Shiori's short name for it doesn't come back.
 * @param {any} ctx @param {string} id @param {string} path
 */
export async function restoreDeleted(ctx, id, path) {
  /** @type {{ restored: string[], taken: string[] }} */
  let r;
  try {
    r = await restoreGroup(ctx.ws, id, path);
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.toast(t`That version isn't stored on this device.`);
    return;
  }
  if (r.taken.includes(path)) {
    const name = path.split('/').pop() ?? path;
    // A stale screen (a second tab) of a file that has already come back: it's this very file, so open it, rather than say to delete it.
    const back = (await ctx.ws.read(id, path))?.entry?.hash;
    const mine = deletedGroup(await deletesOf(ctx.store, id), path)?.[0].data.old;
    if (back && back === mine) {
      ctx.notices.toast(t`${name} is already back.`);
      ctx.go(bookingHref(id, path, `#/trip/${encodeURIComponent(id)}`));
      return;
    }
    ctx.notices.toast(t`A file named ${name} is there now: rename or delete it first.`);
    return;
  }
  /** @param {string[]} paths */
  const parts = (paths) => countParts(paths.filter((p) => BOOKING_FILE.test(p)).length, paths.filter((p) => PLAN_FILE.test(p)).length);
  const what = list([path.split('/').pop() ?? path, ...parts(r.restored.filter((p) => p !== path))]);
  const left = parts(r.taken);
  ctx.notices.toast(left.length ? t`Restored ${what}. ${list(left)} didn't come back, as something new is there now.` : t`Restored ${what}`);
  ctx.go(bookingHref(id, path, `#/trip/${encodeURIComponent(id)}`));
}
