import { StorageFullError } from '../../src/core/errors.js';

/**
 * Behaviour every Store must have. Runs under node:test against the memory
 * store and in browsers against IndexedDB (test/browser/suites/store-idb.js).
 * Uses only assert.equal, assert.deepEqual, assert.ok and assert.rejects.
 * @param {(name: string, fn: () => Promise<void>) => void} test
 * @param {any} assert
 * @param {() => Promise<import('../../src/core/types.js').Store>} makeStore  returns a fresh, empty store
 */
export function storeContract(test, assert, makeStore) {
  const buf = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;
  const str = (/** @type {ArrayBuffer} */ b) => new TextDecoder().decode(b);
  const file = (/** @type {string} */ scope, /** @type {string} */ path, hash = 'h1') =>
    ({ scope, path, hash, size: 1, type: 'text/plain', author: 'user', created: 1, modified: 2 });
  const scopeRec = (/** @type {string} */ id) =>
    ({ id, kind: /** @type {const} */ ('trip'), title: id, status: /** @type {const} */ ('active'), created: 1, updated: 1, format: 1 });

  test('blobs: put, has, get and delete', async () => {
    const s = await makeStore();
    await s.tx(['blobs'], 'readwrite', (t) => t.putBlob({ hash: 'abc', type: 'text/plain', size: 2, data: buf('hi') }));
    const got = await s.tx(['blobs'], 'readonly', async (t) => ({
      has: await t.hasBlob('abc'), missing: await t.hasBlob('zzz'), rec: await t.getBlob('abc'),
    }));
    assert.equal(got.has, true);
    assert.equal(got.missing, false);
    assert.ok(got.rec);
    assert.equal(str(/** @type {any} */ (got.rec).data), 'hi');
    assert.equal(/** @type {any} */ (got.rec).type, 'text/plain');
    await s.tx(['blobs'], 'readwrite', (t) => t.deleteBlob('abc'));
    assert.equal(await s.tx(['blobs'], 'readonly', (t) => t.getBlob('abc')), undefined);
  });

  test('files: list by prefix in path order, scoped, and delete', async () => {
    const s = await makeStore();
    await s.tx(['files'], 'readwrite', async (t) => {
      for (const p of ['/plan/b.json', '/notes/a.md', '/plan/a.json', '/trip.json']) await t.putFile(file('trip-1', p));
      await t.putFile(file('trip-2', '/plan/z.json'));
    });
    const all = await s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1', '/'));
    assert.deepEqual(all.map((f) => f.path), ['/notes/a.md', '/plan/a.json', '/plan/b.json', '/trip.json']);
    const plan = await s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1', '/plan/'));
    assert.deepEqual(plan.map((f) => f.path), ['/plan/a.json', '/plan/b.json']);
    const one = await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/trip.json'));
    assert.equal(/** @type {any} */ (one)?.hash, 'h1');
    await s.tx(['files'], 'readwrite', (t) => t.deleteFile('trip-1', '/trip.json'));
    assert.equal(await s.tx(['files'], 'readonly', (t) => t.getFile('trip-1', '/trip.json')), undefined);
  });

  test('events: appendEvent numbers each scope from 1', async () => {
    const s = await makeStore();
    const seqs = await s.tx(['events'], 'readwrite', async (t) => [
      (await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' })).seq,
      (await t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' })).seq,
      (await t.appendEvent('b', { ts: 3, type: 'x', actor: 'user' })).seq,
    ]);
    assert.deepEqual(seqs, [1, 2, 1]);
    assert.equal(await s.tx(['events'], 'readonly', (t) => t.lastSeq('a')), 2);
    assert.equal(await s.tx(['events'], 'readonly', (t) => t.lastSeq('none')), 0);
  });

  test('events: listEvents with after, before, limit, reverse and types', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      for (let i = 1; i <= 6; i++) await t.appendEvent('a', { ts: i, type: i % 2 ? 'odd' : 'even', actor: 'user', data: { i } });
    });
    const q = (/** @type {any} */ query) => s.tx(['events'], 'readonly', (t) => t.listEvents('a', query));
    assert.deepEqual((await q({})).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual((await q({ after: 2, before: 6 })).map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual((await q({ reverse: true, limit: 2 })).map((e) => e.seq), [6, 5]);
    assert.deepEqual((await q({ types: ['even'], reverse: true, limit: 2 })).map((e) => e.seq), [6, 4]);
    assert.deepEqual((await q({ after: 6 })).map((e) => e.seq), []);
    assert.deepEqual((await q({ after: 5, before: 3 })).map((e) => e.seq), []);
  });

  test('events: putEvent keeps its seq and appendEvent continues after it', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', (t) => t.putEvent({ scope: 'a', seq: 41, ts: 1, type: 'x', actor: 'user' }));
    const next = await s.tx(['events'], 'readwrite', (t) => t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' }));
    assert.equal(next.seq, 42);
  });

  test('scopes: put, get, list; deleteScope removes only that scope', async () => {
    const s = await makeStore();
    await s.tx(['scopes', 'files', 'events'], 'readwrite', async (t) => {
      for (const id of ['trip-1', 'trip-2']) {
        await t.putScope(scopeRec(id));
        await t.putFile(file(id, '/a.md'));
        await t.appendEvent(id, { ts: 1, type: 'x', actor: 'user' });
      }
    });
    await s.tx(['scopes', 'files', 'events'], 'readwrite', (t) => t.deleteScope('trip-1'));
    const left = await s.tx(['scopes', 'files', 'events'], 'readonly', async (t) => ({
      scopes: (await t.listScopes()).map((x) => x.id),
      files1: await t.listFiles('trip-1'), files2: await t.listFiles('trip-2'),
      events1: await t.listEvents('trip-1'), events2: await t.listEvents('trip-2'),
      gone: await t.getScope('trip-1'),
    }));
    assert.deepEqual(left.scopes, ['trip-2']);
    assert.equal(left.files1.length, 0);
    assert.equal(left.files2.length, 1);
    assert.equal(left.events1.length, 0);
    assert.equal(left.events2.length, 1);
    assert.equal(left.gone, undefined);
  });

  test('secrets: put, get, list ids and delete', async () => {
    const s = await makeStore();
    await s.tx(['secrets'], 'readwrite', async (t) => {
      await t.putSecret('openrouter', { key: 'sk-1' });
      await t.putSecret('anthropic', 'sk-2');
    });
    assert.deepEqual(await s.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['anthropic', 'openrouter']);
    assert.deepEqual(await s.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), { key: 'sk-1' });
    await s.tx(['secrets'], 'readwrite', (t) => t.deleteSecret('openrouter'));
    assert.equal(await s.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), undefined);
  });

  test('tx: a transaction that throws writes nothing', async () => {
    const s = await makeStore();
    await assert.rejects(s.tx(['files', 'events'], 'readwrite', async (t) => {
      await t.putFile(file('trip-1', '/a.md'));
      await t.appendEvent('trip-1', { ts: 1, type: 'file.write', actor: 'user' });
      throw new Error('boom');
    }));
    const left = await s.tx(['files', 'events'], 'readonly', async (t) => [await t.listFiles('trip-1'), await t.listEvents('trip-1')]);
    assert.deepEqual(left, [[], []]);
  });

  test('tx: returns the value of fn; read-only and out-of-scope access fail', async () => {
    const s = await makeStore();
    assert.equal(await s.tx(['files'], 'readonly', async () => 42), 42);
    await assert.rejects(s.tx(['files'], 'readonly', (t) => t.putFile(file('trip-1', '/a.md'))));
    await assert.rejects(s.tx(['files'], 'readonly', (t) => t.getBlob('x')));
  });

  test('tx: running out of space rejects with StorageFullError and writes nothing', async () => {
    const s = await makeStore();
    await assert.rejects(s.tx(['files'], 'readwrite', async (t) => {
      await t.putFile(file('trip-1', '/a.md'));
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }), StorageFullError);
    assert.deepEqual(await s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1')), []);
  });
}
