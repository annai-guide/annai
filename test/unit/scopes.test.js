import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError, StorageFullError, NotFoundError } from '../../src/core/workspace.js';
import { makeSchemaFor, validate } from '../../src/core/schema.js';
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, kindOf, newId, ensureBaseScopes, createTrip, listTrips, setTripStatus, syncTripTitles, removeTrip, removeLeftovers, recordBackup, backupState } from '../../src/core/scopes.js';
import { logEvent, blobsOf } from '../../src/core/events.js';
import { utf8, ownBuffer } from '../../src/core/bytes.js';
import { sha256Hex } from '../../src/core/hash.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS, PLAN_ITEM_SCHEMA, BOOKING_SCHEMA } from '../../src/plugins/core-schemas/schemas.js';
import * as corePlugin from '../../src/plugins/core-schemas/index.js';

function setup() {
  const store = createMemoryStore();
  let clock = 1000;
  const ws = new Workspace(store, { now: () => ++clock, schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  return { store, ws };
}

test('kindOf and newId', () => {
  assert.equal(kindOf(ME), 'me');
  assert.equal(kindOf(SYS), 'sys');
  assert.equal(kindOf(SYS_PLUGINS), 'sys');
  assert.equal(kindOf('trip-abc'), 'trip');
  assert.equal(kindOf('x'), 'other');
  const a = newId('trip'), b = newId('trip');
  assert.match(a, /^trip-[0-9a-z]+$/);
  assert.notEqual(a, b);
});

test('ensureBaseScopes creates me and the system scopes once', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  await ensureBaseScopes(ws);
  const ids = (await store.tx(['scopes'], 'readonly', (t) => t.listScopes())).map((s) => s.id).sort();
  assert.deepEqual(ids, [ME, SYS, SYS_PLUGINS, SYS_SETTINGS].sort());
  assert.match(await ws.readText(ME, '/profile.md'), /^# Profile/);
  assert.equal((await ws.history(ME, '/profile.md')).length, 1);
  assert.equal(await ws.readText(ME, '/memory.md'), '# Memory\n');
});

test('createTrip makes a scope, trip.json, trip memory and a scope.create event', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: '京都 in spring', start: '2027-04-03', end: '2027-04-10' });
  const rec = await store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
  assert.equal(rec.kind, 'trip');
  assert.equal(rec.title, '京都 in spring');
  const trip = await ws.readJSON(id, '/trip.json');
  assert.deepEqual(trip, { id: rec.tripId, title: '京都 in spring', start: '2027-04-03', end: '2027-04-10', places: [], party: [] });
  assert.equal(await ws.readText(id, '/memory.md'), '# Trip memory\n');
  const types = (await store.tx(['events'], 'readonly', (t) => t.listEvents(id))).map((e) => e.type);
  assert.deepEqual(types, ['scope.create', 'file.write', 'file.write']);
});

test('createTrip refuses an empty title or a bad date and leaves nothing behind', async () => {
  const { store, ws } = setup();
  await assert.rejects(createTrip(ws, { title: '  ' }), ValidationError);
  await assert.rejects(createTrip(ws, { title: 'Big Sur', start: '2026-13-01' }), ValidationError);
  assert.deepEqual(await store.tx(['scopes'], 'readonly', (t) => t.listScopes()), []);
});

test('listTrips orders by last change and splits archived trips', async () => {
  const { store, ws } = setup();
  const a = await createTrip(ws, { title: 'A' });
  const b = await createTrip(ws, { title: 'B' });
  await ws.write(a, '/notes/x.md', 'newer', { author: 'user' });
  let trips = await listTrips(store);
  assert.deepEqual(trips.active.map((s) => s.title), ['A', 'B']);
  await setTripStatus(store, b, 'archived');
  trips = await listTrips(store);
  assert.deepEqual(trips.active.map((s) => s.title), ['A']);
  assert.deepEqual(trips.archived.map((s) => s.title), ['B']);
  const types = (await store.tx(['events'], 'readonly', (t) => t.listEvents(b))).map((e) => e.type);
  assert.equal(types.at(-1), 'scope.archive');
});

