import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPack, readManifest, failWords, MANIFEST, pathOf, STALE_MS } from '../../src/core/pack/download.js';
import { planFor, MAX_GUIDES } from '../../src/core/pack/plan.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { loadPack, packNamer } from '../../src/core/pack/read.js';
import { readFile } from 'node:fs/promises';
import { packTrip, services, overpass, STOPS, YUFUIN, YUFUIN_WIKI, yufuinStop, yufuinAnswer } from './pack-kit.js';

const V = '9.9.9';
/** English alone, as before editions. */
const EN = ['en'];
const files = async (/** @type {any} */ ws, /** @type {string} */ trip) => (await ws.list(trip, '/offline/')).map((/** @type {any} */ f) => f.path).sort();
const body = (/** @type {any} */ a) => decodeURIComponent(String(a.init.body ?? '')).replace(/\+/g, ' ');
/** The Overpass servers a download asked, each once, in the order first asked. @param {{ url: string }[]} asked */
const overpassHosts = (asked) => [...new Set(asked.filter((a) => a.url.endsWith('/api/interpreter')).map((a) => new URL(a.url).hostname))];
/** Turns Settings → Tools → "Also ask VK's server" on, as its tick saves it. @param {any} ws */
const vkOn = (ws) => updateAppSettings(ws, { places: { vkOverpass: true } });

test('each part once, a moment apart, into named files; the guides by name only', async () => {
  const { ws, trip } = await packTrip();
  const { fetch, asked } = services();
  /** @type {any[]} */
  const progress = [];
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: EN, gapMs: 20, onProgress: (p) => progress.push(p) });
  const plan = await planFor(ws, trip);
  assert.equal(plan.parts.length, 5); // around both stops and along the way; Wikipedia at both stops
  assert.equal(m.key, plan.key);
  assert.deepEqual(m.failed, []);
  assert.equal(m.stopped, false);
  assert.equal(m.full, false);
  const paths = await files(ws, trip);
  assert.equal(paths.filter((p) => p.startsWith('/offline/osm/')).length, 3);
  assert.equal(paths.filter((p) => p.startsWith('/offline/wikipedia/')).length, 2);
  assert.equal(paths.filter((p) => p.startsWith('/offline/wikivoyage/')).length, 2);
  assert.ok(paths.includes(MANIFEST));
  // In the order of their names: the plan's, then Wikipedia's nearest first (Cambria's stand-in article is 1.4 km from Nepenthe).
  assert.deepEqual(m.guides.map((g) => [g.title, g.asked]), [['Cambria (California)', ['Cambria, California']], ['Big Sur', ['Big Sur']]]);
  assert.equal(m.files.length, 7);
  assert.equal(m.bytes, m.files.reduce((n, f) => n + f.bytes, 0));
  assert.equal(m.places, 5); // each place once, though the areas overlap
  assert.equal(m.summaries, 4);
  const overpassAsked = asked.filter((a) => a.url.includes('overpass')).map(body);
  assert.ok(overpassAsked.some((q) => q.includes('nwr(around:5000,36.3715,-121.9017)[amenity=toilets];')));
  assert.ok(overpassAsked.some((q) => q.includes('around:3000,36.3715,-121.9017,36.2213,-121.7567')));
  assert.ok(overpassAsked.every((q) => q.startsWith('data=[out:json][timeout:60];') && q.endsWith('out center tags 3000;')));
  for (const a of asked.filter((x) => x.url.startsWith('https://en.'))) assert.equal(a.init.headers['Api-User-Agent'], 'annai/9.9.9 (https://annai.guide)');
  for (const a of asked.filter((x) => x.url.includes('wikivoyage'))) assert.doesNotMatch(a.url, /coord|36\.\d|121\.\d/); // names, never a position (§11.7)
  for (let k = 1; k < asked.length; k++) assert.ok(asked[k].at - asked[k - 1].at >= 15, 'one request at a time, apart');
  const osm = JSON.parse(String(await ws.readText(trip, pathOf(plan.parts[0]))));
  assert.deepEqual(osm.area, { points: [[36.3715, -121.9017]], radius: 5000 });
  assert.deepEqual(osm.rows[0], ['n1', 'Bixby Bridge Vista Point', 'viewpoint', 36.3712, -121.902, '', 'sights']);
  assert.equal(progress.at(-1).done, progress.at(-1).total - 1);
  assert.deepEqual(await readManifest(ws, trip), m);
});

test('the next download asks only for what changed, and drops what the plan no longer needs', async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  const before = await files(ws, trip);
  const again = services();
  await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(again.asked.filter((a) => !a.url.includes('wikivoyage')), []);
  assert.deepEqual(await files(ws, trip), before);
  await ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { name: 'Nepenthe', lat: 36.1, lng: -121.65 } }, { author: 'user' });
  const moved = services();
  const m = await downloadPack({ ws, scope: trip, fetch: moved.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(moved.asked.filter((a) => a.url.includes('overpass')).length, 2); // around the new Nepenthe, and the way to it
  const after = await files(ws, trip);
  const plan = await planFor(ws, trip);
  assert.deepEqual(after.filter((p) => !p.includes('wikivoyage') && p !== MANIFEST), plan.parts.map((p) => pathOf(p)).sort());
  assert.equal(m.key, plan.key);
});

test("the VK switch off: a part asks overpass-api.de, then z., then lz4., each only after the one before refuses, and a refusal by all is a failure that names the last", async () => {
  const { ws, trip } = await packTrip();
  const { fetch, asked } = services({ overpass: () => new Response('', { status: 504 }) });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: EN, gapMs: 0, busyMs: 1 });
  assert.deepEqual(overpassHosts(asked), ['overpass-api.de', 'z.overpass-api.de', 'lz4.overpass-api.de']);
  assert.deepEqual(asked.filter((a) => a.url.endsWith('/api/interpreter')).slice(0, 3).map((a) => new URL(a.url).hostname), ['overpass-api.de', 'z.overpass-api.de', 'lz4.overpass-api.de'], 'in turn, for the first part');
  assert.equal(m.failed[0].why, "OpenStreetMap didn't answer (lz4.overpass-api.de answered 504).");
});

test("a part's answer from overpass-api.de is the only request for it; after its 502 the next server is asked, and its answer is used", async () => {
  const { ws, trip } = await packTrip();
  /** @type {string[]} */
  const log = [];
  const { fetch } = services({
    overpass: (url, init) => {
      const host = new URL(url).hostname;
      log.push(host);
      // overpass-api.de refuses the second part's request at once (its 502 "Timeout"); z. answers it.
      return host === 'overpass-api.de' && log.length === 2 ? new Response('Timeout', { status: 502 }) : overpass(url, init);
    },
  });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: EN, gapMs: 0, busyMs: 1 });
  assert.deepEqual(log, ['overpass-api.de', 'overpass-api.de', 'z.overpass-api.de', 'overpass-api.de'], 'z. only after the refusal; the next part asks overpass-api.de first again');
  assert.deepEqual(m.failed, []);
});

