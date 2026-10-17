import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS, margin } from '../../src/core/live/triggers.js';
import { readWatches, saveWatch, removeWatch, expired, newWatchId, watchPath } from '../../src/core/live/watches.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { off } from './live-kit.js';

const T = /** @type {Record<string, import('../../src/core/live/triggers.js').TriggerType>} */ (Object.fromEntries(TRIGGERS.map((t) => [t.type, t])));
const T0 = Date.parse('2026-11-27T10:00:00-08:00');
const BIXBY = { lat: 36.3715, lng: -121.9017 };
const MIN = 60_000;
/** @param {Partial<import('../../src/core/live/triggers.js').Moment>} o @returns {import('../../src/core/live/triggers.js').Moment} */
const moment = (o = {}) => ({ now: T0, fix: null, newFix: false, past: false, live: true, activity: 'unknown', change: null, odometer: 0, stop: null, gap: null, fired: () => false, ...o });
/** A moment with a new fix at p, at now. @param {{ lat: number, lng: number }} p @param {number} now @param {Partial<import('../../src/core/live/geo.js').Fix>} [f] @param {Partial<import('../../src/core/live/triggers.js').Moment>} [o] */
const at = (p, now, f = {}, o = {}) => moment({ now, fix: { lat: p.lat, lng: p.lng, accuracy: 10, at: now, speed: null, heading: null, source: 'gps', ...f }, newFix: true, ...o });

test('each type checks what it is given, in plain words', () => {
  assert.deepEqual(TRIGGERS.map((t) => t.type), ['time', 'every', 'enter', 'leave', 'dwell', 'arrived', 'moved', 'activity']);
  assert.equal(T.time.validate({ at: '2026-11-27T18:00:00-08:00' }), null);
  assert.match(String(T.time.validate({ at: '2026-11-27 18:00' })), /ISO date-time with an offset/);
  assert.match(String(T.every.validate({ minutes: 0 })), /minutes must be a number from 1 to 1440/);
  assert.match(String(T.enter.validate({ lat: 36 })), /lat and lng/);
  assert.match(String(T.enter.validate({ lat: 36, lng: -121, radius: 5 })), /radius is in meters/);
  assert.match(String(T.dwell.validate({ lat: 36, lng: -121 })), /minutes/);
  assert.equal(T.arrived.validate({}), null);
  assert.match(String(T.moved.validate({ km: 0 })), /km must be a number from 0.1 to 1000/);
  assert.match(String(T.activity.validate({ activity: 'running' })), /still, walking or moving-fast/);
  assert.match(String(T.activity.validate({ activity: 'still', edge: 'middle' })), /edge is start or stop/);
  assert.equal(T.enter.describe({ lat: 36.3715, lng: -121.9017, name: 'Bixby Bridge' }), 'on entering Bixby Bridge (200 m)');
  assert.equal(T.moved.describe({ km: 15 }), 'after 15 km travelled');
  assert.equal(T.activity.describe({ activity: 'moving-fast' }), 'when moving fast starts');
  assert.equal(T.time.gps, false);
  assert.equal(T.every.gps, false);
  assert.ok(['enter', 'leave', 'dwell', 'arrived', 'moved', 'activity'].every((k) => T[k].gps));
});

test('time fires at its moment and says when it came due; every counts from when it was set, then from its last firing', () => {
  const w = { at: '2026-11-27T10:00:00-08:00' };
  assert.equal(T.time.check(w, moment({ now: T0 - 1 }), {}), null);
  assert.deepEqual(T.time.check(w, moment({ now: T0 + 5 * MIN }), {}), { text: 'the time came: 2026-11-27T10:00:00-08:00', at: T0 });
  assert.equal(T.time.next?.(w, moment(), {}), T0);
  const mem = { set: T0, lastAt: null };
  assert.equal(T.every.check({ minutes: 30 }, moment({ now: T0 + 29 * MIN }), mem), null);
  assert.deepEqual(T.every.check({ minutes: 30 }, moment({ now: T0 + 30 * MIN }), mem), { text: '30 min since you set it', at: T0 + 30 * MIN });
  const later = { set: T0, lastAt: T0 + 30 * MIN };
  assert.equal(T.every.next?.({ minutes: 30 }, moment(), later), T0 + 60 * MIN);
  assert.equal(T.every.check({ minutes: 30 }, moment({ now: T0 + 61 * MIN }), later)?.text, '30 min since it last fired');
});

