import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, plural, key } from '../../src/core/l10n.js';
import {
  locale, sentences, sentenceGap, num, numField, parseNum, money, size, distance, setDistances, duration, seconds, relTime, day, dateRange, when, zone, list, languageName, sortWords, formatCost,
} from '../../src/ui/format.js';

// The helpers speak the interface language with the phone's region: `as('en', 'de-DE')` is English screens on a German phone.
const phone = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
/** @param {string} ui @param {string} [on] the phone's language */
function as(ui, on = ui) {
  setWords(ui, null);
  Object.defineProperty(globalThis, 'navigator', { value: { language: on }, configurable: true });
}
afterEach(() => {
  setWords('en', null);
  if (phone) Object.defineProperty(globalThis, 'navigator', phone);
});

const AT = Date.UTC(2026, 10, 25, 18, 30); // 10:30 in Los Angeles, 19:30 in Paris
const LA = 'America/Los_Angeles';

test('locale: the screens\' language with the phone\'s region', () => {
  as('en', 'en-US');
  assert.equal(locale(), 'en-US');
  as('en', 'en-GB');
  assert.equal(locale(), 'en-GB');
  as('en', 'de-DE');
  assert.equal(locale(), 'en-DE', 'English words, a German phone\'s number marks');
  as('en', 'de');
  assert.equal(locale(), 'en-DE', 'a phone language with no region has its likeliest');
  as('ja', 'en-US');
  assert.equal(new Intl.NumberFormat(locale()).resolvedOptions().locale, 'ja', 'ja-US is what Intl resolves to ja');
  as('en', 'not a locale!');
  assert.equal(locale(), 'en', 'a phone tag Intl refuses leaves the screens\' language');
});

test('num, and the numbers in fields', () => {
  as('en', 'en-US');
  assert.equal(num(1234.5), '1,234.5');
  assert.equal(numField(1234.5), '1234.5');
  assert.equal(numField(1.048576), '1.048576');
  assert.equal(numField(undefined), '');
  assert.equal(numField(null), '');
  as('en', 'de-DE');
  assert.equal(num(1234.5), '1.234,5');
  assert.equal(numField(1.5), '1,5');
  as('ja', 'ja-JP');
  assert.equal(num(1234.5), '1,234.5');
  as('ar', 'ar-EG');
  assert.equal(num(12), new Intl.NumberFormat('ar-EG').format(12));
});