test("the VK switch on: maps.mail.ru, with the same query, when overpass-api.de fails; a part that fails is noted, and the rest goes on", async () => {
  const { ws, trip } = await packTrip();
  await vkOn(ws);
  const { fetch, asked } = services({
    overpass: (url, init) => {
      if (url.includes('overpass-api.de')) return new Response('', { status: 429 });
      return body({ init }).includes('around:3000') ? new Response('', { status: 504 }) : overpass(url, init);
    },
  });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: EN, gapMs: 0, busyMs: 1 });
  assert.deepEqual(overpassHosts(asked), ['overpass-api.de', 'z.overpass-api.de', 'lz4.overpass-api.de', 'maps.mail.ru'], 'VK after the three, in turn');
  const vk = asked.filter((a) => a.url === 'https://maps.mail.ru/osm/tools/overpass/api/interpreter');
  assert.equal(vk.length, 3, 'once a part');
  assert.deepEqual(new Set(vk.map(body)), new Set(asked.filter((a) => a.url.includes('overpass-api.de')).map(body)), 'the queries overpass-api.de and its servers were asked');
  // The log's English, and what the panel makes its words from (localization L5h): which part, and what went wrong, as data.
  assert.deepEqual(m.failed, [{
    label: 'OpenStreetMap between Bixby Creek Bridge and Nepenthe', why: "OpenStreetMap didn't answer (maps.mail.ru answered 504).",
    part: { source: 'osm', place: { how: 'between', names: ['Bixby Creek Bridge', 'Nepenthe'] } },
    said: { code: 'osm', inner: { code: 'status', where: 'maps.mail.ru', status: 504 }, message: 'maps.mail.ru answered 504' },
  }]);
  assert.deepEqual((await readManifest(ws, trip))?.failed, m.failed, 'kept as it was written');
  assert.equal(m.stopped, false);
  assert.equal(m.files.filter((f) => f.kind === 'osm').length, 2);
  assert.deepEqual(JSON.parse(String(await ws.readText(trip, pathOf((await planFor(ws, trip)).parts[0])))).rows[0], ['n1', 'Bixby Bridge Vista Point', 'viewpoint', 36.3712, -121.902, '', 'sights']);
  assert.equal(m.guides.length, 2);
});

test('no connection, broken answers and refusals are failures that say so, never crashes; a source that is down costs the others nothing', async () => {
  const { ws, trip } = await packTrip();
  const offline = services({ overpass: () => { throw new Error("annai couldn't reach overpass-api.de. Is the device offline?"); } });
  const m = await downloadPack({ ws, scope: trip, fetch: offline.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(m.failed.length, 3); // the plan's three OpenStreetMap parts
  assert.equal(m.stopped, true);
  assert.match(m.failed[0].why, /^OpenStreetMap didn't answer \(annai couldn't reach overpass-api\.de\. Is the device offline\?\)\.$/);
  // Overpass being down says nothing of Wikipedia: its parts came.
  assert.equal(offline.asked.filter((a) => a.url.includes('wikipedia')).length, 2);
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, 2);
  const broken = services({
    overpass: () => new Response('<html>Overpass is busy</html>'),
    wikipedia: () => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }),
  });
  const b = await downloadPack({ ws, scope: trip, fetch: broken.fetch, version: V, editions: EN, gapMs: 0 });
  assert.match(b.failed[0].why, /overpass-api\.de sent an answer annai can't read/);
  const remark = services({ overpass: () => ({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' }) });
  const r = await downloadPack({ ws, scope: trip, fetch: remark.fetch, version: V, editions: EN, gapMs: 0 });
  assert.match(r.failed[0].why, /stopped early: runtime error: Query timed out/);
  const wiki = services({ overpass: () => ({ elements: [] }), wikipedia: () => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }) });
  const other = await packTrip(); // the first run saved Wikipedia's parts in this one
  const w = await downloadPack({ ws: other.ws, scope: other.trip, fetch: wiki.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(w.failed.map((f) => f.why), ['Wikipedia said: Waiting for a database server.', 'Wikipedia said: Waiting for a database server.']);
});

test('stopping keeps what came, and the next download goes on from there', async () => {
  const { ws, trip } = await packTrip();
  const abort = new AbortController();
  const first = services();
  const m = await downloadPack({ ws, scope: trip, fetch: first.fetch, version: V, editions: EN, gapMs: 10, signal: abort.signal, onProgress: (p) => { if (p.done === 2) abort.abort(); } });
  assert.equal(m.stopped, true);
  assert.equal(m.files.length, 2);
  assert.equal(m.failed.length, 0);
  const next = services();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(next.asked.filter((a) => !a.url.includes('wikivoyage')).length, 3);
  assert.equal(n.files.length, 7);
  assert.equal(n.stopped, false);
});

test('the pack stops at its size limit and says so', async () => {
  const { ws, trip } = await packTrip();
  const m = await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0, maxBytes: 600 });
  assert.equal(m.full, true);
  assert.ok(m.bytes <= 600);
  assert.ok(m.files.length < 7);
});

test('parts a month old are downloaded again, and kept as they were when that fails', async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  const later = () => Date.now() + STALE_MS + 86_400_000;
  const fresh = services();
  await downloadPack({ ws, scope: trip, fetch: fresh.fetch, version: V, editions: EN, gapMs: 0, now: later });
  assert.equal(fresh.asked.filter((a) => a.url.includes('overpass')).length, 3);
  const before = await files(ws, trip);
  const contents = async () => Object.fromEntries(await Promise.all(before.filter((p) => p !== MANIFEST).map(async (p) => [p, await ws.readText(trip, p)])));
  const was = await contents();
  const down = services({ overpass: () => new Response('', { status: 503 }), wikipedia: () => new Response('', { status: 503 }) });
  const m = await downloadPack({ ws, scope: trip, fetch: down.fetch, version: V, editions: EN, gapMs: 0, now: () => later() + STALE_MS + 86_400_000 });
  assert.equal(m.stopped, true);
  assert.deepEqual(await files(ws, trip), before);
  assert.deepEqual(await contents(), was, 'every file as it was, not only the same names');
  assert.equal(m.files.length, 7);
});

