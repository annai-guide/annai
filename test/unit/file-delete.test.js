import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, removeTrip, ME } from '../../src/core/scopes.js';
import { syncNames, readNames } from '../../src/core/names.js';
import { record } from '../../src/core/agent/log.js';
import { readTripFiles, fileDetails, deletedFiles, restoreGroup } from '../../src/core/trip-files.js';
import { forget } from '../../src/core/forget.js';
import { deleteGroup, restoreDeleted, freeableDeleted, deleteForGood, deletedName } from '../../src/ui/file-delete.js';
import { snapshot } from '../contract/snapshot.js';
import { noteBlobReads } from './store-spy.js';
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
  const blobs = () => ws.store.tx(['blobs'], 'readonly', async (t) => (await t.listBlobs()).map((b) => b.hash).sort());
  const before = await blobs();
  await deleteGroup(ctx, trip, /** @type {any} */ (fileDetails(await readTripFiles(ws, ws.store, trip), '/bookings/said.json')));
  assert.deepEqual(ctx.toasts, ['Deleted Testville Grill']);
  assert.deepEqual(await blobs(), before, 'frees nothing');
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

test("Delete frees only the bookings' and plan items' current life: a kept group's earlier history under the same paths stays, and its Restore brings them back", async () => {
  const { ws, trip, details } = await hotel();
  const file = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry;
  await record(ws.store, trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, document: { hash: file.hash, mediaType: 'application/pdf' } }, blobs: [{ hash: file.hash, type: 'application/pdf' }] });
  await deleteGroup(ctxOf(ws), trip, await details());
  // Shiori reads a note and writes the same two paths again (bookings are named by short name, calendar items by UID).
  await ws.write(trip, '/files/note.pdf', '%PDF-1.4 A different note', { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/note.pdf', title: 'Note stay' }, { author: 'shiori' });
  await ws.write(trip, '/plan/check-in.json', { id: 'check-in', title: 'Check in at the note', fixed: true, booking: '/trip/bookings/stay.json' }, { author: 'shiori' });
  const ctx = ctxOf(ws);
  await deleteGroup(ctx, trip, /** @type {any} */ (fileDetails(await readTripFiles(ws, ws.store, trip), '/files/note.pdf')));
  assert.match(ctx.toasts[0], /bytes freed\.$/);
  assert.deepEqual(await ws.history(trip, '/files/note.pdf'), []);
  const r = await restoreGroup(ws, trip, '/files/hotel.pdf');
  assert.deepEqual(r, { restored: ['/files/hotel.pdf', '/bookings/stay.json', '/plan/check-in.json'], taken: [] });
  assert.equal((await ws.readJSON(trip, '/bookings/stay.json')).title, 'Hotel Aurora Test');
  assert.equal((await ws.readJSON(trip, '/plan/check-in.json')).title, 'Check in');
});

test("Delete frees the earlier life of a booking or plan path that went with the same file: it's doomed with the file's history", async () => {
  const { ws, trip, details } = await hotel();
  const other = await createTrip(ws, { title: 'Elsewhere' });
  await ws.write(other, '/files/copy.pdf', '%PDF-1.4 Hotel Aurora Test', { author: 'user', type: 'application/pdf' });
  const first = /** @type {any} */ (await ws.read(trip, '/bookings/stay.json')).entry;
  const ctx = ctxOf(ws);
  await deleteGroup(ctx, trip, await details());
  assert.match(ctx.toasts[0], /Another trip or file has the same content/);
  await removeTrip(ws.store, other);
  // The same file name comes again with other bytes, and the same booking and plan paths.
  await ws.write(trip, '/files/hotel.pdf', '%PDF-1.4 Hotel Borealis Test', { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/hotel.pdf', title: 'Hotel Borealis Test' }, { author: 'shiori' });
  await ws.write(trip, '/plan/check-in.json', { id: 'check-in', title: 'Check in at Borealis', fixed: true, booking: '/trip/bookings/stay.json' }, { author: 'shiori' });
  await deleteGroup(ctx, trip, await details());
  assert.match(ctx.toasts[1], /bytes freed\.$/);
  for (const p of ['/files/hotel.pdf', '/bookings/stay.json', '/plan/check-in.json']) assert.deepEqual(await ws.history(trip, p), [], p);
  assert.equal(await ws.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(first.hash)), false, "the first life's booking JSON is freed too");
  await assert.rejects(() => restoreGroup(ws, trip, '/files/hotel.pdf'), { name: 'NotFoundError' });
});

test("Restore with another file at the deleted file's path brings back nothing of the group, and the toast says why", async () => {
  const { ws, trip, details } = await hotel();
  const file = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry;
  await record(ws.store, trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, document: { hash: file.hash, mediaType: 'application/pdf' } }, blobs: [{ hash: file.hash, type: 'application/pdf' }] });
  await deleteGroup(ctxOf(ws), trip, await details());
  await ws.write(trip, '/files/hotel.pdf', '%PDF-1.4 Another hotel', { author: 'user', type: 'application/pdf' });
  assert.deepEqual(await restoreGroup(ws, trip, '/files/hotel.pdf'), { restored: [], taken: ['/files/hotel.pdf', '/bookings/stay.json', '/plan/check-in.json'] });
  const ctx = { ...ctxOf(ws), go: () => assert.fail('stays where it is'), render: async () => {} };
  await restoreDeleted(ctx, trip, '/files/hotel.pdf');
  assert.deepEqual(ctx.toasts, ["A file named hotel.pdf is there now, so this one can't come back."]);
  assert.deepEqual((await ws.list(trip, '/bookings/')).concat(await ws.list(trip, '/plan/')), []);
  assert.equal(await ws.readText(trip, '/files/hotel.pdf'), '%PDF-1.4 Another hotel');
});