test('syncTripTitles keeps the scope title in step with trip.json', async () => {
  const { store, ws } = setup();
  syncTripTitles(ws);
  const id = await createTrip(ws, { title: 'Old' });
  await ws.patch(id, '/trip.json', { title: 'Big Sur · Thanksgiving' }, { author: 'user' });
  assert.equal((await store.tx(['scopes'], 'readonly', (t) => t.getScope(id))).title, 'Big Sur · Thanksgiving');
});

test('logEvent and app settings', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const ev = await logEvent(store, SYS, { type: 'error', data: { message: 'x' } });
  assert.equal(ev.actor, 'system');
  assert.deepEqual(await readAppSettings(ws), {});
  await updateAppSettings(ws, { lastExportAt: 5 });
  await updateAppSettings(ws, { theme: 'dark' });
  assert.deepEqual(await readAppSettings(ws), { lastExportAt: 5, theme: 'dark' });
  assert.equal((await ws.list(SYS_SETTINGS)).length, 1);
});

test('plan item and booking schemas', () => {
  const time = { at: '2026-11-26T18:30:00-08:00', tz: 'America/Los_Angeles' };
  assert.deepEqual(validate(PLAN_ITEM_SCHEMA, { id: 'p1', title: 'Nepenthe', fixed: true, start: time, place: { name: 'Nepenthe', lat: 36.22, lng: -121.76 } }), []);
  assert.deepEqual(validate(PLAN_ITEM_SCHEMA, { id: 'p1', title: 'Nepenthe' }), ['$.fixed: is required']);
  assert.deepEqual(validate(BOOKING_SCHEMA, { id: 'b1', kind: 'lodging', status: 'unverified', source: '/files/shot.png', cost: { amount: 612.4, currency: 'USD' } }), []);
  assert.equal(validate(BOOKING_SCHEMA, { id: 'b1', kind: 'boat', status: 'maybe', source: 'x' }).length, 3);
});

test('the core-schemas plugin registers its schemas and unregisters them', () => {
  /** @type {any[]} */
  const registered = [];
  const api = { schemas: { register: (/** @type {any} */ s) => { registered.push(s); return () => registered.splice(registered.indexOf(s), 1); } } };
  assert.equal(corePlugin.manifest.id, 'core-schemas');
  const dispose = corePlugin.activate(api);
  assert.equal(registered.length, CORE_SCHEMAS.length);
  dispose();
  assert.equal(registered.length, 0);
});

test('two first changes to the app settings at once both stick', async () => {
  const { ws } = setup();
  await ensureBaseScopes(ws);
  await Promise.all([updateAppSettings(ws, { units: 'metric' }), updateAppSettings(ws, { theme: 'dark' })]);
  assert.deepEqual(await readAppSettings(ws), { units: 'metric', theme: 'dark' });
});

test('creating a trip on a full device says storage is full and leaves nothing behind', async () => {
  const inner = createMemoryStore();
  let full = false;
  /** @type {import('../../src/core/types.js').Store} */
  const store = {
    close() {},
    tx(stores, mode, fn) {
      return inner.tx(stores, mode, (t) => fn({ ...t, putScope: async (rec) => {
        if (full) throw new DOMException('no space', 'QuotaExceededError');
        return t.putScope(rec);
      } }));
    },
  };
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  const kept = await createTrip(ws, { title: 'Kyoto' });
  full = true;
  await assert.rejects(createTrip(ws, { title: 'Big Sur' }), StorageFullError);
  await assert.rejects(setTripStatus(store, kept, 'archived'), StorageFullError);
  full = false;
  assert.deepEqual((await listTrips(store)).active.map((s) => s.id), [kept]);
});

/** @typedef {import('../../src/core/types.js').Store} Store */

/** Every stored blob, hash → size. @param {Store} store */
const storedBlobs = async (store) => new Map((await store.tx(['blobs'], 'readonly', (t) => t.listBlobs())).map((b) => [b.hash, b.size]));

test('blobsOf lists the content an event points at', () => {
  assert.deepEqual(blobsOf({ data: { path: '/a', old: 'h1', new: 'h2' }, refs: ['h3'] }), ['h1', 'h2', 'h3']);
  assert.deepEqual(blobsOf({ data: { old: null, new: 7 } }), []);
  assert.deepEqual(blobsOf({}), []);
});

