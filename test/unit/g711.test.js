import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muLaw, fromMuLaw, aLaw, fromALaw } from '../../plugins-official/openai-realtime/index.js';

// G.711 (ITU-T G.711), which OpenAI Realtime takes as audio/pcmu and audio/pcma: 8 kHz, one byte a sample. The
// reference is Sun Microsystems' public-domain g711.c, as in ITU-T G.191's tools: μ-law in G.711's 14-bit domain,
// A-law in its 13-bit one.

/** @param {number} v @param {number[]} table */
const search = (v, table) => { const i = table.findIndex((t) => v <= t); return i < 0 ? table.length : i; };
/** g711.c's linear2ulaw. @param {number} pcm */
function linear2ulaw(pcm) {
  let v = pcm >> 2;
  const mask = v < 0 ? 0x7f : 0xff;
  v = Math.min(Math.abs(v), 8159) + (0x84 >> 2);
  const seg = search(v, [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff]);
  return seg >= 8 ? 0x7f ^ mask : ((seg << 4) | ((v >> (seg + 1)) & 0xf)) ^ mask;
}
/** g711.c's ulaw2linear. @param {number} u */
function ulaw2linear(u) {
  const v = ~u & 0xff;
  const t = (((v & 0xf) << 3) + 0x84) << ((v & 0x70) >> 4);
  return v & 0x80 ? 0x84 - t : t - 0x84;
}
/** g711.c's linear2alaw. @param {number} pcm */
function linear2alaw(pcm) {
  let v = pcm >> 3;
  const mask = v >= 0 ? 0xd5 : 0x55;
  if (v < 0) v = -v - 1;
  const seg = search(v, [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff]);
  return seg >= 8 ? 0x7f ^ mask : ((seg << 4) | ((v >> (seg < 2 ? 1 : seg)) & 0xf)) ^ mask;
}
/** g711.c's alaw2linear. @param {number} a */
function alaw2linear(a) {
  const v = a ^ 0x55;
  const seg = (v & 0x70) >> 4;
  const t = seg === 0 ? ((v & 0xf) << 4) + 8 : (((v & 0xf) << 4) + 0x108) << (seg - 1);
  return v & 0x80 ? t : -t;
}

test("μ-law and A-law code every 16-bit sample, and decode every byte, exactly as the reference g711.c does (review)", () => {
  const all = Int16Array.from({ length: 65_536 }, (_, i) => i - 32_768);
  assert.deepEqual([...muLaw(all)], Array.from(all, linear2ulaw));
  assert.deepEqual([...aLaw(all)], Array.from(all, linear2alaw));
  const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual([...fromMuLaw(codes)], Array.from(codes, ulaw2linear));
  assert.deepEqual([...fromALaw(codes)], Array.from(codes, alaw2linear));
});

test('μ-law and A-law: the codes for 0, the extremes and the smallest steps, as G.711 has them', () => {
  assert.deepEqual([...muLaw(Int16Array.of(0, 1, -1, 32767, -32767, -32768))], [0xff, 0xff, 0x7e, 0x80, 0x00, 0x00]);
  assert.deepEqual([...fromMuLaw(Uint8Array.of(0xff, 0x7f, 0x80, 0x00))], [0, 0, 32124, -32124]);
  assert.deepEqual([...aLaw(Int16Array.of(0, 1, -1, 32767, -32768))], [0xd5, 0xd5, 0x55, 0xaa, 0x2a]);
  assert.deepEqual([...fromALaw(Uint8Array.of(0xd5, 0x55, 0xaa, 0x2a))], [8, -8, 32256, -32256]);
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
