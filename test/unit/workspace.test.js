import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError, NotFoundError, StorageFullError } from '../../src/core/workspace.js';
import { PathError } from '../../src/core/paths.js';
import { sha256Hex } from '../../src/core/hash.js';

const PLAN = { type: 'object', required: ['id', 'title', 'fixed'], properties: { id: { type: 'string' }, title: { type: 'string' }, fixed: { type: 'boolean' } } };

async function setup(store = createMemoryStore()) {
  await store.tx(['scopes'], 'readwrite', (t) => t.putScope({ id: 'trip-1', kind: 'trip', title: 'T', status: 'active', created: 0, updated: 0, format: 1 }));
  let clock = 1000;
  const ws = new Workspace(store, {
    now: () => ++clock,
    schemaFor: (scope, path) => (path.startsWith('/plan/') ? PLAN : null),
  });
  return { ws, store };
}

test('write then read text, with entry metadata and a file.write event', async () => {
  const { ws, store } = await setup();
  const entry = await ws.write('trip-1', 'notes/day1.md', '# Day 1', { author: 'user' });
  assert.equal(entry.path, '/notes/day1.md');
  assert.equal(entry.type, 'text/markdown');
  assert.equal(entry.size, 7);
  assert.equal(entry.author, 'user');
  assert.equal(entry.hash, await sha256Hex('# Day 1'));
  assert.equal(await ws.readText('trip-1', '/notes/day1.md'), '# Day 1');
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'));
  assert.deepEqual(events.map((e) => [e.type, e.data.path, e.data.old]), [['file.write', '/notes/day1.md', null]]);
});

test('objects are stored as pretty JSON with a trailing newline', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'Dinner', fixed: true }, { author: 'shiori' });
  assert.equal(await ws.readText('trip-1', '/plan/a.json'), '{\n  "id": "a",\n  "title": "Dinner",\n  "fixed": true\n}\n');
  assert.deepEqual(await ws.readJSON('trip-1', '/plan/a.json'), { id: 'a', title: 'Dinner', fixed: true });
});

test('writing identical content adds no event', async () => {
  const { ws, store } = await setup();
  await ws.write('trip-1', '/a.md', 'same', { author: 'user' });
  await ws.write('trip-1', '/a.md', 'same', { author: 'user' });
  assert.equal((await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'))).length, 1);
});

test('history, restore and delete keep every version', async () => {
  const { ws } = await setup();
  const v1 = await ws.write('trip-1', '/a.md', 'one', { author: 'user' });
  await ws.write('trip-1', '/a.md', 'two', { author: 'shiori' });
  await ws.restore('trip-1', '/a.md', v1.hash, { author: 'user' });
  assert.equal(await ws.readText('trip-1', '/a.md'), 'one');
  await ws.delete('trip-1', '/a.md', { author: 'user' });
  assert.equal(await ws.read('trip-1', '/a.md'), undefined);
  const h = await ws.history('trip-1', '/a.md');
  assert.deepEqual(h.map((x) => [x.type, x.actor]), [['file.write', 'user'], ['file.write', 'shiori'], ['file.write', 'user'], ['file.delete', 'user']]);
  await ws.restore('trip-1', '/a.md', h[1].new, { author: 'user' });
  assert.equal(await ws.readText('trip-1', '/a.md'), 'two');
});

test('invalid JSON and schema violations are refused and write nothing', async () => {
  const { ws, store } = await setup();
  await assert.rejects(ws.write('trip-1', '/plan/a.json', '{oops', { author: 'user' }), (e) => e instanceof ValidationError && /not valid JSON/.test(e.errors[0]));
  await assert.rejects(ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'x' }, { author: 'user' }), (e) => e instanceof ValidationError && e.errors[0] === '$.fixed: is required');
  assert.equal((await ws.list('trip-1')).length, 0);
  assert.equal((await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'))).length, 0);
});

test('patch merges into JSON; patching a missing file fails', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'Dinner', fixed: false }, { author: 'user' });
  await ws.patch('trip-1', '/plan/a.json', { fixed: true, notes: 'window table' }, { author: 'shiori' });
  assert.deepEqual(await ws.readJSON('trip-1', '/plan/a.json'), { id: 'a', title: 'Dinner', fixed: true, notes: 'window table' });
  await assert.rejects(ws.patch('trip-1', '/plan/missing.json', { a: 1 }, { author: 'user' }), NotFoundError);
});

test('concurrent patches to one file both apply', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'T', fixed: false }, { author: 'user' });
  await Promise.all([
    ws.patch('trip-1', '/plan/a.json', { x: 1 }, { author: 'user' }),
    ws.patch('trip-1', '/plan/a.json', { y: 2 }, { author: 'user' }),
  ]);
  const v = await ws.readJSON('trip-1', '/plan/a.json');
  assert.equal(v.x, 1);
  assert.equal(v.y, 2);
});

