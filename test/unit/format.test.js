import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, plural } from '../../src/core/l10n.js';
import {
  locale, num, numField, parseNum, money, size, distance, duration, relTime, day, dateRange, when, zone, list, languageName, sortWords, formatCost,
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
  assert.equal(parseNum('1.234,5'), 1234.5);
  assert.equal(parseNum('1 234,5'), 1234.5);
  as('en', 'de-DE');
  assert.equal(parseNum('1.234,5'), 1234.5);
  for (const bad of ['lots', '1,2,x', '--1', '1..2.', '1,23,45']) assert.ok(Number.isNaN(parseNum(bad)), bad);
  assert.equal(parseNum('1e3'), 1000);
  assert.equal(parseNum(''), 0, 'nothing typed is for the caller to see, as Number("") is');
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
  assert.equal(size(0), '0 byte');
  assert.equal(size(512), '512 byte');
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

test('relTime says "now" within a minute, and the units after', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  as('en', 'en-US');
  assert.equal(relTime(now - 10_000, now), 'now');
  assert.equal(relTime(now - 2 * 3600_000, now), '2 hours ago');
  assert.equal(relTime(now - 86_400_000, now), 'yesterday');
  assert.equal(relTime(now + 5 * 60_000, now), 'in 5 minutes');
  as('de', 'de-DE');
  assert.equal(relTime(now - 2 * 3600_000, now), 'vor 2 Stunden');
  as('ja', 'ja-JP');
  assert.equal(relTime(now - 2 * 3600_000, now), '2 時間前');
  assert.equal(relTime(now - 10_000, now), '今');
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
