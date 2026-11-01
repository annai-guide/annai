/**
 * Forgetting for good (spec §4.9; the user's rule: removing means removing). Deleting a file keeps
 * its history (§4.2), so its content stays named and stored; what annai removes for good (a plugin's
 * package, its settings, what it kept in the log) goes with the history and log entries that name
 * it, and the content nothing else names any more is freed at once.
 * A forget that removes anything leaves one `forget` entry, numbered after every entry the scope had: the last number never falls, so
 * the next entry never takes a removed one's number, and a backup made before the forget reads the scope as changed (scopes.js
 * backupState, backup-auto.js changedSince). Only the newest such entry is kept, so a file kept without history doesn't grow the log.
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').EventRecord} EventRecord
 * @typedef {{ files?: (path: string) => boolean, history?: (path: string, e: EventRecord) => boolean, events?: (e: EventRecord) => boolean,
 *   mustFree?: (path: string) => boolean }} Match
 *   files: current files to delete; history: file.write and file.delete entries (by data.path, and the entry itself) to delete; events: any other entries;
 *   mustFree: paths whose every version (as the history entries deleted name them) must be freed, or nothing is forgotten at all
 *   (Delete in Files: a file the conversation still names is kept whole, history and all)
 * @typedef {{ files: number, events: number, bytes: number, kept: null | 'here' | 'elsewhere' }} Forgot
 *   kept: null when it forgot; else why nothing was: a mustFree version is still named in this scope's log ('here'), or by a file or
 *   another scope ('elsewhere')
 */

const HISTORY = ['file.write', 'file.delete'];

/** Thrown inside the transaction to roll it back when a mustFree version is still named. */
class Kept {
  /** @param {'here' | 'elsewhere'} where */
  constructor(where) { this.where = where; }
}

/**
 * In one transaction: deletes the scope's matching files, history entries and log entries, then
 * every content they named that no file and no log entry names any more.
 * @param {Store} store @param {string} scope @param {Match} match
 * @returns {Promise<Forgot>}
 */
export async function forget(store, scope, match) {
  try {
    return await forgetIn(store, scope, match);
  } catch (e) {
    if (e instanceof Kept) return { files: 0, events: 0, bytes: 0, kept: e.where };
    throw e;
  }
}

/** @param {Store} store @param {string} scope @param {Match} match @returns {Promise<Forgot>} */
function forgetIn(store, scope, match) {
  return store.tx(['files', 'events', 'blobs', 'scopes'], 'readwrite', async (t) => {
    const top = await t.lastSeq(scope);
    /** @type {Set<string>} */
    const named = new Set();
    let files = 0;
    if (match.files) {
      for (const f of await t.listFiles(scope)) {
        if (!match.files(f.path)) continue;
        await t.deleteFile(scope, f.path);
        named.add(f.hash);
        files++;
      }
    }
    /** @type {Map<number, EventRecord>} */
    const doomed = new Map();
    if (match.history) {
      for (const e of await t.listEvents(scope, { types: HISTORY })) {
        if (typeof e.data?.path === 'string' && match.history(e.data.path, e)) doomed.set(e.seq, e);
      }
    }
    if (match.events) for (const e of await t.listEvents(scope)) if (match.events(e)) doomed.set(e.seq, e);
    for (const e of doomed.values()) {
      await t.deleteEvent(scope, e.seq);
      for (const h of [e.data?.old, e.data?.new, ...(e.refs ?? [])]) if (typeof h === 'string') named.add(h);
    }
    if (match.mustFree) {
      for (const e of doomed.values()) {
        if (typeof e.data?.path !== 'string' || !match.mustFree(e.data.path)) continue;
        for (const h of [e.data.old, e.data.new]) {
          if (typeof h !== 'string' || !(await t.blobInUse(h))) continue;
          throw new Kept((await t.blobInUse(h, { exceptScope: scope })) ? 'elsewhere' : 'here'); // rolls the transaction back
        }
      }
    }
    let bytes = 0;
    // Each content freed is read for its size alone: never a list of every blob, which a push sync would pay each time.
    for (const h of named) {
      if (await t.blobInUse(h)) continue;
      const b = await t.getBlob(h);
      if (!b) continue;
      await t.deleteBlob(h);
      bytes += Number(b.size) || 0;
    }
    if (files || doomed.size) {
      for (const e of await t.listEvents(scope, { types: ['forget'] })) if (!doomed.has(e.seq)) await t.deleteEvent(scope, e.seq);
      const now = Date.now();
      await t.putEvent({ scope, seq: top + 1, ts: now, at: now, type: 'forget', actor: 'system', data: { files, events: doomed.size, bytes } });
    }
    return { files, events: doomed.size, bytes, kept: null };
  });
}
