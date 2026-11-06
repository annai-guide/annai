import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, off, LA, MONTEREY } from './live-kit.js';
import { createTrip, SYS_DEVICE } from '../../src/core/scopes.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { TRIGGERS } from '../../src/core/live/triggers.js';
import { NO_FIX_BACK_MS } from '../../src/core/live/activity.js';

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

test('locked over 3 minutes on the highway, unlocked at a red light: moving fast holds a minute from the first slow fix, and voice with it', async () => {
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

test('locked 10 minutes on the highway, unlocked at a long light: no false "starts" on green, and voice stays on', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await on_screen(k);
  const light = y + SPEED * 600;
  for (let s = 5; s <= 70; s += 5) await k.fix(at('09:11') + s * 1000, north(light), { speed: 0 });
  assert.equal(k.live.activity, 'still', 'over a minute at the light');
  assert.equal(held(k), true, 'voice holds two minutes more');
  await road(k, at('09:12:15'), light, 45);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(), 1, 'it is the same drive');
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

test('killed while locked 10 minutes on the road: the same drive at the first fix, one "starts", and voice on at once; the way counts', async () => {
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
  // A light is told from a parking by the first fix alone, which cannot be done: no false "starts" on green, but voice comes 30 s after green, not at the light.
  assert.notEqual(l.live.activity, 'moving-fast', 'no speed, no road yet');
  assert.equal(held(l), false);
  await road(l, at('09:11:30'), z + SPEED * 600, 30);
  assert.equal(l.live.activity, 'moving-fast');
  assert.equal(lights(), 1, 'green is not a start');
});

test('killed on the road, then parked and opened: whatever the way from the record says, voice stays off, nothing is restored, no "starts", and the stop that was missed fires once the parked fixes settle (the user, 2026-11-05)', async () => {
  // Parked a minute after 4 km of road in 11 minutes; 2 hours and 50 km on; a flight. Each averages over 18 km/h from the record's place.
  for (const [wait, away] of [[11 * 60_000, 4000], [2 * 3600_000, 50_000], [3600_000, 800_000]]) {
    const k = await liveKit({ start: at('09:00') });
    const starts = await startsWatch(k);
    const stops = await stopsWatch(k);
    await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: 'Narrate.' });
    const y = await road(k, at('09:00'), 0, 60);
    await off_screen(k);
    const back = at('09:01') + wait;
    await k.to(back);
    await k.restart();
    await k.fix(back + 5000, north(y + away), { speed: 0 });
    assert.notEqual(k.live.activity, 'moving-fast', `${away} m`);
    assert.equal(held(k), false, `voice stays off after ${away} m`);
    assert.equal(stops(), 0, `${away} m: not on one reading`);
    await k.stay(north(y + away), back + 10_000, back + 45_000);
    assert.equal(k.live.activity, 'still', `${away} m`);
    assert.equal(held(k), false, `voice stays off after ${away} m, so it is shown, not said`);
    assert.equal(stops(), 1, `${away} m: one late "stops"`);
    assert.equal(starts(), 1, `${away} m: the first drive's only`);
    await k.stay(north(y + away), back + 50_000, back + 300_000, 30);
    assert.equal(stops(), 1, `${away} m`);
  }
});

test('killed on the road, then reopened on the road with a speed: the same drive at the first fix, voice on, one "starts"', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:03'));
  await k.restart();
  await k.fix(at('09:03:05'), north(y + SPEED * 125), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  await road(k, at('09:03:10'), y + SPEED * 130, 30);
  assert.equal(count(), 1);
});