test("A second tab's Restore of a file that has already come back says it's back and opens it, not 'delete it first'", async () => {
  const { ws, trip, details } = await hotel();
  const file = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry;
  await record(ws.store, trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, document: { hash: file.hash, mediaType: 'application/pdf' } }, blobs: [{ hash: file.hash, type: 'application/pdf' }] });
  await deleteGroup(ctxOf(ws), trip, await details());
  /** @type {string[]} */
  const went = [];
  const ctx = { ...ctxOf(ws), go: (/** @type {string} */ h) => went.push(h), render: async () => {} };
  await restoreDeleted(ctx, trip, '/files/hotel.pdf');
  await restoreDeleted(ctx, trip, '/files/hotel.pdf'); // the other tab, still showing Restore
  assert.match(ctx.toasts[0], /^Restored hotel\.pdf/);
  assert.equal(ctx.toasts[1], 'hotel.pdf is already back.');
  assert.equal(went.length, 2);
  assert.equal(went[1], went[0]);
});

test("Delete in Files: when the other deleted copy's history names the content, the toast doesn't blame the conversation", async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville' });
  for (const p of ['/files/a.pdf', '/files/b.pdf']) await ws.write(trip, p, '%PDF-1.4 Same bytes', { author: 'user', type: 'application/pdf' });
  const ctx = ctxOf(ws);
  for (const p of ['/files/a.pdf', '/files/b.pdf']) await deleteGroup(ctx, trip, /** @type {any} */ (fileDetails(await readTripFiles(ws, ws.store, trip), p)));
  assert.match(ctx.toasts[0], /^Deleted a\.pdf\. Another trip or file has the same content, /);
  assert.equal(ctx.toasts[1], "Deleted b.pdf. The same content is still used elsewhere in this trip, so it's under Deleted, where you can restore it.");
});

test('Deleted names a kept file by the short name it had, though the name goes with the file', async () => {
  const { ws, trip, details } = await hotel();
  syncNames(ws);
  const file = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry;
  await record(ws.store, trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, document: { hash: file.hash, mediaType: 'application/pdf' } }, blobs: [{ hash: file.hash, type: 'application/pdf' }] });
  await deleteGroup(ctxOf(ws), trip, await details());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Object.hasOwn(await readNames(ws, trip), '/files/hotel.pdf'), false);
  const [gone] = deletedFiles(await deletes(ws, trip), await ws.list(trip, '/'));
  assert.deepEqual([gone.real, gone.name], ['hotel.pdf', 'Hotel stay']);
});

/** The conversation reading some content: a tool result naming it, so a file with it can't be freed. @param {Workspace} ws @param {string} trip @param {string} hash */
async function conversationReads(ws, trip, hash) {
  await record(ws.store, trip, { type: 'tool.result', actor: 'system', data: { id: `c-${hash}`, name: 'read', ok: true, document: { hash, mediaType: 'application/pdf' } }, blobs: [{ hash, type: 'application/pdf' }] });
}
const stored = (/** @type {Workspace} */ ws, /** @type {string} */ hash) => ws.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(hash));

