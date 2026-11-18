import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../src/core/languages.js';
import { summaryLanguage } from '../../src/core/agent/compaction.js';

// A line counts for one of the traveller's own languages by what its writing shows (the design check of 2026-11-17, option 1; detector-next). Every
// example of the five Deferred entries it closes or narrows, the R2 question, the check's single-line rows and its edges a to e, each under the
// settings the entry names. Main read one line's letters as one of the world's languages, and placed Han alone and shared scripts by the list's order.

const { languageSettings, speechLocale, tagOf } = L;
const listed = (/** @type {string[]} */ ids, locale = 'en-US') => languageSettings({ languages: { spoken: ids } }, locale);
const phone = (/** @type {string} */ locale) => languageSettings({}, locale);
const most = (/** @type {string} */ name) => `${name}, the language most of what the user wrote is in`;
/** What placed says of a line: a language's id, 'either' (Han that says neither Japanese nor Chinese), or null. @param {string} text @param {any} s */
const id = (text, s) => { const l = L.placed(text, s); return l === L.EITHER ? 'either' : l?.id ?? null; };

const [j1, j2] = ['今日の夕食はどこにしますか', 'ラーメンがいいな'];
const [e1, e2] = ['Where should we eat tonight?', 'Is the museum open today?'];
const [s1, s2] = ['我们今晚去哪里吃饭', '我们这个周末去哪里'];
/** Japanese lines with a place's name in Latin letters (the entry's three, and one more from the check's pool). */
const JA_LATIN = ['Los Angelesまで何時間？', 'The Getty Centerは今日開いてる？', 'Hotel Le Meridienのチェックインは何時？', 'Shibuya Sky のチケットは 2,000円です'];
/** Chinese lines with a place's name in Latin letters, each with a character only Chinese writes. */
const ZH_LATIN = ['我们明天去 Golden Gate Bridge 吗？', '这家 In-N-Out Burger 怎么样？'];

test("a Japanese or Chinese line with a place's name in Latin letters counts for its own language (F-A); main read 「Los Angelesまで何時間？」 as Spanish", () => {
  for (const s of [listed(['en', 'zh', 'ja']), listed(['en', 'ja']), phone('en-US'), phone('ja-JP')]) {
    for (const x of JA_LATIN) assert.equal(id(x, s), 'ja', `${x} ${s.spoken.map((l) => l.id)}`);
  }
  for (const s of [listed(['en', 'zh', 'ja']), phone('en-US'), phone('ja-JP')]) {
    for (const x of ZH_LATIN) assert.equal(id(x, s), 'zh', `${x} ${s.spoken.map((l) => l.id)}`);
  }
  // The entry's trip: two plain Japanese lines and five such lines (main, nothing chosen: French).
  const trip = [j1, j2, ...JA_LATIN, JA_LATIN[0]];
  for (const s of [phone('en-US'), listed(['en', 'ja']), listed(['en', 'zh', 'ja'])]) assert.equal(summaryLanguage(trip, s), most('Japanese'));
});

test('"Los Angeles hotel" is English, not Spanish: one stray small word names nothing (F-A\'s second shape)', () => {
  for (const s of [listed(['en', 'ja']), listed(['en', 'zh', 'ja']), listed(['en'])]) {
    for (const x of ['Los Angeles hotel', 'Las Vegas flights', 'Big Sur food', 'Big Sur tomorrow?']) assert.equal(id(x, s), 'en', x);
  }
  // Nothing chosen on an English phone (main: Spanish, and French for the Big Sur lines): such a line counts for nothing, the question for English.
  const s = phone('en-US');
  assert.equal(summaryLanguage(['Is the beach far from here?', 'Los Angeles hotel', 'Las Vegas flights', 'Los Angeles hotel'], s), most('English'));
  assert.equal(summaryLanguage(['Is the beach far from here?', 'Big Sur food', 'Big Sur tomorrow?', 'Big Sur food'], s), most('English'));
});

test("the phone's voice gives her Japanese sentence with English names the Japanese voice (F-B), and an English one with a Spanish name the English voice", () => {
  const fb = '明日10:00 Museum of Odd Clocks: 12 Pendulum Lane, Testville 今いる場所から公共交通での経路を開きます。';
  assert.equal(speechLocale(listed(['en', 'ja']), fb), 'ja-JP', 'main: en-US');
  assert.equal(speechLocale(listed(['en', 'zh', 'ja']), fb), 'ja-JP', 'main: en-US');
  assert.equal(speechLocale(listed(['en', 'es', 'ja']), 'Los Angeles International Airportまでは車で約40分です。'), 'ja-JP', 'main: es-ES');
  assert.equal(speechLocale(listed(['ja', 'en']), 'Next up: Los Angeles hotel check-in.'), 'en-US', 'main: ja-JP');
});