test('removeTrip removes the trip, its files and history, and frees the content only it used', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const before = await storedBlobs(store);
  const id = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(id, '/files/a.webp', new Uint8Array(3000).fill(7), { author: 'user' });
  await ws.write(id, '/notes/day1.md', 'first', { author: 'user' });
  await ws.write(id, '/notes/day1.md', 'second', { author: 'user' }); // "first" is an older version now
  await ws.write(id, '/files/b.webp', new Uint8Array(2000).fill(8), { author: 'user' });
  await ws.delete(id, '/files/b.webp', { author: 'user' }); // a deleted file, kept by its history until now
  const added = [...(await storedBlobs(store))].filter(([hash]) => !before.has(hash));
  assert.ok(added.length >= 6);
  const result = await removeTrip(store, id);
  assert.deepEqual(result, { title: 'Big Sur', bytes: added.reduce((n, [, size]) => n + size, 0) });
  assert.deepEqual([...(await storedBlobs(store)).keys()].sort(), [...before.keys()].sort());
  const left = await store.tx(['scopes', 'files', 'events'], 'readonly', async (t) => ({
    scope: await t.getScope(id), files: await t.listFiles(id, '/'), events: await t.listEvents(id),
    log: await t.listEvents(SYS, { types: ['trip.remove'] }),
  }));
  assert.equal(left.scope, undefined);
  assert.deepEqual(left.files, []);
  assert.deepEqual(left.events, []);
  assert.deepEqual(left.log.map((e) => e.data), [{ title: 'Big Sur', bytes: result.bytes }]);
});

test('removeTrip keeps content another trip uses, now or in its history', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const photo = new Uint8Array(3000).fill(7);
  const a = await createTrip(ws, { title: 'A' });
  const b = await createTrip(ws, { title: 'B' });
  await ws.write(a, '/files/p.webp', photo, { author: 'user' });
  await ws.write(b, '/files/same.webp', photo, { author: 'user' }); // the same photo, stored once
  await ws.write(a, '/notes/n.md', 'old', { author: 'user' });
  await ws.write(b, '/notes/n.md', 'old', { author: 'user' });
  await ws.write(b, '/notes/n.md', 'new', { author: 'user' }); // in B, "old" is history now
  const [first] = await ws.history(b, '/notes/n.md');
  await removeTrip(store, a);
  assert.deepEqual((await ws.read(b, '/files/same.webp'))?.bytes, photo);
  await ws.restore(b, '/notes/n.md', /** @type {string} */ (first.new), { author: 'user' });
  assert.equal(await ws.readText(b, '/notes/n.md'), 'old');
});

test('removeTrip also frees content nothing refers to, and keeps what any log points at', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const id = await createTrip(ws, { title: 'Big Sur' });
  const orphan = 'a'.repeat(64); // left behind by an interrupted restore
  const traced = 'b'.repeat(64); // a body the system log points at
  await store.tx(['blobs'], 'readwrite', async (t) => {
    for (const hash of [orphan, traced]) await t.putBlob({ hash, type: 'application/octet-stream', size: 4, data: new Uint8Array(4).buffer });
  });
  await logEvent(store, SYS, { type: 'net.request', refs: [traced] });
  await removeTrip(store, id);
  const left = await storedBlobs(store);
  assert.equal(left.has(orphan), false);
  assert.equal(left.has(traced), true);
});

test('removeLeftovers removes what a late writer left in a removed trip, and frees what only it named', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const kept = await createTrip(ws, { title: 'Kept' });
  const gone = await createTrip(ws, { title: 'Gone' });
  await removeTrip(store, gone);
  const before = await storedBlobs(store);
  // A web request that ignored Stop finishes after the removal: its log line (and a body it kept) land in the removed trip.
  await store.tx(['blobs', 'files', 'events'], 'readwrite', async (t) => {
    await t.putBlob({ hash: 'late-body', type: 'text/plain', size: 9, data: ownBuffer(utf8('late body')) });
    await t.appendEvent(gone, { ts: 1, type: 'net.request', actor: 'system', data: { url: 'https://example.com/' }, refs: ['late-body'] });
    await t.putFile({ scope: gone, path: '/late.md', hash: 'late-body', size: 9, type: 'text/plain', author: 'agent', created: 1, modified: 1 });
  });
  assert.deepEqual(await removeLeftovers(store, 5000), { scopes: 1, bytes: 9 });
  const left = await store.tx(['scopes', 'files', 'events', 'blobs'], 'readonly', async (t) => ({
    events: await t.listEvents(gone), files: await t.listFiles(gone), held: await t.scopesWithData(),
    log: await t.listEvents(SYS, { types: ['leftovers.remove'] }),
  }));
  assert.deepEqual(left.events, []);
  assert.deepEqual(left.files, []);
  assert.ok(left.held.includes(kept) && left.held.includes(ME) && !left.held.includes(gone));
  assert.deepEqual([...(await storedBlobs(store)).keys()].sort(), [...before.keys()].sort());
  assert.deepEqual(left.log.map((e) => [e.ts, e.data]), [[5000, { scopes: 1, bytes: 9 }]]);
  // Nothing left over: nothing removed, nothing logged.
  assert.deepEqual(await removeLeftovers(store, 6000), { scopes: 0, bytes: 0 });
  assert.equal((await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['leftovers.remove'] }))).length, 1);
});