test('unknown scopes and bad paths are refused', async () => {
  const { ws } = await setup();
  await assert.rejects(ws.write('trip-404', '/a.md', 'x', { author: 'user' }), NotFoundError);
  await assert.rejects(ws.write('trip-1', '/a/../b.md', 'x', { author: 'user' }), PathError);
});

test('list returns files under a prefix', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/notes/a.md', 'a', { author: 'user' });
  await ws.write('trip-1', '/plan/a.json', { id: 'a', title: 'T', fixed: true }, { author: 'user' });
  assert.deepEqual((await ws.list('trip-1', '/notes/')).map((f) => f.path), ['/notes/a.md']);
});

test('binary content keeps its bytes and declared type', async () => {
  const { ws } = await setup();
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const entry = await ws.write('trip-1', '/files/photo.jpg', bytes, { author: 'user' });
  assert.equal(entry.type, 'image/jpeg');
  assert.deepEqual([...(/** @type {any} */ (await ws.read('trip-1', '/files/photo.jpg'))).bytes], [...bytes]);
});

test('onChange runs after commits, and listener errors do not fail the write', async () => {
  const { ws } = await setup();
  /** @type {string[]} */
  const seen = [];
  ws.onChange((c) => { seen.push(`${c.op} ${c.path}`); });
  ws.onChange(() => { throw new Error('listener broke'); });
  await ws.write('trip-1', '/a.md', 'x', { author: 'user' });
  await ws.delete('trip-1', '/a.md', { author: 'user' });
  assert.deepEqual(seen, ['write /a.md', 'delete /a.md']);
});

test('storage full maps to StorageFullError and writes nothing', async () => {
  const inner = createMemoryStore();
  /** @type {import('../../src/core/types.js').Store} */
  const full = {
    close() {},
    tx(stores, mode, fn) {
      return inner.tx(stores, mode, (t) => fn({ ...t, putBlob: async () => { throw new DOMException('no space', 'QuotaExceededError'); } }));
    },
  };
  const { ws } = await setup(full);
  await assert.rejects(ws.write('trip-1', '/a.md', 'x', { author: 'user' }), StorageFullError);
  assert.equal((await ws.list('trip-1')).length, 0);
});

test('a name in decomposed Unicode (as macOS writes it) and the same name typed are one file', async () => {
  const { ws } = await setup();
  const typed = '/files/ガイド.md';
  const fromMac = typed.normalize('NFD');
  assert.notEqual(fromMac, typed);
  await ws.write('trip-1', fromMac, 'from a Mac', { author: 'user' });
  assert.equal(await ws.readText('trip-1', typed), 'from a Mac');
  assert.deepEqual((await ws.list('trip-1', '/files/')).map((f) => f.path), [typed]);
});

test('saving content that has not changed leaves the trip where it is in Trips', async () => {
  const { ws, store } = await setup();
  await ws.write('trip-1', '/a.md', 'same', { author: 'user' });
  const updated = async () => (await store.tx(['scopes'], 'readonly', (t) => t.getScope('trip-1')))?.updated;
  const before = await updated();
  await ws.write('trip-1', '/a.md', 'same', { author: 'user' });
  assert.equal(await updated(), before);
});

test('restoring a version gives the file the type it had, not the type of a twin with the same bytes', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/n.md', 'x', { author: 'user' });
  const first = await ws.write('trip-1', '/n.txt', 'x', { author: 'user' }); // same bytes, so the blob is shared
  await ws.write('trip-1', '/n.txt', 'y', { author: 'user' });
  assert.equal((await ws.restore('trip-1', '/n.txt', first.hash, { author: 'user' })).type, 'text/plain');
  const photo = await ws.write('trip-1', '/files/p', new Uint8Array([1]), { author: 'user', type: 'image/heic' });
  await ws.write('trip-1', '/files/p', new Uint8Array([2]), { author: 'user', type: 'image/heic' });
  assert.equal((await ws.restore('trip-1', '/files/p', photo.hash, { author: 'user' })).type, 'image/heic');
});

test('patch can create a missing file, and two first patches at once both apply', async () => {
  const { ws } = await setup();
  await Promise.all([
    ws.patch('trip-1', '/s.json', { a: 1 }, { author: 'system', create: true }),
    ws.patch('trip-1', '/s.json', { b: 2 }, { author: 'system', create: true }),
  ]);
  assert.deepEqual(await ws.readJSON('trip-1', '/s.json'), { a: 1, b: 2 });
});

