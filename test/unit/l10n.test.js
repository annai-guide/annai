import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { t, tc, plural, setWords, key, lang, dir, holes, chooseTag, sameLanguage } from '../../src/core/l10n.js';

beforeEach(() => setWords('en', null));
after(() => setWords('en', null));

test('t gives the English, with the values in place, when no words are set', () => {
  const a = 'June 3';
  assert.equal(t`Last backup ${a}, to ${'Drive'}.`, 'Last backup June 3, to Drive.');
  assert.equal(t`No values`, 'No values');
  assert.equal(t`${1}${2}`, '12');
  assert.equal(lang(), 'en');
  assert.equal(dir(), 'ltr');
});

/** One call site per message, as the code has: a template array is cached per site. @param {string} a @param {string} b */
const backup = (a, b) => t`Last backup ${a}, to ${b}.`;

test('a translation is used with its values in its own order', () => {
  setWords('ja', { [key('Last backup {0}, to {1}.')]: '{1}への最後のバックアップ: {0}' });
  assert.equal(backup('昨日', 'ドライブ'), 'ドライブへの最後のバックアップ: 昨日');
  assert.equal(lang(), 'ja');
});

test('a translation whose placeholders differ gives the English', () => {
  setWords('ja', { [key('Last backup {0}, to {1}.')]: '{0} only' });
  assert.equal(backup('a', 'b'), 'Last backup a, to b.');
  setWords('ja', { [key('Last backup {0}, to {1}.')]: '{0} {1} {2}' });
  assert.equal(backup('a', 'b'), 'Last backup a, to b.');
});

test('a value that looks like a placeholder is left alone', () => {
  setWords('ja', { [key('Hi {0}.')]: 'やあ{0}。' });
  assert.equal(t`Hi ${'{0}{1}'}.`, 'やあ{0}{1}。');
});

test('tc and t look up different keys', () => {
  setWords('ja', { [key('Open')]: '開く', [key('Open', 'verb')]: '開ける' });
  assert.equal(t`Open`, '開く');
  assert.equal(tc('verb')`Open`, '開ける');
  assert.notEqual(key('Open'), key('Open', 'verb'));
});

test('setWords forgets what the call sites cached', () => {
  const site = () => t`Open`;
  assert.equal(site(), 'Open');
  setWords('ja', { [key('Open')]: '開く' });
  assert.equal(site(), '開く');
  setWords('de', { [key('Open')]: 'Öffnen' });
  assert.equal(site(), 'Öffnen');
  setWords('en', null);
  assert.equal(site(), 'Open');
});

test('plural in English: 0, 1, 2 and 1000', () => {
  const stamps = (/** @type {number} */ n) => plural(n, '# stamp', '# stamps');
  assert.deepEqual([0, 1, 2, 1000].map(stamps), ['0 stamps', '1 stamp', '2 stamps', '1,000 stamps']);
});

test('plural carries other values', () => {
  assert.equal(plural(2, '# stamp in {0}', '# stamps in {0}', 'Kyoto'), '2 stamps in Kyoto');
});

test('plural in Japanese has the one form', () => {
  setWords('ja', { [key('# stamp\0# stamps')]: { other: 'スタンプ #個' } });
  assert.equal(plural(1, '# stamp', '# stamps'), 'スタンプ 1個');
  assert.equal(plural(3, '# stamp', '# stamps'), 'スタンプ 3個');
});

test('plural in Arabic has six forms', () => {
  const forms = { zero: 'Z #', one: 'O #', two: 'T #', few: 'F #', many: 'M #', other: 'X #' };
  setWords('ar', { [key('# stamp\0# stamps')]: forms });
  const out = [0, 1, 2, 3, 11, 100].map((n) => plural(n, '# stamp', '# stamps'));
  assert.deepEqual(out.map((s) => s[0]), ['Z', 'O', 'T', 'F', 'M', 'X']);
});

test('a plural form missing from the words is the other form; a mismatched one is the English', () => {
  setWords('ru', { [key('# stamp\0# stamps')]: { other: '# марок' } });
  assert.equal(plural(1, '# stamp', '# stamps'), '1 марок');
  setWords('ru', { [key('# stamp in {0}\0# stamps in {0}')]: { other: '# марок' } });
  assert.equal(plural(5, '# stamp in {0}', '# stamps in {0}', 'Kyoto'), '5 stamps in Kyoto');
});