test('removeTrip removes only trips', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  await assert.rejects(removeTrip(store, ME), NotFoundError);
  await assert.rejects(removeTrip(store, 'trip-missing'), NotFoundError);
  assert.ok(await store.tx(['scopes'], 'readonly', (t) => t.getScope(ME)));
});

/** The last history entry of a scope. @param {Store} store @param {string} id */
const lastSeq = (store, id) => store.tx(['events'], 'readonly', (t) => t.lastSeq(id));

test('a trip counts as backed up from a recorded Backup until it changes (spec §4.9)', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: 'Big Sur' });
  assert.deepEqual(await backupState(store, id), { at: null, changed: true });
  await recordBackup(store, new Map([[id, await lastSeq(store, id)]]), 5000);
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: false });
  await setTripStatus(store, id, 'archived');
  await setTripStatus(store, id, 'active');
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: false }, 'archiving changes nothing the Backup holds');
  await ws.write(id, '/notes/day1.md', 'Bixby Bridge', { author: 'user' });
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: true });
});

test('a Backup built before a change and saved after it does not cover the change', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: 'Big Sur' });
  const built = await lastSeq(store, id);
  await ws.write(id, '/notes/day1.md', 'written while the file was being built', { author: 'user' });
  await recordBackup(store, new Map([[id, built]]), 5000);
  assert.equal((await backupState(store, id)).changed, true);
});

test('recordBackup skips what is not a trip, trips that are gone, and older Backups', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const id = await createTrip(ws, { title: 'Big Sur' });
  const seq = await lastSeq(store, id);
  await recordBackup(store, new Map([[ME, 1], ['trip-gone', 1], [id, seq]]), 5000);
  assert.equal((await store.tx(['scopes'], 'readonly', (t) => t.getScope(ME)))?.backup, undefined);
  await recordBackup(store, new Map([[id, seq - 1]]), 9000);
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: false });
});

test('backupState of a trip unchanged since its Backup reads none of its history', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: 'Big Sur' });
  await recordBackup(store, new Map([[id, await lastSeq(store, id)]]), 5000);
  /** @type {Store} */
  const noLog = {
    close: () => {},
    tx: (stores, mode, fn) => store.tx(stores, mode, (t) => fn({ ...t, listEvents: () => { throw new Error('read the history'); } })),
  };
  assert.deepEqual(await backupState(noLog, id), { at: 5000, changed: false });
});

test('removing a trip keeps content another trip names, and frees content nobody names (spec §4.9)', async () => {
  const { store, ws } = await setup();
  const a = await createTrip(ws, { title: 'A' });
  const b = await createTrip(ws, { title: 'B' });
  const shared = utf8('shared photo');
  const sharedHash = await sha256Hex(shared);
  const orphan = utf8('nobody');
  const orphanHash = await sha256Hex(orphan);
  await ws.write(a, '/files/p.webp', shared, { author: 'user', type: 'image/webp' });
  await store.tx(['blobs', 'events'], 'readwrite', async (t) => {
    await t.putBlob({ hash: orphanHash, type: 'text/plain', size: orphan.byteLength, data: ownBuffer(orphan) });
    await t.appendEvent(b, { ts: 1, type: 'tool.result', actor: 'system', refs: [sharedHash] });
  });
  await removeTrip(store, a);
  const left = await store.tx(['blobs'], 'readonly', async (t) => [await t.hasBlob(sharedHash), await t.hasBlob(orphanHash)]);
  assert.deepEqual(left, [true, false]);
});
