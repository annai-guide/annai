import { segmentsOf, thin, positionAt, fractionAt, fit } from './route.js';
import { stampCount } from './stamps.js';
import { instantOf, timeIn } from '../time.js';
import { kmText, span } from '../live/geo.js';

/**
 * The replay (spec §13) of a journey or one of its days, for the screen to draw: the route as drawn
 * (thinned, on a flat map), its entries, the route in words for anyone who can't see it (§16.5), and
 * what was so at any moment of the playback.
 * @typedef {import('./journey.js').Journey} Journey
 * @typedef {import('./journey.js').Entry} Entry
 * @typedef {import('./route.js').Point} Point
 * @typedef {{ day: string | null, tz: string, from: number, to: number, segments: Point[][], lengths: number[], map: ReturnType<typeof fit>,
 *   entries: Entry[], stamps: import('./stamps.js').Stamp[], km: number, words: string }} Replay
 *   lengths: each drawn piece's length on the map
 * @typedef {{ xy: [number, number] | null, index: number, where: string, stamps: number, done: number[] }} Moment
 *   index: the entry last reached (-1: none yet); done: how much of each piece is behind, on the map
 */

/** Playback speeds: trip time a second, and their words (choice 5). */
export const PLAY_SPEEDS = Object.freeze(/** @type {[number, string][]} */ ([[60, '1 minute a second'], [600, '10 minutes a second'], [3600, '1 hour a second']]));

/** When a day begins and ends in a zone. @param {string} day "YYYY-MM-DD" @param {string} tz */
export function dayBounds(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { from: instantOf({ year: y, month: m, day: d }, tz), to: instantOf({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, tz) };
}

/** Distance on the map. @param {ReturnType<typeof fit>} map */
const onMap = (map) => (/** @type {Point} */ a, /** @type {Point} */ b) => {
  const [x1, y1] = map.xy(a);
  const [x2, y2] = map.xy(b);
  return Math.hypot(x2 - x1, y2 - y1);
};

/**
 * @param {Journey} j @param {string | null} [day] one of j.days; null: the whole trip
 * @returns {Replay | null} null when nothing was recorded then
 */
export function replayOf(j, day = null) {
  const b = day ? dayBounds(day, j.tz) : null;
  const inside = (/** @type {number} */ t) => !b || (t >= b.from && t < b.to);
  const points = b ? j.points.filter((p) => inside(p.at)) : j.points;
  const entries = j.entries.filter((e) => inside(e.at));
  if (!points.length && !entries.length) return null;
  const times = [...entries.flatMap((e) => ('to' in e ? [e.at, e.to] : [e.at])), ...(points.length ? [points[0].at, points[points.length - 1].at] : [])];
  const segments = thin(segmentsOf(points));
  const map = fit(segments.flat());
  const dist = onMap(map);
  const lengths = segments.map((s) => s.slice(1).reduce((n, p, i) => n + dist(s[i], p), 0));
  const km = Math.round(entries.reduce((n, e) => n + (e.kind === 'move' ? e.km : 0), 0) * 10) / 10;
  const stamps = j.stamps.filter((s) => inside(s.at));
  return { day, tz: j.tz, from: Math.min(...times), to: Math.max(...times), segments, lengths, map, entries, stamps, km, words: routeWords({ entries, km, stamps }) };
}

/**
 * The route in words (spec §16.5: it must make sense without seeing it): how far, from where to
 * where, with how many stops and stamps. @param {{ entries: Entry[], km: number, stamps: unknown[] }} r
 */
export function routeWords({ entries, km, stamps }) {
  const stays = /** @type {Extract<Entry, { kind: 'stay' }>[]} */ (entries.filter((e) => e.kind === 'stay'));
  const named = stays.filter((e) => e.name);
  const first = named[0]?.name;
  const last = named[named.length - 1]?.name;
  const tail = `with ${stays.length} ${stays.length === 1 ? 'stop' : 'stops'} and ${stampCount(stamps.length)}.`;
  if (!km) return `No road was recorded, ${tail}`;
  return `${kmText(km * 1000)} on the road${first ? `, from ${first}` : ''}${last && last !== first ? ` to ${last}` : ''}, ${tail}`;
}

/** What was so at t. @param {Replay} r @param {number} t @returns {Moment} */
export function momentAt(r, t) {
  let index = -1;
  for (let lo = 0, hi = r.entries.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    if (r.entries[mid].at <= t) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  /** @type {any} */
  const stay = r.entries.find((e) => e.kind === 'stay' && t >= e.at && t <= e.to);
  /** @type {any} */
  const move = stay ? null : r.entries.find((e) => e.kind === 'move' && t >= e.at && t <= e.to);
  /** @type {any} */
  let prev = null;
  for (let i = index; i >= 0 && !prev; i--) if (r.entries[i].kind === 'stay' && /** @type {any} */ (r.entries[i]).name) prev = r.entries[i];
  const where = stay ? (stay.name ? `At ${stay.name}` : 'Stopped')
    : move ? `${move.mode === 'walk' ? 'Walking' : 'Driving'}${prev ? ` from ${prev.name}` : ''}`
      : t < r.from || index < 0 ? 'Not started yet'
        : prev ? `After ${prev.name}` : 'On the way';
  const pos = positionAt(r.segments, t);
  const dist = onMap(r.map);
  return { xy: pos ? r.map.xy(pos) : null, index, where, stamps: r.stamps.filter((s) => s.at <= t).length, done: r.segments.map((s, i) => fractionAt(s, t, dist) * r.lengths[i]) };
}

/** @param {string} s @param {number} n */
const cut = (s, n) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One timeline entry in words: when, and what (choice 6). @param {Entry} e @param {string} tz */
export function entryLine(e, tz) {
  const at = String(timeIn(e.at, tz));
  if (e.kind === 'stay') {
    const stamp = e.stamp ? ' · stamp' : '';
    // An arrival the road shows no stay for (the track ended there): when it came.
    if (e.to <= e.at) return { when: at, text: `${e.name ?? 'A stop'} · arrived${stamp}` };
    return { when: `${at}–${timeIn(e.to, tz)}`, text: `${e.name ?? 'A stop'} · ${span(e.to - e.at)}${stamp}` };
  }
  if (e.kind === 'move') return { when: at, text: `${e.mode === 'walk' ? 'Walked' : 'Drove'} ${kmText(e.km * 1000)} · ${span(e.to - e.at)}${e.gap ? ' (partly unseen: the phone was locked)' : ''}` };
  if (e.kind === 'card') {
    const c = e.card ?? {};
    const words = [c.title, c.text, c.place?.name].find((x) => typeof x === 'string' && x.trim());
    return { when: at, text: `Shiori: ${cut(String(words ?? 'a card'), 120)}` };
  }
  if (e.kind === 'said') return { when: at, text: `You${e.spoken ? ' said' : ''}: ${cut(e.text, 120)}` };
  return { when: at, text: `Photo ${e.path.split('/').pop()}` };
}
