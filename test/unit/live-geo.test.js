import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meters, fixOf, keep, travelMinutes, modeFor, kmText, span, KEEP_MS } from '../../src/core/live/geo.js';
import { ActivityTracker, QUIET_STILL_MS, NO_FIX_BACK_MS } from '../../src/core/live/activity.js';

import { off, BIXBY, NEPENTHE } from './live-kit.js';

const T0 = Date.parse('2026-11-27T09:00:00-08:00');
/** @param {{ lat: number, lng: number }} p @param {number} s seconds after T0 @param {Partial<import('../../src/core/live/geo.js').Fix>} [o] */
const at = (p, s, o = {}) => /** @type {import('../../src/core/live/geo.js').Fix} */ ({ ...p, accuracy: 8, at: T0 + s * 1000, speed: null, heading: null, source: 'gps', ...o });

/** A change without what it rested on. @param {import('../../src/core/live/activity.js').Change | null} c */
const bare = (c) => (c ? { from: c.from, to: c.to, at: c.at } : c);

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
  assert.equal(t.due(), T0 + 60_000 + 15 * 60_000, 'moving fast, nothing pending: only the gap with no fix at all (a tunnel is shorter)');
  assert.equal(t.tick(T0 + 240_000), null, 'a tunnel stays moving fast');
  for (const [s, speed] of [[245, 0.8], [265, 1.3], [290, 1.5]]) assert.equal(t.feed(at(p, s, { speed })), null);
  assert.equal(t.due(), T0 + 305_000);
  assert.equal(t.tick(T0 + 304_000), null);
  assert.deepEqual(bare(t.tick(T0 + 305_000)), { from: 'moving-fast', to: 'walking', at: T0 + 305_000 });
  assert.equal(t.due(), T0 + 410_000, 'two minutes after the last fix');
  assert.equal(t.tick(T0 + 409_000), null);
  assert.deepEqual(bare(t.tick(T0 + 410_000)), { from: 'walking', to: 'still', at: T0 + 410_000 });
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
  assert.equal(u.speed, null, 'off screen: the way travelled says nothing of the speed now');
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

test('off screen and back every 50 s while parked: the hold of moving fast goes on from the last fast fix, and ends on the first fix after a minute', () => {
  const t = driving();
  t.feed(at(BIXBY, 0, { speed: 0.8 }));
  let ended = null;
  // The phone is locked 10 s after each fix and unlocked 40 s later; its first fix comes 5 s after that.
  for (let s = 10; s <= 400 && ended === null; s += 50) {
    t.heard(T0 + (s + 40) * 1000);
    t.feed(at(BIXBY, s + 45, { speed: s % 100 === 10 ? 0.3 : 0.8 }));
    if (t.activity !== 'moving-fast') ended = s + 45;
  }
  assert.ok(ended !== null && ended <= 110, `moving fast ended at ${ended}`); // the first fix a minute after the first slow speed
  // Unlocked where the phone locked, with the screen off since: the first fix back that says slow ends it, a fast one keeps it.
  const u = driving();
  u.feed(at(BIXBY, 0, { speed: 14 }));
  u.heard(T0 + 300_000);
  u.feed(at(BIXBY, 305, { speed: 14 }));
  assert.equal(u.activity, 'moving-fast');
  u.heard(T0 + 600_000);
  assert.equal(u.feed(at(BIXBY, 605, { speed: 0 }))?.to, 'still');
});

test('leaving moving fast goes to still when any speed in the hold said still, else to what the last speed said', () => {
  // A phone parked in a city: the speeds wander about walking pace, now and then under 0.5 m/s.
  const t = driving();
  const speeds = [0.8, 0.3, 0.9, 1.1, 0.4, 0.9];
  let to = null;
  for (let s = 0, i = 0; s <= 70 && to === null; s += 10, i++) to = t.feed(at(BIXBY, s, { speed: speeds[i % speeds.length] }))?.to ?? null;
  assert.equal(to, 'still');
  for (let s = 80; s <= 400; s += 10) assert.notEqual(t.feed(at(BIXBY, s, { speed: speeds[(s / 10) % speeds.length] }))?.to, 'walking', `at ${s} s`);
  assert.equal(t.activity, 'still');
  // Slow and never still: a walk from the car.
  const w = driving();
  let walked = null;
  for (let s = 0; s <= 70 && walked === null; s += 10) walked = w.feed(at(off(BIXBY, 0, s * 1.2), s, { speed: 1.2 }))?.to ?? null;
  assert.equal(walked, 'walking');
});

