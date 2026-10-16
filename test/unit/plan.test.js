import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingRef, planRows, planDays, legKm, distanceText, dayLabel, PLAN_FILE, BOOKING_FILE } from '../../src/core/plan.js';

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
const rows = () => planRows(items, bookings, { fallbackTz: NY, locale: 'en-US' });

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
    [booking('odd', 'pending'), booking('none', undefined), booking('ok', 'confirmed')], { fallbackTz: NY, locale: 'en-US' });
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
  const by = Object.fromEntries(planRows(list, [], { fallbackTz: NY, locale: 'en-US' }).map((r) => [r.item.id, [r.time, r.end, r.endDays, r.endZone]]));
  assert.deepEqual(by.redeye, ['22:00', '06:30', 1, 'EST']);
  assert.deepEqual(by.day, ['08:00', '16:30', 0, 'EST']);
  assert.deepEqual(by.party, ['21:00', '01:00', 1, '']);
  assert.deepEqual(by.dinner, ['17:00', '20:00', 0, '']);
  assert.deepEqual(by.toronto, ['09:00', '10:30', 0, '']);
  assert.deepEqual(by.back, ['00:30', '13:00', -1, 'HST']);
  assert.deepEqual(by.museum, ['', '', 0, '']);
  // The zone is named the way the locale names it.
  assert.equal(planRows(list, [], { fallbackTz: NY, locale: 'de-DE' })[0].endZone, 'GMT-5');
  // No end, or one that isn't a time: nothing to say about it.
  const plain = planRows([{ path: '/plan/x.json', item: { id: 'x', title: 'x', fixed: false, start: { at: '2026-11-26T10:00:00-05:00', tz: NY }, end: { at: 'soon', tz: LA } } }], [], { fallbackTz: NY, locale: 'en-US' })[0];
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

test('distanceText and dayLabel speak the locale', () => {
  assert.equal(distanceText(0.581, 'en-US'), '≈ 0.4 mi');
  assert.equal(distanceText(42.3, 'en-US'), '≈ 26 mi');
  assert.equal(distanceText(42.3, 'de-DE'), '≈ 42 km');
  assert.equal(distanceText(4.26, 'fr-FR'), '≈ 4,3 km');
  assert.equal(distanceText(10, 'en-GB'), '≈ 6.2 mi');
  assert.equal(distanceText(10, 'not a locale!'), '≈ 6.2 mi');
  assert.equal(dayLabel('2026-11-25', 'en-US'), 'Wed, Nov 25');
});

test('PLAN_FILE and BOOKING_FILE: records sit directly in their folder, as the format check and the booking rule see them', () => {
  assert.equal(PLAN_FILE.test('/plan/dinner.json'), true);
  assert.equal(PLAN_FILE.test('/plan/day1/dinner.json'), false);
  assert.equal(BOOKING_FILE.test('/bookings/hotel.json'), true);
  assert.equal(BOOKING_FILE.test('/bookings/2026/hotel.json'), false);
  assert.equal(BOOKING_FILE.test('/bookings/hotel.pdf'), false);
});
