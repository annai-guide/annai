import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, iso, off, LA, MONTEREY, BIXBY, NEPENTHE, CAMBRIA, HEARST } from './live-kit.js';
import { readAppSettings } from '../../src/core/settings.js';
import { readWatches } from '../../src/core/live/watches.js';
import { createTrip, removeTrip, ME } from '../../src/core/scopes.js';
import { ManualClock, scaledClock, realClock } from '../../src/core/live/clock.js';
import { Live } from '../../src/core/live/live.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };
const CASTLE = { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } };

test('clocks: a manual one runs its timers in order as it moves; a scaled one runs ten times faster', async () => {
  const c = new ManualClock(1000);
  /** @type {string[]} */
  const ran = [];
  c.set(() => ran.push('b'), 200);
  const gone = c.set(() => ran.push('x'), 100);
  c.set(() => ran.push('a'), 100);
  c.clear(gone);
  await c.advanceTo(1150);
  assert.deepEqual(ran, ['a']);
  assert.equal(c.now(), 1150);
  await c.advanceTo(5000);
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(c.pending, 0);
  let t = 0;
  const base = { now: () => t, set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => ({ fn, ms }), clear: () => {} };
  const fast = scaledClock(1_000_000, 10, base);
  t = 500;
  assert.equal(fast.now(), 1_005_000);
  assert.equal(fast.set(() => {}, 10_000).ms, 1000);
});

test('live mode on: GPS runs, the switch is kept, a state entry is logged and Shiori is woken once; off: GPS stops and the activity is unknown', async () => {
  const k = await liveKit({ live: false });
  assert.equal(k.sensors.gpsOn(), false);
  await k.live.setLive(true);
  assert.equal(k.sensors.gpsOn(), true);
  assert.equal((await readAppSettings(k.ws)).live.on, true);
  assert.deepEqual(k.agent.wakes.map((w) => w.kind), ['live']);
  assert.match(k.agent.wakes[0].text, /turned live mode on.*driving-companion/);
  await k.drive(MONTEREY, off(MONTEREY, 0, -3000), at('08:31'), at('08:34'));
  assert.equal(k.registry.list('activity')[0].now(), 'moving-fast');
  await k.live.setLive(false);
  assert.equal(k.sensors.gpsOn(), false);
  assert.equal(k.registry.list('activity')[0].now(), 'unknown');
  assert.equal(k.live.fix, null);
  assert.deepEqual((await k.events(['state'])).map((e) => e.data.live), ['on', 'off']);
  assert.equal(k.agent.wakes.length, 1);
  await k.live.setLive(false);
  assert.equal((await k.events(['state'])).length, 2);
});

test('location points are kept as §4.5 says; GPS jitter at a stop adds no distance; the activity sensor follows (spec §11.2)', async () => {
  const k = await liveKit();
  for (let s = 0; s <= 300; s += 5) await k.fix(at('08:30') + s * 1000, off(MONTEREY, Math.sin(s * 7.3) * 10, Math.cos(s * 3.1) * 10), { accuracy: 20, speed: 0 });
  assert.ok((await k.events(['location'])).length < 20);
  assert.equal(k.live.odometer, 0);
  assert.equal(k.live.activity, 'still');
  let calls = 0;
  k.registry.list('activity')[0].onChange(() => { calls++; });
  await k.drive(off(MONTEREY, 0, -100), off(MONTEREY, 0, -5000), at('08:36'), at('08:41')); // from beyond the jitter, so its first point is kept
  const driving = (await k.events(['location'])).filter((e) => e.ts >= at('08:36'));
  assert.equal(driving.length, 61); // every fix, 83 m apart
  assert.ok(Math.abs(k.live.odometer - 5) < 0.1, `odometer ${k.live.odometer}`);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(driving[1].data).sort(), ['accuracy', 'lat', 'lng', 'speed']);
  assert.equal(driving[1].ts, at('08:36:05'));
});

