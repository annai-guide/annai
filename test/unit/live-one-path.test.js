import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, off, MONTEREY } from './live-kit.js';
import { NO_FIX_BACK_MS, NO_FIX_STILL_MS, QUIET_STILL_MS } from '../../src/core/live/activity.js';

/**
 * One path for every gap in evidence (restore, heard and the bound): the contract's lines and the findings that led to it, each
 * through the real Live, tracker and triggers. F-numbers are the re-review's findings; R, K, A and V are the contract's lines.
 */
const north = (/** @type {number} */ m) => off(MONTEREY, 0, -m);
const SPEED = 14;
/** Metres from the record to a place reached an hour later: the way says it went on (5.6 m/s). */
const FAR = 20_000;
/** …and to one where the way says it did not. */
const NEAR = 2_000;

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
const hide = async (k) => { k.sensors.visible(false); await k.settle(); };
/** @param {any} k */
const show = async (k) => { k.sensors.visible(true); await k.settle(); };
/** @param {any} k */
const sensor = (k) => k.registry.list('activity').at(-1);
/** @param {any} k */
const held = (k) => sensor(k).held();
/** "When moving fast stops" or "starts", repeating, and how many times it has fired. @param {any} k @param {'stop' | 'start'} edge */
async function watch(k, edge) {
  const w = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', ...(edge === 'stop' ? { edge } : {}) }, repeat: true, fallback: 'x' });
  return () => k.agent.wakes.filter((/** @type {any} */ x) => x.text.includes(w.id)).length;
}
/** How many times voice has been told the drive ended. @param {any} k */
function ends(k) {
  let n = 0;
  sensor(k).onDriveEnd(() => { n++; });
  return () => n;
}
/** A minute of driving, with a "stops" and a "starts" watch set; "starts" counts from here. */
async function driving() {
  const k = await liveKit({ start: at('09:00') });
  const stops = await watch(k, 'stop');
  const fired = await watch(k, 'start');
  const y = await road(k, at('09:00'), 0, 60);
  const first = fired();
  assert.equal(k.live.activity, 'moving-fast');
  return { k, stops, starts: () => fired() - first, y };
}
/** On the road, then the page killed while locked: the record is an hour old at the reopening. @param {string} [hhmm] */
async function killed(hhmm = '10:00') {
  const d = await driving();
  await hide(d.k);
  await d.k.to(at(hhmm));
  await d.k.restart();
  return { ...d, told: ends(d.k) };
}
/** Asks the activity at each step of a stretch of time: moving fast must never be shown. @param {any} k @param {number} until */
async function neverFast(k, until) {
  for (let t = k.clock.now() + 10_000; t <= until; t += 10_000) {
    await k.to(t);
    assert.notEqual(k.live.activity, 'moving-fast');
  }
}

// F1, R3: a reading whose way is too short to say

for (const acc of [30, 100]) {
  test(`F1: a reload, a no-speed first fix seconds after the last one at ±${acc} m, then 125 s of silence: moving fast holds, and voice`, async () => {
    const { k, stops, y } = await driving();
    await k.reload();
    const told = ends(k);
    const t = at('09:01:04');
    await k.fix(t, north(y - SPEED), { speed: null, accuracy: acc });
    await k.to(t + 125_000);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.equal(stops(), 0);
    assert.equal(told(), 0);
  });
}

test('F1: a reload and a burst of two no-speed fixes 2 s apart, then 125 s of silence: the same', async () => {
  const { k, stops, y } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  await k.restart();
  const told = ends(k);
  const t = at('09:03:05');
  const there = y + SPEED * 124;
  await k.fix(t, north(there), { speed: null, accuracy: 30 });
  await k.fix(t + 2000, north(there + SPEED * 2), { speed: null, accuracy: 30 });
  await k.to(t + 127_000);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.equal(stops(), 0);
  assert.equal(told(), 0);
});

// F2, R3: a GPS speed that #speedAt can't read

