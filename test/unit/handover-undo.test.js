import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { ensureBaseScopes, createTrip, removeTrip, kindOf, SYS_WAITING } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { record } from '../../src/core/agent/log.js';
import { undoHandover, undoable, filesToRead } from '../../src/core/handover.js';
import { readNames, syncNames } from '../../src/core/names.js';
import { moveFile } from '../../src/core/waiting.js';
import { utf8 } from '../../src/core/bytes.js';

const HERS = { author: 'shiori', handover: 'h-1' };
const flightBooking = { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'AS 123' };
const hotelBooking = { id: 'hotel', kind: 'lodging', status: 'unverified', source: '/files/hotel.png', title: 'Hotel Aurora Test' };
const fly = { id: 'fly', title: 'Fly to Anchorage', fixed: true, booking: '/bookings/flight.json' };

async function kit() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  // A trip of the user's, dates typed by hand, with the hand-over's files moved in (written as the user's, with the hand-over).
  const trip = await createTrip(ws, { title: 'Anchorage', start: '2026-11-18', end: '2026-11-28' });
  await ws.write(trip, '/files/flight.pdf', utf8('%PDF flight'), { author: 'user', type: 'application/pdf', handover: 'h-1' });
  return { store, ws, trip };
}
/** @param {any} store @param {string} scope @param {string[]} types */
const eventsIn = (store, scope, types) => store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types }));

