import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { NOMINATIM_GAP, ASK_MS, OVERPASS_MS } from '../../src/plugins/places/index.js';
import { articlesOf, merged } from '../../src/core/wiki.js';
import { guideFile } from '../../src/core/pack/download.js';
import { meters } from '../../src/core/live/geo.js';

/**
 * overpass-api.de's answer to nearby's own default query (sights and food, 1000 m) at Tokyo Station, as it came to one server on
 * 2026-11-14 through nearby's code, trimmed to a few elements: public landmark data, under the ODbL (its osm3s field says so).
 */
const TOKYO_ANSWER = JSON.parse(await readFile(new URL('../fixtures/places/overpass-tokyo.json', import.meta.url), 'utf8'));

/** en.wikipedia.org's real answer to nearby's query in the open Pacific (0, -140; 2026-11-19): nothing near. */
const NONE = JSON.parse(await readFile(new URL('../fixtures/places/wiki-nearby-none.json', import.meta.url), 'utf8'));
/**
 * A Wikipedia edition's answer to nearby's generator geosearch, shaped as the saved real ones (test/fixtures/places/wiki-kiyomizu-*.json): each page its
 * pageid, title, index, primary coordinates and Wikidata id; with none near, the saved Pacific answer.
 * @param {...[string, number, number, string?]} pages title, lat, lon, Wikidata id
 */
const geo = (...pages) => (pages.length
  ? { batchcomplete: true, query: { pages: pages.map(([title, lat, lon, id], k) => ({ pageid: 1000 + k, ns: 0, title, index: k - 1, coordinates: [{ lat, lon, primary: true, globe: 'earth' }], pageprops: { wikibase_item: id ?? `Q${900 + k}` } })) } }
  : NONE);

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
  /** @param {string} name @param {any} input @param {(url: string, init: any) => any} answer @param {Record<string, any>} [more] more of the call */
  const run = (name, input, answer, more = {}) => tools[name].run(input, {
    scope: tripId ?? 'me', trip: tripId, signal: new AbortController().signal, model: null, wake: 'w', author: 'shiori', ...more,
    fetch: async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      asked.push({ url, init, at: Date.now() });
      const a = await answer(url, init);
      return a instanceof Response ? a : new Response(JSON.stringify(a));
    },
  });
  return { run, asked, ws, trip: tripId };
}

const McWay = { lat: 36.1580, lng: -121.6720 };
const KIYOMIZU = { lat: 34.9949, lng: 135.785 };
/** Settings → Languages with a list chosen, as its screen saves it. @param {any} ws @param {string[]} spoken */
const speaks = (ws, spoken) => updateAppSettings(ws, { languages: { spoken, answer: 'follow' } });

test('nearby: OpenStreetMap and Wikipedia together, nearest first, as TSV', async () => {
  const { run, asked } = await setup();
  const out = await run('nearby', { ...McWay, radius: 2000, kinds: ['sights'] }, (url) => {
    if (url.includes('overpass')) return { elements: [{ type: 'node', lat: 36.1585, lon: -121.6722, tags: { name: 'McWay Falls Overlook', tourism: 'viewpoint' } }, { type: 'way', center: { lat: 36.17, lon: -121.68 }, tags: { name: 'Far Trail', natural: 'peak' } }] };
    return geo(['McWay Falls', 36.1577, -121.6716]);
  });
  const rows = out.split('\n');
  assert.equal(rows[0], 'name\tkind\tdistance_m\tlat\tlng\tsource\tnote');
  assert.deepEqual(rows.slice(1).map((r) => r.split('\t')[0]), ['McWay Falls', 'McWay Falls Overlook', 'Far Trail']);
  assert.match(rows[1], /\twikipedia\thttps:\/\/en\.wikipedia\.org\/wiki\/McWay_Falls$/);
  const body = decodeURIComponent(String(asked.find((a) => a.url.includes('overpass'))?.init.body)).replace(/\+/g, ' ');
  assert.match(body, /around:2000,36\.158,-121\.672/);
});

/** The Overpass query nearby sent, from its form body. @param {{ url: string, init: any }[]} asked */
const overpassQuery = (asked) => String(new URLSearchParams(String(asked.find((a) => a.url.includes('overpass'))?.init.body)).get('data'));
const noWiki = geo();

test("nearby's query at its defaults: the 250 m circle first, then the 500 and 1000 m ones, each only when the one before held fewer than 40, declaring 64 MiB", async () => {
  const { run, asked } = await setup();
  await run('nearby', { lat: 35.6812, lng: 139.7671 }, (url) => (url.includes('overpass') ? { elements: [] } : noWiki));
  // Written as the probe's script wrote it (.superpowers/probes/overpass-lighter/probe.sh, its inner64 form), which overpass-api.de and
  // its backends answered: sights' three tags and food's one, each with a name. The probe asked 300 m, then 1000 m; the steps between
  // circles are half the radius here (a quarter of the area: the final review's finding 1, 2026-11-16).
  const filters = ['[tourism~"^(attraction|viewpoint|museum|gallery|artwork|zoo|aquarium)$"][name]', '[historic][name]',
    '[natural~"^(waterfall|peak|beach|cave_entrance|arch)$"][name]', '[amenity~"^(restaurant|cafe|fast_food|bar|pub|ice_cream)$"][name]'];
  const circle = (/** @type {number} */ r) => `(${filters.map((f) => `nwr(around:${r},35.6812,139.7671)${f};`).join('')});`;
  assert.equal(overpassQuery(asked), `[out:json][timeout:20][maxsize:67108864];${circle(250)}if (count(nwr) < 40) {${circle(500)}}if (count(nwr) < 40) {${circle(1000)}}out center tags 400;`);
});

test("nearby's query for other radii and kinds: circles each half the next (a quarter of the area), down to the first of 300 m or less, each with the asked kinds", async () => {
  const { run, asked } = await setup();
  /** The circles nearby asks for, smallest first, each as its radius and its statements with the radius taken out. @param {any} input */
  const circles = async (input) => {
    asked.length = 0;
    await run('nearby', { ...McWay, ...input }, (url) => (url.includes('overpass') ? { elements: [] } : noWiki));
    const q = overpassQuery(asked);
    const m = /^\[out:json\]\[timeout:20\]\[maxsize:67108864\];(\(.*?\);)((?:if \(count\(nwr\) < 40\) \{\(.*?\);\})*)out center tags 400;$/.exec(q);
    assert.ok(m, q);
    const all = [m[1], ...[...m[2].matchAll(/if \(count\(nwr\) < 40\) \{(\(.*?\);)\}/g)].map((x) => x[1])];
    return all.map((c) => {
      const radii = [...new Set([...c.matchAll(/nwr\(around:(\d+),36\.158,-121\.672\)/g)].map((x) => Number(x[1])))];
      assert.equal(radii.length, 1, c);
      return { r: radii[0], text: c.replaceAll(`around:${radii[0]},`, 'around:R,') };
    });
  };
  // The driving companion's widest look ahead (skills/driving-companion: 5000 to 15000 m, sights): 15000 / 2 = 7500, then 3750, 1875,
  // 937.5 (938), 469 and 234.5, the first of 300 m or less, rounded to 235.
  const drive = await circles({ radius: 15000, kinds: ['sights'] });
  assert.deepEqual(drive.map((c) => c.r), [235, 469, 938, 1875, 3750, 7500, 15000]);
  assert.ok(drive.every((c) => c.text === '(nwr(around:R,36.158,-121.672)[tourism~"^(attraction|viewpoint|museum|gallery|artwork|zoo|aquarium)$"][name];'
    + 'nwr(around:R,36.158,-121.672)[historic][name];nwr(around:R,36.158,-121.672)[natural~"^(waterfall|peak|beach|cave_entrance|arch)$"][name];);'));
  // Whole meters: 1234 / 2 = 617, then 308.5 (309), which is over 300, then 154.5 (155).
  const food = await circles({ radius: 1234, kinds: ['food'] });
  assert.deepEqual(food.map((c) => c.r), [155, 309, 617, 1234]);
  assert.match(food[0].text, /^\(nwr\(around:R,36\.158,-121\.672\)\[amenity~"[^"]+"\]\[name\];\);$/);
  // A radius past nearby's 20 km asks 20 km.
  assert.deepEqual((await circles({ radius: 50000, kinds: ['lodging'] })).map((c) => c.r), [157, 313, 625, 1250, 2500, 5000, 10000, 20000]);
  // 300 m or less: that circle alone, as one statement per tag, kinds asked without a name without one.
  assert.deepEqual(await circles({ radius: 300, kinds: ['food'] }).then((c) => c.map((x) => x.r)), [300]);
  assert.deepEqual(await circles({ radius: 50, kinds: ['toilets', 'parking'] }), [{ r: 50, text: '(nwr(around:R,36.158,-121.672)[amenity=toilets];nwr(around:R,36.158,-121.672)[amenity=parking];);' }]);
});

/**
 * Three of the 24 probes' answers (2026-11-15/16, overpass-api.de, the probed query, the 300 m circle then the 1000 m one, at public landmarks, byte for byte as they came,
 * gzipped; OpenStreetMap data under the ODbL, which their osm3s field says), with what the probe measured in each by its own code (jq,
 * haversine on 6371 km from each place's full position, a way's centre): its 40th nearest place, in meters. Tokyo's and Paris's 300 m
 * circles held 81 and 153 places, so that circle came; Sydney's held fewer than 40, so the 1000 m one came, cut at 400 (nodes only, in id order).
 */
const LIGHTER = {
  tokyo: { at: { lat: 35.6812, lng: 139.7671 }, n: 81, near40: 201, nearest: '東京駅丸の内駅舎' },
  paris: { at: { lat: 48.853, lng: 2.3499 }, n: 153, near40: 171, nearest: 'Cathédrale Notre-Dame de Paris' },
  sydney: { at: { lat: -33.8568, lng: 151.2153 }, n: 400, near40: 404, nearest: 'midden' },
};
/** A probe's answer, from its fixture. @param {string} place */
const lighter = async (place) => JSON.parse(gunzipSync(await readFile(new URL(`../fixtures/places/overpass-lighter-${place}.json.gz`, import.meta.url))).toString('utf8'));

test("nearby's rows from the probes' real answers: the nearest 40 by distance, from anywhere in the answer, which comes in id order", async () => {
  const rad = (/** @type {number} */ d) => (d * Math.PI) / 180;
  for (const [place, p] of Object.entries(LIGHTER)) {
    const body = await lighter(place);
    assert.equal(body.elements.length, p.n, place);
    const { run } = await setup();
    const lines = (await run('nearby', p.at, (url) => (url.includes('overpass') ? body : noWiki))).split('\n');
    // The header and 40 rows; Sydney's answer, at Overpass's 400, then ends with the line saying it was cut (the next test).
    assert.equal(lines.length, p.n === 400 ? 42 : 41, place);
    const rows = lines.slice(1, 41).map((r) => r.split('\t'));
    assert.ok(rows.every((r) => r[5] === 'osm'), place);
    const meters = rows.map((r) => Number(r[2]));
    assert.deepEqual(meters, [...meters].sort((a, b) => a - b), `${place}: nearest first`);
    assert.equal(rows[0][0], p.nearest, place);
    // The nearest place comes late in the answer (a way or relation after every node, or a high id): the first 40 as sent would miss it.
    assert.ok(body.elements.findIndex((/** @type {any} */ e) => e.tags?.name === p.nearest) >= 40, place);
    // Each place measured as the probe did, from its full position: the 40th is the probe's. nearby measures from the 4-decimal position
    // it lists (up to about 7 m off), so places clearly nearer than that 40th are all listed, and none clearly farther.
    const all = body.elements.map((/** @type {any} */ e) => {
      const [lat, lng] = [e.lat ?? e.center.lat, e.lon ?? e.center.lon];
      const h = Math.sin(rad(lat - p.at.lat) / 2) ** 2 + Math.cos(rad(p.at.lat)) * Math.cos(rad(lat)) * Math.sin(rad(lng - p.at.lng) / 2) ** 2;
      const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
      return { key: `${e.tags.name}\t${r4(lat)}\t${r4(lng)}`, m: 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) };
    }).sort((/** @type {any} */ a, /** @type {any} */ b) => a.m - b.m);
    assert.equal(Math.round(all[39].m), p.near40, `${place}: the 40th nearest, as the probe measured it`);
    assert.ok(Math.abs(meters[39] - p.near40) <= 10, `${place}: nearby's 40th, ${meters[39]} m`);
    const listed = new Set(rows.map((r) => `${r[0]}\t${r[3]}\t${r[4]}`));
    for (const e of all) {
      if (e.m < p.near40 - 10) assert.ok(listed.has(e.key), `${place}: ${e.key} at ${Math.round(e.m)} m is listed`);
      if (e.m > p.near40 + 10) assert.ok(!listed.has(e.key), `${place}: ${e.key} at ${Math.round(e.m)} m is not`);
    }
  }
});

test("nearby's rows from Tokyo's answer: the station building (a relation) first; a historic road reaching into the circle, its centre 77 km off, left out", async () => {
  const body = await lighter('tokyo');
  const { run } = await setup();
  const out = await run('nearby', LIGHTER.tokyo.at, (url) => (url.includes('overpass') ? body : noWiki));
  assert.match(out.split('\n')[1], /^東京駅丸の内駅舎\thistoric building\t99\t35\.6812\t139\.766\tosm\t/);
  assert.ok(body.elements.some((/** @type {any} */ e) => e.tags?.name === '甲州道中'));
  assert.ok(!out.includes('甲州道中'));
});

/** The line nearby ends its answer with when OpenStreetMap's answer stopped at its 400 (the query's `out center tags 400`), naming the radius to ask again with. @param {number} m */
const cutLine = (m) => `OpenStreetMap's answer stopped at 400 places, not chosen by distance, so a nearer place may be missing. Ask again with a radius of ${m} m or less for the nearest places within it.`;

test("nearby says when OpenStreetMap's answer stopped at 400, counting what Overpass sent, last, beside the other endings; never at 399", async () => {
  // Sydney's probe answer (LIGHTER): the 1000 m circle, cut at 400 nodes in id order, the Opera House (an outline) not among them.
  const body = await lighter('sydney');
  assert.equal(body.elements.length, 400);
  const at = LIGHTER.sydney.at;
  const { run, ws, trip } = await setup({ trip: true });
  const wiki = geo(['Sydney Opera House', -33.8568, 151.2153]);
  const lines = (await run('nearby', at, (url) => (url.includes('overpass') ? body : wiki))).split('\n');
  assert.equal(lines.length, 42);
  assert.ok(lines.slice(1, 41).every((r) => r.split('\t').length === 7));
  // nearby reads this saved answer of the earlier query as cut in the 500 m circle, which holds 66 of these places as nearby rounds them (the
  // 250 m one 18): it names 250 m. Today's query stops at 500 m there, whole.
  assert.equal(lines.at(-1), cutLine(250));
  // 399 of the same places: an answer that didn't reach the limit says nothing.
  const whole = (await run('nearby', at, (url) => (url.includes('overpass') ? { ...body, elements: body.elements.slice(0, 399) } : wiki))).split('\n');
  assert.equal(whole.length, 41);
  assert.equal(whole.at(-1).split('\t').length, 7);
  // What Overpass sent counts, not the rows kept: 400 elements, five of them with no position (osmRow makes no row from one; an element
  // without tags still makes a row), are still cut.
  const bare = body.elements.map((/** @type {any} */ e, /** @type {number} */ k) => (k < 5 ? { type: e.type, id: e.id, tags: e.tags } : e));
  assert.equal((await run('nearby', at, (url) => (url.includes('overpass') ? { ...body, elements: bare } : wiki))).split('\n').at(-1), cutLine(250));
  // Wikipedia not answering, and no pack: OpenStreetMap's rows, then the Wikipedia line, then the cut line.
  const down = (await run('nearby', at, (url) => (url.includes('overpass') ? body : new Response('', { status: 503 })))).split('\n');
  assert.equal(down.length, 43);
  assert.deepEqual(down.slice(-2), ["Wikipedia didn't answer; these are OpenStreetMap places only.", cutLine(250)]);
  // A pack whose area holds the point but not the circle fills in for Wikipedia, saying so; the cut line comes after, last.
  const day = '2026-10-16T09:00:00.000Z';
  await ws.write(/** @type {string} */ (trip), '/offline/osm/o1.json', JSON.stringify({ area: { points: [[at.lat, at.lng]], radius: 500 }, rows: [] }), { author: 'system' });
  await ws.write(/** @type {string} */ (trip), '/offline/wikipedia/w1.json', JSON.stringify({ at: [at.lat, at.lng], radius: 10000, pages: [['Sydney Opera House', -33.8568, 151.2153, 'The Sydney Opera House is a performing arts centre in Sydney.']] }), { author: 'system' });
  await ws.write(/** @type {string} */ (trip), '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at: day, failed: [], full: false, stopped: false, bytes: 700,
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 400, items: 0 }, { id: 'w1', kind: 'wikipedia', path: '/offline/wikipedia/w1.json', bytes: 300, items: 1 }], guides: [] }), { author: 'system' });
  const filled = (await run('nearby', at, (url) => (url.includes('overpass') ? body : new Response('', { status: 503 })))).split('\n');
  assert.equal(filled.length, 43);
  assert.match(filled[1], /^Sydney Opera House\twikipedia article\t0\t/);
  assert.deepEqual(filled.slice(-2), ["Wikipedia didn't answer, so its articles come from the offline pack (downloaded 2026-10-16).", cutLine(250)]);
  // With the pack, an answer short of the limit ends as before.
  assert.equal((await run('nearby', at, (url) => (url.includes('overpass') ? { ...body, elements: body.elements.slice(0, 399) } : new Response('', { status: 503 })))).split('\n').at(-1),
    "Wikipedia didn't answer, so its articles come from the offline pack (downloaded 2026-10-16).");
});