test('a Japanese trip full of kanji place names is Japanese with a Chinese row listed: Han that says nothing joins the side with lines of its own', () => {
  const kanji = ['東京駅', '浅草寺', '新宿駅前'];
  const three = listed(['en', 'zh', 'ja']);
  // Main: Chinese (Simplified), whichever order the lines come in.
  for (const lines of [[...kanji, j1, j2], [j1, j2, ...kanji], [j1, ...kanji, j2]]) assert.equal(summaryLanguage(lines, three), most('Japanese'), lines.join());
  // Main: Chinese (Traditional), the two kanji lines winning a tie as the newer.
  assert.equal(summaryLanguage([j1, j2, '東京駅', '新宿駅前'], listed(['ja', 'zh', 'zh-Hant', 'en'])), most('Japanese'));
  // Kanji lines are no vote for a Chinese row (東 and 長 are Traditional forms): main named Traditional for a Simplified writer.
  const rows = listed(['zh', 'zh-Hant', 'en']);
  assert.equal(summaryLanguage([s2, s1, '東京駅', '長野駅', '東京駅'], rows), most('Chinese (Simplified)'));
  assert.equal(summaryLanguage([s2, s1, '東京駅', '長野駅'], rows), most('Chinese (Simplified)'));
  // The entry's own warning: a Chinese traveller who lists Japanese too keeps Chinese, as her lines that tell nothing join the Chinese line.
  const plain = ['好想去看夜景', '我想吃拉麵', '想去海邊走走'];
  for (const s of [listed(['zh', 'ja', 'en']), listed(['zh', 'zh-Hant', 'ja'])]) assert.equal(summaryLanguage([...plain, s1, '大家好'], s), most('Chinese (Simplified)'));
});

test('with nothing chosen, a Chinese trip on a Japanese phone is Chinese (R2), Simplified on a Taiwanese phone Simplified, Russian on a Ukrainian phone Russian', () => {
  assert.equal(summaryLanguage([s1, '我们明天去哪里', '好想去看夜景'], phone('ja-JP')), most('Chinese (Simplified)'), 'main: Japanese');
  // Its edge: only kanji lines on a Japanese phone are Japanese.
  assert.equal(summaryLanguage(['東京駅', '新宿駅前', '浅草寺'], phone('ja-JP')), most('Japanese'));
  assert.equal(summaryLanguage([s1, '我们明天去哪里'], phone('zh-TW')), most('Chinese (Simplified)'), 'main: Chinese (Traditional)');
  assert.equal(summaryLanguage(['Где можно поужинать сегодня вечером?', 'Музей сегодня открыт?'], phone('uk-UA')), most('Russian'), 'main: Ukrainian');
  // The row is named with nothing chosen on a phone with no Chinese row (main: "Chinese", no script).
  assert.equal(summaryLanguage([s1], phone('en-US')), most('Chinese (Simplified)'));
});

test('with Ukrainian and Russian listed, a Russian line is Russian in either order; a Ukrainian line by its letters is Ukrainian', () => {
  const ru = 'Где можно поужинать сегодня вечером?';
  const uk = 'Де можна повечеряти сьогодні ввечері?';
  for (const order of [['uk', 'ru'], ['ru', 'uk']]) {
    const s = listed(order);
    assert.equal(summaryLanguage([ru], s), most('Russian'), order.join());
    assert.equal(tagOf(ru, s), 'ru', order.join());
    assert.equal(speechLocale(s, ru), 'ru-RU', order.join());
    assert.equal(summaryLanguage([uk], s), most('Ukrainian'), order.join());
    assert.equal(speechLocale(s, uk), 'uk-UA', order.join());
  }
});

test("Cantonese and a Chinese row in either order: Simplified text is Chinese, Cantonese text (by its own characters) Cantonese", () => {
  for (const order of [['yue', 'zh'], ['zh', 'yue']]) {
    const s = listed(order);
    assert.equal(summaryLanguage([s1], s), most('Chinese (Simplified)'), order.join());
    assert.equal(speechLocale(s, s1), 'zh-CN', order.join());
    assert.equal(tagOf(s1, s), 'zh-Hans', order.join());
    assert.equal(speechLocale(s, '佢哋聽日去邊度'), 'yue-Hant-HK', order.join());
  }
  // The entry's lines whose characters tell no script, Cantonese by its own: main named the first listed Chinese row.
  const yue = ['我哋今晚去邊度食飯', '佢哋聽日去邊度', '我哋今晚去邊度食飯', e1];
  assert.equal(summaryLanguage(yue, listed(['zh', 'yue', 'en'])), most('Cantonese'));
  assert.equal(summaryLanguage(yue, listed(['zh-Hant', 'yue', 'en'])), most('Cantonese'));
  // Cantonese in Traditional forms with no character of its own, Traditional not listed: the listed language written in them (main: Simplified).
  assert.equal(summaryLanguage(['我們今晚去邊度食飯', '我們聽日去邊度', '我們今晚去邊度食飯', e1], listed(['zh', 'yue', 'en'])), most('Cantonese'));
});

