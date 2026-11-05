import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, off, LA, MONTEREY } from './live-kit.js';
import { createTrip, SYS_DEVICE } from '../../src/core/scopes.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { TRIGGERS } from '../../src/core/live/triggers.js';

/** The drive's one record (the design's section 4): the scenarios of the third re-review, each through the real Live, tracker and triggers. */
const north = (/** @type {number} */ m) => off(MONTEREY, 0, -m);
const SPEED = 14;

/** Driving north from y metres at 14 m/s for secs, a fix every 5 s. @param {any} k @param {number} t0 @param {number} y0 @param {number} secs @returns {Promise<number>} where it got to */
async function road(k, t0, y0, secs) {
  let y = y0;
  for (let s = 0; s <= secs; s += 5) {
    await k.fix(t0 + s * 1000, north(y), { speed: SPEED });
    y += SPEED * 5;
  }
  return y;
}
/** @param {any} k */
const off_screen = async (k) => { k.sensors.visible(false); await k.settle(); };
/** @param {any} k */
const on_screen = async (k) => { k.sensors.visible(true); await k.settle(); };
/** @param {any} k */
const held = (k) => k.registry.list('activity').at(-1).held();
/** A "when moving fast starts" watch, and how many times it has fired. @param {any} k */
async function startsWatch(k) {
  const w = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'Off we go.' });
  return () => k.agent.wakes.filter((/** @type {any} */ x) => x.text.includes(w.id)).length;
}
const movedFired = (/** @type {any} */ k) => k.agent.wakes.filter((/** @type {any} */ x) => x.text.includes('travelled'));

test('locked over 3 minutes on the highway, unlocked at a red light: moving fast holds a minute from the first slow fix, and Auto voice with it', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  assert.equal(k.live.activity, 'moving-fast');
  await off_screen(k);
  await k.to(at('09:05'));
  await on_screen(k);
  const light = y + SPEED * 240;
  await k.fix(at('09:05:05'), north(light), { speed: 0 });
  assert.equal(k.live.activity, 'moving-fast', 'the first slow fix does not end it');
  assert.equal(held(k), true);
  await k.fix(at('09:05:45'), north(light), { speed: 0 });
  assert.equal(k.live.activity, 'moving-fast', 'a light of 40 s');
  await road(k, at('09:05:50'), light, 30);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(), 1);
});

test('locked 10 minutes on the highway, unlocked at a long light: no false "starts" on green, and Auto voice stays on', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await on_screen(k);
  const light = y + SPEED * 600;
  for (let s = 5; s <= 70; s += 5) await k.fix(at('09:11') + s * 1000, north(light), { speed: 0 });
  assert.equal(k.live.activity, 'still', 'over a minute at the light');
  assert.equal(held(k), true, 'Auto voice holds two minutes more');
  await road(k, at('09:12:15'), light, 45);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(), 1, 'it is the same drive');
});

test('unlocked with no fix for two minutes: moving fast ends then, not back when the phone locked; Auto voice holds, and green fires nothing', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:06'));
  await on_screen(k);
  await k.to(at('09:08:01'));
  assert.equal(k.live.activity, 'still');
  assert.equal(held(k), true, 'two minutes of quiet GPS is what ended it; voice holds from there');
  await road(k, at('09:08:30'), y + SPEED * 360, 45);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(), 1, 'moving fast ended under five minutes ago');
});

test('parked and locked, page alive: the way since the last fix is short, so the hold still dates from there and the first fix ends it', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:20'));
  await on_screen(k);
  await k.fix(at('09:20:05'), north(y + 100), { speed: 0 });
  assert.equal(k.live.activity, 'still');
  assert.equal(held(k), false);
});

test('a manual place is a jump: the next fix starts afresh, moving or parked, so no way is counted and no watch fires', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  const km = k.live.odometer;
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: 'Narrate.' });
  await k.live.place(off(MONTEREY, 80_000, 0));
  await road(k, at('09:01:10'), y, 30);
  assert.ok(k.live.odometer - km < 1, `moving: ${k.live.odometer - km} km added`);
  assert.equal(movedFired(k).length, 0);

  const p = await liveKit({ start: at('09:00') });
  await p.fix(at('09:00'), MONTEREY, { speed: 0 });
  await p.fix(at('09:00:10'), MONTEREY, { speed: 0 });
  await p.live.setWatch(p.trip, { when: { type: 'moved', km: 5 }, fallback: 'Narrate.' });
  await p.live.place(off(MONTEREY, 80_000, 0));
  await p.stay(MONTEREY, at('09:00:20'), at('09:01:30'));
  await road(p, at('09:01:40'), 0, 60);
  assert.ok(p.live.odometer < 1, `parked then off: ${p.live.odometer} km`);
  assert.equal(movedFired(p).length, 0);
  // Gone from the page before the next fix too.
  await p.live.place(off(MONTEREY, 80_000, 0));
  await p.reload();
  await p.fix(at('09:03'), north(900), { speed: 0 });
  assert.ok(p.live.odometer < 2, `over a reload: ${p.live.odometer} km`);
});

