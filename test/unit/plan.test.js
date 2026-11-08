import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingRef, planRows, planDays, legKm, PLAN_FILE, BOOKING_FILE, beforeShiori, shioriUndos, NIGHTS_MAX } from '../../src/core/plan.js';
import { upcoming } from '../../src/core/now.js';
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
  { path: '/bookings/flight.json', booking: { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pkpass' } },
  { path: '/bookings/hotel.json', booking: { id: 'hotel', kind: 'lodging', status: 'confirmed', source: '/files/hotel.pdf' } },
];
const rows = () => planRows(items, bookings, { fallbackTz: NY });

test('bookingRef: with or without /trip, only a booking record', () => {
  assert.equal(bookingRef('/trip/bookings/a.json'), '/bookings/a.json');
  assert.equal(bookingRef('/bookings/a.json'), '/bookings/a.json');
  assert.equal(bookingRef('/trip/notes/a.md'), null);
  assert.equal(bookingRef(7), null);
});

test('planRows: each item in its own zone, with its booking, and what is wrong with it', () => {
  const by = Object.fromEntries(rows().map((r) => [r.item.id, r]));
  assert.equal(rows().length, 9);
  assert.deepEqual([by.flight.day, by.flight.time, by.flight.end, by.flight.check, by.flight.missing], ['2026-11-25', '08:00', '16:30', true, false]);
  assert.deepEqual([by.hotel.bookingPath, by.hotel.check, by.hotel.missing], ['/bookings/hotel.json', false, false]);
  assert.deepEqual([by.late.day, by.late.time], ['2026-11-25', '23:30']); // already the 26th in New York
  assert.equal(by.dinner.missing, true);
  assert.deepEqual([by.museum.day, by.museum.time], ['2026-11-27', '']);
  assert.deepEqual([by.odd.day, by.odd.time], ['2026-11-28', '12:00']);
  assert.match(by.odd.note, /"Eastern" isn't one annai knows; shown in America\/New_York/);
  assert.deepEqual([by.skate.at, by.skate.day, by.skate.time], [null, null, '']);
});

test('planRows: a booking in any state but confirmed needs checking, as the Bookings list says', () => {
  const item = (/** @type {string} */ id) => ({ path: `/plan/${id}.json`, item: { id, title: id, fixed: true, booking: `/bookings/${id}.json` } });
  const booking = (/** @type {string} */ id, /** @type {unknown} */ status) => ({ path: `/bookings/${id}.json`, booking: { id, kind: 'other', status, source: '/files/x.pdf' } });
  const got = planRows([item('odd'), item('none'), item('ok'), { path: '/plan/free.json', item: { id: 'free', title: 'free', fixed: false } }],
    [booking('odd', 'pending'), booking('none', undefined), booking('ok', 'confirmed')], { fallbackTz: NY });
  assert.deepEqual(got.map((r) => [r.item.id, r.check]), [['odd', true], ['none', true], ['ok', false], ['free', false]]);
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
  const [r] = planRows([], [flight], { fallbackTz: 'UTC' });
  assert.deepEqual([r.from, r.day, r.time, r.end, r.endZone], ['booking', '2026-11-20', '11:20', '14:05', 'AKT']);
  assert.deepEqual([r.path, r.bookingPath, r.item.title, r.item.fixed, r.line, r.check, r.missing, r.note], ['/bookings/flight.json', '/bookings/flight.json', 'ANNAI AIR AN 123', true, null, false, false, '']);
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

test("a plan item linking a booking stands for it; a stay's check-out is still shown unless an item is on that day", () => {
  const fly = { path: '/plan/fly.json', item: { id: 'fly', title: 'Fly to Anchorage', fixed: true, start: flight.booking.start, end: flight.booking.end, booking: '/trip/bookings/flight.json' } };
  const checkIn = { path: '/plan/in.json', item: { id: 'in', title: 'Check in', fixed: true, start: stay.booking.start, booking: '/bookings/stay.json' } };
  const rows = planRows([fly, checkIn], [flight, stay], { fallbackTz: 'UTC' });
  assert.deepEqual(rows.map((r) => [r.from, r.path, r.day]), [
    ['item', '/plan/fly.json', '2026-11-20'], ['item', '/plan/in.json', '2026-11-20'], ['end', '/bookings/stay.json', '2026-11-27'],
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

test('check and checkFields come from checkOf: an old unverified booking is check, a new one lists its fields, an old confirmed one neither', () => {
  const old = { path: '/bookings/old.json', booking: { id: 'old', kind: 'flight', status: 'unverified', source: '/files/a.pdf', start: flight.booking.start } };
  const seat = { path: '/bookings/seat.json', booking: { ...flight.booking, id: 'seat', unsure: ['seat', 'wings'], fields: { seat: '14C' } } };
  const ok = { path: '/bookings/ok.json', booking: { id: 'ok', kind: 'flight', status: 'confirmed', source: '/files/a.pdf', start: flight.booking.start } };
  const by = Object.fromEntries(planRows([], [old, seat, ok], { fallbackTz: 'UTC' }).map((r) => [r.path, [r.check, r.checkFields]]));
  assert.deepEqual(by, { '/bookings/old.json': [true, []], '/bookings/seat.json': [false, ['seat']], '/bookings/ok.json': [false, []] });
  // A plan item that stands for a booking carries its marks.
  const item = { path: '/plan/fly.json', item: { id: 'fly', title: 'Fly', fixed: true, booking: '/bookings/seat.json' } };
  const [r] = planRows([item], [seat], { fallbackTz: 'UTC' });
  assert.deepEqual([r.from, r.check, r.checkFields], ['item', false, ['seat']]);
});

test("Now's next items include a flight booking no plan item stands for, and never a night line", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Anchorage' });
  for (const b of [flight, stay]) await ws.write(trip, b.path, b.booking, { author: 'user' });
  const { rows } = await tripRows({ store, ws }, trip);
  const next = upcoming(rows, Date.parse('2026-11-20T08:00:00-08:00'), 10);
  assert.deepEqual(next.map((r) => [r.from, r.path]), [['booking', '/bookings/flight.json'], ['booking', '/bookings/stay.json'], ['end', '/bookings/stay.json']]);
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
  assert.deepEqual(days([at('online', '2026-11-19T11:20:00-08:00', '/bookings/flight.json')], flight), ['item@2026-11-19', 'booking@2026-11-20']);
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
  // The return is a link to the booking, fixed, at its place, and counts for Now; a line is neither.
  assert.deepEqual([ret.item.fixed, ret.item.place.name, ret.bookingPath, ret.at], [true, 'Airport lot', '/bookings/car.json', Date.parse('2026-11-27T09:00:00-09:00')]);
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
  // The end row goes to the item's details, and is fixed (●) even for a flexible item; the start row is the item without its end.
  assert.deepEqual([rows[1].path, rows[1].item.fixed, rows[0].item.fixed, 'end' in rows[0].item], ['/plan/hike.json', true, false, false]);
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
  assert.equal(at({ fields: { dropoff: '' } }), undefined);
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
