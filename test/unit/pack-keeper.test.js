import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackKeeper } from '../../src/core/pack/keeper.js';
import { STALE_MS, guideFile, downloadPack, MANIFEST } from '../../src/core/pack/download.js';
import { packTrip, services, fakeAgent, wikivoyage as kitGuides, STOPS, YUFUIN, yufuinStop, yufuinAnswer } from './pack-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { SIZES, planFor } from '../../src/core/pack/plan.js';
import { readFile } from 'node:fs/promises';
import { packWords } from '../../src/ui/offline-pack.js';

/** @param {() => boolean | Promise<boolean>} ok */
async function until(ok, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** @param {{ connection?: string, visible?: boolean, now?: () => number }} [o] */
async function kit(o = {}) {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  let connection = o.connection ?? 'unknown';
  let visible = o.visible ?? true;
  // A short "hour": it counts from the end of the last run, whoever began it.
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1.2.3', connection: () => connection, visible: () => visible, fetch: net.fetch, quietMs: 20, pokeMs: 10, autoMs: 30, gapMs: 0, now: o.now });
  return { ...t, agent, net, keeper, set: (/** @type {{ connection?: string, visible?: boolean }} */ s) => { connection = s.connection ?? connection; visible = s.visible ?? visible; } };
}

test('status before any download: the stops, about how much it takes, nothing outdated', async () => {
  const t = await kit();
  const { keeper, trip } = t;
  const s = await keeper.status(trip);
  assert.equal(s.stops, 2);
  assert.equal(s.manifest, null);
  assert.equal(s.why, null);
  // Both stops' places, the 21 km between, both stops' summaries, and one guide (one for every two names), at the measured sizes.
  const plan = await planFor(t.ws, trip);
  const km = plan.parts.reduce((n, p) => n + (p.kind === 'osm' ? p.km : 0), 0);
  assert.equal(s.estimate, Math.round(2 * SIZES.osmStop + km * SIZES.osmPerKm + 2 * SIZES.wikipedia + SIZES.guide), String(s.estimate));
  assert.equal(s.running, null);
  keeper.dispose();
});

test("one download at a time, with progress; then the pack is up to date, and the trip's log says so", async () => {
  const { keeper, trip, store } = await kit();
  /** @type {any[]} */
  const seen = [];
  keeper.onChange(() => seen.push(keeper.running && { ...keeper.running }));
  const a = keeper.download(trip);
  assert.equal(keeper.download(trip), a);
  const m = await a;
  assert.equal(m.files.length, 7);
  assert.ok(seen.some((r) => r?.total > 0 && r.label));
  assert.equal(seen.at(-1), null);
  const s = await keeper.status(trip);
  assert.equal(s.why, null);
  assert.ok(s.manifest);
  const log = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['pack.download'] }));
  assert.deepEqual(log.map((e) => e.data), [{ files: 7, bytes: m.bytes, guides: 2, failed: 0, stopped: false, auto: false }]);
  keeper.dispose();
});

test('why an update: the plan changed, parts are missing, or it is a month old', async () => {
  let now = Date.now();
  const { keeper, trip, ws } = await kit({ now: () => now });
  await keeper.download(trip);
  await ws.write(trip, '/plan/mcway.json', { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at: '2026-11-27T21:45:00Z' }, place: { name: 'McWay Falls', lat: 36.158, lng: -121.672 } }, { author: 'user' });
  const changed = await keeper.status(trip);
  assert.equal(changed.why, 'plan');
  assert.ok(changed.estimate > 0);
  await ws.delete(trip, '/plan/mcway.json', { author: 'user' });
  const m = /** @type {any} */ (await ws.readJSON(trip, '/offline/pack.json'));
  await ws.delete(trip, m.files[0].path, { author: 'user' });
  assert.equal((await keeper.status(trip)).why, 'missing');
  await keeper.download(trip);
  assert.equal((await keeper.status(trip)).why, null);
  now += STALE_MS + 1;
  assert.equal((await keeper.status(trip)).why, 'old');
  keeper.dispose();
});

test('stop() stops the download; what came stays', async () => {
  const { keeper, trip } = await kit();
  const off = keeper.onChange(() => { if ((keeper.running?.done ?? 0) >= 2) keeper.stop(); });
  const m = await keeper.download(trip);
  off();
  assert.equal(m.stopped, true);
  assert.equal((await keeper.status(trip)).why, 'missing');
  keeper.dispose();
});

test('opening another trip stops a running download (choice 10)', async () => {
  const { keeper, trip, agent } = await kit();
  const off = keeper.onChange(() => { if (keeper.running?.done === 1) agent.open(null); });
  const m = await keeper.download(trip);
  off();
  assert.equal(m.stopped, true);
  keeper.dispose();
});

test('on Wi-Fi an outdated pack is brought up to date by itself once the plan is quiet; not on mobile data, not before a first download, not hidden', async () => {
  const { keeper, trip, ws, net, set } = await kit({ connection: 'cellular' });
  const plan = (/** @type {number} */ lat) => ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat } }, { author: 'user' });
  await plan(36.2);
  set({ connection: 'wifi' });
  keeper.poke();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, 0, 'no first download by itself');
  await keeper.download(trip);
  const asked = net.asked.length;
  set({ connection: 'cellular' });
  await plan(36.19);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, asked, 'not on mobile data');
  set({ connection: 'wifi', visible: false });
  keeper.poke();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, asked, 'not while annai is hidden');
  set({ visible: true });
  keeper.poke();
  await until(async () => (await keeper.status(trip)).why === null && net.asked.length > asked);
  const log = await keeper.o.store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['pack.download'] }));
  assert.equal(log.at(-1)?.data.auto, true);
  keeper.dispose();
});

test('by itself at most once an hour, even when parts keep failing', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  let fail = false;
  const net = services({ overpass: (url, init) => (fail ? new Response('', { status: 503 }) : { elements: [] }) });
  let now = Date.now();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0, now: () => now });
  await keeper.download(t.trip);
  now += 2 * 3_600_000; // the hour from the run by hand is out
  fail = true;
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await until(async () => ((await keeper.status(t.trip)).manifest?.failed.length ?? 0) > 0); // the update by itself ran, and failed in part
  const asked = net.asked.length;
  keeper.poke();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(net.asked.length, asked);
  keeper.dispose();
});

test("live mode's names come from the open trip's pack", async () => {
  const { keeper, trip, agent } = await kit();
  const here = { lat: 36.3715, lng: -121.9017 };
  assert.equal(keeper.name(here), null);
  await keeper.download(trip);
  await until(() => keeper.name(here) !== null);
  assert.equal(keeper.name(here)?.name, 'Bixby Creek Bridge');
  agent.open(null);
  await until(() => keeper.name(here) === null);
  keeper.dispose();
});