test("Delete for good: Shiori's own delete, which never went through the check, frees the file alone and says how much", async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville' });
  await ws.write(trip, '/files/note.pdf', '%PDF-1.4 Shiori filed this', { author: 'user', type: 'application/pdf' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/note.pdf', title: 'Hotel Aurora Test' }, { author: 'shiori' });
  const hash = /** @type {any} */ (await ws.read(trip, '/files/note.pdf')).entry.hash;
  await ws.delete(trip, '/files/note.pdf', { author: 'shiori' });
  const before = await snapshot(ws.store);
  const can = await freeableDeleted(ws, trip, '/files/note.pdf');
  assert.deepEqual(can, { paths: ['/files/note.pdf'], copies: [] });
  assert.deepEqual(await snapshot(ws.store), before, 'asking changes nothing');
  const ctx = ctxOf(ws);
  assert.deepEqual(await deleteForGood(ctx, trip, '/files/note.pdf', 'note.pdf'), ['/files/note.pdf']);
  assert.deepEqual(ctx.toasts, ['Deleted note.pdf for good. 26 bytes freed.']);
  assert.deepEqual(await ws.history(trip, '/files/note.pdf'), []);
  assert.equal(await stored(ws, hash), false);
  assert.equal((await ws.history(trip, '/bookings/stay.json')).length, 1, "the booking, which was never deleted, is untouched");
  assert.deepEqual(deletedFiles(await deletes(ws, trip), await ws.list(trip, '/')), []);
  assert.equal(await freeableDeleted(ws, trip, '/files/note.pdf'), null, 'nothing left to free');
});

test('Delete for good: a file the conversation names has no button, and a tap that comes too late changes nothing and says why', async () => {
  const { ws, trip } = await hotel();
  const hash = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry.hash;
  await ws.delete(trip, '/files/hotel.pdf', { author: 'shiori' });
  // Freeable now; then the conversation reads it (a wake, a second tab) before the tap.
  assert.ok(await freeableDeleted(ws, trip, '/files/hotel.pdf'));
  const ctx = ctxOf(ws);
  await conversationReads(ws, trip, hash);
  const before = await snapshot(ws.store);
  assert.equal(await freeableDeleted(ws, trip, '/files/hotel.pdf'), null);
  assert.equal(await deleteForGood(ctx, trip, '/files/hotel.pdf', 'Hotel stay'), null);
  assert.deepEqual(ctx.toasts, ['Hotel stay is still used by something else, so it stays under Deleted.']);
  assert.deepEqual(await snapshot(ws.store), before);
});

test('Delete for good: the same bytes in another trip keep it, and when that copy goes the button comes', async () => {
  const { ws, trip, details } = await hotel();
  const other = await createTrip(ws, { title: 'Elsewhere' });
  await ws.write(other, '/files/copy.pdf', '%PDF-1.4 Hotel Aurora Test', { author: 'user', type: 'application/pdf' });
  await deleteGroup(ctxOf(ws), trip, await details());
  assert.equal(await freeableDeleted(ws, trip, '/files/hotel.pdf'), null);
  await removeTrip(ws.store, other);
  assert.ok(await freeableDeleted(ws, trip, '/files/hotel.pdf'));
});

/** A hotel group deleted from its details screen and kept (another trip had the bytes), the copy then gone; its booking has an earlier life. */
async function keptGroup() {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville' });
  // An earlier life of the booking's path, deleted on its own (its JSON is tiny, and it is no part of this group).
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/talk', title: 'Earlier stay' }, { author: 'shiori' });
  const earlier = /** @type {any} */ (await ws.read(trip, '/bookings/stay.json')).entry.hash;
  await ws.delete(trip, '/bookings/stay.json', { author: 'shiori' });
  const { details } = await hotel({ ws, trip });
  const other = await createTrip(ws, { title: 'Elsewhere' });
  await ws.write(other, '/files/copy.pdf', '%PDF-1.4 Hotel Aurora Test', { author: 'user', type: 'application/pdf' });
  const ctx = ctxOf(ws);
  await deleteGroup(ctx, trip, await details());
  await removeTrip(ws.store, other);
  return { ws, trip, ctx, earlier };
}

test("Delete for good on a details screen's group frees the file and the booking and plan item it took, each only in its current life", async () => {
  const { ws, trip, ctx, earlier } = await keptGroup();
  const can = await freeableDeleted(ws, trip, '/files/hotel.pdf');
  assert.deepEqual(can?.paths, ['/files/hotel.pdf', '/bookings/stay.json', '/plan/check-in.json']);
  const before = await snapshot(ws.store);
  await freeableDeleted(ws, trip, '/files/hotel.pdf');
  assert.deepEqual(await snapshot(ws.store), before, 'asking changes nothing');
  assert.deepEqual(await deleteForGood(ctx, trip, '/files/hotel.pdf', 'Hotel stay'), can?.paths);
  assert.match(ctx.toasts.at(-1) ?? '', /^Deleted Hotel stay for good\. \d+ bytes freed\.$/);
  assert.deepEqual(await ws.history(trip, '/files/hotel.pdf'), []);
  assert.deepEqual(await ws.history(trip, '/plan/check-in.json'), []);
  // The booking's earlier life, which this group never took, stays: its write and its own delete.
  assert.deepEqual((await ws.history(trip, '/bookings/stay.json')).map((v) => [v.type, v.actor]), [['file.write', 'shiori'], ['file.delete', 'shiori']]);
  assert.equal(await stored(ws, earlier), true);
  await assert.rejects(() => restoreGroup(ws, trip, '/files/hotel.pdf'), { name: 'NotFoundError' });
});

test("Delete for good leaves alone a booking or plan path that has a file again: only what the group took and is still deleted goes", async () => {
  const { ws, trip, ctx } = await keptGroup();
  // Shiori reads another file and writes the plan item's path again; the booking's path is deleted again on its own.
  await ws.write(trip, '/plan/check-in.json', { id: 'check-in', title: 'Check in at the note', fixed: true }, { author: 'shiori' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/talk', title: 'Newer stay' }, { author: 'shiori' });
  await ws.delete(trip, '/bookings/stay.json', { author: 'shiori' });
  const planBefore = await ws.history(trip, '/plan/check-in.json');
  const bookingBefore = await ws.history(trip, '/bookings/stay.json');
  const can = await freeableDeleted(ws, trip, '/files/hotel.pdf');
  assert.deepEqual(can?.paths, ['/files/hotel.pdf']);
  await deleteForGood(ctx, trip, '/files/hotel.pdf', 'Hotel stay');
  assert.deepEqual(await ws.history(trip, '/plan/check-in.json'), planBefore);
  assert.deepEqual(await ws.history(trip, '/bookings/stay.json'), bookingBefore);
  assert.equal((await ws.readJSON(trip, '/plan/check-in.json')).title, 'Check in at the note');
});

test('Delete for good on a file deleted before the update (no mark of a group) frees the file alone', async () => {
  const { ws, trip } = await hotel();
  await ws.writeMany(trip, ['/files/hotel.pdf', '/bookings/stay.json'].map((path) => ({ path, content: null })), { author: 'user' });
  assert.deepEqual((await freeableDeleted(ws, trip, '/files/hotel.pdf'))?.paths, ['/files/hotel.pdf']);
});

// Identical deleted copies (the user's answer, 2026-11-01): either copy's Delete for good frees them all together.

const PDF = { author: 'user', type: 'application/pdf' };
/** A trip with these files, each written with its bytes, and Shiori deleting the ones named in `gone`. @param {Record<string, string>} files @param {string[]} gone */
async function trove(files, gone) {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville' });
  for (const [path, bytes] of Object.entries(files)) await ws.write(trip, path, bytes, PDF);
  for (const path of gone) await ws.delete(trip, path, { author: 'shiori' });
  return { ws, trip };
}
const SAME = '%PDF-1.4 the very same file, twice';

test('Delete for good: two deleted copies of one file show it on either, one tap frees both, and the toast says "1 other copy"', async () => {
  for (const tapped of ['/files/a.pdf', '/files/b.pdf']) {
    const { ws, trip } = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME }, ['/files/a.pdf', '/files/b.pdf']);
    const hash = /** @type {any} */ (await ws.history(trip, '/files/a.pdf')).at(0).new;
    const before = await snapshot(ws.store);
    const can = await freeableDeleted(ws, trip, tapped);
    assert.deepEqual(can?.paths, [tapped, tapped === '/files/a.pdf' ? '/files/b.pdf' : '/files/a.pdf']);
    assert.deepEqual(can?.copies, [tapped === '/files/a.pdf' ? '/files/b.pdf' : '/files/a.pdf']);
    assert.deepEqual(await snapshot(ws.store), before, 'a dry run changes nothing');
    const ctx = ctxOf(ws);
    assert.deepEqual(await deleteForGood(ctx, trip, tapped, tapped.split('/').pop() ?? ''), can?.paths);
    assert.deepEqual(ctx.toasts, [`Deleted ${tapped.split('/').pop()} and 1 other copy for good. ${SAME.length} bytes freed.`]);
    for (const p of ['/files/a.pdf', '/files/b.pdf']) assert.deepEqual(await ws.history(trip, p), [], p);
    assert.equal(await stored(ws, hash), false);
    assert.deepEqual(deletedFiles(await deletes(ws, trip), await ws.list(trip, '/')), [], 'both rows leave Deleted');
  }
});

test('Delete for good: three deleted copies are "2 other copies"', async () => {
  const three = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME, '/files/c.pdf': SAME }, ['/files/a.pdf', '/files/b.pdf', '/files/c.pdf']);
  const ctx = ctxOf(three.ws);
  assert.deepEqual((await freeableDeleted(three.ws, three.trip, '/files/b.pdf'))?.copies, ['/files/a.pdf', '/files/c.pdf']);
  await deleteForGood(ctx, three.trip, '/files/b.pdf', 'b.pdf');
  assert.deepEqual(ctx.toasts, [`Deleted b.pdf and 2 other copies for good. ${SAME.length} bytes freed.`]);
});

