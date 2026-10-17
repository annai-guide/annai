import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { packPlan, planStops, planFor, estimate, likelyGuides, guideTitles, hashId, STRETCH_KM, MAX_OSM, MAX_WIKI } from '../../src/core/pack/plan.js';
import { meters } from '../../src/core/live/geo.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/live/big-sur.json', import.meta.url), 'utf8'));
const bigSur = Object.entries(fixture.plan).map(([id, item]) => ({ path: `/plan/${id}.json`, item }));
const pt = (/** @type {[number, number]} */ p) => ({ lat: p[0], lng: p[1] });

test('Big Sur: OpenStreetMap around each stop and along each leg, Wikipedia at each stop and on the way, and the names to look up', () => {
  const plan = packPlan({ trip: { places: ['Big Sur'] }, items: bigSur });
  assert.deepEqual(plan.stops.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  const osm = plan.parts.filter((p) => p.kind === 'osm');
  const around = osm.filter((p) => p.km === 0);
  const along = osm.filter((p) => p.km > 0);
  assert.equal(around.length, 5);
  assert.deepEqual(around.map((p) => [p.radius, p.label]).slice(0, 2), [[5000, 'around Bixby Creek Bridge'], [5000, 'around Nepenthe']]);
  assert.equal(along.length, 5); // McWay Falls to Hearst Castle, about 70 km, in two stretches
  for (const p of along) assert.ok(p.radius === 3000 && p.points.length === 2 && p.km <= STRETCH_KM, p.label);
  assert.deepEqual(along[0].points, [[36.3715, -121.9017], [36.2213, -121.7567]]);
  const wiki = plan.parts.filter((p) => p.kind === 'wikipedia');
  assert.equal(wiki.length, 9);
  for (const a of wiki) for (const b of wiki) if (a !== b) assert.ok(meters(pt(a.at), pt(b.at)) >= 7000, `${a.label} / ${b.label}`);
  assert.deepEqual(plan.names, ['Big Sur', 'Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  assert.equal(plan.cut, 0);
  assert.equal(new Set(plan.parts.map((p) => p.id)).size, plan.parts.length);
});

test('the same plan gives the same parts and key; moving a stop changes the key and only the parts near it', () => {
  const a = packPlan({ trip: null, items: bigSur });
  const b = packPlan({ trip: null, items: structuredClone(bigSur) });
  assert.equal(a.key, b.key);
  const moved = structuredClone(bigSur);
  const cambria = moved.find((x) => x.path === '/plan/cambria.json');
  if (cambria) cambria.item.place.lat += 0.02;
  const c = packPlan({ trip: null, items: moved });
  assert.notEqual(c.key, a.key);
  const ids = new Set(c.parts.map((p) => p.id));
  assert.ok(a.parts.filter((p) => p.label.includes('Bixby')).every((p) => ids.has(p.id)));
  assert.notEqual(packPlan({ trip: { places: ['Monterey'] }, items: bigSur }).key, a.key); // the names count too
});

test('a flight is no leg, the same place twice in a row is one stop, and items without a place or a time', () => {
  const items = [
    { path: '/plan/sfo.json', item: { title: 'Fly out', start: { at: '2026-11-25T08:00:00Z' }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } } },
    { path: '/plan/sfo2.json', item: { title: 'Lounge', start: { at: '2026-11-25T09:00:00Z' }, place: { name: 'SFO lounge', lat: 37.6215, lng: -122.3791 } } },
    { path: '/plan/hnd.json', item: { title: 'Land', start: { at: '2026-11-26T15:00:00Z' }, place: { name: 'Haneda', lat: 35.5494, lng: 139.7798 } } },
    { path: '/plan/note.json', item: { title: 'Pack', start: { at: '2026-11-24T08:00:00Z' } } },
    { path: '/plan/odd.json', item: { title: 'Odd', place: { name: 'Nowhere', lat: 'x', lng: 1 } } },
    { path: '/plan/later.json', item: { title: 'Some day', place: { name: 'Asakusa', lat: 35.7148, lng: 139.7967 } } },
  ];
  const plan = packPlan({ trip: { places: [' ', 3, 'Tokyo'] }, items });
  assert.deepEqual(plan.stops.map((s) => s.name), ['SFO', 'Haneda', 'Asakusa']);
  assert.equal(plan.parts.filter((p) => p.kind === 'osm' && p.km > 0).length, 1); // Haneda to Asakusa only
  assert.deepEqual(plan.names, ['Tokyo', 'SFO', 'Haneda', 'Asakusa']);
  assert.deepEqual(planStops([]), []);
  assert.deepEqual(packPlan({ trip: null, items: [] }).parts, []);
});

test('stops either side of the date line are joined the short way', () => {
  const items = [
    { path: '/plan/a.json', item: { title: 'A', start: { at: '2026-11-25T08:00:00Z' }, place: { name: 'Taveuni East', lat: -16.85, lng: 179.95 } } },
    { path: '/plan/b.json', item: { title: 'B', start: { at: '2026-11-25T10:00:00Z' }, place: { name: 'Taveuni West', lat: -16.95, lng: -179.95 } } },
  ];
  const along = packPlan({ trip: null, items }).parts.filter((p) => p.kind === 'osm' && p.km > 0);
  assert.equal(along.length, 1);
  assert.ok(along[0].kind === 'osm' && along[0].km < 30, 'about 23 km, not around the world');
});

test('a very long plan is capped, and says how much was left out', () => {
  const items = Array.from({ length: 300 }, (_, k) => ({ path: `/plan/s${k}.json`, item: { title: `Stop ${k}`, start: { at: new Date(Date.UTC(2026, 10, 1) + k * 3_600_000).toISOString() }, place: { name: `Stop ${k}`, lat: 30 + k * 0.3, lng: -100 } } }));
  const plan = packPlan({ trip: null, items });
  assert.ok(plan.parts.filter((p) => p.kind === 'osm').length <= MAX_OSM);
  assert.ok(plan.parts.filter((p) => p.kind === 'wikipedia').length <= MAX_WIKI);
  assert.ok(plan.cut > 0);
});

test('the estimate shown before downloading: about 0.4 MB for Big Sur', () => {
  const plan = packPlan({ trip: { places: ['Big Sur'] }, items: bigSur });
  assert.equal(likelyGuides(plan), 3);
  const n = estimate(plan.parts, likelyGuides(plan));
  assert.ok(n > 300 * 1024 && n < 600 * 1024, String(n));
  assert.equal(estimate([], 0), 0);
});

test('the Wikivoyage titles a name may be under', () => {
  assert.deepEqual(guideTitles('Cambria, California'), ['Cambria, California', 'Cambria (California)']);
  assert.deepEqual(guideTitles('  Big   Sur '), ['Big Sur']);
  assert.deepEqual(guideTitles('  '), []);
});

test('fingerprints are short, steady and different', () => {
  assert.equal(hashId('osm 5000 36.3715,-121.9017'), hashId('osm 5000 36.3715,-121.9017'));
  assert.notEqual(hashId('a'), hashId('b'));
  assert.match(hashId('anything'), /^[0-9a-z]{1,11}$/);
});

test("planFor reads the trip's places and its plan folder, leaving out broken files and subfolders", async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.patch(trip, '/trip.json', { places: ['Big Sur'] }, { author: 'user' });
  await ws.write(trip, '/plan/nepenthe.json', fixture.plan.nepenthe, { author: 'user' });
  await ws.write(trip, '/plan/old/mcway.json', fixture.plan.mcway, { author: 'user' });
  await ws.write(trip, '/plan/broken.json', '{"title":', { author: 'user', type: 'text/plain' });
  const plan = await planFor(ws, trip);
  assert.deepEqual(plan.stops.map((s) => s.name), ['Nepenthe']);
  assert.deepEqual(plan.names, ['Big Sur', 'Nepenthe']);
});
