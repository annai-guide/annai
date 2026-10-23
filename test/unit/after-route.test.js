import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsOf, segmentsOf, legsOf, thin, positionAt, fractionAt, fit, jumps } from '../../src/core/after/route.js';
import { meters } from '../../src/core/live/geo.js';
import { at, off, MONTEREY, BIXBY, NEPENTHE, HEARST, CAMBRIA } from './live-kit.js';
import { road, MORNING } from './after-kit.js';
import { cpuMs } from './cpu.js';

const MIN = 60_000;

test('location entries as points, in time order; entries that are not a position are left out', () => {
  const pts = pointsOf([
    { ts: 3, data: { lat: 36.1, lng: -121.6, accuracy: 8, speed: 12.5 } }, { ts: 1, data: { lat: 36, lng: -121.5 } },
    { ts: 2, data: { lat: 'x', lng: 1 } }, { ts: 4 }, { ts: 5, data: { lat: 91, lng: 0 } }, { ts: NaN, data: { lat: 1, lng: 1 } },
  ]);
  assert.deepEqual(pts, [{ lat: 36, lng: -121.5, at: 1 }, { lat: 36.1, lng: -121.6, at: 3, accuracy: 8, speed: 12.5 }]);
});

test('stays of 10 minutes or more, placed where the time went, and the moves between; a jump makes a move partly unseen (choice 7)', () => {
  const legs = legsOf(MORNING);
  assert.deepEqual(legs.map((l) => l.kind), ['move', 'stay', 'move', 'stay']);
  const [drive, bixby, on, castle] = /** @type {any[]} */ (legs);
  assert.equal(drive.mode, 'drive');
  assert.ok(Math.abs(drive.km - meters(MONTEREY, BIXBY) / 1000) < 1, String(drive.km));
  assert.equal(drive.gap, false);
  assert.deepEqual([bixby.lat, bixby.lng], [BIXBY.lat, BIXBY.lng]);
  assert.ok(Math.abs(bixby.from - at('09:30')) <= 30_000 && Math.abs(bixby.to - at('09:50')) <= 30_000);
  assert.equal(on.gap, true); // the phone was locked from Nepenthe to Hearst Castle
  assert.equal(on.from, bixby.to);
  assert.deepEqual([castle.lat, castle.lng, castle.from, castle.to], [HEARST.lat, HEARST.lng, at('16:40'), at('18:15')]);
});

test('walking is a walk; nothing, one point, or every point at one spot is no move', () => {
  const walk = [{ ...MONTEREY, at: at('08:00') }, { ...MONTEREY, at: at('08:20') }, ...road(MONTEREY, off(MONTEREY, 2000, 0), at('08:20:05'), at('08:45'), 10)];
  assert.deepEqual(legsOf(walk).map((l) => [l.kind, /** @type {any} */ (l).mode ?? '']), [['stay', ''], ['move', 'walk']]);
  assert.deepEqual(legsOf([]), []);
  assert.deepEqual(legsOf([{ ...MONTEREY, at: 0 }]), []);
  assert.deepEqual(legsOf([{ ...MONTEREY, at: 0 }, { ...off(MONTEREY, 10, 0), at: 5 * MIN }]), []);
});

test('the track splits where it jumps: the phone locked, or a flight', () => {
  assert.deepEqual(segmentsOf(MORNING).map((s) => s.length), [MORNING.length - 2, 2]);
  assert.equal(jumps({ ...MONTEREY, at: 0 }, { ...CAMBRIA, at: 60_000 }), true); // 150 km in a minute
  assert.equal(jumps({ ...MONTEREY, at: 0 }, { ...off(MONTEREY, 900, 0), at: 30 * MIN }), false);
  assert.deepEqual(segmentsOf([]), []);
});

