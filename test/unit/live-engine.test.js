import { test } from 'node:test';
import { NO_FIX_BACK_MS } from '../../src/core/live/activity.js';
import assert from 'node:assert/strict';
import { dueWords } from '../../src/core/time.js';
import { liveKit, at, iso, off, LA, MONTEREY, BIXBY, NEPENTHE, CAMBRIA, HEARST } from './live-kit.js';
import { readAppSettings } from '../../src/core/settings.js';
import { readWatches } from '../../src/core/live/watches.js';
import { createTrip, removeTrip, ME, SYS_DEVICE } from '../../src/core/scopes.js';
import { ManualClock, realClock } from '../../src/core/live/clock.js';
import { Live } from '../../src/core/live/live.js';
import { planWords } from '../../src/core/live/plan-watches.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };
const CASTLE = { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } };

test('clocks: a manual one runs its timers in order as it moves', async () => {
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
});

test('live mode on: GPS runs, the switch is kept, a state entry is logged and Shiori is woken once; off: GPS stops and the activity is unknown', async () => {
  const k = await liveKit({ live: false });
  assert.equal(k.sensors.gpsOn(), false);
  await k.live.setLive(true);
  assert.equal(k.sensors.gpsOn(), true);
  assert.equal((await readAppSettings(k.ws)).live.on, true);
  assert.deepEqual(k.agent.wakes.map((w) => w.kind), ['live']);
  assert.match(k.agent.wakes[0].text, /turned GPS on.*driving-companion/);
  await k.drive(MONTEREY, off(MONTEREY, 0, -3000), at('08:31'), at('08:34'));
  assert.equal(k.registry.list('activity')[0].now(), 'moving-fast');
  await k.live.setLive(false);
  assert.equal(k.sensors.gpsOn(), false);
  assert.equal(k.registry.list('activity')[0].now(), 'unknown');
  assert.equal(k.live.fix, null);
  const switched = async () => (await k.events(['state'])).filter((e) => e.data.live);
  assert.deepEqual((await switched()).map((e) => e.data.live), ['on', 'off']);
  assert.equal(k.agent.wakes.length, 1);
  await k.live.setLive(false);
  assert.equal((await switched()).length, 2);
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
  assert.equal(w.text, `Your watch ${call.id} (at ${dueWords(iso('10:00'))}) fired: the time came: ${dueWords(iso('10:00'))}. Its reminder: "Call Mia about dinner."`);
  assert.deepEqual(w.fallbacks, [{ watch: call.id, text: 'Call Mia about dinner.' }]);
  const [fired] = await k.events(['trigger.fired']);
  assert.deepEqual(fired.data, { watch: call.id, type: 'time', owner: 'shiori', text: `the time came: ${dueWords(iso('10:00'))}`, fallback: 'Call Mia about dinner.' });
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

test('moved fires after its km from when it was set: wakes do not start the count again (second drive); with repeat, it counts again from each firing', async () => {
  const k = await liveKit();
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, repeat: true, fallback: 'Narrate.' });
  await k.drive(MONTEREY, off(MONTEREY, 0, -3000), at('09:00'), at('09:03'));
  k.agent.woke(); // she woke for something else
  await k.drive(off(MONTEREY, 0, -3000), off(MONTEREY, 0, -5500), at('09:03:05'), at('09:06'));
  assert.equal(k.agent.wakes.length, 1);
  assert.match(k.agent.wakes[0].text, new RegExp(`^Your watch ${w.id} \\(after 5 km travelled\\) fired: you have travelled 5\\.\\d km since this watch last started counting`));
  await k.drive(off(MONTEREY, 0, -5500), off(MONTEREY, 0, -9000), at('09:06:05'), at('09:09'));
  assert.equal(k.agent.wakes.length, 1, 'counting again from that firing: 3.5 km');
  await k.drive(off(MONTEREY, 0, -9000), off(MONTEREY, 0, -11000), at('09:09:05'), at('09:11'));
  assert.equal(k.agent.wakes.length, 2);
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
  // Shiori reads the English; the user's words are made from its data, the same in English.
  const leave = 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 36 min by car.';
  assert.deepEqual(k.agent.wakes[0].fallbacks.map((/** @type {any} */ f) => [f.watch, f.text, planWords(f.plan)]), [['plan:nepenthe:leave', leave, leave]]);
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
  // An arrival is a cue for her, not a reminder: its fallback is only for when no model answers (emulator pass, spec §11.3).
  assert.deepEqual(k.agent.wakes[0].fallbacks.map((/** @type {any} */ f) => f.cue), [true]);
  const [fired] = await k.events(['trigger.fired']);
  assert.deepEqual(fired.data.place, { name: 'Bixby Creek Bridge', ...BIXBY });
});

