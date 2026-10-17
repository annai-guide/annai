import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { liveKit, at, LA, MONTEREY, BIXBY } from './live-kit.js';
import { RULES, DRIVE, places } from './big-sur-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock, realClock } from '../../src/core/live/clock.js';
import { Simulation, trackFrom } from '../../src/core/live/simulate.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { SimRun } from '../../src/core/live/sim-run.js';
import { readJourney } from '../../src/core/after/journey.js';
import { readAppSettings } from '../../src/core/settings.js';
import { listTrips, createTrip } from '../../src/core/scopes.js';
import { dayIn } from '../../src/core/time.js';

test('a simulation takes live mode over: its clock, its sensors only, live on without saving the switch; then gives it back (choice 10)', async () => {
  const k = await liveKit({ live: false });
  const clock = new ManualClock(at('09:00'));
  const realWas = k.live.clock;
  const giveBack = await k.live.simulate({ clock, timeZone: () => LA, trip: k.trip });
  assert.equal(k.live.simulating, true);
  const sim = new Simulation({ registry: k.registry, track: [] });
  await k.live.setLive(true);
  await k.live.settled();
  assert.equal(k.live.on, true);
  assert.equal((await readAppSettings(k.ws)).live?.on, undefined); // not saved
  assert.equal(k.sensors.gpsOn(), false); // the phone's GPS isn't started
  k.sensors.visible(false); // the phone's own visibility isn't heard
  sim.send({ at: at('09:00'), kind: 'fix', fix: { lat: BIXBY.lat, lng: BIXBY.lng, accuracy: 8, speed: 0 } });
  await k.live.settled();
  assert.equal(k.live.shown, true);
  assert.equal(k.live.fix?.lat, BIXBY.lat);
  assert.equal(k.live.fix?.at, at('09:00')); // in the simulation's time
  const [point] = await k.events(['location']);
  assert.equal(point.ts, at('09:00'));
  sim.dispose();
  await giveBack();
  assert.equal(k.live.simulating, false);
  assert.equal(k.live.clock, realWas);
  assert.equal(k.live.on, false); // as the user left it
  assert.equal(k.live.fix, null);
  await assert.doesNotReject(giveBack()); // twice is fine
});

test("the Agent on a simulation's clock stamps the conversation in its time, then goes back to the device's (choice 11)", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Hi.' } }, { name: 'sleep', input: {} }] }]]);
  const t = Date.parse('2026-11-27T12:00:00-08:00');
  const restore = k.agent.useClock({ now: () => t, online: () => true, timeZone: () => LA });
  k.agent.send('Hello');
  assert.equal(k.agent.busy, true);
  await k.agent.idle();
  assert.equal(k.agent.busy, false);
  for (const e of await k.events(['msg.user', 'wake', 'out.speak'])) assert.equal(e.ts, t, e.type);
  restore();
  assert.notEqual(k.agent.now(), t);
});

/** A memory annai as the app has it: an Agent with Shiori's scripted rules, live mode on the real clock, the phone's sensors, and a SimRun. */
async function anApp(/** @type {any} */ o = {}) {
  const k = await agentKit([{ rules: RULES }], { agent: { fetch: places }, voice: { mode: 'auto' } });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const run = new SimRun({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, live, ...o });
  return { k, live, run };
}

test('Simulate a trip: the Big Sur sample, as fast as it can go, in a new trip of its own; afterwards everything is as it was (spec §13)', async () => {
  const { k, live, run } = await anApp();
  const { trip } = await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  assert.notEqual(trip, k.trip);
  assert.equal(run.running, true);
  await run.finished;
  assert.deepEqual([run.state?.done, run.state?.error, run.state?.stopped], [true, null, false]);
  assert.equal(run.state?.title, 'Big Sur on Highway 1: Monterey to Cambria (simulation)');
  const j = await readJourney({ store: k.store, ws: k.ws, trip });
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  assert.equal(j.tz, 'America/Los_Angeles');
  assert.equal((await k.ws.readJSON(trip, '/plan/nepenthe.json')).title, 'Lunch at Nepenthe');
  const wakes = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['wake'] }));
  assert.ok(wakes.length >= 20, String(wakes.length));
  assert.ok(wakes.every((e) => dayIn(e.ts, LA) === '2026-11-27'), 'stamped in simulated time');
  // As it was: the trip open before, live mode off and unsaved, the real clock.
  assert.equal(k.agent.target, k.trip);
  assert.equal((await readAppSettings(k.ws)).activeTrip, k.trip);
  assert.deepEqual([live.simulating, live.on, (await readAppSettings(k.ws)).live?.on], [false, false, undefined]);
  assert.ok(Math.abs(k.agent.now() - Date.now()) < 5000);
});

