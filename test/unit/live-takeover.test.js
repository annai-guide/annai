import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, off, LA, MONTEREY } from './live-kit.js';
import { followDrive, followPlay, askIn } from '../../src/ui/today.js';
import { Live } from '../../src/core/live/live.js';
import { startTab } from '../../src/ui/screens/plan.js';

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

/** Driving's reload: main.js's order, the shell starting while live mode still reads its rows. shown: the trip as the screen reads it, then each move told. @param {any} k */
async function onDriving(k) {
  await k.settle();
  k.live.dispose();
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, keep: k.keep, timeZone: () => LA });
  k.live = live;
  const started = live.start();
  const shown = [live.play];
  followPlay(live, () => live.play, () => shown.push(live.play));
  const s = shell(live);
  await started;
  s.seed();
  await live.settled();
  return { shown, s };
}

test("a reload on Driving with a quick chat open: it's told the trip in play once the rows load", async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  const { shown } = await onDriving(k);
  assert.deepEqual(shown, [chat, k.trip]);
});

test('a reload on Driving with nothing open: the same, from no trip', async () => {
  const k = await liveKit();
  k.agent.opened(null);
  const { shown } = await onDriving(k);
  assert.deepEqual(shown, [null, k.trip]);
});

test("that telling takes nobody over: a reload moving fast with a quick chat open stays where it was", async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.drive(A, B, at('09:00'), at('09:05'));
  const { shown, s } = await onDriving(k);
  assert.deepEqual(shown, [chat, k.trip]);
  await k.fix(at('09:05:10'), off(A, 0, -6100), { speed: 20 });
  assert.deepEqual(s.went, []);
});

test('midnight with GPS off: a trip starting today comes into play, and Driving is told with no fix to carry it', async () => {
  const k = await liveKit({ live: false, start: at('22:00', '2026-11-26') });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, chat);
  const moved = /** @type {(string | null)[]} */ ([]);
  followPlay(k.live, () => k.live.play, () => moved.push(k.live.play));
  await k.to(at('00:01'));
  assert.deepEqual(moved, [k.trip]);
});

test('a quick ask goes to the trip in play now, not the one the screen was drawn for', async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await onDriving(k);
  const sent = /** @type {any[]} */ ([]);
  const agent = Object.assign(k.agent, { open: async (/** @type {string} */ id) => k.agent.opened(id), send: (/** @type {string} */ text) => sent.push([text, k.agent.target]) });
  await askIn({ ws: k.ws, live: k.live, agent }, 'Fuel?');
  assert.deepEqual(sent, [['Fuel?', k.trip]]);
});

test("the Itinerary's redraw keeps the tab the user was on; a fresh entry, or a tab that is gone, opens today's", () => {
  const tabs = [{ key: '2026-11-26', rows: [1] }, { key: '2026-11-27', rows: [1] }, { key: '2026-11-28', rows: [] }, { key: '', rows: [1] }];
  assert.equal(startTab(tabs, '2026-11-27', null).key, '2026-11-27', 'fresh entry: today');
  assert.equal(startTab(tabs, '2026-11-27', '2026-11-26').key, '2026-11-26', 'redraw: the one the user had');
  assert.equal(startTab(tabs, '2026-11-27', '2026-11-28').key, '2026-11-28', 'an empty day too');
  assert.equal(startTab(tabs, '2026-11-27', '').key, '', 'No time yet');
  assert.equal(startTab(tabs, '2026-11-27', '2026-12-01').key, '2026-11-27', 'its day is gone: today');
  assert.equal(startTab(tabs, '2026-12-05', null).key, '2026-11-26', 'no today: the first with rows');
});
