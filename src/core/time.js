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
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offsetText(offsetMinutes(ms, tz))}`;
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

/** The time, "HH:MM", of a moment in tz. @param {string | number} at @param {string} tz */
export function timeIn(at, tz) {
  const t = ms(at);
  if (t === null) return null;
  const w = wallClock(t, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}