test('parseNum reads what a person types in their language', () => {
  for (const [ui, on] of [['en', 'en-US'], ['en', 'en-GB'], ['ja', 'ja-JP'], ['zh-Hans', 'zh-CN']]) {
    as(ui, on);
    assert.equal(parseNum('1.5'), 1.5, `${ui} ${on}`);
    assert.equal(parseNum('1,500'), 1500, `${ui} ${on}: a comma before three digits is a thousands mark`);
    assert.equal(parseNum('1,500.25'), 1500.25);
    assert.equal(parseNum('1,5'), 1.5, 'a comma that cannot be a thousands mark is a decimal one');
    assert.equal(parseNum('0,500'), 0.5, 'a thousands mark has 1 to 999 before it');
    assert.equal(parseNum('0.500'), 0.5);
    assert.equal(parseNum('12,500'), 12500);
    assert.equal(parseNum(' 42 '), 42);
    assert.equal(parseNum('.5'), 0.5);
    assert.equal(parseNum('-3'), -3);
    assert.equal(parseNum('1,234,567'), 1234567);
  }
  for (const [ui, on] of [['de', 'de-DE'], ['en', 'de-DE'], ['en', 'fr-FR'], ['en', 'es-ES']]) {
    as(ui, on);
    assert.equal(parseNum('1,5'), 1.5, `${ui} ${on}`);
    assert.equal(parseNum('0,25'), 0.25);
    assert.equal(parseNum('1.5'), 1.5, 'a point that cannot be a thousands mark is a decimal one');
  }
  as('de', 'de-DE');
  assert.equal(parseNum('1.500'), 1500, 'a German thousands mark');
  assert.equal(parseNum('0.500'), 0.5, 'not a thousands mark: nothing, or a zero, before it');
  assert.equal(parseNum('1.234,5'), 1234.5);
  assert.equal(parseNum('1 234,5'), 1234.5);
  assert.equal(parseNum('1.234.567'), 1234567);
  as('en', 'de-DE');
  assert.equal(parseNum('1.234,5'), 1234.5);
  assert.equal(parseNum('0.500'), 0.5);
  // Marks that are not thousands before the last one are a typo, not a number.
  as('en', 'en-US');
  for (const bad of ['2.5,5', '1.5,0', '1.5,5', '1.234,5', '1,23,45', '1,2,3', '1..2', '1,,2', '1.2.3']) assert.ok(Number.isNaN(parseNum(bad)), `en ${bad}`);
  as('de', 'de-DE');
  for (const bad of ['2,5.5', '1,5.0', '1,234.5', '1.23.45', '1,2,3']) assert.ok(Number.isNaN(parseNum(bad)), `de ${bad}`);
  // Only digits and marks are a number: no names, no hex, no exponents, no Infinity, and nothing is not zero.
  for (const bad of ['', '  ', 'lots', 'Infinity', '-Infinity', '0x1F', '1e400', '1e3', '--1', '+-1', '1,2,x', '.', ',', '-', '1 2 x']) assert.ok(Number.isNaN(parseNum(bad)), JSON.stringify(bad));
  assert.ok(Number.isNaN(parseNum(undefined)));
  assert.equal(parseNum('+1.5'), 1.5);
  assert.equal(parseNum('5.'), 5);
  // A Japanese keyboard types full-width digits and marks.
  as('ja', 'ja-JP');
  assert.equal(parseNum('１２'), 12);
  assert.equal(parseNum('１，５００'), 1500);
  assert.equal(parseNum('１．５'), 1.5);
  assert.equal(parseNum('\u22123'), -3, 'a typographic minus');
});

test('money: a cost below a cent keeps two significant digits', () => {
  as('en', 'en-US');
  assert.equal(money(1.234), '$1.23');
  assert.equal(money(0), '$0.00');
  assert.equal(money(0.0042), '$0.0042');
  assert.equal(money(0.000125), '$0.00013');
  assert.equal(money(0.5, 'USD', { minimumFractionDigits: 0, maximumFractionDigits: 6 }), '$0.5');
  assert.equal(money(1234.5, 'EUR'), '€1,234.50');
  assert.equal(money(5, 'not a currency'), '5 not a currency');
  as('ja', 'ja-JP');
  assert.equal(money(0.0042), '$0.0042', 'Japanese rounds to $0.00 by default');
  assert.equal(money(1.234), new Intl.NumberFormat('ja', { style: 'currency', currency: 'USD' }).format(1.234));
  as('en', 'de-DE');
  assert.equal(money(1.234), new Intl.NumberFormat('en-DE', { style: 'currency', currency: 'USD' }).format(1.234), 'the platform\'s own');
  as('de', 'de-DE');
  assert.equal(money(1.234), '1,23\u00a0$');
  as('en', 'en-US');
  assert.equal(formatCost(0), 'free');
  assert.equal(formatCost(undefined), 'cost unknown');
  assert.equal(formatCost(NaN), 'cost unknown');
  assert.equal(formatCost(0.0042), '$0.0042');
});

