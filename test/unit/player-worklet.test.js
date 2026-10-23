// The player worklet (src/plugins/voice-browser/player-worklet.js) run in Node, quantum by quantum, with its page side
// (workletStream): the cases a browser's timing rarely lands on (the pops-fix review). The browser suite live-player renders it
// for real, in Chromium and WebKit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = /** @type {any} */ (globalThis);
/** @type {any} */
let Player = null;
g.registerProcessor = (/** @type {string} */ _name, /** @type {any} */ cls) => { Player = cls; };
g.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage: (/** @type {any} */ m) => /** @type {any} */ (this).sent(m), close() {} };
  }
};
g.sampleRate = 48_000;
g.currentFrame = 0;
const worklet = '../../src/plugins/voice-browser/player-worklet.js'; // a worklet's script, no module to the type checker
await import(worklet);
const { workletStream } = await import('../../src/plugins/voice-browser/index.js');

/**
 * A worklet and its stream at rate: what the page posts reaches it before the next quantum, its reports reach the page
 * after the quantum. @param {number} [rate]
 */
function player(rate = 48_000) {
  g.sampleRate = rate;
  g.currentFrame = 0;
  const p = new Player({ processorOptions: { rate: 24_000 } });
  /** @type {any[]} */
  const inbox = [];
  /** @type {any[]} */
  const outbox = [];
  p.sent = (/** @type {any} */ m) => outbox.push(m);
  const node = { port: { onmessage: /** @type {any} */ (null), postMessage: (/** @type {any} */ m) => inbox.push(m), close() {} }, disconnect() {} };
  const s = workletStream(node, { rate: 24_000, sampleRate: rate, now: () => g.currentFrame / rate, running: Promise.resolve(true) });
  /** @type {number[]} */
  const out = [];
  let alive = true;
  const step = () => {
    for (const m of inbox.splice(0)) p.port.onmessage({ data: m });
    const buf = new Float32Array(128);
    if (alive) alive = p.process([], [[buf]]);
    out.push(...buf);
    g.currentFrame += 128;
    for (const m of outbox.splice(0)) node.port.onmessage?.({ data: m });
  };
  return { p, s, out, step, run: (/** @type {number} */ n) => { for (let i = 0; i < n; i++) step(); } };
}
/** A 440 Hz tone at half of full scale, n samples of 24 kHz from sample from. */
const tone = (/** @type {number} */ n, from = 0) => Int16Array.from({ length: n }, (_, i) => Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * (i + from)) / 24_000)));
/** The tone's own largest step at rate, and a fade's slope on it (1%). */
const own = (/** @type {number} */ rate) => 0.5 * ((2 * Math.PI * 440) / rate) * 1.01;
const largestStep = (/** @type {number[]} */ x, a = 1, b = x.length) => {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
const sounding = (/** @type {number[]} */ x, from = 0) => x.slice(from).filter((v) => Math.abs(v) > 1e-4).length;
const quanta = (/** @type {number} */ ms, rate = 48_000) => Math.ceil((ms * rate) / 1000 / 128);

for (const rate of [48_000, 44_100]) {
  test(`at ${rate} Hz, the last piece and the end, coming as it fades out running dry, are played, all of them (review 1)`, () => {
    for (let late = 0; late < 4; late++) {
      const k = player(rate);
      const pcm = tone(4855 + 2400);
      k.s.push(pcm.subarray(0, 4855));
      while (k.p.state !== 'play' || k.p.target !== 0) k.step(); // the dry fade began
      k.run(late);
      k.s.push(pcm.subarray(4855));
      k.s.end();
      k.run(quanta(400, rate));
      const all = Math.round((pcm.length * rate) / 24_000);
      assert.ok(sounding(k.out) >= all * 0.98, `${late} quanta into the fade: ${sounding(k.out)} frames of sound of ${all}`);
      assert.equal(k.p.state, 'done');
    }
  });

  test(`at ${rate} Hz, a stop with less left than its fade fades over what is left: no jump bigger than the sound's own (review 2)`, () => {
    for (const left of [100, 150, 190, 220, 250, 280, 320, 600]) {
      const k = player(rate);
      k.s.push(tone(4837));
      while (k.p.state !== 'play') k.step();
      while (k.p.written - k.p.pos > left) k.step();
      const from = k.out.length;
      k.s.stop();
      k.run(20);
      assert.ok(largestStep(k.out, from - 64) <= own(rate), `${left} samples left: jump ${largestStep(k.out, from - 64).toFixed(4)}`);
      assert.equal(k.p.state, 'done');
    }
  });
}

test('a piece that comes after it ran dry, waiting for its start buffer, stays queued until it has played: the microphone is deaf while it sounds (review 3)', () => {
  const k = player();
  k.s.push(tone(4800));
  while (!(k.p.state === 'wait' && k.p.dryAt >= 0)) k.step();
  k.run(5);
  assert.equal(k.s.queued(), 0, 'run dry: her sound has stopped');
  k.s.push(tone(2400, 4800));
  k.run(quanta(60)); // reports come while it waits for more
  assert.equal(k.s.queued(), 1);
  k.s.end();
  let unqueued = 0;
  for (let i = 0; i < quanta(300); i++) {
    const before = k.out.length;
    const queued = k.s.queued(); // as the quantum is made
    k.step();
    if (k.out.slice(before).some((v) => Math.abs(v) > 0.01) && queued === 0) unqueued++;
  }
  assert.equal(unqueued, 0, `${unqueued} quanta of her sound with nothing queued`);
});

test('the start buffer waits 250 ms at most: a short first piece, and a short one after running dry, play though nothing more comes (review 4)', () => {
  const k = player();
  k.s.push(tone(2400)); // 100 ms: short of the 150 it starts at
  k.run(quanta(240));
  assert.equal(k.p.state, 'wait');
  k.run(quanta(20));
  assert.equal(k.p.state, 'play', 'played 250 ms after it came');
  while (!(k.p.state === 'wait' && k.p.dryAt >= 0)) k.step();
  k.s.push(tone(2400, 2400));
  k.run(quanta(240));
  assert.equal(k.p.state, 'wait');
  k.run(quanta(20));
  assert.equal(k.p.state, 'play', 'played 250 ms after it came');
});

for (const rate of [48_000, 44_100]) {
  for (const pattern of ['steady', 'bursty']) {
    test(`at ${rate} Hz, 22 s of pieces coming ${pattern === 'steady' ? 'about 400 ms ahead' : 'in bursts of 3 s'} play as one sound: its buffer let go of and grown on the way`, () => {
      const k = player(rate);
      const sizes = [5760, 5760, 4800, 960, 3840, 5760, 3840, 10560, 13440, 7680, 2880, 11520, 7680, 13440, 8640, 12480, 10560, 960];
      const all = [...sizes, ...sizes, ...sizes, ...sizes];
      const pcm = tone(all.reduce((a, b) => a + b, 0));
      let fed = 0;
      let i = 0;
      let first = -1;
      while (k.p.state !== 'done') {
        const want = pattern === 'steady' ? 9600 : k.p.written - k.p.pos < 7200 ? 72_000 : 0;
        while (i < all.length && fed - k.p.pos < want) {
          k.s.push(pcm.subarray(fed, fed + all[i]));
          fed += all[i++];
        }
        if (i === all.length) k.s.end();
        const at = k.out.length;
        k.step();
        if (first < 0 && k.p.played > 0) first = at; // it starts at a quantum's first frame
      }
      const step = 24_000 / rate;
      const fade = Math.round(rate * 0.005);
      let worst = 0;
      for (let j = 0; j * step <= pcm.length - 2; j++) {
        const p = j * step;
        const n = Math.floor(p);
        const ideal = (pcm[n] + (pcm[n + 1] - pcm[n]) * (p - n)) / 0x8000;
        worst = Math.max(worst, Math.abs(k.out[first + j] - ideal * Math.min(1, j / fade)));
      }
      assert.ok(worst < 1e-6, `error ${worst}`);
      assert.equal(k.p.holes, 0);
    });
  }
}