test('killed on the road, opened and gone before a good fix, then reopened on the road: the same drive, one "starts"', async () => {
  const k = await liveKit({ start: at('09:00') });
  const count = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await k.restart(); // opened, too old to say so, no fix
  await off_screen(k); // gone: the record must not say unknown now
  assert.equal(k.keep.get().activity, 'moving-fast');
  await k.to(at('09:11:40'));
  await k.restart(); // again, on the road
  await k.fix(at('09:11:45'), north(y + SPEED * 645), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  await road(k, at('09:11:50'), y + SPEED * 650, 30);
  assert.equal(count(), 1);
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
  assert.deepEqual(Object.keys(change).sort(), ['activity', 'at', 'due', 'ended', 'hushed', 'odo', 'odometer']);
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

// One false "stops" after a reload or unlock (the user left "accept" unticked, 2026-11-05): silence right after coming back says nothing of stopping.
/** A "when moving fast stops" watch, and how many times it has fired. @param {any} k */
async function stopsWatch(k) {
  const w = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', edge: 'stop' }, repeat: true, fallback: 'Pulled up.' });
  return () => k.agent.wakes.filter((/** @type {any} */ x) => x.text.includes(w.id)).length;
}

for (const locked of [3, 5, 10]) {
  for (const quiet of [120, 300]) {
    test(`locked ${locked} min on the road, unlocked, no fix for ${quiet} s, the road again with a first fix without speed: moving fast never flips, voice holds, no "stops", one "starts"`, async () => {
      const k = await liveKit({ start: at('09:00') });
      const starts = await startsWatch(k);
      const stops = await stopsWatch(k);
      const y = await road(k, at('09:00'), 0, 60);
      await off_screen(k);
      const back = at('09:01') + locked * 60_000;
      await k.to(back);
      await on_screen(k);
      for (let s = 30; s <= quiet; s += 30) {
        await k.to(back + s * 1000);
        assert.equal(k.live.activity, 'moving-fast', `${s} s after the unlock`);
        assert.equal(held(k), true, `voice, ${s} s after the unlock`);
      }
      const there = y + SPEED * (locked * 60 + quiet + 5);
      await k.fix(back + (quiet + 5) * 1000, north(there), { speed: null });
      assert.equal(k.live.activity, 'moving-fast', 'a first fix with no speed');
      await road(k, back + (quiet + 10) * 1000, there + SPEED * 5, 40);
      assert.equal(k.live.activity, 'moving-fast');
      assert.equal(held(k), true);
      assert.equal(stops(), 0);
      assert.equal(starts(), 1);
    });
  }
}

for (const quiet of [120, 300]) {
  test(`reloaded on the road (the record under 5 min old), no fix for ${quiet} s, the road again: moving fast never flips, voice holds, no "stops", one "starts"`, async () => {
    const k = await liveKit({ start: at('09:00') });
    const starts = await startsWatch(k);
    const stops = await stopsWatch(k);
    const y = await road(k, at('09:00'), 0, 60);
    await off_screen(k);
    await k.to(at('09:03'));
    await k.restart();
    assert.equal(k.live.activity, 'moving-fast');
    await k.to(at('09:03') + quiet * 1000);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    const there = y + SPEED * (120 + quiet + 5);
    await k.fix(at('09:03') + (quiet + 5) * 1000, north(there), { speed: null });
    await road(k, at('09:03') + (quiet + 10) * 1000, there + SPEED * 5, 40);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(stops(), 0);
    assert.equal(starts(), 1);
  });
}

test('killed on the road and reopened after 5 and 10 min, no fix for 120 and 300 s, the road again: too old to restore, so nothing can flip; one "starts", no "stops"', async () => {
  for (const killed of [5, 10]) {
    for (const quiet of [120, 300]) {
      const k = await liveKit({ start: at('09:00') });
      const starts = await startsWatch(k);
      const stops = await stopsWatch(k);
      const y = await road(k, at('09:00'), 0, 60);
      await off_screen(k);
      const back = at('09:01') + killed * 60_000;
      await k.to(back);
      await k.restart();
      await k.to(back + quiet * 1000);
      assert.equal(k.live.activity, 'unknown');
      const there = y + SPEED * (killed * 60 + quiet + 5);
      await k.fix(back + (quiet + 5) * 1000, north(there), { speed: SPEED });
      assert.equal(k.live.activity, 'moving-fast');
      await road(k, back + (quiet + 10) * 1000, there + SPEED * 5, 30);
      assert.equal(stops(), 0, `${killed} min, ${quiet} s`);
      assert.equal(starts(), 1, `${killed} min, ${quiet} s`);
    }
  }
});

test('a garage: unlocked with no fix at all, moving fast ends at the bound and dates from the last fix, voice goes with it, and "stops" fires once', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  await road(k, at('09:00'), 0, 60);
  const last = at('09:01');
  await off_screen(k);
  await k.to(at('09:04'));
  await on_screen(k);
  await k.to(at('09:04') + NO_FIX_BACK_MS - 1000);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.equal(stops(), 0);
  await k.to(at('09:04') + NO_FIX_BACK_MS);
  assert.equal(k.live.activity, 'still');
  assert.equal(held(k), false, 'it ended long ago: no two minutes more');
  assert.equal(stops(), 1);
  const ended = (await k.events(['state'], SYS_DEVICE)).map((e) => e.data.ended).filter((e) => e !== undefined).at(-1);
  assert.equal(ended, last + 60_000, 'a minute after the last fix, as a hold that dates from it');
  await k.to(at('09:04') + NO_FIX_BACK_MS + 600_000);
  assert.equal(stops(), 1);
});

test('the GPS dead past the bound on the road, then back: "stops" fires once at the bound (the user\'s pick), voice is on at the first fix and "starts" does not fire', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await startsWatch(k);
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:04'));
  await on_screen(k);
  await k.to(at('09:04') + NO_FIX_BACK_MS);
  assert.equal(stops(), 1);
  assert.equal(held(k), false, 'voice goes off at the bound');
  const back = at('09:04') + NO_FIX_BACK_MS + 30_000;
  const there = y + SPEED * (back - at('09:01')) / 1000;
  await k.fix(back, north(there), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  await road(k, back + 5000, there + SPEED * 5, 40);
  assert.equal(starts(), 1);
  assert.equal(stops(), 1);
});

test('reloaded with the record under 5 min old, then parked: a garage ends at the bound and dates from the last fix; a parked fix ends a minute on, and driving off later starts', async () => {
  const g = await liveKit({ start: at('09:00') });
  const gStops = await stopsWatch(g);
  await road(g, at('09:00'), 0, 60);
  await off_screen(g);
  await g.to(at('09:03'));
  await g.restart();
  await g.to(at('09:03') + NO_FIX_BACK_MS - 1000);
  assert.equal(g.live.activity, 'moving-fast');
  await g.to(at('09:03') + NO_FIX_BACK_MS);
  assert.equal(g.live.activity, 'still');
  assert.equal(held(g), false);
  assert.equal(gStops(), 1);

  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:03'));
  await k.restart();
  await k.stay(north(y + 60), at('09:03:05'), at('09:04:10'));
  assert.equal(k.live.activity, 'still', 'no fifteen minutes, and no five: the good fix decided');
});

test('after a reload or an unlock, one fix without a speed whose way is slow, then silence: moving fast ends 2 min on, not 15, and not at the bound', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:03'));
  await k.restart();
  await k.fix(at('09:03:05'), north(y + 40), { speed: null });
  await k.to(at('09:05:04'));
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:05:05'));
  assert.equal(k.live.activity, 'still');
});

test('cell-tower fixes after an unlock are no first good fix: two of them, however still they look, do not end moving fast', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:04'));
  await on_screen(k);
  for (const s of [5, 25, 45]) await k.fix(at('09:04') + s * 1000, north(y + 3000), { speed: null, accuracy: 3000 });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(stops(), 0);
  // And the bound does not move for them.
  await k.to(at('09:04') + NO_FIX_BACK_MS);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
});

