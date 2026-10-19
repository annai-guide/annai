import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamResampler, LiveInput } from '../../src/core/realtime/input.js';
import { clip, quiet, cat, RATE } from './voice-kit.js';

const lunch = await clip('where-lunch');
const gas = await clip('gas-station');

/** 16 kHz sound at 48 kHz, as a phone's microphone gives it. @param {Float32Array} pcm */
const up3 = (pcm) => Float32Array.from({ length: pcm.length * 3 }, (_, i) => pcm[Math.floor(i / 3)]);

/**
 * A microphone fed by the test: frames in the worklet's batches of 2048, and what LiveInput sent, in order:
 * 'start', 'end', or the bytes of a chunk.
 */
function rig(o = {}) {
  /** @type {((pcm: Float32Array, rate: number) => void) | null} */
  let frames = null;
  let closed = false;
  /** @type {(string | Uint8Array)[]} */
  const sent = [];
  const mic = {
    async open(/** @type {any} */ c) {
      frames = c.onFrames;
      return { close() { closed = true; } };
    },
  };
  const input = new LiveInput({ mic, send: { activity: (edge) => sent.push(edge), audio: (b) => sent.push(b) }, ...o });
  return {
    input, sent,
    get closed() { return closed; },
    /** @param {Float32Array} pcm @param {number} [rate] */
    feed(pcm, rate = 48_000) {
      for (let i = 0; i < pcm.length; i += 2048) /** @type {any} */ (frames)(pcm.subarray(i, i + 2048), rate);
    },
  };
}
/** The ms of 16 kHz 16-bit audio in some chunks. @param {(string | Uint8Array)[]} xs */
const msOf = (xs) => (xs.filter((x) => typeof x !== 'string').reduce((n, x) => n + /** @type {Uint8Array} */ (x).length, 0) / 2 / RATE) * 1000;

test('2 s of speech in 30 s of quiet: activityStart, the pre-roll and 100 ms chunks, activityEnd at the cut, and nothing in the silence', async () => {
  const r = rig();
  await r.input.start();
  const speech = cat(lunch, quiet(0.3), gas);
  r.feed(up3(cat(quiet(14), speech, quiet(14))));
  assert.equal(r.sent[0], 'start');
  assert.equal(r.sent.at(-1), 'end');
  assert.deepEqual(r.sent.filter((x) => typeof x === 'string'), ['start', 'end'], 'one sentence, one activity');
  const chunks = /** @type {Uint8Array[]} */ (r.sent.slice(1, -1));
  assert.ok(chunks.every((c) => c instanceof Uint8Array));
  assert.ok(chunks.slice(0, -1).every((c) => c.length === 3200), '100 ms chunks of 16 kHz PCM16');
  const ms = msOf(chunks);
  const said = (speech.length / RATE) * 1000;
  // The speech, about 0.3 s before it, and the 0.7 s pause that ends it: never the rest of the 28 s of quiet.
  assert.ok(ms > said + 600 && ms < said + 1400, `${ms} ms sent for ${said} ms of speech`);
  r.input.stop();
  assert.ok(r.closed, 'the microphone closes');
});

test('the audio sent is the speech: its loudest part is where the speech is', async () => {
  const r = rig();
  await r.input.start();
  r.feed(up3(cat(quiet(2), lunch, quiet(2))));
  const bytes = /** @type {Uint8Array[]} */ (r.sent.filter((x) => typeof x !== 'string'));
  const all = new Int16Array(bytes.reduce((n, b) => n + b.length, 0) / 2);
  let at = 0;
  for (const b of bytes) {
    all.set(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), at);
    at += b.length / 2;
  }
  const peak = Math.max(...all.map(Math.abs));
  const want = Math.max(...lunch.map((x) => Math.abs(x))) * 0x7fff;
  assert.ok(peak > want * 0.7 && peak < want * 1.3, `peak ${peak} vs ${want}`);
});

test('a sentence still going on when listening stops is ended; a click is ended too, and nothing more is sent', async () => {
  const r = rig();
  await r.input.start();
  r.feed(up3(cat(quiet(1), lunch.subarray(0, 12_000))));
  assert.equal(r.sent[0], 'start');
  r.input.stop();
  assert.equal(r.sent.at(-1), 'end');
  const n = r.sent.length;
  r.feed(up3(cat(quiet(1), lunch)));
  assert.equal(r.sent.length, n, 'nothing after stop');
});

test('the resampler gives the same samples chunk by chunk as all at once (within 1e-3)', () => {
  const tone = Float32Array.from({ length: 48_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  for (const [from, sizes] of /** @type {[number, number[]][]} */ ([[48_000, [2048, 128, 1, 4095]], [44_100, [2048, 333]], [16_000, [512]]])) {
    const input = from === 48_000 ? tone : Float32Array.from({ length: from }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / from));
    const whole = new StreamResampler(from, 16_000).push(input);
    assert.ok(Math.abs(whole.length - 16_000) <= 1, `${from}: ${whole.length} samples for a second`);
    for (const size of sizes) {
      const r = new StreamResampler(from, 16_000);
      const parts = [];
      for (let i = 0; i < input.length; i += size) parts.push(...r.push(input.subarray(i, i + size)));
      assert.equal(parts.length, whole.length, `${from} in pieces of ${size}`);
      assert.ok(parts.every((x, i) => Math.abs(x - whole[i]) <= 0x7fff * 1e-3), `${from} in pieces of ${size}: the same samples`);
    }
    // A 440 Hz tone at half scale stays about half scale.
    const peak = Math.max(...whole.slice(200).map(Math.abs));
    assert.ok(peak > 0x7fff * 0.45 && peak < 0x7fff * 0.55, `${from}: peak ${peak}`);
  }
});

test('while Koe plays, a start needs 6 dB more over the floor', async () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const hiss = (/** @type {number} */ s) => Float32Array.from({ length: s * RATE }, () => rnd() * 0.001);
  /** A voice-like tone over the hiss: a in amplitude, rising and falling four times a second. @param {number} a */
  const voice = (a) => hiss(1).map((x, i) => x + a * (0.75 + 0.25 * Math.sin((2 * Math.PI * 4 * i) / RATE)) * Math.sin((2 * Math.PI * 1000 * i) / RATE));
  const starts = async (/** @type {number} */ a, /** @type {boolean} */ playing) => {
    const r = rig({ speaking: () => playing });
    await r.input.start();
    r.feed(cat(hiss(2), voice(a)), RATE);
    r.input.stop();
    return r.sent.includes('start');
  };
  assert.equal(await starts(0.002, false), true, 'about 12 dB over the hiss starts speech');
  assert.equal(await starts(0.002, true), false, 'but not while Koe plays');
  assert.equal(await starts(0.008, true), true, 'a louder voice cuts in while Koe plays');
  const off = rig({ speaking: () => true, bargeInDb: Infinity });
  await off.input.start();
  off.feed(cat(hiss(2), voice(0.05)), RATE);
  assert.ok(!off.sent.includes('start'), 'with cutting in by voice off, nothing starts while Koe plays');
});
