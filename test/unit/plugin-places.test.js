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
import { RESULT_MAX } from '../../src/core/agent/tools.js';
import { articlesOf, merged } from '../../src/core/wiki.js';
import { guideFile, downloadPack } from '../../src/core/pack/download.js';
import { voyageWorld, wikidataOf } from './pack-kit.js';
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
  return { run, asked, ws, trip: tripId, tools };
}

const McWay = { lat: 36.1580, lng: -121.6720 };
/** What nearby says where the offline pack's articles are listed: a part holds each edition's nearest 20 (the extracts' 20), at each stop and every 15 km of the way. */
const HOLDS = "The offline pack holds each edition's nearest 20 Wikipedia articles at each stop and every 15 km of the way, so Wikipedia has more.";
/** The line nearby says when it cut its places, its articles or both, each with the distance of its last row. @param {[number, number] | null} places @param {[number, number] | null} articles @param {number} [radius] */
const reachLine = (places, articles, radius = 1000) => `These are ${[places && `the nearest ${places[0]} places (out to ${places[1]} m)`, articles && `the nearest ${articles[0]} Wikipedia articles (out to ${articles[1]} m)`].filter(Boolean).join(' and ')}; farther ones within ${radius} m aren't listed.`;
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
    // The header and 40 rows, then the line saying they are the nearest 40 of more; Sydney's answer, at Overpass's 400, has instead the line saying
    // Overpass cut it, in id order, so these 40 aren't the nearest (the next test): the reach line would say the opposite.
    assert.equal(lines.length, 42, place);
    const rows = lines.slice(1, 41).map((r) => r.split('\t'));
    if (p.n === 400) assert.match(lines[41], /^OpenStreetMap's answer stopped at 400 places, not chosen by distance/, place);
    else assert.equal(lines[41], reachLine([40, Number(rows[39][2])], null), place);
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
  // The 40 places and the article (each list its own count), then Overpass's cut alone: it says these 40 aren't the nearest, so no line says they are.
  assert.equal(lines.length, 43);
  assert.ok(lines.slice(1, 42).every((r) => r.split('\t').length === 7));
  assert.doesNotMatch(lines.join('\n'), /These are the nearest/);
  // nearby reads this saved answer of the earlier query as cut in the 500 m circle, which holds 66 of these places as nearby rounds them (the
  // 250 m one 18): it names 250 m. Today's query stops at 500 m there, whole.
  assert.equal(lines.at(-1), cutLine(250));
  // The articles cut as well: the reach line names them alone, then Overpass's line.
  const fifty = geo(...Array.from({ length: 50 }, (_, k) => /** @type {[string, number, number, string]} */ ([`Article ${k}`, at.lat - (100 + 5 * k) / 111_195, at.lng, `Q${2000 + k}`])));
  const both = (await run('nearby', at, (url) => (url.includes('overpass') ? body : fifty))).split('\n');
  const farthest = Number(both.filter((r) => r.includes('\twikipedia\t')).map((r) => r.split('\t')[2]).at(-1));
  assert.deepEqual(both.slice(-2), [reachLine(null, [50, farthest]), cutLine(250)]);
  // 399 of the same places: an answer that didn't reach the limit says nothing of it, only that the 40 are the nearest of more.
  const whole = (await run('nearby', at, (url) => (url.includes('overpass') ? { ...body, elements: body.elements.slice(0, 399) } : wiki))).split('\n');
  assert.equal(whole.length, 43);
  assert.match(whole.at(-1) ?? '', /^These are the nearest 40 places/);
  // What Overpass sent counts, not the rows kept: 400 elements, five of them with no position (osmRow makes no row from one; an element
  // without tags still makes a row), are still cut.
  const bare = body.elements.map((/** @type {any} */ e, /** @type {number} */ k) => (k < 5 ? { type: e.type, id: e.id, tags: e.tags } : e));
  assert.equal((await run('nearby', at, (url) => (url.includes('overpass') ? { ...body, elements: bare } : wiki))).split('\n').at(-1), cutLine(250));
  // Wikipedia not answering, and no pack: OpenStreetMap's rows, then the Wikipedia line, then the cut line.
  const down = (await run('nearby', at, (url) => (url.includes('overpass') ? body : new Response('', { status: 503 })))).split('\n');
  assert.equal(down.length, 43);
  assert.deepEqual([down.at(-2), down.at(-1)], ["Wikipedia didn't answer; these are OpenStreetMap places only.", cutLine(250)]);
  // A pack whose area holds the point but not the circle fills in for Wikipedia, saying so; the cut line comes after, last.
  const day = '2026-10-16T09:00:00.000Z';
  await ws.write(/** @type {string} */ (trip), '/offline/osm/o1.json', JSON.stringify({ area: { points: [[at.lat, at.lng]], radius: 500 }, rows: [] }), { author: 'system' });
  await ws.write(/** @type {string} */ (trip), '/offline/wikipedia/w1.json', JSON.stringify({ at: [at.lat, at.lng], radius: 10000, pages: [['Sydney Opera House', -33.8568, 151.2153, 'The Sydney Opera House is a performing arts centre in Sydney.']] }), { author: 'system' });
  await ws.write(/** @type {string} */ (trip), '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at: day, failed: [], full: false, stopped: false, bytes: 700,
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 400, items: 0 }, { id: 'w1', kind: 'wikipedia', path: '/offline/wikipedia/w1.json', bytes: 300, items: 1 }], guides: [] }), { author: 'system' });
  const filled = (await run('nearby', at, (url) => (url.includes('overpass') ? body : new Response('', { status: 503 })))).split('\n');
  assert.equal(filled.length, 45);
  assert.match(filled[1], /^Sydney Opera House\twikipedia article\t0\t/);
  assert.deepEqual(filled.slice(-3), ["Wikipedia didn't answer, so its articles come from the offline pack (downloaded 2026-10-16).", HOLDS, cutLine(250)]);
  // With the pack, an answer short of the limit ends without it.
  assert.match((await run('nearby', at, (url) => (url.includes('overpass') ? { ...body, elements: body.elements.slice(0, 399) } : new Response('', { status: 503 })))),
    /\nWikipedia didn't answer, so its articles come from the offline pack \(downloaded 2026-10-16\)\.\n.+\nThese are the nearest 40 places \(out to \d+ m\); farther ones within 1000 m aren't listed\.$/);
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
    // The header, 40 rows and the cut line: no line says the 40 are the nearest. A radius over 10 km adds the line that Wikipedia was asked within 10 km.
    assert.equal(lines.length, 42 + (input.radius > 10_000 ? 1 : 0));
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
/** Wikidata from its real answer of 2026-11-20 (pack-kit.js SITELINKS: the 24 Kiyomizu articles only Japanese listed, among others); an item it doesn't name has no title in another edition. */
const wikidata = wikidataOf();
/** Nothing from OpenStreetMap, each Wikipedia edition's saved answer, and Wikidata's. @param {string} url */
const kiyomizuOnly = (url) => (url.includes('overpass') ? { elements: [] } : url.includes('wikidata.org') ? wikidata(url) : KIYOMIZU_WIKI[new URL(url).hostname] ?? new Response('', { status: 404 }));
/** nearby's rows, split. @param {string} out */
const rowsOf = (out) => out.split('\n').slice(1).filter((r) => r.includes('\t')).map((r) => r.split('\t'));

