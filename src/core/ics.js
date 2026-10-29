import { validZone, instantOf, isoInZone, dayIn, instantAt } from './time.js';
import { t } from './l10n.js';
import { num } from './intl.js';

/**
 * Calendar files (spec §8): importing .ics creates plan items, and the plan exports as .ics.
 * The parts of RFC 5545 that calendars use for events.
 * @typedef {{ at: string, tz: string, allDay?: boolean }} Time
 * @typedef {{ uid: string, summary: string, start: Time | null, end: Time | null, location: string, geo: { lat: number, lng: number } | null,
 *   description: string, repeats: boolean, notes: string[] }} CalendarEvent  notes: what annai had to guess, for the plan item's notes
 */

export const MAX_EVENTS = 500;
export const MAX_ICS_BYTES = 2 * 1024 * 1024;

/** Content lines: a line that starts with a space or a tab continues the one before. @param {string} text */
function unfold(text) {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean);
}

/** "NAME;P=V:value" → its parts, or null for a line without a value. @param {string} line */
function contentLine(line) {
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rest] = line.slice(0, i).split(';');
  /** @type {Record<string, string>} */
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** A TEXT value: \\ \; \, and \n. @param {string} v */
const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
/**
 * A TEXT value on one line: backslashes, ";" and "," escaped, every line break (CRLF, CR or LF) as \n,
 * and other control characters dropped, so nothing in a record can start a line of its own in the file.
 * @param {string} v
 */
const escapeText = (v) => v.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, '\\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

/**
 * DTSTART or DTEND as a time in its zone: the TZID when annai knows it (directly, or through the
 * calendar's own VTIMEZONE), else the default zone, with a note. UTC times are shown in the default zone.
 * @param {{ params: Record<string, string>, value: string }} line @param {string} defaultTz @param {Map<string, string>} zones
 * @returns {{ time: Time, note: string } | null}
 */
function timeOf(line, defaultTz, zones) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(line.value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const w = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(hh ?? 0), minute: Number(mi ?? 0), second: Number(ss ?? 0) };
  const allDay = hh === undefined || line.params.VALUE === 'DATE';
  let tz = defaultTz;
  let note = '';
  const named = line.params.TZID;
  if (named && !z) {
    const mapped = validZone(named) ? named : zones.get(named);
    if (mapped && validZone(mapped)) tz = mapped;
    else note = /* en */ `The calendar's time zone "${named}" isn't one annai knows, so ${defaultTz} was used.`;
  }
  const at = z ? Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) : instantOf(w, tz);
  return { time: { at: isoInZone(at, tz), tz, ...(allDay ? { allDay: true } : {}) }, note };
}

/** A DURATION in ms ("PT1H30M", "P1D", "P2W"), or null. @param {string} v */
function durationMs(v) {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/**
 * The events of an .ics file. Unknown properties and broken lines are skipped; a repeating
 * event gives its first time; cancelled events are left out.
 * @param {string} text @param {{ defaultTz: string }} o @returns {CalendarEvent[]}
 */
export function parseIcs(text, { defaultTz }) {
  const lines = unfold(text).map(contentLine).filter((l) => l !== null);
  /** @type {Map<string, string>} VTIMEZONE TZID → its IANA name */
  const zones = new Map();
  /** @type {string | null} */
  let zone = null;
  for (const l of lines) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VTIMEZONE') zone = '';
    else if (l.name === 'END' && l.value.toUpperCase() === 'VTIMEZONE') zone = null;
    else if (zone !== null && l.name === 'TZID') zone = l.value;
    else if (zone && l.name === 'X-LIC-LOCATION') zones.set(zone, l.value);
  }
  /** @type {CalendarEvent[]} */
  const out = [];
  /** @type {(CalendarEvent & { status: string, duration: number | null }) | null} */
  let ev = null;
  let depth = 0; // components inside an event (alarms) are skipped
  for (const l of lines) {
    if (l.name === 'BEGIN') {
      if (ev) depth++;
      else if (l.value.toUpperCase() === 'VEVENT') ev = { uid: '', summary: '', start: null, end: null, location: '', geo: null, description: '', repeats: false, notes: [], status: '', duration: null };
      continue;
    }
    if (l.name === 'END') {
      if (ev && depth) depth--;
      else if (ev && l.value.toUpperCase() === 'VEVENT') {
        const { status, duration, ...done } = ev;
        if (!done.end && done.start && duration !== null) done.end = { at: isoInZone(Date.parse(done.start.at) + duration, done.start.tz), tz: done.start.tz };
        if (status !== 'CANCELLED') out.push(done);
        if (out.length > MAX_EVENTS) throw new Error(t`This calendar has more than ${num(MAX_EVENTS)} events. Export only the trip's dates from your calendar, and add that file.`);
        ev = null;
      }
      continue;
    }
    if (!ev || depth) continue;
    if (l.name === 'UID') ev.uid = l.value.trim();
    else if (l.name === 'SUMMARY') ev.summary = unescapeText(l.value);
    else if (l.name === 'LOCATION') ev.location = unescapeText(l.value);
    else if (l.name === 'DESCRIPTION') ev.description = unescapeText(l.value);
    else if (l.name === 'STATUS') ev.status = l.value.trim().toUpperCase();
    else if (l.name === 'RRULE') ev.repeats = true;
    else if (l.name === 'DURATION') ev.duration = durationMs(l.value);
    else if (l.name === 'GEO') {
      const [lat, lng] = l.value.split(';').map(Number);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) ev.geo = { lat, lng };
    } else if (l.name === 'DTSTART' || l.name === 'DTEND') {
      const t = timeOf(l, defaultTz, zones);
      if (!t) continue;
      if (l.name === 'DTSTART') ev.start = t.time;
      else ev.end = t.time;
      if (t.note && !ev.notes.includes(t.note)) ev.notes.push(t.note);
    }
  }
  return out;
}

