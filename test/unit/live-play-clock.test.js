import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock, PlayClock } from '../../src/core/live/clock.js';

test('a play clock runs at its speed, pauses, moves, and changes speed; its timers follow (spec §13, §18)', async () => {
  const base = new ManualClock(0);
  const c = new PlayClock(1_000_000, { speed: 10, base });
  /** @type {string[]} */
  const ran = [];
  c.set(() => ran.push('a'), 60_000); // a minute of its time: 6 s of the base's at 10×
  await base.advanceTo(3000);
  assert.equal(c.now(), 1_030_000);
  c.pause();
  await base.advanceTo(60_000);
  assert.equal(c.now(), 1_030_000);
  assert.deepEqual(ran, []); // paused: the timer waits
  c.speed = 60;
  c.play();
  await base.advanceTo(60_499);
  assert.deepEqual(ran, []);
  await base.advanceTo(60_500); // the 30 s left, at 60×
  assert.deepEqual(ran, ['a']);
  c.set(() => ran.push('b'), 3_600_000);
  c.seek(2_000_000_000);
  await base.advanceTo(60_501); // moved past it: it runs at once
  assert.deepEqual(ran, ['a', 'b']);
  const gone = c.set(() => ran.push('x'), 1000);
  c.clear(gone);
  await base.advanceTo(70_000);
  assert.deepEqual(ran, ['a', 'b']);
});

test('a play clock tells who listens when it plays, pauses, moves or changes speed', () => {
  const c = new PlayClock(0, { base: new ManualClock(0), playing: false });
  let n = 0;
  const off = c.onChange(() => n++);
  c.play();
  c.speed = 600;
  c.seek(5);
  c.pause();
  off();
  c.play();
  assert.equal(n, 4);
  assert.equal(c.playing, true);
  assert.equal(c.speed, 600);
});
