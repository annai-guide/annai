import { validZone, dayIn, instantAt } from '../core/time.js';
import { checkOf, there, written, TOP } from '../core/bookings.js';
import { BOOKING_FILE, PLAN_FILE, record, kindWord, CARRIERS } from '../core/plan.js';
import { isGivenFile } from '../core/paths.js';
import { TIMINGS } from '../core/backup-auto.js';
import { holdWords, oldHold } from '../core/backup.js';
import { languageSettings, tagOf, NO_LANGUAGE } from '../core/languages.js';
import { t, tc, plural, lang as screensLang, sameLanguage } from '../core/l10n.js';
import { h } from './dom.js';
import { num, money, size, when, relTime, zone, parseNum, numField, sentences, list, day } from '../core/intl.js';

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
  'too-long': t`conversation too long for it`, 'no-provider-tool': t`has no web tool of that kind`, 'not-chat': t`isn't a chat model`, 'no-speech': t`speech couldn't reach it`, 'no-audio': t`doesn't take audio`,
};

/** What happened to one model in a role call, in a few words (spec §9.6). @param {string} outcome */
export function outcomeText(outcome) {
  return OUTCOMES[outcome] ?? outcome;
}

/** The address of a file in a trip; from, the screen its crumb goes back to (a Plan, a booking), else the trip. @param {string} id @param {string} path @param {string} [from] */
export const fileHref = (id, path, from) => `#/trip/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
/** A trip's conversation. @param {string} id */
export const talkHref = (id) => `#/trip/${encodeURIComponent(id)}/talk`;

/**
 * A trip file's or booking's details; `from` is the screen its crumb goes back to (the trip, the Plan, the Conversation, a plan
 * item's details), else the trip. @param {string} id @param {string} path "/files/…" or "/bookings/…" @param {string} [from]
 */
export const bookingHref = (id, path, from) => `#/trip/${encodeURIComponent(id)}/booking?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
/** A plan item's details. @param {string} id @param {string} path "/plan/…" @param {string} [from] as bookingHref's */
export const itemHref = (id, path, from) => `#/trip/${encodeURIComponent(id)}/item?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
/**
 * Where a link to a trip's file goes: a file the user gave (/files/x) or a booking opens the details screen, a plan item its details, never
 * the raw form; any other file, its own screen. @param {string} id @param {string} path in the trip @param {string} [from]
 */
export const recordHref = (id, path, from) => (BOOKING_FILE.test(path) || isGivenFile(path) ? bookingHref(id, path, from) : PLAN_FILE.test(path) ? itemHref(id, path, from) : fileHref(id, path, from));
/**
 * What a tap on a Plan row opens (the bookings-and-trips design, goal 6): its booking's details when it is or stands for one, else the
 * plan item's; never the raw file. @param {string} id @param {import('../core/plan.js').PlanRow} r @param {string} [from]
 */
export const detailsHref = (id, r, from) => (r.booking && r.bookingPath ? bookingHref(id, r.bookingPath, from) : itemHref(id, r.path, from));
/**
 * A Plan row's name: a set's start and end say what they are: a stay's Check in and Check out, a
 * car's Pick up and Return, the Arrive of a flight, a train or a ride (CARRIERS), anything else's Ends. @param {import('../core/plan.js').PlanRow} r
 */
export function rowName(r) {
  const name = String(r.item.title ?? r.path);
  const kind = r.set?.kind;
  if (r.set?.part === 'end') return kind === 'lodging' ? t`Check out · ${name}` : kind === 'car' ? t`Return · ${name}` : CARRIERS.has(kind ?? '') ? t`Arrive · ${name}` : t`Ends · ${name}`;
  if (r.set?.part === 'start') return kind === 'lodging' ? t`Check in · ${name}` : kind === 'car' ? t`Pick up · ${name}` : name;
  return name;
}

