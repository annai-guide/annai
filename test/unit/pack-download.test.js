import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPack, readManifest, failWords, partWords, guideFile, MANIFEST, pathOf, morePath, STALE_MS } from '../../src/core/pack/download.js';
import { planFor, packPlan } from '../../src/core/pack/plan.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { loadPack, packNamer } from '../../src/core/pack/read.js';
import { readFile } from 'node:fs/promises';
import { packTrip, services, overpass, wikivoyage as kitGuides, voyageWorld, STOPS, YUFUIN, YUFUIN_WIKI, yufuinStop, yufuinAnswer, yufuinWikipedia, wikidataOf, summariesFrom, LINKS, EDITION_GUIDES } from './pack-kit.js';

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
  assert.ok(!('full' in m), 'no size limit');
  assert.deepEqual(m.voyage, ['en']);
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
  // An article both lists hold: each edition's summary and address, in the order, joined.
  assert.match(String(pack.pages(YUFUIN, 10_000, ['ja', 'en']).find((r) => r[0] === '由布院駅')?.[6]), /^由布院駅（ゆふいんえき）は、.+ https:\/\/ja\.wikipedia\.org\/wiki\/由布院駅 · Yufuin Station \(由布院駅, Yufuin-eki\) is .+ https:\/\/en\.wikipedia\.org\/wiki\/Yufuin_Station$/);
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

test("a part one edition didn't answer is saved in the others, and only that edition is asked again; its second stage waits for it, counted with its failure", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const flaky = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => (url.includes('ja.wikipedia.org') ? new Response('', { status: 503 }) : yufuinAnswer(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: flaky.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  // The second stage needs both lists: it is left for the next run, counted as a part that didn't download with the failure that left it (a source
  // down, so the keeper brings it by itself as it brings the list), and Wikidata is not asked.
  assert.deepEqual(m.failed.map((f) => [f.label, f.why]), [['Wikipedia near Yufuin Station', 'ja.wikipedia.org answered 503.'], ["Wikipedia's other editions near Yufuin Station", 'ja.wikipedia.org answered 503.']]);
  assert.deepEqual(m.failed[1].said, m.failed[0].said);
  assert.deepEqual(m.failed[1].part, { source: 'wikidata', place: m.failed[0].part && 'place' in m.failed[0].part ? m.failed[0].part.place : null });
  assert.deepEqual(flaky.asked.filter((a) => a.url.includes('wikidata.org')), []);
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  assert.deepEqual((await files(ws, trip)).filter((p) => p.includes('/wikipedia/')), [pathOf(part)], 'no file claims an edition it lacks');
  const next = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(next.asked), ['ja.wikipedia.org']);
  assert.equal(next.asked.filter((a) => a.url.includes('wikidata.org')).length, 1, 'then the stage');
  assert.deepEqual(n.failed, []);
  assert.ok(n.files.some((f) => f.path === morePath(part, ['ja', 'en']) && f.kind === 'wikipedia-editions'));
  assert.equal(n.summaries, 26);
});

/** OpenStreetMap with nothing near. */
const quiet = () => ({ elements: [] });
/** The requests a run made of Wikidata and by title, as [host, what]: Wikidata's ids, or the titles asked. @param {{ url: string }[]} asked */
const stageAsked = (asked) => asked.filter((a) => a.url.includes('wikidata.org') || new URL(a.url).searchParams.has('titles') && a.url.includes('wikipedia.org'))
  .map((a) => { const u = new URL(a.url); return [u.hostname, u.searchParams.get('ids') ?? u.searchParams.get('titles')]; });

test("the second stage: for the articles a part's lists hold, each edition's summary its list lacks, through Wikidata, then by title; one file named by the part and the editions read, of its own kind", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  // The lists first, then Wikidata for the 26 articles they hold, then each edition by the titles its list lacks: Japanese the six English
  // articles it didn't list (別府ロープウェイ…), English the one Japanese article Wikidata names in English (湯布院町, Yufuin, Ōita).
  const lists = YUFUIN_WIKI.ja.query.pages.length + YUFUIN_WIKI.en.query.pages.length;
  assert.equal(lists, 28);
  const stage = stageAsked(net.asked);
  assert.deepEqual(stage.map(([host]) => host), ['www.wikidata.org', 'ja.wikipedia.org', 'en.wikipedia.org']);
  assert.equal(String(stage[0][1]).split('|').length, 26);
  assert.deepEqual(String(stage[1][1]).split('|').sort(), ['別府ロープウェイ', '野矢駅', '南由布駅', '湯平駅', '庄内駅 (大分県)', 'ジュピター (コースター)'].sort());
  assert.deepEqual(stage[2][1], 'Yufuin, Ōita');
  const wd = new URL(String(net.asked.find((a) => a.url.includes('wikidata.org'))?.url));
  assert.deepEqual([wd.searchParams.get('action'), wd.searchParams.get('props'), wd.searchParams.get('sitefilter')], ['wbgetentities', 'sitelinks', 'jawiki|enwiki']);
  const byTitle = new URL(String(net.asked.find((a) => new URL(a.url).searchParams.has('titles') && a.url.includes('ja.wikipedia.org'))?.url)).searchParams;
  assert.deepEqual([byTitle.get('prop'), byTitle.get('ppprop'), byTitle.get('exintro'), byTitle.get('explaintext'), byTitle.get('exlimit'), byTitle.get('exchars'), byTitle.get('redirects')],
    ['extracts|pageprops', 'wikibase_item', '1', '1', '20', '400', '1']);
  // Ids and titles only: never the position.
  for (const a of net.asked.filter((x) => x.url.includes('wikidata.org') || new URL(x.url).searchParams.has('titles'))) assert.doesNotMatch(a.url, /33\.26|131\.35|ggscoord/);
  for (const a of net.asked.filter((x) => x.url.includes('wikidata.org'))) assert.equal(a.init.headers['Api-User-Agent'], 'annai/9.9.9 (https://annai.guide)');
  // Its file: by the part and the editions read, sorted; a kind of its own; each row an edition's summary, tagged with its edition and item, where the lists put the item.
  const f = m.files.find((x) => x.kind === 'wikipedia-editions');
  assert.deepEqual([f?.path, f?.id, f?.items, f?.edition], [`/offline/wikipedia/${part.id}.x.en.ja.json`, part.id, 7, undefined]);
  assert.equal(morePath(part, ['ja', 'en']), f?.path);
  const stored = JSON.parse(String(await ws.readText(trip, morePath(part, ['ja', 'en']))));
  assert.deepEqual(stored.at, [33.2627, 131.3553]);
  const ropeway = YUFUIN_WIKI.en.query.pages.find((/** @type {any} */ p) => p.title === 'Beppu Ropeway');
  assert.deepEqual(stored.pages.find((/** @type {any[]} */ r) => r[0] === '別府ロープウェイ'), ['別府ロープウェイ', Math.round(ropeway.coordinates[0].lat * 1e4) / 1e4, Math.round(ropeway.coordinates[0].lon * 1e4) / 1e4, '別府ロープウェイ: its summary on ja.wikipedia.org.', 'Q6414356', 'ja']);
  assert.deepEqual(stored.pages.find((/** @type {any[]} */ r) => r[5] === 'en')?.slice(0, 1).concat(stored.pages.find((/** @type {any[]} */ r) => r[5] === 'en')?.[4]), ['Yufuin, Ōita', 'Q8189446']);
  // Each article once, counted once: the second stage adds summaries in other editions, not articles.
  assert.equal(m.summaries, 26);
  // Read: an article's every held edition, its summary and address, joined, named in the first edition that has it.
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const rows = pack.pages(YUFUIN, 10_000, ['ja', 'en']);
  assert.equal(rows.length, 26);
  assert.match(String(rows.find((r) => r[0] === '別府ロープウェイ')?.[6]), /^別府ロープウェイ: its summary on ja\.wikipedia\.org\. https:\/\/ja\.wikipedia\.org\/wiki\/別府ロープウェイ · The Beppu Ropeway \(別府ロープウェイ, Beppu rōpuwei\) is .+… https:\/\/en\.wikipedia\.org\/wiki\/Beppu_Ropeway$/);
  assert.ok(!rows.some((r) => r[0] === 'Beppu Ropeway'), 'Japanese first, now that the pack holds it');
  assert.match(String(rows.find((r) => r[0] === '湯布院町')?.[6]), / https:\/\/ja\.wikipedia\.org\/wiki\/湯布院町 · Yufuin, Ōita: its summary on en\.wikipedia\.org\. https:\/\/en\.wikipedia\.org\/wiki\/Yufuin,_Ōita$/);
  // English first: English's title, its summary first.
  assert.match(String(pack.pages(YUFUIN, 10_000, ['en', 'ja']).find((r) => r[0] === 'Yufuin, Ōita')?.[6]), /^Yufuin, Ōita: its summary on en\.wikipedia\.org\. https:\/\/en\.wikipedia\.org\/wiki\/Yufuin,_Ōita · 湯布院町/);
  // Live mode's name: the first edition's title, as before.
  assert.equal(pack.name({ lat: 33.2626, lng: 131.3551 }, ['ja', 'en'])?.name, '由布院駅');
  // A reorder stores nothing: the same file, nothing asked of Wikipedia or Wikidata.
  const again = services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() });
  await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, editions: ['en', 'ja'], gapMs: 0 });
  assert.deepEqual(again.asked.filter((a) => !a.url.includes('wikivoyage')), []);
});

test("a second stage keeps an edition's page only as the item it was asked for, once: a title that now leads to another article (a redirect) is not that item's", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  // Japanese answers its six titles, and with them 由布院駅 (an item its own list holds, as a redirect's target would come) and 別府ロープウェイ twice.
  const extra = (/** @type {string} */ url) => {
    const r = summariesFrom()(url);
    if (!url.includes('ja.wikipedia.org')) return r;
    const page = (/** @type {string} */ title, /** @type {string} */ id) => ({ ns: 0, title, extract: `${title}: another.`, pageprops: { wikibase_item: id } });
    return { ...r, query: { pages: [...r.query.pages, page('由布院駅', 'Q8060317'), page('別府ロープウェイ', 'Q6414356')] } };
  };
  const net = services({ overpass: quiet, wikipedia: (url) => (new URL(url).searchParams.has('titles') ? extra(url) : yufuinAnswer(url)), wikidata: wikidataOf() });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const rows = JSON.parse(String(await ws.readText(trip, morePath(part, ['ja', 'en'])))).pages;
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.filter((/** @type {any[]} */ r) => r[4] === 'Q6414356').map((/** @type {any[]} */ r) => r[3]), ['別府ロープウェイ: its summary on ja.wikipedia.org.']);
  assert.ok(!rows.some((/** @type {any[]} */ r) => r[4] === 'Q8060317'), "Japanese's own list holds it");
});