test("Delete for good: copies have exactly the same stored versions; a deleted file that shares only some of them is no copy, and neither is freed (a known limitation)", async () => {
  // a: one. b: one, two. c: two. Linked in a chain, but no two have the same versions: nothing is freed, nothing changes.
  const { ws, trip } = await trove({ '/files/a.pdf': 'one', '/files/b.pdf': 'one', '/files/c.pdf': 'two' }, []);
  await ws.write(trip, '/files/b.pdf', 'two', PDF);
  for (const p of ['/files/a.pdf', '/files/b.pdf', '/files/c.pdf']) await ws.delete(trip, p, { author: 'shiori' });
  const before = await snapshot(ws.store);
  for (const p of ['/files/a.pdf', '/files/b.pdf', '/files/c.pdf']) assert.equal(await freeableDeleted(ws, trip, p), null, p);
  const ctx = ctxOf(ws);
  assert.equal(await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf'), null);
  assert.deepEqual(await snapshot(ws.store), before);
});

test('Delete for good: copies with the same two versions, in either order, are copies', async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': 'one', '/files/b.pdf': 'two' }, []);
  await ws.write(trip, '/files/a.pdf', 'two', PDF);
  await ws.write(trip, '/files/b.pdf', 'one', PDF);
  for (const p of ['/files/a.pdf', '/files/b.pdf']) await ws.delete(trip, p, { author: 'shiori' });
  assert.deepEqual(await freeableDeleted(ws, trip, '/files/a.pdf'), { paths: ['/files/a.pdf', '/files/b.pdf'], copies: ['/files/b.pdf'] });
});

