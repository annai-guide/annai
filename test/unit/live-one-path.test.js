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
/** …and to one a slow way off (0.56 m/s in an hour: not still, so a parked car there takes the hold, but the drive is over). */
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
/** "When moving fast stops" or "starts", and how many times it has fired. @param {any} k @param {'stop' | 'start'} edge */
async function watch(k, edge, repeat = true) {
  const w = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', ...(edge === 'stop' ? { edge } : {}) }, repeat, fallback: 'x' });
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

for (const [name, mins, way] of /** @type {[string, number, number][]} */ ([['a city grid', 12, 4.5], ['a winding road', 20, 4], ['an errand loop back near the record', 30, 0.3]])) {
  test(`K4: killed and reopened still driving on ${name}: the way looks slow, so the old drive ends silently: no "stops" on the road, no end told, one "starts", and a one-time "stops" fires at the real stop`, async () => {
    const { k, stops, starts, y } = await driving();
    const once = await watch(k, 'stop', false);
    await hide(k);
    const t = at('09:01') + mins * 60_000;
    await k.to(t);
    await k.restart();
    const told = ends(k);
    let there = y + way * mins * 60;
    for (let s = 3; s < 30; s += 5) {
      await k.fix(t + s * 1000, north(there), { speed: SPEED });
      there += SPEED * 5;
      assert.equal(k.live.activity, 'unknown', 'no still on the road');
    }
    there = await road(k, t + 33_000, there, 30);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.deepEqual([stops(), once(), starts(), told()], [0, 0, 1, 0]);
    await k.stay(north(there), t + 180_000, t + 280_000, 5);
    assert.equal(k.live.activity, 'still');
    assert.deepEqual([stops(), once(), starts()], [1, 1, 1]);
    await k.to(t + 400_000); // voice's 2 minutes after a real stop
    assert.equal(told(), 1);
  });
}

test('K4: reopened on a new drive: the cost, as today: no "stops" for the old drive, and a one-time "stops" waits for the end of this one', async () => {
  const { k, stops, starts, y } = await driving();
  const once = await watch(k, 'stop', false);
  await hide(k);
  await k.to(at('11:00'));
  await k.restart();
  const told = ends(k);
  const there = await road(k, at('11:00:05'), y + 500, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.deepEqual([stops(), once(), starts(), told()], [0, 0, 1, 0]);
  await k.stay(north(there), at('11:05'), at('11:07'), 5);
  assert.deepEqual([stops(), once()], [1, 1]);
  await k.to(at('11:09'));
  assert.equal(told(), 1);
});

test('K4: a reload in the 30 s before "starts": it still fires once, and nothing else does', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:13'));
  await k.restart();
  const told = ends(k);
  const there = await road(k, at('09:13:03'), y + 3200, 10);
  await k.restart();
  const told2 = ends(k);
  await road(k, at('09:13:15'), there, 40);
  assert.equal(k.live.activity, 'moving-fast');
  assert.deepEqual([stops(), starts(), told(), told2()], [0, 1, 0, 0]);
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

// A change's time is a stale record's alone: any other stop is the watch's, however early its hold is dated

for (const repeat of [true, false]) {
  const kind = repeat ? 'repeating' : 'one-time';
  test(`a ${kind} watch set after a slow reading at a corner, in a stretch of 3 to 5 m/s, fires at the real stop`, async () => {
    const k = await liveKit({ start: at('09:00') });
    let y = await road(k, at('09:00'), 0, 60);
    let t = at('09:01:05');
    await k.fix(t, north(y), { speed: 2 });
    for (let s = 5; s <= 300; s += 5) await k.fix(t += 5000, north(y += 20), { speed: 4 });
    const stops = await watch(k, 'stop', repeat);
    for (let s = 5; s <= 180; s += 5) await k.fix(t += 5000, north(y += 20), { speed: 4 });
    assert.equal(k.live.activity, 'moving-fast');
    for (let s = 5; s <= 90; s += 5) await k.fix(t += 5000, north(y), { speed: 0 });
    assert.equal(k.live.activity, 'still');
    assert.equal(stops(), 1);
  });

  test(`a ${kind} watch set in a hold after an unlock, the first reading slow with a slow way: it fires`, async () => {
    const k = await liveKit({ start: at('09:00') });
    const y = await road(k, at('09:00'), 0, 60);
    await hide(k);
    await k.to(at('09:10'));
    await show(k);
    const stops = await watch(k, 'stop', repeat);
    await k.fix(at('09:10:40'), north(y + 1500), { speed: 0 });
    await k.to(at('09:12'));
    assert.equal(k.live.activity, 'still');
    assert.equal(stops(), 1);
  });

  test(`a ${kind} watch whose file has no \`created\`, a reload, a stop: it fires`, async () => {
    const k = await liveKit({ start: at('09:00') });
    const set = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', edge: 'stop' }, repeat, fallback: 'x' });
    const y = await road(k, at('09:00'), 0, 60);
    const { created: _, ...file } = await k.ws.readJSON(k.trip, `/watches/${set.id}.json`);
    await k.ws.write(k.trip, `/watches/${set.id}.json`, file, { author: 'user' });
    await k.settle();
    await hide(k);
    await k.to(at('09:03:30'));
    await k.restart();
    await k.stay(north(y + 40), at('09:03:35'), at('09:05'), 5);
    assert.equal(k.live.activity, 'still');
    assert.equal(k.agent.wakes.filter((/** @type {any} */ x) => x.text.includes(set.id)).length, 1);
  });
}

// At a light, after a gap with a city way: the car went on, so the hold starts at the reading

for (const secs of [90, 150, 200, 280]) {
  test(`reloaded at a 30 s light after ${secs} s locked, a way of 4 m/s: no "stops", no end told, voice held, and green is the same drive`, async () => {
    const { k, stops, starts, y } = await driving();
    await hide(k);
    await k.to(at('09:01') + secs * 1000);
    await k.restart();
    const told = ends(k);
    const t = at('09:01') + (secs + 3) * 1000;
    const there = y + 4 * (secs + 3);
    await k.fix(t, north(there), { speed: 0 });
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    await k.fix(t + 25_000, north(there), { speed: 0 });
    await road(k, t + 30_000, there, 50);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
  });
}

for (const secs of [90, 280, 600]) {
  test(`unlocked at a 30 s light after ${secs} s locked, a way of 4 m/s: the same`, async () => {
    const { k, stops, starts, y } = await driving();
    const told = ends(k);
    await hide(k);
    await k.to(at('09:01') + secs * 1000);
    await show(k);
    const t = at('09:01') + (secs + 3) * 1000;
    const there = y + 4 * (secs + 3);
    await k.fix(t, north(there), { speed: 0 });
    assert.equal(k.live.activity, 'moving-fast');
    await k.fix(t + 25_000, north(there), { speed: 0 });
    await road(k, t + 30_000, there, 50);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
  });
}

test('killed, reopened at a 30 s light, a way of 4 m/s: no "stops", no end told, and green is the same drive', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:11'));
  await k.restart();
  const told = ends(k);
  const there = y + 4 * 600;
  await k.fix(at('09:11:03'), north(there), { speed: 0 });
  await k.fix(at('09:11:28'), north(there), { speed: 0 });
  await road(k, at('09:11:33'), there, 55);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

for (const gap of /** @type {const} */ (['reload', 'unlock'])) {
  test(`parked behind a ${gap}, a way near zero: the first reading still ends it at once`, async () => {
    const { k, stops, y } = await driving();
    await hide(k);
    await k.to(at('09:04'));
    if (gap === 'reload') await k.restart();
    else await show(k);
    await k.fix(at('09:04:03'), north(y - SPEED * 5 + 20), { speed: 0 }); // 200 m in 3 minutes is 1 m/s, a phone on foot, not near zero
    assert.equal(k.live.activity, 'still');
    assert.equal(stops(), 1);
  });
}

// When a stale record's end is told

test('killed, a far way, reopened at a 30 s light: no end told, so a saved Voice On stays; green is the same drive', async () => {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  await k.to(at('09:11'));
  await k.restart();
  const told = ends(k);
  const there = y + SPEED * 590;
  await k.fix(at('09:11:03'), north(there), { speed: 0 });
  assert.equal(told(), 0);
  await k.fix(at('09:11:28'), north(there), { speed: 0 });
  await road(k, at('09:11:33'), there, 55);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
});

for (const [name, way] of /** @type {[string, number][]} */ ([['a far way', FAR], ['a way of 4 m/s', 4 * 3540]])) {
  test(`killed, ${name}, parked: the end is told once, at the change, with the late "stops"`, async () => {
    const { k, stops, starts, y } = await driving();
    await hide(k);
    await k.to(at('10:00'));
    await k.restart();
    const told = ends(k);
    const there = y + way;
    for (let t = at('10:00:05'); t < at('10:01:05'); t += 10_000) {
      await k.fix(t, north(there), { speed: 0 });
      assert.equal(told(), 0);
      assert.equal(stops(), 0);
    }
    await k.stay(north(there), at('10:01:05'), at('10:02:30'), 10);
    assert.equal(k.live.activity, 'still');
    assert.deepEqual([stops(), starts(), told()], [1, 0, 1]);
  });
}

for (const speed of [1, null]) {
  test(`killed, a way of 4 m/s, reopened at a light, the first reading ${speed === null ? 'with no speed' : 'at 1 m/s'}: no end told at it, and green tells none`, async () => {
    const { k, stops, starts, y } = await driving();
    await hide(k);
    await k.to(at('09:11'));
    await k.restart();
    const told = ends(k);
    const there = y + 4 * 600;
    await k.fix(at('09:11:03'), north(there), { speed });
    assert.equal(told(), 0);
    await k.fix(at('09:11:20'), north(there), { speed: 0 });
    assert.equal(told(), 0);
    await road(k, at('09:11:33'), there, 55);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
    assert.deepEqual([stops(), starts(), told()], [0, 0, 0]);
  });
}

test('killed, a near way, parked: told at the first reading with a speed; a first reading with no speed is told at its change, 2 minutes later', async () => {
  for (const speed of [0, null]) {
    const { k, y } = await driving();
    await hide(k);
    await k.to(at('10:00'));
    await k.restart();
    const told = ends(k);
    await k.fix(at('10:00:05'), north(y - SPEED * 5 + 20), { speed }); // 2 km in an hour is 0.56 m/s, above the sensor's still: truly near zero here
    assert.equal(told(), speed === null ? 0 : 1, String(speed));
    await k.to(at('10:02:15'));
    assert.equal(told(), 1, `${speed}: in the end`);
  }
});

test('killed, a far way, a light, and a voice choice before the change: it cancels the end; the "stops" still fires', async () => {
  const { k, stops, y } = await driving();
  await hide(k);
  await k.to(at('10:00'));
  await k.restart();
  const told = ends(k);
  const there = y + FAR;
  await k.fix(at('10:00:05'), north(there), { speed: 0 });
  sensor(k).hush(false);
  await k.settle();
  await k.stay(north(there), at('10:00:15'), at('10:02:30'), 10);
  assert.deepEqual([stops(), told()], [1, 0]);
});

// A way too short for its accuracy (R3 and R4)

test('a no-speed fix at ±100 m over 16 s at 10 m/s, then 125 s of silence: too short to say, so no false "stops"', async () => {
  const k = await liveKit({ start: at('09:00') });
  const stops = await watch(k, 'stop');
  const v = 10;
  const y = await road(k, at('09:00'), 0, 60);
  await k.to(at('09:01:02'));
  await k.reload();
  const told = ends(k);
  const t = at('09:01:16');
  await k.fix(t, north(y + v * 11), { speed: null, accuracy: 100 });
  await k.to(t + 125_000);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
  assert.deepEqual([stops(), told()], [0, 0]);
});

test('a parked phone: the same fix over 16 s can\'t say, and 2 minutes of silence ends nothing; over 25 s it can, and R4 stands', async () => {
  for (const [secs, ended] of /** @type {[number, boolean][]} */ ([[16, false], [25, true]])) {
    const k = await liveKit({ start: at('09:00') });
    const y = await road(k, at('09:00'), 0, 60);
    await k.to(at('09:01:02'));
    await k.reload();
    const t = at('09:01') + secs * 1000;
    await k.fix(t, north(y - SPEED * 5), { speed: null, accuracy: 100 });
    await k.to(t + 125_000);
    assert.equal(k.live.activity, ended ? 'still' : 'moving-fast', `${secs} s`);
  }
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

// Fix pass 2

/** `road` returns where the next fix would be: the last one it made is this far back. */
const LAST = SPEED * 5;

// How a hold is dated after a gap: the phone stayed put only if the way is under STILL_BELOW (the sensor's own "still", not walking).
// Reading a parked phone as moved only delays a true "stops" by the hold; reading a moving car as parked fires a false one.

for (const gap of /** @type {const} */ (['reload', 'unlock', 'kill'])) {
  for (const [way, acc] of /** @type {[number, number][]} */ ([[2.5, 8], [5, 8], [5.2, 8], [5.2, 30]])) {
    test(`a 30 s light behind a ${gap} at a way of ${way} m/s${acc > 8 ? ` and ±${acc} m` : ''}: no false "stops", no false end, and a one-time "when I stop" waits for the real stop`, async () => {
      const { k, stops, starts, y } = await driving();
      const once = await watch(k, 'stop', false);
      const told = ends(k);
      const secs = gap === 'kill' ? 400 : 120;
      await hide(k);
      const t = at('09:01') + secs * 1000;
      await k.to(t);
      if (gap === 'unlock') await show(k);
      else await k.restart();
      const toldAfter = gap === 'unlock' ? told : ends(k);
      const there = y - LAST + way * (secs + 3);
      await k.fix(t + 3000, north(there), { speed: 0, accuracy: acc });
      await k.fix(t + 28_000, north(there), { speed: 0, accuracy: acc });
      const end = await road(k, t + 33_000, there, 50);
      assert.equal(k.live.activity, 'moving-fast');
      assert.equal(held(k), true);
      assert.deepEqual([stops(), once(), starts(), told() + (gap === 'unlock' ? 0 : toldAfter())], [0, 0, 0, 0]);
      await k.stay(north(end), t + 90_000, t + 300_000, 5);
      assert.equal(k.live.activity, 'still');
      assert.deepEqual([stops(), once()], [1, 1]);
    });
  }
}

test('two 30 s lights with a reload between them, the odometer\'s place from before the first light: no false "stops" at either', async () => {
  for (const way of [2.5, 4, 5, 5.2]) {
    const { k, stops, starts, y } = await driving();
    await hide(k);
    let t = at('09:01') + 90_000;
    await k.to(t);
    await k.restart();
    let told = ends(k);
    let there = y - LAST + way * 93;
    await k.fix(t + 3000, north(there), { speed: 0 });
    await k.fix(t + 28_000, north(there), { speed: 0 });
    there = await road(k, t + 33_000, there, 20);
    await hide(k);
    t = t + 33_000 + 20_000 + 90_000;
    await k.to(t);
    await k.restart();
    const told2 = ends(k);
    there += way * 90;
    await k.fix(t + 3000, north(there), { speed: 0 });
    await k.fix(t + 28_000, north(there), { speed: 0 });
    await road(k, t + 33_000, there, 40);
    assert.equal(k.live.activity, 'moving-fast', String(way));
    assert.deepEqual([stops(), starts(), told(), told2()], [0, 0, 0, 0], String(way));
    told = told2;
  }
});

for (const gap of /** @type {const} */ (['reload', 'unlock', 'kill'])) {
  test(`parked behind a ${gap}, a way truly near zero: the first reading ends it at once`, async () => {
    const { k, stops, y } = await driving();
    const secs = gap === 'kill' ? 400 : 180;
    await hide(k);
    const t = at('09:01') + secs * 1000;
    await k.to(t);
    if (gap === 'unlock') await show(k);
    else await k.restart();
    await k.fix(t + 3000, north(y - LAST + 20), { speed: 0 });
    if (gap === 'kill') await k.stay(north(y - LAST + 20), t + 13_000, t + 140_000, 10);
    assert.equal(k.live.activity, 'still');
    assert.equal(stops(), 1);
  });
}

test('a phone carried 200 m on foot during a 3-minute gap: the way is walking, not still, so "stops" reads one hold later, not never', async () => {
  for (const gap of /** @type {const} */ (['reload', 'unlock'])) {
    const { k, stops, y } = await driving();
    await hide(k);
    const t = at('09:04');
    await k.to(t);
    if (gap === 'unlock') await show(k);
    else await k.restart();
    await k.fix(t + 3000, north(y - LAST + 200), { speed: 0 });
    assert.equal(stops(), 0, `${gap}: the hold starts at the reading`);
    await k.stay(north(y - LAST + 200), t + 13_000, t + 140_000, 10);
    assert.equal(k.live.activity, 'still', gap);
    assert.equal(stops(), 1, gap);
  }
});

// A voice-off on a drive killed and reopened driving on a way that looks slow: the old drive ends silently, and the hush lasts through it

for (const [name, mins, way] of /** @type {[string, number, number][]} */ ([['a way of 4 m/s', 12, 4], ['a way of 0.3 m/s (an errand loop)', 30, 0.3]])) {
  test(`voice turned off on a drive, killed, reopened driving at ${name}: it stays off, and the road is on through the reading after 30 s`, async () => {
    const { k, stops, y } = await driving();
    sensor(k).hush(true);
    await k.settle();
    await hide(k);
    const t = at('09:01') + mins * 60_000;
    await k.to(t);
    await k.restart();
    const told = ends(k);
    let there = y - LAST + way * mins * 60;
    for (let s = 3; s <= 90; s += 5) {
      await k.fix(t + s * 1000, north(there), { speed: SPEED });
      there += SPEED * 5;
      assert.equal(held(k), false, `at ${s} s`);
      assert.equal(k.keep.get().hushed, true, `at ${s} s`);
    }
    assert.equal(k.live.activity, 'moving-fast');
    assert.deepEqual([stops(), told()], [0, 0]);
  });
}

test('voice turned off on a drive, killed, reopened driving and pulled in within the 30 s: the hush does not reach the next drive', async () => {
  const { k, y } = await driving();
  sensor(k).hush(true);
  await k.settle();
  await hide(k);
  const t = at('09:01') + 12 * 60_000;
  await k.to(t);
  await k.restart();
  let there = y - LAST + 4 * 12 * 60;
  for (let s = 3; s <= 13; s += 5) {
    await k.fix(t + s * 1000, north(there), { speed: SPEED });
    there += SPEED * 5;
  }
  await k.stay(north(there), t + 18_000, t + 200_000, 5);
  assert.equal(k.live.activity, 'still');
  assert.equal(k.keep.get().hushed, false);
  await road(k, t + 3_600_000, there, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
});

// The errand loop back near the record, a first fix with no speed: it says nothing about the old drive, and the road goes on

for (const way of [0.1, 0.3, 1]) {
  test(`killed on the road, back near the record at a way of ${way} m/s, a first fix with no speed, then the road: no end told on it, and a saved Voice On stays on`, async () => {
    const { k, stops, y } = await driving();
    await hide(k);
    const t = at('09:21');
    await k.to(t);
    await k.restart();
    const told = ends(k);
    const there = y - LAST + way * 1200;
    await k.fix(t + 3000, north(there), { speed: null });
    assert.equal(told(), 0, 'no end on the road');
    await road(k, t + 8000, there + 70, 40);
    assert.equal(told(), 0);
    assert.equal(stops(), 0);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), true);
  });
}

// Fix pass 3

/**
 * Killed on the road `secs` after the last fix, reopened parked at `way` m/s from the record's place (speed 0, a fix every 5 s from 3 s), and driving off at `off` s.
 * @param {number} secs @param {number} way @param {number} off @param {number} [setAt] when to set a one-time "when I stop", s after the reopening
 */
async function parkedAfterKill(secs, way, off, setAt) {
  const { k, stops, starts, y } = await driving();
  await hide(k);
  const t = at('09:01') + secs * 1000;
  await k.to(t);
  await k.restart();
  const told = ends(k);
  const p = y - LAST + way * secs;
  /** @type {() => number} */
  let once = () => 0;
  let armed = false;
  /** @type {Record<number, number>} */
  const toldAt = {};
  for (let s = 3; s < off; s += 5) {
    await k.fix(t + s * 1000, north(p), { speed: 0 });
    toldAt[s] = told();
    if (setAt !== undefined && !armed && s >= setAt) { armed = true; once = await watch(k, 'stop', false); }
  }
  const stopsBefore = stops();
  const end = await road(k, t + off * 1000, p, 60);
  return { k, stops, starts, told, toldAt, stopsBefore, once, end, t };
}

// G1: killed on the road, reopened parked at a way of 0.5 to 5 m/s: the drive that record describes was over long ago, so driving off later starts

for (const [name, secs] of /** @type {[string, number][]} */ ([['7 minutes', 420], ['20 minutes', 1200], ['1 hour', 3600]])) {
  for (const way of [0.6, 2, 2.8, 3.5, 4.5]) {
    test(`G1: killed at ${name}, reopened parked at a way of ${way} m/s: the end is told once at the reading plus 60 s, one "stops", and driving off 3 minutes on starts`, async () => {
      const { stops, starts, told, toldAt, stopsBefore } = await parkedAfterKill(secs, way, 183);
      assert.equal(toldAt[58], 0, 'not before the hold');
      assert.equal(toldAt[68], 1, 'at the reading plus 60 s');
      assert.deepEqual([stopsBefore, told(), stops()], [1, 1, 1]);
      assert.equal(starts(), 1, 'driving off starts');
    });
  }
}

for (const way of [5.5, 8]) {
  test(`G1, the rule's other side: killed, a way of ${way} m/s says it drove until now, so driving off 3 minutes on starts nothing; past the 5 minutes it does`, async () => {
    const soon = await parkedAfterKill(1200, way, 183);
    assert.equal(soon.starts(), 0, 'inside the same-drive rule');
    const late = await parkedAfterKill(1200, way, 420);
    assert.equal(late.starts(), 1, 'past it');
  });
}

test('G1, the named case: a parked car 2 km past the record, reopened an hour later: told at the reading plus 60 s, and driving off starts', async () => {
  const { starts, told, toldAt, stopsBefore } = await parkedAfterKill(3600, NEAR / 3600, 183);
  assert.deepEqual([toldAt[58], toldAt[68], stopsBefore, told(), starts()], [0, 1, 1, 1, 1]);
});

for (const way of [0.6, 2]) {
  test(`G1: a one-time "when I stop" set in the 60 s hold after a kill, at a way of ${way} m/s: it doesn't fire at the hold's end, and is still armed for the next drive's real stop`, async () => {
    const { k, once, end } = await parkedAfterKill(1200, way, 183, 20);
    assert.equal(once(), 0, 'not at the hold end');
    await k.stay(north(end), at('09:21') + 183_000 + 90_000, at('09:21') + 183_000 + 300_000, 5);
    assert.equal(once(), 1, 'at the real stop');
  });
}

// A voice-off lasts through a light after K4, as on any drive

/** A voice-off on a drive, killed, reopened driving on a slow way: K4. @returns {Promise<{ k: any, t: number, there: number }>} */
async function killedHushed() {
  const { k, y } = await driving();
  sensor(k).hush(true);
  await k.settle();
  await hide(k);
  const t = at('09:01') + 12 * 60_000;
  await k.to(t);
  await k.restart();
  return { k, t, there: y - LAST + 4 * 12 * 60 };
}

for (const [name, light] of /** @type {[string, number][]} */ ([['a light of 40 s', 40], ['a light of 100 s', 100]])) {
  test(`voice off, killed, reopened on a slow way (K4), then ${name}: the hush holds, and the road after has voice off`, async () => {
    const { k, t, there } = await killedHushed();
    let p = there;
    for (let s = 3; s <= 18; s += 5) { await k.fix(t + s * 1000, north(p), { speed: SPEED }); p += SPEED * 5; }
    for (let s = 23; s <= 18 + light; s += 5) await k.fix(t + s * 1000, north(p), { speed: 0 });
    await road(k, t + (23 + light) * 1000, p, 60);
    assert.equal(k.live.activity, 'moving-fast');
    assert.equal(held(k), false);
    assert.equal(k.keep.get().hushed, true);
  });
}

test('voice off, killed, reopened on a slow way (K4), then a crawl at 1 to 2.5 m/s for 30 s: the hush holds, and the road after has voice off', async () => {
  const { k, t, there } = await killedHushed();
  let p = there;
  for (let s = 3; s <= 18; s += 5) { await k.fix(t + s * 1000, north(p), { speed: SPEED }); p += SPEED * 5; }
  for (let s = 23; s <= 53; s += 5) { const v = 1 + 1.5 * ((s - 23) / 30); await k.fix(t + s * 1000, north(p), { speed: v }); p += v * 5; }
  await road(k, t + 58_000, p, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), false);
  assert.equal(k.keep.get().hushed, true);
});

test('voice off, killed, reopened on a slow way (K4), then a 10-minute pull-in: it clears, and the hush does not reach the next drive', async () => {
  const { k, t, there } = await killedHushed();
  let p = there;
  for (let s = 3; s <= 18; s += 5) { await k.fix(t + s * 1000, north(p), { speed: SPEED }); p += SPEED * 5; }
  await k.stay(north(p), t + 23_000, t + 623_000, 5);
  assert.equal(k.live.activity, 'still');
  assert.equal(k.keep.get().hushed, false);
  await road(k, t + 3_600_000, p, 60);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(held(k), true);
});

test('a voice tap inside K4\'s 30 s counts: the voice-off it chose holds through a light', async () => {
  const { k, y } = await driving();
  await hide(k);
  const t = at('09:01') + 12 * 60_000;
  await k.to(t);
  await k.restart();
  let p = y - LAST + 4 * 12 * 60;
  for (let s = 3; s <= 13; s += 5) { await k.fix(t + s * 1000, north(p), { speed: SPEED }); p += SPEED * 5; }
  sensor(k).hush(true);
  await k.settle();
  assert.equal(k.keep.get().hushed, true);
  await k.stay(north(p), t + 18_000, t + 68_000, 5);
  await road(k, t + 73_000, p, 60);
  assert.equal(held(k), false);
  assert.equal(k.keep.get().hushed, true);
});

test('K4 with a voice-off, then a stop of about 2.5 minutes: a true end is told', async () => {
  const { k, t, there } = await killedHushed();
  const told = ends(k);
  let p = there;
  for (let s = 3; s <= 18; s += 5) { await k.fix(t + s * 1000, north(p), { speed: SPEED }); p += SPEED * 5; }
  await k.stay(north(p), t + 23_000, t + 23_000 + 150_000, 5);
  assert.equal(k.live.activity, 'still');
  assert.equal(told(), 1);
});
