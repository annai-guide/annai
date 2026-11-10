import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { ensureBaseScopes, createTrip, removeTrip, kindOf, SYS_WAITING, ME } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { record } from '../../src/core/agent/log.js';
import { undoHandover, undoable, filesToRead, undoEverywhere } from '../../src/core/handover.js';
import { Transcript } from '../../src/core/agent/transcript.js';
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

test("a voice-first chat: the system's naming write after her turn is not the user's change; Undo takes back her dates and keeps the name", async () => {
  const { ws } = await kit();
  const chat = await createTrip(ws, { title: 'New conversation' });
  await ws.write(chat, '/bookings/flight.json', flightBooking, HERS);
  await ws.patch(chat, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, HERS);
  await ws.patch(chat, '/trip.json', { title: 'Plan our weekend in Testville' }, { author: 'system' }); // the heard line's words came after her turn
  const out = await undoHandover(ws, chat, 'h-1');
  assert.deepEqual(out.kept, [], 'no change of the user');
  assert.deepEqual(out.undone.sort(), ['/bookings/flight.json', '/trip.json']);
  const trip = await ws.readJSON(chat, '/trip.json');
  assert.equal(trip.start, undefined);
  assert.equal(trip.end, undefined);
  assert.equal(trip.title, 'Plan our weekend in Testville', 'the name stays');
  assert.equal(await ws.read(chat, '/bookings/flight.json'), undefined);
  assert.equal((await ws.history(chat, '/trip.json')).at(-1)?.actor, 'user');
  // A user's own rename after her turn is still a change of theirs: kept as it is.
  const other = await createTrip(ws, { title: 'New conversation' });
  await ws.patch(other, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, HERS);
  await ws.patch(other, '/trip.json', { title: 'Weekend' }, { author: 'user' });
  assert.deepEqual((await undoHandover(ws, other, 'h-1')).kept, ['/trip.json']);
});