test('undo takes back her bookings and plan items from the hand-over: added ones go, changed ones come back as they were; the files stay', async () => {
  const { ws, trip } = await kit();
  await ws.write(trip, '/bookings/flight.json', flightBooking, HERS);
  await ws.write(trip, '/plan/fly.json', fly, HERS);
  await ws.patch(trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, HERS);
  await ws.patch(trip, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { ...HERS, create: true });
  const out = await undoHandover(ws, trip, 'h-1');
  assert.deepEqual(out.undone.sort(), ['/bookings/flight.json', '/plan/fly.json', '/trip.json']);
  assert.deepEqual([out.kept, out.tripEmpty], [[], false]);
  assert.equal(await ws.read(trip, '/bookings/flight.json'), undefined);
  assert.equal(await ws.read(trip, '/plan/fly.json'), undefined);
  assert.equal((await ws.readJSON(trip, '/trip.json')).start, '2026-11-18'); // dates the user had typed (My call 7)
  assert.ok(await ws.read(trip, '/files/flight.pdf'));
  assert.deepEqual(await ws.readJSON(trip, '/names.json'), { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' });
  // Undone as the user, and said once.
  assert.equal((await ws.history(trip, '/trip.json')).at(-1)?.actor, 'user');
  const [undo] = await eventsIn(ws.store, trip, ['handover.undo']);
  assert.deepEqual([undo.actor, undo.data], ['user', { handover: 'h-1', undone: 3, kept: [] }]);
});

test('undo leaves what the user changed since, and names it', async () => {
  const { ws, trip } = await kit();
  await ws.write(trip, '/bookings/flight.json', flightBooking, HERS);
  await ws.write(trip, '/bookings/hotel.json', hotelBooking, HERS);
  await ws.patch(trip, '/bookings/hotel.json', { title: 'Hotel Aurora Test, tower room' }, { author: 'user' });
  const out = await undoHandover(ws, trip, 'h-1');
  assert.deepEqual(out.undone, ['/bookings/flight.json']);
  assert.deepEqual(out.kept, ['/bookings/hotel.json']);
  assert.equal((await ws.readJSON(trip, '/bookings/hotel.json')).title, 'Hotel Aurora Test, tower room');
});

test("undo never touches another hand-over's writes, her writes outside one, the user's own, or names.json", async () => {
  const { ws, trip } = await kit();
  await ws.write(trip, '/bookings/flight.json', flightBooking, HERS);
  await ws.write(trip, '/bookings/hotel.json', hotelBooking, { author: 'shiori', handover: 'h-2' });
  await ws.write(trip, '/notes/dinner.md', 'Dinner at 7', { author: 'shiori' });
  await ws.write(trip, '/notes/mine.md', 'Mine', { author: 'user' });
  await ws.patch(trip, '/names.json', { '/files/flight.pdf': 'Alaska flight' }, { ...HERS, create: true });
  // Her later write outside the hand-over, to a file the hand-over made: it is kept, as a change since.
  await ws.write(trip, '/plan/fly.json', fly, HERS);
  await ws.patch(trip, '/plan/fly.json', { notes: 'Window seat' }, { author: 'shiori' });
  const out = await undoHandover(ws, trip, 'h-1');
  assert.deepEqual(out.undone, ['/bookings/flight.json']);
  assert.deepEqual(out.kept, ['/plan/fly.json']);
  for (const p of ['/bookings/hotel.json', '/notes/dinner.md', '/notes/mine.md', '/names.json', '/plan/fly.json']) assert.ok(await ws.read(trip, p), p);
});

test("a trip she started for the hand-over: empty of the user's, tripEmpty with the files it brought; with a message or a photo of theirs, it stays emptied of her writes and keeps its trip.json", async () => {
  const { store, ws } = await kit();
  const started = await createTrip(ws, { title: 'Anchorage · Nov 20–27', start: '2026-11-20', end: '2026-11-27' }, { author: 'shiori', handover: 'h-1' });
  await ws.write(started, '/files/flight.pdf', utf8('%PDF flight'), { author: 'user', type: 'application/pdf', handover: 'h-1' });
  await record(store, started, { type: 'msg.user', actor: 'user', data: { handed: [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }], handover: 'h-1', from: 'me' }, texts: [['text', '(files)']] });
  await ws.write(started, '/bookings/flight.json', flightBooking, HERS);
  assert.deepEqual(await undoHandover(ws, started, 'h-1'), { undone: ['/bookings/flight.json'], kept: [], keptKeys: [], tripEmpty: true, files: ['/files/flight.pdf'] });
  assert.ok(await ws.read(started, '/trip.json'));
  assert.ok(await ws.read(started, '/memory.md'));

  const again = await createTrip(ws, { title: 'Kyoto' }, { author: 'shiori', handover: 'h-3' });
  await ws.write(again, '/files/temple.pdf', utf8('%PDF temple'), { author: 'user', type: 'application/pdf', handover: 'h-3' });
  await ws.write(again, '/bookings/temple.json', { ...flightBooking, id: 'temple', kind: 'event', source: '/files/temple.pdf' }, { author: 'shiori', handover: 'h-3' });
  await record(store, again, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Also the ryokan']] });
  const out = await undoHandover(ws, again, 'h-3');
  assert.deepEqual([out.undone, out.tripEmpty], [['/bookings/temple.json'], false]);
  assert.ok(await ws.read(again, '/trip.json'));

  const photo = await createTrip(ws, { title: 'Big Sur' }, { author: 'shiori', handover: 'h-4' });
  await ws.write(photo, '/files/coast.jpg', utf8('a photo of the coast'), { author: 'user', type: 'image/jpeg' });
  assert.equal((await undoHandover(ws, photo, 'h-4')).tripEmpty, false);
});

test('undoable: true with something to take back, false once undone; a second undo changes nothing (Review Focus 5)', async () => {
  const { store, ws, trip } = await kit();
  assert.equal(await undoable(store, trip, 'h-1'), false, 'only the files it brought: nothing of hers to take back');
  await ws.write(trip, '/bookings/flight.json', flightBooking, HERS);
  assert.equal(await undoable(store, trip, 'h-1'), true);
  assert.equal(await undoable(store, trip, 'h-9'), false);
  await undoHandover(ws, trip, 'h-1');
  assert.equal(await undoable(store, trip, 'h-1'), false);
  const before = await eventsIn(store, trip, ['file.write', 'file.delete', 'handover.undo']);
  assert.deepEqual(await undoHandover(ws, trip, 'h-1'), { undone: [], kept: [], keptKeys: [], tripEmpty: false, files: [] });
  assert.equal((await eventsIn(store, trip, ['file.write', 'file.delete', 'handover.undo'])).length, before.length);
  // A trip she started is undoable for it; once removed by hand, undo is no error.
  const started = await createTrip(ws, { title: 'Kyoto' }, { author: 'shiori', handover: 'h-2' });
  assert.equal(await undoable(store, started, 'h-2'), true);
  await removeTrip(store, started);
  assert.equal(await undoable(store, started, 'h-2'), false);
  assert.deepEqual(await undoHandover(ws, started, 'h-2'), { undone: [], kept: [], keptKeys: [], tripEmpty: false, files: [] });
});

test('filesToRead: the files of wakes after her last turn; none once a turn has answered them', async () => {
  const { store, ws, trip } = await kit();
  await ws.write(trip, '/files/hotel.png', utf8('hotel'), { author: 'user', type: 'image/png' });
  await record(store, trip, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'file', text: 'moved here', files: ['/files/flight.pdf'] }] } });
  await record(store, trip, { type: 'wake', actor: 'system', data: { id: 'w-2', reasons: [{ kind: 'file', text: 'moved here', files: ['/files/hotel.png', '/files/flight.pdf'] }] } });
  await record(store, trip, { type: 'wake', actor: 'system', data: { id: 'w-2', meanwhile: true, reasons: [{ kind: 'file', text: 'x', files: ['/files/other.pdf'] }] } });
  assert.deepEqual(await filesToRead(store, trip), ['/files/flight.pdf', '/files/hotel.png']);
  await record(store, trip, { type: 'model.turn', actor: 'shiori', data: { wake: 'w-2' } });
  assert.deepEqual(await filesToRead(store, trip), []);
});

