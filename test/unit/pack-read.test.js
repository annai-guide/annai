import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, toLine } from '../../src/core/pack/read.js';
import { downloadPack, MANIFEST } from '../../src/core/pack/download.js';
import { packTrip, services } from './pack-kit.js';

test('meters from a point to a line, or to a point', () => {
  const east = /** @type {[number, number][]} */ ([[36, -121], [36, -120]]);
  assert.ok(Math.abs(toLine({ lat: 36.09, lng: -120.5 }, east) - 10_000) < 100, 'beside the middle');
  assert.ok(Math.abs(toLine({ lat: 36, lng: -119.9 }, east) - 9_000) < 100, 'past the end');
  assert.ok(toLine({ lat: 36, lng: -120.7 }, east) < 1, 'on it');
  assert.ok(Math.abs(toLine({ lat: 36.09, lng: -121 }, [[36, -121]]) - 10_000) < 100, 'a point');
});

test("a downloaded pack: what it covers, its places and pages, its guides by name, and live mode's names", async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: '1.0.0', gapMs: 0 });
  const pack = await loadPack(ws, trip);
  assert.ok(pack);
  assert.equal(pack.day, new Date().toISOString().slice(0, 10));
  const bixby = { lat: 36.3715, lng: -121.9017 };
  assert.equal(pack.covers(bixby, 1000), true);
  assert.equal(pack.covers(bixby, 6000), false);
  assert.equal(pack.touches({ lat: 36.30, lng: -121.83 }), true); // on the way
  assert.equal(pack.touches({ lat: 36.60, lng: -121.89 }), false); // Monterey
  assert.deepEqual(pack.places(bixby, 1000, ['sights']).map((r) => r[0]), ['Bixby Bridge Vista Point']);
  assert.deepEqual(pack.places(bixby, 1000, ['toilets']).map((r) => [r[0], r[1], r[5]]), [['', 'toilets', 'osm']]);
  const pages = pack.pages(bixby, 2000);
  assert.deepEqual(pages.map((r) => r.slice(0, 2)), [['Bixby Creek Bridge', 'wikipedia article']]);
  assert.match(pages[0][6], /^Bixby Creek Bridge is a reinforced concrete .* https:\/\/en\.wikipedia\.org\/wiki\/Bixby_Creek_Bridge$/);
  assert.equal((await pack.guide('big sur'))?.title, 'Big Sur');
  assert.equal((await pack.guide('Cambria'))?.title, 'Cambria (California)');
  assert.equal((await pack.guide('Cambria, California'))?.title, 'Cambria (California)');
  assert.equal(await pack.guide('Monterey'), null);
  assert.deepEqual(pack.name({ lat: 36.3715, lng: -121.9017 }), { name: 'Bixby Creek Bridge', m: 0 });
  assert.equal(pack.name({ lat: 36.2203, lng: -121.7612 })?.name, 'Nepenthe (restaurant)'); // a restaurant is no place name; its article is
  assert.equal(pack.name({ lat: 36.5, lng: -121.95 }), null);
  assert.equal(await loadPack(ws, trip), pack); // read once for each version of the manifest
});

test('a broken pack is no pack, and a broken part is left out: never an error', async () => {
  const { ws, trip } = await packTrip();
  assert.equal(await loadPack(ws, trip), null);
  assert.equal(await loadPack(ws, null), null);
  await ws.write(trip, MANIFEST, '{"format":', { author: 'system', type: 'text/plain' });
  assert.equal(await loadPack(ws, trip), null);
  await downloadPack({ ws, scope: trip, ...services(), version: '1.0.0', gapMs: 0 });
  const m = /** @type {any} */ (await ws.readJSON(trip, MANIFEST));
  const osm = m.files.filter((/** @type {any} */ f) => f.kind === 'osm');
  await ws.write(trip, osm[0].path, '{"area":', { author: 'user', type: 'text/plain' });
  await ws.write(trip, osm[1].path, { area: { points: 'x', radius: 5000 }, rows: [] }, { author: 'user' });
  await ws.write(trip, osm[2].path, { area: { points: [[36.3, -121.85]], radius: 3000 }, rows: [['n9', 'Odd', 'viewpoint', 'x', 1, '', 'sights'], ['n10', 'Fine', 'viewpoint', 36.3, -121.85, '', 'sights']] }, { author: 'user' });
  await ws.patch(trip, MANIFEST, { at: '2026-10-17T00:00:00.000Z' }, { author: 'system' });
  const pack = await loadPack(ws, trip);
  assert.ok(pack);
  assert.deepEqual(pack.places({ lat: 36.3, lng: -121.85 }, 1000, ['sights']).map((r) => r[0]), ['Fine']);
  await ws.write(trip, m.guides.find((/** @type {any} */ g) => g.title === 'Big Sur').path, 'not json', { author: 'user', type: 'text/plain' });
  assert.equal(await pack.guide('Big Sur'), null);
});

test("a part Overpass cut off at its 3000 places doesn't count as covering: nearby asks online there, and uses it only when offline (C1)", async () => {
  const { ws, trip } = await packTrip();
  const many = Array.from({ length: 3000 }, (_, i) => ({ type: 'node', id: 1000 + i, lat: 36.3715 + (i % 50) / 1e4, lon: -121.9017 + Math.floor(i / 50) / 1e4, tags: { name: `Place ${i}`, amenity: 'cafe' } }));
  // Every part that reaches Bixby is cut off there: the stop's and the way's.
  await downloadPack({ ws, scope: trip, ...services({ overpass: (url, init) => (decodeURIComponent(String(init?.body)).includes('36.3715') ? { elements: many } : { elements: [] }) }), version: '1.0.0', gapMs: 0 });
  const pack = await loadPack(ws, trip);
  assert.ok(pack);
  const bixby = { lat: 36.3715, lng: -121.9017 };
  assert.equal(pack.covers(bixby, 1000), false);
  assert.equal(pack.touches(bixby), true);
  assert.equal(pack.covers({ lat: 36.2213, lng: -121.7567 }, 1000), true); // Nepenthe's part is whole
});