test("a voice-first chat she named and dated in one write, before its words came: Undo takes back what she wrote but keeps her name, never \"New conversation\"", async () => {
  const { ws } = await kit();
  const chat = await createTrip(ws, { title: 'New conversation' });
  await ws.patch(chat, '/trip.json', { title: 'Testville weekend', start: '2026-11-20', end: '2026-11-27', places: ['Testville'] }, HERS);
  // The heard line's words come after her turn: the chat has a name already, so the system writes nothing.
  const out = await undoHandover(ws, chat, 'h-1');
  assert.deepEqual([out.undone, out.kept], [['/trip.json'], []]);
  const trip = await ws.readJSON(chat, '/trip.json');
  assert.deepEqual([trip.title, trip.start, trip.end, trip.places], ['Testville weekend', undefined, undefined, []]); // her places go too: they were hers
  assert.equal((await ws.history(chat, '/trip.json')).at(-1)?.actor, 'user');
  // A chat named before her turn (its first line typed) gets that name back, as before.
  const typed = await createTrip(ws, { title: 'Plan our weekend' });
  await ws.patch(typed, '/trip.json', { title: 'Testville weekend', start: '2026-11-20' }, HERS);
  await undoHandover(ws, typed, 'h-1');
  const back = await ws.readJSON(typed, '/trip.json');
  assert.deepEqual([back.title, back.start], ['Plan our weekend', undefined]);
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
  // Undo sends what it moved back to wait itself, the note it put back with it.
  assert.deepEqual(out.files, []);
  assert.deepEqual((await ws.list(SYS_WAITING, '/files/')).map((f) => f.path), ['/files/flight.pdf', '/files/pasted-2026-10-28-0310.txt']);
  assert.deepEqual(await ws.list(started, '/files/'), []);
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

test('a second Undo tap respects what the first kept: a trip holding a booking she changed later stays', async () => {
  const { store, ws } = await kit();
  const started = await createTrip(ws, { title: 'Testville' }, { author: 'shiori', handover: 'h-1' });
  await ws.write(started, '/bookings/flight.json', flightBooking, HERS);
  await ws.patch(started, '/bookings/flight.json', { title: 'AN 124' }, { author: 'shiori' }); // a later turn of hers, no hand-over
  const first = await undoHandover(ws, started, 'h-1');
  assert.deepEqual([first.kept, first.tripEmpty], [['/bookings/flight.json'], false]);
  assert.equal(await undoable(store, started, 'h-1'), false);
  assert.equal((await undoHandover(ws, started, 'h-1')).tripEmpty, false);
});

test('Undo of files moved from the waiting space into a trip that stays sends them back to wait, with their names, unless changed there', async () => {
  const { ws } = await kit();
  syncNames(ws);
  const kyoto = await createTrip(ws, { title: 'Kyoto' });
  await ws.write(SYS_WAITING, '/files/hotel.pdf', utf8('%PDF hotel'), { author: 'user', type: 'application/pdf' });
  await ws.write(SYS_WAITING, '/files/car.txt', utf8('a car'), { author: 'user', type: 'text/plain' });
  await ws.patch(SYS_WAITING, '/names.json', { '/files/hotel.pdf': 'Hotel Aurora' }, { author: 'shiori', create: true });
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/hotel.pdf' }, kyoto, { handover: 'h-1' });
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/car.txt' }, kyoto, { handover: 'h-1' });
  await ws.write(kyoto, '/files/car.txt', utf8('a car, booked'), { author: 'user', type: 'text/plain' });
  const out = await undoHandover(ws, kyoto, 'h-1');
  assert.deepEqual([out.tripEmpty, out.files, out.kept], [false, [], ['/files/car.txt']]);
  assert.deepEqual((await ws.list(SYS_WAITING, '/files/')).map((f) => f.path), ['/files/hotel.pdf']);
  assert.deepEqual(await readNames(ws, SYS_WAITING), { '/files/hotel.pdf': 'Hotel Aurora' });
  assert.deepEqual((await ws.list(kyoto, '/files/')).map((f) => f.path), ['/files/car.txt']);
});

// Round 3: Undo's own writes, copies, and telling where the hand-over came from.

/** A trip she started from conversation `from` for hand-over h, its user line copied in, as start_trip makes one. @param {any} ws @param {any} store @param {string} from @param {string} h */
async function startedFrom(ws, store, from, h, title = 'Kyoto') {
  const id = await createTrip(ws, { title }, { author: 'shiori', handover: h });
  await record(store, id, { type: 'msg.user', actor: 'user', data: { handed: [], handover: h, from }, texts: [['text', '(files)']] });
  await record(store, from, { type: 'handover.moved', actor: 'shiori', data: { handover: h, to: id, started: true, count: 1 } });
  return id;
}

test("Undo from the trip a file came from: its move back is Undo's own, not the user's, so the trip she started goes", async () => {
  const { store, ws, trip } = await kit();
  await ws.write(trip, '/files/note.txt', utf8('Original note'), { author: 'user', type: 'text/plain' });
  const started = await startedFrom(ws, store, trip, 'h-2');
  await moveFile(ws, { scope: trip, path: '/files/note.txt' }, started, { handover: 'h-2' });
  await ws.write(started, '/files/note.txt', utf8('Edited by Shiori'), { author: 'shiori', type: 'text/plain', handover: 'h-2' });
  const out = await undoEverywhere(ws, trip, 'h-2', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual(out.removed, ['Kyoto']);
  assert.equal(await ws.readText(trip, '/files/note.txt'), 'Original note');
  assert.equal(await store.tx(['scopes'], 'readonly', (t) => t.getScope(started)), undefined);
});

test("a message copied into a trip is not the user's own work there; an older hand-over of the same turn has no Undo of its own", async () => {
  const { store, ws } = await kit();
  syncNames(ws);
  for (const [h, name] of [['h-1', 'a.pdf'], ['h-2', 'b.pdf']]) {
    await ws.write(SYS_WAITING, `/files/${name}`, utf8(name), { author: 'user', type: 'application/pdf' });
    await record(store, ME, { type: 'msg.user', actor: 'user', data: { handed: [{ path: `/waiting/files/${name}`, type: 'application/pdf', name, new: true }], handover: h }, texts: [['text', '(files)']] });
  }
  const started = await startedFrom(ws, store, ME, 'h-2', 'Anchorage');
  await record(store, started, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: ME }, texts: [['text', '(files)']] });
  for (const name of ['a.pdf', 'b.pdf']) await moveFile(ws, { scope: SYS_WAITING, path: `/files/${name}` }, started, { handover: 'h-2' });
  assert.equal(await undoable(store, ME, 'h-1'), false);
  assert.equal(await undoable(store, started, 'h-1'), false);
  const out = await undoEverywhere(ws, ME, 'h-2', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual(out.removed, ['Anchorage']);
  assert.deepEqual((await ws.list(SYS_WAITING, '/files/')).map((f) => f.path), ['/files/a.pdf', '/files/b.pdf']);
});

test('Undo in the trip she started tells the conversation the hand-over came from: the trip was removed and the files wait again', async () => {
  const { store, ws } = await kit();
  await ws.write(SYS_WAITING, '/files/a.pdf', utf8('a'), { author: 'user', type: 'application/pdf' });
  const started = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/a.pdf' }, started, { handover: 'h-1' });
  await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
  const [mark] = await eventsIn(store, ME, ['handover.undo']);
  assert.deepEqual([mark.data.handover, mark.data.removed], ['h-1', ['Anchorage']]);
  const words = (await Transcript.load(store, ME)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).join('\n');
  assert.match(words, /\[annai\] The user tapped Undo[^\n]*the trip you started for them, "Anchorage", was removed, and the files wait with you again/);
});

// Round 4.

test("Undo never removes a trip holding a file another hand-over moved in: from the waiting space or from another trip", async () => {
  for (const origin of ['waiting', 'trip']) {
    const { store, ws, trip } = await kit();
    const started = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
    await ws.write(started, '/bookings/flight.json', flightBooking, HERS);
    const from = origin === 'waiting' ? SYS_WAITING : trip;
    await ws.write(from, '/files/hotel.png', utf8('hotel'), { author: 'user', type: 'image/png' });
    await moveFile(ws, { scope: from, path: '/files/hotel.png' }, started, { handover: 'h-2' });
    const out = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(out.removed.length, 0, origin);
    assert.equal(await ws.readText(started, '/files/hotel.png'), 'hotel', origin);
    assert.equal(await ws.read(started, '/bookings/flight.json'), undefined, origin);
  }
});

test("the open conversation's mark is written only once its trips are removed: a failed removal leaves Undo to tap again", async () => {
  const { store, ws } = await kit();
  await ws.write(SYS_WAITING, '/files/a.pdf', utf8('a'), { author: 'user', type: 'application/pdf' });
  const started = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/a.pdf' }, started, { handover: 'h-1' });
  await assert.rejects(undoEverywhere(ws, ME, 'h-1', { remove: async () => { throw new Error('storage full'); } }));
  assert.deepEqual(await eventsIn(store, ME, ['handover.undo']), []);
  assert.equal(await undoable(store, started, 'h-1'), true);
  const out = await undoEverywhere(ws, ME, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual(out.removed, ['Anchorage']);
  const words = (await Transcript.load(store, ME)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).join('\n');
  assert.match(words, /\[annai\] The user tapped Undo for what you did with the files they handed you: the trip you started for them, "Anchorage", was removed/);
  assert.doesNotMatch(words, /0 files/);
});

test('Undo in the first of two trips she started from one conversation for one hand-over takes the second away too, and the files wait again', async () => {
  const { store, ws } = await kit();
  const a = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
  const b = await startedFrom(ws, store, ME, 'h-1', 'Kyoto');
  for (const [name, to] of [['a.pdf', a], ['b.pdf', b]]) {
    await ws.write(SYS_WAITING, `/files/${name}`, utf8(name), { author: 'user', type: 'application/pdf' });
    await moveFile(ws, { scope: SYS_WAITING, path: `/files/${name}` }, to, { handover: 'h-1' });
  }
  const out = await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual(out.removed.sort(), ['Anchorage', 'Kyoto']);
  assert.equal(await store.tx(['scopes'], 'readonly', (t) => t.getScope(b)), undefined);
  assert.deepEqual((await ws.list(SYS_WAITING, '/files/')).map((f) => f.path).sort(), ['/files/a.pdf', '/files/b.pdf']);
});

test('one Undo that removes two trips names both', async () => {
  const { store, ws } = await kit();
  const a = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
  const b = await startedFrom(ws, store, ME, 'h-1', 'Kyoto');
  for (const s of [a, b]) await ws.write(s, '/bookings/x.json', flightBooking, HERS);
  const out = await undoEverywhere(ws, ME, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual(out.removed.sort(), ['Anchorage', 'Kyoto']);
  const [mark] = await eventsIn(store, ME, ['handover.undo']);
  assert.deepEqual([...mark.data.removed].sort(), ['Anchorage', 'Kyoto']);
  const words = (await Transcript.load(store, ME)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).join('\n');
  assert.match(words, /the trips you started for them, "(Anchorage|Kyoto)" and "(Anchorage|Kyoto)", were removed/);
});

// Round 5.

test("a note she wrote in the trip in a later turn of her own (no hand-over) doesn't keep the trip she started", async () => {
  const { store, ws } = await kit();
  await ws.write(SYS_WAITING, '/files/a.pdf', utf8('a'), { author: 'user', type: 'application/pdf' });
  const started = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/a.pdf' }, started, { handover: 'h-1' });
  await ws.write(started, '/notes/packing.md', 'gloves', { author: 'shiori' });
  const out = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.waiting], [['Anchorage'], true]);
});

test('files that went back to the trip they came from are said to be back there, not waiting', async () => {
  const { store, ws, trip } = await kit();
  const started = await startedFrom(ws, store, trip, 'h-2', 'Kyoto');
  await moveFile(ws, { scope: trip, path: '/files/flight.pdf' }, started, { handover: 'h-2' });
  const out = await undoEverywhere(ws, started, 'h-2', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.waiting, out.back], [['Kyoto'], false, [{ id: trip, title: 'Anchorage' }]]);
  const [mark] = await eventsIn(store, trip, ['handover.undo']);
  assert.deepEqual([mark.data.removed, mark.data.back, 'waiting' in mark.data], [['Kyoto'], ['Anchorage'], false]);
  const words = (await Transcript.load(store, trip)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).join('\n');
  assert.match(words, /the trip you started for them, "Kyoto", was removed, and the files are back in "Anchorage"/);
  assert.doesNotMatch(words, /wait with you/);
});

test("a second press keeps a trip the first kept for a file that isn't this hand-over's, and the line goes once nothing is left to do", async () => {
  for (const other of ['the user', 'another hand-over']) {
    const { store, ws } = await kit();
    const started = await startedFrom(ws, store, ME, 'h-1', 'Anchorage');
    await ws.write(started, '/bookings/flight.json', flightBooking, HERS);
    await ws.write(started, '/files/hotel.png', utf8('hotel'), { author: other === 'the user' ? 'user' : 'shiori', type: 'image/png', ...(other === 'the user' ? {} : { handover: 'h-2' }) });
    const first = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.deepEqual(first.removed, [], other);
    assert.equal(await undoable(store, started, 'h-1'), false, other);
    const again = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.deepEqual(again.removed, [], other);
    assert.equal(await ws.readText(started, '/files/hotel.png'), 'hotel', other);
  }
});

// Round 6: where the files went is said whether or not a trip was removed.

test('Undo of files filed from the waiting space into a trip that stays says they wait again, in the mark and her line', async () => {
  const { store, ws } = await kit();
  const kyoto = await createTrip(ws, { title: 'Kyoto' });
  await ws.write(SYS_WAITING, '/files/hotel.pdf', utf8('hotel'), { author: 'user', type: 'application/pdf' });
  await moveFile(ws, { scope: SYS_WAITING, path: '/files/hotel.pdf' }, kyoto, { handover: 'h-1' });
  await record(store, ME, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: kyoto, started: false, count: 1 } });
  const out = await undoEverywhere(ws, ME, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.waiting, out.back], [[], true, []]);
  const [mark] = await eventsIn(store, ME, ['handover.undo']);
  assert.equal(mark.data.waiting, true);
  const words = (await Transcript.load(store, ME)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).join('\n');
  assert.match(words, /\[annai\] The user tapped Undo for what you did with the files they handed you: the files wait with you again\./);
});