/**
 * What a timetable row says of what can move, from its item's fixed (planRows): ● and "Fixed:" for a plan item stored as fixed, ○ and
 * "Flexible:" for one stored as not, and nothing for a row nobody said anything of (a booking's own row: null), the way Koe's view says
 * nothing. `word` is for a screen reader; `mark` stays an empty mark, which keeps the row's columns. @param {unknown} fixed
 */
export function constraintOf(fixed) {
  if (fixed === true) return { cls: 'fixed', mark: '●', word: t`Fixed:` };
  if (fixed === false) return { cls: 'flexible', mark: '○', word: t`Flexible:` };
  return { cls: '', mark: '', word: '' };
}

/** A set's quiet line: "Staying at Hotel · night 2 of 4", "Car · day 3 of 8". @param {import('../core/plan.js').PlanRow} r */
export function lineName(r) {
  const name = String(r.item.title ?? '');
  const n = num(r.line?.n ?? 0);
  const of = num(r.line?.of ?? 0);
  return r.set?.kind === 'lodging' ? t`Staying at ${name} · night ${n} of ${of}` : t`${name} · day ${n} of ${of}`;
}

/**
 * A booking's kind in words, and a plan item's: a name for every kind the one table of kind words gives (KINDS, src/core/plan.js), so a
 * kind Shiori writes for an item shows in the screens' language: "ferry", "bus", "coach" and "meal" have a name of their own.
 */
export const BOOKING_KINDS = /** @type {Record<string, string>} */ ({
  flight: t`Flight`, lodging: t`Stay`, car: t`Car`, rail: t`Train`, event: t`Event`, restaurant: t`Restaurant`, other: t`Other`,
  ferry: t`Ferry`, bus: t`Bus`, coach: t`Coach`, meal: t`Meal`,
});

/**
 * A plan item's kind in the screens' language, the word read by the table every reader takes (kindWord: "Ferry" and " bus " are a ferry
 * and a bus, "plane" a flight); undefined for a word annai has no name for. @param {string} kind
 * @returns {string | undefined}
 */
export function kindName(kind) {
  const k = kindWord(kind);
  return k === undefined ? undefined : BOOKING_KINDS[k];
}

/** How many of a kind of booking, by its kind. */
const COUNTS = /** @type {Record<string, (n: number) => string>} */ ({
  flight: (n) => plural(n, '# flight', '# flights'), lodging: (n) => plural(n, '# stay', '# stays'), car: (n) => plural(n, '# car', '# cars'),
  rail: (n) => plural(n, '# train', '# trains'), event: (n) => plural(n, '# event', '# events'), restaurant: (n) => plural(n, '# restaurant', '# restaurants'),
  other: (n) => plural(n, '# booking', '# bookings'),
});

/**
 * A Files row's second line, from what the file became: one booking by its kind and day ("Stay · Nov 20"), several of one kind by their
 * count and days ("2 flights · Nov 20, Nov 27"), of different kinds by their counts ("1 flight · 1 stay"), plan items from a calendar, or
 * that it waits for Shiori, or holds nothing yet. @param {import('../core/trip-files.js').Became[]} became
 */