test('a listed language annai has no words for counts when it is the only one listed in its script, or the phone\'s; two in one script tell nothing (L1)', () => {
  const tr = ['Bu akşam nerede yemek yiyebiliriz?', 'Yarın müzeye gidebilir miyiz?', 'Bu gece nerede kalacağız?'];
  const pl = ['Gdzie my dziś zjemy kolację?', 'To muzeum jest dziś otwarte?', 'Jaka jutro będzie pogoda tutaj?'];
  assert.equal(summaryLanguage(tr, listed(['tr'])), most('Turkish'));
  assert.equal(summaryLanguage(tr, phone('tr-TR')), most('Turkish'));
  assert.equal(summaryLanguage(pl, phone('pl-PL')), most('Polish'), 'main: English');
  assert.equal(summaryLanguage(pl, listed(['pl'])), most('Polish'));
  // L1, a question for the user: with English listed too, no line tells Turkish or Polish from English, so the first listed.
  assert.equal(summaryLanguage(tr, listed(['en', 'tr'])), 'English, the first language the user speaks (English and Turkish)');
  assert.equal(summaryLanguage([...tr, e1], listed(['tr', 'en'])), most('English'));
  assert.equal(summaryLanguage(pl, listed(['pl', 'en'])), 'Polish, the first language the user speaks (Polish and English)', 'main: English, from "my" and "to"');
  // Scripts annai had no name for count by the script the listed language is written in.
  assert.equal(summaryLanguage(['আমরা আজ রাতে কোথায় খাব?', 'জাদুঘর কি আজ খোলা?', e1], listed(['en', 'bn'])), most('Bengali'));
  assert.equal(summaryLanguage(['Tối nay chúng ta ăn ở đâu?', 'Bảo tàng hôm nay có mở cửa không?', e1], listed(['en', 'vi'])), most('Vietnamese'));
});

test('the edges option 1 takes (the design check\'s a to e), pinned', () => {
  const three = listed(['en', 'zh', 'ja']);
  // a. An English line with a kanji name has no grammar of its own to tell by: it is not counted (main: English).
  assert.equal(id('Where is 新宿御苑?', three), null);
  assert.equal(summaryLanguage(['Where is 新宿御苑?', 'Where is 新宿御苑?', j1], listed(['en', 'ja'])), most('Japanese'));
  // b. With Japanese and Chinese both listed, a window of Chinese lines that tell nothing gets the first listed language (main: Chinese).
  assert.equal(id('大家好', three), 'either');
  assert.equal(summaryLanguage(['大家好', '明天去京都'], three), 'English, the first language the user speaks (English, Chinese (Simplified) and Japanese)');
  assert.equal(summaryLanguage(['大家好', '明天去京都'], listed(['ja', 'zh'])), 'Japanese, the first language the user speaks (Japanese and Chinese (Simplified))');
  // c. Nothing chosen, one small word of another language leaves a line unsure; two name it.
  assert.equal(id('Je voudrais un café', phone('en-US')), null);
  assert.equal(id('Je voudrais un café avec du lait', phone('en-US')), 'fr');
  // d. With Ukrainian and Russian listed, a Ukrainian line with none of і ї є ґ counts as Russian.
  assert.equal(id('Де ми будемо вечеряти?', listed(['uk', 'ru'])), 'ru');
  // e. With only Japanese listed, a line with a character only Chinese writes is not counted (main: Japanese).
  assert.equal(id('这是我们说的', listed(['en', 'ja'])), null);
  assert.equal(id('这是我们说的', listed(['ja'])), null);
  assert.equal(summaryLanguage([e1, '这是我们说的', s1], listed(['en', 'ja'])), most('English'));
});