test("nearby reads Wikipedia in each of the traveller's languages and English: each article once, by its Wikidata id, named in the first edition that has it, its note its address in each edition that has it", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja']);
  const out = await run('nearby', KIYOMIZU, kiyomizuOnly);
  const rows = rowsOf(out);
  const named = (/** @type {string} */ name) => rows.find((r) => r[0] === name);
  // 30 Japanese and 14 English articles, 6 of them the same: 38, every one, under the 50 kept.
  assert.equal(rows.length, 38);
  assert.ok(!out.includes('These are the nearest'), 'nothing cut');
  // In both lists: Japanese's title, and both addresses, Japanese's first.
  assert.deepEqual(named('清水寺'), ['清水寺', 'wikipedia article', '8', '34.9948', '135.785', 'wikipedia', 'https://ja.wikipedia.org/wiki/清水寺 · https://en.wikipedia.org/wiki/Kiyomizu-dera']);
  assert.equal(named('Kiyomizu-dera'), undefined, 'the same article, under Japanese');
  // Only Japanese's list holds 産寧坂; Wikidata names it in English, Sannenzaka: both addresses, in the order.
  assert.equal(named('産寧坂')?.[6], 'https://ja.wikipedia.org/wiki/産寧坂 · https://en.wikipedia.org/wiki/Sannenzaka');
  assert.equal(named('七味家本舗')?.[6], 'https://ja.wikipedia.org/wiki/七味家本舗 · https://en.wikipedia.org/wiki/Shichimiya');
  // Only Japanese has 東山警察署 (Wikidata names no English article): its address alone.
  assert.equal(named('東山警察署')?.[6], 'https://ja.wikipedia.org/wiki/東山警察署');
  assert.equal(named('Ryozen Museum of History')?.[6], 'https://en.wikipedia.org/wiki/Ryozen_Museum_of_History', "English's own articles stay, under English");
  assert.equal(named('正法寺 (京都市東山区)')?.[6], 'https://ja.wikipedia.org/wiki/正法寺_%28京都市東山区%29', 'an address as pageUrl writes it (src/core/wiki.js)');
  // Each edition asked once, as annai names itself to Wikimedia, for its 50 nearest with their coordinates and Wikidata ids.
  const wiki = asked.filter((a) => a.url.includes('wikipedia.org'));
  assert.deepEqual(wiki.map((a) => new URL(a.url).hostname), ['ja.wikipedia.org', 'en.wikipedia.org']);
  for (const a of wiki) {
    assert.match(a.url, /&generator=geosearch&ggscoord=34\.9949%7C135\.785&ggsradius=1000&ggslimit=50&prop=coordinates%7Cpageprops&ppprop=wikibase_item&colimit=50$/);
    assert.match(a.init.headers['Api-User-Agent'], /^annai\/\d+\.\d+\.\d+ \(https:\/\/annai\.guide\)$/);
  }
  // Then one Wikidata request, after the lists: the 38 articles' ids, and the two editions' sites; ids, never the position.
  const wd = asked.filter((a) => a.url.includes('wikidata.org'));
  assert.equal(wd.length, 1);
  assert.ok(asked.indexOf(wd[0]) > asked.indexOf(wiki[1]));
  const q = new URL(wd[0].url);
  assert.equal(q.origin + q.pathname, 'https://www.wikidata.org/w/api.php');
  assert.deepEqual([q.searchParams.get('action'), q.searchParams.get('props'), q.searchParams.get('sitefilter'), q.searchParams.get('origin')], ['wbgetentities', 'sitelinks', 'jawiki|enwiki', '*']);
  assert.equal(String(q.searchParams.get('ids')).split('|').length, 38);
  assert.doesNotMatch(wd[0].url, /34\.99|135\.78/);
  assert.match(wd[0].init.headers['Api-User-Agent'], /^annai\//);
  // English first: Wikidata's English title names the article only Japanese listed, and English's address comes first.
  await speaks(ws, ['en', 'ja']);
  const english = rowsOf(await run('nearby', KIYOMIZU, kiyomizuOnly));
  assert.deepEqual(english.find((r) => r[6].includes('Sannenzaka'))?.slice(0, 1).concat(english.find((r) => r[6].includes('Sannenzaka'))?.[6] ?? ''), ['Sannenzaka', 'https://en.wikipedia.org/wiki/Sannenzaka · https://ja.wikipedia.org/wiki/産寧坂']);
  assert.ok(english.some((r) => r[0] === 'Kiyomizu-dera') && !english.some((r) => r[0] === '清水寺'));
  // Chinese (Traditional) and English: Chinese Wikipedia, whose 1 km has no 清水寺, so English's Kiyomizu-dera stands beside its own.
  await speaks(ws, ['zh-Hant']);
  asked.length = 0;
  const zh = rowsOf(await run('nearby', KIYOMIZU, kiyomizuOnly));
  assert.deepEqual(asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname), ['zh.wikipedia.org', 'en.wikipedia.org']);
  assert.equal(new URL(asked.filter((a) => a.url.includes('wikidata.org'))[0].url).searchParams.get('sitefilter'), 'zhwiki|enwiki');
  assert.ok(zh.some((r) => r[0] === '圓山公園 (京都府)') && !zh.some((r) => r[0] === 'Maruyama Park (Kyoto)'));
  assert.ok(zh.some((r) => r[0] === 'Kiyomizu-dera'));
  assert.equal(zh.find((r) => r[0] === '产宁坂')?.[6], 'https://zh.wikipedia.org/wiki/产宁坂 · https://en.wikipedia.org/wiki/Sannenzaka');
  // Three editions: Japanese, Chinese, English, each address in that order where Wikidata names it.
  await speaks(ws, ['ja', 'zh-Hant']);
  const three = rowsOf(await run('nearby', KIYOMIZU, kiyomizuOnly));
  assert.equal(three.find((r) => r[0] === '産寧坂')?.[6], 'https://ja.wikipedia.org/wiki/産寧坂 · https://zh.wikipedia.org/wiki/产宁坂 · https://en.wikipedia.org/wiki/Sannenzaka');
  assert.equal(three.find((r) => r[0] === '清閑寺')?.[6], 'https://ja.wikipedia.org/wiki/清閑寺 · https://zh.wikipedia.org/wiki/清閑寺');
});

test("English alone: nearby asks Wikidata nothing, and its rows are English's own", async () => {
  const { run, asked } = await setup();
  const rows = rowsOf(await run('nearby', KIYOMIZU, kiyomizuOnly));
  assert.equal(rows.length, 14);
  assert.equal(rows.find((r) => r[0] === 'Kiyomizu-dera')?.[6], 'https://en.wikipedia.org/wiki/Kiyomizu-dera');
  assert.deepEqual(asked.filter((a) => a.url.includes('wikidata.org')), []);
  assert.deepEqual(asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname), ['en.wikipedia.org']);
  assert.equal(new URL(asked.filter((a) => a.url.includes('wikipedia.org'))[0].url).searchParams.get('ggslimit'), '50', 'its nearest 50');
});