test('enter and leave: the first fix only says where it is; a crossing fires; jitter in the margin does not', () => {
  const w = { ...BIXBY, radius: 200, name: 'Bixby Bridge' };
  assert.equal(margin(200), 50);
  const mem = {};
  assert.equal(T.enter.check(w, at(off(BIXBY, 0, 1000), T0), mem), null); // first: outside
  assert.equal(T.enter.check(w, at(off(BIXBY, 0, 240), T0 + 5000), mem), null); // in the margin: can't tell
  assert.deepEqual(T.enter.check(w, at(off(BIXBY, 0, 150), T0 + 10_000), mem), { text: 'you entered Bixby Bridge', place: { name: 'Bixby Bridge', lat: 36.3715, lng: -121.9017 } });
  for (const d of [190, 230, 245, 210, 180]) assert.equal(T.enter.check(w, at(off(BIXBY, d, 0), T0 + 20_000), mem), null); // jitter at the edge
  assert.equal(T.enter.check(w, at(off(BIXBY, 0, 600), T0 + 30_000, { accuracy: 500 }), mem), null); // too vague to say
  const out = {};
  T.leave.start?.(w, at(off(BIXBY, 0, 100), T0), out); // set while inside
  assert.equal(T.leave.check(w, at(off(BIXBY, 0, 240), T0 + 5000), out), null);
  assert.deepEqual(T.leave.check(w, at(off(BIXBY, 0, 900), T0 + 10_000), out), { text: 'you left Bixby Bridge, now 900 m away', place: { name: 'Bixby Bridge', lat: 36.3715, lng: -121.9017 } });
  assert.equal(T.leave.check(w, at(off(BIXBY, 0, 950), T0 + 15_000), out), null); // still out: once
  assert.equal(T.enter.check(w, moment({ now: T0 + 40_000, fix: at(BIXBY, T0).fix }), mem), null); // no new fix (a clock check): nothing moves
});

test('dwell fires once per visit after its minutes inside; leaving starts again; a catch-up first look does not fire it', () => {
  const w = { ...BIXBY, radius: 200, minutes: 10, name: 'Bixby Bridge' };
  const mem = {};
  T.dwell.start?.(w, at(off(BIXBY, 0, 1000), T0), mem);
  T.dwell.check(w, at(BIXBY, T0 + MIN), mem); // in
  assert.equal(T.dwell.next?.(w, moment({ now: T0 + 2 * MIN }), mem), T0 + 11 * MIN);
  assert.equal(T.dwell.check(w, moment({ now: T0 + 11 * MIN, past: true }), mem), null);
  assert.deepEqual(T.dwell.check(w, moment({ now: T0 + 11 * MIN }), mem), { text: "you've been at Bixby Bridge for 10 min", at: T0 + 11 * MIN, place: { name: 'Bixby Bridge', lat: 36.3715, lng: -121.9017 } });
  assert.equal(T.dwell.check(w, moment({ now: T0 + 30 * MIN }), mem), null);
  T.dwell.check(w, at(off(BIXBY, 0, 1000), T0 + 31 * MIN), mem); // out
  T.dwell.check(w, at(BIXBY, T0 + 32 * MIN), mem); // in again
  assert.equal(T.dwell.check(w, moment({ now: T0 + 42 * MIN }), mem)?.at, T0 + 42 * MIN);
});

