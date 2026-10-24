import { validZone } from '../core/time.js';
import { TIMINGS } from '../core/backup-auto.js';
import { languageSettings, tagOf, NO_LANGUAGE } from '../core/languages.js';
import { t, lang as screensLang } from '../core/l10n.js';
import { h } from './dom.js';
import { num, money, size, when, relTime, zone, parseNum, numField } from '../core/intl.js';

export * from '../core/intl.js';

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

/**
 * The attributes of someone's own words (the user's, or Shiori's) among annai's: `lang` from the text (none when unsure, so it takes the
 * screens'; empty when the screens' would be wrong for it, under a Chinese, Japanese or Korean interface) and `dir="auto"`.
 * Used as `h('p', { ...say(text), text })`, or `mark(el, say(text))`. @param {Record<string, any>} app the app settings @param {boolean} [byShiori] her lines
 * @returns {(text: string) => { lang: string | undefined, dir: 'auto' }}
 */
export function wording(app, byShiori = false) {
  const settings = languageSettings(app, navigator.language);
  const ui = screensLang();
  return (text) => {
    const tag = tagOf(text, settings, byShiori, ui);
    return { lang: tag === NO_LANGUAGE ? '' : tag || undefined, dir: 'auto' };
  };
}

/** Gives an element the attributes `wording` gave its words, taking away a language it no longer has. @param {HTMLElement} el @param {{ lang?: string, dir: string }} a */
export function mark(el, { lang, dir }) {
  if (lang !== undefined) el.setAttribute('lang', lang);
  else el.removeAttribute('lang');
  el.setAttribute('dir', dir);
}

/** A path for the page: left to right as a whole, its file's name turned by its own letters, so a Hebrew name does not reorder "/notes/". @param {string} path */
export function pathParts(path) {
  const at = path.lastIndexOf('/') + 1;
  return [path.slice(0, at), h('span', { dir: 'auto', text: path.slice(at) })];
}