test('running late for a fixed item, from where the user is (spec §11.3)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  await k.stay(BIXBY, at('11:00'), at('11:30'), 30);
  assert.equal(k.agent.wakes.length, 2);
  assert.match(k.agent.wakes[0].text, /^Plan: time to leave soon for "Lunch at Nepenthe"/);
  assert.equal(k.agent.wakes[1].text, 'Plan: running late for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away, about 36 min by car, so about 5 min late.');
  const late = 'Running late: Lunch at Nepenthe at 12:00. About 36 min away.';
  assert.deepEqual(k.agent.wakes[1].fallbacks.map((/** @type {any} */ f) => [f.watch, f.text, planWords(f.plan)]), [['plan:nepenthe:late', late, late]]);
});

test('another trip opened: its watches and its log; a time watch of the first still reminds; nothing goes into a removed trip', async () => {
  const k = await liveKit({ live: false, plan: { nepenthe: NEP } });
  const first = k.trip;
  const w1 = await k.live.setWatch(first, { when: { type: 'time', at: iso('09:00') }, fallback: 'Pack the snacks.' });
  const w2 = await k.live.setWatch(first, { when: { type: 'every', minutes: 10 }, fallback: 'Every ten.' });
  // The kit's trip is over, so Cambria is the only one happening and in play, not by winning a tie (ids made in one millisecond tie at random). The open alone doesn't move play.
  await k.ws.patch(first, '/trip.json', { start: '2026-11-01', end: '2026-11-02' }, { author: 'user' });
  const second = await createTrip(k.ws, { title: 'Cambria', start: '2026-11-27', end: '2026-11-27' });
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
  assert.deepEqual(k.live.nowInfo(), { place: 'unknown (GPS is off, so annai has none)', activity: 'unknown (GPS is off)' });
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
  assert.equal(k.live.watchText(w), `Set ${w.id}: after 15 km travelled, every time, until ${iso('18:00')}. GPS is off, so it waits until the user turns it on. Now: unknown (GPS is off); unknown (GPS is off, so annai has none).`);
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
  // Nothing is happening: the first trip ended last week, so with no trip talked in, play is the open conversation, and only the open makes live mode look at the second.
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-01', end: '2026-11-02' }, { author: 'user' });
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

test('a failure told is the same problem when only its numbers change: a card for it once, not one a minute', async () => {
  /** @type {unknown[]} */
  const problems = [];
  const k = await liveKit({ problem: (e) => problems.push(e) });
  await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 1 }, fallback: 'Look up.' });
  let free = 4096;
  const tx = k.store.tx.bind(k.store);
  k.store.tx = (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => tx(names, mode, (/** @type {any} */ t) => fn(new Proxy(t, {
    get(o, key) {
      const v = o[key];
      if (key === 'appendEvent') return (/** @type {string} */ scope, /** @type {any} */ e) => (e.type === 'trigger.fired' ? Promise.reject(new Error(`The disk is full: ${free--} bytes left.`)) : o.appendEvent(scope, e));
      return typeof v === 'function' ? v.bind(o) : v;
    },
  })));
  await k.to(at('08:36'));
  assert.ok(free < 4093, 'it failed every minute');
  assert.equal(problems.length, 1);
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

/** Driving south from Monterey at 12–15 m/s, a fix every 5 s from t0 for so many seconds; returns where it ended. @param {any} k @param {number} t0 @param {number} secs */
async function fastFrom(k, t0, secs) {
  let p = MONTEREY;
  for (let s = 0; s <= secs; s += 5) {
    const speed = 12 + (s % 20) / 5; // 12 to 15 m/s
    p = off(p, 0, -speed * 5);
    await k.fix(t0 + s * 1000, p, { speed });
  }
  return p;
}

test('parking after a drive: the slower speed held completes on the recheck, not only on a new fix; no fix for 2 min reads as still (drive test 2026-11-02)', async () => {
  const k = await liveKit({ start: at('17:00') });
  const leftFast = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', edge: 'stop' }, fallback: 'Stopped driving.' });
  const p = await fastFrom(k, at('17:00'), 300);
  assert.equal(k.live.activity, 'moving-fast');
  const parked = off(p, 0, -30);
  /** @type {string[]} */
  const seen = [];
  k.registry.list('activity')[0].onChange(() => { seen.push(k.live.activity); });
  for (const [t, speed] of /** @type {const} */ ([['17:05:10', 0.8], ['17:05:30', 1.3], ['17:05:55', 1.5]])) await k.fix(at(t), parked, { speed });
  await k.to(at('17:06:09'));
  assert.equal(k.live.activity, 'moving-fast', 'the slower speed has held 59 s');
  await k.to(at('17:06:10'));
  assert.equal(k.live.activity, 'walking', 'a minute after the first slow fix, with no new fix');
  assert.deepEqual(k.agent.wakes.filter((w) => w.text.includes(leftFast.id)).length, 1, 'the activity watch fired on the recheck');
  await k.to(at('17:07:54'));
  assert.equal(k.live.activity, 'walking');
  await k.to(at('17:07:55'));
  assert.equal(k.live.activity, 'still', 'no fix for 2 min after a slow speed');
  assert.match(k.live.nowInfo().activity, /^still$/);
  assert.deepEqual(seen, ['walking', 'still']);
});

test('parking on the second drive\'s points, with the recheck: moving fast has gone a minute after the slow speed, and the status reads still well before six minutes; a 3-minute arrived fires on them', async () => {
  const k = await liveKit({ start: at('17:00') });
  await k.fix(at('17:00'), MONTEREY, { speed: 0 });
  const arrived = await k.live.setWatch(k.trip, { when: { type: 'arrived', minutes: 3 }, fallback: 'Parked.' });
  const p = await fastFrom(k, at('17:00:05'), 300);
  const t0 = at('17:05:10');
  /** @type {[number, number | null, number][]} */
  const points = [[0, 8.6, 8], [62, 3.2, 8], [136, 0.8, 8], [233, null, 13], [294, 0.3, 8], [354, null, 8]];
  /** @type {Record<number, string>} */
  const read = {};
  for (const [s, speed, accuracy] of points) {
    await k.fix(t0 + s * 1000, p, { speed, accuracy });
    read[s] = k.live.activity;
  }
  assert.equal(read[136], 'moving-fast');
  assert.notEqual(read[233], 'moving-fast', 'about 4 minutes on');
  assert.equal(read[294], 'still');
  const fired = k.agent.wakes.filter((w) => w.text.includes(arrived.id));
  assert.equal(fired.length, 1, 'the stop began with the first of these points');
  assert.match(fired[0].text, /you've stopped for 3 min somewhere new/);
});

test('a red light does not fire "moving fast starts" again; the end of the drive and the next drive do', async () => {
  const k = await liveKit({ start: at('17:00') });
  const starts = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'Off we go.' });
  const ends = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast', edge: 'stop' }, repeat: true, fallback: 'Stopped.' });
  const count = (/** @type {{ id: string }} */ w) => k.agent.wakes.filter((x) => x.text.includes(w.id)).length;
  let p = await fastFrom(k, at('17:00'), 300);
  assert.equal(count(starts), 1);
  await k.stay(p, at('17:05:10'), at('17:07:30')); // a long red light: long enough to read still
  assert.equal(k.live.activity, 'still');
  assert.equal(count(ends), 1);
  p = await fastFrom(k, at('17:07:40'), 200);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(starts), 1, 'the same drive');
  await k.stay(p, at('17:11:10'), at('17:13:00'));
  assert.equal(count(ends), 2);
  await k.stay(p, at('17:13:10'), at('17:19:00'), 60);
  p = await fastFrom(k, at('17:19:10'), 100);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(starts), 2, 'stopped for over five minutes: a new drive');
});

