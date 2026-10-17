/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').Tx} Tx */
import { storeError, StoppedError } from './errors.js';

/**
 * An in-memory Store with the same contract as the IndexedDB store, for unit
 * tests and for running the core outside a browser. Transactions run one at a
 * time; a read-write transaction works on a copy that replaces the data only
 * when it succeeds.
 * @returns {Store}
 */
export function createMemoryStore() {
  let data = emptyData();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let closed = false;
  return {
    tx(stores, mode, fn) {
      if (closed) return Promise.reject(new StoppedError());
      const run = async () => {
        const work = mode === 'readwrite' ? copy(data) : data;
        const result = await fn(makeTx(work, mode, new Set(stores)));
        if (mode === 'readwrite') data = work;
        return result;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p.catch((e) => { throw storeError(e); });
    },
    close() { closed = true; },
  };
}

function emptyData() {
  return { blobs: new Map(), files: new Map(), events: new Map(), secrets: new Map(), scopes: new Map() };
}

/** @param {ReturnType<typeof emptyData>} d */
function copy(d) {
  return { blobs: new Map(d.blobs), files: new Map(d.files), events: new Map(d.events), secrets: new Map(d.secrets), scopes: new Map(d.scopes) };
}

const fkey = (/** @type {string} */ scope, /** @type {string} */ path) => `${scope}\u0000${path}`;
const ekey = (/** @type {string} */ scope, /** @type {number} */ seq) => `${scope}\u0000${seq}`;

/**
 * @param {ReturnType<typeof emptyData>} d
 * @param {'readonly'|'readwrite'} mode
 * @param {Set<string>} allowed
 * @returns {Tx}
 */
function makeTx(d, mode, allowed) {
  /** @param {keyof ReturnType<typeof emptyData>} name @param {boolean} [write] */
  const use = (name, write = false) => {
    if (!allowed.has(name)) throw new DOMException(`store "${name}" is not part of this transaction`, 'NotFoundError');
    if (write && mode !== 'readwrite') throw new DOMException('the transaction is read-only', 'ReadOnlyError');
    return d[name];
  };
  const out = (/** @type {any} */ v) => (v === undefined ? undefined : structuredClone(v));
  const eventsOf = (/** @type {string} */ scope) =>
    [...use('events').values()].filter((e) => e.scope === scope).sort((a, b) => a.seq - b.seq);

  /** @type {Tx} */
  const t = {
    async getBlob(hash) { return out(use('blobs').get(hash)); },
    async hasBlob(hash) { return use('blobs').has(hash); },
    async putBlob(rec) { use('blobs', true).set(rec.hash, structuredClone(rec)); },
    async deleteBlob(hash) { use('blobs', true).delete(hash); },
    async blobInUse(hash, { files = true, events = true, exceptScope } = {}) {
      if (files) for (const f of use('files').values()) if (f.hash === hash) return true;
      if (!events) return false;
      for (const e of use('events').values()) {
        if (e.scope === exceptScope) continue;
        if ((e.refs ?? []).includes(hash) || e.data?.old === hash || e.data?.new === hash) return true;
      }
      return false;
    },
    async listBlobs() { return [...use('blobs').values()].map((b) => ({ hash: b.hash, size: b.size })); },
    async scopesWithData() {
      return [...new Set([...use('files').values(), ...use('events').values()].map((x) => x.scope))].sort();
    },
    async getFile(scope, path) { return out(use('files').get(fkey(scope, path))); },
    async putFile(entry) { use('files', true).set(fkey(entry.scope, entry.path), structuredClone(entry)); },
    async deleteFile(scope, path) { use('files', true).delete(fkey(scope, path)); },
    async listFiles(scope, prefix = '/') {
      return [...use('files').values()]
        .filter((f) => f.scope === scope && f.path.startsWith(prefix))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(out);
    },
    async lastSeq(scope) {
      const list = eventsOf(scope);
      return list.length ? list[list.length - 1].seq : 0;
    },
    async appendEvent(scope, ev) {
      use('events', true);
      const seq = (await t.lastSeq(scope)) + 1;
      const rec = { ...structuredClone(ev), scope, seq };
      d.events.set(ekey(scope, seq), rec);
      return structuredClone(rec);
    },
    async putEvent(rec) { use('events', true).set(ekey(rec.scope, rec.seq), structuredClone(rec)); },
    async deleteEvent(scope, seq) { use('events', true).delete(ekey(scope, seq)); },
    async listEvents(scope, q = {}) {
      let list = eventsOf(scope).filter((e) => e.seq > (q.after ?? 0) && (q.before === undefined || e.seq < q.before));
      if (q.types) list = list.filter((e) => q.types?.includes(e.type));
      if (q.notTypes) list = list.filter((e) => !q.notTypes?.includes(e.type));
      if (q.reverse) list.reverse();
      return list.slice(0, q.limit ?? Infinity).map(out);
    },
    async getScope(id) { return out(use('scopes').get(id)); },
    async putScope(rec) { use('scopes', true).set(rec.id, structuredClone(rec)); },
    async listScopes() { return [...use('scopes').values()].map(out); },
    async deleteScope(id) {
      use('scopes', true).delete(id);
      for (const [k, f] of use('files', true)) if (f.scope === id) d.files.delete(k);
      for (const [k, e] of use('events', true)) if (e.scope === id) d.events.delete(k);
    },
    async getSecret(id) { return out(use('secrets').get(id)?.value); },
    async putSecret(id, value) { use('secrets', true).set(id, structuredClone({ id, value })); },
    async deleteSecret(id) { use('secrets', true).delete(id); },
    async listSecretIds() { return [...use('secrets').keys()].sort(); },
  };
  return t;
}