test("a recorded track: a trip's own points, played again in a new trip, earn the same stamps (choice 12)", async () => {
  const { k, run } = await anApp();
  const { trip: first } = await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await run.finished;
  const { trip } = await run.start({ kind: 'trip', trip: first }, { speed: 'fast' });
  await run.finished;
  assert.equal(run.state?.error, null);
  assert.equal(run.state?.title, 'Big Sur on Highway 1: Monterey to Cambria (simulation) (simulation)');
  const j = await readJourney({ store: k.store, ws: k.ws, trip });
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  assert.equal((await k.ws.readJSON(trip, '/bookings/lodge.json')).confirmation, 'CPL-5531');
});

test('at ten times real time it plays on its clock, pauses, changes speed and stops; stopped, everything is as it was', async () => {
  const base = new ManualClock(0);
  const { k, live, run } = await anApp({ base });
  const short = { name: 'Around Monterey', start: '2026-11-27T09:00:00-08:00', timezone: LA, route: [{ ...MONTEREY, leave: '09:05' }, { ...BIXBY, arrive: '09:35' }], endMin: 10 };
  await run.start({ kind: 'itinerary', itinerary: short }, { speed: 10 });
  const t0 = /** @type {number} */ (run.now());
  await base.advanceTo(60_000, () => live.settled());
  assert.equal(run.now(), t0 + 600_000); // a minute is ten
  run.pause();
  await base.advanceTo(120_000, () => live.settled());
  assert.equal(run.now(), t0 + 600_000);
  assert.equal(run.state?.paused, true);
  run.resume();
  run.setSpeed(60);
  assert.equal(run.state?.speed, 60);
  await base.advanceTo(150_000, () => live.settled());
  assert.equal(run.now(), t0 + 600_000 + 1_800_000);
  run.stop();
  await run.finished;
  assert.deepEqual([run.state?.done, run.state?.stopped], [true, true]);
  assert.deepEqual([live.simulating, live.on, k.agent.target], [false, false, k.trip]);
  assert.ok((await k.store.tx(['events'], 'readonly', (t) => t.listEvents(/** @type {string} */ (run.state?.trip), { types: ['location'] }))).length > 10);
});

test('opening another trip stops the simulation; that trip stays open, and nothing of the simulation goes into it (choice 10)', async () => {
  const base = new ManualClock(0);
  const { k, live, run } = await anApp({ base });
  const other = await createTrip(k.ws, { title: 'Kyoto in spring' });
  await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 10 });
  await base.advanceTo(120_000, () => live.settled()); // twenty minutes into the drive
  await k.agent.open(other);
  await base.advanceTo(240_000, () => live.settled());
  await run.finished;
  assert.deepEqual([run.state?.stopped, run.state?.done, k.agent.target], [true, true, other]);
  assert.deepEqual(await k.store.tx(['events'], 'readonly', (t) => t.listEvents(other, { types: ['location', 'trigger.fired'] })), []);
});

test('a broken itinerary is a plain error, and no trip is made; one already running refuses a second', async () => {
  const { k, run } = await anApp();
  const before = (await listTrips(k.store)).active.length;
  await assert.rejects(run.start({ kind: 'itinerary', itinerary: { name: 'x', start: 'soon', route: [] } }, { speed: 'fast' }), /^Error: An itinerary needs a start/);
  await assert.rejects(run.start({ kind: 'itinerary', itinerary: { ...DRIVE, plan: { bad: { title: 'No id' } } } }, { speed: 'fast' }), /The itinerary's plan item "bad" doesn't fit annai's plan format/);
  assert.equal((await listTrips(k.store)).active.length, before);
  assert.equal(run.running, false);
  await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await assert.rejects(run.start({ kind: 'itinerary', itinerary: DRIVE }), /^Error: A simulation is already running\. Stop it first\.$/);
  run.stop();
  await run.finished;
});
