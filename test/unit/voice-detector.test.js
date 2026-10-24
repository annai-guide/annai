import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector } from '../../src/core/voice/detector.js';
import { biquad } from '../../src/core/voice/pcm.js';
import { clip, quiet, brown, burst, hum, cat, mix, detect, segments, room, RATE } from './voice-kit.js';

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

// The iPhone opens a microphone with digital silence (zeros), then gives sound (the iPhone trace, 2026-10-22). The zeros say nothing of the
// room, so the floor starts as a guess, and speech that starts the instant the zeros end must still be cut as a segment.
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

// An utterance of under about half a second ("Yes", "Thanks") that starts the instant the zeros end: a floor learned from its first frame
// was the word's own level, and the word was never 10 dB over itself for the 250 ms speech needs (the flake-sweep review's gap). The zeros
// now make the floor a guess at FLOOR_MIN_DB, so the word is speech against it. "Thanks" (flite) starts at its loudest: no rise at all.
for (const rate of [16_000, 48_000]) {
  test(`a short word said the instant a just-opened microphone's zeros end is a segment: "Yes" (0.3 s) and "Thanks" (${rate / 1000} kHz)`, async () => {
    const short = (await clip('where-eat')).subarray(0, Math.round(0.3 * RATE));
    const thanks = await clip('thanks');
    assert.equal(segments(detectAt(cat(quiet(0.4), short, quiet(1.2, 0)), rate)).length, 1, 'after a hiss (the same words)');
    for (const [name, word] of /** @type {const} */ ([['yes', short], ['thanks', thanks]])) {
      for (const zeros of [0.1, 1]) {
        assert.equal(segments(detectAt(cat(new Float32Array(Math.round(zeros * RATE)), word, quiet(1.2, 0)), rate)).length, 1, `${name} after ${zeros} s of zeros, then zeros`);
        assert.equal(segments(detectAt(cat(new Float32Array(Math.round(zeros * RATE)), word, room(4, new Float32Array(0))), rate)).length, 1, `${name} after ${zeros} s of zeros, then a room`);
      }
    }
  });
}

test('a microphone that opens on a word, then gates to zeros: the zeros make the young floor a guess again, so the short word after is a segment (Opus\'s proposal)', async () => {
  const loud = eat.subarray(Math.round(eat.length * 0.3), Math.round(eat.length * 0.3) + 320); // 20 ms of a word: the floor's first frame
  const thanks = await clip('thanks');
  for (const word of [eat.subarray(0, Math.round(0.3 * RATE)), thanks]) {
    assert.deepEqual(detect(cat(loud, new Float32Array(RATE * 0.3), word, quiet(1.2, 0))).map((e) => e.type), ['speech', 'segment']);
  }
});

test('noise that starts as a just-opened microphone\'s zeros end (a car, an engine, a fan or a loud room, a click) is no segment, and never sure speech while the floor is a guess', () => {
  const zeros = new Float32Array(RATE / 2);
  for (const [name, noise] of /** @type {const} */ ([['car', brown(6, 0.5)], ['loud car', brown(6, 1.5)], ['engine', brown(6, 0.4, 9)],
    ['fan', room(8, new Float32Array(0), undefined, 0.016)], ['click', cat(burst(0.12, 0.8), quiet(1.5))], ['click, then zeros', cat(burst(0.12, 0.8), quiet(1.5, 0))]])) {
    const d = new Detector({ sampleRate: RATE });
    const pcm = cat(zeros, noise);
    let sure = 0;
    /** @type {string[]} */
    const types = [];
    for (let i = 0; i < pcm.length; i += 2048) {
      types.push(...d.push(pcm.subarray(i, i + 2048)).map((e) => e.type));
      sure = Math.max(sure, d.speechMs);
    }
    assert.equal(types.filter((t) => t === 'segment').length, 0, name);
    assert.ok(sure < 250, `${name}: ${sure} ms of sure speech (a live turn starts at 250)`);
  }
});

test('a quiet room heard after the zeros ends the guess: a sentence later is sure speech as it goes, and the floor stays the room\'s', () => {
  const d = new Detector({ sampleRate: RATE });
  const pcm = cat(new Float32Array(RATE / 2), quiet(1), hum(2), quiet(1.2));
  let sure = 0;
  for (let i = 0; i < pcm.length; i += 320) {
    d.push(pcm.subarray(i, i + 320));
    if (i === RATE * 2) sure = d.speechMs; // half a second into the speech
  }
  assert.ok(sure >= 250, `${sure} ms of sure speech half a second in (a live turn starts at 250)`);
  assert.ok(d.floorDb !== null && d.floorDb < -70, `the room's floor: ${d.floorDb}`);
});

test('speech said the instant the zeros end, with no quiet in it, is held as unsure for a second; then the floor is its quietest frame, and it goes on to its pause', () => {
  const d = new Detector({ sampleRate: RATE });
  const voice = hum(2);
  const pcm = cat(new Float32Array(RATE / 2), voice, quiet(1.2, 0));
  /** @type {number[]} */
  const speech = [];
  const events = [];
  /** @type {number | null} */
  let given = null;
  for (let i = 0; i < pcm.length; i += 320) {
    events.push(...d.push(pcm.subarray(i, i + 320)));
    if (d.speaking) speech.push(d.speechMs);
    if (given === null && d.speechMs > 0) given = d.floorDb;
  }
  assert.deepEqual(events.map((e) => e.type), ['speech', 'segment']);
  assert.equal(speech[40], 0, 'unsure while the floor is the guess');
  assert.ok((speech.at(-1) ?? 0) >= 250, `sure by its end: ${speech.at(-1)} ms`);
  // The quietest of the run's first 52 frames, measured as the detector does (its band, 20 ms frames).
  const hp = biquad('highpass', 300, RATE);
  const lp = biquad('lowpass', 3400, RATE);
  let quietest = Infinity;
  for (let f = 0; f < 52; f++) {
    let e = 0;
    for (let i = f * 320; i < (f + 1) * 320; i++) e += lp(hp(voice[i])) ** 2;
    quietest = Math.min(quietest, 10 * Math.log10(e / 320 + 1e-12));
  }
  assert.ok(given !== null && Math.abs(given - quietest) < 1, `the floor as the guess gave way, ${given} dB, is the run's quietest frame, ${quietest.toFixed(1)} dB`);
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

test('a microphone that opens with 100 ms of digital silence: the floor\'s guess gives way to the room\'s first frames, so the room is not speech', () => {
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