test('a time watch fires by the clock with live mode off, then is gone; a location watch waits for live mode', async () => {
  const k = await liveKit({ live: false });
  const call = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Call Mia about dinner.' });
  const enter = await k.live.setWatch(k.trip, { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, name: 'Bixby' }, fallback: 'Bixby Bridge.' });
  await k.to(at('09:59'));
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('10:00'));
  assert.equal(k.agent.wakes.length, 1);
  const w = k.agent.wakes[0];
  assert.equal(w.kind, 'trigger');
  assert.equal(w.text, `Your watch ${call.id} (at ${iso('10:00')}) fired: the time came: ${iso('10:00')}. Its reminder: "Call Mia about dinner."`);
  assert.deepEqual(w.fallbacks, [{ watch: call.id, text: 'Call Mia about dinner.' }]);
  const [fired] = await k.events(['trigger.fired']);
  assert.deepEqual(fired.data, { watch: call.id, type: 'time', owner: 'shiori', text: `the time came: ${iso('10:00')}`, fallback: 'Call Mia about dinner.' });
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches.map((x) => x.id), [enter.id]);
  await k.to(at('11:00'));
  assert.equal(k.agent.wakes.length, 1);
});

test('watches firing at once merge into one wake (spec §6.1)', async () => {
  const k = await liveKit({ live: false });
  const a = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'A.' });
  const b = await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 90 }, fallback: 'B.' }); // set at 08:30
  await k.to(at('10:00'));
  assert.equal(k.agent.wakes.length, 1);
  assert.deepEqual(k.agent.wakes[0].fallbacks.map((/** @type {any} */ f) => f.watch).sort(), [a.id, b.id].sort()); // set at the same moment: either order
  await k.to(at('11:30'));
  assert.equal(k.agent.wakes.length, 2); // every keeps going
});

test('enter and leave fire once a crossing; jitter at the edge does not refire them; a vague fix changes nothing', async () => {
  const k = await liveKit();
  await k.fix(at('09:00'), off(BIXBY, 0, 1000));
  const circle = { lat: BIXBY.lat, lng: BIXBY.lng, radius: 200, name: 'Bixby Bridge' };
  await k.live.setWatch(k.trip, { when: { type: 'enter', ...circle }, repeat: true, fallback: 'Bixby Bridge ahead.' });
  await k.live.setWatch(k.trip, { when: { type: 'leave', ...circle }, repeat: true, fallback: 'On to Big Sur.' });
  await k.fix(at('09:01'), off(BIXBY, 0, 150));
  for (const [i, d] of [190, 230, 245, 210, 180, 240].entries()) await k.fix(at('09:02') + i * 5000, off(BIXBY, d, 0), { accuracy: 15 });
  await k.fix(at('09:03'), off(BIXBY, 0, 600), { accuracy: 900 });
  await k.fix(at('09:04'), off(BIXBY, 0, -600));
  await k.fix(at('09:05'), BIXBY);
  assert.deepEqual(k.agent.wakes.map((w) => w.fallbacks[0].text), ['Bixby Bridge ahead.', 'On to Big Sur.', 'Bixby Bridge ahead.']);
});

test('moved fires after its km since her last wake; any wake starts the count again', async () => {
  const k = await liveKit();
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, repeat: true, fallback: 'Narrate.' });
  await k.drive(MONTEREY, off(MONTEREY, 0, -3000), at('09:00'), at('09:03'));
  k.agent.woke(); // she woke for something else
  await k.drive(off(MONTEREY, 0, -3000), off(MONTEREY, 0, -7000), at('09:03:05'), at('09:07'));
  assert.equal(k.agent.wakes.length, 0);
  await k.drive(off(MONTEREY, 0, -7000), off(MONTEREY, 0, -9000), at('09:07:05'), at('09:09'));
  assert.equal(k.agent.wakes.length, 1);
  assert.match(k.agent.wakes[0].text, new RegExp(`^Your watch ${w.id} \\(after 5 km travelled\\) fired: you have travelled 5\\.\\d km since your last wake`));
});

