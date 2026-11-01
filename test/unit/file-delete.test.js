import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { syncNames, readNames } from '../../src/core/names.js';
import { record } from '../../src/core/agent/log.js';
import { readTripFiles, fileDetails, deletedFiles, restoreGroup } from '../../src/core/trip-files.js';
import { forget } from '../../src/core/forget.js';
import { deleteGroup } from '../../src/ui/file-delete.js';
import { liveKit, iso, at, LA, MONTEREY, BIXBY } from './live-kit.js';

/** A context for deleteGroup: the workspace, its store, and the toasts it gives. @param {Workspace} ws */
function ctxOf(ws) {
  /** @type {string[]} */
  const toasts = [];
  return { ws, store: ws.store, toasts, notices: { toast: (/** @type {string} */ m) => toasts.push(m) } };
}

/**
 * A trip with /files/hotel.pdf, the stay Shiori read from it (named by her) and its plan item.
 * @param {{ ws: Workspace, trip: string }} [given] a workspace and a trip to put them in
 */
async function hotel(given) {
  const ws = given?.ws ?? new Workspace(createMemoryStore());
  if (!given) await ensureBaseScopes(ws);
  const trip = given?.trip ?? await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/files/hotel.pdf', '%PDF-1.4 Hotel Aurora Test', { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/hotel.pdf', title: 'Hotel Aurora Test' }, { author: 'shiori' });
  await ws.write(trip, '/plan/check-in.json', { id: 'check-in', title: 'Check in', fixed: true, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY }, booking: '/trip/bookings/stay.json' }, { author: 'shiori' });
  await ws.write(trip, '/names.json', { '/files/hotel.pdf': 'Hotel stay' }, { author: 'shiori' });
  const details = async () => /** @type {import('../../src/core/trip-files.js').Details} */ (fileDetails(await readTripFiles(ws, ws.store, trip), '/files/hotel.pdf'));
  return { ws, trip, details };
}

test('Delete in Files: a file nothing else names is freed, the toast says how much, and its short name goes', async () => {
  const { ws, trip, details } = await hotel();
  syncNames(ws);
  const ctx = ctxOf(ws);
  const gone = await deleteGroup(ctx, trip, await details());
  assert.deepEqual(gone, ['/files/hotel.pdf', '/bookings/stay.json', '/plan/check-in.json']);
  assert.match(ctx.toasts[0], /^Deleted Hotel stay, 1 booking,? and 1 plan item\. \d+ bytes freed\.$/);
  for (const p of /** @type {string[]} */ (gone)) assert.deepEqual(await ws.history(trip, p), [], p);
  assert.equal(Object.hasOwn(await readNames(ws, trip), '/files/hotel.pdf'), false);
  assert.ok((await ws.history(trip, '/names.json')).length >= 2, "names.json's own history stays");
});

test('Delete in Files: a file the conversation still names is kept, history and all, and the toast says where it is', async () => {
  const { ws, trip, details } = await hotel();
  const file = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry;
  await record(ws.store, trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, document: { hash: file.hash, mediaType: 'application/pdf' } }, blobs: [{ hash: file.hash, type: 'application/pdf' }] });
  const ctx = ctxOf(ws);
  await deleteGroup(ctx, trip, await details());
  assert.match(ctx.toasts[0], /^Deleted Hotel stay, 1 booking,? and 1 plan item\. The conversation still has it, so it's under Deleted, where you can restore it\.$/);
  assert.equal((await ws.history(trip, '/files/hotel.pdf')).length, 2);
  assert.equal((await ws.list(trip, '/files/')).length, 0);
});

test('Delete in Files: the same bytes elsewhere keep it, and the toast says so', async () => {
  const { ws, trip, details } = await hotel();
  await ws.write(ME, '/files/hotel.pdf', '%PDF-1.4 Hotel Aurora Test', { author: 'user', type: 'application/pdf' });
  const ctx = ctxOf(ws);
  await deleteGroup(ctx, trip, await details());
  assert.match(ctx.toasts[0], /^Deleted Hotel stay, 1 booking,? and 1 plan item\. Another trip or file has the same content, so it's under Deleted, where you can restore it\.$/);
});

test('Delete: a booking with no file keeps its history and frees nothing; the toast is as before', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/bookings/said.json', { id: 'said', kind: 'restaurant', status: 'confirmed', source: '/talk', title: 'Testville Grill' }, { author: 'shiori' });
  const ctx = ctxOf(ws);
  await deleteGroup(ctx, trip, /** @type {any} */ (fileDetails(await readTripFiles(ws, ws.store, trip), '/bookings/said.json')));
  assert.deepEqual(ctx.toasts, ['Deleted Testville Grill']);
  assert.equal((await ws.history(trip, '/bookings/said.json')).length, 2);
});

test("Delete in Files goes through the workspace: live mode drops the deleted plan item's reminders", async () => {
  const k = await liveKit();
  const { trip, details } = await hotel(k);
  await k.settle();
  await k.fix(at('08:31'), MONTEREY);
  const held = () => k.live.held.filter((key) => key.includes('plan:check-in:'));
  assert.ok(held().length, 'the plan item had its watches');
  await deleteGroup(ctxOf(k.ws), trip, await details());
  await k.settle();
  assert.deepEqual(held(), []);
});

