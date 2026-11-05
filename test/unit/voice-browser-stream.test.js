// The stream player's page side (the pops investigation, 2026-10-23): what the player worklet reports, turned into queued(),
// playedMs, the glow and the per-reply numbers. The worklet itself is tested rendered, in the browser suite live-player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workletStream } from '../../src/plugins/voice-browser/index.js';

/** A player worklet's node, by its port: what was posted to it, and reports sent back. */
function fakeNode() {
  /** @type {any[]} */
  const posted = [];
  /** @type {any[][]} */
  const transfers = [];
  const node = {
    disconnected: false,
    port: {
      /** @type {((e: any) => void) | null} */
      onmessage: null,
      closed: false,
      close() { node.port.closed = true; },
      /** @param {any} m @param {any[]} [t] */
      postMessage(m, t = []) {
        posted.push(m);
        transfers.push(t);
      },
    },
    disconnect() { node.disconnected = true; },
    /** @param {Partial<import('../../src/plugins/voice-browser/index.js').Report>} r */
    report(r) {
      node.port.onmessage?.({ data: { frame: 0, played: 0, read: 0, had: 0, level: 0, playing: false, dry: false, done: false, holes: 0, holeFrames: 0, waited: 0, ...r } });
    },
  };
  return { node, posted, transfers };
}

/** A stream at 24 kHz into a 48 kHz context whose clock is clock.now (s). */
function stream(stallMs = 1000) {
  const { node, posted, transfers } = fakeNode();
  const clock = { now: 0 };
  /** @type {number[]} */
  const levels = [];
  const s = workletStream(node, { rate: 24_000, sampleRate: 48_000, now: () => clock.now, onLevel: (x) => levels.push(x), running: Promise.resolve(true), stallMs });
  return { s, node, posted, transfers, clock, levels };
}

test('each piece goes to the worklet as a copy of its own, transferred; the caller keeps theirs', () => {
  const { s, posted, transfers } = stream();
  const pcm = new Int16Array([1, 2, 3]);
  s.push(pcm);
  s.push(new Int16Array(0)); // nothing: not sent
  assert.equal(posted.length, 1);
  assert.deepEqual([...posted[0]], [1, 2, 3]);
  assert.notEqual(posted[0].buffer, pcm.buffer);
  assert.deepEqual(transfers[0], [posted[0].buffer]);
  assert.deepEqual([...pcm], [1, 2, 3]);
});

test('queued() counts the pieces the worklet has not played past; run dry and faded out, none of what it had as it began to fade, and every piece after (review 3)', () => {
  const { s, node } = stream();
  s.push(new Int16Array(2400));
  s.push(new Int16Array(2400));
  s.push(new Int16Array(2400));
  assert.equal(s.queued(), 3, 'before any report: all of it is still to play');
  node.report({ read: 2399, had: 7200, playing: true });
  assert.equal(s.queued(), 3);
  node.report({ read: 2400, had: 7200, playing: true });
  assert.equal(s.queued(), 2);
  s.push(new Int16Array(2400)); // it came as the last faded out: the worklet has it, waiting for its start buffer
  node.report({ read: 7156, had: 7200, dry: true });
  assert.equal(s.queued(), 1, 'what came after it ran dry stays queued, though the worklet has it');
  node.report({ read: 7300, had: 9600, playing: true });
  assert.equal(s.queued(), 1);
  node.report({ read: 9556, had: 9600, dry: true });
  assert.equal(s.queued(), 0);
  s.push(new Int16Array(2400));
  assert.equal(s.queued(), 1, 'a new piece is queued at once, before any report (the microphone is deaf from it on)');
});

test("the glow follows the reports' loudness (four times the RMS, at most 1), and goes to 0 when it is done", () => {
  const { s, node, levels } = stream();
  s.push(new Int16Array(4800));
  node.report({ level: 0.1, playing: true });
  node.report({ level: 0.5, playing: true });
  s.end();
  node.report({ done: true, played: 9600, read: 4800 });
  assert.deepEqual(levels.map((x) => Math.round(x * 100) / 100), [0.4, 1, 0]);
});

test("ended: done settles at the worklet's done report, with what it played and its numbers (holes, their ms, the start's wait), and the node is let go", async () => {
  const { s, node, posted } = stream();
  s.push(new Int16Array(4800));
  s.end();
  assert.equal(posted.at(-1), 'end');
  let settled = false;
  s.done.then(() => { settled = true; });
  node.report({ frame: 4800, played: 4800, read: 2400, playing: true });
  await Promise.resolve();
  assert.equal(settled, false);
  node.report({ frame: 12_000, played: 9600, read: 4800, done: true, holes: 1, holeFrames: 4800, waited: 1440 });
  assert.deepEqual(await s.done, { playedMs: 200, holes: 1, holeMs: 100, waitMs: 30, player: 'worklet' });
  assert.equal(node.disconnected, true);
  assert.equal(node.port.onmessage, null);
  assert.equal(node.port.closed, true);
  assert.equal(s.queued(), 0);
});

