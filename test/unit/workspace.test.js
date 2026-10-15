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
