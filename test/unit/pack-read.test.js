import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, toLine } from '../../src/core/pack/read.js';
import { downloadPack, MANIFEST, pathOf } from '../../src/core/pack/download.js';
import { planFor } from '../../src/core/pack/plan.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { readingEditions } from '../../src/core/wiki.js';
import { packTrip, services, YUFUIN, YUFUIN_WIKI, yufuinStop, yufuinAnswer } from './pack-kit.js';
import { readFile } from 'node:fs/promises';

test('meters from a point to a line, or to a point', () => {
  const east = /** @type {[number, number][]} */ ([[36, -121], [36, -120]]);
  assert.ok(Math.abs(toLine({ lat: 36.09, lng: -120.5 }, east) - 10_000) < 100, 'beside the middle');
  assert.ok(Math.abs(toLine({ lat: 36, lng: -119.9 }, east) - 9_000) < 100, 'past the end');
  assert.ok(toLine({ lat: 36, lng: -120.7 }, east) < 1, 'on it');
  assert.ok(Math.abs(toLine({ lat: 36.09, lng: -121 }, [[36, -121]]) - 10_000) < 100, 'a point');
});

test("a downloaded pack: what it covers, its places and pages, its guides by name, and live mode's names", async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: '1.0.0', editions: ['en'], gapMs: 0 });
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
  const pages = pack.pages(bixby, 2000, ['en']);
  assert.deepEqual(pages.map((r) => r.slice(0, 2)), [['Bixby Creek Bridge', 'wikipedia article']]);
  assert.match(pages[0][6], /^Bixby Creek Bridge is a reinforced concrete .* https:\/\/en\.wikipedia\.org\/wiki\/Bixby_Creek_Bridge$/);
  assert.deepEqual((await pack.guide('big sur', ['en'])).map((p) => [p.edition, p.title]), [['en', 'Big Sur']]);
  assert.equal((await pack.guide('Cambria', ['en']))[0]?.title, 'Cambria (California)');
  assert.equal((await pack.guide('Cambria, California', ['en']))[0]?.title, 'Cambria (California)');
  assert.deepEqual(await pack.guide('Monterey', ['en']), []);
  assert.deepEqual(pack.name({ lat: 36.3715, lng: -121.9017 }, ['en']), { name: 'Bixby Creek Bridge', m: 0 });
  assert.equal(pack.name({ lat: 36.2203, lng: -121.7612 }, ['en'])?.name, 'Nepenthe (restaurant)'); // a restaurant is no place name; its article is
  assert.equal(pack.name({ lat: 36.5, lng: -121.95 }, ['en']), null);
  assert.equal(await loadPack(ws, trip), pack); // read once for each version of the manifest
});

test('a broken pack is no pack, and a broken part is left out: never an error', async () => {
  const { ws, trip } = await packTrip();
  assert.equal(await loadPack(ws, trip), null);
  assert.equal(await loadPack(ws, null), null);
  await ws.write(trip, MANIFEST, '{"format":', { author: 'system', type: 'text/plain' });
  assert.equal(await loadPack(ws, trip), null);
  await downloadPack({ ws, scope: trip, ...services(), version: '1.0.0', editions: ['en'], gapMs: 0 });
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
  assert.deepEqual(await pack.guide('Big Sur', ['en']), []);
});

test("a part Overpass cut off at its 3000 places doesn't count as covering: nearby asks online there, and uses it only when offline (C1)", async () => {
  const { ws, trip } = await packTrip();
  const many = Array.from({ length: 3000 }, (_, i) => ({ type: 'node', id: 1000 + i, lat: 36.3715 + (i % 50) / 1e4, lon: -121.9017 + Math.floor(i / 50) / 1e4, tags: { name: `Place ${i}`, amenity: 'cafe' } }));
  // Every part that reaches Bixby is cut off there: the stop's and the way's.
  await downloadPack({ ws, scope: trip, ...services({ overpass: (url, init) => (decodeURIComponent(String(init?.body)).includes('36.3715') ? { elements: many } : { elements: [] }) }), version: '1.0.0', editions: ['en'], gapMs: 0 });
  const pack = await loadPack(ws, trip);
  assert.ok(pack);
  const bixby = { lat: 36.3715, lng: -121.9017 };
  assert.equal(pack.covers(bixby, 1000), false);
  assert.equal(pack.touches(bixby), true);
  assert.equal(pack.covers({ lat: 36.2213, lng: -121.7567 }, 1000), true); // Nepenthe's part is whole
});

test('meters to a line across the date line: the short way, as the plan joins the stops', () => {
  const line = /** @type {[number, number][]} */ ([[-17, 179.8], [-17, -179.8]]); // Fiji's 180th meridian, 0.4° wide
  assert.ok(toLine({ lat: -17, lng: 179.99 }, line) < 50);
  assert.ok(toLine({ lat: -17, lng: -179.95 }, line) < 50);
  assert.ok(Math.abs(toLine({ lat: -16.99, lng: 180 }, line) - 1106) < 20);
  assert.ok(toLine({ lat: -17, lng: 0 }, line) > 10_000_000);
});

