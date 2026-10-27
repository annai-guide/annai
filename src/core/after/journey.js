import { pointsOf, legsOf } from './route.js';
import { stampsOf, isArrival } from './stamps.js';
import { meters } from '../live/geo.js';
import { validZone, deviceZone, instantOf, dayIn } from '../time.js';
import { PLAN_FILE } from '../plan.js';
import { storedTexts } from '../agent/log.js';

/**
 * A trip as it went (spec §13), read once from its log and files for the recap and the replay: the
 * road (location points, read by type through the log's index), where the user stayed and how they
 * moved, the stamps, Shiori's cards, the user's words (typed or spoken), and the photos.
 * @typedef {import('./route.js').Point} Point
 * @typedef {import('./route.js').Leg} Leg
 * @typedef {import('./stamps.js').Stamp} Stamp
 * @typedef {{ kind: 'stay', at: number, to: number, lat: number, lng: number, name: string | null, stamp: Stamp | null }
 *   | { kind: 'move', at: number, to: number, km: number, mode: 'drive' | 'walk', gap: boolean }
 *   | { kind: 'card', at: number, card: any, tune?: true }
 *   | { kind: 'said', at: number, text: string, spoken: boolean }
 *   | { kind: 'photo', at: number, path: string, hash: string, type: string, size: number, width: number | null, height: number | null,
 *       place: { lat: number, lng: number } | null }} Entry  a card's tune: a personality tuning's, whose title the screens make
 * @typedef {{ title: string, at: number | null, place: { name: string, lat: number, lng: number } | null, fixed: boolean, visited: boolean }} PlanLine
 * @typedef {{ trip: string, title: string, tz: string, info: any, points: Point[], legs: Leg[], stamps: Stamp[], entries: Entry[],
 *   plan: PlanLine[], from: number | null, to: number | null, days: string[] }} Journey
 *   info: trip.json; from, to: when the first and last thing happened; days: each day something did, in the trip's zone.
 *   A stay whose to is its at is an arrival the road shows no stay for (the track ended there with live mode on).
 */

/** A stay is named by an arrival or a plan place this close (the namer keeps its own reach: the offline pack's 500 m). */
export const NAMED_M = 300;
/** What the journey reads from the log, by type (A6: the log is never walked). */
export const JOURNEY_TYPES = Object.freeze(['location', 'trigger.fired', 'out.show', 'msg.user', 'heard', 'heard.text', 'state']);
const MIN = 60_000;

/** @param {any} p @returns {p is { lat: number, lng: number }} */
const hasPoint = (p) => Boolean(p) && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * When a photo was taken (spec §4.8: ISO 8601, with an offset when the photo records one; without
 * one it is the clock where it was taken, read in the trip's zone). @param {unknown} taken @param {string} tz
 */
export function takenAt(taken, tz) {
  if (typeof taken !== 'string') return null;
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(taken)) {
    const t = Date.parse(taken);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(taken);
  return m ? instantOf({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) }, tz) : null;
}

/**
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, trip: string,
 *   namer?: (p: { lat: number, lng: number }) => { name: string, m: number } | null }} c
 *   namer: names a place where nothing in the trip does (the offline pack's, spec §11.5)
 * @returns {Promise<Journey>}
 */
