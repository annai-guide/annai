import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveInput } from '../../src/core/realtime/input.js';
import { StreamResampler } from '../../src/core/voice/pcm.js';
import { clip, quiet, cat, burst, room, RATE } from './voice-kit.js';

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

test('a sentence still going on when listening stops is ended, and nothing more is sent', async () => {
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
      assert.ok(parts.every((x, i) => Math.abs(x - whole[i]) <= 1e-3), `${from} in pieces of ${size}: the same samples`);
    }
    // A 440 Hz tone at half scale stays about half scale.
    const peak = Math.max(...whole.slice(200).map(Math.abs));
    assert.ok(peak > 0.45 && peak < 0.55, `${from}: peak ${peak}`);
  }
});

test('while Koe plays, a start needs 6 dB more over the floor', async () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const hiss = (/** @type {number} */ s) => Float32Array.from({ length: s * RATE }, () => rnd() * 0.001);
  /** A voice-like tone over the hiss: a in amplitude, rising and falling four times a second. @param {number} a */
  const voice = (a) => hiss(1).map((x, i) => x + a * (0.75 + 0.25 * Math.sin((2 * Math.PI * 4 * i) / RATE)) * Math.sin((2 * Math.PI * 1000 * i) / RATE));
  const starts = async (/** @type {number} */ a, /** @type {boolean} */ playing) => {
    const r = rig({ speaking: () => playing, duplex: () => true });
    await r.input.start();
    r.feed(cat(hiss(2), voice(a)), RATE);
    r.input.stop();
    return r.sent.includes('start');
  };
  assert.equal(await starts(0.002, false), true, 'about 12 dB over the hiss starts speech');
  assert.equal(await starts(0.002, true), false, 'but not while Koe plays');
  assert.equal(await starts(0.008, true), true, 'a louder voice cuts in while Koe plays');
  const off = rig({ speaking: () => true });
  await off.input.start();
  off.feed(cat(hiss(2), voice(0.05)), RATE);
  assert.ok(!off.sent.includes('start'), 'half-duplex (the phone speaker, or cutting in by voice off): nothing starts while Koe plays, however loud');
});

/**
 * Koe's voice from the phone's speaker, heard by its microphone (the iPhone trace, 2026-10-22: she cut herself off after a word or
 * two, ✂, every turn): 1 s of quiet, her voice (a speech clip) at gainDb re the clip as recorded while speaking() is true, 280 ms of
 * it after it stops, then quiet, and then, if given, the user's own words. Fed in the worklet's batches at 16 kHz.
 * @param {number} gainDb @param {{ after?: Float32Array, duplex?: boolean, tailMs?: number }} [o]
 */
async function echo(gainDb, { after, duplex = false, tailMs } = {}) {
  let playing = false;
  const r = rig({ speaking: () => playing, duplex: () => duplex, ...(tailMs === undefined ? {} : { tailMs }) });
  await r.input.start();
  const her = lunch.map((x) => x * 10 ** (gainDb / 20));
  // Her last 280 ms, heard after the player said it ended: the speaker's latency and the room's echo.
  const tail = her.slice(-Math.round(RATE * 0.28) - RATE / 2, -RATE / 2);
  const parts = /** @type {[Float32Array, boolean][]} */ ([[quiet(1), false], [her, true], [tail, false], [quiet(1), false], ...(after ? [[cat(after, quiet(1.5)), false]] : [])]);
  for (const [pcm, on] of /** @type {[Float32Array, boolean][]} */ (parts)) {
    playing = on;
    r.feed(pcm, RATE);
  }
  return r;
}

test('half-duplex: her own voice from the speaker, at -40 to 0 dB re speech, starts no turn while she plays nor in the 300 ms after', async () => {
  for (const g of [-40, -30, -20, -10, -6, 0]) {
    const r = await echo(g);
    // (Counted, not compared: a diff of the audio sent takes minutes to print.)
    assert.equal(r.sent.length, 0, `echo at ${g} dB: ${r.sent.filter((x) => typeof x === 'string').join(', ')} and ${Math.round(msOf(r.sent))} ms of sound left the phone`);
    r.input.stop();
  }
  const r = await echo(0, { tailMs: 0 });
  assert.equal(r.sent[0], 'start', 'with no time after her voice, its echo would start one');
});

test('half-duplex: the user speaking after her voice ends starts a turn, and nothing heard while she played goes with it (its pre-roll is dropped)', async () => {
  const r = await echo(0, { after: gas });
  assert.deepEqual(r.sent.filter((x) => typeof x === 'string'), ['start', 'end']);
  const ms = msOf(r.sent);
  const said = (gas.length / RATE) * 1000;
  assert.ok(ms > said && ms < said + 1400, `${ms} ms sent for ${said} ms of speech: none of her ${Math.round((lunch.length / RATE) * 1000)} ms`);
  r.input.stop();
});

test('full duplex (headphones or the car, with cutting in by voice on): the user speaking over her starts a turn', async () => {
  let playing = true;
  const r = rig({ speaking: () => playing, duplex: () => true });
  await r.input.start();
  r.feed(cat(quiet(1), lunch, quiet(1)), RATE);
  assert.equal(r.sent[0], 'start', 'the user cut in');
  playing = false;
  r.input.stop();
});