test('every change of activity is logged once, on this device, from a fix or from the recheck, with what it rested on and no position', async () => {
  const k = await liveKit({ start: at('17:00') });
  /** @type {string[]} */
  const told = [];
  k.registry.list('activity')[0].onChange(() => told.push(k.live.activity));
  const p = await fastFrom(k, at('17:00'), 120);
  const parked = off(p, 0, -30);
  for (const [t, speed] of /** @type {const} */ ([['17:02:10', 0.8], ['17:02:30', 0.3], ['17:02:55', 1.1]])) await k.fix(at(t), parked, { speed });
  await k.to(at('17:09')); // no more fixes: moving fast ended on the recheck
  const states = (await k.events(['state'], SYS_DEVICE)).filter((e) => e.data.activity && e.data.from !== e.data.activity); // the changes; a beat has from equal to activity
  assert.deepEqual(states.map((e) => e.data.activity), told.filter((x, i) => x !== told[i - 1]), 'listeners are also told when the hold of voice is over');
  assert.deepEqual(states.map((e) => [e.data.from, e.data.activity]), [['unknown', 'moving-fast'], ['moving-fast', 'still']]);
  const end = states[1].data;
  assert.deepEqual(Object.keys(end).sort(), ['activity', 'ended', 'from', 'gapS', 'heards', 'heldS', 'odometer', 'readings', 'speed']);
  assert.ok(end.heldS >= 60 && end.heldS < 120, `held ${end.heldS} s`);
  assert.equal(end.heards, 0);
  assert.equal(end.readings.still, 1);
  assert.equal(end.readings.walking, 2);
  assert.ok(!JSON.stringify(states).includes('lat') && !JSON.stringify(states).includes('lng'));
});

