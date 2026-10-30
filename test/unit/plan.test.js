import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingRef, planRows, planDays, legKm, PLAN_FILE, BOOKING_FILE, beforeShiori, shioriUndos, NIGHTS_MAX } from '../../src/core/plan.js';
import { upcoming } from '../../src/core/now.js';
import { tripRows } from '../../src/ui/trip-rows.js';
import { setWords } from '../../src/core/l10n.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
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

test('planRows: an end on a later day says how many days later, and an end in another zone names it', () => {
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
  const by = Object.fromEntries(planRows(list, [], { fallbackTz: NY }).map((r) => [r.item.id, [r.time, r.end, r.endDays, r.endZone]]));
  assert.deepEqual(by.redeye, ['22:00', '06:30', 1, 'ET']);
  assert.deepEqual(by.day, ['08:00', '16:30', 0, 'ET']);
  assert.deepEqual(by.party, ['21:00', '01:00', 1, '']);
  assert.deepEqual(by.dinner, ['17:00', '20:00', 0, '']);
  assert.deepEqual(by.toronto, ['09:00', '10:30', 0, '']);
  assert.deepEqual(by.back, ['00:30', '13:00', -1, 'HST']);
  assert.deepEqual(by.museum, ['', '', 0, '']);
  // The zone is named in the screens' language.
  setWords('de', null);
  try {
    assert.equal(planRows(list, [], { fallbackTz: NY })[0].endZone, 'New York (Ortszeit)');
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
  assert.deepEqual([r.path, r.bookingPath, r.item.title, r.item.fixed, r.night, r.check, r.missing, r.note], ['/bookings/flight.json', '/bookings/flight.json', 'ANNAI AIR AN 123', true, null, false, false, '']);
  assert.equal(r.booking, flight.booking);
});

test('a stay: check-in, a night line on each day between (night 2 of 7 … 7 of 7), then check-out', () => {
  const rows = planRows([], [stay], { fallbackTz: 'UTC' });
  assert.deepEqual(rows.map((r) => [r.from, r.day, r.night && `${r.night.n}/${r.night.of}`]), [
    ['booking', '2026-11-20', null], ['checkout', '2026-11-27', null],
    ['night', '2026-11-21', '2/7'], ['night', '2026-11-22', '3/7'], ['night', '2026-11-23', '4/7'],
    ['night', '2026-11-24', '5/7'], ['night', '2026-11-25', '6/7'], ['night', '2026-11-26', '7/7']]);
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
    ['item', '/plan/fly.json', '2026-11-20'], ['item', '/plan/in.json', '2026-11-20'], ['checkout', '/bookings/stay.json', '2026-11-27'],
    ...['21', '22', '23', '24', '25', '26'].map((d) => ['night', '/bookings/stay.json', `2026-11-${d}`])]);
  assert.equal(rows[1].bookingPath, '/bookings/stay.json');
  const checkOut = { path: '/plan/out.json', item: { id: 'out', title: 'Check out', fixed: true, start: stay.booking.end, booking: '/bookings/stay.json' } };
  assert.equal(planRows([checkIn, checkOut], [stay], { fallbackTz: 'UTC' }).some((r) => r.from === 'checkout'), false);
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
  assert.deepEqual(days.find((d) => d.key === '2026-11-21')?.rows.map((r) => r.from), ['night', 'item']);
  const nights = (/** @type {any} */ b) => planRows([], [b], { fallbackTz: 'UTC' }).filter((r) => r.from === 'night');
  assert.equal(nights(stayTo('same', '2026-11-20T22:00:00-09:00')).length, 0);
  assert.equal(nights(stayTo('one', '2026-11-21T11:00:00-09:00')).length, 0);
  const long = nights(stayTo('long', '2027-06-08T11:00:00-08:00'));
  assert.equal(NIGHTS_MAX, 60);
  assert.equal(long.length, 60);
  assert.deepEqual([long[0].night, long[59].night], [{ n: 2, of: 200 }, { n: 61, of: 200 }]);
});

test('a booking with a time zone annai does not know, or an end before its start, still shows, in the fallback zone with the note; no nights', () => {
  const odd = stayTo('odd', '2026-11-27T11:00:00-09:00', 'Alaska');
  const rows = planRows([], [odd], { fallbackTz: AK });
  assert.deepEqual(rows.map((r) => [r.from, r.day, r.time]), [['booking', '2026-11-20', '15:00'], ['checkout', '2026-11-27', '11:00']]);
  assert.match(rows[0].note, /"Alaska" isn't one annai knows; shown in America\/Anchorage/);
  const none = planRows([], [{ path: '/bookings/n.json', booking: { ...stay.booking, start: { at: '2026-11-20T15:00:00-09:00' }, end: { at: '2026-11-27T11:00:00-09:00' } } }], { fallbackTz: AK });
  assert.deepEqual(none.map((r) => r.from), ['booking', 'checkout']);
  assert.match(none[0].note, /"" isn't one annai knows/);
  // An end before its start: shown as written, no nights.
  const back = planRows([], [stayTo('back', '2026-11-18T11:00:00-09:00')], { fallbackTz: 'UTC' });
  assert.deepEqual(back.map((r) => [r.from, r.day]), [['booking', '2026-11-20'], ['checkout', '2026-11-18']]);
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
  assert.deepEqual(next.map((r) => [r.from, r.path]), [['booking', '/bookings/flight.json'], ['booking', '/bookings/stay.json'], ['checkout', '/bookings/stay.json']]);
  assert.equal(rows.filter((r) => r.from === 'night').length, 6);
});

test("a plan item linking a booking stands for it only on its own day: a stay keeps its check-in row when the item is its check-out or a breakfast (the review of seeing-bookings, R1)", () => {
  const at = (/** @type {string} */ id, /** @type {string} */ when, /** @type {string} */ booking) => ({ path: `/plan/${id}.json`, item: { id, title: id, fixed: true, start: { at: when, tz: AK }, booking } });
  const days = (/** @type {any[]} */ items, /** @type {any} */ b) => planRows(items, [b], { fallbackTz: 'UTC' }).filter((r) => r.from !== 'night').map((r) => `${r.from}@${r.day}`);
  // R1: only a check-out item: the check-in is still a row, the check-out the item.
  assert.deepEqual(days([at('out', '2026-11-27T11:00:00-09:00', '/bookings/stay.json')], stay), ['item@2026-11-27', 'booking@2026-11-20']);
  // R1b: a breakfast mid-stay: check-in and check-out both stay.
  assert.deepEqual(days([at('breakfast', '2026-11-22T08:00:00-09:00', '/bookings/stay.json')], stay), ['item@2026-11-22', 'booking@2026-11-20', 'checkout@2026-11-27']);
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
    assert.deepEqual(planRows([item], [redeye], { fallbackTz: LA }).map((r) => r.from), ['item'], tz);
  }
  // A stay's check-out item written in UTC, already the next day there: still the check-out's day in Anchorage.
  const out = { path: '/plan/out.json', item: { id: 'out', title: 'Check out', fixed: true, start: { at: '2026-11-27T03:00:00Z', tz: 'UTC' }, booking: '/bookings/stay.json' } };
  const late = { path: '/bookings/stay.json', booking: { ...stay.booking, end: { at: '2026-11-26T18:00:00-09:00', tz: AK } } };
  assert.equal(planRows([out], [late], { fallbackTz: 'UTC' }).some((r) => r.from === 'checkout'), false);
});