test('Delete for good: a newer file of the same name that the conversation names is no copy of an older duplicate, and survives with its booking', async () => {
  // hotel.pdf and hotel-2.pdf are the same bytes, both deleted. Then hotel.pdf gets an updated confirmation, Shiori reads it
  // into a booking, and it is deleted too and kept (the conversation names it).
  const { ws, trip } = await trove({ '/files/hotel.pdf': SAME, '/files/hotel-2.pdf': SAME }, ['/files/hotel.pdf', '/files/hotel-2.pdf']);
  await ws.write(trip, '/files/hotel.pdf', '%PDF-1.4 the updated confirmation', PDF);
  const newer = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry.hash;
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/hotel.pdf', title: 'Hotel' }, { author: 'shiori' });
  await conversationReads(ws, trip, newer);
  await ws.writeMany(trip, [{ path: '/files/hotel.pdf', content: null }, { path: '/bookings/stay.json', content: null }], { author: 'user', with: '/files/hotel.pdf' });
  const before = await snapshot(ws.store);
  assert.equal(await freeableDeleted(ws, trip, '/files/hotel-2.pdf'), null, 'no button on the older duplicate');
  assert.equal(await freeableDeleted(ws, trip, '/files/hotel.pdf'), null);
  const ctx = ctxOf(ws);
  assert.equal(await deleteForGood(ctx, trip, '/files/hotel-2.pdf', 'hotel-2.pdf'), null);
  assert.deepEqual(await snapshot(ws.store), before, 'the newer file, its booking and its whole history are all still there');
  assert.equal(await stored(ws, newer), true);
  assert.equal((await ws.history(trip, '/bookings/stay.json')).length, 2);
});

