import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readingOrder } from '../../src/core/languages.js';
import { editionsOf, articlesOf, wikiSaid, merged, articleUrl, pageUrl, siteOf, sitelinksUrl, titlesOf, summariesUrl, ARTICLES } from '../../src/core/wiki.js';
import { nominatimLanguages } from '../../src/core/nominatim.js';
import { parseInline } from '../../src/ui/markdown.js';
import { ADDRESS_ENDS } from '../../src/core/address-ends.js';

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
  assert.ok(merged(old, ['ja', 'en']).every((a) => a.also.length === 0));
});

test("merged keeps each article's later editions' rows in `also`, in the order, one an edition", async () => {
  const [ja, en, zh] = await Promise.all(['ja', 'en', 'zh'].map(async (e) => articlesOf(await kiyomizu(e), e)));
  // 地主神社 (Q10928238) is in the Japanese and Chinese lists; 清水寺 (Q221716) in the Japanese and English; 圓山公園 (Q1108695) in the English and Chinese.
  const all = merged([...en, ...zh, ...ja], ['ja', 'zh', 'en']);
  const of = (/** @type {string} */ id) => all.find((a) => a.id === id);
  assert.deepEqual([of('Q10928238')?.edition, of('Q10928238')?.also.map((a) => [a.edition, a.title])], ['ja', [['zh', '地主神社']]]);
  assert.deepEqual([of('Q221716')?.title, of('Q221716')?.also.map((a) => [a.edition, a.title])], ['清水寺', [['en', 'Kiyomizu-dera']]]);
  assert.deepEqual([of('Q1108695')?.title, of('Q1108695')?.also.map((a) => [a.edition, a.title])], ['圓山公園 (京都府)', [['en', 'Maruyama Park (Kyoto)']]]);
  // An article only one edition lists has none; the same edition twice (overlapping parts) is one.
  assert.deepEqual(of('Q11526741')?.also, []);
  const twice = merged([...ja, ...ja, ...en], ['ja', 'en']);
  assert.deepEqual(twice.find((a) => a.id === 'Q221716')?.also.map((a) => a.edition), ['en']);
  assert.equal(twice.length, 38);
  // Rows as given stay as they were: merged makes its own.
  assert.ok(!('also' in ja[0]));
});

test("merged joins a row with no id to its page's id from another row: an older list, fetched before its article had an item, is not a second article beside the second stage's row", () => {
  // The page "X" on ja: an older list holds it with no id, a later second stage with Q1; English's list holds it as Q1 too.
  /** @param {string} edition @param {string} title @param {string | null} id */
  const row = (edition, title, id) => ({ title, lat: 35, lng: 139, summary: '', id, edition });
  const one = merged([row('ja', 'X', null), row('en', 'X en', 'Q1'), row('ja', 'X', 'Q1')], ['en', 'ja']);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].title, one[0].id, one[0].also.map((a) => [a.edition, a.title])], ['X en', 'Q1', [['ja', 'X']]]);
  // The other order of rows, and Japanese first in the reading order: the same one article, named in Japanese, with the id.
  const first = merged([row('ja', 'X', 'Q1'), row('en', 'X en', 'Q1'), row('ja', 'X', null)], ['ja', 'en']);
  assert.deepEqual(first.map((a) => [a.title, a.id, a.also.map((x) => x.edition)]), [['X', 'Q1', ['en']]]);
  // The id-less row alone in its edition and the id-less page that no other row names stay as before: once by its title, with none.
  const alone = merged([row('ja', 'Y', null), row('ja', 'Y', null), row('en', 'Z', 'Q2')], ['ja', 'en']);
  assert.deepEqual(alone.map((a) => [a.title, a.id]), [['Y', null], ['Z', 'Q2']]);
  // A title in another edition is another page: the id Q1 that ja's "X" has is not given to English's "X".
  assert.equal(merged([row('ja', 'X', 'Q1'), row('en', 'X', null)], ['ja', 'en']).length, 2);
});