// Fix pass 1 on the small follow-ups (2026-11-05): each through the real Live, tracker and triggers.
/** The activity sensor as Voice has it. @param {any} k */
const sensor = (k) => k.registry.list('activity').at(-1);
/** How many drive ends the page now running has told. @param {any} k */
function ends(k) {
  let n = 0;
  sensor(k).onDriveEnd(() => { n++; });
  return () => n;
}
/** Driving, locked, unlocked and no fix to the bound. @param {any} k @returns {Promise<{ y: number, bound: number }>} */
async function toBound(k) {
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:04'));
  await on_screen(k);
  const bound = at('09:04') + NO_FIX_BACK_MS;
  await k.to(bound);
  return { y, bound };
}

for (const [words, after] of /** @type {[string, number][]} */ ([['30 s', 30_000], ['over 5 minutes', 340_000]])) {
  test(`a bound end is written to the record: a reload ${words} after it restores nothing, no second "stops", no second drive end, voice not back on`, async () => {
    const k = await liveKit({ start: at('09:00') });
    const stops = await stopsWatch(k);
    const { y, bound } = await toBound(k);
    assert.equal(stops(), 1);
    assert.equal(k.keep.get().activity, 'still', 'the record says what the page says');
    await k.to(bound + after);
    await k.restart();
    const told = ends(k);
    assert.notEqual(k.live.activity, 'moving-fast');
    assert.equal(held(k), false);
    await k.fix(bound + after + 5000, north(y + 50), { speed: 0 });
    await k.to(bound + after + NO_FIX_BACK_MS + 60_000);
    assert.notEqual(k.live.activity, 'moving-fast');
    assert.equal(held(k), false);
    assert.equal(stops(), 1);
    assert.equal(told(), 0);
  });
}

