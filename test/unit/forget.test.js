import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { forget } from '../../src/core/forget.js';
import { record } from '../../src/core/agent/log.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}
const stored = async (/** @type {any} */ store, /** @type {string} */ s) => {
  const hash = await sha256Hex(utf8(s));
  return store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.hasBlob(hash));
};
const inTides = (/** @type {string} */ p) => p.startsWith('/tides/');

test('forget: files under a prefix go with their whole history, and the space their content took comes back', async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v1 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v2 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/notes.md', 'notes', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/other/index.js', 'other code', { author: 'system' });
  const r = await forget(store, SYS_PLUGINS, { files: inTides, history: inTides });
  assert.deepEqual(r, { files: 2, events: 3, bytes: 'v1 code'.length + 'v2 code'.length + 'notes'.length });
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/')).map((f) => f.path), ['/other/index.js']);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tides/index.js'), []);
  assert.equal(await stored(store, 'v1 code'), false);
  assert.equal(await stored(store, 'other code'), true);
});

test('forget: content something else still names stays', async () => {
  const { store, ws } = await setup();
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(SYS_PLUGINS, '/tides/table.md', 'shared', { author: 'system' });
  await ws.write(trip, '/notes/table.md', 'shared', { author: 'user' });
  const r = await forget(store, SYS_PLUGINS, { files: inTides, history: inTides });
  assert.equal(r.bytes, 0);
  assert.equal(await ws.readText(trip, '/notes/table.md'), 'shared');
});

test('forget: history alone drops the old versions and keeps the current files', async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v1 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v2 code', { author: 'system' });
  const r = await forget(store, SYS_PLUGINS, { history: inTides });
  assert.deepEqual(r, { files: 0, events: 2, bytes: 'v1 code'.length });
  assert.equal(await ws.readText(SYS_PLUGINS, '/tides/index.js'), 'v2 code');
});

test('forget: log entries that match go, with the content only they named', async () => {
  const { store } = await setup();
  await record(store, SYS, { type: 'tides.cache', actor: 'plugin:tides', data: {}, texts: [['table', 'x'.repeat(3000)]] });
  await record(store, SYS, { type: 'plugin.error', actor: 'plugin:tides', data: { message: 'boom' } });
  const r = await forget(store, SYS, { events: (e) => e.actor === 'plugin:tides' && Boolean(e.refs?.length) });
  assert.deepEqual(r, { files: 0, events: 1, bytes: 3000 });
  assert.deepEqual((await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS))).map((e) => e.type), ['plugin.error']);
});

test('forget: nothing that matches changes nothing', async () => {
  const { store } = await setup();
  assert.deepEqual(await forget(store, SYS_PLUGINS, { files: inTides, history: inTides }), { files: 0, events: 0, bytes: 0 });
});

test("forget reads only the content it frees, never a list of every blob there is: a push sync's forget stays quick beside thousands of photos", async () => {
  const { store, ws } = await setup();
  const trip = await createTrip(ws, { title: 'Big Sur' });
  for (let i = 0; i < 50; i++) await ws.write(trip, `/files/p${i}.jpg`, new Uint8Array([0, i, 1, 2]), { author: 'user' });
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v1 code', { author: 'system' });
  await ws.write(SYS_PLUGINS, '/tides/index.js', 'v2 code', { author: 'system' });
  let listed = 0;
  /** @type {any} the store, counting listBlobs */
  const spied = {
    ...store,
    tx: (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => store.tx(stores, mode, (t) => fn(new Proxy(t, {
      get: (o, k) => (k === 'listBlobs' ? () => { listed++; return o.listBlobs(); } : /** @type {any} */ (o)[k]),
    }))),
  };
  const r = await forget(spied, SYS_PLUGINS, { history: inTides });
  assert.deepEqual(r, { files: 0, events: 2, bytes: 'v1 code'.length });
  assert.equal(listed, 0);
  assert.equal(await stored(store, 'v1 code'), false);
});
