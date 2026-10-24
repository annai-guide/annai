// How annai formats for people (localization design, section 4): one set of Intl helpers, each formatter made once per locale.
// The locale is the screens' language with the phone's region (l10n.js): English screens on a German phone format as en-DE.
import { t, locale } from './l10n.js';
import { LANGUAGES } from './languages.js';

export { locale };

/** @type {Map<string, any>} */
const made = new Map();

/** An Intl formatter of this locale, made once. @param {any} Ctor @param {object} [options] */
function make(Ctor, options = {}) {
  const id = `${Ctor.name}|${locale()}|${JSON.stringify(options)}`;
  let f = made.get(id);
  if (!f) made.set(id, f = new Ctor(locale(), options));
  return f;
}

/** A number the way this language writes it. @param {number} n @param {Intl.NumberFormatOptions} [options] */
export const num = (n, options) => make(Intl.NumberFormat, options).format(n);

/** This language's mark of a kind, from how it writes 1,234.5. @param {'group' | 'decimal'} type */
const signOf = (type) => make(Intl.NumberFormat).formatToParts(1234.5).find((p) => p.type === type)?.value ?? '';

/** A number as a field shows it, whole and with this language's decimal sign; empty for none. @param {unknown} n */
export const numField = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(n).replace('.', signOf('decimal')) : '');

/**
 * A number typed by a person: "1,5" in German, "1,500" in English, "1.5" anywhere. The last mark is the decimal sign, unless it
 * is the only one, is the language's group mark and has three digits after it (or the same mark comes again: all are groups).
 * @param {unknown} text @returns {number} NaN when it isn't a number
 */
