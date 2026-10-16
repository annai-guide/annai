import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector } from '../../src/core/voice/detector.js';
import { clip, quiet, brown, burst, cat, mix, detect, segments, RATE } from './voice-kit.js';

const lunch = await clip('where-lunch');
const gas = await clip('gas-station');
const ms = (/** @type {Float32Array} */ pcm) => (pcm.length / RATE) * 1000;

test('one sentence becomes one segment: the speech, with a little before and after (spec §10.2)', () => {
  const events = detect(cat(quiet(0.6), lunch, quiet(1)));
  assert.deepEqual(events.map((e) => e.type), ['speech', 'segment']);
  const [len] = segments(events);
  assert.ok(len >= ms(lunch) && len <= ms(lunch) + 600, `${len} ms for ${ms(lunch)} ms of speech`);
});

test('a pause of about 700 ms ends a segment; a short one does not', () => {
  assert.equal(segments(detect(cat(quiet(0.5), lunch, quiet(1.2), gas, quiet(1)))).length, 2);
  assert.equal(segments(detect(cat(quiet(0.5), lunch, quiet(0.35), gas, quiet(1)))).length, 1);
});

test('the pause is tunable', () => {
  assert.equal(segments(detect(cat(quiet(0.5), lunch, quiet(1.2), gas, quiet(2)), { pauseMs: 1500 })).length, 1);
});

test('speech over road noise is still found; the noise alone is not speech', () => {
  const speech = cat(quiet(2, 0), lunch, quiet(1.2, 0), gas, quiet(1.5, 0));
  // About 6 dB of speech over the noise: a loud car.
  assert.equal(segments(detect(mix(speech, brown(speech.length / RATE, 0.5)))).length, 2);
  assert.deepEqual(detect(brown(6, 0.5)), []);
});

test('steady noise that starts suddenly (a window opened) is learned as the new floor, not taken for speech', () => {
  const events = detect(cat(brown(3, 0.03), brown(4, 0.4, 9)));
  assert.equal(segments(events).length, 0);
});

test('a click is too short to be speech', () => {
  const events = detect(cat(quiet(1), burst(0.12, 0.8), quiet(1.5)));
  assert.equal(segments(events).length, 0);
  assert.deepEqual(events.map((e) => e.type), ['speech', 'discard']);
});

test('48 kHz works the same', () => {
  const pcm = cat(quiet(0.6), lunch, quiet(1));
  const up = Float32Array.from({ length: pcm.length * 3 }, (_, i) => pcm[Math.floor(i / 3)]);
  const d = new Detector({ sampleRate: 48_000 });
  const events = [];
  for (let i = 0; i < up.length; i += 4096) events.push(...d.push(up.subarray(i, i + 4096)));
  assert.equal(segments(events).length, 1);
  assert.equal(/** @type {any} */ (events.find((e) => e.type === 'segment')).sampleRate, 48_000);
});

test('the level rises while someone speaks; end() keeps speech that was still going', () => {
  const d = new Detector({ sampleRate: RATE });
  d.push(quiet(0.5));
  assert.ok(d.level < 0.2);
  let loudest = 0;
  for (let i = 0; i < RATE; i += 320) {
    d.push(lunch.subarray(i, i + 320));
    loudest = Math.max(loudest, d.level);
  }
  assert.equal(d.speaking, true);
  assert.ok(loudest > 0.2, `level ${loudest}`);
  assert.deepEqual(d.end().map((e) => e.type), ['segment']);
  assert.equal(d.speaking, false);
  assert.deepEqual(new Detector({ sampleRate: RATE }).end(), []);
});

test('speech that never pauses is cut into pieces no longer than maxMs; it never stops listening', () => {
  const run = cat(...Array.from({ length: 8 }, () => cat(lunch, quiet(0.2), gas, quiet(0.2))));
  const lens = segments(detect(cat(quiet(0.5), run, quiet(1)), { maxMs: 8000 }));
  assert.ok(lens.length >= 3, `${lens.length} segments`);
  assert.ok(lens.every((l) => l <= 8000), lens.join(', '));
});