test('GPS off while a first good fix is awaited writes unknown, after a bound end and after a kill; GPS on later, driving is a new drive', async () => {
  const b = await liveKit({ start: at('09:00') });
  const bStarts = await startsWatch(b);
  const { y, bound } = await toBound(b);
  await b.live.setLive(false);
  await b.settle();
  assert.equal(b.keep.get().activity, 'unknown');
  await b.to(bound + 3_600_000);
  await b.live.setLive(true);
  await b.settle();
  await road(b, bound + 3_600_000 + 5000, y + SPEED * 3600, 60);
  assert.equal(b.live.activity, 'moving-fast');
  assert.equal(bStarts(), 2, 'the old drive is over: this one starts');

  const k = await liveKit({ start: at('09:00') });
  await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await k.restart();
  assert.equal(k.keep.get().activity, 'moving-fast', 'a kill leaves the record until a good fix');
  await k.live.setLive(false);
  await k.settle();
  assert.equal(k.keep.get().activity, 'unknown');
});

test('voice off for this drive lasts past a bound end: the road at the next good fix leaves it off; a parked fix clears it', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  sensor(k).hush(true);
  await off_screen(k);
  await k.to(at('09:04'));
  await on_screen(k);
  const bound = at('09:04') + NO_FIX_BACK_MS;
  await k.to(bound + 30_000);
  assert.equal(k.live.activity, 'still');
  await k.fix(bound + 30_000, north(y + SPEED * (bound + 30_000 - at('09:01')) / 1000), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), false, 'voice stays off');

  const p = await liveKit({ start: at('09:00') });
  const z = await road(p, at('09:00'), 0, 60);
  sensor(p).hush(true);
  await off_screen(p);
  await p.to(at('09:04'));
  await on_screen(p);
  const end = at('09:04') + NO_FIX_BACK_MS;
  await p.to(end + 30_000);
  await p.fix(end + 30_000, north(z + 50), { speed: 0 });
  assert.equal(p.keep.get().hushed, false, 'written');
  await road(p, end + 3_600_000, z + 50, 60);
  assert.equal(p.live.activity, 'moving-fast');
  assert.equal(held(p), true, 'the next drive has its voice');
});

