import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookingPath, shioriBooking, checkOf, checkWords } from '../../src/core/bookings.js';

const b = { id: 'hotel', kind: 'lodging', status: 'unverified', source: '/files/hotel.pdf', unsure: [] };

test('isBookingPath: a trip booking record, nothing else', () => {
  assert.equal(isBookingPath('trip-1', '/bookings/hotel.json'), true);
  assert.equal(isBookingPath('trip-1', '/bookings/old/hotel.json'), false);
  assert.equal(isBookingPath('trip-1', '/bookings/hotel.md'), false);
  assert.equal(isBookingPath('me', '/bookings/hotel.json'), false);
});

test('shioriBooking: new ones unverified, never confirmed by her; her change to a confirmed one keeps it confirmed, with nothing marked', () => {
  assert.equal(shioriBooking(undefined, b), b);
  assert.throws(() => shioriBooking(undefined, { ...b, status: 'confirmed' }), /Only the user confirms a booking/);
  assert.throws(() => shioriBooking(b, { ...b, status: 'confirmed' }), /Only the user confirms a booking/);
  // A booking the user confirmed, from before unsure: told "the seat is 14D", she patches it. There is no confirming step any more,
  // so it stays as the user left it, with nothing marked (the review of seeing-bookings, R2).
  const confirmed = { id: 'f', kind: 'flight', status: 'confirmed', source: '/files/f.pdf', title: 'ANNAI AIR AN 123', fields: { seat: '14C' } };
  const changed = shioriBooking(confirmed, { ...confirmed, fields: { seat: '14D' } });
  assert.deepEqual(changed, { ...confirmed, fields: { seat: '14D' } });
  assert.deepEqual(checkOf(changed), { whole: false, fields: [] });
  // R2b: one written with unsure: [] is stored as written, nothing marked.
  const listed = shioriBooking(confirmed, { ...confirmed, fields: { seat: '14D' }, unsure: [] });
  assert.equal(listed.status, 'confirmed');
  assert.deepEqual(checkOf(listed), { whole: false, fields: [] });
  // She may take a confirmation back.
  assert.equal(shioriBooking(confirmed, { ...confirmed, status: 'unverified' }).status, 'unverified');
  // Not a record: the format check says what is wrong.
  assert.equal(shioriBooking(b, 'text'), 'text');
});

test("checkWords: a booking's check as a model is shown it, from what the screens mark (checkOf); nothing when nothing is marked", () => {
  assert.equal(checkWords({ status: 'confirmed' }), '');
  assert.equal(checkWords({ status: 'unverified', unsure: [] }), '', 'one of hers she is sure of');
  assert.equal(checkWords({ status: 'unverified' }), 'not sure it was read right', 'from before fields were marked: checked whole');
  assert.equal(checkWords(undefined), '');
  // With no status (the 固定 re-review's L5): no unsure key is a booking from before, checked whole; an empty unsure marks nothing.
  assert.equal(checkWords({ kind: 'lodging', title: 'Test Inn' }), 'not sure it was read right');
  assert.equal(checkWords({ kind: 'lodging', title: 'Test Inn', unsure: [] }), '');
});

test("checkWords names each part Shiori is unsure of by what it is, as the screens mark it beside its value: never the field's name, which a model says, translated (the 固定 re-review's L2)", () => {
  const t = { at: '2026-11-27T11:00:00-08:00', tz: 'America/Los_Angeles' };
  const words = (/** @type {any} */ x) => checkWords({ status: 'unverified', ...x });
  const said = [
    [words({ kind: 'lodging', unsure: ['end'], end: t }), 'not sure the check-out time was read right'],
    [words({ kind: 'lodging', unsure: ['start'], start: t }), 'not sure the check-in time was read right'],
    [words({ kind: 'flight', unsure: ['start', 'seat'], start: t, fields: { seat: '12A' } }), 'not sure the departure time or the seat was read right'],
    [words({ kind: 'rail', unsure: ['end'], end: t }), 'not sure the arrival time was read right'],
    [words({ kind: 'car', unsure: ['start', 'end'], start: t, end: t }), 'not sure the pick-up time or the return time was read right'],
    [words({ kind: 'event', unsure: ['end'], end: t }), 'not sure the end time was read right'],
    [words({ kind: 'lodging', unsure: ['title', 'confirmation', 'room'], title: 'Test Inn', confirmation: 'TQ1', fields: { room: '204' } }), 'not sure the name, the confirmation number or the room was read right'],
    // A key the screens show as written: the words it is made of.
    [words({ kind: 'lodging', unsure: ['mealPlan', 'late_checkout'], fields: { mealPlan: 'breakfast', late_checkout: 'yes' } }), 'not sure the meal plan or the late checkout was read right'],
    // Only what the screens mark: a name that is no field of it marks nothing, and says nothing.
    [words({ kind: 'lodging', unsure: ['end', 'cost'], end: t }), 'not sure the check-out time was read right'],
  ];
  for (const [got, want] of said) {
    assert.equal(got, want);
    assert.doesNotMatch(got, /\b(unsure|unverified|status|fields|title)\b|\b(start|end)\b(?! time)/);
  }
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
  assert.deepEqual(shioriBooking(undefined, { ...old, unsure: ['seat'] }), { ...old, unsure: ['seat'] });
});