test("nearby: Wikidata late, refusing or answering an error: the rows as the lists give them, and a line that says a row may leave out an edition, inside the one limit", async () => {
  const { run, ws } = await setup();
  await speaks(ws, ['ja']);
  const line = "Wikidata didn't answer, so a row may leave out an edition that has its article.";
  const was = ASK_MS.ms;
  ASK_MS.ms = 300;
  // Node lets AbortSignal.timeout's timer go when nothing else keeps it running: this does, as a page does.
  const alive = setInterval(() => {}, 1000);
  try {
    /** @param {string} url @param {any} init */
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    const t0 = Date.now();
    const late = await run('nearby', KIYOMIZU, (url, init) => (url.includes('wikidata.org') ? hang(url, init) : kiyomizuOnly(url)));
    // The lists' time and Wikidata's together: one limit (300 ms here), not one each.
    assert.ok(Date.now() - t0 < 600, `${Date.now() - t0} ms`);
    const rows = rowsOf(late);
    assert.equal(rows.length, 38);
    assert.equal(rows.find((r) => r[0] === '清水寺')?.[6], 'https://ja.wikipedia.org/wiki/清水寺 · https://en.wikipedia.org/wiki/Kiyomizu-dera', 'both lists hold it');
    assert.equal(rows.find((r) => r[0] === '産寧坂')?.[6], 'https://ja.wikipedia.org/wiki/産寧坂', 'only its list');
    assert.equal(late.split('\n').at(-1), line);
    ASK_MS.ms = was;
    const refused = await run('nearby', KIYOMIZU, (url) => (url.includes('wikidata.org') ? new Response('', { status: 429 }) : kiyomizuOnly(url)));
    assert.equal(refused, late);
    // Wikidata answers an error with 200 and {"error": …}: no answer either.
    const said = await run('nearby', KIYOMIZU, (url) => (url.includes('wikidata.org') ? { error: { code: 'maxlag', info: 'Waiting for a database server: 6 seconds lagged.' } } : kiyomizuOnly(url)));
    assert.equal(said, late);
  } finally {
    ASK_MS.ms = was;
    clearInterval(alive);
  }
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

/** n articles due south of a point, from `from` m, each `step` m on (111,195 m a degree of latitude), in an edition's answer. @param {string} prefix @param {number} n @param {number} from @param {number} step */
const south = (prefix, n, from, step) => geo(...Array.from({ length: n }, (_, k) => /** @type {[string, number, number, string]} */ ([`${prefix} ${k}`, KIYOMIZU.lat - (from + k * step) / 111_195, KIYOMIZU.lng, `Q${prefix.length}${1000 + k}`])));
/** n restaurants due north of a point, from `from` m, each `step` m on. @param {number} n @param {number} from @param {number} step */
const north = (n, from, step) => ({ elements: Array.from({ length: n }, (_, k) => ({ type: 'node', id: k + 1, lat: KIYOMIZU.lat + (from + k * step) / 111_195, lon: KIYOMIZU.lng, tags: { name: `Place ${k}`, amenity: 'restaurant' } })) });

test("60 places and 60 articles give the nearest 40 and the nearest 50, each list cut to its own count and then sorted together: the articles crowd no place out, nor the places any article", async () => {
  const { run } = await setup();
  // The places all nearer than every article (10 to 600 m; the articles from 700 m): one shared count would leave no article.
  const out = await run('nearby', KIYOMIZU, (url) => (url.includes('overpass') ? north(60, 10, 10) : south('Article', 60, 700, 4)));
  const rows = rowsOf(out);
  assert.equal(rows.filter((r) => r[5] === 'osm').length, 40);
  assert.equal(rows.filter((r) => r[5] === 'wikipedia').length, 50);
  assert.deepEqual(rows.map((r) => Number(r[2])), rows.map((r) => Number(r[2])).sort((a, b) => a - b), 'nearest first, together');
  assert.deepEqual(rows.filter((r) => r[5] === 'osm').map((r) => r[0]), Array.from({ length: 40 }, (_, k) => `Place ${k}`), 'the nearest 40 places');
  assert.deepEqual(rows.filter((r) => r[5] === 'wikipedia').map((r) => r[0]), Array.from({ length: 50 }, (_, k) => `Article ${k}`), 'the nearest 50 articles');
  // Each list cut, with how far it reaches: the 40th place at 400 m, the 50th article at 896 m.
  assert.equal(out.split('\n').at(-1), reachLine([40, Number(rows.filter((r) => r[5] === 'osm')[39][2])], [50, Number(rows.filter((r) => r[5] === 'wikipedia')[49][2])]));
  // The places farther than every article: the same.
  const other = rowsOf(await run('nearby', KIYOMIZU, (url) => (url.includes('overpass') ? north(60, 500, 5) : south('Article', 60, 10, 4))));
  assert.deepEqual([other.filter((r) => r[5] === 'osm').length, other.filter((r) => r[5] === 'wikipedia').length], [40, 50]);
});

test("nearby says its articles are cut at 50 and not at 49, and when an edition's answer was full; its places at 41 and not at 40; with how far each reaches, never promising a retry", async () => {
  const { run, ws } = await setup();
  const places = (/** @type {number} */ n) => north(n, 10, 10);
  const say = async (/** @type {any} */ osm, /** @type {(url: string) => any} */ wiki) => (await run('nearby', KIYOMIZU, (url) => (url.includes('overpass') ? osm : url.includes('wikidata.org') ? wikidata(url) : wiki(url)))).split('\n').at(-1);
  // English alone, 50 articles: its answer was full (ggslimit 50), so there may be more: cut, out to the 50th.
  assert.equal(await say(places(5), () => south('Article', 50, 100, 5)), reachLine(null, [50, 345]));
  // 49: whole, nothing said.
  assert.match(String(await say(places(5), () => south('Article', 49, 100, 5))), /\t/);
  // Places: 41 came, 40 kept, the 40th at 400 m; 40 came, nothing said.
  assert.equal(await say(places(41), () => south('Article', 3, 100, 5)), reachLine([40, 400], null));
  assert.match(String(await say(places(40), () => south('Article', 3, 100, 5))), /\t/);
  // Both cut, in one line.
  assert.equal(await say(places(41), () => south('Article', 50, 100, 5)), reachLine([40, 400], [50, 345]));
  // Two editions of 30 each, 60 articles merged: neither answer full, the merged list is cut to 50 all the same.
  await speaks(ws, ['ja']);
  const two = await say(places(5), (url) => (url.includes('ja.wikipedia.org') ? south('記事', 30, 100, 10) : south('Article', 30, 105, 10)));
  assert.equal(two, reachLine(null, [50, 345]));
  // Two editions of 25 each: 50 in all, no answer full, nothing cut.
  assert.match(String(await say(places(5), (url) => (url.includes('ja.wikipedia.org') ? south('記事', 25, 100, 10) : south('Article', 25, 105, 10)))), /\t/);
  // One edition full (50) and the merged list 50: cut, as that edition may have more.
  assert.equal(await say(places(5), (url) => (url.includes('ja.wikipedia.org') ? south('記事', 50, 100, 5) : geo())), reachLine(null, [50, 345]));
});

/**
 * A trip's offline pack at Kiyomizu-dera: Wikipedia's real answers as the pack holds them (a part's 20 nearest: two overlapping Japanese parts and one
 * English), and OpenStreetMap's 5 km around, with some places in it, and, unless `stages` is false (a pack from before them), each part's second stage for
 * Japanese and English (empty: what these tests read is the lists). @param {any} ws @param {string} trip @param {{ id: number, lat: number, lon: number, tags: any }[]} [places] @param {{ stages?: boolean }} [o]
 */
async function kiyomizuPack(ws, trip, places = [], { stages = true } = {}) {
  const at = [KIYOMIZU.lat, KIYOMIZU.lng];
  const pagesOf = (/** @type {string} */ host, /** @type {number} */ from, /** @type {number} */ to) => KIYOMIZU_WIKI[host].query.pages.slice(from, to).map((/** @type {any} */ g) => [g.title, g.coordinates[0].lat, g.coordinates[0].lon, '', g.pageprops.wikibase_item]);
  const parts = /** @type {[string, string, string, any[]][]} */ ([['ja', 'w1', '/offline/wikipedia/w1.ja.json', pagesOf('ja.wikipedia.org', 0, 20)], ['ja', 'w2', '/offline/wikipedia/w2.ja.json', pagesOf('ja.wikipedia.org', 10, 30)], ['en', 'w1', '/offline/wikipedia/w1.json', pagesOf('en.wikipedia.org', 0, 20)]]);
  for (const [, , path, pages] of parts) await ws.write(trip, path, JSON.stringify({ at, radius: 10000, pages }), { author: 'system' });
  const more = stages ? ['w1', 'w2'].map((id) => ({ id, kind: 'wikipedia-editions', path: `/offline/wikipedia/${id}.x.en.ja.json`, bytes: 1, items: 0 })) : [];
  for (const m of more) await ws.write(trip, m.path, JSON.stringify({ at, pages: [] }), { author: 'system' });
  await ws.write(trip, '/offline/osm/o1.json', JSON.stringify({ area: { points: [at], radius: 5000 }, rows: places.map((e) => [`n${e.id}`, e.tags.name, 'restaurant', e.lat, e.lon, '', 'food']) }), { author: 'system' });
  await ws.write(trip, '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at: '2026-11-19T09:00:00.000Z', failed: [], full: false, stopped: false, bytes: 1, guides: [],
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 1, items: places.length }, ...parts.map(([edition, id, path]) => ({ id, kind: 'wikipedia', path, bytes: 1, items: 20, edition })), ...more] }), { author: 'system' });
}

