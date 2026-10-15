/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').Tx} Tx */

export const DB_NAME = 'annai';
export const DB_VERSION = 1;

/** Opens the database, creating or upgrading it. @param {string} [name] @returns {Promise<IDBDatabase>} */
export function openDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('annai is open in another tab that needs to close first.'));
  });
}

/** Ordered migrations, each in the all-or-nothing versionchange transaction (spec §4.6). @param {IDBDatabase} db @param {number} from */
function upgrade(db, from) {
  if (from < 1) {
    db.createObjectStore('blobs', { keyPath: 'hash' });
    db.createObjectStore('files', { keyPath: ['scope', 'path'] });
    db.createObjectStore('events', { keyPath: ['scope', 'seq'] });
    db.createObjectStore('secrets', { keyPath: 'id' });
    db.createObjectStore('scopes', { keyPath: 'id' });
  }
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
  return {
    async tx(stores, mode, fn) {
      for (let attempt = 0; ; attempt++) {
        const d = db ?? (await connect());
        try {
          return await runTx(d, stores, mode, fn);
        } catch (e) {
          if (attempt === 0 && connectionLost(e)) {
            if (db === d) db = null;
            continue;
          }
          throw e;
        }
      }
    },
    close() {
      db?.close();
      db = null;
    },
  };
}

/** @param {any} e */
function connectionLost(e) {
  return e?.name === 'InvalidStateError' || /connection (is )?(lost|closing|closed)|database (is )?clos/i.test(String(e?.message));
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
      const rec = { ...ev, scope, seq };
      await req(os('events').add(rec));
      return rec;
    },
    putEvent: async (rec) => { await req(os('events').put(rec)); },
    listEvents: (scope, q = {}) => new Promise((res, rej) => {
      const lo = (q.after ?? 0) + 1;
      const hi = q.before === undefined ? Infinity : q.before - 1;
      const limit = q.limit ?? Infinity;
      if (lo > hi || limit <= 0) {
        res([]);
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
        if (!q.types || q.types.includes(c.value.type)) out.push(c.value);
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