test('a watch that is broken, of an unknown type, expired, or whose plugin trigger throws is skipped; the others still fire', async () => {
  const k = await liveKit({ live: false });
  k.registry.add('tides', 'trigger', { type: 'tide', check() { throw new TypeError('tide tables missing'); } });
  await k.ws.write(k.trip, '/watches/broken.json', 'not json', { author: 'shiori', type: 'text/plain' });
  await k.ws.write(k.trip, '/watches/w-odd.json', { id: 'w-odd', owner: 'shiori', when: { type: 'comet' }, fallback: 'Look up.' }, { author: 'shiori' });
  await k.ws.write(k.trip, '/watches/w-old.json', { id: 'w-old', owner: 'shiori', when: { type: 'time', at: iso('09:30') }, fallback: 'Old.', expires: iso('09:00') }, { author: 'shiori' });
  const tide = await k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' });
  const ok = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Still works.' });
  await k.to(at('10:00'));
  assert.deepEqual(k.agent.wakes.map((w) => w.fallbacks.map((/** @type {any} */ f) => f.watch)), [[ok.id]]);
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches.map((w) => w.id).sort(), ['w-odd', tide.id].sort()); // the expired one went, unfired
  assert.match(await k.live.listWatches(k.trip), /w-odd\tshiori\tcomet \(its trigger type isn't installed\)/);
});

test("the plan's leave reminder comes by the clock with live mode off, from the stop before, in the plan's own words", async () => {
  const k = await liveKit({ live: false, plan: { bixby: BIX, nepenthe: NEP } });
  await k.to(at('11:08'));
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('11:09'));
  assert.equal(k.agent.wakes.length, 1);
  assert.equal(k.agent.wakes[0].text, 'Plan: time to leave soon for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away in a straight line, about 36 min by car.');
  assert.deepEqual(k.agent.wakes[0].fallbacks, [{ watch: 'plan:nepenthe:leave', text: 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 36 min by car.' }]);
  assert.equal((await k.events(['trigger.fired']))[0].data.event, 'leave');
  await k.to(at('12:00'));
  assert.equal(k.agent.wakes.length, 1);
});

test('the plan changing while live: a moved item moves its reminder, a deleted item has none, a broken file stops nothing', async () => {
  const k = await liveKit({ live: false, plan: { bixby: BIX, nepenthe: NEP, castle: CASTLE } });
  await k.ws.patch(k.trip, '/plan/nepenthe.json', { start: { at: iso('13:00') }, end: { at: iso('14:00') } }, { author: 'shiori' });
  await k.ws.delete(k.trip, '/plan/castle.json', { author: 'user' });
  await k.ws.write(k.trip, '/plan/broken.json', 'not json', { author: 'user', type: 'text/plain' });
  await k.to(at('12:08'));
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('12:09'));
  assert.equal(k.agent.wakes.length, 1);
  await k.to(at('17:00'));
  assert.equal(k.agent.wakes.length, 1);
});

test('arrived at a plan place after a 2 min stop; driving past does not count; the place is logged for stamps (spec §13)', async () => {
  const k = await liveKit({ plan: { bixby: BIX } });
  await k.drive(off(BIXBY, 0, 3000), off(BIXBY, 0, -3000), at('09:00'), at('09:06'));
  assert.equal(k.agent.wakes.length, 0);
  await k.drive(off(BIXBY, 0, -3000), BIXBY, at('09:06:05'), at('09:09'));
  await k.stay(BIXBY, at('09:09:10'), at('09:12'));
  assert.deepEqual(k.agent.wakes.map((w) => w.text), ['Plan: you arrived at Bixby Creek Bridge for "Bixby Bridge photo stop" (flexible, 09:45).']);
  const [fired] = await k.events(['trigger.fired']);
  assert.deepEqual(fired.data.place, { name: 'Bixby Creek Bridge', ...BIXBY });
});

test('running late for a fixed item, from where the user is (spec §11.3)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  await k.stay(BIXBY, at('11:00'), at('11:30'), 30);
  assert.equal(k.agent.wakes.length, 2);
  assert.match(k.agent.wakes[0].text, /^Plan: time to leave soon for "Lunch at Nepenthe"/);
  assert.equal(k.agent.wakes[1].text, 'Plan: running late for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away, about 36 min by car, so about 5 min late.');
  assert.deepEqual(k.agent.wakes[1].fallbacks, [{ watch: 'plan:nepenthe:late', text: 'Running late: Lunch at Nepenthe at 12:00. About 36 min away.' }]);
});

test('another trip opened: its watches and its log; a time watch of the first still reminds; nothing goes into a removed trip', async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  const first = k.trip;
  const w1 = await k.live.setWatch(first, { when: { type: 'time', at: iso('09:00') }, fallback: 'Pack the snacks.' });
  const w2 = await k.live.setWatch(first, { when: { type: 'every', minutes: 10 }, fallback: 'Every ten.' });
  const second = await createTrip(k.ws, { title: 'Cambria' });
  k.agent.target = second;
  await k.live.setLive(true);
  await k.fix(at('08:40'), CAMBRIA);
  assert.equal((await k.events(['location'], second)).length, 1);
  assert.equal((await k.events(['location'], first)).length, 0);
  await k.to(at('09:00'));
  assert.deepEqual(k.agent.reminders, [{ watch: w1.id, text: 'Pack the snacks.', scope: first }]);
  assert.match(k.agent.wakes.find((w) => w.scope === first)?.text, /Pack the snacks/);
  assert.equal(k.agent.wakes.filter((w) => String(w.text).includes(w2.id)).length, 0); // an every watch waits for its own conversation
  assert.equal(k.agent.wakes.filter((w) => String(w.text).includes('Nepenthe')).length, 0); // and so does the first trip's plan
  await k.live.setWatch(first, { when: { type: 'time', at: iso('10:00') }, fallback: 'Gone.' });
  await removeTrip(k.store, first);
  await k.to(at('10:00'));
  assert.equal(k.agent.reminders.length, 1);
  assert.equal((await k.events(undefined, first)).length, 0);
});

