import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseOf } from '../../src/core/timeline.js';
import { dayIn, nextDay } from '../../src/core/time.js';

const noon = Date.parse('2026-11-27T12:00:00-08:00'), LA = 'America/Los_Angeles';

test('phaseOf by dates in the zone', () => {
  assert.equal(phaseOf({}, noon, LA), 'undated');
  assert.equal(phaseOf(null, noon, LA), 'undated');
  assert.equal(phaseOf({ end: '2026-11-27' }, noon, LA), 'undated');
  assert.equal(phaseOf({ start: '2026-11-28' }, noon, LA), 'future');
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, noon, LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-25', end: '2026-11-26' }, noon, LA), 'past');
  assert.equal(phaseOf({ start: '2026-11-27' }, noon, LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-26' }, noon, LA), 'past');
});

test('the last evening of a trip is still the trip, by the zone given', () => {
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, Date.parse('2026-11-28T07:00:00Z'), LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, Date.parse('2026-11-28T07:00:00Z'), 'Asia/Tokyo'), 'past');
});

test('nextDay is the next midnight, through a day with no midnight', () => {
  assert.equal(nextDay(noon, LA), Date.parse('2026-11-28T00:00:00-08:00'));
  const t = nextDay(Date.parse('2026-03-07T12:00:00-05:00'), 'America/Havana');
  assert.ok(t > Date.parse('2026-03-07T12:00:00-05:00'));
  assert.equal(dayIn(t, 'America/Havana'), '2026-03-08');
});

test('nextDay crosses a month and a year, and from the last second of a day is the next second', () => {
  assert.equal(nextDay(Date.parse('2026-12-31T23:59:59Z'), 'UTC'), Date.parse('2027-01-01T00:00:00Z'));
});