for (const acc of [51, 75, 100]) {
  test(`F2: a reload, a GPS speed at ±${acc} m, then silence: it can't say, so the hold goes on`, async () => {
    const { k, stops, y } = await driving();
    await hide(k);
    await k.to(at('09:03'));
    await k.restart();
    const told = ends(k);
    const t = at('09:03:05');
    await k.fix(t, north(y + SPEED * 124), { speed: SPEED, accuracy: acc });
    await k.to(t + 125_000);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.equal(stops(), 0);
    assert.equal(told(), 0);
  });

  test(`F2: an unlock, a GPS speed at ±${acc} m, then silence: the same`, async () => {
    const { k, stops, y } = await driving();
    const told = ends(k);
    await hide(k);
    await k.to(at('09:04'));
    await show(k);
    const t = at('09:04:05');
    await k.fix(t, north(y + SPEED * 184), { speed: SPEED, accuracy: acc });
    await k.to(t + 125_000);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.equal(stops(), 0);
    assert.equal(told(), 0);
  });

  test(`F2: a kill, a GPS speed at ±${acc} m, then silence: nothing fires, no moving fast, no end told`, async () => {
    const { k, stops, starts, told, y } = await killed();
    const t = at('10:00:05');
    await k.fix(t, north(y + FAR), { speed: SPEED, accuracy: acc });
    await neverFast(k, t + 125_000);
    assert.equal(stops(), 0);
    assert.equal(starts(), 0);
    assert.equal(told(), 0);
  });
}

// F3, A1: cell-tower fixes

test('F3: killed on the road, cell-tower fixes only for 45 s: nothing fires and no end told; the first good reading says the road, with no "starts"', async () => {
  const { k, stops, starts, told, y } = await killed('09:20');
  let there = y + SPEED * 1100;
  for (let s = 5; s <= 45; s += 5) {
    await k.fix(at('09:20') + s * 1000, north(there), { speed: null, accuracy: 900 });
    there += SPEED * 5;
    assert.notEqual(k.live.activity, 'moving-fast');
    assert.equal(stops(), 0);
    assert.equal(told(), 0);
  }
  await k.fix(at('09:20:50'), north(there), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

// F4, K5: a fix that moved the odometer is evidence

test('F4: on the road, locked 7 minutes, unlocked, a far no-speed first fix, then a reload within seconds of a km: the way since then is short, not slow, so the hold goes on', async () => {
  const { k, stops, y } = await driving();
  await hide(k);
  await k.to(at('09:08'));
  await show(k);
  const there = y + SPEED * 420;
  const t = at('09:08:05');
  await k.fix(t, north(there), { speed: null, accuracy: 30 });
  assert.equal(k.live.activity, 'moving-fast');
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast', 'the record is under 5 minutes from the last evidence, the far fix');
  const told = ends(k);
  await k.fix(t + 4000, north(there + 20), { speed: null, accuracy: 30 });
  await k.to(t + 4000 + QUIET_STILL_MS + 5000);
  assert.equal(k.live.activity, 'moving-fast', 'no two minutes of quiet from a way that was never slow');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), told()], [0, 0]);
});

// F5, A1: coarse says nothing, anywhere

test('F5: good fixes, one ±1000 m fix, then silence: the fix says nothing, so no false stop in a tunnel', async () => {
  const { k, stops, y } = await driving();
  const told = ends(k);
  await k.fix(at('09:01:20'), north(y + SPEED * 20), { speed: null, accuracy: 1000 });
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:04:30'));
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), told()], [0, 0]);
});

test('A1: the cost, as the user was told: coarse only in a garage, on screen: moving fast for 15 minutes from the last good fix, not from the last coarse one', async () => {
  const { k, stops, y } = await driving();
  const last = at('09:01');
  for (let t = last + 10_000; t < last + NO_FIX_STILL_MS - 10_000; t += 10_000) await k.fix(t, north(y), { speed: 0, accuracy: 300 });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(stops(), 0);
  await k.to(last + NO_FIX_STILL_MS + 1000);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
});

test('A1: with Precise Location off, activity stays unknown instead of still', async () => {
  const k = await liveKit({ start: at('09:00') });
  for (let t = at('09:00:10'); t < at('09:10'); t += 30_000) await k.fix(t, MONTEREY, { speed: 0, accuracy: 1500 });
  assert.equal(k.live.activity, 'unknown');
});

