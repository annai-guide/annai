import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validZone, deviceZone, isoInZone, instantOf, dayIn, timeIn, offsetMinutes } from '../../src/core/time.js';

test('validZone knows IANA zones and nothing else', () => {
  assert.equal(validZone('America/Los_Angeles'), true);
  assert.equal(validZone('UTC'), true);
  assert.equal(validZone('Pacific Standard Time'), false);
  assert.equal(validZone(''), false);
  assert.equal(validZone(undefined), false);
  assert.equal(validZone(deviceZone()), true);
});

test("isoInZone writes the zone's wall clock with its offset, odd offsets included", () => {
  assert.equal(isoInZone(Date.UTC(2026, 10, 25, 16, 30), 'America/Los_Angeles'), '2026-11-25T08:30:00-08:00');
  assert.equal(isoInZone(Date.UTC(2026, 6, 4, 16, 30), 'America/Los_Angeles'), '2026-07-04T09:30:00-07:00');
  assert.equal(isoInZone(Date.UTC(2026, 0, 1, 0, 0), 'Asia/Kathmandu'), '2026-01-01T05:45:00+05:45');
  assert.equal(isoInZone(Date.UTC(2026, 0, 1, 0, 0), 'UTC'), '2026-01-01T00:00:00+00:00');
  assert.equal(isoInZone(Date.UTC(2026, 0, 1, 0, 0, 0, 999), 'UTC'), '2026-01-01T00:00:00+00:00');
  assert.equal(offsetMinutes(Date.UTC(2026, 0, 1), 'Asia/Kathmandu'), 345);
});

test('instantOf: a wall-clock time in a zone, through clock changes', () => {
  const la = 'America/Los_Angeles';
  assert.equal(instantOf({ year: 2026, month: 11, day: 25, hour: 8, minute: 30 }, la), Date.UTC(2026, 10, 25, 16, 30));
  // 01:30 happens twice when the clocks go back: it is the first one, west and east of UTC.
  assert.equal(instantOf({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, la), Date.UTC(2026, 10, 1, 8, 30));
  assert.equal(instantOf({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Berlin'), Date.UTC(2026, 9, 25, 0, 30));
  // 02:30 never happens when the clocks go forward: it moves on by the gap, to 03:30.
  assert.equal(instantOf({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, la), Date.UTC(2026, 2, 8, 10, 30));
  assert.equal(instantOf({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin'), Date.UTC(2026, 2, 29, 1, 30));
  // A date alone is its midnight.
  assert.equal(instantOf({ year: 2026, month: 11, day: 26 }, la), Date.UTC(2026, 10, 26, 8, 0));
});

test('dayIn and timeIn: the local day and time of a moment, in a zone', () => {
  const at = '2026-11-25T23:30:00-08:00';
  assert.equal(dayIn(at, 'America/Los_Angeles'), '2026-11-25');
  assert.equal(timeIn(at, 'America/Los_Angeles'), '23:30');
  assert.equal(dayIn(at, 'America/New_York'), '2026-11-26');
  assert.equal(timeIn(at, 'America/New_York'), '02:30');
  assert.equal(dayIn(Date.UTC(2026, 10, 26, 7, 59), 'America/Los_Angeles'), '2026-11-25');
  assert.equal(dayIn('not a time', 'UTC'), null);
  assert.equal(timeIn('', 'UTC'), null);
});