test('a plan change while a download runs is kept: once it ends, annai brings the pack up to date by itself on Wi-Fi', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  /** @type {(v?: unknown) => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = r; });
  let calls = 0;
  let waiting = false;
  const net = services({ overpass: async () => {
    if (++calls === 2) {
      waiting = true;
      await gate;
    }
    return { elements: [] };
  } });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0 });
  const running = keeper.download(t.trip);
  await until(() => waiting);
  // The plan changes while the second Overpass part waits for its answer.
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await new Promise((r) => setTimeout(r, 40)); // the plan is quiet: annai would update, but a download runs
  open();
  await running;
  await until(async () => (await keeper.status(t.trip)).why === null, 3000);
  const log = await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }));
  assert.deepEqual(log.map((e) => e.data.auto), [false, true]);
  keeper.dispose();
});

test('a pack an older annai stopped at its size limit (full: true) is missing what it lacks: "Download the rest", and on Wi-Fi it comes by itself', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 30, gapMs: 0 });
  try {
    const m = await keeper.download(t.trip);
    // As an older annai left it: a part it had no room for, and full.
    await t.ws.delete(t.trip, m.files[0].path, { author: 'system' });
    await t.ws.write(t.trip, '/offline/pack.json', JSON.stringify({ ...(await t.ws.readJSON(t.trip, '/offline/pack.json')), files: m.files.slice(1), full: true }), { author: 'system' });
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.match(String(packWords(s, 'wifi').button), /^Download the rest \(about /);
    assert.ok(packWords(s, 'wifi').lines.every((l) => !/limit|longer than a pack/.test(l)), 'no limit, and nothing left out');
    keeper.poke();
    await until(async () => (await keeper.status(t.trip)).why === null);
    assert.ok(!('full' in /** @type {any} */ (await t.ws.readJSON(t.trip, '/offline/pack.json'))));
  } finally {
    keeper.dispose();
  }
});

test("a pack the release before wrote with Japanese listed (its Wikipedia whole in both editions, its guides English's only, no voyage) is missing its Japanese guides alone: \"Download the rest\", about them, and nothing else is asked", async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'unknown', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0 });
  try {
    await updateAppSettings(t.ws, { languages: { spoken: ['ja'], answer: 'follow' } });
    await keeper.download(t.trip);
    // As the release before wrote it: no voyage, no also, and no Japanese guide's file.
    const m = /** @type {any} */ (await t.ws.readJSON(t.trip, '/offline/pack.json'));
    const ja = m.guides.flatMap((/** @type {any} */ g) => g.also.map((/** @type {any} */ a) => guideFile(g.title, a.edition).path));
    assert.ok(ja.length > 0);
    for (const path of ja) await t.ws.delete(t.trip, path, { author: 'system' });
    await t.ws.write(t.trip, '/offline/pack.json', JSON.stringify({ ...m, voyage: undefined, files: m.files.filter((/** @type {any} */ f) => !ja.includes(f.path)), guides: m.guides.map((/** @type {any} */ g) => ({ title: g.title, asked: g.asked, path: g.path })) }), { author: 'system' });
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.estimate, m.guides.length * SIZES.guideEdition, 'its guides in Japanese, nothing more');
    const asked = net.asked.length;
    await keeper.download(t.trip);
    const since = net.asked.slice(asked);
    assert.deepEqual(since.filter((a) => a.url.includes('wikipedia.org') || a.url.includes('overpass') || (a.url.includes('en.wikivoyage') && new URL(a.url).searchParams.get('prop') === 'extracts')), []);
    assert.deepEqual(since.filter((a) => a.url.includes('ja.wikivoyage.org') && new URL(a.url).searchParams.get('prop') === 'extracts').map((a) => new URL(a.url).searchParams.get('titles')), ['カンブリア']);
    assert.equal((await keeper.status(t.trip)).why, null);
  } finally {
    keeper.dispose();
  }
});

test("a language added: the pack's guides are missing in its edition (\"Download the rest\", about its guides and summaries there); on Wi-Fi they come by themselves, English's guides not again; a language taken off asks for nothing", async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 30, gapMs: 0 });
  try {
    await keeper.download(t.trip);
    assert.equal((await keeper.status(t.trip)).why, null);
    // Chinese and Korean added: two Wikipedia parts in each edition, and the pack's two guides in Chinese Wikivoyage; Korean has no Wikivoyage.
    await updateAppSettings(t.ws, { languages: { spoken: ['en', 'zh', 'ko'], answer: 'follow' } });
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.estimate, 4 * SIZES.wikiEdition + 2 * SIZES.guideEdition);
    assert.match(String(packWords(s, 'wifi').button), /^Download the rest \(about /);
    const asked = net.asked.length;
    await until(async () => (await keeper.status(t.trip)).why === null);
    const since = net.asked.slice(asked);
    assert.deepEqual(since.filter((a) => a.url.includes('en.wikivoyage.org') && new URL(a.url).searchParams.get('prop') === 'extracts'), [], "English's guides are not downloaded again");
    assert.deepEqual(since.filter((a) => a.url.includes('zh.wikivoyage.org') && new URL(a.url).searchParams.get('prop') === 'extracts').map((a) => new URL(a.url).searchParams.get('titles')), ['大蘇爾']);
    assert.ok(since.every((a) => !a.url.includes('ko.wikivoyage') && new URL(a.url).searchParams.get('lllang') !== 'ko'), 'nothing asked of a Wikivoyage there is none of');
    assert.deepEqual((await keeper.status(t.trip)).manifest?.voyage, ['en', 'zh']);
    // Chinese and Korean taken off: nothing is missing, and nothing is asked by itself.
    const now = net.asked.length;
    await updateAppSettings(t.ws, { languages: { spoken: ['en'], answer: 'follow' } });
    assert.equal((await keeper.status(t.trip)).why, null);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(net.asked.length, now);
  } finally {
    keeper.dispose();
  }
});

test('stop() can be awaited: once it settles, the download has ended and what came is written down', async () => {
  const t = await packTrip();
  let waiting = false;
  const net = services({ overpass: async (url, init) => {
    waiting = true;
    // Overpass takes its time; the stop cuts the wait short.
    await new Promise((r) => { init.signal.addEventListener('abort', r, { once: true }); });
    throw new DOMException('Stopped.', 'AbortError');
  } });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, gapMs: 0 });
  const running = keeper.download(t.trip);
  await until(() => waiting);
  await keeper.stop();
  assert.equal(keeper.running, null);
  assert.equal((await keeper.status(t.trip)).manifest?.stopped, true);
  assert.equal((await running).stopped, true);
  await keeper.stop(); // nothing running: settles at once
  keeper.dispose();
});