test("Wikidata: an edition's site, the request for which editions have each item, and its answer as titles (the real answer's shape)", () => {
  assert.deepEqual(['en', 'ja', 'zh', 'zh-yue', 'tl', 'no'].map(siteOf), ['enwiki', 'jawiki', 'zhwiki', 'zh_yuewiki', 'tlwiki', 'nowiki']);
  assert.equal(ARTICLES, 50);
  const url = new URL(sitelinksUrl(['Q283196', 'Q221716'], ['ja', 'zh-yue', 'en']));
  assert.equal(url.origin + url.pathname, 'https://www.wikidata.org/w/api.php');
  assert.deepEqual(Object.fromEntries(url.searchParams), { action: 'wbgetentities', format: 'json', origin: '*', props: 'sitelinks', sitefilter: 'jawiki|zh_yuewiki|enwiki', ids: 'Q283196|Q221716' });
  // Tokyo Station, as Wikidata answered (the editions design, 2026-11-20); an item in one edition has that one key only; a missing item none.
  const answer = { entities: {
    Q283196: { type: 'item', id: 'Q283196', sitelinks: { enwiki: { site: 'enwiki', title: 'Tokyo Station', badges: [] }, jawiki: { site: 'jawiki', title: '東京駅', badges: [] }, zhwiki: { site: 'zhwiki', title: '東京站', badges: [] } } },
    Q11526741: { type: 'item', id: 'Q11526741', sitelinks: { jawiki: { site: 'jawiki', title: '東山警察署', badges: [] } } },
    Q999999999: { id: 'Q999999999', missing: '' },
  }, success: 1 };
  const titles = titlesOf(answer, ['ja', 'en']);
  assert.deepEqual([...(titles.get('Q283196') ?? [])], [['ja', '東京駅'], ['en', 'Tokyo Station']], 'the editions asked, in their order: not Chinese');
  assert.deepEqual([...(titles.get('Q11526741') ?? [])], [['ja', '東山警察署']]);
  assert.deepEqual([...(titles.get('Q999999999') ?? [])], []);
  // An item merged into another is answered under the id asked, with the item's own id: both name it.
  const merged = titlesOf({ entities: { Q1: { type: 'item', id: 'Q2', sitelinks: { enwiki: { title: 'Two' } } } } }, ['en']);
  assert.equal(merged.get('Q1')?.get('en'), 'Two');
  assert.equal(merged.get('Q2')?.get('en'), 'Two');
  // An error answer, or nothing readable, names nothing.
  assert.equal(titlesOf({ error: { code: 'no-such-entity' } }, ['en']).size, 0);
  assert.equal(titlesOf(null, ['en']).size, 0);
});

test("the second stage's request: an edition's articles by title, 20 a request, with the summaries nearby's pack takes and their items", () => {
  const u = new URL(summariesUrl('ja', ['別府ロープウェイ', '庄内駅 (大分県)']));
  assert.equal(u.origin + u.pathname, 'https://ja.wikipedia.org/w/api.php');
  assert.deepEqual(Object.fromEntries(u.searchParams), { action: 'query', format: 'json', formatversion: '2', origin: '*', redirects: '1', prop: 'extracts|pageprops', ppprop: 'wikibase_item',
    exintro: '1', explaintext: '1', exlimit: '20', exchars: '400', titles: '別府ロープウェイ|庄内駅 (大分県)' });
});

