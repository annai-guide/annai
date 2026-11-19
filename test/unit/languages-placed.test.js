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
/** What the request says where Han that says neither gave the language by the order alone (the first they speak written in Han; nothing chosen: the phone's), not that the lines are in it. */
const byOrder = (/** @type {string} */ name, ofPhone = false) => `${name}, ${ofPhone ? "the language of the user's phone" : 'the first language the user speaks written in Han'} (the lines that decide are Han, which doesn't tell Japanese from Chinese)`;
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
  // The entry's trip: two plain Japanese lines and five such lines (main, nothing chosen: Spanish).
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

test('with nothing chosen, a Chinese trip on a Japanese phone is Chinese (R2), Simplified on a Taiwanese phone Simplified, and a Ukrainian phone stands for all Cyrillic', () => {
  assert.equal(summaryLanguage([s1, '我们明天去哪里', '好想去看夜景'], phone('ja-JP')), most('Chinese (Simplified)'), 'main: Japanese');
  // Its edge: only kanji lines on a Japanese phone are Japanese.
  assert.equal(summaryLanguage(['東京駅', '新宿駅前', '浅草寺'], phone('ja-JP')), byOrder('Japanese', true));
  assert.equal(summaryLanguage([s1, '我们明天去哪里'], phone('zh-TW')), most('Chinese (Simplified)'), 'main: Chinese (Traditional)');
  // The check made Russian on a Ukrainian phone Russian; the final review's F2 reversed it (the main session's call): the phone stands for its script, as a Bulgarian or Serbian phone
  // does, so Ukrainian with none of і ї є ґ (6.9% of real sentences of 5 words or more) is no longer Russian. A Russian line on a Ukrainian phone is read as the phone's too.
  assert.equal(summaryLanguage(['Де ми можемо повечеряти?', 'Де знаходиться музей?', 'Дякую за допомогу'], phone('uk-UA')), most('Ukrainian'), 'the review: Russian');
  assert.equal(summaryLanguage(['Где можно поужинать сегодня вечером?', 'Музей сегодня открыт?'], phone('uk-UA')), most('Ukrainian'), 'main: Ukrainian; the check: Russian');
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

test('the edges option 1 takes (the design check\'s a to e), pinned, as the final review and fix round 1 left them', () => {
  const three = listed(['en', 'zh', 'ja']);
  // a, revisited (fix round 1: the second reviewers, and the English trip is the traveller's own kind): an English line with a kanji name is English, since its Latin
  // words name English (2 small words); a line whose Latin words name no language has no grammar of its own to tell by and is not counted (main counted it for nothing too: its summary was the first listed).
  assert.equal(id('Where is 新宿御苑?', three), 'en', 'the check: not counted');
  assert.equal(id('Meet at 新宿 station at noon.', three), null);
  assert.equal(summaryLanguage(['Where is 新宿御苑?', 'Where is 新宿御苑?', j1], listed(['en', 'ja'])), most('English'), 'the check: Japanese');
  // b, revisited (Haiku-2's finding 4): with Japanese and Chinese both listed, a window of Han that tells nothing is the first of them written in Han, as the voice reads it (main: Chinese).
  assert.equal(id('大家好', three), 'either');
  assert.equal(summaryLanguage(['大家好', '明天去京都'], three), byOrder('Chinese (Simplified)'), 'the check: English, the first listed');
  assert.equal(summaryLanguage(['大家好', '明天去京都'], listed(['ja', 'zh'])), byOrder('Japanese'));
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
  // N2: with Chinese first and English screens, 東京駅 is still drawn as Chinese, but in the listed row's own forms: 東, 時 and 間 are Japanese's too, so they say no row (detector-next's fix round 1; before detector-next: zh-Hant).
  assert.equal(tagOf('東京駅', listed(['en', 'zh', 'ja'])), 'zh-Hans');
  assert.equal(tagOf('東京駅', listed(['en', 'zh-Hant', 'ja'])), 'zh-Hant', 'the listed row is Traditional');
  assert.equal(tagOf('東京駅', listed(['en', 'ja', 'zh'])), 'ja', 'before detector-next: zh-Hant');
  assert.equal(tagOf('東京駅', listed(['en', 'zh', 'ja']), false, 'ja'), 'ja', 'Japanese screens; before detector-next: zh-Hant');
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
    // A line with Chinese, Japanese or Korean characters and Latin words is Latin only when its Latin words name a language (fix round 1; the pins were '' and ''):
    ['Where is 新宿御苑?', 'Latn'], ['Where is 天安门?', 'Latn'], ['新宿 Shibuya Sky', ''], ['好想去 Golden Gate Bridge', ''], ['iPhone 15 Pro 多少钱？', 'zh'],
    ['Is 一蘭 near 渋谷駅 still open tonight?', 'Latn'],
    ['안녕하세요 반갑습니다', 'Kore'], ['Где можно поужинать?', 'Cyrl'], ['امشب کجا شام بخوریم؟', 'Arab'], ['আমরা আজ রাতে কোথায় খাব?', 'Beng'],
    ['Is the Café Пушкин open on Sundays?', 'Latn'], ['https://example.com/kiyomizu', ''], ['42 · 7:30', ''], ['', ''],
  ]);
  for (const [x, kind] of cases) assert.equal(L.writing(x), kind, x);
});

