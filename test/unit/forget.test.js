import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, backupState, SYS, SYS_PLUGINS, ME } from '../../src/core/scopes.js';
import { forget } from '../../src/core/forget.js';
import { record } from '../../src/core/agent/log.js';
import { resolveEvent } from '../../src/core/agent/transcript.js';
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
  assert.deepEqual(r, { files: 2, events: 3, kept: null, bytes: 'v1 code'.length + 'v2 code'.length + 'notes'.length });
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
  assert.deepEqual(r, { files: 0, events: 2, bytes: 'v1 code'.length, kept: null });
  assert.equal(await ws.readText(SYS_PLUGINS, '/tides/index.js'), 'v2 code');
});

test('forget: log entries that match go, with the content only they named', async () => {
  const { store } = await setup();
  await record(store, SYS, { type: 'tides.cache', actor: 'plugin:tides', data: {}, texts: [['table', 'x'.repeat(3000)]] });
  await record(store, SYS, { type: 'plugin.error', actor: 'plugin:tides', data: { message: 'boom' } });
  const r = await forget(store, SYS, { events: (e) => e.actor === 'plugin:tides' && Boolean(e.refs?.length) });
  assert.deepEqual(r, { files: 0, events: 1, bytes: 3000, kept: null });
  assert.deepEqual((await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS))).map((e) => e.type), ['plugin.error', 'forget']);
});

test('forget: nothing that matches changes nothing, and leaves no forget entry', async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_PLUGINS, '/other/index.js', 'other code', { author: 'system' });
  const log = () => store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS_PLUGINS));
  const before = await log();
  assert.deepEqual(await forget(store, SYS_PLUGINS, { files: inTides, history: inTides }), { files: 0, events: 0, bytes: 0, kept: null });
  assert.deepEqual(await log(), before);
  assert.ok(!before.some((/** @type {any} */ e) => e.type === 'forget'));
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
  assert.deepEqual(r, { files: 0, events: 2, bytes: 'v1 code'.length, kept: null });
  assert.equal(listed, 0);
  assert.equal(await stored(store, 'v1 code'), false);
});

test("forget: a scope's last entry number never falls, so a backup made before the forget reads changed after it", async () => {
  const { store, ws } = await setup();
  const trip = await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/files/a.pdf', 'pdf bytes', { author: 'user' });
  const last = () => store.tx(['events'], 'readonly', (t) => t.lastSeq(trip));
  const held = await last();
  await store.tx(['scopes'], 'readwrite', async (t) => t.putScope({ .../** @type {any} */ (await t.getScope(trip)), backup: { at: 1, seq: held } }));
  await ws.delete(trip, '/files/a.pdf', { author: 'user' });
  const top = await last();
  await forget(store, trip, { history: (p) => p === '/files/a.pdf' });
  assert.ok((await last()) > top, 'the forget is the newest entry, numbered after every entry it removed');
  assert.equal((await backupState(store, trip)).changed, true);
  const [e] = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { reverse: true, limit: 1 }));
  assert.equal(e.type, 'forget');
  assert.deepEqual(e.refs ?? [], []);
  // A second forget keeps one such entry, not one per call: callers that keep a file without history (the push mirror) don't grow the log.
  await ws.write(trip, '/notes/n.md', 'x', { author: 'user' });
  await forget(store, trip, { history: (p) => p === '/notes/n.md' });
  const forgets = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['forget'] }));
  assert.equal(forgets.length, 1);
  assert.ok(forgets[0].seq > e.seq);
});

// Delete in Files (the file-details design, Task 7): the group goes through the workspace, then forget frees it only when nothing else
// names the file's own versions (mustFree), all or nothing.

const PDF1 = 'pdf v1 bytes';
const PDF2 = 'pdf version two bytes';
/** A trip with /files/h.pdf (two versions), its booking and the plan item for that booking. */
async function group() {
  const { store, ws } = await setup();
  const trip = await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/files/h.pdf', PDF1, { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/files/h.pdf', PDF2, { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/bookings/h.json', { id: 'h', kind: 'lodging', status: 'confirmed', source: '/files/h.pdf', title: 'Hotel Aurora Test' }, { author: 'shiori' });
  await ws.write(trip, '/plan/h.json', { id: 'h', title: 'Check in', fixed: true, booking: '/bookings/h.json' }, { author: 'shiori' });
  const hashOf = async (/** @type {string} */ s) => sha256Hex(utf8(s));
  const json = async (/** @type {string} */ p) => (await ws.read(trip, p))?.entry;
  const booking = /** @type {any} */ (await json('/bookings/h.json'));
  const item = /** @type {any} */ (await json('/plan/h.json'));
  const paths = ['/files/h.pdf', '/bookings/h.json', '/plan/h.json'];
  const del = async () => {
    await ws.writeMany(trip, paths.map((path) => ({ path, content: null })), { author: 'user', with: '/files/h.pdf' });
    return forget(store, trip, { history: (p) => paths.includes(p), mustFree: (p) => p === '/files/h.pdf' });
  };
  return { store, ws, trip, paths, del, h1: await hashOf(PDF1), h2: await hashOf(PDF2), booking, item };
}
/** Every log entry and blob there is, to compare. @param {any} store */
const snapshot = (store) => store.tx(['events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => ({
  events: (await Promise.all((await t.listScopes()).map((/** @type {any} */ s) => t.listEvents(s.id)))).flat().map((/** @type {any} */ e) => [e.scope, e.seq, e.type]),
  blobs: (await t.listBlobs()).map((/** @type {any} */ b) => b.hash).sort(),
}));
const has = (/** @type {any} */ store, /** @type {string} */ hash) => store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.hasBlob(hash));

