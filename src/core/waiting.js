import { SYS_WAITING, createTrip } from './scopes.js';
import { forgetWith } from './forget.js';
import { NotFoundError } from './workspace.js';
import { normPath, freeName } from './paths.js';
import { NAMES_FILE, readNames } from './names.js';
import { FILE_BOOKING } from './bookings.js';
import { tc } from './l10n.js';

/**
 * The waiting space (the bookings-and-trips design, my call 3): once where what the user handed Shiori while no trip was open waited, in a space of its own,
 * so no trip saw it. Nothing handed goes there now (the draft conversation is open when nothing else is). Only an Undo whose files have no trip to go back
 * to, and an old backup's waiting files on import, fill it; an older annai's are in it at the first start. `moveWaitingToChat` empties it, into a chat.
 * @typedef {import('./workspace.js').Workspace} Workspace @typedef {import('./types.js').FileEntry} FileEntry
 */

/** The files waiting with Shiori. @param {Workspace} ws @returns {Promise<FileEntry[]>} */
export const waitingFiles = (ws) => ws.list(SYS_WAITING, '/files/');

/** How she files what was handed to her in a chat or trip: what belongs to another trip she moves there, the rest she files here. */
/* en */
export const FILE_HERE = `First look in list_trips: one that belongs to another of their trips you move_file there, and say so; the rest you file here. ${FILE_BOOKING} A photo that isn't a booking stays among the trip's photos.`;
/** How she treats a pasted text she files (handOverText says it of a hand-over, the waiting chat's wake of what she files for the user). */
/* en */
export const PASTED_TEXT = "A pasted text (pasted-….txt) that isn't a booking: delete it, so it isn't kept. One that is stays with its booking.";
/**
 * What she is told in the conversation the waiting files moved into. One text, true of every source (an older annai's waiting files, an old backup's, an
 * Undo's files with no trip to go back to): she says what is there and asks the user what to do, and files nothing until they say (the user, 2026-11-14,
 * "Ask you first": "Nothing gets filed without your word, so an Undo stays undone"). It describes what to say and quotes none of it, for she repeats words she is given.
 */
/* en */
const MOVED_HERE = `annai has moved files that were waiting with you into this conversation's /trip/files/, with any short names you gave them: ones kept for you before (by an older annai, or in an old backup), or ones an Undo took back out of a trip. The user has not just handed them to you and has asked for nothing yet. Read each one, then tell the user what is there, a line for each, and ask what they want done with them, in their language as the Languages section says. Until they answer, file nothing: don't move, rename or delete a file, and write no booking or plan item. When they tell you what to do, do it the way you file a hand-over: ${FILE_HERE} ${PASTED_TEXT} A calendar file's events go on the plan only if they ask for that. Then say what you did.`;

/**
 * The files waiting with Shiori go into a conversation of their own, "Waiting with Shiori" (timeline stage 7: no screen shows the waiting space any more,
 * and nothing new waits there). With none, nothing is made. The chat is annai's (system), so her snapshot reads its name as a guess she may improve. Each
 * file moves with its short name, a transaction each, and her wake comes after them: it says files are there, so a run cut off before it never leaves a chat
 * whose wake is untrue. A cut run leaves files in a chat with no wake (the user finds them in its Details) and the rest for a new chat at the next run (the
 * user, 2026-11-14, "A new chat each run (Recommended)"). The chat isn't open, so no turn starts before the moves end. No setting is stored. Run at start, after
 * an import and after an Undo that sends files back here.
 * @param {Workspace} ws @param {(w: { kind: 'file', scope: string, text: string }) => Promise<unknown>} wake Shiori's, which writes it into a conversation that isn't open
 * @returns {Promise<string | null>} the chat, or null when nothing waited
 */
export async function moveWaitingToChat(ws, wake) {
  const files = await waitingFiles(ws);
  if (!files.length) return null;
  const id = await createTrip(ws, { title: tc("a conversation's name")`Waiting with Shiori` }, { author: 'system' });
  for (const f of files) await moveFile(ws, { scope: SYS_WAITING, path: f.path }, id, { author: 'system' });
  await wake({ kind: 'file', scope: id, text: MOVED_HERE });
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

/** A waiting file and its history go, then names.json's history. @param {import('./types.js').Tx} t @param {string} path @returns {Promise<number>} bytes freed */
async function forgetWaiting(t, path) {
  const { bytes } = await forgetWith(t, SYS_WAITING, { files: (p) => p === path, history: (p) => p === path });
  await forgetWith(t, SYS_WAITING, { history: (p) => p === NAMES_FILE });
  return bytes;
}