test('writeMany writes and deletes several files in one transaction', async () => {
  const { ws, store } = await setup();
  await ws.write('trip-1', '/old.md', 'old', { author: 'user' });
  /** @type {any[]} */
  const seen = [];
  ws.onChange((c) => { seen.push([c.op, c.path]); });
  await ws.writeMany('trip-1', [
    { path: 'a.md', content: 'a' },
    { path: '/b.json', content: { x: 1 } },
    { path: '/old.md', content: null },
  ], { author: 'system' });
  assert.deepEqual((await ws.list('trip-1')).map((f) => f.path), ['/a.md', '/b.json']);
  assert.deepEqual(await ws.readJSON('trip-1', '/b.json'), { x: 1 });
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1'));
  assert.deepEqual(events.slice(1).map((e) => [e.type, e.data.path]), [['file.write', '/a.md'], ['file.write', '/b.json'], ['file.delete', '/old.md']]);
  assert.deepEqual(seen, [['write', '/a.md'], ['write', '/b.json'], ['delete', '/old.md']]);
  await assert.rejects(ws.writeMany('trip-1', [{ path: '/c.md', content: 'c' }, { path: '/plan/x.json', content: { id: 'x' } }], { author: 'user' }), ValidationError);
  await assert.rejects(ws.writeMany('trip-1', [{ path: '/c.md', content: 'c' }, { path: '/missing.md', content: null }], { author: 'user' }), NotFoundError);
  assert.equal(await ws.read('trip-1', '/c.md'), undefined);
});

test('writeMany is all or nothing when storage runs out partway', async () => {
  const inner = createMemoryStore();
  let blobs = 0;
  /** @type {import('../../src/core/types.js').Store} */
  const filling = {
    close() {},
    tx(stores, mode, fn) {
      return inner.tx(stores, mode, (t) => fn({ ...t, putBlob: async (rec) => {
        if (++blobs === 2) throw new DOMException('no space', 'QuotaExceededError');
        return t.putBlob(rec);
      } }));
    },
  };
  const { ws } = await setup(filling);
  await assert.rejects(ws.writeMany('trip-1', [{ path: '/a.md', content: 'a' }, { path: '/b.md', content: 'b' }], { author: 'user' }), StorageFullError);
  assert.deepEqual(await ws.list('trip-1'), []);
});

test('photos keep when and where they were taken, and a restored version keeps it too', async () => {
  const { ws } = await setup();
  const meta = { width: 48, height: 64, taken: '2026-11-26T19:04:12-08:00', place: { lat: 36.2219, lng: -121.7598 } };
  const first = await ws.write('trip-1', '/files/a.webp', new Uint8Array([1]), { author: 'user', type: 'image/webp', meta });
  assert.deepEqual(first.meta, meta);
  assert.deepEqual((await ws.read('trip-1', '/files/a.webp'))?.entry.meta, meta);
  await ws.write('trip-1', '/files/a.webp', new Uint8Array([2]), { author: 'user', type: 'image/webp', meta });
  assert.deepEqual((await ws.restore('trip-1', '/files/a.webp', first.hash, { author: 'user' })).meta, meta);
  const note = await ws.write('trip-1', '/notes/a.md', 'x', { author: 'user' });
  assert.equal('meta' in note, false);
});

test('a guard on a JSON write sees what is stored and what would be, read as the format check reads it, inside the path lock', async () => {
  const { ws } = await setup();
  await ws.write('trip-1', '/x.json', { a: 1 }, { author: 'user' });
  /** @type {any[]} */
  const seen = [];
  const guard = (/** @type {any} */ before, /** @type {any} */ next) => { seen.push([before, next]); return { ...next, guarded: true }; };
  // A byte-order mark, which the format check reads past, is read past here too.
  const first = ws.write('trip-1', '/x.json', '﻿{"a":3}', { author: 'shiori', guard });
  const second = ws.patch('trip-1', '/x.json', { b: 2 }, { author: 'shiori', guard });
  await Promise.all([first, second]);
  assert.deepEqual(seen, [[{ a: 1 }, { a: 3 }], [{ a: 3, guarded: true }, { a: 3, guarded: true, b: 2 }]]);
  assert.deepEqual(await ws.readJSON('trip-1', '/x.json'), { a: 3, guarded: true, b: 2 });
  // A guard that throws writes nothing.
  await assert.rejects(ws.write('trip-1', '/x.json', { a: 9 }, { author: 'shiori', guard: () => { throw new Error('no'); } }), /no/);
  assert.equal((await ws.readJSON('trip-1', '/x.json')).a, 3);
});

test('a write, patch, delete or writeMany given a hand-over records it on its log entry; one given none has no such key', async () => {
  const { ws, store } = await setup();
  const s = 'trip-1';
  await ws.write(s, '/a.md', 'x', { author: 'shiori', handover: 'h-1' });
  await ws.patch(s, '/b.json', { y: 1 }, { author: 'shiori', create: true, handover: 'h-1' });
  await ws.delete(s, '/a.md', { author: 'shiori', handover: 'h-1' });
  await ws.writeMany(s, [{ path: '/d.md', content: 'd' }, { path: '/b.json', content: null }], { author: 'shiori', handover: 'h-2' });
  await ws.write(s, '/c.md', 'z', { author: 'user' });
  const ev = await store.tx(['events'], 'readonly', (t) => t.listEvents(s, { types: ['file.write', 'file.delete'] }));
  assert.deepEqual(ev.map((e) => e.data.handover ?? null), ['h-1', 'h-1', 'h-1', 'h-2', 'h-2', null]);
  assert.equal('handover' in ev.at(-1).data, false);
});