/** An Overpass answer of n named nodes due north of a point, from `from` to `to` m away (about 111195 m to a degree of latitude). @param {{ lat: number, lng: number }} at @param {number} n @param {number} from @param {number} to */
const ring = (at, n, from, to) => ({ elements: Array.from({ length: n }, (_, k) => ({ type: 'node', id: k + 1, lat: at.lat + (from + ((to - from) * k) / (n - 1)) / 111195, lon: at.lng, tags: { name: `Place ${k}`, tourism: 'attraction' } })) });
/** The circles of the query nearby sent, smallest first. @param {{ url: string, init: any }[]} asked */
const circlesOf = (asked) => [...new Set([...overpassQuery(asked).matchAll(/around:(\d+),/g)].map((m) => Number(m[1])))];

test("nearby names the circle to ask again with: half the one cut, which held fewer than 40 and so came whole; the widest, an inner one or the smallest", async () => {
  const at = { lat: 48.853, lng: 2.3499 };
  /** One cut answer: the circles asked, the last line, and the circles asked again at the radius it names. @param {any} input @param {number} from @param {number} to */
  const cutAt = async (input, from, to) => {
    const { run, asked } = await setup();
    const lines = (await run('nearby', { ...at, ...input }, (url) => (url.includes('overpass') ? ring(at, 400, from, to) : noWiki))).split('\n');
    assert.equal(lines.length, 42);
    const named = /a radius of (\d+) m or less/.exec(lines.at(-1) ?? '');
    assert.ok(named, String(lines.at(-1)));
    const first = circlesOf(asked);
    asked.length = 0;
    await run('nearby', { ...at, ...input, radius: Number(named[1]) }, (url) => (url.includes('overpass') ? { elements: [] } : noWiki));
    return { line: lines.at(-1), first, again: circlesOf(asked) };
  };
  // The widest circle cut: 400 places between 620 and 980 m, none within 500 m. The 500 m circle came whole before it, so 500 m is asked.
  const widest = await cutAt({}, 620, 980);
  assert.deepEqual(widest.first, [250, 500, 1000]);
  assert.equal(widest.line, cutLine(500));
  assert.deepEqual(widest.again, [250, 500]);
  // An inner circle cut: 400 places between 300 and 480 m. The 1000 m circle never ran, and half the radius (500 m) would have been the
  // same query without it, the same answer again: it is the 500 m circle that was cut, so 250 m is asked.
  const inner = await cutAt({}, 300, 480);
  assert.equal(inner.line, cutLine(250));
  assert.deepEqual(inner.again, [250]);
  // The smallest circle cut: 400 places within 240 m. Half of it is a new circle, 125 m, which can be cut again and says so again.
  const smallest = await cutAt({}, 20, 240);
  assert.equal(smallest.line, cutLine(125));
  assert.deepEqual(smallest.again, [125]);
  // A radius of 300 m or less is one circle: half of that.
  const one = await cutAt({ radius: 200 }, 20, 190);
  assert.deepEqual(one.first, [200]);
  assert.equal(one.line, cutLine(100));
  // The driving companion's 15 km look ahead, on synthetic nodes due north with the dense area inside the 7500 m circle (at the live call of
  // 2026-11-16, a point in Lake Michigan, the circles up to 7500 m held fewer than 40 and the 15 km one was cut; nearby names 7500 m on
  // that saved answer): here 7500 m is cut, so 3750 m is asked, where half the radius (7500) would repeat the answer.
  const drive = await cutAt({ radius: 15000 }, 4000, 7400);
  assert.deepEqual(drive.first, [235, 469, 938, 1875, 3750, 7500, 15000]);
  assert.equal(drive.line, cutLine(3750));
  assert.deepEqual(drive.again, [235, 469, 938, 1875, 3750]);
  // Dense nearer in, the 1875 m circle cut: 938 m.
  assert.equal((await cutAt({ radius: 15000 }, 1000, 1800)).line, cutLine(938));
  // A circle is told by the distance each row carries, and an outline's is to its centre: 360 roads counted by their centre, 5 km away
  // (the mock roads have no outline; Overpass would count one reaching the circle), don't count in it, so with 40 nodes between 300 and
  // 480 m the 500 m circle is the one cut.
  const { run } = await setup();
  const roads = (/** @type {number} */ n) => Array.from({ length: n }, (_, k) => ({ type: 'way', id: 1000 + k, center: { lat: at.lat + 0.045, lon: at.lng }, tags: { name: `Road ${k}`, historic: 'road' } }));
  const last = async (/** @type {any[]} */ elements) => (await run('nearby', at, (url) => (url.includes('overpass') ? { elements } : noWiki))).split('\n').at(-1);
  assert.equal(await last([...ring(at, 40, 300, 480).elements, ...roads(360)]), cutLine(250));
  // 39 nodes in the 500 m circle and 361 roads centred off: no circle holds 40 rows, so it is the radius asked, 1000 m, halved. The 40 is
  // pinned from below: with 39 enough, the 500 m circle would be the one cut and 250 m named.
  assert.equal(await last([...ring(at, 39, 300, 480).elements, ...roads(361)]), cutLine(500));
  // No circle holding 40 of the rows that came (400 roads, all centred off): still said, naming half the radius asked.
  assert.equal(await last(roads(400)), cutLine(500));
});

test("nearby says so when Wikipedia didn't answer and no pack reaches the point: its own ending", async () => {
  const { run } = await setup();
  const down = () => new Response('', { status: 503 });
  // OpenStreetMap's places only, said.
  const out = (await run('nearby', McWay, (url) => (url.includes('overpass') ? place('Lone Place') : down()))).split('\n');
  assert.match(out[1], /^Lone Place\t/);
  assert.equal(out.at(-1), "Wikipedia didn't answer; these are OpenStreetMap places only.");
  assert.equal(out.length, 3);
  // Wikipedia answering with no articles is not that: nothing is said.
  assert.doesNotMatch(await run('nearby', McWay, (url) => (url.includes('overpass') ? place('Lone Place') : noWiki)), /Wikipedia/);
  // Nothing from OpenStreetMap either way: as before.
  await assert.rejects(run('nearby', McWay, () => down()), /OpenStreetMap is busy and Wikipedia didn't answer/);
});

/**
 * A server that answers body after ms, or never (ms null), unless its request is stopped first; each step goes in log as "<step> <host>".
 * @param {string[]} log @param {string} url @param {any} init @param {number | null} ms @param {any} [body]
 */
function server(log, url, init, ms, body) {
  const host = new URL(url).hostname;
  log.push(`ask ${host}`);
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      log.push(`stopped ${host}`);
      reject(init.signal.reason);
    };
    const timer = ms === null ? undefined : setTimeout(() => {
      init.signal?.removeEventListener('abort', stop);
      log.push(`answer ${host}`);
      resolve(body);
    }, ms);
    init.signal?.addEventListener('abort', stop, { once: true });
  });
}
const place = (/** @type {string} */ name) => ({ elements: [{ type: 'node', lat: 36.1585, lon: -121.6722, tags: { name, tourism: 'viewpoint' } }] });
const wikiRow = geo(['McWay Falls', 36.1577, -121.6716]);