test('a pack is old once its oldest part is a month old, however recent its last update', async () => {
  let now = Date.now();
  const { keeper, trip, ws } = await kit({ now: () => now });
  await keeper.download(trip);
  now += 20 * 86_400_000;
  // Twenty days later the plan changes near Nepenthe: only the parts there are downloaded again.
  await ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await keeper.download(trip);
  assert.equal((await keeper.status(trip)).why, null);
  now += 11 * 86_400_000; // the parts around Bixby are now 31 days old
  assert.equal((await keeper.status(trip)).why, 'old');
  keeper.dispose();
});

test('a plan change while an update annai began by itself runs: once it ends, the pack is brought up to date again, without waiting an hour (fix pass L2)', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  /** @type {(v?: unknown) => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = r; });
  let gateOn = false;
  let waiting = false;
  const net = services({ overpass: async () => {
    if (gateOn && !waiting) {
      waiting = true;
      await gate;
    }
    return { elements: [] };
  } });
  let now = Date.now();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0, now: () => now });
  await keeper.download(t.trip); // the first, by hand
  now += 2 * 3_600_000;
  gateOn = true;
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await until(() => waiting); // annai's own update runs, waiting on Overpass
  // The plan changes again in the middle of it.
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.21 } }, { author: 'user' });
  await new Promise((r) => setTimeout(r, 40));
  open();
  await until(async () => (await keeper.status(t.trip)).why === null, 3000);
  const log = await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }));
  assert.deepEqual(log.map((e) => e.data.auto), [false, true, true]);
  keeper.dispose();
});

test("a change of languages is noticed: on Wi-Fi the new edition's files come by themselves, a reorder brings nothing, and live mode's names follow the order and the files", async () => {
  const t = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const agent = fakeAgent(t.trip);
  const net = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 30, gapMs: 0 });
  try {
    await keeper.download(t.trip); // by hand: the hour is 30 ms here
    const station = { lat: 33.2626, lng: 131.3551 };
    // 湯布院町 is a Japanese article alone: English Wikipedia names another place at its point.
    const town = { lat: 33.26442, lng: 131.35558 };
    await until(() => keeper.name(station)?.name === 'Yufuin Station');
    assert.equal(keeper.name(town)?.name, 'Yufuin Onsen');
    assert.equal((await keeper.status(t.trip)).why, null);
    const hosts = () => net.asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname);
    assert.deepEqual(hosts(), ['en.wikipedia.org']);
    // Japanese added, after English: its files are missing, about one other edition's part, and annai brings them by itself.
    await updateAppSettings(t.ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.estimate, SIZES.wikiEdition + SIZES.guide + SIZES.guideEdition); // and a guide, in English and Japanese, as the pack has none yet
    await until(async () => hosts().length === 2 && (await keeper.status(t.trip)).why === null);
    assert.deepEqual(hosts(), ['en.wikipedia.org', 'ja.wikipedia.org']);
    // The names read the new files (the pack is read again), English first all the same where English has an article.
    await until(() => keeper.name(town)?.name === '湯布院町');
    assert.equal(keeper.name(station)?.name, 'Yufuin Station', 'English first');
    // Japanese moved first: nothing to download, and the names are Japanese Wikipedia's.
    const asked = net.asked.length;
    await updateAppSettings(t.ws, { languages: { spoken: ['ja', 'en'], answer: 'follow' } });
    await until(() => keeper.name(station)?.name === '由布院駅');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(net.asked.length, asked);
  } finally {
    keeper.dispose();
  }
});

test("a pack from before editions, with Japanese listed: its English parts count as missing too, and come again with their ids; English alone, nothing", async () => {
  const t = await packTrip();
  const before = /** @type {Record<string, string>} */ (JSON.parse(await readFile(new URL('../fixtures/places/pack-before-editions.json', import.meta.url), 'utf8')));
  for (const [path, text] of Object.entries(before)) await t.ws.write(t.trip, path, text, { author: 'system' });
  const net = services({ overpass: () => ({ elements: [] }) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'unknown', fetch: net.fetch, gapMs: 0, now: () => Date.parse('2026-11-19T09:00:00Z') });
  try {
    assert.equal((await keeper.status(t.trip)).why, null, 'English alone: as it was');
    await updateAppSettings(t.ws, { languages: { spoken: ['ja', 'en'], answer: 'follow' } });
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.estimate, 2 * SIZES.wikipedia + 2 * SIZES.wikiEdition + 2 * SIZES.guideEdition); // two parts, each in English again and in Japanese, and its two guides in Japanese
    await keeper.download(t.trip);
    assert.deepEqual(net.asked.filter((a) => a.url.includes('wikipedia.org')).map((a) => new URL(a.url).hostname).sort(), ['en.wikipedia.org', 'en.wikipedia.org', 'ja.wikipedia.org', 'ja.wikipedia.org']);
    assert.equal((await keeper.status(t.trip)).why, null, 'every part has its edition now');
  } finally {
    keeper.dispose();
  }
});

test("a download that stopped before its manifest: the files it left, which the manifest doesn't name, count as missing; the next download names them and the keeper is content", async () => {
  const t = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  const keeper = (/** @type {string} */ locale) => new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale, version: '1', connection: () => 'unknown', fetch: net.fetch, gapMs: 0 });
  const english = keeper('en-US');
  const japanese = keeper('ja-JP');
  try {
    await english.download(t.trip);
    assert.equal((await japanese.status(t.trip)).why, 'missing', 'Japanese is listed, its files are not there');
    // The page is closed after the files are written and before the manifest is.
    const anyWs = /** @type {any} */ (t.ws);
    const writeMany = anyWs.writeMany;
    anyWs.writeMany = async () => { throw new Error('the page closed'); };
    await assert.rejects(japanese.download(t.trip), /the page closed/);
    anyWs.writeMany = writeMany;
    assert.equal((await japanese.status(t.trip)).why, 'missing', 'the Japanese file is on disk, the manifest does not name it');
    const asked = net.asked.length;
    await japanese.download(t.trip);
    // Wikipedia was asked twice in all, English's part by the English keeper and Japanese's by the Japanese download that stopped; this one asked it nothing.
    assert.equal(net.asked.filter((a) => a.url.includes('wikipedia.org')).length, 2);
    assert.deepEqual(net.asked.slice(asked).filter((a) => !a.url.includes('wikivoyage')), []);
    assert.equal((await japanese.status(t.trip)).why, null);
  } finally {
    english.dispose();
    japanese.dispose();
  }
});

