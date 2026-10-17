import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackFrom, Simulation } from '../../src/core/live/simulate.js';
import { ManualClock, scaledClock } from '../../src/core/live/clock.js';
import { meters } from '../../src/core/live/geo.js';
import { liveKit, at, MONTEREY, BIXBY } from './live-kit.js';

const SHORT = {
  start: '2026-11-27T09:00:00-08:00', everySec: 5, stillSec: 10, endMin: 1,
  route: [{ name: 'Monterey', ...MONTEREY, leave: '09:01' }, { lat: 36.46, lng: -121.92 }, { name: 'Bixby Bridge', ...BIXBY, arrive: '09:31' }],
  marks: [{ at: '09:10', kind: /** @type {const} */ ('hide') }, { at: '09:20', kind: /** @type {const} */ ('show') }],
};

test('a track from an itinerary: still at the stops, a steady speed along the road between, marks first at the same moment; the same every time', () => {
  const t = trackFrom(SHORT);
  assert.deepEqual(trackFrom(SHORT), t);
  const fixes = t.filter((e) => e.kind === 'fix');
  assert.equal(fixes[0].at, at('09:00'));
  assert.equal(/** @type {any} */ (fixes[0]).fix.speed, 0);
  assert.ok(meters(/** @type {any} */ (fixes[0]).fix, MONTEREY) <= 5); // a little GPS jitter
  const moving = fixes.filter((e) => /** @type {any} */ (e).fix.speed > 0);
  assert.equal(moving[0].at, at('09:01'));
  assert.equal(moving.length, 360); // 30 minutes, every 5 s
  const road = meters(MONTEREY, { lat: 36.46, lng: -121.92 }) + meters({ lat: 36.46, lng: -121.92 }, BIXBY);
  assert.ok(Math.abs(/** @type {any} */ (moving[0]).fix.speed - road / 1800) < 0.01);
  assert.ok(meters(/** @type {any} */ (fixes.at(-1)).fix, BIXBY) <= 5);
  assert.equal(fixes.at(-1)?.at, at('09:32')); // a minute at the last stop
  const hide = t.findIndex((e) => e.kind === 'hide');
  assert.equal(t[hide].at, at('09:10'));
  assert.equal(t[hide + 1].at, at('09:10')); // the fix at the same moment comes after it
  assert.throws(() => trackFrom({ ...SHORT, start: '2026-11-27 09:00' }), /needs a start: an ISO date-time with an offset/);
  assert.throws(() => trackFrom({ ...SHORT, route: [SHORT.route[0], { ...SHORT.route[2], arrive: '08:59' }] }), /Bixby Bridge is reached before the drive there ends/);
  assert.throws(() => trackFrom({ ...SHORT, route: [SHORT.route[0]] }), /at least two places/);
});

test('a simulation plays a track through sensors of its own into the live engine: fixes, the phone locked and unlocked, the connection', async () => {
  const k = await liveKit({ start: at('09:00') });
  const sim = new Simulation({ registry: k.registry, track: trackFrom(SHORT) });
  await k.settle();
  await sim.run(k.clock, k.settle);
  const points = await k.events(['location']);
  assert.ok(points.length > 200);
  assert.ok(points.every((e) => e.data.source === 'sim'));
  assert.ok(!points.some((e) => e.ts > at('09:10') && e.ts < at('09:20')), 'no GPS while the phone was locked');
  assert.equal(k.live.shown, true);
  sim.send({ at: at('09:32'), kind: 'offline' });
  await k.settle();
  assert.equal(k.live.online, false);
  sim.dispose();
  assert.equal(k.registry.list('sensor').filter((s) => s.kind === 'location').length, 1); // only the kit's own
});

test('played on a clock ten times faster than real time (spec §18), 20 s of track take 2 s', async () => {
  const base = new ManualClock(0);
  const k = await liveKit({ start: at('09:00') });
  const sim = new Simulation({ registry: k.registry, track: [{ at: at('09:00'), kind: 'offline' }, { at: at('09:00:10'), kind: 'online' }, { at: at('09:00:20'), kind: 'offline' }] });
  const clock = scaledClock(at('09:00'), 10, base);
  let ended = false;
  sim.play(clock, { onEnd: () => { ended = true; } });
  await k.settle();
  assert.equal(k.live.online, false);
  await base.advanceTo(1000);
  await k.settle();
  assert.equal(k.live.online, true);
  assert.equal(ended, false);
  await base.advanceTo(2000);
  await k.settle();
  assert.equal(k.live.online, false);
  assert.equal(ended, true);
});
