import { meters } from './geo.js';

/**
 * Trip simulation (spec §13, §18): a GPS track and a fake clock fed through the same machinery as
 * a real trip. A track comes from an itinerary (a route with stops and their times); a Simulation
 * plays it through sensors of its own (location, visibility, connectivity) into the live engine.
 * Milestone 7 puts a screen on it ("Simulate a trip"); tests step it as fast as it can go, and a
 * person can watch it ten times faster than real time (§18).
 * @typedef {{ name?: string, lat: number, lng: number, arrive?: string, leave?: string }} RoutePoint
 *   a stop has arrive and leave ("HH:MM" on the start's day, at its offset); the first only leaves, the last only
 *   arrives; points without either shape the road
 * @typedef {{ name?: string, start: string, everySec?: number, stillSec?: number, accuracy?: number, endMin?: number,
 *   route: RoutePoint[], marks?: { at: string, kind: 'hide' | 'show' | 'offline' | 'online' }[] }} Itinerary
 *   start: an ISO date-time with an offset; everySec: a fix this often while moving (5); stillSec: while stopped (10);
 *   endMin: how long the track stays at the last stop (30); marks: the phone locked and unlocked, the connection lost and back
 * @typedef {{ lat: number, lng: number, accuracy: number, speed?: number }} TrackFix  speed: none when a recorded point has none
 * @typedef {{ at: number, kind: 'fix', fix: TrackFix } | { at: number, kind: 'hide' | 'show' | 'offline' | 'online' }} TrackEvent
 */

/** Meters in a degree of latitude. */
const DEG = (6_371_000 * Math.PI) / 180;

/** The plugin id a simulation's sensors are registered under: live mode tells them from the phone's. */
export const SIMULATION = 'simulation';

/** The point d meters along a path. @param {{ lat: number, lng: number }[]} path @param {number} d */
function along(path, d) {
  let left = d;
  for (let i = 1; i < path.length; i++) {
    const seg = meters(path[i - 1], path[i]);
    if (left <= seg || i === path.length - 1) {
      const f = seg ? Math.min(1, left / seg) : 1;
      return { lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * f, lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * f };
    }
    left -= seg;
  }
  return { lat: path[0].lat, lng: path[0].lng };
}

/** In time order; at the same moment a mark comes first: the phone is unlocked, then its GPS gives a fix. @param {TrackEvent} a @param {TrackEvent} b */
const byTime = (a, b) => a.at - b.at || (a.kind === 'fix' ? 1 : 0) - (b.kind === 'fix' ? 1 : 0);

/**
 * A track from an itinerary: still at each stop (with a little GPS jitter), and at a steady speed
 * between stops along the route's points. The same itinerary gives the same track every time.
 * @param {Itinerary} it @returns {TrackEvent[]}
 */
export function trackFrom(it) {
  const start = Date.parse(it?.start ?? '');
  const offset = /([zZ]|[+-]\d\d:\d\d)$/.exec(String(it?.start ?? ''))?.[1];
  if (!Number.isFinite(start) || !offset || !/^\d{4}-\d{2}-\d{2}T/.test(it.start)) throw new Error('An itinerary needs a start: an ISO date-time with an offset, like 2026-11-27T08:30:00-08:00.');
  const route = Array.isArray(it.route) ? it.route : [];
  if (route.length < 2) throw new Error('An itinerary needs a route of at least two places.');
  const day = it.start.slice(0, 10);
  /** @param {string | undefined} hhmm @param {string} what */
  const time = (hhmm, what) => {
    const t = Date.parse(`${day}T${hhmm}:00${offset}`);
    if (!/^\d\d:\d\d$/.test(String(hhmm)) || !Number.isFinite(t)) throw new Error(`${what} needs a time like 09:30, not ${JSON.stringify(hhmm)}.`);
    return t;
  };
  const every = (it.everySec ?? 5) * 1000;
  const still = (it.stillSec ?? 10) * 1000;
  const accuracy = it.accuracy ?? 8;
  const stops = route.map((p, i) => ({ p, i })).filter(({ p, i }) => i === 0 || i === route.length - 1 || p.arrive !== undefined || p.leave !== undefined);
  /** @type {TrackEvent[]} */
  const out = [];
  let n = 0;
  const jitter = () => Math.sin(++n * 12.9898) * 3; // ± 3 m, the same every run
  /** @param {{ lat: number, lng: number }} p @param {number} from @param {number} to */
  const stay = (p, from, to) => {
    for (let t = from; t < to; t += still) {
      const dx = jitter();
      const dy = jitter();
      out.push({ at: t, kind: 'fix', fix: { lat: p.lat + dy / DEG, lng: p.lng + dx / (DEG * Math.cos((p.lat * Math.PI) / 180)), accuracy, speed: 0 } });
    }
  };
  let reached = start;
  for (let s = 0; s < stops.length; s++) {
    const { p, i } = stops[s];
    const name = p.name ?? `Stop ${s + 1}`;
    const arrive = s === 0 ? start : time(p.arrive, `${name}'s arrive`);
    if (arrive < reached) throw new Error(`${name} is reached before the drive there ends: check its times.`);
    const last = s === stops.length - 1;
    const leave = last ? arrive + (it.endMin ?? 30) * 60_000 : time(p.leave, `${name}'s leave`);
    if (leave < arrive) throw new Error(`${name} is left before it is reached: check its times.`);
    stay(p, arrive, last ? leave + 1 : leave);
    if (last) break;
    const next = stops[s + 1];
    const reach = time(next.p.arrive, `${next.p.name ?? `Stop ${s + 2}`}'s arrive`);
    if (reach <= leave) throw new Error(`${next.p.name ?? `Stop ${s + 2}`} is reached before the drive there ends: check its times.`);
    const path = route.slice(i, next.i + 1);
    const length = path.slice(1).reduce((sum, q, k) => sum + meters(path[k], q), 0);
    const speed = length / ((reach - leave) / 1000);
    for (let t = leave; t < reach; t += every) out.push({ at: t, kind: 'fix', fix: { ...along(path, speed * ((t - leave) / 1000)), accuracy, speed } });
    reached = reach;
  }
  for (const m of it.marks ?? []) out.push({ at: time(m.at, `The mark ${m.kind}`), kind: m.kind });
  return out.sort(byTime);
}