test('no fix for 15 minutes is still, whatever the last speed was; a tunnel shorter than that stays', () => {
  const GAP = 15 * 60_000;
  const slow = driving();
  slow.feed(at(BIXBY, 0, { speed: 3.5 })); // into a garage
  assert.equal(slow.due(), T0 + GAP);
  assert.equal(slow.tick(T0 + GAP - 1), null);
  assert.deepEqual(bare(slow.tick(T0 + GAP)), { from: 'moving-fast', to: 'still', at: T0 + GAP });
  assert.equal(slow.due(), null);
  const glitch = new ActivityTracker();
  for (let s = 0; s <= 20; s += 5) glitch.feed(at(BIXBY, s, { speed: 0 }));
  glitch.feed(at(BIXBY, 25, { speed: 6 })); // a lone glitch, and then nothing
  glitch.tick(T0 + 60_000);
  assert.equal(glitch.activity, 'moving-fast');
  assert.equal(glitch.tick(T0 + 25_000 + GAP)?.to, 'still');
  const unlocked = driving();
  unlocked.feed(at(BIXBY, 0, { speed: 14 }));
  unlocked.heard(T0 + 3_600_000); // an hour off screen, and no fix since: no speed to say it is moving
  assert.equal(unlocked.due(), T0 + 3_600_000 + NO_FIX_BACK_MS);
  assert.equal(unlocked.tick(T0 + 3_600_000 + NO_FIX_BACK_MS)?.to, 'still');
});

test('after a gap the last speed says nothing: a no-speed first fix back decides nothing', () => {
  const t = new ActivityTracker();
  for (let s = 0; s <= 40; s += 5) t.feed(at(BIXBY, s, { speed: 1.2 }));
  assert.equal(t.tick(T0 + 160_000)?.to, 'still');
  t.heard(T0 + 600_000); // unlocked
  assert.equal(t.feed(at(BIXBY, 601)), null); // no speed, nothing to compare it with
  assert.equal(t.tick(T0 + 640_000), null, 'thirty seconds on');
  assert.equal(t.due(), null);
  assert.equal(t.activity, 'still');
});

test('a hold is kept only for the activity the speeds say: another one starts it again', () => {
  const t = new ActivityTracker();
  for (let s = 0; s <= 40; s += 5) t.feed(at(BIXBY, s, { speed: 0 }));
  assert.equal(t.activity, 'still');
  t.feed(at(BIXBY, 100, { speed: 0.6 })); // walking, for one reading
  assert.equal(t.feed(at(BIXBY, 125, { speed: 5.2 })), null);
  assert.equal(t.tick(T0 + 130_000), null, 'five seconds of fast speed are not a hold of thirty');
  assert.equal(t.activity, 'still');
  assert.equal(t.tick(T0 + 155_000)?.to, 'moving-fast', 'thirty seconds after the first fast speed');
});

test('what the last change rested on: readings since the one before, the hold, the gap and the unlocks', () => {
  const t = driving();
  t.feed(at(BIXBY, 0, { speed: 0.8 })); // walking: the hold begins
  t.heard(T0 + 5000);
  t.feed(at(BIXBY, 10)); // nothing to read a speed from yet
  t.feed(at(BIXBY, 20, { speed: 0 }));
  t.feed(at(BIXBY, 40, { speed: 4 }));
  assert.equal(t.activity, 'moving-fast');
  const c = t.feed(at(BIXBY, 62, { speed: 0.3 }));
  assert.equal(t.activity, 'still');
  assert.deepEqual(c?.why, { heldS: 62, gapS: 22, readings: { still: 2, walking: 1, between: 1, fast: 5, none: 1 }, heards: 1 }); // fast: the drive's last fixes, since it began
  t.feed(at(BIXBY, 70, { speed: 0 }));
  assert.equal(c?.why.readings.still, 2, 'the counts stay with the change they explain');
});