export function parseNum(text) {
  const s = String(text ?? '').replace(/[\s'’]/g, '');
  const marks = /^[+-]?[\d.,]+$/.test(s) ? s.match(/[.,]/g) : null;
  if (!marks) return Number(s);
  const last = marks.at(-1) ?? '.';
  const at = s.lastIndexOf(last);
  const whole = marks.length > 1 ? marks.every((m) => m === last) : last === signOf('group') && s.length - at === 4;
  if (whole && marks.length > 1 && !/^[+-]?\d{1,3}(?:[.,]\d{3})+$/.test(s)) return NaN; // several marks that are not thousands
  return Number(whole ? s.replace(/[.,]/g, '') : `${s.slice(0, at).replace(/[.,]/g, '')}.${s.slice(at + 1)}`);
}

/**
 * An amount for people: "$1.23", and "$0.0042" below a cent (two significant digits, which Japanese would round to $0.00).
 * @param {number} amount @param {string} [currency] @param {Intl.NumberFormatOptions} [options] to change the digits above a cent
 */
export function money(amount, currency = 'USD', options = {}) {
  try {
    return num(amount, { style: 'currency', currency, ...(amount && Math.abs(amount) < 0.01 ? { maximumSignificantDigits: 2 } : options) });
  } catch {
    return `${amount} ${currency}`; // not a currency code
  }
}

const BYTES = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];
/** "512 byte", "1.5 kB", "5.0 MB", "12 MB": a size in bytes, by 1024s. @param {number} n */
export function size(n) {
  let i = 0;
  let v = n;
  while (v >= 1024 && i < BYTES.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i && v < 10 ? 1 : 0;
  return num(v, { style: 'unit', unit: BYTES[i], unitDisplay: 'short', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const MILES = new Set(['US', 'GB', 'LR', 'MM']);
/** "26 mi" or "42 km": miles where the locale's region uses them. @param {number} km */
export function distance(km) {
  const miles = MILES.has(new Intl.Locale(locale()).maximize().region ?? '');
  const n = miles ? km / 1.609344 : km;
  return num(n, { style: 'unit', unit: miles ? 'mile' : 'kilometer', unitDisplay: 'short', maximumFractionDigits: n < 10 ? 1 : 0 });
}

/**
 * "250 ms", "1.4 sec" (seconds always show a tenth), "25 min", and from an hour "2 hr, 10 min" (Intl.DurationFormat, Safari 16.4; a long time is minutes elsewhere).
 * @param {number} ms @param {'short' | 'long' | 'narrow'} [style]
 */
export function duration(ms, style = 'short') {
  const s = ms / 1000;
  const Durations = /** @type {any} */ (Intl).DurationFormat;
  if (s >= 3600 && typeof Durations === 'function') {
    const m = Math.round(s / 60);
    return make(Durations, { style }).format({ hours: Math.floor(m / 60), minutes: m % 60 });
  }
  const unit = s < 1 ? 'millisecond' : s < 60 ? 'second' : 'minute';
  const digits = unit === 'second' ? 1 : 0;
  return num(unit === 'millisecond' ? ms : unit === 'second' ? s : s / 60, { style: 'unit', unit, unitDisplay: style, minimumFractionDigits: digits, maximumFractionDigits: unit === 'minute' ? 1 : digits });
}

/** @type {[Intl.RelativeTimeFormatUnit, number][]} */
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

/** "2 hours ago", "yesterday", "now". @param {number} ts @param {number} [now] */
export function relTime(ts, now = Date.now()) {
  const diff = (ts - now) / 1000;
  const [unit, sec] = UNITS.find(([, s]) => Math.abs(diff) >= s) ?? ['second', 1];
  return make(Intl.RelativeTimeFormat, { numeric: 'auto' }).format(unit === 'second' ? 0 : Math.round(diff / sec), unit);
}

const PLAIN_DAY = /** @type {Intl.DateTimeFormatOptions} */ ({ month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Nov 25", or "Wed, Nov 25": a plain date (YYYY-MM-DD) as written, with no time-zone shift. @param {string} key @param {boolean} [weekday] */
export const day = (key, weekday = false) => make(Intl.DateTimeFormat, weekday ? { ...PLAIN_DAY, weekday: 'short' } : PLAIN_DAY).format(Date.parse(`${key}T00:00:00Z`));

/** "Nov 25 – 29" for plain dates (YYYY-MM-DD), shown as written, with no time-zone shift. @param {string} start @param {string} [end] */
export function dateRange(start, end) {
  return end ? make(Intl.DateTimeFormat, PLAIN_DAY).formatRange(Date.parse(`${start}T00:00:00Z`), Date.parse(`${end}T00:00:00Z`)) : day(start);
}

/**
 * "Nov 25, 2026, 7:04 PM": an instant on this device's clock, or in a zone. @param {number | Date} at @param {string} [tz]
 * @param {Intl.DateTimeFormatOptions} [options] what to show, the date and the time at medium length when it isn't said
 */
export const when = (at, tz, options = { dateStyle: 'medium', timeStyle: 'short' }) => make(Intl.DateTimeFormat, tz ? { ...options, timeZone: tz } : options).format(at);

/** "Wed, 25 Nov, 10:30": an instant in a zone, on a 24-hour clock, as the Replay and the Simulate clocks show it. @param {number} at @param {string} tz */
export const dayClock = (at, tz) => when(at, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A zone by a name people use at an instant: "PT", "Japan Time", never "America/Los_Angeles". @param {number} at @param {string} tz */
export const zone = (at, tz) => make(Intl.DateTimeFormat, { timeZone: tz, timeZoneName: 'shortGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;

/** "a, b and c" (or "a, b, or c"). @param {string[]} items @param {'and' | 'or'} [kind] */
export const list = (items, kind = 'and') => make(Intl.ListFormat, { type: kind === 'or' ? 'disjunction' : 'conjunction' }).format(items);

/** A language's name in the interface language ("Japanese", "日本語"), annai's English name where the browser has none. @param {string} id */
export function languageName(id) {
  let name;
  try {
    name = make(Intl.DisplayNames, { type: 'language' }).of(id);
  } catch { /* not a code Intl knows */ }
  return name && name !== id ? name : LANGUAGES.find((l) => l.id === id)?.name ?? id;
}

/** For sorting words in this language's order. @param {string} a @param {string} b */
export const sortWords = (a, b) => make(Intl.Collator).compare(a, b);