/** A keeper on Wi-Fi with a short "hour", over a trip with the two Big Sur stops, and the plan change that makes an update due. @param {Parameters<typeof services>[0]} [o] @param {number} [autoMs] the hour, in ms */
async function hourly(o = {}, autoMs = 400) {
  const t = await packTrip();
  const net = services({ overpass: () => ({ elements: [] }), ...o });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs, gapMs: 0 });
  const move = (/** @type {number} */ lat) => t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat } }, { author: 'user' });
  const autoRuns = async () => (await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }))).filter((e) => e.data.auto);
  const { began, ended } = watching(keeper);
  return { ...t, net, keeper, move, autoRuns, began, ended };
}

/** When each of a keeper's downloads began and ended (the hour is counted from a run's end). @param {PackKeeper} keeper */
function watching(keeper) {
  /** @type {number[]} */
  const began = [];
  /** @type {number[]} */
  const ended = [];
  let on = false;
  keeper.onChange(() => {
    if (keeper.running && !on) began.push(Date.now());
    if (!keeper.running && on) ended.push(Date.now());
    on = keeper.running !== null;
  });
  return { began, ended };
}

test("a change right after an update annai began by itself is not held for the hour: annai brings the pack up to date by itself once the plan is quiet", async () => {
  const { keeper, trip, move, autoRuns, began } = await hourly({}, 1000);
  try {
    await keeper.download(trip); // by hand
    await move(36.2);
    await until(async () => (await autoRuns()).length === 1);
    const at = Date.now();
    await move(36.19); // inside the hour
    await until(async () => (await autoRuns()).length === 2 && (await keeper.status(trip)).why === null, 3000);
    assert.equal(began.length, 3, 'by hand, and twice by itself');
    assert.ok(began[2] - at < 500, `the second run began ${began[2] - at} ms after the change: the quiet (10 ms here), not the hour (1000)`);
  } finally {
    keeper.dispose();
  }
});

test("an update annai began by itself that failed in part is tried again by itself, once an hour at most, with nothing else to wake it", async () => {
  let down = false;
  const { keeper, trip, net, move, autoRuns, began, ended } = await hourly({ overpass: () => (down ? new Response('', { status: 503 }) : { elements: [] }) });
  try {
    await keeper.download(trip);
    down = true;
    await move(36.2);
    await until(async () => ((await keeper.status(trip)).manifest?.failed.length ?? 0) > 0);
    down = false;
    const asked = net.asked.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(net.asked.length, asked, 'not before the hour is out');
    await until(async () => (await keeper.status(trip)).why === null, 3000);
    assert.equal((await autoRuns()).length, 2);
    assert.ok(began[2] - ended[1] >= 380, `the retry began an hour (400 ms here) after the failed run's end: ${began[2] - ended[1]}`);
    // It worked: nothing more is tried.
    const done = net.asked.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(net.asked.length, done);
  } finally {
    keeper.dispose();
  }
});

test("a plan change while an update annai began by itself runs, and that fails in part, is looked at at once: the failure's hour doesn't put it off", async () => {
  const t = await packTrip();
  /** @type {(v?: unknown) => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = r; });
  let gateOn = false;
  let waiting = false;
  let refuse = 0;
  const net = services({ overpass: async () => {
    if (gateOn && !waiting) {
      waiting = true;
      await gate;
      refuse = 3; // every server, for the first part
    }
    return refuse-- > 0 ? new Response('', { status: 503 }) : { elements: [] };
  } });
  let now = Date.now();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0, now: () => now });
  try {
    await keeper.download(t.trip); // by hand
    now += 2 * 3_600_000;
    gateOn = true;
    await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
    await until(() => waiting);
    await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.21 } }, { author: 'user' });
    await new Promise((r) => setTimeout(r, 40));
    open();
    // The run ends with a part failed, and the change made during it is looked at within the poke (5 ms here), not at the hour's end (the clock doesn't move).
    await until(async () => (await keeper.status(t.trip)).why === null, 3000);
    const log = await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }));
    assert.deepEqual(log.map((e) => [e.data.auto, e.data.failed > 0]), [[false, false], [true, true], [true, false]]);
  } finally {
    keeper.dispose();
  }
});

test("the plan is looked at once it has been quiet for the quiet time: changes that keep coming keep the update off until they stop", async () => {
  const t = await packTrip();
  const net = services({ overpass: () => ({ elements: [] }) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 150, pokeMs: 5, autoMs: 30, gapMs: 0 });
  /** @type {number[]} */
  const began = [];
  let on = false;
  keeper.onChange(() => {
    if (keeper.running && !on) began.push(Date.now());
    on = keeper.running !== null;
  });
  try {
    await keeper.download(t.trip);
    let last = 0;
    for (let k = 0; k < 4; k++) {
      await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 + k / 100 } }, { author: 'user' });
      last = Date.now();
      await new Promise((r) => setTimeout(r, 60));
    }
    await until(() => began.length === 2, 3000);
    assert.ok(began[1] - last >= 140, `the update began ${began[1] - last} ms after the last change, not 150 after the first`);
    await until(async () => (await keeper.status(t.trip)).why === null, 3000);
  } finally {
    keeper.dispose();
  }
});

test("a settings write looks at the pack only when the languages' editions changed: a switch, or the same languages again, changes nothing here", async () => {
  const t = await packTrip();
  const net = services({ overpass: () => ({ elements: [] }) });
  /** @type {string} */
  let connection = 'cellular';
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => connection, fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 30, gapMs: 0 });
  try {
    await keeper.download(t.trip);
    // The plan changes on mobile data: an update is due, and waits for Wi-Fi (nothing pokes the keeper when the phone joins it, here).
    await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
    await new Promise((r) => setTimeout(r, 60));
    connection = 'wifi';
    const asked = net.asked.length;
    await updateAppSettings(t.ws, { places: { vkOverpass: true } });
    await updateAppSettings(t.ws, { languages: { spoken: ['en'], answer: 'follow' } }); // the same editions: English
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(net.asked.length, asked, 'nothing asked for a setting that is not a language');
    await updateAppSettings(t.ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
    await until(async () => net.asked.length > asked && (await keeper.status(t.trip)).why === null, 3000);
  } finally {
    keeper.dispose();
  }
});

