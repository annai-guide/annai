import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackFrom, trackFromLog, Simulation, SIMULATION } from '../../src/core/live/simulate.js';
import { Registry } from '../../src/core/registry.js';
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

test('a recorded track: still fixes fill the stops the log kept no points for, and a jump marks the phone locked (spec §13, choice 12)', () => {
  const at = (/** @type {string} */ t) => Date.parse(`2026-11-27T${t}:00-08:00`);
  const track = trackFromLog([
    { lat: 36.3715, lng: -121.9017, at: at('09:30'), accuracy: 8, speed: 0 },
    { lat: 36.3716, lng: -121.9016, at: at('09:50'), accuracy: 8, speed: 1.2 }, // the leaving, 20 min later
    { lat: 36.36, lng: -121.89, at: at('09:52'), accuracy: 8, speed: 14 },
    { lat: 35.68, lng: -121.17, at: at('16:40'), accuracy: 12 }, // unlocked at Hearst Castle
  ]);
  const fixes = track.filter((e) => e.kind === 'fix');
  assert.equal(fixes.filter((e) => e.at > at('09:30') && e.at < at('09:50')).length, 119); // every 10 s while stopped
  assert.ok(fixes.filter((e) => e.at > at('09:30') && e.at < at('09:50')).every((e) => e.kind === 'fix' && e.fix.speed === 0));
  assert.deepEqual(track.filter((e) => e.kind !== 'fix').map((e) => [e.kind, e.at]), [['hide', at('09:52') + 1000], ['show', at('16:40') - 1000]]);
  assert.equal(/** @type {any} */ (fixes.at(-1)).fix.speed, undefined); // no speed recorded: the GPS's own isn't made up
  assert.throws(() => trackFromLog([{ lat: 1, lng: 1, at: 0 }]), /^Error: That trip has no recorded track yet: GPS records one while it is on\.$/);
});

test('a run stops when told, and waits at its gate', async () => {
  const registry = new Registry();
  const track = trackFrom({ start: '2026-11-27T09:00:00-08:00', route: [{ lat: 36.6, lng: -121.9, leave: '09:01' }, { lat: 36.5, lng: -121.9, arrive: '09:11' }], endMin: 1 });
  const sim = new Simulation({ registry, track });
  const clock = new ManualClock(track[0].at);
  const abort = new AbortController();
  let sent = 0;
  /** @type {() => void} */
  let open = () => {};
  const gate = () => (sent === 10 ? new Promise((resolve) => { open = () => resolve(undefined); }) : Promise.resolve());
  const running = sim.run(clock, async () => { sent++; if (sent === 20) abort.abort(); }, { signal: abort.signal, gate });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent, 10); // waiting at the gate
  open();
  await running;
  assert.equal(sent, 20); // stopped
  assert.equal(SIMULATION, 'simulation');
});

test('a recorded track that ends at a stop stays there until the record ends (live mode turned off), so the arrival comes again', () => {
  const at = (/** @type {string} */ t) => Date.parse(`2026-11-27T${t}:00-08:00`);
  const points = [{ lat: 35.6, lng: -121.1, at: at('18:20'), speed: 14 }, { lat: 35.5641, lng: -121.0807, at: at('18:32'), speed: 0 }];
  assert.equal(trackFromLog(points).at(-1)?.at, at('18:32'));
  const track = trackFromLog(points, { end: at('19:02') });
  assert.equal(track.at(-1)?.at, at('19:02') - 10_000);
  assert.ok(track.filter((e) => e.at > at('18:32')).every((e) => e.kind === 'fix' && e.fix.speed === 0 && e.fix.lat === 35.5641));
});