test('stop() fades it out and says at once how much was heard: the last report, and what has played since while it was playing', async () => {
  const { s, node, posted, clock } = stream();
  for (let i = 0; i < 10; i++) s.push(new Int16Array(2400)); // 1 s
  node.report({ frame: 24_000, played: 19_200, read: 9600, playing: true }); // 400 ms played as of 0.5 s
  clock.now = 0.53;
  const r = s.stop();
  assert.equal(posted.at(-1), 'stop');
  assert.equal(r.playedMs, 430);
  assert.deepEqual(await s.done, r, 'done says the same');
  assert.equal(s.stop(), r);
  s.push(new Int16Array(10));
  assert.equal(posted.at(-1), 'stop', 'nothing more goes to it after a stop');
  node.report({ done: true, played: 21_000, read: 10_500 });
  assert.equal(node.disconnected, true, 'let go once it has faded out');
  assert.deepEqual(await s.done, r);
});

test('stop() while it waits to start (or ran dry) adds nothing since; and never more than was pushed', () => {
  const a = stream();
  a.s.push(new Int16Array(2400));
  a.node.report({ frame: 4800, played: 0, playing: false });
  a.clock.now = 1;
  assert.equal(a.s.stop().playedMs, 0);
  const b = stream();
  b.s.push(new Int16Array(2400)); // 100 ms
  b.node.report({ frame: 0, played: 3840, read: 1920, playing: true });
  b.clock.now = 5;
  assert.equal(b.s.stop().playedMs, 100);
});

test("a sync's answer (the browser suite's handshake) is no report", () => {
  const { s, node } = stream();
  s.push(new Int16Array(2400));
  node.port.onmessage?.(/** @type {any} */ ({ data: { sync: 1 } }));
  assert.equal(s.queued(), 1);
});

test('started settles at the first report that it plays, after its start buffer: what goes with her sound starts there', async () => {
  const { s, node } = stream();
  let started = false;
  s.started?.then(() => { started = true; });
  s.push(new Int16Array(2400));
  node.report({ frame: 128 });
  await Promise.resolve();
  assert.equal(started, false, 'waiting for its start buffer');
  node.report({ frame: 256, playing: true });
  await Promise.resolve();
  assert.equal(started, true);
  s.stop();
});

test('a player that tells nothing for a while (a context suspended mid-reply) is stopped: done, stalled, what was heard kept, nothing queued (review 5)', async () => {
  const { s, node, posted, clock } = stream(60);
  s.push(new Int16Array(4800));
  node.report({ frame: 4800, played: 4800, read: 2400, playing: true });
  clock.now = 0.15; // the context's clock went on, but the worklet said nothing: no more of it is known to have played
  const r = await s.done;
  assert.equal(posted.at(-1), 'stop');
  assert.deepEqual([r.stalled, r.playedMs, s.queued()], [true, 100, 0]);
  assert.equal(node.disconnected, true);
});

test('stopped, it never stalls later: the watch ends with it, and the node is let go once the worklet is done, or after the stall time if it never says (follow-up 3)', async () => {
  const a = stream(30);
  a.s.push(new Int16Array(4800));
  const r = a.s.stop();
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(a.posted.filter((m) => m === 'stop').length, 1, 'one stop');
  assert.equal(r.stalled, undefined);
  assert.equal(a.node.disconnected, true, 'let go after the stall time');
  const b = stream(30);
  b.s.push(new Int16Array(4800));
  b.s.stop();
  b.node.report({ done: true, played: 100 });
  assert.equal(b.node.disconnected, true);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(b.posted.filter((m) => m === 'stop').length, 1);
});

test('started settles false on a stream stopped or ended before its sound started, so nobody waits for it forever (follow-up 4)', async () => {
  const a = stream();
  a.s.push(new Int16Array(2400));
  a.s.stop();
  assert.equal(await a.s.started, false);
  const b = stream();
  b.s.end();
  b.node.report({ done: true });
  assert.equal(await b.s.started, false);
  const c = stream();
  c.s.push(new Int16Array(2400));
  c.node.report({ playing: true });
  c.s.stop();
  assert.equal(await c.s.started, true);
});

test("a processor error stops it as a stall", async () => {
  const { s, node } = stream();
  s.push(new Int16Array(4800));
  /** @type {any} */ (node).onprocessorerror();
  assert.equal((await s.done).stalled, true);
});