test("a second stage asks Wikidata 50 items a request and each edition 20 titles a request, the limits without bot rights", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  // Three editions of 20 articles each, no two the same, and every article in every edition: 60 items, 40 lacking in each edition.
  /** @type {Record<string, any>} */
  const table = {};
  const list = (/** @type {string} */ e, /** @type {number} */ from) => ({ batchcomplete: true, query: { pages: Array.from({ length: 20 }, (_, k) => {
    const id = `Q${from + k}`;
    table[id] = { sitelinks: Object.fromEntries(['ja', 'zh', 'en'].map((x) => [`${x}wiki`, { title: `${x} ${from + k}` }])) };
    return { ns: 0, title: `${e} ${from + k}`, coordinates: [{ lat: 33.26 + k / 1e4, lon: 131.35, primary: true, globe: 'earth' }], pageprops: { wikibase_item: id }, extract: '' };
  }) } });
  const lists = { ja: list('ja', 100), zh: list('zh', 200), en: list('en', 300) };
  const net = services({ overpass: quiet, wikidata: wikidataOf(table), wikipedia: (url) => (new URL(url).searchParams.has('titles') ? summariesFrom(table)(url) : lists[/** @type {'ja'} */ (new URL(url).hostname.split('.')[0])]) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const stage = stageAsked(net.asked);
  assert.deepEqual(stage.map(([host, what]) => [host, String(what).split('|').length]), [['www.wikidata.org', 50], ['www.wikidata.org', 10],
    ['ja.wikipedia.org', 20], ['ja.wikipedia.org', 20], ['zh.wikipedia.org', 20], ['zh.wikipedia.org', 20], ['en.wikipedia.org', 20], ['en.wikipedia.org', 20]]);
  assert.equal(m.files.find((f) => f.kind === 'wikipedia-editions')?.items, 120);
  assert.equal(new URL(net.asked.find((a) => a.url.includes('wikidata.org'))?.url ?? '').searchParams.get('sitefilter'), 'jawiki|zhwiki|enwiki');
});

test("the second stage: a failure writes no file (Wikidata's or an edition's), counted as a part that didn't download; a pack without it, as an older annai left it, reads as missing and the next run brings it alone", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const stageFile = morePath(part, ['ja', 'en']);
  // Wikidata refusing: the lists are saved, the stage is not, and the failure says Wikidata's, a source down.
  const down = services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: () => new Response('', { status: 503 }) });
  const m = await downloadPack({ ws, scope: trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed.map((f) => [f.label, f.why, f.part]), [["Wikipedia's other editions near Yufuin Station", 'Wikidata answered 503.', { source: 'wikidata', place: part.place }]]);
  assert.equal(failWords(/** @type {any} */ (m.failed[0].said)), 'Wikidata answered 503.');
  assert.equal(partWords(/** @type {any} */ (m.failed[0].part)), "Wikipedia's other editions near Yufuin Station", 'the panel names the part');
  assert.ok(!(await files(ws, trip)).includes(stageFile), 'no file claims what it lacks');
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, 2);
  // An edition refusing its titles, after Wikidata answered: no file either.
  const jaDown = services({ overpass: quiet, wikipedia: (url) => (url.includes('ja.wikipedia.org') && new URL(url).searchParams.has('titles') ? new Response('', { status: 503 }) : yufuinWikipedia(url)), wikidata: wikidataOf() });
  const j = await downloadPack({ ws, scope: trip, fetch: jaDown.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(j.failed.map((f) => [f.label, f.why]), [["Wikipedia's other editions near Yufuin Station", 'ja.wikipedia.org answered 503.']]);
  assert.ok(!(await files(ws, trip)).includes(stageFile));
  assert.deepEqual(wikiHosts(jaDown.asked.filter((a) => !new URL(a.url).searchParams.has('titles'))), [], 'the lists, held, are not asked again');
  // Then it comes, alone.
  const up = services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() });
  const u = await downloadPack({ ws, scope: trip, fetch: up.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(u.failed, []);
  assert.deepEqual(stageAsked(up.asked).map(([host]) => host), ['www.wikidata.org', 'ja.wikipedia.org', 'en.wikipedia.org']);
  assert.ok((await files(ws, trip)).includes(stageFile));
  // A pack as the release before wrote it with Japanese listed: its lists, no second stage. The next run asks for the stage alone.
  const old = /** @type {any} */ (await readManifest(ws, trip));
  await ws.writeMany(trip, [{ path: stageFile, content: null }, { path: MANIFEST, content: JSON.stringify({ ...old, files: old.files.filter((/** @type {any} */ f) => f.kind !== 'wikipedia-editions') }) }], { author: 'system' });
  const before = services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() });
  await downloadPack({ ws, scope: trip, fetch: before.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(before.asked.filter((a) => !new URL(a.url).searchParams.has('titles'))), []);
  assert.deepEqual(stageAsked(before.asked).map(([host]) => host), ['www.wikidata.org', 'ja.wikipedia.org', 'en.wikipedia.org']);
  assert.ok((await files(ws, trip)).includes(stageFile));
});

test("a second stage is fetched again when its lists are (a month old) or came after it (its refetch failed, its old copy kept), and kept otherwise", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const stageFile = morePath(part, ['ja', 'en']);
  const t0 = Date.parse('2026-11-20T09:00:00Z');
  const net = () => services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() });
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 });
  // A day on: everything held, nothing asked.
  const held = net();
  await downloadPack({ ws, scope: trip, fetch: held.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 86_400_000 });
  assert.deepEqual(held.asked.filter((a) => !a.url.includes('wikivoyage')), []);
  // Japanese's list a month old (its stage younger): the list comes again, and the stage with it, the articles may have changed.
  const m = /** @type {any} */ (await readManifest(ws, trip));
  await ws.write(trip, MANIFEST, JSON.stringify({ ...m, files: m.files.map((/** @type {any} */ f) => (f.path === pathOf(part, 'ja') ? { ...f, at: t0 - STALE_MS } : f)) }), { author: 'system' });
  // ...but Wikidata refuses: the list is new, the stage keeps its old copy (what the pack had stays), counted as failed.
  const refused = services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: () => new Response('', { status: 503 }) });
  const r = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 2 * 86_400_000 });
  assert.deepEqual(wikiHosts(refused.asked), ['ja.wikipedia.org']);
  assert.equal(r.failed.length, 1);
  assert.ok((await files(ws, trip)).includes(stageFile), 'its old copy');
  assert.equal(r.files.find((f) => f.path === stageFile)?.at, t0);
  // The next run, Wikidata answering: the stage is older than its Japanese list, so it comes again, and nothing else does.
  const next = net();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 3 * 86_400_000 });
  assert.deepEqual(n.failed, []);
  assert.deepEqual(wikiHosts(next.asked.filter((a) => !new URL(a.url).searchParams.has('titles'))), []);
  assert.deepEqual(stageAsked(next.asked).map(([host]) => host), ['www.wikidata.org', 'ja.wikipedia.org', 'en.wikipedia.org']);
  assert.equal(n.files.find((f) => f.path === stageFile)?.at, t0 + 3 * 86_400_000);
  // A month on, everything comes again, the stage after its lists.
  const old = net();
  await downloadPack({ ws, scope: trip, fetch: old.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 3 * 86_400_000 + STALE_MS + 1 });
  assert.deepEqual(old.asked.filter((a) => /wikipedia|wikidata/.test(a.url)).map((a) => new URL(a.url).hostname), ['ja.wikipedia.org', 'en.wikipedia.org', 'www.wikidata.org', 'ja.wikipedia.org', 'en.wikipedia.org']);
});

test("a second stage whose list is asked again and not answered is left with that list's old copy kept: nothing is asked for the stage, which is counted with the list's failure", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const stageFile = morePath(part, ['ja', 'en']);
  const t0 = Date.parse('2026-11-20T09:00:00Z');
  await downloadPack({ ws, scope: trip, ...services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() }), version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 });
  // Japanese's list a month old, so asked again; Japanese Wikipedia refuses.
  const m = /** @type {any} */ (await readManifest(ws, trip));
  await ws.write(trip, MANIFEST, JSON.stringify({ ...m, files: m.files.map((/** @type {any} */ f) => (f.path === pathOf(part, 'ja') ? { ...f, at: t0 - STALE_MS } : f)) }), { author: 'system' });
  const refused = services({ overpass: quiet, wikipedia: (url) => (url.includes('ja.wikipedia.org') ? new Response('', { status: 503 }) : yufuinWikipedia(url)), wikidata: wikidataOf() });
  const r = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 2 * 86_400_000 });
  assert.deepEqual(r.failed.map((f) => f.label), ['Wikipedia near Yufuin Station', "Wikipedia's other editions near Yufuin Station"]);
  assert.deepEqual(r.failed[1].said, r.failed[0].said, "the stage carries its list's failure");
  assert.deepEqual(stageAsked(refused.asked), [], 'the old list is not fed to a stage against the host that just failed');
  // Both old copies stay, as they were.
  assert.equal(r.files.find((f) => f.path === pathOf(part, 'ja'))?.at, t0 - STALE_MS);
  assert.equal(r.files.find((f) => f.path === stageFile)?.at, t0);
});

test("Wikidata that never answers is left after three parts in a row, as an edition is: the second stages after are counted and not asked, every list comes", async () => {
  // Stops 33 km apart: each its own Wikipedia part, and a part between.
  const { ws, trip } = await packTrip(Object.fromEntries(Array.from({ length: 4 }, (_, k) => [`/plan/s${k}.json`, yufuinStop(`Stop ${k}`, { lat: 33.2627 + k * 0.3, lng: 131.3553 }, k + 1)])));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 4);
  const net = services({ overpass: quiet, wikipedia: (url) => yufuinAnswer(url.replace(/ggscoord=[^&]+/, `ggscoord=${YUFUIN.lat}%7C${YUFUIN.lng}`)),
    wikidata: (_url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, answerMs: 30 });
  assert.equal(net.asked.filter((a) => a.url.includes('wikidata.org')).length, 3);
  assert.equal(wikiHosts(net.asked).length, 2 * wikis.length, 'every list');
  assert.deepEqual(m.failed.map((f) => f.why), Array(wikis.length).fill("Wikidata didn't answer in time."));
  assert.equal(new Set(m.failed.map((f) => f.label)).size, wikis.length);
  assert.equal(m.stopped, true, 'it gave up on one');
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia-editions'), []);
});

test("a language added or taken off keeps the part's former second stage until the new one comes, whether the run stopped or failed: offline, rows keep every edition's summary they had", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const stages = async () => (await files(ws, trip)).filter((p) => p.includes('.x.'));
  const net = (/** @type {Record<string, any>} */ o = {}) => services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf(), ...o });
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'en'], gapMs: 0 });
  const two = morePath(part, ['ja', 'en']);
  assert.deepEqual(await stages(), [two]);
  /** How many of the rows the pack gives for the stop carry two editions' summaries of the editions read. @param {string[]} read */
  const both = async (read) => {
    const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
    return pack.pages(YUFUIN, 10_000, read).filter((r) => String(r[6]).split(' · ').length > 1).length;
  };
  const before = await both(['ja', 'en']);
  assert.ok(before >= 9, `${before} rows with two editions`);
  // Chinese added, and the run stops once its list is in (the phone leaves Wi-Fi), before the new stage: the old one stays, in the manifest too.
  const abort = new AbortController();
  const stopped = net();
  const s = await downloadPack({ ws, scope: trip, fetch: stopped.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0, signal: abort.signal, onProgress: (p) => { if (p.label.includes('other editions')) abort.abort(); } });
  assert.deepEqual(await stages(), [two], 'the old stage stays');
  assert.ok(s.files.some((f) => f.path === two && f.kind === 'wikipedia-editions'));
  assert.equal(await both(['ja', 'zh', 'en']), before);
  // The same when Wikidata refuses.
  const failed = net({ wikidata: () => new Response('', { status: 503 }) });
  await downloadPack({ ws, scope: trip, fetch: failed.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(await stages(), [two]);
  assert.equal(await both(['ja', 'zh', 'en']), before);
  // The new one comes: the old one goes.
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  const three = `/offline/wikipedia/${part.id}.x.en.ja.zh.json`;
  assert.deepEqual(await stages(), [three]);
  // Chinese taken off with Wikidata down: the three's stays, read by the two editions left; then the two's comes and the three's goes.
  await downloadPack({ ws, scope: trip, ...net({ wikidata: () => new Response('', { status: 503 }) }), version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(await stages(), [three]);
  assert.equal(await both(['ja', 'en']), before);
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(await stages(), [two]);
  // English alone: no stage wanted, the old one goes (nothing waits for it).
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['en'], gapMs: 0 });
  assert.deepEqual(await stages(), []);
});

