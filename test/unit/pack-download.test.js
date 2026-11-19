import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPack, readManifest, MANIFEST, pathOf, STALE_MS } from '../../src/core/pack/download.js';
import { planFor } from '../../src/core/pack/plan.js';
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

test('three failures in a row from one source leave it for the rest of the run: no connection, broken answers and refusals are failures that say so, never crashes', async () => {
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
  assert.equal(rows.filter((t) => t === '由布院温泉').length, 1, 'in both parts and both editions: once');
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
  const same = services();
  await downloadPack({ ws, scope: trip, fetch: same.fetch, version: V, editions: ['en'], gapMs: 0, now });
  assert.deepEqual(same.asked.filter((a) => !a.url.includes('wikivoyage')), []);
  for (const p of Object.keys(BEFORE).filter((x) => x !== MANIFEST)) assert.equal(await ws.readText(trip, p), BEFORE[p], p);
  // Japanese listed, and Wikipedia down: OpenStreetMap and the guides are not asked again, and the English parts stay as they were.
  const down = services({ wikipedia: () => new Response('', { status: 503 }) });
  const d = await downloadPack({ ws, scope: trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, now });
  assert.deepEqual(down.asked.filter((a) => a.url.includes('overpass')), []);
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

test("a download that stopped before its manifest: the files it left keep the edition their path says, English's are asked again once (their ids are not known), and no file is read as another edition's", async () => {
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

test('a pack made with English alone takes Japanese listed first: only Japanese is asked, and English stays as it is', async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = () => services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url) });
  await downloadPack({ ws, scope: trip, fetch: net().fetch, version: V, editions: EN, gapMs: 0 });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const english = await ws.readText(trip, pathOf(part));
  const next = net();
  const m = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, editions: ['en', 'ja'], gapMs: 0 });
  assert.deepEqual(wikiHosts(next.asked), ['ja.wikipedia.org']);
  assert.equal(await ws.readText(trip, pathOf(part)), english);
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia').map((f) => f.edition).sort(), ['en', 'ja']);
  assert.equal(m.summaries, 26);
});

test("Wikipedia's parts come edition by edition in the reading order, every stop's part of one before the next's; a pack that fills up holds the first language at every stop and English at as many as fit", async () => {
  const { ws, trip } = await packTrip(farStops(3));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 3);
  const net = () => services({ overpass: noOsm, wikipedia: (url) => yufuinAnswer(url) });
  const all = net();
  const m = await downloadPack({ ws, scope: trip, fetch: all.fetch, version: V, editions: ['ja', 'en'], gapMs: 0 });
  assert.deepEqual(wikiHosts(all.asked), [...wikis.map(() => 'ja.wikipedia.org'), ...wikis.map(() => 'en.wikipedia.org')]);
  assert.deepEqual(m.failed, []);
  // A limit that holds the OpenStreetMap parts, every stop's Japanese and one English: not both languages at the first stops and nothing at the last.
  const size = (/** @type {string} */ edition) => m.files.filter((f) => f.kind === 'wikipedia' && f.edition === edition).map((f) => f.bytes);
  const limit = m.files.filter((f) => f.kind === 'osm').reduce((n, f) => n + f.bytes, 0) + size('ja').reduce((n, b) => n + b, 0) + Math.min(...size('en'));
  const small = await packTrip(farStops(3));
  const cut = await downloadPack({ ws: small.ws, scope: small.trip, fetch: net().fetch, version: V, editions: ['ja', 'en'], gapMs: 0, maxBytes: limit });
  assert.equal(cut.full, true);
  assert.ok(cut.bytes <= limit);
  assert.equal(cut.files.filter((f) => f.edition === 'ja').length, wikis.length, 'Japanese at every stop');
  assert.equal(cut.files.filter((f) => f.edition === 'en').length, 1, 'English where it fits');
  // The other way round: English at every stop, and Japanese where it fits.
  const english = await packTrip(farStops(3));
  const limitEn = m.files.filter((f) => f.kind === 'osm').reduce((n, f) => n + f.bytes, 0) + size('en').reduce((n, b) => n + b, 0) + Math.min(...size('ja'));
  const enFirst = await downloadPack({ ws: english.ws, scope: english.trip, fetch: net().fetch, version: V, editions: ['en', 'ja'], gapMs: 0, maxBytes: limitEn });
  assert.equal(enFirst.files.filter((f) => f.edition === 'en').length, wikis.length);
  assert.equal(enFirst.files.filter((f) => f.edition === 'ja').length, 1);
});

test("an edition whose host never answers is left after three parts in a row, so it costs three answer times, not one a part; the other editions' parts all come", async () => {
  const { ws, trip } = await packTrip(farStops(4));
  const wikis = (await planFor(ws, trip)).parts.filter((p) => p.kind === 'wikipedia');
  assert.ok(wikis.length >= 4);
  const net = services({ overpass: noOsm, wikipedia: (url, init) => (url.includes('zh.wikipedia.org') ? hangs(url, init) : yufuinAnswer(url)) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['zh', 'en'], gapMs: 0, answerMs: 30 });
  assert.equal(wikiHosts(net.asked).filter((h) => h === 'zh.wikipedia.org').length, 3);
  assert.equal(wikiHosts(net.asked).filter((h) => h === 'en.wikipedia.org').length, wikis.length);
  assert.deepEqual(m.failed.map((f) => f.why), Array(3).fill("zh.wikipedia.org didn't answer in time."));
  assert.equal(m.files.filter((f) => f.edition === 'en').length, wikis.length);
  assert.equal(m.stopped, true, 'it gave up on one');
  // Everything given up on is the connection down: the guides are not looked for.
  const down = services({ overpass: () => new Response('', { status: 503 }), wikipedia: () => new Response('', { status: 503 }) });
  const offline = await packTrip(farStops(4));
  const d = await downloadPack({ ws: offline.ws, scope: offline.trip, fetch: down.fetch, version: V, editions: ['ja', 'en'], gapMs: 0, busyMs: 1 });
  assert.equal(d.files.length, 0);
  assert.equal(down.asked.filter((a) => a.url.includes('wikivoyage')).length, 0);
});

