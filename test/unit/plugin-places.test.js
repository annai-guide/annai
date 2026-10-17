import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { NOMINATIM_GAP } from '../../src/plugins/places/index.js';

async function setup({ trip = false } = {}) {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const tripId = trip ? await createTrip(ws, { title: 'Big Sur' }) : null;
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @type {{ url: string, init: any, at: number }[]} */
  const asked = [];
  /** @param {string} name @param {any} input @param {(url: string, init: any) => any} answer */
  const run = (name, input, answer) => tools[name].run(input, {
    scope: tripId ?? 'me', trip: tripId, signal: new AbortController().signal, model: null, wake: 'w', author: 'shiori',
    fetch: async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      asked.push({ url, init, at: Date.now() });
      const a = await answer(url, init);
      return a instanceof Response ? a : new Response(JSON.stringify(a));
    },
  });
  return { run, asked, ws, trip: tripId };
}

const McWay = { lat: 36.1580, lng: -121.6720 };

test('nearby: OpenStreetMap and Wikipedia together, nearest first, as TSV', async () => {
  const { run, asked } = await setup();
  const out = await run('nearby', { ...McWay, radius: 2000, kinds: ['sights'] }, (url) => {
    if (url.includes('overpass')) return { elements: [{ type: 'node', lat: 36.1585, lon: -121.6722, tags: { name: 'McWay Falls Overlook', tourism: 'viewpoint' } }, { type: 'way', center: { lat: 36.17, lon: -121.68 }, tags: { name: 'Far Trail', natural: 'peak' } }] };
    return { query: { geosearch: [{ title: 'McWay Falls', lat: 36.1577, lon: -121.6716, dist: 50.1 }] } };
  });
  const rows = out.split('\n');
  assert.equal(rows[0], 'name\tkind\tdistance_m\tlat\tlng\tsource\tnote');
  assert.deepEqual(rows.slice(1).map((r) => r.split('\t')[0]), ['McWay Falls', 'McWay Falls Overlook', 'Far Trail']);
  assert.match(rows[1], /\twikipedia\thttps:\/\/en\.wikipedia\.org\/wiki\/McWay_Falls$/);
  const body = decodeURIComponent(String(asked.find((a) => a.url.includes('overpass'))?.init.body)).replace(/\+/g, ' ');
  assert.match(body, /around:2000,36\.158,-121\.672/);
});

