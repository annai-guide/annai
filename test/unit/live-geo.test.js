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

test('parked with 30 m of GPS wander, no GPS speed, accuracy 20 to 65 m: still for half an hour; a slow walk is still walking (Review Focus 1)', () => {
  for (const accuracy of [20, 40, 65]) {
    const t = new ActivityTracker();
    for (let s = 0; s <= 1800; s += 5) {
      const seen = t.feed(at(off(NEPENTHE, Math.sin(s * 7.3) * 30, Math.cos(s * 3.1) * 30), s, { accuracy }));
      assert.ok(seen?.to !== 'walking' && seen?.to !== 'moving-fast', `accuracy ${accuracy}, at ${s} s: ${seen?.to}`);
    }
    assert.equal(t.activity, 'still', `accuracy ${accuracy}`);
  }
  for (const accuracy of [8, 15]) {
    const walk = new ActivityTracker();
    let p = BIXBY;
    for (let s = 0; s <= 120; s += 5) walk.feed(at((p = off(p, 6, 0)), s, { accuracy })); // 1.2 m/s
    assert.equal(walk.activity, 'walking', `accuracy ${accuracy}`);
  }
});

test('activity asked without a fix: a held change completes on time; a quiet GPS after a slow speed is still, after a fast one stays moving fast; a restarted GPS counts afresh', () => {
  const t = new ActivityTracker();
  let p = BIXBY;
  for (let s = 0; s <= 60; s += 5) t.feed(at((p = off(p, 0, -70)), s, { speed: 14 }));
  assert.equal(t.activity, 'moving-fast');
  assert.equal(t.due(), null, 'moving fast, nothing pending: no gap rule');
  assert.equal(t.tick(T0 + 240_000), null, 'a tunnel stays moving fast');
  for (const [s, speed] of [[245, 0.8], [265, 1.3], [290, 1.5]]) assert.equal(t.feed(at(p, s, { speed })), null);
  assert.equal(t.due(), T0 + 305_000);
  assert.equal(t.tick(T0 + 304_000), null);
  assert.deepEqual(t.tick(T0 + 305_000), { from: 'moving-fast', to: 'walking', at: T0 + 305_000 });
  assert.equal(t.due(), T0 + 410_000, 'two minutes after the last fix');
  assert.equal(t.tick(T0 + 409_000), null);
  assert.deepEqual(t.tick(T0 + 410_000), { from: 'walking', to: 'still', at: T0 + 410_000 });
  assert.equal(t.due(), null);
  const u = new ActivityTracker();
  for (let s = 0; s <= 40; s += 5) u.feed(at(BIXBY, s, { speed: 1.2 }));
  assert.equal(u.activity, 'walking');
  u.heard(T0 + 600_000); // annai came back on screen after ten minutes
  assert.equal(u.tick(T0 + 600_000), null);
  assert.equal(u.due(), T0 + 720_000);
});

test('a last speed of 3 to 5 m/s while moving fast (slow traffic before a tunnel) stays moving fast through a gap; below 3 it reads still', () => {
  const t = new ActivityTracker();
  let p = BIXBY;
  for (let s = 0; s <= 60; s += 5) t.feed(at((p = off(p, 0, -70)), s, { speed: 14 }));
  for (let s = 65; s <= 90; s += 5) t.feed(at((p = off(p, 0, -20)), s, { speed: 4 }));
  assert.equal(t.activity, 'moving-fast');
  assert.equal(t.tick(T0 + 90_000 + 600_000), null, 'ten minutes with no fix after a 4 m/s: still moving fast');
  assert.equal(t.activity, 'moving-fast');
  const u = new ActivityTracker();
  for (let s = 0; s <= 60; s += 5) u.feed(at((p = off(p, 0, -70)), s, { speed: 14 }));
  u.feed(at(p, 65, { speed: 2.5 }));
  assert.deepEqual(u.tick(T0 + 65_000 + 120_000)?.to, 'still');
});