test('a click or a door slam leaves nothing: no activity and no audio, so no billed turn (review)', async () => {
  const r = rig();
  await r.input.start();
  r.feed(up3(cat(quiet(1), burst(0.12, 0.8), quiet(1.5), burst(0.2, 0.9), quiet(1.5))));
  assert.deepEqual(r.sent, [], 'nothing left the phone');
  // Speech after it is sent whole, its start included.
  r.feed(up3(cat(lunch, quiet(1.5))));
  assert.equal(r.sent[0], 'start');
  assert.equal(r.sent.at(-1), 'end');
  assert.ok(msOf(r.sent) > (lunch.length / RATE) * 1000, 'the whole sentence, not from where it was sure');
  r.input.stop();
});

test("given the session to send to, it sends at the session's rate: 8 kHz for one that takes G.711 (K6)", async () => {
  /** @type {(string | Uint8Array)[]} */
  const sent = [];
  /** @type {((pcm: Float32Array, rate: number) => void) | null} */
  let frames = null;
  const mic = { async open(/** @type {any} */ c) { frames = c.onFrames; return { close() {} }; } };
  const session = { audioIn: { format: 'pcmu', rate: 8000 }, activity: (/** @type {string} */ edge) => sent.push(edge), audio: (/** @type {Uint8Array} */ b) => sent.push(b) };
  const input = new LiveInput({ mic, send: session });
  await input.start();
  const pcm = up3(cat(quiet(2), lunch, quiet(2)));
  for (let i = 0; i < pcm.length; i += 2048) /** @type {any} */ (frames)(pcm.subarray(i, i + 2048), 48_000);
  const chunks = /** @type {Uint8Array[]} */ (sent.filter((x) => typeof x !== 'string'));
  assert.deepEqual([sent[0], sent.at(-1)], ['start', 'end']);
  assert.ok(chunks.slice(0, -1).every((c) => c.length === 1600), '100 ms chunks of 8 kHz PCM16');
  input.stop();
});

// voice-fix item 3 (the iPhone trace, 2026-10-22: "Listening" for 29 s after the user stopped): the investigation's zero-frame pattern.
test("near-silent frames from the microphone (60 ms of zeros every half second) don't keep a turn going: it ends at the user's pause", async () => {
  /** @type {any[]} */
  const turns = [];
  const r = rig({ onTurn: (/** @type {any} */ t) => turns.push(t) });
  await r.input.start();
  r.feed(room(40, lunch, (t) => t > 3 + lunch.length / RATE && t % 0.5 < 0.06), RATE);
  assert.deepEqual(r.sent.filter((x) => typeof x === 'string'), ['start', 'end']);
  const ms = msOf(r.sent);
  assert.ok(ms < (lunch.length / RATE) * 1000 + 1500, `${Math.round(ms)} ms sent for ${Math.round((lunch.length / RATE) * 1000)} ms of speech`);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].end, 'pause');
  r.input.stop();
});

test('a realtime turn is capped at about 15 s: speech that never pauses goes as turns of 15 s at most, each traced as capped', async () => {
  /** @type {any[]} */
  const turns = [];
  const r = rig({ onTurn: (/** @type {any} */ t) => turns.push(t) });
  await r.input.start();
  r.feed(cat(quiet(0.5), ...Array.from({ length: 10 }, () => cat(lunch, quiet(0.2), gas, quiet(0.2)))), RATE);
  r.input.stop();
  /** The ms of sound in each turn. */
  const each = [];
  let n = 0;
  for (const x of r.sent) {
    if (x === 'start') n = 0;
    else if (x === 'end') each.push(n);
    else if (typeof x !== 'string') n += (x.length / 2 / RATE) * 1000;
  }
  assert.ok(each.length >= 2, `${each.length} turns`);
  assert.ok(each.every((ms) => ms <= 15_500), each.map(Math.round).join(', '));
  assert.equal(turns[0].end, 'cap');
  assert.equal(turns.at(-1).end, 'close', 'what was still going when listening stopped');
});

test("each turn's end is traced as numbers only: why it ended, how long, the floor and the loudest frame in dB", async () => {
  /** @type {any[]} */
  const turns = [];
  const r = rig({ onTurn: (/** @type {any} */ t) => turns.push(t) });
  await r.input.start();
  r.feed(cat(quiet(1), lunch, quiet(1.5)), RATE);
  assert.equal(turns.length, 1);
  const [t] = turns;
  assert.deepEqual(Object.keys(t).sort(), ['end', 'floorDb', 'ms', 'peakDb']);
  assert.equal(t.end, 'pause');
  assert.ok(Number.isFinite(t.floorDb) && Number.isFinite(t.peakDb) && t.peakDb > t.floorDb + 30, JSON.stringify(t));
  assert.ok(t.ms > 1000 && t.ms < 4000, JSON.stringify(t));
  r.input.stop();
});

test('cut(): a turn the model has stopped transcribing ends now (traced so), and its sound after the cut must start a turn of its own over a floor learned again', async () => {
  /** @type {any[]} */
  const turns = [];
  const r = rig({ onTurn: (/** @type {any} */ t) => turns.push(t) });
  await r.input.start();
  r.feed(cat(quiet(1), lunch.subarray(0, lunch.length >> 1)), RATE);
  assert.equal(r.input.active, true);
  r.input.cut('transcript');
  assert.equal(r.input.active, false);
  assert.equal(r.sent.at(-1), 'end');
  assert.equal(turns[0].end, 'transcript');
  const n = r.sent.length;
  r.feed(quiet(2), RATE);
  assert.equal(r.sent.length, n, 'nothing while nobody speaks');
  r.input.cut('transcript'); // no turn: nothing
  assert.equal(r.sent.length, n);
  r.input.stop();
});
