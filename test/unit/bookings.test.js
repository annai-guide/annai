import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookingPath, shioriBooking, checkOf } from '../../src/core/bookings.js';

const b = { id: 'hotel', kind: 'lodging', status: 'unverified', source: '/files/hotel.pdf', unsure: [] };

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
  const same = { fields: { rooms: [1, 2], breakfast: true }, status: 'confirmed', source: b.source, kind: b.kind, id: b.id, unsure: [] };
  assert.deepEqual(shioriBooking(confirmed, same), { value: same, note: '' });
  const changed = shioriBooking(confirmed, { ...confirmed, confirmation: 'HX-7788' });
  assert.deepEqual(changed.value, { ...confirmed, confirmation: 'HX-7788', status: 'unverified' });
  assert.match(changed.note, /^ The user had confirmed it; after your change it is unverified again/);
  // She may take a confirmation back.
  assert.deepEqual(shioriBooking(confirmed, { ...confirmed, status: 'unverified' }).value.status, 'unverified');
  // Not a record: the format check says what is wrong.
  assert.deepEqual(shioriBooking(b, 'text'), { value: 'text', note: '' });
});

test('checkOf: an old unverified booking is marked whole; an old confirmed one not at all; a new one by its unsure fields', () => {
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified' }), { whole: true, fields: [] });
  assert.deepEqual(checkOf({ kind: 'flight', status: 'confirmed' }), { whole: false, fields: [] });
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified', unsure: ['seat', 'end'], fields: { seat: '14C' }, end: { at: '2026-11-20T14:05:00-09:00', tz: 'America/Anchorage' } }), { whole: false, fields: ['seat', 'end'] });
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified', unsure: [] }), { whole: false, fields: [] });
  // Only fields the booking has are marked: a name with nothing written under it has no line to mark.
  assert.deepEqual(checkOf({ kind: 'flight', status: 'unverified', unsure: ['confirmation', 'cost'], confirmation: 'TESTQ1' }), { whole: false, fields: ['confirmation'] });
});

test('checkOf: an unsure name that is no field, or an unsure that is not a list, marks nothing and throws nothing', () => {
  assert.deepEqual(checkOf({ kind: 'other', status: 'unverified', unsure: ['wings'] }), { whole: false, fields: [] });
  assert.deepEqual(checkOf({ kind: 'other', status: 'unverified', unsure: 'seat' }), { whole: false, fields: [] });
  assert.deepEqual(checkOf({ kind: 'other', status: 'unverified', unsure: [3, null, 'title', 'title'], title: 'Hotel Aurora Test', fields: 'not an object' }), { whole: false, fields: ['title'] });
  for (const odd of [null, undefined, 'text', 7, [], { unsure: null }]) assert.doesNotThrow(() => checkOf(odd));
  assert.deepEqual(checkOf(null), { whole: false, fields: [] });
});

test("shioriBooking: a new booking without unsure is refused in words; an old one's change needs none", () => {
  const old = { id: 'b', kind: 'flight', status: 'unverified', source: '/files/f.pdf' };
  assert.throws(() => shioriBooking(undefined, old), /unsure/);
  assert.doesNotThrow(() => shioriBooking(old, { ...old, confirmation: 'TESTQ1' }));
  // One written with unsure keeps it: a rewrite without it would turn it into an old record, marked whole.
  assert.throws(() => shioriBooking({ ...old, unsure: [] }, { ...old, confirmation: 'TESTQ1' }), /unsure/);
  assert.deepEqual(shioriBooking(undefined, { ...old, unsure: ['seat'] }), { value: { ...old, unsure: ['seat'] }, note: '' });
});