test('a moved file back in the trip it came from is said to be back there, a trip removed or not; and still after a first tap that failed', async () => {
  const { store, ws, trip } = await kit();
  const kyoto = await createTrip(ws, { title: 'Kyoto' });
  await moveFile(ws, { scope: trip, path: '/files/flight.pdf' }, kyoto, { handover: 'h-1' });
  const out = await undoEverywhere(ws, trip, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.waiting, out.back], [[], false, [{ id: trip, title: 'Anchorage' }]]);
  const words = (await Transcript.load(store, trip)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).join('\n');
  assert.match(words, /the files are back in "Anchorage"/);
  // A first tap that moved the files home and then failed: the second still says where they are.
  const b = await kit();
  await b.ws.write(SYS_WAITING, '/files/a.pdf', utf8('a'), { author: 'user', type: 'application/pdf' });
  const started = await startedFrom(b.ws, b.store, ME, 'h-1', 'Anchorage');
  await moveFile(b.ws, { scope: SYS_WAITING, path: '/files/a.pdf' }, started, { handover: 'h-1' });
  await assert.rejects(undoEverywhere(b.ws, ME, 'h-1', { remove: async () => { throw new Error('storage full'); } }));
  const again = await undoEverywhere(b.ws, ME, 'h-1', { remove: async (s) => removeTrip(b.store, s) });
  assert.deepEqual([again.removed, again.waiting], [['Anchorage'], true]);
});

