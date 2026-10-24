import { validZone } from '../core/time.js';
import { TIMINGS } from '../core/backup-auto.js';
import { LANGUAGES } from '../core/languages.js';
import { t, lang } from '../core/l10n.js';

// How annai formats for people (localization design, section 4): one set of Intl helpers, each formatter made once per locale.
// The locale is the screens' language with the phone's region: English screens on a German phone format as en-DE.
let seen = '';
let current = 'en-US';
/** @type {Map<string, any>} */
const made = new Map();

/** The formats' locale: the interface language with the phone's region ("en-GB", "en-DE"; "ja" for ja-US, as Intl resolves it). */
export function locale() {
  const phone = globalThis.navigator?.language || 'en-US';
  if (seen !== `${lang()}|${phone}`) {
    seen = `${lang()}|${phone}`;
    try {
      current = new Intl.Locale(lang(), { region: new Intl.Locale(phone).maximize().region }).toString();
    } catch {
      current = lang();
    }
  }
  return current;
}

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
const mark = (type) => make(Intl.NumberFormat).formatToParts(1234.5).find((p) => p.type === type)?.value ?? '';

/** A number as a field shows it, whole and with this language's decimal sign; empty for none. @param {unknown} n */
export const numField = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(n).replace('.', mark('decimal')) : '');

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
  const whole = marks.length > 1 ? marks.every((m) => m === last) : last === mark('group') && s.length - at === 4;
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

/**
 * "26 Nov 2026, 19:04": when a photo was taken, as the clock showed where it was taken.
 * @param {string} taken ISO 8601, with or without an offset
 */
export function takenText(taken) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(taken);
  if (!m) return taken;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return when(at, 'UTC');
}

/**
 * A trip's backup status for its card (spec §4.9, §16.2).
 * @param {{ at: number | null, changed: boolean }} state @param {number} [now]
 */
export function backupText({ at, changed }, now = Date.now()) {
  if (at === null) return t`not backed up`;
  return changed ? t`backed up ${relTime(at, now)}, changed since` : t`backed up ${relTime(at, now)}`;
}

/** A cost in USD for people: "free", "$0.0042", "$1.23", or "cost unknown". @param {number | undefined} usd */
export function formatCost(usd) {
  if (usd === undefined || !Number.isFinite(usd)) return t`cost unknown`;
  return usd === 0 ? t`free` : money(usd);
}

/** @type {Record<string, string>} */
const OUTCOMES = {
  ok: 'answered', auth: 'key rejected', credit: 'out of credit', rate: 'too many requests', overloaded: 'overloaded',
  context: 'too long for it', image: "didn't take the photo", upload: 'photo upload expired', blocked: "doesn't allow web apps",
  unreachable: "couldn't connect", 'bad-request': 'refused the request', 'not-found': 'unknown model or address', server: 'provider error',
  network: 'connection dropped', timeout: 'too slow to start', cancelled: 'stopped', plugin: 'plugin failed', removed: 'removed',
  'type-missing': 'its plugin is missing', off: 'its ability is switched off', redirect: 'redirected elsewhere', benched: 'resting after an error', 'no-images': "doesn't take photos", 'no-tools': "can't use tools",
  'too-long': 'conversation too long for it', 'no-provider-tool': 'has no web tool of that kind', 'not-chat': "isn't a chat model", 'no-speech': "couldn't hear the speech", 'no-audio': "doesn't take audio",
};

/** What happened to one model in a role call, in a few words (spec §9.6). @param {string} outcome */
export function outcomeText(outcome) {
  return OUTCOMES[outcome] ?? outcome;
}

/** The address of a file in a trip. @param {string} id @param {string} path */
export const fileHref = (id, path) => `#/trip/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`;

/** The Booking screen for a trip's booking (spec §16.2). @param {string} id @param {string} path "/bookings/…" */
export const bookingHref = (id, path) => `#/trip/${encodeURIComponent(id)}/booking?path=${encodeURIComponent(path)}`;

const BOOKING_KINDS = /** @type {Record<string, string>} */ ({ flight: 'Flight', lodging: 'Stay', car: 'Car', rail: 'Train', event: 'Event', restaurant: 'Restaurant', other: 'Other' });

/**
 * What a booking says, as label and value lines for the Booking screen (spec §16.2), in the order
 * a person checks them. Times are shown in their own zone, named.
 * @param {Record<string, any>} b @returns {[string, string][]}
 */