test('the odometer does not read the open trip: 30 km in trip B, trip A opened, the page gone before a fix: the first fix adds nothing', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.fix(at('09:00'), north(-5000), { speed: 0 }); // trip A's last point, far back
  const b = await createTrip(k.ws, { title: 'Trip B', start: '2026-11-27', end: '2026-11-28' });
  k.agent.opened(b);
  await k.settle();
  const y = await road(k, at('09:01'), 0, 2100); // 29.4 km
  const km = k.live.odometer;
  assert.ok(km > 25, `${km}`);
  await off_screen(k);
  k.agent.target = k.trip;
  await k.restart();
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: 'Narrate.' });
  await k.fix(at('09:37'), north(y), { speed: 0 });
  assert.ok(k.live.odometer - km < 0.2, `${k.live.odometer - km} km added while parked`);
  assert.equal(movedFired(k).length, 0);
});

test('"Me" open, killed, 18 km closed: the way counts at the first fix back', async () => {
  const k = await liveKit({ start: at('09:00') });
  k.agent.opened(null);
  await k.settle();
  await k.stay(MONTEREY, at('09:00'), at('09:00:30'));
  await off_screen(k);
  await k.restart();
  await k.to(at('09:30'));
  await k.fix(at('09:30'), north(18_000), { speed: 0 });
  assert.ok(Math.abs(k.live.odometer - 18) < 0.5, `${k.live.odometer} km`);
});

test('a ±1500 m fix is no place to count from, over a reload or not', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.fix(at('09:00'), MONTEREY, { speed: 0 });
  await k.fix(at('09:00:30'), off(MONTEREY, 1600, 0), { speed: 1, accuracy: 1500 });
  assert.ok((await k.events(['location'])).length >= 2, 'it was kept as the last point');
  await k.reload();
  await k.fix(at('09:01'), MONTEREY, { speed: 0 });
  assert.ok(k.live.odometer < 0.05, `after a good point: ${k.live.odometer} km`);

  const first = await liveKit({ start: at('09:00') });
  await first.fix(at('09:00'), off(MONTEREY, 1500, 0), { speed: 0, accuracy: 1500 });
  await first.reload();
  await first.fix(at('09:01'), MONTEREY, { speed: 0 });
  assert.ok(first.live.odometer < 0.05, `first of all: ${first.live.odometer} km`);
});

test('killed while locked 10 minutes on the road: the same drive at the first fix, one "starts", and Auto voice on at once; the way counts', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  assert.equal(count(), 1);
  await off_screen(k);
  await k.to(at('09:11'));
  await k.restart();
  assert.equal(k.live.activity, 'unknown', 'too old to say so before a fix');
  const there = y + SPEED * 600;
  await k.fix(at('09:11:05'), north(there), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast', 'the first fix');
  assert.equal(held(k), true);
  assert.ok(Math.abs(k.live.odometer - there / 1000) < 0.2, `${k.live.odometer} km`);
  await road(k, at('09:11:10'), there, 60);
  assert.equal(count(), 1);

  // At a light when it comes back: the same drive too, and the hold starts there.
  const l = await liveKit({ start: at('09:00') });
  const lights = await startsWatch(l);
  const z = await road(l, at('09:00'), 0, 60);
  await off_screen(l);
  await l.to(at('09:11'));
  await l.restart();
  await l.fix(at('09:11:05'), north(z + SPEED * 600), { speed: 0 });
  assert.equal(l.live.activity, 'moving-fast');
  await road(l, at('09:11:30'), z + SPEED * 600, 30);
  assert.equal(lights(), 1);
});

test('reloaded, locked again before a fix, unlocked at a light: the way from the record says the drive went on', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast');
  await off_screen(k);
  await k.to(at('09:07'));
  await on_screen(k);
  const light = y + SPEED * 360;
  await k.fix(at('09:07:05'), north(light), { speed: 0 });
  assert.equal(k.live.activity, 'moving-fast');
  await road(k, at('09:07:30'), light, 30);
  assert.equal(count(), 1);
});