test("a summary is cut to about as much as 200 characters of English say, after a mark where its text has no spaces: Japanese and Chinese are not cut at their first word", async () => {
  const saved = async (/** @type {string} */ name) => JSON.parse(await readFile(new URL(`../fixtures/places/${name}`, import.meta.url), 'utf8')).query.pages;
  const [ja, zh, en] = await Promise.all(['wiki-pack-yufuin-ja.json', 'wiki-pack-shilin-zh.json', 'wiki-pack-yufuin-en.json'].map(saved));
  const text = (/** @type {any[]} */ pages, /** @type {string} */ title) => String(pages.find((p) => p.title === title).extract).trim();
  const at = { lat: 33.2627, lng: 131.3553 };
  const summaries = /** @type {[string, string][]} */ ([
    ['士林區', text(zh, '士林區')], // 272 characters, one space, at 174
    ['湯布院病院', text(ja, '地域医療機能推進機構湯布院病院')], // 110, none
    ['由布院', `由布院温泉 ${text(ja, '由布院温泉').slice(5)}${text(ja, '由布院駅')}`], // a space after its first word only
    ['Jupiter', text(en, 'Jupiter (roller coaster)')], // English, 404
    ['Mixed', `${'word '.repeat(36)}ジュピター ${'word '.repeat(30)}`], // English with kana at 180: 10 more to count, so one word less than by code units
  ]);
  const { ws, trip } = await packTrip();
  await ws.write(trip, '/offline/osm/o1.json', JSON.stringify({ area: { points: [[at.lat, at.lng]], radius: 5000 }, rows: [] }), { author: 'system' });
  await ws.write(trip, '/offline/wikipedia/w1.json', JSON.stringify({ at: [at.lat, at.lng], radius: 10000, pages: summaries.map(([title, s], k) => [title, at.lat, at.lng + k / 1e4, s]) }), { author: 'system' });
  await ws.write(trip, MANIFEST, JSON.stringify({ format: 1, key: 'k', at: '2026-11-19T09:00:00.000Z', failed: [], full: false, stopped: false, bytes: 1, places: 0, summaries: 5, guides: [],
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 1, items: 0, at: 1 }, { id: 'w1', kind: 'wikipedia', path: '/offline/wikipedia/w1.json', bytes: 1, items: 5, at: 1 }] }), { author: 'system' });
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const cut = Object.fromEntries(pack.pages(at, 1000, ['en']).map((r) => [r[0], String(r[6]).replace(/ https:\/\/\S+$/, '')]));
  const weight = (/** @type {string} */ s) => [...s].reduce((n, c) => n + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/u.test(c) ? 2 : 1), 0);
  for (const name of ['士林區', '湯布院病院', '由布院']) {
    // As much as 200 English characters, at a mark: 192, 160 and 167, counting a CJK character as 2.
    assert.ok(weight(cut[name]) <= 201 && weight(cut[name]) > 150, `${name}: ${cut[name]}`);
    assert.match(cut[name], /[、。，；！？]…$/u, `${name}: after a mark`);
  }
  assert.ok(cut['由布院'].startsWith('由布院温泉 （ゆふいんおんせん）は、'));
  // English is cut as before: at its last space within 200 characters, a kana counting 2, the long-vowel mark ー too (the ジュピター in it), not by code units.
  const expected = (/** @type {string} */ text) => {
    const t = text.replace(/\s+/g, ' ');
    let room = 200;
    let end = 0;
    for (const c of t) {
      room -= weight(c);
      if (room < 0) break;
      end += c.length;
    }
    return `${t.slice(0, end).replace(/\s+\S*$/, '')}…`;
  };
  assert.equal(cut.Jupiter, expected(summaries[3][1]));
  assert.equal(cut.Mixed, expected(summaries[4][1]));
  assert.notEqual(cut.Mixed, `${summaries[4][1].slice(0, 200).replace(/\s+\S*$/, '')}…`, 'a cut by code units would end at another space');
});

