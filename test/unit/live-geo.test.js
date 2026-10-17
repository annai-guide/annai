import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meters, fixOf, keep, travelMinutes, modeFor, kmText, span, KEEP_MS } from '../../src/core/live/geo.js';
import { ActivityTracker } from '../../src/core/live/activity.js';

import { off, BIXBY, NEPENTHE } from './live-kit.js';

const T0 = Date.parse('2026-11-27T09:00:00-08:00');
/** @param {{ lat: number, lng: number }} p @param {number} s seconds after T0 @param {Partial<import('../../src/core/live/geo.js').Fix>} [o] */
const at = (p, s, o = {}) => /** @type {import('../../src/core/live/geo.js').Fix} */ ({ ...p, accuracy: 8, at: T0 + s * 1000, speed: null, heading: null, source: 'gps', ...o });

test('meters between two points', () => {
  assert.equal(meters(BIXBY, BIXBY), 0);
  assert.equal(Math.round(meters(BIXBY, NEPENTHE) / 10), 2116);
  assert.ok(Math.abs(meters(BIXBY, off(BIXBY, 0, 100)) - 100) < 0.5);
  assert.ok(Math.abs(meters(BIXBY, off(BIXBY, 100, 0)) - 100) < 0.5);
});

test("a sensor's position becomes a fix; anything else is nothing", () => {
  assert.deepEqual(fixOf({ lat: 36.37, lng: -121.9, accuracy: 12, speed: 14.2, heading: 170 }, T0), { lat: 36.37, lng: -121.9, accuracy: 12, at: T0, speed: 14.2, heading: 170, source: 'gps' });
  assert.deepEqual(fixOf({ lat: 36.37, lng: -121.9, at: T0 - 5000, source: 'manual' }, T0), { lat: 36.37, lng: -121.9, accuracy: 50, at: T0 - 5000, speed: null, heading: null, source: 'manual' });
  assert.equal(fixOf({ lat: 36.37, lng: -121.9, speed: NaN }, T0)?.speed, null);
  assert.equal(fixOf({ lat: 36.37, lng: -121.9, speed: -1 }, T0)?.speed, null);
  for (const bad of [null, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: '36', lng: -121 }, { lat: NaN, lng: 0 }]) assert.equal(fixOf(bad, T0), null);
});

test('kept points (spec §4.5): after about 20 m, or the accuracy if worse, or a minute while moving', () => {
  const a = at(BIXBY, 0);
  assert.equal(keep(null, a, false), true);
  assert.equal(keep(a, at(off(BIXBY, 15, 0), 5), true), false);
  assert.equal(keep(a, at(off(BIXBY, 21, 0), 5), false), true);
  assert.equal(keep(a, at(off(BIXBY, 30, 0), 5, { accuracy: 40 }), false), false); // within what the GPS can tell
  assert.equal(keep(a, at(off(BIXBY, 45, 0), 5, { accuracy: 40 }), false), true);
  assert.equal(keep(a, at(off(BIXBY, 5, 0), KEEP_MS / 1000), true), true); // a minute while moving
  assert.equal(keep(a, at(off(BIXBY, 5, 0), KEEP_MS / 1000), false), false); // standing still: no
});

test('the rough travel estimate (spec §11.3) errs early', () => {
  assert.equal(travelMinutes(7.05, 'drive'), 12); // River Inn to Nepenthe: 7.05 km × 1.4 ÷ 50 km/h
  assert.equal(travelMinutes(1, 'walk'), 18); // 1 km × 1.3 ÷ 4.5 km/h
  assert.equal(modeFor(1.5, 'walking'), 'walk');
  assert.equal(modeFor(1.5, 'moving-fast'), 'drive');
  assert.equal(modeFor(2.5, 'still'), 'drive');
  assert.equal(kmText(850.4), '850 m');
  assert.equal(kmText(12_340), '12.3 km');
  assert.equal(span(42 * 60_000), '42 min');
  assert.equal(span(125 * 60_000), '2 h 5 min');
  assert.equal(span(30_000), 'less than a minute');
});

test('activity: moving fast after 30 s of GPS speed; a red light of 40 s stays moving fast; 70 s still is still', () => {
  const t = new ActivityTracker();
  /** @type {any[]} */
  const changes = [];
  let p = BIXBY;
  for (let s = 0; s <= 40; s += 5) {
    p = off(p, 0, -100);
    const c = t.feed(at(p, s, { speed: 20 }));
    if (c) changes.push([s, c.from, c.to]);
  }
  assert.deepEqual(changes, [[30, 'unknown', 'moving-fast']]);
  assert.equal(t.activity, 'moving-fast');
  for (let s = 45; s <= 85; s += 5) assert.equal(t.feed(at(p, s, { speed: 0 })), null); // stopped 40 s
  for (let s = 90; s <= 100; s += 5) t.feed(at((p = off(p, 0, -100)), s, { speed: 20 }));
  assert.equal(t.activity, 'moving-fast');
  for (let s = 105; s <= 175; s += 5) {
    const c = t.feed(at(p, s, { speed: 0 }));
    if (c) changes.push([s, c.from, c.to]);
  }
  assert.deepEqual(changes.at(-1), [165, 'moving-fast', 'still']); // 60 s after the stop began at 105
});

test('activity without GPS speed: from positions; parked GPS jitter is still, never walking', () => {
  const walk = new ActivityTracker();
  let p = BIXBY;
  for (let s = 0; s <= 60; s += 5) walk.feed(at((p = off(p, 7, 0)), s)); // 1.4 m/s
  assert.equal(walk.activity, 'walking');
  const parked = new ActivityTracker();
  for (let s = 0; s <= 300; s += 5) {
    // wandering up to 10 m around the car with 20 m accuracy
    const seen = parked.feed(at(off(BIXBY, Math.sin(s * 7.3) * 10, Math.cos(s * 3.1) * 10), s, { accuracy: 20 }));
    assert.notEqual(seen?.to, 'walking');
    assert.notEqual(seen?.to, 'moving-fast');
  }
  assert.equal(parked.activity, 'still');
  const drive = new ActivityTracker();
  p = BIXBY;
  for (let s = 0; s <= 60; s += 5) drive.feed(at((p = off(p, 0, -125)), s)); // 25 m/s
  assert.equal(drive.activity, 'moving-fast');
  assert.ok(Math.abs(/** @type {number} */ (drive.speed) - 25) < 2);
});

test('activity: between walking and moving fast, nothing changes; reset forgets', () => {
  const t = new ActivityTracker();
  let p = BIXBY;
  for (let s = 0; s <= 20; s += 5) t.feed(at((p = off(p, 0, -100)), s, { speed: 20 }));
  for (let s = 25; s <= 30; s += 5) t.feed(at((p = off(p, 0, -20)), s, { speed: 4 })); // 4 m/s: neither
  t.feed(at((p = off(p, 0, -100)), 35, { speed: 20 }));
  assert.equal(t.activity, 'moving-fast'); // the 30 s since 0 still counted
  t.reset();
  assert.equal(t.activity, 'unknown');
  assert.equal(t.speed, null);
});
