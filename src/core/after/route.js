import { meters } from '../live/geo.js';

/**
 * The road a trip took, from its location points (spec §4.5, §13): where the user stayed and how
 * they moved between, the track split where it jumps and thinned for drawing, where they were at
 * any moment, and a flat map of it (equirectangular, no tiles). A five-day trip's tens of thousands
 * of points are fine: each step is a pass or a few over them.
 * @typedef {{ lat: number, lng: number, at: number, accuracy?: number, speed?: number }} Point
 * @typedef {{ kind: 'stay', lat: number, lng: number, from: number, to: number }} Stay
 * @typedef {{ kind: 'move', from: number, to: number, km: number, mode: 'drive' | 'walk', gap: boolean }} Move
 *   gap: the track jumps on the way (the phone was locked, annai closed, a flight), so km is what was seen
 * @typedef {Stay | Move} Leg
 */

/** A stay is within this many meters… */
export const STAY_M = 200;
/** …for at least this many minutes (choice 7). */
export const STAY_MIN = 10;
/** The track jumps where two points are this far apart after this long… */
export const JUMP_M = 1000;
export const JUMP_MIN = 10;
/** …or this far apart at any time (a flight). */
export const FAR_M = 20_000;
/** Slower than this on average is walking. */
export const WALK_KMH = 8;
/** At most this many points are drawn (choice 8). */
export const DRAWN = 1500;
const MIN = 60_000;
/** Meters in a degree of latitude. */
const DEG = (6_371_000 * Math.PI) / 180;
/** @param {number} d */
const rad = (d) => (d * Math.PI) / 180;
/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The location points of a log, in time order; an entry that isn't a position is left out. @param {{ ts: number, data?: any }[]} events @returns {Point[]} */
export function pointsOf(events) {
  /** @type {Point[]} */
  const out = [];
  for (const e of events) {
    const d = e?.data;
    if (!d || !finite(d.lat) || !finite(d.lng) || Math.abs(d.lat) > 90 || Math.abs(d.lng) > 180 || !finite(e.ts)) continue;
    out.push({ lat: d.lat, lng: d.lng, at: e.ts, ...(finite(d.accuracy) ? { accuracy: d.accuracy } : {}), ...(finite(d.speed) ? { speed: d.speed } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Whether the track jumps from a to b (choice 7). @param {Point} a @param {Point} b */
export function jumps(a, b) {
  const d = meters(a, b);
  return d >= FAR_M || (d >= JUMP_M && b.at - a.at >= JUMP_MIN * MIN);
}

/** The track in pieces, split where it jumps. @param {Point[]} points @returns {Point[][]} */
export function segmentsOf(points) {
  /** @type {Point[][]} */
  const out = [];
  /** @type {Point[]} */
  let cur = [];
  for (const p of points) {
    if (cur.length && jumps(cur[cur.length - 1], p)) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Where the user stayed and how they moved between (choice 7): a stay is STAY_MIN minutes or more
 * within STAY_M of where it began, placed at the point that waited longest for the next; a move is
 * what lies between, from a stay's last point to the next one's first.
 * @param {Point[]} points in time order @returns {Leg[]}
 */
export function legsOf(points) {
  const n = points.length;
  /** @type {{ i: number, j: number, best: number }[]} */
  const runs = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && meters(points[i], points[j + 1]) <= STAY_M) j++;
    if (j > i && points[j].at - points[i].at >= STAY_MIN * MIN) {
      let best = i;
      for (let k = i; k < j; k++) if (points[k + 1].at - points[k].at > points[best + 1].at - points[best].at) best = k;
      runs.push({ i, j, best });
      i = j + 1;
    } else i++;
  }
  /** @type {Leg[]} */
  const legs = [];
  /** @param {number} a @param {number} b */
  const move = (a, b) => {
    let m = 0;
    let ms = 0;
    let gap = false;
    for (let k = a + 1; k <= b; k++) {
      if (jumps(points[k - 1], points[k])) gap = true;
      else {
        m += meters(points[k - 1], points[k]);
        ms += points[k].at - points[k - 1].at;
      }
    }
    if (m < 100) return;
    const kmh = ms > 0 ? m / 1000 / (ms / 3_600_000) : Infinity;
    legs.push({ kind: 'move', from: points[a].at, to: points[b].at, km: Math.round(m / 100) / 10, mode: kmh < WALK_KMH ? 'walk' : 'drive', gap });
  };
  let last = 0;
  for (const r of runs) {
    move(last, r.i);
    const p = points[r.best];
    legs.push({ kind: 'stay', lat: p.lat, lng: p.lng, from: points[r.i].at, to: points[r.j].at });
    last = r.j;
  }
  if (n) move(last, n - 1);
  return legs;
}

/** Meters from p to the line from a to b, in a flat local frame. @param {number[]} p @param {number[]} a @param {number[]} b */
function off(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker over one piece, without recursion. @param {Point[]} s @param {number[][]} xy @param {number} eps meters */
function simplify(s, xy, eps) {
  if (s.length <= 2) return [...s];
  const keep = new Uint8Array(s.length);
  keep[0] = 1;
  keep[s.length - 1] = 1;
  /** @type {[number, number][]} */
  const stack = [[0, s.length - 1]];
  while (stack.length) {
    const [a, b] = /** @type {[number, number]} */ (stack.pop());
    let best = -1;
    let far = eps;
    for (let k = a + 1; k < b; k++) {
      const d = off(xy[k], xy[a], xy[b]);
      if (d > far) {
        far = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return s.filter((_, k) => keep[k]);
}

/**
 * The track thinned for drawing (choice 8), piece by piece: Douglas–Peucker, its tolerance doubled
 * until at most max points are left. Every piece keeps its two ends.
 * @param {Point[][]} segments @param {number} [max] @returns {Point[][]}
 */
export function thin(segments, max = DRAWN) {
  const total = segments.reduce((n, s) => n + s.length, 0);
  if (total <= max) return segments.map((s) => [...s]);
  const all = segments.flat();
  const lat0 = all.reduce((sum, p) => sum + p.lat, 0) / all.length;
  const kx = Math.cos(rad(lat0)) * DEG;
  const xy = segments.map((s) => s.map((p) => [p.lng * kx, p.lat * DEG]));
  for (let eps = 5; ; eps *= 2) {
    const out = segments.map((s, i) => simplify(s, xy[i], eps));
    if (out.reduce((n, s) => n + s.length, 0) <= max || eps > 1e7) return out;
  }
}

/** The index of the last point at or before t in a piece (-1 when t is before it). @param {Point[]} s @param {number} t */
function before(s, t) {
  let lo = 0;
  let hi = s.length - 1;
  if (!s.length || t < s[0].at) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].at <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where the user was at t on the drawn route: between two points in proportion to the time; during a
 * jump, where it began; before the start and after the end, at the ends.
 * @param {Point[][]} segments @param {number} t @returns {{ lat: number, lng: number } | null}
 */
export function positionAt(segments, t) {
  /** @type {Point | null} */
  let prev = null;
  for (const s of segments) {
    if (!s.length) continue;
    if (t < s[0].at) return prev ? { lat: prev.lat, lng: prev.lng } : { lat: s[0].lat, lng: s[0].lng };
    const k = before(s, t);
    if (k < s.length - 1) {
      const a = s[k];
      const b = s[k + 1];
      const f = b.at > a.at ? (t - a.at) / (b.at - a.at) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    }
    prev = s[s.length - 1];
  }
  return prev ? { lat: prev.lat, lng: prev.lng } : null;
}

/**
 * How much of a drawn piece was behind the user at t, as a part of its length (0 to 1), measured by
 * dist (meters; the replay passes its map's own distance, so the drawn line and the marker agree).
 * @param {Point[]} s @param {number} t @param {(a: Point, b: Point) => number} [dist]
 */
export function fractionAt(s, t, dist = meters) {
  if (s.length < 2 || t <= s[0].at) return 0;
  if (t >= s[s.length - 1].at) return 1;
  let total = 0;
  let done = 0;
  const k = before(s, t);
  for (let i = 1; i < s.length; i++) {
    const d = dist(s[i - 1], s[i]);
    total += d;
    if (i <= k) done += d;
    else if (i === k + 1) done += d * ((t - s[k].at) / Math.max(1, s[i].at - s[k].at));
  }
  return total ? done / total : 0;
}

/**
 * A flat map of the points (spec §13: "a simple equirectangular projection and no map tiles"): north
 * up, fitted into a box width wide with pad around it, as tall as the route needs within minHeight
 * and maxHeight. A trip over the date line counts its western longitudes on from 180.
 * @param {{ lat: number, lng: number }[]} points
 * @param {{ width?: number, pad?: number, minHeight?: number, maxHeight?: number }} [o]
 * @returns {{ width: number, height: number, xy: (p: { lat: number, lng: number }) => [number, number] }}
 */
export function fit(points, { width = 1000, pad = 40, minHeight = 500, maxHeight = 1300 } = {}) {
  if (!points.length) return { width, height: minHeight, xy: () => [width / 2, minHeight / 2] };
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.lng);
    hi = Math.max(hi, p.lng);
  }
  const wrap = hi - lo > 180;
  const lng = (/** @type {number} */ x) => (wrap && x < 0 ? x + 360 : x);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, lng(p.lng));
    maxLng = Math.max(maxLng, lng(p.lng));
  }
  const k = Math.cos(rad((minLat + maxLat) / 2));
  const w = Math.max((maxLng - minLng) * k, 0.005);
  const h = Math.max(maxLat - minLat, 0.005);
  const height = Math.round(Math.min(maxHeight, Math.max(minHeight, ((width - 2 * pad) * h) / w + 2 * pad)));
  const s = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const cx = (minLng + maxLng) / 2;
  const cy = (minLat + maxLat) / 2;
  const r = (/** @type {number} */ v) => Math.round(v * 10) / 10;
  return { width, height, xy: (p) => [r(width / 2 + (lng(p.lng) - cx) * k * s), r(height / 2 - (p.lat - cy) * s)] };
}