test('Undo reaches a trip two conversations away: files that went on from a sibling trip she started into a third trip come back, and its booking goes', async () => {
  const { store, ws, trip: third } = await kit();
  const a = await startedFrom(ws, store, ME, 'h-1', 'Anchorage stay');
  const b = await startedFrom(ws, store, ME, 'h-1', 'Kyoto');
  for (const [name, to] of [['a.pdf', a], ['b.pdf', b]]) {
    await ws.write(SYS_WAITING, `/files/${name}`, utf8(name), { author: 'user', type: 'application/pdf' });
    await moveFile(ws, { scope: SYS_WAITING, path: `/files/${name}` }, to, { handover: 'h-1' });
  }
  // In Kyoto's turn, for the same hand-over, she sent b.pdf on into the user's own trip and filed a booking there.
  await moveFile(ws, { scope: b, path: '/files/b.pdf' }, third, { handover: 'h-1' });
  await record(store, b, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: third, started: false, count: 1 } });
  await ws.write(third, '/bookings/b.json', { ...flightBooking, id: 'b', source: '/files/b.pdf' }, HERS);
  const out = await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual(out.removed.sort(), ['Anchorage stay', 'Kyoto']);
  assert.equal(await ws.read(third, '/bookings/b.json'), undefined, 'no booking left naming a file it took back');
  assert.equal(await ws.read(third, '/files/b.pdf'), undefined);
  assert.deepEqual((await ws.list(SYS_WAITING, '/files/')).map((f) => f.path).sort(), ['/files/a.pdf', '/files/b.pdf']);
});

// Stage 5: a hand-over cycle.

