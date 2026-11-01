import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileRows, fileDetails, deletionOf } from '../../src/core/trip-files.js';

/** A file entry in a trip. @param {string} path @param {string} type */
const f = (path, type) => ({ scope: 'trip-1', path, hash: path, size: 1, type, author: 'user', created: 1, modified: 1 });
const files = [
  f('/files/flight.pdf', 'application/pdf'), f('/files/hotel.png', 'image/png'), f('/files/new.pdf', 'application/pdf'), f('/files/trip.ics', 'text/calendar'),
  f('/files/pasted-2026-10-28-0310.txt', 'text/plain'), f('/files/view.jpg', 'image/jpeg'), f('/notes/day1.md', 'text/markdown'), f('/files/scans/old.pdf', 'application/pdf'),
];
const bookings = [
  { path: '/bookings/flight.json', booking: { kind: 'flight', title: 'ANNAI AIR AN 123', source: '/trip/files/flight.pdf' } },
  { path: '/bookings/stay.json', booking: { kind: 'lodging', title: 'Hotel Aurora Test', source: '/files/hotel.png' } },
];
const items = [{ path: '/plan/ics-a-1.json', item: { title: 'Dinner' }, source: '/files/trip.ics' }, { path: '/plan/own.json', item: { title: 'Walk' } }];

