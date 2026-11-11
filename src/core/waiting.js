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
 * transaction: a move cut off never leaves the file in both places, nor a calendar without its plan items (along).
 * @param {Workspace} ws @param {{ scope: string, path: string }} from @param {string} to the trip
 * @param {{ handover?: string, author?: string, folder?: string, source?: string, undo?: string, along?: string[] }} [o] handover: the hand-over it was
 *   moved for, on what it writes; author: who deletes it from a trip (Shiori, unless the user moved it); folder: where it goes, /files/ unless said;
 *   source: the file it now comes from (a calendar's plan item, moved back on its own by Undo); undo: an Undo's move back, for that hand-over;
 *   along: files of the same trip that go with it, each into its own folder there, naming it where it went as their source (a calendar's plan items)
 * @returns {Promise<string>} its path in the trip
 */
export async function moveFile(ws, from, to, o = {}) {
  const handover = { ...(o.handover ? { handover: o.handover } : {}), ...(o.undo ? { undo: o.undo } : {}) };
  const names = await readNames(ws, from.scope);
  const waiting = from.scope === SYS_WAITING;
  const author = o.author ?? 'shiori';
  /** The paths in a folder of the trip, with those this move takes. @type {Map<string, Set<string>>} */
  const taken = new Map();
  /** @type {Parameters<Workspace['writeAcross']>[0]} */
  const writes = [];
  /** @type {Parameters<Workspace['writeAcross']>[0]} */
  const deletes = [];
  /** @type {Record<string, string>} */
  const named = {};
  /** @type {Record<string, null>} */
  const unnamed = {};
  /** One file: written in the trip under a free name, gone where it was. @param {string} path @param {string} folder @param {string} [source] */
  const one = async (path, folder, source) => {
    const got = await ws.read(from.scope, path);
    if (!got) throw new NotFoundError(path);
    const { entry, bytes } = got;
    const free = taken.get(folder) ?? new Set((await ws.list(to, folder)).map((f) => f.path));
    taken.set(folder, free);
    const there = freeName(normPath(`${folder}${path.split('/').pop()}`), free);
    free.add(there);
    const was = source && entry.source !== source && entry.source ? { source: entry.source } : {};
    const now = source ?? entry.source;
    writes.push({ scope: to, path: there, content: bytes, opts: {
      author: entry.author, type: entry.type, ...(now ? { source: now } : {}), ...(entry.meta ? { meta: entry.meta } : {}), ...handover,
      moved: { from: from.scope, path, ...was },
    } });
    if (!waiting) deletes.push({ scope: from.scope, path, content: null, opts: { author, ...handover, moved: { to, path: there, ...was } } });
    if (Object.hasOwn(names, path) && names[path]) {
      named[there] = names[path];
      unnamed[path] = null;
    }
    return there;
  };
  const path = await one(from.path, o.folder ?? '/files/', o.source);
  for (const p of o.along ?? []) await one(p, p.slice(0, p.lastIndexOf('/') + 1), path);
  const short = Object.keys(named).length > 0;
  await ws.writeAcross([
    ...writes,
    ...(short ? [{ scope: to, path: NAMES_FILE, patch: named, opts: { author: 'shiori', ...handover } }] : []),
    ...deletes,
    ...(short ? [{ scope: from.scope, path: NAMES_FILE, patch: unnamed, opts: waiting ? { author: 'system' } : { author, ...handover } }] : []),
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
