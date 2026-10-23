import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector } from '../../src/core/voice/detector.js';
import { clip, quiet, brown, burst, cat, mix, detect, segments, room, RATE } from './voice-kit.js';

const lunch = await clip('where-lunch');
const gas = await clip('gas-station');
const eat = await clip('where-eat');
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

/** The detector at a sample rate, fed in chunks of 4096 samples. @param {Float32Array} pcm 16 kHz @param {number} rate 16000 or 48000 */
function detectAt(pcm, rate) {
  const k = rate / RATE;
  const at = Float32Array.from({ length: pcm.length * k }, (_, i) => pcm[Math.floor(i / k)]);
  const d = new Detector({ sampleRate: rate });
  const events = [];
  for (let i = 0; i < at.length; i += 4096) events.push(...d.push(at.subarray(i, i + 4096)));
  return events;
}

// The iPhone opens a microphone with digital silence (zeros), then gives sound (the iPhone trace, 2026-10-22). The detector learns its floor
// from the first frame with sound in it and ignores zeros, so speech that starts the instant the zeros end must still be cut as a segment.
for (const rate of [16_000, 48_000]) {
  test(`a microphone just opened: digital silence, then a sentence that starts the instant the zeros end, is a segment (${rate / 1000} kHz)`, async () => {
    for (const name of ['where-lunch', 'where-eat', 'gas-station', 'first-one']) {
      const words = await clip(name);
      for (const zeros of [0.4, 1]) {
        const events = detectAt(cat(new Float32Array(Math.round(zeros * RATE)), words, quiet(1.2, 0)), rate);
        assert.equal(segments(events).length, 1, `${name} after ${zeros} s of zeros`);
      }
    }
  });
}

test('the same sentence after zeros and after a faint hiss: a hiss is what the fake microphone of the e2e tests puts under everything', async () => {
  const words = await clip('where-eat');
  assert.equal(segments(detectAt(cat(quiet(0.4), words, quiet(1.2, 0)), 16_000)).length, 1);
});