// The voice's second step (detector-next): her real sentences that show no language of their own are plan lines of names and times and short
// headers; given the language of her reply so far her sentences got the right voice 99.4 to 99.5% of the time in every list order of [en, ja] and [en, zh, ja], against 96.5 to 99.5% without
// (the numbers of fix round 1; the first two commits: 98.7 to 99.0% against 96.3 to 99.0%).
test("the phone's voice: a sentence that shows no language of its own takes the language of her reply so far", () => {
  const reply = '我们明天去故宫吧。';
  const jaFirst = listed(['en', 'ja', 'zh']);
  assert.equal(speechLocale(jaFirst, '明天比較滿：'), 'ja-JP', 'alone, Han that says neither is the first listed in Han');
  assert.equal(speechLocale(jaFirst, '明天比較滿：', { before: [reply] }), 'zh-CN');
  const three = listed(['en', 'zh', 'ja']);
  assert.equal(speechLocale(three, '下一站是 Golden Gate Bridge。'), 'en-US', 'alone, it shows nothing: the first listed');
  assert.equal(speechLocale(three, '下一站是 Golden Gate Bridge。', { before: [reply] }), 'zh-CN');
  assert.equal(speechLocale(three, '- 10:00–12:00 奇趣钟表博物馆（Pendulum Lane 12号）', { before: [reply] }), 'zh-CN');
  // A sentence that shows its own language keeps it; Han is never read in a voice not written in Han; a fixed answer language still wins.
  assert.equal(speechLocale(three, 'Where should we eat?', { before: [reply] }), 'en-US');
  assert.equal(speechLocale(jaFirst, '東京駅。', { before: ['We arrive at noon.'] }), 'ja-JP');
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'zh', 'ja'], answer: 'ja' } }, 'en-US'), '下一站是 Golden Gate Bridge。', { before: [reply] }), 'ja-JP');
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// Fix round 1 of detector-next (the final review's F1 to F6 and the four second opinions, 2026-11-17). Each test below failed on the branch's first
// two commits (f7c4a373f), except three that pass there and pin a rule the round kept or a measure it made: the catalog's Japanese is no Chinese, the
// writing edges (the Latin threshold, the name rule, a script two share) and the join of Han that says neither for a chosen list; the title names the finding.

const three = listed(['en', 'zh', 'ja']);

test('a line with Chinese, Japanese or Korean characters and Latin words is Latin only when its Latin words name a language: English with a kanji name is English, Han with a Latin name is not (Haiku-3 Fix B, Haiku-1 1B, Haiku-2 1 and 2)', () => {
  // The English line with a name in kanji, in Chinese-only characters or in Hangul: English (main: English; the first commits: not counted, or Chinese).
  for (const x of ['Where is 新宿御苑?', 'Where is 天安门?', 'Where is 东京站?', 'Where is 서울역?', 'Take the JR line from 東京駅 to 新宿駅 then 中野駅.', 'Is 東京駅 far from the hotel?', 'Is 浅草寺 open today?']) {
    assert.equal(id(x, three), 'en', x);
    assert.equal(id(x, listed(['ja', 'en'])), 'en', x);
    assert.equal(id(x, phone('ja-JP')), 'en', `${x}: nothing chosen on a Japanese phone`);
  }
  // Han or kana with a Latin name that names no language is not English: it shows nothing (the first commits: English).
  for (const x of ['新宿 Shibuya Sky', '東京 Tokyo Tower', '好想去 Golden Gate Bridge', '想去 Tokyo Tower', 'Meet at 新宿 station at noon.']) {
    assert.equal(L.writing(x), '', x);
    assert.equal(id(x, three), null, x);
  }
  // A trip of such Japanese lines is Japanese, in every setting where the one plain line counts (the first commits: English, from the Latin names).
  const ja = ['新宿 Shibuya Sky', '東京 Tokyo Tower', '浅草 Sensoji', j2];
  for (const s of [listed(['en', 'ja']), three, listed(['zh', 'en', 'ja']), phone('en-US'), phone('ja-JP')]) assert.equal(summaryLanguage(ja, s), most('Japanese'), s.spoken.map((l) => l.id).join());
  // And a Chinese trip is Chinese by 你, 们, 哪 in its lines (the first commits: English).
  const zh = ['好想去 Golden Gate Bridge', '想去 Tokyo Tower', '你好 Tokyo Tower 在哪里', s1];
  for (const s of [three, listed(['zh', 'en', 'ja']), phone('en-US'), phone('zh-CN')]) assert.equal(summaryLanguage(zh, s), most('Chinese (Simplified)'), s.spoken.map((l) => l.id).join());
  // The English trip with kanji names, which the check's edge a counted for nothing and the first commits for Japanese.
  const en = ['Where is 新宿御苑?', 'Where is 浅草寺?', 'Take the JR line from 東京駅 to 新宿駅 then 中野駅.', j1];
  for (const s of [three, listed(['en', 'ja']), listed(['ja', 'en']), listed(['ja', 'zh', 'en']), phone('en-US'), phone('ja-JP'), phone('zh-CN')]) assert.equal(summaryLanguage(en, s), most('English'), s.spoken.map((l) => l.id).join());
  // The voice: her English sentence with kanji names, first in her reply, is in the English voice, not the first listed language's.
  assert.equal(speechLocale(listed(['ja', 'en']), 'Take the JR line from 東京駅 to 新宿駅 then 中野駅.'), 'en-US', 'the first commits: ja-JP');
  assert.equal(speechLocale(listed(['zh', 'en']), 'Where is 新宿御苑?'), 'en-US', 'the first commits: zh-TW, from 東');
  // Kana is Japanese's grammar and a character only Chinese writes is Chinese's, whatever the Latin around them, when nothing in Latin names a language.
  assert.equal(L.writing('Los Angelesまで何時間？'), 'Jpan');
  assert.equal(L.writing('下一站是 Golden Gate Bridge。'), '', '4 characters against 3 words, 16 letters: a name');
  assert.equal(L.writing('我们明天去 Golden Gate Bridge 吗？'), 'zh');
});

