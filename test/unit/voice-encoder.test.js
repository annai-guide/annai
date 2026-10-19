import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserPlatform } from '../../src/plugins/voice-browser/index.js';

const g = /** @type {any} */ (globalThis);

/**
 * A stand-in WebCodecs that encodes only Opus: a 20 ms packet (TOC 0x48) per 20 ms of input, and
 * an OpusHead description whose pre-skip is preSkip. hang: flush never settles (for every input, or
 * only for one longer than a tenth of a second).
 * @param {{ hang?: 'always' | 'long', preSkip?: number }} [o]
 */
function fakeCodecs({ hang, preSkip = 312 } = {}) {
  g.AudioData = class {
    /** @param {any} o */
    constructor(o) { this.numberOfFrames = o.numberOfFrames; }
    close() {}
  };
  g.AudioEncoder = class {
    /** @param {any} o */
    constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.frames = 0; this.c = /** @type {any} */ ({}); }
    /** @param {any} c */
    configure(c) {
      if (c.codec !== 'opus') throw new DOMException('Not here.', 'NotSupportedError');
      this.c = c;
      this.state = 'configured';
    }
    /** @param {any} d */
    encode(d) { this.frames += d.numberOfFrames; }
    flush() {
      if (hang === 'always' || (hang === 'long' && this.frames > this.c.sampleRate / 10)) return new Promise(() => {});
      const head = Uint8Array.from([...'OpusHead'].map((c) => c.charCodeAt(0)).concat([1, 1, preSkip & 0xff, preSkip >> 8, 0x80, 0x3e, 0, 0, 0, 0, 0]));
      for (let i = 0; i < Math.ceil(this.frames / (this.c.sampleRate * 0.02)); i++) {
        this.output({ byteLength: 3, copyTo: (/** @type {Uint8Array} */ b) => b.set([0x48, 1, 2]) }, i === 0 ? { decoderConfig: { description: head } } : undefined);
      }
      return Promise.resolve();
    }
    close() { this.state = 'closed'; }
  };
}
const unfake = () => {
  delete g.AudioEncoder;
  delete g.AudioData;
  delete g.MediaRecorder;
};
/** The OpusHead of an Ogg file's first page: its pre-skip. @param {Uint8Array} ogg */
const preSkipOf = (ogg) => ogg[27 + ogg[26] + 10] | (ogg[27 + ogg[26] + 11] << 8);

test('each codec is tried with a time limit: one whose trial never finishes is not made, and the answer still comes', async () => {
  fakeCodecs({ hang: 'always' });
  try {
    const started = Date.now();
    assert.deepEqual(await /** @type {any} */ (browserPlatform({ limitMs: 30 }).encoder).makes(), []);
    assert.ok(Date.now() - started < 1000, 'the trials run side by side, each with its limit');
  } finally {
    unfake();
  }
  fakeCodecs();
  try {
    assert.deepEqual(await /** @type {any} */ (browserPlatform({ limitMs: 30 }).encoder).makes(), ['ogg', 'webm']);
  } finally {
    unfake();
  }
});

test('an encode that never finishes fails within its limit (the segment goes in the next format, down to WAV), and its codec is offered no more', async () => {
  fakeCodecs({ hang: 'long' });
  try {
    const enc = /** @type {any} */ (browserPlatform({ limitMs: 30 }).encoder);
    assert.deepEqual(await enc.makes(), ['ogg', 'webm']);
    const pcm = new Int16Array(16_000);
    const started = Date.now();
    await assert.rejects(enc.encode(pcm, 16_000, 'ogg'), /took too long/);
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms: the limit grows with the length, a little`);
    const again = Date.now();
    await assert.rejects(enc.encode(pcm, 16_000, 'webm'), /took too long/);
    assert.ok(Date.now() - again < 100, 'its WebM fails at once: no second wait');
    assert.deepEqual(await enc.makes(), [], 'Opus is offered no more until annai restarts');
  } finally {
    unfake();
  }
});

test("Chromium's OpusHead gives its pre-skip at the input's rate (104 at 16 kHz): the file says it at 48 kHz, as RFC 7845 wants", async () => {
  for (const [given, written] of [[104, 312], [312, 312], [120, 120]]) {
    fakeCodecs({ preSkip: given });
    try {
      const enc = /** @type {any} */ (browserPlatform().encoder);
      await enc.makes();
      assert.equal(preSkipOf(await enc.encode(new Int16Array(3200), 16_000, 'ogg')), written, `given ${given}`);
    } finally {
      unfake();
    }
  }
});

test('MediaRecorder: AAC in MP4 by its codec, else plain audio/mp4 (in case iOS refuses the codec string), each format once', () => {
  for (const [supported, want] of /** @type {[string[], any[]][]} */ ([
    [['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'], [{ type: 'audio/mp4;codecs=mp4a.40.2', format: 'mp4' }]],
    [['audio/mp4'], [{ type: 'audio/mp4', format: 'mp4' }]],
    [['audio/webm;codecs=opus', 'audio/mp4'], [{ type: 'audio/webm;codecs=opus', format: 'webm' }, { type: 'audio/mp4', format: 'mp4' }]],
  ])) {
    g.MediaRecorder = { isTypeSupported: (/** @type {string} */ t) => supported.includes(t) };
    try {
      assert.deepEqual(/** @type {any} */ (browserPlatform().encoder).records(), want);
    } finally {
      unfake();
    }
  }
  assert.deepEqual(/** @type {any} */ (browserPlatform().encoder).records(), [], 'no MediaRecorder at all (WebKit on Linux)');
});