test("a plan change after annai's own update, then a language added: each comes by itself once the plan is quiet, not an hour on; then nothing more is asked (shape 4)", async () => {
  const { keeper, trip, ws, net, move, autoRuns, began } = await hourly({}, 1000);
  try {
    await keeper.download(trip);
    let at = Date.now();
    await move(36.2);
    await until(async () => (await autoRuns()).length === 1 && (await keeper.status(trip)).why === null);
    assert.ok(began[1] - at < 500, `the plan change's run began ${began[1] - at} ms after it`);
    const asked = net.asked.length;
    at = Date.now();
    await updateAppSettings(ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
    await until(async () => (await autoRuns()).length === 2 && (await keeper.status(trip)).why === null, 3000);
    assert.ok(began[2] - at < 500, `the language's run began ${began[2] - at} ms after it: the quiet (10 ms here), not the hour (1000)`);
    assert.ok(net.asked.slice(asked).some((a) => a.url.includes('ja.wikipedia.org')));
    const done = net.asked.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(net.asked.length, done, 'nothing more is asked');
    assert.equal(began.length, 3);
  } finally {
    keeper.dispose();
  }
});

/**
 * A keeper whose connection the test sets, over the two Big Sur stops, with Overpass held at its next request when armed: that request ends
 * only with the run's own signal (as a real fetch's does), or when the test lets it go.
 */
async function leaving(autoMs = 30) {
  const t = await packTrip();
  let connection = 'wifi';
  let armed = false;
  let waiting = false;
  /** @type {boolean | undefined} */
  let cutShort;
  /** @type {() => void} */
  let release = () => {};
  const letGo = new Promise((r) => { release = () => r(undefined); });
  const net = services({ overpass: async (url, init) => {
    if (!armed) return { elements: [] };
    armed = false;
    waiting = true;
    await Promise.race([letGo, new Promise((r) => init.signal.addEventListener('abort', r, { once: true }))]);
    cutShort = init.signal.aborted;
    if (cutShort) throw new DOMException('Stopped.', 'AbortError');
    return { elements: [] };
  } });
  const agent = fakeAgent(t.trip);
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, locale: 'en-US', version: '1', connection: () => connection, fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs, gapMs: 0 });
  const move = (/** @type {number} */ lat) => t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat } }, { author: 'user' });
  const log = async () => (await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }))).map((e) => e.data);
  return { ...t, agent, net, keeper, move, log, release: () => release(), arm: () => { armed = true; waiting = false; }, waiting: () => waiting, cutShort: () => cutShort, set: (/** @type {string} */ c) => { connection = c; } };
}

test('an update annai began by itself on Wi-Fi stops when the phone leaves Wi-Fi: what came stays, and the next look on Wi-Fi goes on', async () => {
  const k = await leaving();
  const { keeper, trip, net } = k;
  try {
    await keeper.download(trip); // by hand
    k.arm();
    await k.move(36.2);
    await until(() => k.waiting()); // annai's own update runs, waiting on Overpass
    k.set('cellular');
    keeper.poke(); // the connection changed (main.js pokes on it)
    await until(async () => keeper.running === null && (await k.log()).length === 2);
    assert.equal(k.cutShort(), true, 'the request it waited for was cut short by the stop');
    const s = await keeper.status(trip);
    assert.equal(s.manifest?.stopped, true);
    assert.equal(s.why, 'missing');
    assert.ok((s.manifest?.files.length ?? 0) > 0, 'what came stays');
    const asked = net.asked.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(net.asked.length, asked, 'nothing more over mobile data, though the hour is out');
    // Back on Wi-Fi: the next look goes on, and finishes the pack.
    k.set('wifi');
    keeper.poke();
    await until(async () => (await keeper.status(trip)).why === null, 3000);
    assert.deepEqual((await k.log()).map((d) => d.auto), [false, true, true]);
  } finally {
    keeper.dispose();
  }
});

test('a download the traveller started goes on when the phone leaves Wi-Fi: the stop is for what annai began by itself', async () => {
  const k = await leaving();
  const { keeper, trip } = k;
  try {
    k.arm();
    const running = keeper.download(trip); // by hand
    await until(() => k.waiting());
    k.set('cellular');
    keeper.poke();
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual(keeper.running, null, 'still running');
    k.release();
    const m = await running;
    assert.equal(k.cutShort(), false);
    assert.equal(m.stopped, false);
  } finally {
    keeper.dispose();
  }
});