export function fileLine(became) {
  const books = became.filter((b) => b.kind === 'booking');
  /** @type {string[]} */
  const parts = [];
  if (books.length === 1) {
    const b = books[0];
    parts.push([b.bookingKind !== 'other' && BOOKING_KINDS[b.bookingKind] ? BOOKING_KINDS[b.bookingKind] : t`Booking`, b.day ? day(b.day) : null].filter(Boolean).join(' · '));
  } else if (books.length) {
    /** @type {Map<string, number>} */
    const kinds = new Map();
    for (const b of books) {
      const k = b.bookingKind in COUNTS ? b.bookingKind : 'other';
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const days = [...new Set(books.map((b) => b.day).filter((d) => typeof d === 'string'))].sort();
    parts.push([...kinds].map(([k, n]) => COUNTS[k](n)).join(' · ') + (kinds.size === 1 && days.length ? ` · ${list(days.map((d) => day(d)), 'plain')}` : ''));
  }
  if (became.some((b) => b.kind === 'plan')) parts.push(t`Itinerary items from a calendar`);
  if (!parts.length) parts.push(became[0]?.kind === 'waiting' ? t`Waiting for Shiori to read it` : became[0]?.kind === 'nothing' ? t`Nothing yet` : '');
  return parts.join(' · ');
}

/**
 * Words for the keys Shiori writes most in a booking's `fields`, and for those annai files there itself (bookings.js EXTRAS and `dropoff`),
 * but not `arrival` (where an arrival ends, a place: bookings.js files it) nor `total` and `price` (a cost she gave in words): they and
 * any other key are shown as written. The same keys as Shiori's words for a booking's parts (bookings.js partWords), so what she asks
 * about has a line by that name.
 */
export const FIELD_WORDS = /** @type {Record<string, string>} */ ({
  flight: tc('booking')`Flight`, airline: t`Airline`, from: tc('booking')`From`, to: tc('booking')`To`, seat: t`Seat`, class: tc('booking')`Cabin`,
  travellers: t`Travellers`, bags: t`Bags`, terminal: t`Terminal`, gate: t`Gate`, room: tc('booking')`Room`, guests: t`Guests`, nights: t`Nights`,
  pickup: t`Pick-up`, dropoff: t`Drop-off`, train: tc('booking')`Train`, car: tc('booking')`Car`, party: t`Party size`, notes: t`Notes`,
  phone: t`Phone number`, passengers: t`Passengers`, company: t`Company`, flights: tc('booking')`Flights`,
});

/** A key's words where the booking's kind says another thing than FIELD_WORDS: a rental's `car` is its model, a train's is its coach; on any other kind it is a car. */
const KIND_FIELD_WORDS = /** @type {Record<string, Record<string, string>>} */ ({ car: { car: tc('rental')`Car` }, rail: { car: tc('train')`Car` } });

/** Each kind's facts in the order a person checks them; then any other field, as written. */
const ORDER = /** @type {Record<string, string[]>} */ ({
  flight: ['route', 'start', 'end', 'place', 'flight', 'airline', 'seat', 'travellers', 'bags', 'confirmation', 'cost'],
  lodging: ['place', 'start', 'end', 'nights', 'room', 'guests', 'confirmation', 'cost'],
});
const OTHER = ['start', 'end', 'place', 'confirmation', 'cost'];

/**
 * What a booking says, as labelled facts for its details (the bookings-and-trips design, goal 6), in the order a person checks them for
 * its kind: times in their own zone, named (else the trip's, when given), and `unsure` on each field Shiori isn't sure of (checkOf).
 * zone: a time's zone words, within value, which a screen keeps on one line.
 * @param {any} b @param {{ fallbackTz?: string }} [o]
 * @returns {{ key: string, label: string, value: string, lang?: 'en', unsure: boolean, zone?: string }[]}
 */
export function bookingFacts(b, o = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return [];
  const fields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields) ? b.fields : {};
  const marked = new Set(checkOf(b).fields);
  // A detail drawn is a value that is there, as checkOf marks them: a null or a blank is no line ("null" is never words).
  const has = (/** @type {string} */ k) => Object.hasOwn(fields, k) && there(fields[k]);
  /** A route's part: text that is there (any other shape of from or to is a detail of its own). */
  const words = (/** @type {unknown} */ x) => typeof x === 'string' && there(x);
  const labelOf = (/** @type {string} */ k) => KIND_FIELD_WORDS[b.kind]?.[k] ?? FIELD_WORDS[k];
  /** @param {any} time */
  const at = (time) => {
    const tz = validZone(time?.tz) ? time.tz : o.fallbackTz;
    const ms = tz ? instantAt(time?.at, tz) : NaN;
    if (!Number.isFinite(ms) || !tz) return null;
    return { value: t`${when(ms, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${zone(ms, tz)})`, zone: zone(ms, tz) };
  };
  /**
   * The words of a key of a list's object or of `fields`: annai's where it has them (FIELD_WORDS), else the key as written.
   * @param {string} k
   */
  const keyWords = (k) => (Object.hasOwn(FIELD_WORDS, k) ? labelOf(k) : k);
  /**
   * A flight leg's two times, drawn as they are written, with no zone looked up or guessed: an itinerary prints each airport's own clock, a
   * leg's `tz` is one zone for two airports, and a connection can be in a third. Each is its day and its 24-hour clock from its text
   * (`written`, the reading a write is accepted by), or the text itself when it is no time or a UTC one (that clock is not the airport's).
   * One day and a later clock is a range, "Nov 20 08:00–11:30", its dash held to the clock after it (U+2060, so a line can't break
   * between them); anything else, each in full, joined by " – ". @param {unknown} leaves @param {unknown} arrives
   */
  const times = (leaves, arrives) => {
    // A side that is a time with no Z: its day and clock from its own text; null when it is none, or a UTC one, and it is then drawn as written.
    const read = (/** @type {unknown} */ v) => {
      const r = record(v);
      const w = written(r ? r.at ?? r.time : v);
      return w && w.m[5] !== 'Z' ? { day: w.m[1], clock: `${w.m[2]}:${w.m[3]}` } : null;
    };
    const [p, q] = [read(leaves), read(arrives)];
    const full = (/** @type {unknown} */ v, /** @type {ReturnType<typeof read>} */ w) => (v === undefined ? '' : w ? `${day(w.day)} ${w.clock}` : valueText(v));
    if (p && q && p.day === q.day && q.clock > p.clock) return `${full(leaves, p)}–\u2060${q.clock}`;
    return [full(leaves, p), full(arrives, q)].filter(Boolean).join(' – ');
  };
  // A label and its value inside a line: a full-width colon with no space on Japanese and Chinese screens (ja-style, zh-style; the
  // catalog's own "{0}：{1}" rows), ": " elsewhere.
  const colon = () => (/^(ja|zh)(-|$)/.test(screensLang()) ? '：' : ': ');
  /**
   * One object, alone or in a list, as one line of the values it has: a flight leg is its number, its route (origin → destination) and its
   * times (departure, arrival: `times`); every other value follows with its label (`keyWords`), as written; nothing that is null or blank.
   * A leg's `tz` is left out when it has times (it is their zone, which they don't name) and drawn when it has none. @param {Record<string, any>} x
   */
  const line = (x) => {
    const used = new Set();
    const pick = (/** @type {string[]} */ names) => {
      const k = names.find((n) => there(x[n]));
      if (k !== undefined) used.add(k);
      return k === undefined ? undefined : x[k];
    };
    const [number, from, to, leaves, arrives] = [pick(['flight']), pick(['origin', 'from']), pick(['destination', 'to']), pick(['departure', 'depart']), pick(['arrival', 'arrive'])];
    if (leaves !== undefined || arrives !== undefined) used.add('tz');
    const rest = Object.entries(x).filter(([k, v]) => !used.has(k) && there(v)).map(([k, v]) => `${keyWords(k)}${colon()}${valueText(v)}`);
    return [number === undefined ? '' : valueText(number), [from, to].filter(there).map(valueText).join(' → '), times(leaves, arrives), ...rest].filter(Boolean).join(' · ');
  };
  /**
   * A field's value in words, as written and never as JSON: the items of a list that are there, joined (a list with an object in it is one
   * line each, `line`), an object as one line, anything else as text. @param {unknown} v @returns {string}
   */
  const valueText = (v) => {
    if (Array.isArray(v)) {
      const items = v.filter(there);
      return items.some(record) ? items.map((x) => valueText(x)).join('\n') : list(items.map((x) => valueText(x)));
    }
    const r = record(v);
    if (r) return line(r);
    return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  };
  const stay = b.kind === 'lodging';
  const flight = b.kind === 'flight';
  /** @type {Record<string, () => { label: string, value: string | null, unsure?: boolean, zone?: string } | null>} */
  const own = {
    route: () => ({ label: tc('flight')`Route`, value: [fields.from, fields.to].filter(words).join(' → ') || null, unsure: marked.has('from') || marked.has('to') }),
    start: () => ({ label: flight ? t`Departs` : stay ? t`Check-in` : tc('booking')`Starts`, ...(at(b.start) ?? { value: null }) }),
    end: () => ({ label: flight ? t`Arrives` : stay ? t`Check-out` : tc('booking')`Ends`, ...(at(b.end) ?? { value: null }) }),
    // Its name and address, each that is there; an address that is only a copy of the name (annai names a place from its address) once.
    place: () => {
      const [name, address] = [b.place?.name, b.place?.address].map((x) => (there(x) ? String(x) : ''));
      return { label: t`Place`, value: name && address && name !== address ? tc('booking')`${name}, ${address}` : name || address || null };
    },
    nights: () => {
      if (has('nights')) return null; // hers, among the fields
      const tz = (/** @type {any} */ x) => (validZone(x?.tz) ? x.tz : null);
      if (!tz(b.start) || !tz(b.end)) return null;
      const from = instantAt(b.start.at, tz(b.start));
      const to = instantAt(b.end.at, tz(b.end));
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
      const days = Math.round((Date.parse(`${dayIn(to, tz(b.end))}T00:00:00Z`) - Date.parse(`${dayIn(from, tz(b.start))}T00:00:00Z`)) / 86_400_000);
      return days > 0 ? { label: t`Nights`, value: num(days) } : null;
    },
    confirmation: () => ({ label: t`Confirmation`, value: there(b.confirmation) ? String(b.confirmation) : null }),
    cost: () => ({ label: t`Cost`, value: b.cost && Number.isFinite(b.cost.amount) ? money(b.cost.amount, b.cost.currency) : null }),
  };
  /** @type {ReturnType<typeof bookingFacts>} */
  const out = [];
  // A flight's from and to in words are its route; anything else stays a field of its own, so nothing she wrote goes unseen.
  const shown = new Set(flight ? ['from', 'to'].filter((k) => typeof fields[k] === 'string' && fields[k]) : []);
  for (const key of (Object.hasOwn(ORDER, b.kind) ? ORDER[b.kind] : OTHER)) {
    if (Object.hasOwn(own, key)) {
      const f = own[key]();
      if (f?.value) {
        out.push({ key, label: f.label, value: f.value, unsure: f.unsure ?? marked.has(key), ...(f.zone ? { zone: f.zone } : {}) });
        if (TOP.includes(key)) shown.add(key); // a part of its own that drew: its field, if one is named like it, is the same part, not a second line
      } else if (f && TOP.includes(key) && has(key)) {
        // A part that drew nothing (the booking has none, or one that can't be drawn) and a field named like it (a real model wrote fields.place): the field is its line, as written, under its label.
        shown.add(key);
        out.push({ key, label: f.label, value: valueText(fields[key]), unsure: marked.has(key) });
      }
      if (key !== 'nights' || !has('nights')) continue;
    }
    if (!has(key)) continue;
    shown.add(key);
    out.push({ key, label: labelOf(key), value: valueText(fields[key]), unsure: marked.has(key) });
  }
  for (const [key, v] of Object.entries(fields)) {
    if (shown.has(key) || !there(v)) continue;
    const words = Object.hasOwn(FIELD_WORDS, key) ? labelOf(key) : null;
    out.push({ key, label: words ?? key, value: valueText(v), ...(words ? {} : { lang: /** @type {const} */ ('en') }), unsure: marked.has(key) });
  }
  return out;
}

/** The checks a booking's details draw: one by each fact bookingFacts marks, and its name's. The Plan's chip counts these, so it says what the details show. @param {any} b @param {{ fallbackTz?: string }} [o] */
export const checkCount = (b, o) => (checkOf(b).fields.includes('title') && typeof b.title === 'string' && b.title.trim() ? 1 : 0) + bookingFacts(b, o).filter((f) => f.unsure).length;

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
