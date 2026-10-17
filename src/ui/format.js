import { validZone } from '../core/time.js';
import { TIMINGS } from '../core/backup-auto.js';
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** @type {[Intl.RelativeTimeFormatUnit, number][]} */
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

/** "2 hours ago", "yesterday", "just now". @param {number} ts @param {number} [now] */
export function relTime(ts, now = Date.now()) {
  const diff = (ts - now) / 1000;
  for (const [unit, sec] of UNITS) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  return 'just now';
}

/** @param {number} n */
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Nov 25 – 29" for plain dates (YYYY-MM-DD), shown as written, with no time-zone shift. @param {string} start @param {string} [end] */
export function dateRange(start, end) {
  const a = new Date(`${start}T00:00:00Z`);
  if (!end) return day.format(a);
  const b = new Date(`${end}T00:00:00Z`);
  return typeof day.formatRange === 'function' ? day.formatRange(a, b) : `${day.format(a)} – ${day.format(b)}`;
}

/**
 * "26 Nov 2026, 19:04": when a photo was taken, as the clock showed where it was taken.
 * @param {string} taken ISO 8601, with or without an offset @param {string} [locale]
 */
export function takenText(taken, locale) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(taken);
  if (!m) return taken;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(at);
}

/**
 * A trip's backup status for its card (spec §4.9, §16.2).
 * @param {{ at: number | null, changed: boolean }} state @param {number} [now]
 */
export function backupText({ at, changed }, now = Date.now()) {
  if (at === null) return 'not backed up';
  return `backed up ${relTime(at, now)}${changed ? ', changed since' : ''}`;
}

/** A cost in USD for people: "free", "$0.0042", "$1.23", or "cost unknown". @param {number | undefined} usd */
export function formatCost(usd) {
  if (usd === undefined || !Number.isFinite(usd)) return 'cost unknown';
  if (usd === 0) return 'free';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** @type {Record<string, string>} */
const OUTCOMES = {
  ok: 'answered', auth: 'key rejected', credit: 'out of credit', rate: 'too many requests', overloaded: 'overloaded',
  context: 'too long for it', image: "didn't take the photo", upload: 'photo upload expired', blocked: "doesn't allow web apps",
  unreachable: "couldn't connect", 'bad-request': 'refused the request', 'not-found': 'unknown model or address', server: 'provider error',
  network: 'connection dropped', timeout: 'too slow to start', cancelled: 'stopped', plugin: 'plugin failed', removed: 'removed',
  'type-missing': 'its plugin is missing', benched: 'resting after an error', 'no-images': "doesn't take photos", 'no-tools': "can't use tools",
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
 * @param {Record<string, any>} b @param {string} locale @returns {[string, string][]}
 */
export function bookingLines(b, locale) {
  /** @param {any} t */
  const when = (t) => {
    const at = Date.parse(t?.at ?? '');
    if (!Number.isFinite(at) || !validZone(t?.tz)) return null;
    return `${new Intl.DateTimeFormat(locale, { timeZone: t.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at)} (${t.tz})`;
  };
  /** @type {[string, string][]} */
  const lines = [['Kind', BOOKING_KINDS[b.kind] ?? String(b.kind ?? '')]];
  const start = when(b.start);
  if (start) lines.push(['Starts', start]);
  const end = when(b.end);
  if (end) lines.push(['Ends', end]);
  if (b.place?.name) lines.push(['Place', [b.place.name, b.place.address].filter(Boolean).join(', ')]);
  if (b.confirmation) lines.push(['Confirmation', String(b.confirmation)]);
  if (b.cost && Number.isFinite(b.cost.amount)) {
    try {
      lines.push(['Cost', new Intl.NumberFormat(locale, { style: 'currency', currency: b.cost.currency }).format(b.cost.amount)]);
    } catch {
      lines.push(['Cost', `${b.cost.amount} ${b.cost.currency}`]);
    }
  }
  if (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) {
    for (const [k, v] of Object.entries(b.fields)) lines.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
  return lines;
}

/** "an iPhone", "an Android phone", "a computer". @param {string} label */
export function withArticle(label) {
  return `${/^(?:[aeiou]|iP)/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** A backup place's own screen. @param {string} id */
export const placeHref = (id) => `#/backups/place?id=${encodeURIComponent(id)}`;

/** @type {Record<string, (of: string) => string>} */
const PHASES = {
  building: () => 'Getting the backup ready…',
  checking: (of) => `Comparing files${of}…`,
  uploading: (of) => `Uploading${of}…`,
  downloading: (of) => `Downloading${of}…`,
};

/**
 * A backup place's state in a few words, for its row and its screen (spec §12.4).
 * @param {import('../core/backup-targets.js').Target} t
 * @param {{ phase: string, done: number, total: number } | null} progress @param {number} [now]
 */
export function placeStatus(t, progress, now = Date.now()) {
  if (progress) return (PHASES[progress.phase] ?? (() => 'Working…'))(progress.total ? ` ${progress.done} of ${progress.total}` : '');
  const h = t.hold;
  const when = t.last ? `Last backup ${relTime(t.last.at, now)}` : 'Not backed up yet';
  if (h?.kind === 'newer') return `Paused: there is a newer backup from ${h.remote.label ? withArticle(h.remote.label) : 'another device'}`;
  if (h?.kind === 'large') return `${when}. Waiting for your OK to upload ${bytes(h.bytes)}`;
  if (h?.kind === 'error') return `${when}. The last try failed: ${h.message}`;
  if (!t.checked) return 'Not set up yet: fill it in, then Save and test';
  return t.auto === 'off' ? `${when}. Automatic backups are off` : when;
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
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * MIB) : undefined;
}

/** The limit as its field shows it, in megabytes: annai's own when unset, empty for none. @param {number | null | undefined} limit */
export function limitField(limit) {
  if (limit === null) return '';
  return String(Math.round(((limit ?? TIMINGS.askAbove) / MIB) * 10) / 10);
}

/** The limit in words. @param {number | null | undefined} limit */
export function limitText(limit) {
  return limit === null ? 'no limit' : bytes(limit ?? TIMINGS.askAbove);
}