test('the drawn route keeps at most 1500 points, its ends, and its shape, quickly even for a five-day trip (choice 8)', () => {
  /** @type {any[]} */
  const wiggly = [];
  for (let i = 0; i < 50_000; i++) wiggly.push({ lat: 36 + i * 1e-5, lng: -121.5 + Math.sin(i / 50) * 0.01, at: i * 5000 });
  const t0 = cpuMs();
  const drawn = thin(segmentsOf(wiggly));
  const ms = cpuMs() - t0;
  const n = drawn.reduce((s, x) => s + x.length, 0);
  assert.ok(n <= 1500 && n > 200, String(n));
  assert.deepEqual(drawn[0][0], wiggly[0]);
  assert.deepEqual(drawn.at(-1)?.at(-1), wiggly.at(-1));
  assert.ok(ms < 3000, `${Math.round(ms)} ms of CPU`); // 0.4 s here; a quadratic thinning of 50,000 points takes minutes
  assert.deepEqual(thin([[{ lat: 1, lng: 1, at: 0 }]]), [[{ lat: 1, lng: 1, at: 0 }]]);
});

test('where the user was at a moment: between points by the time; held during a jump; the ends before and after', () => {
  const drawn = thin(segmentsOf(MORNING));
  const mid = /** @type {{ lat: number, lng: number }} */ (positionAt(drawn, at('09:15')));
  assert.ok(Math.abs(mid.lat - (MONTEREY.lat + BIXBY.lat) / 2) < 0.01, String(mid.lat));
  assert.deepEqual(positionAt(drawn, at('12:00')), { lat: NEPENTHE.lat, lng: NEPENTHE.lng });
  assert.deepEqual(positionAt(drawn, at('06:00')), { lat: MONTEREY.lat, lng: MONTEREY.lng });
  assert.deepEqual(positionAt(drawn, at('23:00')), { lat: off(HEARST, 20, 20).lat, lng: off(HEARST, 20, 20).lng });
  assert.equal(positionAt([], 0), null);
  assert.equal(fractionAt(drawn[0], at('08:00')), 0);
  assert.equal(fractionAt(drawn[0], at('11:00')), 1);
  const half = fractionAt(drawn[0], at('09:15'));
  assert.ok(half > 0.2 && half < 0.35, String(half)); // half of Monterey–Bixby, of a piece that goes on to Nepenthe
});

test('a flat map: north up, west left, inside its padding; one point sits in the middle; the date line is crossed, not wrapped', () => {
  const m = fit([MONTEREY, CAMBRIA, BIXBY], { width: 1000, pad: 40 });
  const [mx, my] = m.xy(MONTEREY);
  const [cx, cy] = m.xy(CAMBRIA);
  assert.ok(my < cy, 'Monterey is north of Cambria');
  assert.ok(mx < cx, 'Monterey is west of Cambria');
  for (const [x, y] of [[mx, my], [cx, cy]]) assert.ok(x >= 39 && x <= 961 && y >= 39 && y <= m.height - 39, `${x},${y}`);
  assert.ok(m.height >= 500 && m.height <= 1300, String(m.height));
  const one = fit([MONTEREY], { width: 1000 });
  assert.deepEqual(one.xy(MONTEREY), [500, one.height / 2]);
  const fiji = fit([{ lat: -17, lng: 179.9 }, { lat: -17.1, lng: -179.9 }], { width: 1000 });
  const [ax] = fiji.xy({ lat: -17, lng: 179.9 });
  const [bx] = fiji.xy({ lat: -17.1, lng: -179.9 });
  assert.ok(bx > ax && bx - ax < 960, `${ax} ${bx}`);
});

test('a stay the track ends in lasts until the record ends, when it is known (live mode turned off there)', () => {
  const evening = [...road(HEARST, CAMBRIA, at('18:15'), at('18:32')), { ...CAMBRIA, at: at('18:32') }];
  assert.deepEqual(legsOf(evening).map((l) => l.kind), ['move']); // no end known: nothing says how long
  const legs = legsOf(evening, { end: at('19:02') });
  assert.deepEqual(legs.map((l) => l.kind), ['move', 'stay']);
  assert.deepEqual([/** @type {any} */ (legs[1]).lat, legs[1].to], [CAMBRIA.lat, at('19:02')]);
  assert.ok(Math.abs(legs[1].from - at('18:32')) <= 30_000);
  assert.deepEqual(legsOf(evening, { end: at('18:35') }).map((l) => l.kind), ['move']); // three minutes: not a stay
});