test('size: by 1024s, a tenth below ten', () => {
  as('en', 'en-US');
  assert.equal(size(0), '0 bytes');
  assert.equal(size(1), '1 byte');
  assert.equal(size(512), '512 bytes');
  assert.equal(size(1023), '1,023 bytes');
  assert.equal(size(1536), '1.5 kB');
  assert.equal(size(5 * 1024 * 1024), '5.0 MB');
  assert.equal(size(12.4 * 1024 * 1024), '12 MB');
  assert.equal(size(3 * 1024 ** 3), '3.0 GB');
  assert.equal(size(5000 * 1024 ** 3), '5,000 GB');
  as('en', 'de-DE');
  assert.equal(size(1536), '1,5 kB');
  as('zh-Hans', 'zh-CN');
  assert.equal(size(5 * 1024 * 1024), new Intl.NumberFormat('zh-Hans-CN', { style: 'unit', unit: 'megabyte', unitDisplay: 'short', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(5));
});

test('distance: the Distances choice wins over the region, and Automatic is the region again (localization L6)', () => {
  try {
    as('en', 'en-US');
    setDistances('km');
    assert.equal(distance(42.3), '42 km');
    as('en', 'de-DE');
    setDistances('mi');
    assert.equal(distance(42.3), '26 mi');
    setDistances(null);
    assert.equal(distance(42.3), '42 km');
    setDistances('furlongs');
    assert.equal(distance(42.3), '42 km', 'what it doesn\'t know is Automatic');
  } finally {
    setDistances(null);
  }
});

test('distance: miles where the region uses them, kilometres elsewhere', () => {
  as('en', 'en-US');
  assert.equal(distance(0.581), '0.4 mi');
  assert.equal(distance(42.3), '26 mi');
  as('en', 'en-GB');
  assert.equal(distance(10), '6.2 mi');
  as('en', 'de-DE');
  assert.equal(distance(42.3), '42 km');
  assert.equal(distance(4.26), '4,3 km');
  as('ja', 'ja-JP');
  assert.equal(distance(42.3), '42 km');
  as('ja', 'en-US');
  assert.equal(distance(42.3), '26 mi', 'Japanese screens on an American phone: the region rule is the phone\'s');
  as('zh-Hans', 'zh-CN');
  assert.equal(distance(4.26), '4.3公里');
  as('ar', 'ar-SA');
  assert.equal(distance(10), new Intl.NumberFormat('ar-SA', { style: 'unit', unit: 'kilometer', unitDisplay: 'short', maximumFractionDigits: 0 }).format(10));
});

test('duration: milliseconds, seconds, minutes, and hours with a minute count', () => {
  as('en', 'en-US');
  assert.equal(duration(250), '250 ms');
  assert.equal(duration(1400), '1.4 sec');
  assert.equal(duration(2000), '2.0 sec');
  assert.equal(duration(1400, 'long'), '1.4 seconds');
  // The unit is chosen after rounding: 999.6 ms is a second, 59.96 s a minute, 59.99 min an hour.
  assert.equal(duration(999.4), '999 ms');
  assert.equal(duration(999.6), '1.0 sec');
  assert.equal(duration(59_940), '59.9 sec');
  assert.equal(duration(59_960), '1 min');
  assert.equal(duration(59.94 * 60_000), '59.9 min');
  assert.equal(duration(59.99 * 60_000), typeof (/** @type {any} */ (Intl).DurationFormat) === 'function' ? '1 hr' : '60 min');
  assert.equal(seconds(900, 'long'), '0.9 seconds', 'speech is counted in seconds, however short');
  assert.equal(seconds(1400, 'long'), '1.4 seconds');
  assert.equal(duration(25 * 60_000), '25 min');
  assert.equal(duration(84_000), '1.4 min');
  assert.equal(duration(130 * 60_000), typeof (/** @type {any} */ (Intl).DurationFormat) === 'function' ? '2 hr, 10 min' : '130 min');
  as('de', 'de-DE');
  assert.equal(duration(25 * 60_000), '25 Min.');
  as('ja', 'ja-JP');
  assert.equal(duration(25 * 60_000), '25 分');
  as('zh-Hans', 'zh-CN');
  assert.equal(duration(1400), '1.4秒');
});

test('relTime says "just now" under a minute, "in 1 minute" for a minute ahead, and the units after', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  as('en', 'en-US');
  assert.equal(relTime(now - 10_000, now), 'just now');
  assert.equal(relTime(now, now), 'just now');
  assert.equal(relTime(now - 59_000, now), 'just now');
  assert.equal(relTime(now + 10_000, now), 'in 1 minute', 'never "0 seconds ago" or "now"');
  assert.equal(relTime(now - 60_000, now), '1 minute ago');
  assert.equal(relTime(now - 2 * 3600_000, now), '2 hours ago');
  assert.equal(relTime(now - 86_400_000, now), 'yesterday');
  assert.equal(relTime(now + 5 * 60_000, now), 'in 5 minutes');
  as('de', 'de-DE');
  assert.equal(relTime(now - 2 * 3600_000, now), 'vor 2 Stunden');
  assert.equal(relTime(now + 10_000, now), 'in 1 Minute');
  as('ja', 'ja-JP');
  assert.equal(relTime(now - 2 * 3600_000, now), '2 時間前');
  assert.equal(relTime(now - 10_000, now), 'just now', 'until a translation says it');
  assert.equal(relTime(now + 10_000, now), '1 分後');
});

test('dates: plain days, ranges, instants in a zone, and the zone\'s name', () => {
  as('en', 'en-US');
  assert.equal(day('2026-11-25'), 'Nov 25');
  assert.equal(day('2026-11-25', true), 'Wed, Nov 25');
  assert.equal(dateRange('2026-11-25'), 'Nov 25');
  assert.match(dateRange('2026-11-25', '2026-11-29'), /^Nov 25\s–\s29$/);
  assert.equal(when(AT, LA), 'Nov 25, 2026, 10:30 AM');
  assert.equal(when(AT, LA, { weekday: 'short', hour: 'numeric', minute: '2-digit' }), 'Wed 10:30 AM');
  assert.equal(zone(AT, LA), 'PT');
  assert.equal(zone(AT, 'Asia/Tokyo'), 'Japan Time');
  assert.equal(zone(AT, 'Europe/Paris'), 'France Time');
  as('en', 'en-GB');
  assert.equal(day('2026-11-25', true), 'Wed 25 Nov');
  assert.match(dateRange('2026-11-25', '2026-11-29'), /^25\s?–\s?29 Nov$/);
  assert.equal(when(AT, 'Europe/London'), '25 Nov 2026, 18:30');
  as('en', 'de-DE');
  assert.equal(when(AT, 'Europe/Berlin'), '25 Nov 2026, 19:30');
  as('ja', 'ja-JP');
  assert.equal(day('2026-11-25', true), '11月25日(水)');
  assert.equal(zone(AT, LA), 'ロサンゼルス時間');
  as('zh-Hans', 'zh-CN');
  assert.equal(day('2026-11-25'), '11月25日');
  as('ar', 'ar-EG');
  assert.equal(day('2026-11-25'), new Intl.DateTimeFormat('ar-EG', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, 10, 25)));
});