test("a Wikimedia page's address keeps its title as written, encoding only what a browser would read as another part of it, and the brackets (an unpaired one ends a link in chat)", () => {
  // A Wikivoyage guide's the same as a Wikipedia article's.
  assert.equal(pageUrl('en.wikivoyage.org', 'Cambria (California)'), 'https://en.wikivoyage.org/wiki/Cambria_%28California%29');
  assert.equal(pageUrl('en.wikivoyage.org', 'Big Sur'), 'https://en.wikivoyage.org/wiki/Big_Sur');
  assert.equal(pageUrl('en.wikivoyage.org', 'Zürich'), 'https://en.wikivoyage.org/wiki/Zürich');
  assert.equal(articleUrl('de', 'Zürich (Begriffsklärung)'), pageUrl('de.wikipedia.org', 'Zürich (Begriffsklärung)'));
  // A bracket is encoded, as it always was: an unpaired one ends a link in chat (src/ui/markdown.js, which keeps a pair inside an address it didn't write).
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
  // A bracketed title's address links whole in chat, bare or in [text](address).
  for (const text of [`see ${articleUrl('ja', '正法寺 (京都市東山区)')} now`, `[正法寺](${articleUrl('ja', '正法寺 (京都市東山区)')})`]) {
    const link = /** @type {any} */ (parseInline(text).find((x) => x.t === 'a'));
    assert.equal(decodeURIComponent(link.href), 'https://ja.wikipedia.org/wiki/正法寺_(京都市東山区)', text);
  }
});

test("a title's last character that chat leaves out of a bare link (a sentence's stop) is encoded, so the address links whole and opens that title; a sentence's own stop stays out", () => {
  // Both sites open a title so encoded (plain GETs, 2026-11-20): …/Washington,_D.C%2E is Washington,_D.C., …/Yahoo%21 Yahoo! (served as itself, no redirect).
  assert.equal(articleUrl('en', 'Washington, D.C.'), 'https://en.wikipedia.org/wiki/Washington,_D.C%2E');
  assert.equal(pageUrl('en.wikivoyage.org', 'Washington, D.C.'), 'https://en.wikivoyage.org/wiki/Washington,_D.C%2E');
  assert.equal(articleUrl('ja', 'Yahoo!'), 'https://ja.wikipedia.org/wiki/Yahoo%21');
  assert.equal(articleUrl('en', '"Heroes"'), 'https://en.wikipedia.org/wiki/"Heroes%22');
  // Every character a title may end in (MediaWiki refuses # < > [ ] | { } in one; # is encoded wherever it is), each before a sentence's own
  // stop or a word: the link is the whole address, the stop stays text, and the address is the title.
  for (let c = 0x21; c < 0x7f; c++) {
    const ch = String.fromCharCode(c);
    if ('<>[]|{}'.includes(ch)) continue;
    const title = `Hope, Arkansas${ch}`;
    const url = articleUrl('en', title);
    for (const after of [' now', '.', ',', ';', ':', '!', '?', "'", '"']) {
      const text = `see ${url}${after}`;
      assert.deepEqual(parseInline(text), [{ t: 'text', v: 'see ' }, { t: 'a', href: url, c: [{ t: 'text', v: url }] }, { t: 'text', v: after }], text);
    }
    // In [text](address) it was whole already: a browser's own form of it (`^` encoded, say).
    assert.equal(/** @type {any} */ (parseInline(`[${title}](${url})`)[0]).href, new URL(url).href);
    assert.equal(decodeURIComponent(new URL(url).pathname), `/wiki/${title.replace(/ /g, '_')}`, title);
  }
  // A title that ends in anything else has the address it had, byte for byte.
  assert.equal(articleUrl('en', 'Washington, D.C. metropolitan area'), 'https://en.wikipedia.org/wiki/Washington,_D.C._metropolitan_area');
  assert.equal(articleUrl('ja', 'Yahoo! JAPAN'), 'https://ja.wikipedia.org/wiki/Yahoo!_JAPAN');
  assert.equal(articleUrl('en', "St. Mary's"), "https://en.wikipedia.org/wiki/St._Mary's");
  assert.equal(articleUrl('en', 'Big Sur'), 'https://en.wikipedia.org/wiki/Big_Sur');
  assert.equal(articleUrl('ja', '清水寺'), 'https://ja.wikipedia.org/wiki/清水寺');
  // A bracket is still encoded, at the end too, and one before a last stop.
  assert.equal(articleUrl('en', 'Cambria (California)'), 'https://en.wikipedia.org/wiki/Cambria_%28California%29');
  assert.equal(articleUrl('en', 'Hope (Arkansas).'), 'https://en.wikipedia.org/wiki/Hope_%28Arkansas%29%2E');
});

