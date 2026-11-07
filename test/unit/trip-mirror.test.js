import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, syncTripTitles, setTripStatus, tripMirror, backfillTrips, ME, SYS } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';

/** @param {{ schemas?: boolean }} [o] schemas: false lets a test write what a released copy or a plugin could have left */
async function kit({ schemas = true } = {}) {
  const store = createMemoryStore();
  const ws = new Workspace(store, schemas ? { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) } : {});
  await ensureBaseScopes(ws);
  syncTripTitles(ws);
  const scope = (/** @type {string} */ id) => store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
  /** A record as a released copy wrote it: none of the mirror's keys. @param {string} id */
  const released = (id) => store.tx(['scopes'], 'readwrite', async (t) => {
    const { start: _s, end: _e, talked: _t, ...rec } = /** @type {any} */ (await t.getScope(id));
    await t.putScope(rec);
  });
  return { store, ws, scope, released };
}
const settled = () => new Promise((r) => setTimeout(r, 5));

/** Counts writes of a scope record alone, as the mirror's are (a file's write touches its record's updated too). @param {any} store */
function countMirrorWrites(store) {
  let puts = 0;
  const real = store.tx.bind(store);
  store.tx = (/** @type {string[]} */ names, /** @type {any} */ mode, /** @type {(t: any) => any} */ fn) => real(names, mode, (/** @type {any} */ t) => fn(names.length > 1 ? t : new Proxy(t, {
    get: (o, k) => (k === 'putScope' ? (/** @type {any} */ r) => { puts++; return o.putScope(r); } : o[k]),
  })));
  return () => puts;
}

test('a new trip carries its dates and talked: null; with none, no date keys', async () => {
  const { ws, scope } = await kit();
  const id = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  const r = /** @type {any} */ (await scope(id));
  assert.deepEqual([r.start, r.end, r.talked], ['2026-11-20', '2026-11-22', null]);
  const none = /** @type {any} */ (await scope(await createTrip(ws, { title: 'A chat' })));
  assert.equal('start' in none, false);
  assert.equal('end' in none, false);
  assert.equal(none.talked, null);
});

test('a patch, a restore and a clear of trip.json all reach the record, with no title too', async () => {
  const { ws, scope } = await kit({ schemas: false });
  const id = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  const first = /** @type {any} */ (await ws.read(id, '/trip.json')).entry.hash;
  await ws.patch(id, '/trip.json', { start: '2026-12-01', end: '2026-12-02' }, { author: 'shiori' });
  await settled();
  let r = /** @type {any} */ (await scope(id));
  assert.deepEqual([r.start, r.end], ['2026-12-01', '2026-12-02']);
  await ws.restore(id, '/trip.json', first, { author: 'user' });
  await settled();
  r = await scope(id);
  assert.deepEqual([r.start, r.end], ['2026-11-20', '2026-11-22']);
  await ws.patch(id, '/trip.json', { start: null, end: null }, { author: 'user' });
  await settled();
  r = await scope(id);
  assert.equal('start' in r, false);
  assert.equal('end' in r, false);
  assert.equal(r.title, 'Testville');
  assert.equal(r.talked, null, 'the mirror keeps what the log wrote');
  // A trip.json with no title (a plugin's, or an old copy's) still moves the dates, and the record keeps its name.
  await ws.write(id, '/trip.json', { start: '2026-12-05' }, { author: 'user' });
  await settled();
  r = await scope(id);
  assert.deepEqual([r.start, r.title], ['2026-12-05', 'Testville']);
});

test('a date that is no date is not copied, and nothing readable leaves it undated', async () => {
  assert.deepEqual(tripMirror({ start: 'soon', end: 7 }), {});
  assert.deepEqual(tripMirror({ start: '2026-11-20T10:00:00Z', end: '2026-11-22' }), { end: '2026-11-22' });
  assert.deepEqual(tripMirror({ start: '2026-11-20', end: '2026-11-22', title: 'x' }), { start: '2026-11-20', end: '2026-11-22' });
  assert.deepEqual(tripMirror(null), {});
  assert.deepEqual(tripMirror('text'), {});
});

test('a trip.json whose read fails leaves the record as it was: a read that failed says nothing of its dates', async () => {
  const { ws, scope } = await kit();
  const id = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  // The patch's own read goes through, and the hook's read after it fails, as a file whose bytes are gone does.
  const read = ws.readJSON.bind(ws);
  let reads = 0;
  ws.readJSON = async (/** @type {string} */ s, /** @type {string} */ p) => {
    if (++reads > 1) throw new Error('the content of /trip.json is missing from storage');
    return read(s, p);
  };
  const warn = console.warn;
  console.warn = () => {}; // the listener's failure is warned of
  try {
    await ws.patch(id, '/trip.json', { start: '2026-11-21', title: 'Renamed' }, { author: 'user' });
  } finally {
    console.warn = warn;
  }
  const r = /** @type {any} */ (await scope(id));
  assert.deepEqual([r.start, r.end, r.title], ['2026-11-20', '2026-11-22', 'Testville']);
});