test('list: "and" and "or" in the language', () => {
  as('en', 'en-US');
  assert.equal(list([]), '');
  assert.equal(list(['a']), 'a');
  assert.equal(list(['a', 'b']), 'a and b');
  assert.equal(list(['a', 'b', 'c']), 'a, b, and c');
  assert.equal(list(['a', 'b', 'c'], 'or'), 'a, b, or c');
  as('en', 'en-GB');
  assert.equal(list(['a', 'b', 'c']), 'a, b and c');
  as('ja', 'ja-JP');
  assert.equal(list(['英語', '中国語', '日本語']), '英語、中国語、日本語');
  as('zh-Hans', 'zh-CN');
  assert.equal(list(['英语', '日语', '法语']), '英语、日语和法语');
});

test('list: a plain list has no "and", only the language\'s separator', () => {
  as('en', 'en-US');
  assert.equal(list(['a', 'b', 'c'], 'plain'), 'a, b, c');
  as('ja', 'ja-JP');
  assert.equal(list(['a', 'b', 'c'], 'plain'), 'a、b、c');
  as('zh-Hans', 'zh-CN');
  assert.equal(list(['a', 'b', 'c'], 'plain'), 'a、b、c');
});

test('languageName: the language\'s name in the screens\' language, annai\'s English where the browser has none', () => {
  as('en', 'en-US');
  assert.equal(languageName('ja'), 'Japanese');
  assert.equal(languageName('fil'), 'Filipino');
  assert.equal(languageName('xx'), 'xx');
  assert.equal(languageName('not a code'), 'not a code');
  as('ja', 'ja-JP');
  assert.equal(languageName('ja'), '日本語');
  assert.equal(languageName('en'), '英語');
  as('zh-Hans', 'zh-CN');
  assert.equal(languageName('ja'), '日语');
});