test('a file she moved from A to B and later back to A, for one hand-over: Undo from either end leaves it in A, and says it is back in A alone', async () => {
  for (const end of ['A', 'B']) {
    const { store, ws, trip: a } = await kit();
    const b = await createTrip(ws, { title: 'Kyoto' });
    await moveFile(ws, { scope: a, path: '/files/flight.pdf' }, b, { handover: 'h-1' });
    await record(store, a, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: b, started: false, count: 1 } });
    await record(store, b, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: a }, texts: [['text', '(files)']] });
    // In Kyoto's turn, for the same hand-over, she found it was Anchorage's after all.
    await moveFile(ws, { scope: b, path: '/files/flight.pdf' }, a, { handover: 'h-1' });
    await record(store, b, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: a, started: false, count: 1 } });
    const out = await undoEverywhere(ws, end === 'A' ? a : b, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight', end);
    assert.deepEqual((await ws.list(b, '/files/')).map((f) => f.path), [], end);
    assert.deepEqual([out.removed, out.waiting, out.back], [[], false, [{ id: a, title: 'Anchorage' }]], end);
  }
});

// Stage 5: Undo names the trips that stay that it changed.

test('Undo in a trip she started names each trip that stays and lost what she did there, but not where the files went back, nor a trip a file only passed through', async () => {
  const { store, ws, trip } = await kit();
  await ws.write(trip, '/files/hotel.png', utf8('hotel'), { author: 'user', type: 'image/png', handover: 'h-1' });
  const started = await startedFrom(ws, store, trip, 'h-1', 'Testville');
  await moveFile(ws, { scope: trip, path: '/files/flight.pdf' }, started, { handover: 'h-1' });
  // The hotel goes to one of the user's own trips, where she files its booking.
  const kyoto = await createTrip(ws, { title: 'Kyoto' });
  await moveFile(ws, { scope: trip, path: '/files/hotel.png' }, kyoto, { handover: 'h-1' });
  await record(store, trip, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: kyoto, started: false, count: 1 } });
  await record(store, kyoto, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: trip }, texts: [['text', '(files)']] });
  await ws.write(kyoto, '/bookings/hotel.json', hotelBooking, HERS);
  const out = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.back, out.changed], [['Testville'], [{ id: trip, title: 'Anchorage' }], [{ id: kyoto, title: 'Kyoto' }]]);
  assert.equal(await ws.read(kyoto, '/bookings/hotel.json'), undefined);
  // Only her booking there, its file left as the user changed it: still named.
  const b = await kit();
  const big = await createTrip(b.ws, { title: 'Big Sur' });
  const there = await moveFile(b.ws, { scope: b.trip, path: '/files/flight.pdf' }, big, { handover: 'h-1' });
  await record(b.store, b.trip, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: big, started: false, count: 1 } });
  await b.ws.write(big, '/bookings/flight.json', flightBooking, HERS);
  await b.ws.write(big, there, utf8('%PDF flight, marked up'), { author: 'user', type: 'application/pdf' });
  const kept = await undoEverywhere(b.ws, b.trip, 'h-1', { remove: async (s) => removeTrip(b.store, s) });
  assert.deepEqual([kept.kept, kept.back, kept.changed], [1, [], [{ id: big, title: 'Big Sur' }]]);
  // A trip the file went through and left again for the same hand-over (A to B and back to A) holds nothing of it: not named.
  const c = await kit();
  const via = await createTrip(c.ws, { title: 'Kyoto' });
  await moveFile(c.ws, { scope: c.trip, path: '/files/flight.pdf' }, via, { handover: 'h-1' });
  await record(c.store, c.trip, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: via, started: false, count: 1 } });
  await moveFile(c.ws, { scope: via, path: '/files/flight.pdf' }, c.trip, { handover: 'h-1' });
  await record(c.store, via, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: c.trip, started: false, count: 1 } });
  assert.deepEqual((await undoEverywhere(c.ws, c.trip, 'h-1', { remove: async (s) => removeTrip(c.store, s) })).changed, []);
});

test('a cycle where she changed the file in B for the hand-over (A to B, her change, back to A): Undo leaves it in A as it was handed, and nothing as the user changed it', async () => {
  for (const end of ['A', 'B']) {
    const { store, ws, trip: a } = await kit();
    const b = await createTrip(ws, { title: 'Kyoto' });
    const there = await moveFile(ws, { scope: a, path: '/files/flight.pdf' }, b, { handover: 'h-1' });
    await record(store, a, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: b, started: false, count: 1 } });
    await record(store, b, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: a }, texts: [['text', '(files)']] });
    await ws.write(b, there, utf8('%PDF flight, tidied'), { author: 'shiori', type: 'application/pdf', handover: 'h-1' });
    await moveFile(ws, { scope: b, path: there }, a, { handover: 'h-1' });
    await record(store, b, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: a, started: false, count: 1 } });
    const out = await undoEverywhere(ws, end === 'A' ? a : b, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight', end);
    assert.deepEqual((await ws.list(b, '/files/')).map((f) => f.path), [], end);
    assert.deepEqual([out.kept, out.back], [0, [{ id: a, title: 'Anchorage' }]], end);
  }
});

