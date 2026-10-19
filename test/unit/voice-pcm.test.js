import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav, wavSeconds, resample, SEND_RATE, StreamResampler } from '../../src/core/voice/pcm.js';
import { clip, RATE } from './voice-kit.js';

test('WAV round-trips as 16-bit mono, and says how long it is', () => {
  const pcm = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 5) * 0.5);
  const bytes = encodeWav(pcm, 16000);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(bytes.length, 44 + 3200);
  const back = decodeWav(bytes);
  assert.equal(back.sampleRate, 16000);
  assert.ok(back.pcm.every((x, i) => Math.abs(x - pcm[i]) < 1e-4));
  assert.equal(wavSeconds(bytes), 0.1);
  assert.equal(encodeWav(Float32Array.of(2, -2), 8000).length, 48); // out-of-range samples are clipped, not wrapped
  assert.deepEqual([...decodeWav(encodeWav(Float32Array.of(2, -2), 8000)).pcm].map((x) => Math.round(x)), [1, -1]);
});

test('the speech fixtures are 16 kHz WAV files a second or two long', async () => {
  for (const name of ['where-lunch', 'gas-station', 'where-eat', 'first-one']) {
    const pcm = await clip(name);
    assert.ok(pcm.length > RATE * 0.8 && pcm.length < RATE * 3, `${name}: ${pcm.length / RATE} s`);
  }
});

test('resampling keeps the length in time and the tone', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  const down = resample(tone, 48000, SEND_RATE);
  assert.equal(down.length, 16000);
  const crossings = down.reduce((n, x, i) => n + (i && Math.sign(x) !== Math.sign(down[i - 1]) ? 1 : 0), 0);
  assert.ok(Math.abs(crossings - 880) < 10, `${crossings} zero crossings`);
  assert.equal(resample(tone, 48000, 48000), tone);
  assert.equal(resample(down, 16000, 48000).length, 48000);
});

test('a file that is not a 16-bit WAV is refused in plain words', () => {
  assert.throws(() => decodeWav(new TextEncoder().encode('not a wav file at all, really')), /not a WAV file/);
  const float = encodeWav(Float32Array.of(0.1), 8000);
  new DataView(float.buffer).setUint16(34, 32, true);
  assert.throws(() => decodeWav(float), /16-bit/);
});

/** A tone, s seconds at fs. @param {number} f @param {number} fs @param {number} s */
const tone = (f, fs, s) => Float32Array.from({ length: fs * s }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
/** A tone's level in dB in x (1 = 0 dB), after the filter has settled. @param {Float32Array} x @param {number} fs @param {number} f */
function level(x, fs, f) {
  let re = 0;
  let im = 0;
  const from = Math.floor(x.length / 4);
  for (let i = from; i < x.length; i++) {
    re += x[i] * Math.cos((2 * Math.PI * f * i) / fs);
    im += x[i] * Math.sin((2 * Math.PI * f * i) / fs);
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / (x.length - from) + 1e-12);
}

test("bringing 48 kHz down keeps what is above the new rate's half out: 40 dB down past it, speech's band within 1 dB (G.711's 8 kHz and Gemini's 16 kHz) (review)", () => {
  /** @type {[number, number, number, number[]][]} from, to, the top of the band kept flat, tones above the new rate's half */
  const cases = [[48_000, 8000, 3000, [4400, 5000, 6000, 8000, 10_000]], [48_000, 16_000, 6000, [8800, 10_000, 12_000]], [44_100, 8000, 3000, [4400, 6000]]];
  for (const [from, to, flat, gone] of cases) {
    for (const f of [300, 1000, 2000, flat]) {
      const db = level(new StreamResampler(from, to).push(tone(f, from, 1)), to, f);
      assert.ok(db > -1 && db < 0.5, `${from} → ${to}: ${f} Hz at ${db.toFixed(2)} dB`);
    }
    for (const f of gone) {
      const folded = Math.abs(((f + to / 2) % to) - to / 2);
      const db = level(new StreamResampler(from, to).push(tone(f, from, 1)), to, folded);
      assert.ok(db < -40, `${from} → ${to}: ${f} Hz folds to ${folded} Hz at ${db.toFixed(1)} dB`);
    }
  }
  // The telephone band's top, 3.4 kHz, is kept too.
  assert.ok(level(new StreamResampler(48_000, 8000).push(tone(3400, 48_000, 1)), 8000, 3400) > -1.5);
});
