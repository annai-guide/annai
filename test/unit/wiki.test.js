import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readingOrder } from '../../src/core/languages.js';
import { editionsOf, articlesOf, wikiSaid, merged, articleUrl, pageUrl } from '../../src/core/wiki.js';
import { nominatimLanguages } from '../../src/core/nominatim.js';
import { parseInline } from '../../src/ui/markdown.js';

/** Wikipedia's answers near Kiyomizu-dera within 1 km, as they came on 2026-11-19 (nearby's query; text under CC BY-SA 4.0). @param {string} e */
const kiyomizu = async (e) => JSON.parse(await readFile(new URL(`../fixtures/places/wiki-kiyomizu-${e}.json`, import.meta.url), 'utf8'));
const ids = (/** @type {{ id: string }[]} */ order) => order.map((l) => l.id);
/** The app settings with a list chosen. @param {string[]} spoken @param {string} [answer] */
const speaks = (spoken, answer = 'follow') => ({ languages: { spoken, answer } });

test('the reading order: the language Shiori is fixed to, then the list in its order, then English, each once', () => {
  assert.deepEqual(ids(readingOrder(speaks(['ja', 'zh-Hant']), 'en-US')), ['ja', 'zh-Hant', 'en']);
  assert.deepEqual(ids(readingOrder(speaks(['en', 'zh', 'ja']), 'en-US')), ['en', 'zh', 'ja']);
  assert.deepEqual(ids(readingOrder(speaks(['en', 'ja'], 'ja'), 'en-US')), ['ja', 'en']);
  // An answer saved before the list limited it can be outside the list: it comes first all the same.
  assert.deepEqual(ids(readingOrder(speaks(['en'], 'zh-Hant'), 'en-US')), ['zh-Hant', 'en']);
});

test("with nothing chosen, the phone's language, then English", () => {
  assert.deepEqual(ids(readingOrder({}, 'ja-JP')), ['ja', 'en']);
  assert.deepEqual(ids(readingOrder({}, 'zh-TW')), ['zh-Hant', 'en']);
  assert.deepEqual(ids(readingOrder({}, 'en-GB')), ['en']);
  assert.deepEqual(ids(readingOrder({ languages: { answer: 'ja' } }, 'en-US')), ['ja', 'en']);
});

test('a phone language annai has no row for: Nominatim is told it, Wikipedia reads English (no host was checked for it)', () => {
  const order = readingOrder({}, 'et-EE');
  assert.deepEqual(ids(order), ['et', 'en']);
  assert.deepEqual(editionsOf(order), ['en']);
  assert.equal(nominatimLanguages(order), 'et,en');
});

test("each language's Wikipedia edition by its host: both Chinese rows read zh, Cantonese zh-yue, Filipino tl", () => {
  assert.deepEqual(editionsOf(readingOrder(speaks(['zh', 'zh-Hant', 'yue', 'fil', 'no', 'ja']), 'en-US')), ['zh', 'zh-yue', 'tl', 'no', 'ja', 'en']);
});

test("Nominatim's languages: each in the order, with the ISO code after one that differs from it", () => {
  assert.equal(nominatimLanguages(readingOrder(speaks(['ja', 'zh-Hant']), 'en-US')), 'ja,zh-Hant,zh,en');
  assert.equal(nominatimLanguages(readingOrder(speaks(['zh', 'zh-Hant']), 'en-US')), 'zh,zh-Hant,en');
  assert.equal(nominatimLanguages(readingOrder(speaks(['fil']), 'en-US')), 'fil,tl,en');
});

test('editions merged by Wikidata id: each article once, under the first edition of the order that has it; the rest as they came', async () => {
  const [ja, en, zh] = await Promise.all(['ja', 'en', 'zh'].map(async (e) => articlesOf(await kiyomizu(e), e)));
  assert.equal(ja.length, 30);
  assert.equal(en.length, 14);
  // Six articles are in both (清水寺 is Kiyomizu-dera, 高台寺 Kōdai-ji…).
  const both = merged([...ja, ...en], ['ja', 'en']);
  assert.equal(both.length, 38);
  assert.ok(both.some((a) => a.title === '清水寺' && a.id === 'Q221716' && a.edition === 'ja'));
  assert.ok(!both.some((a) => a.title === 'Kiyomizu-dera'));
  assert.ok(both.some((a) => a.title === 'Higashiyama-ku' && a.edition === 'en'), "English's own articles stay");
  // The other way round, English's titles.
  const english = merged([...ja, ...en], ['en', 'ja']);
  assert.ok(english.some((a) => a.title === 'Kiyomizu-dera') && !english.some((a) => a.title === '清水寺'));
  // An edition outside the order comes after the order's.
  assert.equal(merged([...zh, ...en], ['en']).find((a) => a.id === 'Q1108695')?.title, 'Maruyama Park (Kyoto)');
  assert.equal(merged([...zh, ...en], ['en', 'zh']).find((a) => a.id === 'Q1108695')?.title, 'Maruyama Park (Kyoto)');
  assert.equal(merged([...zh, ...en], ['zh', 'en']).find((a) => a.id === 'Q1108695')?.title, '圓山公園 (京都府)');
  // Without an id (a part written before editions), an article is its edition's own, once by its title.
  const old = [{ ...en[0], id: null }, { ...en[0], id: null }, { ...ja[12], id: null }];
  assert.equal(merged(old, ['ja', 'en']).length, 2);
});

