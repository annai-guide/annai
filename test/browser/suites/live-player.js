import { browserPlatform } from '../../../src/plugins/voice-browser/index.js';

/** A piece of a live voice: ms of a tone, as 24 kHz 16-bit PCM. @param {number} [ms] */
const piece = (ms = 100) => Int16Array.from({ length: (24 * ms) | 0 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)));
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** A 440 Hz tone at half of full scale, n samples of 24 kHz 16-bit PCM. @param {number} n */
const tone = (n) => Int16Array.from({ length: n }, (_, i) => Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 24_000)));
/** Gemini's piece sizes (samples): a reply of the pops investigation's (questions-b-5), and questions-a-3's, which caught Chromium's doubled frame. */
const GEMINI = [5760, 5760, 4800, 960, 3840, 5760, 3840, 10560, 13440, 7680, 2880, 11520, 7680, 13440, 8640, 12480, 10560, 960];
const QUESTIONS_A_3 = [3360, 3840, 4800, 3840, 2880, 5760, 7680, 10560, 14400, 7680, 7680, 5760];
const sum = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0);
/** The frame the first push lands on: an offline context suspends at the end of a 128-frame quantum, the first one here. */
const START = 128;
/** The player's fades (player-worklet.js): in at the start, over 5 ms; and stop's, 12 ms. */
const fadeFrames = (/** @type {number} */ rate) => Math.round(rate * 0.005);

/**
 * The stream player rendered offline at rate, sample-exact: each push, end and stop at its time (s from frame START), the
 * context suspended there until the player worklet has taken it in.
 * @param {{ rate: number, seconds: number, pcm: Int16Array, sizes: number[], at?: number[], endAt?: number, stopAt?: number }} o
 */
async function render(o) {
  const off = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(o.seconds * o.rate), sampleRate: o.rate });
  const w = /** @type {any} */ (window);
  const { AudioContext: RealContext, AudioWorkletNode: RealNode } = w;
  /** @type {any[]} */
  const nodes = [];
  w.AudioContext = function () { return off; };
  w.AudioWorkletNode = class extends RealNode {
    /** @param {any[]} a */
    constructor(...a) {
      super(...a);
      nodes.push(this);
    }
  };
  try {
    const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
    for (let i = 0; !nodes.length; i++) {
      if (i > 500) throw new Error('no player worklet');
      await wait(10);
    }
    const port = nodes[0].port;
    let seq = 0;
    const sync = () => new Promise((resolve) => {
      const id = ++seq;
      /** @param {MessageEvent} e */
      const on = (e) => {
        if (e.data?.sync !== id) return;
        port.removeEventListener('message', on);
        resolve(undefined);
      };
      port.addEventListener('message', on);
      port.postMessage({ sync: id });
    });
    /** @type {Map<number, (() => void)[]>} */
    const at = new Map();
    const add = (/** @type {number} */ t, /** @type {() => void} */ fn) => {
      const f = START + Math.ceil((t * o.rate) / 128 - 1e-9) * 128;
      at.set(f, [...(at.get(f) ?? []), fn]);
    };
    let i0 = 0;
    o.sizes.forEach((n, k) => {
      const p = o.pcm.subarray(i0, i0 + n);
      i0 += n;
      add(o.at?.[k] ?? 0, () => s.push(p));
    });
    if (o.endAt !== undefined) add(o.endAt, () => s.end());
    if (o.stopAt !== undefined) add(o.stopAt, () => s.stop());
    for (const [f, fns] of at) {
      off.suspend(f / o.rate).then(async () => {
        for (const fn of fns) fn();
        await sync();
        off.resume();
      });
    }
    const out = (await off.startRendering()).getChannelData(0);
    return { out, stopFrame: o.stopAt === undefined ? -1 : START + Math.ceil((o.stopAt * o.rate) / 128 - 1e-9) * 128 };
  } finally {
    w.AudioContext = RealContext;
    w.AudioWorkletNode = RealNode;
  }
}

/** The same sound as one buffer, started at frame START: the browser's own resampling, with no piece edges. @param {number} rate @param {number} seconds @param {Int16Array} pcm */
async function single(rate, seconds, pcm) {
  const off = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(seconds * rate), sampleRate: rate });
  const buf = off.createBuffer(1, pcm.length, 24_000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start(START / rate);
  return (await off.startRendering()).getChannelData(0);
}

