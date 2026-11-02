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
 * The line beside Delete for good: all that the tap frees besides the file, named before the tap. Its copies (by the names `shown`
 * gives), and the bookings and plan items Shiori read from the file and from them. Null when there are none of either.
 * @param {{ paths: string[], copies: string[] }} free freeableDeleted's answer @param {(path: string) => string} shown a copy's name
 * @returns {string | null}
 */
export function forGoodLine(free, shown) {
  const group = list(countParts(free.paths.filter((p) => BOOKING_FILE.test(p)).length, free.paths.filter((p) => PLAN_FILE.test(p)).length));
  const copies = free.copies.length ? list(free.copies.map(shown)) : '';
  if (!copies) return group ? t`Also deletes the ${group} Shiori read from it.` : null;
  return group
    ? plural(free.copies.length, 'Also deletes {0}, a copy of this file, and the {1} Shiori read from them.', 'Also deletes {0}, copies of this file, and the {1} Shiori read from them.', copies, group)
    : plural(free.copies.length, 'Also deletes {0}, a copy of this file.', 'Also deletes {0}, copies of this file.', copies);
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
  const r = file.length ? await forget(ctx.store, id, { history: ownLife(await deletesOf(ctx.store, id), paths), mustFree: (p) => p === file[0], onlyDeleted: (p) => p !== file[0] }).catch(() => null) : null;
  ctx.notices.toast(!r ? t`Deleted ${what}`
    : r.kept === 'here' ? t`Deleted ${what}. The conversation still has it, so it's under Deleted, where you can restore it.`
      : r.kept === 'history' ? t`Deleted ${what}. The same content is still used elsewhere in this trip, so it's under Deleted, where you can restore it.`
        : r.kept === 'elsewhere' ? t`Deleted ${what}. Another trip or file has the same content, so it's under Deleted, where you can restore it.`
          : t`Deleted ${what}. ${size(r.bytes)} freed.`);
  return paths;
}

/**
 * Which history entries a Delete dooms: for a file the user gave, all of them (mustFree guards them); for each booking or plan item,
 * only its current life, as those paths are reused by design (bookings are named by short name, calendar items by UID): the entries
 * after its newest earlier delete that didn't go with one of these files (a kept group's Restore needs those), and this Delete's own.
 * @param {import('../core/types.js').EventRecord[]} deletes the trip's file.delete entries, as deletesOf gives them
 * @param {string[]} paths what this Delete takes, each file followed by its group
 * @param {string[]} [files] the files whose groups these are (default: the first path)
 * @returns {(path: string, e: import('../core/types.js').EventRecord) => boolean}
 */
function ownLife(deletes, paths, files = [paths[0]]) {
  const earlier = /** @type {Map<string, number>} */ (new Map());
  for (const e of deletes) if (paths.includes(e.data?.path) && !files.includes(e.data.with)) earlier.set(e.data.path, e.seq);
  return (p, e) => paths.includes(p) && (isGivenFile(p) || e.seq > (earlier.get(p) ?? -Infinity));
}

/**
 * What a deleted file is shown by: the short name its newest Delete carried, else Shiori's name for it, else its own.
 * @param {Record<string, string>} names Shiori's short names @param {import('../core/types.js').EventRecord[]} deletes the trip's file.delete entries @param {string} path
 */
export function deletedName(names, deletes, path) {
  const real = path.split('/').pop() ?? path;
  const was = deletes.filter((x) => x.data?.path === path).at(-1)?.data.name;
  return typeof was === 'string' && was !== real ? was : names[path] ?? real;
}

/**
 * The other `/files/` paths that are copies of the file: the versions they ever stored are exactly the file's. (A copy that is a file
 * now keeps them all, whole: forget's mustFree finds its content in use.) A deleted file that shares only some of its versions (a duplicate, then an updated file saved under the same name) is
 * no copy: freeing it would take part of the other's history, so forget keeps both. Which copies can really go is forget's call
 * (mustFree): a live file, the conversation or another trip naming a version keeps them all.
 * @param {import('../core/types.js').Store} store @param {string} id @param {string} path
 * @returns {Promise<string[]>}
 */
async function copiesOf(store, id, path) {
  const history = await store.tx(['events'], 'readonly', (t) => t.listEvents(id, { types: ['file.write', 'file.delete'] }));
  /** @type {Map<string, Set<string>>} */
  const named = new Map();
  for (const e of history) {
    const p = e.data?.path;
    if (typeof p !== 'string' || !isGivenFile(p)) continue;
    for (const h of [e.data.old, e.data.new]) if (typeof h === 'string') named.set(p, (named.get(p) ?? new Set()).add(h));
  }
  const mine = named.get(path);
  if (!mine) return [];
  return [...named].filter(([p, hs]) => p !== path && hs.size === mine.size && [...hs].every((h) => mine.has(h))).map(([p]) => p);
}