test('only time on screen counts: unlocked every 5 minutes with 20 s on screen each, GPS giving nothing, it ends after 330 s on screen in total', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  await road(k, at('09:00'), 0, 60);
  let t = at('09:01');
  for (let i = 0; i < 16; i++) { // 320 s on screen
    await off_screen(k);
    t += 280_000;
    await k.to(t);
    await on_screen(k);
    t += 20_000;
    await k.to(t);
    assert.equal(k.live.activity, 'moving-fast', `after ${(i + 1) * 20} s on screen`);
  }
  assert.equal(stops(), 0);
  await off_screen(k);
  t += 280_000;
  await k.to(t);
  await on_screen(k);
  await k.to(t + 9000);
  assert.equal(k.live.activity, 'moving-fast', '329 s');
  await k.to(t + 10_000);
  assert.equal(k.live.activity, 'still', '330 s');
  assert.equal(held(k), false);
  await k.to(t + 20_000); // it went into the catch-up, which waits for a fix
  assert.equal(stops(), 1);
});

test('a long lock between two short unlocks, with no fix, does not end it at once', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:04'));
  await on_screen(k);
  await k.to(at('09:04:20'));
  await off_screen(k);
  await k.to(at('10:04:20'));
  await on_screen(k);
  await k.settle();
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  await k.to(at('10:04:20') + NO_FIX_BACK_MS - 21_000);
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('10:04:20') + NO_FIX_BACK_MS - 20_000);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
});

test('a chain of reloads with no fix is bounded: the hold keeps the last evidence as the record\'s age, so the last reload under 5 minutes runs to the bound, at most 10.5 minutes on, with one "stops"', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await startsWatch(k);
  const stops = await stopsWatch(k);
  await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  const last = k.keep.get().at;
  for (const s of [100, 200, 299]) {
    await k.to(last + s * 1000);
    await k.reload();
    assert.equal(k.live.activity, 'moving-fast', `${s} s`);
    assert.equal(k.keep.get().at, last, 'going off screen on a hold is no evidence');
  }
  await k.to(last + (299 + 300) * 1000); // a beat in the hold is none either
  assert.equal(k.keep.get().at, last);
  await k.to(last + (299 + 329) * 1000);
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(last + (299 + 330) * 1000);
  assert.equal(k.live.activity, 'still');
  assert.equal(held(k), false);
  assert.equal(stops(), 1);
  assert.equal(starts(), 1);
});

test('reloads every minute with no fix: past 5 minutes from the last evidence nothing is restored, silently, however long it goes on; the road then is the same drive', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await startsWatch(k);
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  const last = k.keep.get().at;
  for (let s = 60; s <= 1200; s += 60) {
    await k.to(last + s * 1000);
    await k.reload();
    if (s >= 300) assert.equal(held(k), false, `${s} s`);
    else assert.equal(k.live.activity, 'moving-fast', `${s} s`);
  }
  assert.equal(stops(), 0);
  const there = y + SPEED * 1205;
  await k.fix(last + 1205 * 1000, north(there), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  await road(k, last + 1210 * 1000, there + SPEED * 5, 40);
  assert.equal(starts(), 1);
  assert.equal(stops(), 0);
});

test('voice off during a hold survives a reload: written with the record\'s age kept', async () => {
  const k = await liveKit({ start: at('09:00') });
  await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  const last = k.keep.get().at;
  await k.to(last + 60_000);
  await k.restart();
  assert.equal(held(k), true);
  sensor(k).hush(true);
  assert.equal(k.keep.get().hushed, true);
  assert.equal(k.keep.get().at, last);
  await k.to(last + 120_000);
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), false);
});

