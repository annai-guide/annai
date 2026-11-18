import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingRef, planRows, planDays, legKm, PLAN_FILE, BOOKING_FILE, beforeShiori, shioriUndos, NIGHTS_MAX, fixedWords, timeUnsure } from '../../src/core/plan.js';
import { upcoming } from '../../src/core/now.js';
import { detailsHref } from '../../src/ui/format.js';
import { tripRows } from '../../src/ui/trip-rows.js';
import { setWords } from '../../src/core/l10n.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
import { noteQueries } from './store-spy.js';

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const items = [
  { path: '/plan/flight.json', item: { id: 'flight', title: 'UA 123 to Newark', kind: 'flight', fixed: true, start: { at: '2026-11-25T08:00:00-08:00', tz: LA }, end: { at: '2026-11-25T16:30:00-05:00', tz: NY }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 }, booking: '/trip/bookings/flight.json' } },
  { path: '/plan/hotel.json', item: { id: 'hotel', title: 'Check in', fixed: true, start: { at: '2026-11-25T20:00:00-05:00', tz: NY }, place: { name: 'Hoboken Inn', lat: 40.744, lng: -74.032 }, booking: '/bookings/hotel.json' } },
  { path: '/plan/late.json', item: { id: 'late', title: 'Late snack', fixed: false, start: { at: '2026-11-25T23:30:00-08:00', tz: LA } } },
  { path: '/plan/pie.json', item: { id: 'pie', title: 'Pick up pies', fixed: false, priority: 1, start: { at: '2026-11-26T10:00:00-05:00', tz: NY }, place: { name: 'Bakery', lat: 40.75, lng: -74.03 } } },
  { path: '/plan/dinner.json', item: { id: 'dinner', title: 'Dinner', fixed: true, start: { at: '2026-11-26T17:00:00-05:00', tz: NY }, place: { name: "Aunt Mei's", lat: 40.745, lng: -74.028 }, booking: '/trip/bookings/gone.json' } },
  { path: '/plan/museum.json', item: { id: 'museum', title: 'Museum day', kind: 'all-day', fixed: true, start: { at: '2026-11-27T00:00:00-05:00', tz: NY } } },
  { path: '/plan/odd.json', item: { id: 'odd', title: 'Odd zone', fixed: false, start: { at: '2026-11-28T12:00:00-05:00', tz: 'Eastern' } } },
  { path: '/plan/skate.json', item: { id: 'skate', title: 'Ice skating', fixed: false } },
  { path: '/plan/early.json', item: { id: 'early', title: 'Before the trip', fixed: false, start: { at: '2026-11-20T09:00:00-05:00', tz: NY } } },
  { path: '/plan/bad.json', item: /** @type {any} */ ('not an object') },
];
const bookings = [
  { path: '/bookings/flight.json', booking: { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pkpass', title: 'UA 123' } },
  { path: '/bookings/hotel.json', booking: { id: 'hotel', kind: 'lodging', status: 'confirmed', source: '/files/hotel.pdf' } },
];
const rows = () => planRows(items, bookings, { fallbackTz: NY });

test("fixedWords: what a plan item's fixed means, as a model is shown it; a flexible item, or one with no fixed field, gets no words", () => {
  assert.equal(fixedWords(true, { unsure: false }), "can't be moved");
  assert.equal(fixedWords(false, { unsure: false }), '');
  assert.equal(fixedWords(/** @type {any} */ ({}).fixed, { unsure: false }), '');
  // A time Shiori isn't sure of is never shown as settled: beside "can't be moved" (a plan item stored as fixed), or alone.
  assert.equal(fixedWords(true, { unsure: true }), "can't be moved; not sure the time was read right");
  assert.equal(fixedWords(false, { unsure: true }), 'not sure the time was read right');
});

test("timeUnsure: a time a row shows is the same moment as its booking's start or end, and the screens mark that one (an old booking, with no unsure, has every part it has marked)", () => {
  const inn = { kind: 'lodging', status: 'unverified', unsure: ['end'], start: { at: '2026-11-26T15:00:00-08:00', tz: LA }, end: { at: '2026-11-27T11:00:00-08:00', tz: LA } };
  const o = { fallbackTz: LA };
  assert.equal(timeUnsure([inn.end], inn, o), true, "an end row: its start is the booking's check-out");
  assert.equal(timeUnsure([{ at: '2026-11-27T14:00:00-05:00', tz: NY }], inn, o), true, 'the same moment written in another zone');
  assert.equal(timeUnsure([{ at: '2026-11-27T11:00:00', tz: LA }], inn, o), true, 'or on its zone\'s clock, with no offset');
  assert.equal(timeUnsure([{ at: '2026-11-27T11:00:00' }], inn, o), true, 'or with no zone: the fallback\'s');
  assert.equal(timeUnsure([inn.start], inn, o), false, 'the check-in is sure');
  assert.equal(timeUnsure([{ at: '2026-11-27T10:00:00-08:00', tz: LA }], inn, o), false, 'another time is not the booking\'s');
  assert.equal(timeUnsure([inn.end], { ...inn, unsure: ['seat', 'start'] }, o), false, 'its other fields are not its time');
  assert.equal(timeUnsure([inn.end], { ...inn, unsure: [] }, o), false, 'nothing marked');
  const { unsure: _, ...old } = inn;
  assert.equal(timeUnsure([inn.start], old, o), true, 'one from before, not confirmed: every part it has is marked, its start too');
  assert.equal(timeUnsure([inn.end], old, o), true, 'and its end');
  assert.equal(timeUnsure([inn.end], { ...old, end: undefined }, o), false, 'an end it has not is no part to mark');
  assert.equal(timeUnsure([inn.start], { ...old, status: 'confirmed' }, o), false, 'a confirmed one from before');
  assert.equal(timeUnsure([inn.end], null, o), false, 'no booking');
  assert.equal(timeUnsure([inn.end], { ...inn, end: undefined }, o), false, 'a booking without that time');
});

test('timeUnsure: only the times the row shows count: a sure start beside an unsure end is sure when the row shows the start alone (the review of booking-check, F1)', () => {
  const stay = { kind: 'lodging', status: 'unverified', start: { at: '2026-11-26T15:00:00-08:00', tz: LA }, end: { at: '2026-11-27T11:00:00-08:00', tz: LA } };
  const o = { fallbackTz: LA };
  const [checkIn, checkOut] = [stay.start, stay.end];
  // The end is the unsure time: a row that shows the start alone is sure; a row that shows both is not.
  assert.equal(timeUnsure([checkIn], { ...stay, unsure: ['end'] }, o), false, 'the start alone, the end marked');
  assert.equal(timeUnsure([checkIn, checkOut], { ...stay, unsure: ['end'] }, o), true, 'both shown, the end marked');
  // The start is the unsure time: either row is not sure.
  assert.equal(timeUnsure([checkIn], { ...stay, unsure: ['start'] }, o), true, 'the start alone, the start marked');
  assert.equal(timeUnsure([checkIn, checkOut], { ...stay, unsure: ['start'] }, o), true, 'both shown, the start marked');
  assert.equal(timeUnsure([checkOut], { ...stay, unsure: ['start'] }, o), false, 'the end alone, the start marked');
});

test("timeUnsure: an old booking with no end marks no row with no time (a missing time is no moment, though NaN is NaN)", () => {
  const o = { fallbackTz: LA };
  const stay = { kind: 'lodging', status: 'unverified', start: { at: '2026-11-26T15:00:00-08:00', tz: LA } }; // from before: no unsure key, no end
  assert.equal(timeUnsure([stay.start], stay, o), true, 'its start is a part it has, so it is marked');
  assert.equal(timeUnsure([], stay, o), false, 'a row with no time');
  assert.equal(timeUnsure([undefined], stay, o), false, 'a row whose time is missing');
  assert.equal(timeUnsure([{ at: 'sometime' }], stay, o), false, 'or one that is no date');
});

test('bookingRef: with or without /trip, only a booking record', () => {
  assert.equal(bookingRef('/trip/bookings/a.json'), '/bookings/a.json');
  assert.equal(bookingRef('/bookings/a.json'), '/bookings/a.json');
  assert.equal(bookingRef('/trip/notes/a.md'), null);
  assert.equal(bookingRef(7), null);
});

test('planRows: each item in its own zone, with its booking, and what is wrong with it', () => {
  const by = Object.fromEntries(rows().map((r) => [r.item.id, r]));
  assert.equal(rows().length, 9);
  assert.deepEqual([by.flight.day, by.flight.time, by.flight.end, by.flight.checkFields, by.flight.missing], ['2026-11-25', '08:00', '16:30', ['title'], false]);
  assert.deepEqual([by.hotel.bookingPath, by.hotel.checkFields, by.hotel.missing], ['/bookings/hotel.json', [], false]);
  assert.ok(rows().every((r) => !('check' in r)), 'a row has no mark of its booking as a whole: its parts are checkFields');
  assert.deepEqual([by.late.day, by.late.time], ['2026-11-25', '23:30']); // already the 26th in New York
  assert.equal(by.dinner.missing, true);
  assert.deepEqual([by.museum.day, by.museum.time], ['2026-11-27', '']);
  assert.deepEqual([by.odd.day, by.odd.time], ['2026-11-28', '12:00']);
  assert.match(by.odd.note, /"Eastern" isn't one annai knows; shown in America\/New_York/);
  assert.deepEqual([by.skate.at, by.skate.day, by.skate.time], [null, null, '']);
});

test('planRows: a booking in any state but confirmed has every part it has to check (no unsure): its rows carry them', () => {
  const item = (/** @type {string} */ id) => ({ path: `/plan/${id}.json`, item: { id, title: id, fixed: true, booking: `/bookings/${id}.json` } });
  const booking = (/** @type {string} */ id, /** @type {unknown} */ status) => ({ path: `/bookings/${id}.json`, booking: { id, kind: 'other', status, source: '/files/x.pdf', title: id } });
  const got = planRows([item('odd'), item('none'), item('ok'), { path: '/plan/free.json', item: { id: 'free', title: 'free', fixed: false } }],
    [booking('odd', 'pending'), booking('none', undefined), booking('ok', 'confirmed')], { fallbackTz: NY });
  assert.deepEqual(got.map((r) => [r.item.id, r.checkFields]), [['odd', ['title']], ['none', ['title']], ['ok', []], ['free', []]]);
});

test('planRows: an end in another zone names it; an end a day earlier says so; an end on a later day is a row of its own (the drive-test follow-ups, section 2)', () => {
  const at = (/** @type {string} */ id, /** @type {string} */ start, /** @type {string} */ tz, /** @type {string} */ end, /** @type {string} */ endTz, kind = 'event') =>
    ({ path: `/plan/${id}.json`, item: { id, title: id, kind, fixed: true, start: { at: start, tz }, end: { at: end, tz: endTz } } });
  const list = [
    at('redeye', '2026-11-25T22:00:00-08:00', LA, '2026-11-26T06:30:00-05:00', NY, 'flight'), // LA to New York overnight
    at('day', '2026-11-25T08:00:00-08:00', LA, '2026-11-25T16:30:00-05:00', NY, 'flight'), // LA to New York the same day
    at('party', '2026-11-26T21:00:00-05:00', NY, '2026-11-27T01:00:00-05:00', NY), // past midnight, one zone
    at('dinner', '2026-11-26T17:00:00-05:00', NY, '2026-11-26T20:00:00-05:00', NY), // one day, one zone
    at('toronto', '2026-11-27T09:00:00-05:00', NY, '2026-11-27T10:30:00-05:00', 'America/Toronto'), // another zone, the same clock
    at('back', '2026-11-29T00:30:00+09:00', 'Asia/Tokyo', '2026-11-28T13:00:00-10:00', 'Pacific/Honolulu', 'flight'), // across the date line: a day earlier
    at('museum', '2026-11-27T00:00:00-05:00', NY, '2026-11-28T00:00:00-05:00', NY, 'all-day'),
  ];
  const by = Object.fromEntries(planRows(list, [], { fallbackTz: NY }).filter((r) => r.from === 'item').map((r) => [r.item.id, [r.time, r.end, r.endDays, r.endZone]]));
  assert.deepEqual(by.redeye, ['22:00', '', 0, '']);
  assert.deepEqual(by.day, ['08:00', '16:30', 0, 'ET']);
  assert.deepEqual(by.party, ['21:00', '', 0, '']);
  assert.deepEqual(by.dinner, ['17:00', '20:00', 0, '']);
  assert.deepEqual(by.toronto, ['09:00', '10:30', 0, '']);
  assert.deepEqual(by.back, ['00:30', '13:00', -1, 'HST']);
  assert.deepEqual(by.museum, ['', '', 0, '']);
  // The zone is named in the screens' language.
  setWords('de', null);
  try {
    assert.equal(planRows(list, [], { fallbackTz: NY }).find((r) => r.item.id === 'day')?.endZone, 'New York (Ortszeit)');
  } finally {
    setWords('en', null);
  }
  // No end, or one that isn't a time: nothing to say about it.
  const plain = planRows([{ path: '/plan/x.json', item: { id: 'x', title: 'x', fixed: false, start: { at: '2026-11-26T10:00:00-05:00', tz: NY }, end: { at: 'soon', tz: LA } } }], [], { fallbackTz: NY })[0];
  assert.deepEqual([plain.end, plain.endDays, plain.endZone], ['', 0, '']);
});

test('planDays: every trip day, other days with something on them, rows by time; untimed apart', () => {
  const { days, untimed } = planDays(rows(), { start: '2026-11-25', end: '2026-11-29' });
  assert.deepEqual(days.map((d) => d.key), ['2026-11-20', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
  assert.deepEqual(days[1].rows.map((r) => r.item.id), ['flight', 'hotel', 'late']);
  assert.deepEqual(days[2].rows.map((r) => r.item.id), ['pie', 'dinner']);
  assert.deepEqual(days[5].rows, []);
  assert.deepEqual(untimed.map((r) => r.item.id), ['skate']);
  assert.deepEqual(planDays([], {}).days, []);
  assert.deepEqual(planDays([], { start: '2026-11-25' }).days.map((d) => d.key), ['2026-11-25']);
  assert.equal(planDays([], { start: '2026-01-01', end: '2026-12-31' }).days.length, 60);
});

test('legKm: straight-line distance between stops with places, never across a flight', () => {
  const by = Object.fromEntries(rows().map((r) => [r.item.id, r]));
  const near = legKm(by.pie, by.dinner);
  assert.ok(near !== null && near > 0.5 && near < 0.7, String(near));
  assert.equal(legKm(by.flight, by.hotel), null); // over 1,000 km: a flight, not a leg
  assert.equal(legKm(by.hotel, by.late), null); // no place
});

test('PLAN_FILE and BOOKING_FILE: records sit directly in their folder, as the format check and the booking rule see them', () => {
  assert.equal(PLAN_FILE.test('/plan/dinner.json'), true);
  assert.equal(PLAN_FILE.test('/plan/day1/dinner.json'), false);
  assert.equal(BOOKING_FILE.test('/bookings/hotel.json'), true);
  assert.equal(BOOKING_FILE.test('/bookings/2026/hotel.json'), false);
  assert.equal(BOOKING_FILE.test('/bookings/hotel.pdf'), false);
});

test("a plan item Shiori changed last can go back to the version before all her changes in a row (spec §11.5: every replan can be undone)", () => {
  const w = (/** @type {string} */ actor, /** @type {string | null} */ old, /** @type {string | null} */ next, type = 'file.write') => ({ seq: 1, ts: 1, actor, type, old, new: next });
  assert.deepEqual(beforeShiori([w('user', null, 'a'), w('shiori', 'a', 'b')]), { restore: 'a' });
  assert.deepEqual(beforeShiori([w('user', null, 'a'), w('shiori', 'a', 'b'), w('shiori', 'b', 'c')]), { restore: 'a' }); // moved, then a note: both go (B3)
  assert.equal(beforeShiori([w('user', null, 'a'), w('shiori', 'a', 'b'), w('user', 'b', 'c')]), null); // the user changed it since
  assert.deepEqual(beforeShiori([w('shiori', null, 'a'), w('shiori', 'a', 'b')]), { remove: true }); // she added it: Undo removes it
  assert.deepEqual(beforeShiori([w('user', null, 'a'), w('shiori', 'a', null, 'file.delete'), w('shiori', null, 'b')]), { remove: true });
  assert.equal(beforeShiori([w('user', null, 'a'), w('shiori', 'a', null, 'file.delete')]), null);
  assert.equal(beforeShiori([]), null);
});

test("the Plan's Undos come from one read of the log, however many items Shiori changed (B7)", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  /** @type {{ path: string, author: string }[]} */
  const files = [];
  for (let i = 0; i < 20; i++) {
    const path = `/plan/stop-${i}.json`;
    await ws.write(trip, path, { id: `stop-${i}`, title: `Stop ${i}` }, { author: 'user' });
    await ws.write(trip, path, { id: `stop-${i}`, title: `Stop ${i}`, notes: 'moved' }, { author: 'shiori' });
    files.push({ path, author: 'shiori' });
  }
  await ws.write(trip, '/plan/new.json', { id: 'new', title: 'Added' }, { author: 'shiori' });
  files.push({ path: '/plan/new.json', author: 'shiori' }, { path: '/plan/mine.json', author: 'user' });
  for (let i = 0; i < 500; i++) await logEvent(store, trip, { type: 'location', actor: 'system', data: { lat: 36, lng: -121 } });
  const queries = noteQueries(store);
  const undo = await shioriUndos(ws, trip, files);
  assert.equal(queries.length, 1);
  assert.equal(undo.size, 21);
  assert.ok(undo.get('/plan/stop-3.json') && 'restore' in /** @type {any} */ (undo.get('/plan/stop-3.json')));
  assert.deepEqual(undo.get('/plan/new.json'), { remove: true });
  assert.equal(undo.has('/plan/mine.json'), false);
});

const AK = 'America/Anchorage';
const flight = { path: '/bookings/flight.json', booking: { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', unsure: [], start: { at: '2026-11-20T11:20:00-08:00', tz: LA }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK } } };
const stay = { path: '/bookings/stay.json', booking: { id: 'stay', kind: 'lodging', status: 'unverified', source: '/files/hotel.png', title: 'Hotel Aurora Test', unsure: [], place: { name: 'Hotel Aurora Test', lat: 61.2, lng: -149.9 }, start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-27T11:00:00-09:00', tz: AK } } };
const pass = { path: '/bookings/pass.json', booking: { id: 'pass', kind: 'event', status: 'unverified', source: '/files/pass.pkpass', title: 'Museum pass', unsure: [] } };
/** A stay of so many nights from Nov 20. @param {string} id @param {string} end */
const stayTo = (id, end, tz = AK) => ({ path: `/bookings/${id}.json`, booking: { ...stay.booking, id, start: { at: '2026-11-20T15:00:00-09:00', tz }, end: { at: end, tz } } });

test('a flight no plan item stands for is on the day it leaves, at its own clock, its arrival zone named', () => {
  const [r, arrive] = planRows([], [flight], { fallbackTz: 'UTC' });
  // Its departure, then its Arrive, as a red-eye's (carrier-rows-next: main drew one row, 11:20–14:05 AKT, at the place it left).
  assert.deepEqual([r.from, r.day, r.time, r.end, r.endZone], ['booking', '2026-11-20', '11:20', '', '']);
  assert.deepEqual([arrive.from, arrive.day, arrive.time, arrive.endZone, arrive.item.place, arrive.path], ['end', '2026-11-20', '14:05', 'AKT', undefined, '/bookings/flight.json']);
  assert.deepEqual([r.path, r.bookingPath, r.item.title, r.item.fixed, r.line, r.checkFields, r.missing, r.note], ['/bookings/flight.json', '/bookings/flight.json', 'ANNAI AIR AN 123', null, null, [], false, '']);
  assert.equal(r.booking, flight.booking);
});

test('a stay: check-in, a night line on each day between (night 2 of 7 … 7 of 7), then check-out', () => {
  const rows = planRows([], [stay], { fallbackTz: 'UTC' });
  assert.deepEqual(rows.map((r) => [r.from, r.day, r.line && `${r.line.n}/${r.line.of}`]), [
    ['booking', '2026-11-20', null], ['end', '2026-11-27', null],
    ['line', '2026-11-21', '2/7'], ['line', '2026-11-22', '3/7'], ['line', '2026-11-23', '4/7'],
    ['line', '2026-11-24', '5/7'], ['line', '2026-11-25', '6/7'], ['line', '2026-11-26', '7/7']]);
  // Check-in is at its own time, with no end: the stay's end is its check-out row.
  assert.deepEqual([rows[0].time, rows[0].end, rows[1].time, rows[1].end], ['15:00', '', '11:00', '']);
  // A night is a quiet line: no time, the check-in's place.
  assert.deepEqual([rows[2].at, rows[2].time, rows[2].item.place.name, rows[2].path], [null, '', 'Hotel Aurora Test', '/bookings/stay.json']);
});

test("a booking's own rows say nobody said (null), and its end is the fixed of a plan item linked to it that ends there; none, null (the user's answer, 2026-11-15: only what was said fixed)", () => {
  const fixedOf = (/** @type {import('../../src/core/plan.js').PlanRow[]} */ rows) => rows.map((r) => [r.from, r.item.fixed]);
  const nights = stayTo('stay', '2026-11-22T11:00:00-09:00'); // check-in Nov 20 15:00, a night on the 21st, check-out Nov 22 11:00
  const inn = (/** @type {Record<string, any>} */ more) => ({ path: '/plan/inn.json', item: { id: 'inn', title: 'Stay at Hotel Aurora Test', start: nights.booking.start, booking: '/bookings/stay.json', ...more } });
  const out = { at: '2026-11-22T11:00:00-09:00', tz: AK };
  // A stay nothing stands for: its check-in, check-out and night say nothing, not even "flexible".
  assert.deepEqual(fixedOf(planRows([], [nights], { fallbackTz: 'UTC' })), [['booking', null], ['end', null], ['line', null]]);
  // A stay item with both times, fixed, linked to the booking (what FILE_BOOKING has her write): its start row is the item's, and the
  // booking's check-out is as fixed as it, which is the item's end taken off the start row.
  const rows = planRows([inn({ fixed: true, end: out })], [nights], { fallbackTz: 'UTC' });
  assert.deepEqual(fixedOf(rows), [['item', true], ['end', true], ['line', true]]);
  assert.equal('end' in rows[0].item, false);
  // A fixed check-in item with no end says nothing of the check-out; nor does one that ends at some other time than the booking.
  assert.deepEqual(fixedOf(planRows([inn({ fixed: true })], [nights], { fallbackTz: 'UTC' })), [['item', true], ['end', null], ['line', null]]);
  assert.deepEqual(fixedOf(planRows([inn({ fixed: true, end: { at: '2026-11-22T14:00:00-09:00', tz: AK } })], [nights], { fallbackTz: 'UTC' })), [['item', true], ['end', null], ['line', null]]);
  // A red-eye: its fixed item with both times says its arrival (in the arrival's zone) is fixed too; with no item, the arrival says nothing.
  const redEye = { path: '/bookings/red.json', booking: { id: 'red', kind: 'flight', status: 'unverified', source: '/files/r.pdf', title: 'ANNAI AIR AN 9', unsure: [], start: { at: '2026-11-20T22:00:00-08:00', tz: LA }, end: { at: '2026-11-21T06:30:00-05:00', tz: 'America/New_York' } } };
  const fly = { path: '/plan/red.json', item: { id: 'red', title: 'Fly home', fixed: true, start: redEye.booking.start, end: redEye.booking.end, booking: '/bookings/red.json' } };
  assert.deepEqual(fixedOf(planRows([fly], [redEye], { fallbackTz: 'UTC' })), [['item', true], ['end', true]]);
  assert.deepEqual(fixedOf(planRows([], [redEye], { fallbackTz: 'UTC' })), [['booking', null], ['end', null]]);
});

test("the build's change, kept by fix 1 (trek(true) held on main too): a stored flexible stay's check-out is flexible, and a plan item over several days gives its end and nights its own fixed, either way", () => {
  const fixedOf = (/** @type {import('../../src/core/plan.js').PlanRow[]} */ rows) => rows.map((r) => [r.from, r.item.fixed]);
  const nights = stayTo('stay', '2026-11-22T11:00:00-09:00');
  const inn = { path: '/plan/inn.json', item: { id: 'inn', title: 'Stay at Hotel Aurora Test', fixed: false, start: nights.booking.start, end: nights.booking.end, booking: '/bookings/stay.json' } };
  assert.deepEqual(fixedOf(planRows([inn], [nights], { fallbackTz: 'UTC' })), [['item', false], ['end', false], ['line', false]]);
  const trek = (/** @type {boolean} */ fixed) => ({ path: '/plan/trek.json', item: { id: 'trek', title: 'Hut trek', fixed, start: { at: '2026-11-21T08:00:00-09:00', tz: AK }, end: { at: '2026-11-23T16:00:00-09:00', tz: AK } } });
  assert.deepEqual(fixedOf(planRows([trek(false)], [], { fallbackTz: 'UTC' })), [['item', false], ['end', false], ['line', false]]);
  assert.deepEqual(fixedOf(planRows([trek(true)], [], { fallbackTz: 'UTC' })), [['item', true], ['end', true], ['line', true]]);
});

test("a plan item linking a booking stands for it; a stay's check-out is still shown unless an item is on that day", () => {
  const fly = { path: '/plan/fly.json', item: { id: 'fly', title: 'Fly to Anchorage', fixed: true, start: flight.booking.start, end: flight.booking.end, booking: '/trip/bookings/flight.json' } };
  const checkIn = { path: '/plan/in.json', item: { id: 'in', title: 'Check in', fixed: true, start: stay.booking.start, booking: '/bookings/stay.json' } };
  const rows = planRows([fly, checkIn], [flight, stay], { fallbackTz: 'UTC' });
  assert.deepEqual(rows.map((r) => [r.from, r.path, r.day]), [
    ['item', '/plan/fly.json', '2026-11-20'], ['item', '/plan/in.json', '2026-11-20'], ['end', '/bookings/flight.json', '2026-11-20'], ['end', '/bookings/stay.json', '2026-11-27'],
    ...['21', '22', '23', '24', '25', '26'].map((d) => ['line', '/bookings/stay.json', `2026-11-${d}`])]);
  assert.equal(rows[1].bookingPath, '/bookings/stay.json');
  const checkOut = { path: '/plan/out.json', item: { id: 'out', title: 'Check out', fixed: true, start: stay.booking.end, booking: '/bookings/stay.json' } };
  assert.equal(planRows([checkIn, checkOut], [stay], { fallbackTz: 'UTC' }).some((r) => r.from === 'end'), false);
});

test('a booking with no time is Not on a day; plan items with no time stay under No time yet', () => {
  const untimedItem = { path: '/plan/u.json', item: { id: 'u', title: 'Ice skating', fixed: false } };
  const { notOnDay, untimed } = planDays(planRows([untimedItem], [pass], { fallbackTz: 'UTC' }), {});
  assert.deepEqual(notOnDay.map((r) => r.path), ['/bookings/pass.json']);
  assert.deepEqual(untimed.map((r) => r.path), ['/plan/u.json']);
  assert.deepEqual(planDays(planRows([untimedItem], [], { fallbackTz: 'UTC' }), {}).notOnDay, []);
});

test('nights come first in their day, before its other rows; a 0- or 1-night stay has none; a 200-night one stops at 60', () => {
  const dinnerOn21st = { path: '/plan/dinner.json', item: { id: 'dinner', title: 'Dinner', fixed: true, start: { at: '2026-11-21T00:30:00-09:00', tz: AK } } };
  const { days } = planDays(planRows([dinnerOn21st], [stay], { fallbackTz: 'UTC' }), {});
  assert.deepEqual(days.find((d) => d.key === '2026-11-21')?.rows.map((r) => r.from), ['line', 'item']);
  const nights = (/** @type {any} */ b) => planRows([], [b], { fallbackTz: 'UTC' }).filter((r) => r.from === 'line');
  assert.equal(nights(stayTo('same', '2026-11-20T22:00:00-09:00')).length, 0);
  assert.equal(nights(stayTo('one', '2026-11-21T11:00:00-09:00')).length, 0);
  const long = nights(stayTo('long', '2027-06-08T11:00:00-08:00'));
  assert.equal(NIGHTS_MAX, 60);
  assert.equal(long.length, 60);
  assert.deepEqual([long[0].line, long[59].line], [{ n: 2, of: 200 }, { n: 61, of: 200 }]);
});

test('a booking with a time zone annai does not know, or an end before its start, still shows, in the fallback zone with the note; no nights', () => {
  const odd = stayTo('odd', '2026-11-27T11:00:00-09:00', 'Alaska');
  const rows = planRows([], [odd], { fallbackTz: AK });
  assert.deepEqual(rows.map((r) => [r.from, r.day, r.time]), [['booking', '2026-11-20', '15:00'], ['end', '2026-11-27', '11:00']]);
  assert.match(rows[0].note, /"Alaska" isn't one annai knows; shown in America\/Anchorage/);
  const none = planRows([], [{ path: '/bookings/n.json', booking: { ...stay.booking, start: { at: '2026-11-20T15:00:00-09:00' }, end: { at: '2026-11-27T11:00:00-09:00' } } }], { fallbackTz: AK });
  assert.deepEqual(none.map((r) => r.from), ['booking', 'end']);
  assert.match(none[0].note, /"" isn't one annai knows/);
  // An end before its start: shown as written, no nights.
  const back = planRows([], [stayTo('back', '2026-11-18T11:00:00-09:00')], { fallbackTz: 'UTC' });
  assert.deepEqual(back.map((r) => [r.from, r.day]), [['booking', '2026-11-20'], ['end', '2026-11-18']]);
  // A time with no offset is read on its zone's clock (here the fallback's), not the phone's.
  const bare = planRows([], [{ path: '/bookings/b.json', booking: { ...flight.booking, start: { at: '2026-11-20T11:20:00', tz: 'Nowhere' }, end: undefined } }], { fallbackTz: AK });
  assert.deepEqual([bare[0].day, bare[0].time], ['2026-11-20', '11:20']);
  assert.match(bare[0].note, /"Nowhere" isn't one annai knows/);
  // Odd shapes: never thrown, never dropped.
  for (const b of [{ kind: 'lodging', start: 'soon', end: 7 }, { kind: 'lodging', start: { at: 3 }, end: { at: null } }, { kind: 7 }, {}]) {
    assert.equal(planRows([], [{ path: '/bookings/x.json', booking: /** @type {any} */ (b) }], { fallbackTz: 'UTC' }).filter((r) => r.from === 'booking').length, 1);
  }
});

test('checkFields comes from checkOf: an old unverified booking lists every part it has, a new one its unsure fields, an old confirmed one none; no row has a check of the booking as a whole (booking-say round 4)', () => {
  const old = { path: '/bookings/old.json', booking: { id: 'old', kind: 'flight', status: 'unverified', source: '/files/a.pdf', start: flight.booking.start, end: flight.booking.end, title: 'ANNAI AIR AN 7', fields: { seat: '14C' } } };
  const seat = { path: '/bookings/seat.json', booking: { ...flight.booking, id: 'seat', unsure: ['seat', 'wings'], fields: { seat: '14C' } } };
  const ok = { path: '/bookings/ok.json', booking: { id: 'ok', kind: 'flight', status: 'confirmed', source: '/files/a.pdf', start: flight.booking.start } };
  const bare = { path: '/bookings/bare.json', booking: { id: 'bare', kind: 'flight', status: 'unverified', source: '/files/a.pdf' } };
  const got = planRows([], [old, seat, ok, bare], { fallbackTz: 'UTC' });
  assert.deepEqual(Object.fromEntries(got.map((r) => [r.path, r.checkFields])), {
    '/bookings/old.json': ['title', 'start', 'end', 'seat'], '/bookings/seat.json': ['seat'], '/bookings/ok.json': [], '/bookings/bare.json': [],
  });
  assert.ok(got.every((r) => !('check' in r)), 'no row carries a check of the whole booking');
  // A plan item that stands for a booking carries its marks.
  const item = { path: '/plan/fly.json', item: { id: 'fly', title: 'Fly', fixed: true, booking: '/bookings/seat.json' } };
  const [r] = planRows([item], [seat], { fallbackTz: 'UTC' });
  assert.deepEqual([r.from, r.checkFields], ['item', ['seat']]);
  const [o] = planRows([{ path: '/plan/fly.json', item: { ...item.item, booking: '/bookings/old.json' } }], [old], { fallbackTz: 'UTC' });
  assert.deepEqual([o.from, o.checkFields], ['item', ['title', 'start', 'end', 'seat']], 'an old booking too');
  // A set's quiet lines carry none of their booking's marks.
  const nights = planRows([], [{ path: '/bookings/inn.json', booking: { id: 'inn', kind: 'lodging', status: 'unverified', source: '/files/i.pdf', title: 'Old Inn', start: stay.booking.start, end: stay.booking.end } }], { fallbackTz: 'UTC' });
  assert.deepEqual([...new Set(nights.filter((x) => x.from === 'line').map((x) => JSON.stringify(x.checkFields)))], ['[]']);
  assert.deepEqual(nights.filter((x) => x.from !== 'line').map((x) => x.checkFields), [['title', 'start', 'end'], ['title', 'start', 'end']], 'its check-in and check-out rows carry them');
});

test("Now's next items include a flight booking no plan item stands for, and never a night line", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Anchorage' });
  for (const b of [flight, stay]) await ws.write(trip, b.path, b.booking, { author: 'user' });
  const { rows } = await tripRows({ store, ws }, trip);
  const next = upcoming(rows, Date.parse('2026-11-20T08:00:00-08:00'), 10);
  assert.deepEqual(next.map((r) => [r.from, r.path]), [['booking', '/bookings/flight.json'], ['end', '/bookings/flight.json'], ['booking', '/bookings/stay.json'], ['end', '/bookings/stay.json']]);
  assert.equal(rows.filter((r) => r.from === 'line').length, 6);
});

test("a plan item linking a booking stands for it only on its own day: a stay keeps its check-in row when the item is its check-out or a breakfast (the review of seeing-bookings, R1)", () => {
  const at = (/** @type {string} */ id, /** @type {string} */ when, /** @type {string} */ booking) => ({ path: `/plan/${id}.json`, item: { id, title: id, fixed: true, start: { at: when, tz: AK }, booking } });
  const days = (/** @type {any[]} */ items, /** @type {any} */ b) => planRows(items, [b], { fallbackTz: 'UTC' }).filter((r) => r.from !== 'line').map((r) => `${r.from}@${r.day}`);
  // R1: only a check-out item: the check-in is still a row, the check-out the item.
  assert.deepEqual(days([at('out', '2026-11-27T11:00:00-09:00', '/bookings/stay.json')], stay), ['item@2026-11-27', 'booking@2026-11-20']);
  // R1b: a breakfast mid-stay: check-in and check-out both stay.
  assert.deepEqual(days([at('breakfast', '2026-11-22T08:00:00-09:00', '/bookings/stay.json')], stay), ['item@2026-11-22', 'booking@2026-11-20', 'end@2026-11-27']);
  // A flight whose linked item is on another day (a reminder to check in online the day before): the flight is still on its day.
  assert.deepEqual(days([at('online', '2026-11-19T11:20:00-08:00', '/bookings/flight.json')], flight), ['item@2026-11-19', 'booking@2026-11-20', 'end@2026-11-20']);
  // A booking with no time that a plan item stands for isn't also "Not on a day".
  const untimed = { path: '/bookings/pass.json', booking: { ...pass.booking } };
  assert.deepEqual(days([at('museum', '2026-11-21T10:00:00-09:00', '/bookings/pass.json')], untimed), ['item@2026-11-21']);
});

test('a restored plan item with no offset gives the same instant everywhere a stored time is read: the Plan, its reminders and the calendar file', async () => {
  const { planWatches } = await import('../../src/core/live/plan-watches.js');
  const { planToIcs } = await import('../../src/core/ics.js');
  const dinner = { id: 'dinner', title: 'Dinner with Sam', fixed: true, start: { at: '2026-11-21T18:30', tz: AK }, end: { at: '2026-11-21T20:00', tz: AK } };
  const want = Date.parse('2026-11-21T18:30:00-09:00');
  const [row] = planRows([{ path: '/plan/dinner.json', item: dinner }], [], { fallbackTz: 'UTC' });
  assert.equal(row.at, want);
  const watches = planWatches([{ path: '/plan/dinner.json', item: dinner }], new Map(), { fallbackTz: 'UTC' });
  assert.ok(watches.length > 0);
  for (const w of watches) assert.deepEqual([w.when.at, w.when.end], [want, Date.parse('2026-11-21T20:00:00-09:00')], w.id);
  const { text } = planToIcs([dinner, { id: 'museum', title: 'Museum day', kind: 'all-day', fixed: true, start: { at: '2026-11-22T00:00', tz: AK } }], { name: 'Anchorage', tripId: 't-1', now: 0 });
  assert.match(text, /DTSTART:20261122T033000Z\r\nDTEND:20261122T050000Z/);
  assert.match(text, /DTSTART;VALUE=DATE:20261122/);
});

test("a plan item written in another zone than its booking still stands for it on the booking's day: a red-eye isn't shown twice (the second review, X1)", () => {
  const redeye = { path: '/bookings/f.json', booking: { id: 'f', kind: 'flight', status: 'unverified', source: '/files/f.pdf', unsure: [], title: 'Red-eye',
    start: { at: '2026-11-20T23:30:00-08:00', tz: LA }, end: { at: '2026-11-21T07:30:00-05:00', tz: NY } } };
  for (const tz of [NY, 'UTC']) {
    const at = tz === NY ? '2026-11-21T02:30:00-05:00' : '2026-11-21T07:30:00Z';
    const item = { path: '/plan/f.json', item: { id: 'f', title: 'Red-eye', fixed: true, start: { at, tz }, booking: '/bookings/f.json' } };
    // The item stands for the departure; the arrival is a row of its own, the next day.
    assert.deepEqual(planRows([item], [redeye], { fallbackTz: LA }).map((r) => [r.from, r.day]), [['item', '2026-11-21'], ['end', '2026-11-21']], tz);
  }
  // A stay's check-out item written in UTC, already the next day there: still the check-out's day in Anchorage.
  const out = { path: '/plan/out.json', item: { id: 'out', title: 'Check out', fixed: true, start: { at: '2026-11-27T03:00:00Z', tz: 'UTC' }, booking: '/bookings/stay.json' } };
  const late = { path: '/bookings/stay.json', booking: { ...stay.booking, end: { at: '2026-11-26T18:00:00-09:00', tz: AK } } };
  assert.equal(planRows([out], [late], { fallbackTz: 'UTC' }).some((r) => r.from === 'end'), false);
});

// The drive-test follow-ups, section 2: everything with a start and an end on a later day is a set: its start row, a quiet line on each
// day between, and its end as a row of its own.
const { rowName, lineName } = await import('../../src/ui/format.js');
const car = { path: '/bookings/car.json', booking: { id: 'car', kind: 'car', status: 'unverified', source: '/files/car.pdf', unsure: [], title: 'Test Rentals compact',
  place: { name: 'Airport lot', lat: 61.17, lng: -149.99 }, start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-27T09:00:00-09:00', tz: AK } } };
/** Each row as from@day time name. @param {import('../../src/core/plan.js').PlanRow[]} rows */
const shown = (rows) => rows.map((r) => `${r.from}@${r.day} ${r.time}${r.end ? `–${r.end}` : ''} ${r.line ? lineName(r) : rowName(r)}`);

test('a car: Pick up at its time with no end, a quiet line for each day between (day 2 of 8 … 7 of 8), Return at its time, a regular row', () => {
  const rows = planRows([], [car], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), [
    'booking@2026-11-20 10:00 Pick up · Test Rentals compact', 'end@2026-11-27 09:00 Return · Test Rentals compact',
    ...[2, 3, 4, 5, 6, 7].map((n) => `line@2026-11-${19 + n}  Test Rentals compact · day ${n} of 8`)]);
  const ret = rows[1];
  // The return is a link to the booking, at its place, and counts for Now; a line is neither. Like the pick-up, a booking's own row, it
  // says nothing of what can move (null: nobody said).
  assert.deepEqual([ret.item.fixed, ret.item.place.name, ret.bookingPath, ret.at], [null, 'Airport lot', '/bookings/car.json', Date.parse('2026-11-27T09:00:00-09:00')]);
  assert.deepEqual([rows[2].at, rows[2].time, rows[2].line], [null, '', { n: 2, of: 8 }]);
  const next = upcoming(rows, Date.parse('2026-11-21T12:00:00-09:00'), 10);
  assert.deepEqual(next.map((r) => r.from), ['end']);
  // A car with no title: its kind's word.
  assert.deepEqual(shown(planRows([], [{ ...car, booking: { ...car.booking, title: undefined } }], { fallbackTz: 'UTC' })).slice(0, 3),
    ['booking@2026-11-20 10:00 Pick up · Car', 'end@2026-11-27 09:00 Return · Car', 'line@2026-11-21  Car · day 2 of 8']);
});

test('anything else over several days ends with an Ends row; a train with Arrive; a stay keeps its words', () => {
  const fest = { path: '/bookings/fest.json', booking: { id: 'fest', kind: 'event', status: 'confirmed', source: '/files/f.pdf', title: 'Folk festival',
    start: { at: '2026-11-21T12:00:00-09:00', tz: AK }, end: { at: '2026-11-23T22:00:00-09:00', tz: AK } } };
  assert.deepEqual(shown(planRows([], [fest], { fallbackTz: 'UTC' })), [
    'booking@2026-11-21 12:00 Folk festival', 'end@2026-11-23 22:00 Ends · Folk festival', 'line@2026-11-22  Folk festival · day 2 of 3']);
  const train = { path: '/bookings/t.json', booking: { ...fest.booking, id: 't', kind: 'rail', title: 'Night train', start: { at: '2026-11-21T20:00:00-09:00', tz: AK }, end: { at: '2026-11-22T08:00:00-09:00', tz: AK } } };
  assert.deepEqual(shown(planRows([], [train], { fallbackTz: 'UTC' })), ['booking@2026-11-21 20:00 Night train', 'end@2026-11-22 08:00 Arrive · Night train']);
  assert.deepEqual(shown(planRows([], [stayTo('s', '2026-11-22T11:00:00-09:00')], { fallbackTz: 'UTC' })), [
    'booking@2026-11-20 15:00 Check in · Hotel Aurora Test', 'end@2026-11-22 11:00 Check out · Hotel Aurora Test', 'line@2026-11-21  Staying at Hotel Aurora Test · night 2 of 2']);
  // A plan item with no booking draws its own set, in its own kind's words; one on a single day is one row, as before.
  const hike = { path: '/plan/hike.json', item: { id: 'hike', title: 'Hut trek', fixed: false, start: { at: '2026-11-21T08:00:00-09:00', tz: AK }, end: { at: '2026-11-22T16:00:00-09:00', tz: AK } } };
  const lunch = { path: '/plan/lunch.json', item: { id: 'lunch', title: 'Lunch', fixed: false, start: { at: '2026-11-21T12:00:00-09:00', tz: AK }, end: { at: '2026-11-21T13:00:00-09:00', tz: AK } } };
  const rows = planRows([hike, lunch], [], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), ['item@2026-11-21 08:00 Hut trek', 'end@2026-11-22 16:00 Ends · Hut trek', 'item@2026-11-21 12:00–13:00 Lunch']);
  // The end row goes to the item's details, and is as flexible (○) as the item; the start row is the item without its end.
  assert.deepEqual([rows[1].path, rows[1].item.fixed, rows[0].item.fixed, 'end' in rows[0].item], ['/plan/hike.json', false, false, false]);
  // An all-day item over two days stays one row.
  const museum = { path: '/plan/m.json', item: { id: 'm', title: 'Museum days', kind: 'all-day', fixed: true, start: { at: '2026-11-21T00:00', tz: AK }, end: { at: '2026-11-23T00:00', tz: AK } } };
  assert.deepEqual(planRows([museum], [], { fallbackTz: 'UTC' }).map((r) => r.from), ['item']);
});

test('review focus 1: a booking with only a start, an end before its start, or a zone annai does not know is one row, as before, with no lines', () => {
  const only = planRows([], [{ ...car, booking: { ...car.booking, end: undefined } }], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(only), ['booking@2026-11-20 10:00 Test Rentals compact']);
  const back = planRows([], [{ ...car, booking: { ...car.booking, end: { at: '2026-11-18T09:00:00-09:00', tz: AK } } }], { fallbackTz: 'UTC' });
  assert.deepEqual(back.map((r) => [r.from, r.time, r.end, r.endDays]), [['booking', '10:00', '09:00', -2]]);
  const odd = planRows([], [{ ...car, booking: { ...car.booking, start: { ...car.booking.start, tz: 'Alaska' }, end: { ...car.booking.end, tz: 'Alaska' } } }], { fallbackTz: AK });
  assert.deepEqual(odd.map((r) => [r.from, r.time, r.end, r.endDays]), [['booking', '10:00', '09:00', 7]]);
  assert.match(odd[0].note, /"Alaska" isn't one annai knows/);
});

test('review focus 2: a stay and a plan item for it with slightly different times are one set, from the booking', () => {
  const item = { path: '/plan/in.json', item: { id: 'in', title: 'Hotel Aurora Test', kind: 'lodging', fixed: true, booking: '/bookings/stay.json',
    start: { at: '2026-11-20T16:00:00-09:00', tz: AK }, end: { at: '2026-11-27T10:00:00-09:00', tz: AK } } };
  const rows = planRows([item], [stay], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), [
    'item@2026-11-20 16:00 Hotel Aurora Test', 'end@2026-11-27 11:00 Check out · Hotel Aurora Test',
    ...[2, 3, 4, 5, 6, 7].map((n) => `line@2026-11-${19 + n}  Staying at Hotel Aurora Test · night ${n} of 7`)]);
  assert.equal(rows[1].path, '/bookings/stay.json');
});

test('review focus 3: a red-eye is its departure, then Arrive the next day, with no lines between', () => {
  const redeye = { path: '/bookings/f.json', booking: { id: 'f', kind: 'flight', status: 'unverified', source: '/files/f.pdf', unsure: [], title: 'AN 9 red-eye',
    start: { at: '2026-11-20T23:30:00-08:00', tz: LA }, end: { at: '2026-11-21T07:30:00-05:00', tz: NY } } };
  assert.deepEqual(shown(planRows([], [redeye], { fallbackTz: 'UTC' })), ['booking@2026-11-20 23:30 AN 9 red-eye', 'end@2026-11-21 07:30 Arrive · AN 9 red-eye']);
});

test('a booking with no good times draws its set from the plan item that stands for it and spans days, the earliest; the booking adds no row', () => {
  const bare = { path: '/bookings/car.json', booking: { id: 'car', kind: 'car', status: 'unverified', source: '/files/car.pdf', unsure: [], title: 'Test Rentals compact' } };
  const rent = (/** @type {string} */ id, /** @type {string} */ start) => ({ path: `/plan/${id}.json`, item: { id, title: `Rental car ${id}`, fixed: true, booking: '/trip/bookings/car.json',
    start: { at: start, tz: AK }, end: { at: '2026-11-23T10:00:00-09:00', tz: AK }, place: { name: 'Airport lot' } } });
  const rows = planRows([rent('b', '2026-11-21T10:00:00-09:00'), rent('a', '2026-11-20T10:00:00-09:00')], [bare], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), [
    'item@2026-11-21 10:00–10:00 Rental car b', 'item@2026-11-20 10:00 Pick up · Rental car a', 'end@2026-11-23 10:00 Return · Rental car a',
    'line@2026-11-21  Rental car a · day 2 of 4', 'line@2026-11-22  Rental car a · day 3 of 4']);
  // The end row and the lines go to the booking's details.
  assert.deepEqual([rows[2].path, rows[2].bookingPath, rows[2].item.place.name], ['/plan/a.json', '/bookings/car.json', 'Airport lot']);
  // A return item standing for it on the last day leaves no second Return row.
  const back = { path: '/plan/back.json', item: { id: 'back', title: 'Return the car', fixed: true, booking: '/bookings/car.json', start: { at: '2026-11-23T09:30:00-09:00', tz: AK } } };
  assert.deepEqual(planRows([rent('a', '2026-11-20T10:00:00-09:00'), back], [bare], { fallbackTz: 'UTC' }).map((r) => r.from), ['item', 'line', 'line', 'item']);
  // A stay whose times Shiori wrote under other names: the item's days, in the stay's words.
  const hotel = { path: '/bookings/h.json', booking: { id: 'h', kind: 'lodging', status: 'unverified', source: '/files/h.pdf', checkin: '2026-11-20 15:00', checkout: '2026-11-22 11:00' } };
  const stayItem = { path: '/plan/h.json', item: { id: 'h', title: 'Hotel Aurora Test', fixed: true, booking: '/bookings/h.json', start: { at: '2026-11-20T15:00', tz: AK }, end: { at: '2026-11-22T11:00', tz: AK } } };
  assert.deepEqual(shown(planRows([stayItem], [hotel], { fallbackTz: 'UTC' })), [
    'item@2026-11-20 15:00 Check in · Hotel Aurora Test', 'end@2026-11-22 11:00 Check out · Hotel Aurora Test', 'line@2026-11-21  Staying at Hotel Aurora Test · night 2 of 2']);
});

test('review 2: an end row is not at the start: a flight or train Arrive has no place; a one-way car is where it was dropped; a stay and a round trip keep theirs', () => {
  const at = (/** @type {any} */ b) => planRows([], [{ path: '/bookings/x.json', booking: { ...car.booking, ...b } }], { fallbackTz: 'UTC' }).find((r) => r.from === 'end')?.item.place;
  // A car with a drop-off elsewhere (a name, or a place with one): that; one the model wrote as something else: none.
  assert.deepEqual(at({ fields: { dropoff: 'Downtown desk' } }), { name: 'Downtown desk' });
  assert.deepEqual(at({ fields: { dropoff: { name: 'Downtown desk', lat: 61.2, lng: -149.9 } } })?.name, 'Downtown desk');
  assert.equal(at({ fields: { dropoff: 42 } }), undefined);
  // A blank drop-off says nothing (`there`): the car returns where it was picked up (it was a Return row with no place, for records written when a blank was stored).
  assert.equal(at({ fields: { dropoff: '' } })?.name, 'Airport lot');
  assert.equal(at({ fields: { dropoff: '  ' } })?.name, 'Airport lot');
  assert.equal(at({ fields: { other: 1 } })?.name, 'Airport lot');
  assert.equal(at({})?.name, 'Airport lot');
  // A stay keeps its place; a flight and a train do not, so Plan legs, Drive and Directions don't point at the origin.
  assert.equal(planRows([], [stay], { fallbackTz: 'UTC' }).find((r) => r.from === 'end')?.item.place.name, 'Hotel Aurora Test');
  const far = (/** @type {string} */ kind) => ({ path: '/bookings/f.json', booking: { id: 'f', kind, status: 'unverified', source: '/files/f.pdf', unsure: [], title: 'Night one', place: { name: 'Origin', lat: 61, lng: -149 },
    start: { at: '2026-11-20T23:30:00-08:00', tz: LA }, end: { at: '2026-11-21T07:30:00-05:00', tz: NY } } });
  for (const kind of ['flight', 'rail']) {
    const [start, end] = planRows([], [far(kind)], { fallbackTz: 'UTC' });
    assert.deepEqual([start.item.place?.name, end.item.place, legKm(start, end)], ['Origin', undefined, null]);
  }
  // A plan item drawing the set takes the linked booking's drop-off too.
  const bare = { path: '/bookings/car.json', booking: { id: 'car', kind: 'car', status: 'unverified', source: '/files/car.pdf', unsure: [], fields: { dropoff: 'Downtown desk' } } };
  const item = { path: '/plan/c.json', item: { id: 'c', title: 'Rental', fixed: true, booking: '/bookings/car.json', place: { name: 'Airport lot' }, start: car.booking.start, end: car.booking.end } };
  assert.deepEqual(planRows([item], [bare], { fallbackTz: 'UTC' }).find((r) => r.from === 'end')?.item.place, { name: 'Downtown desk' });
});

test('review 7: a second multi-day item for a booking with no times keeps its end; only the one drawing the set, or one whose booking draws, loses it', () => {
  const bare = { path: '/bookings/car.json', booking: { id: 'car', kind: 'car', status: 'unverified', source: '/files/car.pdf', unsure: [], title: 'Test Rentals compact' } };
  const rent = (/** @type {string} */ id, /** @type {string} */ day) => ({ path: `/plan/${id}.json`, item: { id, title: `Rental ${id}`, fixed: true, booking: '/bookings/car.json',
    start: { at: `2026-11-${day}T10:00:00-09:00`, tz: AK }, end: { at: '2026-11-23T10:00:00-09:00', tz: AK } } });
  const rows = planRows([rent('a', '20'), rent('b', '21')], [bare], { fallbackTz: 'UTC' });
  const mine = (/** @type {string} */ p) => rows.find((r) => r.from === 'item' && r.path === p);
  assert.deepEqual([mine('/plan/a.json')?.end, mine('/plan/b.json')?.end, mine('/plan/b.json')?.endDays], ['', '10:00', 2]);
  // With a booking that draws its own set, the item (a Check in, a pick-up) stays without its end.
  const rows2 = planRows([rent('a', '20')], [car], { fallbackTz: 'UTC' });
  assert.equal(rows2.find((r) => r.path === '/plan/a.json')?.end, '');
});

test('review 10: an Arrive row names its zone when it differs from the departure\'s, and not when it does not', () => {
  const f = (/** @type {string} */ tz2, /** @type {string} */ end) => planRows([], [{ path: '/bookings/f.json', booking: { id: 'f', kind: 'flight', status: 'unverified', source: '/files/f.pdf', unsure: [], title: 'AN 9',
    start: { at: '2026-11-20T23:30:00-08:00', tz: LA }, end: { at: end, tz: tz2 } } }], { fallbackTz: 'UTC' });
  const [, arrive] = f(NY, '2026-11-21T07:30:00-05:00');
  assert.deepEqual([arrive.time, arrive.endZone], ['07:30', 'ET']);
  assert.equal(f(LA, '2026-11-21T07:30:00-08:00')[1].endZone, '');
  // A red-eye's start row has none.
  assert.equal(f(NY, '2026-11-21T07:30:00-05:00')[0].endZone, '');
});

test("a car rental of kind car, 20 to 23 November, linked to a flight's booking with no times draws as a car's set, as the reminders read it: Pick up and Return at its place, not a flight's Arrive with no place; the booking, which the car is no part of, is Not on a day beside it", async () => {
  const { planWatches } = await import('../../src/core/live/plan-watches.js');
  const ua = { path: '/bookings/ua.json', booking: { id: 'ua', kind: 'flight', status: 'unverified', source: '/files/ua.pdf', unsure: [], title: 'ANNAI AIR AN 123' } };
  const rental = (/** @type {unknown} */ kind) => ({ path: '/plan/car.json', item: { id: 'car', title: 'Car rental', kind, fixed: true, booking: '/trip/bookings/ua.json',
    start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-23T10:00:00-09:00', tz: AK }, place: { name: 'Airport lot', lat: 61.17, lng: -149.99 } } });
  for (const kind of ['car', ' Car ']) {
    const rows = planRows([rental(kind)], [ua], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(rows), [
      'item@2026-11-20 10:00 Pick up · Car rental', 'end@2026-11-23 10:00 Return · Car rental',
      'line@2026-11-21  Car rental · day 2 of 4', 'line@2026-11-22  Car rental · day 3 of 4', 'booking@null  ANNAI AIR AN 123'], kind);
    // The flight's booking, which the car is no part of, draws its own row: with no time, under "Not on a day".
    assert.deepEqual(rows.map((r) => r.set?.kind), ['car', 'car', 'car', 'car', undefined], kind);
    assert.deepEqual(planDays(rows, {}).notOnDay.map((r) => r.bookingPath), ['/bookings/ua.json'], kind);
    assert.equal(rows[1].item.place?.name, 'Airport lot', kind); // returned where it was picked up, as a car is
    // The reminders read the same kind from the same table: a car's, with no flight's 2-hour margin and no airport's circle.
    const watches = planWatches([rental(kind)], new Map([[ua.path, ua.booking]]), { fallbackTz: 'UTC' });
    const when = (/** @type {string} */ event) => /** @type {any} */ (watches.find((w) => w.id === `plan:car:${event}`)).when;
    assert.deepEqual([when('leave').by, when('arrived').radius], [Date.parse('2026-11-20T10:00:00-09:00'), 300], kind);
  }
  // With no kind, or a word the table doesn't have, it takes its booking's on the Plan as in the reminders (the neighbour entry, still
  // open): a flight's set, ending with Arrive and no place, and the flight's 2-hour margin.
  for (const kind of [undefined, 'transfer']) {
    const rows = planRows([rental(kind)], [ua], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(rows).slice(0, 2), ['item@2026-11-20 10:00 Car rental', 'end@2026-11-23 10:00 Arrive · Car rental'], String(kind));
    assert.equal(rows[1].item.place, undefined, String(kind));
    const watches = planWatches([rental(kind)], new Map([[ua.path, ua.booking]]), { fallbackTz: 'UTC' });
    assert.equal(/** @type {any} */ (watches.find((w) => w.id === 'plan:car:leave')).when.by, Date.parse('2026-11-20T08:00:00-09:00'), String(kind));
  }
});

test("an item's everyday kind word draws its kind's set, read by the reminders' table: a \"Hotel\" over two nights with no booking is a stay (Check in, Check out, nights), a \"train\" overnight Arrives with no place", () => {
  const item = (/** @type {string} */ kind, /** @type {string} */ title, /** @type {string} */ end) => ({ path: `/plan/${kind.trim()}.json`, item: { id: kind.trim(), title, kind, fixed: true,
    start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: end, tz: AK }, place: { name: title, lat: 61.2, lng: -149.9 } } });
  assert.deepEqual(shown(planRows([item(' Hotel ', 'Harbor Inn', '2026-11-22T11:00:00-09:00')], [], { fallbackTz: 'UTC' })), [
    'item@2026-11-20 15:00 Check in · Harbor Inn', 'end@2026-11-22 11:00 Check out · Harbor Inn', 'line@2026-11-21  Staying at Harbor Inn · night 2 of 2']);
  const train = planRows([item('train', 'Night train', '2026-11-21T08:00:00-09:00')], [], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(train), ['item@2026-11-20 15:00 Night train', 'end@2026-11-21 08:00 Arrive · Night train']);
  assert.equal(train[1].item.place, undefined);
});

// kind-next's fix round 1 (F1): a plan item that is another thing than its booking (both a flight, a train, a car or a stay, not the same
// one) draws its own set, keeps its own end and stands for none of the booking's rows, which the booking draws.
const ua = (/** @type {Record<string, any>} */ b = {}) => ({ path: '/bookings/ua.json', booking: { id: 'ua', kind: 'flight', status: 'unverified', source: '/files/ua.pdf', unsure: [], title: 'ANNAI AIR AN 123', place: { name: 'Home airport' },
  start: { at: '2026-11-20T07:00:00-09:00', tz: AK }, end: { at: '2026-11-20T09:00:00-09:00', tz: AK }, ...b } });
const rental = (/** @type {Record<string, any>} */ o = {}) => ({ path: '/plan/car.json', item: { id: 'car', title: 'Car rental', kind: 'car', fixed: true, booking: '/trip/bookings/ua.json',
  start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-23T10:00:00-09:00', tz: AK }, place: { name: 'Airport lot', lat: 61.17, lng: -149.99 }, ...o } });
const CAR_SET = ['item@2026-11-20 10:00 Pick up · Car rental', 'end@2026-11-23 10:00 Return · Car rental', 'line@2026-11-21  Car rental · day 2 of 4', 'line@2026-11-22  Car rental · day 3 of 4'];
/** The flight's own rows, 07:00 to 09:00 on the 20th: its departure and its Arrive (carrier-rows-next). */
const UA_ROWS = ['booking@2026-11-20 07:00 ANNAI AIR AN 123', 'end@2026-11-20 09:00 Arrive · ANNAI AIR AN 123'];

test("a car rental of kind car on the booking of a flight with a start and an end draws its own set (Pick up, days, Return on the 23rd), and the flight's row stays (the review of kind-next, F1)", () => {
  for (const kind of ['car', ' Car ']) {
    const rows = planRows([rental({ kind })], [ua()], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(rows), [...CAR_SET, ...UA_ROWS], kind);
    // The car's end is its own row, at its own place, of its set; the flight's rows are the booking's, its departure and its Arrive.
    assert.deepEqual(rows.map((r) => r.set?.kind), ['car', 'car', 'car', 'car', 'flight', 'flight'], kind);
    assert.deepEqual([rows[1].item.place?.name, rows[1].path, rows[4].path, rows[5].path], ['Airport lot', '/plan/car.json', '/bookings/ua.json', '/bookings/ua.json'], kind);
  }
  // A flight item linked to the booking stands for the flight's row on its day, as before; the car beside it is a set of its own, and its
  // Return on the 23rd is not stood for by a flight item (the flight home) on that day.
  const out = { path: '/plan/out.json', item: { id: 'out', title: 'Flight out', kind: 'flight', fixed: true, booking: '/trip/bookings/ua.json', start: { at: '2026-11-20T07:00:00-09:00', tz: AK }, end: { at: '2026-11-20T09:00:00-09:00', tz: AK } } };
  const home = { path: '/plan/home.json', item: { id: 'home', title: 'Flight home', kind: 'flight', fixed: true, booking: '/trip/bookings/ua.json', start: { at: '2026-11-23T12:00:00-09:00', tz: AK } } };
  // The flight item keeps its end (main's row, 07:00–09:00), and the booking draws its Arrive beside it.
  assert.deepEqual(shown(planRows([out, home, rental()], [ua()], { fallbackTz: 'UTC' })), ['item@2026-11-20 07:00–09:00 Flight out', 'item@2026-11-23 12:00 Flight home', ...CAR_SET, 'end@2026-11-20 09:00 Arrive · ANNAI AIR AN 123']);
});

test("a car pick-up with no end on a timed flight's booking is a row of its own, and the flight's row stays (the review of kind-next, F1)", () => {
  const pick = rental({ title: 'Car pick-up', end: undefined });
  assert.deepEqual(shown(planRows([pick], [ua()], { fallbackTz: 'UTC' })), ['item@2026-11-20 10:00 Car pick-up', ...UA_ROWS]);
});

test("a flight's booking with a start only, and a car on the 21st to 23rd: the flight's row is drawn beside the car's set (the review of kind-next, F1)", () => {
  const rows = planRows([rental({ start: { at: '2026-11-21T10:00:00-09:00', tz: AK } })], [ua({ end: undefined })], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), ['item@2026-11-21 10:00 Pick up · Car rental', 'end@2026-11-23 10:00 Return · Car rental', 'line@2026-11-22  Car rental · day 2 of 3', 'booking@2026-11-20 07:00 ANNAI AIR AN 123']);
});

test("a stay's booking with a start only, and a car linked to it: the stay's Check in is drawn beside the car's set (the review of kind-next, F1)", () => {
  const inn = { path: '/bookings/ua.json', booking: { id: 'ua', kind: 'lodging', status: 'unverified', source: '/files/ua.pdf', unsure: [], title: 'Harbor Inn', start: { at: '2026-11-20T15:00:00-09:00', tz: AK } } };
  assert.deepEqual(shown(planRows([rental()], [inn], { fallbackTz: 'UTC' })), [...CAR_SET, 'booking@2026-11-20 15:00 Check in · Harbor Inn']);
});

test("a hotel item of kind lodging over two nights on a timed flight's booking is a stay's set (Check in, Check out, nights), and the flight's row stays (the review of kind-next, F1)", () => {
  const inn = { path: '/plan/inn.json', item: { id: 'inn', title: 'Harbor Inn', kind: 'lodging', fixed: true, booking: '/trip/bookings/ua.json',
    start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-22T11:00:00-09:00', tz: AK } } };
  assert.deepEqual(shown(planRows([inn], [ua()], { fallbackTz: 'UTC' })), [
    'item@2026-11-20 15:00 Check in · Harbor Inn', 'end@2026-11-22 11:00 Check out · Harbor Inn', 'line@2026-11-21  Staying at Harbor Inn · night 2 of 2', ...UA_ROWS]);
});

test("a car that ends where a stay's booking does, linked to it, is no plan item of the stay's: the stay's check-out says nobody said (null), and the car's Return is its own (the review of kind-next, F1)", () => {
  const inn = { path: '/bookings/ua.json', booking: { id: 'ua', kind: 'lodging', status: 'unverified', source: '/files/ua.pdf', unsure: [], title: 'Harbor Inn', place: { name: 'Harbor Inn' },
    start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-23T10:00:00-09:00', tz: AK } } };
  const rows = planRows([rental()], [inn], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), [...CAR_SET, 'booking@2026-11-20 15:00 Check in · Harbor Inn', 'end@2026-11-23 10:00 Check out · Harbor Inn',
    'line@2026-11-21  Staying at Harbor Inn · night 2 of 3', 'line@2026-11-22  Staying at Harbor Inn · night 3 of 3']);
  assert.deepEqual(rows.filter((r) => r.from === 'end').map((r) => [r.path, r.item.fixed]), [['/plan/car.json', true], ['/bookings/ua.json', null]]);
});

test("an overnight flight's booking (22:00 on the 20th to 08:00 on the 21st) with a car linked to it draws all of it: the departure, the car's set, the car's days and Return, and the flight's Arrive (the review of kind-next, F1; the second opinion, finding 2)", () => {
  const night = ua({ start: { at: '2026-11-20T22:00:00-09:00', tz: AK }, end: { at: '2026-11-21T08:00:00-09:00', tz: AK } });
  const rows = planRows([rental()], [night], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), [...CAR_SET, 'booking@2026-11-20 22:00 ANNAI AIR AN 123', 'end@2026-11-21 08:00 Arrive · ANNAI AIR AN 123']);
  assert.deepEqual(rows.slice(4).map((r) => [r.path, r.set?.kind]), [['/bookings/ua.json', 'flight'], ['/bookings/ua.json', 'flight']]);
});

test("an item of a generic word on its booking is still the booking's own thing, as before F1: a ferry item on an other booking stands for its departure (the booking draws its Arrive, as a ferry's: carrier-rows-next), a meal item on its restaurant booking and an event item on an other booking are one row with it (the review of kind-next: the narrow rule)", () => {
  const book = (/** @type {string} */ kind, /** @type {string} */ title) => ({ path: '/bookings/b.json', booking: { id: 'b', kind, status: 'unverified', source: '/files/b.pdf', unsure: [], title,
    start: { at: '2026-11-20T12:00:00-09:00', tz: AK }, end: { at: '2026-11-20T13:30:00-09:00', tz: AK } } });
  const on = (/** @type {string} */ kind, /** @type {string} */ title) => ({ path: '/plan/x.json', item: { id: 'x', title, kind, fixed: true, booking: '/bookings/b.json',
    start: { at: '2026-11-20T12:00:00-09:00', tz: AK }, end: { at: '2026-11-20T13:30:00-09:00', tz: AK } } });
  for (const [bookingKind, kind, title] of [['restaurant', 'meal', 'Dinner at Moose'], ['other', 'event', 'Folk night']]) {
    const rows = planRows([on(kind, title)], [book(bookingKind, `${title} (booking)`)], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(rows), [`item@2026-11-20 12:00–13:30 ${title}`], `${kind} on ${bookingKind}`);
  }
  const ferry = planRows([on('ferry', 'Ferry to Whittier')], [book('other', 'Ferry to Whittier (booking)')], { fallbackTz: 'UTC' });
  // The ferry item keeps its end, as it was on main (12:00–13:30); the booking draws its Arrive beside it.
  assert.deepEqual(shown(ferry), ['item@2026-11-20 12:00–13:30 Ferry to Whittier', 'end@2026-11-20 13:30 Arrive · Ferry to Whittier (booking)']);
  assert.deepEqual(ferry.map((r) => r.bookingPath), ['/bookings/b.json', '/bookings/b.json'], 'one thing: both rows are the booking\'s');
});

test("an overnight ride of kind ferry, bus or coach ends as a flight's or train's does, with Arrive and no place, so the Plan draws no leg from where it left and Driving's strip doesn't list it (the review of kind-next, F2: the reminders' CARRIERS)", async () => {
  const { routeStrip } = await import('../../src/core/now.js');
  const ride = (/** @type {string} */ kind) => ({ path: '/plan/ride.json', item: { id: 'ride', title: 'Night ride to Osaka', kind, fixed: true, place: { name: 'Shinjuku terminal', lat: 35.69, lng: 139.7 },
    start: { at: '2026-11-20T23:00:00-09:00', tz: AK }, end: { at: '2026-11-21T06:30:00-09:00', tz: AK } } });
  const breakfast = { path: '/plan/breakfast.json', item: { id: 'breakfast', title: 'Breakfast in Osaka', fixed: false, place: { name: 'Osaka cafe', lat: 34.69, lng: 135.5 }, start: { at: '2026-11-21T08:00:00-09:00', tz: AK } } };
  const asleep = { lat: 35.1, lng: 136.9 }; // aboard near Nagoya
  for (const kind of ['bus', 'ferry', 'coach', ' Bus ', 'rail', 'flight']) {
    const rows = planRows([ride(kind), breakfast], [], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(rows), ['item@2026-11-20 23:00 Night ride to Osaka', 'end@2026-11-21 06:30 Arrive · Night ride to Osaka', 'item@2026-11-21 08:00 Breakfast in Osaka'], kind);
    const [start, end, next] = rows;
    assert.deepEqual([start.item.place?.name, end.item.place, legKm(end, next)], ['Shinjuku terminal', undefined, null], kind); // no leg from the terminal to the breakfast
    // Aboard near Nagoya at 05:00 AKST the next stop on the strip is the breakfast, not the terminal it left.
    assert.deepEqual(routeStrip(rows, asleep, Date.parse('2026-11-21T05:00:00-09:00'), 'driving').map((s) => s.name), ['Osaka cafe'], kind);
  }
  // Kinds that don't carry the traveller keep the place a set ends at: a stay's check-out, a hike's end.
  for (const kind of ['hike', 'other', 'meal']) {
    const rows = planRows([ride(kind)], [], { fallbackTz: 'UTC' });
    assert.deepEqual([rows[1].item.place?.name, shown(rows)[1]], ['Shinjuku terminal', 'end@2026-11-21 06:30 Ends · Night ride to Osaka'], kind);
  }
});

// kind-next's fix round 2.
test("a ride booked as `other` (the booking format has no kind for a ferry) with times, and a ferry item linked to it, ends as a ride does: Arrive, no place, no leg to the breakfast, and Driving's strip doesn't list the port (the re-review of kind-next, R1)", async () => {
  const { routeStrip } = await import('../../src/core/now.js');
  const ticket = { path: '/bookings/ferry.json', booking: { id: 'ferry', kind: 'other', status: 'unverified', source: '/files/ferry.pdf', unsure: [], title: 'Ferry ticket', place: { name: 'Port A', lat: 35.65, lng: 139.8 },
    start: { at: '2026-11-20T19:00:00-09:00', tz: AK }, end: { at: '2026-11-21T07:00:00-09:00', tz: AK } } };
  const ferry = (/** @type {Record<string, any>} */ o = {}) => ({ path: '/plan/ferry.json', item: { id: 'ferry', title: 'Night ferry', kind: 'ferry', fixed: true, booking: '/trip/bookings/ferry.json',
    start: { at: '2026-11-20T19:00:00-09:00', tz: AK }, place: { name: 'Port A', lat: 35.65, lng: 139.8 }, ...o } });
  const breakfast = { path: '/plan/breakfast.json', item: { id: 'breakfast', title: 'Breakfast in Osaka', fixed: false, place: { name: 'Osaka cafe', lat: 34.69, lng: 135.5 }, start: { at: '2026-11-21T08:00:00-09:00', tz: AK } } };
  const asleep = { lat: 35.1, lng: 136.9 }; // aboard near Nagoya
  const end = { at: '2026-11-21T07:00:00-09:00', tz: AK };
  for (const [what, o] of /** @type {[string, Record<string, any>][]} */ ([['no end of its own', {}], ['its own end', { end }]])) {
    for (const kind of ['ferry', 'bus', 'coach']) {
      const rows = planRows([ferry({ kind, ...o }), breakfast], [ticket], { fallbackTz: 'UTC' }).sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at));
      assert.deepEqual(shown(rows), ['item@2026-11-20 19:00 Night ferry', 'end@2026-11-21 07:00 Arrive · Ferry ticket', 'item@2026-11-21 08:00 Breakfast in Osaka'], `${kind}, ${what}`);
      assert.deepEqual([rows[1].item.place, legKm(rows[1], rows[2])], [undefined, null], `${kind}, ${what}`); // no port, so no leg from it to the breakfast
      assert.deepEqual(routeStrip(rows, asleep, Date.parse('2026-11-21T05:00:00-09:00'), 'driving').map((s) => s.name), ['Osaka cafe'], `${kind}, ${what}`);
    }
  }
  // Only a booking of kind other takes a ride's word from an item: a shuttle linked to a stay's or a car's booking leaves its Check out and Return.
  for (const [kind, last] of [['lodging', 'end@2026-11-21 07:00 Check out · Ferry ticket'], ['car', 'end@2026-11-21 07:00 Return · Ferry ticket']]) {
    const rows = planRows([ferry({ kind: 'bus' })], [{ path: ticket.path, booking: { ...ticket.booking, kind } }], { fallbackTz: 'UTC' });
    assert.equal(shown(rows.filter((r) => r.from === 'end')).join(), last, kind);
  }
  // A booking of kind other whose items say nothing of a ride (an event item, or none) keeps its "Ends" at the booking's place.
  // A package booked as other with a flight or a train item on it is no ride: a flight and a train have their own booking kinds.
  for (const items of [[], [ferry({ kind: 'event' })], [ferry({ kind: undefined })], [ferry({ kind: 'flight' })], [ferry({ kind: 'rail' })]]) {
    const rows = planRows(items, [ticket], { fallbackTz: 'UTC' });
    const last = rows.filter((r) => r.from === 'end')[0];
    assert.deepEqual([last.set?.kind, last.item.place?.name, shown([last])[0]], ['other', 'Port A', 'end@2026-11-21 07:00 Ends · Ferry ticket'], JSON.stringify(items.map((x) => x.item.kind)));
  }
});

test("an untitled ride stored as `other`, with a ride item linked to it, is named by the ride's kind on its Arrive row, as an untitled ride booking is, not \"Booking\" (booking-next fix 1)", () => {
  const ticket = { path: '/bookings/ferry.json', booking: { id: 'ferry', kind: 'other', status: 'unverified', source: '/files/ferry.pdf', unsure: [], place: { name: 'Port A', lat: 35.65, lng: 139.8 },
    start: { at: '2026-11-20T19:00:00-09:00', tz: AK }, end: { at: '2026-11-21T07:00:00-09:00', tz: AK } } };
  const ride = (/** @type {string} */ kind) => ({ path: '/plan/ferry.json', item: { id: 'ferry', title: 'Night ride', kind, fixed: true, booking: '/trip/bookings/ferry.json', start: { at: '2026-11-20T19:00:00-09:00', tz: AK } } });
  const last = (/** @type {any[]} */ its, /** @type {any} */ b = ticket) => shown(planRows(its, [b], { fallbackTz: 'UTC' }).filter((r) => r.from === 'end'))[0];
  for (const [kind, word] of [['ferry', 'Ferry'], ['bus', 'Bus'], ['coach', 'Coach']]) {
    assert.equal(last([ride(kind)]), `end@2026-11-21 07:00 Arrive · ${word}`, kind);
    // The same ride written as a booking of its own kind.
    assert.equal(last([], { ...ticket, booking: { ...ticket.booking, kind } }), `end@2026-11-21 07:00 Arrive · ${word}`, `${kind} booking`);
  }
  // With no ride item it is a booking of kind other: "Booking", as before; a title of its own wins.
  assert.equal(last([]), 'end@2026-11-21 07:00 Ends · Booking');
  assert.equal(last([ride('ferry')], { ...ticket, booking: { ...ticket.booking, title: 'Sunflower ferry' } }), 'end@2026-11-21 07:00 Arrive · Sunflower ferry');
});

// booking-next: a ferry, a bus and a coach are booking kinds of their own.
test("a ferry ticket Shiori writes as a booking of kind ferry (bus, coach), with no ride item linked to it, is taken, and ends on the Plan as a train's booking does: Arrive with no place, no leg from the port to the breakfast, and Driving's strip doesn't list the port (main refused the kind, so a ferry was written `other` and ended \"Ends · Ferry ticket\" at the port)", async () => {
  const { routeStrip } = await import('../../src/core/now.js');
  const { Registry } = await import('../../src/core/registry.js');
  const { PluginHost } = await import('../../src/core/plugins.js');
  const { makeSchemaFor } = await import('../../src/core/schema.js');
  const { kindOf } = await import('../../src/core/scopes.js');
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Seto Inland Sea' });
  await ws.patch(trip, '/trip.json', { timezones: [AK] }, { author: 'user' });
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  const write = (/** @type {any} */ input) => tools.write.run(input, { scope: trip, trip, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori' });
  await ws.write(trip, '/plan/breakfast.json', { id: 'breakfast', title: 'Breakfast in Osaka', fixed: false, place: { name: 'Osaka cafe', lat: 34.69, lng: 135.5 }, start: { at: '2026-11-21T08:00:00-09:00', tz: AK } }, { author: 'user' });
  const asleep = { lat: 35.1, lng: 136.9 }; // aboard
  for (const kind of ['ferry', 'bus', 'coach']) {
    // As she writes it: aliases for its times, each in the place it leaves or arrives (a ride's time never takes the trip's only zone).
    await write({ path: '/trip/bookings/ride.json', content: { id: 'ride', kind, status: 'unverified', source: '/trip/files/ride.pdf', unsure: [], title: 'Ferry ticket',
      place: { name: 'Port A', lat: 35.65, lng: 139.8 }, depart: '2026-11-20T19:00', arrive: { at: '2026-11-21T07:00', tz: AK }, tz: AK } });
    assert.equal((await ws.readJSON(trip, '/bookings/ride.json')).kind, kind);
    const { rows } = await tripRows({ store, ws }, trip);
    const timed = rows.filter((r) => r.at !== null).sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at));
    assert.deepEqual(shown(timed), ['booking@2026-11-20 19:00 Ferry ticket', 'end@2026-11-21 07:00 Arrive · Ferry ticket', 'item@2026-11-21 08:00 Breakfast in Osaka'], kind);
    const [, end, breakfast] = timed;
    assert.deepEqual([end.set?.kind, end.item.place, legKm(end, breakfast)], [kind, undefined, null], kind); // no port, so no leg from it
    assert.deepEqual(routeStrip(rows, asleep, Date.parse('2026-11-21T05:00:00-09:00'), 'driving').map((s) => s.name), ['Osaka cafe'], kind);
  }
});

test("a car rental linked to a flight's booking opens its own item and carries no check chip of the flight's: its rows have no booking, and the link it wrote stays (the second opinion on kind-next's fix round 1, findings 1 and 2)", () => {
  const rows = planRows([rental()], [ua({ unsure: ['start'] })], { fallbackTz: 'UTC' });
  const car = rows.filter((r) => r.path === '/plan/car.json');
  assert.equal(car.length, 4, 'pick up, Return and two quiet lines');
  for (const r of car) assert.deepEqual([r.bookingPath, r.booking, r.checkFields, r.missing], [null, null, [], false], r.from);
  assert.deepEqual(car.filter((r) => r.set?.part !== 'line').map((r) => detailsHref('t1', r)), Array(2).fill('#/trip/t1/item?path=%2Fplan%2Fcar.json'));
  // The flight's own row is the booking's, with its marks and its link, as before.
  const [flight] = rows.filter((r) => r.path === '/bookings/ua.json');
  assert.deepEqual([flight.bookingPath, flight.booking?.id, flight.checkFields.length > 0], ['/bookings/ua.json', 'ua', true]);
  assert.equal(detailsHref('t1', flight), '#/trip/t1/booking?path=%2Fbookings%2Fua.json');
  // The link the item wrote is still read: a car linked to a booking the trip doesn't have is missing.
  assert.deepEqual(planRows([rental()], [], { fallbackTz: 'UTC' }).filter((r) => r.from !== 'line').map((r) => r.missing), [true, true]);
  // A car on its own kind of booking is that booking's: its row carries it and opens it, as an item of the booking's thing does.
  const hire = { path: '/bookings/ua.json', booking: { id: 'ua', kind: 'car', status: 'unverified', source: '/files/ua.pdf', unsure: ['start'], title: 'Car hire', start: { at: '2026-11-20T10:00:00-09:00', tz: AK } } };
  const [pick] = planRows([rental()], [hire], { fallbackTz: 'UTC' });
  assert.deepEqual([pick.bookingPath, pick.checkFields], ['/bookings/ua.json', ['start']]);
});

test("a car item on a booking of a kind outside the four (other, restaurant, event) is that booking's thing and stands for it, one row: the rule reads the booking's word too (the second opinion on kind-next's fix round 1, finding 4)", () => {
  const book = (/** @type {string} */ kind) => ({ path: '/bookings/b.json', booking: { id: 'b', kind, status: 'unverified', source: '/files/b.pdf', unsure: ['start'], title: 'Transfer voucher',
    start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-20T12:00:00-09:00', tz: AK } } });
  const car = { path: '/plan/car.json', item: { id: 'car', title: 'Car rental', kind: 'car', fixed: true, booking: '/trip/bookings/b.json',
    start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-20T12:00:00-09:00', tz: AK } } };
  for (const kind of ['other', 'restaurant', 'event']) {
    const rows = planRows([car], [book(kind)], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(rows), ['item@2026-11-20 10:00–12:00 Car rental'], kind);
    assert.deepEqual([rows[0].bookingPath, rows[0].checkFields], ['/bookings/b.json', ['start']], kind); // it is the booking's own: it opens it and carries its marks
  }
});

// carrier-rows-next: a booked flight, train, ferry, bus or coach is its departure at its place and an Arrive with no place, whatever the
// day (the Deferred entries "A same-day carrier booking keeps its departure place" and "The Driving strip keeps a flight already left as
// the next stop"); main split only one that arrived on a later day. A plan item that ends the same day stays one row, with its end.
const CARRIED = ['flight', 'rail', 'ferry', 'bus', 'coach'];
const PORT = { name: 'Port A', lat: 61.0, lng: -149.0 };
const supper = { path: '/plan/dinner.json', item: { id: 'dinner', title: 'Dinner', fixed: true, start: { at: '2026-11-20T19:00:00-09:00', tz: AK }, place: { name: 'Harbor cafe', lat: 61.4, lng: -149.6 } } };
const ak = (/** @type {string} */ hhmm, day = '2026-11-20') => ({ at: `${day}T${hhmm}:00-09:00`, tz: AK });
/** A ride from Port A, 08:00 to 10:00 on the 20th. @param {string} kind @param {Record<string, any>} [o] */
const rideBooking = (kind, o = {}) => ({ path: '/bookings/ride.json', booking: { id: 'ride', kind, status: 'unverified', source: '/files/ride.pdf', unsure: [], title: 'Ride ticket', place: PORT, start: ak('08:00'), end: ak('10:00'), ...o } });
/** @param {string} kind @param {Record<string, any>} [o] */
const rideItem = (kind, o = {}) => ({ path: '/plan/ride.json', item: { id: 'ride', title: 'Morning ride', kind, fixed: true, place: PORT, start: ak('08:00'), end: ak('10:00'), ...o } });
/** A day's rows as the Plan's tab orders them. @param {import('../../src/core/plan.js').PlanRow[]} rows */
const dayOf = (rows, key = '2026-11-20') => planDays(rows, {}).days.find((d) => d.key === key)?.rows ?? [];
/** The legs the Plan's timetable draws on a day: between rows next to each other, none to or from a quiet line. @param {import('../../src/core/plan.js').PlanRow[]} rows */
const legsOn = (rows, key = '2026-11-20') => {
  const on = dayOf(rows, key);
  return on.flatMap((r, i) => (i && r.from !== 'line' && on[i - 1].from !== 'line' && legKm(on[i - 1], r) !== null ? [`${on[i - 1].item.place?.name} → ${r.item.place?.name}`] : []));
};

test("a same-day flight, train, ferry, bus or coach booking is its departure at its place and an Arrive with no place, as an overnight one is, so the Plan draws no leg from where it left to the next stop (main: one row 08:00–10:00 at Port A, and a leg Port A → Harbor cafe)", () => {
  for (const kind of CARRIED) {
    const rows = planRows([supper], [rideBooking(kind)], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(rows)), ['booking@2026-11-20 08:00 Ride ticket', 'end@2026-11-20 10:00 Arrive · Ride ticket', 'item@2026-11-20 19:00 Dinner'], kind);
    const [start, end] = dayOf(rows);
    assert.deepEqual([start.item.place?.name, end.item.place, end.path, end.set?.kind, end.item.fixed], ['Port A', undefined, '/bookings/ride.json', kind, null], kind);
    assert.deepEqual(legsOn(rows), [], kind);
  }
  // An untitled one is named by its kind on both rows, as an overnight one is.
  assert.deepEqual(shown(dayOf(planRows([], [rideBooking('ferry', { title: undefined })], { fallbackTz: 'UTC' }))), ['booking@2026-11-20 08:00 Ferry', 'end@2026-11-20 10:00 Arrive · Ferry']);
  // A flight that lands in another zone the same day names it on its Arrive, as a red-eye's does.
  const west = rideBooking('flight', { start: { at: '2026-11-20T11:20:00-08:00', tz: LA }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK } });
  assert.deepEqual(planRows([], [west], { fallbackTz: 'UTC' }).map((r) => [r.from, r.time, r.end, r.endZone]), [['booking', '11:20', '', ''], ['end', '14:05', '', 'AKT']]);
});

test("a same-day plan item of kind flight, rail, ferry, bus or coach is one row with its end, as on main, alone or on a booking with no times, so the Plan still draws its leg (Deferred); on a timed carrier booking it stands for the departure and the booking draws the Arrive, no leg between", () => {
  for (const kind of [...CARRIED, ' Train ', 'plane']) {
    // Alone: main's row, 08:00–10:00 at Port A, and main's leg to the next stop (the Deferred entry "A flight, train or ride the Plan can't split").
    const alone = planRows([rideItem(kind), supper], [], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(alone)), ['item@2026-11-20 08:00–10:00 Morning ride', 'item@2026-11-20 19:00 Dinner'], kind);
    assert.deepEqual(legsOn(alone), ['Port A → Harbor cafe'], kind);
  }
  for (const kind of CARRIED) {
    // On its booking, with the booking's times: the item stands for the departure and keeps its end (main's row), and the booking draws the
    // Arrive: the end said twice, no leg between.
    const on = planRows([rideItem(kind, { booking: '/trip/bookings/ride.json' }), supper], [rideBooking(kind)], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(on)), ['item@2026-11-20 08:00–10:00 Morning ride', 'end@2026-11-20 10:00 Arrive · Ride ticket', 'item@2026-11-20 19:00 Dinner'], kind);
    assert.equal(dayOf(on)[1].item.fixed, true, `${kind}: the Arrive is as fixed as the item that ends there`);
    assert.deepEqual(legsOn(on), [], kind);
    // The departure item Shiori writes for a booking (the plan-a-trip skill), with no end: main drew it alone, so the arrival was nowhere on the Plan.
    const departure = planRows([rideItem(kind, { booking: '/trip/bookings/ride.json', end: undefined }), supper], [rideBooking(kind)], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(departure)), ['item@2026-11-20 08:00 Morning ride', 'end@2026-11-20 10:00 Arrive · Ride ticket', 'item@2026-11-20 19:00 Dinner'], kind);
    assert.deepEqual(legsOn(departure), [], kind);
    // On a booking with no times: nothing draws an Arrive, so it is main's row (the Deferred entry again).
    const bare = planRows([rideItem(kind, { booking: '/trip/bookings/ride.json' }), supper], [rideBooking(kind, { start: undefined, end: undefined })], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(bare)), ['item@2026-11-20 08:00–10:00 Morning ride', 'item@2026-11-20 19:00 Dinner'], kind);
    assert.deepEqual(legsOn(bare), ['Port A → Harbor cafe'], kind);
  }
  // A kind that doesn't carry the traveller keeps one row, with its end, at its place, and its leg on.
  for (const kind of ['meal', 'event', 'hike', undefined]) {
    const rows = planRows([rideItem(kind, { title: 'Harbor walk' }), supper], [], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(rows)), ['item@2026-11-20 08:00–10:00 Harbor walk', 'item@2026-11-20 19:00 Dinner'], String(kind));
    assert.deepEqual(legsOn(rows), ['Port A → Harbor cafe'], String(kind));
  }
});

test("Driving's strip lists a flight's, a train's or a ride's place until it leaves, and never once it has: while aboard, the first half hour too, and after it arrives (main listed Port A until 10:00, or half an hour from the start of one with no end)", async () => {
  const { routeStrip } = await import('../../src/core/now.js');
  const near = { lat: 61.01, lng: -149.01 }; // on the way to the port
  const aboard = { lat: 61.2, lng: -149.3 };
  const landed = { lat: 61.35, lng: -149.5 };
  const strip = (/** @type {any[]} */ rows, /** @type {string} */ hhmm, /** @type {any} */ here) => routeStrip(rows, here, Date.parse(ak(hhmm).at), 'driving').map((s) => s.name);
  for (const kind of CARRIED) {
    const shapes = /** @type {[string, any[], any[]][]} */ ([
      ['booking', [supper], [rideBooking(kind)]],
      ['item', [rideItem(kind), supper], []],
      ['item on its booking', [rideItem(kind, { booking: '/trip/bookings/ride.json' }), supper], [rideBooking(kind)]],
      ['item with no end', [rideItem(kind, { end: undefined }), supper], []],
    ]);
    for (const [what, items, bookings] of shapes) {
      const rows = planRows(items, bookings, { fallbackTz: 'UTC' });
      assert.deepEqual(strip(rows, '07:30', near), ['Port A', 'Harbor cafe'], `${kind} ${what}: on the way there`);
      assert.deepEqual(strip(rows, '07:59', near), ['Port A', 'Harbor cafe'], `${kind} ${what}: a minute before it leaves`);
      for (const hhmm of ['08:00', '08:15', '09:00', '09:59']) assert.deepEqual(strip(rows, hhmm, aboard), ['Harbor cafe'], `${kind} ${what}: aboard at ${hhmm}`);
      assert.deepEqual(strip(rows, '10:30', landed), ['Harbor cafe'], `${kind} ${what}: after it arrives`);
    }
  }
  // An overnight one, the Plan's two rows on main too: its port is gone from its departure, not half an hour later.
  const night = planRows([rideItem('ferry', { start: ak('23:00'), end: ak('06:30', '2026-11-21') })], [], { fallbackTz: 'UTC' });
  assert.deepEqual(strip(night, '22:30', near), ['Port A']);
  assert.deepEqual(strip(night, '23:10', aboard), []);
  // A stop that carries no one stays on the strip for half an hour from its start, as before.
  const walk = planRows([rideItem('event', { title: 'Harbor walk', end: undefined }), supper], [], { fallbackTz: 'UTC' });
  assert.deepEqual(strip(walk, '08:15', near), ['Port A', 'Harbor cafe']);
});

test("guard, not the change (as before carrier-rows-next): a ride, a train or a flight item on a same-day booking that is one row (an event's, a car's, a restaurant's, a package booked as other) stands for that row and keeps its end, so no time is lost", () => {
  for (const [bookingKind, kind] of [['event', 'ferry'], ['event', 'bus'], ['car', 'bus'], ['restaurant', 'ferry'], ['other', 'flight'], ['other', 'rail']]) {
    const rows = planRows([rideItem(kind, { booking: '/trip/bookings/ride.json' })], [rideBooking(bookingKind)], { fallbackTz: 'UTC' });
    assert.deepEqual(shown(dayOf(rows)), ['item@2026-11-20 08:00–10:00 Morning ride'], `${kind} on ${bookingKind}`);
  }
});

// The review of carrier-rows-next, finding 1: an item on a booking is main's row, with its end, so no time main showed is gone; the split only
// adds an Arrive. Each shape below showed its times on main and lost them in the first build (its test says which).
/** One day's rows of a booking and the items on it, without the quiet lines. @param {any[]} items @param {any} booking */
const onBooking = (items, booking, key = '2026-11-20') => shown(dayOf(planRows(items, [booking], { fallbackTz: 'UTC' }), key).filter((r) => r.from !== 'line'));
/** A plan item on the ride booking. @param {string} id @param {Record<string, any>} [o] @param {string} [kind] */
const linked = (id, o = {}, kind = 'flight') => ({ ...rideItem(kind, { id, title: id, booking: '/trip/bookings/ride.json', ...o }), path: `/plan/${id}.json` });

test("a round trip under one flight booking, one item a leg with its end: both legs keep their end (the first build: '11:20 outbound', '13:00 return')", () => {
  const booking = rideBooking('flight', { start: ak('11:20'), end: ak('17:30', '2026-11-27') });
  const legs = [linked('outbound', { start: ak('11:20'), end: ak('14:05') }), linked('return', { start: ak('13:00', '2026-11-27'), end: ak('17:30', '2026-11-27') })];
  assert.deepEqual(onBooking(legs, booking), ['item@2026-11-20 11:20–14:05 outbound']);
  assert.deepEqual(onBooking(legs, booking, '2026-11-27'), ['item@2026-11-27 13:00–17:30 return']);
});

test("a connection under one booking, two leg items with their ends, keeps both ends, with the booking's times and with none (the first build: '08:00 leg1', '11:00 leg2', and with none '08:00 leg1')", () => {
  const connection = [linked('leg1', { end: ak('10:00') }), linked('leg2', { start: ak('11:00'), end: ak('13:00') })];
  const both = ['item@2026-11-20 08:00–10:00 leg1', 'item@2026-11-20 11:00–13:00 leg2'];
  assert.deepEqual(onBooking(connection, rideBooking('flight', { end: ak('13:00') })), both);
  assert.deepEqual(onBooking(connection, rideBooking('flight', { start: undefined, end: undefined })), both);
});

test("a flight item with its end and a no-kind item (a taxi) on the flight's booking: the flight keeps its end (the first build: '14:05 fly')", () => {
  const items = [linked('fly', { start: ak('14:05'), end: ak('16:30') }), linked('taxi', { kind: undefined, start: ak('17:00'), end: undefined })];
  assert.deepEqual(onBooking(items, rideBooking('flight', { start: ak('14:05'), end: ak('16:30') })), ['item@2026-11-20 14:05–16:30 fly', 'item@2026-11-20 17:00 taxi']);
});

test("a day-return train, one booking with an out and a back item, keeps both ends (the first build: '08:00 out', '16:00 back')", () => {
  const items = [linked('out', { end: ak('10:00') }, 'rail'), linked('back', { start: ak('16:00'), end: ak('18:00') }, 'rail')];
  assert.deepEqual(onBooking(items, rideBooking('rail', { end: ak('18:00') })), ['item@2026-11-20 08:00–10:00 out', 'item@2026-11-20 16:00–18:00 back']);
});

test("a check-in at 06:30 beside the departure item, with the booking's times and with none, and two flights on a booking with no times: each flight keeps its end (the first build: '08:00 Fly' and no arrival, '08:00 f1')", () => {
  const checkIn = linked('check-in', { start: ak('06:30'), end: undefined }, undefined);
  for (const booking of [rideBooking('flight'), rideBooking('flight', { start: undefined, end: undefined })]) {
    assert.deepEqual(onBooking([checkIn, linked('fly')], booking), ['item@2026-11-20 06:30 check-in', 'item@2026-11-20 08:00–10:00 fly']);
  }
  const two = [linked('f1'), linked('f2', { start: ak('14:00'), end: ak('16:00') })];
  assert.deepEqual(onBooking(two, rideBooking('flight', { start: undefined, end: undefined })), ['item@2026-11-20 08:00–10:00 f1', 'item@2026-11-20 14:00–16:00 f2']);
});

test("a ride item on a multi-day booking of another kind (a shuttle on a stay's, a ferry on a car's, a flight on a package booked other or event; none is another thing, anotherThing) keeps its end: the item rows only, the booking's end and quiet lines are left out here, and its start (a stay's check-in, a car's pick-up) is hidden by the item, which stands for it by day, as on main (the kind-next entry's last bullet) (the first build: '14:00 shuttle', no Arrive)", () => {
  const days = { start: ak('09:00'), end: ak('09:00', '2026-11-22') };
  for (const [bookingKind, kind] of [['lodging', 'bus'], ['car', 'ferry'], ['other', 'flight'], ['event', 'flight']]) {
    const items = [linked('shuttle', { start: ak('14:00'), end: ak('14:40') }, kind)];
    assert.deepEqual(onBooking(items, rideBooking(bookingKind, days)).filter((r) => r.startsWith('item')), ['item@2026-11-20 14:00–14:40 shuttle'], `${kind} on ${bookingKind}`);
  }
});

test("a shuttle at 06:00 to 07:30 before the flight's 09:00 to 12:00 keeps its end and stands for the flight's departure by day, so the flight's 09:00 departure is nowhere (as on main; the kind-next entry's bullet) and the flight's Arrive follows; one item on its booking keeps its end beside the booking's Arrive (the end said twice, no leg between)", () => {
  assert.deepEqual(onBooking([linked('shuttle', { start: ak('06:00'), end: ak('07:30') }, 'bus')], rideBooking('flight', { start: ak('09:00'), end: ak('12:00') })),
    ['item@2026-11-20 06:00–07:30 shuttle', 'end@2026-11-20 12:00 Arrive · Ride ticket']);
  const rows = planRows([linked('ride'), supper], [rideBooking('ferry')], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(dayOf(rows)), ['item@2026-11-20 08:00–10:00 ride', 'end@2026-11-20 10:00 Arrive · Ride ticket', 'item@2026-11-20 19:00 Dinner']);
  assert.deepEqual(legsOn(rows), []);
});

// The second opinion's finding 3 (slice 1, F3): a ride Shiori stored as `other` before booking-next, with a ride item linked.
test("a legacy ride booked as other, with a ride item linked and no end of its own, keeps its row a ride's: Driving's strip drops its port once it leaves (the row's kind was 'booking')", async () => {
  const { routeStrip } = await import('../../src/core/now.js');
  const old = rideBooking('other', { title: 'Ferry ticket', end: undefined });
  const untimed = rideItem('ferry', { booking: '/trip/bookings/ride.json', start: undefined, end: undefined });
  const rows = planRows([untimed, supper], [old], { fallbackTz: 'UTC' });
  const [row] = rows.filter((r) => r.from === 'booking');
  assert.deepEqual([row.set, row.item.kind, row.item.title], [null, 'ferry', 'Ferry ticket']);
  const strip = (/** @type {string} */ hhmm, /** @type {any} */ here) => routeStrip(rows, here, Date.parse(ak(hhmm).at), 'driving').map((s) => s.name);
  assert.deepEqual(strip('07:30', { lat: 61.01, lng: -149.01 }), ['Port A', 'Harbor cafe']);
  for (const hhmm of ['08:00', '08:10', '09:00']) assert.deepEqual(strip(hhmm, { lat: 61.2, lng: -149.3 }), ['Harbor cafe'], hhmm);
  // With no ride item nothing says it is a ride: its row is a booking's, and stays on the strip for half an hour (Deferred).
  const alone = planRows([supper], [old], { fallbackTz: 'UTC' });
  assert.equal(alone.find((r) => r.from === 'booking')?.item.kind, 'booking');
  // A booking of kind other that is no ride keeps 'booking'.
  assert.equal(planRows([], [rideBooking('other', { end: undefined })], { fallbackTz: 'UTC' })[0].item.kind, 'booking');
});

// The second opinion's finding 1 and 2 on fix round 1 (shapes A, B, E): a plan item is main's row, so a same-day carrier item is no set and
// draws no booking's: fix round 1 made it the drawer of a booking with a start only, a stay with a check-out only, and a package, and the
// booking's own rows (a departure, a check-out) or an event's set (its quiet line and its end) were gone. The rows are main's in all three.
const nov = (/** @type {string} */ hhmm, /** @type {number} */ day) => ak(hhmm, `2026-11-${day}`);

test("shape A: a flight booking with a departure only and its item the next day (12:56 to 15:56): the departure stays on its day and the item is main's row, with its end", () => {
  const booking = rideBooking('flight', { start: nov('10:33', 20), end: undefined });
  const item = linked('home', { title: 'Flight home', start: nov('12:56', 21), end: nov('15:56', 21) });
  assert.deepEqual(shown(planRows([item], [booking], { fallbackTz: 'UTC' })), ['item@2026-11-21 12:56–15:56 Flight home', 'booking@2026-11-20 10:33 Ride ticket']);
  // Its departure is also where Driving's strip and Kokoro's view find the flight.
  assert.deepEqual(onBooking([item], booking, '2026-11-20'), ['booking@2026-11-20 10:33 Ride ticket']);
});

test("shape B: a stay with a check-out only (the 21st, 13:47) and a coach item the day before (06:21 to 16:21): the check-out stays and the coach is main's row", () => {
  const booking = rideBooking('lodging', { start: undefined, end: nov('13:47', 21), title: 'Harbor Inn' });
  const coach = linked('coach', { title: 'Coach in', start: nov('06:21', 20), end: nov('16:21', 20) }, 'coach');
  assert.deepEqual(shown(planRows([coach], [booking], { fallbackTz: 'UTC' })), ['item@2026-11-20 06:21–16:21 Coach in', 'end@2026-11-21 13:47 Check out · Harbor Inn']);
});

test("shape E: a booking with no times holding a same-day flight item and an event over three days: the event draws the set (its quiet line, its end on the 22nd) and the flight keeps its end, as on main", () => {
  const booking = rideBooking('other', { start: undefined, end: undefined, title: 'Package' });
  const fly = linked('fly', { title: 'Fly', start: nov('08:00', 20), end: nov('10:00', 20) });
  const fest = linked('fest', { title: 'Festival', kind: 'event', start: nov('09:00', 20), end: nov('09:00', 22) }, 'event');
  const rows = planRows([fly, fest], [booking], { fallbackTz: 'UTC' });
  assert.deepEqual(shown(rows), ['item@2026-11-20 08:00–10:00 Fly', 'item@2026-11-20 09:00 Festival', 'end@2026-11-22 09:00 Ends · Festival', 'line@2026-11-21  Festival · day 2 of 3']);
  assert.deepEqual(rows.map((r) => r.set?.part ?? null), [null, 'start', 'end', 'line']);
});

// The second opinion's findings F1 and F3 (slice 1) are shapes A and B above, in the exact inputs it gave.
test("the second opinion's F1 and F3: a start-only train booking (the 28th, 04:30 Honolulu) with a same-day train item on the 26th, and an end-only stay (a check-out the 26th, 17:30 London) with a same-day ferry item that evening in New York: the booking's own row stays, the item is main's row", () => {
  const train = { path: '/bookings/train.json', booking: { id: 'train', kind: 'rail', status: 'unverified', source: '/files/t.pdf', unsure: [], title: 'Return train', start: { at: '2026-11-28T04:30:00-10:00', tz: 'Pacific/Honolulu' } } };
  const out = { path: '/plan/out.json', item: { id: 'out', title: 'Train out', kind: 'rail', fixed: true, booking: '/trip/bookings/train.json', start: { at: '2026-11-26T08:00:00-08:00', tz: LA }, end: { at: '2026-11-26T10:00:00-08:00', tz: LA } } };
  assert.deepEqual(shown(planRows([out], [train], { fallbackTz: 'UTC' })), ['item@2026-11-26 08:00–10:00 Train out', 'booking@2026-11-28 04:30 Return train']);
  const inn = { path: '/bookings/inn.json', booking: { id: 'inn', kind: 'lodging', status: 'unverified', source: '/files/i.pdf', unsure: [], title: 'Harbor Inn', end: { at: '2026-11-26T17:30:00+00:00', tz: 'Europe/London' } } };
  const ferry = { path: '/plan/ferry.json', item: { id: 'ferry', title: 'Night ferry', kind: 'ferry', fixed: true, booking: '/trip/bookings/inn.json', start: { at: '2026-11-26T21:00:00-05:00', tz: NY }, end: { at: '2026-11-26T21:15:00-05:00', tz: NY } } };
  assert.deepEqual(shown(planRows([ferry], [inn], { fallbackTz: 'UTC' })), ['item@2026-11-26 21:00–21:15 Night ferry', 'end@2026-11-26 17:30 Check out · Harbor Inn']);
});

test("the second opinion's F2: a same-day flight booking across zones (the 25th, 21:30 Tokyo to 19:30 Los Angeles) keeps its booked arrival when a linked item is on the arrival's day in Los Angeles but not on the departure's day in Tokyo; an item that is on both days still stands for the Arrive", () => {
  const booking = { path: '/bookings/ua1.json', booking: { id: 'ua1', kind: 'flight', status: 'unverified', source: '/files/u.pdf', unsure: [], title: 'UA 1 to LAX',
    start: { at: '2026-11-25T21:30:00+09:00', tz: 'Asia/Tokyo' }, end: { at: '2026-11-25T19:30:00-08:00', tz: LA } } };
  const land = { path: '/plan/land.json', item: { id: 'land', title: 'Land at LAX', kind: 'flight', fixed: true, booking: '/trip/bookings/ua1.json', start: { at: '2026-11-25T19:45:00-08:00', tz: LA } } };
  assert.deepEqual(shown(planRows([land], [booking], { fallbackTz: 'UTC' })), ['item@2026-11-25 19:45 Land at LAX', 'booking@2026-11-25 21:30 UA 1 to LAX', 'end@2026-11-25 19:30 Arrive · UA 1 to LAX']);
  // Los Angeles to New York the same day: a taxi at 20:00 New York time is the 25th in both zones, so it stands for the Arrive (the departure item stands for the departure).
  const east = { path: '/bookings/ua2.json', booking: { ...booking.booking, id: 'ua2', title: 'UA 2 to JFK', start: { at: '2026-11-25T11:00:00-08:00', tz: LA }, end: { at: '2026-11-25T19:30:00-05:00', tz: NY } } };
  const fly = { path: '/plan/fly.json', item: { id: 'fly', title: 'Fly', kind: 'flight', fixed: true, booking: '/trip/bookings/ua2.json', start: { at: '2026-11-25T11:00:00-08:00', tz: LA } } };
  const taxi = { path: '/plan/taxi.json', item: { id: 'taxi', title: 'Taxi', fixed: true, booking: '/trip/bookings/ua2.json', start: { at: '2026-11-25T20:00:00-05:00', tz: NY } } };
  assert.deepEqual(shown(planRows([fly, taxi], [east], { fallbackTz: 'UTC' })), ['item@2026-11-25 11:00 Fly', 'item@2026-11-25 20:00 Taxi']);
});