test('Delete: a file nothing else names is freed with its whole group, each content counted once', async () => {
  const g = await group();
  // The first version is named by three entries now (its two writes and the second's `old`), and still counts once.
  await g.ws.write(g.trip, '/files/h.pdf', PDF1, { author: 'user', type: 'application/pdf' });
  const r = await g.del();
  assert.equal(r.kept, null);
  assert.equal(r.bytes, PDF1.length + PDF2.length + g.booking.size + g.item.size);
  for (const p of g.paths) assert.deepEqual(await g.ws.history(g.trip, p), [], p);
  for (const h of [g.h1, g.h2, g.booking.hash, g.item.hash]) assert.equal(await has(g.store, h), false);
});

test('Delete: the file.delete entries of one Delete say which file they went with (WriteOptions.with)', async () => {
  const g = await group();
  await g.ws.writeMany(g.trip, g.paths.map((path) => ({ path, content: null })), { author: 'user', with: '/files/h.pdf' });
  const dels = await g.store.tx(['events'], 'readonly', (t) => t.listEvents(g.trip, { types: ['file.delete'] }));
  assert.deepEqual(dels.map((e) => [e.data.path, e.data.with]), g.paths.map((p) => [p, '/files/h.pdf']));
  assert.equal(new Set(dels.map((e) => e.ts)).size, 1);
});

test("Delete: a PDF the conversation names (a tool result's document) is kept, and nothing at all changes", async () => {
  const g = await group();
  await record(g.store, g.trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, document: { hash: g.h2, mediaType: 'application/pdf' } }, blobs: [{ hash: g.h2, type: 'application/pdf' }] });
  await g.ws.writeMany(g.trip, g.paths.map((path) => ({ path, content: null })), { author: 'user', with: '/files/h.pdf' });
  const before = await snapshot(g.store);
  const r = await forget(g.store, g.trip, { history: (p) => g.paths.includes(p), mustFree: (p) => p === '/files/h.pdf' });
  assert.deepEqual(r, { files: 0, events: 0, bytes: 0, kept: 'here' });
  assert.deepEqual(await snapshot(g.store), before);
});

test("Delete: a photo the user sent in the conversation keeps the file; so does an old version it names, as it's all or nothing", async () => {
  const g = await group();
  await record(g.store, g.trip, { type: 'msg.user', actor: 'user', data: { text: 'this one', images: [{ hash: g.h1, mediaType: 'image/png' }] }, blobs: [{ hash: g.h1, type: 'image/png' }] });
  assert.equal((await g.del()).kept, 'here');
  assert.equal(await has(g.store, g.h2), true, 'the current version stays too');
  assert.equal((await g.ws.history(g.trip, '/files/h.pdf')).length, 3);
});

test('Delete: the same bytes in another trip, or in the user\'s own files, keep it: elsewhere', async () => {
  for (const scope of ['trip', ME]) {
    const g = await group();
    const other = scope === 'trip' ? await createTrip(g.ws, { title: 'Anchorage' }) : ME;
    await g.ws.write(other, '/files/copy.pdf', PDF2, { author: 'user', type: 'application/pdf' });
    assert.equal((await g.del()).kept, 'elsewhere', scope);
  }
});

test("Delete: a copy the conversation names (a photo sent smaller) doesn't keep the file; the copy stays and still draws", async () => {
  const g = await group();
  const ev = await record(g.store, g.trip, { type: 'msg.user', actor: 'user', data: { text: 'here', images: [{ hash: '', mediaType: 'image/jpeg' }] }, blobs: [{ bytes: utf8('a smaller copy'), type: 'image/jpeg' }] });
  const copy = ev.refs[0];
  await g.store.tx(['events'], 'readwrite', (t) => t.putEvent({ ...ev, data: { ...ev.data, images: [{ hash: copy, mediaType: 'image/jpeg' }] } }));
  assert.equal((await g.del()).kept, null);
  assert.equal(await has(g.store, g.h2), false);
  assert.equal(await has(g.store, copy), true);
  const [stored] = await g.store.tx(['events'], 'readonly', (t) => t.listEvents(g.trip, { types: ['msg.user'] }));
  const drawn = /** @type {any} */ (await resolveEvent(g.store, stored));
  assert.equal(drawn.images[0].missing, undefined);
  assert.ok(drawn.images[0].data);
});

test("Delete: a booking's JSON that a stored text names doesn't keep the file; that JSON stays, the file's versions go", async () => {
  const g = await group();
  await record(g.store, g.trip, { type: 'tool.result', actor: 'system', data: { id: 'c2', name: 'read', ok: true }, blobs: [{ hash: g.booking.hash, type: 'application/json' }] });
  const r = await g.del();
  assert.equal(r.kept, null);
  assert.equal(await has(g.store, g.booking.hash), true);
  assert.equal(await has(g.store, g.h1), false);
  assert.equal(await has(g.store, g.h2), false);
});

test('forget: with no mustFree, nothing is kept back', async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_PLUGINS, '/tides/a.md', 'a', { author: 'system' });
  assert.equal((await forget(store, SYS_PLUGINS, { files: inTides, history: inTides })).kept, null);
});