test('the context\'s state as a stream ended goes with its numbers, for the Trace (a stuck context reads running: WebKit 217606)', async () => {
  const { node } = fakeNode();
  const s = workletStream(node, { rate: 24_000, sampleRate: 48_000, now: () => 0, running: Promise.resolve(true), stallMs: 20, state: () => 'running' });
  s.push(new Int16Array(240));
  const r = await s.done;
  assert.deepEqual([r.stalled, r.ctx], [true, 'running']);
});

/** The browser's audio, enough for the player's unlock and the microphone. */
function fakeAudioGlobals(/** @type {{ state?: string, resumes?: boolean, resumeMs?: number }} */ { state = 'running', resumes = true, resumeMs = 0 } = {}) {
  /** @type {any[]} */
  const contexts = [];
  const stopped = { tracks: 0 };
  const g = /** @type {any} */ (globalThis);
  const saved = { AudioContext: g.AudioContext, Audio: g.Audio, AudioWorkletNode: g.AudioWorkletNode };
  g.AudioContext = class {
    state = state;
    closed = false;
    audioWorklet = { addModule: async () => {} };
    destination = {};
    sampleRate = 48_000;
    constructor() { contexts.push(this); }
    resume() {
      if (!resumes) return new Promise(() => {});
      if (!resumeMs) return Promise.resolve();
      return new Promise((r) => { setTimeout(() => { this.state = 'running'; r(undefined); }, resumeMs); });
    }
    async close() { this.closed = true; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() { return {}; }, disconnect() {} }; }
  };
  /** @type {any[]} */
  const audios = [];
  g.Audio = class {
    paused = true;
    ended = false;
    sources = 0;
    constructor() { audios.push(this); }
    set src(_) { this.sources++; }
    canPlayType() { return ''; }
    async play() { this.paused = false; }
  };
  g.URL.createObjectURL ??= () => 'blob:fake';
  g.AudioWorkletNode = class { port = {}; connect(/** @type {any} */ x) { return x; } disconnect() {} };
  const track = { stop() { stopped.tracks++; }, getSettings: () => ({}) };
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } });
  return { contexts, stopped, audios, restore() {
    Object.assign(g, saved);
    delete /** @type {any} */ (globalThis.navigator).mediaDevices;
  } };
}

test('after sound got stuck, a tap makes a new context; an ordinary tap keeps the one it has', async (t) => {
  const { browserPlatform } = await import('../../src/plugins/voice-browser/index.js');
  const a = fakeAudioGlobals();
  t.after(a.restore);
  const p = browserPlatform();
  await p.player.unlock();
  await p.player.unlock();
  assert.equal(a.contexts.length, 1);
  await p.player.unlock({ fresh: true });
  assert.equal(a.contexts.length, 2);
  assert.equal(a.contexts[0].closed, true);
});

test('the microphone doesn\'t wait for ever on a resume that never settles (WebKit 281566): it says sound is stuck, and lets go of its tracks', async (t) => {
  const { browserPlatform } = await import('../../src/plugins/voice-browser/index.js');
  const a = fakeAudioGlobals({ state: 'suspended', resumes: false });
  t.after(a.restore);
  const p = browserPlatform();
  await assert.rejects(p.mic.open({ onFrames() {}, onError() {} }), (/** @type {any} */ e) => e.stuck === true && /stuck/.test(e.message));
  assert.equal(a.stopped.tracks, 1);
});

test('finding: a resume that takes 1.4 s and works opens the microphone: no false "stuck"', async (t) => {
  const { browserPlatform } = await import('../../src/plugins/voice-browser/index.js');
  const a = fakeAudioGlobals({ state: 'suspended', resumeMs: 1400 });
  t.after(a.restore);
  const p = browserPlatform();
  const session = await p.mic.open({ onFrames() {}, onError() {} });
  assert.equal(a.contexts[0].state, 'running');
  session.close();
});

test('a tap while a whole clip plays leaves it alone: no silent clip over her sentence, and sound is unlocked', async (t) => {
  const { browserPlatform } = await import('../../src/plugins/voice-browser/index.js');
  const a = fakeAudioGlobals();
  t.after(a.restore);
  const p = browserPlatform();
  await p.player.unlock();
  assert.equal(a.audios[0].sources, 1, 'the first: its silent clip');
  assert.equal(a.audios[0].paused, false);
  assert.equal(await p.player.unlock({ fresh: true }), true);
  assert.equal(a.audios[0].sources, 1, 'she goes on');
  assert.equal(a.contexts.length, 2, 'the stuck context is still made anew');
  a.audios[0].ended = true;
  await p.player.unlock();
  assert.equal(a.audios[0].sources, 2, 'one that ended takes the clip');
});
