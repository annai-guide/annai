import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validLinks, loadLinks, expandLink, mapsLinks, searchLinks } from '../../src/core/links.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';

const shipped = async () => JSON.parse(await readFile(new URL('../../catalog/links.json', import.meta.url), 'utf8'));
const freshWs = async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  return ws;
};

test('the shipped catalog is valid, and a non-https format is not', async () => {
  const c = await shipped();
  assert.equal(validLinks(c), true);
  assert.equal(validLinks({ ...c, maps: [{ ...c.maps[0], directions: 'javascript:alert(1)' }] }), false);
  assert.equal(validLinks({ ...c, search: { flight: [{ id: 'x', name: 'X', url: 'http://x.test/{a}', needs: [] }] } }), false);
  assert.equal(validLinks(null), false);
});

test('expandLink fills values, URI-encoded, and drops a [part] whose value is missing', () => {
  assert.equal(expandLink('https://x.test/{a}[/{b}][?c={c}]', { a: 'San Francisco', c: 'x&y' }), 'https://x.test/San%20Francisco?c=x%26y');
  assert.equal(expandLink('https://x.test/{a}[/{b}]', { a: 'A', b: ' ' }), 'https://x.test/A');
  assert.equal(expandLink('https://x.test/{a}', { a: '{b}' }), 'https://x.test/%7Bb%7D');
  assert.equal(expandLink('https://x.test/{n}adults', { n: 2 }), 'https://x.test/2adults');
});

test('mapsLinks: Apple and Google directions; a mode only one has gives one link', async () => {
  const c = await shipped();
  assert.deepEqual(mapsLinks(c, { destination: 'Nepenthe, Big Sur' }), [
    { label: 'Apple Maps', url: 'https://maps.apple.com/?daddr=Nepenthe%2C%20Big%20Sur&dirflg=d' },
    { label: 'Google Maps', url: 'https://www.google.com/maps/dir/?api=1&destination=Nepenthe%2C%20Big%20Sur&travelmode=driving' },
  ]);
  assert.deepEqual(mapsLinks(c, { destination: '36.22,-121.75', origin: 'Carmel', mode: 'transit' })[1].url,
    'https://www.google.com/maps/dir/?api=1&destination=36.22%2C-121.75&travelmode=transit&origin=Carmel');
  assert.deepEqual(mapsLinks(c, { destination: 'x', mode: 'bike' }).map((l) => l.label), ['Google Maps']);
  assert.throws(() => mapsLinks(c, { destination: ' ' }), /needs a destination/);
  assert.throws(() => mapsLinks(c, { destination: 'x', mode: 'teleport' }), /No maps app here gives teleport directions/);
});

test('searchLinks: prefilled searches; dates are checked, and what is missing is said', async () => {
  const c = await shipped();
  const flights = searchLinks(c, 'flight', { from: 'SFO', to: 'EWR', depart: '2026-11-25', return: '2026-11-29', adults: 2 });
  assert.deepEqual(flights.map((l) => l.label), ['Google Flights', 'KAYAK']);
  assert.equal(flights[1].url, 'https://www.kayak.com/flights/SFO-EWR/2026-11-25/2026-11-29/2adults');
  assert.equal(searchLinks(c, 'flight', { from: 'SFO', to: 'EWR', depart: '2026-11-25' })[1].url, 'https://www.kayak.com/flights/SFO-EWR/2026-11-25');
  assert.equal(searchLinks(c, 'hotel', { place: 'Hoboken', checkin: '2026-11-25', checkout: '2026-11-29' })[0].url,
    'https://www.booking.com/searchresults.html?ss=Hoboken&checkin=2026-11-25&checkout=2026-11-29');
  assert.equal(searchLinks(c, 'car', { place: 'EWR', pickup: '2026-11-25', dropoff: '2026-11-29' })[0].url, 'https://www.kayak.com/cars/EWR/2026-11-25/2026-11-29');
  assert.throws(() => searchLinks(c, 'flight', { from: 'SFO', to: 'EWR' }), /A flight search needs from, to, depart/);
  assert.throws(() => searchLinks(c, 'hotel', { place: 'Hoboken', checkin: '11/25/2026', checkout: '2026-11-29' }), /checkin must be a date written YYYY-MM-DD/);
  assert.throws(() => searchLinks(c, 'cruise', {}), /knows flight, hotel, car searches, not "cruise"/);
});

test('loadLinks: fetched and kept, once a session; offline, the kept copy; never fetched, null', async () => {
  const c = await shipped();
  const ws = await freshWs();
  let calls = 0;
  const online = async () => { calls++; return new Response(JSON.stringify(c), { status: 200 }); };
  assert.deepEqual(await loadLinks({ ws, fetch: online }), c);
  assert.deepEqual(await loadLinks({ ws, fetch: online }), c);
  assert.equal(calls, 1);
  assert.deepEqual(await ws.readJSON(SYS_SETTINGS, '/catalog/links.json'), c);
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  const kept = await freshWs();
  await kept.write(SYS_SETTINGS, '/catalog/links.json', c, { author: 'system' });
  assert.deepEqual(await loadLinks({ ws: kept, fetch: offline }), c);
  assert.equal(await loadLinks({ ws: await freshWs(), fetch: offline }), null);
  // A broken catalog on the site is not taken.
  const broken = async () => new Response('{"format":2}', { status: 200 });
  assert.equal(await loadLinks({ ws: await freshWs(), fetch: broken }), null);
});