test('Chinese lines with no character of the check\'s list carry one of 21 more: 请 钱 饭 为 让 觉 脑 确 认 设 项 应 类 图 边 办 进 种 层 运 张, none of which is in the catalog\'s Japanese (the next test; Haiku-3 finding 3)', () => {
  for (const c of [...'请钱饭为让觉脑确认设项应类图边办进种层运张']) assert.equal(L.writing(`明天${c}`), 'zh', c);
  assert.equal(L.writing('我想吃饭'), 'zh');
  assert.equal(L.writing('请问这里怎么走'), 'zh');
  assert.equal(L.writing('多少钱？'), 'zh');
  // 后 and 无 are in Japanese's own character set (皇后), so they are left out; so are 的 and 是 (目的地, 是非).
  for (const x of ['皇后', '后藤', '无', '目的地', '是非']) assert.notEqual(L.writing(x), 'zh', x);
  // The check's other characters stay pinned: the 12 Traditional forms Japanese writes otherwise, and the small words, one by one.
  for (const c of [...'說對關點發實經樣樂國會來']) assert.equal(L.writing(`明天${c}`), 'zh', c);
  for (const c of ['你', '您', '她', '們', '這', '哪', '吗', '嗎', '呢', '吧', '么', '麼', '沒', '很', '啊', '佢', '哋']) assert.equal(L.writing(`明天${c}`), 'zh', c);
  // A Chinese trip of such lines is Chinese in every list and on an English phone (the first commits: the first listed language, or the phone's).
  const trip = ['我想吃饭', '请问这里怎么走', '多少钱？', '好想去看夜景', e1, 'Thank you so much!'];
  for (const s of [three, listed(['ja', 'en', 'zh']), listed(['zh', 'en', 'ja']), phone('en-US'), phone('ja-JP')]) assert.equal(summaryLanguage(trip, s), most('Chinese (Simplified)'), s.spoken.map((l) => l.id).join());
});

test('no line of the catalog\'s Japanese is Chinese by its writing (Haiku-3 finding 3: the list\'s reason; the 33 kept Japanese runs were measured by hand, not here)', async () => {
  const { readFileSync } = await import('node:fs');
  const rows = readFileSync(new URL('../../l10n/ja.tsv', import.meta.url), 'utf8').split('\n').slice(1).map((r) => r.split('\t')[3]).filter(Boolean);
  assert.ok(rows.filter((x) => /[\u3040-\u30ff]/u.test(x)).length > 2000, 'the column read is the Japanese one: most of its rows have kana');
  assert.deepEqual(rows.filter((x) => L.writing(x) === 'zh'), []);
});

test('the Simplified or Traditional row is taken from characters only for a line that is Chinese by its writing: Japanese kanji that share Traditional forms say none (Haiku-4 finding 3a, Haiku-1 Part A, Haiku-3 finding 5)', () => {
  for (const x of ['東京駅', '時間', '電車', '開店', '見学', '東京駅 9:00 · 新宿 11:00']) assert.equal(L.hanRow(x), '', x);
  assert.equal(L.hanRow('我們今晚去哪裡吃飯'), 'zh-Hant');
  assert.equal(L.hanRow('我们今晚去哪里吃饭'), 'zh');
  // The voice: with Chinese listed before Japanese a Han line that says neither takes the first listed Han language's own row, not zh-TW from 東 (the first commits).
  for (const x of ['東京駅', '時間', '東京駅 9:00 · 新宿 11:00']) {
    assert.equal(speechLocale(three, x), 'zh-CN', x);
    assert.equal(speechLocale(listed(['en', 'zh-Hant', 'ja']), x), 'zh-TW', `${x}: its own row is Traditional`);
    assert.equal(speechLocale(phone('zh-CN'), x), 'zh-CN', `${x}: a Simplified phone`);
    assert.equal(speechLocale(listed(['zh', 'zh-Hant']), x), 'zh-CN', `${x}: the first listed Chinese row`);
    assert.equal(speechLocale(listed(['ja', 'en', 'zh']), x), 'ja-JP', x);
  }
  // Characters that say a row still choose its voice, even with the other row listed first.
  assert.equal(speechLocale(listed(['zh', 'zh-Hant']), '我們今晚去哪裡吃飯'), 'zh-TW');
  assert.equal(speechLocale(listed(['zh-Hant', 'zh']), '我们今晚去哪里吃饭'), 'zh-CN');
  // The tag: the same rule; 時間 is no Traditional evidence (the first commits: zh-Hant).
  assert.equal(tagOf('時間', three), 'zh-Hans');
  assert.equal(tagOf('時間', listed(['en', 'zh-Hant', 'ja'])), 'zh-Hant');
  assert.equal(tagOf('我們今晚去哪裡吃飯', three), 'zh-Hant', 'characters that say Traditional');
  assert.equal(tagOf('東京駅', phone('zh-CN')), 'zh-Hans', 'main: zh-Hant');
  // The summary names the row from Chinese lines only, as it did (東京駅 is no vote).
  assert.equal(summaryLanguage(['東京駅', '時間', s1], listed(['zh', 'zh-Hant', 'en'])), most('Chinese (Simplified)'));
  // The voice reads the row from the sentence's Han characters alone, as the tag does (Haiku-3 finding 3 of round 1's second opinions): a Traditional sentence after English words is
  // zh-TW, and so is an English sentence with Traditional names that Chinese reads for want of English (991c8093c: zh-CN, from a whole-sentence reading that Latin words spoiled).
  assert.equal(speechLocale(listed(['zh']), 'Where should we eat? 我們今晚去哪裡'), 'zh-TW');
  assert.equal(tagOf('Where should we eat? 我們今晚去哪裡', listed(['en', 'zh'])), 'zh-Hant', 'the tag, one rule with the voice');
  assert.equal(speechLocale(listed(['zh']), 'Where is 故宮博物院 對面?'), 'zh-TW', '991c8093c: zh-CN');
  assert.equal(speechLocale(listed(['zh']), 'Where should we eat? 我们今晚去哪里'), 'zh-CN');
});