/**
 * A track from a trip's recorded location points (spec §13: "a recorded … GPS track"). The log keeps
 * a point only after moving (§4.5), so a stop between two points close together a minute or more
 * apart is filled with still fixes; where the track jumps (a kilometre or more after ten minutes or
 * more: the phone was locked, or annai closed) the phone is marked locked, so catch-up runs as it did.
 * @param {{ lat: number, lng: number, at: number, accuracy?: number, speed?: number }[]} points in time order
 * @param {{ stillSec?: number }} [o] @returns {TrackEvent[]}
 */
export function trackFromLog(points, { stillSec = 10 } = {}) {
  if (points.length < 2) throw new Error('That trip has no recorded track yet: live mode records one while it is on.');
  const still = stillSec * 1000;
  /** @type {TrackEvent[]} */
  const out = [];
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    const accuracy = p.accuracy ?? 10;
    out.push({ at: p.at, kind: 'fix', fix: { lat: p.lat, lng: p.lng, accuracy, ...(typeof p.speed === 'number' ? { speed: p.speed } : {}) } });
    const q = points[k + 1];
    if (!q) break;
    const gap = q.at - p.at;
    const d = meters(p, q);
    if (gap > 60_000 && d < 150) {
      for (let t = p.at + still; t < q.at; t += still) out.push({ at: t, kind: 'fix', fix: { lat: p.lat, lng: p.lng, accuracy, speed: 0 } });
    } else if (gap >= 10 * 60_000 && d >= 1000) {
      out.push({ at: p.at + 1000, kind: 'hide' }, { at: q.at - 1000, kind: 'show' });
    }
  }
  return out.sort(byTime);
}

/** A track played through sensors of its own (spec §13, §18). */
export class Simulation {
  /** The connection, as the simulation has it. */
  online = true;
  /** On screen, as the simulation has it. */
  shown = true;
  /** @type {Record<string, ((x: any) => void) | null>} */
  #emit = { location: null, visibility: null, connectivity: null };
  /** @type {(() => void)[]} */
  #offs;

  /** @param {{ registry: import('../registry.js').Registry, track: TrackEvent[] }} c */
  constructor({ registry, track }) {
    this.track = track;
    this.#offs = ['location', 'visibility', 'connectivity'].map((kind) => registry.add(SIMULATION, 'sensor', {
      kind,
      start: (/** @type {(x: any) => void} */ fn) => {
        this.#emit[kind] = fn;
        if (kind === 'connectivity') fn(this.online);
        return () => { if (this.#emit[kind] === fn) this.#emit[kind] = null; };
      },
    }));
  }

  /** Sends one event to its sensor. A fix while the location sensor is off (locked, live mode off) goes nowhere. @param {TrackEvent} e */
  send(e) {
    if (e.kind === 'fix') this.#emit.location?.({ ...e.fix, source: 'sim' });
    else if (e.kind === 'hide' || e.kind === 'show') {
      this.shown = e.kind === 'show';
      this.#emit.visibility?.(this.shown);
    } else {
      this.online = e.kind === 'online';
      this.#emit.connectivity?.(this.online);
    }
  }

  /**
   * As fast as it can go, on a manual clock: each event at its time, settle() after each. signal stops
   * it; gate() is awaited before each event (a pause).
   * @param {import('./clock.js').ManualClock} clock @param {() => Promise<unknown>} [settle]
   * @param {{ from?: number, to?: number, signal?: AbortSignal, gate?: () => Promise<unknown> }} [o]
   */
  async run(clock, settle = async () => {}, { from = -Infinity, to = Infinity, signal, gate } = {}) {
    for (const e of this.track) {
      if (signal?.aborted) return;
      if (e.at < from || e.at > to) continue;
      if (gate) await gate();
      if (signal?.aborted) return;
      await clock.advanceTo(e.at, settle);
      this.send(e);
      await settle();
    }
  }

  /**
   * In real time on a clock: a scaledClock, ten times faster for a person watching (spec §18).
   * @param {import('./clock.js').Clock} clock @param {{ onEnd?: () => void }} [o] @returns {() => void} stops it
   */
  play(clock, { onEnd } = {}) {
    let i = 0;
    /** @type {any} */
    let handle = null;
    const step = () => {
      handle = null;
      while (i < this.track.length && this.track[i].at <= clock.now()) this.send(this.track[i++]);
      if (i >= this.track.length) {
        onEnd?.();
        return;
      }
      handle = clock.set(step, this.track[i].at - clock.now());
    };
    step();
    return () => {
      if (handle !== null) clock.clear(handle);
      i = this.track.length;
    };
  }

  /** Takes its sensors away. */
  dispose() {
    for (const off of this.#offs.splice(0)) off();
  }
}