test('nearby: the second OpenStreetMap server when the first fails; Wikipedia alone, said so, when both do', async () => {
  const { run, asked } = await setup();
  const wiki = { query: { geosearch: [{ title: 'McWay Falls', lat: 36.1577, lon: -121.6716, dist: 50 }] } };
  await run('nearby', McWay, (url) => (url.includes('overpass-api.de') ? new Response('', { status: 502 }) : url.includes('overpass') ? { elements: [] } : wiki));
  assert.ok(asked.some((a) => a.url.includes('overpass.private.coffee')));
  const out = await run('nearby', McWay, (url) => (url.includes('overpass') ? new Response('', { status: 504 }) : wiki));
  assert.match(out, /OpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
});

test('geocode and reverse through Nominatim, one request a second at most', async () => {
  const { run, asked } = await setup();
  NOMINATIM_GAP.ms = 60;
  const found = await run('geocode', { query: 'Nepenthe, Big Sur' }, () => [{ display_name: 'Nepenthe, Highway 1, Big Sur, CA', lat: '36.2203', lon: '-121.7612', category: 'amenity', type: 'restaurant' }]);
  assert.equal(found, 'name\tlat\tlng\ttype\nNepenthe, Highway 1, Big Sur, CA\t36.2203\t-121.7612\tamenity/restaurant');
  const where = await run('reverse', McWay, () => ({ name: 'McWay Falls', display_name: 'McWay Falls, Big Sur, CA', category: 'natural', type: 'waterfall' }));
  assert.deepEqual(JSON.parse(where), { name: 'McWay Falls', address: 'McWay Falls, Big Sur, CA', type: 'natural/waterfall' });
  assert.ok(asked[1].at - asked[0].at >= 55);
  assert.match(asked[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=Nepenthe%2C%20Big%20Sur&format=jsonv2&limit=5$/);
});

test("weather: the place's time zone, the day, and its hours as TSV", async () => {
  const { run, asked } = await setup();
  const hours = ['2026-11-26T15:00', '2026-11-26T16:00', '2026-11-27T15:00'];
  const out = await run('weather', { ...McWay, when: '2026-11-26' }, () => ({
    timezone: 'America/Los_Angeles', timezone_abbreviation: 'PST',
    hourly: { time: hours, temperature_2m: [14.2, 13.1, 12], precipitation_probability: [10, 20, 80], precipitation: [0, 0, 2.1], weather_code: [2, 3, 61], wind_speed_10m: [12, 15, 30] },
    daily: { time: ['2026-11-26', '2026-11-27'], sunrise: ['2026-11-26T06:58', '2026-11-27T06:59'], sunset: ['2026-11-26T16:53', '2026-11-27T16:52'],
      temperature_2m_max: [15, 13], temperature_2m_min: [8, 9], precipitation_probability_max: [20, 80] },
  }));
  assert.match(asked[0].url, /latitude=36\.158&longitude=-121\.672/);
  assert.match(asked[0].url, /timezone=auto/);
  assert.equal(out, [
    'Time zone: America/Los_Angeles (PST)',
    '2026-11-26: 8 to 15 °C, rain chance up to 20%, sunrise 06:58, sunset 16:53',
    'time\ttemp_c\train_chance_pct\train_mm\tweather\twind_kmh',
    '2026-11-26T15:00\t14.2\t10\t0\tpartly cloudy\t12',
    '2026-11-26T16:00\t13.1\t20\t0\tovercast\t15',
  ].join('\n'));
  assert.match(await run('weather', { ...McWay, when: '2027-03-01' }, () => ({ timezone: 'America/Los_Angeles', hourly: { time: [] }, daily: { time: [] } })), /16 days/);
});

test('guide: the introduction and the sections; one section; or what there is instead', async () => {
  const { run } = await setup();
  const extract = 'Big Sur is a region.\n\n== Understand ==\nRugged coast.\n\n== Eat ==\nNepenthe.\n\n=== Budget ===\nDeli.\n\n== Sleep ==\nCamp.';
  const page = { query: { pages: { 1: { title: 'Big Sur', extract } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (Wikivoyage)\n\nBig Sur is a region.\n\nSections: Understand, Eat, Budget, Sleep. Ask for one with section.');
  assert.equal(await run('guide', { place: 'Big Sur', section: 'eat' }, () => page), 'Big Sur: Eat (Wikivoyage)\n\nNepenthe.\n\n=== Budget ===\nDeli.');
  const missing = await run('guide', { place: 'Bigg Sur' }, (url) => (url.includes('opensearch') ? ['Bigg Sur', ['Big Sur', 'Big Sur River']] : { query: { pages: { '-1': { title: 'Bigg Sur', missing: '' } } } }));
  assert.equal(missing, 'Wikivoyage has no article called "Bigg Sur". Close ones: Big Sur, Big Sur River.');
});

test('nearby: toilets and parking count without a name; sights and food are asked for with one, matched whole', async () => {
  const { run, asked } = await setup();
  const out = await run('nearby', { ...McWay, kinds: ['toilets', 'food'] }, (url) => {
    if (url.includes('overpass')) return { elements: [{ type: 'node', lat: 36.1581, lon: -121.6721, tags: { amenity: 'toilets' } }] };
    return { query: { geosearch: [] } };
  });
  assert.match(out.split('\n')[1], /^\ttoilets\t\d+\t36\.1581\t-121\.6721\tosm\t$/);
  const body = decodeURIComponent(String(asked.find((a) => a.url.includes('overpass'))?.init.body)).replace(/\+/g, ' ');
  assert.match(body, /\)\[amenity=toilets\];/);
  assert.match(body, /\)\[amenity~"\^\(restaurant\|cafe\|fast_food\|bar\|pub\|ice_cream\)\$"\]\[name\];/);
});

test("Nominatim is told who is asking: the app's origin as the referrer", async () => {
  const { run, asked } = await setup();
  await run('geocode', { query: 'Big Sur' }, () => []);
  assert.equal(asked[0].init.referrerPolicy, 'origin');
});

test('weather without a connection: no forecast, but the sun, worked out on the phone (spec §11.5)', async () => {
  const { run } = await setup();
  const out = await run('weather', { lat: 36.27, lng: -121.807, when: '2026-11-27' }, () => { throw new TypeError('Failed to fetch'); });
  assert.match(out, /^Open-Meteo didn't answer \(Failed to fetch\), so there is no forecast\. Worked out on the phone, in this phone's time zone \([^)]+\): /);
  assert.match(out, /sunrise \d\d:\d\d, sunset \d\d:\d\d, golden hour until \d\d:\d\d in the morning and from \d\d:\d\d in the evening\.$/);
  const far = await run('weather', { lat: 69.6492, lng: 18.9553, when: '2026-12-21' }, () => { throw new TypeError('Load failed'); });
  assert.match(far, /the sun doesn't rise that day; twilight from \d\d:\d\d to \d\d:\d\d\.$/);
});

test("a server's answer annai can't read is the tool's plain answer, not a bug in the plugin", async () => {
  const { run } = await setup();
  await assert.rejects(run('geocode', { query: 'Big Sur' }, () => new Response('<html>Bad gateway</html>')),
    (/** @type {any} */ e) => e.constructor === Error && /^Nominatim sent an answer annai can't read\.$/.test(e.message));
  await assert.rejects(run('guide', { place: 'Big Sur' }, () => new Response('{"query":')),
    (/** @type {any} */ e) => e.constructor === Error && /^en\.wikivoyage\.org sent an answer annai can't read\.$/.test(e.message));
});

/** Writes a small pack by McWay Falls into the trip, as a download would leave it. @param {any} ws @param {string} trip */
async function mcwayPack(ws, trip) {
  const at = '2026-10-16T09:00:00.000Z';
  await ws.write(trip, '/offline/osm/o1.json', JSON.stringify({ area: { points: [[36.158, -121.672]], radius: 5000 }, rows: [
    ['n1', 'McWay Falls Overlook', 'viewpoint', 36.1585, -121.6722, '', 'sights'],
    ['n2', 'Big Sur Bakery', 'cafe', 36.2700, -121.8080, '', 'food'],
    ['n3', 'Julia Pfeiffer Burns cafe', 'cafe', 36.1600, -121.6700, '', 'food'],
  ] }), { author: 'system' });
  await ws.write(trip, '/offline/wikipedia/w1.json', JSON.stringify({ at: [36.158, -121.672], radius: 10000, pages: [['McWay Falls', 36.1577, -121.6716, 'McWay Falls is an 80-foot waterfall that flows year-round from McWay Creek in Julia Pfeiffer Burns State Park.']] }), { author: 'system' });
  await ws.write(trip, '/offline/wikivoyage/g1.json', JSON.stringify({ title: 'Cambria (California)', text: 'Cambria is a town.\n\n== See ==\nMoonstone Beach.' }), { author: 'system' });
  await ws.write(trip, '/offline/wikivoyage/g2.json', JSON.stringify({ title: 'San Simeon', text: 'San Simeon is home to Hearst Castle.' }), { author: 'system' });
  await ws.write(trip, '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at, failed: [], full: false, stopped: false, bytes: 1000,
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 400, items: 3 }, { id: 'w1', kind: 'wikipedia', path: '/offline/wikipedia/w1.json', bytes: 300, items: 1 },
      { id: 'g1', kind: 'wikivoyage', path: '/offline/wikivoyage/g1.json', bytes: 100, items: 1 }, { id: 'g2', kind: 'wikivoyage', path: '/offline/wikivoyage/g2.json', bytes: 100, items: 1 }],
    guides: [{ title: 'Cambria (California)', asked: ['Cambria, California'], path: '/offline/wikivoyage/g1.json' }, { title: 'San Simeon', asked: ['Hearst Castle'], path: '/offline/wikivoyage/g2.json' }] }), { author: 'system' });
}
const nothing = () => { throw new Error('no request should be made'); };

test('nearby reads the offline pack first: no request where it covers the whole circle (spec §8)', async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const out = await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing);
  const rows = out.split('\n');
  assert.equal(rows[0], 'name\tkind\tdistance_m\tlat\tlng\tsource\tnote');
  assert.deepEqual(rows.slice(1, -1).map((r) => r.split('\t')[0]), ['McWay Falls', 'McWay Falls Overlook']);
  assert.match(rows[1], /\twikipedia\tMcWay Falls is an 80-foot waterfall .*State Park\. https:\/\/en\.wikipedia\.org\/wiki\/McWay_Falls$/);
  assert.equal(rows.at(-1), 'From the offline pack (downloaded 2026-10-16).');
  const food = await run('nearby', { ...McWay, radius: 1000, kinds: ['food'] }, nothing);
  assert.deepEqual(food.split('\n').slice(1, -1).map((r) => r.split('\t')[0]), ['McWay Falls', 'Julia Pfeiffer Burns cafe']);
});