test("a service that doesn't answer in time is a failure that says so; a stop while waiting is a stop", async () => {
  const { ws, trip } = await packTrip();
  const hang = (/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const slow = services({ overpass: hang });
  const m = await downloadPack({ ws, scope: trip, fetch: slow.fetch, version: V, editions: EN, gapMs: 0, answerMs: 30 });
  assert.equal(m.failed[0].why, "OpenStreetMap didn't answer (lz4.overpass-api.de didn't answer in time).");
  assert.equal(m.stopped, true); // three in a row
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 30);
  const stopped = await downloadPack({ ws, scope: trip, fetch: services({ overpass: hang }).fetch, version: V, editions: EN, gapMs: 0, signal: abort.signal });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.failed, []);
});

test("Overpass's 429 (too many requests) is waited out once before the other server is asked (the VK switch on): an answer then, and maps.mail.ru isn't asked", async () => {
  const { ws, trip } = await packTrip();
  await vkOn(ws);
  let busy = 1;
  const { fetch, asked } = services({ overpass: (url, init) => (url.includes('overpass-api.de') && busy-- > 0 ? new Response('', { status: 429 }) : { elements: [] }) });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: EN, gapMs: 0, busyMs: 40 });
  const first = asked.filter((a) => a.url.includes('overpass')).slice(0, 2);
  assert.deepEqual(first.map((a) => new URL(a.url).hostname), ['overpass-api.de', 'overpass-api.de']);
  assert.ok(first[1].at - first[0].at >= 35, 'it waited');
  assert.deepEqual(overpassHosts(asked), ['overpass-api.de']);
  assert.deepEqual(m.failed, []);
});

const wikiHosts = (/** @type {{ url: string }[]} */ asked) => asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname);

test("Japanese and English listed: each edition's nearest rows in a file of its own, with their Wikidata ids, merged where they are read; a reorder downloads nothing", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const first = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  const m = await downloadPack({ ws, scope: trip, fetch: first.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(wikiHosts(first.asked), ['ja.wikipedia.org', 'en.wikipedia.org']);
  for (const a of first.asked.filter((x) => x.url.includes('wikipedia.org'))) assert.equal(a.init.headers['Api-User-Agent'], 'annai/9.9.9 (https://annai.guide)');
  // The request as Wikipedia's API takes it (MediaWiki's paraminfo, 2026-11-19): the nearest 20 within 10 km, with Wikidata ids and 400-character summaries.
  for (const a of first.asked.filter((x) => x.url.includes('wikipedia.org'))) {
    const u = new URL(a.url).searchParams;
    assert.deepEqual([u.get('generator'), u.get('ggscoord'), u.get('ggsradius'), u.get('ggslimit'), u.get('prop'), u.get('ppprop'), u.get('exlimit'), u.get('exchars'), u.get('colimit')],
      ['geosearch', '33.2627|131.3553', '10000', '20', 'extracts|coordinates|pageprops', 'wikibase_item', '20', '400', '20']);
  }
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  // English's file where it was before editions; another edition's beside it, each named in the manifest with its edition.
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia').map((f) => [f.path, f.edition, f.items]), [[`/offline/wikipedia/${part.id}.ja.json`, 'ja', 20], [`/offline/wikipedia/${part.id}.json`, 'en', 8]]);
  const ja = JSON.parse(String(await ws.readText(trip, pathOf(part, 'ja'))));
  const station = YUFUIN_WIKI.ja.query.pages.find((/** @type {any} */ p) => p.title === '由布院駅');
  assert.deepEqual(ja.pages.find((/** @type {any[]} */ r) => r[0] === '由布院駅'), ['由布院駅', 33.2626, 131.3551, station.extract.trim(), 'Q8060317']);
  // 20 and 8 summaries, two of them the same articles (由布院駅 is Yufuin Station, 由布院温泉 Yufuin Onsen): each counted once.
  assert.equal(m.summaries, 26);
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const titles = (/** @type {string[]} */ editions) => pack.pages(YUFUIN, 10_000, editions).map((r) => r[0]);
  assert.equal(titles(['ja', 'en']).length, 26);
  assert.ok(titles(['ja', 'en']).includes('由布院駅') && !titles(['ja', 'en']).includes('Yufuin Station'));
  assert.ok(titles(['en', 'ja']).includes('Yufuin Station') && !titles(['en', 'ja']).includes('由布院駅'));
  const ropeway = pack.pages(YUFUIN, 10_000, ['ja', 'en']).find((r) => r[0] === 'Beppu Ropeway');
  assert.match(String(ropeway?.[6]), / https:\/\/en\.wikipedia\.org\/wiki\/Beppu_Ropeway$/, "English's own article, linked on English Wikipedia");
  assert.match(String(pack.pages(YUFUIN, 10_000, ['ja', 'en']).find((r) => r[0] === '由布院駅')?.[6]), / https:\/\/ja\.wikipedia\.org\/wiki\/由布院駅$/);
  // Live mode's and the recap's name: the one the first edition gives.
  assert.equal(pack.name({ lat: 33.2626, lng: 131.3551 }, ['ja', 'en'])?.name, '由布院駅');
  assert.equal(pack.name({ lat: 33.2626, lng: 131.3551 }, ['en', 'ja'])?.name, 'Yufuin Station');
  // The recap's and Replay's namer: in the order the settings give.
  await updateAppSettings(ws, { languages: { spoken: ['ja'], answer: 'follow' } });
  assert.equal((await packNamer(ws, trip, 'en-US'))({ lat: 33.2626, lng: 131.3551 })?.name, '由布院駅');
  await updateAppSettings(ws, { languages: null });
  assert.equal((await packNamer(ws, trip, 'en-US'))({ lat: 33.2626, lng: 131.3551 })?.name, 'Yufuin Station');
  assert.equal((await packNamer(ws, trip, 'ja-JP'))({ lat: 33.2626, lng: 131.3551 })?.name, '由布院駅', "the phone's language, with none chosen");
  // The guides are still found by English Wikipedia's titles, never by Japanese ones: English Wikivoyage has no such guide.
  const titlesAsked = first.asked.filter((a) => a.url.includes('wikivoyage')).flatMap((a) => (new URL(a.url).searchParams.get('titles') ?? '').split('|'));
  assert.ok(titlesAsked.includes('Beppu Ropeway'), "an English-only Wikipedia article's title");
  assert.ok(titlesAsked.every((t) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t)));
  // Moving English first changes no file: nothing is asked of Wikipedia (nor of Overpass); the guides' names are looked up as ever.
  const again = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, editions: ['en', 'ja'], gapMs: 0 });
  assert.deepEqual(again.asked.filter((a) => !a.url.includes('wikivoyage')), []);
  // English alone again: the Japanese files go.
  await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, editions: ['en'], gapMs: 0 });
  assert.deepEqual((await files(ws, trip)).filter((p) => p.includes('/wikipedia/')), [pathOf(part)]);
});

