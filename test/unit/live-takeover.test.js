import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, off, LA, MONTEREY } from './live-kit.js';
import { followDrive } from '../../src/ui/today.js';
import { Live } from '../../src/core/live/live.js';

const A = MONTEREY;
const B = off(MONTEREY, 0, -6000);
const C = off(MONTEREY, 0, -12_000);

/**
 * The shell's follower on a live engine, as the shell wires it: the user is on a screen Driving may leave, and goes back to it after each take-over.
 * @param {any} live @param {{ typing?: () => boolean }} [o]
 */
function shell(live, o = {}) {
  const went = /** @type {string[]} */ ([]);
  const seed = followDrive(live, { screens: () => [], hash: () => '#/talk', typing: o.typing ?? (() => false), trip: () => live.play, go: (to) => went.push(to) });
  return { went, seed };
}

test('one drive with a long light: the user went back to the conversation, and Driving does not take over again', async () => {
  const k = await liveKit();
  const s = shell(k.live);
  await k.drive(A, B, at('09:00'), at('09:05'));
  assert.deepEqual(s.went, ['#/drive']);
  await k.stay(B, at('09:05:05'), at('09:06:15'), 5); // a 70 s light
  await k.drive(B, C, at('09:06:20'), at('09:11'));
  assert.deepEqual(s.went, ['#/drive'], 'once');
});

test('typing as moving fast begins skips the take-over for that drive, and a light does not bring it back', async () => {
  const k = await liveKit();
  let typing = true;
  const s = shell(k.live, { typing: () => typing });
  await k.drive(A, B, at('09:00'), at('09:05'));
  typing = false;
  await k.stay(B, at('09:05:05'), at('09:06:15'), 5);
  await k.drive(B, C, at('09:06:20'), at('09:11'));
  assert.deepEqual(s.went, []);
});

test('a new drive, over 5 minutes after the last, takes over again', async () => {
  const k = await liveKit();
  const s = shell(k.live);
  await k.drive(A, B, at('09:00'), at('09:05'));
  await k.stay(B, at('09:05:05'), at('09:12'), 10);
  await k.drive(B, C, at('09:12:05'), at('09:17'));
  assert.deepEqual(s.went, ['#/drive', '#/drive']);
});

/** The page loads again on an address with a hash: the shell starts before live mode has restored the drive record. @param {any} k */
async function reloaded(k) {
  await k.settle();
  k.live.dispose();
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, keep: k.keep, timeZone: () => LA });
  k.live = live;
  const started = live.start();
  const s = shell(live); // main.js: startShell runs while start() is still reading its first record
  return { s, started, live };
}

test('a reload on a hash address, moving fast: the first fix takes nobody over', async () => {
  const k = await liveKit();
  await k.drive(A, B, at('09:00'), at('09:05'));
  const { s, started, live } = await reloaded(k);
  await started;
  s.seed();
  await live.settled();
  await k.fix(at('09:05:10'), off(A, 0, -6100), { speed: 20 });
  assert.deepEqual(s.went, []);
});

test('a reload at a long light, then driving off: the same drive, nobody taken over', async () => {
  const k = await liveKit();
  await k.drive(A, B, at('09:00'), at('09:05'));
  await k.stay(B, at('09:05:05'), at('09:06:15'), 5);
  const { s, started, live } = await reloaded(k);
  await started;
  s.seed();
  await live.settled();
  await k.drive(B, C, at('09:06:20'), at('09:11'));
  assert.deepEqual(s.went, []);
});