test("from the pack, the same counts: the nearest 40 places and 50 articles, said when cut, and what the pack holds", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await speaks(ws, ['ja']);
  // 60 places in the pack's area, and the pack's 38 articles in the circle (two overlapping Japanese parts and English's): 40 places, every article.
  const restaurants = north(60, 10, 15).elements;
  await kiyomizuPack(ws, /** @type {string} */ (trip), restaurants);
  const out = await run('nearby', KIYOMIZU, () => { throw new Error('asked'); });
  const rows = rowsOf(out);
  assert.equal(rows.filter((r) => r[5] === 'osm').length, 40);
  assert.equal(rows.filter((r) => r[5] === 'wikipedia').length, 38);
  assert.ok(rows.some((r) => r[0] === '清水寺') && !rows.some((r) => r[0] === 'Kiyomizu-dera'));
  assert.deepEqual(out.split('\n').slice(-3), ['From the offline pack (downloaded 2026-11-19).', HOLDS, reachLine([40, 595], null)]);
  // Koe's quick read the same.
  const quick = await run('nearby', KIYOMIZU, () => { throw new Error('asked'); }, { offline: true });
  assert.equal(rowsOf(quick).length, 78);
});

const OLD_STAGES = "Some of its parts don't hold the other editions' summaries yet, so a row may leave out an edition that has its article; they come with the pack's next download.";

test("from the pack, nearby says what the pack lacks yet of the editions read: a part with no second stage, an edition with no list; nothing where it lacks nothing, or English is alone", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  const offline = () => { throw new Error('asked'); };
  await kiyomizuPack(ws, /** @type {string} */ (trip), [], { stages: false });
  // A pack from before the second stage (or one whose stage failed), Japanese and English read: its parts lack the stage, said after what a part holds.
  await speaks(ws, ['ja']);
  assert.deepEqual((await run('nearby', KIYOMIZU, offline)).split('\n').slice(-2), [HOLDS, OLD_STAGES]);
  // Koe's quick read says it too.
  assert.deepEqual((await run('nearby', KIYOMIZU, offline, { offline: true })).split('\n').slice(-2), [HOLDS, OLD_STAGES]);
  // English alone: no second stage is wanted, and nothing is lacking.
  await speaks(ws, []);
  const english = await run('nearby', KIYOMIZU, offline);
  assert.equal(english.split('\n').at(-1), HOLDS);
  // Chinese added since the download: no list of it, and no stage for the three. One line, the edition first, named as guide's lacking names one.
  await speaks(ws, ['ja', 'zh-Hant']);
  assert.deepEqual((await run('nearby', KIYOMIZU, offline)).split('\n').slice(-2), [HOLDS, `Chinese Wikipedia isn't in the offline pack yet; it comes with the pack's next download. ${OLD_STAGES}`]);
  // Two editions with no list: both named, in the reading order.
  await speaks(ws, ['ja', 'zh-Hant', 'de']);
  assert.match((await run('nearby', KIYOMIZU, offline)).split('\n').at(-1) ?? '', /^Chinese and German Wikipedia aren't in the offline pack yet; they come with the pack's next download\. Some of its parts/);
  // A pack with its stages lacks nothing for Japanese and English: the line is not there.
  const whole = await setup({ trip: true });
  await kiyomizuPack(whole.ws, /** @type {string} */ (whole.trip));
  await speaks(whole.ws, ['ja']);
  assert.equal((await whole.run('nearby', KIYOMIZU, offline)).split('\n').at(-1), HOLDS);
});

test("nearby with the pack filling in for an edition that doesn't answer says what the pack holds and lacks, and nothing where the pack gave no article", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await speaks(ws, ['ja']);
  await kiyomizuPack(ws, /** @type {string} */ (trip), [], { stages: false });
  const down = (/** @type {string} */ host) => (/** @type {string} */ url) => (url.includes(host) ? new Response('', { status: 503 }) : kiyomizuOnly(url));
  // Japanese down, the pack past its circle: its articles from the pack, so what a part holds, and what it lacks, after the line that says so.
  const out = await run('nearby', { ...KIYOMIZU, radius: 8000 }, down('ja.wikipedia.org'));
  assert.deepEqual(out.split('\n').slice(-3), ["ja.wikipedia.org didn't answer, so its articles come from the offline pack (downloaded 2026-11-19), where it holds them.", HOLDS, OLD_STAGES]);
  // Both editions answering: no article is the pack's, so it is not mentioned.
  const online = await run('nearby', { ...KIYOMIZU, radius: 8000 }, kiyomizuOnly);
  assert.doesNotMatch(online, /offline pack/);
  // OpenStreetMap down, Wikipedia answering in both: its places from the pack, no article from it.
  const osmDown = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('overpass') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  assert.match(osmDown, /\nOpenStreetMap is busy, so its places come from the offline pack \(downloaded 2026-11-19\)\.$/);
  // Wikipedia not answering at all: every article is the pack's.
  const none = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  assert.deepEqual(none.split('\n').slice(-3), ["Wikipedia didn't answer, so its articles come from the offline pack (downloaded 2026-11-19).", HOLDS, OLD_STAGES]);
});