test('the same article in two parts that overlap, in one edition here and another there, shows once', async () => {
  const east = { lat: 33.2627, lng: 131.441 }; // 8 km on: two Wikipedia parts, whose 10 km overlap
  const { ws, trip } = await packTrip({ '/plan/a.json': yufuinStop('Yufuin Station', YUFUIN, 1), '/plan/b.json': yufuinStop('East', east, 2) });
  // At the station, Japanese has 由布院駅 and English lacks it; 8 km on, the other way round. (The saved English answer has Yufuin Station there
  // too: the stand-in takes one article out of each part, so the dedupe is proven on an input made for it.)
  const { fetch } = services({
    overpass: () => ({ elements: [] }),
    wikipedia: (url) => (url.includes('ggscoord=33.2627%7C131.3553') ? yufuinAnswer(url, ['Yufuin Station']) : yufuinAnswer(url, ['由布院駅'])),
  });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, 4);
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const rows = pack.pages(YUFUIN, 10_000, ['ja', 'en']).map((r) => r[0]);
  assert.equal(rows.filter((t) => t === '由布院駅' || t === 'Yufuin Station').length, 1);
  assert.ok(rows.includes('由布院駅'));
  assert.equal(rows.filter((t) => t === '由布院温泉' || t === 'Yufuin Onsen').length, 1, 'in both parts and both editions: once, under either title');
  assert.equal(m.summaries, 26);
});

test("a part one edition didn't answer is saved in the others, and only that edition is asked again", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const flaky = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => (url.includes('ja.wikipedia.org') ? new Response('', { status: 503 }) : yufuinAnswer(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: flaky.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed.map((f) => [f.label, f.why]), [['Wikipedia near Yufuin Station', 'ja.wikipedia.org answered 503.']]);
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  assert.deepEqual((await files(ws, trip)).filter((p) => p.includes('/wikipedia/')), [pathOf(part)], 'no file claims an edition it lacks');
  const next = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(next.asked), ['ja.wikipedia.org']);
  assert.deepEqual(n.failed, []);
  assert.equal(n.summaries, 26);
});

/** A pack today's main wrote (2026-11-18, the Big Sur trip of pack-kit.js, with main's downloadPack): its /offline/ files as they were. */
const BEFORE = /** @type {Record<string, string>} */ (JSON.parse(await readFile(new URL('../fixtures/places/pack-before-editions.json', import.meta.url), 'utf8')));

test('a pack written before editions: read as English; nothing asked for English alone; with Japanese listed its English parts come again with their ids, kept as they were till then', async () => {
  const { ws, trip } = await packTrip();
  for (const [path, text] of Object.entries(BEFORE)) await ws.write(trip, path, text, { author: 'system' });
  const now = () => Date.parse('2026-11-19T09:00:00Z');
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.match(String(pack.pages({ lat: 36.3715, lng: -121.9017 }, 2000, ['en'])[0][6]), / https:\/\/en\.wikipedia\.org\/wiki\/Bixby_Creek_Bridge$/);
  const wikiFiles = Object.keys(BEFORE).filter((p) => p.includes('/wikipedia/'));
  const unchanged = services();
  await downloadPack({ ws, scope: trip, fetch: unchanged.fetch, version: V, editions: ['en'], gapMs: 0, now });
  assert.deepEqual(unchanged.asked.filter((a) => !a.url.includes('wikivoyage')), []);
  for (const p of Object.keys(BEFORE).filter((x) => x !== MANIFEST)) assert.equal(await ws.readText(trip, p), BEFORE[p], p);
  // Japanese listed, and Wikipedia down: OpenStreetMap is not asked again, no guide's text is downloaded again (the names are looked up as ever), and the English parts stay as they were.
  const down = services({ wikipedia: () => new Response('', { status: 503 }) });
  const d = await downloadPack({ ws, scope: trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now });
  assert.deepEqual(down.asked.filter((a) => a.url.includes('overpass')), []);
  assert.deepEqual(down.asked.filter((a) => a.url.includes('wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts'), []);
  assert.equal(d.failed.length, 4); // the plan's two Wikipedia parts, in each of the two editions
  for (const p of wikiFiles) assert.equal(await ws.readText(trip, p), BEFORE[p], p);
  assert.ok(d.files.filter((f) => f.kind === 'wikipedia').every((f) => f.edition === undefined), 'still from before editions, so asked again next time');
  // Then they come: English's rows again, now with their ids, where they were.
  const up = services();
  const u = await downloadPack({ ws, scope: trip, fetch: up.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now });
  assert.deepEqual(wikiHosts(up.asked).sort(), ['en.wikipedia.org', 'en.wikipedia.org', 'ja.wikipedia.org', 'ja.wikipedia.org']);
  for (const p of wikiFiles) assert.ok(JSON.parse(String(await ws.readText(trip, p))).pages.every((/** @type {any[]} */ r) => typeof r[4] === 'string'), p);
  assert.deepEqual(u.files.filter((f) => f.kind === 'wikipedia').map((f) => f.edition).sort(), ['en', 'en', 'ja', 'ja']);
});

/** A request that never answers, until it is stopped. @param {string} _url @param {any} init */
const hangs = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
/** Stops 33 km apart: each its own Wikipedia part, and a part between. @param {number} n */
const farStops = (n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`/plan/s${k}.json`, yufuinStop(`Stop ${k}`, { lat: 33.2627 + k * 0.3, lng: 131.3553 }, k + 1)]));
const noOsm = () => ({ elements: [] });
/** The saved answers as if every part asked at the station: parts of one size, so a size limit can be counted in parts. @param {string} url */
const same = (url) => yufuinAnswer(url.replace(/ggscoord=[^&]+/, `ggscoord=${YUFUIN.lat}%7C${YUFUIN.lng}`));