test('with only Han that says neither, the summary is the first listed language written in Han, as the voice reads it; other lines still count (Haiku-2 finding 4)', () => {
  const kanji = ['東京駅', '浅草寺', '新宿駅前'];
  for (const [ids, name] of /** @type {[string[], string][]} */ ([[['en', 'zh', 'ja'], 'Chinese (Simplified)'], [['en', 'ja', 'zh'], 'Japanese'], [['en', 'zh-Hant', 'ja'], 'Chinese (Traditional)'], [['zh', 'ja'], 'Chinese (Simplified)'], [['ja', 'zh'], 'Japanese']])) {
    assert.equal(summaryLanguage(kanji, listed(ids)), byOrder(name), ids.join());
    assert.equal(speechLocale(listed(ids), kanji[0]).split('-')[0], /** @type {Record<string, string>} */ ({ 'Chinese (Simplified)': 'zh', 'Chinese (Traditional)': 'zh', Japanese: 'ja' })[name], `the voice: ${ids.join()}`);
  }
  // Nothing chosen: the phone's, when it is written in Han, else the answer for no line at all.
  assert.equal(summaryLanguage(kanji, phone('zh-TW')), byOrder('Chinese (Traditional)', true));
  assert.equal(summaryLanguage(kanji, phone('ja-JP')), byOrder('Japanese', true));
  assert.equal(summaryLanguage(kanji, phone('en-US')), "English, the language of the user's phone (nothing the user wrote names a language)");
  // One English line beside them still counts, and the Han lines do not outvote it (they join no side).
  assert.equal(summaryLanguage([e1, ...kanji], three), most('English'));
});

test('the join of Han that says neither, for a chosen list: it goes to the side with lines of its own, all of it, a tie to the newer, each of Japanese, Mandarin and Cantonese by itself (the final review F5)', () => {
  const kanji = ['東京駅', '浅草寺', '新宿駅前'];
  // Three English lines, one Japanese line and three kanji names: Japanese (4 against 3); without the join, English; adding 1 instead of 3, English.
  assert.equal(summaryLanguage([e1, e2, 'Is it far from here?', j1, ...kanji], three), most('Japanese'));
  assert.equal(summaryLanguage([e1, e2, 'Is it far from here?', ...kanji, j1], listed(['en', 'ja', 'zh'])), most('Japanese'));
  // The Chinese side, by one line with 们 and two that tell nothing: Chinese.
  assert.equal(summaryLanguage([e1, e2, s1, '大家好', '明天去京都'], three), most('Chinese (Simplified)'));
  assert.equal(summaryLanguage([e1, e2, s1, '大家好', '明天去京都'], listed(['en', 'ja', 'zh'])), most('Chinese (Simplified)'));
  // A tie of lines of their own goes to the newer: the kanji names follow it.
  assert.equal(summaryLanguage([j1, s1, ...kanji, e1], listed(['ja', 'zh', 'en'])), most('Chinese (Simplified)'));
  assert.equal(summaryLanguage([s1, j1, ...kanji, e1], listed(['zh', 'ja', 'en'])), most('Japanese'));
  // Mandarin and Cantonese are two sides, not one: 2 + 2 against Japanese 3 is Japanese, and the kanji names follow it.
  const yue = ['我哋今晚去邊度食飯', '佢哋聽日去邊度'];
  assert.equal(summaryLanguage([...yue, s1, s2, j1, j2, '今日はいい天気です', '大家好', '明天去京都'], listed(['zh', 'yue', 'ja', 'en'])), most('Japanese'));
  // The same, without Japanese: Cantonese's lines and Mandarin's tie, the newer wins them.
  assert.equal(summaryLanguage([s1, s2, ...yue, '大家好'], listed(['zh', 'yue', 'ja'])), most('Cantonese'));
  assert.equal(summaryLanguage([...yue, s1, s2, '大家好'], listed(['zh', 'yue', 'ja'])), most('Chinese (Simplified)'));
});

test('her reply so far is the first earlier sentence that shows a language, for Han that says neither the first written in Han, not a reading of the sentences joined (the final review F1, Haiku-2 finding 3)', () => {
  // The English reply that names Japanese places: a name with hiragana early on no longer makes the English sentences Japanese, and the plan lines take the Han language heard.
  const reply = ['Sure, here is the plan.', '・18:30 すき家 新宿三丁目店', 'Take the JR 山手線 from 上野駅 to 新宿駅.', 'Dinner is at 一蘭 渋谷店.', '新宿御苑 closes at 16:30.'];
  assert.equal(speechLocale(three, reply[3], { before: reply.slice(0, 3) }), 'en-US', 'the first commits: ja-JP, from the hiragana of すき家 in the joined text');
  assert.equal(speechLocale(three, reply[4], { before: reply.slice(0, 4) }), 'en-US', 'the first commits: ja-JP');
  assert.equal(speechLocale(three, '・10:00 浅草寺', { before: reply }), 'ja-JP', 'the Han language already heard in her reply: main and the first commits, zh-CN');
  assert.equal(speechLocale(three, '・10:00 浅草寺', { before: ['Sure, here is the plan.'] }), 'zh-CN', 'no Han heard: the first listed in Han');
  // The first that shows one, not the joined text: one Chinese sentence and two Japanese ones read joined are Japanese; the first is Chinese.
  const mixed = ['我们明天去故宫吧。', '今日は晴れです。', '今日は雨です。'];
  assert.equal(speechLocale(three, '10:00 東京駅', { before: mixed }), 'zh-CN', 'the first commits: ja-JP');
  assert.equal(speechLocale(three, '10:00 東京駅', { before: [...mixed].reverse() }), 'ja-JP');
  // A sentence that shows nothing takes any language of the reply; Han that says neither takes only one written in Han.
  assert.equal(speechLocale(three, '10:00–12:00', { before: ['Where should we eat?'] }), 'en-US');
  assert.equal(speechLocale(three, '東京駅', { before: ['Where should we eat?'] }), 'zh-CN', 'English is not written in Han: the first listed in Han');
});