test('languageName: English screens keep annai\'s own English names, where the browser\'s differ', () => {
  as('en', 'en-US');
  assert.equal(languageName('zh'), 'Chinese (Mandarin)', 'not the browser\'s "Chinese"');
  assert.equal(languageName('bn'), 'Bengali', 'not "Bangla"');
  as('ja', 'ja-JP');
  assert.equal(languageName('zh'), '中国語');
  assert.equal(languageName('bn'), 'ベンガル語');
});

test('sortWords follows the language\'s order', () => {
  as('en', 'en-US');
  assert.deepEqual(['b', 'Z', 'a', 'é'].sort(sortWords), ['a', 'b', 'é', 'Z']);
  as('sv', 'sv-SE');
  assert.deepEqual(['ä', 'z', 'a'].sort(sortWords), ['a', 'z', 'ä'], 'Swedish puts ä after z');
  as('en', 'de-DE');
  assert.deepEqual(['ä', 'z', 'a'].sort(sortWords), ['a', 'ä', 'z']);
});

test('plural\'s # is written the way the other numbers are: the screens\' language with the phone\'s region', () => {
  as('en', 'en-US');
  assert.equal(plural(1200, '# place', '# places'), '1,200 places');
  as('en', 'de-DE');
  assert.equal(plural(1200, '# place', '# places'), '1.200 places');
  assert.equal(plural(1, '# place', '# places'), '1 place');
});

test('sentences side by side: a space in English, as the language joins them in Japanese, the empty left out; the gap alone for a sentence drawn apart', () => {
  assert.equal(sentences('annai isn\'t installed yet.', '', 'Install annai.'), "annai isn't installed yet. Install annai.");
  assert.equal(sentences('', ''), '');
  assert.equal(sentences('Only one.'), 'Only one.');
  assert.equal(sentenceGap(), ' ');
  setWords('ja', { [key('{0} {1}', 'sentences')]: '{0}{1}' });
  assert.equal(sentences('まだです。', '入れてください。', '以上です。'), 'まだです。入れてください。以上です。');
  assert.equal(sentenceGap(), '');
});

test('sentences: a part with no full stop of its own (a plugin\'s error, say) keeps a space after it, so the next sentence never runs into it', () => {
  assert.equal(sentences('annai.foo is not a function', 'Try again.'), 'annai.foo is not a function Try again.');
  setWords('ja', { [key('{0} {1}', 'sentences')]: '{0}{1}' });
  assert.equal(sentences('annai.foo is not a function', '設定 → プラグインでオフにできます。'), 'annai.foo is not a function 設定 → プラグインでオフにできます。');
  assert.equal(sentences('Steps used up.', 'もう一度お試しください。'), 'Steps used up.もう一度お試しください。');
  assert.equal(sentences('止まりました！', '「ok」でした。', '次へ'), '止まりました！「ok」でした。次へ');
});