test('a false stop no longer: on the road, a reload, one good fix with no speed whose way says the drive went on, then silence: it holds to the bound, which dates from that fix', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:03'));
  await k.restart();
  const fixAt = at('09:03:05');
  const there = y + SPEED * 125;
  await k.fix(fixAt, north(there), { speed: null });
  await k.to(at('09:03:05') + 125_000);
  assert.equal(k.live.activity, 'moving-fast', '125 s of silence says nothing');
  assert.equal(stops(), 0);
  // The road again, with a speed: nothing happened.
  const r = await liveKit({ start: at('09:00') });
  const rStops = await stopsWatch(r);
  const ry = await road(r, at('09:00'), 0, 60);
  await off_screen(r);
  await r.to(at('09:03'));
  await r.restart();
  await r.fix(fixAt, north(there), { speed: null });
  await road(r, fixAt + 125_000, ry + SPEED * 250, 40);
  assert.equal(r.live.activity, 'moving-fast');
  assert.equal(rStops(), 0);
  // No more fixes at all: the same bound as with no fix, and "stops" once, moving fast having ended a minute after that fix.
  await k.to(at('09:03') + NO_FIX_BACK_MS - 1000);
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:03') + NO_FIX_BACK_MS);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
  const ended = (await k.events(['state'], SYS_DEVICE)).map((/** @type {any} */ e) => e.data.ended).filter((/** @type {any} */ e) => e !== undefined).at(-1);
  assert.equal(ended, fixAt + 60_000);
});

test('the GPS that never gives its own speed: no-speed fixes on the road past the bound work out a speed, so nothing stops', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:03'));
  await k.restart();
  let there = y + SPEED * 120;
  for (let s = 5; s <= 600; s += 5) await k.fix(at('09:03') + s * 1000, north(there += SPEED * 5), { speed: null });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(stops(), 0);
});

test('a first fix with no speed, killed on the road: it waits for the next good fix; that one fast: moving fast, nothing fires, voice never told an end', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await startsWatch(k);
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await k.restart();
  const told = ends(k);
  const there = y + SPEED * 605;
  await k.fix(at('09:11:05'), north(there), { speed: null });
  assert.equal(told(), 0, 'not yet');
  await k.to(at('09:11:30'));
  assert.equal(told(), 0, 'still not: there is no way to tell');
  assert.equal(k.keep.get().activity, 'moving-fast', 'the record waits too');
  await k.fix(at('09:11:35'), north(there + SPEED * 30), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  await road(k, at('09:11:40'), there + SPEED * 35, 40);
  assert.equal(told(), 0);
  assert.equal(starts(), 1);
  assert.equal(stops(), 0);
});

test('a first fix with no speed, killed, then parked with a way above 5 m/s: the next fix at speed 0 tells the end once, and "stops" waits for the readings to settle', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await k.restart();
  const told = ends(k);
  await k.fix(at('09:11:05'), north(y + 4000), { speed: null });
  assert.equal(told(), 0);
  await k.fix(at('09:11:10'), north(y + 4000), { speed: 0 });
  assert.equal(told(), 1);
  assert.equal(stops(), 0);
  await k.stay(north(y + 4000), at('09:11:15'), at('09:12:30'));
  assert.equal(told(), 1);
  assert.equal(stops(), 1, 'late, once (the user, 2026-11-05)');
  assert.equal(held(k), false);
});

test('a first fix with no speed whose way is slow decides at once: the end is told', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:40'));
  await k.restart();
  const told = ends(k);
  await k.fix(at('09:40:05'), north(y + 60), { speed: null });
  assert.equal(told(), 1);
});