test('with nothing chosen a sentence in the phone\'s script is read in the phone\'s voice; Ukrainian with none of і ї є ґ on a Ukrainian phone is Ukrainian (the final review F2)', () => {
  // The voice: a Dutch phone's Dutch sentence has "is" and "open" in it (the first commits: en-US), a Slovenian phone's has "je" (fr-FR).
  assert.equal(speechLocale(phone('nl-NL'), 'Het museum is open.'), 'nl-NL', 'the first commits: en-US');
  assert.equal(speechLocale(phone('sl-SI'), 'Datoteka je pokvarjena, zato je ni mogoče predvajati.'), 'sl-SI', 'the first commits: fr-FR');
  assert.equal(speechLocale(phone('ca-ES'), 'Aquest és el nostre museu.'), 'ca-ES');
  assert.equal(speechLocale(phone('en-US'), 'Je voudrais un café avec du lait'), 'en-US', 'another language of the same script: the phone\'s voice, as main');
  // A sentence in another script is still read as what it is (Japanese replies on an English phone), and a plan line takes her reply's language only where it shows none.
  assert.equal(speechLocale(phone('en-US'), '明日の予定です。'), 'ja-JP');
  assert.equal(speechLocale(phone('ur-PK'), 'Where should we eat tonight?'), 'en-US');
  assert.equal(speechLocale(phone('nl-NL'), '10:00–12:00', { before: ['Waar gaan we eten?'] }), 'nl-NL');
  // The summary, tag and voice on a Ukrainian phone: Cyrillic is Ukrainian (the check: Russian), by the phone standing for its script.
  const uk = phone('uk-UA');
  for (const x of ['Де ми можемо повечеряти?', 'Дякую за допомогу', 'Где можно поужинать сегодня вечером?']) {
    assert.equal(id(x, uk), 'uk', x);
    assert.equal(speechLocale(uk, x), 'uk-UA', x);
    assert.equal(summaryLanguage([x], uk), most('Ukrainian'), x);
  }
  // A Russian phone keeps Russian, with Ukrainian's own letters Ukrainian; a Bulgarian phone is Bulgarian.
  assert.equal(id('Где можно поужинать?', phone('ru-RU')), 'ru');
  assert.equal(id('Де ми будемо вечеряти ввечері?', phone('ru-RU')), 'uk');
  assert.equal(id('Къде можем да вечеряме тази вечер?', phone('bg-BG')), 'bg');
  // Summary of French lines on an English phone: French (two small words name it); the voice reads them in the phone's voice, as it did on main.
  assert.equal(summaryLanguage(['Je voudrais un café avec du lait', 'Nous sommes à Paris avec les enfants', 'Où est le musée, s\'il vous plaît?'], phone('en-US')), most('French'));
});

test('a script two listed languages share, with nothing telling them apart, is read in the first listed language written in it, not the first listed language of any script (the final review F3)', () => {
  const ru = 'Где можно поужинать сегодня вечером?';
  assert.equal(speechLocale(listed(['en', 'ru', 'bg']), ru), 'ru-RU', 'the first commits: en-US, every Russian sentence');
  assert.equal(speechLocale(listed(['en', 'bg', 'ru']), ru), 'bg-BG');
  assert.equal(speechLocale(listed(['ja', 'ru', 'en', 'bg']), ru), 'ru-RU');
  // A Latin sentence under [ja, en, tr], where nothing tells English from Turkish: the first Latin language, not the Japanese voice (the first commits).
  assert.equal(speechLocale(listed(['ja', 'en', 'tr']), 'Bu akşam nerede yemek yiyebiliriz?'), 'en-US');
  assert.equal(speechLocale(listed(['ja', 'en', 'tr']), 'Where should we eat tonight?'), 'en-US');
  assert.equal(speechLocale(listed(['ja', 'tr', 'en']), 'Bu akşam nerede yemek yiyebiliriz?'), 'tr-TR');
  // A sentence that shows no script still takes the first listed language.
  assert.equal(speechLocale(listed(['ja', 'en', 'tr']), '10:00–12:00'), 'ja-JP');
  // Han that says neither is the first of theirs written in Han, as before.
  assert.equal(speechLocale(listed(['en', 'ja', 'zh']), '東京駅'), 'ja-JP');
});

test('two listed Latin-script languages that both have small-word lists: one small word of one and none of the other\'s names the line; otherwise two (the final review F4)', () => {
  const es = listed(['en', 'es']);
  assert.equal(id('¿Quieres cenar ahora?', es), 'es', 'the mark ¿ is one word of Spanish');
  assert.equal(speechLocale(es, '¿Quieres cenar ahora?'), 'es-ES', 'the first commits: en-US');
  assert.equal(speechLocale(es, 'Take the bus.'), 'en-US');
  assert.equal(speechLocale(listed(['es', 'en']), 'Take the bus.'), 'en-US', 'one small word of English, none of Spanish');
  assert.equal(speechLocale(listed(['ja', 'en', 'es']), 'Take the bus.'), 'en-US', 'the first commits: ja-JP');
  for (const [ids, x, locale] of /** @type {[string[], string, string][]} */ ([[['en', 'fr'], 'Merci beaucoup', 'fr-FR'], [['en', 'de'], 'Danke schön, bitte', 'de-DE'], [['en', 'it'], 'Grazie, ciao', 'it-IT']])) assert.equal(speechLocale(listed(ids), x), locale, x);
  // The summary of a Spanish window whose lines each carry one small word (the first commits: the first listed language, English).
  const spanish = ['Gracias por la ayuda', 'Muchas gracias amigo', 'Gracias, hasta mañana'];
  assert.equal(summaryLanguage(spanish, es), most('Spanish'));
  assert.equal(summaryLanguage(spanish, listed(['es', 'en'])), most('Spanish'));
  // The cost, as on main: "Los Angeles hotel" is Spanish when Spanish is listed beside English, English with English alone or with Japanese.
  assert.equal(id('Los Angeles hotel', es), 'es');
  assert.equal(id('Los Angeles hotel', listed(['en', 'ja'])), 'en');
  // With a listed Latin-script language that has no list (Turkish, Polish), a line must carry two small words, as built.
  assert.equal(id('Gracias por la ayuda', listed(['en', 'es', 'tr'])), null);
  assert.equal(id('Gracias por todo, amigo', listed(['en', 'es', 'tr'])), null);
  assert.equal(id('Muchas gracias por la ayuda', listed(['en', 'es', 'tr'])), null, 'one word of Spanish and none of English is still one');
  assert.equal(id('Muchas gracias. Hola, muy bien', listed(['en', 'es', 'tr'])), 'es', 'three words');
  // Nothing chosen: two, as built.
  assert.equal(id('Gracias por la ayuda', phone('en-US')), null);
});

