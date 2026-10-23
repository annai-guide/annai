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
      /** @param {any} m @param {any[]} [t] */
      postMessage(m, t = []) {
        posted.push(m);
        transfers.push(t);
      },
    },
    disconnect() { node.disconnected = true; },
    /** @param {Partial<import('../../src/plugins/voice-browser/index.js').Report>} r */
    report(r) {
      node.port.onmessage?.({ data: { frame: 0, played: 0, read: 0, written: 0, level: 0, playing: false, dry: false, done: false, holes: 0, holeFrames: 0, waited: 0, ...r } });
    },
  };
  return { node, posted, transfers };
}

/** A stream at 24 kHz into a 48 kHz context whose clock is clock.now (s). */
function stream() {
  const { node, posted, transfers } = fakeNode();
  const clock = { now: 0 };
  /** @type {number[]} */
  const levels = [];
  const s = workletStream(node, { rate: 24_000, sampleRate: 48_000, now: () => clock.now, onLevel: (x) => levels.push(x), running: Promise.resolve(true) });
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

test('queued() counts the pieces the worklet has not played past; run dry and faded out, none of what it had (its faded tail goes unplayed until more comes)', () => {
  const { s, node } = stream();
  s.push(new Int16Array(2400));
  s.push(new Int16Array(2400));
  s.push(new Int16Array(2400));
  assert.equal(s.queued(), 3, 'before any report: all of it is still to play');
  node.report({ read: 2399, written: 7200, playing: true });
  assert.equal(s.queued(), 3);
  node.report({ read: 2400, written: 7200, playing: true });
  assert.equal(s.queued(), 2);
  s.push(new Int16Array(2400)); // pushed as it ran dry: the report below is from before the worklet had it
  node.report({ read: 7156, written: 7200, dry: true });
  assert.equal(s.queued(), 1, 'a piece pushed after what it had stays queued');
  node.report({ read: 7300, written: 9600, playing: true });
  assert.equal(s.queued(), 1);
  node.report({ read: 9556, written: 9600, dry: true });
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