test("the second stage follows the editions read: a language added is a new file, the old one going at that download; one taken off, the same; English alone has none", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const stages = async () => (await files(ws, trip)).filter((p) => p.includes('.x.'));
  const net = () => services({ overpass: quiet, wikipedia: yufuinWikipedia, wikidata: wikidataOf() });
  // English alone: no second stage, and Wikidata is never asked.
  const en = net();
  const e = await downloadPack({ ws, scope: trip, fetch: en.fetch, version: V, editions: ['en'], gapMs: 0 });
  assert.deepEqual(await stages(), []);
  assert.deepEqual(en.asked.filter((a) => a.url.includes('wikidata.org')), []);
  assert.deepEqual(e.files.filter((f) => f.kind === 'wikipedia-editions'), []);
  // Japanese added.
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(await stages(), [morePath(part, ['ja', 'en'])]);
  // Chinese added: a new file for the three, the two's gone; Chinese's own list asked, the stage again in the three.
  const zh = net();
  const z = await downloadPack({ ws, scope: trip, fetch: zh.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(await stages(), [`/offline/wikipedia/${part.id}.x.en.ja.zh.json`]);
  assert.deepEqual(wikiHosts(zh.asked.filter((a) => !new URL(a.url).searchParams.has('titles'))), ['zh.wikipedia.org']);
  assert.equal(new URL(zh.asked.find((a) => a.url.includes('wikidata.org'))?.url ?? '').searchParams.get('sitefilter'), 'jawiki|zhwiki|enwiki');
  // The stand-in's Chinese list is empty: Chinese is asked for the titles Wikidata names in Chinese (由布院駅 is 由布院站…).
  assert.ok(stageAsked(zh.asked).some(([host, what]) => host === 'zh.wikipedia.org' && String(what).split('|').includes('由布院站')));
  assert.ok(z.files.some((f) => f.kind === 'wikipedia-editions' && f.path.endsWith('.x.en.ja.zh.json')));
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.match(String(pack.pages(YUFUIN, 10_000, ['ja', 'zh', 'en']).find((r) => r[0] === '由布院駅')?.[6]), / https:\/\/ja\.wikipedia\.org\/wiki\/由布院駅 · 由布院站: its summary on zh\.wikipedia\.org\. https:\/\/zh\.wikipedia\.org\/wiki\/由布院站 · Yufuin Station /);
  // Chinese taken off: the two's file again, the three's gone.
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(await stages(), [morePath(part, ['ja', 'en'])]);
  // English alone again: none.
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['en'], gapMs: 0 });
  assert.deepEqual(await stages(), []);
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
  // Japanese listed, and Wikipedia down: OpenStreetMap is not asked again, no English guide's text is downloaded again (the names are looked up as
  // ever), the Japanese guide comes, and the English parts stay as they were.
  const down = services({ wikipedia: () => new Response('', { status: 503 }) });
  const d = await downloadPack({ ws, scope: trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now });
  assert.deepEqual(down.asked.filter((a) => a.url.includes('overpass')), []);
  assert.deepEqual(down.asked.filter((a) => a.url.includes('en.wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts'), []);
  assert.deepEqual(textsAsked(down.asked, 'ja'), ['カンブリア']);
  assert.equal(d.failed.length, 6); // the plan's two Wikipedia parts, in each of the two editions, and their second stages, which wait for them
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
/** The saved answers as if every part asked at the station: parts of one size. @param {string} url */
const same = (url) => yufuinAnswer(url.replace(/ggscoord=[^&]+/, `ggscoord=${YUFUIN.lat}%7C${YUFUIN.lng}`));

/** Stops 33 km apart, each its own Wikipedia part (and a part between): every part's lists as at Yufuin, its stages by title from Wikidata's real titles. */
const farWikipedia = (/** @type {string} */ url) => (new URL(url).searchParams.has('titles') ? summariesFrom()(url) : same(url));

test("a second stage's requests count under their own host, as a list's do: Wikidata's under 'wikidata', each edition's by-title under its own; hosts that fail in turn give none up, and the one that fails three in a row is left", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.equal(wikis.length, 7);
  // Stage by stage: Wikidata refuses, Japanese's titles refuse, Wikidata, Japanese, Wikidata, Japanese; the seventh asks for neither. Each stage's
  // Wikidata request answers except in the odd stages, so Wikidata never fails twice in a row; Japanese fails in every even stage, three in a row of its own.
  let wd = 0;
  let ja = 0;
  const net = services({
    overpass: noOsm, wikipedia: (url, init) => (new URL(url).searchParams.has('titles') && url.includes('ja.wikipedia.org') ? (ja++, new Response('', { status: 503 })) : farWikipedia(url)),
    wikidata: (url, init) => (++wd % 2 === 1 ? new Response('', { status: 503 }) : wikidataOf()(url)),
  });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  // Stage 1: Wikidata fails (1 in a row). Stage 2: Wikidata answers, Japanese fails (ja 1). Stage 3: Wikidata fails. Stage 4: Wikidata answers, ja 2.
  // Stage 5: Wikidata fails. Stage 6: Wikidata answers, ja 3, left. Stage 7: left, asked nothing.
  assert.equal(net.asked.filter((a) => a.url.includes('wikidata.org')).length, 6);
  assert.equal(ja, 3);
  assert.deepEqual(m.failed.map((f) => f.why), ['Wikidata answered 503.', 'ja.wikipedia.org answered 503.', 'Wikidata answered 503.', 'ja.wikipedia.org answered 503.', 'Wikidata answered 503.',
    'ja.wikipedia.org answered 503.', 'ja.wikipedia.org answered 503.']);
  assert.equal(m.stopped, true, 'Japanese gave up');
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia-editions'), []);
  assert.equal(m.failed.length, wikis.length, 'every stage counted once: three failed at Wikidata, three at Japanese, the seventh left');
});

test("an edition's by-title answer starts its own count over: Japanese's requests fail and answer in turn across the stages, three failures not in a row, and it is never given up", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.equal(wikis.length, 7);
  // One Japanese by-title request a stage: stages 1, 3 and 5 fail, 2, 4, 6 and 7 answer. Three failures, but never three in a row.
  let ja = 0;
  const net = services({
    overpass: noOsm, wikipedia: (url) => (new URL(url).searchParams.has('titles') && url.includes('ja.wikipedia.org') && ++ja <= 5 && ja % 2 === 1 ? new Response('', { status: 503 }) : farWikipedia(url)),
    wikidata: wikidataOf(),
  });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.equal(ja, 7, 'asked at every stage: never given up');
  assert.equal(m.failed.length, 3);
  assert.ok(m.failed.every((f) => f.why === 'ja.wikipedia.org answered 503.'));
  assert.equal(m.stopped, false);
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia-editions').length, 4, 'the stages that answered');
});

test("a second stage whose edition the run gave up is left, never asked: the lists a run had kept, the edition's others refused three times in a row", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  const t0 = Date.parse('2026-11-20T09:00:00Z');
  const net = () => services({ overpass: noOsm, wikipedia: farWikipedia, wikidata: wikidataOf() });
  await downloadPack({ ws, scope: trip, ...net(), version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 });
  // The first three parts' Japanese lists a month old, so they are asked again; the others' lists are fresh and their stages are gone.
  const m = /** @type {any} */ (await readManifest(ws, trip));
  const stale = new Set(wikis.slice(0, 3).map((p) => pathOf(p, 'ja')));
  const stages = wikis.slice(3).map((p) => morePath(p, ['ja', 'en']));
  await ws.writeMany(trip, [...stages.map((path) => ({ path, content: null })), { path: MANIFEST, content: JSON.stringify({ ...m, files: m.files.filter((/** @type {any} */ f) => !stages.includes(f.path)).map((/** @type {any} */ f) => (stale.has(f.path) ? { ...f, at: t0 - STALE_MS } : f)) }) }], { author: 'system' });
  const refused = services({ overpass: noOsm, wikipedia: (url) => (url.includes('ja.wikipedia.org') && !new URL(url).searchParams.has('titles') ? new Response('', { status: 503 }) : farWikipedia(url)), wikidata: wikidataOf() });
  const r = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 2 * 86_400_000 });
  // Three Japanese lists refused: Japanese is given up. Its stages, kept lists or not, are left and asked for nothing: not Wikidata, not by title.
  assert.deepEqual(wikiHosts(refused.asked), ['ja.wikipedia.org', 'ja.wikipedia.org', 'ja.wikipedia.org']);
  assert.deepEqual(refused.asked.filter((a) => a.url.includes('wikidata.org')), []);
  assert.equal(r.stopped, true);
  // The three whose lists failed (their old lists kept) and the four left: seven stages, each counted with the failure that left it.
  assert.equal(r.failed.filter((f) => f.part && 'source' in f.part && f.part.source === 'wikidata').length, wikis.length);
  assert.ok(r.failed.filter((f) => f.part && 'source' in f.part && f.part.source === 'wikidata').every((f) => f.why === 'ja.wikipedia.org answered 503.'));
  // The next run brings them all, the lists that failed and the stages.
  const up = net();
  const u = await downloadPack({ ws, scope: trip, fetch: up.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now: () => t0 + 3 * 86_400_000 });
  assert.deepEqual(u.failed, []);
  assert.equal(u.files.filter((f) => f.kind === 'wikipedia-editions').length, wikis.length);
});

/**
 * What the pack a run left lacks of the editions read (`Pack.lacks`, which nearby's line reads). It reads each Wikipedia part's lists and its stage
 * itself: a stage can outlive the lists of an edition taken off (the former stage kept for the editions still read), so a stage for the editions read
 * is no proof that their lists are there.
 * @param {any} ws @param {string} trip @param {string[]} editions
 */
const lacksOf = async (ws, trip, editions) => /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip)).lacks(editions);