test('a tunnel: moving fast, then 3 min with no fix, stays moving fast', async () => {
  const k = await liveKit({ start: at('17:00') });
  await fastFrom(k, at('17:00'), 300);
  await k.to(at('17:08'));
  assert.equal(k.live.activity, 'moving-fast');
});

test('after parking with no more fixes, arrived and dwell fire on the recheck', async () => {
  const k = await liveKit({ start: at('17:00') });
  await k.fix(at('17:00'), MONTEREY, { speed: 0 });
  const arrived = await k.live.setWatch(k.trip, { when: { type: 'arrived', minutes: 3 }, fallback: 'Arrived.' }); // set where the drive starts
  const p = await fastFrom(k, at('17:00:05'), 300);
  const parked = off(p, 0, -30);
  const dwell = await k.live.setWatch(k.trip, { when: { type: 'dwell', lat: parked.lat, lng: parked.lng, radius: 25, minutes: 5 }, fallback: 'Five minutes here.' });
  for (const [t, speed] of /** @type {const} */ ([['17:05:10', 0.8], ['17:05:30', 1.3], ['17:05:55', 1.5]])) await k.fix(at(t), parked, { speed });
  const fired = (/** @type {string} */ id) => k.agent.wakes.filter((w) => w.text.includes(id)).length;
  const since = /** @type {number} */ (k.live.stop?.since);
  assert.ok(since >= at('17:05') && since <= at('17:05:10'), 'the stop began as the car slowed');
  await k.to(since + 3 * 60_000 - 1000);
  assert.equal(fired(arrived.id), 0);
  await k.to(since + 3 * 60_000);
  assert.equal(fired(arrived.id), 1, 'arrived: 3 min after the stop began, no new fix');
  await k.to(at('17:10:09'));
  assert.equal(fired(dwell.id), 0);
  await k.to(at('17:10:10'));
  assert.equal(fired(dwell.id), 1, 'dwell: 5 min inside, no new fix');
});

test('a plugin change while a slower speed is being held does not drop the change (the GPS restarts only after time off screen)', async () => {
  const k = await liveKit({ start: at('17:00') });
  const p = await fastFrom(k, at('17:00'), 300);
  const parked = off(p, 0, -30);
  for (const [t, speed] of /** @type {const} */ ([['17:05:10', 0.8], ['17:05:30', 1.3], ['17:05:55', 1.5]])) await k.fix(at(t), parked, { speed });
  await k.to(at('17:05:56'));
  k.registry.add('test', 'sensor', { kind: 'other', start: () => () => {} }); // a plugin installed meanwhile: the sensors are looked at again
  await k.settle();
  await k.to(at('17:06:10'));
  assert.equal(k.live.activity, 'walking', 'a minute after the first slow fix, as without the plugin change');
});

test('an urgent watch (drive-test design §7): stored with its mark, said so when set and listed, and its wake carries it; a plain one does not', async () => {
  const { validate } = await import('../../src/core/schema.js');
  const { WATCH_SCHEMA } = await import('../../src/core/live/watches.js');
  const base = { id: 'w-1', owner: 'shiori', when: { type: 'time', at: iso('10:00') }, fallback: 'Leave now.' };
  assert.deepEqual(validate(WATCH_SCHEMA, { ...base, urgent: true }), []);
  assert.deepEqual(validate(WATCH_SCHEMA, { ...base, urgent: false }), []);
  assert.deepEqual(validate(WATCH_SCHEMA, base), []);
  assert.notDeepEqual(validate(WATCH_SCHEMA, { ...base, urgent: 'yes' }), []);
  const k = await liveKit({ live: false });
  const leave = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Leave now for the last ferry.', urgent: true });
  const plain = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Tea time.', urgent: false });
  assert.equal(leave.urgent, true);
  assert.equal('urgent' in plain, false, 'absent is false');
  const stored = (await readWatches(k.ws, k.trip)).watches;
  assert.deepEqual([stored.find((w) => w.id === leave.id)?.urgent, stored.find((w) => w.id === plain.id)?.urgent], [true, undefined]);
  assert.match(k.live.watchText(leave), /^Set w-\S+: at Fri 2026-11-27 \d\d:\d\d \(GMT-8\), urgent\./);
  assert.ok((await k.live.listWatches(k.trip)).includes(`${leave.id}\tshiori\tat ${dueWords(iso('10:00'))}, urgent\tno\t`));
  await k.to(at('10:00'));
  assert.equal(k.agent.wakes.length, 1);
  assert.equal(k.agent.wakes[0].urgent, true);
  await k.to(at('11:00'));
  assert.equal(k.agent.wakes.length, 2);
  assert.equal('urgent' in k.agent.wakes[1], false);
});

