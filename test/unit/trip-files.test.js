import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileRows } from '../../src/core/trip-files.js';

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
  const rows = fileRows({ files, bookings, items, names: { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, toRead: ['/files/new.pdf'] });
  assert.deepEqual(rows.map((r) => [r.name, r.became.map((b) => b.kind)]), [
    ['ANNAI AIR flight · Nov 20', ['booking']], ['hotel.png', ['booking']], ['new.pdf', ['waiting']], ['pasted-2026-10-28-0310.txt', ['nothing']], ['trip.ics', ['plan']]]);
  assert.equal(rows.some((r) => r.real === 'view.jpg'), false);
  assert.deepEqual(rows[0], { path: '/files/flight.pdf', name: 'ANNAI AIR flight · Nov 20', real: 'flight.pdf', type: 'application/pdf', became: [{ kind: 'booking', bookingKind: 'flight', path: '/bookings/flight.json', title: 'ANNAI AIR AN 123' }] });
  assert.deepEqual(rows[4].became, [{ kind: 'plan', path: '/plan/ics-a-1.json', title: 'Dinner' }]);
});

test('fileRows: one file that became two bookings (outbound and return) lists both', () => {
  const both = [...bookings, { path: '/bookings/back.json', booking: { kind: 'flight', title: 'ANNAI AIR AN 124', source: '/files/flight.pdf' } }];
  const [row] = fileRows({ files: [files[0]], bookings: both, items: [], names: {}, toRead: [] });
  assert.deepEqual(row.became.map((b) => b.kind === 'booking' && b.title), ['ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
  // A photo waiting to be read is listed; odd records are no booking.
  const odd = fileRows({ files: [files[5]], bookings: [{ path: '/bookings/x.json', booking: /** @type {any} */ ('text') }], items: [], names: {}, toRead: ['/files/view.jpg'] });
  assert.deepEqual(odd.map((r) => [r.real, r.became]), [['view.jpg', [{ kind: 'waiting' }]]]);
});