/** A drive at 14 m/s up to T0, then the second drive's points after it (seconds after T0; speed; accuracy). */
const PARKING = /** @type {const} */ ([[0, 8.6, 8], [62, 3.2, 8], [136, 0.8, 8], [233, null, 13], [294, 0.3, 8], [354, null, 8]]);
/** @returns {ActivityTracker} moving fast, up to just before T0 */
function driving() {
  const t = new ActivityTracker();
  let p = BIXBY;
  for (let s = -60; s < 0; s += 5) t.feed(at((p = off(p, 0, -70)), s, { speed: 14 }));
  assert.equal(t.activity, 'moving-fast');
  return t;
}

test('parking on sparse fixes, each fix judged by itself (second drive): a fix with no speed still counts, and the gap before it is a span to read a speed over', () => {
  const t = driving();
  /** @type {Record<number, string>} */
  const was = {};
  for (const [s, speed, accuracy] of PARKING) {
    t.feed(at(BIXBY, s, { speed, accuracy }));
    was[s] = t.activity;
  }
  assert.equal(was[136], 'moving-fast', 'the first slow speed only starts the hold');
  assert.equal(was[233], 'still', '97 s after that slow speed, and no way travelled');
});

test('parking with the speed jumping between still and walking (second drive): moving fast ends within two minutes, whichever slow speed each fix says', () => {
  // The points the trace keeps are a minute apart while moving; the fixes between them aren't kept. Speeds at a stop wander across 0.5 m/s.
  // A no-speed fix reads the last 60 s of way, so the drive itself can still say moving fast for a minute; then the hold of a minute runs.
  for (const every of [1, 5, 15]) {
    const t = driving();
    /** @type {any[]} */
    const speeds = [0.8, null, 0.3, 1.1];
    let ended = null;
    for (let s = 0, i = 0; s <= 300 && ended === null; s += every, i++) {
      t.feed(at(BIXBY, s, { speed: speeds[i % speeds.length] }));
      if (t.activity !== 'moving-fast') ended = s;
    }
    assert.ok(ended !== null && ended <= 120 + every, `every ${every} s: moving fast ended at ${ended}`);
  }
});

test('a red light with the speed jumping about, then driving on, stays moving fast; a fast speed starts the minute again', () => {
  const t = driving();
  /** @type {any[]} */
  const speeds = [0.8, null, 0.3, 1.1];
  let p = BIXBY;
  for (let s = 0, i = 0; s <= 50; s += 5, i++) assert.equal(t.feed(at(p, s, { speed: speeds[i % 4] })), null);
  t.feed(at((p = off(p, 0, -70)), 55, { speed: 14 }));
  for (let s = 60, i = 0; s <= 115; s += 5, i++) assert.equal(t.feed(at(p, s, { speed: speeds[i % 4] })), null, `at ${s} s`);
  assert.equal(t.activity, 'moving-fast');
  assert.equal(t.due(), T0 + 120_000);
});

test('a span over a gap: a no-speed fix after a tunnel reads the way travelled; time off screen is no span', () => {
  const t = driving();
  const far = off(BIXBY, 0, -3000);
  t.feed(at(BIXBY, 0, { speed: 14 }));
  t.feed(at(far, 200)); // 15 m/s since the tunnel began
  assert.ok(Math.abs(/** @type {number} */ (t.speed) - 15) < 1);
  const u = driving();
  u.feed(at(BIXBY, 0, { speed: 14 }));
  u.heard(T0 + 200_000);
  u.feed(at(far, 200));
  assert.equal(u.speed, 14, 'off screen: the way travelled says nothing of the speed now');
});

test('still after a quiet GPS stays still at every later look, until a new fix says otherwise', () => {
  const t = new ActivityTracker();
  for (let s = 0; s <= 40; s += 5) t.feed(at(BIXBY, s, { speed: 1.2 }));
  assert.equal(t.activity, 'walking');
  assert.equal(t.tick(T0 + 160_000)?.to, 'still');
  for (let s = 220; s <= 1200; s += 60) assert.equal(t.tick(T0 + s * 1000), null, `at ${s} s`);
  assert.equal(t.activity, 'still');
  t.feed(at(off(BIXBY, 0, 40), 1205, { speed: 1.2 }));
  t.feed(at(off(BIXBY, 0, 80), 1240, { speed: 1.2 }));
  assert.equal(t.activity, 'walking');
});