test('after an unlock or a reload one fix without a speed and then silence ends moving fast in 2 min, not 15 (fix pass 2)', () => {
  const t = driving();
  t.feed(at(BIXBY, 0, { speed: 14 }));
  t.heard(T0 + 600_000);
  assert.equal(t.speed, null, 'the speed before the gap says nothing of now');
  t.feed(at(BIXBY, 601)); // no speed, nothing to compare it with
  assert.equal(t.due(), T0 + 601_000 + 120_000);
  assert.equal(t.tick(T0 + 601_000 + 119_000), null);
  assert.equal(t.tick(T0 + 601_000 + 120_000)?.to, 'still');
  // A fast speed after the gap keeps a tunnel's moving fast as before.
  const u = driving();
  u.heard(T0 + 600_000);
  u.feed(at(BIXBY, 601, { speed: 14 }));
  assert.equal(u.tick(T0 + 601_000 + 600_000), null);
});

test('the way since the last fix says the drive went on: a slow first fix back starts the hold; a short way leaves it dating from the last fix (fix pass 3)', () => {
  const t = driving();
  t.feed(at(BIXBY, 0, { speed: 14 }));
  t.heard(T0 + 180_000);
  const light = off(BIXBY, 0, -2500); // 14 m/s for three minutes
  assert.equal(t.feed(at(light, 185, { speed: 0 })), null);
  assert.equal(t.feed(at(light, 240, { speed: 0 })), null);
  assert.equal(t.feed(at(light, 246, { speed: 0 }))?.at, T0 + 185_000 + 60_000);
  // A coarse first fix can't say it did not go on: the first good one can.
  const c = driving();
  c.feed(at(BIXBY, 0, { speed: 14 }));
  c.heard(T0 + 180_000);
  assert.equal(c.feed(at(BIXBY, 185, { accuracy: 3000 })), null);
  assert.equal(c.feed(at(light, 200, { speed: 0 })), null);
  assert.equal(c.activity, 'moving-fast');
  // Two locks before a fix: the way counts from the last fix of all.
  const d = driving();
  d.feed(at(BIXBY, 0, { speed: 14 }));
  d.heard(T0 + 100_000);
  d.heard(T0 + 170_000);
  assert.equal(d.feed(at(light, 185, { speed: 0 })), null);
  // No fix since the unlock: it holds to the bound, and ends there.
  const n = driving();
  n.feed(at(BIXBY, 0, { speed: 14 }));
  n.heard(T0 + 180_000);
  assert.equal(n.tick(T0 + 300_000), null);
  assert.equal(n.tick(T0 + 180_000 + NO_FIX_BACK_MS)?.at, T0 + 180_000 + NO_FIX_BACK_MS);
  // Between fixes on screen nothing is different: the hold of a stop goes on over an unlock whose way is short.
  const s = driving();
  s.feed(at(BIXBY, 0, { speed: 0.2 }));
  s.heard(T0 + 50_000);
  assert.equal(s.feed(at(BIXBY, 65, { speed: 0.2 }))?.at, T0 + 60_000);
});

test('moving fast is said to have ended when its hold ran out, not when the page found out (fix pass 2)', () => {
  const t = driving();
  t.feed(at(BIXBY, 0, { speed: 14 }));
  t.feed(at(BIXBY, 10, { speed: 0.2 })); // parked: the hold begins
  t.heard(T0 + 40 * 60_000); // locked for 40 minutes, then unlocked
  const c = t.feed(at(BIXBY, 40 * 60 + 5, { speed: 0.1 }));
  assert.equal(c?.to, 'still');
  assert.equal(c?.at, T0 + 10_000 + 60_000, 'a minute after the first slow speed');
  assert.deepEqual(Object.keys(c?.why ?? {}).sort(), ['gapS', 'heards', 'heldS', 'readings']);
  assert.equal(/** @type {any} */ (t).why, undefined, 'what it rested on goes with the change');
});