test("an update that failed in part is tried again by itself only where a source is down: an answer annai can't use (Overpass stopping early) waits for the traveller's Try again", async () => {
  let mode = 'fine';
  const { keeper, trip, net, move, autoRuns } = await hourly({ overpass: () => (mode === 'early' ? { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' } : { elements: [] }) });
  try {
    await keeper.download(trip);
    mode = 'early';
    await move(36.2);
    await until(async () => (await autoRuns()).length === 1);
    const asked = net.asked.length;
    await new Promise((r) => setTimeout(r, 700)); // the hour here is 400 ms
    assert.equal((await autoRuns()).length, 1, 'not tried again by itself');
    assert.equal(net.asked.length, asked);
    const s = await keeper.status(trip);
    assert.equal(s.why, 'missing', 'the panel still offers Try again');
    assert.ok((s.manifest?.failed.length ?? 0) > 0);
  } finally {
    keeper.dispose();
  }
});

test("one rule for every look: an update that failed in part on an answer annai can't use is not started again by a poke after the hour either (the app opened, back to the tab); the traveller's Try again does it", async () => {
  let mode = 'fine';
  const { keeper, trip, net, move, autoRuns } = await hourly({ overpass: () => (mode === 'early' ? { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' } : { elements: [] }) });
  try {
    await keeper.download(trip);
    mode = 'early';
    await move(36.2);
    await until(async () => (await autoRuns()).length === 1);
    await new Promise((r) => setTimeout(r, 450)); // the hour here is 400 ms
    const asked = net.asked.length;
    keeper.poke();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await autoRuns()).length, 1, 'a poke does not ask again');
    assert.equal(net.asked.length, asked);
    // The traveller's Try again does, and it works once Overpass does.
    mode = 'fine';
    await keeper.download(trip);
    assert.equal((await keeper.status(trip)).why, null);
  } finally {
    keeper.dispose();
  }
});

/** A keeper over the two stops whose clock the test moves, with Overpass saying what `overpass.mode` says. */
async function aging() {
  const t = await packTrip();
  const overpass = { mode: 'fine' };
  const net = services({ overpass: () => (overpass.mode === 'early' ? { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' } : { elements: [] }) });
  const clock = { now: Date.now() };
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 400, gapMs: 0, now: () => clock.now });
  const autoRuns = async () => (await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }))).filter((e) => e.data.auto);
  return { ...t, net, keeper, overpass, clock, autoRuns };
}

test("a pack that is a month old is brought up to date by itself even where an answer annai can't use is among its failures (a failure leaves 'missing' first, 'old' still counts)", async () => {
  const { keeper, trip, overpass, clock, autoRuns } = await aging();
  try {
    overpass.mode = 'early';
    await keeper.download(trip);
    const s = await keeper.status(trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.byItself, false, 'a failure annai would only meet again waits for Try again');
    clock.now += STALE_MS + 1;
    const old = await keeper.status(trip);
    assert.equal(old.why, 'missing', 'a failure still comes first in the panel');
    assert.equal(old.byItself, true);
    keeper.poke();
    await until(async () => (await autoRuns()).length === 1);
  } finally {
    keeper.dispose();
  }
});

test("a language added to a pack with a failure annai can't use among them is still brought by itself: its files are missing, no failure accounts for them", async () => {
  const { keeper, trip, ws, net, overpass, clock, autoRuns } = await aging();
  try {
    overpass.mode = 'early';
    await keeper.download(trip);
    clock.now += 1000; // the hour (400 ms here) from the run by hand is out
    assert.equal((await keeper.status(trip)).byItself, false);
    await updateAppSettings(ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
    assert.equal((await keeper.status(trip)).byItself, true);
    await until(async () => (await autoRuns()).length === 1);
    assert.ok(net.asked.some((a) => a.url.includes('ja.wikipedia.org')));
  } finally {
    keeper.dispose();
  }
});

test('a tap on Download while annai\'s own run goes makes it the traveller\'s: it goes on when the phone leaves Wi-Fi', async () => {
  const k = await leaving();
  const { keeper, trip } = k;
  try {
    await keeper.download(trip); // by hand
    k.arm();
    await k.move(36.2);
    await until(() => k.waiting()); // annai's own update runs, waiting on Overpass
    const run = keeper.download(trip); // a tap on a button drawn before the run began
    k.set('cellular');
    keeper.poke();
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual(keeper.running, null, 'still running');
    k.release();
    const m = await run;
    assert.equal(k.cutShort(), false);
    assert.equal(m.stopped, false);
  } finally {
    keeper.dispose();
  }
});

test("back on Wi-Fi while a stopped run is winding down: the look then is not lost, and the run goes on an hour after the stop, not never (shape 10)", async () => {
  const k = await leaving(600); // the hour here
  const { keeper, trip, ws } = k;
  const write = ws.writeMany.bind(ws);
  let slow = false;
  // The run's end (its manifest) takes a while, as on a big trip.
  ws.writeMany = async (...a) => {
    if (slow) await new Promise((r) => setTimeout(r, 300));
    return write(...a);
  };
  const { began, ended } = watching(keeper);
  try {
    await keeper.download(trip); // by hand
    k.arm();
    await k.move(36.2);
    await until(() => k.waiting()); // annai's own update, waiting on Overpass
    slow = true;
    k.set('cellular');
    keeper.poke(); // the stop begins
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(keeper.running, null, 'winding down');
    k.set('wifi');
    keeper.poke(); // back on Wi-Fi, while the run is still ending: #auto finds the job and returns
    await until(async () => (await keeper.status(trip)).why === null, 6000);
    assert.deepEqual((await k.log()).map((d) => d.auto), [false, true, true]);
    assert.ok(began[2] - ended[1] >= 570, `an hour (600 ms here) after the stopped run's end: ${began[2] - ended[1]}`);
  } finally {
    keeper.dispose();
  }
});

test("what annai brings by itself, by the manifest alone: a run that was stopped, a source that was down, an edition lacking, a plan changed; not an answer annai can't use", async () => {
  const { keeper, trip, ws } = await aging();
  try {
    await keeper.download(trip);
    const m = /** @type {any} */ (await ws.readJSON(trip, '/offline/pack.json'));
    /** @param {any} change */
    const withManifest = async (change) => {
      await ws.write(trip, '/offline/pack.json', { ...m, ...change }, { author: 'system' });
      return keeper.status(trip);
    };
    assert.deepEqual(await keeper.status(trip).then((s) => [s.why, s.byItself]), [null, false], 'nothing to bring');
    // Stopped, with every part there and nothing failed (the stop came at the end of the run).
    assert.deepEqual(await withManifest({ stopped: true }).then((s) => [s.why, s.byItself]), ['missing', true]);
    // A failure with its source down: no answer, a 429, a 5xx; or one an older annai kept (it says nothing of why).
    const part = { source: 'osm', place: { how: 'around', names: ['Nepenthe'] } };
    for (const said of [null, { code: 'late', where: 'overpass-api.de' }, { code: 'status', where: 'overpass-api.de', status: 429 }, { code: 'status', where: 'overpass-api.de', status: 503 }]) {
      assert.equal((await withManifest({ failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'x', part, said }] })).byItself, true, JSON.stringify(said));
    }
    // An answer annai can't use: waits for the traveller (a file for the part is there, as an older run left it).
    for (const said of [{ code: 'early', where: 'overpass-api.de', remark: 'x' }, { code: 'said', where: 'Wikipedia', info: 'x' }, { code: 'no-text', title: 'Big Sur' }, { code: 'unreadable', where: 'overpass-api.de' }]) {
      assert.deepEqual(await withManifest({ failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'x', part, said }] }).then((s) => [s.why, s.byItself]), ['missing', false], JSON.stringify(said));
    }
    // A language whose guides were never looked for (every file is there): lacking, the pack asked English only.
    await updateAppSettings(ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
    await keeper.download(trip);
    const whole = /** @type {any} */ (await ws.readJSON(trip, '/offline/pack.json'));
    assert.deepEqual(await keeper.status(trip).then((s) => [s.why, s.byItself]), [null, false]);
    await ws.write(trip, '/offline/pack.json', { ...whole, voyage: ['en'] }, { author: 'system' });
    assert.deepEqual(await keeper.status(trip).then((s) => [s.why, s.byItself]), ['missing', true]);
  } finally {
    keeper.dispose();
  }
});

test("a language with no Wikivoyage added to a pack whose guides failed (no text) is brought by itself: the missing parts are counted against the parts' failures, not the guides'", async () => {
  const t = await packTrip();
  // Both guides come with no text: two failures an answer annai can't use, which wait for Try again; they are not parts of the plan.
  const net = services({ wikivoyage: (url) => (new URL(url).searchParams.get('prop') === 'extracts' ? { query: { pages: [{ title: 'x', extract: '' }] } } : kitGuides(url)) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'unknown', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0 });
  try {
    await keeper.download(t.trip);
    const before = await keeper.status(t.trip);
    assert.deepEqual(before.manifest?.failed.map((f) => f.part?.source), ['wikivoyage', 'wikivoyage']);
    assert.equal(before.why, 'missing');
    assert.equal(before.byItself, false, 'no text waits for Try again');
    // Korean added: it has no Wikivoyage, and its two Wikipedia parts are missing, which no failure accounts for.
    await updateAppSettings(t.ws, { languages: { spoken: ['en', 'ko'], answer: 'follow' } });
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.byItself, true);
  } finally {
    keeper.dispose();
  }
});

test("a stopped run rests an hour from its end, the traveller's Stop included: a look right after it (back to the tab, a connection change) doesn't start the run again, however long the run had gone on", async () => {
  const t = await packTrip();
  const net = services({ overpass: () => ({ elements: [] }) });
  const clock = { now: Date.now() };
  // A phone tethered to a friend's hotspot says Wi-Fi: the traveller stops the download to save the friend's data.
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 300, gapMs: 0, now: () => clock.now });
  const autoRuns = async () => (await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }))).filter((e) => e.data.auto);
  try {
    let stopped = false;
    const off = keeper.onChange(() => {
      if ((keeper.running?.done ?? 0) >= 2 && !stopped) {
        stopped = true;
        clock.now += 1000; // the run has gone on past the hour (300 ms here) when the traveller stops it
        keeper.stop();
      }
    });
    const m = await keeper.download(t.trip);
    off();
    assert.equal(m.stopped, true);
    assert.equal((await keeper.status(t.trip)).byItself, true, 'a stopped run is brought on by itself');
    const asked = net.asked.length;
    keeper.poke();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(net.asked.length, asked, "the stopped run rests: the look did not start it again");
    assert.equal((await autoRuns()).length, 0);
    // The hour from the Stop is out: the run goes on by itself.
    clock.now += 400;
    keeper.poke();
    await until(async () => (await keeper.status(t.trip)).why === null, 3000);
    assert.equal((await autoRuns()).length, 1);
  } finally {
    keeper.dispose();
  }
});