test('a trip.json that is not JSON is an answer: it clears the dates and keeps the rest', async () => {
  const { ws, scope } = await kit({ schemas: false });
  const id = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  await ws.write(id, '/trip.json', 'this is { not json', { author: 'user', type: 'text/plain' });
  await settled();
  const r = /** @type {any} */ (await scope(id));
  assert.equal('start' in r, false);
  assert.equal('end' in r, false);
  assert.equal(r.title, 'Testville');
});

test('the same dates and title write nothing', async () => {
  const { ws, store } = await kit();
  const id = await createTrip(ws, { title: 'Testville', start: '2026-11-20' });
  await settled();
  const puts = countMirrorWrites(store);
  await ws.patch(id, '/trip.json', { places: ['Testville'] }, { author: 'user' });
  await settled();
  assert.equal(puts(), 0);
});

// Typed lines come through loop.js's #log; a live voice's through koe.log, which is the same #log: every one ends in record().
test('the first user line and a heard line stamp talked; dismissed lines, wakes and her words do not', async () => {
  const { store, ws, scope } = await kit();
  const id = await createTrip(ws, { title: 'Testville' });
  await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: 100 });
  assert.equal(/** @type {any} */ (await scope(id)).talked, 100);
  await record(store, id, { type: 'heard', actor: 'user', data: { id: 'h1', dismissed: true }, now: 200 });
  await record(store, id, { type: 'model.turn', actor: 'shiori', data: {}, now: 300 });
  await record(store, id, { type: 'wake', actor: 'system', data: {}, now: 350 });
  assert.equal(/** @type {any} */ (await scope(id)).talked, 100);
  await record(store, id, { type: 'heard', actor: 'user', data: { id: 'h2', text: 'hi' }, now: 400 });
  assert.equal(/** @type {any} */ (await scope(id)).talked, 400);
  await record(store, id, { type: 'msg.user', actor: 'user', data: { from: 'trip-other', handover: 'h1' }, texts: [['text', 'the booking']], now: 450 });
  assert.equal(/** @type {any} */ (await scope(id)).talked, 400, "a hand-over's copy of a line is not talking");
});

test('a line in me or a sys scope writes no talked', async () => {
  const { store, scope } = await kit();
  const before = [await scope(ME), await scope(SYS)];
  await record(store, ME, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: 100 });
  await record(store, SYS, { type: 'heard', actor: 'user', data: { id: 'h' }, now: 100 });
  assert.deepEqual([await scope(ME), await scope(SYS)], before);
});

test('a record from a released copy is filled once, archived ones too, and a second run writes nothing', async () => {
  const { store, ws, scope, released } = await kit();
  const a = await createTrip(ws, { title: 'A', start: '2026-11-20', end: '2026-11-22' });
  const b = await createTrip(ws, { title: 'B', start: '2026-11-25' });
  const silent = await createTrip(ws, { title: 'Nobody spoke' });
  await record(store, a, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: 100 });
  await record(store, a, { type: 'heard', actor: 'user', data: { id: 'h', text: 'yes' }, now: 150 });
  await record(store, a, { type: 'msg.user', actor: 'user', data: { from: 'trip-other' }, texts: [['text', 'a hand-over copy']], now: 180 });
  // The last real line is behind more than a page of lines that are not hers to count.
  for (let i = 0; i < 250; i++) await record(store, a, { type: 'heard', actor: 'user', data: { id: `d${i}`, dismissed: true }, now: 200 + i });
  await setTripStatus(store, b, 'archived');
  for (const id of [a, b, silent]) await released(id);
  await backfillTrips(ws);
  const ra = /** @type {any} */ (await scope(a));
  assert.deepEqual([ra.start, ra.end, ra.talked, ra.title], ['2026-11-20', '2026-11-22', 150, 'A']);
  const rb = /** @type {any} */ (await scope(b));
  assert.deepEqual([rb.start, rb.talked, rb.status], ['2026-11-25', null, 'archived']);
  assert.equal(/** @type {any} */ (await scope(silent)).talked, null);
  assert.equal('start' in /** @type {any} */ (await scope(silent)), false);
  const puts = countMirrorWrites(store);
  await backfillTrips(ws);
  assert.equal(puts(), 0);
});

test('backfill: a bad date in trip.json is not copied, and a trip.json that is not JSON leaves the trip undated', async () => {
  const { ws, scope, released } = await kit({ schemas: false });
  const bad = await createTrip(ws, { title: 'Bad', start: '2026-11-20' });
  await ws.write(bad, '/trip.json', { title: 'Bad', start: 'next week', end: '2026-11-22' }, { author: 'user' });
  const broken = await createTrip(ws, { title: 'Broken', start: '2026-11-20' });
  await ws.write(broken, '/trip.json', 'this is { not json', { author: 'user', type: 'text/plain' });
  await settled();
  await released(bad);
  await released(broken);
  await backfillTrips(ws);
  const rb = /** @type {any} */ (await scope(bad));
  assert.deepEqual([rb.start, rb.end, rb.talked], [undefined, '2026-11-22', null]);
  const rk = /** @type {any} */ (await scope(broken));
  assert.deepEqual([rk.start, rk.talked], [undefined, null]);
});

