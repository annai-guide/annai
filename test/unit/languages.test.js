import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, nativeName, languageSettings, languagesText, modelLanguages, speechLocale, dictationLocale, listedFor, strayLanguage, languageOf } from '../../src/core/languages.js';

// Languages you speak (phase 2): the list, the setting read from the app settings, and the words models are told.

test('every language has a name and the codes each model takes, and the browser knows its name for itself; ids are unique', () => {
  const ids = new Set(LANGUAGES.map((l) => l.id));
  assert.equal(ids.size, LANGUAGES.length);
  for (const l of LANGUAGES) {
    assert.ok(l.name && l.locale && l.iso && (l.live || l.id === 'yue'), l.id);
    assert.match(l.locale, /^[a-z]{2,3}(-[A-Za-z0-9]+)+$/, l.id);
  }
  assert.deepEqual(['ja', 'zh', 'es'].map((id) => nativeName(/** @type {any} */ (LANGUAGES.find((l) => l.id === id)))), ['日本語', '中文', 'español']);
  assert.equal(LANGUAGES.length, 41, 'the list has 41 languages');
  assert.equal(LANGUAGES.find((l) => l.id === 'yue')?.live, null, "Gemini Live's zh-Hant is not Cantonese: Cantonese has no Live code (review item 12)");
  const zh = LANGUAGES.find((l) => l.id === 'zh');
  assert.deepEqual([zh?.name, zh?.iso, zh?.live, zh?.google, zh?.locale], ['Chinese (Mandarin)', 'zh', 'zh-Hans', 'cmn-Hans-CN', 'zh-CN']);
});

test('with nothing saved the setting is the browser\'s language, answering in the language she is spoken to', () => {
  const s = languageSettings({}, 'ja-JP');
  assert.deepEqual(s.spoken.map((l) => l.id), ['ja']);
  assert.equal(s.answer, null);
  assert.equal(s.explicit, false);
  assert.equal(languageSettings({}, 'en-GB').spoken[0].locale, 'en-GB', "the browser's own region is kept");
  assert.deepEqual(languageSettings({}, 'nb-NO').spoken.map((l) => [l.id, l.locale]), [['no', 'nb-NO']]);
  assert.deepEqual(languageSettings({}, undefined).spoken.map((l) => l.id), ['en']);
  assert.equal(languageSettings({}, 'not a locale!').spoken[0].id, 'en', 'a tag that is none: English');
});

test('with nothing saved, the browser\'s own tag is the locale, as before this branch: a language annai has no code for keeps its name and tag (review item 3)', () => {
  // et, is, eu, ur, lv, lt... were English; zh-Hant-TW dictated as zh-CN.
  for (const [tag, name] of [['et-EE', 'Estonian'], ['is', 'Icelandic'], ['eu-ES', 'Basque'], ['ur-PK', 'Urdu'], ['lv', 'Latvian'], ['lt-LT', 'Lithuanian']]) {
    const s = languageSettings({}, tag);
    assert.deepEqual([s.spoken[0].name, s.spoken[0].locale, s.explicit], [name, tag, false], tag);
    assert.equal(dictationLocale(s), tag, `${tag}: dictation in the browser's own language`);
    assert.equal(speechLocale(s, 'Tere'), tag, `${tag}: and the browser voice`);
    assert.deepEqual(modelLanguages(s), { spoken: [], answer: null }, `${tag}: no protocol is given a hint`);
  }
  const hant = languageSettings({}, 'zh-Hant-TW');
  assert.deepEqual([hant.spoken[0].id, hant.spoken[0].locale, dictationLocale(hant)], ['zh', 'zh-Hant-TW', 'zh-Hant-TW']);
  assert.equal(languageSettings({}, 'pt_BR').spoken[0].locale, 'pt-BR', 'a tag written with an underscore');
});