test("a look that falls on a download the traveller runs is not lost: once it ends, annai looks again, and an automatic run comes an hour (150 ms here) after the traveller's run ended, not at once and not never", async () => {
  const t = await packTrip();
  let down = true;
  const net = services({ overpass: () => (down ? new Response('', { status: 503 }) : { elements: [] }) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 150, gapMs: 0 });
  const { began, ended } = watching(keeper);
  const autoRuns = async () => (await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }))).filter((e) => e.data.auto);
  try {
    await keeper.download(t.trip); // by hand: Overpass is down, so the pack comes with failed parts, which annai brings on by itself
    assert.equal((await keeper.status(t.trip)).byItself, true);
    down = false;
    // Nothing pokes the keeper again: the end of the traveller's own run is the look.
    await until(async () => (await autoRuns()).length === 1 && (await keeper.status(t.trip)).why === null, 3000);
    assert.equal(began.length, 2);
    assert.ok(began[1] - ended[0] >= 140, `the automatic run began ${began[1] - ended[0]} ms after the traveller's run ended: the hour counts from any run's end`);
  } finally {
    keeper.dispose();
  }
});

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// The design check's table of when annai runs by itself (editions-a-keeper-designcheck.md, section 4). The hour is counted from the end of the last
// run, whoever began it and however it ended; a change that no run has begun since waits only for the quiet; a stopped run rests the hour whatever changed.

for (const when of /** @type {const} */ (['during', 'after'])) {
  test(`the traveller's Stop holds an hour from the Stop though the plan changed ${when} their run (shapes 1 and 2): no run for most of the hour, then one`, async () => {
    const k = await leaving(600); // the hour here
    const { keeper, trip } = k;
    const { began, ended } = watching(keeper);
    try {
      k.arm();
      const running = keeper.download(trip); // by hand
      await until(() => k.waiting());
      if (when === 'during') await k.move(36.2);
      await sleep(40); // the plan is quiet: a hold has to outlast that
      await keeper.stop();
      assert.equal((await running).stopped, true);
      if (when === 'after') await k.move(36.2);
      await sleep(360);
      assert.equal(began.length, 1, 'no run for most of the hour');
      assert.equal((await k.log()).length, 1);
      await until(() => began.length === 2, 3000);
      assert.ok(began[1] - ended[0] >= 570, `one run an hour (600 ms here) after the Stop: ${began[1] - ended[0]}`);
      await until(async () => (await keeper.status(trip)).why === null, 3000);
      assert.deepEqual((await k.log()).map((d) => d.auto), [false, true]);
    } finally {
      keeper.dispose();
    }
  });
}

test("a plan change after the traveller's whole download begins a run once the plan is quiet, well inside the hour (shape 3, call 1)", async () => {
  const { keeper, trip, move, autoRuns, began } = await hourly({}, 1000);
  try {
    await keeper.download(trip); // by hand
    const at = Date.now();
    await move(36.2);
    await until(async () => (await autoRuns()).length === 1 && (await keeper.status(trip)).why === null, 3000);
    assert.ok(began[1] - at < 500, `the run began ${began[1] - at} ms after the change: the quiet (10 ms here), not the hour (1000)`);
  } finally {
    keeper.dispose();
  }
});

test("annai's own run that goes on for most of the hour, then the traveller's Stop: no run until an hour from the Stop (shape 5)", async () => {
  const k = await leaving(500); // the hour here
  const { keeper, trip } = k;
  const { began, ended } = watching(keeper);
  try {
    await keeper.download(trip); // by hand
    k.arm();
    await k.move(36.2);
    await until(() => k.waiting()); // annai's own update runs, waiting on Overpass
    await sleep(400); // most of the hour
    await keeper.stop();
    assert.equal(began.length, 2);
    await sleep(300);
    assert.equal(began.length, 2, 'no run for most of the hour from the Stop');
    await until(() => began.length === 3, 3000);
    assert.ok(began[2] - ended[1] >= 470, `an hour (500 ms here) after the Stop: ${began[2] - ended[1]}`);
    await until(async () => (await keeper.status(trip)).why === null, 3000);
  } finally {
    keeper.dispose();
  }
});

test("a traveller's run that goes on longer than the hour and ends on 503s is retried an hour after its end, not at once (shape 6)", async () => {
  let slow = true;
  let down = true;
  const { keeper, trip, began, ended } = await hourly({ overpass: async () => {
    if (slow) {
      slow = false;
      await sleep(480); // longer than the hour (400 ms here)
    }
    return down ? new Response('', { status: 503 }) : { elements: [] };
  } });
  try {
    const m = await keeper.download(trip); // by hand
    assert.ok(m.failed.length > 0);
    down = false;
    await sleep(300);
    assert.equal(began.length, 1, 'not at once');
    await until(() => began.length === 2, 3000);
    assert.ok(began[1] - ended[0] >= 370, `the retry began an hour (400 ms here) after the run's end: ${began[1] - ended[0]}`);
    await until(async () => (await keeper.status(trip)).why === null, 3000);
  } finally {
    keeper.dispose();
  }
});