export async function readJourney({ store, ws, trip, namer = () => null }) {
  const scope = await store.tx(['scopes'], 'readonly', (t) => t.getScope(trip));
  const info = (await ws.readJSON(trip, '/trip.json').catch(() => null)) ?? {};
  /** @type {{ slug: string, item: any }[]} */
  const items = [];
  for (const f of await ws.list(trip, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const item = await ws.readJSON(trip, f.path).catch(() => null);
    if (item && typeof item === 'object' && !Array.isArray(item)) items.push({ slug: f.path.replace(/^\/plan\//, '').replace(/\.json$/, ''), item });
  }
  const tz = [info?.timezones?.[0], ...items.map((x) => x.item.start?.tz), deviceZone()].find(validZone) ?? 'UTC';
  const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: [...JOURNEY_TYPES] }));
  const points = pointsOf(events.filter((e) => e.type === 'location'));
  const fired = events.filter((e) => e.type === 'trigger.fired');
  const stamps = stampsOf(fired, tz);
  const arrivals = fired.filter((e) => isArrival(e.data) && hasPoint(e.data.place) && typeof e.data.place.name === 'string' && e.data.place.name.trim());
  const places = items.map((x) => x.item.place).filter(hasPoint).map((p) => ({ name: String(/** @type {any} */ (p).name ?? ''), lat: p.lat, lng: p.lng })).filter((p) => p.name);
  /** Where a stay was: its arrival's name, else a plan place's, else the namer's. @param {{ lat: number, lng: number, from: number, to: number }} s */
  const nameOf = (s) => {
    const a = arrivals.find((e) => e.ts >= s.from - 15 * MIN && e.ts <= s.to + MIN && meters(e.data.place, s) <= NAMED_M);
    if (a) return String(a.data.place.name).trim();
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const p of places) {
      const d = meters(p, s);
      if (d <= NAMED_M && (!best || d < best.m)) best = { name: p.name, m: d };
    }
    if (best) return best.name;
    try {
      return namer(s)?.name ?? null;
    } catch {
      return null;
    }
  };
  // Live mode turned off after the last point: the last stay lasts until then.
  const lastAt = points.length ? points[points.length - 1].at : Infinity;
  const end = events.find((e) => e.type === 'state' && e.data?.live === 'off' && e.ts > lastAt)?.ts;
  const legs = legsOf(points, end === undefined ? {} : { end });
  /** @type {Entry[]} */
  const entries = [];
  for (const l of legs) {
    if (l.kind === 'move') {
      entries.push({ kind: 'move', at: l.from, to: l.to, km: l.km, mode: l.mode, gap: l.gap });
      continue;
    }
    const name = nameOf(l);
    const day = dayIn(l.from, tz);
    const stamp = name ? stamps.find((x) => x.name.toLowerCase() === name.toLowerCase() && dayIn(x.at, tz) === day) ?? null : null;
    entries.push({ kind: 'stay', at: l.from, to: l.to, lat: l.lat, lng: l.lng, name, stamp });
  }
  // An arrival the road shows no stay for (the track ended there, live mode still on) is still a place of the trip.
  for (const a of arrivals) {
    const covered = entries.some((e) => e.kind === 'stay' && a.ts >= e.at - 15 * MIN && a.ts <= e.to + MIN && meters(a.data.place, e) <= NAMED_M);
    if (covered) continue;
    const name = String(a.data.place.name).trim();
    const day = dayIn(a.ts, tz);
    const stamp = stamps.find((x) => x.name.toLowerCase() === name.toLowerCase() && dayIn(x.at, tz) === day) ?? null;
    entries.push({ kind: 'stay', at: a.ts, to: a.ts, lat: a.data.place.lat, lng: a.data.place.lng, name, stamp });
  }
  /** @type {Map<string, { text: string }>} heard segments whose words come later */
  const waiting = new Map();
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'out.show') {
      if (d.card && typeof d.card === 'object' && !Array.isArray(d.card)) entries.push({ kind: 'card', at: e.ts, card: d.card, ...(d.tune ? { tune: true } : {}) });
    } else if (e.type === 'msg.user') {
      const text = String({ ...d, ...(d.stored ? await storedTexts(store, e) : {}) }.text ?? '').trim();
      if (text) entries.push({ kind: 'said', at: e.ts, text, spoken: false });
    } else if (e.type === 'heard' && !d.dismissed) {
      const said = { kind: /** @type {const} */ ('said'), at: e.ts, text: typeof d.text === 'string' ? d.text.trim() : '', spoken: true };
      entries.push(said);
      if (typeof d.text !== 'string' && typeof d.id === 'string') waiting.set(d.id, said);
    } else if (e.type === 'heard.text') {
      const said = waiting.get(d.of);
      if (said) said.text = String(d.text ?? '').trim();
    }
  }
  for (const f of await ws.list(trip, '/files/')) {
    if (!f.type.startsWith('image/')) continue;
    const m = f.meta ?? {};
    entries.push({
      kind: 'photo', at: takenAt(m.taken, tz) ?? f.created, path: f.path, hash: f.hash, type: f.type, size: f.size,
      width: m.width ?? null, height: m.height ?? null, place: hasPoint(m.place) ? { lat: m.place.lat, lng: m.place.lng } : null,
    });
  }
  const kept = entries.filter((e) => e.kind !== 'said' || e.text).sort((a, b) => a.at - b.at);
  const times = [...kept.flatMap((e) => ('to' in e ? [e.at, e.to] : [e.at])), ...(points.length ? [points[0].at, points[points.length - 1].at] : [])];
  /* en */ return {
    trip, title: scope?.title ?? String(info.title ?? 'Trip'), tz, info, points, legs, stamps, entries: kept,
    plan: items
      .map(({ slug, item }) => {
        const t = Date.parse(item.start?.at ?? '');
        return {
          title: String(item.title ?? slug), at: Number.isFinite(t) ? t : null, fixed: item.fixed === true,
          place: hasPoint(item.place) && item.place.name ? { name: String(item.place.name), lat: item.place.lat, lng: item.place.lng } : null,
          visited: fired.some((e) => e.data?.watch === `plan:${slug}:arrived`),
        };
      })
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)),
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    days: [...new Set(times.map((t) => /** @type {string} */ (dayIn(t, tz))))].sort(),
  };
}
