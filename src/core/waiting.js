import { SYS_WAITING } from './scopes.js';
import { forgetWith } from './forget.js';
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
 * with its history kept (spec §4.2). Both ends say it was a move (`moved` on their log entries), so Undo puts it back where it was. One
 * transaction: a move cut off never leaves the file in both places.
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
  const names = await readNames(ws, from.scope);
  const name = Object.hasOwn(names, from.path) ? names[from.path] : null;
  const waiting = from.scope === SYS_WAITING;
  const author = o.author ?? 'shiori';
  await ws.writeAcross([
    { scope: to, path, content: bytes, opts: {
      author: entry.author, type: entry.type, ...(source ? { source } : {}), ...(entry.meta ? { meta: entry.meta } : {}), ...handover,
      moved: { from: from.scope, path: from.path, ...was },
    } },
    ...(name ? [{ scope: to, path: NAMES_FILE, patch: { [path]: name }, opts: { author: 'shiori', ...handover } }] : []),
    ...(waiting ? [] : [{ scope: from.scope, path: from.path, content: null, opts: { author, ...handover, moved: { to, path, ...was } } }]),
    ...(name ? [{ scope: from.scope, path: NAMES_FILE, patch: { [from.path]: null }, opts: waiting ? { author: 'system' } : { author, ...handover } }] : []),
  ], { inTx: waiting ? (t) => forgetWaiting(t, from.path) : undefined });
  return path;
}

/**
 * Removes a waiting file for good: the file and its history, then the content nothing else names (spec §4.9); and its short name with
 * it, names.json's history included, so nothing stored keeps the dropped file's name. One transaction.
 * @param {Workspace} ws @param {string} path in the waiting space (/files/…) @returns {Promise<number>} the bytes the file's content freed
 */
export async function dropWaiting(ws, path) {
  const named = Object.hasOwn(await readNames(ws, SYS_WAITING), path);
  // inTx's value, the bytes forgetWaiting freed.
  return /** @type {number} */ (await ws.writeAcross(named ? [{ scope: SYS_WAITING, path: NAMES_FILE, patch: { [path]: null }, opts: { author: 'system' } }] : [], { inTx: (t) => forgetWaiting(t, path) }));
}

/** A waiting file and its history go, then names.json's history. @param {import('./types.js').Tx} t @param {string} path @returns {Promise<number>} bytes freed */
async function forgetWaiting(t, path) {
  const { bytes } = await forgetWith(t, SYS_WAITING, { files: (p) => p === path, history: (p) => p === path });
  await forgetWith(t, SYS_WAITING, { history: (p) => p === NAMES_FILE });
  return bytes;
}
