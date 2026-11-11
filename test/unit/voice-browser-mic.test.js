// The microphone's open in the voice-browser plugin (drive-3 design, D4): an audio thread that never runs is found as the microphone
// opens, not when a reply's sound stalls. Web Audio is faked here: each context made either runs its worklets or doesn't, as a context
// whose state reads "running" with a dead audio thread doesn't (seen on an iPhone). The real worklet runs in the browser suite.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { browserPlatform } from '../../src/plugins/voice-browser/index.js';

/** The bound the plugin waits for a first frame, as its FIRST_FRAME_MS (STALL_MS). */
const FIRST_FRAME_MS = 1000;

/** Whether the nth context made runs its worklets; contexts past the list run as the last says. @type {boolean[]} */
let runs = [];
/** @type {any[]} */
let contexts = [];
/** @type {any[]} */
let nodes = [];
/** @type {any} */
let tracks = [];
const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode };

class FakeContext {
  constructor() {
    this.runs = runs[Math.min(contexts.length, runs.length - 1)];
    this.state = 'running'; // a dead one says running too
    this.currentTime = 0;
    this.sampleRate = 48_000;
    this.destination = { name: 'destination' };
    this.closed = false;
    /** @type {string[]} */
    this.modules = [];
    this.audioWorklet = { addModule: async (/** @type {string} */ url) => { this.modules.push(url.split('/').at(-1)); } };
    contexts.push(this);
  }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  createMediaStreamSource() { return { connect: (/** @type {any} */ n) => n, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect: (/** @type {any} */ n) => n, disconnect() {} }; }
}

class FakeWorkletNode {
  /** @param {FakeContext} ctx @param {string} name */
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
    this.disconnected = false;
    this.port = { /** @type {any} */ onmessage: null, postMessage() {}, close() {} };
    nodes.push(this);
    // A running audio thread calls process() within a few ms of the node's start: the worklet's first post.
    if (ctx.runs && name === 'annai-capture') setTimeout(() => this.port.onmessage?.({ data: 'ran' }), 3);
  }
  connect(/** @type {any} */ n) { return n; }
  disconnect() { this.disconnected = true; }
  /** The worklet's batch of samples, as it posts them. @param {Float32Array} pcm */
  post(pcm) { this.port.onmessage?.({ data: pcm }); }
}

beforeEach(() => {
  runs = [true];
  contexts = [];
  nodes = [];
  tracks = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          const track = { label: 'Mic', stopped: false, onended: null, stop() { track.stopped = true; }, getSettings: () => ({ deviceId: 'mic-1' }) };
          tracks.push(track);
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
      },
    },
  });
  /** @type {any} */ (globalThis).AudioContext = FakeContext;
  /** @type {any} */ (globalThis).AudioWorkletNode = FakeWorkletNode;
});

afterEach(() => {
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  /** @type {any} */ (globalThis).AudioContext = saved.AudioContext;
  /** @type {any} */ (globalThis).AudioWorkletNode = saved.AudioWorkletNode;
});

/** A platform whose opens are heard, as the Voice hears them for the Trace. */
function platform() {
  const p = browserPlatform();
  /** @type {{ firstFrameMs: number | null, renewed: boolean }[]} */
  const told = [];
  p.mic.onOpen?.((m) => told.push(m));
  /** @type {{ pcm: Float32Array, rate: number }[]} */
  const frames = [];
  const open = () => p.mic.open({ onFrames: (pcm, rate) => frames.push({ pcm, rate }), onError: () => {} });
  return { p, told, frames, open };
}

const captures = () => nodes.filter((n) => n.name === 'annai-capture');

test('a healthy open waits only for the worklet\'s first post, and says how long that took; the post itself is no frame', async () => {
  const { told, frames, open } = platform();
  const started = Date.now();
  const mic = await open();
  assert.ok(Date.now() - started < FIRST_FRAME_MS / 4, `opened in ${Date.now() - started} ms`);
  assert.equal(contexts.length, 1, 'no new context');
  assert.equal(told.length, 1);
  assert.equal(told[0].renewed, false);
  assert.equal(typeof told[0].firstFrameMs, 'number');
  assert.ok(/** @type {number} */ (told[0].firstFrameMs) < FIRST_FRAME_MS / 4, `firstFrameMs ${told[0].firstFrameMs}`);
  assert.deepEqual(frames, [], "the worklet's 'ran' is not sound");
  captures()[0].post(new Float32Array(2048));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rate, 48_000);
  mic.close();
});

test('an audio thread that never runs: the context is made anew once, in place, on the same stream, and the microphone opens on it', async () => {
  runs = [false, true];
  const { p, told, frames, open } = platform();
  const started = Date.now();
  const mic = await open();
  const took = Date.now() - started;
  assert.ok(took >= FIRST_FRAME_MS - 50 && took < 2 * FIRST_FRAME_MS, `opened after ${took} ms`);
  assert.equal(contexts.length, 2, 'one new context');
  assert.equal(contexts[0].closed, true, 'the dead one is closed');
  assert.equal(contexts[1].closed, false);
  assert.deepEqual(contexts[1].modules.sort(), ['capture-worklet.js', 'player-worklet.js'], 'both worklets load again on the new context');
  assert.equal(tracks.length, 1, 'the same stream: the microphone is not asked for again');
  assert.equal(tracks[0].stopped, false);
  assert.equal(told.length, 1);
  assert.equal(told[0].renewed, true);
  assert.equal(typeof told[0].firstFrameMs, 'number');
  const [dead, live] = captures();
  assert.equal(dead.port.onmessage, null, "the dead context's node is let go");
  assert.equal(dead.disconnected, true);
  live.post(new Float32Array(2048));
  assert.equal(frames.length, 1, 'what the new context hears reaches the detector');
  // The player's sound plays on the new context too, which output() reads.
  assert.equal(p.player.output?.()?.state, 'running');
  mic.close();
});

test('an audio thread that never runs, even on a context made anew: a stuck error within twice the bound, the stream let go', async () => {
  runs = [false];
  const { told, frames, open } = platform();
  const started = Date.now();
  await assert.rejects(open(), (/** @type {any} */ e) => e.stuck === true);
  const took = Date.now() - started;
  assert.ok(took < 2 * FIRST_FRAME_MS + 300, `gave up after ${took} ms`);
  assert.equal(contexts.length, 2, 'made anew once, not again');
  assert.equal(tracks[0].stopped, true, 'the microphone is let go');
  assert.deepEqual(told, [{ firstFrameMs: null, renewed: true }]);
  assert.deepEqual(frames, []);
});

test('output() gives the context\'s state and clock for the Trace, and a tap\'s fresh unlock makes the context anew as the open does', async () => {
  const { p, open } = platform();
  assert.equal(p.player.output?.(), null, 'no context yet');
  const mic = await open();
  contexts[0].currentTime = 12.34567;
  assert.deepEqual({ state: p.player.output?.()?.state, time: p.player.output?.()?.time }, { state: 'running', time: 12.346 });
  mic.close();
  await p.player.unlock({ fresh: true });
  assert.equal(contexts[0].closed, true);
  assert.equal(contexts.length, 2);
});