test("a download that stopped before its manifest: the files it left keep the edition their path says and no file is read as another edition's; with no manifest at all English's file is asked again once, its ids not being known", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = () => services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url) });
  await downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: EN, gapMs: 0 });
  // Japanese listed; the page is closed after the files are written and before the manifest is.
  const anyWs = /** @type {any} */ (ws);
  const writeMany = anyWs.writeMany;
  anyWs.writeMany = async () => { throw new Error('the page closed'); };
  await assert.rejects(downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: ['ja', 'en'], gapMs: 0 }), /the page closed/);
  anyWs.writeMany = writeMany;
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  assert.ok((await files(ws, trip)).includes(pathOf(part, 'ja')), 'the Japanese file is there, the manifest still the English-only one');
  assert.deepEqual((await readManifest(ws, trip))?.files.filter((f) => f.kind === 'wikipedia').map((f) => f.edition), ['en']);
  // The next download keeps it as Japanese, and asks nothing of Wikipedia.
  const next = net();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(next.asked), []);
  assert.deepEqual(n.files.filter((f) => f.kind === 'wikipedia').map((f) => [f.path, f.edition]).sort(), [[pathOf(part), 'en'], [pathOf(part, 'ja'), 'ja']].sort());
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.match(String(pack.pages(YUFUIN, 10_000, ['ja', 'en']).find((r) => r[0] === '由布院駅')?.[6]), / https:\/\/ja\.wikipedia\.org\/wiki\/由布院駅$/);
  // No manifest at all: the Japanese file is still Japanese and kept; the English one's edition is unknown, so it is asked again, once.
  await ws.writeMany(trip, [{ path: MANIFEST, content: null }], { author: 'system' });
  const lost = net();
  const l = await downloadPack({ ws, scope: trip, fetch: lost.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(lost.asked), ['en.wikipedia.org']);
  assert.deepEqual(l.files.filter((f) => f.kind === 'wikipedia').map((f) => f.edition).sort(), ['en', 'ja']);
  const again = net();
  await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(again.asked), [], 'and then not again');
});

test('a pack made with English alone takes Japanese listed first: only Japanese is asked, and English stays as it is; listed second, the same', async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = () => services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url) });
  await downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: EN, gapMs: 0 });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const english = await ws.readText(trip, pathOf(part));
  const next = net();
  const m = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(next.asked), ['ja.wikipedia.org']);
  assert.equal(await ws.readText(trip, pathOf(part)), english);
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia').map((f) => f.edition).sort(), ['en', 'ja']);
  assert.equal(m.summaries, 26);
  // Listed second: Japanese is asked for all the same (and a pack that has it already asks nothing).
  const other = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  await downloadPack({ ws: other.ws, scope: other.trip, fetch: net().fetch, version: V, editions: EN, gapMs: 0 });
  const second = net();
  await downloadPack({ ws: other.ws, scope: other.trip, fetch: second.fetch, version: V, editions: ['en', 'ja'], gapMs: 0 });
  assert.deepEqual(wikiHosts(second.asked), ['ja.wikipedia.org']);
});

test("Wikipedia's parts come edition by edition in the reading order, every stop's part of one before the next's; a pack that fills up holds the first language at every stop and English at the stops it reaches", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 3);
  const net = () => services({ overpass: noOsm, wikipedia: same });
  const all = net();
  const m = await downloadPack({ ws, scope: trip, fetch: all.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  // By host and the point asked about: Japanese at every part in the plan's order, then English at every part in it.
  const asks = all.asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => `${new URL(a.url).hostname} ${new URL(a.url).searchParams.get('ggscoord')}`);
  assert.deepEqual(asks, [...['ja', 'en'].flatMap((e) => wikis.map((p) => `${e}.wikipedia.org ${p.at.join('|')}`))]);
  assert.equal(new Set(asks).size, 2 * wikis.length);
  const osmAfter = all.asked.findIndex((a) => a.url.includes('wikipedia.org'));
  assert.ok(all.asked.slice(0, osmAfter).every((a) => a.url.endsWith('/api/interpreter')) && osmAfter === 5, 'OpenStreetMap first');
  assert.deepEqual(m.failed, []);
  // A limit that holds the OpenStreetMap parts, every stop's Japanese and one English: not both languages at the first stops and nothing at the last.
  const size = (/** @type {string} */ edition) => m.files.filter((f) => f.kind === 'wikipedia' && f.edition === edition).map((f) => f.bytes);
  const limit = m.files.filter((f) => f.kind === 'osm').reduce((n, f) => n + f.bytes, 0) + size('ja').reduce((n, b) => n + b, 0) + Math.min(...size('en'));
  const small = await packTrip(farStops(3));
  const cut = await downloadPack({ ws: small.ws, scope: small.trip, fetch: net().fetch, version: V, editions: ['ja', 'en'], gapMs: 0, maxBytes: limit });
  assert.equal(cut.full, true);
  assert.ok(cut.bytes <= limit);
  assert.equal(cut.files.filter((f) => f.edition === 'ja').length, wikis.length, 'Japanese at every stop');
  assert.equal(cut.files.filter((f) => f.edition === 'en').length, 1, 'English at the stop it reaches');
  // The other way round: English at every stop, and Japanese at the stops it reaches.
  const english = await packTrip(farStops(3));
  const limitEn = m.files.filter((f) => f.kind === 'osm').reduce((n, f) => n + f.bytes, 0) + size('en').reduce((n, b) => n + b, 0) + Math.min(...size('ja'));
  const enFirst = await downloadPack({ ws: english.ws, scope: english.trip, fetch: net().fetch, version: V, editions: ['en', 'ja'], gapMs: 0, maxBytes: limitEn });
  assert.equal(enFirst.files.filter((f) => f.edition === 'en').length, wikis.length);
  assert.equal(enFirst.files.filter((f) => f.edition === 'ja').length, 1);
});

test("an edition whose host never answers is left after three parts in a row, so it costs three answer times, not one a part; the parts left are counted among those that didn't download, the other editions' parts all come, and with every source given up the guides are not looked for", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 4);
  const net = services({ overpass: noOsm, wikipedia: (url, init) => (url.includes('zh.wikipedia.org') ? hangs(url, init) : yufuinAnswer(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['zh', 'en'], gapMs: 0, answerMs: 30 });
  assert.equal(wikiHosts(net.asked).filter((h) => h === 'zh.wikipedia.org').length, 3);
  assert.equal(wikiHosts(net.asked).filter((h) => h === 'en.wikipedia.org').length, wikis.length);
  // The three late ones, and each part left after them with the failure that gave the edition up: the panel counts them all.
  assert.deepEqual(m.failed.map((f) => f.why), Array(wikis.length).fill("zh.wikipedia.org didn't answer in time."));
  assert.equal(new Set(m.failed.map((f) => f.label)).size, wikis.length, 'each part by its own name');
  assert.equal(m.files.filter((f) => f.edition === 'en').length, wikis.length);
  assert.equal(m.stopped, true, 'it gave up on one');
  // Everything given up on is the connection down: the guides are not looked for.
  const down = services({ overpass: () => new Response('', { status: 503 }), wikipedia: () => new Response('', { status: 503 }) });
  const offline = await packTrip(farStops(4));
  const d = await downloadPack({ ws: offline.ws, scope: offline.trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, busyMs: 1 });
  assert.equal(d.files.length, 0);
  assert.equal(down.asked.filter((a) => a.url.includes('wikivoyage')).length, 0);
});