test('killed, and a GPS that never gives its own speed: the tracker\'s speed decides, on the road and parked', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await startsWatch(k);
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:11'));
  await k.restart();
  const told = ends(k);
  let there = y + SPEED * 605;
  for (const s of [5, 25, 30]) await k.fix(at('09:11') + s * 1000, north(there += SPEED * (s === 5 ? 0 : 20)), { speed: null });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(told(), 0);
  assert.equal(starts(), 1);

  const p = await liveKit({ start: at('09:00') });
  const z = await road(p, at('09:00'), 0, 60);
  await off_screen(p);
  await p.to(at('09:11'));
  await p.restart();
  const pTold = ends(p);
  for (const s of [5, 25, 30]) await p.fix(at('09:11') + s * 1000, north(z + 4000), { speed: null });
  assert.notEqual(p.live.activity, 'moving-fast');
  assert.equal(pTold(), 1);
});

test('a bound end, and a first fix with no speed on the road: it waits, and the next good fix says the same drive, with no "starts"', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await startsWatch(k);
  const { y, bound } = await toBound(k);
  const there = y + SPEED * (bound + 30_000 - at('09:01')) / 1000;
  await k.fix(bound + 30_000, north(there), { speed: null });
  await k.fix(bound + 35_000, north(there + SPEED * 5), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  await road(k, bound + 40_000, there + SPEED * 10, 40);
  assert.equal(starts(), 1);
});

test('a light long enough to end moving fast, green, and a reload: the end under 2 minutes old is not told while the record says moving fast', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  await k.stay(north(y), at('09:01:05'), at('09:02:10'), 5);
  assert.equal(k.live.activity, 'still');
  await road(k, at('09:02:15'), y, 35);
  assert.equal(k.live.activity, 'moving-fast');
  sensor(k).hush(true);
  await off_screen(k);
  await k.to(at('09:03:00'));
  await k.restart();
  const told = ends(k);
  await k.to(at('09:04:30'));
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(told(), 0);
  assert.equal(k.keep.get().hushed, true, 'her off for this drive stays');
});

test('a no-speed fix just before the bound leaves voice its 2 minutes; the road in them is the same drive, and no end is told, whatever the GPS does next', async () => {
  const k = await liveKit({ start: at('09:00') });
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:03'));
  await k.restart();
  const told = ends(k);
  const bound = at('09:03') + NO_FIX_BACK_MS;
  const there = y + SPEED * 400;
  await k.fix(bound - 20_000, north(there), { speed: null });
  await k.to(bound);
  assert.equal(k.live.activity, 'still');
  assert.equal(held(k), true, 'it ended only now, as a stop does: the 2 minutes follow');
  await k.fix(bound + 10_000, north(there + SPEED * 30), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(bound + 240_000); // a tunnel, past what was its voice hold
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(told(), 0);
});

test('annai started off screen, with moving fast restored: only the time on screen counts towards the bound', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('09:02'));
  k.registry.add('test', 'sensor', { kind: 'visibility', start: (/** @type {(v: boolean) => void} */ emit) => { emit(false); return () => {}; } });
  await k.restart();
  assert.equal(k.live.shown, false);
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:12'));
  k.live.visible(true);
  await k.settle();
  await k.to(at('09:14'));
  assert.equal(k.live.activity, 'moving-fast', 'ten minutes off screen are no silence');
  assert.equal(stops(), 0);
});

/** A one-time "stops" watch, and how many times it has fired. @param {any} k */
async function stopOnce(k) {
  const w = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', edge: 'stop' }, fallback: 'You stopped.' });
  return () => k.agent.wakes.filter((/** @type {any} */ x) => x.text.includes(w.id)).length;
}
/** Driving, killed, reopened an hour later. @param {any} k @returns {Promise<number>} where the drive had got to */
async function killedAnHour(k) {
  const y = await road(k, at('09:00'), 0, 60);
  await off_screen(k);
  await k.to(at('10:00'));
  await k.restart();
  return y;
}