test("what the pack lacks after real downloads: nothing where no list came or every part is whole, something after a language is added and the run stops, a stage fails, or one edition's list fails in a part, or a language is taken off and put back between downloads (its stages kept over lists that went); never for English alone", async () => {
  const net = (/** @type {Record<string, any>} */ o = {}) => services({ overpass: noOsm, wikipedia: farWikipedia, wikidata: wikidataOf(), ...o });
  const two = ['ja', 'en'];
  const three = ['ja', 'zh', 'en'];
  const run = async (/** @type {any} */ ws, /** @type {string} */ trip, /** @type {Record<string, any>} */ o, /** @type {string[]} */ editions, /** @type {AbortSignal | undefined} */ signal = undefined) => downloadPack({ ws, scope: trip, ...net(o), version: V, editions, gapMs: 0, signal });
  const titled = (/** @type {string} */ url) => new URL(url).searchParams.has('titles');
  // Wikimedia answering nothing for the whole run while OpenStreetMap answers: no list, no stage, so no row to leave an edition out of, and nothing lacking.
  const dead = await packTrip(farStops(4));
  const d = await run(dead.ws, dead.trip, { wikipedia: () => new Response('', { status: 503 }) }, two);
  assert.deepEqual(d.files.filter((f) => f.kind.startsWith('wikipedia')), []);
  assert.ok(d.failed.length > 0);
  assert.equal(await lacksOf(dead.ws, dead.trip, two), false);
  // The next run, with Wikimedia back, makes it whole.
  await run(dead.ws, dead.trip, {}, two);
  assert.equal(await lacksOf(dead.ws, dead.trip, two), false);
  assert.equal(await lacksOf(dead.ws, dead.trip, ['en']), false, 'English alone');
  // Chinese added, and the run stopped after some of its lists: Chinese in some parts, no stage for the three, the two's stages kept: lacking for the three only.
  const abort = new AbortController();
  let zh = 0;
  const s = await run(dead.ws, dead.trip, { wikipedia: (/** @type {string} */ url) => { if (url.includes('zh.wikipedia.org') && !titled(url) && ++zh === 3) abort.abort(); return farWikipedia(url); } }, three, abort.signal);
  const some = s.files.filter((f) => f.kind === 'wikipedia' && f.edition === 'zh').length;
  assert.ok(some > 0 && some < 7, `${some} of 7 parts have Chinese's list`);
  assert.equal(await lacksOf(dead.ws, dead.trip, three), true);
  assert.equal(await lacksOf(dead.ws, dead.trip, two), false, "the two's stages stay till the three's come");
  // The next run brings the rest.
  await run(dead.ws, dead.trip, {}, three);
  assert.equal(await lacksOf(dead.ws, dead.trip, three), false);
  // Wikidata refusing the first run: every list, no stage.
  const noStage = await packTrip(farStops(4));
  await run(noStage.ws, noStage.trip, { wikidata: () => new Response('', { status: 503 }) }, two);
  assert.equal(await lacksOf(noStage.ws, noStage.trip, two), true);
  await run(noStage.ws, noStage.trip, {}, two);
  assert.equal(await lacksOf(noStage.ws, noStage.trip, two), false);
  // One edition's list failing in one part (the third) and answering in the others, so no edition is given up: that part has English's list only, and
  // its stage waits for Japanese's. The part's Japanese request is the third.
  const wikis = (await planFor(noStage.ws, noStage.trip)).parts.filter((p) => p.kind === 'wikipedia');
  const one = await packTrip(farStops(4));
  const at = String(/** @type {any} */ (wikis[2]).at[0]);
  /** @param {string[]} hosts the editions that fail for the third part */
  const failing = (hosts) => (/** @type {string} */ url) => (!titled(url) && hosts.includes(new URL(url).hostname.split('.')[0]) && String(new URL(url).searchParams.get('ggscoord')).startsWith(at) ? new Response('', { status: 503 }) : farWikipedia(url));
  const f = await run(one.ws, one.trip, { wikipedia: failing(['ja']) }, two);
  assert.deepEqual(f.files.filter((x) => x.kind === 'wikipedia' && x.id === wikis[2].id).map((x) => x.edition ?? 'en'), ['en']);
  assert.equal(await lacksOf(one.ws, one.trip, two), true);
  assert.equal(await lacksOf(one.ws, one.trip, ['en']), false, 'English alone');
  // Both editions failing in that part: no list there at all, no row from it, so nothing is lacking.
  const both = await packTrip(farStops(4));
  const b = await run(both.ws, both.trip, { wikipedia: failing(['ja', 'en']) }, two);
  assert.deepEqual(b.files.filter((x) => x.kind.startsWith('wikipedia') && x.id === wikis[2].id), []);
  assert.equal(await lacksOf(both.ws, both.trip, two), false);
  // A language taken off and put back between downloads: whole in Japanese and English; then Chinese and English with Wikidata refusing, so Chinese's
  // lists come and no stage for them, Japanese's lists go as no longer wanted and the stages made for Japanese and English stay (their rows serve the
  // editions still read); then Japanese is put back before the next download. Every part holds its stage for the two and none holds Japanese's list,
  // so its rows have lost Japanese and the pack lacks it, though no stage is missing.
  const swap = await packTrip(farStops(4));
  await run(swap.ws, swap.trip, {}, two);
  assert.equal(await lacksOf(swap.ws, swap.trip, two), false);
  const z = await run(swap.ws, swap.trip, { wikidata: () => new Response('', { status: 503 }) }, ['zh', 'en']);
  assert.deepEqual(z.files.filter((x) => x.kind === 'wikipedia' && x.edition === 'ja'), [], "Japanese's lists went");
  assert.deepEqual(z.files.filter((x) => x.kind === 'wikipedia-editions').map((x) => x.path).sort(), wikis.map((p) => morePath(p, two)).sort(), "the stages for the two stay, none for Chinese's");
  assert.equal(await lacksOf(swap.ws, swap.trip, ['zh', 'en']), true, "Chinese's stages didn't come");
  assert.equal(await lacksOf(swap.ws, swap.trip, two), true, "Japanese's lists are gone though every stage for the two is held");
  assert.equal(await lacksOf(swap.ws, swap.trip, ['en']), false, 'English alone');
  await run(swap.ws, swap.trip, {}, two);
  assert.equal(await lacksOf(swap.ws, swap.trip, two), false, 'the next download brings the lists back');
});

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
  assert.match(String(pack.pages(YUFUIN, 10_000, ['ja', 'en']).find((r) => r[0] === '由布院駅')?.[6]), / https:\/\/ja\.wikipedia\.org\/wiki\/由布院駅 · .+ https:\/\/en\.wikipedia\.org\/wiki\/Yufuin_Station$/);
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

test("Wikipedia's parts come in the plan's order, each part in every edition in the reading order, and the pack takes every part however big", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 3);
  const all = services({ overpass: noOsm, wikipedia: same });
  const m = await downloadPack({ ws, scope: trip, fetch: all.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  // By host and the point asked about: every part in the plan's order, Japanese then English at each.
  const asks = all.asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => `${new URL(a.url).hostname} ${new URL(a.url).searchParams.get('ggscoord')}`);
  assert.deepEqual(asks, wikis.flatMap((p) => ['ja', 'en'].map((e) => `${e}.wikipedia.org ${p.at.join('|')}`)));
  // Every Wikipedia part's lists first, then the guides, then the second stages, then OpenStreetMap's (the order test below): a stage waits for
  // every list of its part, and the guides read English's lists alone, so the stages don't hold the first guide back (a long trip in three
  // editions has about 8 requests a part, 3 of them the lists). The stand-in Wikidata knows no other edition: one request a stage, nothing more to ask.
  const kinds = kindsAsked(all.asked, (await planFor(ws, trip)).parts);
  const lists = kinds.filter((k) => k === 'wiki stop' || k === 'wiki way');
  assert.deepEqual(lists, wikis.flatMap((p) => Array(2).fill(p.place.how === 'near' ? 'wiki stop' : 'wiki way')));
  assert.deepEqual(kinds.slice(0, lists.length), lists, 'the lists, every part, before anything else');
  const lastGuide = kinds.lastIndexOf('guides');
  assert.equal(kinds[lists.length], 'guides', 'then the guides');
  assert.deepEqual(kinds.slice(lastGuide + 1), [...Array(wikis.length).fill('wikidata'), ...Array(5).fill('osm')], 'then each stage, then OpenStreetMap');
  assert.deepEqual(m.failed, []);
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, 2 * wikis.length);
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia-editions').length, wikis.length);
  // Past the 20 MB a pack once stopped at: every part is saved. Five OpenStreetMap parts of 52,000 places, each answer 7.6 MB (under what
  // annai reads of one answer, 8 MiB), about 27 MB as stored.
  const body = JSON.stringify({ elements: Array.from({ length: 52_000 }, (_, k) => ({ type: 'node', id: k + 1, lat: 33.2627, lon: 131.3553, tags: { name: `A viewpoint with a name long enough to fill a part ${k}`, tourism: 'viewpoint' } })) });
  const other = await packTrip(farStops(3));
  const b = await downloadPack({ ws: other.ws, scope: other.trip, fetch: services({ overpass: () => new Response(body), wikipedia: same }).fetch, version: V, editions: EN, gapMs: 0 });
  assert.ok(b.bytes > 20 * 1024 * 1024, String(b.bytes));
  assert.deepEqual(b.failed, []);
  assert.equal(b.files.filter((f) => f.kind === 'osm').length, 5);
  assert.equal(b.files.filter((f) => f.kind === 'wikipedia').length, wikis.length);
});

