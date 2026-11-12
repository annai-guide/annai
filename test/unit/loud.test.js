// Where her sound's last loud frame ends (src/core/koe/loud.js): 20 ms frames of each chunk, loud at -40 dBFS rms or above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newLoud, pushLoud, loudMs, LOUD_DBFS } from '../../src/core/koe/loud.js';

const RATE = 24_000;
/** A square wave of this level (its rms is its amplitude), ms long. @param {number} ms @param {number} dbfs */
const level = (ms, dbfs) => new Int16Array(Math.round((RATE * ms) / 1000)).fill(Math.round(10 ** (dbfs / 20) * 0x8000));
/** @param {...Int16Array} parts */
const join = (...parts) => Int16Array.from(parts.flatMap((p) => [...p]));

test('-40 dBFS is the level', () => {
  assert.equal(LOUD_DBFS, -40);
});

test('the end is the end of the last loud frame: a quiet tail after it is not counted', () => {
  const l = newLoud();
  pushLoud(l, join(level(1000, -18), level(300, -60)), RATE);
  assert.equal(loudMs(l, RATE), 1000);
  assert.equal(l.samples, 31_200);
});

test('a frame at -40 dBFS is loud, one just under it is not', () => {
  const on = newLoud();
  pushLoud(on, join(level(100, -18), level(20, -40)), RATE);
  assert.equal(loudMs(on, RATE), 120);
  const under = newLoud();
  pushLoud(under, join(level(100, -18), level(20, -40.5)), RATE);
  assert.equal(loudMs(under, RATE), 100);
});

test('chunks of one sound end where the whole sound would, when each is a whole number of frames', () => {
  const sound = join(level(500, -18), level(200, -45), level(100, -30), level(400, -60));
  const whole = newLoud();
  pushLoud(whole, sound, RATE);
  const parts = newLoud();
  for (let at = 0; at < sound.length; at += 4800) pushLoud(parts, sound.subarray(at, at + 4800), RATE);
  assert.equal(loudMs(parts, RATE), loudMs(whole, RATE));
  assert.equal(loudMs(whole, RATE), 800);
});

test('a short last frame in a chunk is judged on its own samples, and counts from its end', () => {
  const l = newLoud();
  pushLoud(l, join(level(40, -18), level(5, -18)), RATE); // 40 ms, then 5 ms of one chunk
  assert.equal(loudMs(l, RATE), 45);
  pushLoud(l, level(7, -70), RATE);
  assert.equal(loudMs(l, RATE), 45);
  assert.equal(l.samples, 1080 + 168);
});

test('nothing loud yet: the end is 0', () => {
  const l = newLoud();
  pushLoud(l, level(500, -60), RATE);
  assert.equal(loudMs(l, RATE), 0);
  assert.equal(loudMs(newLoud(), RATE), 0);
});

test('an empty chunk changes nothing', () => {
  const l = newLoud();
  pushLoud(l, level(100, -18), RATE);
  pushLoud(l, new Int16Array(0), RATE);
  assert.deepEqual(l, { samples: 2400, end: 2400 });
});