/** The first leg of a drive, then the page reloads: a Live over the same store. */
const north = (/** @type {number} */ m) => off(MONTEREY, 0, -m);

test('a moved watch survives a reload: the odometer is kept on the device, so a reload at 2.5 km fires at 3 km', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 3 }, fallback: 'Narrate.' });
  await k.drive(MONTEREY, north(2500), at('09:00:05'), at('09:03'));
  assert.equal(k.agent.wakes.length, 0);
  await k.reload();
  await k.drive(north(2500), north(2900), at('09:03:05'), at('09:03:35'));
  assert.equal(k.agent.wakes.length, 0, '2.9 km');
  await k.drive(north(2900), north(3300), at('09:03:40'), at('09:04:10'));
  assert.equal(k.agent.wakes.length, 1);
  assert.match(k.agent.wakes[0].text, /you have travelled 3\.\d km/);
});

test('reloading every 2 km, a 5 km moved watch still fires; a repeat counts from its last firing across a reload', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, repeat: true, fallback: 'Narrate.' });
  let t = at('09:00:05');
  const leg = async (/** @type {number} */ a, /** @type {number} */ b) => {
    await k.drive(north(a), north(b), t, t + 60_000);
    t += 65_000;
  };
  await leg(0, 2000);
  await k.reload();
  await leg(2000, 4000);
  await k.reload();
  assert.equal(k.agent.wakes.length, 0, '4 km');
  await leg(4000, 6000);
  assert.equal(k.agent.wakes.length, 1);
  await k.reload();
  await leg(6000, 9000); // 3 km since the firing at 5 km: 8 km
  assert.equal(k.agent.wakes.length, 1);
  await leg(9000, 11000);
  assert.equal(k.agent.wakes.length, 2, 'ten km: the second 5 km is done');
});

test('a drive while annai was closed counts once: the leg to the first fix back is the odometer\'s, not also the log\'s', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 3.5 }, fallback: 'Narrate.' });
  await k.drive(MONTEREY, north(1000), at('09:00:05'), at('09:01'));
  k.live.dispose();
  await k.clock.advanceTo(at('09:03'), k.settle);
  await k.reload();
  await k.fix(at('09:03:05'), north(3200), { speed: 14 }); // 2.2 km since the last point: 3.2 km in all
  assert.equal(k.agent.wakes.filter((w) => w.text.includes('travelled')).length, 0, 'counted twice it would be 5.4 km');
  await k.drive(north(3200), north(3700), at('09:03:10'), at('09:03:50'));
  assert.equal(k.agent.wakes.filter((w) => w.text.includes('travelled')).length, 1);
});

test('a moved watch says where it counts from, near a named place, after a repeat from its last firing; without a place it says it as before', async () => {
  const START = { title: 'Old Harbor', fixed: false, start: { at: iso('08:30'), tz: LA }, place: { name: 'Old Harbor', ...MONTEREY } };
  const MIDWAY = { title: 'Half Moon Diner', fixed: false, start: { at: iso('09:30'), tz: LA }, place: { name: 'Half Moon Diner', ...north(5000) } };
  const k = await liveKit({ start: at('09:00'), plan: { harbor: START, diner: MIDWAY } });
  await k.fix(at('09:00'), MONTEREY, { speed: 0 });
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 4 }, repeat: true, fallback: 'Narrate.' });
  assert.deepEqual(/** @type {any} */ (w).setAt, { lat: MONTEREY.lat, lng: MONTEREY.lng, km: 0 });
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches[0].setAt, { lat: MONTEREY.lat, lng: MONTEREY.lng, km: 0 });
  const moved = () => k.agent.wakes.filter((x) => x.text.includes('travelled'));
  await k.drive(MONTEREY, north(4600), at('09:00:05'), at('09:04'));
  assert.match(moved()[0].text, /you have travelled 4\.\d km since near Old Harbor/);
  await k.reload();
  await k.drive(north(4600), north(9000), at('09:04:05'), at('09:08'));
  assert.equal(moved().length, 2);
  assert.match(moved()[1].text, /since near Half Moon Diner/, 'from where the first firing was');
  const far = await liveKit({ start: at('09:00') });
  await far.live.setWatch(far.trip, { when: { type: 'moved', km: 2 }, fallback: 'Narrate.' });
  await far.drive(MONTEREY, north(2400), at('09:00:05'), at('09:03'));
  assert.match(far.agent.wakes[0].text, /km since this watch last started counting\./);
});