/** A workspace whose clock the test moves. */
async function clocked() {
  let now = 1_800_000_000_000;
  const ws = new Workspace(createMemoryStore(), { now: () => now });
  await ensureBaseScopes(ws);
  return { ws, tick: (/** @type {number} */ ms = 1000) => { now += ms; }, now: () => now };
}
const deletes = (/** @type {Workspace} */ ws, /** @type {string} */ trip) => ws.store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['file.delete'] }));

test('Deleted lists the newest delete of each file the user gave: kept ones and Shiori\'s; not freed ones, moves, or a path with a file now', async () => {
  const { ws, tick } = await clocked();
  const trip = await createTrip(ws, { title: 'Testville' });
  const add = (/** @type {string} */ p, /** @type {string} */ s) => ws.write(trip, p, s, { author: 'user', type: 'application/pdf' });
  await add('/files/kept.pdf', 'kept v1');
  await ws.delete(trip, '/files/kept.pdf', { author: 'user' });
  tick();
  await add('/files/kept.pdf', 'kept v2');
  tick();
  await ws.delete(trip, '/files/kept.pdf', { author: 'user' });
  await add('/files/hers.pdf', 'hers');
  tick();
  await ws.delete(trip, '/files/hers.pdf', { author: 'shiori' });
  await add('/files/moved.pdf', 'moved');
  await ws.delete(trip, '/files/moved.pdf', { author: 'shiori', moved: { to: 'trip-other', path: '/files/moved.pdf' } });
  await add('/files/back.pdf', 'back v1');
  await ws.delete(trip, '/files/back.pdf', { author: 'user' });
  await add('/files/back.pdf', 'back v2');
  await add('/files/freed.pdf', 'freed');
  await ws.delete(trip, '/files/freed.pdf', { author: 'user' });
  await forget(ws.store, trip, { history: (p) => p === '/files/freed.pdf', mustFree: (p) => p === '/files/freed.pdf' });
  await ws.write(trip, '/notes/n.md', 'n', { author: 'user' });
  await ws.delete(trip, '/notes/n.md', { author: 'user' });
  const list = deletedFiles(await deletes(ws, trip), await ws.list(trip, '/'));
  assert.deepEqual(list.map((x) => [x.path, x.actor]), [['/files/hers.pdf', 'shiori'], ['/files/kept.pdf', 'user']]);
  assert.equal(list[1].old, (/** @type {any} */ (await deletes(ws, trip)).filter((e) => e.data.path === '/files/kept.pdf').at(-1)).data.old);
});

test('Restore brings back the file and what went with it at that Delete, not a booking deleted at another time; a path taken now is skipped and said', async () => {
  const { ws, tick } = await clocked();
  const trip = await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/files/walks.ics', 'BEGIN:VCALENDAR', { author: 'user', type: 'text/calendar' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/files/walks.ics', title: 'Hotel Aurora Test' }, { author: 'shiori' });
  await ws.write(trip, '/bookings/old.json', { id: 'old', kind: 'car', status: 'confirmed', source: '/files/walks.ics', title: 'TESTCAR1' }, { author: 'shiori' });
  await ws.write(trip, '/plan/walk.json', { id: 'walk', title: 'Aurora walk', fixed: true }, { author: 'shiori', source: '/trip/files/walks.ics' });
  await ws.write(trip, '/plan/check-in.json', { id: 'check-in', title: 'Check in', fixed: true, booking: '/bookings/stay.json' }, { author: 'shiori' });
  // An earlier Delete of the same group took the car booking alone.
  await ws.writeMany(trip, [{ path: '/bookings/old.json', content: null }], { author: 'user', with: '/files/walks.ics' });
  tick();
  await ws.writeMany(trip, ['/files/walks.ics', '/bookings/stay.json', '/plan/walk.json', '/plan/check-in.json'].map((path) => ({ path, content: null })), { author: 'user', with: '/files/walks.ics' });
  // Something new took the check-in's place meanwhile.
  await ws.write(trip, '/plan/check-in.json', { id: 'check-in', title: 'Check in at noon', fixed: true }, { author: 'user' });
  const r = await restoreGroup(ws, trip, '/files/walks.ics');
  assert.deepEqual(r, { restored: ['/files/walks.ics', '/bookings/stay.json', '/plan/walk.json'], taken: ['/plan/check-in.json'] });
  assert.equal(await ws.readText(trip, '/files/walks.ics'), 'BEGIN:VCALENDAR');
  assert.equal((await ws.readJSON(trip, '/plan/check-in.json')).title, 'Check in at noon');
  assert.equal(await ws.readJSON(trip, '/bookings/old.json'), undefined);
  // The calendar's plan item is made from the file again: its entry keeps the source it had.
  assert.equal((await ws.list(trip, '/plan/')).find((f) => f.path === '/plan/walk.json')?.source, '/trip/files/walks.ics');
  assert.deepEqual(deletedFiles(await deletes(ws, trip), await ws.list(trip, '/')), []);
});

test('Restore of a file deleted before Delete marked its group brings back the file alone', async () => {
  const { ws } = await clocked();
  const trip = await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/files/old.pdf', 'old', { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/bookings/old.json', { id: 'old', kind: 'car', status: 'confirmed', source: '/files/old.pdf', title: 'TESTCAR1' }, { author: 'shiori' });
  await ws.writeMany(trip, ['/files/old.pdf', '/bookings/old.json'].map((path) => ({ path, content: null })), { author: 'user' });
  assert.deepEqual(await restoreGroup(ws, trip, '/files/old.pdf'), { restored: ['/files/old.pdf'], taken: [] });
  assert.equal((await ws.list(trip, '/files/'))[0]?.type, 'application/pdf');
});