test('a one-time "stops" missed after a kill fires at the reopening, and not at the second drive\'s end; voice stays off, and "starts" does not fire', async () => {
  const k = await liveKit({ start: at('09:00') });
  const once = await stopOnce(k);
  const starts = await startsWatch(k);
  const y = await killedAnHour(k);
  const told = ends(k);
  assert.equal(once(), 0);
  for (let s = 0; s <= 120; s += 10) await k.fix(at('10:00') + s * 1000, north(y + 20_000), { speed: 0 });
  assert.equal(once(), 1, 'at the reopening');
  assert.equal(held(k), false);
  assert.equal(told(), 1, 'the drive end, once');
  assert.equal(starts(), 1);
  const z = await road(k, at('11:00'), y + 20_000, 120);
  await k.stay(north(z), at('11:10'), at('11:13'), 10);
  assert.equal(once(), 1, 'it went: the second drive has none');
  assert.equal(starts(), 2, 'the second drive starts');
});

test('killed and reopened on the road: nothing fires until the real stop, once', async () => {
  const k = await liveKit({ start: at('09:00') });
  const once = await stopOnce(k);
  const y = await killedAnHour(k);
  const there = y + SPEED * 3540;
  const z = await road(k, at('10:00:05'), there, 120);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(once(), 0);
  await k.stay(north(z), at('10:02:10'), at('10:04:10'), 5);
  assert.equal(k.live.activity, 'still');
  assert.equal(once(), 1);
});

test('a repeating "stops" after a kill: one firing late, then one for each real stop', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  const y = await killedAnHour(k);
  await k.stay(north(y + 20_000), at('10:00:05'), at('10:02'), 5);
  assert.equal(stops(), 1, 'late');
  const z = await road(k, at('11:00'), y + 20_000, 120);
  assert.equal(stops(), 1);
  await k.stay(north(z), at('11:02:05'), at('11:04:05'), 5);
  assert.equal(stops(), 2, 'the real stop');
});

test('after a kill and a reopening, a light under 30 s then the road: no firing, and the real stop has its one', async () => {
  const k = await liveKit({ start: at('09:00') });
  const once = await stopOnce(k);
  const y = await killedAnHour(k);
  const there = y + SPEED * 3540;
  await k.stay(north(there), at('10:00:05'), at('10:00:25'), 5);
  assert.equal(once(), 0);
  const z = await road(k, at('10:00:30'), there, 120);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(once(), 0);
  await k.stay(north(z), at('10:02:35'), at('10:04:35'), 5);
  assert.equal(once(), 1);
});

test('silence is no stop after a kill: a lone no-speed fix, then silence, fires nothing; a change from no fix leaves it owed', async () => {
  const k = await liveKit({ start: at('09:00') });
  const once = await stopOnce(k);
  const y = await killedAnHour(k);
  await k.fix(at('10:00:05'), north(y + 40), { speed: null });
  await k.to(at('10:10'));
  assert.equal(k.live.activity, 'still', 'two minutes of quiet read as still');
  assert.equal(once(), 0);
  // The next change a reading confirms says it, late.
  for (let s = 0; s <= 35; s += 5) await k.fix(at('10:10:05') + s * 1000, north(y + 40), { speed: 1 });
  assert.equal(k.live.activity, 'walking');
  assert.equal(once(), 1);
});

test('a bound end, then a reload: no second "stops", at once or on later parked fixes', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await stopsWatch(k);
  const { y, bound } = await toBound(k);
  assert.equal(stops(), 1);
  await k.to(bound + 400_000);
  await k.restart();
  await k.stay(north(y + 50), bound + 405_000, bound + 500_000, 5);
  assert.equal(stops(), 1);
});

test('GPS off after a kill forgets the stop that was owed: GPS on later and parked, nothing fires', async () => {
  const k = await liveKit({ start: at('09:00') });
  const once = await stopOnce(k);
  const y = await killedAnHour(k);
  await k.live.setLive(false);
  await k.settle();
  await k.to(at('10:30'));
  await k.live.setLive(true);
  await k.settle();
  await k.stay(north(y + 50), at('10:30:05'), at('10:32'), 5);
  assert.equal(k.live.activity, 'still');
  assert.equal(once(), 0);
});
