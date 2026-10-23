/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').Tx} Tx */
import { storeError, StoppedError } from './errors.js';

export const DB_NAME = 'annai';
export const DB_VERSION = 4;

/**
 * Opens the database, creating or upgrading it. An upgrade that another connection
 * blocks waits for that connection to close (ours close on versionchange) instead of failing.
 * @param {string} [name] @param {number} [version] differs from DB_VERSION only in tests
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => upgrade(req.result, /** @type {IDBTransaction} */ (req.transaction), e.oldVersion, e.newVersion ?? version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Ordered migrations, each in the all-or-nothing versionchange transaction (spec §4.6).
 * @param {IDBDatabase} db @param {IDBTransaction} tx @param {number} from @param {number} to the version being opened: only steps up to it run
 */
function upgrade(db, tx, from, to) {
  if (from < 1) {
    db.createObjectStore('blobs', { keyPath: 'hash' });
    db.createObjectStore('files', { keyPath: ['scope', 'path'] });
    db.createObjectStore('events', { keyPath: ['scope', 'seq'] });
    db.createObjectStore('secrets', { keyPath: 'id' });
    db.createObjectStore('scopes', { keyPath: 'id' });
  }
  // 2: blob sizes can be listed without reading any content (spec §4.9).
  if (from < 2 && to >= 2) tx.objectStore('blobs').createIndex('size', 'size');
  // 3: what files and log entries point at is indexed, so removing a trip reads only what it used (spec §4.9).
  if (from < 3 && to >= 3) {
    tx.objectStore('files').createIndex('hash', 'hash');
    const events = tx.objectStore('events');
    events.createIndex('refs', 'refs', { multiEntry: true });
    events.createIndex('old', 'data.old');
    events.createIndex('new', 'data.new');
  }
  // 4: log entries by type, so a query by type reads only those entries, not a day's location points (A6).
  // The records stay as they are, so exports and Backups are unchanged.
  if (from < 4 && to >= 4) tx.objectStore('events').createIndex('type', ['scope', 'type', 'seq']);
}

/** Deletes a whole database (used by "Erase everything" and by tests). @param {string} [name] */
export function eraseDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
  });
}

/**
 * The IndexedDB Store. If the connection is lost (Safari drops it after the
 * page has been in the background), the next transaction reopens it and
 * retries once; a failed transaction never commits, so the retry is safe.
 * @param {string} [name]
 * @param {{ onOpen?: (db: IDBDatabase) => void }} [hooks] test hook: sees every connection opened
 * @returns {Promise<Store>}
 */
export async function createIdbStore(name = DB_NAME, hooks = {}) {
  /** @type {IDBDatabase | null} */
  let db = null;
  const connect = async () => {
    const d = await openDatabase(name);
    d.onversionchange = () => {
      d.close();
      if (db === d) db = null;
    };
    d.onclose = () => {
      if (db === d) db = null;
    };
    hooks.onOpen?.(d);
    db = d;
    return d;
  };
  await connect();
  let closed = false;
  return {
    async tx(stores, mode, fn) {
      if (closed) throw new StoppedError(); // never reopen: another tab owns the data now
      for (let attempt = 0; ; attempt++) {
        const d = db ?? (await connect());
        try {
          return await runTx(d, stores, mode, fn);
        } catch (e) {
          if (attempt === 0 && connectionLost(e)) {
            if (db === d) db = null;
            continue;
          }
          throw storeError(e);
        }
      }
    },
    close() {
      closed = true;
      db?.close();
      db = null;
    },
  };
}

/**
 * A transaction that failed because the connection went away: a closed connection
 * throws InvalidStateError, and WebKit fails the transaction in flight with
 * "UnknownError: Connection to Indexed Database server lost". Nothing was committed
 * either way, so one retry is safe.
 * @param {any} e
 */
function connectionLost(e) {
  return e?.name === 'InvalidStateError' || e?.name === 'UnknownError' || /connection (is )?(lost|closing|closed)|server lost|database (is )?clos/i.test(String(e?.message));
}

/**
 * @template T
 * @param {IDBDatabase} db
 * @param {import('./types.js').StoreName[]} stores
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: Tx) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runTx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    /** @type {any} */
    let result;
    let settled = false;
    const fail = (/** @type {any} */ e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    t.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    t.onabort = () => fail(t.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
    Promise.resolve()
      .then(() => fn(makeTx(t)))
      .then((r) => { result = r; }, (e) => {
        fail(e);
        try { t.abort(); } catch { /* already finished */ }
      });
  });
}

