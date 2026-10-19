import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, fakeAgent, fakeSensors, at, iso, off, LA, MONTEREY, BIXBY, RIVER_INN, NEPENTHE } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };

test('back on screen: a time watch that came due fires late and labelled, with moved, in one catch-up wake with the time away and the distance (spec §11.4)', async () => {
  const k = await liveKit();
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.live.setWatch(k.trip, { when: { type: 'moved', km: 10 }, repeat: true, fallback: 'Narrate.' });
  await k.drive(MONTEREY, off(MONTEREY, 0, -2000), at('09:40'), at('09:42'));
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:30'));
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 0); // waiting for a fix
  await k.fix(at('10:30:05'), off(MONTEREY, 0, -20_000), { speed: 15 });
  assert.equal(k.agent.wakes.length, 1);
  const w = k.agent.wakes[0];
  assert.equal(w.kind, 'catch-up');
  assert.ok(w.text.startsWith('Catch-up: annai was off screen for 48 min (since 09:42), and the user moved 18.0 km. '), w.text);
  assert.ok(w.text.includes(`Your watch ${tea.id} (at ${iso('10:00')}) fired: the time came: ${iso('10:00')} (late by 30 min: annai was off screen). Its reminder: "Tea time."`), w.text);
  assert.match(w.text, /fired: you have travelled 20\.\d km since your last wake\. Its reminder: "Narrate\."$/);
  assert.deepEqual(w.fallbacks.map((/** @type {any} */ f) => f.text), ['Tea time.', 'Narrate.']);
  assert.deepEqual((await k.events(['trigger.fired'])).map((e) => [e.data.late ?? 0, e.data.catchUp]), [[30, true], [0, true]]);
});

test("leaving is inferred from where the user was against where they are; the plan's leave reminder that came due while away fires late", async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  await k.stay(BIXBY, at('10:50'), at('10:51'));
  const bye = await k.live.setWatch(k.trip, { when: { type: 'leave', lat: BIXBY.lat, lng: BIXBY.lng, name: 'Bixby Bridge' }, fallback: 'Bye, Bixby.' });
  await k.stay(BIXBY, at('10:51:10'), at('10:52'));
  const before = k.agent.wakes.length; // arrived at Bixby, 2 min after stopping
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('11:40'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('11:40:05'), RIVER_INN);
  assert.equal(k.agent.wakes.length, before + 1);
  const w = k.agent.wakes.at(-1);
  assert.equal(w.kind, 'catch-up');
  assert.ok(w.text.startsWith('Catch-up: annai was off screen for 48 min (since 10:52), and the user moved 14.1 km from near Bixby Creek Bridge. '), w.text);
  assert.ok(w.text.includes('Plan: time to leave soon for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away in a straight line, about 36 min by car (late by 31 min: annai was off screen).'), w.text);
  assert.ok(w.text.includes(`Your watch ${bye.id} (on leaving Bixby Bridge (200 m)) fired: you left Bixby Bridge, now 14.1 km away. Its reminder: "Bye, Bixby."`), w.text);
});

test('arriving is inferred on coming back inside a plan place', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  await k.drive(RIVER_INN, off(RIVER_INN, 0, -500), at('11:40'), at('11:41'));
  const before = k.agent.wakes.length; // the leave reminder came at 11:40
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('11:55'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('11:55:05'), NEPENTHE);
  assert.equal(k.agent.wakes.length, before + 1);
  assert.ok(k.agent.wakes.at(-1).text.endsWith('Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (fixed, 12:00), inferred on coming back on screen.'));
});

test('nothing came due while away: no wake (choice 12); no fix comes back: the catch-up goes after 15 s with what the clock made due', async () => {
  const k = await liveKit();
  await k.fix(at('09:00'), MONTEREY);
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('09:30'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('09:30:05'), MONTEREY);
  assert.equal(k.agent.wakes.length, 0);
  assert.equal(k.clock.pending, 1); // only the minute's look
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Ten.' });
  await k.to(at('09:50'));
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:10'));
  k.sensors.visible(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('10:10:15'));
  assert.equal(k.agent.wakes.length, 1);
  assert.ok(k.agent.wakes[0].text.startsWith('Catch-up: annai was off screen for 20 min (since 09:50). Your watch'), k.agent.wakes[0].text);
});

test('after a restart: an overdue time watch fires late, an every watch once (not twenty times), nothing for a plan item long past; the distance from the last point counts', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const once = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:00') }, fallback: 'Nine.' });
  const every = await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 30 }, fallback: 'Half hour.' });
  await k.fix(at('08:31'), MONTEREY);
  k.live.dispose();
  // annai is closed until 18:30, then starts again
  const clock = new ManualClock(at('18:30'));
  const agent = fakeAgent(k.trip);
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent, clock, timeZone: () => LA });
  await live.start();
  await live.settled();
  assert.equal(agent.wakes.length, 0); // live mode was on: it waits for a fix
  sensors.fix({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 8, speed: 0 });
  await live.settled();
  assert.equal(agent.wakes.length, 1);
  const w = agent.wakes[0];
  assert.equal(w.kind, 'catch-up');
  assert.match(w.text, /^Catch-up: annai was closed for 9 h 59 min \(since 08:31\), and the user moved 4\d\.\d km to near Nepenthe\. /);
  assert.ok(w.text.includes(`Your watch ${once.id} (at ${iso('09:00')}) fired: the time came: ${iso('09:00')} (late by 570 min: annai was closed).`));
  assert.ok(w.text.includes(`Your watch ${every.id} (every 30 min) fired: 30 min since you set it (late by 570 min: annai was closed).`));
  assert.ok(!w.text.includes('Nepenthe"'), 'no plan reminder for lunch, long past');
  await clock.advanceTo(at('19:00'), () => live.settled());
  assert.equal(agent.wakes.length, 2); // every goes on from now
  assert.equal(agent.wakes[1].kind, 'trigger');
});