// The Japanese and Chinese marks a bare address ends at wherever they stand (src/core/address-ends.js), listed here on purpose: a change to that set changes this test.
const ENDS = ['。', '、', '，', '；', '！', '？', '（', '）', '」', '』', '”'];

test("a Japanese or Chinese mark in a title is encoded as UTF-8 bytes wherever it stands, and the address opens that title and links whole in chat", () => {
  assert.equal(ADDRESS_ENDS, ENDS.join(''));
  // Plain GETs, 2026-11-20: ja …/モーニング娘%E3%80%82 and …/藤岡弘%E3%80%81 and zh …/中国%EF%BC%88上海%EF%BC%89自由贸易试验区 open their pages (decoded to the title).
  assert.equal(articleUrl('ja', 'モーニング娘。'), 'https://ja.wikipedia.org/wiki/モーニング娘%E3%80%82');
  assert.equal(articleUrl('ja', '藤岡弘、'), 'https://ja.wikipedia.org/wiki/藤岡弘%E3%80%81');
  assert.equal(articleUrl('zh', '中国（上海）自由贸易试验区'), 'https://zh.wikipedia.org/wiki/中国%EF%BC%88上海%EF%BC%89自由贸易试验区');
  for (const ch of ENDS) {
    const bytes = [...new TextEncoder().encode(ch)].map((b) => `%${b.toString(16).toUpperCase()}`).join('');
    for (const [where, title] of [['start', `${ch}京都`], ['middle', `京${ch}都`], ['end', `京都${ch}`], ['twice', `京${ch}${ch}都`]]) {
      const url = articleUrl('ja', title);
      assert.equal(url, `https://ja.wikipedia.org/wiki/${title.replaceAll(ch, bytes)}`, `${ch} at the ${where}`);
      assert.equal(decodeURIComponent(new URL(url).pathname), `/wiki/${title}`, `${ch} at the ${where}, as the page's title`);
      for (const text of [url, `${url} です`, `${url}。世界遺産`, `（${url}）と`, `「${url}」`, `${url}、${url}`]) {
        const links = parseInline(text).filter((x) => x.t === 'a');
        assert.deepEqual(links.map((x) => /** @type {any} */ (x).href), text.includes('、') ? [url, url] : [url], `${ch} at the ${where} of ${text}`);
      }
    }
  }
});

