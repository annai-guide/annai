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
