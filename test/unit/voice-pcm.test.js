import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav, wavSeconds, resample, SEND_RATE } from '../../src/core/voice/pcm.js';
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
