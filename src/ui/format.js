import { validZone } from '../core/time.js';
import { TIMINGS } from '../core/backup-auto.js';
import { holdWords, oldHold } from '../core/backup.js';
import { languageSettings, tagOf, NO_LANGUAGE } from '../core/languages.js';
import { t, tc, lang as screensLang, sameLanguage } from '../core/l10n.js';
import { h } from './dom.js';
import { num, money, size, when, relTime, zone, parseNum, numField, sentences } from '../core/intl.js';

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

/** Who wrote a trip's file: you, Shiori or annai (plugins write only to annai's own settings). @param {string} author as stored */
export const authorName = (author) => (author === 'user' ? t`you` : author === 'shiori' ? /* en */ 'Shiori' : 'annai');

/** A cost in USD for people: "free", "$0.0042", "$1.23", or "cost unknown". @param {number | undefined} usd */
export function formatCost(usd) {
  if (usd === undefined || !Number.isFinite(usd)) return t`cost unknown`;
  return usd === 0 ? t`free` : money(usd);
}

/** @type {Record<string, string>} */
const OUTCOMES = {
  ok: t`answered`, auth: t`key rejected`, credit: t`out of credit`, rate: t`too many requests`, overloaded: t`overloaded`,
  context: t`too long for it`, image: t`didn't take the photo`, upload: t`photo upload expired`, blocked: t`doesn't allow web apps`,
  unreachable: t`couldn't connect`, 'bad-request': t`refused the request`, 'not-found': t`unknown model or address`, server: t`provider error`,
  network: t`connection dropped`, timeout: t`too slow to start`, cancelled: t`stopped`, plugin: t`plugin failed`, removed: t`removed`,
  'type-missing': t`its plugin is missing`, off: t`its ability is switched off`, redirect: t`redirected elsewhere`, benched: t`resting after an error`, 'no-images': t`doesn't take photos`, 'no-tools': t`can't use tools`,
  'too-long': t`conversation too long for it`, 'no-provider-tool': t`has no web tool of that kind`, 'not-chat': t`isn't a chat model`, 'no-speech': t`couldn't hear the speech`, 'no-audio': t`doesn't take audio`,
};

/** What happened to one model in a role call, in a few words (spec §9.6). @param {string} outcome */
export function outcomeText(outcome) {
  return OUTCOMES[outcome] ?? outcome;
}

/** The address of a file in a trip; from, the screen its crumb goes back to (a Plan, a booking, Now), else the trip. @param {string} id @param {string} path @param {string} [from] */
export const fileHref = (id, path, from) => `#/trip/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;

/** The Booking screen for a trip's booking (spec §16.2). @param {string} id @param {string} path "/bookings/…" */
export const bookingHref = (id, path) => `#/trip/${encodeURIComponent(id)}/booking?path=${encodeURIComponent(path)}`;

const BOOKING_KINDS = /** @type {Record<string, string>} */ ({ flight: t`Flight`, lodging: t`Stay`, car: t`Car`, rail: t`Train`, event: t`Event`, restaurant: t`Restaurant`, other: t`Other` });

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
    return t`${when(ms, time.tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${zone(ms, time.tz)})`;
  };
  /** @type {[string, string][]} */
  const lines = [[t`Kind`, BOOKING_KINDS[b.kind] ?? String(b.kind ?? '')]];
  const start = at(b.start);
  if (start) lines.push([tc('booking')`Starts`, start]);
  const end = at(b.end);
  if (end) lines.push([tc('booking')`Ends`, end]);
  if (b.place?.name) lines.push([t`Place`, b.place.address ? tc('booking')`${b.place.name}, ${b.place.address}` : String(b.place.name)]);
  if (b.confirmation) lines.push([t`Confirmation`, String(b.confirmation)]);
  if (b.cost && Number.isFinite(b.cost.amount)) lines.push([t`Cost`, money(b.cost.amount, b.cost.currency)]);
  if (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) {
    for (const [k, v] of Object.entries(b.fields)) lines.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
  return lines;
}

/** A day as YYYY-MM-DD in this device's own zone, not UTC's. @param {number} ms */
export const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A backup place's own screen. @param {string} id */
export const placeHref = (id) => `#/backups/place?id=${encodeURIComponent(id)}`;

/** What a backup's download says it is doing: "Getting files: 120 of 650"; one file (a whole-file place) is no count. @param {{ done: number, total: number } | null} p */
export const gettingFiles = (p) => (p && p.total > 1 ? t`Getting files: ${num(p.done)} of ${num(p.total)}` : t`Getting the backup…`);

/** @type {Record<string, (p: { done: number, total: number }) => string>} */
const PHASES = {
  building: () => t`Getting the backup ready…`,
  checking: (p) => (p.total ? t`Comparing files ${num(p.done)} of ${num(p.total)}…` : t`Comparing files…`),
  uploading: (p) => (p.total ? t`Uploading ${num(p.done)} of ${num(p.total)}…` : t`Uploading…`),
};

