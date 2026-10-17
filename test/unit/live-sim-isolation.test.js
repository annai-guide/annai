import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { RULES, DRIVE, places } from './big-sur-kit.js';
import { LA, MONTEREY, BIXBY, NEPENTHE, iso } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { SimRun } from '../../src/core/live/sim-run.js';
import * as simRun from '../../src/core/live/sim-run.js';
import { readWatches, saveWatch } from '../../src/core/live/watches.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { createTrip, ME } from '../../src/core/scopes.js';

/** Today, as the device has it: weeks before the sample's simulated Nov 27. */
const TODAY = Date.parse('2026-10-17T09:00:00-07:00');
const SIM = Date.parse('2026-11-27T12:00:00-08:00');

/**
 * A memory annai as the app has it, whose real clock the test moves: an Agent with Shiori's scripted
 * rules, live mode, the phone's sensors (none here), and a SimRun.
 * @param {{ live?: boolean, base?: ManualClock }} [o]
 */
async function anApp({ live: on = false, base } = {}) {
  const real = new ManualClock(TODAY);
  const k = await agentKit([{ rules: RULES }], { agent: { fetch: places, now: real.now, timeZone: () => LA }, voice: { mode: 'auto' } });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  if (on) await updateAppSettings(k.ws, { live: { on: true } });
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: real, timeZone: () => LA });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const run = new SimRun({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, live, ...(base ? { base } : {}) });
  /** Moves the real clock, letting live mode and Shiori do what comes due. @param {number} t */
  const to = (t) => real.advanceTo(t, async () => { await live.settled(); await k.agent.idle(); await live.settled(); });
  /** @param {string} scope @param {string[]} types */
  const events = (scope, types) => k.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types }));
  return { k, live, run, real, to, events };
}

test("a simulation never fires, spends or drops the user's own time watches; afterwards they fire at their real times (review 1)", async () => {
  const { k, live, run, to, events } = await anApp();
  await live.setWatch(k.trip, { when: { type: 'time', at: '2026-11-20T20:00:00-08:00' }, fallback: 'Pack the camera batteries.' });
  await live.setWatch(k.trip, { when: { type: 'time', at: '2026-12-24T20:00:00-08:00' }, expires: '2026-11-26T00:00:00-08:00', fallback: 'Christmas eve.' });
  await live.setWatch(ME, { when: { type: 'time', at: '2026-11-20T21:00:00-08:00' }, fallback: 'Call home.' });
  await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await run.finished;
  for (const scope of [k.trip, ME]) assert.deepEqual(await events(scope, ['trigger.fired', 'wake', 'reminder']), [], scope);
  assert.equal((await readWatches(k.ws, k.trip)).watches.length, 2);
  assert.equal((await readWatches(k.ws, ME)).watches.length, 1);
  const mine = ['Pack the camera batteries.', 'Christmas eve.', 'Call home.'];
  assert.deepEqual(k.notices.filter((n) => mine.includes(n.body)).map((n) => n.body), []); // the simulation's own reminders may show; the user's don't
  // On the real clock, as they were set.
  await to(Date.parse('2026-11-20T21:30:00-08:00'));
  const fired = await events(k.trip, ['trigger.fired']);
  assert.deepEqual(fired.map((e) => [e.data.fallback, e.ts]), [['Pack the camera batteries.', Date.parse('2026-11-20T20:00:00-08:00')]]);
  assert.deepEqual((await events(ME, ['trigger.fired'])).map((e) => e.data.fallback), ['Call home.']);
  await to(Date.parse('2026-11-26T00:01:00-08:00'));
  assert.deepEqual((await readWatches(k.ws, k.trip)).watches.map((w) => w.fallback), []); // Christmas eve expired then, not before
});

test('after a simulation dated in the future, the hourly wake budget counts real hours: its wakes count in the hour they came, not until its date (review 2a)', async () => {
  const { k, run, real } = await anApp();
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 3 } } });
  await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await run.finished;
  // As fast as it can go, the run woke her (with real models) more than 3 times in this real hour.
  k.notices.length = 0;
  const n = (await k.events(['wake'])).length;
  await k.agent.wake({ kind: 'trigger', text: 'a real watch fired, just after the simulation' });
  await k.agent.idle();
  assert.equal((await k.events(['wake'])).length, n);
  await until(() => k.notices.length > 0); // the card comes a moment after
  assert.deepEqual(k.notices.map((x) => x.title), ['Shiori skipped a wake']);
  // An hour later by the real clock (not on Nov 27, the simulation's date), she wakes again.
  await real.advanceTo(TODAY + 61 * 60_000);
  await k.agent.wake({ kind: 'trigger', text: 'a real watch fired, an hour later' });
  await k.agent.idle();
  assert.equal((await k.events(['wake'])).length, n + 1);
});