test('with no connection, annai says each reminder at once and holds the wakes; back online, one wake says what came (spec §17, choice 8)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  k.sensors.online(false);
  await k.settle();
  await k.to(at('10:00'));
  assert.deepEqual(k.agent.reminders, [{ watch: tea.id, text: 'Tea time.', scope: k.trip }]);
  assert.equal(k.agent.wakes.length, 0);
  await k.to(at('11:30')); // no position: the plan reminds half an hour before
  assert.deepEqual(k.agent.reminders.map((r) => r.text), ['Tea time.', 'Leave soon: Lunch at Nepenthe at 12:00.']);
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.online(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 1);
  assert.equal(k.agent.wakes[0].kind, 'trigger');
  assert.match(k.agent.wakes[0].text, /^While there was no connection \(for 3 h, since 08:30\), these came, and annai showed their reminders by itself: Your watch w-\S+ \(at [^)]+\) fired: the time came: [^.]+\. Its reminder: "Tea time\." Plan: time to leave soon for "Lunch at Nepenthe" \(fixed, 12:00\)\.$/);
  assert.deepEqual(k.agent.wakes[0].fallbacks, []);
  assert.ok((await k.events(['trigger.fired'])).every((e) => e.data.offline === true));
  k.sensors.online(true);
  await k.settle();
  assert.equal(k.agent.wakes.length, 1);
});

test("after a restart the way travelled while closed counts once, in the catch-up, and the odometer doesn't jump when the user later starts moving", async () => {
  const k = await liveKit();
  const moved = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 10 }, fallback: 'Ten km.' });
  await k.fix(at('08:31'), MONTEREY);
  k.live.dispose();
  // annai is closed while the user drives to Nepenthe, and starts again there.
  const clock = new ManualClock(at('10:30'));
  const agent = fakeAgent(k.trip);
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent, clock, timeZone: () => LA });
  await live.start();
  await live.settled();
  sensors.fix({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 8, speed: 0 });
  await live.settled();
  assert.equal(agent.wakes.length, 1);
  assert.equal(agent.wakes[0].kind, 'catch-up');
  assert.ok(agent.wakes[0].text.includes(`Your watch ${moved.id} (after 10 km travelled) fired: you have travelled 4`), agent.wakes[0].text);
  const km = live.odometer;
  assert.ok(km > 40 && km < 50, `odometer ${km}`);
  // Driving on from Nepenthe adds only the road from there.
  for (let s = 0; s <= 120; s += 5) {
    await clock.advanceTo(at('10:31') + s * 1000, () => live.settled());
    sensors.fix({ ...off(NEPENTHE, 0, -s * 15), accuracy: 8, speed: 15 });
    await live.settled();
  }
  assert.ok(live.odometer - km < 2, `odometer ${live.odometer}`);
  live.dispose();
});

test("a catch-up that ends before the first fix still counts the way travelled while closed once, at that fix, so the odometer doesn't jump when the user later moves", async () => {
  const k = await liveKit();
  const moved = await k.live.setWatch(k.trip, { when: { type: 'moved', km: 10 }, fallback: 'Ten km.' });
  await k.fix(at('08:31'), MONTEREY);
  k.live.dispose();
  const clock = new ManualClock(at('10:30'));
  const agent = fakeAgent(k.trip);
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent, clock, timeZone: () => LA });
  await live.start();
  await live.settled();
  // The GPS takes longer than the catch-up waits for it.
  await clock.advanceTo(at('10:30:20'), () => live.settled());
  assert.equal(agent.wakes.length, 0, 'nothing the clock made due');
  sensors.fix({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 8, speed: 0 });
  await live.settled();
  const km = live.odometer;
  assert.ok(km > 40 && km < 50, `odometer ${km}`);
  assert.ok(agent.wakes.some((/** @type {any} */ w) => w.text.includes(`Your watch ${moved.id} (after 10 km travelled) fired: you have travelled 4`)), JSON.stringify(agent.wakes));
  for (let s = 0; s <= 120; s += 5) {
    await clock.advanceTo(at('10:31') + s * 1000, () => live.settled());
    sensors.fix({ ...off(NEPENTHE, 0, -s * 15), accuracy: 8, speed: 15 });
    await live.settled();
  }
  assert.ok(live.odometer - km < 2, `odometer ${live.odometer}`);
  live.dispose();
});

test("a coarse first fix after coming back (a cell tower's, 800 m) leaves the way travelled meanwhile to the first good one, not to a jump when the user later moves (fix pass 2)", async () => {
  const k = await liveKit();
  await k.fix(at('08:31'), MONTEREY);
  k.live.dispose();
  const clock = new ManualClock(at('10:30'));
  const agent = fakeAgent(k.trip);
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent, clock, timeZone: () => LA });
  await live.start();
  await live.settled();
  sensors.fix({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 800, speed: 0 });
  await live.settled();
  await clock.advanceTo(at('10:30:30'), () => live.settled());
  sensors.fix({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 8, speed: 0 });
  await live.settled();
  const km = live.odometer;
  assert.ok(km > 40 && km < 50, `odometer ${km}`);
  for (let s = 0; s <= 120; s += 5) {
    await clock.advanceTo(at('10:31') + s * 1000, () => live.settled());
    sensors.fix({ ...off(NEPENTHE, 0, -s * 15), accuracy: 8, speed: 15 });
    await live.settled();
  }
  assert.ok(live.odometer - km < 2, `odometer ${live.odometer}`);
  live.dispose();
});