test('arrived: stopped for its minutes somewhere new; not where it was set, and not the same spot twice', () => {
  const w = { minutes: 5 };
  const mem = {};
  T.arrived.start?.(w, at(BIXBY, T0), mem); // set while parked at Bixby
  const here = { ...BIXBY, since: T0 };
  assert.equal(T.arrived.check(w, moment({ now: T0 + 10 * MIN, stop: here }), mem), null);
  const nepenthe = { lat: 36.2213, lng: -121.7567, since: T0 + 30 * MIN };
  assert.equal(T.arrived.next?.(w, moment({ now: T0 + 31 * MIN, stop: nepenthe }), mem), T0 + 35 * MIN);
  assert.equal(T.arrived.check(w, moment({ now: T0 + 34 * MIN, stop: nepenthe }), mem), null);
  const f = T.arrived.check(w, moment({ now: T0 + 35 * MIN, stop: nepenthe }), mem);
  assert.equal(f?.text, "you've stopped for 5 min somewhere new");
  assert.deepEqual(f?.place, { lat: 36.2213, lng: -121.7567 });
  assert.equal(T.arrived.check(w, moment({ now: T0 + 50 * MIN, stop: { ...nepenthe, since: T0 + 40 * MIN } }), mem), null); // the same spot again
});

test('moved counts the odometer from her last wake; activity fires on its edge', () => {
  assert.equal(T.moved.check({ km: 15 }, moment({ odometer: 24.9 }), { km0: 10 }), null);
  assert.deepEqual(T.moved.check({ km: 15 }, moment({ odometer: 25.2 }), { km0: 10 }), { text: 'you have travelled 15.2 km since your last wake' });
  const start = { activity: 'moving-fast' };
  const stop = { activity: 'moving-fast', edge: 'stop' };
  assert.equal(T.activity.check(start, moment(), {}), null);
  assert.deepEqual(T.activity.check(start, moment({ change: { from: 'unknown', to: 'moving-fast' } }), {}), { text: 'the activity is now moving fast (it was not known yet)' });
  assert.equal(T.activity.check(stop, moment({ change: { from: 'unknown', to: 'moving-fast' } }), {}), null);
  assert.deepEqual(T.activity.check(stop, moment({ change: { from: 'moving-fast', to: 'still' } }), {}), { text: 'the activity is now still (it was moving fast)' });
});

test('watch records: kept as /watches/<id>.json with a format check; broken ones are counted, not read', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  const id = newWatchId();
  assert.match(id, /^w-/);
  const w = { id, owner: 'shiori', when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Look out for Point Sur on the right.', created: '2026-11-27T17:00:00.000Z' };
  await saveWatch(ws, trip, w, 'shiori');
  await saveWatch(ws, ME, { ...w, id: 'w-me' }, 'shiori');
  await assert.rejects(saveWatch(ws, trip, /** @type {any} */ ({ ...w, id: 'w-bad', fallback: '' }), 'shiori'), /fallback/);
  await assert.rejects(saveWatch(ws, trip, /** @type {any} */ ({ ...w, id: 'w-bad', expires: 'tomorrow' }), 'shiori'), /expires/);
  await ws.write(trip, '/watches/broken.json', 'not json', { author: 'shiori', type: 'text/plain' });
  await ws.write(trip, '/watches/sub/x.json', { id: 'x' }, { author: 'shiori' });
  const got = await readWatches(ws, trip);
  assert.deepEqual(got.watches, [{ ...w, path: watchPath(id) }]);
  assert.equal(got.broken, 1);
  assert.equal((await readWatches(ws, ME)).watches[0].id, 'w-me');
  await removeWatch(ws, trip, got.watches[0]);
  assert.deepEqual((await readWatches(ws, trip)).watches, []);
  await removeWatch(ws, trip, got.watches[0]); // already gone: no error
  assert.equal(expired({ ...w, expires: '2026-11-27T10:00:00-08:00' }, T0), true);
  assert.equal(expired({ ...w, expires: '2026-11-27T10:00:00-08:00' }, T0 - 1), false);
  assert.equal(expired(w, T0), false);
});
