import { storeContract } from '../../contract/store-contract.js';
import { createIdbStore, eraseDatabase, openDatabase, DB_VERSION } from '../../../src/core/store-idb.js';

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  let n = 0;
  const fresh = async () => {
    const name = `annai-test-${Date.now()}-${n++}`;
    await eraseDatabase(name);
    return createIdbStore(name);
  };
  storeContract(test, assert, fresh);

  const rec = { scope: 'trip-1', path: '/a.md', hash: 'h1', size: 1, type: 'text/plain', author: 'user', created: 1, modified: 1 };

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