test("during a simulation, the day's spend counts the real day's calls, and entries in other conversations keep real time (review 2b, 2c)", async () => {
  const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
  const real = Date.parse('2026-10-17T09:00:00-07:00');
  const k = await agentKit([[say('One.'), say('Two.')]], { agent: { now: () => real, timeZone: () => LA } });
  await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.00001 } } });
  const restore = k.agent.useClock({ now: () => SIM, online: () => true, timeZone: () => LA, scope: k.trip });
  k.agent.send('First');
  await k.agent.idle();
  k.agent.send('Second');
  await k.agent.idle();
  assert.ok(k.notices.some((n) => n.title === "Shiori stopped: today's budget is spent"), k.notices.map((n) => n.title).join(', '));
  // The simulation's own conversation is in its time; another one's entries are in the real world's.
  const other = await createTrip(k.ws, { title: 'Kyoto in spring' });
  await k.agent.wake({ kind: 'file', scope: other, text: 'New files: /trip/files/ticket.pdf' });
  await k.agent.remind([{ watch: 'w-1', text: 'Pack the camera batteries.' }], other);
  const theirs = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(other, { types: ['wake', 'reminder'] }));
  assert.deepEqual(theirs.map((e) => [e.type, e.ts]), [['wake', real], ['reminder', real]]);
  assert.ok((await k.events(['msg.user'])).every((e) => e.ts === SIM));
  restore();
});

test('a reload in the middle of a simulation opens the trip that was open before, and live mode goes on into it (review 3)', async () => {
  const base = new ManualClock(0);
  const { k, run } = await anApp({ base });
  const { trip } = await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 10 });
  assert.equal((await readAppSettings(k.ws)).activeTrip, trip);
  // The page is gone (iOS let it go in the background); annai starts again.
  assert.equal(await /** @type {any} */ (simRun).recoverSimulation({ store: k.store, ws: k.ws }), k.trip);
  const s = await readAppSettings(k.ws);
  assert.deepEqual([s.activeTrip, s.simulation], [k.trip, undefined]);
  assert.equal(await /** @type {any} */ (simRun).recoverSimulation({ store: k.store, ws: k.ws }), null); // nothing to recover now
  run.stop();
  await run.finished;
});

test("outside its run, a simulation's trip is still: no reminders, watches or road of the real world go into it (review 4)", async () => {
  const { k, live, run, to, events } = await anApp({ live: true });
  const { trip } = await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
  await run.finished;
  k.notices.length = 0; // the run's own reminders were shown during it
  // A reminder Shiori set during the run for later that day, as she might with real models.
  await saveWatch(k.ws, trip, { id: 'w-castle', owner: 'shiori', when: { type: 'time', at: '2026-11-27T16:15:00-08:00' }, repeat: false, fallback: 'Leave for the castle.', created: iso('09:00') }, 'shiori');
  const firedBefore = (await events(trip, ['trigger.fired'])).length;
  const pointsBefore = (await events(trip, ['location'])).length;
  // Later, for real: the user opens the simulation's trip with live mode on, and drives on the real Nov 27.
  await updateAppSettings(k.ws, { activeTrip: trip });
  await k.agent.open(trip);
  await live.settled();
  const sensors = k.registry.list('sensor');
  assert.equal(sensors.length, 0); // no phone here: the fixes come through live mode itself
  await to(Date.parse('2026-11-27T11:30:00-08:00'));
  live.fixed({ lat: MONTEREY.lat, lng: MONTEREY.lng, accuracy: 8, speed: 20 });
  live.fixed({ lat: BIXBY.lat, lng: BIXBY.lng, accuracy: 8, speed: 20 });
  live.fixed({ lat: NEPENTHE.lat, lng: NEPENTHE.lng, accuracy: 8, speed: 0 });
  await live.settled();
  await to(Date.parse('2026-11-27T17:00:00-08:00'));
  await until(() => !k.agent.busy);
  assert.equal((await events(trip, ['trigger.fired'])).length, firedBefore);
  assert.equal((await events(trip, ['location'])).length, pointsBefore);
  assert.deepEqual(k.notices.filter((n) => n.title === 'Reminder').map((n) => n.body), []);
});