test("a relaunch keeps the Stop's hold: Stop, dispose, a new keeper over the same store, a look: held until an hour from the Stop (shape 7)", async () => {
  const k = await leaving(600); // the hour here
  const { keeper, trip, store, ws, net } = k;
  try {
    k.arm();
    const running = keeper.download(trip); // by hand
    await until(() => k.waiting());
    await keeper.stop();
    assert.equal((await running).stopped, true);
    const stoppedAt = Date.now();
    keeper.dispose();
    const again = new PackKeeper({ store, ws, agent: fakeAgent(trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 600, gapMs: 0 });
    try {
      const { began } = watching(again);
      again.poke();
      await sleep(360);
      assert.equal(began.length, 0, 'held');
      await until(() => began.length === 1, 3000);
      assert.ok(Date.now() - stoppedAt >= 500, `the run began an hour (600 ms here) after the Stop: ${Date.now() - stoppedAt}`);
      await until(async () => (await again.status(trip)).why === null, 3000);
    } finally {
      again.dispose();
    }
  } finally {
    keeper.dispose();
  }
});

for (const why of /** @type {const} */ (['plan change', 'old pack'])) {
  test(`no loop: a run that writes no manifest after a ${why} gives one automatic run at once, then one an hour on (shape 8)`, async () => {
    const t = await packTrip();
    const net = services({ overpass: () => ({ elements: [] }) });
    await downloadPack({ ws: t.ws, scope: t.trip, fetch: net.fetch, version: '1', editions: ['en'], gapMs: 0 }); // an earlier session's pack
    const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 600, gapMs: 0 });
    const { began, ended } = watching(keeper);
    try {
      // The page closes after the files are written and before the manifest is: no manifest comes, and what made the update due stays.
      const anyWs = /** @type {any} */ (t.ws);
      if (why === 'old pack') await t.ws.patch(t.trip, MANIFEST, { at: new Date(Date.now() - 40 * 86_400_000).toISOString() }, { author: 'system' });
      anyWs.writeMany = async () => { throw new Error('the page closed'); };
      if (why === 'plan change') await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
      else keeper.poke();
      await until(() => began.length === 1 && ended.length === 1, 3000);
      await sleep(360);
      assert.equal(began.length, 1, 'not again within the hour');
      await until(() => began.length === 2, 3000);
      assert.ok(began[1] - ended[0] >= 570, `the next an hour (600 ms here) after the first's end: ${began[1] - ended[0]}`);
    } finally {
      keeper.dispose();
    }
  });
}

test("a manifest dated far ahead (another clock) with a source down: the run goes once and ends, and the looks do not spin (shape 9)", async () => {
  const t = await packTrip();
  const net = services({ overpass: () => ({ elements: [] }) });
  await downloadPack({ ws: t.ws, scope: t.trip, fetch: net.fetch, version: '1', editions: ['en'], gapMs: 0 });
  const m = /** @type {any} */ (await t.ws.readJSON(t.trip, MANIFEST));
  const part = { source: 'osm', place: { how: 'around', names: ['Nepenthe'] } };
  await t.ws.write(t.trip, MANIFEST, { ...m, at: new Date(Date.now() + 400 * 86_400_000).toISOString(), stopped: true, failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'x', part, said: { code: 'late', where: 'overpass-api.de' } }] }, { author: 'system' });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 400, gapMs: 0 });
  let looks = 0;
  const status = keeper.status.bind(keeper);
  keeper.status = (scope) => {
    looks++;
    return status(scope);
  };
  const { began } = watching(keeper);
  try {
    keeper.poke();
    await until(() => began.length === 1, 3000);
    await until(async () => (await keeper.status(t.trip)).why === null, 3000);
    await sleep(300);
    assert.equal(began.length, 1, 'once');
    assert.ok(looks < 10, `${looks} looks`);
  } finally {
    keeper.dispose();
  }
});

test("another conversation opened during the traveller's download stops it; back, it rests an hour, and then goes on (shape 11, K4 as ruled)", async () => {
  const k = await leaving(600); // the hour here
  const { keeper, trip, agent } = k;
  const { began, ended } = watching(keeper);
  try {
    k.arm();
    const running = keeper.download(trip); // by hand
    await until(() => k.waiting());
    agent.open(null);
    assert.equal((await running).stopped, true);
    agent.open(trip);
    await sleep(360);
    assert.equal(began.length, 1, 'resting');
    await until(() => began.length === 2, 3000);
    assert.ok(began[1] - ended[0] >= 570, `an hour (600 ms here) after the stop: ${began[1] - ended[0]}`);
    await until(async () => (await keeper.status(trip)).why === null, 3000);
  } finally {
    keeper.dispose();
  }
});

test("a language whose names lookup answers something annai can't use (badvalue) waits for Try again: the pack says so, and five hours of looks ask Japanese nothing (shape 12)", async () => {
  const t = await packTrip();
  const net = services({ overpass: () => ({ elements: [] }), wikivoyage: (url) => (url.includes('ja.wikivoyage.org') && new URL(url).searchParams.get('prop')?.startsWith('pageprops') ? { error: { code: 'badvalue', info: 'Unrecognized value for parameter "prop".' } } : kitGuides(url)) });
  const clock = { now: Date.now() };
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), locale: 'en-US', version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, autoMs: 400, gapMs: 0, now: () => clock.now });
  try {
    await updateAppSettings(t.ws, { languages: { spoken: ['en', 'ja'], answer: 'follow' } });
    await keeper.download(t.trip);
    const s = await keeper.status(t.trip);
    assert.equal(s.why, 'missing');
    assert.equal(s.byItself, false);
    assert.deepEqual(s.manifest?.voyage, ['en']);
    const words = packWords(s, 'wifi');
    assert.match(String(words.button), /^Try again/);
    assert.ok(words.lines.every((l) => !/by itself/.test(l)), words.lines.join(' | '));
    const ja = () => net.asked.filter((a) => a.url.includes('ja.wikivoyage.org')).length;
    const asked = ja();
    for (let h = 0; h < 5; h++) {
      clock.now += 3_600_000;
      keeper.poke();
      await sleep(40);
    }
    assert.equal(ja(), asked, 'Japanese is asked nothing by itself');
  } finally {
    keeper.dispose();
  }
});