// The fix pass.

test('a file she created and then changed for the hand-over goes, never back to her own first version', async () => {
  const { ws, trip } = await kit();
  await ws.write(trip, '/bookings/flight.json', flightBooking, HERS);
  await ws.patch(trip, '/bookings/flight.json', { title: 'AN 123' }, HERS);
  assert.deepEqual((await undoHandover(ws, trip, 'h-1')).undone, ['/bookings/flight.json']);
  assert.equal(await ws.read(trip, '/bookings/flight.json'), undefined);
});

test("the user's own change to a trip she started (its name, its memory) keeps the trip", async () => {
  for (const change of [
    async (/** @type {any} */ ws, /** @type {string} */ s) => ws.patch(s, '/trip.json', { title: 'Our Testville trip' }, { author: 'user' }),
    async (/** @type {any} */ ws, /** @type {string} */ s) => ws.write(s, '/memory.md', '# Trip memory\nThe ferry on day two\n', { author: 'user' }),
  ]) {
    const { ws } = await kit();
    const started = await createTrip(ws, { title: 'Testville · Nov 20–27' }, { author: 'shiori', handover: 'h-1' });
    await ws.write(started, '/bookings/flight.json', flightBooking, HERS);
    await change(ws, started);
    assert.equal((await undoHandover(ws, started, 'h-1')).tripEmpty, false);
  }
});

test('Undo puts a file she deleted back with its short name', async () => {
  const { ws, trip } = await kit();
  syncNames(ws);
  await ws.patch(trip, '/names.json', { '/files/flight.pdf': 'ANNAI AIR · Nov 20' }, { author: 'shiori', create: true });
  await ws.delete(trip, '/files/flight.pdf', HERS);
  assert.deepEqual(await readNames(ws, trip), {});
  await undoHandover(ws, trip, 'h-1');
  assert.ok(await ws.read(trip, '/files/flight.pdf'));
  assert.deepEqual(await readNames(ws, trip), { '/files/flight.pdf': 'ANNAI AIR · Nov 20' });
});

test('a file moved out of a trip comes back to it, with its short name, and leaves where it went; in whichever order the two are undone', async () => {
  for (const order of ['from first', 'to first']) {
    const { store, ws, trip } = await kit();
    syncNames(ws);
    const kyoto = await createTrip(ws, { title: 'Kyoto' });
    await ws.patch(trip, '/names.json', { '/files/flight.pdf': 'ANNAI AIR · Nov 20' }, { author: 'shiori', create: true });
    const there = await moveFile(ws, { scope: trip, path: '/files/flight.pdf' }, kyoto, { handover: 'h-1' });
    const [moved] = (await eventsIn(store, trip, ['file.delete'])).filter((/** @type {any} */ e) => e.data.path === '/files/flight.pdf');
    assert.deepEqual(moved.data.moved, { to: kyoto, path: there });
    for (const s of order === 'from first' ? [trip, kyoto] : [kyoto, trip]) await undoHandover(ws, s, 'h-1');
    assert.ok(await ws.read(trip, '/files/flight.pdf'), order);
    assert.equal(await ws.read(kyoto, there), undefined, order);
    assert.deepEqual(await readNames(ws, trip), { '/files/flight.pdf': 'ANNAI AIR · Nov 20' }, order);
    assert.deepEqual(await readNames(ws, kyoto), {}, order);
  }
});

test('a file moved from a trip into a trip she started goes back where it came from, never to the waiting space too', async () => {
  const { store, ws, trip } = await kit();
  const started = await createTrip(ws, { title: 'Testville' }, { author: 'shiori', handover: 'h-1' });
  await moveFile(ws, { scope: trip, path: '/files/flight.pdf' }, started, { handover: 'h-1' });
  const out = await undoHandover(ws, started, 'h-1');
  assert.deepEqual([out.tripEmpty, out.files], [true, []]); // the caller removes the trip; nothing goes to the waiting space
  assert.ok(await ws.read(trip, '/files/flight.pdf'));
  await removeTrip(store, started);
  assert.deepEqual((await undoHandover(ws, trip, 'h-1')).undone, []);
  assert.ok(await ws.read(trip, '/files/flight.pdf'));
});

