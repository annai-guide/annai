import { ME, kindOf } from './scopes.js';
import { blobsOf, isName } from './events.js';

/**
 * Reading stored content by its hash for one scope (spec §4.1). Content is stored once for every trip, so a hash alone
 * would read any trip's. A scope reaches a hash that one of its files or log entries names (refs, data.old, data.new),
 * or, from a trip, one of the user's own files; anything else reads as not stored, and a refused read of content the
 * device holds is logged once in the scope (`content.refused`: what asked and the start of the hash, never the bytes).
 * Names written without the bytes are held to the same rule (log.js, workspace.js, archive.js).
 * @typedef {import('./types.js').Store} Store @typedef {import('./types.js').BlobRecord} BlobRecord
 */

/**
 * Whether a scope reaches a hash, in a transaction over files and events. @param {import('./types.js').Tx} t @param {string} scope @param {unknown} hash
 * @param {{ me?: boolean }} [o] me false: the scope's own names alone, not the user's own files beside a trip's (a restored version)
 */
export async function reachable(t, scope, hash, { me = true } = {}) {
  if (!isName(hash)) return false;
  const h = /** @type {string} */ (hash);
  return (await t.blobNamedIn(h, scope)) || (me && kindOf(scope) === 'trip' && t.blobNamedIn(h, ME, { events: false }));
}

/**
 * Looks a hash up for a scope; refusals are logged. @param {Store} store @param {string} scope @param {unknown} hash
 * @param {{ named?: { scope: string, data?: any, refs?: string[] }, via?: string, quiet?: boolean }} o @param {boolean} bytes
 */
async function look(store, scope, hash, o, bytes) {
  if (!isName(hash)) return undefined;
  const h = /** @type {string} */ (hash);
  const own = o.named?.scope === scope && blobsOf(o.named).includes(h);
  const got = await store.tx(own ? ['blobs'] : ['files', 'events', 'blobs'], 'readonly', async (t) => (own || (await reachable(t, scope, h))
    ? { found: bytes ? await t.getBlob(h) : await t.hasBlob(h) }
    : { held: await t.hasBlob(h) }));
  if (got.held && !o.named && !o.quiet) await refused(store, scope, h, o.via);
  return got.found;
}

/**
 * Stored content by hash, read for a scope: undefined when not stored or not reached.
 * @param {Store} store @param {string} scope @param {unknown} hash
 * @param {{ named?: { scope: string, data?: any, refs?: string[] }, via?: string, quiet?: boolean }} [o] named: the log entry
 *   as stored, of the scope, whose data has the hash: if it names it, nothing else is looked up, and an entry's own data
 *   is never a refusal to log; quiet: no log either (a hash from the conversation's own entries); via: what asked
 * @returns {Promise<BlobRecord | undefined>}
 */
export const readBlob = (store, scope, hash, o = {}) => /** @type {Promise<BlobRecord | undefined>} */ (look(store, scope, hash, o, true));

/** Whether a scope can read a hash (stored and reached), without reading it. @param {Store} store @param {string} scope @param {unknown} hash @param {{ via?: string }} [o] */
export const canRead = async (store, scope, hash, o = {}) => Boolean(await look(store, scope, hash, o, false));

/** A blob's bytes as readBlob reads them, or null. @param {Store} store @param {string} scope @param {unknown} hash @param {Parameters<typeof readBlob>[3]} [o] */
export async function blobBytes(store, scope, hash, o) {
  const b = await readBlob(store, scope, hash, o);
  return b ? new Uint8Array(b.data) : null;
}

/** The refusals each store has logged while annai runs. @type {WeakMap<Store, Set<string>>} */
const told = new WeakMap();

/**
 * Logs a refused read in its scope, once a scope and hash; a scope removed meanwhile gets nothing (§4.9).
 * @param {Store} store @param {string} scope @param {string} hash @param {string} [via] @param {number} [now]
 */
export async function refused(store, scope, hash, via, now = Date.now()) {
  const seen = told.get(store) ?? new Set();
  told.set(store, seen);
  if (seen.has(`${scope}\n${hash}`)) return;
  if (seen.size >= 1000) seen.clear();
  seen.add(`${scope}\n${hash}`);
  await store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    if (await t.getScope(scope)) await t.appendEvent(scope, { ts: now, type: 'content.refused', actor: 'system', data: { content: `${hash.slice(0, 12)}…`, ...(via ? { via } : {}) } });
  }).catch(() => {});
}