test('Delete for good: a newer file of the same name that Shiori deleted is no copy of an older duplicate: it, its booking and its history survive (the reviewed data loss)', async () => {
  const { ws, trip } = await trove({ '/files/hotel.pdf': SAME, '/files/hotel-2.pdf': SAME }, ['/files/hotel.pdf', '/files/hotel-2.pdf']);
  await ws.write(trip, '/files/hotel.pdf', '%PDF-1.4 the updated confirmation', PDF);
  const newer = /** @type {any} */ (await ws.read(trip, '/files/hotel.pdf')).entry.hash;
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/hotel.pdf', title: 'Hotel' }, { author: 'shiori' });
  await ws.delete(trip, '/files/hotel.pdf', { author: 'shiori' });
  const before = await snapshot(ws.store);
  assert.equal(await freeableDeleted(ws, trip, '/files/hotel-2.pdf'), null);
  assert.equal(await freeableDeleted(ws, trip, '/files/hotel.pdf'), null);
  assert.equal(await deleteForGood(ctxOf(ws), trip, '/files/hotel-2.pdf', 'hotel-2.pdf'), null);
  assert.deepEqual(await snapshot(ws.store), before);
  assert.equal(await stored(ws, newer), true);
  assert.equal((await ws.history(trip, '/files/hotel.pdf')).length, 4);
  assert.equal((await ws.readJSON(trip, '/bookings/stay.json')).id, 'stay');
});

test("deletedName: the name a deleted file is shown by is the short name its delete carried, else Shiori's, else its own", async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME, '/files/c.pdf': SAME }, []);
  await ws.writeMany(trip, [{ path: '/files/a.pdf', content: null }], { author: 'user', with: '/files/a.pdf', name: 'Hotel stay' });
  await ws.delete(trip, '/files/b.pdf', { author: 'shiori' });
  await ws.delete(trip, '/files/c.pdf', { author: 'shiori' });
  const deletes_ = await deletes(ws, trip);
  const names = { '/files/b.pdf': 'Flight', '/files/c.pdf': 'c.pdf' };
  assert.deepEqual(['/files/a.pdf', '/files/b.pdf', '/files/c.pdf'].map((p) => deletedName(names, deletes_, p)), ['Hotel stay', 'Flight', 'c.pdf']);
});

test('Delete for good: with a copy that is still a current file, there is no button on the deleted ones, and a late tap changes nothing', async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME, '/files/c.pdf': SAME }, ['/files/a.pdf', '/files/b.pdf']);
  const before = await snapshot(ws.store);
  assert.equal(await freeableDeleted(ws, trip, '/files/a.pdf'), null);
  assert.equal(await freeableDeleted(ws, trip, '/files/b.pdf'), null);
  const ctx = ctxOf(ws);
  assert.equal(await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf'), null);
  assert.deepEqual(ctx.toasts, ['a.pdf is still used by something else, so it stays under Deleted.']);
  assert.deepEqual(await snapshot(ws.store), before);
});

test('Delete for good: when the conversation names the content, or another trip has it, neither copy can be freed', async () => {
  const named = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME }, ['/files/a.pdf', '/files/b.pdf']);
  await conversationReads(named.ws, named.trip, /** @type {any} */ (await named.ws.history(named.trip, '/files/a.pdf')).at(0).new);
  assert.equal(await freeableDeleted(named.ws, named.trip, '/files/a.pdf'), null);
  assert.equal(await freeableDeleted(named.ws, named.trip, '/files/b.pdf'), null);
  const away = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME }, ['/files/a.pdf', '/files/b.pdf']);
  await away.ws.write(ME, '/files/elsewhere.pdf', SAME, PDF);
  assert.equal(await freeableDeleted(away.ws, away.trip, '/files/a.pdf'), null);
});