test("a bare address ends at a mark of the set wherever it stands: a stop, a comma, a closing bracket, then more text, a list, a wrapped address", () => {
  const url = 'https://ja.wikipedia.org/wiki/清水寺';
  const other = 'https://ja.wikipedia.org/wiki/金閣寺';
  /** @param {string} text @returns {unknown[]} the text's pieces, a link as its address */
  const pieces = (text) => parseInline(text).map((x) => (x.t === 'a' ? { a: x.href } : x.t === 'text' ? x.v : x));
  for (const ch of ENDS) {
    assert.deepEqual(pieces(`${url}${ch}`), [{ a: url }, ch], `${ch} at the text's end`);
    assert.deepEqual(pieces(`${url}${ch} 次は`), [{ a: url }, `${ch} 次は`], `${ch} before a space`);
    assert.deepEqual(pieces(`${url}${ch}次は八坂神社`), [{ a: url }, `${ch}次は八坂神社`], `${ch} before more text`);
  }
  assert.deepEqual(pieces(`清水寺 ${url}、金閣寺 ${other}。`), ['清水寺 ', { a: url }, '、金閣寺 ', { a: other }, '。'], 'a list');
  assert.deepEqual(pieces(`清水寺（${url}）と金閣寺（${other}）`), ['清水寺（', { a: url }, '）と金閣寺（', { a: other }, '）'], 'wrapped in （）');
  assert.deepEqual(pieces(`「${url}」を見る`), ['「', { a: url }, '」を見る'], 'wrapped in 「」');
  assert.deepEqual(pieces(`请看“${url}”。`), ['请看“', { a: url }, '”。'], 'wrapped in “”');
  assert.deepEqual(pieces(`${url}（世界遺産）`), [{ a: url }, '（世界遺産）'], 'a note straight after it');
  assert.deepEqual(pieces(`${url}？`), [{ a: url }, '？']);
  // A mark that titles of foreign names, long vowels, dashes and quotes hold is not one: it stays in the address.
  for (const ch of ['・', '·', 'ー', '—', '–', '’', '：', '【', '】', '「', '『', '〜', '…']) {
    const long = `https://ja.wikipedia.org/wiki/京${ch}都`;
    assert.deepEqual(pieces(`${long} です`), [{ a: long }, ' です'], ch);
    assert.equal(articleUrl('ja', `京${ch}都`), long, `${ch} stays in a title as written, byte for byte`);
    // At a title's end too (【推しの子】, 京・): the writer leaves it, and the address links whole.
    const end = `https://ja.wikipedia.org/wiki/京${ch}`;
    assert.equal(articleUrl('ja', `京${ch}`), end, `${ch} at a title's end, byte for byte`);
    for (const text of [end, `${end} です`, `（${end}）と`, `「${end}」`]) assert.deepEqual(pieces(text).filter((x) => typeof x !== 'string'), [{ a: end }], `${ch} at the end of ${text}`);
  }
  assert.deepEqual(pieces(`${articleUrl('ja', '【推しの子】')} です`), [{ a: 'https://ja.wikipedia.org/wiki/【推しの子】' }, ' です']);
});

test("a title that holds nothing a bare address ends at has the address it had, byte for byte", () => {
  for (const [edition, title] of [['ja', 'ジョージ・ワシントン'], ['ja', 'コーヒー'], ['ja', '【推しの子】'], ['zh', '星球大战：原力觉醒'], ['en', 'Mary’s Place'], ['en', 'Café · Bar'],
    ['ja', 'ブッシュ・ジュニア'], ['ja', '京都—大阪'], ['en', 'Yahoo! JAPAN'], ['ja', '清水寺'], ['en', 'Big Sur']]) {
    assert.equal(articleUrl(edition, title), `https://${edition}.wikipedia.org/wiki/${title.replaceAll(' ', '_')}`, title);
  }
});

