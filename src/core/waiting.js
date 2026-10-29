import { SYS_WAITING } from './scopes.js';
import { forget } from './forget.js';
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
 * Moves a file into a trip's Files (or another folder), under a name no file there has, keeping its type, details, source and author,
 * with its short name. From the waiting space, the file and its history go (its space comes back); from a trip, it is deleted there
 * with its history kept (spec §4.2). Both ends say it was a move (`moved` on their log entries), so Undo puts it back where it was.
 * @param {Workspace} ws @param {{ scope: string, path: string }} from @param {string} to the trip
 * @param {{ handover?: string, author?: string, folder?: string, source?: string, undo?: string }} [o] handover: the hand-over it was moved for, on what it
 *   writes; author: who deletes it from a trip (Shiori, unless the user moved it); folder: where it goes, /files/ unless said;
 *   source: the file it now comes from (a calendar's plan item, moved with its calendar); undo: an Undo's move back, for that hand-over
 * @returns {Promise<string>} its path in the trip
 */
export async function moveFile(ws, from, to, o = {}) {
  const got = await ws.read(from.scope, from.path);
  if (!got) throw new NotFoundError(from.path);
  const { entry, bytes } = got;
  const folder = o.folder ?? '/files/';
  const taken = new Set((await ws.list(to, folder)).map((f) => f.path));
  const path = freeName(normPath(`${folder}${from.path.split('/').pop()}`), taken);
  const handover = { ...(o.handover ? { handover: o.handover } : {}), ...(o.undo ? { undo: o.undo } : {}) };
  const source = o.source ?? entry.source;
  const was = o.source && entry.source !== o.source && entry.source ? { source: entry.source } : {};
  await ws.write(to, path, bytes, {
    author: entry.author, type: entry.type, ...(source ? { source } : {}), ...(entry.meta ? { meta: entry.meta } : {}), ...handover,
    moved: { from: from.scope, path: from.path, ...was },
  });
  const names = await readNames(ws, from.scope);
  const name = Object.hasOwn(names, from.path) ? names[from.path] : null;
  if (name) await ws.patch(to, NAMES_FILE, { [path]: name }, { author: 'shiori', create: true, ...handover });
  if (from.scope === SYS_WAITING) await dropWaiting(ws, from.path);
  else {
    const author = o.author ?? 'shiori';
    await ws.delete(from.scope, from.path, { author, ...handover, moved: { to, path, ...was } });
    if (name && Object.hasOwn(await readNames(ws, from.scope), from.path)) await ws.patch(from.scope, NAMES_FILE, { [from.path]: null }, { author, ...handover });
  }
  return path;
}

/**
 * Removes a waiting file for good: the file and its history, then the content nothing else names (spec §4.9); and its short name with
 * it, names.json's history included (the coordinator, 2026-10-29), so nothing stored keeps the dropped file's name.
 * @param {Workspace} ws @param {string} path in the waiting space (/files/…) @returns {Promise<number>} the bytes the file's content freed
 */
export async function dropWaiting(ws, path) {
  if (Object.hasOwn(await readNames(ws, SYS_WAITING), path)) await ws.patch(SYS_WAITING, NAMES_FILE, { [path]: null }, { author: 'system' });
  const { bytes } = await forget(ws.store, SYS_WAITING, { files: (p) => p === path, history: (p) => p === path });
  await forget(ws.store, SYS_WAITING, { history: (p) => p === NAMES_FILE });
  return bytes;
}
