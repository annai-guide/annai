import { storeContract } from '../../contract/store-contract.js';
import { createIdbStore, eraseDatabase, openDatabase, DB_VERSION } from '../../../src/core/store-idb.js';
import { storedTexts } from '../../../src/core/agent/log.js';
import { forget } from '../../../src/core/forget.js';
import { Workspace } from '../../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../../src/core/scopes.js';
import { snapshot } from '../../contract/snapshot.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../../src/core/archive.js';
import { StorageFullError, StoppedError } from '../../../src/core/errors.js';

/**
 * Aborts the next requests on the files store in flight, as a browser can: the request is placed, then its transaction goes.
 * @param {'get' | 'put'} method @param {number} count
 */
function abortNext(method, count) {
  const real = /** @type {any} */ (IDBObjectStore.prototype)[method];
  let done = 0;
  /** @type {any} */ (IDBObjectStore.prototype)[method] = function (/** @type {any[]} */ ...a) {
    const r = real.apply(this, a);
    if (done < count && this.name === 'files') {
      done++;
      this.transaction.abort();
    }
    return r;
  };
  return { aborted: () => done, heal: () => { /** @type {any} */ (IDBObjectStore.prototype)[method] = real; } };
}

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  let n = 0;
  const fresh = async () => {
    const name = `annai-test-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    return createIdbStore(name);
  };
  storeContract(test, assert, fresh);

  test("idb: forget's dry run reports what a real forget does and rolls everything back, blobs and log included", async () => {
    const s = await fresh();
    const ws = new Workspace(s);
    await ensureBaseScopes(ws);
    const trip = await createTrip(ws, { title: 'Dry' });
    await ws.write(trip, '/files/a.pdf', 'first bytes', { author: 'user', type: 'application/pdf' });
    await ws.write(trip, '/files/a.pdf', 'second bytes', { author: 'user', type: 'application/pdf' });
    await ws.delete(trip, '/files/a.pdf', { author: 'shiori' });
    const match = { history: (/** @type {string} */ p) => p === '/files/a.pdf', mustFree: (/** @type {string} */ p) => p === '/files/a.pdf' };
    const before = JSON.stringify(await snapshot(s));
    const dry = await forget(s, trip, { ...match, dryRun: true });
    assert.equal(JSON.stringify(await snapshot(s)), before);
    assert.deepEqual(dry, { files: 0, events: 3, bytes: 0, blobs: 2, kept: null });
    assert.deepEqual(await forget(s, trip, match), { files: 0, events: 3, bytes: 'first bytes'.length + 'second bytes'.length, kept: null });
    assert.ok(JSON.stringify(await snapshot(s)) !== before);
    s.close();
  });

  const rec = { scope: 'trip-1', path: '/a.md', hash: 'h1', size: 1, type: 'text/plain', author: 'user', created: 1, modified: 1 };

  test("idb: an entry that says it stored texts but names none reads as none, not a DataError that stops its conversation loading (Step, 9)", async () => {
    const s = await fresh();
    const [bare, empty] = await s.tx(['events'], 'readwrite', async (t) => [
      await t.appendEvent('trip-1', { ts: 1, type: 'msg.user', actor: 'user', data: { stored: ['text'] } }),
      await t.appendEvent('trip-1', { ts: 2, type: 'msg.user', actor: 'user', data: { stored: ['text'] }, refs: [''] }),
    ]);
    assert.deepEqual(await storedTexts(s, bare), {});
    assert.deepEqual(await storedTexts(s, empty), {});
    s.close();
  });

  test('idb: data survives closing and reopening', async () => {
    const name = `annai-test-persist-${Date.now()}`;
    const a = await createIdbStore(name);
    await a.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    a.close();
    const b = await createIdbStore(name);
    const f = await b.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md'));
    assert.equal(f.hash, 'h1');
    b.close();
    await eraseDatabase(name);
  });

  test('idb: reopens after the connection is closed under it', async () => {
    const name = `annai-test-lost-${Date.now()}`;
    /** @type {IDBDatabase[]} */
    const connections = [];
    const s = await createIdbStore(name, { onOpen: (db) => connections.push(db) });
    await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    connections[0].close(); // what Safari does to a backgrounded page's connection
    const f = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md'));
    assert.equal(f.hash, 'h1');
    assert.equal(connections.length, 2);
    s.close();
    await eraseDatabase(name);
  });

  test('idb: erasing the database while it is open closes our connection cleanly', async () => {
    const name = `annai-test-erase-${Date.now()}`;
    const s = await createIdbStore(name);
    await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    await eraseDatabase(name);
    assert.equal(await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')), undefined);
    s.close();
    await eraseDatabase(name);
  });

  test("idb: retries once when Safari reports the connection to the database server lost", async () => {
    const s = await fresh();
    let first = true;
    await s.tx(['files'], 'readwrite', async (t) => {
      if (first) {
        first = false;
        // The error WebKit gives a transaction that was in flight when it dropped the connection.
        throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
      }
      await t.putFile(rec);
    });
    assert.equal((await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')))?.hash, 'h1');
    s.close();
  });

  test('idb: a read the browser aborts in flight is tried once more, and the connection it was on closes', async () => {
    const name = `annai-test-abort-${Date.now()}`;
    /** @type {IDBDatabase[]} */
    const connections = [];
    const s = await createIdbStore(name, { onOpen: (db) => connections.push(db) });
    await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    const b = abortNext('get', 1);
    const f = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md'));
    b.heal();
    assert.equal(b.aborted(), 1);
    assert.equal(f.hash, 'h1');
    assert.equal(connections.length, 2);
    let closed = '';
    try {
      connections[0].transaction(['files']);
    } catch (e) {
      closed = /** @type {any} */ (e).name;
    }
    assert.equal(closed, 'InvalidStateError', 'the old connection is closed');
    s.close();
    await eraseDatabase(name);
  });

  test('idb: a write the browser aborts in flight is tried once more, and stored once', async () => {
    const s = await fresh();
    let runs = 0;
    const b = abortNext('put', 1);
    await s.tx(['files', 'events'], 'readwrite', async (t) => {
      runs++;
      await t.putFile(rec);
      await t.appendEvent('trip-1', { ts: 1, type: 'file.write', actor: 'user' });
    });
    b.heal();
    assert.equal(b.aborted(), 1);
    assert.equal(runs, 2);
    assert.equal((await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')))?.hash, 'h1');
    assert.equal((await s.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'))).length, 1);
    s.close();
  });

  test('idb: a read aborted twice rejects: the retry is one', async () => {
    const s = await fresh();
    const b = abortNext('get', 2);
    await assert.rejects(s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')), (/** @type {any} */ e) => e.name === 'AbortError');
    b.heal();
    assert.equal(b.aborted(), 2);
    s.close();
  });

  // A full disk, as the builder's probe of 2026-11-19 saw it (Linux builds; its output wasn't kept; not yet on a phone): WebKit and Chromium answer every request, then abort the
  // commit (WebKit with no error, Chromium with a DataError for the files of a large value, and only for those: its small writes are saved). Faked here
  // by aborting a transaction once all of annai's requests have succeeded.
  /**
   * A store whose next transactions the browser aborts at their commit, with `error` as the transaction's error, each counted.
   * @param {string} mode @param {DOMException | null} error
   * @param {{ large?: boolean }} [o] large: only a transaction that put a 1 MiB value is aborted, as Chromium's blob files are; `at.heal()` puts back what it watches puts with
   */
  const refusing = async (mode, error, { large = false } = {}) => {
    const name = `annai-test-full-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    const at = { aborts: 0, on: true, big: false, heal: () => {} };
    if (large) {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = /** @type {any} */ (/** @this {IDBObjectStore} */ function (/** @type {any[]} */ ...a) {
        if (a[0]?.data?.byteLength >= 1 << 20) at.big = true;
        return put.apply(this, /** @type {any} */ (a));
      });
      at.heal = () => { IDBObjectStore.prototype.put = put; };
    }
    const s = await createIdbStore(name, {
      onOpen: (db) => {
        const real = db.transaction.bind(db);
        db.transaction = /** @type {any} */ ((/** @type {any} */ stores, /** @type {any} */ m) => {
          const t = real(stores, m);
          if (at.on && m === mode) {
            Object.defineProperty(t, 'error', { get: () => error });
            // A request of its own that succeeds after fn's last: the commit point, where the browser refuses.
            queueMicrotask(() => {
              const keep = t.objectStore(stores[0]).count();
              keep.onsuccess = () => Promise.resolve().then(() => Promise.resolve()).then(() => {
                const again = t.objectStore(stores[0]).count();
                again.onsuccess = () => {
                  if (large && !at.big) return;
                  at.big = false;
                  at.aborts++;
                  t.abort();
                };
              });
            });
          }
          return t;
        });
      },
    });
    return { s, at };
  };

  test("idb: a write WebKit aborts after every request in it succeeded (its full disk, no error) rejects with StorageFullError and writes nothing, after one more try", async () => {
    const { s, at } = await refusing('readwrite', null);
    let runs = 0;
    const got = await s.tx(['files'], 'readwrite', async (t) => {
      runs++;
      await t.putFile(rec);
    }).then(() => null, (e) => e);
    at.on = false;
    assert.ok(got instanceof StorageFullError, String(got));
    assert.equal(got.cause?.name, 'AbortError');
    assert.equal(runs, 2, 'with no error it can be a lost connection, so it is tried once more first');
    assert.equal(at.aborts, 2);
    assert.equal(await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')), undefined);
    s.close();
  });

  test("idb: Chromium's full disk refuses a large value alone: a small write it saved goes through, a 1 MiB blob's commit, aborted with a DataError, rejects with StorageFullError, tried once", async () => {
    const { s, at } = await refusing('readwrite', new DOMException('Failed to write blobs (IOError)', 'DataError'), { large: true });
    try {
      await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
      assert.equal(at.aborts, 0, 'a small write is saved');
      assert.equal((await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')))?.hash, 'h1');
      let runs = 0;
      const got = await s.tx(['blobs'], 'readwrite', async (t) => {
        runs++;
        await t.putBlob({ hash: 'big', type: 'application/octet-stream', size: 1 << 20, data: new ArrayBuffer(1 << 20) });
      }).then(() => null, (e) => e);
      assert.ok(got instanceof StorageFullError, String(got));
      assert.equal(got.cause?.name, 'DataError');
      assert.equal(runs, 1, "a DataError isn't a lost connection: no second try");
      assert.equal(at.aborts, 1);
      at.on = false;
      assert.equal(await s.tx(['blobs'], 'readonly', (t) => t.getBlob('big')), undefined);
    } finally {
      at.heal();
      s.close();
    }
  });

  test('idb: a read-only transaction the browser aborts after its requests succeeded keeps its error', async () => {
    const { s, at } = await refusing('readonly', null);
    const got = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')).then(() => null, (e) => e);
    at.on = false;
    assert.equal(got?.name, 'AbortError');
    assert.ok(!(got instanceof StorageFullError));
    s.close();
  });

  /** The next put requests on the files store fail as the browser's own, with that error, after a real request kept the transaction going. @param {string} name @param {string} message */
  const failPuts = (name, message) => {
    const real = IDBObjectStore.prototype.put;
    let failed = 0;
    IDBObjectStore.prototype.put = /** @type {any} */ (/** @this {IDBObjectStore} */ function (/** @type {any[]} */ ...a) {
      if (this.name !== 'files') return real.apply(this, /** @type {any} */ (a));
      failed++;
      /** @type {any} */
      const r = { error: new DOMException(message, name), result: undefined, onsuccess: null, onerror: null };
      this.count().onsuccess = () => r.onerror?.(new Event('error'));
      return r;
    });
    return { failed: () => failed, heal: () => { IDBObjectStore.prototype.put = real; } };
  };

  test("idb: WebKit's UnknownError on a write request rejects with StorageFullError, after one more try", async () => {
    const s = await fresh();
    const p = failPuts('UnknownError', 'Unable to store record in object store');
    const got = await s.tx(['files'], 'readwrite', (t) => t.putFile(rec)).then(() => null, (e) => e);
    p.heal();
    assert.ok(got instanceof StorageFullError, String(got));
    assert.equal(got.cause?.name, 'UnknownError');
    assert.equal(p.failed(), 2);
    s.close();
  });

  test('idb: a QuotaExceededError on a write request rejects with StorageFullError at once', async () => {
    const s = await fresh();
    const p = failPuts('QuotaExceededError', 'The quota has been exceeded.');
    const got = await s.tx(['files'], 'readwrite', (t) => t.putFile(rec)).then(() => null, (e) => e);
    p.heal();
    assert.ok(got instanceof StorageFullError, String(got));
    assert.equal(p.failed(), 1);
    s.close();
  });

  test("idb: a request annai's own code got wrong (two appends racing for one number) keeps its error, though fn went on to finish", async () => {
    const s = await fresh();
    const got = await s.tx(['events'], 'readwrite', async (t) => {
      const ev = { ts: 1, type: 'file.write', actor: /** @type {const} */ ('user') };
      await Promise.allSettled([t.appendEvent('trip-1', ev), t.appendEvent('trip-1', ev)]);
    }).then(() => null, (e) => e);
    assert.equal(got?.name, 'ConstraintError');
    assert.ok(!(got instanceof StorageFullError));
    s.close();
  });

  for (const mode of /** @type {const} */ (['readwrite', 'readonly'])) {
    for (const [name, message] of /** @type {const} */ ([['UnknownError', 'Internal error opening backing store for indexedDB.open.'], ['AbortError', 'The connection was closed.']])) {
      // Chromium's backing store writes as it opens: at its last bytes it can't open, for a read too. The builder's probe of 2026-11-19 (Linux Chromium with no byte
      // free; its output wasn't kept) saw a new connection fail with the UnknownError, and the reopen of a connection its failed write had closed fail with the AbortError;
      // the reopen is faked here.
      test(`idb: a ${mode} transaction whose reopen for its one more try fails with ${name} (Chromium at its last bytes) rejects with StorageFullError`, async () => {
        const s = await fresh();
        const b = abortNext(mode === 'readwrite' ? 'put' : 'get', 1);
        const open = IDBFactory.prototype.open;
        let opens = 0;
        // The connection the abort left is closed by the retry; reopening it, Chromium's backing store can't be opened.
        IDBFactory.prototype.open = /** @type {any} */ (function () {
          opens++;
          /** @type {any} */
          const r = { error: new DOMException(message, name), result: undefined };
          setTimeout(() => r.onerror?.(new Event('error')));
          return r;
        });
        const got = await s.tx(['files'], mode, async (t) => { await (mode === 'readwrite' ? t.putFile(rec) : t.getFile('trip-1', '/a.md')); }).then(() => null, (e) => e);
        IDBFactory.prototype.open = open;
        b.heal();
        assert.equal(opens, 1);
        assert.ok(got instanceof StorageFullError, String(got));
        assert.equal(got.cause?.name, name);
        s.close();
      });
    }
  }

  // A transaction that starts with no connection (another tab upgraded the database, so annai's connection closed itself) connects first: at the last bytes of
  // Chromium that connect fails too, and it passes the same door: a full phone, after the one more try every lost connection gets; any other failure keeps its error.
  for (const [name, full] of /** @type {const} */ ([['UnknownError', true], ['AbortError', true], ['SecurityError', false]])) {
    test(`idb: a transaction that starts with no connection, whose connect fails with ${name}, ${full ? 'rejects with StorageFullError, after one more try' : 'keeps its error, with no second try'}`, async () => {
      const dbName = `annai-test-noconn-${Date.now()}-${n++}`;
      await eraseDatabase(dbName);
      const s = await createIdbStore(dbName);
      await eraseDatabase(dbName); // the connection is told to close, and does
      const open = IDBFactory.prototype.open;
      let opens = 0;
      IDBFactory.prototype.open = /** @type {any} */ (function () {
        opens++;
        /** @type {any} */
        const r = { error: new DOMException('Internal error opening backing store for indexedDB.open.', name), result: undefined };
        setTimeout(() => r.onerror?.(new Event('error')));
        return r;
      });
      const got = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')).then(() => null, (e) => e);
      IDBFactory.prototype.open = open;
      assert.equal(opens, full ? 2 : 1);
      assert.equal(got instanceof StorageFullError, full, String(got));
      assert.equal((got?.cause ?? got)?.name, name);
      s.close();
    });
  }

  // The sequences the builder's probe of 2026-11-19 saw on a full disk (Linux builds; its output wasn't kept): WebKit, a transaction of four puts: the second fails with UnknownError,
  // the others, in flight, with AbortError, and the transaction ends with an UnknownError of its own. Chromium at no byte free, a trip's removal:
  // its request fails with AbortError, and its transaction ends with an UnknownError of its own ("Connection is closing because of: IO error").
  // fn may reject with the AbortError (a request that awaits others, or one the transaction's end cut off); the reason is the transaction's.
  test("idb: a request that fails with AbortError because its transaction ended with an error of its own rejects with that error: StorageFullError for an UnknownError", async () => {
    const name = `annai-test-own-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    const own = new DOMException('Unable to store record in object store', 'UnknownError');
    const s = await createIdbStore(name, {
      onOpen: (db) => {
        const real = db.transaction.bind(db);
        db.transaction = /** @type {any} */ ((/** @type {any} */ stores, /** @type {any} */ mode) => {
          const t = real(stores, mode);
          if (mode === 'readwrite') Object.defineProperty(t, 'error', { get: () => own });
          return t;
        });
      },
    });
    let runs = 0;
    const b = abortNext('put', 2); // the request is placed, then the transaction goes: the request fails with AbortError
    const got = await s.tx(['files'], 'readwrite', async (t) => { runs++; await t.putFile(rec); }).then(() => null, (e) => e);
    b.heal();
    assert.equal(b.aborted(), 2);
    assert.equal(runs, 2, 'it is tried once more, as a lost connection is');
    assert.ok(got instanceof StorageFullError, String(got));
    assert.equal(got.cause, own, "the transaction's own error, not its request's AbortError");
    s.close();
  });

  test("idb: WebKit's transaction of several puts, whose second fails with UnknownError while the others are in flight, rejects with StorageFullError, after one more try", async () => {
    const s = await fresh();
    const put = IDBObjectStore.prototype.put;
    /** @type {WeakMap<IDBTransaction, number>} */
    const seen = new WeakMap();
    let failed = 0;
    IDBObjectStore.prototype.put = /** @type {any} */ (/** @this {IDBObjectStore} */ function (/** @type {any[]} */ ...a) {
      const k = (seen.get(this.transaction) ?? 0) + 1;
      seen.set(this.transaction, k);
      if (this.name !== 'files' || k !== 2) return put.apply(this, /** @type {any} */ (a));
      failed++;
      /** @type {any} */
      const r = { error: new DOMException('Unable to store record in object store', 'UnknownError'), result: undefined, onsuccess: null, onerror: null };
      this.count().onsuccess = () => r.onerror?.(new Event('error'));
      return r;
    });
    let runs = 0;
    const got = await s.tx(['files'], 'readwrite', async (t) => {
      runs++;
      await Promise.all([1, 2, 3, 4].map((i) => t.putFile({ ...rec, path: `/p${i}.md` })));
    }).then(() => null, (e) => e);
    IDBObjectStore.prototype.put = put;
    assert.ok(got instanceof StorageFullError, String(got));
    assert.equal(got.cause?.name, 'UnknownError', "the failed request's, not the AbortError of the others in flight");
    assert.equal(runs, 2);
    assert.equal(failed, 2);
    assert.deepEqual(await s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1')), [], 'nothing was written');
    s.close();
  });

  test("idb: a write aborted in flight with no error of the transaction's own is no refusal: the request's AbortError is kept", async () => {
    const s = await fresh();
    const b = abortNext('put', 2);
    const got = await s.tx(['files'], 'readwrite', (t) => t.putFile(rec)).then(() => null, (e) => e);
    b.heal();
    assert.equal(got?.name, 'AbortError');
    assert.ok(!(got instanceof StorageFullError));
    s.close();
  });

  test('idb: a first open that fails with UnknownError or AbortError (Chromium at its last bytes, by a builder probe of 2026-11-19) rejects with StorageFullError; any other failure of it keeps its error', async () => {
    const open = IDBFactory.prototype.open;
    /** @param {string} name */
    const failWith = (name) => {
      IDBFactory.prototype.open = /** @type {any} */ (function () {
        /** @type {any} */
        const r = { error: new DOMException('Internal error opening backing store for indexedDB.open.', name), result: undefined };
        setTimeout(() => r.onerror?.(new Event('error')));
        return r;
      });
    };
    try {
      failWith('UnknownError');
      const full = await createIdbStore(`annai-test-open-${Date.now()}`).then(() => null, (e) => e);
      assert.ok(full instanceof StorageFullError, String(full));
      assert.equal(full.cause?.name, 'UnknownError');
      failWith('AbortError');
      const closed = await createIdbStore(`annai-test-open-${Date.now()}`).then(() => null, (e) => e);
      assert.ok(closed instanceof StorageFullError, String(closed));
      failWith('SecurityError');
      const other = await createIdbStore(`annai-test-open-${Date.now()}`).then(() => null, (e) => e);
      assert.equal(other?.name, 'SecurityError');
      assert.ok(!(other instanceof StorageFullError));
    } finally {
      IDBFactory.prototype.open = open;
    }
  });

  test('idb: an import whose write the browser aborts once lists each trip once: a retry starts the result over', async () => {
    const a = await fresh();
    const wa = new Workspace(a);
    await ensureBaseScopes(wa);
    for (const title of ['Road', 'Side']) await wa.write(await createTrip(wa, { title }), '/notes.md', title, { author: 'user' });
    const { blob } = await exportArchive(a, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    a.close();
    const b = await fresh();
    // The second trip's record is put, and its transaction goes: the first try has listed both trips by then.
    const put = IDBObjectStore.prototype.put;
    let trips = 0;
    let aborted = 0;
    IDBObjectStore.prototype.put = function (/** @type {any[]} */ ...x) {
      const r = put.apply(this, /** @type {[any, any]} */ (x));
      if (this.name === 'scopes' && x[0]?.kind === 'trip' && ++trips === 2 && !aborted) {
        aborted++;
        this.transaction.abort();
      }
      return r;
    };
    let result;
    try {
      result = await importArchive(b, await peekArchive(bytes), { me: 'replace', settings: 'replace' });
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    assert.equal(aborted, 1);
    assert.equal((await b.tx(['scopes'], 'readonly', (t) => t.listScopes())).filter((x) => x.kind === 'trip').length, 2);
    assert.equal(result.trips.length, 2, 'two trips stored, two listed');
    assert.equal(new Set(result.trips).size, 2);
    b.close();
  });

  test('idb: opening waits while another connection blocks an upgrade, instead of failing', async () => {
    const name = `annai-test-blocked-${Date.now()}`;
    await eraseDatabase(name);
    const old = await openDatabase(name);
    // An old connection with no versionchange handler, like a service worker mid-read.
    setTimeout(() => old.close(), 100);
    const upgraded = await openDatabase(name, DB_VERSION + 1);
    assert.equal(upgraded.version, DB_VERSION + 1);
    upgraded.close();
    await eraseDatabase(name);
  });

  test('idb: a version-1 database gains the blob-size index and keeps its blobs', async () => {
    const name = `annai-test-v1-${Date.now()}`;
    await eraseDatabase(name);
    // Version 1 exactly as milestone 1 shipped it, holding one photo.
    const v1 = await /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        /** @type {[string, string | string[]][]} */
        const stores = [['blobs', 'hash'], ['files', ['scope', 'path']], ['events', ['scope', 'seq']], ['secrets', 'id'], ['scopes', 'id']];
        for (const [store, keyPath] of stores) r.result.createObjectStore(store, { keyPath });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
    await new Promise((resolve, reject) => {
      const tx = v1.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ hash: 'abc', type: 'image/webp', size: 3, data: new Uint8Array([1, 2, 3]).buffer });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    v1.close();
    const s = await createIdbStore(name);
    assert.deepEqual(await s.tx(['blobs'], 'readonly', (t) => t.listBlobs()), [{ hash: 'abc', size: 3 }]);
    s.close();
    await eraseDatabase(name);
  });

  test('idb: a version-2 database gains the indexes and finds what its old records name', async () => {
    const name = `annai-test-v2-${Date.now()}`;
    await eraseDatabase(name);
    const v2 = await openDatabase(name, 2);
    await new Promise((resolve, reject) => {
      const tx = v2.transaction(['events', 'files'], 'readwrite');
      tx.objectStore('events').put({ scope: 'trip-1', seq: 1, ts: 1, type: 'tool.result', actor: 'system', refs: ['old-ref'] });
      tx.objectStore('files').put(rec);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    v2.close();
    const s = await createIdbStore(name);
    assert.deepEqual(await s.tx(['files', 'events'], 'readonly', async (t) => [await t.blobInUse('old-ref'), await t.blobInUse('h1'), await t.blobInUse('none')]), [true, true, false]);
    s.close();
    await eraseDatabase(name);
  });

  test('idb: a version-3 database gains the type index, and a query by type reads only entries of those types (A6)', async () => {
    const name = `annai-test-v3-${Date.now()}`;
    await eraseDatabase(name);
    const v3 = await openDatabase(name, 3);
    await new Promise((resolve, reject) => {
      const tx = v3.transaction(['events'], 'readwrite');
      const events = tx.objectStore('events');
      for (let i = 1; i <= 200; i++) events.put({ scope: 'trip-1', seq: i, ts: i, type: i % 50 === 0 ? 'trigger.fired' : 'location', actor: 'system', data: { i } });
      events.put({ scope: 'trip-2', seq: 1, ts: 1, type: 'trigger.fired', actor: 'system' });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    v3.close();
    const s = await createIdbStore(name);
    const read = { store: 0, index: 0 };
    const storeCursor = IDBObjectStore.prototype.openCursor;
    const indexCursor = IDBIndex.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = /** @type {any} */ (/** @this {any} */ function (/** @type {any[]} */ ...a) {
      read.store++;
      return storeCursor.apply(this, /** @type {any} */ (a));
    });
    IDBIndex.prototype.openCursor = /** @type {any} */ (/** @this {any} */ function (/** @type {any[]} */ ...a) {
      read.index++;
      return indexCursor.apply(this, /** @type {any} */ (a));
    });
    try {
      const fired = await s.tx(['events'], 'readonly', (t) => t.listEvents('trip-1', { types: ['trigger.fired'] }));
      assert.deepEqual(fired.map((e) => e.seq), [50, 100, 150, 200]);
      const last = await s.tx(['events'], 'readonly', (t) => t.listEvents('trip-1', { types: ['trigger.fired', 'nothing'], reverse: true, limit: 2, before: 200 }));
      assert.deepEqual(last.map((e) => e.seq), [150, 100]);
      assert.equal(read.store, 0, 'no walk through the whole log');
      assert.ok(read.index >= 2);
    } finally {
      IDBObjectStore.prototype.openCursor = storeCursor;
      IDBIndex.prototype.openCursor = indexCursor;
    }
    s.close();
    await eraseDatabase(name);
  });

  test('idb: an upgrade from any earlier version never rewrites or deletes a record (spec §4.6)', async () => {
    // A record in each store, with what the indexes added since read (refs, data.old and data.new, size, type).
    const put = {
      blobs: [{ hash: 'h1', type: 'image/webp', size: 3, data: new Uint8Array([1, 2, 3]).buffer }],
      files: [rec],
      events: [{ scope: 'trip-1', seq: 1, ts: 1, type: 'tool.result', actor: 'system', refs: ['h1'], data: { old: 'h0', new: 'h1', n: 7 } }],
      secrets: [{ id: 'key-1', value: 'abc' }],
      scopes: [{ id: 'trip-1', kind: 'trip', name: 'Tokyo' }],
    };
    for (let from = 1; from < DB_VERSION; from++) {
      const name = `annai-test-keep-v${from}-${Date.now()}`;
      await eraseDatabase(name);
      const old = await openDatabase(name, from);
      assert.equal(old.version, from);
      await new Promise((resolve, reject) => {
        const tx = old.transaction(Object.keys(put), 'readwrite');
        for (const [store, records] of Object.entries(put)) for (const r of records) tx.objectStore(store).put(r);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      old.close();
      (await createIdbStore(name)).close();
      const db = await openDatabase(name);
      assert.equal(db.version, DB_VERSION, `version ${from} was upgraded`);
      const tx = db.transaction(Object.keys(put), 'readonly');
      const got = await Promise.all(Object.keys(put).map((store) => new Promise((resolve, reject) => {
        const r = tx.objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      })));
      Object.values(put).forEach((records, i) => assert.deepEqual(got[i], records, `version ${from}, ${Object.keys(put)[i]}`));
      db.close();
      await eraseDatabase(name);
    }
  });

  test('idb: a closed store never opens the database again (a tab that stopped must not write)', async () => {
    const name = `annai-test-closed-${Date.now()}`;
    /** @type {IDBDatabase[]} */
    const connections = [];
    const s = await createIdbStore(name, { onOpen: (db) => connections.push(db) });
    s.close();
    await assert.rejects(s.tx(['files'], 'readwrite', (t) => t.putFile(rec)));
    assert.equal(connections.length, 1);
    await eraseDatabase(name);
  });

  // The store stops (another tab took annai over: main.js's onStolen; or Erase) while a write waits on its reopen. Before the stop was kept
  // where connections open, such a write landed, in both engines (storage-next's fix round, 2026-11-19). The reopen stops the store as it starts.
  for (const shape of /** @type {const} */ (['its connection was dropped', 'its first try lost the connection'])) {
    test(`idb: a write waiting on its reopen when the store stops (${shape}) rejects with StoppedError, writes nothing, and leaves no connection open`, async () => {
      const name = `annai-test-stop-${Date.now()}-${n++}`;
      await eraseDatabase(name);
      /** @type {IDBDatabase[]} */
      const connections = [];
      const s = await createIdbStore(name, { onOpen: (db) => connections.push(db) });
      const dropped = shape === 'its connection was dropped';
      if (dropped) {
        // What the browser does to a connection it drops (Safari, a page in the background): closes it and says so.
        connections[0].close();
        connections[0].dispatchEvent(new Event('close'));
      }
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = /** @type {any} */ (function (/** @type {any} */ ...a) {
        const r = open.apply(this, /** @type {any} */ (a));
        s.close();
        return r;
      });
      let runs = 0;
      const got = await s.tx(['files'], 'readwrite', async (t) => {
        runs++;
        // The error WebKit gives a transaction that was in flight when it dropped the connection.
        if (!dropped && runs === 1) throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
        await t.putFile(rec);
      }).then(() => null, (e) => e).finally(() => { IDBFactory.prototype.open = open; });
      assert.ok(got instanceof StoppedError, String(got));
      assert.equal(runs, dropped ? 0 : 1, 'nothing runs on the connection that opened after the stop');
      assert.equal(connections.length, 2, 'the reopen opened');
      for (const [i, c] of connections.entries()) {
        let closed = '';
        try {
          c.transaction(['files']);
        } catch (e) {
          closed = /** @type {any} */ (e).name;
        }
        assert.equal(closed, 'InvalidStateError', `connection ${i} is closed`);
      }
      const other = await createIdbStore(name); // the tab that took over
      assert.equal(await other.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')), undefined, 'the write did not land');
      other.close();
      await eraseDatabase(name);
    });
  }

  // A reopen that fails after the stop is the stop's own error (types.js, close): the open's (a full phone's, a version's) is nothing for a tab that has stopped to show.
  for (const name of /** @type {const} */ (['UnknownError', 'AbortError', 'VersionError', 'SecurityError'])) {
    test(`idb: a write whose reopen fails with ${name} after the store has stopped rejects with StoppedError, tried once`, async () => {
      const dbName = `annai-test-stop-fail-${Date.now()}-${n++}`;
      await eraseDatabase(dbName);
      const s = await createIdbStore(dbName);
      await eraseDatabase(dbName); // the connection is told to close, and does
      const open = IDBFactory.prototype.open;
      let opens = 0;
      IDBFactory.prototype.open = /** @type {any} */ (function () {
        opens++;
        s.close();
        /** @type {any} */
        const r = { error: new DOMException('The open failed.', name), result: undefined };
        setTimeout(() => r.onerror?.(new Event('error')));
        return r;
      });
      const got = await s.tx(['files'], 'readwrite', (t) => t.putFile(rec)).then(() => null, (e) => e).finally(() => { IDBFactory.prototype.open = open; });
      assert.ok(got instanceof StoppedError, String(got));
      assert.equal(opens, 1);
      await eraseDatabase(dbName);
    });
  }

  // Transactions that start while the connection is gone each open one; the first to open keeps the store's connection, and the others close theirs.
  // Before, the last kept it and the rest stayed open, which close() never reached (a phone that sleeps drops the connection with transactions in flight).
  test('idb: transactions waiting on one reopen keep one connection open between them, and closing the store closes it', async () => {
    const name = `annai-test-share-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    /** @type {IDBDatabase[]} */
    const connections = [];
    const s = await createIdbStore(name, { onOpen: (db) => connections.push(db) });
    await s.tx(['files'], 'readwrite', (t) => t.putFile(rec));
    connections[0].close(); // what the browser does to a connection it drops
    connections[0].dispatchEvent(new Event('close'));
    const got = await Promise.all([1, 2, 3].map(() => s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md'))));
    assert.deepEqual(got.map((f) => f?.hash), ['h1', 'h1', 'h1']);
    assert.equal(connections.length, 4, 'each waiting transaction opened one');
    const open = () => connections.filter((c) => {
      try {
        c.transaction(['files']);
        return true;
      } catch {
        return false;
      }
    }).length;
    assert.equal(open(), 1, 'one stays open');
    s.close();
    assert.equal(open(), 0, 'closing the store closed it');
    await eraseDatabase(name);
  });
}