test('backfill: a trip.json whose read fails stops it, with no talked written: the next start finishes it', async () => {
  const { ws, scope, released } = await kit({ schemas: false });
  const id = await createTrip(ws, { title: 'Road', start: '2026-11-20', end: '2026-11-22' });
  await released(id);
  const read = ws.readJSON.bind(ws);
  ws.readJSON = async () => { throw new Error('the content of /trip.json is missing from storage'); };
  await assert.rejects(backfillTrips(ws), /missing from storage/);
  ws.readJSON = read;
  let r = /** @type {any} */ (await scope(id));
  assert.equal('talked' in r, false, 'not marked done');
  await backfillTrips(ws);
  r = await scope(id);
  assert.deepEqual([r.start, r.end, r.talked], ['2026-11-20', '2026-11-22', null]);
});

test('a line said on a record the backfill has not reached does not mark it done: the next backfill still dates it', async () => {
  const { store, ws, scope, released } = await kit();
  const a = await createTrip(ws, { title: 'A', start: '2026-11-27' });
  const b = await createTrip(ws, { title: 'B', start: '2026-11-27', end: '2026-11-28' });
  await released(a);
  await released(b);
  // The first run throws on a log read before it reaches either trip.
  const real = store.tx.bind(store);
  let n = 0;
  store.tx = (/** @type {any} */ s, /** @type {any} */ m, /** @type {any} */ f) => (s.length === 1 && s[0] === 'events' && m === 'readonly' && n++ === 0 ? Promise.reject(new Error('idb hiccup')) : real(s, m, f));
  await assert.rejects(backfillTrips(ws), /idb hiccup/);
  store.tx = real;
  await record(store, a, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hi']], now: 100 });
  assert.equal('talked' in /** @type {any} */ (await scope(a)), false, 'the key still says: not filled');
  await backfillTrips(ws);
  const ra = /** @type {any} */ (await scope(a));
  assert.deepEqual([ra.start, ra.talked], ['2026-11-27', 100]);
  const rb = /** @type {any} */ (await scope(b));
  assert.deepEqual([rb.start, rb.end, rb.talked], ['2026-11-27', '2026-11-28', null]);
});

test('backfill: a filled trip whose read fails does not stop a later trip\'s first fill', async () => {
  const { ws, scope, released } = await kit({ schemas: false });
  const a = await createTrip(ws, { title: 'Filled', start: '2026-11-20', end: '2026-11-21' });
  const b = await createTrip(ws, { title: 'Old copy', start: '2026-11-27', end: '2026-11-28' });
  await released(b);
  const read = ws.readJSON.bind(ws);
  ws.readJSON = async (/** @type {string} */ s, /** @type {string} */ p) => {
    if (s === a) throw new Error('the content of /trip.json is missing from storage');
    return read(s, p);
  };
  await backfillTrips(ws);
  ws.readJSON = read;
  const ra = /** @type {any} */ (await scope(a));
  assert.deepEqual([ra.start, ra.end, ra.talked], ['2026-11-20', '2026-11-21', null], 'the unreadable trip keeps its record');
  const rb = /** @type {any} */ (await scope(b));
  assert.deepEqual([rb.start, rb.end, rb.talked], ['2026-11-27', '2026-11-28', null]);
});

test('a date edit whose read failed is healed at the next start: backfill mirrors every trip that has a talked key, and writes only if something differs', async () => {
  const { ws, scope, store } = await kit();
  const id = await createTrip(ws, { title: 'Past', start: '2026-11-20', end: '2026-11-21' });
  const read = ws.readJSON.bind(ws);
  let reads = 0;
  ws.readJSON = async (/** @type {string} */ s, /** @type {string} */ p) => {
    if (++reads === 2) throw new Error('the content of /trip.json is missing from storage'); // the listener's read, after the patch's own
    return read(s, p);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await ws.patch(id, '/trip.json', { start: '2026-11-27', end: '2026-11-28', title: 'Moved' }, { author: 'user' });
  } finally {
    console.warn = warn;
  }
  ws.readJSON = read;
  let r = /** @type {any} */ (await scope(id));
  assert.deepEqual([r.start, r.end, r.title], ['2026-11-20', '2026-11-21', 'Past'], 'the record is behind the file');
  assert.ok('talked' in r, 'a record that backfill has already filled');
  await backfillTrips(ws);
  r = await scope(id);
  assert.deepEqual([r.start, r.end, r.title], ['2026-11-27', '2026-11-28', 'Moved']);
  const puts = countMirrorWrites(store);
  await backfillTrips(ws);
  assert.equal(puts(), 0, 'nothing differs: nothing written');
});