test('A1: a coarse fix with a fast GPS speed says nothing either: no start from it', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.stay(MONTEREY, at('09:00'), at('09:01'));
  const starts = await watch(k, 'start');
  for (let s = 10; s < 90; s += 10) await k.fix(at('09:01') + s * 1000, north(s * 50), { speed: 25, accuracy: 200 });
  assert.equal(k.live.activity, 'still');
  assert.equal(starts(), 0);
});

// F6, F10, F12, K2: reopened parked

for (const [name, speed] of /** @type {const} */ ([['no speed', null], ['speed 0', 0]])) {
  test(`F6: killed, parked, fixes over 2 minutes apart with ${name}: one late "stops", moving fast never shown, the end told once, no "starts"`, async () => {
    const { k, stops, starts, told, y } = await killed();
    const there = y + FAR;
    for (let t = at('10:00:05'), i = 0; i < 6; t += 130_000, i++) {
      await k.fix(t, north(there), { speed });
      assert.notEqual(k.live.activity, 'moving-fast');
      await neverFast(k, t + 120_000);
    }
    assert.equal(stops(), 1);
    assert.equal(starts(), 0);
    assert.equal(told(), 1);
    assert.equal(k.live.activity, 'still');
  });
}

test('F10: killed, two no-speed fixes 20 s apart on the road, then 35 s with no fix: nothing fires, voice told no end', async () => {
  const { k, stops, starts, told, y } = await killed('09:20');
  const t = at('09:20:05');
  const there = y + SPEED * 1140;
  await k.fix(t, north(there), { speed: null });
  await k.fix(t + 20_000, north(there + SPEED * 20), { speed: null });
  await k.to(t + 55_000);
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
  await k.fix(t + 60_000, north(there + SPEED * 75), { speed: SPEED });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

test('F12: a reload in the first 30 s after a parked reopening: the late "stops" is not lost, nor doubled, and the end is told once in all', async () => {
  const { k, stops, starts, told, y } = await killed();
  const there = y + FAR;
  await k.fix(at('10:00:05'), north(there), { speed: 0 });
  await k.fix(at('10:00:15'), north(there), { speed: 0 });
  await k.restart();
  const told2 = ends(k);
  await k.stay(north(there), at('10:00:20'), at('10:02:30'), 10);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
  assert.equal(starts(), 0);
  assert.equal(told() + told2(), 1);
});

test('F12: a voice tap on a parked reopening and then a reload: the late "stops" is not lost, and the tap cancels the end to tell (V2)', async () => {
  const { k, stops, y } = await killed();
  sensor(k).hush(false);
  await k.settle();
  await k.restart();
  const told = ends(k);
  await k.stay(north(y + FAR), at('10:00:20'), at('10:02:30'), 10);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
  assert.equal(told(), 0);
});

test('K2: the late "stops" comes once, and driving off later does start', async () => {
  const { k, stops, starts, told, y } = await killed();
  const there = y + FAR;
  await k.stay(north(there), at('10:00:05'), at('10:03'), 10);
  assert.equal(stops(), 1);
  assert.equal(told(), 1);
  await road(k, at('10:30'), there, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(stops(), 1);
  assert.equal(starts(), 1);
  assert.equal(held(k), true);
});

// F9: late, in the same page

test('F9: killed, one no-speed fix, then the next day in the same page: the one late "stops" comes at the first reading, and walking 35 s adds nothing', async () => {
  const { k, stops, y } = await killed();
  const told = ends(k);
  const there = y + FAR;
  await k.fix(at('10:00:05'), north(there), { speed: null });
  await k.to(at('10:02:30'));
  assert.equal(stops(), 0);
  await hide(k);
  const day2 = at('09:00', '2026-11-28');
  await k.to(day2);
  await show(k);
  await k.fix(day2 + 5000, north(there), { speed: 0 });
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
  await k.fix(day2 + 60_000, north(there + 20), { speed: 1.4 });
  await k.fix(day2 + 95_000, north(there + 70), { speed: 1.4 });
  assert.equal(k.live.activity, 'walking');
  assert.equal(stops(), 1);
  assert.equal(told(), 1);
});

test('F9: on the road, locked to the next day in the same page: the drive that ended unseen ends once, and walking does not start anything', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  const day2 = at('09:00', '2026-11-28');
  await k.to(day2);
  await show(k);
  const there = y + FAR;
  await k.fix(day2 + 5000, north(there), { speed: 1.4 });
  for (let s = 10; s <= 40; s += 5) await k.fix(day2 + s * 1000, north(there + s * 1.4), { speed: 1.4 });
  await k.to(day2 + 180_000);
  assert.notEqual(k.live.activity, 'moving-fast');
  assert.deepEqual([stops(), starts()], [1, 0]);
});

test('F9: a watch set after the reopening is not for a drive that ended before it: walking later does not fire it', async () => {
  for (const there of [FAR, NEAR]) {
    const { k, y } = await killed();
    await k.fix(at('10:00:05'), north(y + there), { speed: null });
    await k.to(at('10:02:30'));
    const stops = await watch(k, 'stop');
    await k.to(at('10:03'));
    await k.fix(at('10:30'), north(y + there + 20), { speed: 1.4 });
    await k.fix(at('10:30:35'), north(y + there + 70), { speed: 1.4 });
    await k.to(at('10:33'));
    assert.notEqual(k.live.activity, 'moving-fast');
    assert.equal(stops(), 0, `${there} m`);
  }
});

// F11, K5: the record, when a hold ends

test('F11: locked 6 minutes in a jam with 200 m of way, a fast fix, then a reload 35 s later: the fast fix wrote the record, so it is restored and nothing is lost', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:07'));
  await show(k);
  await k.fix(at('09:07:05'), north(y + 200), { speed: 6 });
  await k.to(at('09:07:40'));
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  const told = ends(k);
  await k.fix(at('09:07:45'), north(y + 410), { speed: 6 });
  await k.fix(at('09:08:20'), north(y + 620), { speed: 6 });
  assert.equal(k.live.activity, 'moving-fast');
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

// K3: nothing at all

test('K3: reopened with no readings at all: nothing fires and no moving fast is shown, for as long as that lasts; the dead-GPS bound does not apply', async () => {
  const { k, stops, starts, told } = await killed();
  for (const hours of [1, 2, 6]) {
    await k.to(at('10:00') + hours * 3_600_000);
    assert.equal(k.live.activity, 'unknown');
    assert.equal(held(k), false);
  }
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

test('K3: a reading of 3 to 5 m/s after a kill says nothing, and silence then fires nothing (Haiku\'s finding: no large hold ended by the quiet path)', async () => {
  const { k, stops, starts, told, y } = await killed();
  const t = at('10:00:05');
  await k.fix(t, north(y + FAR), { speed: 4 });
  await k.fix(t + 20_000, north(y + FAR + 80), { speed: 4 });
  await k.to(t + 3_600_000);
  assert.notEqual(k.live.activity, 'moving-fast');
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

// K4: the new drive

test('K4: reopened on a new drive: "stops" for the old drive at the first reading, then "starts" for the new one, and no drive end told on the road', async () => {
  const { k, stops, starts, told, y } = await killed();
  const there = y + NEAR;
  await k.fix(at('10:00:05'), north(there), { speed: SPEED });
  assert.equal(stops(), 1);
  assert.equal(starts(), 0);
  assert.notEqual(k.live.activity, 'moving-fast');
  await road(k, at('10:00:10'), there + 70, 35);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts(), told()], [1, 1, 0]);
});

// K5: a chain of reloads

test('K5: reloads with no reading: under 5 minutes from the last evidence each restores with the record\'s age frozen; after that it is K3', async () => {
  const { k, stops } = await driving();
  const frozen = at('09:01');
  await hide(k);
  for (const [t, was] of /** @type {[string, string][]} */ ([['09:02', 'moving-fast'], ['09:04', 'moving-fast'], ['09:05:50', 'moving-fast'], ['09:06:10', 'unknown'], ['09:09', 'unknown']])) {
    await k.to(at(t));
    await k.reload();
    assert.equal(k.live.activity, was, t);
    if (was === 'moving-fast') assert.equal(k.keep.get().at, frozen, 'frozen');
  }
  await k.to(at('10:00'));
  assert.equal(k.live.activity, 'unknown');
  assert.equal(stops(), 0);
});

// R1, R2, R5

test('R1: a reading on the road after any gap: no "stops", no "starts", voice held throughout', async () => {
  for (const gap of /** @type {const} */ (['reload', 'unlock', 'kill'])) {
    const { k, stops, starts, y } = await driving();
    const told = ends(k);
    await hide(k);
    await k.to(gap === 'kill' ? at('09:20') : at('09:03'));
    if (gap === 'unlock') await show(k);
    else await k.restart();
    const told2 = gap === 'unlock' ? () => 0 : ends(k);
    await road(k, k.clock.now() + 5000, y + SPEED * 500, 60);
    assert.equal(k.live.activity, 'moving-fast', gap);
    assert.equal(held(k), true, gap);
    assert.deepEqual([stops(), starts(), told(), told2()], [0, 0, 0, 0], gap);
  }
});

test('R2: moving fast holds for 330 s of time on screen: lock time does not use it, and unlocks every 5 minutes do not reset it', async () => {
  const { k, stops } = await driving();
  await hide(k);
  let shown = 0;
  let t = at('09:05');
  while (shown + 60_000 < NO_FIX_BACK_MS) {
    await k.to(t);
    await show(k);
    await k.to(t + 60_000);
    assert.equal(k.live.activity, 'moving-fast');
    shown += 60_000;
    await hide(k);
    t += 300_000;
  }
  assert.equal(stops(), 0);
  await k.to(t);
  await show(k);
  await k.to(t + NO_FIX_BACK_MS - shown + 1000);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
});

test('R3: one no-speed fix then silence does not mean 15 minutes of moving fast: the bound in time still applies', async () => {
  const { k, stops, y } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  await k.restart();
  const told = ends(k);
  const t = at('09:03:05');
  await k.fix(t, north(y + SPEED * 124), { speed: null });
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:03') + NO_FIX_BACK_MS - 2000);
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:03') + NO_FIX_BACK_MS + 2000);
  assert.equal(k.live.activity, 'still');
  assert.deepEqual([stops(), told()], [1, 1]);
  assert.equal(held(k), false);
});

test('R5: past the bound, one "stops" and one end; a reload says neither again and does not bring moving fast back; the road inside 5 minutes: moving fast and voice back, no "starts"', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  await show(k);
  const told = ends(k);
  const bound = at('09:03') + NO_FIX_BACK_MS;
  await k.to(bound + 1000);
  assert.equal(k.live.activity, 'still');
  assert.equal(held(k), false);
  assert.deepEqual([stops(), told()], [1, 1]);
  await k.reload();
  const told2 = ends(k);
  assert.equal(k.live.activity, 'still', 'a reload after the bound end does not bring moving fast back');
  await road(k, bound + 200_000, y + SPEED * (bound + 200_000 - at('09:01')) / 1000, 35); // the reload forgot the place, so the usual 30 s
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts(), told(), told2()], [1, 0, 1, 0]);
});

test('R5: the road past 5 minutes from the bound end is another drive by the same-drive rule: moving fast and voice back, and "starts" fires: the listed false "starts"', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  await show(k);
  const bound = at('09:03') + NO_FIX_BACK_MS;
  await k.to(bound + 305_000);
  await road(k, bound + 305_000, y + SPEED * (bound + 305_000 - at('09:01')) / 1000, 10);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts()], [1, 1]);
});