test('in a right-to-left language the values are isolated; in the others they are not', () => {
  setWords('ar', { [key('Hello {0}.')]: 'مرحبا {0}.' });
  assert.equal(dir(), 'rtl');
  assert.equal(t`Hello ${'Kyoto'}.`, 'مرحبا ⁨Kyoto⁩.');
  setWords('ar', { [key('# stamp {0}\0# stamps {0}')]: { other: '# طوابع {0}' } });
  assert.equal(plural(3, '# stamp {0}', '# stamps {0}', 'x'), '3 طوابع \u2068x\u2069');
  setWords('ja', { [key('Hello {0}.')]: 'こんにちは{0}。' });
  assert.equal(dir(), 'ltr');
  assert.equal(t`Hello ${'Kyoto'}.`, 'こんにちはKyoto。');
  setWords('en', null);
  assert.equal(t`Hello ${'Kyoto'}.`, 'Hello Kyoto.');
});

test('a pseudo transform changes the English, keeps the placeholders, and sets the direction by tag', () => {
  setWords('ar-XB', null, (s) => s.toUpperCase());
  assert.equal(dir(), 'rtl');
  assert.equal(t`go ${'x'} now`, 'GO ⁨x⁩ NOW');
  assert.equal(plural(1, '# a', '# bs'), '1 A');
  assert.equal(plural(2, '# a', '# bs'), '2 BS');
});

test('the keys of the design\'s three examples', () => {
  assert.equal(key('No trips yet. Start one below, or open a trip someone sent you.'), 'yeiyfl');
  assert.equal(key('Last backup {0}, to {1}.'), '33pqd9');
  assert.equal(key('# stamp\0# stamps'), '1e9ja08');
});

test('holes lists the placeholders, once each, in order', () => {
  assert.equal(holes('{1} and {0} and {1}'), '{0}{1}');
  assert.equal(holes('none'), '');
});

test('plural without a translation is English in English\'s way, whatever the interface language counts like', () => {
  setWords('ja', {});
  assert.equal(plural(1, '# stamp', '# stamps'), '1 stamp');
  assert.equal(plural(2, '# stamp', '# stamps'), '2 stamps');
  setWords('ar', { [key('# stamp\0# stamps')]: { zero: 'Z #' } });
  assert.equal(plural(1, '# stamp', '# stamps'), '1 stamp', 'a category the words lack falls to other, then to English');
  setWords('ru', {});
  assert.equal(plural(21, '# stamp', '# stamps'), '21 stamps');
});

// ---- localization L4: which language the screens start in ----

test('the phone\'s languages are matched by language and script: zh-TW is not zh-Hans, and the first one annai has wins', () => {
  const both = ['en', 'ja', 'zh-Hans'];
  assert.deepEqual(chooseTag(null, ['zh-TW', 'ja-JP'], both), { tag: 'ja', region: 'JP' });
  assert.deepEqual(chooseTag(null, ['zh-CN', 'ja-JP'], both), { tag: 'zh-Hans', region: 'CN' });
  assert.deepEqual(chooseTag(null, ['zh-Hans-SG'], both), { tag: 'zh-Hans', region: 'SG' });
  assert.deepEqual(chooseTag(null, ['en-GB'], both), { tag: 'en', region: 'GB' });
  assert.deepEqual(chooseTag(null, ['fr-FR', 'ja'], both), { tag: 'ja', region: '' }, 'a phone language with no region has none');
  assert.deepEqual(chooseTag(null, ['fr-FR'], both), { tag: 'en', region: '' }, 'nothing annai has is English');
  assert.deepEqual(chooseTag(null, [], both), { tag: 'en', region: '' });
  assert.deepEqual(chooseTag(null, ['not a tag', 'ja-JP'], both), { tag: 'ja', region: 'JP' }, 'a tag that is none is passed over');
});