test('killed while locked, but parked: the record says moving fast and the way says no, so nothing is restored and driving off later starts', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:40'));
  await k.restart();
  await k.fix(at('09:40:05'), north(y + 60), { speed: 0 });
  assert.equal(k.live.activity, 'unknown');
  assert.equal(held(k), false);
  await k.stay(north(y + 60), at('09:40:10'), at('09:41'));
  assert.equal(k.live.activity, 'still');
  await road(k, at('09:42'), y + 60, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(), 2);
});

test('moved says nothing of GPS on: the way counts at the next fix, however GPS was', () => {
  const moved = /** @type {any} */ (TRIGGERS.find((t) => t.type === 'moved'));
  assert.doesNotMatch(moved.summary, /GPS/);
});

test('the record: what it holds, written on each change, each km, the beat and going off screen; no position goes in the log', async () => {
  const k = await liveKit({ start: at('09:00') });
  assert.equal(k.keep.get(), null);
  await k.fix(at('09:00'), north(0), { speed: 14 });
  assert.equal(k.keep.get(), null, 'nothing to say yet');
  await road(k, at('09:00:05'), 0, 35); // moving fast
  const change = k.keep.get();
  assert.deepEqual(Object.keys(change).sort(), ['activity', 'at', 'ended', 'odo', 'odometer']);
  assert.deepEqual(Object.keys(change.odo).sort(), ['accuracy', 'at', 'lat', 'lng']);
  assert.equal(change.activity, 'moving-fast');
  assert.equal(change.ended, null);
  await road(k, at('09:00:45'), 500, 90); // over a km more
  assert.ok(k.keep.get().odometer >= 1, 'each km');
  assert.ok(k.keep.get().at > change.at);
  await k.to(at('09:08'));
  const beat = k.keep.get().at;
  await k.to(at('09:13:30'));
  assert.ok(k.keep.get().at > beat, 'the beat');
  const last = k.keep.get().at;
  await k.to(at('09:13:40'));
  await off_screen(k);
  assert.equal(k.keep.get().at, at('09:13:40'), 'going off screen');
  assert.ok(last < k.keep.get().at);
  for (const e of await k.events(['state'], SYS_DEVICE)) for (const key of ['lat', 'lng', 'odo']) assert.equal(key in e.data, false);
});

test('the record alone comes back: without it nothing does, whatever the state entries say; with it, whatever its age for the odometer and its place', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 200);
  await off_screen(k);
  const kept = k.keep.get();
  k.keep.set(null);
  await k.restart();
  assert.equal(k.live.odometer, 0, 'the state entries are evidence, nothing reads them back');
  assert.equal(k.live.activity, 'unknown');
  k.keep.set(kept);
  await k.restart();
  assert.ok(k.live.odometer > 2);
  assert.equal(k.live.activity, 'moving-fast');
  const km = k.live.odometer;
  k.live.dispose();
  await k.to(at('09:00') + 3 * 86_400_000);
  await k.restart();
  assert.equal(k.live.odometer, km, 'three days on');
  assert.equal(k.live.activity, 'unknown');
  await k.fix(at('09:00') + 3 * 86_400_000 + 5000, north(y + 2000), { speed: 0 });
  assert.ok(Math.abs(k.live.odometer - km - 2) < 0.2, `the place came back too: ${k.live.odometer - km} km`);
});

test('the first read of the activity already has the record: Voice has no moment before it, and nothing needs telling', async () => {
  const k = await liveKit({ start: at('09:00') });
  await road(k, at('09:00'), 0, 90);
  await off_screen(k);
  k.live.dispose();
  /** @type {boolean[]} */
  const read = [];
  const off1 = k.registry.onChange(() => {
    const s = k.registry.list('activity').at(-1);
    if (s && !read.length) read.push(s.held());
  });
  await k.restart();
  off1();
  assert.deepEqual(read, [true]);
});

test('a simulation leaves the record alone', async () => {
  const k = await liveKit({ start: at('09:00') });
  await road(k, at('09:00'), 0, 90);
  await off_screen(k);
  await on_screen(k);
  const kept = k.keep.get();
  const back = await k.live.simulate({ clock: new ManualClock(at('12:00')), timeZone: () => LA, trip: k.trip });
  await k.live.setLive(true);
  k.live.fixed({ lat: 1, lng: 1, accuracy: 8, speed: 20 });
  await k.settle();
  await back();
  assert.deepEqual(k.keep.get(), kept);
});