test('the now block: where the user is, near which plan place, and what they are doing (spec §6.3)', async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  assert.deepEqual(k.live.nowInfo(), { place: 'unknown (live mode is off, so annai has no GPS)', activity: 'unknown (live mode is off)' });
  await k.live.setLive(true);
  assert.deepEqual(k.live.nowInfo(), { place: 'unknown (waiting for GPS)', activity: 'unknown' });
  await k.drive(off(NEPENTHE, 0, 3000), off(NEPENTHE, 0, 400), at('11:40'), at('11:43'));
  assert.equal(k.live.nowInfo().place, 'near Nepenthe (400 m) · 36.22490, -121.75670 (±8 m)');
  assert.match(k.live.nowInfo().activity, /^moving fast, about 5\d km\/h$/);
  await k.to(at('11:50'));
  assert.match(k.live.nowInfo().place, /\(±8 m, 7 min ago\)$/);
  await k.live.setLive(false);
  await k.live.setLive(true);
  k.sensors.error('denied');
  await k.settle();
  assert.equal(k.live.gps, 'denied');
  assert.equal(k.live.nowInfo().place, 'unknown (location permission is off)');
  await k.live.place({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, name: 'Nepenthe' }); // spec §17: a manual place
  assert.equal(k.live.nowInfo().place, 'near Nepenthe (0 m) · 36.22130, -121.75670 (±50 m, set by the user)');
});

test("watch_set's checks, in plain words; the list shows hers and the plan's; the plan's can't be cancelled", async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'comet' }, fallback: 'x' }), /when\.type must be one of: time, every, enter, leave, dwell, arrived, moved, activity\./);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'plan' }, fallback: 'x' }), /when\.type must be one of/);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'moved', km: -1 }, fallback: 'x' }), /A moved watch: km must be a number from 0\.1 to 1000\./);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: ' ' }), /needs a fallback/);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'time', at: iso('08:00') }, fallback: 'x' }), /has already passed/);
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: 'x', expires: 'soon' }), /expires must be an ISO date-time/);
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Look for Point Sur.', expires: iso('18:00') });
  assert.equal(k.live.watchText(w), `Set ${w.id}: after 15 km travelled, every time, until ${iso('18:00')}. Live mode is off, so it waits until the user turns it on. Now: unknown (live mode is off); unknown (live mode is off, so annai has no GPS).`);
  const list = await k.live.listWatches(k.trip);
  assert.equal(list.split('\n')[0], 'id\towner\twhen\trepeat\treminder\texpires\tlast_fired');
  assert.ok(list.includes(`${w.id}\tshiori\tafter 15 km travelled\tyes\tLook for Point Sur.\t${iso('18:00')}\t`));
  assert.ok(list.includes('plan:nepenthe:leave\tsystem\t15 min before leaving for "Lunch at Nepenthe" at 12:00\tno\tLeave soon: Lunch at Nepenthe at 12:00.\t\t'));
  await assert.rejects(k.live.cancelWatch(k.trip, 'plan:nepenthe:leave'), /follows the plan/);
  await assert.rejects(k.live.cancelWatch(k.trip, 'w-nope'), /There is no watch w-nope/);
  assert.equal(await k.live.cancelWatch(k.trip, w.id), `Cancelled ${w.id}.`);
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches, []);
  assert.equal(await k.live.listWatches(ME), 'No watches.');
});