/** The tone with a slow wobble on it, so that no stretch of it repeats: where a stretch is in it says where it was played from. @param {number} n */
const wobble = (n) => Int16Array.from({ length: n }, (_, i) => Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 24_000) + 3000 * Math.sin(i / 37)));
/**
 * Where seg is in ref, every frame within 1e-4 (-1: nowhere). @param {Float32Array} seg @param {Float32Array} ref
 */
const placeIn = (seg, ref) => {
  for (let j = 0; j + seg.length <= ref.length; j++) {
    let k = 0;
    while (k < seg.length && Math.abs(seg[k] - ref[j + k]) <= 1e-4) k++;
    if (k === seg.length) return j;
  }
  return -1;
};

/** The largest one-frame jump in x[a..b). @param {Float32Array} x */
const largestStep = (x, a = 1, b = x.length) => {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
/** A fade's own slope on top of the tone's (they are a quarter turn apart): the step limit's 1%. */
const SLOPE = 1.01;

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  // The tests in real time share one player, as annai does: one context (WebKit stops running new ones past a few).
  const player = /** @type {any} */ (browserPlatform().player);

  for (const rate of [48_000, 44_100]) {
    for (const [name, sizes] of /** @type {[string, number[]][]} */ ([['Gemini-sized pieces', GEMINI], ["questions-a-3's pieces", QUESTIONS_A_3]])) {
      test(`at ${rate} Hz, a tone in ${name} is the same sound as in one buffer, within 1e-4 at every frame`, async () => {
        const pcm = tone(sum(sizes));
        const seconds = pcm.length / 24_000 + 0.1;
        const { out } = await render({ rate, seconds, pcm, sizes, endAt: 0 });
        const ref = await single(rate, seconds, pcm);
        const step = 24_000 / rate;
        const fade = fadeFrames(rate);
        let worst = 0;
        let where = 0;
        // Every frame it reads between two samples (the very last has none after it), with the fade in at its start.
        for (let k = 0; k * step <= pcm.length - 2; k++) {
          const e = Math.abs(out[START + k] - ref[START + k] * Math.min(1, k / fade));
          if (e > worst) [worst, where] = [e, k];
        }
        assert.ok(worst <= 1e-4, `error ${worst.toExponential(2)} at frame ${where} (${(where / rate).toFixed(4)} s)`);
        const after = START + Math.ceil(pcm.length / step) + 2;
        assert.ok(out.subarray(after).every((x) => x === 0), 'silent once played out');
      });
    }

    test(`at ${rate} Hz, a piece that comes late leaves silence, no jump bigger than the sound's own, and the sound goes on exactly where it left off`, async () => {
      const sizes = [4800, ...GEMINI.slice(1, 8)];
      const pcm = wobble(sum(sizes));
      // The first 200 ms at once, the rest 120 ms after they ran out.
      const late = 4800 / 24_000 + 0.12;
      const seconds = pcm.length / 24_000 + 0.5;
      const { out } = await render({ rate, seconds, pcm, sizes, at: [0, ...sizes.slice(1).map(() => late)], endAt: late });
      const ref = await single(rate, seconds, pcm);
      const own = largestStep(ref, START, START + Math.round(rate * 1.5));
      // Up to its last sample: end() plays to it, and the sound stops there, as the sound itself does.
      let last = out.length - 1;
      while (last > 0 && out[last] === 0) last--;
      const jump = largestStep(out, 1, last);
      assert.ok(jump <= own * SLOPE, `largest jump ${jump.toFixed(4)}, the sound's own ${own.toFixed(4)}`);
      let run = 0;
      let longest = 0;
      let after = 0;
      for (let i = START + 1000; i < START + Math.round(rate * 0.5); i++) {
        run = out[i] === 0 ? run + 1 : 0;
        if (run > longest) [longest, after] = [run, i + 1];
      }
      assert.ok(longest >= rate * 0.1, `silent for ${((longest / rate) * 1000).toFixed(0)} ms in between`);
      // Before the hole, as one buffer; after it, faded back in, the same from where it stopped.
      const fade = fadeFrames(rate);
      const step = 24_000 / rate;
      for (let k = 0; START + k < after - longest - fade - 128; k++) {
        assert.ok(Math.abs(out[START + k] - ref[START + k] * Math.min(1, k / fade)) <= 1e-4, `before the hole, frame ${k}`);
      }
      const from = after + fade + 1;
      const at = placeIn(out.subarray(from, last - 1), ref);
      assert.ok(at > START, 'after the hole, the same sound as one buffer at every frame');
      const playedBefore = after - longest - START; // frames of it played before the hole, the fade's last one silent
      assert.ok(Math.abs(at - (START + playedBefore + fade + 1)) <= 2, `it went on ${at - START - playedBefore - fade - 1} frames from where it stopped`);
      assert.ok(Math.abs(Math.round((last - 1 - from) * step) - (pcm.length - Math.round((at - START) * step))) <= 3, 'and played to its end');
    });

    for (const [how, arrives] of /** @type {[string, (t: number) => number][]} */ ([
      ['about 400 ms ahead', (t) => Math.max(0, t - 0.4)],
      ['in bursts of 3 s', (t) => Math.max(0, Math.floor(t / 3) * 3 - 0.3)],
    ])) {
      test(`at ${rate} Hz, 22 s of Gemini-sized pieces coming ${how} as it plays are the same sound as one buffer at every frame (its buffer let go of, and grown, on the way)`, async () => {
        const sizes = [...GEMINI, ...GEMINI, ...GEMINI, ...GEMINI];
        const pcm = wobble(sum(sizes));
        let t = 0;
        const at = sizes.map((n) => {
          const a = arrives(t / 24_000);
          t += n;
          return a;
        });
        const seconds = pcm.length / 24_000 + 0.2;
        const { out } = await render({ rate, seconds, pcm, sizes, at, endAt: at.at(-1) });
        const ref = await single(rate, seconds, pcm);
        const step = 24_000 / rate;
        const fade = fadeFrames(rate);
        let worst = 0;
        let where = 0;
        for (let k = 0; k * step <= pcm.length - 2; k++) {
          const e = Math.abs(out[START + k] - ref[START + k] * Math.min(1, k / fade));
          if (e > worst) [worst, where] = [e, k];
        }
        assert.ok(worst <= 1e-4, `error ${worst.toExponential(2)} at ${(where / rate).toFixed(4)} s`);
      });
    }

    test(`at ${rate} Hz, the last piece and the end, coming as it fades out running dry, all play (review 1)`, async () => {
      const first = 4855;
      const pcm = tone(first + 2400);
      const step = 24_000 / rate;
      // The quantum its dry fade begins in: what is left falls under what a fade and a quantum take (player-worklet.js's low).
      const low = (fadeFrames(rate) + 128) * step + 2;
      let m = 0;
      while (first - m * 128 * step >= low) m++;
      const all = Math.round((pcm.length * rate) / 24_000);
      for (const q of [m - 1, m, m + 1, m + 2]) {
        const t = (q * 128) / rate;
        const { out } = await render({ rate, seconds: 0.6, pcm, sizes: [first, 2400], at: [0, t], endAt: t });
        let sound = 0;
        for (const x of out) if (Math.abs(x) > 1e-4) sound++;
        assert.ok(sound >= all * 0.98, `${q - m} quanta into the fade: ${sound} frames of sound of ${all}`);
      }
    });

    test(`at ${rate} Hz, a stop with less left than its fade fades over what is left: no jump bigger than the sound's own (review 2)`, async () => {
      const n = 4837;
      const pcm = tone(n);
      const own = largestStep(await single(rate, 0.15, pcm), START);
      for (const leftMs of [4, 6, 8, 10, 12, 14, 20]) {
        const { out, stopFrame } = await render({ rate, seconds: 0.5, pcm, sizes: [n], stopAt: n / 24_000 - leftMs / 1000 });
        const jump = largestStep(out, stopFrame - 64);
        assert.ok(jump <= own * SLOPE, `${leftMs} ms left: largest jump ${jump.toFixed(4)}, the tone's own ${own.toFixed(4)}`);
      }
    });

    test(`at ${rate} Hz, stop() mid-sound fades: no jump bigger than the sound's own, and silent within 15 ms`, async () => {
      const pcm = tone(sum(GEMINI));
      const { out, stopFrame } = await render({ rate, seconds: 1.5, pcm, sizes: GEMINI, stopAt: 1 });
      const own = largestStep(await single(rate, 1, pcm));
      assert.ok(out.subarray(stopFrame - 64, stopFrame).some((x) => Math.abs(x) > 0.1), 'sounding as it stopped');
      const jump = largestStep(out, stopFrame - 64);
      assert.ok(jump <= own * SLOPE, `largest jump ${jump.toFixed(4)}, the tone's own ${own.toFixed(4)}`);
      const quiet = stopFrame + Math.ceil(rate * 0.015);
      assert.ok(out.subarray(quiet).every((x) => x === 0), 'silent 15 ms after the stop');
    });
  }

  test('pieces pushed in a burst play back to back: five of 100 ms take about half a second, and their loudness reaches the glow', async () => {
    /** @type {number[]} */
    const levels = [];
    const s = player.stream({ rate: 24_000, onLevel: (/** @type {number} */ x) => levels.push(x) });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) s.push(piece());
    s.end();
    const r = await s.done;
    const took = performance.now() - t0;
    assert.ok(Math.abs(r.playedMs - 500) < 40, `played ${r.playedMs} ms`);
    assert.ok(took > 440 && took < 2000, `took ${took} ms`);
    assert.ok(levels.some((x) => x > 0.3), `levels ${levels.slice(0, 6).join(', ')}`);
    assert.equal(levels.at(-1), 0);
    assert.equal(r.player, 'worklet');
    assert.equal(r.holes, 0);
  });

  test('pieces that come slower than they play all play; only sound counts as played, and the holes are counted', async () => {
    const s = player.stream({ rate: 24_000 });
    // The first waits (100 ms is short of the 150 it starts at), plays with the second, and runs dry long before the third.
    for (let i = 0; i < 3; i++) {
      s.push(piece());
      await wait(350);
    }
    s.end();
    const r = await s.done;
    assert.ok(Math.abs(r.playedMs - 300) < 40, `played ${r.playedMs} ms`);
    assert.ok(r.holes >= 1 && r.holeMs > 0, `holes ${r.holes}, ${r.holeMs} ms`);
  });

  test("a stream whose end comes after its sound has played out (Gemini's turn end comes after its last audio) is done, with no hole", async () => {
    const s = player.stream({ rate: 24_000 });
    s.push(piece(300));
    await wait(700);
    assert.equal(s.queued(), 0);
    s.end();
    const r = await s.done;
    assert.ok(Math.abs(r.playedMs - 300) < 40, `played ${r.playedMs} ms`);
    assert.equal(r.holes, 0);
  });

  test('stop() says how much was heard (the rendered tests show it silent within 15 ms)', async () => {
    const s = player.stream({ rate: 24_000 });
    for (let i = 0; i < 20; i++) s.push(piece());
    await wait(400);
    const { playedMs } = s.stop();
    assert.ok(playedMs > 200 && playedMs < 700, `played ${playedMs} ms of 2000`);
    assert.equal((await s.done).playedMs, playedMs);
    s.push(piece()); // after a stop, nothing more plays
  });

  test('a stream ended with nothing in it is done at once, having played nothing', async () => {
    const s = player.stream({ rate: 24_000 });
    s.end();
    assert.equal((await s.done).playedMs, 0);
  });

  test('a long stream keeps only what is still to play: pieces already heard are let go (review)', async () => {
    const s = player.stream({ rate: 24_000 });
    let most = 0;
    for (let i = 0; i < 40; i++) {
      s.push(piece(50));
      most = Math.max(most, s.queued());
      await wait(45);
    }
    s.end();
    const { playedMs } = await s.done;
    assert.ok(most < 10, `at most ${most} pieces kept of 40`);
    assert.equal(s.queued(), 0);
    assert.ok(Math.abs(playedMs - 2000) < 60, `played ${playedMs} ms of 2000`);
  });

  /**
   * Five pieces of 100 ms on the player that schedules a buffer a piece, rendered offline (WebKit runs only a few contexts in
   * real time). @param {() => () => void} without what takes the worklet away, giving its undo
   */
  const fallback = async (without) => {
    const undo = without();
    const w = /** @type {any} */ (window);
    const real = w.AudioContext;
    const off = new OfflineAudioContext({ numberOfChannels: 1, length: 48_000, sampleRate: 48_000 });
    w.AudioContext = function () { return off; };
    try {
      const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
      for (let i = 0; i < 5; i++) s.push(piece());
      s.end();
      await wait(100); // the worklet known to be out of reach: the pieces go to the buffers
      const out = (await off.startRendering()).getChannelData(0);
      const r = await s.done;
      assert.equal(r.player, 'buffers');
      assert.ok(Math.abs(r.playedMs - 500) < 60, `played ${r.playedMs} ms`);
      let sound = 0;
      for (const x of out) if (x !== 0) sound++;
      assert.ok(Math.abs(sound - 24_000) < 100, `${sound} frames of sound`);
    } finally {
      w.AudioContext = real;
      undo();
    }
  };

  test('where AudioWorklet is missing, the stream plays on buffers', () => fallback(() => {
    const w = /** @type {any} */ (window);
    const real = w.AudioWorkletNode;
    w.AudioWorkletNode = undefined;
    return () => { w.AudioWorkletNode = real; };
  }));

  test("where the player worklet's module doesn't load, the stream plays on buffers", () => fallback(() => {
    const proto = /** @type {any} */ (AudioWorklet.prototype);
    const real = proto.addModule;
    proto.addModule = () => Promise.reject(new Error('refused'));
    return () => { proto.addModule = real; };
  }));

  test('a stream on buffers made while its context has not run yet (still resuming) waits for it: not stalled, all of it played (follow-up 5)', async () => {
    const w = /** @type {any} */ (window);
    const real = { context: w.AudioContext, node: w.AudioWorkletNode };
    const off = new OfflineAudioContext({ numberOfChannels: 1, length: 48_000, sampleRate: 48_000 });
    w.AudioContext = function () { return off; };
    w.AudioWorkletNode = undefined;
    try {
      const s = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
      for (let i = 0; i < 5; i++) s.push(piece());
      s.end();
      await wait(1300); // its clock stands still, but it never ran
      await off.startRendering();
      const r = await s.done;
      assert.equal(r.stalled, undefined);
      assert.ok(Math.abs(r.playedMs - 500) < 60, `played ${r.playedMs} ms`);
      assert.equal(await s.started, true);
    } finally {
      w.AudioContext = real.context;
      w.AudioWorkletNode = real.node;
    }
  });

  test('started is false for a stream stopped before its sound started, its player known or still loading (follow-up 4)', async () => {
    const known = player.stream({ rate: 24_000 });
    known.push(piece());
    known.stop();
    assert.equal(await known.started, false);
    const w = /** @type {any} */ (window);
    const real = w.AudioContext;
    w.AudioContext = function () { return new OfflineAudioContext({ numberOfChannels: 1, length: 4800, sampleRate: 48_000 }); };
    try {
      const loading = /** @type {any} */ (browserPlatform().player).stream({ rate: 24_000 });
      loading.push(piece());
      loading.stop();
      assert.equal(await loading.started, false);
    } finally {
      w.AudioContext = real;
    }
  });

  test("a module load that hangs gives up after 1.5 s, the stream on buffers; the next stream tries again, and plays on the worklet (review 5)", async () => {
    const w = /** @type {any} */ (window);
    const proto = /** @type {any} */ (AudioWorklet.prototype);
    const real = { context: w.AudioContext, addModule: proto.addModule };
    const off = new OfflineAudioContext({ numberOfChannels: 1, length: 48_000, sampleRate: 48_000 });
    w.AudioContext = function () { return off; };
    proto.addModule = () => new Promise(() => {});
    try {
      const p = /** @type {any} */ (browserPlatform().player);
      const first = p.stream({ rate: 24_000 });
      first.push(piece());
      first.end();
      await wait(1700); // past the 1.5 s the module may take: on buffers
      proto.addModule = real.addModule;
      const second = p.stream({ rate: 24_000 });
      second.push(piece());
      second.end();
      await wait(300); // its module loads
      await off.startRendering();
      assert.equal((await first.done).player, 'buffers');
      assert.equal((await second.done).player, 'worklet');
    } finally {
      w.AudioContext = real.context;
      proto.addModule = real.addModule;
    }
  });
}