test("Delete for good: a copy's other version that the conversation names keeps both copies whole, history and all", async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': 'b first' }, []);
  await ws.write(trip, '/files/b.pdf', SAME, PDF);
  await conversationReads(ws, trip, /** @type {any} */ (await ws.history(trip, '/files/b.pdf')).at(0).new);
  for (const p of ['/files/a.pdf', '/files/b.pdf']) await ws.delete(trip, p, { author: 'shiori' });
  const before = await snapshot(ws.store);
  assert.equal(await freeableDeleted(ws, trip, '/files/a.pdf'), null);
  const ctx = ctxOf(ws);
  assert.equal(await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf'), null);
  assert.deepEqual(await snapshot(ws.store), before, "b's history is not touched");
});

test("Delete for good on copies also frees each copy's own group, each booking in its current life only", async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME }, []);
  await ws.write(trip, '/bookings/one.json', { id: 'one' }, { author: 'shiori' });
  await ws.write(trip, '/bookings/two.json', { id: 'two' }, { author: 'shiori' });
  await ws.write(trip, '/bookings/kept.json', { id: 'kept', v: 1 }, { author: 'shiori' });
  await ws.delete(trip, '/bookings/kept.json', { author: 'shiori' }); // an earlier life, no part of any group
  await ws.write(trip, '/bookings/kept.json', { id: 'kept', v: 2 }, { author: 'shiori' });
  await ws.writeMany(trip, [{ path: '/files/a.pdf', content: null }, { path: '/bookings/one.json', content: null }], { author: 'user', with: '/files/a.pdf' });
  await ws.writeMany(trip, [{ path: '/files/b.pdf', content: null }, { path: '/bookings/two.json', content: null }, { path: '/bookings/kept.json', content: null }], { author: 'user', with: '/files/b.pdf' });
  const can = await freeableDeleted(ws, trip, '/files/a.pdf');
  assert.deepEqual(can?.paths, ['/files/a.pdf', '/bookings/one.json', '/files/b.pdf', '/bookings/two.json', '/bookings/kept.json']);
  await deleteForGood(ctxOf(ws), trip, '/files/a.pdf', 'a.pdf');
  for (const p of ['/files/a.pdf', '/files/b.pdf', '/bookings/one.json', '/bookings/two.json']) assert.deepEqual(await ws.history(trip, p), [], p);
  assert.deepEqual((await ws.history(trip, '/bookings/kept.json')).map((v) => v.type), ['file.write', 'file.delete'], "the booking's earlier life stays");
});

test('Delete for good: a dry run reads no blob bytes, however many copies; the real tap still reports the size', async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME, '/files/b.pdf': SAME }, ['/files/a.pdf', '/files/b.pdf']);
  const reads = noteBlobReads(ws.store);
  assert.ok(await freeableDeleted(ws, trip, '/files/a.pdf'));
  assert.equal(reads.whole, 0, 'the screen loads no blob');
  const ctx = ctxOf(ws);
  await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf');
  assert.ok(reads.whole > 0);
  assert.match(ctx.toasts[0], /bytes freed\.$/);
});

test('Delete for good: a stale tap on a file that came back changes nothing, says it is back, and returns null for the screen to re-render', async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME }, ['/files/a.pdf']);
  await restoreGroup(ws, trip, '/files/a.pdf'); // in another tab
  const before = await snapshot(ws.store);
  const ctx = ctxOf(ws);
  assert.equal(await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf'), null);
  assert.deepEqual(ctx.toasts, ['a.pdf is already back.']);
  assert.deepEqual(await snapshot(ws.store), before);
  assert.equal(await freeableDeleted(ws, trip, '/files/a.pdf'), null);
});

/** A store that lets a write go in just before the first transaction that can free blobs: another tab, between this tab's reads and its forget. @param {Workspace} ws @param {() => Promise<unknown>} interleave */
function racing(ws, interleave) {
  let raced = false;
  const store = ws.store;
  return {
    get raced() { return raced; },
    store: /** @type {any} */ ({
      ...store,
      tx: (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => {
        if (!raced && mode === 'readwrite' && stores.includes('blobs')) {
          raced = true;
          return interleave().then(() => store.tx(stores, mode, fn));
        }
        return store.tx(stores, mode, fn);
      },
    }),
  };
}

test("Delete for good: a booking another tab writes again just before the free keeps its whole history and every version's content", async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME }, []);
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', v: 1 }, { author: 'shiori' });
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', v: 2 }, { author: 'shiori' });
  await ws.writeMany(trip, [{ path: '/files/a.pdf', content: null }, { path: '/bookings/stay.json', content: null }], { author: 'user', with: '/files/a.pdf' });
  const old = (await ws.history(trip, '/bookings/stay.json')).filter((v) => v.type === 'file.write').map((v) => /** @type {any} */ (v).new);
  const race = racing(ws, () => ws.write(trip, '/bookings/stay.json', { id: 'stay', v: 3 }, { author: 'shiori' }));
  const ctx = { ...ctxOf(ws), store: race.store };
  await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf');
  assert.ok(race.raced);
  assert.equal((await ws.readJSON(trip, '/bookings/stay.json')).v, 3);
  assert.equal((await ws.history(trip, '/bookings/stay.json')).filter((v) => v.type === 'file.write').length, 3, 'no version of the live booking was forgotten');
  for (const h of old) assert.equal(await stored(ws, h), true, 'its old content is still stored');
  assert.deepEqual(await ws.history(trip, '/files/a.pdf'), [], 'the file itself went');
});