test('activity survives a reload: mid-drive and at a red light nothing fires again; after ten minutes parked, moving off does', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'Off we go.' });
  const count = () => k.agent.wakes.filter((w) => w.text.includes(starts.id)).length;
  let p = await fastFrom(k, at('09:00'), 120);
  assert.equal(count(), 1);
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast', 'restored');
  p = await fastFrom(k, at('09:02:10'), 60);
  assert.equal(count(), 1, 'mid-drive');
  await k.stay(p, at('09:03:20'), at('09:05:00')); // a light long enough to read still
  assert.equal(k.live.activity, 'still');
  await k.restart();
  assert.equal(k.live.activity, 'still');
  await fastFrom(k, at('09:05:10'), 100);
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(count(), 1, 'a reload at a red light');
  await k.stay(p, at('09:07:00'), at('09:20:00'), 30); // parked for good
  await k.restart();
  assert.equal(k.live.activity, 'still');
  await fastFrom(k, at('09:20:10'), 100);
  assert.equal(count(), 2, 'ten minutes parked');
  // Closed for ten minutes: nothing is known of the activity.
  k.live.dispose();
  await k.clock.advanceTo(at('09:35'), k.settle);
  await k.restart();
  assert.equal(k.live.activity, 'unknown');
});

test('each page load writes one app.start on this device', async () => {
  const k = await liveKit();
  const starts = async () => (await k.events(['app.start'], SYS_DEVICE)).length;
  assert.equal(await starts(), 1);
  await k.restart();
  assert.equal(await starts(), 2);
});

test('a parked phone with GPS on writes a state entry every 5 minutes with its largest speed and accuracy; with GPS off, none', async () => {
  const k = await liveKit({ start: at('09:00') });
  for (let s = 0; s <= 720; s += 30) await k.fix(at('09:00') + s * 1000, MONTEREY, { speed: s % 90 === 0 ? 0.4 : 0.1, accuracy: 10 + (s % 60) });
  const states = async () => (await k.events(['state'], SYS_DEVICE)).filter((e) => e.data.activity);
  const beats = (await states()).filter((e) => e.data.from === e.data.activity);
  assert.equal(beats.length, 2, 'at about 5 and 10 minutes');
  for (const b of beats) {
    assert.equal(b.data.activity, 'still');
    assert.deepEqual(Object.keys(b.data).sort(), ['activity', 'from', 'gapS', 'heards', 'heldS', 'maxAccuracy', 'maxSpeed', 'odometer', 'readings', 'speed']);
    assert.equal(b.data.maxSpeed, 0.4);
    assert.equal(b.data.maxAccuracy, 10 + 30);
  }
  assert.ok(beats[1].ts - beats[0].ts >= 300_000 && beats[1].ts - beats[0].ts < 360_000);
  await k.live.setLive(false);
  const n = (await states()).length;
  await k.to(at('09:00') + 60 * 60_000);
  assert.equal((await states()).length, n);
});

/** Reloads at the given metres along the road north, as a phone does it (out of view first), every watch counting the same. */
const roadTo = async (/** @type {any} */ k, /** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ t0) => {
  await k.drive(north(a), north(b), t0, t0 + Math.max(30, (b - a) / 12) * 1000);
  return t0 + Math.max(30, (b - a) / 12) * 1000 + 5000;
};
const movedWakes = (/** @type {any} */ k) => k.agent.wakes.filter((/** @type {any} */ w) => w.text.includes('travelled'));

test('a page killed unseen loses nothing: the record\'s odometer and place are of one moment, so the way since counts at the first fix back', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 3 }, fallback: 'Narrate.' });
  let t = await roadTo(k, 0, 2500, at('09:00:05'));
  await k.restart(); // no beat on the way out
  t = await roadTo(k, 2500, 2900, t);
  assert.equal(movedWakes(k).length, 0, '2.9 km');
  await roadTo(k, 2900, 3300, t);
  assert.equal(movedWakes(k).length, 1, 'by 3.3 km, as if nothing had happened');
});