export function bookingLines(b) {
  /** @param {any} time */
  const at = (time) => {
    const ms = Date.parse(time?.at ?? '');
    if (!Number.isFinite(ms) || !validZone(time?.tz)) return null;
    return `${when(ms, time.tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${zone(ms, time.tz)})`;
  };
  /** @type {[string, string][]} */
  const lines = [['Kind', BOOKING_KINDS[b.kind] ?? String(b.kind ?? '')]];
  const start = at(b.start);
  if (start) lines.push(['Starts', start]);
  const end = at(b.end);
  if (end) lines.push(['Ends', end]);
  if (b.place?.name) lines.push(['Place', [b.place.name, b.place.address].filter(Boolean).join(', ')]);
  if (b.confirmation) lines.push(['Confirmation', String(b.confirmation)]);
  if (b.cost && Number.isFinite(b.cost.amount)) lines.push(['Cost', money(b.cost.amount, b.cost.currency)]);
  if (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) {
    for (const [k, v] of Object.entries(b.fields)) lines.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
  return lines;
}

/** "an iPhone", "an Android phone", "a computer". @param {string} label */
export function withArticle(label) {
  return `${/^(?:[aeiou]|iP)/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** A day as YYYY-MM-DD in this device's own zone, not UTC's. @param {number} ms */
export const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A backup place's own screen. @param {string} id */
export const placeHref = (id) => `#/backups/place?id=${encodeURIComponent(id)}`;

/** What a backup's download says it is doing: "Getting files: 120 of 650"; one file (a whole-file place) is no count. @param {{ done: number, total: number } | null} p */
export const gettingFiles = (p) => (p && p.total > 1 ? `Getting files: ${num(p.done)} of ${num(p.total)}` : 'Getting the backup…');

/** @type {Record<string, (of: string) => string>} */
const PHASES = {
  building: () => 'Getting the backup ready…',
  checking: (of) => `Comparing files${of}…`,
  uploading: (of) => `Uploading${of}…`,
};

/**
 * A backup place's state in a few words, for its row and its screen (spec §12.4).
 * @param {import('../core/backup-targets.js').Target} t
 * @param {{ phase: string, done: number, total: number } | null} progress @param {number} [now]
 */
export function placeStatus(t, progress, now = Date.now()) {
  if (progress?.phase === 'downloading') return gettingFiles(progress);
  if (progress) return (PHASES[progress.phase] ?? (() => 'Working…'))(progress.total ? ` ${num(progress.done)} of ${num(progress.total)}` : '');
  const h = t.hold;
  const last = t.last ? `Last backup ${relTime(t.last.at, now)}` : 'Not backed up yet';
  if (h?.kind === 'newer') return `Paused: there is a newer backup from ${h.remote.label ? withArticle(h.remote.label) : 'another device'}`;
  if (h?.kind === 'large') return `${last}. Waiting for your OK to upload ${size(h.bytes)}`;
  if (h?.kind === 'error') return `${last}. The last try failed: ${h.message}`;
  if (!t.checked) return 'Not set up yet: fill it in, then Save and test';
  return t.auto === 'off' ? `${last}. Automatic backups are off` : last;
}

/**
 * What the newer backup at a place is, and the user's two choices (spec §12.4: single writer).
 * @param {import('../core/backup-targets.js').Target} t @param {{ where: string, noun: string, tree: boolean }} o @param {number} [now]
 */
export function newerText(t, { where, noun, tree }, now = Date.now()) {
  if (t.hold?.kind !== 'newer') return '';
  const r = t.hold.remote;
  const who = r.label ? withArticle(r.label) : 'another device';
  return `${who[0].toUpperCase()}${who.slice(1)} backed up to ${where} ${relTime(r.at, now)}${t.last ? `, after this ${noun}'s last backup` : ''}. `
    + 'Automatic backups there are paused, so neither device overwrites the other. '
    + `Import it as a copy to bring its trips here, or back up this ${noun} over it${tree ? ' (the other backup stays in its history)' : ''}.`;
}

const MIB = 1024 * 1024;

/**
 * The limit for automatic uploads on a connection the browser doesn't name, as typed in megabytes:
 * bytes, null for none (empty), or undefined when it isn't a number of megabytes.
 * @param {string} text @returns {number | null | undefined}
 */
export function limitFromField(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const n = parseNum(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * MIB) : undefined;
}

/** The limit as its field shows it, in megabytes: annai's own when unset, empty for none. @param {number | null | undefined} limit */
export function limitField(limit) {
  if (limit === null) return '';
  return numField(Math.round(((limit ?? TIMINGS.askAbove) / MIB) * 10) / 10);
}

/** The limit in words. @param {number | null | undefined} limit */
export function limitText(limit) {
  return limit === null ? 'no limit' : size(limit ?? TIMINGS.askAbove);
}