test("a parenthesis pair inside a bare address or a [text](address) destination stays in it (GFM's rule, one level of it), an unpaired one ends it", () => {
  const ja = 'https://ja.wikipedia.org/wiki/正法寺_(京都市東山区)';
  /** @param {string} text @returns {any[]} */
  const links = (text) => parseInline(text).filter((x) => x.t === 'a');
  assert.deepEqual(links(`${ja} です`).map((x) => x.href), [ja]);
  assert.deepEqual(links(`${ja}。`).map((x) => x.href), [ja]);
  assert.deepEqual(links(`(${ja})`).map((x) => x.href), [ja]);
  assert.deepEqual(links(`${ja}.`).map((x) => x.href), [ja]);
  assert.deepEqual(links(`https://en.wikipedia.org/wiki/Mercury_(planet)_(x)_and`).map((x) => x.href), ['https://en.wikipedia.org/wiki/Mercury_(planet)_(x)_and']);
  assert.deepEqual(parseInline('(see https://en.wikipedia.org/wiki/Mercury_(planet))'), [{ t: 'text', v: '(see ' }, { t: 'a', href: 'https://en.wikipedia.org/wiki/Mercury_(planet)', c: [{ t: 'text', v: 'https://en.wikipedia.org/wiki/Mercury_(planet)' }] }, { t: 'text', v: ')' }]);
  assert.deepEqual(parseInline('https://a.test/x(y'), [{ t: 'a', href: 'https://a.test/x', c: [{ t: 'text', v: 'https://a.test/x' }] }, { t: 'text', v: '(y' }]);
  assert.deepEqual(parseInline('(https://a.test/x)'), [{ t: 'text', v: '(' }, { t: 'a', href: 'https://a.test/x', c: [{ t: 'text', v: 'https://a.test/x' }] }, { t: 'text', v: ')' }]);
  const [md] = links(`[正法寺](${ja})`);
  assert.equal(decodeURIComponent(md.href), ja);
  assert.deepEqual(md.c, [{ t: 'text', v: '正法寺' }]);
  assert.equal(parseInline(`[正法寺](${ja})`).length, 1, 'the whole destination, nothing left over');
  assert.equal(links('[x](https://a.test/p_(q)_(r))').length, 1);
  // Square brackets, braces and | never belong to a bare address (MediaWiki refuses them in a title), so each ends it, wherever it stands and paired or not; the price is that
  // an IP-literal address, http://[::1]:8080/x, doesn't link in chat.
  const foo = 'https://en.wikipedia.org/wiki/Foo';
  for (const ch of ['[', ']', '{', '}', '|']) {
    assert.deepEqual(parseInline(`${foo}${ch}`).map((x) => (x.t === 'a' ? x.href : /** @type {any} */ (x).v)), [foo, ch], `${ch} at the end`);
    assert.deepEqual(parseInline(`${foo}${ch}bar`).map((x) => (x.t === 'a' ? x.href : /** @type {any} */ (x).v)), [foo, `${ch}bar`], `${ch} before more text`);
  }
  assert.deepEqual(parseInline(`[${foo}] and {${foo}}`).map((x) => (x.t === 'a' ? x.href : /** @type {any} */ (x).v)), ['[', foo, '] and {', foo, '}']);
  assert.deepEqual(parseInline('http://[::1]:8080/x'), [{ t: 'text', v: 'http://[::1]:8080/x' }]);
  // The text of a [text](address) never holds a [ (CommonMark: an unmatched [ is literal), so a [ run isn't rescanned to the end of the line from every [: 19,999 of them
  // then one CJK character took 750 ms to parse (2026-11-20, the u flag on), now 0.1 ms. No timing here (a loaded host's pauses aren't the code's): this pins the rule.
  assert.deepEqual(parseInline('[a [b](https://x.test/y)'), [{ t: 'text', v: '[a ' }, { t: 'a', href: 'https://x.test/y', c: [{ t: 'text', v: 'b' }] }]);
  // An address annai wrote has its brackets encoded: unchanged.
  assert.equal(articleUrl('ja', '正法寺 (京都市東山区)'), 'https://ja.wikipedia.org/wiki/正法寺_%28京都市東山区%29');
});

