import { StorageFullError, StoppedError } from '../../src/core/errors.js';

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

  test('blobs: listBlobs gives every hash and size, not the content', async () => {
    const s = await makeStore();
    await s.tx(['blobs'], 'readwrite', async (t) => {
      await t.putBlob({ hash: 'b', type: 'image/webp', size: 5, data: buf('hello') });
      await t.putBlob({ hash: 'a', type: 'text/plain', size: 2, data: buf('hi') });
    });
    const list = await s.tx(['blobs'], 'readonly', (t) => t.listBlobs());
    assert.deepEqual([...list].sort((x, y) => (x.hash < y.hash ? -1 : 1)), [{ hash: 'a', size: 2 }, { hash: 'b', size: 5 }]);
  });

  test('blobInUse: a file, a log entry\'s refs, or a file version in a log entry names a blob', async () => {
    const s = await makeStore();
    await s.tx(['files', 'events'], 'readwrite', async (t) => {
      await t.putFile(file('trip-1', '/a.md', 'by-file'));
      await t.appendEvent('trip-1', { ts: 1, type: 'tool.result', actor: 'system', refs: ['by-ref-1', 'by-ref-2'] });
      await t.appendEvent('trip-2', { ts: 1, type: 'file.write', actor: 'user', data: { path: '/b.md', old: 'by-old', new: 'by-new' } });
    });
    const used = await s.tx(['files', 'events'], 'readonly', async (t) => Promise.all(['by-file', 'by-ref-2', 'by-old', 'by-new', 'nobody'].map((h) => t.blobInUse(h))));
    assert.deepEqual(used, [true, true, true, true, false]);
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobInUse('by-ref-1', { events: false })), false);
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobInUse('by-file', { events: false })), true);
    // Leaving one conversation out: only what names the blob elsewhere counts.
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobInUse('by-ref-1', { exceptScope: 'trip-1' })), false);
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobInUse('by-old', { exceptScope: 'trip-1' })), true);
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobInUse('by-file', { exceptScope: 'trip-1' })), true);
  });

  test('blobNamedIn: only what a file or a log entry of that one scope names (a read by hash for a trip, backlog-hash)', async () => {
    const s = await makeStore();
    await s.tx(['files', 'events'], 'readwrite', async (t) => {
      // Scopes on both sides of trip-m in key order, so a store that looks past them must still find trip-m's own.
      for (const scope of ['trip-a', 'trip-m', 'trip-z']) {
        await t.putFile(file(scope, '/shared.md', 'shared'));
        await t.appendEvent(scope, { ts: 1, type: 'tool.result', actor: 'system', refs: ['shared'] });
      }
      await t.putFile(file('trip-a', '/a.md', 'a-file'));
      await t.putFile(file('trip-m', '/m.md', 'm-file'));
      await t.putFile(file('trip-z', '/z.md', 'z-file'));
      await t.appendEvent('trip-a', { ts: 1, type: 'tool.result', actor: 'system', refs: ['a-ref'] });
      await t.appendEvent('trip-m', { ts: 1, type: 'tool.result', actor: 'system', refs: ['m-text', 'm-ref'] });
      await t.appendEvent('trip-m', { ts: 1, type: 'file.write', actor: 'user', data: { path: '/m.md', old: 'm-old', new: 'm-file' } });
      await t.appendEvent('trip-z', { ts: 1, type: 'file.write', actor: 'user', data: { path: '/z.md', old: 'z-old', new: 'z-file' } });
    });
    const named = (/** @type {string} */ h, /** @type {any} */ which) => s.tx(['files', 'events'], 'readonly', (t) => t.blobNamedIn(h, 'trip-m', which));
    const asked = ['shared', 'm-file', 'm-text', 'm-ref', 'm-old', 'a-file', 'a-ref', 'z-file', 'z-old', 'nobody'];
    assert.deepEqual(await Promise.all(asked.map((h) => named(h))), [true, true, true, true, true, false, false, false, false, false]);
    // Files alone: what the user's own files are, seen from a trip (spec §4.3).
    assert.deepEqual(await Promise.all(['m-file', 'm-ref', 'm-old'].map((h) => named(h, { events: false }))), [true, false, false]);
    // A scope with nothing, and an empty or missing hash, name nothing.
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobNamedIn('shared', 'trip-none')), false);
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobNamedIn('', 'trip-m')), false);
    assert.equal(await s.tx(['files', 'events'], 'readonly', (t) => t.blobNamedIn(/** @type {any} */ (undefined), 'trip-m')), false);
  });

  test('scopesWithData: each scope id that has files or log entries, once, in order, with a record or not', async () => {
    const s = await makeStore();
    await s.tx(['scopes', 'files', 'events'], 'readwrite', async (t) => {
      await t.putFile(file('trip-b', '/a.md'));
      await t.putFile(file('trip-b', '/z.md'));
      for (let i = 0; i < 3; i++) await t.appendEvent('trip-b', { ts: i, type: 'x', actor: 'user' });
      await t.appendEvent('trip-a', { ts: 1, type: 'x', actor: 'user' });
      await t.putFile(file('trip-c', '/only-a-file.md'));
      await t.putScope(scopeRec('trip-d')); // a record and nothing else
    });
    assert.deepEqual(await s.tx(['files', 'events'], 'readonly', (t) => t.scopesWithData()), ['trip-a', 'trip-b', 'trip-c']);
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
    assert.deepEqual((await q({ notTypes: ['odd'], reverse: true, limit: 2 })).map((e) => e.seq), [6, 4]);
    assert.deepEqual((await q({ notTypes: ['odd', 'even'] })).map((e) => e.seq), []);
    assert.deepEqual((await q({ after: 6 })).map((e) => e.seq), []);
    assert.deepEqual((await q({ after: 5, before: 3 })).map((e) => e.seq), []);
  });

  test('events: listEvents by several types merges them in order, with after, before, limit, reverse and notTypes', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      const kinds = ['a', 'b', 'c'];
      for (let i = 1; i <= 9; i++) await t.appendEvent('x', { ts: i, type: kinds[i % 3], actor: 'user' }); // 1 b, 2 c, 3 a, 4 b, 5 c, 6 a, 7 b, 8 c, 9 a
      await t.appendEvent('y', { ts: 1, type: 'a', actor: 'user' });
    });
    const q = (/** @type {any} */ query) => s.tx(['events'], 'readonly', (t) => t.listEvents('x', query));
    assert.deepEqual((await q({ types: ['a', 'b'] })).map((e) => e.seq), [1, 3, 4, 6, 7, 9]);
    assert.deepEqual((await q({ types: ['b', 'a'], reverse: true, limit: 3 })).map((e) => e.seq), [9, 7, 6]);
    assert.deepEqual((await q({ types: ['a', 'b'], after: 3, before: 9 })).map((e) => e.seq), [4, 6, 7]);
    assert.deepEqual((await q({ types: ['a', 'b'], notTypes: ['b'] })).map((e) => e.seq), [3, 6, 9]);
    assert.deepEqual((await q({ types: ['a', 'a'], limit: 2 })).map((e) => e.seq), [3, 6]);
    assert.deepEqual((await q({ types: ['none'] })).map((e) => e.seq), []);
    assert.deepEqual((await q({ types: [] })).map((e) => e.seq), []);
  });

  test('events: a type read without a limit gives every entry, in order, among many others', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      for (let i = 1; i <= 1500; i++) await t.appendEvent('x', { ts: i, type: i % 3 ? 'location' : 'wake', actor: 'system', data: { i } });
    });
    const q = (/** @type {any} */ query) => s.tx(['events'], 'readonly', (t) => t.listEvents('x', query));
    const points = await q({ types: ['location'] });
    assert.equal(points.length, 1000);
    assert.ok(points.every((e, i) => i === 0 || e.seq > points[i - 1].seq));
    assert.equal(points[0].data.i, 1);
    const back = await q({ types: ['location', 'wake'], reverse: true, after: 1400 });
    assert.deepEqual(back.slice(0, 3).map((e) => e.seq), [1500, 1499, 1498]);
    assert.equal(back.length, 100);
  });

  test('events: putEvent keeps its seq and appendEvent continues after it', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', (t) => t.putEvent({ scope: 'a', seq: 41, ts: 1, type: 'x', actor: 'user' }));
    const next = await s.tx(['events'], 'readwrite', (t) => t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' }));
    assert.equal(next.seq, 42);
  });

  test('events: deleteEvent removes one entry, from every index', async () => {
    const s = await makeStore();
    await s.tx(['events'], 'readwrite', async (t) => {
      await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' });
      await t.appendEvent('a', { ts: 2, type: 'file.write', actor: 'user', data: { path: '/p', old: null, new: 'h-new' }, refs: ['h-ref'] });
      await t.appendEvent('a', { ts: 3, type: 'x', actor: 'user' });
      await t.appendEvent('b', { ts: 1, type: 'file.write', actor: 'user' });
    });
    await s.tx(['events'], 'readwrite', (t) => t.deleteEvent('a', 2));
    await s.tx(['events'], 'readwrite', (t) => t.deleteEvent('a', 99)); // nothing there: no error
    const got = await s.tx(['files', 'events'], 'readonly', async (t) => ({
      seqs: (await t.listEvents('a')).map((e) => e.seq),
      typed: (await t.listEvents('a', { types: ['file.write'] })).length,
      b: (await t.listEvents('b')).length,
      used: [await t.blobInUse('h-new'), await t.blobInUse('h-ref')],
    }));
    assert.deepEqual(got, { seqs: [1, 3], typed: 0, b: 1, used: [false, false] });
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

  test('tx: a closed store refuses every transaction from then on', async () => {
    const s = await makeStore();
    await s.tx(['files'], 'readwrite', (t) => t.putFile(file('trip-1', '/a.md')));
    s.close();
    await assert.rejects(s.tx(['files'], 'readonly', (t) => t.listFiles('trip-1')), StoppedError);
    await assert.rejects(s.tx(['files'], 'readwrite', (t) => t.putFile(file('trip-1', '/b.md'))), StoppedError);
  });
}