test('R5: a chain past the bound end: a reload, a lock and the road again do not bring a second "stops", a second end or a "starts" inside 5 minutes', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  await show(k);
  const told = ends(k);
  const bound = at('09:03') + NO_FIX_BACK_MS;
  await k.to(bound + 10_000);
  await hide(k);
  await k.to(bound + 100_000);
  await k.restart();
  const told2 = ends(k);
  await k.to(bound + 120_000);
  assert.equal(k.live.activity, 'still');
  await road(k, bound + 120_000, y + SPEED * (bound + 120_000 - at('09:01')) / 1000, 35);
  assert.equal(k.live.activity, 'moving-fast');
  assert.deepEqual([stops(), starts(), told(), told2()], [1, 0, 1, 0]);
});

test('R5 and V1: a hush, a bound end, then a reload: the reload forgets the hush with the place (the listed cost), and voice comes on with the next moving fast', async () => {
  const { k, stops, y } = await driving();
  sensor(k).hush(true);
  await hide(k);
  await k.to(at('09:03'));
  await show(k);
  const bound = at('09:03') + NO_FIX_BACK_MS;
  await k.to(bound + 1000);
  await k.reload();
  await road(k, bound + 100_000, y + SPEED * (bound + 100_000 - at('09:01')) / 1000, 35);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.equal(stops(), 1);
});