test('点 is no Simplified form: 「交差点」 on a Japanese phone, or with only Japanese listed, is tagged ja (N1; main: zh-Hans)', () => {
  for (const x of ['交差点', '新宿三丁目交差点', '終点']) {
    assert.equal(tagOf(x, phone('ja-JP'), false, 'ja'), 'ja', x);
    assert.equal(tagOf(x, listed(['ja'])), 'ja', x);
    assert.equal(tagOf(x, listed(['en', 'ja'])), 'ja', x);
  }
});

test("a line's tag: Han that says neither is the screens' language when that is one of theirs, else the first of theirs written in Han", () => {
  // N2: with Chinese first and English screens, 東京駅 is still drawn as Chinese (東 is a Traditional form).
  assert.equal(tagOf('東京駅', listed(['en', 'zh', 'ja'])), 'zh-Hant');
  assert.equal(tagOf('東京駅', listed(['en', 'ja', 'zh'])), 'ja', 'main: zh-Hant');
  assert.equal(tagOf('東京駅', listed(['en', 'zh', 'ja']), false, 'ja'), 'ja', 'Japanese screens; main: zh-Hant');
  assert.equal(tagOf('骨架', listed(['ja', 'zh']), false, 'zh-Hans'), 'zh-Hans', 'Chinese screens');
  // Characters only Chinese writes are Chinese whatever the screens.
  assert.equal(tagOf('这是我们说的', listed(['ja', 'zh']), false, 'ja'), 'zh-Hans');
  // A script two of theirs share that nothing in the line tells: the first of them, as before.
  assert.equal(tagOf('Къде можем да вечеряме тази вечер?', listed(['bg', 'ru'])), 'bg');
  assert.equal(tagOf('Где можно поужинать сегодня вечером?', listed(['en'])), 'ru', 'none of theirs: the script\'s own');
});

test('writing tells a line by its writing alone: one scale (Chinese, Japanese and Korean characters against the words in other scripts), and the grammar of a mixed line', () => {
  const cases = /** @type {[string, string][]} */ ([
    ['今日の夕食はどこにしますか', 'Jpan'], ['カレー', 'Jpan'], ['Los Angelesまで何時間？', 'Jpan'],
    ['我们今晚去哪里吃饭', 'zh'], ['我們今晚去哪裡吃飯', 'zh'], ['佢哋聽日去邊度', 'zh'], ['東京駅', 'Hani'], ['大家好', 'Hani'],
    ['Where is 新宿御苑?', ''], ['iPhone 15 Pro 多少钱？', ''], ['Is 一蘭 near 渋谷駅 still open tonight?', 'Latn'],
    ['안녕하세요 반갑습니다', 'Kore'], ['Где можно поужинать?', 'Cyrl'], ['امشب کجا شام بخوریم؟', 'Arab'], ['আমরা আজ রাতে কোথায় খাব?', 'Beng'],
    ['Is the Café Пушкин open on Sundays?', 'Latn'], ['https://example.com/kiyomizu', ''], ['42 · 7:30', ''], ['', ''],
  ]);
  for (const [x, kind] of cases) assert.equal(L.writing(x), kind, x);
});

// The voice's second step (detector-next): her real sentences that show no language of their own are plan lines of names and times and short
// headers; given the language of her reply so far her sentences got the right voice 98.7 to 99.0% of the time in every list order, against 96.3 to 99.0% without.
test("the phone's voice: a sentence that shows no language of its own takes the language of her reply so far", () => {
  const reply = '我们明天去故宫吧。';
  const jaFirst = listed(['en', 'ja', 'zh']);
  assert.equal(speechLocale(jaFirst, '明天比較滿：'), 'ja-JP', 'alone, Han that says neither is the first listed in Han');
  assert.equal(speechLocale(jaFirst, '明天比較滿：', { before: reply }), 'zh-CN');
  const three = listed(['en', 'zh', 'ja']);
  assert.equal(speechLocale(three, '下一站是 Golden Gate Bridge。'), 'en-US', 'alone, it shows nothing: the first listed');
  assert.equal(speechLocale(three, '下一站是 Golden Gate Bridge。', { before: reply }), 'zh-CN');
  assert.equal(speechLocale(three, '- 10:00–12:00 奇趣钟表博物馆（Pendulum Lane 12号）', { before: reply }), 'zh-CN');
  // A sentence that shows its own language keeps it; Han is never read in a voice not written in Han; a fixed answer language still wins.
  assert.equal(speechLocale(three, 'Where should we eat?', { before: reply }), 'en-US');
  assert.equal(speechLocale(jaFirst, '東京駅。', { before: 'We arrive at noon.' }), 'ja-JP');
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'zh', 'ja'], answer: 'ja' } }, 'en-US'), '下一站是 Golden Gate Bridge。', { before: reply }), 'ja-JP');
});