test('a line names Vietnamese only by a mark only Vietnamese writes (ơ, ư, a tone mark), not by â ê ô that French, Romanian and Portuguese share (Haiku-1 finding 2)', () => {
  const en = phone('en-US');
  for (const x of ['Bienvenue à l\'hôtel, c\'est près de la gare.', 'Mâine mergem la Iași, este lângă gară.', 'Crêpes pour tout le monde']) {
    assert.notEqual(id(x, en), 'vi', x);
    assert.notEqual(id(x, phone('ja-JP')), 'vi', `${x}: a Japanese phone`);
  }
  // A French line, a Romanian one and a third that names no language: with nothing chosen on an English phone each is the phone's (the first commits: Vietnamese).
  assert.equal(summaryLanguage(['Bienvenue à l\'hôtel, c\'est près de la gare.', 'Mâine mergem la Iași, este lângă gară.', 'Crêpes pour tout le monde'], en), most('English'), 'the first commits: Vietnamese');
  assert.equal(speechLocale(en, 'Bienvenue à l\'hôtel, c\'est près de la gare.'), 'en-US', 'the first commits: vi-VN');
  // Its own marks still name it, with nothing chosen and listed.
  assert.equal(id('Chưa biết', en), 'vi');
  assert.equal(id('Tối nay chúng ta ăn ở đâu?', listed(['en', 'vi'])), 'vi');
  assert.equal(summaryLanguage(['Tối nay chúng ta ăn ở đâu?', 'Bảo tàng hôm nay có mở cửa không?', 'Cảm ơn bạn rất nhiều'], en), most('Vietnamese'));
});

test('writing and placed: the Latin threshold and the name rule\'s edge (writing), a script two listed languages share (placed), pinned one by one (Haiku-3 finding 7, the final review)', () => {
  // A line that is half Latin and half Cyrillic has no majority.
  assert.equal(L.writing('ab ЖЖ'), '');
  assert.equal(L.writing('abc ЖЖ'), 'Latn');
  // The name rule's edge: as many characters as Latin letters is a name; one more is the line's.
  assert.equal(L.writing('abcd 新宿御苑'), '', '4 characters, 4 letters: a name');
  assert.equal(L.writing('abc 新宿御苑'), 'Hani', '4 characters, 3 letters');
  assert.equal(L.writing('目的地'), 'Hani', '的 is no Chinese-only character');
  // Two listed Cyrillic languages and a line nothing tells apart: none of theirs.
  assert.equal(id('Къде можем да вечеряме тази вечер?', listed(['bg', 'ru'])), null);
  assert.equal(id('Къде можем да вечеряме тази вечер?', listed(['bg'])), 'bg');
  // The tag places the characters alone: 「東京駅 Tokyo Station」 is Japanese with Japanese listed, though its line names none.
  assert.equal(tagOf('東京駅 Tokyo Station', listed(['en', 'ja'])), 'ja');
  assert.equal(tagOf('時間 Tokyo', listed(['en', 'ja'])), 'ja');
  // 你, 您 and 她 are Chinese's.
  for (const x of ['你好', '您好', '她好']) assert.equal(L.writing(x), 'zh', x);
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// Fix round 2 of detector-next (the re-review's R1 to R4 and the second opinions' Haiku-1 findings 5 and 6, Haiku-2 F1 and F3, Haiku-3 3 and 4,
// 2026-11-17). Each test below failed on 991c8093c (the end of round 1), except R3 (a)'s, which pins a rule round 1 built (the threshold of two small
// words: with one, two of its lines change reading) and passes there by design. The tag's `hanTag(own…)` of R3 (c) cannot be pinned after this round:
// with a line's writing taken first (the tag test) and Chinese's small words before a Latin name's (R1), `own` and `said` read one row, and a fuzz of
// 300,000 random lines under 8 lists and 4 screens finds no difference.

test("Chinese's own small words are grammar, as hiragana is: a Chinese sentence naming an English place with two small words is Chinese; a name in a Chinese form stays English (R1)", () => {
  const zh = ['我们明天上午去 The Museum of Modern Art，下午去中央公园。', '我們明天去 The Art Institute of Chicago 嗎？', '我们明天上午去 Top of the Rock，下午去中央公园。', '我們明天去 Museum of the Moving Image 吧，下午去中央公園。'];
  for (const x of zh) {
    assert.equal(L.writing(x), 'zh', x);
    assert.equal(id(x, three), 'zh', x);
    assert.equal(speechLocale(three, x), x.includes('們') ? 'zh-TW' : 'zh-CN', `${x}: the first commits gave zh, 991c8093c en-US`);
  }
  assert.equal(speechLocale(listed(['en', 'zh-Hant', 'ja']), zh[1]), 'zh-TW');
  // Cantonese's characters are small words too.
  assert.equal(L.writing('佢哋聽日去邊度睇 The Museum of Modern Art'), 'zh');
  // The summary: on a Simplified phone three such lines and two English lines are Chinese (991c8093c: English).
  const trip = [zh[0], zh[2], '我们明天去 The Art Institute of Chicago 吗？', e1, e2];
  for (const s of [phone('zh-CN'), three, listed(['en', 'ja', 'zh'])]) assert.equal(summaryLanguage(trip, s), most('Chinese (Simplified)'), s.spoken.map((l) => l.id).join());
  // What stays: a name in a Chinese form, or in kanji, in an English line is English (the forms come after the small words, as the name rule's grammar of its own).
  for (const x of ['Where is 天安门?', 'Where is 东京站?', 'Where is 新宿御苑?']) assert.equal(L.writing(x), 'Latn', x);
  // Chinese's small words outrank Latin words only where its characters outnumber them: an English sentence quoting 你好 stays English.
  assert.equal(L.writing('Say 你好 to the staff at the desk.'), 'Latn');
});

test('Han that is placed as none of theirs is Han that says neither: with Japanese listed and Chinese not, a Chinese-only character is read in the Japanese voice, not the English one (R2)', () => {
  const enja = listed(['en', 'ja']);
  for (const x of ['靖國神社', '我们明天去故宫吧。', '國學院大學']) {
    assert.equal(id(x, enja), null, `${x}: placed as none of theirs`);
    assert.equal(speechLocale(enja, x), 'ja-JP', `${x}: 991c8093c en-US`);
    assert.equal(speechLocale(enja, x, { before: ['Sure, here is the plan.'] }), 'ja-JP', `${x} after an English sentence`);
  }
  assert.equal(speechLocale(enja, '我们明天去故宫吧。', { before: ['今日は晴れです。'] }), 'ja-JP');
  // No Han language listed: still the first listed, as before; with Chinese listed, nothing changes.
  assert.equal(speechLocale(listed(['en']), '我们明天去故宫吧。'), 'en-US');
  assert.equal(speechLocale(three, '我们明天去故宫吧。'), 'zh-CN');
  // A fixed answer language still wins.
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'ja'], answer: 'en' } }, 'en-US'), '靖國神社'), 'en-US');
});

