import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyToStart, estimateSeconds } from '../../src/core/voice/stream-start.js';

// When a streamed voice may start (G3, "Never stutters"): once the rest of the clip, at the rate it's arriving, will be in
// before playback reaches it. Its length is estimated from the words, at 15 characters a second, with a fifth more to spare.

test('a sentence is estimated at 15 characters a second; kana, Chinese characters and Hangul at 7, as those languages are spoken (fix pass)', () => {
  assert.equal(estimateSeconds('x'.repeat(60)), 4);
  assert.equal(estimateSeconds(''), 0);
  // 23 characters of Japanese, about 3 s aloud: at 15 a second it would be 1.5 s, half of it.
  const ja = '京都行きの電車は九時十五分に四番線から出ます。';
  assert.equal(ja.length, 23);
  assert.ok(Math.abs(estimateSeconds(ja) - 22 / 7 - 1 / 15) < 1e-9, `${estimateSeconds(ja)}: 22 at 7 a second, the full stop at 15`);
  assert.ok(Math.abs(estimateSeconds('서울역 다음') - (5 / 7 + 1 / 15)) < 1e-9, 'Hangul, and the space');
  assert.ok(Math.abs(estimateSeconds('Kyoto 京都') - (6 / 15 + 2 / 7)) < 1e-9, 'mixed');
});

test('readyToStart: all in, it starts; nothing yet, it waits', () => {
  assert.equal(readyToStart({ bufferedS: 0.1, receivedS: 0, elapsedS: 0, estimatedS: 10, ended: true }), true, 'the whole clip is here');
  assert.equal(readyToStart({ bufferedS: 0, receivedS: 0, elapsedS: 0.5, estimatedS: 10, ended: false }), false, 'nothing received');
  assert.equal(readyToStart({ bufferedS: 0.1, receivedS: 0, elapsedS: 0, estimatedS: 10, ended: false }), false, 'one piece: no rate yet');
});

test('readyToStart: arriving faster than it plays, measured over a quarter second, a cushion of 0.3 s is enough', () => {
  assert.equal(readyToStart({ bufferedS: 0.3, receivedS: 0.3, elapsedS: 0.25, estimatedS: 10, ended: false }), true, '1.2 times real time');
  assert.equal(readyToStart({ bufferedS: 0.28, receivedS: 0.28, elapsedS: 0.25, estimatedS: 10, ended: false }), false, 'under the cushion');
  assert.equal(readyToStart({ bufferedS: 0.5, receivedS: 0.5, elapsedS: 0.25, estimatedS: 10, ended: false, cushionS: 0.6 }), false, 'a cushion of its own');
});

test('readyToStart: a rate measured over less than a quarter second is not trusted: a burst of pieces handled back to back on a busy phone looks like many times real time (fix pass)', () => {
  assert.equal(readyToStart({ bufferedS: 1, receivedS: 0.9, elapsedS: 0.05, estimatedS: 10, ended: false }), false, '18 times real time, in 50 ms');
  assert.equal(readyToStart({ bufferedS: 4.6, receivedS: 4.5, elapsedS: 0.25, estimatedS: 10, ended: false }), true, 'the same rate over a quarter second');
  assert.equal(readyToStart({ bufferedS: 1, receivedS: 0.9, elapsedS: 0.05, estimatedS: 10, ended: false, windowS: 0.04 }), true, 'a window of its own');
  assert.equal(readyToStart({ bufferedS: 1, receivedS: 0.9, elapsedS: 0.05, estimatedS: 10, ended: true }), true, 'all of it in: nothing to measure');
});

test('readyToStart: arriving at half the speed it plays, an estimated 10 s waits until 6 s are in: (1 − 0.5) × 10 × 1.2', () => {
  assert.equal(readyToStart({ bufferedS: 5.9, receivedS: 5, elapsedS: 10, estimatedS: 10, ended: false }), false);
  assert.equal(readyToStart({ bufferedS: 6, receivedS: 5, elapsedS: 10, estimatedS: 10, ended: false }), true);
  // A sentence longer than its estimate: what is already in counts as its length, so at a tenth of real time it waits for all of it.
  assert.equal(readyToStart({ bufferedS: 3, receivedS: 0.3, elapsedS: 3, estimatedS: 2, ended: false }), false, '(1 − 0.1) × 3 × 1.2 = 3.24 > 3');
});
