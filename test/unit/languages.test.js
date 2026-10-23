import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, nativeName, languageSettings, languagesText, modelLanguages, speechLocale, strayLanguage, languageOf } from '../../src/core/languages.js';

// Languages you speak (phase 2): the list, the setting read from the app settings, and the words models are told.

test('every language has a name and the codes each model takes, and the browser knows its name for itself; ids are unique', () => {
  const ids = new Set(LANGUAGES.map((l) => l.id));
  assert.equal(ids.size, LANGUAGES.length);
  for (const l of LANGUAGES) {
    assert.ok(l.name && l.locale && l.iso && l.live, l.id);
    assert.match(l.locale, /^[a-z]{2,3}(-[A-Za-z0-9]+)+$/, l.id);
  }
  assert.deepEqual(['ja', 'zh', 'es'].map((id) => nativeName(/** @type {any} */ (LANGUAGES.find((l) => l.id === id)))), ['日本語', '中文', 'español']);
  const zh = LANGUAGES.find((l) => l.id === 'zh');
  assert.deepEqual([zh?.name, zh?.iso, zh?.live, zh?.google, zh?.locale], ['Chinese (Mandarin)', 'zh', 'zh-Hans', 'cmn-Hans-CN', 'zh-CN']);
});

test('with nothing saved the setting is the browser\'s language, answering in the language she is spoken to', () => {
  const s = languageSettings({}, 'ja-JP');
  assert.deepEqual(s.spoken.map((l) => l.id), ['ja']);
  assert.equal(s.answer, null);
  assert.equal(s.explicit, false);
  assert.equal(languageSettings({}, 'en-GB').spoken[0].locale, 'en-GB', "the browser's own region is kept");
  assert.deepEqual(languageSettings({}, 'nb-NO').spoken.map((l) => l.id), ['no']);
  assert.deepEqual(languageSettings({}, 'xx-YY').spoken.map((l) => l.id), ['en'], 'a language annai has no code for: English');
  assert.deepEqual(languageSettings({}, undefined).spoken.map((l) => l.id), ['en']);
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
  const one = languagesText(languageSettings({}, 'en-US'));
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

test('the browser voice and dictation: the answer language if fixed; else the language of the sentence among those listed; else the first', () => {
  const three = languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US');
  assert.equal(speechLocale(three, 'Where should we eat?'), 'en-US');
  assert.equal(speechLocale(three, 'ラーメンを食べましょう'), 'ja-JP');
  assert.equal(speechLocale(three, '我们去吃饭吧'), 'zh-CN');
  assert.equal(speechLocale(three, '한국어'), 'en-US', 'a language not listed: the first listed');
  assert.equal(speechLocale(languageSettings({ languages: { spoken: ['en', 'ja'], answer: 'ja' } }, 'en'), 'Hello'), 'ja-JP');
  assert.equal(speechLocale(three, ''), 'en-US');
  assert.equal(speechLocale(three), 'en-US');
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
  assert.equal(strayLanguage('bonjour', languageSettings({ languages: { spoken: ['en'] } }, 'en')), '', 'a word no small list can place');
  assert.equal(strayLanguage('merci', languageSettings({ languages: { spoken: ['en'] } }, 'en')), 'French');
  assert.equal(strayLanguage('Où est la gare, s’il vous plaît', en), '', 'a sentence is the user going on in another language, if they do: not a stray word');
  assert.equal(strayLanguage('gracias señor', en), 'Spanish');
  assert.equal(strayLanguage('¿Qué?', languageSettings({ languages: { spoken: ['en', 'es'] } }, 'en')), '', 'listed');
  assert.equal(strayLanguage('', en), '');
});

test('languageOf names the language of a text by its script or its commonest words (moved from compaction, unchanged)', () => {
  assert.equal(languageOf('今日の夕食はどこにしますか'), 'Japanese');
  assert.equal(languageOf('我们今晚去哪里吃饭'), 'Chinese');
  assert.equal(languageOf('Is the Café Пушкин open on Sundays?'), 'English');
  assert.equal(languageOf('hmm'), '');
});