test("a Wikimedia page's address keeps its title as written, encoding only what a browser would read as another part of it, and the brackets (chat's links end at one)", () => {
  // A Wikivoyage guide's the same as a Wikipedia article's.
  assert.equal(pageUrl('en.wikivoyage.org', 'Cambria (California)'), 'https://en.wikivoyage.org/wiki/Cambria_%28California%29');
  assert.equal(pageUrl('en.wikivoyage.org', 'Big Sur'), 'https://en.wikivoyage.org/wiki/Big_Sur');
  assert.equal(pageUrl('en.wikivoyage.org', 'Zürich'), 'https://en.wikivoyage.org/wiki/Zürich');
  assert.equal(articleUrl('de', 'Zürich (Begriffsklärung)'), pageUrl('de.wikipedia.org', 'Zürich (Begriffsklärung)'));
  // A bracket is encoded: chat's links end at one (src/ui/markdown.js), so 正法寺_(京都市東山区) would link only 正法寺_.
  assert.equal(articleUrl('ja', '正法寺 (京都市東山区)'), 'https://ja.wikipedia.org/wiki/正法寺_%28京都市東山区%29');
  assert.equal(articleUrl('en', 'Nepenthe (restaurant)'), 'https://en.wikipedia.org/wiki/Nepenthe_%28restaurant%29');
  assert.equal(articleUrl('en', "Where Is the Friend's House?"), "https://en.wikipedia.org/wiki/Where_Is_the_Friend's_House%3F");
  assert.equal(articleUrl('en', '100% Wolf'), 'https://en.wikipedia.org/wiki/100%25_Wolf');
  assert.equal(articleUrl('en', 'A#B'), 'https://en.wikipedia.org/wiki/A%23B');
  assert.equal(articleUrl('en', 'A\\B'), 'https://en.wikipedia.org/wiki/A%5CB');
  assert.equal(articleUrl('en', 'Cambria, California'), 'https://en.wikipedia.org/wiki/Cambria,_California');
  // A browser asks for the same page: it encodes the rest itself.
  assert.equal(new URL(articleUrl('ja', '清水寺')).pathname, '/wiki/%E6%B8%85%E6%B0%B4%E5%AF%BA');
  const q = new URL(articleUrl('en', "Where Is the Friend's House?"));
  assert.equal(q.search, '');
  assert.equal(decodeURIComponent(q.pathname), "/wiki/Where_Is_the_Friend's_House?");
  assert.equal(new URL(articleUrl('en', 'A\\B')).pathname, '/wiki/A%5CB');
  assert.equal(decodeURIComponent(new URL(articleUrl('ja', '正法寺 (京都市東山区)')).pathname), '/wiki/正法寺_(京都市東山区)');
  // Why: chat's renderer ends a link at a bracket, bare or in [text](address), so a bracketed title's address links whole only with the brackets encoded.
  for (const text of [`see ${articleUrl('ja', '正法寺 (京都市東山区)')} now`, `[正法寺](${articleUrl('ja', '正法寺 (京都市東山区)')})`]) {
    const link = /** @type {any} */ (parseInline(text).find((x) => x.t === 'a'));
    assert.equal(decodeURIComponent(link.href), 'https://ja.wikipedia.org/wiki/正法寺_(京都市東山区)', text);
  }
});

test("an answer that is an error says what it says; an answer with articles or none says nothing", () => {
  assert.equal(wikiSaid({ error: { code: 'maxlag', info: 'Waiting for a database server.' } }), 'Waiting for a database server');
  assert.equal(wikiSaid({ error: { code: 'badvalue' } }), 'badvalue');
  assert.equal(wikiSaid({ error: {} }), 'no');
  assert.equal(wikiSaid({ batchcomplete: true }), '');
  assert.equal(wikiSaid({ query: { pages: [] } }), '');
  assert.equal(wikiSaid(null), '');
});
