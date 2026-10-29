import { SYS_WAITING, freeUnused } from './scopes.js';
import { NotFoundError } from './workspace.js';
import { normPath, freeName } from './paths.js';
import { NAMES_FILE, readNames } from './names.js';

/**
 * The waiting space (the bookings-and-trips design, my call 3): what the user hands Shiori while no trip is open waits here, in
 * a space of its own, so no trip sees it, until she files it into a trip, which gives its space back here.
 * @typedef {import('./workspace.js').Workspace} Workspace @typedef {import('./types.js').FileEntry} FileEntry
 */

/** The files waiting with Shiori. @param {Workspace} ws @returns {Promise<FileEntry[]>} */
export const waitingFiles = (ws) => ws.list(SYS_WAITING, '/files/');

/**
 * Moves a file into a trip's Files, under a name no file there has, keeping its type, details, source and author, with
 * its short name. From the waiting space, the file and its history go (its space comes back); from a trip, it is deleted
 * there with its history kept (spec §4.2).
 * @param {Workspace} ws @param {{ scope: string, path: string }} from @param {string} to the trip
 * @param {{ handover?: string, author?: string }} [o] handover: the hand-over it was moved for, on what it writes;
 *   author: who deletes it from a trip (Shiori, unless the user moved it)
 * @returns {Promise<string>} its path in the trip
 */
export async function moveFile(ws, from, to, o = {}) {
  const got = await ws.read(from.scope, from.path);
  if (!got) throw new NotFoundError(from.path);
  const { entry, bytes } = got;
  const taken = new Set((await ws.list(to, '/files/')).map((f) => f.path));
  const path = freeName(normPath(`/files/${from.path.split('/').pop()}`), taken);
  const handover = o.handover ? { handover: o.handover } : {};
  await ws.write(to, path, bytes, {
    author: entry.author, type: entry.type, ...(entry.source ? { source: entry.source } : {}), ...(entry.meta ? { meta: entry.meta } : {}), ...handover,
  });
  const names = await readNames(ws, from.scope);
  const name = Object.hasOwn(names, from.path) ? names[from.path] : null;
  if (name) await ws.patch(to, NAMES_FILE, { [path]: name }, { author: 'shiori', create: true, ...handover });
  if (from.scope === SYS_WAITING) await dropWaiting(ws, from.path);
  else {
    const author = o.author ?? 'shiori';
    await ws.delete(from.scope, from.path, { author, ...handover });
    if (name) await ws.patch(from.scope, NAMES_FILE, { [from.path]: null }, { author, ...handover });
  }
  return path;
}

/**
 * Removes a waiting file for good: the file and its history, and its short name, then the content nothing else names (spec §4.9).
 * names.json's older versions stay in its history, as any file's do.
 * @param {Workspace} ws @param {string} path in the waiting space (/files/…) @returns {Promise<number>} the bytes freed
 */
export async function dropWaiting(ws, path) {
  if (Object.hasOwn(await readNames(ws, SYS_WAITING), path)) await ws.patch(SYS_WAITING, NAMES_FILE, { [path]: null }, { author: 'user' });
  return ws.store.tx(['files', 'events', 'blobs'], 'readwrite', async (t) => {
    /** @type {Set<string>} */
    const named = new Set();
    const file = await t.getFile(SYS_WAITING, path);
    if (file) {
      named.add(file.hash);
      await t.deleteFile(SYS_WAITING, path);
    }
    for (const e of await t.listEvents(SYS_WAITING, { types: ['file.write', 'file.delete'] })) {
      if (e.data?.path !== path) continue;
      for (const h of [e.data.old, e.data.new]) if (typeof h === 'string') named.add(h);
      await t.deleteEvent(SYS_WAITING, e.seq);
    }
    return freeUnused(t, named);
  });
}