test('Delete in Files: a booking another tab writes again just before the forget keeps its whole history', async () => {
  const { ws, trip, details } = await hotel();
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/hotel.pdf', title: 'Hotel Aurora Test', v: 2 }, { author: 'shiori' });
  const d = await details();
  // writeMany runs through ws.store; the forget through the context's store, where the write goes in first.
  const race = racing(ws, () => ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/talk', title: 'Newer', v: 3 }, { author: 'shiori' }));
  const ctx = { ...ctxOf(ws), store: race.store };
  await deleteGroup(ctx, trip, d);
  assert.ok(race.raced);
  assert.equal((await ws.readJSON(trip, '/bookings/stay.json')).v, 3);
  assert.equal((await ws.history(trip, '/bookings/stay.json')).filter((v) => v.type === 'file.write').length, 3);
  assert.deepEqual(await ws.history(trip, '/files/hotel.pdf'), [], 'the file itself was freed');
});

test('Delete for good: a failed read (another tab took the data over) is explained by a toast, and nothing rejects', async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME }, ['/files/a.pdf']);
  ws.store.close();
  const ctx = ctxOf(ws);
  assert.equal(await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf'), null);
  assert.equal(ctx.toasts.length, 1);
});

test('Delete for good: a file whose only content is empty frees no space, so it has no button', async () => {
  const { ws, trip } = await trove({ '/files/empty.pdf': '' }, ['/files/empty.pdf']);
  const before = await snapshot(ws.store);
  assert.equal(await freeableDeleted(ws, trip, '/files/empty.pdf'), null);
  assert.deepEqual(await snapshot(ws.store), before);
  // With a version that has bytes, or a booking in its group, there is something to free.
  const some = await trove({ '/files/empty.pdf': '' }, []);
  await some.ws.write(some.trip, '/files/empty.pdf', SAME, PDF);
  await some.ws.delete(some.trip, '/files/empty.pdf', { author: 'shiori' });
  assert.ok(await freeableDeleted(some.ws, some.trip, '/files/empty.pdf'));
});

test("Delete for good: an empty file's group still shows the button when it has a booking with content to free", async () => {
  const { ws, trip } = await trove({ '/files/empty.pdf': '' }, []);
  await ws.write(trip, '/bookings/stay.json', { id: 'stay', kind: 'lodging' }, { author: 'shiori' });
  await ws.writeMany(trip, [{ path: '/files/empty.pdf', content: null }, { path: '/bookings/stay.json', content: null }], { author: 'user', with: '/files/empty.pdf' });
  assert.deepEqual((await freeableDeleted(ws, trip, '/files/empty.pdf'))?.paths, ['/files/empty.pdf', '/bookings/stay.json']);
});

test('Delete for good: a file restored in another tab between the reads and the free is "already back", not "still used by something else"', async () => {
  const { ws, trip } = await trove({ '/files/a.pdf': SAME }, ['/files/a.pdf']);
  const race = racing(ws, () => restoreGroup(ws, trip, '/files/a.pdf'));
  const ctx = { ...ctxOf(ws), store: race.store };
  assert.equal(await deleteForGood(ctx, trip, '/files/a.pdf', 'a.pdf'), null);
  assert.ok(race.raced);
  assert.deepEqual(ctx.toasts, ['a.pdf is already back.']);
  assert.equal((await ws.list(trip, '/files/')).length, 1);
  assert.equal((await ws.history(trip, '/files/a.pdf')).length, 3, 'its history is whole');
});