test('one fix with an accuracy of 1500 m adds nothing to the way, and neither does a manual place far away (re-review)', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 5 }, fallback: 'Narrate.' });
  let t = await roadTo(k, 0, 1500, at('09:00:05'));
  await k.fix(t, off(north(1500), 1500, 0), { accuracy: 1500, speed: null });
  t = await roadTo(k, 1500, 2000, t + 5000);
  await k.reload();
  t = await roadTo(k, 2000, 2500, t);
  assert.equal(movedWakes(k).length, 0, 'a glitch of 1.5 km out and back is not 3 km');
  await k.live.place({ lat: MONTEREY.lat + 0.72, lng: MONTEREY.lng }); // 80 km away: the user says so
  await k.reload();
  t = await roadTo(k, 2500, 4500, t + 60_000);
  assert.equal(movedWakes(k).length, 0, 'a manual place is not travel');
  await roadTo(k, 4500, 5600, t);
  assert.equal(movedWakes(k).length, 1, 'the real 5 km');
});

test('parked for two hours with 30 m of jitter, a 1 km moved watch does not fire, reloads included (re-review)', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.fix(at('09:00'), MONTEREY, { speed: 0 });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 1 }, fallback: 'Narrate.' });
  for (let min = 1; min <= 120; min++) {
    const a = (min * 53) % 360;
    await k.fix(at('09:00') + min * 60_000, off(MONTEREY, 30 * Math.cos(a), 30 * Math.sin(a)), { accuracy: 25 + (min % 6), speed: null });
    if (min % 40 === 0) await k.reload();
  }
  assert.equal(movedWakes(k).length, 0);
});

for (const where of /** @type {const} */ (['me', 'another trip'])) {
  test(`a moved watch in ${where} counts the same, across reloads and while another conversation is open (re-review)`, async () => {
    const k = await liveKit({ start: at('09:00') });
    // The kit's trip is over, so Elsewhere is the only one happening (a tie between trips made in one millisecond goes by a random part of the id).
    await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-01', end: '2026-11-02' }, { author: 'user' });
    const other = await createTrip(k.ws, { title: 'Elsewhere', start: '2026-11-27', end: '2026-11-28' });
    const scope = where === 'me' ? ME : other;
    const w = await k.live.setWatch(scope, { when: { type: 'moved', km: 5 }, fallback: 'Narrate.' });
    let t = await roadTo(k, 0, 2500, at('09:00:05'));
    await k.reload();
    t = await roadTo(k, 2500, 4600, t);
    assert.equal(movedWakes(k).length, 0, 'its conversation is not open');
    k.agent.opened(scope === ME ? null : scope); // now it is: 4.6 km of the way are counted
    await k.settle();
    assert.equal(k.agent.wakes.filter((x) => x.text.includes(w.id)).length, 0, '4.6 km');
    await roadTo(k, 4600, 5600, t);
    assert.equal(k.agent.wakes.filter((x) => x.text.includes(w.id)).length, 1);
  });
}

test('a repeating moved watch stays within 0.3 km of its distance at any reload rate; a firing records the odometer', async () => {
  const k = await liveKit({ start: at('09:00') });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 1 }, repeat: true, fallback: 'Narrate.' });
  let t = at('09:00:05');
  for (let a = 0; a < 9000; a += 700) {
    t = await roadTo(k, a, a + 700, t);
    await k.reload();
  }
  const fired = await k.events(['trigger.fired']);
  const kms = fired.map((e) => e.data.km);
  assert.ok(kms.length >= 5 && kms.every((x) => typeof x === 'number'), `fired ${kms.length} times, at ${kms.join(', ')}`);
  for (let i = 1; i < kms.length; i++) assert.ok(Math.abs(kms[i] - kms[i - 1] - 1) <= 0.3, `${kms[i - 1]} to ${kms[i]}`);
  assert.ok(kms.length <= 9);
});