// V1, V2, V3

test('V1: voice turned off during a drive stays off across a reload, an unlock and a kill while the way has not decided; the road keeps it off', async () => {
  for (const gap of /** @type {const} */ (['reload', 'unlock', 'kill'])) {
    const { k, y } = await driving();
    sensor(k).hush(true);
    await hide(k);
    await k.to(gap === 'kill' ? at('09:20') : at('09:03'));
    if (gap === 'unlock') await show(k);
    else await k.restart();
    assert.equal(held(k), false, gap);
    await road(k, k.clock.now() + 5000, y + SPEED * 500, 20);
    assert.equal(k.live.activity, 'moving-fast', gap);
    assert.equal(held(k), false, `${gap}: stays off`);
  }
});

test('V1: voice off, killed, then parked: it clears when the way decides the drive ended, so the next drive has its voice', async () => {
  const { k, y } = await driving();
  sensor(k).hush(true);
  await hide(k);
  await k.to(at('10:00'));
  await k.restart();
  await k.stay(north(y + FAR), at('10:00:05'), at('10:03'), 10);
  assert.equal(k.live.activity, 'still');
  assert.equal(k.keep.get().hushed, false);
  await road(k, at('11:00'), y + FAR, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
});

test('V1: voice off after a kill, before a reading says, is kept, and a reload keeps it', async () => {
  const { k, y } = await killed();
  sensor(k).hush(true);
  await k.settle();
  assert.equal(k.keep.get().hushed, true);
  await k.restart();
  await road(k, at('10:00:10'), y + SPEED * 3540, 20);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), false);
});

