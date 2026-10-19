/**
 * Forgetting for good (spec §4.9; the user's rule: removing means removing). Deleting a file keeps
 * its history (§4.2), so its content stays named and stored; what annai removes for good (a plugin's
 * package, its settings, what it kept in the log) goes with the history and log entries that name
 * it, and the content nothing else names any more is freed at once.
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').EventRecord} EventRecord
 * @typedef {{ files?: (path: string) => boolean, history?: (path: string) => boolean, events?: (e: EventRecord) => boolean }} Match
 *   files: current files to delete; history: file.write and file.delete entries (by data.path) to delete; events: any other entries
 */

const HISTORY = ['file.write', 'file.delete'];

/**
 * In one transaction: deletes the scope's matching files, history entries and log entries, then
 * every content they named that no file and no log entry names any more.
 * @param {Store} store @param {string} scope @param {Match} match
 * @returns {Promise<{ files: number, events: number, bytes: number }>}
 */
export function forget(store, scope, match) {
  return store.tx(['files', 'events', 'blobs', 'scopes'], 'readwrite', async (t) => {
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
        if (typeof e.data?.path === 'string' && match.history(e.data.path)) doomed.set(e.seq, e);
      }
    }
    if (match.events) for (const e of await t.listEvents(scope)) if (match.events(e)) doomed.set(e.seq, e);
    for (const e of doomed.values()) {
      await t.deleteEvent(scope, e.seq);
      for (const h of [e.data?.old, e.data?.new, ...(e.refs ?? [])]) if (typeof h === 'string') named.add(h);
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
    return { files, events: doomed.size, bytes };
  });
}