test("a pack-fed answer stays whole, with its endings, at any number of editions: the farthest articles are left out until it fits a tool result, and the reach line says how far the rest reach", async () => {
  const { run, ws, trip } = await setup({ trip: true });
  const at = [KIYOMIZU.lat, KIYOMIZU.lng];
  const editions = ['de', 'fr', 'es', 'en'];
  // 50 articles in each of four Latin-script editions, every one in all four, each with a summary the pack cuts to about 200 characters: rows of
  // about 1,100 characters, 56,000 in all, past RESULT_MAX (40,000), which cuts the end, the endings included.
  const pages = (/** @type {string} */ e) => Array.from({ length: 50 }, (_, k) => [`${e} article ${k}`, KIYOMIZU.lat - (100 + 5 * k) / 111_195, KIYOMIZU.lng, `${e} ${k} ${'a summary word '.repeat(30)}`, `Q${5000 + k}`]);
  const lists = editions.map((e) => ({ e, path: `/offline/wikipedia/w1${e === 'en' ? '' : `.${e}`}.json` }));
  for (const { e, path } of lists) await ws.write(/** @type {string} */ (trip), path, JSON.stringify({ at, radius: 10000, pages: pages(e) }), { author: 'system' });
  const stage = '/offline/wikipedia/w1.x.de.en.es.fr.json';
  await ws.write(/** @type {string} */ (trip), stage, JSON.stringify({ at, pages: [] }), { author: 'system' });
  await ws.write(/** @type {string} */ (trip), '/offline/osm/o1.json', JSON.stringify({ area: { points: [at], radius: 5000 }, rows: [] }), { author: 'system' });
  await ws.write(/** @type {string} */ (trip), '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at: '2026-11-19T09:00:00.000Z', failed: [], stopped: false, bytes: 1, guides: [],
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 1, items: 0 }, { id: 'w1', kind: 'wikipedia-editions', path: stage, bytes: 1, items: 0 },
      ...lists.map(({ e, path }) => ({ id: 'w1', kind: 'wikipedia', path, bytes: 1, items: 50, edition: e }))] }), { author: 'system' });
  await speaks(ws, ['de', 'fr', 'es']);
  const offline = () => { throw new Error('asked'); };
  for (const input of [{}, { offline: true }]) {
    const out = await run('nearby', KIYOMIZU, offline, input);
    const rows = rowsOf(out);
    // Whole: inside a tool result, the endings there, the articles that fit kept (not one fewer than could), the nearest of them, each in four editions.
    assert.ok(out.length <= RESULT_MAX, `${out.length} characters`);
    assert.ok(out.length > RESULT_MAX - 1500, `${out.length} characters: as many as fit`);
    assert.ok(rows.length > 20 && rows.length < 50, `${rows.length} articles`);
    assert.deepEqual(rows.map((r) => r[0]), Array.from({ length: rows.length }, (_, k) => `de article ${k}`), 'the nearest, in order');
    assert.equal(rows[0][6].split(' · ').length, 4);
    const lines = out.split('\n');
    assert.match(lines.at(-3) ?? '', /^From the offline pack \(downloaded 2026-11-19\)/);
    assert.equal(lines.at(-2), HOLDS);
    assert.equal(lines.at(-1), reachLine(null, [rows.length, Number(rows.at(-1)?.[2])]));
  }
  // Fewer editions fit whole: English alone, 50 articles, nothing left out and nothing said.
  await speaks(ws, []);
  const english = await run('nearby', KIYOMIZU, offline);
  assert.equal(rowsOf(english).length, 50);
  assert.equal(english.split('\n').at(-1), HOLDS);
});