test("an edition whose host never answers is left after three parts in a row, so it costs three answer times, not one a part; the parts left are counted among those that didn't download, the other editions' parts all come, and the guides are looked for all the same: Wikipedia given up is not Wikivoyage given up", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 4);
  const net = services({ overpass: noOsm, wikipedia: (url, init) => (url.includes('zh.wikipedia.org') ? hangs(url, init) : yufuinAnswer(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['zh', 'en'], gapMs: 0, answerMs: 30 });
  assert.equal(wikiHosts(net.asked).filter((h) => h === 'zh.wikipedia.org').length, 3);
  assert.equal(wikiHosts(net.asked).filter((h) => h === 'en.wikipedia.org').length, wikis.length);
  // The three late ones, and each part left after them with the failure that gave the edition up, each with its second stage, which waits for
  // the list: the panel counts them all. Wikidata is never asked: no part has both lists.
  assert.deepEqual(m.failed.map((f) => f.why), Array(2 * wikis.length).fill("zh.wikipedia.org didn't answer in time."));
  assert.equal(new Set(m.failed.map((f) => f.label)).size, 2 * wikis.length, 'each part by its own name');
  assert.deepEqual(net.asked.filter((a) => a.url.includes('wikidata.org')), []);
  assert.equal(m.files.filter((f) => f.edition === 'en').length, wikis.length);
  assert.equal(m.stopped, true, 'it gave up on one');
  // Wikipedia given up in every edition, Wikivoyage answering: the trip's own names still get their guides (only Wikipedia's titles are missing).
  const wikipediaDown = await packTrip(farStops(4));
  await wikipediaDown.ws.patch(wikipediaDown.trip, '/trip.json', { places: ['Big Sur'] }, { author: 'user' });
  const apart = services({ overpass: noOsm, wikipedia: () => new Response('', { status: 503 }) });
  const a = await downloadPack({ ws: wikipediaDown.ws, scope: wikipediaDown.trip, fetch: apart.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.equal(wikiHosts(apart.asked).length, 6, 'three parts each, then Wikipedia is left in both editions');
  assert.deepEqual(a.guides.map((g) => g.title), ['Big Sur']);
  // Everything down: the connection is, and the guides' first request finds it out (a few failed requests on a dead connection, not a part each).
  const down = services({ overpass: () => new Response('', { status: 503 }), wikipedia: () => new Response('', { status: 503 }), wikivoyage: () => new Response('', { status: 503 }) });
  const offline = await packTrip(farStops(4));
  const d = await downloadPack({ ws: offline.ws, scope: offline.trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, busyMs: 1 });
  assert.equal(d.files.length, 0);
  assert.equal(down.asked.filter((a) => a.url.includes('wikivoyage')).length, 1);
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

/** Wikivoyage as if every name had a guide, whose text it sends, or refuses with a 503. @param {() => boolean} down */
/** A trip of farStops(4) whose own places are ten more names to look up. */
async function manyNames() {
  const t = await packTrip(farStops(4));
  await t.ws.patch(t.trip, '/trip.json', { places: Array.from({ length: 10 }, (_, k) => `Town ${k}`) }, { author: 'user' });
  return t;
}
const everyName = (down) => (/** @type {string} */ url) => {
  const u = new URL(url);
  const titles = (u.searchParams.get('titles') ?? '').split('|');
  if (u.searchParams.get('prop') === 'pageprops') return { query: { pages: titles.map((title) => ({ title })) } };
  return down() ? new Response('', { status: 503 }) : { query: { pages: [{ title: titles[0], extract: `${titles[0]} is a guide.` }] } };
};

test("Wikivoyage is left after three guides in a row that fail: the others are not asked for", async () => {
  // As many guides as names have one: far more than the 12 a pack once held.
  const whole = await manyNames();
  const found = (await downloadPack({ ws: whole.ws, scope: whole.trip, fetch: services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage: everyName(() => false) }).fetch, version: V, editions: EN, gapMs: 0 })).guides.length;
  assert.ok(found > 12, String(found));
  const { ws, trip } = await manyNames();
  const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage: everyName(() => true) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  const texts = net.asked.filter((a) => a.url.includes('wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts');
  assert.equal(texts.length, 3);
  // The three that failed, and each guide left after them with the failure that gave Wikivoyage up: the panel counts them all.
  assert.equal(m.failed.length, found);
  assert.equal(new Set(m.failed.map((f) => f.label)).size, found, 'each guide by its own name');
  assert.ok(m.failed.every((f) => /^Wikivoyage: /.test(f.label) && f.part && 'title' in f.part && f.said?.code === 'status' && /^Wikivoyage answered 503/.test(f.why)));
  assert.deepEqual(m.guides, []);
  assert.equal(m.stopped, true);
});

test("Wikivoyage left after three guides that failed: the guides the pack already has fresh are kept, and only the ones it lacks count as failed", async () => {
  const { ws, trip } = await manyNames();
  let down = false;
  const wikivoyage = everyName(() => down);
  const first = await downloadPack({ ws, scope: trip, fetch: services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage }).fetch, version: V, editions: EN, gapMs: 0 });
  assert.ok(first.guides.length > 12);
  // The first three guides in found order are gone, and Wikivoyage stops answering: those three fail, Wikivoyage is left, and the rest are fresh.
  const lost = first.guides.slice(0, 3);
  for (const g of lost) await ws.delete(trip, g.path, { author: 'system' });
  down = true;
  const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(net.asked.filter((a) => a.url.includes('wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts').length, 3);
  assert.deepEqual(m.failed.map((f) => /** @type {any} */ (f.part).title), lost.map((g) => g.title), 'only the three it lacked');
  assert.deepEqual(m.guides, first.guides.slice(3), 'the ones it had stay, in their order');
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikivoyage').map((f) => f.path).sort(), m.guides.map((g) => g.path).sort());
  assert.equal(m.stopped, true);
});

test("a stop during the guides keeps the guide that came, counts no guide as failed, and the next download goes on with the rest", async () => {
  const { ws, trip } = await packTrip();
  const abort = new AbortController();
  // The stop comes with the first guide's text: that guide is saved, and the second is not asked for.
  const stopping = services({
    wikivoyage: (url) => {
      if (new URL(url).searchParams.get('prop') === 'extracts') abort.abort();
      return kitGuides(url);
    },
  });
  const m = await downloadPack({ ws, scope: trip, fetch: stopping.fetch, version: V, editions: EN, gapMs: 0, signal: abort.signal });
  assert.equal(m.stopped, true);
  assert.deepEqual(m.failed, [], 'a guide not asked for is not a failure');
  assert.equal(m.guides.length, 1);
  assert.equal(stopping.asked.filter((a) => a.url.includes('wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts').length, 1);
  const next = services();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(next.asked.filter((a) => a.url.includes('wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts').length, 1, 'only the guide that was not got');
  assert.equal(n.guides.length, 2);
  assert.equal(n.stopped, false);
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

test("a guide that leads from another title (Hearst Castle to San Simeon) is found by the title it leads to, and asked by the name that led to it", async () => {
  const { ws, trip } = await packTrip({ '/plan/hearst.json': { id: 'hearst', title: 'Hearst Castle', fixed: false, start: { at: '2026-11-27T17:45:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Hearst Castle', lat: 35.6852, lng: -121.1668 } } });
  const net = services({ overpass: noOsm, wikipedia: () => ({ batchcomplete: true }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.guides.map((g) => [g.title, g.asked]), [['San Simeon', ['Hearst Castle']]]);
  assert.deepEqual(m.failed, []);
  assert.match(String(await ws.readText(trip, m.guides[0].path)), /San Simeon is a town/);
});

test("the pack's requests to Wikimedia take the app's turns: with three held by others, its first Wikipedia part waits for one", async () => {
  const { wikimediaTurn } = await import('../../src/core/wiki.js');
  /** @type {(() => void)[]} */
  const release = [];
  const held = [1, 2, 3].map(() => wikimediaTurn('https://en.wikipedia.org/w/api.php', () => new Promise((resolve) => release.push(() => resolve(undefined)))));
  try {
    const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
    const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url) });
    const download = downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(net.asked, [], "Wikipedia's part is the first thing asked, and it waits for a turn");
    release.shift()?.();
    const m = await download;
    assert.deepEqual(m.failed, []);
    assert.ok(net.asked.some((a) => a.url.includes('en.wikipedia.org')));
  } finally {
    for (const r of release.splice(0)) r();
    await Promise.all(held);
  }
});

/** The titles asked of an edition's Wikivoyage for their text. @param {{ url: string }[]} asked @param {string} edition */
const textsAsked = (asked, edition) => asked.filter((a) => new URL(a.url).hostname === `${edition}.wikivoyage.org` && new URL(a.url).searchParams.get('prop') === 'extracts').map((a) => new URL(a.url).searchParams.get('titles'));
/** The guide editions' files, by English title and edition. @param {import('../../src/core/pack/download.js').Manifest} m */
const guideEditionsOf = (m) => m.guides.map((g) => [g.title, g.also.map((a) => [a.edition, a.title])]);

test("guides in the traveller's other editions: English's file where it was, each other edition's beside it by English's title, named in the guide's also, and the editions asked in the manifest's voyage", async () => {
  const { ws, trip } = await packTrip();
  const net = services();
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(m.voyage, ['en', 'ja', 'zh']);
  // Each edition's titles come from English's links: one request an edition, naming the guides found (titles only, never a position).
  const links = net.asked.filter((a) => new URL(a.url).searchParams.get('prop') === 'langlinks');
  assert.deepEqual(links.map((a) => [new URL(a.url).hostname, new URL(a.url).searchParams.get('lllang'), new URL(a.url).searchParams.get('titles')]),
    [['en.wikivoyage.org', 'ja', 'Cambria (California)|Big Sur'], ['en.wikivoyage.org', 'zh', 'Cambria (California)|Big Sur']]);
  for (const a of net.asked.filter((x) => x.url.includes('wikivoyage'))) assert.doesNotMatch(a.url, /coord|36\.\d|121\.\d/);
  assert.deepEqual(textsAsked(net.asked, 'ja'), ['カンブリア']);
  assert.deepEqual(textsAsked(net.asked, 'zh'), ['大蘇爾']);
  assert.deepEqual(guideEditionsOf(m), [
    ['Cambria (California)', [['ja', 'カンブリア']]],
    ['Big Sur', [['zh', '大蘇爾']]],
  ]);
  assert.equal(guideFile('Big Sur', 'zh').path, guideFile('Big Sur').path.replace(/\.json$/, '.zh.json'));
  assert.deepEqual(JSON.parse(String(await ws.readText(trip, guideFile('Big Sur', 'zh').path))), { title: '大蘇爾', text: EDITION_GUIDES.zh['大蘇爾'] });
  // Each guide file in the manifest, by its path alone: the edition is in the path, and in the guide's entry.
  const guideFiles = m.files.filter((f) => f.kind === 'wikivoyage').map((f) => f.path).sort();
  assert.deepEqual(guideFiles, [guideFile('Big Sur').path, guideFile('Big Sur', 'zh').path, guideFile('Cambria (California)').path, guideFile('Cambria (California)', 'ja').path].sort());
  assert.ok(m.files.filter((f) => f.kind === 'wikivoyage').every((f) => !('edition' in f)));
  assert.deepEqual(await readManifest(ws, trip), m, 'read back as written');
  // Read in the order given, by any of its titles; an edition not given is not read.
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Big Sur', ['ja', 'zh', 'en'])).map((p) => [p.edition, p.title]), [['zh', '大蘇爾'], ['en', 'Big Sur']]);
  assert.deepEqual((await pack.guide('大蘇爾', ['en', 'zh'])).map((p) => p.edition), ['en', 'zh']);
  assert.deepEqual((await pack.guide('カンブリア', ['en'])).map((p) => [p.edition, p.title]), [['en', 'Cambria (California)']]);
});

test("an edition whose lookup fails stays out of voyage with a failure, and what the pack had in it stays; English's guides are saved regardless; the next download asks only that edition", async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  const later = () => Date.now() + STALE_MS + 86_400_000;
  // A month on everything is old; Japanese's lookup is refused.
  const refused = services({ wikivoyage: (url) => (new URL(url).searchParams.get('lllang') === 'ja' ? new Response('', { status: 503 }) : kitGuides(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0, now: later });
  assert.deepEqual(m.voyage, ['en', 'zh']);
  assert.deepEqual(m.failed.map((f) => [f.label, f.why]), [['Wikivoyage', 'Wikivoyage answered 503.']]);
  assert.deepEqual(textsAsked(refused.asked, 'en').sort(), ['Big Sur', 'Cambria (California)'], "English's guides, a month old, came again");
  assert.deepEqual(textsAsked(refused.asked, 'ja'), [], 'nothing asked of Japanese');
  assert.ok((await files(ws, trip)).includes(guideFile('Cambria (California)', 'ja').path), "Japanese's old copy stays");
  assert.deepEqual(guideEditionsOf(m)[0], ['Cambria (California)', [['ja', 'カンブリア']]]);
  // The next download (within the month of English's new copies): only Japanese's lookup, and its text, the old copy being old.
  const next = services();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0, now: later });
  assert.deepEqual(n.failed, []);
  assert.deepEqual(n.voyage, ['en', 'ja', 'zh']);
  assert.deepEqual(next.asked.filter((a) => new URL(a.url).searchParams.get('prop') === 'langlinks').map((a) => new URL(a.url).searchParams.get('lllang')), ['ja', 'zh']);
  assert.deepEqual([...textsAsked(next.asked, 'en'), ...textsAsked(next.asked, 'zh')], []);
  assert.deepEqual(textsAsked(next.asked, 'ja'), ['カンブリア']);
});

test("a language added asks only for its edition's guides, a language taken off drops its files at the next download, and an edition's text that fails keeps its old copy", async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  // Japanese and Chinese added: their lookups and texts only; English's guides are fresh.
  const added = services();
  const a = await downloadPack({ ws, scope: trip, fetch: added.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(textsAsked(added.asked, 'en'), []);
  assert.deepEqual([textsAsked(added.asked, 'ja'), textsAsked(added.asked, 'zh')], [['カンブリア'], ['大蘇爾']]);
  assert.deepEqual(a.voyage, ['en', 'ja', 'zh']);
  // Japanese taken off: its file goes, the guide's also no more names it; nothing is downloaded but the names and Chinese's links.
  const fewer = services();
  const f = await downloadPack({ ws, scope: trip, fetch: fewer.fetch, version: V, editions: ['zh', 'en'], gapMs: 0 });
  assert.deepEqual(fewer.asked.filter((x) => new URL(x.url).searchParams.get('prop') === 'extracts'), []);
  assert.ok(!(await files(ws, trip)).includes(guideFile('Cambria (California)', 'ja').path));
  assert.deepEqual(f.guides.map((g) => [g.title, g.also.map((x) => x.edition)]), [['Cambria (California)', []], ['Big Sur', ['zh']]]);
  assert.deepEqual(f.voyage, ['en', 'zh']);
  // English Wikivoyage refusing the names lookup: the guides this download didn't get to stay as they were, in every edition.
  const unfound = await downloadPack({ ws, scope: trip, fetch: services({ wikivoyage: (url) => (new URL(url).searchParams.get('prop') === 'pageprops' ? new Response('', { status: 503 }) : kitGuides(url)) }).fetch, version: V, editions: ['zh', 'en'], gapMs: 0 });
  assert.deepEqual(unfound.guides, f.guides);
  assert.deepEqual(unfound.voyage, f.voyage);
  assert.ok((await files(ws, trip)).includes(guideFile('Big Sur', 'zh').path));
  // A month on, Chinese Wikivoyage refuses the text: its old copy stays, named in also, and counted as a part that didn't download.
  const later = () => Date.now() + STALE_MS + 86_400_000;
  const refused = services({ wikivoyage: (url) => (url.includes('zh.wikivoyage.org') && new URL(url).searchParams.get('prop') === 'extracts' ? new Response('', { status: 503 }) : kitGuides(url)) });
  const r = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['zh', 'en'], gapMs: 0, now: later });
  assert.deepEqual(r.failed.map((x) => [x.label, x.why]), [['Wikivoyage: 大蘇爾', 'zh.wikivoyage.org answered 503.']]);
  assert.deepEqual(JSON.parse(String(await ws.readText(trip, guideFile('Big Sur', 'zh').path))).title, '大蘇爾');
  assert.deepEqual(guideEditionsOf(r)[1], ['Big Sur', [['zh', '大蘇爾']]]);
});

test("a pack from before Wikivoyage's editions, and one an older annai stopped at its size limit: read as written (its guides English, voyage English alone, full ignored), and its next download completes it", async () => {
  const { ws, trip } = await packTrip();
  for (const [path, text] of Object.entries(BEFORE)) await ws.write(trip, path, path === MANIFEST ? JSON.stringify({ ...JSON.parse(text), full: true }) : text, { author: 'system' });
  const m = /** @type {import('../../src/core/pack/download.js').Manifest} */ (await readManifest(ws, trip));
  assert.deepEqual(m.voyage, ['en']);
  assert.deepEqual(m.guides.map((g) => g.also), [[], []]);
  assert.ok(!('full' in m));
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Big Sur', ['zh', 'en'])).map((p) => [p.edition, p.title]), [['en', 'Big Sur']]);
  // Its next download, with Chinese listed: Chinese's guide comes; English's, fresh, are not asked again.
  const now = () => Date.parse('2026-11-19T09:00:00Z');
  const net = services();
  const n = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['zh', 'en'], gapMs: 0, now });
  assert.deepEqual(textsAsked(net.asked, 'en'), []);
  assert.deepEqual(textsAsked(net.asked, 'zh'), ['大蘇爾']);
  assert.deepEqual(n.voyage, ['en', 'zh']);
  assert.deepEqual(n.failed, []);
  assert.ok(!('full' in /** @type {any} */ (await ws.readJSON(trip, MANIFEST))), 'no longer written');
});

test("a trip longer than a pack once held (100 OpenStreetMap parts, 100 Wikipedia parts, 12 guides) is downloaded whole", async () => {
  // 120 stops 33 km apart: each its own part of both, and the way between.
  const plan = packPlan({ trip: null, items: Object.entries(farStops(120)).map(([path, item]) => ({ path, item })) });
  assert.ok(plan.parts.filter((p) => p.kind === 'osm').length > 100 && plan.parts.filter((p) => p.kind === 'wikipedia').length > 100);
  const { ws, trip } = await packTrip(farStops(120));
  const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage: everyName(() => false) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.equal(m.files.filter((f) => f.kind !== 'wikivoyage').length, plan.parts.length);
  assert.equal(m.key, plan.key);
  assert.ok(m.guides.length > 12, String(m.guides.length));
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
  assert.match(String(rows.find((r) => r[0] === '士林夜市')?.[6]), / https:\/\/zh\.wikipedia\.org\/wiki\/士林夜市 · Shilin Night Market is a night market in Taipei\. https:\/\/en\.wikipedia\.org\/wiki\/Shilin_Night_Market$/);
  assert.ok(!rows.some((r) => r[0] === 'Shilin Night Market'), 'Chinese first');
  assert.equal(pack.name({ lat: 25.08522, lng: 121.52472 }, ['zh', 'en'])?.name, '士林夜市');
  // English first: its title, linked on English Wikipedia.
  const first = pack.pages(shilin, 10_000, ['en', 'zh']);
  assert.match(String(first.find((r) => r[0] === 'Shilin Night Market')?.[6]), /^Shilin Night Market is a night market in Taipei\. https:\/\/en\.wikipedia\.org\/wiki\/Shilin_Night_Market · .+ https:\/\/zh\.wikipedia\.org\/wiki\/士林夜市$/);
  assert.ok(!first.some((r) => r[0] === '士林夜市'));
  assert.equal(pack.name({ lat: 25.08522, lng: 121.52472 }, ['en', 'zh'])?.name, 'Shilin Night Market');
});

/** What a request is, for the order a download asks in: OpenStreetMap, a Wikipedia part (a stop's, or along the way), or Wikivoyage. @param {{ url: string }[]} asked @param {import('../../src/core/pack/plan.js').Part[]} parts */
const kindsAsked = (asked, parts) => asked.map((a) => {
  if (a.url.endsWith('/api/interpreter')) return 'osm';
  if (a.url.includes('wikivoyage.org')) return 'guides';
  if (a.url.includes('wikidata.org')) return 'wikidata';
  const at = String(new URL(a.url).searchParams.get('ggscoord')).replace('|', ',');
  return parts.find((p) => p.kind === 'wikipedia' && p.at.join(',') === at)?.place.how === 'near' ? 'wiki stop' : 'wiki way';
});

test("the quick parts come first: every Wikipedia part, the stops' and the way's, then the guides, then OpenStreetMap's parts; the guides read the titles the stops' and the way's parts gave", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  const plan = await planFor(ws, trip);
  const stops = plan.parts.filter((p) => p.kind === 'wikipedia' && p.place.how === 'near').length;
  const way = plan.parts.filter((p) => p.kind === 'wikipedia' && p.place.how === 'between').length;
  assert.deepEqual([stops, way, plan.parts.filter((p) => p.kind === 'osm').length], [3, 2, 5]);
  const net = services({ overpass: noOsm, wikipedia: same });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const kinds = kindsAsked(net.asked, plan.parts);
  // The guides' lookup is one request here, then English's links: no, English alone asks the names, and a text for each guide found.
  assert.deepEqual(kinds.slice(0, stops + way), [...Array(stops).fill('wiki stop'), ...Array(way).fill('wiki way')]);
  assert.equal(kinds[stops + way], 'guides');
  const lastGuides = kinds.lastIndexOf('guides');
  assert.ok(kinds.slice(stops + way, lastGuides + 1).every((k) => k === 'guides'), 'the guides together');
  assert.deepEqual(kinds.slice(lastGuides + 1), Array(5).fill('osm'));
  // The names it looked for include a title only a Wikipedia part gave.
  const title = YUFUIN_WIKI.en.query.pages[0].title;
  assert.ok(net.asked.filter((a) => a.url.includes('wikivoyage.org')).some((a) => decodeURIComponent(a.url).includes(title)), title);
  // The parts of the plan the other way round are all there.
  assert.equal(m.files.filter((f) => f.kind === 'wikipedia').length, stops + way);
  assert.equal(m.files.filter((f) => f.kind === 'osm').length, 5);
});