const osmUrls = (/** @type {{ url: string }[]} */ asked) => asked.filter((a) => a.url.endsWith('/api/interpreter'));

test("a source that refuses is left after three parts in a row, the rest counted as parts that didn't download; a success between them starts the count over", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const plan = await planFor(ws, trip);
  const osmParts = plan.parts.filter((p) => p.kind === 'osm').length;
  assert.equal(osmParts, 7);
  // Every Overpass server refuses every part: the first three parts ask all three servers, the other four are never asked.
  const refusing = services({ overpass: () => new Response('', { status: 503 }), wikipedia: (url) => yufuinAnswer(url) });
  const m = await downloadPack({ ws, scope: trip, fetch: refusing.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(osmUrls(refusing.asked).length, 9);
  assert.equal(m.failed.length, osmParts, 'all seven are parts that didn\'t download');
  assert.equal(m.failed.filter((f) => f.said && f.part && 'place' in f.part && f.part.source === 'osm').length, osmParts, 'each with its part, for the panel');
  assert.equal(new Set(m.failed.map((f) => f.label)).size, osmParts);
  assert.equal(m.stopped, true);
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, plan.parts.filter((p) => p.kind === 'wikipedia').length, 'Wikipedia is another source');
  // Refused, refused, answered, refused, refused, answered, refused: never three in a row, so every part is asked.
  let n = 0;
  const flaky = services({ overpass: noOsm, wikipedia: (url) => ([3, 6].includes(++n) ? yufuinAnswer(url) : new Response('', { status: 503 })) });
  const other = await packTrip(farStops(4));
  const f = await downloadPack({ ws: other.ws, scope: other.trip, fetch: flaky.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(n, 7, 'every Wikipedia part asked');
  assert.equal(f.failed.length, 5);
  assert.equal(f.stopped, false);
});

test("an answer annai can't use (a query that timed out, an unreadable body, an error answer) fails its part only: the source is asked for every part, never left", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const plan = await planFor(ws, trip);
  const osmParts = plan.parts.filter((p) => p.kind === 'osm').length;
  const wikiParts = plan.parts.filter((p) => p.kind === 'wikipedia').length;
  // Overpass: every server says a query ran too long (HTTP 200 with a remark), for seven parts.
  const remark = services({ overpass: () => ({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' }), wikipedia: (url) => yufuinAnswer(url) });
  const m = await downloadPack({ ws, scope: trip, fetch: remark.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(osmUrls(remark.asked).length, 3 * osmParts, 'every part asked every server');
  assert.equal(m.failed.length, osmParts);
  assert.match(m.failed[0].why, /stopped early: runtime error: Query timed out/);
  assert.equal(m.stopped, false);
  assert.equal(m.files.filter((f) => f.kind === 'osm').length, 0);
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, wikiParts);
  // An answer that isn't JSON, from every server.
  const html = services({ overpass: () => new Response('<html>Overpass is busy</html>'), wikipedia: (url) => yufuinAnswer(url) });
  const second = await packTrip(farStops(4));
  const u = await downloadPack({ ws: second.ws, scope: second.trip, fetch: html.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(osmUrls(html.asked).length, 3 * osmParts);
  assert.equal(u.stopped, false);
  // Wikipedia: an error answer for every part.
  const maxlag = services({ overpass: noOsm, wikipedia: () => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }) });
  const third = await packTrip(farStops(4));
  const w = await downloadPack({ ws: third.ws, scope: third.trip, fetch: maxlag.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(wikiHosts(maxlag.asked).length, wikiParts);
  assert.equal(w.failed.length, wikiParts);
  assert.equal(w.stopped, false);
  // A part that fails this way between failures of another kind starts the count over: late, late, unreadable, late, late, unreadable, late asks every part.
  let k = 0;
  const mixed = services({ overpass: noOsm, wikipedia: (url, init) => ([3, 6].includes(++k) ? new Response('no') : hangs(url, init)) });
  const fourth = await packTrip(farStops(4));
  await downloadPack({ ws: fourth.ws, scope: fourth.trip, fetch: mixed.fetch, version: V, editions: EN, gapMs: 0, answerMs: 20 });
  assert.equal(k, wikiParts);
});

test("Wikivoyage is left after three guides in a row that fail: the others are not asked for", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikivoyage = (/** @type {string} */ url) => {
    const u = new URL(url);
    if (u.searchParams.get('prop') !== 'pageprops') return new Response('', { status: 503 });
    return { query: { pages: (u.searchParams.get('titles') ?? '').split('|').map((title) => ({ title })) } };
  };
  const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  const texts = net.asked.filter((a) => a.url.includes('wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts');
  assert.equal(texts.length, 3);
  // The three that failed, and each guide left after them with the failure that gave Wikivoyage up: the panel counts all twelve.
  assert.equal(m.failed.length, MAX_GUIDES);
  assert.equal(new Set(m.failed.map((f) => f.label)).size, MAX_GUIDES, 'each guide by its own name');
  assert.ok(m.failed.every((f) => /^Wikivoyage: /.test(f.label) && f.part && 'title' in f.part && f.said?.code === 'status' && /^Wikivoyage answered 503/.test(f.why)));
  assert.deepEqual(m.guides, []);
  assert.equal(m.stopped, true);
});

test("an answer cut off in its body is no answer: the source is left after three parts in a row, as one that never answers is", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia').length;
  assert.ok(wikis >= 4);
  const cutOff = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"query":')); c.error(new Error('connection reset')); } }));
  const net = services({ overpass: noOsm, wikipedia: cutOff });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(wikiHosts(net.asked).length, 3, 'three parts asked, then Wikipedia is left');
  assert.equal(m.failed.length, wikis, 'the three and the parts left, all counted');
  assert.equal(m.failed[0].why, "Wikipedia's answer was cut off.");
  assert.equal(m.stopped, true);
});

test("when every Overpass server was left (VK's switch turned off after the others gave up) a part says so in words, not (null)", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  await vkOn(ws);
  let vk = 0;
  // overpass-api.de and its two servers refuse; VK's answer is one annai can't read, so it is never given up and the source is not either.
  const net = services({
    overpass: async (url) => {
      if (!url.includes('maps.mail.ru')) return new Response('', { status: 503 });
      if (++vk === 3) await updateAppSettings(ws, { places: { vkOverpass: false } });
      return new Response('<html>busy</html>');
    },
  });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  const left = m.failed.filter((f) => /every server was left/.test(f.why));
  assert.ok(left.length > 0, 'the parts after the switch');
  assert.equal(left[0].why, "OpenStreetMap didn't answer (every server was left for the rest of the run).");
  assert.deepEqual(left[0].said, { code: 'osm', inner: null, message: null });
  assert.ok(m.failed.every((f) => !/null/.test(f.why)));
  assert.equal(failWords(/** @type {any} */ (left[0].said)), "OpenStreetMap didn't answer (every server was left for the rest of the run).");
});

test("an error answer to Wikivoyage's names lookup is a failure that says so, and no guide is looked for", async () => {
  const { ws, trip } = await packTrip();
  const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage: () => ({ error: { code: 'maxlag', info: 'Waiting for a database server.' } }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.failed.map((f) => f.why), ['Wikivoyage said: Waiting for a database server.']);
  assert.deepEqual(m.guides, []);
});

test("Overpass's 429 twice for one part fails that server for the part: the next is asked; a server that refuses or never answers three parts in a row is left, the others carry on", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  const parts = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'osm').length;
  assert.equal(parts, 5);
  // overpass-api.de says "too many requests" every time: each part waits once, asks again, is told so again, and z. answers.
  const busy = services({ overpass: (url, init) => (url.includes('//overpass-api.de') ? new Response('', { status: 429 }) : overpass(url, init)), wikipedia: (url) => yufuinAnswer(url) });
  const m = await downloadPack({ ws, scope: trip, fetch: busy.fetch, version: V, editions: EN, gapMs: 0, busyMs: 1 });
  assert.deepEqual(osmUrls(busy.asked).slice(0, 3).map((a) => new URL(a.url).hostname), ['overpass-api.de', 'overpass-api.de', 'z.overpass-api.de'], 'the first part');
  assert.equal(osmUrls(busy.asked).filter((a) => new URL(a.url).hostname === 'overpass-api.de').length, 6, 'three parts, twice each; then it is left');
  assert.equal(osmUrls(busy.asked).filter((a) => new URL(a.url).hostname === 'z.overpass-api.de').length, parts);
  assert.deepEqual(m.failed, []);
  assert.equal(m.files.filter((f) => f.kind === 'osm').length, parts);
  // Refused, refused, answered, refused, refused: never three in a row for it, so it is asked for every part.
  const third = await packTrip(farStops(3));
  let m429 = 0;
  const flaky = services({ overpass: (url, init) => (url.includes('//overpass-api.de') && ++m429 !== 3 ? new Response('', { status: 503 }) : overpass(url, init)), wikipedia: (url) => yufuinAnswer(url) });
  await downloadPack({ ws: third.ws, scope: third.trip, fetch: flaky.fetch, version: V, editions: EN, gapMs: 0, busyMs: 1 });
  assert.equal(osmUrls(flaky.asked).filter((a) => new URL(a.url).hostname === 'overpass-api.de').length, parts);
  // A server that never answers: asked three times (an answer time each), then left; z. answers every part.
  const second = await packTrip(farStops(3));
  const hung = services({ overpass: (url, init) => (url.includes('//overpass-api.de') ? hangs(url, init) : overpass(url, init)), wikipedia: (url) => yufuinAnswer(url) });
  const h = await downloadPack({ ws: second.ws, scope: second.trip, fetch: hung.fetch, version: V, editions: EN, gapMs: 0, answerMs: 20 });
  assert.equal(osmUrls(hung.asked).filter((a) => new URL(a.url).hostname === 'overpass-api.de').length, 3);
  assert.equal(osmUrls(hung.asked).filter((a) => new URL(a.url).hostname === 'z.overpass-api.de').length, parts);
  assert.deepEqual(h.failed, []);
  assert.equal(h.stopped, false);
});

/** A trip's pack for the size-limit tests: farStops(3), English alone, each part's size by its kind. @param {string[]} editions */
async function sizes(editions) {
  const t = await packTrip(farStops(3));
  const net = services({ overpass: (url, init) => overpass(url, init), wikipedia: same });
  const m = await downloadPack({ ws: t.ws, scope: t.trip, fetch: net.fetch, version: V, editions, gapMs: 0 });
  const total = (/** @type {(f: import('../../src/core/pack/download.js').PackFile) => boolean} */ pick) => m.files.filter(pick).reduce((n, f) => n + f.bytes, 0);
  return { m, osm: total((f) => f.kind === 'osm'), en: total((f) => f.edition === 'en'), ja: total((f) => f.edition === 'ja') };
}

test("a pack that filled up takes a language added first at its monthly refresh (the refresh as main's: the parts in the order until one no longer fits), and not before: a pack under a month old stays as it is", async () => {
  const net = () => services({ overpass: (url, init) => overpass(url, init), wikipedia: same });
  const english = await sizes(EN);
  const both = await sizes(['ja', 'en']);
  const parts = both.m.files.filter((f) => f.edition === 'en').length;
  assert.equal(parts, 5);
  const jaSize = both.ja / parts;
  // English alone just overflows: the last of its parts doesn't fit.
  const limit = english.osm + english.en - 1;
  const { ws, trip } = await packTrip(farStops(3));
  const first = await downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: EN, gapMs: 0, maxBytes: limit });
  assert.equal(first.full, true);
  assert.equal(first.files.filter((f) => f.edition === 'en').length, parts - 1);
  // Japanese listed first inside the month: nothing of it comes, the pack is full (a known limitation: it comes with the monthly refresh).
  const soon = await downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: ['ja', 'en'], gapMs: 0, maxBytes: limit });
  assert.equal(soon.files.filter((f) => f.edition === 'ja').length, 0);
  // A month on: OpenStreetMap, then Japanese at the stops it reaches (before any English); the old English copies stay.
  const later = () => Date.now() + STALE_MS + 86_400_000;
  const m = await downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: ['ja', 'en'], gapMs: 0, maxBytes: limit, now: later });
  const ja = m.files.filter((f) => f.edition === 'ja').length;
  assert.equal(ja, Math.floor((limit - english.osm) / jaSize), 'Japanese at as many stops as come before the first that does not fit');
  assert.ok(ja > 0 && ja < parts);
  assert.ok(m.files.filter((f) => f.edition === 'ja').every((f) => f.at > Date.now() + STALE_MS), 'the new copies');
  assert.equal(m.full, true);
});