test('with nothing chosen the model is told what the phone is set to, not that the user speaks it: a Chinese speaker with an English phone is not told they speak English (review item 3)', () => {
  const one = languagesText(languageSettings({}, 'en-US'));
  assert.equal(one, "The user's phone is set to English, and they may speak other languages. Answer in the language they used. Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again.");
  assert.match(languagesText(languageSettings({}, 'et-EE')), /^The user's phone is set to Estonian, and they may speak other languages\./);
  const fixed = languagesText(languageSettings({ languages: { answer: 'ja' } }, 'en-US'));
  assert.equal(fixed, "The user's phone is set to English. Always answer in Japanese, whatever language they use. Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again.");
  assert.doesNotMatch(languagesText(languageSettings({ languages: { spoken: ['en'] } }, 'ja')), /phone/, 'chosen: they speak it');
});

test('a saved setting is read in order; unknown ids and repeats are dropped; an empty list is no setting', () => {
  const s = languageSettings({ languages: { spoken: ['zh', 'en', 'xx', 'zh', 'ja'], answer: 'follow' } }, 'en-US');
  assert.deepEqual(s.spoken.map((l) => l.id), ['zh', 'en', 'ja']);
  assert.equal(s.explicit, true);
  assert.equal(s.answer, null);
  const onlyAnswer = languageSettings({ languages: { spoken: [], answer: 'ja' } }, 'fr');
  assert.deepEqual([onlyAnswer.explicit, onlyAnswer.spoken[0].id, onlyAnswer.answer?.id], [false, 'fr', 'ja'], 'a fixed answer language needs no list of its own');
  assert.equal(languageSettings({ languages: { spoken: ['en'], answer: 'ja' } }, 'fr').answer?.id, 'ja');
  assert.equal(languageSettings({ languages: { spoken: ['en'], answer: 'xx' } }, 'fr').answer, null, 'a language not in the list is follow');
  assert.equal(languageSettings({ languages: 'oops' }, 'fr').explicit, false);
});

test('what models are told (the user, 2026-10-23): the languages, that they may switch, never to switch for one word, and to ask again', () => {
  const three = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  assert.equal(languagesText(three),
    "The user speaks English, Chinese (Mandarin) and Japanese; they may switch between these. Answer in the language they used. Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again.");
  assert.match(languagesText(languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en')), /^The user speaks English and Japanese; they may switch between these\. Answer in the language they used\./);
  const one = languagesText(languageSettings({ languages: { spoken: ['en'] } }, 'en-US'));
  assert.match(one, /^The user speaks English\. Answer in the language they used\./);
  assert.doesNotMatch(one, /switch between/);
  const fixed = languagesText(languageSettings({ languages: { spoken: ['en', 'ja'], answer: 'ja' } }, 'en'));
  assert.match(fixed, /^The user speaks English and Japanese\. Always answer in Japanese, whatever language they use\. Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again\.$/);
});

test('what a model protocol is given is plain data: the codes of each language, in order, and the fixed answer language', () => {
  const m = modelLanguages(languageSettings({ languages: { spoken: ['en', 'zh', 'ja'], answer: 'ja' } }, 'en'));
  assert.deepEqual(m.spoken.map((l) => [l.iso, l.live, l.google]), [['en', 'en', 'en-US'], ['zh', 'zh-Hans', 'cmn-Hans-CN'], ['ja', 'ja', 'ja-JP']]);
  assert.equal(m.answer?.id, 'ja');
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, 'nothing but data: it crosses into a plugin');
  assert.equal(modelLanguages(languageSettings({}, 'en')).answer, null);
  // Until the user picks, the browser's language is only told in words: a hint that forces a Whisper-style model to English would
  // garble a Japanese speaker whose browser is in English, so no protocol is given one.
  assert.deepEqual(modelLanguages(languageSettings({}, 'en-US')), { spoken: [], answer: null });
  assert.equal(modelLanguages(languageSettings({ languages: { answer: 'ja' } }, 'en-US')).answer?.id, 'ja');
});

test('the browser voice: the answer language if fixed; else the language of the sentence among those listed; else the first', () => {
  const three = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  assert.equal(speechLocale(three, 'Where should we eat?'), 'en-US');
  assert.equal(speechLocale(three, 'ラーメンを食べましょう'), 'ja-JP');
  assert.equal(speechLocale(three, '我们去吃饭吧'), 'zh-CN');
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'ja', 'zh'] } }, 'en'), '我们去吃饭吧'), 'zh-CN', 'Han alone is Chinese when Chinese is listed, even behind Japanese');
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en'), '大丈夫'), 'ja-JP', 'and Japanese when only that is');
  assert.equal(speechLocale(three, '한국어'), 'en-US', 'a language not listed: the first listed');
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'ja'], answer: 'ja' } }, 'en'), 'Hello'), 'ja-JP');
  assert.equal(speechLocale(three, ''), 'en-US');
  assert.equal(speechLocale(three), 'en-US');
});