// Fix pass 1: a file's moves undone as one chain.

test('a file moved A to B, back to A and to B again for one hand-over: Undo from either end leaves it in A, back in A alone', async () => {
  for (const end of ['A', 'B']) {
    const { store, ws, trip: a } = await kit();
    const b = await createTrip(ws, { title: 'Kyoto' });
    await record(store, b, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: a }, texts: [['text', '(files)']] });
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, a], [a, b]]) {
      there = await moveFile(ws, { scope: from, path: there }, to, { handover: 'h-1' });
      await record(store, from, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to, started: false, count: 1 } });
    }
    const out = await undoEverywhere(ws, end === 'A' ? a : b, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight', end);
    assert.deepEqual((await ws.list(b, '/files/')).map((f) => f.path), [], end);
    assert.deepEqual([out.removed, out.kept, out.back], [[], 0, [{ id: a, title: 'Anchorage' }]], end);
  }
});

test('a chain A to B to C whose B the user removed since: Undo from A or from C leaves the file in A', async () => {
  for (const end of ['A', 'C']) {
    const { store, ws, trip: a } = await kit();
    const b = await createTrip(ws, { title: 'Kyoto' });
    const c = await createTrip(ws, { title: 'Big Sur' });
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, c]]) {
      await record(store, to, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from }, texts: [['text', '(files)']] });
      there = await moveFile(ws, { scope: from, path: there }, to, { handover: 'h-1' });
      await record(store, from, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to, started: false, count: 1 } });
    }
    await ws.write(c, '/bookings/flight.json', { ...flightBooking, source: there }, HERS);
    await removeTrip(store, b);
    const out = await undoEverywhere(ws, end === 'A' ? a : c, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight', end);
    assert.deepEqual((await ws.list(c, '/files/')).map((f) => f.path), [], end);
    assert.equal(await ws.read(c, '/bookings/flight.json'), undefined, `${end}: no booking left naming a file it took back`);
    assert.deepEqual([out.kept, out.back], [0, [{ id: a, title: 'Anchorage' }]], end);
  }
});

test('a file from the waiting space that she changed in the trip she started, then moved on: Undo from either conversation sends it back to wait as it came', async () => {
  // move_file writes no copy of the user's line where it went: that trip has no Undo line of its own.
  for (const end of ['me', 'started']) {
    const { store, ws } = await kit();
    await ws.write(SYS_WAITING, '/files/note.txt', utf8('temple at 9'), { author: 'user', type: 'text/plain' });
    const started = await startedFrom(ws, store, ME, 'h-1', 'Testville');
    const there = await moveFile(ws, { scope: SYS_WAITING, path: '/files/note.txt' }, started, { handover: 'h-1' });
    await ws.write(started, there, utf8('temple at 10'), { author: 'shiori', type: 'text/plain', handover: 'h-1' });
    // In that trip's turn, for the same hand-over, she sent it on to a trip of the user's.
    const kyoto = await createTrip(ws, { title: 'Kyoto' });
    await moveFile(ws, { scope: started, path: there }, kyoto, { handover: 'h-1' });
    await record(store, started, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: kyoto, started: false, count: 1 } });
    const out = await undoEverywhere(ws, end === 'me' ? ME : started, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(SYS_WAITING, '/files/note.txt'), 'temple at 9', end);
    assert.deepEqual([(await ws.list(kyoto, '/files/')).length, out.removed, out.waiting], [0, ['Testville'], true], end);
  }
});

test('a file in a trip she started whose trip of origin the user removed since: Undo removes the trip but sends the file to wait, and says so', async () => {
  const { store, ws, trip: a } = await kit();
  const started = await startedFrom(ws, store, a, 'h-1', 'Kyoto');
  await moveFile(ws, { scope: a, path: '/files/flight.pdf' }, started, { handover: 'h-1' });
  await removeTrip(store, a);
  const out = await undoEverywhere(ws, started, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual([out.removed, out.waiting, out.back], [['Kyoto'], true, []]);
  assert.equal(await ws.readText(SYS_WAITING, '/files/flight.pdf'), '%PDF flight');
});

test("Undo looks through other scopes' logs only when a trip on a file's way is gone, and for the move on from it, only at scopes changed since", async () => {
  for (const gone of [false, true]) {
    const { store, trip: a } = await kit();
    /** Which logs it reads: every scope listed, and whose writes. */
    const reads = { lists: 0, writes: new Set() };
    const counted = { ...store, tx: (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => store.tx(names, mode, (t) => fn({ ...t,
      listScopes: () => { reads.lists++; return t.listScopes(); },
      listEvents: (/** @type {string} */ s, /** @type {any} */ q) => { if (q?.types?.includes('file.write')) reads.writes.add(s); return t.listEvents(s, q); } })) };
    // Trips last changed before the hand-over, then the hand-over a second later.
    let clock = 1_000_000;
    const ws = new Workspace(/** @type {any} */ (counted), { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf), now: () => clock });
    const before = [];
    for (let i = 0; i < 20; i++) before.push(await createTrip(ws, { title: `Trip ${i}` }));
    clock += 1000;
    const b = await createTrip(ws, { title: 'Kyoto' });
    const c = await createTrip(ws, { title: 'Big Sur' });
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, c]]) {
      await record(store, to, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from }, texts: [['text', '(files)']] });
      there = await moveFile(ws, { scope: from, path: there }, to, { handover: 'h-1' });
      await record(store, from, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to, started: false, count: 1 } });
    }
    if (gone) await removeTrip(store, b);
    reads.lists = 0;
    reads.writes.clear();
    await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight', `gone ${gone}`);
    assert.equal(reads.lists > 0, gone, `gone ${gone}: looked through every scope`);
    assert.deepEqual(before.filter((s) => reads.writes.has(s)), [], `gone ${gone}: read the writes of trips unchanged since`);
  }
});

