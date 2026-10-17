import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overpassFilters, kindsOf, osmRow, KIND_NAMES } from '../../src/core/pack/osm.js';

test('the Overpass filters nearby has always sent: whole values, and a name where one is needed', () => {
  assert.deepEqual(overpassFilters(['sights', 'toilets', 'parks']), [
    '[tourism~"^(attraction|viewpoint|museum|gallery|artwork|zoo|aquarium)$"][name]', '[historic][name]', '[natural~"^(waterfall|peak|beach|cave_entrance|arch)$"][name]',
    '[amenity=toilets]', '[leisure~"^(park|nature_reserve)$"][name]', '[boundary=national_park][name]']);
  assert.deepEqual(KIND_NAMES, ['sights', 'food', 'fuel', 'parking', 'toilets', 'lodging', 'shops', 'parks']);
  assert.deepEqual(overpassFilters(['nonsense']), []);
});

test('which kinds a place is, by its tags', () => {
  assert.deepEqual(kindsOf({ tourism: 'viewpoint', name: 'McWay Falls Overlook' }), ['sights']);
  assert.deepEqual(kindsOf({ tourism: 'viewpoint' }), []); // a sight needs a name
  assert.deepEqual(kindsOf({ amenity: 'toilets' }), ['toilets']);
  assert.deepEqual(kindsOf({ amenity: 'public_bookcase', name: 'Little Library' }), []);
  assert.deepEqual(kindsOf({ tourism: 'camp_site', leisure: 'park', name: 'Pfeiffer Big Sur' }), ['lodging', 'parks']);
});

test('a place as a row: id, name, kind, position, note and kinds; nothing without a position', () => {
  assert.deepEqual(osmRow({ type: 'way', id: 45, center: { lat: 36.158051, lon: -121.67199 }, tags: { name: 'McWay Falls', natural: 'waterfall', wikipedia: 'en:McWay Falls' } }),
    ['w45', 'McWay Falls', 'waterfall', 36.1581, -121.672, 'en:McWay Falls', 'sights']);
  assert.equal(osmRow({ type: 'node', id: 7, lat: 35.685, lon: -121.168, tags: { historic: 'castle', name: 'Hearst Castle' } })?.[2], 'historic castle');
  assert.deepEqual(osmRow({ type: 'node', id: 8, lat: 36.1, lon: -121.6, tags: { amenity: 'fuel', brand: 'Chevron' } })?.slice(1, 3), ['Chevron', 'fuel']);
  assert.equal(osmRow({ type: 'node', id: 9, tags: { name: 'Nowhere' } }), null);
  assert.equal(osmRow(null), null);
  assert.equal(osmRow({ lat: '36', lon: -121 }), null);
});