test("past the pack's edge nearby asks the services, and the pack fills in for any that don't answer, saying so", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const wiki = { query: { geosearch: [{ title: 'Partington Cove', lat: 36.175, lon: -121.69, dist: 2400 }] } };
  const online = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? { elements: [] } : wiki));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
  assert.doesNotMatch(online, /offline pack/);
  const down = await run('nearby', { ...McWay, radius: 8000 }, () => { throw new Error("annai couldn't reach overpass-api.de. Is the device offline?"); });
  assert.match(down, /\nOpenStreetMap and Wikipedia didn't answer, so these come from the offline pack \(downloaded 2026-10-16\)\.$/);
  assert.match(down, /McWay Falls Overlook/);
  const half = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? new Response('', { status: 504 }) : wiki));
  assert.match(half, /Partington Cove/);
  assert.match(half, /\nOpenStreetMap didn't answer, so its places come from the offline pack \(downloaded 2026-10-16\)\.$/);
  // Outside the pack, with both services down, it says so as before.
  await assert.rejects(run('nearby', { lat: 36.6, lng: -121.9 }, () => { throw new Error('offline'); }), /Neither OpenStreetMap nor Wikipedia answered/);
});

test('guide reads the pack first: by its title, without "(California)", or by a name that led to it; a section too', async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  assert.equal(await run('guide', { place: 'Cambria' }, nothing), 'Cambria (California) (Wikivoyage, offline pack of 2026-10-16)\n\nCambria is a town.\n\nSections: See. Ask for one with section.');
  assert.equal(await run('guide', { place: 'cambria, california', section: 'see' }, nothing), 'Cambria (California): See (Wikivoyage, offline pack of 2026-10-16)\n\nMoonstone Beach.');
  assert.match(await run('guide', { place: 'Hearst Castle' }, nothing), /^San Simeon \(Wikivoyage, offline pack of 2026-10-16\)/);
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (Wikivoyage)\n\nBig Sur is a region.');
});

test('a broken pack is no pack: the tools go online', async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await ws.write(/** @type {string} */ (trip), '/offline/pack.json', '{"format":1,', { author: 'system', type: 'text/plain' });
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (Wikivoyage)\n\nBig Sur is a region.');
  await run('nearby', McWay, (url) => (url.includes('overpass') ? { elements: [] } : { query: { geosearch: [] } }));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
});