test('off screen nothing runs: GPS stops and the clock waits; back on screen both start again (spec §11.1)', async () => {
  const k = await liveKit();
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Ten.' });
  assert.equal(k.sensors.gpsOn(), true);
  k.sensors.visible(false);
  await k.settle();
  assert.equal(k.sensors.gpsOn(), false);
  assert.equal(k.clock.pending, 0);
  await k.to(at('10:05'));
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.sensors.gpsOn(), true);
  assert.equal(k.agent.wakes.length, 0); // the catch-up waits for a fix, at most 15 s
  await k.to(at('10:05:15'));
  assert.deepEqual(k.agent.wakes.map((w) => w.kind), ['catch-up']);
});

test('opening another trip makes live mode look at its plan at once, even with nothing else to wake it', async () => {
  const k = await liveKit({ live: false });
  const second = await createTrip(k.ws, { title: 'Cambria' });
  await k.ws.write(second, '/plan/tea.json', { id: 'tea', title: 'Tea at the inn', fixed: true, start: { at: iso('09:00'), tz: LA } }, { author: 'user' });
  k.agent.opened(second);
  await k.settle();
  await k.to(at('08:45'));
  assert.deepEqual(k.agent.wakes.map((w) => w.text), ['Plan: "Tea at the inn" (fixed) starts at 09:00, in 15 min.']);
});

test('a plan item weeks ahead with live mode off: the one timer waits at most a day, and checks once a day', async () => {
  const k = await liveKit({ live: false, start: Date.parse('2026-10-16T12:00:00-07:00'), plan: {
    flight: { title: 'UA 123', fixed: true, start: { at: '2026-11-25T08:00:00-08:00', tz: LA }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } },
  } });
  /** @type {number[]} */
  const delays = [];
  const set = k.clock.set;
  k.clock.set = (fn, ms) => {
    delays.push(ms);
    return set(fn, ms);
  };
  await k.live.setWatch(k.trip, { when: { type: 'time', at: '2026-11-20T18:00:00-08:00' }, fallback: 'Pack for the flight.' });
  await k.settle();
  assert.ok(delays.length > 0 && delays.every((d) => d > 0 && d <= 86_400_000), String(delays));
  const before = delays.length;
  await k.to(Date.parse('2026-10-17T12:00:01-07:00'));
  assert.equal(delays.length - before, 1, 'one check, and one timer for the next day');
  assert.equal(k.agent.wakes.length, 0);
});

test("the real clock holds a delay longer than the browser's timers can", async () => {
  let fired = false;
  const c = realClock();
  const h = c.set(() => {
    fired = true;
  }, 40 * 86_400_000);
  await new Promise((r) => setTimeout(r, 30));
  c.clear(h);
  assert.equal(fired, false);
});