test("a refresh of a pack at its size limit keeps the pack under it: the old copies of the parts it replaces count until they are replaced", async () => {
  const { ws, trip } = await packTrip();
  const first = await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  const later = () => Date.now() + STALE_MS + 86_400_000;
  // A month on, every part is old, and OpenStreetMap has more now: each part's new copy is bigger, so the limit (the pack's own size) can't hold them all.
  const added = Array.from({ length: 6 }, (_, k) => ({ type: 'node', id: 90 + k, lat: 36.3, lon: -121.9, tags: { name: `A viewpoint added since ${k}`, tourism: 'viewpoint' } }));
  const more = services({ overpass: (url, init) => ({ elements: [...overpass(url, init).elements, ...added] }) });
  const m = await downloadPack({ ws, scope: trip, fetch: more.fetch, version: V, editions: EN, gapMs: 0, now: later, maxBytes: first.bytes });
  const onDisk = (await ws.list(trip, '/offline/')).filter((f) => f.path !== MANIFEST).reduce((n, f) => n + f.size, 0);
  assert.equal(m.full, true);
  assert.ok(m.bytes <= first.bytes, `${m.bytes} > ${first.bytes}`);
  assert.ok(onDisk <= first.bytes, `${onDisk} on disk, over ${first.bytes}`);
  assert.equal(m.bytes, onDisk);
  // What could not be replaced stays as it was: every part. A guide's old copy stays only where it fits.
  assert.equal(m.files.filter((f) => f.kind !== 'wikivoyage').length, first.files.filter((f) => f.kind !== 'wikivoyage').length);
  assert.deepEqual(m.guides.map((g) => g.path).sort(), m.files.filter((f) => f.kind === 'wikivoyage').map((f) => f.path).sort());
});

test("a guide's old copy that would take the pack over its limit goes: the limit holds, the parts stay", async () => {
  const { ws, trip } = await packTrip();
  const first = await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  const parts = first.files.filter((f) => f.kind !== 'wikivoyage').reduce((n, f) => n + f.bytes, 0);
  assert.ok(first.guides.length > 0 && parts < first.bytes);
  const later = () => Date.now() + STALE_MS + 86_400_000;
  // A month on; the limit holds the parts, as they came again, and no guide.
  const m = await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0, now: later, maxBytes: parts });
  assert.equal(m.full, true);
  assert.equal(m.bytes, parts);
  assert.equal(m.files.filter((f) => f.kind !== 'wikivoyage').length, first.files.filter((f) => f.kind !== 'wikivoyage').length);
  assert.ok(m.files.filter((f) => f.kind !== 'wikivoyage').every((f) => f.at > Date.now() + STALE_MS), 'every part came again: the old copy of the one being replaced is not in the way');
  assert.deepEqual(m.guides, []);
  assert.deepEqual((await files(ws, trip)).filter((p) => p.includes('/wikivoyage/')), [], 'no guide file is left on the phone');
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

test("a Chinese (Traditional) pack: zh.wikipedia.org's rows in a file of their own, named zh in the manifest, linked on Chinese Wikipedia and read first", async () => {
  const shilin = { lat: 25.0879, lng: 121.5242 };
  const { ws, trip } = await packTrip({ '/plan/shilin.json': yufuinStop('Shilin Night Market', shilin, 1) });
  const saved = JSON.parse(await readFile(new URL('../fixtures/places/wiki-pack-shilin-zh.json', import.meta.url), 'utf8')); // the real answer of 2026-11-19
  const net = services({ overpass: noOsm, wikipedia: (url) => (url.includes('zh.wikipedia.org') ? saved : { batchcomplete: true }) });
  const m = await downloadPack({ ws, scope: trip, fetch: net.fetch, version: V, editions: ['zh', 'en'], gapMs: 0 });
  assert.deepEqual(m.failed, []);
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  assert.deepEqual(m.files.filter((f) => f.kind === 'wikipedia').map((f) => [f.path, f.edition, f.items]), [[`/offline/wikipedia/${part.id}.zh.json`, 'zh', 20], [`/offline/wikipedia/${part.id}.json`, 'en', 0]]);
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const rows = pack.pages(shilin, 10_000, ['zh', 'en']);
  assert.equal(rows.length, 20);
  assert.match(String(rows.find((r) => r[0] === '士林夜市')?.[6]), / https:\/\/zh\.wikipedia\.org\/wiki\/士林夜市$/);
  assert.equal(pack.name({ lat: 25.08522, lng: 121.52472 }, ['zh', 'en'])?.name, '士林夜市');
});
