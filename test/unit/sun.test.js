import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes, sunChips } from '../../src/core/sun.js';

const MIN = 60_000;
/** Within two minutes of the US Naval Observatory's published time (aa.usno.navy.mil, read 2026-10-16, given to the minute). @param {number | null} got @param {string} want */
const near = (got, want) => assert.ok(got !== null && Math.abs(got - Date.parse(want)) <= 2 * MIN, `${got === null ? 'null' : new Date(got).toISOString()} is not ${want}`);

test('sunrise, sunset and civil twilight within two minutes of published times, north and south', () => {
  const bigSur = sunTimes(Date.parse('2026-11-27T12:00:00-08:00'), 36.27, -121.807);
  near(bigSur.sunrise, '2026-11-27T14:56:00Z');
  near(bigSur.sunset, '2026-11-28T00:53:00Z');
  near(bigSur.dawn, '2026-11-27T14:28:00Z');
  near(bigSur.dusk, '2026-11-28T01:21:00Z');
  assert.equal(bigSur.polar, null);
  const sf = sunTimes(Date.parse('2026-06-21T12:00:00-07:00'), 37.7749, -122.4194);
  near(sf.sunrise, '2026-06-21T12:48:00Z');
  near(sf.sunset, '2026-06-22T03:35:00Z');
  near(sf.dawn, '2026-06-21T12:17:00Z');
  near(sf.dusk, '2026-06-22T04:06:00Z');
  const sydney = sunTimes(Date.parse('2026-12-21T12:00:00+11:00'), -33.8688, 151.2093);
  near(sydney.sunrise, '2026-12-20T18:41:00Z');
  near(sydney.sunset, '2026-12-21T09:05:00Z');
  const tokyo = sunTimes(Date.parse('2026-03-20T12:00:00+09:00'), 35.6762, 139.6503);
  near(tokyo.sunrise, '2026-03-19T20:46:00Z');
  near(tokyo.sunset, '2026-03-20T08:53:00Z');
});

test('golden hour: the sun below 6° above the horizon, after sunrise and before sunset', () => {
  const t = sunTimes(Date.parse('2026-11-27T12:00:00-08:00'), 36.27, -121.807);
  const morning = /** @type {number} */ (t.goldenMorningEnd) - /** @type {number} */ (t.sunrise);
  const evening = /** @type {number} */ (t.sunset) - /** @type {number} */ (t.goldenEveningStart);
  assert.ok(morning > 30 * MIN && morning < 60 * MIN, `${morning / MIN} min`);
  assert.ok(Math.abs(morning - evening) < 3 * MIN);
});

test('polar night and midnight sun: no sunrise or sunset, and it says which', () => {
  const night = sunTimes(Date.parse('2026-12-21T12:00:00+01:00'), 69.6492, 18.9553);
  assert.equal(night.sunrise, null);
  assert.equal(night.sunset, null);
  assert.equal(night.polar, 'night');
  near(night.dawn, '2026-12-21T08:31:00Z');
  near(night.dusk, '2026-12-21T12:53:00Z');
  const day = sunTimes(Date.parse('2026-06-21T12:00:00+02:00'), 69.6492, 18.9553);
  assert.equal(day.polar, 'day');
  assert.equal(day.sunrise, null);
  assert.equal(day.dawn, null);
});

test("the Now screen's sun chips through a day, in the place's own zone (spec §11.5)", () => {
  const LA = 'America/Los_Angeles';
  const chips = (/** @type {string} */ hhmm) => sunChips(Date.parse(`2026-11-27T${hhmm}:00-08:00`), 36.27, -121.807, LA);
  assert.match(chips('05:00').join(' | '), /^Sunrise 06:5[56]$/);
  assert.match(chips('07:00').join(' | '), /^Golden hour until 07:\d\d$/);
  assert.match(chips('12:00').join(' | '), /^Golden hour 16:\d\d \| Sunset 16:5[234]$/);
  assert.match(chips('16:40').join(' | '), /^Golden hour now \| Sunset 16:5[234]$/);
  assert.match(chips('17:05').join(' | '), /^Dusk 17:2[012]$/);
  assert.match(chips('21:00').join(' | '), /^Sunrise 06:5[678]$/); // tomorrow's
  // In Tokyo, on a phone set to Los Angeles: the place's zone, not the phone's.
  assert.match(sunChips(Date.parse('2026-03-20T12:00:00+09:00'), 35.6762, 139.6503, 'Asia/Tokyo').join(' | '), /Sunset 17:5[234]$/);
  assert.deepEqual(sunChips(Date.parse('2026-06-21T12:00:00+02:00'), 69.6492, 18.9553, 'Europe/Oslo'), ['Midnight sun']);
  assert.deepEqual(sunChips(Date.parse('2026-12-21T12:00:00+01:00'), 69.6492, 18.9553, 'Europe/Oslo'), ['Polar night']);
});