test("what she is told in each conversation: her writes it put back are counted there, and a moved file is said by where it is, never counted too", async () => {
  const { store, ws, trip: a } = await kit();
  const b = await createTrip(ws, { title: 'Kyoto' });
  await record(store, b, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from: a }, texts: [['text', '(files)']] });
  const there = await moveFile(ws, { scope: a, path: '/files/flight.pdf' }, b, { handover: 'h-1' });
  await record(store, a, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: b, started: false, count: 1 } });
  await ws.write(b, '/bookings/flight.json', { ...flightBooking, source: there }, HERS);
  await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
  const said = async (/** @type {string} */ s) => (await Transcript.load(store, s)).messages.flatMap((m) => m.parts.map((p) => /** @type {any} */ (p).text ?? '')).filter((x) => x.startsWith('[annai] The user tapped Undo')).join('\n');
  assert.match(await said(a), /: the files are back in "Anchorage"\./);
  assert.match(await said(b), /: 1 file put back as it was; the files are back in "Anchorage"\./, 'her booking there, and the file that left');
});

// Re-review of fix pass 1b.

/** A device whose clock moves a second at each write (moves are tool calls, seconds apart), or by step, its scope list counted. */
async function clocked(step = 1000) {
  const store = createMemoryStore();
  let lists = 0;
  // A walk that never ends would starve the test's own timeout (the memory store answers at once): this turns it into a failure. A chain
  // of five trips from either end looks through the scopes under 20 times; 200 is far past that.
  const counted = { ...store, tx: (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => store.tx(names, mode, (t) => fn({ ...t,
    listScopes: () => { if (++lists > 200) throw new Error('Undo walks without end'); return t.listScopes(); } })) };
  let clock = 1_000_000;
  const ws = new Workspace(/** @type {any} */ (counted), { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf), now: () => (clock += step) });
  await ensureBaseScopes(ws);
  const a = await createTrip(ws, { title: 'Anchorage' });
  await ws.write(a, '/files/flight.pdf', utf8('%PDF flight'), { author: 'user', type: 'application/pdf', handover: 'h-1' });
  /** Her move for the hand-over, as open_trip logs it. @param {string} from @param {string} path @param {string} to */
  const move = async (from, path, to) => {
    await record(store, to, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-1', from }, texts: [['text', '(files)']] });
    const there = await moveFile(ws, { scope: from, path }, to, { handover: 'h-1' });
    await record(store, from, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to, started: false, count: 1 } });
    return there;
  };
  return { store, ws, a, move };
}

test('a file that passed a trip removed since twice: Undo ends, and puts it back from where it really is', async () => {
  // A to B to A to B, then B removed: the file went with B, and Undo ends having nothing to bring back.
  {
    const { store, ws, a, move } = await clocked();
    const b = await createTrip(ws, { title: 'Kyoto' });
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, a], [a, b]]) there = await move(from, there, to);
    await removeTrip(store, b);
    const out = await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.deepEqual([out.back, out.kept, (await ws.list(a, '/files/')).length], [[], 0, 0]);
  }
  // The same with a clock that stood still (as one set back can): the passes through B can't be told apart, and Undo still ends.
  {
    const { store, ws, a, move } = await clocked(0);
    const b = await createTrip(ws, { title: 'Kyoto' });
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, a], [a, b]]) there = await move(from, there, to);
    await removeTrip(store, b);
    assert.deepEqual((await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) })).back, []);
  }
  // A to B to C, back to B and on to D, then B removed: the file comes back from D to A.
  {
    const { store, ws, a, move } = await clocked();
    const [b, c, d] = [await createTrip(ws, { title: 'Kyoto' }), await createTrip(ws, { title: 'Big Sur' }), await createTrip(ws, { title: 'Denali' })];
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, c], [c, b], [b, d]]) there = await move(from, there, to);
    await removeTrip(store, b);
    const out = await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight');
    assert.deepEqual([(await ws.list(c, '/files/')).length, (await ws.list(d, '/files/')).length, out.back], [0, 0, [{ id: a, title: 'Anchorage' }]]);
  }
});