test("a language taken off the list is no more read, though its files stay until the next download, which removes them; put back, it is read again", async () => {
  const { ws, trip } = await packTrip({ '/plan/yufuin.json': yufuinStop('Yufuin Station', YUFUIN, 1) });
  const net = () => services({ overpass: () => ({ elements: [] }), wikipedia: (url) => yufuinAnswer(url) });
  await updateAppSettings(ws, { languages: { spoken: ['ja'], answer: 'follow' } });
  // The editions as the app reads them from the settings, as the keeper hands them to the download.
  await downloadPack({ ws, scope: trip, ...net(), version: '1.0.0', editions: await readingEditions(ws, 'en-US'), gapMs: 0 });
  const part = /** @type {any} */ ((await planFor(ws, trip)).parts.find((p) => p.kind === 'wikipedia'));
  const wikipediaFiles = async () => (await ws.list(trip, '/offline/')).map((f) => f.path).filter((path) => path.includes('/wikipedia/')).sort();
  assert.deepEqual(await wikipediaFiles(), [pathOf(part, 'ja'), pathOf(part)].sort());
  const town = { lat: 33.26442, lng: 131.35558 };
  const named = async () => {
    const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
    return { name: pack.name(town, await readingEditions(ws, 'en-US'))?.name, titles: pack.pages(town, 10_000, await readingEditions(ws, 'en-US')).map((r) => r[0]) };
  };
  // 湯布院町 is a Japanese article alone: English Wikipedia names another place at its point.
  const withJapanese = await named();
  assert.equal(withJapanese.name, '湯布院町');
  assert.ok(withJapanese.titles.includes('湯布院町'));
  // Japanese taken off the list: the files stay, and are no more read.
  await updateAppSettings(ws, { languages: { spoken: ['en'], answer: 'follow' } });
  assert.deepEqual(await wikipediaFiles(), [pathOf(part, 'ja'), pathOf(part)].sort(), 'the files stay');
  const english = await named();
  assert.equal(english.name, 'Yufuin Onsen');
  assert.ok(!english.titles.includes('湯布院町'));
  assert.deepEqual([...english.titles].sort(), YUFUIN_WIKI.en.query.pages.map((/** @type {any} */ p) => p.title).sort(), "English Wikipedia's articles, none of Japanese's");
  // Put back before any download: read again.
  await updateAppSettings(ws, { languages: { spoken: ['ja'], answer: 'follow' } });
  assert.equal((await named()).name, '湯布院町');
  // The next download with Japanese off the list removes its files.
  await updateAppSettings(ws, { languages: { spoken: ['en'], answer: 'follow' } });
  await downloadPack({ ws, scope: trip, ...net(), version: '1.0.0', editions: await readingEditions(ws, 'en-US'), gapMs: 0 });
  assert.deepEqual(await wikipediaFiles(), [pathOf(part)]);
});

test("a guide in several editions: found by its English title, that title without its bracket, a name that led to it, or its title in any edition; read in the editions given, in their order, a missing or broken file left out", async () => {
  const { ws, trip } = await packTrip();
  const g = (/** @type {string} */ id) => `/offline/wikivoyage/${id}.json`;
  await ws.write(trip, g('g1'), JSON.stringify({ title: 'Cambria (California)', text: 'Cambria is a town.' }), { author: 'system' });
  await ws.write(trip, g('g1.ja'), JSON.stringify({ title: 'カンブリア', text: 'カンブリアは海辺の町。' }), { author: 'system' });
  await ws.write(trip, g('g1.zh'), 'not json', { author: 'system', type: 'text/plain' });
  await ws.write(trip, MANIFEST, JSON.stringify({ format: 1, key: 'k', at: '2026-11-20T09:00:00.000Z', failed: [], stopped: false, bytes: 1, voyage: ['en', 'ja', 'zh'],
    files: ['g1', 'g1.ja', 'g1.zh'].map((id, k) => ({ id: 'g1', kind: 'wikivoyage', path: g(id), bytes: 1, items: 1, edition: ['en', 'ja', 'zh'][k] })),
    guides: [{ title: 'Cambria (California)', asked: ['Cambria Pines Lodge'], path: g('g1'), also: [{ edition: 'ja', title: 'カンブリア', path: g('g1.ja') }, { edition: 'zh', title: '坎布里亞', path: g('g1.zh') }] }] }), { author: 'system' });
  const pack = /** @type {import('../../src/core/pack/read.js').Pack} */ (await loadPack(ws, trip));
  const parts = async (/** @type {string} */ name, /** @type {string[]} */ editions) => (await pack.guide(name, editions)).map((p) => `${p.edition} ${p.title} ${p.text}`);
  for (const name of ['Cambria (California)', 'cambria', 'Cambria Pines Lodge', 'カンブリア', '坎布里亞']) {
    assert.deepEqual(await parts(name, ['ja', 'zh', 'en']), ['ja カンブリア カンブリアは海辺の町。', 'en Cambria (California) Cambria is a town.'], name);
  }
  assert.deepEqual(await parts('Cambria', ['en', 'ja']), ['en Cambria (California) Cambria is a town.', 'ja カンブリア カンブリアは海辺の町。'], 'in the order given');
  assert.deepEqual(await parts('Cambria', ['en']), ['en Cambria (California) Cambria is a town.'], 'an edition not given is not read');
  assert.deepEqual(await parts('カンブリア', ['de']), [], 'none held in the editions given');
  assert.deepEqual(await parts('Monterey', ['ja', 'en']), []);
});