test('a moved file the user changed where it went stays there, named as kept, and is not put back too', async () => {
  const { ws, trip } = await kit();
  const kyoto = await createTrip(ws, { title: 'Kyoto' });
  const there = await moveFile(ws, { scope: trip, path: '/files/flight.pdf' }, kyoto, { handover: 'h-1' });
  await ws.write(kyoto, there, utf8('%PDF flight, marked up'), { author: 'user', type: 'application/pdf' });
  const out = await undoHandover(ws, trip, 'h-1');
  assert.deepEqual(out.kept, ['/files/flight.pdf']);
  assert.equal(await ws.read(trip, '/files/flight.pdf'), undefined);
  assert.ok(await ws.read(kyoto, there));
});

test('an Undo cut off before the trip she started was removed can finish: it is still undoable, and says the trip is empty', async () => {
  const { store, ws } = await kit();
  const started = await createTrip(ws, { title: 'Testville' }, { author: 'shiori', handover: 'h-1' });
  await ws.write(started, '/bookings/flight.json', flightBooking, HERS);
  assert.equal((await undoHandover(ws, started, 'h-1')).tripEmpty, true);
  // The page closed here, before the trip was removed.
  assert.equal(await undoable(store, started, 'h-1'), true);
  assert.equal((await undoHandover(ws, started, 'h-1')).tripEmpty, true);
  assert.equal((await eventsIn(store, started, ['handover.undo'])).length, 1);
});

// Fix round 2.

test('a handed file she deleted in a trip she started is put back by Undo, and goes back to wait with the others', async () => {
  const { ws } = await kit();
  syncNames(ws);
  const started = await createTrip(ws, { title: 'Testville' }, { author: 'shiori', handover: 'h-1' });
  await ws.write(SYS_WAITING, '/files/flight.pdf', utf8('%PDF flight'), { author: 'user', type: 'application/pdf' });
  await ws.write(SYS_WAITING, '/files/pasted-2026-10-28-0310.txt', utf8('Thanks!\nSee you\nSam\nx'), { author: 'user', type: 'text/plain' });
  for (const p of ['/files/flight.pdf', '/files/pasted-2026-10-28-0310.txt']) await moveFile(ws, { scope: SYS_WAITING, path: p }, started, { handover: 'h-1' });
  // She names both, then deletes the note that isn't a booking: the name goes with it (syncNames, annai's own write).
  await ws.patch(started, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight', '/files/pasted-2026-10-28-0310.txt': 'A thank-you note' }, { ...HERS, create: true });
  await ws.delete(started, '/files/pasted-2026-10-28-0310.txt', HERS);
  const out = await undoHandover(ws, started, 'h-1');
  assert.equal(out.tripEmpty, true, 'annai keeping names in step is nothing of the user\'s');
  assert.deepEqual(out.files.sort(), ['/files/flight.pdf', '/files/pasted-2026-10-28-0310.txt']);
});

test("Undo's counts: a file moved out and changed by her where it went, for the same hand-over, goes back and counts once as undone; one the user changed is kept, counted once", async () => {
  for (const who of ['shiori', 'user']) {
    for (const order of ['from first', 'to first']) {
      const { ws, trip } = await kit();
      const kyoto = await createTrip(ws, { title: 'Kyoto' });
      await ws.write(trip, '/files/note.txt', utf8('temple at 9'), { author: 'user', type: 'text/plain' });
      const there = await moveFile(ws, { scope: trip, path: '/files/note.txt' }, kyoto, { handover: 'h-1' });
      await ws.write(kyoto, there, utf8('temple at 10'), { author: who, type: 'text/plain', ...(who === 'shiori' ? { handover: 'h-1' } : {}) });
      const outs = [];
      for (const s of order === 'from first' ? [trip, kyoto] : [kyoto, trip]) outs.push(await undoHandover(ws, s, 'h-1'));
      const kept = new Set(outs.flatMap((o) => o.keptKeys));
      const inTrip = await ws.readText(trip, '/files/note.txt');
      const inKyoto = await ws.readText(kyoto, there);
      if (who === 'shiori') {
        assert.deepEqual([inTrip, inKyoto, kept.size], ['temple at 9', undefined, 0], `${who} ${order}`);
      } else {
        assert.deepEqual([inTrip, inKyoto, kept.size], [undefined, 'temple at 10', 1], `${who} ${order}`);
      }
    }
  }
});