test('a first tap cut off once a waiting file she changed went back to wait, before its first version was written: the second tap writes it', async () => {
  const { store, ws } = await kit();
  await ws.write(SYS_WAITING, '/files/note.txt', utf8('temple at 9'), { author: 'user', type: 'text/plain' });
  const started = await startedFrom(ws, store, ME, 'h-1', 'Testville');
  const there = await moveFile(ws, { scope: SYS_WAITING, path: '/files/note.txt' }, started, { handover: 'h-1' });
  await ws.write(started, there, utf8('temple at 10'), { author: 'shiori', type: 'text/plain', handover: 'h-1' });
  const kyoto = await createTrip(ws, { title: 'Kyoto' });
  await moveFile(ws, { scope: started, path: there }, kyoto, { handover: 'h-1' });
  await record(store, started, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-1', to: kyoto, started: false, count: 1 } });
  // The page goes as the first version is written back in Waiting (the move there done).
  const write = ws.write.bind(ws);
  ws.write = async (s, p, c, o) => {
    if (s === SYS_WAITING && o.undo && !o.moved) {
      ws.write = write;
      throw new Error('cut off');
    }
    return write(s, p, c, o);
  };
  await assert.rejects(undoEverywhere(ws, ME, 'h-1', { remove: async (s) => removeTrip(store, s) }), /cut off/);
  assert.equal(await ws.readText(SYS_WAITING, '/files/note.txt'), 'temple at 10');
  const out = await undoEverywhere(ws, ME, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual((await ws.list(SYS_WAITING, '/files/')).map((f) => f.path), ['/files/note.txt']);
  assert.equal(await ws.readText(SYS_WAITING, '/files/note.txt'), 'temple at 9');
  assert.deepEqual([out.removed, out.waiting], [['Testville'], true]);
});

test('a chain through a trip removed since that ends at a file the user changed: her booking there goes too, as when nothing was removed', async () => {
  for (const gone of [false, true]) {
    const { store, ws, a, move } = await clocked();
    const b = await createTrip(ws, { title: 'Kyoto' });
    const c = await createTrip(ws, { title: 'Big Sur' });
    let there = '/files/flight.pdf';
    for (const [from, to] of [[a, b], [b, c]]) there = await move(from, there, to);
    await ws.write(c, '/bookings/flight.json', { ...flightBooking, source: there }, HERS);
    await ws.write(c, there, utf8('%PDF flight, seat 12A'), { author: 'user', type: 'application/pdf' });
    if (gone) await removeTrip(store, b);
    const out = await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
    assert.equal(await ws.readText(c, there), '%PDF flight, seat 12A', `gone ${gone}`);
    assert.equal(await ws.read(c, '/bookings/flight.json'), undefined, `gone ${gone}: her booking goes`);
    assert.deepEqual([out.kept, out.changed], [1, [{ id: c, title: 'Big Sur' }]], `gone ${gone}`);
    assert.equal((await eventsIn(store, c, ['handover.undo'])).length, 1, `gone ${gone}: Big Sur is told`);
  }
});

test("a file another hand-over moved on and that one's Undo brought back: Undo of the first still takes it home", async () => {
  const { store, ws, a, move } = await clocked();
  const b = await createTrip(ws, { title: 'Kyoto' });
  const there = await move(a, '/files/flight.pdf', b);
  // In Kyoto, for a hand-over of its own, she sends it back to Anchorage; the user undoes that one, and it is in Kyoto again.
  await record(store, b, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-2' }, texts: [['text', 'and this']] });
  await moveFile(ws, { scope: b, path: there }, a, { handover: 'h-2' });
  await record(store, b, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-2', to: a, started: false, count: 1 } });
  await undoEverywhere(ws, b, 'h-2', { remove: async (s) => removeTrip(store, s) });
  assert.deepEqual((await ws.list(b, '/files/')).map((f) => f.path), [there]);
  const out = await undoEverywhere(ws, a, 'h-1', { remove: async (s) => removeTrip(store, s) });
  assert.equal(await ws.readText(a, '/files/flight.pdf'), '%PDF flight');
  assert.deepEqual([(await ws.list(b, '/files/')).length, out.back], [0, [{ id: a, title: 'Anchorage' }]]);
  // Not undone, that hand-over's move is the user's to keep: Undo of the first leaves it where the second put it.
  const c = await clocked();
  const k = await createTrip(c.ws, { title: 'Kyoto' });
  const p = await c.move(c.a, '/files/flight.pdf', k);
  await moveFile(c.ws, { scope: k, path: p }, c.a, { handover: 'h-2' });
  await moveFile(c.ws, { scope: c.a, path: '/files/flight.pdf' }, k, { handover: 'h-3' });
  await undoEverywhere(c.ws, c.a, 'h-1', { remove: async (s) => removeTrip(c.store, s) });
  assert.deepEqual([(await c.ws.list(c.a, '/files/')).length, (await c.ws.list(k, '/files/')).length], [0, 1]);
});