test('moving fast across an unlock or a reload, and no reading since that can say: it holds to the bound, then ends there; a good fix decides sooner (one false "stops", 2026-11-05)', () => {
  const t = driving();
  t.feed(at(BIXBY, 0, { speed: 14 }));
  t.heard(T0 + 180_000);
  assert.equal(t.due(), T0 + 180_000 + NO_FIX_BACK_MS);
  assert.ok(NO_FIX_BACK_MS > 300_000, 'a five-minute gap and the fix after it are not cut');
  assert.equal(t.tick(T0 + 180_000 + NO_FIX_BACK_MS - 1), null);
  const c = t.tick(T0 + 180_000 + NO_FIX_BACK_MS);
  assert.deepEqual(bare(c), { from: 'moving-fast', to: 'still', at: T0 + 180_000 + NO_FIX_BACK_MS });
  assert.equal(c?.noFix, true);

  const place = at(BIXBY, -60);
  const r = new ActivityTracker();
  r.restore('moving-fast', T0, { from: place });
  assert.equal(r.due(), T0 + NO_FIX_BACK_MS);
  assert.equal(r.tick(T0 + 120_000), null);
  assert.deepEqual(bare(r.tick(T0 + NO_FIX_BACK_MS)), { from: 'moving-fast', to: 'still', at: T0 + NO_FIX_BACK_MS });

  // A second unlock goes on from there: only time on screen counts, so the bound moves by the time off screen and no more.
  const u = driving();
  u.feed(at(BIXBY, 0, { speed: 14 }));
  u.heard(T0 + 180_000, T0 + 60_000);
  u.heard(T0 + 400_000, T0 + 300_000); // 120 s on screen, 100 s off
  assert.equal(u.due(), T0 + 280_000 + NO_FIX_BACK_MS);
  assert.equal(u.tick(T0 + 280_000 + NO_FIX_BACK_MS - 1), null);
  assert.equal(u.tick(T0 + 280_000 + NO_FIX_BACK_MS)?.to, 'still');

  // Only moving fast holds: any other activity reads quiet as before.
  const w = new ActivityTracker();
  w.restore('walking', T0, { from: place });
  assert.equal(w.due(), T0 + QUIET_STILL_MS);
  assert.equal(w.tick(T0 + QUIET_STILL_MS)?.to, 'still');

  // A coarse fix is no decision and moves no bound; two like it read nothing from each other.
  const v = driving();
  v.heard(T0 + 10_000);
  assert.equal(v.feed(at(BIXBY, 20, { accuracy: 3000 })), null);
  assert.equal(v.feed(at(BIXBY, 40, { accuracy: 3000 })), null);
  assert.equal(v.activity, 'moving-fast');
  assert.equal(v.due(), T0 + 10_000 + NO_FIX_BACK_MS);

  // A good fix ends the wait: from there on, the rules of a fix (no speed: quiet for two minutes).
  const g = driving();
  g.heard(T0 + 10_000);
  g.feed(at(off(BIXBY, 0, -840), 20)); // where it stopped
  assert.equal(g.due(), T0 + 20_000 + QUIET_STILL_MS);
  g.reset();
  assert.equal(g.due(), null);

  // A good fix with no speed whose way says the drive went on: on to the same bound. One whose way is slow ends the wait.
  const f = driving();
  f.feed(at(BIXBY, 0, { speed: 14 }));
  f.heard(T0 + 180_000, T0 + 60_000);
  f.feed(at(off(BIXBY, 0, -840), 185));
  assert.equal(f.due(), T0 + 185_000 + QUIET_STILL_MS, 'the way is short');
  const o = driving();
  o.feed(at(BIXBY, 0, { speed: 14 }));
  o.heard(T0 + 180_000, T0 + 60_000);
  o.feed(at(NEPENTHE, 185));
  assert.equal(o.due(), T0 + 180_000 + NO_FIX_BACK_MS);
  assert.equal(o.tick(T0 + 180_000 + NO_FIX_BACK_MS)?.at, T0 + 180_000 + NO_FIX_BACK_MS);
});