test("a refresh at the size limit refreshes the parts in that order until one no longer fits, and keeps the old copy of that one and each after it, a guide's too: the pack can end over its limit by those", async () => {
  const { ws, trip } = await packTrip();
  const first = await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  const later = () => Date.now() + STALE_MS + 86_400_000;
  // A month on, everything is old, and OpenStreetMap has more around Bixby Bridge, the first part: its new copy is bigger, and 20 bytes of room don't hold the lot.
  const added = Array.from({ length: 6 }, (_, k) => ({ type: 'node', id: 90 + k, lat: 36.3, lon: -121.9, tags: { name: `A viewpoint added since ${k}`, tourism: 'viewpoint' } }));
  const more = services({ overpass: (url, init) => ({ elements: [...overpass(url, init).elements, ...(body({ init }).includes('around:5000,36.3715') ? added : [])] }) });
  const m = await downloadPack({ ws, scope: trip, fetch: more.fetch, version: V, editions: EN, gapMs: 0, now: later, maxBytes: first.bytes + 20 });
  assert.equal(m.full, true);
  const parts = m.files.filter((f) => f.kind !== 'wikivoyage');
  const renewed = parts.filter((f) => f.at > Date.now() + STALE_MS);
  assert.equal(parts.length, 5, 'every part is still there');
  assert.equal(renewed.length, 4, 'the parts came again in order, up to the last, whose new copy took the pack past its limit');
  assert.ok(renewed.some((f) => f.kind === 'wikipedia'), 'past the OpenStreetMap parts too');
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikivoyage').map((f) => f.path).sort(), m.guides.map((g) => g.path).sort());
  assert.equal(m.guides.length, first.guides.length, 'the guides stay as they were');
  assert.ok(m.bytes > first.bytes + 20, `${m.bytes}: the old copies of what did not fit are over the limit`);
  // The first part grown by far more than the room: the refresh stops at once, and the parts after it, which would fit, keep their old copies.
  const other = await packTrip();
  const was = await downloadPack({ ws: other.ws, scope: other.trip, ...services(), version: V, editions: EN, gapMs: 0 });
  const lots = Array.from({ length: 300 }, (_, k) => ({ type: 'node', id: 900 + k, lat: 36.3, lon: -121.9, tags: { name: `A viewpoint added since ${k}`, tourism: 'viewpoint' } }));
  const grown = services({ overpass: (url, init) => ({ elements: [...overpass(url, init).elements, ...(body({ init }).includes('around:5000,36.3715') ? lots : [])] }) });
  const s = await downloadPack({ ws: other.ws, scope: other.trip, fetch: grown.fetch, version: V, editions: EN, gapMs: 0, now: later, maxBytes: was.bytes + 20 });
  assert.equal(grown.asked.length, 1, 'only the first part was asked');
  assert.equal(s.files.filter((f) => f.kind !== 'wikivoyage' && f.at > Date.now() + STALE_MS).length, 0, 'none renewed');
  assert.equal(s.files.length, was.files.length, 'every old copy kept');
  assert.equal(s.bytes, was.bytes);
});