test("[address](address) keeps the address as the link's text, and a _ inside a word of Latin letters or digits is no italics", () => {
  assert.deepEqual(parseInline('[https://a.test/x](https://a.test/x)'), [{ t: 'a', href: 'https://a.test/x', c: [{ t: 'text', v: 'https://a.test/x' }] }]);
  assert.deepEqual(parseInline('[see https://a.test/x here](https://b.test/y)'), [{ t: 'a', href: 'https://b.test/y', c: [{ t: 'text', v: 'see https://a.test/x here' }] }]);
  assert.deepEqual(parseInline('[**https://a.test/x**](https://b.test/y)'), [{ t: 'a', href: 'https://b.test/y', c: [{ t: 'b', c: [{ t: 'text', v: 'https://a.test/x' }] }] }]);
  // CommonMark: _ opens or closes emphasis only at a word's edge. …/Big_Sur's underscore is inside a word, as is notes_today's.
  assert.deepEqual(parseInline('notes_today and https://en.wikipedia.org/wiki/Big_Sur here'),
    [{ t: 'text', v: 'notes_today and ' }, { t: 'a', href: 'https://en.wikipedia.org/wiki/Big_Sur', c: [{ t: 'text', v: 'https://en.wikipedia.org/wiki/Big_Sur' }] }, { t: 'text', v: ' here' }]);
  assert.deepEqual(parseInline('snake_case_name'), [{ t: 'text', v: 'snake_case_name' }]);
  assert.deepEqual(parseInline('_x and snake_case'), [{ t: 'text', v: '_x and snake_case' }]);
  // A _ inside a word (notes_today) opens no italics, even with a later _ that has a space after it (the opener's lookbehind: the lookahead alone lets it through).
  assert.deepEqual(parseInline('notes_today and more_ here'), [{ t: 'text', v: 'notes_today and more_ here' }]);
  // Digits are word characters: 2_000_000 is a number.
  assert.deepEqual(parseInline('2_000_000 yen'), [{ t: 'text', v: '2_000_000 yen' }]);
  assert.deepEqual(parseInline('x 2_3_4 y'), [{ t: 'text', v: 'x 2_3_4 y' }]);
  // Japanese and Chinese letters are not (the word class is Latin letters and digits, as src/core/intl.js:25's): _重要_ is italics, and a closing _ before them
  // is no part of the address, whose title is …/清水寺.
  assert.deepEqual(parseInline('日本語_です_ね'), [{ t: 'text', v: '日本語' }, { t: 'i', c: [{ t: 'text', v: 'です' }] }, { t: 'text', v: 'ね' }]);
  assert.deepEqual(parseInline('_https://ja.wikipedia.org/wiki/清水寺_です'),
    [{ t: 'i', c: [{ t: 'a', href: 'https://ja.wikipedia.org/wiki/清水寺', c: [{ t: 'text', v: 'https://ja.wikipedia.org/wiki/清水寺' }] }] }, { t: 'text', v: 'です' }]);
  // Bold and italic around an address: the marks stay out of the link, which is whole.
  assert.deepEqual(parseInline('**https://ja.wikipedia.org/wiki/清水寺**。次は'),
    [{ t: 'b', c: [{ t: 'a', href: 'https://ja.wikipedia.org/wiki/清水寺', c: [{ t: 'text', v: 'https://ja.wikipedia.org/wiki/清水寺' }] }] }, { t: 'text', v: '。次は' }]);
  assert.deepEqual(parseInline('*https://en.wikipedia.org/wiki/Big_Sur* here'),
    [{ t: 'i', c: [{ t: 'a', href: 'https://en.wikipedia.org/wiki/Big_Sur', c: [{ t: 'text', v: 'https://en.wikipedia.org/wiki/Big_Sur' }] }] }, { t: 'text', v: ' here' }]);
  assert.deepEqual(parseInline('say _this_ now, (_that_), _you_.'),
    [{ t: 'text', v: 'say ' }, { t: 'i', c: [{ t: 'text', v: 'this' }] }, { t: 'text', v: ' now, (' }, { t: 'i', c: [{ t: 'text', v: 'that' }] }, { t: 'text', v: '), ' }, { t: 'i', c: [{ t: 'text', v: 'you' }] }, { t: 'text', v: '.' }]);
});

test("an answer that is an error says what it says; an answer with articles or none says nothing", () => {
  assert.equal(wikiSaid({ error: { code: 'maxlag', info: 'Waiting for a database server.' } }), 'Waiting for a database server');
  assert.equal(wikiSaid({ error: { code: 'badvalue' } }), 'badvalue');
  assert.equal(wikiSaid({ error: {} }), 'no');
  assert.equal(wikiSaid({ batchcomplete: true }), '');
  assert.equal(wikiSaid({ query: { pages: [] } }), '');
  assert.equal(wikiSaid(null), '');
});
