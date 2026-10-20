import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyToStart, estimateSeconds } from '../../src/core/voice/stream-start.js';

// When a streamed voice may start (G3, "Never stutters"): once the rest of the clip, at the rate it's arriving, will be in
// before playback reaches it. Its length is estimated from the words, at 15 characters a second, with a fifth more to spare.

test('a sentence is estimated at 15 characters a second', () => {
  assert.equal(estimateSeconds('x'.repeat(60)), 4);
  assert.equal(estimateSeconds(''), 0);
});

test('readyToStart: all in, it starts; nothing yet, it waits', () => {
  assert.equal(readyToStart({ bufferedS: 0.1, receivedS: 0, elapsedS: 0, estimatedS: 10, ended: true }), true, 'the whole clip is here');
  assert.equal(readyToStart({ bufferedS: 0, receivedS: 0, elapsedS: 0.5, estimatedS: 10, ended: false }), false, 'nothing received');
  assert.equal(readyToStart({ bufferedS: 0.1, receivedS: 0, elapsedS: 0, estimatedS: 10, ended: false }), false, 'one piece: no rate yet');
});

test('readyToStart: arriving 6 times faster than it plays, a cushion of 0.3 s is enough', () => {
  assert.equal(readyToStart({ bufferedS: 0.3, receivedS: 0.3, elapsedS: 0.05, estimatedS: 10, ended: false }), true);
  assert.equal(readyToStart({ bufferedS: 0.2, receivedS: 0.2, elapsedS: 0.02, estimatedS: 10, ended: false }), false, 'under the cushion');
  assert.equal(readyToStart({ bufferedS: 0.5, receivedS: 0.5, elapsedS: 0.1, estimatedS: 10, ended: false, cushionS: 0.6 }), false, 'a cushion of its own');
});

test('readyToStart: arriving at half the speed it plays, an estimated 10 s waits until 6 s are in: (1 − 0.5) × 10 × 1.2', () => {
  assert.equal(readyToStart({ bufferedS: 5.9, receivedS: 5, elapsedS: 10, estimatedS: 10, ended: false }), false);
  assert.equal(readyToStart({ bufferedS: 6, receivedS: 5, elapsedS: 10, estimatedS: 10, ended: false }), true);
  // A sentence longer than its estimate: what is already in counts as its length, so at a tenth of real time it waits for all of it.
  assert.equal(readyToStart({ bufferedS: 3, receivedS: 0.3, elapsedS: 3, estimatedS: 2, ended: false }), false, '(1 − 0.1) × 3 × 1.2 = 3.24 > 3');
});