// KNOWN GAP, not yet decided (the young-floor change waits for a phone test; src/core/voice/detector.js is not changed here): an utterance of
// under about half a second ("Yes", "Thanks") that starts the instant the zeros end gives no segment today, because the floor is learned
// from its first frame with sound, and it is not 10 dB over itself for the 250 ms that speech needs. After a hiss it is a segment. A todo
// test: it reports, and does not fail the run, until the detector is changed (then it passes, and its todo goes).
test('a short utterance (0.3 s) that starts the instant the zeros end is a segment', { todo: 'the floor is learned from the first frame with sound; a phone test decides the change' }, async () => {
  const short = (await clip('where-eat')).subarray(0, Math.round(0.3 * RATE));
  assert.equal(segments(detectAt(cat(quiet(0.4), short, quiet(1.2, 0)), 16_000)).length, 1, 'after a hiss it is (the same words)');
  assert.equal(segments(detectAt(cat(new Float32Array(RATE), short, quiet(1.2, 0)), 16_000)).length, 1, 'after zeros: no segment today (the gap)');
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

// voice-fix item 3 (the iPhone trace, 2026-10-22: a live turn ran on for 29 s after the user stopped): near-silent frames.
/** When the run that starts with the speech at 3 s ends, in seconds after it starts. @param {Float32Array} pcm @param {Record<string, number>} [opts] */
function runEnds(pcm, opts) {
  const d = new Detector({ sampleRate: RATE, ...opts });
  let start = null;
  for (let i = 0; i < pcm.length; i += 2048) {
    for (const e of d.push(pcm.subarray(i, i + 2048))) {
      const t = (i + 2048) / RATE;
      if (e.type === 'speech' && start === null) start = t;
      else if (start !== null) return { start, end: t - start, type: e.type };
    }
  }
  return { start, end: Infinity, type: 'none' };
}

test('near-silent frames (60 ms of zeros every half second, as an iPhone gives) neither move the floor nor keep speech going: it ends at its pause', () => {
  const after = (/** @type {number} */ t) => t > 3 + lunch.length / RATE && t % 0.5 < 0.06;
  const r = runEnds(room(40, lunch, after));
  assert.ok(r.start !== null && r.start > 2.9, `speech found at ${r.start} s`);
  assert.deepEqual(detect(room(40, lunch, after)).map((e) => e.type), ['speech', 'segment'], 'and the room is never speech after it (frames partly of zeros too)');
  assert.equal(r.type, 'segment');
  assert.ok(r.end < 4, `the run lasted ${r.end.toFixed(1)} s for ${(lunch.length / RATE).toFixed(1)} s of speech`);
  // And 200 ms of them right after the speech.
  const once = runEnds(room(40, lunch, (t) => t > 3 + lunch.length / RATE && t < 3.2 + lunch.length / RATE));
  assert.ok(once.end < 3, `${once.end.toFixed(1)} s`);
});

test('a microphone that opens with 100 ms of digital silence: the floor starts from the first real frames, so the room is not speech', () => {
  const r = runEnds(room(10, lunch, (t) => t < 0.1));
  assert.ok(r.start !== null && r.start > 2.9, `speech found at ${r.start} s, not in the room before it`);
  assert.equal(r.type, 'segment');
});

test("the floor and the loudest frame of the run, in dB, for the Trace", () => {
  const d = new Detector({ sampleRate: RATE });
  assert.equal(d.floorDb, null);
  const events = [];
  const pcm = cat(quiet(0.6), lunch, quiet(1));
  for (let i = 0; i < pcm.length; i += 2048) events.push(...d.push(pcm.subarray(i, i + 2048)));
  const seg = /** @type {any} */ (events.find((e) => e.type === 'segment'));
  assert.equal(seg.cut, 'pause');
  assert.ok(d.floorDb !== null && d.floorDb < -60, `floor ${d.floorDb}`);
  assert.ok(seg.peakDb > -30 && seg.peakDb > /** @type {number} */ (d.floorDb) + 30, `peak ${seg.peakDb}`);
  const capped = /** @type {any} */ (detect(cat(quiet(0.5), ...Array.from({ length: 6 }, () => cat(lunch, quiet(0.2), gas, quiet(0.2)))), { maxMs: 5000 }).find((e) => e.type === 'segment'));
  assert.equal(capped.cut, 'cap');
});

test("a gate that takes the room down to near silence (not zeros) for 60 ms every half second doesn't drag the floor: speech ends at its pause, and the room after is no speech", () => {
  let n = 7;
  const r = () => ((n = (n * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const pcm = room(25, lunch);
  for (let i = 0; i < pcm.length; i++) if (i / RATE > 3 + lunch.length / RATE && (i / RATE) % 0.5 < 0.06) pcm[i] = r() * 1e-4;
  const events = detect(pcm, { maxMs: 15_000 });
  assert.deepEqual(events.map((e) => e.type), ['speech', 'segment']);
  assert.equal(/** @type {any} */ (events[1]).cut, 'pause');
});

test('zero samples here and there (a quiet 16-bit microphone rounds many to 0) are sound; only runs of 2 ms or more are digital silence (review, Step 11)', () => {
  // A room whose every third sample is exactly 0: a third of each frame, but never two zeros in a row.
  const pcm = room(8, lunch).map((x, i) => (i % 3 === 0 ? 0 : x));
  const events = detect(pcm);
  assert.deepEqual(events.map((e) => e.type), ['speech', 'segment']);
  const d = new Detector({ sampleRate: RATE });
  d.push(pcm.subarray(0, RATE));
  assert.ok(d.floorDb !== null && d.floorDb > -80, `the room set the floor: ${d.floorDb}`);
});

test('a floor whose first frame was speech (a microphone that opens on a word) still finds the speech: a young floor falls freely (the dip rule waits for a learned one; Chromium\'s fake microphone in the e2e caught it)', () => {
  const loud = eat.subarray(Math.round(eat.length * 0.3), Math.round(eat.length * 0.3) + 320); // 20 ms of a word
  const events = detect(cat(new Float32Array(RATE / 2), loud, eat, quiet(1.5)));
  assert.deepEqual(events.map((e) => e.type), ['speech', 'segment']);
});