test("a stop in the first parts asks nothing more, looks for no guides, and keeps every part the pack had, however old", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  await downloadPack({ ws, scope: trip, ...services({ overpass: noOsm, wikipedia: same }), version: V, editions: EN, gapMs: 0 });
  const before = await files(ws, trip);
  const abort = new AbortController();
  const later = () => Date.now() + STALE_MS + 86_400_000;
  const net = services({ overpass: noOsm, wikipedia: same });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0, now: later, signal: abort.signal, onProgress: (p) => { if (p.done === 1) abort.abort(); } });
  assert.equal(m.stopped, true);
  assert.equal(net.asked.length, 1, 'the first part only');
  assert.deepEqual(await files(ws, trip), before, 'nothing the stop did not reach is dropped');
  assert.equal(m.files.length, before.length - 1, 'every file is still in the manifest');
});

test("the trip's own places and stops are always looked up, however many (the first 200 once were all): 250 places, the last with a guide; Wikipedia's titles come after them", async () => {
  const { ws, trip } = await packTrip();
  await ws.patch(trip, '/trip.json', { places: Array.from({ length: 250 }, (_, k) => `Town ${k}`) }, { author: 'user' });
  const net = services({ wikivoyage: everyName(() => false) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const asked = net.asked.filter((a) => new URL(a.url).searchParams.get('prop') === 'pageprops').flatMap((a) => (new URL(a.url).searchParams.get('titles') ?? '').split('|'));
  for (let k = 0; k < 250; k++) assert.ok(asked.includes(`Town ${k}`), `Town ${k} was looked up`);
  assert.ok(asked.indexOf('Town 249') < asked.indexOf('Big Sur'), "the plan's names first, Wikipedia's titles after them");
  assert.ok(m.guides.some((g) => g.title === 'Town 249'));
  assert.equal(m.guides.length, 250 + 5, 'every name has one: the 250 places, the two stops, and the three more titles Wikipedia gave');
});

/** The names an edition's Wikivoyage was asked by (its names lookups, 50 a request), in the order asked. @param {{ url: string }[]} asked @param {string} host */
const namesAsked = (asked, host) => asked.filter((a) => new URL(a.url).hostname === host && new URL(a.url).searchParams.get('prop')?.startsWith('pageprops'))
  .flatMap((a) => (new URL(a.url).searchParams.get('titles') ?? '').split('|'));
/** A trip with no stops and these places: its places are the only names. @param {string[]} places */
async function placesTrip(places) {
  const t = await packTrip({});
  await t.ws.patch(t.trip, '/trip.json', { places }, { author: 'user' });
  return t;
}
/** A guide's entry in the manifest as the tests compare it: its title, the names that led to it, and its pages in other editions. @param {import('../../src/core/pack/download.js').Manifest} m */
const guidesOf = (m) => m.guides.map((g) => [g.title, g.asked, g.also.map((a) => `${a.edition} ${a.title}`)]);

test("English turns a name into a place once: a name it has a page for is not asked of another edition (Kashmir is English's region for an Italian reader, not Italian's Jammu e Kashmir)", async () => {
  const { ws, trip } = await placesTrip(['Kashmir']);
  const net = services({ wikivoyage: voyageWorld({
    en: { Kashmir: { text: 'Kashmir is a region of South Asia.' } },
    it: { Kashmir: { to: 'Jammu e Kashmir' }, 'Jammu e Kashmir': { en: 'Jammu and Kashmir', text: 'Il Jammu e Kashmir è un territorio.' } },
  }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['it', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(guidesOf(m), [['Kashmir', ['Kashmir'], []]], 'one English guide, with no page in Italian');
  assert.deepEqual(m.voyage, ['en', 'it']);
  assert.deepEqual(namesAsked(net.asked, 'it.wikivoyage.org'), [], 'Italian is asked nothing by name');
  assert.deepEqual(await files(ws, trip), [guideFile('Kashmir').path, MANIFEST].sort(), 'no Jammu e Kashmir');
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Kashmir', ['it', 'en'])).map((p) => [p.edition, p.title]), [['en', 'Kashmir']]);
});

test("Granada for a Spanish reader is English's city with Spanish's page that English links to, not Spanish's Grenada: that edition is not asked the name", async () => {
  const { ws, trip } = await placesTrip(['Granada']);
  const net = services({ wikivoyage: voyageWorld({
    en: { Granada: { links: { es: 'Granada (España)' }, text: 'Granada is a city in Andalusia.' } },
    es: { Granada: { en: 'Grenada', text: 'Granada es un país del Caribe.' }, 'Granada (España)': { en: 'Granada', text: 'Granada es una ciudad de Andalucía.' } },
  }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['es', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(guidesOf(m), [['Granada', ['Granada'], ['es Granada (España)']]]);
  assert.deepEqual(namesAsked(net.asked, 'es.wikivoyage.org'), []);
  assert.deepEqual(textsAsked(net.asked, 'es'), ['Granada (España)']);
  assert.deepEqual(await files(ws, trip), [guideFile('Granada').path, guideFile('Granada', 'es').path, MANIFEST].sort(), 'no file for Grenada');
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Granada', ['es', 'en'])).map((p) => `${p.edition} ${p.title}`), ['es Granada (España)', 'en Granada']);
});

test("a name English lists as several places gets no guide and is asked of no other edition (Georgia is the US state in German and the country in Spanish; Congo; Mérida)", async () => {
  const { ws, trip } = await placesTrip(['Georgia', 'Congo', 'Mérida']);
  const net = services({ wikivoyage: voyageWorld({
    en: { Georgia: { to: 'Georgia (disambiguation)' }, 'Georgia (disambiguation)': { list: true }, Congo: { list: true }, Mérida: { list: true } },
    de: { Georgia: { en: 'Georgia (U.S. state)', text: 'Georgia ist ein Bundesstaat der USA.' }, Congo: { list: true } },
    es: { Georgia: { en: 'Georgia (country)', text: 'Georgia es un país del Cáucaso.' }, Mérida: { list: true } },
    ja: { ジョージア: { en: 'Georgia (country)', text: 'ジョージアはコーカサスの国。' } },
  }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['de', 'es', 'ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(m.guides, []);
  assert.deepEqual(m.voyage, ['en', 'de', 'es', 'ja'], 'every edition was asked, with nothing left to ask it');
  assert.deepEqual([...new Set(net.asked.map((a) => new URL(a.url).hostname))], ['en.wikivoyage.org'], 'English alone was asked');
});

test("a name in the traveller's script comes through the first edition that has a page by it, which links to English's place (台湾, ジョージア, 京都): English's guide, the name in asked, each edition English links to in also", async () => {
  const { ws, trip } = await placesTrip(['台湾', 'ジョージア', '京都']);
  const world = {
    en: {
      Taiwan: { links: { zh: '臺灣' }, text: 'Taiwan is an island country.' },
      'Georgia (country)': { links: { ja: 'ジョージア' }, text: 'Georgia is a country in the Caucasus.' },
      Kyoto: { links: { ja: '京都市', zh: '京都' }, text: 'Kyoto was the capital of Japan.' },
    },
    ja: { ジョージア: { en: 'Georgia (country)', text: 'ジョージアはコーカサスの国。' }, 京都: { list: true }, 京都市: { en: 'Kyoto', text: '京都市は京都府の府庁所在地。' } },
    zh: { 台湾: { to: '臺灣' }, 臺灣: { en: 'Taiwan', text: '臺灣是東亞的島嶼。' }, 京都: { en: 'Kyoto', text: '京都是日本的古都。' } },
  };
  const net = services({ wikivoyage: voyageWorld(world) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(m.voyage, ['en', 'ja', 'zh']);
  assert.deepEqual(guidesOf(m), [
    ['Georgia (country)', ['ジョージア'], ['ja ジョージア']],
    ['Taiwan', ['台湾'], ['zh 臺灣']],
    ['Kyoto', ['京都'], ['ja 京都市', 'zh 京都']],
  ]);
  // Japanese is asked the three names, Chinese what Japanese had no page for (京都 is Japanese's list); English the three titles once more.
  assert.deepEqual(namesAsked(net.asked, 'ja.wikivoyage.org'), ['台湾', 'ジョージア', '京都']);
  assert.deepEqual(namesAsked(net.asked, 'zh.wikivoyage.org'), ['台湾', '京都']);
  assert.deepEqual(namesAsked(net.asked, 'en.wikivoyage.org'), ['台湾', 'ジョージア', '京都', 'Georgia (country)', 'Taiwan', 'Kyoto']);
  const names = net.asked.filter((a) => a.url.includes('ja.wikivoyage.org') && new URL(a.url).searchParams.get('prop')?.startsWith('pageprops'));
  assert.deepEqual(['prop', 'lllang', 'lllimit', 'redirects', 'converttitles'].map((k) => new URL(names[0].url).searchParams.get(k)), ['pageprops|langlinks', 'en', '50', '1', '1']);
  for (const a of net.asked) assert.doesNotMatch(a.url, /coord|36\.\d|121\.\d/, 'names, never a position');
  // Read offline as it would be online: the Chinese part and English's, by the name.
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('台湾', ['zh', 'en'])).map((p) => `${p.edition} ${p.title}`), ['zh 臺灣', 'en Taiwan']);
  assert.deepEqual((await pack.guide('京都市', ['ja', 'zh', 'en'])).map((p) => p.edition), ['ja', 'zh', 'en'], 'by its title in an edition');
  // The next download asks the names again and no text: the files are fresh.
  const again = services({ wikivoyage: voyageWorld(world) });
  const n = await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(n.guides, m.guides);
  assert.deepEqual(again.asked.filter((a) => new URL(a.url).searchParams.get('prop') === 'extracts'), []);
});

test("a name that is a list in the only edition read has no guide: 京都 for a Japanese reader (the pack has none, the guide tool gives the list online)", async () => {
  const { ws, trip } = await placesTrip(['京都']);
  const net = services({ wikivoyage: voyageWorld({ en: { Kyoto: { links: { ja: '京都市' } } }, ja: { 京都: { list: true }, 京都市: { en: 'Kyoto', text: '京都市は京都府の府庁所在地。' } } }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(m.guides, []);
  assert.deepEqual(m.voyage, ['en', 'ja']);
});

test("a page with no link to English is no guide, and its name is settled there: the next edition is not asked it (湯布院: Japanese has the page, English has none)", async () => {
  const { ws, trip } = await placesTrip(['湯布院']);
  const net = services({ wikivoyage: voyageWorld({
    en: { Yufu: { links: { zh: '由布院' }, text: 'Yufu is a city.' } },
    ja: { 湯布院: { text: '湯布院は大分県の温泉地。' } },
    zh: { 湯布院: { to: '由布院' }, 由布院: { en: 'Yufu', text: '由布院是大分縣的溫泉地。' } },
  }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(m.guides, [], 'no guide: a guide is English\'s page and its links');
  assert.deepEqual(namesAsked(net.asked, 'zh.wikivoyage.org'), [], 'Chinese is not asked a name Japanese settled');
  assert.deepEqual(await files(ws, trip), [MANIFEST]);
  assert.deepEqual(m.voyage, ['en', 'ja', 'zh']);
});

test("a name two of the traveller's editions have a page for is one place: the first edition decides, as online (the pack never gives one part of each)", async () => {
  const { ws, trip } = await placesTrip(['Aldea']);
  const net = services({ wikivoyage: voyageWorld({
    en: { 'Aldea (Spain)': { links: { ja: 'アルデア' }, text: 'Aldea is a village in Spain.' }, 'Aldea (Chile)': { links: { zh: '阿爾德亞' }, text: 'Aldea is a village in Chile.' } },
    ja: { Aldea: { en: 'Aldea (Spain)', text: 'Aldea はスペインの村。' }, アルデア: { en: 'Aldea (Spain)', text: 'アルデアはスペインの村。' } },
    zh: { Aldea: { en: 'Aldea (Chile)', text: 'Aldea 是智利的村莊。' }, 阿爾德亞: { en: 'Aldea (Chile)', text: '阿爾德亞是智利的村莊。' } },
  }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.deepEqual(guidesOf(m), [['Aldea (Spain)', ['Aldea'], ['ja アルデア']]]);
  assert.deepEqual(namesAsked(net.asked, 'zh.wikivoyage.org'), []);
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Aldea', ['ja', 'zh', 'en'])).map((p) => `${p.edition} ${p.title}`), ['ja アルデア', 'en Aldea (Spain)']);
});

test("the way's Wikipedia titles reach the guides on the first run: every Wikipedia part comes before them, a pack nobody changes never gives them a second chance", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  const plan = await planFor(ws, trip);
  const legs = new Set(plan.parts.flatMap((p) => (p.kind === 'wikipedia' && p.place.how === 'between' ? [p.at.join('|')] : [])));
  assert.ok(legs.size > 0);
  // The stops' answers have no guide for any of their titles; a part along the way names San Simeon, which has one.
  const way = (/** @type {string} */ url) => (legs.has(String(new URL(url).searchParams.get('ggscoord')))
    ? { query: { pages: [{ ns: 0, title: 'San Simeon', coordinates: [{ lat: 33.5, lon: 131.3, primary: true, globe: 'earth' }], pageprops: { wikibase_item: 'Q1' }, extract: 'San Simeon is a town.' }] } }
    : same(url));
  const m = await downloadPack({ ws, scope: trip, ...services({ overpass: noOsm, wikipedia: way }), version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(m.failed, []);
  assert.ok(m.guides.some((g) => g.title === 'San Simeon'), m.guides.map((g) => g.title).join());
});

test("an edition whose names lookup fails ends the turn: its host named, the editions after it not asked the names, the guides the pack had by the names left stay, and both stay out of voyage until the next run brings them", async () => {
  const { ws, trip } = await placesTrip(['京都市', '金门']);
  const world = {
    en: { Kyoto: { links: { ja: '京都市', zh: '京都' }, text: 'Kyoto was the capital of Japan.' }, Kinmen: { links: { zh: '金門' }, text: 'Kinmen is an island group.' } },
    ja: { 京都市: { en: 'Kyoto', text: '京都市は京都府の府庁所在地。' } },
    zh: { 金门: { to: '金門' }, 金門: { en: 'Kinmen', text: '金門是島嶼群。' }, 京都: { en: 'Kyoto', text: '京都是日本的古都。' } },
  };
  const first = await downloadPack({ ws, scope: trip, ...services({ wikivoyage: voyageWorld(world) }), version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(first.failed, []);
  assert.deepEqual(guidesOf(first), [['Kyoto', ['京都市'], ['ja 京都市', 'zh 京都']], ['Kinmen', ['金门'], ['zh 金門']]], 'Japanese settled the first name, Chinese the second');
  assert.deepEqual(first.voyage, ['en', 'ja', 'zh']);
  // Japanese's names lookup answers 503: Chinese is not asked the names, Kinmen's guide (found by 金门, which Japanese would have passed on) stays.
  const refused = services({ wikivoyage: (url) => (url.includes('ja.wikivoyage.org') && new URL(url).searchParams.get('prop')?.startsWith('pageprops') ? new Response('', { status: 503 }) : voyageWorld(world)(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed.map((f) => f.why), ['ja.wikivoyage.org answered 503.']);
  assert.deepEqual(namesAsked(refused.asked, 'zh.wikivoyage.org'), [], 'Chinese is not asked what Japanese left unsettled');
  assert.deepEqual(m.voyage, ['en'], 'Japanese was not asked to its end, and Chinese after it was not asked at all');
  assert.deepEqual(guidesOf(m), guidesOf(first), 'both guides stay, with the names that led to them');
  assert.ok((await files(ws, trip)).includes(guideFile('Kinmen', 'zh').path));
  // Asked again, both editions come into voyage.
  const next = await downloadPack({ ws, scope: trip, ...services({ wikivoyage: voyageWorld(world) }), version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(next.failed, []);
  assert.deepEqual(next.voyage, ['en', 'ja', 'zh']);
  assert.deepEqual(guidesOf(next), guidesOf(first));
  // The plan no longer names them: the guides go with their files.
  await ws.patch(trip, '/trip.json', { places: [] }, { author: 'user' });
  const dropped = await downloadPack({ ws, scope: trip, ...services({ wikivoyage: voyageWorld(world) }), version: V, editions: ['ja', 'zh', 'en'], gapMs: 0 });
  assert.deepEqual(dropped.guides, []);
  assert.deepEqual(await files(ws, trip), [MANIFEST]);
});

test("a guide's text that fails keeps its link: the guide names the edition in also, the file is missing, and the next download brings the text", async () => {
  const { ws, trip } = await packTrip();
  const text = (/** @type {string} */ url) => url.includes('ja.wikivoyage.org') && new URL(url).searchParams.get('prop') === 'extracts';
  const refused = services({ wikivoyage: (url) => (text(url) ? new Response('', { status: 503 }) : kitGuides(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: refused.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed.map((f) => f.why), ['ja.wikivoyage.org answered 503.']);
  assert.deepEqual(guidesOf(m), [['Cambria (California)', ['Cambria, California'], ['ja カンブリア']], ['Big Sur', ['Big Sur'], []]]);
  assert.ok(!(await files(ws, trip)).includes(guideFile('Cambria (California)', 'ja').path), 'no Japanese file');
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Cambria, California', ['ja', 'en'])).map((p) => [p.edition, p.title, p.text.length > 0]), [['ja', 'カンブリア', false], ['en', 'Cambria (California)', true]]);
  const next = services();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(n.failed, []);
  assert.deepEqual(textsAsked(next.asked, 'ja'), ['カンブリア']);
  assert.deepEqual(textsAsked(next.asked, 'en'), [], "English's text is fresh");
  assert.ok((await files(ws, trip)).includes(guideFile('Cambria (California)', 'ja').path));
});

test("a stop while a guide's second edition is fetched keeps the guide, with its link in that edition: the English file is saved, and the next download brings the Japanese one", async () => {
  const { ws, trip } = await packTrip();
  const abort = new AbortController();
  // The stop comes with the first guide's Japanese text, as a real fetch fails when its signal aborts.
  const stopping = services({
    wikivoyage: (url) => {
      if (url.includes('ja.wikivoyage.org') && new URL(url).searchParams.get('prop') === 'extracts') {
        abort.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return kitGuides(url);
    },
  });
  const m = await downloadPack({ ws, scope: trip, fetch: stopping.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, signal: abort.signal });
  assert.equal(m.stopped, true);
  assert.deepEqual(m.failed, []);
  assert.deepEqual(m.guides.map((g) => [g.title, g.also]), [['Cambria (California)', [{ edition: 'ja', title: 'カンブリア' }]]], "the guide, with its link in Japanese: the text didn't come");
  assert.ok(m.files.some((f) => f.path === guideFile('Cambria (California)').path));
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  assert.deepEqual((await pack.guide('Cambria, California', ['ja', 'en'])).map((p) => [p.edition, p.text.length > 0]), [['ja', false], ['en', true]]);
  assert.deepEqual(m.voyage, ['en'], 'the pass did not reach its end: Japanese is still to be asked');
  const next = services();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.equal(n.stopped, false);
  assert.deepEqual(n.guides.map((g) => [g.title, g.also.map((a) => a.edition)]), [['Cambria (California)', ['ja']], ['Big Sur', []]]);
  assert.deepEqual(textsAsked(next.asked, 'en'), ['Big Sur'], 'English Cambria was saved');
});

test("progress reaches its total: a guide whose English text fails takes its other editions with it, counted", async () => {
  const { ws, trip } = await packTrip();
  /** @type {any[]} */
  const progress = [];
  // Cambria's English text is refused (once, so Wikivoyage isn't left); its Japanese guide is then not asked for.
  const net = services({ wikivoyage: (url) => (new URL(url).hostname === 'en.wikivoyage.org' && new URL(url).searchParams.get('titles') === 'Cambria (California)' && new URL(url).searchParams.get('prop') === 'extracts' ? new Response('', { status: 503 }) : kitGuides(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'zh', 'en'], gapMs: 0, onProgress: (p) => progress.push(p) });
  assert.deepEqual(m.guides.map((g) => g.title), ['Big Sur']);
  assert.deepEqual(textsAsked(net.asked, 'ja'), [], 'its Japanese guide was not asked for');
  const last = progress.at(-1);
  assert.equal(last.done + 1, last.total, `the last step is the last of the total: ${last.done + 1} of ${last.total}`);
});

test("progress reaches its total when an edition is given up: its guides left after the third failure are counted, so the next guide's step says where it is", async () => {
  const { ws, trip } = await manyNames();
  /** @type {any[]} */
  const progress = [];
  // Every guide English has links to a Japanese one, and Japanese Wikivoyage refuses every text: three fail, the rest are left.
  const net = services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url), wikivoyage: (url) => {
    const u = new URL(url);
    const titles = (u.searchParams.get('titles') ?? '').split('|');
    if (u.hostname === 'ja.wikivoyage.org') return u.searchParams.get('prop') === 'pageprops' ? { query: { pages: titles.map((title) => ({ title, missing: true })) } } : new Response('', { status: 503 });
    if (u.searchParams.get('prop') === 'langlinks') return { query: { pages: titles.map((title) => ({ title, langlinks: [{ lang: 'ja', title: `${title} ja` }] })) } };
    return everyName(() => false)(url);
  } });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, onProgress: (p) => progress.push(p) });
  assert.ok(m.guides.length > 6, String(m.guides.length));
  assert.equal(textsAsked(net.asked, 'ja').length, 3, 'Japanese was left after three');
  assert.ok(m.failed.length > 3, 'the left guides count among those that did not download');
  const last = progress.at(-1);
  assert.equal(last.done + 1, last.total, `${last.done + 1} of ${last.total}`);
});

test("a guide with no text says which Wikivoyage sent none: the edition's host, not Wikivoyage for every edition; one kept by an older annai, which names none, still reads", async () => {
  const { ws, trip } = await packTrip();
  const empty = (/** @type {string} */ url) => (url.includes('ja.wikivoyage.org') && new URL(url).searchParams.get('prop') === 'extracts' ? { query: { pages: [{ title: 'カンブリア', extract: '' }] } } : kitGuides(url));
  const m = await downloadPack({ ws, scope: trip, fetch: services({ wikivoyage: empty }).fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed.map((f) => [f.label, f.why]), [['Wikivoyage: カンブリア', 'ja.wikivoyage.org sent no text for カンブリア.']]);
  assert.equal(failWords(/** @type {any} */ (m.failed[0].said)), 'ja.wikivoyage.org sent no text for カンブリア.');
  // English's is just Wikivoyage.
  const en = await packTrip();
  const e = await downloadPack({ ws: en.ws, scope: en.trip, fetch: services({ wikivoyage: (url) => (new URL(url).searchParams.get('prop') === 'extracts' ? { query: { pages: [{ title: 'x', extract: '' }] } } : kitGuides(url)) }).fetch, version: V, editions: EN, gapMs: 0 });
  assert.equal(failWords(/** @type {any} */ (e.failed[0].said)), 'Wikivoyage sent no text for Cambria (California).');
  assert.equal(failWords({ code: 'no-text', title: 'Cambria' }), 'Wikivoyage sent no text for Cambria.', "one an older annai kept");
});

test("an error answer to a guide's text is said as the service's own, as a part's and the names' are, not as no text", async () => {
  const { ws, trip } = await packTrip();
  const net = services({ wikivoyage: (url) => (new URL(url).searchParams.get('prop') === 'extracts' ? { error: { code: 'maxlag', info: 'Waiting for a database server' } } : kitGuides(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0 });
  assert.ok(m.failed.length > 0);
  assert.deepEqual([...new Set(m.failed.map((f) => f.why))], ['Wikivoyage said: Waiting for a database server.']);
  assert.deepEqual(m.failed[0].said, { code: 'said', where: 'Wikivoyage', info: 'Waiting for a database server' });
});

test("what says a source is down: no answer, a 429 or a 5xx, a request that was late; not an answer annai can't use (a remark, an error answer, no text, unreadable), through Overpass's wrapper too", async () => {
  const dl = await import('../../src/core/pack/download.js');
  const said = (/** @type {any} */ s) => ({ label: 'x', why: 'y', said: s });
  assert.equal(typeof dl.saysDown, 'function');
  assert.equal(dl.saysDown(said(null)), true, 'no answer at all');
  assert.equal(dl.saysDown(said({ code: 'late', where: 'a' })), true);
  assert.equal(dl.saysDown(said({ code: 'status', status: 503 })), true);
  assert.equal(dl.saysDown(said({ code: 'status', status: 429 })), true);
  assert.equal(dl.saysDown(said({ code: 'osm', inner: null, message: null })), true, 'every server left');
  assert.equal(dl.saysDown(said({ code: 'osm', inner: { code: 'status', status: 504 }, message: 'x' })), true);
  assert.equal(dl.saysDown(said({ code: 'status', status: 404 })), false);
  assert.equal(dl.saysDown(said({ code: 'early', where: 'a', remark: 'r' })), false);
  assert.equal(dl.saysDown(said({ code: 'said', where: 'a', info: 'i' })), false);
  assert.equal(dl.saysDown(said({ code: 'no-text', title: 't' })), false);
  assert.equal(dl.saysDown(said({ code: 'unreadable', where: 'a' })), false);
  assert.equal(dl.saysDown(said({ code: 'osm', inner: { code: 'early', where: 'a', remark: 'r' }, message: 'x' })), false);
});

test("a Wikipedia request that never answers is given up after 25 s, the foreground's, so it holds one of the app's Wikimedia turns no longer; Overpass's keep their two minutes", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = services({ overpass: hangs, wikipedia: hangs, wikivoyage: hangs });
  /** Lets what has started run for a few turns (real time: the timers are faked). */
  const turns = async () => {
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    /** @type {import('../../src/core/pack/download.js').Manifest | null} */
    let m = null;
    const done = downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: EN, gapMs: 0, busyMs: 1 }).then((x) => { m = x; });
    await turns();
    assert.deepEqual(net.asked.map((a) => new URL(a.url).hostname), ['en.wikipedia.org'], "Wikipedia's part first");
    mock.timers.tick(24_999);
    await turns();
    assert.equal(net.asked.length, 1, 'still waiting for it a moment before 25 s');
    mock.timers.tick(1);
    await turns();
    // Cut at 25 s: the guides' names lookup comes next (Wikivoyage is Wikimedia's too), then Overpass.
    assert.deepEqual(net.asked.map((a) => new URL(a.url).hostname), ['en.wikipedia.org', 'en.wikivoyage.org']);
    mock.timers.tick(25_000);
    await turns();
    assert.equal(net.asked.at(-1)?.url.includes('overpass'), true, 'then OpenStreetMap');
    const overpassAsked = net.asked.length;
    mock.timers.tick(100_000);
    await turns();
    assert.equal(net.asked.length, overpassAsked, "Overpass's request is still waiting at 125 s of the download, 100 s into its own");
    mock.timers.tick(20_000);
    await turns();
    assert.ok(net.asked.length > overpassAsked, "and cut at its own 120 s: the next server is asked");
    for (let k = 0; k < 40 && m === null; k++) {
      mock.timers.tick(120_000);
      await turns();
    }
    await done;
    assert.ok(m);
    assert.match(String(/** @type {any} */ (m).failed[0].why), /^Wikipedia didn't answer in time\.$/);
  } finally {
    mock.timers.reset();
  }
});