test('a 90-minute stop with 30 m of GPS wander and no GPS speed: still, no distance, no moved wake, few points (Review Focus 1)', async () => {
  for (const accuracy of [20, 40, 65]) {
    const k = await liveKit({ start: at('12:00') });
    await k.live.setWatch(k.trip, { when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Say something about the road.' });
    for (let s = 0; s <= 5400; s += 5) await k.fix(at('12:00') + s * 1000, off(NEPENTHE, Math.sin(s * 7.3) * 30, Math.cos(s * 3.1) * 30), { accuracy, speed: null });
    assert.equal(k.live.activity, 'still', `accuracy ${accuracy}`);
    assert.ok(k.live.odometer < 0.05, `accuracy ${accuracy}: odometer ${k.live.odometer} km`);
    assert.deepEqual(k.agent.wakes.filter((w) => /travelled/.test(w.text)), [], `accuracy ${accuracy}`);
    const points = (await k.events(['location'])).length;
    assert.ok(points <= 5, `accuracy ${accuracy}: ${points} points kept`);
  }
});

test('a watch written by hand with parts missing is listed as broken, in plain words, and never fires; the good one still does', async () => {
  const k = await liveKit({ live: false });
  await k.ws.write(k.trip, '/watches/w-hand.json', { id: 'w-hand', owner: 'shiori', when: { type: 'enter' }, fallback: 'Look.', created: iso('08:00') }, { author: 'shiori' });
  await k.ws.write(k.trip, '/watches/w-six.json', { id: 'w-six', owner: 'shiori', when: { type: 'time', at: 'tomorrow at six' }, fallback: 'Six.', created: iso('08:00') }, { author: 'shiori' });
  await k.ws.write(k.trip, '/watches/w-often.json', { id: 'w-often', owner: 'shiori', when: { type: 'every', minutes: 'often' }, fallback: 'Often.', created: iso('08:00') }, { author: 'shiori' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Fine.' });
  await k.settle();
  const list = await k.live.listWatches(k.trip);
  assert.match(list, /\nw-hand\tshiori\tan enter watch, broken: it needs lat and lng, so it won't fire\t/);
  assert.match(list, /\nw-six\tshiori\ta time watch, broken: at must be an ISO date-time with an offset, like [^,]+, so it won't fire\t/);
  assert.match(list, /\nw-often\tshiori\tan every watch, broken: minutes must be a number from 1 to 1440, so it won't fire\t/);
  await k.to(at('12:00'));
  assert.equal(k.agent.wakes.length, 1);
  assert.match(k.agent.wakes[0].text, /Its reminder: "Fine\."/);
});

test("a plugin trigger whose validate throws: setting its watch says so plainly", async () => {
  const k = await liveKit({ live: false });
  k.registry.add('tides', 'trigger', { type: 'tide', validate() { throw new TypeError('no tide table'); }, check: () => null });
  await assert.rejects(k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' }),
    (/** @type {any} */ e) => e.constructor === Error && /^The tide trigger couldn't check this watch \(no tide table\)\. Try another kind of watch\.$/.test(e.message));
});

test("a plugin trigger's plain error is noted once in the trip's log and doesn't count against its plugin; only a bug does (spec §5.5)", async () => {
  const k = await liveKit();
  let plain = 0;
  k.registry.add('tides', 'trigger', { type: 'tide', check() { plain++; throw new Error('tide table not downloaded yet'); } });
  k.registry.add('comets', 'trigger', { type: 'comet', check() { throw new TypeError("Cannot read properties of undefined (reading 'orbit')"); } });
  await k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' });
  await k.live.setWatch(k.trip, { when: { type: 'comet' }, fallback: 'Look up.' });
  for (let s = 0; s < 10; s++) await k.fix(at('08:31') + s * 1000, MONTEREY);
  assert.ok(plain >= 10, String(plain));
  assert.equal(k.registry.isDisabled('tides'), false);
  assert.equal(k.registry.isDisabled('comets'), true);
  const noted = (await k.events(['error'])).filter((e) => /tide/.test(String(e.data?.message)));
  assert.equal(noted.length, 1);
  assert.match(noted[0].data.message, /^The tide watch w-[0-9a-z]+ can't be checked: tide table not downloaded yet\.$/);
});

test("a plugin trigger whose describe throws: what fired still reaches Shiori", async () => {
  const k = await liveKit({ live: false });
  k.registry.add('tides', 'trigger', { type: 'tide', describe() { throw new TypeError('no words'); }, check: (/** @type {any} */ w, /** @type {any} */ m) => (m.now >= Date.parse(iso('09:00')) ? { text: 'low tide now' } : null) });
  await k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' });
  await k.to(at('09:00'));
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:30') }, fallback: 'Walk.' });
  await k.to(at('09:30'));
  assert.ok(k.agent.wakes.some((w) => /\(a tide watch\) fired: low tide now/.test(w.text)), k.agent.wakes.map((w) => w.text).join(' | '));
});

test("an item moved later gets the plan's reminders again, for its new time; and a restart remembers which time they were for", async () => {
  const k = await liveKit({ live: false, plan: { bixby: BIX, nepenthe: NEP } });
  await k.to(at('11:09'));
  assert.equal(k.agent.wakes.length, 1);
  await k.ws.write(k.trip, '/plan/nepenthe.json', { id: 'nepenthe', ...NEP, start: { at: iso('13:00'), tz: LA }, end: { at: iso('14:15'), tz: LA } }, { author: 'shiori' });
  await k.settle();
  await k.to(at('12:08'));
  assert.equal(k.agent.wakes.length, 1);
  await k.to(at('12:09'));
  assert.equal(k.agent.wakes.length, 2);
  assert.match(k.agent.wakes[1].text, /time to leave soon for "Lunch at Nepenthe" \(fixed, 13:00\)/);
  const fired = (await k.events(['trigger.fired'])).map((e) => e.data.for);
  assert.deepEqual(fired, [Date.parse(iso('12:00')), Date.parse(iso('13:00'))]);
  k.live.dispose();
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA });
  await again.start();
  await again.settled();
  await k.clock.advanceTo(at('12:20'), () => again.settled());
  assert.equal(k.agent.wakes.length, 2, 'not again after a restart');
  again.dispose();
});

test("a log write that fails doesn't hold a reminder back or make it fire again: it still comes, once, and the problem is told once (a card)", async () => {
  /** @type {unknown[]} */
  const problems = [];
  const k = await liveKit({ problem: (e) => problems.push(e) });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Call Mia.' });
  await k.fix(at('09:56'), MONTEREY);
  await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 5 }, fallback: 'Stretch.' });
  // From now on nothing more is written: no firing, no point, and no watch file removed (the disk is full, say).
  const tx = k.store.tx.bind(k.store);
  k.store.tx = (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => tx(names, mode, (/** @type {any} */ t) => fn(new Proxy(t, {
    get(o, key) {
      const v = o[key];
      if (key === 'appendEvent') return (/** @type {string} */ scope, /** @type {any} */ e) => (['trigger.fired', 'location', 'file.write', 'file.delete'].includes(e.type) ? Promise.reject(new Error('The disk is full.')) : o.appendEvent(scope, e));
      if (key === 'deleteFile' || key === 'putFile') return () => Promise.reject(new Error('The disk is full.'));
      return typeof v === 'function' ? v.bind(o) : v;
    },
  })));
  await k.fix(at('09:58'), MONTEREY);
  await k.to(at('10:12'));
  const reasons = k.agent.wakes.map((w) => w.text);
  assert.equal(reasons.filter((t) => t.includes('Call Mia.')).length, 1, reasons.join(' | '));
  assert.equal(reasons.filter((t) => t.includes('Stretch.')).length, 3, reasons.join(' | ')); // 10:01, 10:06 and 10:11, each once
  assert.equal(problems.length, 1);
  assert.match(String(/** @type {any} */ (problems[0])?.message), /disk is full/);
});

test("live mode keeps memories and firings only for the watches there are: a watch that is gone, or a plan item removed, leaves nothing behind", async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:00') }, fallback: 'Tea.' });
  const cambria = await k.live.setWatch(k.trip, { when: { type: 'enter', lat: CAMBRIA.lat, lng: CAMBRIA.lng, name: 'Cambria' }, fallback: 'Cambria.' });
  await k.fix(at('08:31'), MONTEREY);
  await k.to(at('09:01')); // tea fired, and is gone
  assert.ok(k.live.held.some((key) => key.includes('plan:bixby:')));
  await k.ws.delete(k.trip, '/plan/bixby.json', { author: 'user' });
  await k.settle();
  const held = k.live.held;
  assert.ok(!held.some((key) => key.includes(tea.id) || key.includes('plan:bixby:')), held.join(', '));
  assert.ok(held.some((key) => key.includes(cambria.id)));
  assert.ok(held.some((key) => key.includes('plan:nepenthe:')));
});

test("a plan item removed and made again remembers what it fired, as the log does: its arrival doesn't fire a second time", async () => {
  const k = await liveKit({ plan: { bixby: BIX } });
  await k.stay(BIXBY, at('09:30'), at('09:33'));
  const arrived = async () => (await k.events(['trigger.fired'])).filter((e) => e.data.watch === 'plan:bixby:arrived').length;
  assert.equal(await arrived(), 1);
  const item = await k.ws.readJSON(k.trip, '/plan/bixby.json');
  await k.ws.delete(k.trip, '/plan/bixby.json', { author: 'user' });
  await k.settle();
  await k.ws.write(k.trip, '/plan/bixby.json', item, { author: 'user' });
  await k.settle();
  await k.stay(BIXBY, at('09:34'), at('09:40'));
  assert.equal(await arrived(), 1);
});