test("nearby asks Wikipedia's articles within 10 km at most, and says so when the radius is wider; nearby's description says offline rows carry each edition's short summary", async () => {
  const { run, asked, tools } = await setup();
  const wide = await run('nearby', { ...KIYOMIZU, radius: 15000 }, kiyomizuOnly);
  assert.equal(wide.split('\n').at(-1), "Wikipedia's articles are asked within 10 km only (its geosearch's limit); farther ones aren't listed.");
  assert.equal(new URL(asked.find((a) => a.url.includes('wikipedia.org'))?.url ?? '').searchParams.get('ggsradius'), '10000');
  // 10 km and under: asked as wide as the radius, and nothing said.
  assert.doesNotMatch(await run('nearby', { ...KIYOMIZU, radius: 10000 }, kiyomizuOnly), /geosearch/);
  assert.match(tools.nearby.description, /\(from the offline pack, each edition's short summary too, before its address\)/);
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
    // The limit is spent, so Wikidata is not asked (no request is made after a limit has run out): it is said not to have been asked, as it never
    // had its time to answer.
    assert.match(hung, /\nja\.wikipedia\.org didn't answer, so its articles are missing from this list\.\nWikidata wasn't asked, as the time had run out, so a row may leave out an edition that has its article\.$/);
    // Two editions that never answer share the one limit (asked at once): 500 ms here, where limits one after the other would take twice that.
    ASK_MS.ms = 500;
    await speaks(ws, ['ja', 'zh-Hant']);
    const t1 = Date.now();
    const two = await run('nearby', KIYOMIZU, (url, init) => (init.signal?.aborted ? Promise.reject(init.signal.reason) : url.includes('ja.wikipedia.org') || url.includes('zh.wikipedia.org') ? hang(url, init) : kiyomizuOnly(url)));
    assert.ok(Date.now() - t1 < 900, `${Date.now() - t1} ms for two that never answer`);
    assert.match(two, /\nja\.wikipedia\.org and zh\.wikipedia\.org didn't answer, so their articles are missing from this list\.\nWikidata wasn't asked, as the time had run out/);
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
  const rows = rowsOf(out);
  assert.equal(rows.length, 38);
  // 清水寺 from the pack, in place of English's Kiyomizu-dera (the same Wikidata item), linked on Japanese Wikipedia, then on English's.
  assert.equal(rows.find((r) => r[0] === '清水寺')?.[6], 'https://ja.wikipedia.org/wiki/清水寺 · https://en.wikipedia.org/wiki/Kiyomizu-dera');
  assert.equal(rows.find((r) => r[0] === 'Kiyomizu-dera'), undefined);
  assert.equal(rows.find((r) => r[0] === 'Ryozen Museum of History')?.[6], 'https://en.wikipedia.org/wiki/Ryozen_Museum_of_History');
  // Said whichever edition's articles came from the pack: what a part holds, one rule (the pack lacks nothing here, its stages are there).
  assert.match(out, new RegExp(`\\nja\\.wikipedia\\.org didn't answer, so its articles come from the offline pack \\(downloaded 2026-11-19\\), where it holds them\\.\\n${HOLDS.replace(/[.]/g, '\\.')}$`));
  // English not answering: English's articles from the pack are the one Japanese has none of (the pack has English's own).
  const en = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('en.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  assert.match(en, new RegExp(`\\nen\\.wikipedia\\.org didn't answer, so its articles come from the offline pack \\(downloaded 2026-11-19\\), where it holds them\\.\\n${HOLDS.replace(/[.]/g, '\\.')}$`));
  assert.ok(en.includes('Ryozen Museum of History\t'));
  // Where the pack has none of that edition's articles, the note says they are missing.
  await speaks(ws, ['zh-Hant']);
  const zh = await run('nearby', { ...KIYOMIZU, radius: 8000 }, (url) => (url.includes('zh.wikipedia.org') ? new Response('', { status: 503 }) : kiyomizuOnly(url)));
  assert.match(zh, /\nzh\.wikipedia\.org didn't answer, so its articles are missing from this list\.$/);
  assert.doesNotMatch(zh, /offline pack/, 'no article came from the pack, so nothing is said of what it holds');
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
  // An absence counts only where the source answered: English failing ends the lookup with its error, whatever Japanese would have said.
  await assert.rejects(run('guide', { place: '京都市' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /en\.wikivoyage\.org answered 503/);
  await assert.rejects(run('guide', { place: 'Kyoto' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /en\.wikivoyage\.org answered 503/);
  // English has no page and Japanese doesn't answer: Japanese's error, not "no article".
  await assert.rejects(run('guide', { place: 'Atlantis' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : url.includes('opensearch') ? ['Atlantis', []] : voyage(url))), /ja\.wikivoyage\.org answered 503/);
});

test("guide: English failing by the name is the only request that is made; English missing and Japanese failing, no edition after Japanese is asked", async () => {
  const { run, asked, ws } = await setup();
  await speaks(ws, ['ja', 'zh']);
  await assert.rejects(run('guide', { place: '東京' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /en\.wikivoyage\.org answered 503/);
  assert.deepEqual(voyageHosts(asked), ['en.wikivoyage.org 東京']);
  asked.length = 0;
  await assert.rejects(run('guide', { place: '東京' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /ja\.wikivoyage\.org answered 503/);
  assert.deepEqual(voyageHosts(asked), ['en.wikivoyage.org 東京', 'ja.wikivoyage.org 東京'], 'Chinese, after Japanese, is not asked');
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
  assert.deepEqual(rows.slice(1, -2).map((r) => r.split('\t')[0]), ['McWay Falls', 'McWay Falls Overlook']);
  assert.match(rows[1], /\twikipedia\tMcWay Falls is an 80-foot waterfall .*State Park\. https:\/\/en\.wikipedia\.org\/wiki\/McWay_Falls$/);
  assert.deepEqual(rows.slice(-2), ['From the offline pack (downloaded 2026-10-16).', HOLDS]);
  const food = await run('nearby', { ...McWay, radius: 1000, kinds: ['food'] }, nothing);
  assert.deepEqual(food.split('\n').slice(1, -2).map((r) => r.split('\t')[0]), ['McWay Falls', 'Julia Pfeiffer Burns cafe']);
});

test("past the pack's edge nearby asks the services, and the pack fills in for any that don't answer, saying so", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const wiki = geo(['Partington Cove', 36.175, -121.69]);
  const online = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? { elements: [] } : wiki));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
  assert.doesNotMatch(online, /offline pack/);
  const down = await run('nearby', { ...McWay, radius: 8000 }, () => { throw new Error("annai couldn't reach overpass-api.de. Is the device offline?"); });
  assert.match(down, /\nOpenStreetMap and Wikipedia didn't answer, so these come from the offline pack \(downloaded 2026-10-16\)\.\nThe offline pack holds each edition's nearest 20 /);
  assert.match(down, /McWay Falls Overlook/);
  const half = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? new Response('', { status: 504 }) : wiki));
  assert.match(half, /Partington Cove/);
  assert.match(half, /\nOpenStreetMap is busy, so its places come from the offline pack \(downloaded 2026-10-16\)\.$/);
  const busyBoth = await run('nearby', { ...McWay, radius: 8000 }, () => new Response('', { status: 504 }));
  assert.ok(busyBoth.endsWith(`\nOpenStreetMap is busy and Wikipedia didn't answer, so these come from the offline pack (downloaded 2026-10-16).\n${HOLDS}`));
  // Outside the pack, with both services down, it says so as before.
  await assert.rejects(run('nearby', { lat: 36.6, lng: -121.9 }, () => { throw new Error('offline'); }), /Neither OpenStreetMap nor Wikipedia answered/);
});

test('guide reads the pack first: by its title or by a name that led to it, never by its title without "(California)", which online never matches; a section too', async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  assert.equal(await run('guide', { place: 'Cambria (California)' }, nothing), 'Cambria (California) (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nCambria is a town.\n\nSections: See. Ask for one with section.');
  assert.equal(await run('guide', { place: 'cambria, california', section: 'see' }, nothing), 'Cambria (California): See (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nMoonstone Beach.');
  assert.match(await run('guide', { place: 'Hearst Castle' }, nothing), /^San Simeon \(English Wikivoyage, offline pack of 2026-10-16\)/);
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (English Wikivoyage) https://en.wikivoyage.org/wiki/Big_Sur\n\nBig Sur is a region.');
  // "Cambria" alone is neither its title nor a name that led to it: the tool asks online, as without a pack, where English decides what it means.
  const before = asked.length;
  await run('guide', { place: 'Cambria' }, () => ({ query: { pages: [{ title: 'Cambria', missing: true }] } })).catch(() => {});
  assert.ok(asked.length > before, 'asked online');
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
  assert.match(await run('guide', { place: 'Cambria (California)', section: '観る' }, nothing), /^カンブリア: 観る \(Japanese Wikivoyage, offline pack of 2026-10-16\)/);
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
  assert.match(await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing), /\nFrom the offline pack \(downloaded 2026-10-18\)\.\nThe offline pack holds /);
  await ws.write(id, '/offline/pack.json', JSON.stringify({ ...m, at: '' }), { author: 'system' });
  assert.match(await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing), /\nFrom the offline pack\.\nThe offline pack holds /);
  assert.match(await run('guide', { place: 'Cambria (California)' }, nothing), /^Cambria \(California\) \(English Wikivoyage, offline pack\) https:\/\/en\.wikivoyage\.org\/wiki\/Cambria_%28California%29\n/);
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
  assert.ok((await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing, offline)).endsWith(`McWay Falls Overlook\tviewpoint\t58\t36.1585\t-121.6722\tosm\t\nFrom the offline pack (downloaded 2026-10-16).\n${HOLDS}`));
  const edge = await run('nearby', { ...McWay, radius: 8000 }, nothing, offline);
  assert.match(edge, /McWay Falls Overlook/);
  assert.ok(edge.endsWith(`\nFrom the offline pack (downloaded 2026-10-16), which holds only part of this circle. Kokoro can look further.\n${HOLDS}`));
  assert.equal(await run('nearby', { lat: 36.6, lng: -121.9 }, nothing, offline), 'Not in the offline pack: ask Kokoro.');
  assert.match(await run('guide', { place: 'Cambria (California)' }, nothing, offline), /offline pack of 2026-10-16/);
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
  // English not answering ends it with its error; a list seen, then an edition that doesn't answer, is still the list, with that edition named after it.
  await speaks(ws, ['ja']);
  await assert.rejects(run('guide', { place: '京都' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /en\.wikivoyage\.org answered 503/);
  await speaks(ws, ['ja', 'zh']);
  assert.match(await run('guide', { place: '京都' }, (url) => (url.includes('zh.wikivoyage') ? new Response('', { status: 503 }) : voyage(url))), /^京都 names several places: 京都 \(Japanese Wikivoyage\)[\s\S]*\nzh\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
});

test("guide: a disambiguation page with an empty extract is still the list, not 'no article' that would send another edition's meaning after it", async () => {
  const { run, ws } = await setup();
  const empty = { batchcomplete: true, query: { redirects: [{ from: 'Georgia', to: 'Georgia (disambiguation)' }], pages: [{ pageid: 1, ns: 0, title: 'Georgia (disambiguation)', extract: '', pageprops: { disambiguation: '' } }] } };
  const german = (/** @type {string} */ url) => (url.includes('de.wikivoyage') ? { query: { pages: [{ ns: 0, title: 'Georgia', extract: 'Georgia ist ein Bundesstaat der USA.' }] } } : empty);
  await speaks(ws, ['de']);
  const out = await run('guide', { place: 'Georgia' }, german);
  assert.match(out, /^Georgia names several places: Georgia \(disambiguation\) \(English Wikivoyage\)/);
  assert.doesNotMatch(out, /German|Bundesstaat|no article/);
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
  // English, which gives the titles, doesn't answer: the pack's English part, and a line naming the edition the pack lacks, not the host that was never asked.
  const down = await run('guide', { place: 'Cambria (California)' }, () => new Response('', { status: 503 }));
  assert.equal(down, "Cambria (California) (English Wikivoyage, offline pack of 2026-10-16) https://en.wikivoyage.org/wiki/Cambria_%28California%29\n\nCambria is a town.\n\nSections: See. Ask for one with section.\nJapanese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download.");
  // Japanese alone doesn't: the same, its pack part there being none.
  const jaDown = await run('guide', { place: 'Cambria (California)' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : cambria(url)));
  assert.match(jaDown, /^Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)[\s\S]*\nja\.wikivoyage\.org didn't answer, so this has no part from it\.$/);
  // The page the pack's guide has is gone: its links don't come, and the line says the edition is lacking. A page with no link there: the pack's part alone, no request for what isn't linked.
  assert.match(await run('guide', { place: 'Hearst Castle' }, (url) => (url.includes('opensearch') ? ['x', []] : { query: { pages: [{ title: 'Hearst Castle', missing: true }] } })), /^San Simeon \(English Wikivoyage, offline pack of 2026-10-16\)[^\n]*\n\nSan Simeon is home to Hearst Castle\.\nJapanese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download\.$/);
  assert.match(await run('guide', { place: 'Hearst Castle' }, () => ({ query: { pages: [{ title: 'San Simeon', extract: 'x' }] } })), /^San Simeon \(English Wikivoyage, offline pack of 2026-10-16\)[^\n]*\n\nSan Simeon is home to Hearst Castle\.$/);
  // Offline (Koe's quick reads): never a request, and the line names what the pack lacks.
  asked.length = 0;
  assert.match(await run('guide', { place: 'Cambria (California)' }, nothing, { offline: true }), /offline pack of 2026-10-16\)[\s\S]*\nJapanese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download\.$/);
  assert.equal(asked.length, 0);
  await speaks(ws, ['ja', 'zh']);
  assert.match(await run('guide', { place: 'Cambria (California)' }, nothing, { offline: true }), /\nJapanese and Chinese Wikivoyage aren't in the offline pack yet; they come with the pack's next download\.$/);
  // A pack that asked Japanese and holds no guide there is today's: its English, with no request and no line.
  await packAsked(ws, id, ['en', 'ja', 'zh']);
  const held = await run('guide', { place: 'Cambria (California)' }, nothing);
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

test("guide: each edition's part from the pack where it holds one, whatever happens online: an edition added is the only one read, the others' hosts are not asked, and English (which gives the titles) not answering leaves the edition added named as lacking", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  const id = /** @type {string} */ (trip);
  await packAsked(ws, id, ['en', 'ja']);
  await ws.write(id, guideFile('Cambria (California)', 'ja').path, JSON.stringify({ title: 'カンブリア', text: 'カンブリアは海辺の町。' }), { author: 'system' });
  const m = JSON.parse(String(await ws.readText(id, '/offline/pack.json')));
  m.guides[0].also = [{ edition: 'ja', title: 'カンブリア' }];
  await ws.write(id, '/offline/pack.json', JSON.stringify(m), { author: 'system' });
  await speaks(ws, ['ja', 'zh']); // Chinese added
  const zh = (/** @type {string} */ url) => (url.includes('zh.wikivoyage') ? { query: { pages: [{ title: '坎布里亞', extract: '坎布里亞是海邊小鎮。' }] } } : { query: { pages: [{ title: 'Cambria (California)', extract: 'x', langlinks: [{ lang: 'ja', title: 'カンブリア' }, { lang: 'zh', title: '坎布里亞' }] }] } });
  const out = await run('guide', { place: 'Cambria (California)' }, zh);
  assert.deepEqual(out.split('\n\n').filter((l) => /wikivoyage\.org\/wiki/.test(l)).map((l) => l.split(' https')[0]), ['カンブリア (Japanese Wikivoyage, offline pack of 2026-10-16)', '坎布里亞 (Chinese Wikivoyage)', 'Cambria (California) (English Wikivoyage, offline pack of 2026-10-16)']);
  assert.deepEqual(voyageReads(asked), ['en.wikivoyage.org Cambria (California) links', 'zh.wikivoyage.org 坎布里亞 text'], 'Japanese and English are not asked: the pack holds them');
  // Japanese Wikivoyage down changes nothing: its part is the pack's. English down, which gives the titles: Chinese is named, the pack's parts stay.
  asked.length = 0;
  assert.match(await run('guide', { place: 'Cambria (California)' }, (url) => (url.includes('ja.wikivoyage') ? new Response('', { status: 503 }) : zh(url))), /^カンブリア \(Japanese Wikivoyage, offline pack of 2026-10-16\)[\s\S]*坎布里亞 \(Chinese Wikivoyage\)[\s\S]*Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)[^\n]*\n\n[^\n]*\n\nSections: See\. Ask for one with section\.$/);
  const enDown = await run('guide', { place: 'Cambria (California)' }, (url) => (url.includes('en.wikivoyage') ? new Response('', { status: 503 }) : zh(url)));
  assert.match(enDown, /^カンブリア \(Japanese Wikivoyage, offline pack of 2026-10-16\)[\s\S]*Cambria \(California\) \(English Wikivoyage, offline pack of 2026-10-16\)[\s\S]*\nChinese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download\.$/);
  assert.doesNotMatch(enDown, /didn't answer/, 'zh was never asked, and English is the pack\'s part');
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

/**
 * Wikivoyage's editions as tables of pages (voyageWorld: the shapes of the real answers, 2026-11-20; what the pages say is made up), for a pack
 * downloaded from them and for the guide tool asking them online.
 */
const WORLD = {
  en: {
    Taiwan: { links: { zh: '臺灣' }, text: 'Taiwan is an island country.\n\n== Understand ==\nHistory.' },
    Kashmir: { text: 'Kashmir is a region of South Asia.\n\n== See ==\nDal Lake.' },
    'Cambria (California)': { links: { ja: 'カンブリア' }, text: 'Cambria is a town.\n\n== See ==\nMoonstone Beach.' },
  },
  zh: { 台湾: { to: '臺灣' }, 臺灣: { en: 'Taiwan', text: '臺灣是東亞的島嶼。\n\n== 了解 ==\n歷史。' } },
  it: { Kashmir: { to: 'Jammu e Kashmir' }, 'Jammu e Kashmir': { en: 'Jammu and Kashmir', text: 'Il Jammu e Kashmir è un territorio.' } },
  ja: { カンブリア: { en: 'Cambria (California)', text: 'カンブリアは海辺の町。\n\n== 観る ==\nムーンストーン・ビーチ。' } },
};
/** The trip's pack as a download from WORLD leaves it, for these places and editions; the fetch it was made with, to refuse some of it. @param {any} ws @param {string} trip @param {string[]} places @param {string[]} editions @param {(url: string) => any} [answer] */
async function packFrom(ws, trip, places, editions, answer = voyageWorld(WORLD)) {
  await ws.patch(trip, '/trip.json', { places }, { author: 'user' });
  return downloadPack({ ws, scope: trip, fetch: async (/** @type {string} */ url) => { const a = answer(url); return a instanceof Response ? a : new Response(JSON.stringify(a)); }, version: '1', editions, gapMs: 0 });
}
const headings = (/** @type {string} */ out) => out.split('\n\n').filter((l) => /wikivoyage\.org\/wiki/.test(l)).map((l) => l.split(' https')[0].replace(/, offline pack of [\d-]+/, ''));

test("guide: a name in the traveller's script, with the pack, answers as without it: English's guide and the edition's page it links to, offline, with no request (台湾 for a Chinese reader)", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await speaks(ws, ['zh']);
  const m = await packFrom(ws, /** @type {string} */ (trip), ['台湾'], ['zh', 'en']);
  assert.deepEqual(m.guides.map((g) => [g.title, g.asked, g.also]), [['Taiwan', ['台湾'], [{ edition: 'zh', title: '臺灣' }]]]);
  const withPack = await run('guide', { place: '台湾' }, nothing);
  assert.deepEqual(headings(withPack), ['臺灣 (Chinese Wikivoyage)', 'Taiwan (English Wikivoyage)']);
  assert.equal(asked.length, 0);
  // Without the pack: the same two parts, in three requests (English by the name, Chinese by the name, English by the title Chinese links to).
  const bare = await setup();
  await speaks(bare.ws, ['zh']);
  const without = await bare.run('guide', { place: '台湾' }, voyageWorld(WORLD));
  assert.deepEqual(headings(without), headings(withPack));
  assert.equal(without.replace(/ https:\/\/\S+/g, ''), withPack.replace(/ https:\/\/\S+/g, '').replace(/, offline pack of [\d-]+/g, ''), 'the same answer, but where each part comes from');
  assert.deepEqual(voyageHosts(bare.asked), ['en.wikivoyage.org 台湾', 'zh.wikivoyage.org 台湾', 'en.wikivoyage.org Taiwan']);
});

test("guide: a name English has a page for is English's alone for an Italian reader, with the pack and without it (Kashmir: Italian's Jammu e Kashmir is another place)", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await speaks(ws, ['it']);
  await packFrom(ws, /** @type {string} */ (trip), ['Kashmir'], ['it', 'en']);
  const withPack = await run('guide', { place: 'Kashmir' }, nothing);
  assert.deepEqual(headings(withPack), ['Kashmir (English Wikivoyage)']);
  assert.equal(asked.length, 0);
  const bare = await setup();
  await speaks(bare.ws, ['it']);
  const without = await bare.run('guide', { place: 'Kashmir' }, voyageWorld(WORLD));
  assert.equal(withPack.replace(/, offline pack of [\d-]+/, ''), without);
  assert.deepEqual(voyageHosts(bare.asked), ['en.wikivoyage.org Kashmir'], 'Italian is not asked');
});

test("guide: a guide's text that failed at the download is read online and named offline: the pack's link to the edition says it has the guide", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await speaks(ws, ['ja']);
  const text = (/** @type {string} */ url) => url.includes('ja.wikivoyage.org') && new URL(url).searchParams.get('prop') === 'extracts';
  const m = await packFrom(ws, /** @type {string} */ (trip), ['Cambria (California)'], ['ja', 'en'], (url) => (text(url) ? new Response('', { status: 503 }) : voyageWorld(WORLD)(url)));
  assert.deepEqual(m.guides.map((g) => [g.title, g.also]), [['Cambria (California)', [{ edition: 'ja', title: 'カンブリア' }]]]);
  assert.deepEqual(m.voyage, ['en', 'ja']);
  // Online: Japanese by the title English links to; English's text is not read again.
  const online = await run('guide', { place: 'Cambria (California)' }, voyageWorld(WORLD));
  assert.deepEqual(headings(online), ['カンブリア (Japanese Wikivoyage)', 'Cambria (California) (English Wikivoyage)']);
  assert.deepEqual(voyageReads(asked), ['en.wikivoyage.org Cambria (California) links', 'ja.wikivoyage.org カンブリア text']);
  // Offline: English's part and a line for the one that didn't come.
  asked.length = 0;
  const offline = await run('guide', { place: 'Cambria (California)' }, nothing, { offline: true });
  assert.deepEqual(headings(offline), ['Cambria (California) (English Wikivoyage)']);
  assert.match(offline, /\nJapanese Wikivoyage isn't in the offline pack yet; it comes with the pack's next download\.$/);
  assert.equal(asked.length, 0);
});

test("guide: an edition the pack holds after a guides pass that was stopped is not lacking, though the pass never reached its end: its part comes from the pack, with no line and no request", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await speaks(ws, ['ja']);
  await packFrom(ws, /** @type {string} */ (trip), ['Cambria (California)'], ['ja', 'en']);
  // The pass stopped before its end: voyage is as an older pass left it.
  await ws.patch(/** @type {string} */ (trip), '/offline/pack.json', { voyage: ['en'] }, { author: 'system' });
  const out = await run('guide', { place: 'Cambria (California)' }, nothing);
  assert.deepEqual(headings(out), ['カンブリア (Japanese Wikivoyage)', 'Cambria (California) (English Wikivoyage)']);
  assert.doesNotMatch(out, /isn't in the offline pack/);
  assert.equal(asked.length, 0);
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