test('phone dictation takes one tag, the first language listed, whatever Shiori answers in (review item 1: the answer language is for her voice, not for your ears)', () => {
  const fixed = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'], answer: 'ja' } }, 'en-US');
  assert.equal(dictationLocale(fixed), 'en-US', 'you speak English first; she answers in Japanese');
  assert.equal(speechLocale(fixed, 'Hello'), 'ja-JP', 'her browser voice follows the answer language');
  assert.equal(dictationLocale(languageSettings({ languages: { spoken: ['ja', 'en'] } }, 'en-US')), 'ja-JP');
  assert.equal(dictationLocale(languageSettings({}, 'en-GB')), 'en-GB');
});

test('a very short transcript in a language that is not listed is stray: named, never a language change (the user, 2026-10-23)', () => {
  const en = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  // The words Gemini Live wrote for short English replies on 2026-10-22.
  assert.equal(strayLanguage('¿Qué?', en), 'Spanish');
  assert.equal(strayLanguage('chưa', en), 'Vietnamese');
  assert.equal(strayLanguage('Aha.', en), '', 'English-looking: nothing to say');
  assert.equal(strayLanguage('parco', en), '', "a word no list can place isn't called foreign");
  assert.equal(strayLanguage('Yes.', en), '');
  // Words English shares with another language place nothing (the first real run: "No." was called Spanish).
  for (const said of ['No.', 'No', 'What?', 'All right.', 'Sure.', 'Okay.', 'Mm.']) assert.equal(strayLanguage(said, en), '', said);
  assert.equal(strayLanguage('はい', en), '', 'listed');
  assert.equal(strayLanguage('你好', en), '', 'listed');
  assert.equal(strayLanguage('안녕', en), 'Korean');
  assert.equal(strayLanguage('gracias señor', en), 'Spanish');
  assert.equal(strayLanguage('merci beaucoup', languageSettings({ languages: { spoken: ['en'] } }, 'en')), 'French');
  assert.equal(strayLanguage('Où est la gare, s’il vous plaît', en), '', 'a sentence is the user going on in another language, if they do: not a stray word');
  assert.equal(strayLanguage('¿Qué?', languageSettings({ languages: { spoken: ['en', 'es'] } }, 'en')), '', 'listed');
  assert.equal(strayLanguage('', en), '');
});

