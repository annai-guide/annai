import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError, StorageFullError } from '../../src/core/workspace.js';
import { makeSchemaFor, validate } from '../../src/core/schema.js';
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, kindOf, newId, ensureBaseScopes, createTrip, listTrips, setTripStatus, syncTripTitles } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
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