test('fileRows: a PDF became a flight, a screenshot a stay, a calendar plan items; a plain photo is left out; a new file waits to be read', () => {
  const rows = fileRows({ files, bookings, items, names: { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, toRead: ['/files/new.pdf'], fallbackTz: 'America/Anchorage' });
  assert.deepEqual(rows.map((r) => [r.name, r.became.map((b) => b.kind)]), [
    ['ANNAI AIR flight · Nov 20', ['booking']], ['Hotel Aurora Test', ['booking']], ['new.pdf', ['waiting']], ['pasted-2026-10-28-0310.txt', ['nothing']], ['trip.ics', ['plan']]]);
  assert.equal(rows.some((r) => r.real === 'view.jpg'), false);
  assert.deepEqual(rows[0], { path: '/files/flight.pdf', name: 'ANNAI AIR flight · Nov 20', real: 'flight.pdf', type: 'application/pdf', became: [{ kind: 'booking', bookingKind: 'flight', path: '/bookings/flight.json', title: 'ANNAI AIR AN 123', at: null, day: null }] });
  assert.deepEqual(rows[4].became, [{ kind: 'plan', path: '/plan/ics-a-1.json', title: 'Dinner', at: null, day: null }]);
});

test('fileRows: one file that became two bookings (outbound and return) lists both', () => {
  const both = [...bookings, { path: '/bookings/return.json', booking: { kind: 'flight', title: 'ANNAI AIR AN 124', source: '/files/flight.pdf' } }];
  const [row] = fileRows({ files: [files[0]], bookings: both, items: [], names: {}, toRead: [], fallbackTz: 'America/Anchorage' });
  assert.deepEqual(row.became.map((b) => b.kind === 'booking' && b.title), ['ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
  // A photo waiting to be read is listed; odd records are no booking.
  const odd = fileRows({ files: [files[5]], bookings: [{ path: '/bookings/x.json', booking: /** @type {any} */ ('text') }], items: [], names: {}, toRead: ['/files/view.jpg'], fallbackTz: 'America/Anchorage' });
  assert.deepEqual(odd.map((r) => [r.real, r.became]), [['view.jpg', [{ kind: 'waiting' }]]]);
});

const AK = 'America/Anchorage';
const out = { kind: 'flight', title: 'ANNAI AIR AN 123', source: '/files/flight.pdf', start: { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' } };
const back = { kind: 'flight', title: 'ANNAI AIR AN 124', source: '/trip/files/flight.pdf', start: { at: '2026-11-27T13:00:00-09:00', tz: AK } };
const two = { files, names: {}, toRead: ['/files/new.pdf'], fallbackTz: AK,
  bookings: [{ path: '/bookings/back.json', booking: back }, { path: '/bookings/out.json', booking: out },
    { path: '/bookings/stay.json', booking: { kind: 'lodging', title: 'Hotel Aurora Test', source: '/files/hotel.png', start: { at: '2026-11-20T15:00:00-09:00', tz: AK } } },
    { path: '/bookings/said.json', booking: { kind: 'restaurant', title: 'Testville Grill', source: '/talk', start: { at: '2026-11-22T19:00:00-09:00', tz: AK } } }],
  items: [{ path: '/plan/fly-home.json', item: { title: 'Fly home', booking: '/trip/bookings/back.json' } },
    { path: '/plan/grill.json', item: { title: 'Dinner at the grill', booking: '/bookings/said.json' } },
    { path: '/plan/ics-a-1.json', item: { title: 'Aurora walk', start: { at: '2026-11-22T22:00:00-09:00', tz: AK } }, source: '/files/trip.ics' }] };

test('fileRows: a file with two flights is one row, its bookings in time order with their days; rows by the first day of what they became (a calendar by its items), then name; no day last', () => {
  const rows = fileRows(two);
  assert.deepEqual(rows.map((r) => r.real), ['flight.pdf', 'hotel.png', 'trip.ics', 'new.pdf', 'pasted-2026-10-28-0310.txt']);
  assert.equal(rows[0].name, 'flight.pdf'); // two bookings: neither title names the file
  assert.deepEqual(rows[0].became.map((b) => b.kind === 'booking' && [b.path, b.day]), [['/bookings/out.json', '2026-11-20'], ['/bookings/back.json', '2026-11-27']]);
  assert.equal(rows[1].name, 'Hotel Aurora Test');
});

test('fileDetails: a file with two bookings has two blocks in time order, each with the plan items that stand for it', () => {
  const d = fileDetails(two, '/files/flight.pdf');
  assert.deepEqual(d?.blocks.map((b) => b.path), ['/bookings/out.json', '/bookings/back.json']);
  assert.deepEqual(d?.blocks[1].items.map((p) => p.path), ['/plan/fly-home.json']);
  assert.equal(d?.focus, null);
  assert.deepEqual(fileDetails(two, '/bookings/back.json')?.focus, '/bookings/back.json');
  assert.equal(fileDetails(two, '/bookings/back.json')?.file?.path, '/files/flight.pdf');
});

test('fileDetails: a booking with no file is its block alone; its plan item without notes is listed', () => {
  const d = fileDetails(two, '/bookings/said.json');
  assert.equal(d?.file, null);
  assert.deepEqual(d?.blocks.map((b) => [b.path, b.items.map((p) => p.path)]), [['/bookings/said.json', ['/plan/grill.json']]]);
  // A source under /files/ that isn't there: alone too.
  const gone = fileDetails({ ...two, bookings: [{ path: '/bookings/x.json', booking: { kind: 'car', source: '/files/gone.pdf' } }] }, '/bookings/x.json');
  assert.equal(gone?.file, null);
});

test('fileDetails: a calendar file lists the plan items made from it; a waiting file and a plain photo have rows and no blocks', () => {
  const ics = fileDetails(two, '/trip/files/trip.ics');
  assert.deepEqual([ics?.blocks.length, ics?.made.map((p) => [p.path, p.day])], [0, [['/plan/ics-a-1.json', '2026-11-22']]]);
  assert.deepEqual(fileDetails(two, '/files/new.pdf')?.file?.became, [{ kind: 'waiting' }]);
  assert.deepEqual(fileDetails(two, '/files/view.jpg')?.file?.became, [{ kind: 'photo' }]); // not in Files, still has a screen
  assert.equal(fileDetails(two, '/files/hotel.png')?.blocks.length, 1); // a photo that became a booking
  for (const p of ['/trip.json', '/files/nope.pdf', '/bookings/nope.json', '/notes/day1.md']) assert.equal(fileDetails(two, p), null, p);
});

test('deletionOf: the file, its bookings, and every plan item shown, once each', () => {
  assert.deepEqual(deletionOf(/** @type {any} */ (fileDetails(two, '/files/flight.pdf'))), { file: '/files/flight.pdf', bookings: ['/bookings/out.json', '/bookings/back.json'], items: ['/plan/fly-home.json'] });
  assert.deepEqual(deletionOf(/** @type {any} */ (fileDetails(two, '/bookings/said.json'))), { file: null, bookings: ['/bookings/said.json'], items: ['/plan/grill.json'] });
  assert.deepEqual(deletionOf(/** @type {any} */ (fileDetails(two, '/files/trip.ics'))), { file: '/files/trip.ics', bookings: [], items: ['/plan/ics-a-1.json'] });
});

test('a date-only start is that day, whatever the zone', () => {
  const t = { ...two, fallbackTz: 'America/Los_Angeles', bookings: [], items: [{ path: '/plan/x.json', item: { title: 'Day trip', start: { at: '2026-11-23' } }, source: '/files/trip.ics' }] };
  assert.deepEqual(fileDetails(t, '/files/trip.ics')?.made.map((p) => p.day), ['2026-11-23']);
});

test("an all-day item sorts by its own day in the trip's zone: west of UTC it comes after the evening before", () => {
  const t = { ...two, bookings: [], items: [
    { path: '/plan/a-day.json', item: { title: 'Day trip', start: { at: '2026-11-23' } }, source: '/files/trip.ics' },
    { path: '/plan/b-eve.json', item: { title: 'Late dinner', start: { at: '2026-11-22T20:00:00-09:00', tz: AK } }, source: '/files/trip.ics' }] };
  assert.deepEqual(fileDetails(t, '/files/trip.ics')?.made.map((p) => p.path), ['/plan/b-eve.json', '/plan/a-day.json']);
});