test('the stray flag does not call short English or a name foreign: one word of another language\'s list is not enough (review item 4)', () => {
  const en = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  // Each was flagged by one hit in a small word list ("um" Portuguese, "as" Portuguese, "da" Portuguese...).
  for (const said of ['Um.', 'As well.', 'As usual.', 'Da.', 'O.', 'Son.', 'Al.', 'Van.', 'Op.', 'Die.', 'Den.', 'Dove.', 'Per se.', 'Des Moines.', 'Le Monde.', 'Hola.', 'Bonjour.', 'Gracias.', 'Merci.']) {
    assert.equal(strayLanguage(said, en), '', said);
  }
  // Two words of one language, or a mark only that language has, still place it.
  assert.equal(strayLanguage('¡Hola!', en), 'Spanish');
  assert.equal(strayLanguage('Não.', en), 'Portuguese');
  assert.equal(strayLanguage('Muchas gracias', en), '', 'one word of the list and no mark: not enough');
  assert.equal(strayLanguage('Hola gracias', en), 'Spanish');
  // Romanian "Bună" has an ă, which is not Vietnamese.
  assert.equal(strayLanguage('Bună', en), '');
});

test('kanji alone is Japanese when Japanese is listed and Chinese is not, and Chinese when Chinese is listed (review item 4)', () => {
  const ja = languageSettings({ languages: { spoken: ['en', 'ja'] } }, 'en');
  for (const said of ['了解', '大丈夫', '本当?', '無理', '々', '頑張って']) assert.equal(strayLanguage(said, ja), '', said);
  const zh = languageSettings({ languages: { spoken: ['en', 'zh'] } }, 'en');
  assert.equal(strayLanguage('大丈夫', zh), '');
  assert.equal(strayLanguage('はい', zh), 'Japanese', 'kana is Japanese, and only Japanese');
  // Han alone with neither listed is Chinese (there is no way to tell).
  assert.equal(strayLanguage('了解', languageSettings({ languages: { spoken: ['en'] } }, 'en')), 'Chinese');
  assert.deepEqual([listedFor('Chinese', ja.spoken)?.id, listedFor('Chinese', zh.spoken)?.id, listedFor('Japanese', zh.spoken)], ['ja', 'zh', null]);
});

test('CJK text is counted by character, not as one word: a sentence is not a short transcript, two characters are (review item 4)', () => {
  const en = languageSettings({ languages: { spoken: ['en'] } }, 'en');
  assert.equal(strayLanguage('안녕', en), 'Korean');
  assert.equal(strayLanguage('안녕하세요 반갑습니다', en), '', 'a sentence');
  assert.equal(strayLanguage('ありがとうございます', en), '');
  assert.equal(strayLanguage('はい', en), 'Japanese');
  assert.equal(strayLanguage('我们今晚去哪里吃饭', en), '', 'nine characters: a sentence');
  assert.equal(strayLanguage('好', en), 'Chinese');
});

test('Vietnamese is placed by its own marks, including â, ê, ô and đ where no listed language uses them (review item 4, Step S6)', () => {
  const en = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  assert.equal(strayLanguage('không', en), 'Vietnamese');
  assert.equal(strayLanguage('đúng', en), 'Vietnamese');
  assert.equal(strayLanguage('được', en), 'Vietnamese');
  assert.equal(strayLanguage('chưa', en), 'Vietnamese');
  // French and Portuguese use â, ê and ô: with either listed, those three marks alone say nothing.
  for (const spoken of [['en', 'fr'], ['en', 'pt']]) assert.equal(strayLanguage('không', languageSettings({ languages: { spoken } }, 'en')), '', spoken.join());
  assert.equal(strayLanguage('chưa', languageSettings({ languages: { spoken: ['en', 'fr'] } }, 'en')), 'Vietnamese', 'ư is Vietnamese only');
  assert.equal(strayLanguage('không', languageSettings({ languages: { spoken: ['en', 'vi'] } }, 'en')), '', 'listed');
});

test('languageOf names the language of a text by its script or its commonest words (moved from compaction; its word lists lost the words other languages share)', () => {
  assert.equal(languageOf('今日の夕食はどこにしますか'), 'Japanese');
  assert.equal(languageOf('我们今晚去哪里吃饭'), 'Chinese');
  assert.equal(languageOf('Is the Café Пушкин open on Sundays?'), 'English');
  assert.equal(languageOf('hmm'), '');
});