test("nothing chosen: Han that says neither joins the phone's language only where no other line counts, so an English trip with kanji names on a Han phone is English (Haiku-2 F1, the re-review's R3 (b) turned round)", () => {
  const kanji = ['東京駅', '浅草寺', '新宿駅前', '渋谷駅'];
  for (const locale of ['ja-JP', 'zh-CN', 'zh-TW']) {
    const s = phone(locale);
    assert.equal(summaryLanguage([e1, e2, ...kanji], s), most('English'), `${locale}: 991c8093c named the phone's language`);
    assert.equal(summaryLanguage([...kanji, e2, 'Is it far from here?'], s), most('English'), locale);
    // No line counts but the kanji names: the phone's, as before.
    assert.equal(summaryLanguage(kanji, s), byOrder(locale === 'ja-JP' ? 'Japanese' : locale === 'zh-TW' ? 'Chinese (Traditional)' : 'Chinese (Simplified)', true), locale);
  }
  // The request says what decided the language: Han that says neither goes by the order (or the phone), and no line shows it, so it does not say the lines are in it; a counted line does.
  assert.doesNotMatch(summaryLanguage(kanji, phone('ja-JP')), /most of what the user wrote/);
  assert.doesNotMatch(summaryLanguage(kanji, listed(['en', 'ja', 'zh'])), /most of what the user wrote/);
  assert.match(summaryLanguage([e1, e2, ...kanji], listed(['en', 'ja', 'zh'])), /most of what the user wrote/);
  assert.match(summaryLanguage([j1, ...kanji], listed(['en', 'zh', 'ja'])), /most of what the user wrote/, 'kana lines of its own: the names join them');
  // A kana line on a Japanese phone is a line of Japanese: the names join it.
  assert.equal(summaryLanguage([e1, e2, ...kanji, j1, j2], phone('ja-JP')), most('Japanese'));
  // With a chosen list the same rule, as in round 1: the names join the side with lines of their own, else the first listed in Han only where nothing else counts.
  assert.equal(summaryLanguage([e1, e2, ...kanji], listed(['en', 'ja', 'zh'])), most('English'));
});

test("the name rule's threshold is two small words: one beside a kanji name or a Chinese form names no language (R3 (a); it passes on 991c8093c, pinning the rule)", () => {
  // `says` takes two small words (one is a name's or English's own): with one, these two change reading.
  assert.equal(id('Tickets for 浅草寺?', three), null);
  assert.equal(L.writing('Tickets for 浅草寺?'), '');
  assert.equal(L.writing('这家 The Cheesecake Factory 怎么样？'), 'zh');
  assert.equal(L.writing('地铁站在 The Cheesecake Factory 对面'), 'zh', 'one small word ("The") names nothing; the Chinese tell here is a form (对), not a small word');
  assert.equal(L.writing('地铁站在 The Museum of Modern Art 对面'), 'Latn', 'two small words name English, and a form is a name');
});

test("a line's tag follows its writing: an English line with kanji names inherits the screens' language, as English does (Haiku-1 finding 5); it is no Chinese or Japanese tag", () => {
  for (const x of ['Where is 新宿御苑?', 'Take the 都営大江戸線 from 新宿 to the hotel.', 'Where is 天安门?']) {
    for (const ids of [['en', 'ja'], ['ja', 'en'], ['en', 'zh', 'ja'], ['en', 'zh-Hant', 'ja']]) assert.equal(tagOf(x, listed(ids)), '', `${x} ${ids}: 991c8093c ja, zh-Hans or zh-Hant`);
    assert.equal(tagOf(x, phone('en-US')), '', x);
  }
  // Under screens not in Latin letters it is the English the line says.
  assert.equal(tagOf('Where is 天安门?', listed(['en', 'zh-Hant', 'ja']), false, 'zh-Hant'), 'en', 'Traditional screens: English, not zh-Hant or zh-Hans');
  assert.equal(tagOf('Where is 新宿御苑?', listed(['ja', 'en']), false, 'ja'), 'en');
  // A line that is Han with names in Latin letters stays tagged by its Han (writing says Chinese or Japanese, not Latin).
  assert.equal(tagOf('iPhone 15 Pro 多少钱？', phone('en-US')), 'zh-Hans');
  assert.equal(tagOf('我们明天上午去 The Museum of Modern Art，下午去中央公园。', phone('en-US')), 'zh-Hans', 'R1: Chinese, so tagged Chinese');
  assert.equal(tagOf('Shibuya Sky のチケット', phone('en-US')), 'ja');
});

