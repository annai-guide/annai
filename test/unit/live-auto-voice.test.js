import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { fakeSensors, memoryKeep, at, LA, MONTEREY, off } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { updateAppSettings } from '../../src/core/settings.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A real Agent and Voice (Auto, no audio device to go by) and a Live on a manual clock, GPS on; what voice did and when. */
async function drive() {
  const clock = new ManualClock(at('17:00'));
  const k = await agentKit([{ rules: [] }], { agent: { now: clock.now, timeZone: () => LA }, voice: { mode: 'auto' } });
  await updateAppSettings(k.ws, { live: { on: true } });
  const sensors = fakeSensors(k.registry);
  const keep = memoryKeep();
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA, keep });
  await live.start();
  await live.settled();
  /** @type {[number, boolean][]} */
  const voice = [];
  k.voice.onChange((/** @type {any} */ m) => voice.push([clock.now(), m.on]));
  let p = MONTEREY;
  const fix = async (/** @type {number} */ t, /** @type {number} */ speed) => {
    await clock.advanceTo(t, () => live.settled());
    p = speed > 1 ? off(p, 0, -speed * 5) : p;
    sensors.fix({ lat: p.lat, lng: p.lng, accuracy: 8, speed });
    await live.settled();
    await tick();
  };
  /** Speeds from t0 for secs, a fix every 5 s. */
  const run = async (/** @type {number} */ t0, /** @type {number} */ secs, /** @type {(s: number) => number} */ speed) => {
    for (let s = 0; s <= secs; s += 5) await fix(t0 + s * 1000, speed(s));
  };
  return { k, clock, live, voice, run, sensors, keep };
}

test('Auto voice stays on through a stop at a light of 75 s, and a crawl of 2 min; it goes off about 3 minutes after parking for good', async () => {
  const d = await drive();
  await d.run(at('17:00'), 120, () => 14);
  assert.equal(d.live.activity, 'moving-fast');
  assert.equal(d.k.voice.on, true);
  const changes = () => d.voice.length;
  const n = changes();
  await d.run(at('17:02:05'), 75, () => 0); // a light of 75 s
  await d.run(at('17:03:25'), 60, () => 14);
  assert.equal(d.live.activity, 'moving-fast');
  assert.equal(d.k.voice.on, true);
  assert.equal(changes(), n, `voice flipped: ${JSON.stringify(d.voice.slice(n))}`);
  await d.run(at('17:04:30'), 120, (s) => (s % 30 < 20 ? 1 : 4)); // a crawl, under 5 m/s
  await d.run(at('17:06:35'), 60, () => 14);
  assert.equal(d.k.voice.on, true);
  assert.equal(changes(), n, `voice flipped in the crawl: ${JSON.stringify(d.voice.slice(n))}`);
  // Parked for good: fixes every 20 s, then none.
  const parked = at('17:07:50');
  await d.run(parked, 40, () => 0);
  assert.equal(d.k.voice.on, true, 'a minute in: still on');
  for (let t = parked + 50_000; t <= parked + 10 * 60_000; t += 10_000) {
    await d.clock.advanceTo(t, () => d.live.settled());
    await tick(); // voice works out its mode a moment after it is told
  }
  assert.equal(d.live.activity, 'still');
  assert.equal(d.k.voice.on, false);
  const offAt = /** @type {[number, boolean]} */ (d.voice.at(-1))[0];
  assert.ok(offAt - parked >= 150_000 && offAt - parked <= 210_000, `voice went off ${(offAt - parked) / 1000} s after parking`);
});

test('with the real Voice: locked on the highway and unlocked at a light, voice stays on; killed while locked, voice is back on with the first fix', async () => {
  const d = await drive();
  const { k, clock, live } = d;
  await d.run(at('17:00'), 90, () => 14);
  assert.equal(k.voice.on, true);
  const n = d.voice.length;
  const road = off(MONTEREY, 0, -14 * 300);
  d.sensors.visible(false);
  await live.settled();
  await clock.advanceTo(at('17:06'), () => live.settled());
  d.sensors.visible(true);
  await live.settled();
  for (let t = at('17:06:05'); t <= at('17:06:50'); t += 15_000) {
    await clock.advanceTo(t, () => live.settled());
    d.sensors.fix({ ...road, accuracy: 8, speed: 0 });
    await live.settled();
    await tick();
  }
  assert.equal(k.voice.on, true);
  assert.equal(d.voice.length, n, `voice flipped: ${JSON.stringify(d.voice.slice(n))}`);
  // Locked and killed; ten minutes on the road.
  d.sensors.fix({ ...road, accuracy: 8, speed: 14 });
  await live.settled();
  d.sensors.visible(false);
  await live.settled();
  live.dispose();
  await clock.advanceTo(at('17:17'), () => Promise.resolve());
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA, keep: d.keep });
  await again.start();
  await again.settled();
  await tick();
  const far = off(road, 0, -14 * 600);
  d.sensors.fix({ ...far, accuracy: 8, speed: 14 });
  await again.settled();
  await tick();
  assert.equal(again.activity, 'moving-fast');
  assert.equal(k.voice.on, true, 'on with the first fix, not half a minute later');
  again.dispose();
});