/** Turns Settings → Tools → "Also ask VK's server" on or off, as its tick saves it. @param {any} ws @param {boolean} on */
const vk = (ws, on) => updateAppSettings(ws, { places: { vkOverpass: on } });

test('nearby, with the VK switch on: maps.mail.ru\'s answer when overpass-api.de fails; Wikipedia alone, said busy, when both refuse', async () => {
  const { run, asked, ws } = await setup();
  await vk(ws, true);
  const wiki = geo(['McWay Falls', 36.1577, -121.6716]);
  const other = await run('nearby', McWay, (url) => (url.includes('overpass-api.de') ? new Response('', { status: 502 }) : url.includes('overpass') ? place('VK Server Place') : wiki));
  assert.ok(asked.some((a) => a.url === 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'));
  assert.match(other, /VK Server Place\tviewpoint/);
  const out = await run('nearby', McWay, (url) => (url.includes('overpass') ? new Response('', { status: 504 }) : wiki));
  assert.match(out, /OpenStreetMap is busy; these are Wikipedia articles only\.$/);
});

const Tokyo = { lat: 35.6812, lng: 139.7671 };
/** The name of the answer's first place, which nearby lists. */
const TOKYO_PLACE = String(TOKYO_ANSWER.elements.find((/** @type {any} */ e) => e.tags?.name)?.tags.name);
const tokyoWiki = geo(['Tokyo Station', 35.6812, 139.7671]);
/**
 * Overpass refusing, as a day of hourly probes from one server saw it (2026-11-13/14): the status, and the remark the probe kept from the body
 * (annai reads only the status). overpass-api.de: a 502 "Timeout" at 0.55 s; lz4.: a 504 "too busy" at 43 s; maps.mail.ru: a 504 at 1 s.
 */
const REFUSED = {
  timeout: () => new Response('Timeout', { status: 502 }),
  busy: () => new Response('timeout. The server is probably too busy to handle your request.', { status: 504 }),
  gateway: () => new Response('', { status: 504 }),
};
/** Fake time for the timers nearby's limits use, so a 40 s answer takes no 40 s. */
const FAKE_TIME = { apis: /** @type {any[]} */ (['setTimeout', 'AbortSignal.timeout']) };
/** Lets what has started run, a turn at a time, until f holds (setImmediate is real time under FAKE_TIME); a thousand turns at most. @param {() => boolean} f */
const until = async (f) => {
  for (let k = 0; !f(); k++) {
    if (k === 1000) throw new Error(`never came: ${f}`);
    await new Promise((r) => setImmediate(r));
  }
};
/** Lets what has started run for a few turns. */
const turns = async () => {
  for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
};

test('nearby: an Overpass answer at 40 s is used, past the 25 s the other services get', async () => {
  const { run, asked } = await setup();
  /** @type {string[]} */
  const log = [];
  mock.timers.enable(FAKE_TIME);
  try {
    let out = '';
    const done = run('nearby', Tokyo, (url, init) => (url.includes('overpass') ? server(log, url, init, 40_000, TOKYO_ANSWER) : tokyoWiki)).then((o) => { out = o; });
    await until(() => asked.length >= 2);
    mock.timers.tick(40_000);
    await done;
    assert.ok(out.split('\n').some((r) => r.startsWith(`${TOKYO_PLACE}\t`)), out);
    assert.match(out, /\nTokyo Station\twikipedia article\t0\t/);
    assert.doesNotMatch(out, /didn't answer|busy/);
    assert.deepEqual(log, ['ask overpass-api.de', 'answer overpass-api.de']);
  } finally {
    mock.timers.reset();
  }
});

test("nearby: overpass-api.de's answer at 51.3 s, the slowest of 24 hourly probes, is used: its backends are asked only after a refusal", async () => {
  const { run, asked } = await setup();
  /** @type {string[]} */
  const log = [];
  mock.timers.enable(FAKE_TIME);
  try {
    let out = '';
    const done = run('nearby', Tokyo, (url, init) => (url.includes('overpass') ? server(log, url, init, 51_300, TOKYO_ANSWER) : tokyoWiki)).then((o) => { out = o; });
    await until(() => asked.length >= 2);
    mock.timers.tick(51_300);
    await done;
    assert.ok(out.split('\n').some((r) => r.startsWith(`${TOKYO_PLACE}\t`)), out);
    assert.doesNotMatch(out, /didn't answer|busy/);
    assert.deepEqual(log, ['ask overpass-api.de', 'answer overpass-api.de']);
    assert.ok(!asked.some((a) => a.url.includes('z.overpass') || a.url.includes('lz4.')), 'z. and lz4. are not asked while it is still answering');
  } finally {
    mock.timers.reset();
  }
});

test('nearby: every Overpass server refusing is "busy" as soon as the last one refuses, without waiting out the limit', async () => {
  const { run, ws } = await setup();
  const started = Date.now();
  // overpass-api.de's 502 "Timeout", which came at 0.55 s.
  assert.match(await run('nearby', Tokyo, (url) => (url.includes('overpass') ? REFUSED.timeout() : tokyoWiki)), /\nOpenStreetMap is busy; these are Wikipedia articles only\.$/);
  await vk(ws, true);
  const both = await run('nearby', Tokyo, (url) => (url.includes('overpass-api.de') ? REFUSED.busy() : url.includes('overpass') ? REFUSED.gateway() : tokyoWiki));
  assert.match(both, /\nTokyo Station\t/);
  assert.match(both, /\nOpenStreetMap is busy; these are Wikipedia articles only\.$/);
  // Wikipedia down too: the call fails, saying which.
  await assert.rejects(run('nearby', Tokyo, (url) => (url.includes('overpass') ? REFUSED.busy() : new Response('', { status: 503 }))),
    { message: "OpenStreetMap is busy and Wikipedia didn't answer. Try again in a moment." });
  // Overpass's 429 (too many requests) is busy too; a 406, which overpass-api.de sent node's default agent, is no answer.
  await vk(ws, false);
  assert.match(await run('nearby', Tokyo, (url) => (url.includes('overpass') ? new Response('', { status: 429 }) : tokyoWiki)), /\nOpenStreetMap is busy; these are Wikipedia articles only\.$/);
  assert.match(await run('nearby', Tokyo, (url) => (url.includes('overpass') ? new Response('', { status: 406 }) : tokyoWiki)), /\nOpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
  assert.ok(Date.now() - started < ASK_MS.ms / 5, `no limit waited out: ${Date.now() - started} ms`);
});

test("nearby: an Overpass server that never answers is \"didn't answer\" at its limit, not before, though the other refused at once", async () => {
  const { run, asked, ws } = await setup();
  await vk(ws, true);
  /** @type {string[]} */
  const log = [];
  mock.timers.enable(FAKE_TIME);
  try {
    /** @type {string | null} */
    let out = null;
    const done = run('nearby', Tokyo, (url, init) => (url.includes('overpass-api.de') ? server(log, url, init, null) : url.includes('overpass') ? REFUSED.gateway() : tokyoWiki))
      .then((o) => { out = o; });
    await until(() => asked.length >= 3);
    mock.timers.tick(OVERPASS_MS - 1);
    await turns();
    assert.equal(out, null, 'still waiting for overpass-api.de a moment before its limit');
    mock.timers.tick(1);
    await done;
    assert.match(String(out), /\nTokyo Station\t/);
    assert.match(String(out), /\nOpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
    assert.deepEqual(log, ['ask overpass-api.de', 'stopped overpass-api.de']);
  } finally {
    mock.timers.reset();
  }
});

test('nearby: the VK switch off asks overpass-api.de only (while it answers); on, maps.mail.ru too, at once, with the same query', async () => {
  const { run, asked, ws } = await setup();
  const answer = (/** @type {string} */ url) => (url.includes('overpass') ? TOKYO_ANSWER : tokyoWiki);
  const overpass = () => asked.filter((a) => a.url.includes('overpass'));
  await run('nearby', Tokyo, answer);
  assert.deepEqual(overpass().map((a) => a.url), ['https://overpass-api.de/api/interpreter']);
  asked.length = 0;
  await vk(ws, true);
  const out = await run('nearby', Tokyo, answer);
  assert.deepEqual(overpass().map((a) => a.url), ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']);
  assert.equal(overpass()[1].init.body, overpass()[0].init.body);
  assert.ok(asked.indexOf(overpass()[1]) < asked.findIndex((a) => a.url.includes('wikipedia')), 'asked before Wikipedia: at once');
  assert.ok(out.split('\n').some((r) => r.startsWith(`${TOKYO_PLACE}\t`)));
  asked.length = 0;
  await vk(ws, false);
  await run('nearby', Tokyo, answer);
  assert.deepEqual(overpass().map((a) => a.url), ['https://overpass-api.de/api/interpreter']);
});

/** overpass-api.de's three names, as the Overpass servers nearby asks. */
const FAMILY = ['overpass-api.de', 'z.overpass-api.de', 'lz4.overpass-api.de'];
/**
 * Overpass servers that each refuse (with REFUSED's status) after ms, or answer with body, as `by` says; each step goes in log as "<step> <host>".
 * @param {string[]} log @param {Record<string, any>} by host: the Response a refusal is, or the answer
 * @param {number} [ms]
 */
const inTurn = (log, by, ms = 5) => (/** @type {string} */ url) => {
  const host = new URL(url).hostname;
  if (!url.includes('overpass') && !url.includes('mail.ru')) return tokyoWiki;
  log.push(`ask ${host}`);
  return new Promise((resolve) => setTimeout(() => {
    log.push(`${by[host] instanceof Response || typeof by[host] === 'function' ? 'refused' : 'answer'} ${host}`);
    resolve(typeof by[host] === 'function' ? by[host]() : by[host]);
  }, ms));
};

test("nearby asks overpass-api.de, then z., then lz4., each only after the one before refuses: an answer costs one request, and the others aren't asked", async () => {
  const { run, asked } = await setup();
  /** @type {string[]} */
  const log = [];
  // The refusals of the probe's day: overpass-api.de's and z.'s 502 "Timeout"; lz4. answers.
  const out = await run('nearby', Tokyo, inTurn(log, { 'overpass-api.de': REFUSED.timeout, 'z.overpass-api.de': REFUSED.timeout, 'lz4.overpass-api.de': TOKYO_ANSWER }));
  assert.deepEqual(log, ['ask overpass-api.de', 'refused overpass-api.de', 'ask z.overpass-api.de', 'refused z.overpass-api.de', 'ask lz4.overpass-api.de', 'answer lz4.overpass-api.de']);
  assert.ok(out.split('\n').some((r) => r.startsWith(`${TOKYO_PLACE}\t`)));
  assert.doesNotMatch(out, /busy|didn't answer/);
  const bodies = asked.filter((a) => a.url.includes('overpass')).map((a) => a.init.body);
  assert.equal(new Set(bodies).size, 1, 'the same query each time');
  // The first answering: the others are never asked.
  log.length = 0;
  await run('nearby', Tokyo, inTurn(log, { 'overpass-api.de': TOKYO_ANSWER }));
  assert.deepEqual(log, ['ask overpass-api.de', 'answer overpass-api.de']);
});

test('nearby: all three of overpass-api.de\'s servers refusing, one after another, is "busy" when the last refuses, not before', async () => {
  const { run } = await setup();
  /** @type {string[]} */
  const log = [];
  const out = await run('nearby', Tokyo, inTurn(log, { 'overpass-api.de': REFUSED.timeout, 'z.overpass-api.de': REFUSED.busy, 'lz4.overpass-api.de': REFUSED.timeout }));
  assert.deepEqual(log, FAMILY.flatMap((h) => [`ask ${h}`, `refused ${h}`]));
  assert.match(out, /\nOpenStreetMap is busy; these are Wikipedia articles only\.$/);
  // One of them saying something else (a 406, no refusal for load) makes it "didn't answer".
  const mixed = await run('nearby', Tokyo, inTurn([], { 'overpass-api.de': REFUSED.timeout, 'z.overpass-api.de': () => new Response('', { status: 406 }), 'lz4.overpass-api.de': REFUSED.timeout }));
  assert.match(mixed, /\nOpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
});

test("nearby: one limit for the whole turn of servers: overpass-api.de refusing at once, z. never answering, lz4. is never asked, and \"didn't answer\" comes at OVERPASS_MS", async () => {
  const { run, asked } = await setup();
  /** @type {string[]} */
  const log = [];
  mock.timers.enable(FAKE_TIME);
  try {
    /** @type {string | null} */
    let out = null;
    const done = run('nearby', Tokyo, (url, init) => (new URL(url).hostname === 'overpass-api.de' ? REFUSED.timeout() : url.includes('overpass') ? server(log, url, init, null) : tokyoWiki))
      .then((o) => { out = o; });
    await until(() => asked.some((a) => a.url.includes('z.overpass-api.de')));
    mock.timers.tick(OVERPASS_MS - 1);
    await turns();
    assert.equal(out, null, 'still waiting for z. a moment before the limit');
    mock.timers.tick(1);
    await done;
    assert.match(String(out), /\nOpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
    assert.deepEqual(log, ['ask z.overpass-api.de', 'stopped z.overpass-api.de']);
    assert.ok(!asked.some((a) => a.url.includes('lz4.')), 'lz4. is not asked once the limit has run out');
  } finally {
    mock.timers.reset();
  }
});

test('nearby asks both Overpass servers (the VK switch on) and Wikipedia at once: with neither server answering it waits one limit, not one per server, and gives Wikipedia\'s rows as before', async () => {
  const { run, asked, ws } = await setup();
  await vk(ws, true);
  /** @type {string[]} */
  const log = [];
  mock.timers.enable(FAKE_TIME);
  try {
    /** @type {string | null} */
    let out = null;
    run('nearby', McWay, (url, init) => (url.includes('overpass') ? server(log, url, init, null) : wikiRow)).then((o) => { out = o; });
    await until(() => asked.length >= 3);
    assert.deepEqual(asked.map((a) => new URL(a.url).hostname), ['overpass-api.de', 'maps.mail.ru', 'en.wikipedia.org']);
    // Two limits one after the other (the old way) would leave the second server still waited for here.
    mock.timers.tick(OVERPASS_MS);
    await turns();
    assert.notEqual(out, null, 'one limit, not one per server');
    assert.match(String(out), /McWay Falls/);
    assert.match(String(out), /\nOpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
  } finally {
    mock.timers.reset();
  }
});

test('nearby, with the VK switch on: when both Overpass servers would answer, the first to answer is taken and the other request is stopped', async () => {
  const { run, ws } = await setup();
  await vk(ws, true);
  /** @type {string[]} */
  const log = [];
  const out = await run('nearby', McWay, (url, init) => {
    if (url.includes('overpass-api.de')) return server(log, url, init, 40, place('Slow Server Place'));
    if (url.includes('overpass')) return server(log, url, init, 5, place('Fast Server Place'));
    return geo();
  });
  assert.match(out, /Fast Server Place/);
  assert.doesNotMatch(out, /Slow Server Place|didn't answer/);
  assert.deepEqual(log, ['ask overpass-api.de', 'ask maps.mail.ru', 'answer maps.mail.ru', 'stopped overpass-api.de']);
});

test('nearby: a first Overpass answer that is no answer ("runtime error") is passed over for the next server\'s, asked once it came', async () => {
  const { run } = await setup();
  /** @type {string[]} */
  const log = [];
  const timedOut = { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 21 seconds.' };
  const out = await run('nearby', McWay, (url, init) => {
    if (new URL(url).hostname === 'overpass-api.de') return server(log, url, init, 5, timedOut);
    if (url.includes('overpass')) return server(log, url, init, 5, place('Second Server Place'));
    return geo();
  });
  assert.match(out, /Second Server Place\tviewpoint/);
  assert.doesNotMatch(out, /didn't answer/);
  assert.deepEqual(log, ['ask overpass-api.de', 'answer overpass-api.de', 'ask z.overpass-api.de', 'answer z.overpass-api.de']);
});

test("nearby, with the VK switch on: the Trace has a net.request line for each request with its own time, the stopped one's too", async () => {
  const { run, ws } = await setup();
  await vk(ws, true);
  /** @type {string[]} */
  const log = [];
  const get = (/** @type {string} */ url, /** @type {any} */ init) => {
    const answer = (/** @type {number | null} */ ms, /** @type {any} */ body) => server(log, url, init, ms, body).then((b) => new Response(JSON.stringify(b)));
    if (url.includes('overpass-api.de')) return answer(20, place('First Place'));
    if (url.includes('overpass')) return answer(null);
    return answer(200, wikiRow);
  };
  const traced = tracedFetch(ws.store, ME, { tool: 'nearby', wake: 'w' }, get);
  const out = await run('nearby', McWay, (url, init) => traced(url, init));
  assert.match(out, /First Place/);
  const lines = await ws.store.tx(['events'], 'readonly', (t) => t.listEvents(ME, { types: ['net.request'] }));
  const by = Object.fromEntries(lines.map((/** @type {any} */ e) => [new URL(e.data.url).hostname, e.data]));
  assert.equal(lines.length, 3);
  assert.equal(by['overpass-api.de'].status, 200);
  assert.ok(by['overpass-api.de'].ms >= 15, `its own time: ${by['overpass-api.de'].ms} ms`);
  assert.equal(by['maps.mail.ru'].status, 0, 'stopped: no answer');
  assert.equal(by['maps.mail.ru'].error, 'Stopped: the other Overpass server answered first.');
  assert.ok(by['maps.mail.ru'].ms < by['en.wikipedia.org'].ms, 'stopped as the first answered, not at the end');
  assert.equal(by['en.wikipedia.org'].status, 200);
  assert.ok(by['en.wikipedia.org'].ms >= 190, `its own time: ${by['en.wikipedia.org'].ms} ms`);
});

test("nearby, with the VK switch on: the user's stop stops all three requests at once, and the call ends as stopped, not as a service that didn't answer", async () => {
  const { run, ws } = await setup();
  await vk(ws, true);
  /** @type {string[]} */
  const log = [];
  const stop = new AbortController();
  setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 20);
  const tools = (/** @type {string} */ url, /** @type {any} */ init) => server(log, url, init, null);
  await assert.rejects(run('nearby', McWay, tools, { signal: stop.signal }), { name: 'AbortError' });
  assert.deepEqual(log.filter((x) => x.startsWith('stopped')).sort(), ['stopped en.wikipedia.org', 'stopped maps.mail.ru', 'stopped overpass-api.de']);
  assert.deepEqual(log.filter((x) => x.startsWith('ask')).sort(), ['ask en.wikipedia.org', 'ask maps.mail.ru', 'ask overpass-api.de'], "stopped, so overpass-api.de's z. and lz4. are never asked after");
});

test('geocode and reverse through Nominatim, one request a second at most', async () => {
  const { run, asked } = await setup();
  NOMINATIM_GAP.ms = 60;
  const found = await run('geocode', { query: 'Nepenthe, Big Sur' }, () => [{ display_name: 'Nepenthe, Highway 1, Big Sur, CA', lat: '36.2203', lon: '-121.7612', category: 'amenity', type: 'restaurant' }]);
  assert.equal(found, 'name\tlat\tlng\ttype\twebsite\topening_hours\nNepenthe, Highway 1, Big Sur, CA\t36.2203\t-121.7612\tamenity/restaurant\t\t');
  const where = await run('reverse', McWay, () => ({ name: 'McWay Falls', display_name: 'McWay Falls, Big Sur, CA', category: 'natural', type: 'waterfall' }));
  assert.deepEqual(JSON.parse(where), { name: 'McWay Falls', address: 'McWay Falls, Big Sur, CA', type: 'natural/waterfall' });
  assert.ok(asked[1].at - asked[0].at >= 55);
  assert.match(asked[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=Nepenthe%2C%20Big%20Sur&format=jsonv2&limit=5&extratags=1&accept-language=en$/);
  assert.match(asked[1].url, /\/reverse\?.*&extratags=1&accept-language=en$/);
});

test("geocode and reverse name places in the traveller's languages: accept-language from the reading order, not the browser's own header", async () => {
  const { run, asked, ws } = await setup();
  NOMINATIM_GAP.ms = 1;
  await speaks(ws, ['ja', 'zh-Hant']);
  await run('geocode', { query: '清水寺' }, () => []);
  await run('reverse', KIYOMIZU, () => ({ error: 'Unable to geocode' }));
  assert.deepEqual(asked.map((a) => new URL(a.url).searchParams.get('accept-language')), ['ja,zh-Hant,zh,en', 'ja,zh-Hant,zh,en']);
  // The parameter, which Nominatim reads before the browser's own Accept-Language header: no such header is set here.
  for (const a of asked) assert.deepEqual(Object.keys(a.init.headers ?? {}).filter((k) => /^accept-language$/i.test(k)), []);
  // The phone's language with nothing chosen: a Japanese phone's.
  await updateAppSettings(ws, { languages: null });
  Object.defineProperty(globalThis.navigator, 'language', { value: 'ja-JP', configurable: true });
  try {
    await run('geocode', { query: '清水寺' }, () => []);
  } finally {
    Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true }); // as pin-phone.js sets it
  }
  assert.equal(new URL(asked.at(-1)?.url ?? '').searchParams.get('accept-language'), 'ja,en');
});

/** Wikipedia's real answers near Kiyomizu-dera, within 1 km, 30 at most, by host (2026-11-19; text under CC BY-SA 4.0). */
const KIYOMIZU_WIKI = Object.fromEntries(await Promise.all(['ja', 'en', 'zh'].map(async (e) => [`${e}.wikipedia.org`, JSON.parse(await readFile(new URL(`../fixtures/places/wiki-kiyomizu-${e}.json`, import.meta.url), 'utf8'))])));
/** Nothing from OpenStreetMap, and each Wikipedia edition's saved answer. @param {string} url */
const kiyomizuOnly = (url) => (url.includes('overpass') ? { elements: [] } : KIYOMIZU_WIKI[new URL(url).hostname] ?? new Response('', { status: 404 }));

test("nearby reads Wikipedia in each of the traveller's languages and English: each article once, by its Wikidata id, under the first edition that has it", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja']);
  const rows = (await run('nearby', KIYOMIZU, kiyomizuOnly)).split('\n').slice(1).map((r) => r.split('\t'));
  const named = (/** @type {string} */ name) => rows.find((r) => r[0] === name);
  // 30 Japanese and 14 English articles, 6 of them the same: 38, of which the nearest 30, as many as English alone was asked for.
  assert.equal(rows.length, 30);
  assert.deepEqual(named('清水寺'), ['清水寺', 'wikipedia article', '8', '34.9948', '135.785', 'wikipedia', 'https://ja.wikipedia.org/wiki/清水寺']);
  assert.equal(named('Kiyomizu-dera'), undefined, 'the same article, under Japanese');
  assert.equal(named('Ryozen Museum of History')?.[6], 'https://en.wikipedia.org/wiki/Ryozen_Museum_of_History', "English's own articles stay, under English");
  assert.equal(named('Higashiyama-ku'), undefined, 'the 35th nearest');
  // Each edition asked once, as annai names itself to Wikimedia, for its 30 nearest with their coordinates and Wikidata ids.
  const wiki = asked.filter((a) => a.url.includes('wikipedia.org'));
  assert.deepEqual(wiki.map((a) => new URL(a.url).hostname), ['ja.wikipedia.org', 'en.wikipedia.org']);
  for (const a of wiki) {
    assert.match(a.url, /&generator=geosearch&ggscoord=34\.9949%7C135\.785&ggsradius=1000&ggslimit=30&prop=coordinates%7Cpageprops&ppprop=wikibase_item&colimit=30$/);
    assert.match(a.init.headers['Api-User-Agent'], /^annai\/\d+\.\d+\.\d+ \(https:\/\/annai\.guide\)$/);
  }
  // Chinese (Traditional) and English: Chinese Wikipedia, whose 1 km has no 清水寺, so English's Kiyomizu-dera stands beside its own.
  await speaks(ws, ['zh-Hant']);
  asked.length = 0;
  const zh = (await run('nearby', KIYOMIZU, kiyomizuOnly)).split('\n').map((r) => r.split('\t')[0]);
  assert.deepEqual(asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname), ['zh.wikipedia.org', 'en.wikipedia.org']);
  assert.ok(zh.includes('圓山公園 (京都府)') && !zh.includes('Maruyama Park (Kyoto)'));
  assert.ok(zh.includes('Kiyomizu-dera'));
});

test("nearby with four editions asks Wikimedia three at once, as it asks: the fourth when one has answered (Wikimedia's published rule)", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja', 'zh', 'de']);
  /** @type {(() => void)[]} */
  const answer = [];
  let most = 0;
  const done = run('nearby', KIYOMIZU, (url, init) => {
    if (url.includes('overpass')) return { elements: [] };
    return new Promise((resolve, reject) => {
      answer.push(() => resolve(geo()));
      most = Math.max(most, answer.length);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  for (let wait = 0; answer.length < 3 && wait < 500; wait++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 20));
  const wiki = () => asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname);
  assert.deepEqual(wiki(), ['ja.wikipedia.org', 'zh.wikipedia.org', 'de.wikipedia.org']);
  answer.shift()?.();
  for (let wait = 0; wiki().length < 4 && wait < 500; wait++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(wiki(), ['ja.wikipedia.org', 'zh.wikipedia.org', 'de.wikipedia.org', 'en.wikipedia.org']);
  while (answer.length) answer.shift()?.();
  await done;
  assert.equal(most, 3);
});

/**
 * A trip's offline pack at Kiyomizu-dera: Wikipedia's real answers as the pack holds them (a part's 20 nearest: two overlapping Japanese parts and one
 * English), and OpenStreetMap's 5 km around, with some places in it. @param {any} ws @param {string} trip @param {{ id: number, lat: number, lon: number, tags: any }[]} [places]
 */
async function kiyomizuPack(ws, trip, places = []) {
  const at = [KIYOMIZU.lat, KIYOMIZU.lng];
  const pagesOf = (/** @type {string} */ host, /** @type {number} */ from, /** @type {number} */ to) => KIYOMIZU_WIKI[host].query.pages.slice(from, to).map((/** @type {any} */ g) => [g.title, g.coordinates[0].lat, g.coordinates[0].lon, '', g.pageprops.wikibase_item]);
  const parts = /** @type {[string, string, string, any[]][]} */ ([['ja', 'w1', '/offline/wikipedia/w1.ja.json', pagesOf('ja.wikipedia.org', 0, 20)], ['ja', 'w2', '/offline/wikipedia/w2.ja.json', pagesOf('ja.wikipedia.org', 10, 30)], ['en', 'w1', '/offline/wikipedia/w1.json', pagesOf('en.wikipedia.org', 0, 20)]]);
  for (const [, , path, pages] of parts) await ws.write(trip, path, JSON.stringify({ at, radius: 10000, pages }), { author: 'system' });
  await ws.write(trip, '/offline/osm/o1.json', JSON.stringify({ area: { points: [at], radius: 5000 }, rows: places.map((e) => [`n${e.id}`, e.tags.name, 'restaurant', e.lat, e.lon, '', 'food']) }), { author: 'system' });
  await ws.write(trip, '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at: '2026-11-19T09:00:00.000Z', failed: [], full: false, stopped: false, bytes: 1, guides: [],
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 1, items: places.length }, ...parts.map(([edition, id, path]) => ({ id, kind: 'wikipedia', path, bytes: 1, items: 20, edition }))] }), { author: 'system' });
}

test("Wikipedia's rows are the nearest 30 at most, however many editions are listed (English alone was asked for 30), online and from the pack; the places keep the rest of the 40", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await speaks(ws, ['ja']);
  // The 38 articles of Japanese and English, nearest first (the farthest is Maruyama Park, 994 m): the 30 that stay.
  const all = merged([...articlesOf(KIYOMIZU_WIKI['ja.wikipedia.org'], 'ja'), ...articlesOf(KIYOMIZU_WIKI['en.wikipedia.org'], 'en')], ['ja', 'en'])
    .map((a) => ({ title: a.title, m: meters(KIYOMIZU, a) })).sort((x, y) => x.m - y.m);
  assert.equal(all.length, 38);
  const nearest = all.slice(0, 30).map((x) => x.title).sort();
  // Twenty places farther than every article (997 m, the articles' farthest 994): with no cap, the 38 articles would leave them 2 of the 40 rows.
  const far = { elements: Array.from({ length: 20 }, (_, k) => ({ type: 'node', id: k + 1, lat: KIYOMIZU.lat + 0.00897, lon: KIYOMIZU.lng + k / 1e5, tags: { name: `Far ${k}`, amenity: 'restaurant' } })) };
  assert.ok(far.elements.every((e) => meters(KIYOMIZU, { lat: e.lat, lng: e.lon }) > all[37].m && meters(KIYOMIZU, { lat: e.lat, lng: e.lon }) <= 1000));
  const titlesOf = (/** @type {string} */ out, /** @type {string} */ source) => out.split('\n').slice(1).map((r) => r.split('\t')).filter((r) => r[5] === source).map((r) => r[0]).sort();
  const online = await run('nearby', KIYOMIZU, (url) => (url.includes('overpass') ? far : kiyomizuOnly(url)));
  assert.deepEqual(titlesOf(online, 'wikipedia'), nearest, 'the 30 nearest of the 38');
  assert.equal(titlesOf(online, 'osm').length, 10);
  // The pack's articles the same: two overlapping Japanese parts of 20 (the pack's own size for a part) and English's, 38 in the circle.
  await kiyomizuPack(ws, /** @type {string} */ (trip), far.elements);
  const offline = await run('nearby', KIYOMIZU, () => { throw new Error('asked'); });
  assert.match(offline.split('\n').at(-1) ?? '', /^From the offline pack/);
  assert.deepEqual(titlesOf(offline, 'wikipedia'), nearest);
  assert.equal(titlesOf(offline, 'osm').length, 10);
  assert.ok(offline.includes('清水寺\t') && !offline.includes('Kiyomizu-dera\t'));
});

test("nearby: an edition that doesn't answer is left out and named, one that never answers holds up none of the others, an error answer is no answer, and none answering is today's line", async () => {
  const { run, ws } = await setup();
  await speaks(ws, ['ja']);
  const was = ASK_MS.ms;
  ASK_MS.ms = 80;
  // Node lets AbortSignal.timeout's timer go when nothing else keeps it running: this does, as a page does.
  const alive = setInterval(() => {}, 1000);
  try {
    /** @param {string} url @param {any} init */
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    const t0 = Date.now();
    // As a browser's fetch, a request made once the limit has run out fails at once.
    const hung = await run('nearby', KIYOMIZU, (url, init) => (init.signal?.aborted ? Promise.reject(init.signal.reason) : url.includes('ja.wikipedia.org') ? hang(url, init) : kiyomizuOnly(url)));
    assert.ok(Date.now() - t0 < 2000, 'it ends at the limit (80 ms here), not at the call limit');
    assert.match(hung, /\nKiyomizu-dera\twikipedia article\t/);
    assert.match(hung, /\nja\.wikipedia\.org didn't answer, so its articles are missing from this list\.$/);
    // Two editions that never answer share the one limit (asked at once): 500 ms here, where limits one after the other would take twice that.
    ASK_MS.ms = 500;
    await speaks(ws, ['ja', 'zh-Hant']);
    const t1 = Date.now();
    const two = await run('nearby', KIYOMIZU, (url, init) => (init.signal?.aborted ? Promise.reject(init.signal.reason) : url.includes('ja.wikipedia.org') || url.includes('zh.wikipedia.org') ? hang(url, init) : kiyomizuOnly(url)));
    assert.ok(Date.now() - t1 < 900, `${Date.now() - t1} ms for two that never answer`);
    assert.match(two, /\nja\.wikipedia\.org and zh\.wikipedia\.org didn't answer, so their articles are missing from this list\.$/);
    ASK_MS.ms = 80;
    await speaks(ws, ['ja']);
    const refused = await run('nearby', KIYOMIZU, (url) => (url.includes('ja.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
    assert.equal(refused.split('\n').length, 1 + 14 + 1);
    assert.match(refused, /\nja\.wikipedia\.org didn't answer, so its articles are missing from this list\.$/);
    // MediaWiki answers an error with 200 and {"error": …}: that edition did not answer either, not "no article near".
    const said = await run('nearby', KIYOMIZU, (url) => (url.includes('ja.wikipedia.org') ? { error: { code: 'maxlag', info: 'Waiting for a database server: 6 seconds lagged.' }, servedby: 'mw1' } : kiyomizuOnly(url)));
    assert.equal(said, refused);
    const none = await run('nearby', KIYOMIZU, (url) => (url.includes('wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
    assert.equal(none, "name\tkind\tdistance_m\tlat\tlng\tsource\tnote\nWikipedia didn't answer; these are OpenStreetMap places only.");
    const allSaid = await run('nearby', KIYOMIZU, (url) => (url.includes('wikipedia.org') ? { error: { code: 'maxlag', info: 'Waiting for a database server' } } : kiyomizuOnly(url)));
    assert.equal(allSaid, none);
  } finally {
    ASK_MS.ms = was;
    clearInterval(alive);
  }
});

test("nearby: an edition that doesn't answer has the offline pack's articles of it where the pack reaches, merged by Wikidata id, and says so", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await speaks(ws, ['ja']);
  await kiyomizuPack(ws, /** @type {string} */ (trip));
  // A circle wider than the pack's 5 km: the services are asked; Japanese Wikipedia is down.
  const out = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('ja.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  const rows = out.split('\n').slice(1, -1).map((r) => r.split('\t'));
  assert.equal(rows.length, 30);
  // 清水寺 from the pack, in place of English's Kiyomizu-dera (the same Wikidata item), linked on Japanese Wikipedia.
  assert.equal(rows.find((r) => r[0] === '清水寺')?.[6], 'https://ja.wikipedia.org/wiki/清水寺');
  assert.equal(rows.find((r) => r[0] === 'Kiyomizu-dera'), undefined);
  assert.equal(rows.find((r) => r[0] === 'Ryozen Museum of History')?.[6], 'https://en.wikipedia.org/wiki/Ryozen_Museum_of_History');
  assert.match(out, /\nja\.wikipedia\.org didn't answer, so its articles come from the offline pack \(downloaded 2026-11-19\), where it holds them\.$/);
  // English not answering: English's articles from the pack are the one Japanese has none of (the pack has English's own).
  const en = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('en.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  assert.match(en, /\nen\.wikipedia\.org didn't answer, so its articles come from the offline pack \(downloaded 2026-11-19\), where it holds them\.$/);
  assert.ok(en.includes('Ryozen Museum of History\t'));
  // Where the pack has none of that edition's articles, the note says they are missing.
  await speaks(ws, ['zh-Hant']);
  const zh = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('zh.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  assert.match(zh, /\nzh\.wikipedia\.org didn't answer, so its articles are missing from this list\.$/);
});

test('geocode, reverse and nearby give a place\'s website and opening hours where OpenStreetMap has them, so "is it open" needs no search', async () => {
  const { run } = await setup();
  NOMINATIM_GAP.ms = 1;
  // Nominatim's extratags, as recorded: the website under website (or contact:website), hours under opening_hours.
  const found = await run('geocode', { query: 'Big Sur Roadhouse' }, () => [
    { display_name: 'Big Sur Roadhouse, Highway 1', lat: '36.2', lon: '-121.7', category: 'amenity', type: 'restaurant', extratags: { website: 'https://glenoaksbigsur.com/big-sur-roadhouse/', opening_hours: 'Mo-Su 08:00-14:30' } },
    { display_name: 'Nepenthe, Highway 1', lat: '36.22', lon: '-121.76', category: 'amenity', type: 'restaurant', extratags: { 'contact:website': 'http://www.nepenthebigsur.com' } }]);
  const rows = found.split('\n').slice(1).map((r) => r.split('\t'));
  assert.deepEqual(rows[0].slice(4), ['https://glenoaksbigsur.com/big-sur-roadhouse/', 'Mo-Su 08:00-14:30']);
  assert.deepEqual(rows[1].slice(4), ['http://www.nepenthebigsur.com', '']);
  const where = JSON.parse(await run('reverse', McWay, () => ({ name: 'Roadhouse', display_name: 'Roadhouse, Big Sur', category: 'amenity', type: 'restaurant', extratags: { website: 'https://r.test/', opening_hours: 'Mo-Su 08:00-14:30' } })));
  assert.deepEqual([where.website, where.opening_hours], ['https://r.test/', 'Mo-Su 08:00-14:30']);
  const out = await run('nearby', { ...McWay, kinds: ['food'] }, (url) => (url.includes('overpass')
    ? { elements: [{ type: 'node', lat: 36.1585, lon: -121.6722, tags: { name: 'Roadhouse', amenity: 'restaurant', website: 'https://r.test/', opening_hours: 'Mo-Su 08:00-14:30' } }, { type: 'node', lat: 36.159, lon: -121.673, tags: { name: 'Cafe', amenity: 'cafe', opening_hours: 'Tu-Su 09:00-15:00' } }] }
    : geo()));
  const notes = out.split('\n').slice(1).map((r) => r.split('\t')[6]);
  assert.deepEqual(notes, ['https://r.test/ · hours Mo-Su 08:00-14:30', 'hours Tu-Su 09:00-15:00']);
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
    // Open-Meteo's licence asks for its credit next to wherever its data shows: the Trace shows this answer.
    'Weather data by Open-Meteo.com (https://open-meteo.com/, CC BY 4.0)',
    'Time zone: America/Los_Angeles (PST)',
    '2026-11-26: 8 to 15 °C, rain chance up to 20%, sunrise 06:58, sunset 16:53',
    'time\ttemp_c\train_chance_pct\train_mm\tweather\twind_kmh',
    '2026-11-26T15:00\t14.2\t10\t0\tpartly cloudy\t12',
    '2026-11-26T16:00\t13.1\t20\t0\tovercast\t15',
  ].join('\n'));
  assert.match(await run('weather', { ...McWay, when: '2027-03-01' }, () => ({ timezone: 'America/Los_Angeles', hourly: { time: [] }, daily: { time: [] } })), /16 days/);
});

test('guide: the introduction and the sections, with the article\'s address (CC BY-SA asks for it); one section; or what there is instead', async () => {
  const { run } = await setup();
  const extract = 'Big Sur is a region.\n\n== Understand ==\nRugged coast.\n\n== Eat ==\nNepenthe.\n\n=== Budget ===\nDeli.\n\n== Sleep ==\nCamp.';
  const page = { query: { pages: { 1: { title: 'Big Sur', extract } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (English Wikivoyage) https://en.wikivoyage.org/wiki/Big_Sur\n\nBig Sur is a region.\n\nSections: Understand, Eat, Budget, Sleep. Ask for one with section.');
  assert.equal(await run('guide', { place: 'Big Sur', section: 'eat' }, () => page), 'Big Sur: Eat (English Wikivoyage) https://en.wikivoyage.org/wiki/Big_Sur\n\nNepenthe.\n\n=== Budget ===\nDeli.');
  assert.equal(await run('guide', { place: 'Big Sur', section: 'Nightlife' }, () => page), 'Big Sur (English Wikivoyage) has no section "Nightlife". Its sections: Understand, Eat, Budget, Sleep.');
  const missing = await run('guide', { place: 'Bigg Sur' }, (url) => (url.includes('opensearch') ? ['Bigg Sur', ['Big Sur', 'Big Sur River']] : { query: { pages: { '-1': { title: 'Bigg Sur', missing: '' } } } }));
  assert.equal(missing, 'Wikivoyage has no article called "Bigg Sur". Close ones: Big Sur, Big Sur River.');
});

/**
 * Wikivoyage's editions as their real answers are shaped (2026-11-20; the texts cut short and made up): English's Kyoto with its links
 * (de, ja, zh), Japanese's 京都市 (Japanese has no "Kyoto", and its 京都 is a disambiguation page), Chinese's 京都, 東京 (asked as 东京, converted)
 * and 臺北 (台北 a redirect to it).
 */
const VOYAGE = /** @type {Record<string, Record<string, any>>} */ ({
  en: { Kyoto: { pageid: 18579, ns: 0, title: 'Kyoto', extract: 'Kyoto was the capital of Japan for over a millennium.\n\n== Understand ==\nTemples.\n\n== See ==\nKiyomizu-dera.', langlinks: [{ lang: 'de', title: 'Kyōto' }, { lang: 'ja', title: '京都市' }, { lang: 'zh', title: '京都' }] } },
  ja: {
    京都市: { ns: 0, title: '京都市', extract: '京都市は京都府の府庁所在地。\n\n== 分かる ==\n千年の都。\n\n== 観る ==\n清水寺。', langlinks: [{ lang: 'en', title: 'Kyoto' }, { lang: 'zh', title: '京都' }] },
    京都: { ns: 0, title: '京都', extract: '京都は次のどれか。', pageprops: { disambiguation: '' } },
  },
  zh: {
    京都: { ns: 0, title: '京都', extract: '京都是日本的古都。\n\n== 了解 ==\n千年古都。', langlinks: [{ lang: 'en', title: 'Kyoto' }, { lang: 'ja', title: '京都市' }] },
    東京: { ns: 0, title: '東京', extract: '東京是日本的首都。' },
    臺北: { ns: 0, title: '臺北', extract: '臺北是臺灣的首都。', langlinks: [{ lang: 'en', title: 'Taipei' }] },
  },
});
/** A Wikivoyage edition's answer to the guide's query, by its host and title, converting and following redirects as MediaWiki does. @param {string} url */
function voyage(url) {
  const u = new URL(url);
  const edition = u.hostname.split('.')[0];
  if (u.searchParams.get('action') === 'opensearch') return [u.searchParams.get('search'), []];
  let title = String(u.searchParams.get('titles'));
  const query = /** @type {any} */ ({});
  if (edition === 'zh' && u.searchParams.get('converttitles') && title === '东京') query.converted = [{ from: (title), to: (title = '東京') }];
  if (edition === 'zh' && title === '台北') query.redirects = [{ from: title, to: (title = '臺北') }];
  return { batchcomplete: true, query: { ...query, pages: [VOYAGE[edition]?.[title] ?? { ns: 0, title, missing: true }] } };
}
const voyageHosts = (/** @type {{ url: string }[]} */ asked) => asked.filter((a) => a.url.includes('wikivoyage')).map((a) => `${new URL(a.url).hostname} ${new URL(a.url).searchParams.get('titles')}`);

test("guide: English's and each of the traveller's editions' guide in one answer, a part each in the reading order, every edition but the first asked by the title English links to", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja']);
  const out = await run('guide', { place: 'Kyoto' }, voyage);
  assert.equal(out, [
    '京都市 (Japanese Wikivoyage) https://ja.wikivoyage.org/wiki/京都市\n\n京都市は京都府の府庁所在地。\n\nSections: 分かる, 観る. Ask for one with section.',
    'Kyoto (English Wikivoyage) https://en.wikivoyage.org/wiki/Kyoto\n\nKyoto was the capital of Japan for over a millennium.\n\nSections: Understand, See. Ask for one with section.',
  ].join('\n\n'));
  assert.deepEqual(voyageHosts(asked), ['en.wikivoyage.org Kyoto', 'ja.wikivoyage.org 京都市']);
  // English's text and its links in one request (MediaWiki's paraminfo: lllimit up to 500, and Kyoto's 20 links came in one answer).
  const english = new URL(asked[0].url).searchParams;
  assert.deepEqual([english.get('prop'), english.get('lllimit'), english.get('redirects'), english.get('formatversion')], ['extracts|langlinks|pageprops', '500', '1', '2']);
  // A section is each edition's own: the same section in two editions is two calls.
  assert.equal(await run('guide', { place: 'Kyoto', section: 'see' }, voyage), '京都市 (Japanese Wikivoyage) has no section "see". Its sections: 分かる, 観る.\n\nKyoto: See (English Wikivoyage) https://en.wikivoyage.org/wiki/Kyoto\n\nKiyomizu-dera.');
  assert.equal(await run('guide', { place: 'Kyoto', section: '観る' }, voyage), '京都市: 観る (Japanese Wikivoyage) https://ja.wikivoyage.org/wiki/京都市\n\n清水寺。\n\nKyoto (English Wikivoyage) has no section "観る". Its sections: Understand, See.');
  assert.equal(await run('guide', { place: 'Kyoto', section: 'Nightlife' }, voyage),
    '京都市 (Japanese Wikivoyage) has no section "Nightlife". Its sections: 分かる, 観る.\n\nKyoto (English Wikivoyage) has no section "Nightlife". Its sections: Understand, See.');
});

test("guide: with no English page by the name, the next edition by it (its variants converted) anchors the rest; 京都, a disambiguation page in Japanese, passes on to Chinese", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja', 'zh-Hant']);
  const out = await run('guide', { place: '京都' }, voyage);
  assert.deepEqual(out.split('\n\n').filter((l) => /wikivoyage\.org\/wiki/.test(l)), [
    '京都市 (Japanese Wikivoyage) https://ja.wikivoyage.org/wiki/京都市',
    '京都 (Chinese Wikivoyage) https://zh.wikivoyage.org/wiki/京都',
    'Kyoto (English Wikivoyage) https://en.wikivoyage.org/wiki/Kyoto',
  ]);
  assert.deepEqual(voyageHosts(asked).slice(0, 3), ['en.wikivoyage.org 京都', 'ja.wikivoyage.org 京都', 'zh.wikivoyage.org 京都']);
  assert.deepEqual(voyageHosts(asked).slice(3).sort(), ['en.wikivoyage.org Kyoto', 'ja.wikivoyage.org 京都市']);
  assert.ok(asked.slice(1, 3).every((a) => new URL(a.url).searchParams.get('converttitles') === '1'));
  // English's missing, Japanese's anchoring by its own name.
  asked.length = 0;
  assert.match(await run('guide', { place: '京都市' }, voyage), /^京都市 \(Japanese Wikivoyage\)[\s\S]*\n\n京都 \(Chinese Wikivoyage\)[\s\S]*\n\nKyoto \(English Wikivoyage\)/);
  assert.deepEqual(voyageHosts(asked).slice(0, 2), ['en.wikivoyage.org 京都市', 'ja.wikivoyage.org 京都市']);
  assert.deepEqual(voyageHosts(asked).slice(2).sort(), ['en.wikivoyage.org Kyoto', 'zh.wikivoyage.org 京都']);
  // Chinese's names: a variant converted (东京 to 東京) and a redirect (台北 to 臺北), each anchoring.
  await speaks(ws, ['zh']);
  assert.match(await run('guide', { place: '东京' }, voyage), /^東京 \(Chinese Wikivoyage\) https:\/\/zh\.wikivoyage\.org\/wiki\/東京\n\n東京是日本的首都。$/);
  assert.match(await run('guide', { place: '台北' }, voyage), /^臺北 \(Chinese Wikivoyage\)/);
});

test("guide: nothing in any edition is today's line with English's close names; an edition that fails is named, and the others come; English failing with no other page is the failure", async () => {
  const { run, ws } = await setup();
  await speaks(ws, ['ja']);
  const none = await run('guide', { place: 'Atlantis' }, (url) => (url.includes('opensearch') ? ['Atlantis', ['Atlanta', 'Atlantic City']] : voyage(url)));
  assert.equal(none, 'Wikivoyage has no article called "Atlantis". Close ones: Atlanta, Atlantic City.');
  const jaDown = await run('guide', { place: 'Kyoto' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : voyage(url)));
  assert.match(jaDown, /^Kyoto \(English Wikivoyage\) [\s\S]*\nja\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
  assert.doesNotMatch(jaDown, /Japanese Wikivoyage/);
  const enDown = await run('guide', { place: '京都市' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url)));
  assert.match(enDown, /^京都市 \(Japanese Wikivoyage\) [\s\S]*\nen\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
  await assert.rejects(run('guide', { place: 'Kyoto' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /en\.wikivoyage\.org answered 503/);
  // Both down, with nothing found: named, after the no-article line.
  const both = await run('guide', { place: 'Atlantis' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : url.includes('opensearch') ? ['Atlantis', []] : voyage(url)));
  assert.equal(both, 'Wikivoyage has no article called "Atlantis".\nja.wikivoyage.org didn\'t answer, so this has no part from it.');
});

test("guide asks only the 24 Wikivoyage hosts: a language without an edition (Korean, Cantonese) is never asked, English always is", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ko', 'yue', 'zh-Hant']);
  await run('guide', { place: 'Kyoto' }, voyage);
  assert.deepEqual([...new Set(asked.map((a) => new URL(a.url).hostname))].sort(), ['en.wikivoyage.org', 'zh.wikivoyage.org']);
  asked.length = 0;
  await run('guide', { place: 'Atlantis' }, voyage);
  assert.deepEqual([...new Set(asked.map((a) => new URL(a.url).hostname))].sort(), ['en.wikivoyage.org', 'zh.wikivoyage.org']);
});

test('nearby: toilets and parking count without a name; sights and food are asked for with one, matched whole', async () => {
  const { run, asked } = await setup();
  const out = await run('nearby', { ...McWay, kinds: ['toilets', 'food'] }, (url) => {
    if (url.includes('overpass')) return { elements: [{ type: 'node', lat: 36.1581, lon: -121.6721, tags: { amenity: 'toilets' } }] };
    return geo();
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
  const wiki = geo(['Partington Cove', 36.175, -121.69]);
  const online = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? { elements: [] } : wiki));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
  assert.doesNotMatch(online, /offline pack/);
  const down = await run('nearby', { ...McWay, radius: 8000 }, () => { throw new Error("annai couldn't reach overpass-api.de. Is the device offline?"); });
  assert.match(down, /\nOpenStreetMap and Wikipedia didn't answer, so these come from the offline pack \(downloaded 2026-10-16\)\.$/);
  assert.match(down, /McWay Falls Overlook/);
  const half = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? new Response('', { status: 504 }) : wiki));
  assert.match(half, /Partington Cove/);
  assert.match(half, /\nOpenStreetMap is busy, so its places come from the offline pack \(downloaded 2026-10-16\)\.$/);
  const busyBoth = await run('nearby', { ...McWay, radius: 8000 }, () => new Response('', { status: 504 }));
  assert.match(busyBoth, /\nOpenStreetMap is busy and Wikipedia didn't answer, so these come from the offline pack \(downloaded 2026-10-16\)\.$/);
  // Outside the pack, with both services down, it says so as before.
  await assert.rejects(run('nearby', { lat: 36.6, lng: -121.9 }, () => { throw new Error('offline'); }), /Neither OpenStreetMap nor Wikipedia answered/);
});

test('guide reads the pack first: by its title, without "(California)", or by a name that led to it; a section too', async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  assert.equal(await run('guide', { place: 'Cambria' }, nothing), 'Cambria (California) (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nCambria is a town.\n\nSections: See. Ask for one with section.');
  assert.equal(await run('guide', { place: 'cambria, california', section: 'see' }, nothing), 'Cambria (California): See (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nMoonstone Beach.');
  assert.match(await run('guide', { place: 'Hearst Castle' }, nothing), /^San Simeon \(English Wikivoyage, offline pack of 2026-10-16\)/);
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (English Wikivoyage) https://en.wikivoyage.org/wiki/Big_Sur\n\nBig Sur is a region.');
});

test("guide reads the pack first in each of the traveller's editions it holds, by any edition's title, in the reading order; an edition it doesn't hold isn't asked online", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  const id = /** @type {string} */ (trip);
  await mcwayPack(ws, id);
  await ws.write(id, guideFile('Cambria (California)', 'ja').path, JSON.stringify({ title: 'カンブリア', text: 'カンブリアは海辺の町。\n\n== 観る ==\nムーンストーン・ビーチ。' }), { author: 'system' });
  const m = JSON.parse(String(await ws.readText(id, '/offline/pack.json')));
  m.guides[0].also = [{ edition: 'ja', title: 'カンブリア' }];
  m.voyage = ['en', 'ja', 'zh']; // its guides pass asked Chinese too, and found no guide there
  await ws.write(id, '/offline/pack.json', JSON.stringify(m), { author: 'system' });
  await speaks(ws, ['ja']);
  assert.equal(await run('guide', { place: 'カンブリア' }, nothing), [
    'カンブリア (Japanese Wikivoyage, offline pack of 2026-10-16) https://ja.wikivoyage.org/wiki/カンブリア\n\nカンブリアは海辺の町。\n\nSections: 観る. Ask for one with section.',
    'Cambria (California) (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nCambria is a town.\n\nSections: See. Ask for one with section.',
  ].join('\n\n'));
  // Chinese listed too, which the pack doesn't hold: what it holds, with no request (it comes with the pack's next download).
  await speaks(ws, ['zh', 'ja']);
  assert.match(await run('guide', { place: 'Cambria', section: '観る' }, nothing), /^カンブリア: 観る \(Japanese Wikivoyage, offline pack of 2026-10-16\)/);
});

test('a broken pack is no pack: the tools go online', async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await ws.write(/** @type {string} */ (trip), '/offline/pack.json', '{"format":1,', { author: 'system', type: 'text/plain' });
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (English Wikivoyage) https://en.wikivoyage.org/wiki/Big_Sur\n\nBig Sur is a region.');
  await run('nearby', McWay, (url) => (url.includes('overpass') ? { elements: [] } : geo()));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
});

test('nearby asks online where the pack holds only the first of more places than Overpass gave, and uses that part offline (C1)', async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const part = JSON.parse(String(await ws.readText(/** @type {string} */ (trip), '/offline/osm/o1.json')));
  await ws.write(/** @type {string} */ (trip), '/offline/osm/o1.json', JSON.stringify({ ...part, cut: true }), { author: 'system' });
  await ws.patch(/** @type {string} */ (trip), '/offline/pack.json', { bytes: 1001 }, { author: 'system' });
  const online = await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, (url) => (url.includes('overpass') ? { elements: [] } : geo()));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
  assert.doesNotMatch(online, /offline pack/);
  const offline = await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, () => { throw new Error('offline'); });
  assert.match(offline, /McWay Falls Overlook/);
  assert.match(offline, /from the offline pack/);
});

test("a JSON null, or an answer of the wrong shape, is the plain \"couldn't read\" answer, never a TypeError (C2)", async () => {
  const { run } = await setup();
  NOMINATIM_GAP.ms = 1;
  const plain = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.constructor === Error && re.test(e.message);
  await assert.rejects(run('geocode', { query: 'Big Sur' }, () => null), plain(/^Nominatim sent an answer annai can't read\.$/));
  await assert.rejects(run('geocode', { query: 'Big Sur' }, () => ({ results: [] })), plain(/^Nominatim sent an answer annai can't read\.$/));
  await assert.rejects(run('reverse', McWay, () => null), plain(/^Nominatim sent an answer annai can't read\.$/));
  assert.match(await run('weather', { ...McWay, when: '2026-11-27' }, () => null), /^Open-Meteo didn't answer \(api\.open-meteo\.com sent an answer annai can't read\), so there is no forecast\./);
  const odd = await run('weather', { ...McWay, when: '2026-11-27' }, () => ({ timezone: 'America/Los_Angeles', hourly: { time: ['2026-11-27T10:00', 5] }, daily: { time: ['2026-11-27'] } }));
  assert.equal(typeof odd, 'string');
});

test('a pack whose manifest has no download time says the day of its newest part, or no day at all, never "(downloaded )"', async () => {
  const { run, ws, trip } = await setup({ trip: true });
  const id = /** @type {string} */ (trip);
  await mcwayPack(ws, id);
  const m = JSON.parse(String(await ws.readText(id, '/offline/pack.json')));
  await ws.write(id, '/offline/pack.json', JSON.stringify({ ...m, at: '', files: m.files.map((/** @type {any} */ f, /** @type {number} */ i) => ({ ...f, at: Date.parse('2026-10-15T12:00:00Z') + i * 86_400_000 })) }), { author: 'system' });
  assert.match(await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing), /\nFrom the offline pack \(downloaded 2026-10-18\)\.$/);
  await ws.write(id, '/offline/pack.json', JSON.stringify({ ...m, at: '' }), { author: 'system' });
  assert.match(await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing), /\nFrom the offline pack\.$/);
  assert.match(await run('guide', { place: 'Cambria' }, nothing), /^Cambria \(California\) \(English Wikivoyage, offline pack\) https:\/\/en\.wikivoyage\.org\/wiki\/Cambria_%28California%29\n/);
});

test("nearby online takes an Overpass answer that says \"runtime error\" as no answer: the next server (the VK switch on), then the pack, as for any failure", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await vk(ws, true);
  await mcwayPack(ws, /** @type {string} */ (trip));
  const timedOut = { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 21 seconds.' };
  const wiki = geo();
  let first = true;
  const second = await run('nearby', { ...McWay, radius: 8000, kinds: ['sights'] }, (url) => {
    if (!url.includes('overpass')) return wiki;
    if (first) {
      first = false;
      return timedOut;
    }
    return { elements: [{ type: 'node', lat: 36.1585, lon: -121.6722, tags: { name: 'McWay Falls Overlook', tourism: 'viewpoint' } }] };
  });
  assert.match(second, /McWay Falls Overlook\tviewpoint/);
  const both = await run('nearby', { ...McWay, radius: 8000, kinds: ['sights'] }, (url) => (url.includes('overpass') ? timedOut : wiki));
  assert.match(both, /\nOpenStreetMap didn't answer, so its places come from the offline pack \(downloaded 2026-10-16\)\.$/);
});

test("Koe's places tools (call.offline) read the offline pack only: never a request; past its edge or off it, they say so (K1)", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const offline = { offline: true };
  assert.match(await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing, offline), /McWay Falls Overlook[\s\S]*\nFrom the offline pack \(downloaded 2026-10-16\)\.$/);
  const edge = await run('nearby', { ...McWay, radius: 8000 }, nothing, offline);
  assert.match(edge, /McWay Falls Overlook/);
  assert.match(edge, /\nFrom the offline pack \(downloaded 2026-10-16\), which holds only part of this circle\. Kokoro can look further\.$/);
  assert.equal(await run('nearby', { lat: 36.6, lng: -121.9 }, nothing, offline), 'Not in the offline pack: ask Kokoro.');
  assert.match(await run('guide', { place: 'Cambria' }, nothing, offline), /offline pack of 2026-10-16/);
  assert.equal(await run('guide', { place: 'Big Sur' }, nothing, offline), 'Not in the offline pack: ask Kokoro.');
  assert.equal(asked.length, 0);
});

/** English Wikivoyage's real answers for a disambiguation name (2026-11-20): Georgia redirects to "Georgia (disambiguation)", flagged by its page props. */
const GEORGIA = { batchcomplete: true, query: { redirects: [{ from: 'Georgia', to: 'Georgia (disambiguation)' }], pages: [{ pageid: 1, ns: 0, title: 'Georgia (disambiguation)', extract: 'Georgia may refer to:\n\n== Places ==\nGeorgia (country), in the Caucasus.\nGeorgia (U.S. state).', pageprops: { disambiguation: '' } }] } };

test("guide: a name that is a disambiguation page answers with that page's text, naming the places, not as 'no article' (and not listing itself as a close name)", async () => {
  const { run, asked, ws } = await setup();
  const out = await run('guide', { place: 'Georgia' }, (url) => (url.includes('opensearch') ? ['Georgia', ['Georgia', 'Georgia (country)']] : GEORGIA));
  assert.equal(out, 'Georgia names several places: Georgia (disambiguation) (English Wikivoyage) https://en.wikivoyage.org/wiki/Georgia_%28disambiguation%29\n\nGeorgia may refer to:\n\n== Places ==\nGeorgia (country), in the Caucasus.\nGeorgia (U.S. state).');
  assert.ok(!asked.some((a) => a.url.includes('opensearch')), 'no search for close names: the page is the answer');
  // Japanese's 京都 is one, English has no such page: the first disambiguation page seen (Japanese's, English's page missing) answers; with Chinese's page listed, that anchors instead.
  await speaks(ws, ['ja']);
  assert.match(await run('guide', { place: '京都' }, voyage), /^京都 names several places: 京都 \(Japanese Wikivoyage\) https:\/\/ja\.wikivoyage\.org\/wiki\/京都\n\n京都は次のどれか。$/);
  await speaks(ws, ['ja', 'zh']);
  assert.match(await run('guide', { place: '京都' }, voyage), /^京都市 \(Japanese Wikivoyage\)/);
  // One that fails to answer is still named after it.
  await speaks(ws, ['ja']);
  assert.match(await run('guide', { place: '京都' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /^京都 names several places: [\s\S]*\nen\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
});

test("guide: a section only some editions have: the others each say they have none, in the reading order", async () => {
  const { run, ws } = await setup();
  await speaks(ws, ['ja']);
  // English has See, Japanese calls it 観る: the Japanese part says it has no section "See", before English's text.
  assert.equal(await run('guide', { place: 'Kyoto', section: 'See' }, voyage), [
    '京都市 (Japanese Wikivoyage) has no section "See". Its sections: 分かる, 観る.',
    'Kyoto: See (English Wikivoyage) https://en.wikivoyage.org/wiki/Kyoto\n\nKiyomizu-dera.',
  ].join('\n\n'));
});

test("guide: the anchor lookup has one time limit for all its editions: a dead connection takes ASK_MS, not ASK_MS an edition", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja', 'zh', 'de', 'fr']);
  mock.timers.enable(FAKE_TIME);
  try {
    /** @type {string | null} */
    let out = null;
    const done = run('guide', { place: 'Kyoto' }, (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })))
      .then((o) => { out = o; }, (e) => { out = String(e.message); });
    await until(() => asked.length >= 1);
    mock.timers.tick(ASK_MS.ms);
    await until(() => out !== null);
    await done;
    assert.match(String(out), /en\.wikivoyage\.org didn't answer in time/);
    assert.equal(asked.length, 1, 'once the limit has run out the other editions are not asked at all');
  } finally {
    mock.timers.reset();
  }
});

/** The offline pack of mcwayPack with Japanese listed: its guides are English's, and `voyage` says which editions its guides pass asked. @param {any} ws @param {string} id @param {string[]} voyage */
async function packAsked(ws, id, voyage) {
  await mcwayPack(ws, id);
  const m = JSON.parse(String(await ws.readText(id, '/offline/pack.json')));
  await ws.write(id, '/offline/pack.json', JSON.stringify({ ...m, voyage }), { author: 'system' });
}
/** Wikivoyage's answers for Cambria in English and Japanese. @param {string} url */
function cambria(url) {
  const u = new URL(url);
  if (u.hostname === 'ja.wikivoyage.org') return { query: { pages: [{ title: 'カンブリア', extract: 'カンブリアは海辺の町。' }] } };
  return { query: { pages: [{ title: 'Cambria (California)', extract: 'Cambria is a town.', langlinks: [{ lang: 'ja', title: 'カンブリア' }] }] } };
}

/** Wikivoyage's requests that read an edition's text, and those that read only its links, by host and title. @param {{ url: string }[]} asked */
const voyageReads = (asked) => asked.filter((a) => a.url.includes('wikivoyage.org')).map((a) => {
  const q = new URL(a.url).searchParams;
  return `${new URL(a.url).hostname} ${q.get('titles')} ${q.get('prop')?.includes('extracts') ? 'text' : 'links'}`;
});

test("guide with a pack that never asked the traveller's edition (a language added since, or a pack from before): the pack's parts answer, and only the missing edition is read online, by the titles the pack's guide links to", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  const id = /** @type {string} */ (trip);
  await packAsked(ws, id, ['en']);
  await speaks(ws, ['ja']);
  const online = await run('guide', { place: 'Cambria (California)' }, cambria);
  assert.equal(online, [
    'カンブリア (Japanese Wikivoyage) https://ja.wikivoyage.org/wiki/カンブリア\n\nカンブリアは海辺の町。',
    'Cambria (California) (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nCambria is a town.\n\nSections: See. Ask for one with section.',
  ].join('\n\n'));
  // English's text is not read again (34 to 50 KB a call for a city): its titles in the other editions, and Japanese's own text.
  assert.deepEqual(voyageReads(asked), ['en.wikivoyage.org Cambria (California) links', 'ja.wikivoyage.org カンブリア text']);
  // Wikivoyage doesn't answer: the pack's English part, and a line naming the edition that has no part.
  const down = await run('guide', { place: 'Cambria (California)' }, () => new Response('', { status: 503 }));
  assert.equal(down, "Cambria (California) (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nCambria is a town.\n\nSections: See. Ask for one with section.\nja.wikivoyage.org didn't answer, so this has no part from it.");
  // Japanese alone doesn't: the same, its pack part there being none.
  const jaDown = await run('guide', { place: 'Cambria (California)' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : cambria(url)));
  assert.match(jaDown, /^Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)[\s\S]*\nja\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
  // Wikivoyage says the page the pack's guide has is gone, or has no link there: the pack's part alone, no request for what isn't linked.
  assert.match(await run('guide', { place: 'Hearst Castle' }, (url) => (url.includes('opensearch') ? ['x', []] : { query: { pages: [{ title: 'Hearst Castle', missing: true }] } })), /^San Simeon \(English Wikivoyage, offline pack of 2026-10-16\)[^\n]*\n\nSan Simeon is home to Hearst Castle\.$/);
  // Offline (Koe's quick reads): never a request, and the line names what the pack lacks.
  asked.length = 0;
  assert.match(await run('guide', { place: 'Cambria' }, nothing, { offline: true }), /offline pack of 2026-10-16\)[\s\S]*\nJapanese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download\.$/);
  assert.equal(asked.length, 0);
  await speaks(ws, ['ja', 'zh']);
  assert.match(await run('guide', { place: 'Cambria' }, nothing, { offline: true }), /\nJapanese and Chinese Wikivoyage aren't in the offline pack yet; they come with the pack's next download\.$/);
  // A pack that asked Japanese and holds no guide there is today's: its English, with no request and no line.
  await packAsked(ws, id, ['en', 'ja', 'zh']);
  const held = await run('guide', { place: 'Cambria' }, nothing);
  assert.doesNotMatch(held, /isn't in the offline pack|aren't in the offline pack/);
  assert.match(held, /^Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)/);
});

test("guide, offline, for a place the pack holds no guide of: the answer still names the editions the pack lacks (and none when the pack asked them all, or there is no pack)", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  const id = /** @type {string} */ (trip);
  await packAsked(ws, id, ['en']);
  await speaks(ws, ['ja']);
  assert.equal(await run('guide', { place: 'Big Sur' }, nothing, { offline: true }), "Not in the offline pack: ask Kokoro.\nJapanese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download.");
  await packAsked(ws, id, ['en', 'ja']);
  assert.equal(await run('guide', { place: 'Big Sur' }, nothing, { offline: true }), 'Not in the offline pack: ask Kokoro.');
  const none = await setup();
  await speaks(none.ws, ['ja']);
  assert.equal(await none.run('guide', { place: 'Big Sur' }, nothing, { offline: true }), 'Not in the offline pack: ask Kokoro.');
});

test("guide: each edition's part from the pack where it holds one, whatever happens online: an edition added is the only one read, the others' hosts are not asked, and a host that doesn't answer for the edition added is named", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  const id = /** @type {string} */ (trip);
  await packAsked(ws, id, ['en', 'ja']);
  await ws.write(id, guideFile('Cambria (California)', 'ja').path, JSON.stringify({ title: 'カンブリア', text: 'カンブリアは海辺の町。' }), { author: 'system' });
  const m = JSON.parse(String(await ws.readText(id, '/offline/pack.json')));
  m.guides[0].also = [{ edition: 'ja', title: 'カンブリア' }];
  await ws.write(id, '/offline/pack.json', JSON.stringify(m), { author: 'system' });
  await speaks(ws, ['ja', 'zh']); // Chinese added
  const zh = (/** @type {string} */ url) => (url.includes('zh.wikivoyage') ? { query: { pages: [{ title: '坎布里亞', extract: '坎布里亞是海邊小鎮。' }] } } : { query: { pages: [{ title: 'Cambria (California)', extract: 'x', langlinks: [{ lang: 'ja', title: 'カンブリア' }, { lang: 'zh', title: '坎布里亞' }] }] } });
  const out = await run('guide', { place: 'Cambria' }, zh);
  assert.deepEqual(out.split('\n\n').filter((l) => /wikivoyage\.org\/wiki/.test(l)).map((l) => l.split(' https')[0]), ['カンブリア (Japanese Wikivoyage, offline pack of 2026-10-16)', '坎布里亞 (Chinese Wikivoyage)', 'Cambria (California) (English Wikivoyage, offline pack of 2026-10-16)']);
  assert.deepEqual(voyageReads(asked), ['en.wikivoyage.org Cambria (California) links', 'zh.wikivoyage.org 坎布里亞 text'], 'Japanese and English are not asked: the pack holds them');
  // Japanese Wikivoyage down changes nothing: its part is the pack's. English down, which gives the titles: Chinese is named, the pack's parts stay.
  asked.length = 0;
  assert.match(await run('guide', { place: 'Cambria' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : zh(url))), /^カンブリア \(Japanese Wikivoyage, offline pack of 2026-10-16\)[\s\S]*坎布里亞 \(Chinese Wikivoyage\)[\s\S]*Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)[^\n]*\n\n[^\n]*\n\nSections: See\. Ask for one with section\.$/);
  const enDown = await run('guide', { place: 'Cambria' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : zh(url)));
  assert.match(enDown, /^カンブリア \(Japanese Wikivoyage, offline pack of 2026-10-16\)[\s\S]*Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)[\s\S]*\nzh\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
  assert.doesNotMatch(enDown, /en\.wikivoyage\.org didn't answer/);
});

test("guide: a name English lists as several places stays English's list, whatever edition the traveller reads (Georgia is the US state in German, the country in Spanish): the same question brings the same answer, and no other edition is asked", async () => {
  const { run, asked, ws } = await setup();
  const german = (/** @type {string} */ url) => (url.includes('de.wikivoyage') ? { query: { pages: [{ ns: 0, title: 'Georgia', extract: 'Georgia ist ein Bundesstaat der USA.', langlinks: [{ lang: 'en', title: 'Georgia (state)' }] }] } } : GEORGIA);
  for (const spoken of [['de'], ['es', 'de'], ['de', 'zh']]) {
    await speaks(ws, spoken);
    asked.length = 0;
    const out = await run('guide', { place: 'Georgia' }, german);
    assert.match(out, /^Georgia names several places: Georgia \(disambiguation\) \(English Wikivoyage\) https:\/\/en\.wikivoyage\.org\/wiki\/Georgia_%28disambiguation%29\n\nGeorgia may refer to:/, spoken.join());
    assert.deepEqual([...new Set(asked.map((a) => new URL(a.url).hostname))], ['en.wikivoyage.org'], 'English was asked, and nobody else');
  }
  // English having no page at all is another matter: the next edition by the name anchors (the 京都 test above).
  await speaks(ws, ['de']);
  assert.match(await run('guide', { place: 'Georgia' }, (url) => (url.includes('de.wikivoyage') ? german(url) : { query: { pages: [{ title: 'Georgia', missing: true }] } })), /^Georgia \(German Wikivoyage\)/);
});

test("guide: the editions English links to are read inside the same time limit: English answering late leaves them what is left of it, not a limit of their own", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja', 'zh']);
  mock.timers.enable(FAKE_TIME);
  try {
    /** @type {string | null} */
    let out = null;
    const done = run('guide', { place: 'Kyoto' }, (url, init) => {
      if (url.includes('en.wikivoyage')) return new Promise((resolve) => setTimeout(() => resolve(voyage(url)), 20_000));
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }).then((o) => { out = o; }, (e) => { out = String(e.message); });
    await until(() => asked.length >= 1);
    mock.timers.tick(20_000);
    await until(() => asked.length >= 3);
    mock.timers.tick(5_000); // 25 s since the lookup began: the one limit for English, and for the two it linked to
    await until(() => out !== null);
    await done;
    assert.match(String(out), /^Kyoto \(English Wikivoyage\)[\s\S]*\nja\.wikivoyage\.org and zh\.wikivoyage\.org didn't answer, so this has no part from them\.$/);
  } finally {
    mock.timers.reset();
  }
});
