import { storeContract } from '../../contract/store-contract.js';
import { createIdbStore, eraseDatabase, openDatabase, DB_VERSION } from '../../../src/core/store-idb.js';
import { storedTexts } from '../../../src/core/agent/log.js';
import { forget } from '../../../src/core/forget.js';
import { Workspace } from '../../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../../src/core/scopes.js';
import { snapshot } from '../../contract/snapshot.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../../src/core/archive.js';
import { StorageFullError } from '../../../src/core/errors.js';

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

  // A full disk, as the probe of 2026-11-19 measured it: WebKit and Chromium answer every request, then abort the commit (WebKit with no
  // error, Chromium with a DataError for its blob files). Faked here by aborting a transaction once all of annai's requests have succeeded.
  /**
   * A store whose next transactions the browser aborts at their commit, with `error` as the transaction's error, each counted.
   * @param {string} mode @param {DOMException | null} error
   */
  const refusing = async (mode, error) => {
    const name = `annai-test-full-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    const at = { aborts: 0, on: true };
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

  for (const [engine, error] of /** @type {const} */ ([['WebKit', null], ['Chromium', new DOMException('Failed to write blobs (IOError)', 'DataError')]])) {
    test(`idb: a write the browser aborts after every request in it succeeded (${engine}'s full disk) rejects with StorageFullError and writes nothing`, async () => {
      const { s, at } = await refusing('readwrite', error);
      let runs = 0;
      const got = await s.tx(['files'], 'readwrite', async (t) => {
        runs++;
        await t.putFile(rec);
      }).then(() => null, (e) => e);
      at.on = false;
      assert.ok(got instanceof StorageFullError, String(got));
      assert.equal(got.cause?.name, error ? 'DataError' : 'AbortError');
      // WebKit's has no error: it can be a lost connection, so it is tried once more first; a DataError isn't.
      assert.equal(runs, error ? 1 : 2);
      assert.equal(at.aborts, runs);
      assert.equal(await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/a.md')), undefined);
      s.close();
    });
  }

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
    // Chromium's backing store writes as it opens: at its last bytes it can't, for a read too.
    test(`idb: a ${mode} transaction whose reopen for its one more try fails with UnknownError (Chromium at its last bytes) rejects with StorageFullError`, async () => {
      const s = await fresh();
      const b = abortNext(mode === 'readwrite' ? 'put' : 'get', 1);
      const open = IDBFactory.prototype.open;
      let opens = 0;
      // The connection the abort left is closed by the retry; reopening it, Chromium's backing store can't be opened.
      IDBFactory.prototype.open = /** @type {any} */ (function () {
        opens++;
        /** @type {any} */
        const r = { error: new DOMException('Internal error opening backing store for indexedDB.open.', 'UnknownError'), result: undefined };
        setTimeout(() => r.onerror?.(new Event('error')));
        return r;
      });
      const got = await s.tx(['files'], mode, async (t) => { await (mode === 'readwrite' ? t.putFile(rec) : t.getFile('trip-1', '/a.md')); }).then(() => null, (e) => e);
      IDBFactory.prototype.open = open;
      b.heal();
      assert.equal(opens, 1);
      assert.ok(got instanceof StorageFullError, String(got));
      assert.equal(got.cause?.name, 'UnknownError');
      s.close();
    });
  }

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
}