/** @param {IDBTransaction} t @returns {Tx} */
function makeTx(t) {
  const os = (/** @type {string} */ name) => t.objectStore(name);
  /** @template R @param {IDBRequest<R>} r @returns {Promise<R>} */
  const req = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const seqRange = (/** @type {string} */ scope, /** @type {number} */ lo, /** @type {number} */ hi) => IDBKeyRange.bound([scope, lo], [scope, hi]);
  const pathRange = (/** @type {string} */ scope, /** @type {string} */ prefix) => IDBKeyRange.bound([scope, prefix], [scope, prefix + '￿']);

  /** @type {Tx} */
  const tx = {
    getBlob: (hash) => req(os('blobs').get(hash)),
    hasBlob: async (hash) => (await req(os('blobs').getKey(hash))) !== undefined,
    putBlob: async (rec) => { await req(os('blobs').put(rec)); },
    deleteBlob: async (hash) => { await req(os('blobs').delete(hash)); },
    blobInUse: async (hash, { files = true, events = true, exceptScope } = {}) => {
      const count = (/** @type {IDBIndex} */ index) => req(index.count(IDBKeyRange.only(hash)));
      if (files && await count(os('files').index('hash'))) return true;
      if (!events) return false;
      const ev = os('events');
      for (const name of ['refs', 'old', 'new']) {
        if (exceptScope === undefined) {
          if (await count(ev.index(name))) return true;
          continue;
        }
        // Keys are [scope, seq]: only log entries of other scopes count.
        const keys = /** @type {[string, number][]} */ (await req(ev.index(name).getAllKeys(IDBKeyRange.only(hash))));
        if (keys.some((k) => k[0] !== exceptScope)) return true;
      }
      return false;
    },
    listBlobs: () => new Promise((res, rej) => {
      /** @type {{ hash: string, size: number }[]} */
      const out = [];
      const r = os('blobs').index('size').openKeyCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) {
          res(out);
          return;
        }
        out.push({ hash: /** @type {string} */ (c.primaryKey), size: /** @type {number} */ (c.key) });
        c.continue();
      };
      r.onerror = () => rej(r.error);
    }),
    scopesWithData: async () => {
      // Keys are [scope, path] and [scope, seq]: after each scope's first key, skip past all of its keys
      // ([scope, []] sorts after them, since an array sorts after any string or number).
      const firstKeys = (/** @type {string} */ name) => new Promise((res, rej) => {
        /** @type {string[]} */
        const out = [];
        const r = os(name).openKeyCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (!c) {
            res(out);
            return;
          }
          const scope = /** @type {[string, unknown]} */ (c.primaryKey)[0];
          out.push(scope);
          c.continue([scope, []]);
        };
        r.onerror = () => rej(r.error);
      });
      return [...new Set([...(await firstKeys('files')), ...(await firstKeys('events'))])].sort();
    },
    getFile: (scope, path) => req(os('files').get([scope, path])),
    putFile: async (entry) => { await req(os('files').put(entry)); },
    deleteFile: async (scope, path) => { await req(os('files').delete([scope, path])); },
    listFiles: (scope, prefix = '/') => req(os('files').getAll(pathRange(scope, prefix))),
    lastSeq: (scope) => new Promise((res, rej) => {
      const r = os('events').openKeyCursor(seqRange(scope, -Infinity, Infinity), 'prev');
      r.onsuccess = () => res(r.result ? /** @type {[string, number]} */ (r.result.primaryKey)[1] : 0);
      r.onerror = () => rej(r.error);
    }),
    appendEvent: async (scope, ev) => {
      const seq = (await tx.lastSeq(scope)) + 1;
      const rec = { ...ev, scope, seq, at: Date.now() };
      await req(os('events').add(rec));
      return rec;
    },
    putEvent: async (rec) => { await req(os('events').put(rec)); },
    deleteEvent: async (scope, seq) => { await req(os('events').delete([scope, seq])); },
    listEvents: (scope, q = {}) => new Promise((res, rej) => {
      const lo = (q.after ?? 0) + 1;
      const hi = q.before === undefined ? Infinity : q.before - 1;
      const limit = q.limit ?? Infinity;
      if (lo > hi || limit <= 0) {
        res([]);
        return;
      }
      if (q.types) {
        // By type: each type's entries through the type index, merged in order (DB version 4).
        const kinds = [...new Set(q.types)].filter((k) => !q.notTypes?.includes(k));
        const index = os('events').index('type');
        Promise.all(kinds.map((k) => new Promise((done, fail) => {
          const range = IDBKeyRange.bound([scope, k, lo], [scope, k, hi]);
          if (limit === Infinity || !q.reverse) {
            // Every entry of a type, or the first few: one request (a five-day trip's points), not one callback each.
            const all = index.getAll(range, limit === Infinity ? undefined : limit);
            all.onsuccess = () => done(q.reverse ? /** @type {any[]} */ (all.result).reverse() : all.result);
            all.onerror = () => fail(all.error);
            return;
          }
          /** @type {any[]} */
          const got = [];
          const r = index.openCursor(range, 'prev');
          r.onsuccess = () => {
            const c = r.result;
            if (!c || got.length >= limit) {
              done(got);
              return;
            }
            got.push(c.value);
            c.continue();
          };
          r.onerror = () => fail(r.error);
        }))).then((lists) => {
          const all = /** @type {any[]} */ (lists.flat()).sort((a, b) => (q.reverse ? b.seq - a.seq : a.seq - b.seq));
          res(all.slice(0, limit));
        }, rej);
        return;
      }
      /** @type {any[]} */
      const out = [];
      const r = os('events').openCursor(seqRange(scope, lo, hi), q.reverse ? 'prev' : 'next');
      r.onsuccess = () => {
        const c = r.result;
        if (!c) {
          res(out);
          return;
        }
        if ((!q.types || q.types.includes(c.value.type)) && (!q.notTypes || !q.notTypes.includes(c.value.type))) out.push(c.value);
        if (out.length >= limit) {
          res(out);
          return;
        }
        c.continue();
      };
      r.onerror = () => rej(r.error);
    }),
    getScope: (id) => req(os('scopes').get(id)),
    putScope: async (rec) => { await req(os('scopes').put(rec)); },
    listScopes: () => req(os('scopes').getAll()),
    deleteScope: async (id) => {
      await req(os('scopes').delete(id));
      await req(os('files').delete(pathRange(id, '')));
      await req(os('events').delete(seqRange(id, -Infinity, Infinity)));
    },
    getSecret: async (id) => (await req(os('secrets').get(id)))?.value,
    putSecret: async (id, value) => { await req(os('secrets').put({ id, value })); },
    deleteSecret: async (id) => { await req(os('secrets').delete(id)); },
    listSecretIds: async () => /** @type {string[]} */ (await req(os('secrets').getAllKeys())),
  };
  return tx;
}