/** A newer backup's device, by its label (platform.js's deviceName; "" for any other): a message each. */
const PAUSED_BY = /** @type {Record<string, string>} */ ({
  iPhone: t`Paused: there is a newer backup from an iPhone`, iPad: t`Paused: there is a newer backup from an iPad`,
  'Android phone': t`Paused: there is a newer backup from an Android phone`, computer: t`Paused: there is a newer backup from a computer`,
  '': t`Paused: there is a newer backup from another device`,
});
/** @type {Record<string, (where: string, ago: string) => string>} */
const BACKED_UP_BY = {
  iPhone: (where, ago) => t`An iPhone backed up to ${where} ${ago}.`, iPad: (where, ago) => t`An iPad backed up to ${where} ${ago}.`,
  'Android phone': (where, ago) => t`An Android phone backed up to ${where} ${ago}.`, computer: (where, ago) => t`A computer backed up to ${where} ${ago}.`,
  '': (where, ago) => t`Another device backed up to ${where} ${ago}.`,
};
/** This device, by its noun (deviceName's). */
const THIS_ONE = /** @type {Record<string, { after: string, choice: string }>} */ ({
  phone: { after: t`That was after this phone's last backup.`, choice: t`Import it as a copy to bring its trips here, or back up this phone over it.` },
  iPad: { after: t`That was after this iPad's last backup.`, choice: t`Import it as a copy to bring its trips here, or back up this iPad over it.` },
  computer: { after: t`That was after this computer's last backup.`, choice: t`Import it as a copy to bring its trips here, or back up this computer over it.` },
});
/** @param {Record<string, any>} table @param {string | undefined} name */
const byName = (table, name, none = '') => table[name && Object.hasOwn(table, name) ? name : none];

/** An older hold's English, for a line of its own marked lang="en" under placeStatus's; '' for any other. @param {any} target */
export const holdNote = (target) => (oldHold(target?.hold) ? String(target.hold.message ?? '') : '');

/**
 * A backup place's state in a few words, for its row and its screen (spec §12.4).
 * @param {import('../core/backup-targets.js').Target} target
 * @param {{ phase: string, done: number, total: number } | null} progress @param {number} [now]
 */
export function placeStatus(target, progress, now = Date.now()) {
  if (progress?.phase === 'downloading') return gettingFiles(progress);
  if (progress) return (PHASES[progress.phase] ?? (() => t`Working…`))(progress);
  const h = target.hold;
  if (h?.kind === 'newer') return byName(PAUSED_BY, h.remote.label);
  // Alone, the line has no full stop; a sentence after it gives it one.
  const at = target.last ? relTime(target.last.at, now) : '';
  const last = at ? t`Last backup ${at}.` : t`Not backed up yet.`;
  if (h?.kind === 'large') return sentences(last, t`Waiting for your OK to upload ${size(h.bytes)}`);
  // A hold kept before it said what it was: its English is a line of its own (holdNote).
  if (oldHold(h)) return sentences(last, t`The last try failed.`);
  if (h?.kind === 'error') return sentences(last, t`The last try failed: ${holdWords(h, target.name)}`);
  if (!target.checked) return t`Not set up yet: fill it in, then Save and test`;
  if (target.auto === 'off') return sentences(last, t`Automatic backups are off`);
  return at ? t`Last backup ${at}` : t`Not backed up yet`;
}

/**
 * What the newer backup at a place is, and the user's two choices (spec §12.4: single writer).
 * @param {import('../core/backup-targets.js').Target} target @param {{ where: string, noun: string, tree: boolean }} o @param {number} [now]
 */
export function newerText(target, { where, noun, tree }, now = Date.now()) {
  if (target.hold?.kind !== 'newer') return '';
  const r = target.hold.remote;
  const me = byName(THIS_ONE, noun, 'computer');
  return sentences(byName(BACKED_UP_BY, r.label)(where, relTime(r.at, now)), target.last ? me.after : '',
    t`Automatic backups there are paused, so neither device overwrites the other.`, me.choice, tree ? t`The other backup stays in its history.` : '');
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
  return limit === null ? t`no limit` : size(limit ?? TIMINGS.askAbove);
}

/** Whether the user speaks the screens' language (their Languages, else the phone's): asUser's choice. @param {Record<string, any>} app */
export const speaksScreens = (app) => languageSettings(app, navigator.language).spoken.some((l) => sameLanguage(l.locale, screensLang()));

/**
 * The attributes of someone's own words (the user's, or Shiori's) among annai's: `lang` from the text (none when unsure, so it takes the
 * screens'; empty when theirs would be wrong for it) and `dir="auto"`.
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
