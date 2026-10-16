import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookingPath, shioriBooking } from '../../src/core/bookings.js';

const b = { id: 'hotel', kind: 'lodging', status: 'unverified', source: '/files/hotel.pdf' };

test('isBookingPath: a trip booking record, nothing else', () => {
  assert.equal(isBookingPath('trip-1', '/bookings/hotel.json'), true);
  assert.equal(isBookingPath('trip-1', '/bookings/old/hotel.json'), false);
  assert.equal(isBookingPath('trip-1', '/bookings/hotel.md'), false);
  assert.equal(isBookingPath('me', '/bookings/hotel.json'), false);
});

test('shioriBooking: new ones unverified, never confirmed by her; her change to a confirmed one goes back to the user', () => {
  assert.deepEqual(shioriBooking(undefined, b), { value: b, note: '' });
  assert.throws(() => shioriBooking(undefined, { ...b, status: 'confirmed' }), /Only the user confirms a booking/);
  assert.throws(() => shioriBooking(b, { ...b, status: 'confirmed' }), /Only the user confirms a booking/);
  const confirmed = { ...b, status: 'confirmed', fields: { breakfast: true, rooms: [1, 2] } };
  // The same record, keys in another order: nothing changed, it stays confirmed.
  const same = { fields: { rooms: [1, 2], breakfast: true }, status: 'confirmed', source: b.source, kind: b.kind, id: b.id };
  assert.deepEqual(shioriBooking(confirmed, same), { value: same, note: '' });
  const changed = shioriBooking(confirmed, { ...confirmed, confirmation: 'HX-7788' });
  assert.deepEqual(changed.value, { ...confirmed, confirmation: 'HX-7788', status: 'unverified' });
  assert.match(changed.note, /^ The user had confirmed it; after your change it is unverified again/);
  // She may take a confirmation back.
  assert.deepEqual(shioriBooking(confirmed, { ...confirmed, status: 'unverified' }).value.status, 'unverified');
  // Not a record: the format check says what is wrong.
  assert.deepEqual(shioriBooking(b, 'text'), { value: 'text', note: '' });
});