test('a moved watch counts from the odometer where it was set; one from a backup restored elsewhere (a reading above this odometer) counts from now', async () => {
  const k = await liveKit({ start: at('09:00') });
  await roadTo(k, 0, 2000, at('09:00:05'));
  const w = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 3 }, fallback: 'Narrate.' });
  assert.ok(/** @type {any} */ (w).setAt.km >= 1.5, `set at ${JSON.stringify(/** @type {any} */ (w).setAt)}`);
  await k.ws.write(k.trip, '/watches/w-far.json', { id: 'w-far', owner: 'shiori', when: { type: 'moved', km: 1 }, fallback: 'Far.', created: new Date(at('08:00')).toISOString(), setAt: { km: 900 } }, { author: 'shiori' });
  await k.reload();
  assert.equal(k.live.odometer > 1.5, true, 'the odometer is read back');
  await roadTo(k, 2000, 2500, at('09:03'));
  assert.equal(k.agent.wakes.filter((x) => x.text.includes('w-far')).length, 0, 'half a km from now');
  await roadTo(k, 2500, 3300, at('09:04'));
  assert.equal(k.agent.wakes.filter((x) => x.text.includes('w-far')).length, 1, 'a km from now');
});

test('the odometer is read back whatever its age, and a simulation leaves the device\'s alone', async () => {
  const k = await liveKit({ start: at('09:00') });
  await roadTo(k, 0, 2500, at('09:00:05'));
  await k.reload();
  const km = k.live.odometer;
  assert.ok(km > 2, `${km}`);
  k.live.dispose();
  await k.clock.advanceTo(at('09:00') + 3 * 86_400_000, k.settle);
  await k.restart();
  assert.equal(k.live.odometer, km, 'three days on');
  assert.equal(k.live.activity, 'unknown');
});

test('app.start is written by logStart once the installed plugins have started, not as live mode starts; it says what was restored', async () => {
  const k = await liveKit({ start: at('09:00') });
  await fastFrom(k, at('09:00'), 90);
  const starts = async () => (await k.events(['app.start'], SYS_DEVICE)).map((e) => e.data);
  assert.deepEqual(await starts(), [{ gps: 'on', activity: 'unknown' }]);
  k.live.dispose();
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, keep: k.keep });
  await again.start();
  await again.settled();
  assert.equal((await starts()).length, 1, 'start() writes none');
  await again.logStart();
  assert.deepEqual(await starts(), [{ gps: 'on', activity: 'unknown' }, { gps: 'on', activity: 'moving-fast' }]);
});

test('reloading every 3 minutes on screen or off, moving fast is restored every time and "starts" fires once (re-review)', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'Off we go.' });
  const count = () => k.agent.wakes.filter((w) => w.text.includes(starts.id)).length;
  let t = at('09:00');
  let y = 0;
  const drive = async (/** @type {number} */ secs) => {
    for (const end = t + secs * 1000; t <= end; t += 5000) await k.fix(t, north((y += 60)), { speed: 12 });
  };
  await drive(180);
  assert.equal(count(), 1);
  for (let i = 0; i < 5; i++) {
    await k.restart(); // killed: no entry on the way out
    assert.equal(k.live.activity, 'moving-fast', `reload ${i + 1}`);
    await drive(180);
  }
  assert.equal(count(), 1);
  // Off screen the entry ages too: a drive of six minutes, two more with the screen off, and a reload.
  k.sensors.visible(false);
  await k.settle();
  await k.to(t + 120_000);
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast', 'back after two minutes off screen');
});

test('moving fast holds after a reload with no fix at all, and ends at the bound, not at 15 min (re-review; one false "stops", 2026-11-05)', async () => {
  const k = await liveKit({ start: at('09:00') });
  await fastFrom(k, at('09:00'), 90);
  await k.restart();
  assert.equal(k.live.activity, 'moving-fast');
  await k.to(at('09:01:30') + 125_000);
  assert.equal(k.live.activity, 'moving-fast', 'silence right after a reload says nothing of stopping');
  await k.to(at('09:01:30') + NO_FIX_BACK_MS);
  assert.equal(k.live.activity, 'still');
});

test('parked and locked for 40 minutes, page alive: unlocking does not hold voice or the "starts" watch for longer (re-review)', async () => {
  const k = await liveKit({ start: at('09:00') });
  const starts = await k.live.setWatch(k.trip, { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'Off we go.' });
  const count = () => k.agent.wakes.filter((w) => w.text.includes(starts.id)).length;
  const p = await fastFrom(k, at('09:00'), 120);
  assert.equal(count(), 1);
  await k.fix(at('09:02:10'), p, { speed: 0.3 }); // parked: the hold begins
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('09:42:10'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('09:42:15'), p, { speed: 0.2 });
  assert.equal(k.live.activity, 'still');
  assert.equal(k.registry.list('activity')[0].held(), false, 'voice is not held for the 40 minutes');
  await fastFrom(k, at('09:43:15'), 60);
  assert.equal(count(), 2, 'driving off a minute later is a new drive');
});
