import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { syncNames, readNames } from '../../src/core/names.js';
import { record } from '../../src/core/agent/log.js';
import { readTripFiles, fileDetails } from '../../src/core/trip-files.js';
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