/**
 * What Delete for good takes from a deleted file: the file with its whole history, and the bookings and plan items its newest Delete
 * took with it (none for Shiori's delete, or one from before Delete marked its group), each only in its current life (ownLife). A
 * path that has a file again, or was deleted again on its own since, is not part of it: it is someone's now. With `copies`, the
 * other deleted copies of the same content go too, each with its own group. The match is forget's, with the files' own versions as
 * what must be freed, and the group's paths guarded (onlyDeleted) against being written again before the transaction runs.
 * @param {import('../core/workspace.js').Workspace} ws @param {string} id @param {string} path @param {string[]} [copies]
 * @returns {Promise<{ paths: string[], files: string[], there: boolean, match: import('../core/forget.js').Match }>}
 * there: the file is at its path again
 */
async function foreverOf(ws, id, path, copies = []) {
  const deletes = await deletesOf(ws.store, id);
  const there = new Set((await ws.list(id, '/')).map((f) => f.path));
  const files = [path, ...copies];
  const paths = [...new Set(files.flatMap((f) => [f, ...(deletedGroup(deletes, f) ?? []).slice(1)
    .filter((e) => !there.has(e.data.path) && deletes.filter((x) => x.data?.path === e.data.path).at(-1) === e)
    .map((e) => /** @type {string} */ (e.data.path))]))];
  return { paths, files, there: there.has(path), match: { history: ownLife(deletes, paths, files), mustFree: (p) => files.includes(p), onlyDeleted: (p) => !files.includes(p) } };
}

/**
 * Whether Delete for good would free space on a deleted file, asked by a dry run of forget (one transaction, rolled back, no blob bytes
 * read), with the file's deleted copies (copiesOf) as one forget. Null when it would free nothing: the file is back, the
 * conversation or another file or trip still names a version, or no version of it with any bytes is stored.
 * @param {import('../core/workspace.js').Workspace} ws @param {string} id @param {string} path
 * @returns {Promise<{ paths: string[], copies: string[] } | null>} the paths it would delete, and the other copies of the file among them
 */
export async function freeableDeleted(ws, id, path) {
  if (!isGivenFile(path)) return null;
  const copies = await copiesOf(ws.store, id, path);
  const plan = await foreverOf(ws, id, path, copies);
  if (plan.there) return null;
  const r = await forget(ws.store, id, { ...plan.match, dryRun: true }).catch(() => null);
  return r && r.kept === null && r.blobs ? { paths: plan.paths, copies } : null;
}

/**
 * Delete for good on a deleted file's screen: frees the file and its group (foreverOf), and any other deleted copy of the same
 * content with theirs, at once, and says how much. If the file is back (restored in another tab), nothing is freed and the toast
 * says so; if something names the content by now, nothing is freed and the toast says that; if the paths to free are no longer the
 * ones the screen named (`named`, freeableDeleted's `paths`: another copy appeared, one went, a group changed), nothing is freed
 * and the toast says that. Either way the screen is to render again. A failure is explained and frees nothing.
 * @param {any} ctx @param {string} id @param {string} path @param {string} name what the toast calls it
 * @param {string[]} [named] the paths the screen named as going; omitted by a caller that named nothing
 * @returns {Promise<string[] | null>} the paths freed, or null when nothing was
 */
export async function deleteForGood(ctx, id, path, name, named) {
  try {
    const plan = await foreverOf(ctx.ws, id, path, await copiesOf(ctx.store, id, path));
    if (plan.there) {
      ctx.notices.toast(t`${name} is already back.`);
      return null;
    }
    if (named && [...named].sort().join('\n') !== [...plan.paths].sort().join('\n')) {
      ctx.notices.toast(t`What goes with ${name} has changed, so nothing was deleted.`);
      return null;
    }
    const r = await forget(ctx.store, id, plan.match);
    if (r.kept) {
      // Restored in another tab between the reads and the forget: its own versions kept it.
      const back = (await ctx.ws.list(id, '/')).some((f) => f.path === path);
      ctx.notices.toast(back ? t`${name} is already back.` : t`${name} is still used by something else, so it stays under Deleted.`);
      return null;
    }
    const others = plan.files.length - 1;
    ctx.notices.toast(others ? t`Deleted ${name} and ${plural(others, '# other copy', '# other copies')} for good. ${size(r.bytes)} freed.` : t`Deleted ${name} for good. ${size(r.bytes)} freed.`);
    return plan.paths;
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.toast(messageOf(e));
    return null;
  }
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
    if ((await ctx.ws.read(id, path))?.entry?.hash === deletedGroup(await deletesOf(ctx.store, id), path)?.[0].data.old) {
      ctx.notices.toast(t`${name} is already back.`);
      ctx.go(bookingHref(id, path, `#/trip/${encodeURIComponent(id)}`));
      return;
    }
    ctx.notices.toast(t`A file named ${name} is there now, so this one can't come back.`);
    return;
  }
  /** @param {string[]} paths */
  const parts = (paths) => countParts(paths.filter((p) => BOOKING_FILE.test(p)).length, paths.filter((p) => PLAN_FILE.test(p)).length);
  const what = list([path.split('/').pop() ?? path, ...parts(r.restored.filter((p) => p !== path))]);
  const left = parts(r.taken);
  ctx.notices.toast(left.length ? t`Restored ${what}. ${list(left)} didn't come back, as something new is there now.` : t`Restored ${what}`);
  ctx.go(bookingHref(id, path, `#/trip/${encodeURIComponent(id)}`));
}
