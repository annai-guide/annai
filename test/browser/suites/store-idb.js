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
}