test("the 21 characters tell Simplified from Traditional too (Haiku-1 finding 6): 确认一下设置 is Simplified under [en, zh-Hant, ja]; 国 会 来 stay out", async () => {
  const x = '确认一下设置';
  assert.equal(L.hanRow(x), 'zh', '991c8093c: no row');
  for (const c of [...'请钱饭为让觉脑确认设项应类图边办进种层运张']) assert.equal(L.hanRow(`明天${c}`), 'zh', c);
  assert.equal(tagOf(x, listed(['en', 'zh-Hant', 'ja'])), 'zh-Hans', '991c8093c: zh-Hant, from the list');
  assert.equal(speechLocale(listed(['en', 'zh-Hant', 'ja']), x), 'zh-CN', '991c8093c: zh-TW');
  assert.equal(speechLocale(listed(['yue', 'zh']), x), 'zh-CN', 'Simplified is Mandarin, though Cantonese is listed first');
  assert.equal(summaryLanguage([x, '请问这里怎么走', '多少钱？'], listed(['zh-Hant', 'zh', 'en'])), most('Chinese (Simplified)'), '991c8093c: Traditional, the first listed row');
  // 国 会 来 are Japanese's too: they say no row (東京駅 and 国会 stay unread).
  for (const t of ['国会', '会来', '国']) assert.equal(L.hanRow(`明天${t}`), '', t);
  // No line of the Traditional catalog reads as Simplified (the check Haiku-1's fix needs: 0 before this round and after).
  const { readFileSync } = await import('node:fs');
  const rows = readFileSync(new URL('../../l10n/zh-Hant.tsv', import.meta.url), 'utf8').split('\n').slice(1).map((r) => r.split('\t')[3]).filter(Boolean);
  assert.ok(rows.length > 2000);
  assert.deepEqual(rows.filter((r) => L.hanRow(r) === 'zh'), []);
});

// voice-reply-next: the two Deferred entries ("A line's tag doesn't read her reply so far, as the phone's voice does"; "A reply's separate speak calls each
// start with nothing before them"). A line or sentence of hers that shows no language of its own takes her reply's so far, for the tag and the voice by one
// rule (replyLanguage); where nothing in the line or the reply tells, each reader keeps its own default.
test("a line's tag reads Han that says neither in her reply's language so far, as her voice does: 「好的。」 after 「我们明天去故宫吧。」 with [en, ja, zh] (main: ja, the voice zh-CN)", () => {
  const s = listed(['en', 'ja', 'zh']);
  const before = ['我们明天去故宫吧。'];
  assert.equal(tagOf('好的。', s, true, 'en', { before }), 'zh-Hans');
  assert.equal(speechLocale(s, '好的。', { before }), 'zh-CN');
  // With nothing before it in her reply, both take the first listed in Han (English screens).
  assert.equal(tagOf('好的。', s, true, 'en'), 'ja');
  assert.equal(speechLocale(s, '好的。'), 'ja-JP');
  // Her reply's language is the first of its sentences that shows one written in Han: an English one is passed over, and they are not read joined.
  assert.equal(tagOf('東京駅。', listed(['en', 'zh', 'ja']), true, 'en', { before: ['Here is the plan.', '今日は晴れです。', '我们明天去故宫吧。'] }), 'ja');
  assert.equal(speechLocale(listed(['en', 'zh', 'ja']), '東京駅。', { before: ['Here is the plan.', '今日は晴れです。', '我们明天去故宫吧。'] }), 'ja-JP');
  assert.equal(tagOf('東京駅。', listed(['en', 'zh', 'ja']), true, 'en', { before: ['Here is the plan.'] }), 'zh-Hans', 'only English before it: the first listed in Han');
  // The first earlier sentence that shows a language decides, not a reading of them joined (a Chinese sentence and a Japanese one read joined are Japanese).
  const first = ['我们明天去故宫吧。', '今日は晴れです。'];
  assert.equal(tagOf('東京駅。', listed(['en', 'zh', 'ja']), true, 'en', { before: first }), 'zh-Hans', 'first, not joined');
  assert.equal(speechLocale(listed(['en', 'zh', 'ja']), '東京駅。', { before: first }), 'zh-CN', 'first, not joined');
  // A line that shows its own language keeps it, whatever her reply was in.
  assert.equal(tagOf('今日は晴れです。', s, true, 'en', { before }), 'ja');
  assert.equal(tagOf('这是我们说的', s, true, 'en', { before: ['今日は晴れです。'] }), 'zh-Hans');
});

test("where neither the line nor her reply tells, each reader keeps its own default for Han that says neither: the tag the screens' language when it is one of theirs written in Han (what the page draws with no tag), the voice the first listed in Han: 「東京駅」 with [ja, zh] on Simplified screens, 「大家好」 with [zh, ja] on Japanese screens", () => {
  const ja = listed(['ja', 'zh']);
  assert.equal(tagOf('東京駅', ja, true, 'zh-Hans'), 'zh-Hans', "the screens'; the first listed is ja");
  assert.equal(speechLocale(ja, '東京駅'), 'ja-JP', 'the first listed');
  const zh = listed(['zh', 'ja']);
  assert.equal(tagOf('大家好', zh, true, 'ja'), 'ja', "the screens'; the first listed is zh");
  assert.equal(speechLocale(zh, '大家好'), 'zh-CN', 'the first listed');
  // Her reply so far still decides before either default does.
  assert.equal(tagOf('大家好', zh, true, 'ja', { before: ['今日は晴れです。'] }), 'ja');
  assert.equal(speechLocale(zh, '大家好', { before: ['今日は晴れです。'] }), 'ja-JP');
  assert.equal(tagOf('東京駅', ja, true, 'zh-Hans', { before: ['今日は晴れです。'] }), 'ja');
  assert.equal(tagOf('東京駅', ja, true, 'zh-Hans', { before: ['我们明天去故宫吧。'] }), 'zh-Hans');
});
