import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muLaw, fromMuLaw, aLaw, fromALaw } from '../../plugins-official/openai-realtime/index.js';

// G.711 (ITU-T G.711), which OpenAI Realtime takes as audio/pcmu and audio/pcma: 8 kHz, one byte a sample.

test('μ-law and A-law: the reference codes for 0, ±1 and the extremes match ITU-T G.711', () => {
  assert.deepEqual([...muLaw(Int16Array.of(0, 1, -1, 32767, -32767, -32768))], [0xff, 0xff, 0x7f, 0x80, 0x00, 0x00]);
  assert.deepEqual([...fromMuLaw(Uint8Array.of(0xff, 0x7f, 0x80, 0x00))], [0, 0, 32124, -32124]);
  assert.deepEqual([...aLaw(Int16Array.of(0, 1, -1, 32767, -32768))], [0xd5, 0xd5, 0x55, 0xaa, 0x2a]);
  assert.deepEqual([...fromALaw(Uint8Array.of(0xd5, 0x55, 0xaa, 0x2a))], [8, -8, 32256, -32256]);
});

test('μ-law and A-law round-trip every 16-bit sample within G.711\'s error: half a step of its segment', () => {
  for (let x = -32768; x <= 32767; x++) {
    const mu = fromMuLaw(muLaw(Int16Array.of(x)))[0];
    const a = fromALaw(aLaw(Int16Array.of(x)))[0];
    // A segment's step is a sixteenth of where it starts, so the error is at most a 32nd of the sample (μ-law's
    // biased by 132, A-law's after dropping 3 bits); past the top code, the sample is clipped to it.
    assert.ok(Math.abs(mu - x) <= Math.max((Math.abs(x) + 132) / 32, Math.abs(x) - 32124), `μ-law ${x} → ${mu}`);
    assert.ok(Math.abs(a - x) <= Math.max((Math.abs(x) + 8) / 32 + 8, Math.abs(x) - 32256), `A-law ${x} → ${a}`);
  }
  // The codes decode to sound that encodes back to the same codes.
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual([...muLaw(fromMuLaw(all))].map((c, i) => c === i || (i === 0x7f && c === 0xff)), Array(256).fill(true));
  assert.deepEqual([...aLaw(fromALaw(all))], [...all]);
});

test('a 1 kHz tone at 8 kHz keeps its shape through μ-law (signal to noise over 30 dB)', () => {
  const tone = Int16Array.from({ length: 8000 }, (_, i) => Math.round(12000 * Math.sin((2 * Math.PI * 1000 * i) / 8000 + 0.3)));
  const back = fromMuLaw(muLaw(tone));
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < tone.length; i++) {
    signal += tone[i] ** 2;
    noise += (tone[i] - back[i]) ** 2;
  }
  assert.ok(10 * Math.log10(signal / noise) > 30);
  assert.equal(muLaw(tone).length, tone.length, 'one byte a sample: a quarter of 16-bit PCM at the same rate');
});