test("a guide that leads from another title (Hearst Castle to San Simeon) is found by the title it leads to, and asked by the name that led to it", async () => {
  const { ws, trip } = await packTrip({ '/plan/hearst.json': { id: 'hearst', title: 'Hearst Castle', fixed: false, start: { at: '2026-11-27T17:45:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Hearst Castle', lat: 35.6852, lng: -121.1668 } } });
  const net = services({ overpass: noOsm, wikipedia: () => ({ batchcomplete: true }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.guides.map((g) => [g.title, g.asked]), [['San Simeon', ['Hearst Castle']]]);
  assert.deepEqual(m.failed, []);
  assert.match(String(await ws.readText(trip, m.guides[0].path)), /San Simeon is a town/);
});

test("a Wikipedia article with no Wikidata item is kept with no id and counted once, by its title, whichever part it is in", async () => {
  const { ws, trip } = await packTrip();
  const page = { ns: 0, title: 'Bixby Creek Bridge', coordinates: [{ lat: 36.3715, lon: -121.9017 }], extract: 'A bridge.' };
  const { fetch } = services({ wikipedia: () => ({ query: { pages: [page] } }) });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(m.summaries, 1);
  const row = JSON.parse(String(await ws.readText(trip, m.files.find((f) => f.kind === 'wikipedia')?.path ?? ''))).pages[0];
  assert.deepEqual(row, ['Bixby Creek Bridge', 36.3715, -121.9017, 'A bridge.', null]);
});

test("a Chinese (Traditional) pack: zh.wikipedia.org's rows in a file of their own, named zh in the manifest, linked on Chinese Wikipedia; the article English also has is read under the language listed first", async () => {
  const shilin = { lat: 25.0879, lng: 121.5242 };
  const { ws, trip } = await packTrip({ '/plan/shilin.json': yufuinStop('Shilin Night Market', shilin, 1) });
  const saved = JSON.parse(await readFile(new URL('../fixtures/places/wiki-pack-shilin-zh.json', import.meta.url), 'utf8')); // the real answer of 2026-11-19
  // English Wikipedia's article of the same Wikidata item (Q697118, 士林夜市 in the real answer), its text made for the test.
  const english = { query: { pages: [{ ns: 0, title: 'Shilin Night Market', coordinates: [{ lat: 25.08522222, lon: 121.52472222, primary: true, globe: 'earth' }], pageprops: { wikibase_item: 'Q697118' }, extract: 'Shilin Night Market is a night market in Taipei.' }] } };
  const net = services({ overpass: noOsm, wikipedia: (url) => (url.includes('zh.wikipedia.org') ? saved : url.includes('en.wikipedia.org') ? english : { batchcomplete: true }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia').map((f) => [f.path, f.edition, f.items]), [[`/offline/wikipedia/${part.id}.zh.json`, 'zh', 20], [`/offline/wikipedia/${part.id}.json`, 'en', 1]]);
  assert.equal(m.summaries, 20, 'the night market in both editions, once');
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const rows = pack.pages(shilin, 10_000, ['zh', 'en']);
  assert.equal(rows.length, 20);
  assert.match(String(rows.find((r) => r[0] === '士林夜市')?.[6]), / https:\/\/zh\.wikipedia\.org\/wiki\/士林夜市$/);
  assert.ok(!rows.some((r) => r[0] === 'Shilin Night Market'), 'Chinese first');
  assert.equal(pack.name({ lat: 25.08522, lng: 121.52472 }, ['zh', 'en'])?.name, '士林夜市');
  // English first: its title, linked on English Wikipedia.
  const first = pack.pages(shilin, 10_000, ['en', 'zh']);
  assert.match(String(first.find((r) => r[0] === 'Shilin Night Market')?.[6]), / https:\/\/en\.wikipedia\.org\/wiki\/Shilin_Night_Market$/);
  assert.ok(!first.some((r) => r[0] === '士林夜市'));
  assert.equal(pack.name({ lat: 25.08522, lng: 121.52472 }, ['en', 'zh'])?.name, 'Shilin Night Market');
});
