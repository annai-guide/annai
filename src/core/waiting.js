import { SYS_WAITING, createTrip } from './scopes.js';
import { forgetWith } from './forget.js';
import { NotFoundError } from './workspace.js';
import { normPath, freeName } from './paths.js';
import { NAMES_FILE, readNames } from './names.js';
import { FILE_BOOKING } from './bookings.js';
import { tc } from './l10n.js';

/**
 * The waiting space (the bookings-and-trips design, my call 3): what the user hands Shiori while no trip is open waits here, in
 * a space of its own, so no trip sees it, until she files it into a trip, which gives its space back here.
 * @typedef {import('./workspace.js').Workspace} Workspace @typedef {import('./types.js').FileEntry} FileEntry
 */

/** The files waiting with Shiori. @param {Workspace} ws @returns {Promise<FileEntry[]>} */
export const waitingFiles = (ws) => ws.list(SYS_WAITING, '/files/');

/** How she files what was handed to her in a chat or trip: what belongs to another trip she moves there, the rest she files here. */
/* en */
export const FILE_HERE = `First look in list_trips: one that belongs to another of their trips you move_file there, and say so; the rest you file here. ${FILE_BOOKING} A photo that isn't a booking stays among the trip's photos.`;
/** What she is told in the conversation the waiting files move into, before they move: it names no file, so a run cut off never names one that isn't there. */
/* en */
const MOVED_HERE = `While no trip was open, the user handed you files, and they waited with you. annai has moved them into this conversation's /trip/files/, with any short names you gave them. Read each one. ${FILE_HERE} If this conversation becomes a trip, patch /trip/trip.json with its title and dates. Then say what you did.`;

/**
 * The files waiting with Shiori go into a conversation of their own, "Waiting with Shiori" (timeline stage 7: no screen shows the waiting space any more,
 * and nothing new waits there). With none, nothing is made. The chat is annai's (system), so her snapshot reads its name as a guess she may improve. Its
 * wake comes first and names no file, so a run cut off never leaves files she isn't told of; then each file moves with its short name, a transaction each.
 * The chat isn't open, so no turn starts before the moves end. Each run makes its own chat: a cut run's rest goes to a new one at the next run (the user,
 * 2026-11-14, "A new chat each run (Recommended)"). No setting is stored. Run at start, after an import and after an Undo that sends files back here.
 * @param {Workspace} ws @param {(w: { kind: 'file', scope: string, text: string }) => Promise<unknown>} wake Shiori's, which writes it into a conversation that isn't open
 * @returns {Promise<string | null>} the chat, or null when nothing waited
 */
export async function moveWaitingToChat(ws, wake) {
  const files = await waitingFiles(ws);
  if (!files.length) return null;
  const id = await createTrip(ws, { title: tc("a conversation's name")`Waiting with Shiori` }, { author: 'system' });
  await wake({ kind: 'file', scope: id, text: MOVED_HERE });
  for (const f of files) await moveFile(ws, { scope: SYS_WAITING, path: f.path }, id, { author: 'system' });
  return id;
}

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