test('Taiwan, Hong Kong, Macau and any zh-Hant phone choose Traditional Chinese, a mainland or Singapore one Simplified (l10n-zh-Hant)', () => {
  const all = ['en', 'ja', 'zh-Hans', 'zh-Hant'];
  assert.deepEqual(chooseTag(null, ['zh-TW'], all), { tag: 'zh-Hant', region: 'TW' });
  assert.deepEqual(chooseTag(null, ['zh-HK', 'en-GB'], all), { tag: 'zh-Hant', region: 'HK' }, 'one Traditional catalog, with Taiwan\'s words, for Hong Kong too');
  assert.deepEqual(chooseTag(null, ['zh-MO'], all), { tag: 'zh-Hant', region: 'MO' });
  assert.deepEqual(chooseTag(null, ['zh-Hant-TW'], all), { tag: 'zh-Hant', region: 'TW' });
  assert.deepEqual(chooseTag(null, ['zh-Hant'], all), { tag: 'zh-Hant', region: '' });
  assert.deepEqual(chooseTag(null, ['zh-CN'], all), { tag: 'zh-Hans', region: 'CN' });
  assert.deepEqual(chooseTag(null, ['zh-SG'], all), { tag: 'zh-Hans', region: 'SG' });
  assert.deepEqual(chooseTag(null, ['zh'], all), { tag: 'zh-Hans', region: '' }, 'Chinese with neither script nor region is Simplified, as Intl takes it');
  assert.deepEqual(chooseTag(null, ['zh-TW', 'ja-JP'], all, ['en', 'ja', 'zh-Hans']), { tag: 'ja', region: 'JP' }, 'while it is unfinished, a Taiwan phone is not given it');
  assert.deepEqual(chooseTag('zh-Hant', ['zh-TW'], all, ['en', 'ja', 'zh-Hans']), { tag: 'zh-Hant', region: 'TW' }, 'but a choice of it is kept, with the phone\'s region');
});

test('a Cantonese phone opens in Traditional Chinese, the Chinese it writes, with its region: yue, yue-HK, yue-Hant-HK and zh-yue (review F5)', () => {
  const all = ['en', 'ja', 'zh-Hans', 'zh-Hant'];
  assert.deepEqual(chooseTag(null, ['yue'], all), { tag: 'zh-Hant', region: '' });
  assert.deepEqual(chooseTag(null, ['yue-HK'], all), { tag: 'zh-Hant', region: 'HK' });
  assert.deepEqual(chooseTag(null, ['yue-Hant-HK', 'en-US'], all), { tag: 'zh-Hant', region: 'HK' });
  assert.deepEqual(chooseTag(null, ['zh-yue'], all), { tag: 'zh-Hant', region: '' });
  assert.ok(sameLanguage('yue-Hans', 'zh-Hans'), 'Cantonese written in Simplified is Simplified');
  assert.ok(!sameLanguage('yue-HK', 'zh-Hans'));
  assert.ok(!sameLanguage('yue', 'ja'));
});

test('an unfinished language is never picked for the user, only by them', () => {
  assert.deepEqual(chooseTag(null, ['ja-JP', 'en-US'], ['en', 'ja'], ['en']), { tag: 'en', region: 'US' });
  assert.deepEqual(chooseTag('ja', ['ja-JP', 'en-US'], ['en', 'ja'], ['en']), { tag: 'ja', region: 'JP' });
});

test('a choice keeps the phone\'s region when it is the phone\'s language, and has none otherwise', () => {
  const offered = ['en', 'ja', 'zh-Hans'];
  assert.deepEqual(chooseTag('ja', ['ja-JP'], offered), { tag: 'ja', region: 'JP' });
  assert.deepEqual(chooseTag('ja', ['en-US', 'ja-JP'], offered), { tag: 'ja', region: 'JP' }, 'the region of the phone\'s Japanese, not its first language');
  assert.deepEqual(chooseTag('ja', ['en-US'], offered), { tag: 'ja', region: '' }, 'a phone in English has no Japanese region to give');
  assert.deepEqual(chooseTag('en', ['ja-JP', 'en-GB'], offered), { tag: 'en', region: 'GB' });
  assert.deepEqual(chooseTag('zh-Hans', ['zh-TW'], offered), { tag: 'zh-Hans', region: '' }, 'Traditional Chinese is not the Simplified a choice asks for');
});

test('a choice no longer offered falls back to the phone\'s languages, not straight to English', () => {
  assert.deepEqual(chooseTag('ko', ['ko-KR', 'ja-JP'], ['en', 'ja', 'zh-Hans']), { tag: 'ja', region: 'JP' });
  assert.deepEqual(chooseTag('ko', ['fr-FR'], ['en', 'ja']), { tag: 'en', region: '' });
  assert.deepEqual(chooseTag('', ['ja-JP'], ['en', 'ja']), { tag: 'ja', region: 'JP' }, 'an empty choice is none');
});