test('V2: a voice choice while waiting cancels the told end, for a reopening parked: nothing told at the first reading', async () => {
  const { k, stops, told, y } = await killed();
  sensor(k).hush(false);
  await k.settle();
  await k.stay(north(y + FAR), at('10:00:10'), at('10:03'), 10);
  assert.equal(told(), 0);
  assert.equal(stops(), 1, 'the choice is about voice, so the reminder still fires');
});

test('V3: a record saying moving fast with a recent `ended` does not arm the drive end: no drive end told after the reload', async () => {
  const { k, y } = await driving();
  await k.stay(north(y), at('09:01:05'), at('09:02:10'), 5);
  assert.equal(k.live.activity, 'still');
  const there = await road(k, at('09:02:15'), y, 35);
  assert.equal(k.live.activity, 'moving-fast');
  await k.reload();
  const told = ends(k);
  await road(k, at('09:03:00'), there + 200, 90);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(told(), 0);
  assert.equal(held(k), true);
});

// The hold's own edges

test('a 3 to 5 m/s crawl inside a hold keeps it, and its bound runs from the crawl: readings still coming are not a dead GPS', async () => {
  const { k, stops, y } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  await show(k);
  const told = ends(k);
  let there = y + 1000;
  for (let t = at('09:03:10'); t < at('09:10'); t += 20_000) {
    await k.fix(t, north(there), { speed: 4 });
    there += 80;
    assert.equal(k.live.activity, 'moving-fast');
  }
  assert.equal(held(k), true);
  assert.deepEqual([stops(), told()], [0, 0]);
});

test('a hold with no place to judge from (a record with no odometer place) still ends at the first reading that says', async () => {
  const { k, stops } = await driving();
  await hide(k);
  await k.to(at('09:03'));
  const r = k.keep.get();
  k.keep.set({ ...r, odo: null });
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast');
  await k.stay(MONTEREY, at('09:03:10'), at('09:05:30'), 10);
  assert.equal(k.live.activity, 'still');
  assert.equal(stops(), 1);
});
