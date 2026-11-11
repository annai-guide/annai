/**
 * Times in a place's own zone (spec §4.4: "an ISO 8601 string with offset, plus an IANA time
 * zone"), with the platform's Intl and no library.
 * @typedef {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} Wall  month 1–12
 */

const DAY = 86_400_000;
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** Whether the platform knows this IANA zone. @param {unknown} tz */
export function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The phone's own zone. */
export function deviceZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();
/** @param {string} tz */
function format(tz) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(tz, f);
  }
  return f;
}

/** The wall clock in tz at an instant. @param {number} ms @param {string} tz @returns {Wall} */
export function wallClock(ms, tz) {
  const p = Object.fromEntries(format(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** Minutes east of UTC in tz at an instant. @param {number} ms @param {string} tz */
export function offsetMinutes(ms, tz) {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** "+01:00", "-08:00", "+05:45". @param {number} minutes */
function offsetText(minutes) {
  const m = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** An instant as ISO 8601 with tz's offset, to the second. @param {number} ms @param {string} tz */
export function isoInZone(ms, tz) {
  const w = wallClock(ms, tz);
  /* en */ return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offsetText(offsetMinutes(ms, tz))}`;
}

/**
 * The instant a wall-clock time in tz names. A time a clock change skips moves on by the gap; a
 * time that happens twice is the first. Assumes no two clock changes within a day of each other.
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number, second?: number }} w @param {string} tz
 */
export function instantOf(w, tz) {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour ?? 0, w.minute ?? 0, w.second ?? 0);
  const offsets = [offsetMinutes(guess - DAY, tz), offsetMinutes(guess + DAY, tz)];
  const valid = offsets.map((o) => guess - o * 60_000).filter((t, i) => offsetMinutes(t, tz) === offsets[i]);
  return valid.length ? Math.min(...valid) : guess - offsets[0] * 60_000;
}

/**
 * A stored time as an instant, the one reading every screen uses: its own offset, or, with none written ("2026-11-20T15:00": the format
 * check asks for one, but an imported trip or a restored version may lack it), its wall clock in tz. NaN when it isn't a time.
 * @param {unknown} at @param {string} tz
 */
export function instantAt(at, tz) {
  if (typeof at !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(at);
  return m ? instantOf({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0) }, tz) : Date.parse(at);
}

/* en */ const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A time in the words both halves read for it (a reminder's: watch_set's result, watch_list, Koe's view), so they can't say one time in two
 * zones: its weekday, date and wall clock where it was written, and that zone as the now block names one: "Fri 2027-03-19 18:00 (GMT-7)".
 * All of it is read from the string itself, never from the phone's zone. Text that isn't such a time comes back as it is.
 * @param {string} at an ISO date-time with its offset
 */
export function dueWords(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:([zZ])|([+-])(\d{2}):(\d{2}))$/.exec(String(at));
  const day = m ? WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : undefined;
  if (!m || !day) return String(at);
  const zone = m[6] || (m[8] === '00' && m[9] === '00') ? 'GMT' : `GMT${m[7]}${Number(m[8])}${m[9] === '00' ? '' : `:${m[9]}`}`;
  return `${day} ${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} (${zone})`;
}

/** @param {string | number} at @returns {number | null} */
function ms(at) {
  const t = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/** The day, "YYYY-MM-DD", of a moment in tz. @param {string | number} at @param {string} tz */
export function dayIn(at, tz) {
  const t = ms(at);
  if (t === null) return null;
  const w = wallClock(t, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The first instant of the day after at, in tz: its midnight, or where a clock change moves it. @param {number} at @param {string} tz */
export function nextDay(at, tz) {
  const w = wallClock(at, tz);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return instantOf({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, tz);
}

/** The time, "HH:MM", of a moment in tz. @param {string | number} at @param {string} tz */
export function timeIn(at, tz) {
  const t = ms(at);
  if (t === null) return null;
  const w = wallClock(t, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}