/** FNV-1a, 32 bits, as hex: short and stable. @param {string} s */
function fnv(s) {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(s)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * A plan item for each event, at a path made from its UID, so adding the same file again updates
 * the same items. Calendar events have set times, so they are fixed.
 * @param {CalendarEvent[]} events @returns {{ path: string, item: Record<string, any> }[]}
 */
export function planItems(events) {
  return events.map((e, i) => {
    const key = e.uid || `${e.summary}|${e.start?.at ?? i}`;
    const slug = key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
    const id = `ics-${slug}-${fnv(key)}`;
    // What annai adds to an item is written in English: the plan is the trip's, kept, backed up and read by Shiori as written.
    const notes = [e.description, ...(e.repeats ? [/* en */ 'This repeats in the calendar; only its first time is here.'] : []), ...e.notes].filter(Boolean).join('\n\n');
    /** @type {Record<string, any>} */
    const item = { id, title: e.summary.trim() || /* en */ 'Untitled event', kind: e.start?.allDay ? 'all-day' : 'event', fixed: true };
    if (e.start) item.start = { at: e.start.at, tz: e.start.tz };
    if (e.end) item.end = { at: e.end.at, tz: e.end.tz };
    if (e.location || e.geo) item.place = { name: e.location || /* en */ 'Location', ...(e.geo ?? {}) };
    if (notes) item.notes = notes;
    return { path: /* en */ `/plan/${id}.json`, item };
  });
}

/** A content line folded to 75 octets, never inside a character. @param {string} line */
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** "20261126T220000Z". @param {number} ms */
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * The plan as a calendar file, for the share sheet or a download (spec §8). Times are in UTC,
 * which every calendar shows in the phone's zone; an all-day item is a date in its own zone, and
 * one of several days ends on the day after its last, as calendars write it.
 * Items without a start are left out, and counted.
 * @param {Record<string, any>[]} items @param {{ name: string, tripId: string, now: number }} o
 */
export function planToIcs(items, { name, tripId, now }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//annai//annai.guide//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`];
  let left = 0;
  for (const it of items) {
    // Read as every screen reads a stored time (instantAt): a time with no offset is on its zone's clock.
    const zoneOf = (/** @type {any} */ t) => (validZone(t?.tz) ? t.tz : validZone(it?.start?.tz) ? it.start.tz : 'UTC');
    const start = instantAt(it?.start?.at, zoneOf(it?.start));
    if (!Number.isFinite(start)) {
      left++;
      continue;
    }
    lines.push('BEGIN:VEVENT', /* en */ `UID:${escapeText(`${String(it.id ?? '')}.${tripId}`)}@annai.guide`, `DTSTAMP:${utcStamp(now)}`);
    if (it.kind === 'all-day') {
      const day = (/** @type {any} */ t) => String(dayIn(instantAt(t.at, zoneOf(t)), zoneOf(t))).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${day(it.start)}`);
      if (Number.isFinite(instantAt(it?.end?.at, zoneOf(it?.end))) && day(it.end) > day(it.start)) lines.push(`DTEND;VALUE=DATE:${day(it.end)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(start)}`);
      const end = instantAt(it?.end?.at, zoneOf(it?.end));
      if (Number.isFinite(end) && end >= start) lines.push(`DTEND:${utcStamp(end)}`);
    }
    lines.push(`SUMMARY:${escapeText(String(it.title ?? ''))}`);
    const place = it.place?.name ? [it.place.name, it.place.address].filter(Boolean).join(', ') : '';
    if (place) lines.push(`LOCATION:${escapeText(place)}`);
    if (Number.isFinite(it.place?.lat) && Number.isFinite(it.place?.lng)) lines.push(`GEO:${it.place.lat};${it.place.lng}`);
    if (it.notes) lines.push(`DESCRIPTION:${escapeText(String(it.notes))}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { text: `${lines.map(fold).join('\r\n')}\r\n`, left };
}
