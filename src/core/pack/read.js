import { meters } from '../live/geo.js';
import { MANIFEST, readManifest } from './download.js';

/**
 * The offline pack as the places tools and live mode read it (spec §8: "the tools read the offline
 * pack first"). A part that is missing or broken is left out, never an error: the pack helps; it is
 * never a must.
 * @typedef {import('./osm.js').OsmRow} OsmRow
 * @typedef {import('./download.js').Manifest} Manifest
 * @typedef {{ points: [number, number][], radius: number }} Area
 * @typedef {[title: string, lat: number, lng: number, summary: string]} WikiPage
 * @typedef {{ lat: number, lng: number }} Point
 */

/** Live mode is told it is near a place the pack names this close (choice 7). */
export const NAME_M = 500;
/** The kinds whose places name where the user is. */
const NAMED = new Set(['sights', 'parks', 'lodging']);
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Meters from a point to an area's line, or to its one point (flat near the point, which is plenty for
 * 40 km). Longitudes count the short way round, so a line across the date line is where it is.
 * @param {Point} p @param {[number, number][]} pts
 */
export function toLine(p, pts) {
  if (pts.length === 1) return meters(p, { lat: pts[0][0], lng: pts[0][1] });
  const k = Math.cos((p.lat * Math.PI) / 180);
  /** Degrees from a to b the short way, -180 to 180. @param {number} a @param {number} b */
  const east = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
  // Each point's longitude follows on from the one before (the line goes the short way), the first from p's.
  let lng = p.lng + east(p.lng, pts[0][1]);
  const xy = pts.map((q, i) => {
    if (i) lng += east(pts[i - 1][1], q[1]);
    return [(lng - p.lng) * 111_320 * k, (q[0] - p.lat) * 110_574];
  });
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = xy[i - 1];
    const [bx, by] = xy[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** A summary cut to about 200 characters, at a word. @param {string} s */
function short(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= 200 ? t : `${t.slice(0, 200).replace(/\s+\S*$/, '')}…`;
}

export class Pack {
  /** @type {{ area: Area, rows: OsmRow[], cut?: boolean }[]} cut: Overpass stopped at its limit there, so the part has only some of the places */
  #osm;
  /** @type {WikiPage[]} */
  #wiki;
  /** @type {[string, number, number][]} */
  #names = [];
  /** @type {(path: string) => Promise<any>} */
  #read;

  /** @param {Manifest} manifest @param {{ area: Area, rows: OsmRow[], cut?: boolean }[]} osm @param {WikiPage[]} wiki @param {(path: string) => Promise<any>} read */
  constructor(manifest, osm, wiki, read) {
    this.manifest = manifest;
    this.#osm = osm;
    this.#wiki = wiki;
    this.#read = read;
    for (const { rows } of osm) for (const r of rows) if (r[1] && r[6].split(',').some((k) => NAMED.has(k))) this.#names.push([r[1], r[3], r[4]]);
    for (const w of wiki) this.#names.push([w[0], w[1], w[2]]);
  }

  /** The day it was downloaded: "2026-10-16". */
  get day() {
    return this.manifest.at.slice(0, 10);
  }

  /** Whether one of its OpenStreetMap areas holds the whole circle, with all its places (not one Overpass cut off). @param {Point} p @param {number} radius */
  covers(p, radius) {
    return this.#osm.some((o) => !o.cut && toLine(p, o.area.points) + radius <= o.area.radius);
  }

  /** Whether the point is inside one of its areas. @param {Point} p */
  touches(p) {
    return this.#osm.some((o) => toLine(p, o.area.points) <= o.area.radius);
  }

  /** nearby's rows for its OpenStreetMap places of these kinds within radius. @param {Point} p @param {number} radius @param {string[]} kinds @returns {any[][]} */
  places(p, radius, kinds) {
    const want = new Set(kinds);
    const seen = new Set();
    /** @type {any[][]} */
    const out = [];
    for (const { rows } of this.#osm) {
      for (const r of rows) {
        if (seen.has(r[0]) || !r[6].split(',').some((k) => want.has(k))) continue;
        const d = meters(p, { lat: r[3], lng: r[4] });
        if (d > radius) continue;
        seen.add(r[0]);
        out.push([r[1], r[2], Math.round(d), r[3], r[4], 'osm', r[5]]);
      }
    }
    return out;
  }

  /** nearby's rows for its Wikipedia articles within radius, each with its summary (choice 6). @param {Point} p @param {number} radius @returns {any[][]} */
  pages(p, radius) {
    const seen = new Set();
    /** @type {any[][]} */
    const out = [];
    for (const [title, lat, lng, summary] of this.#wiki) {
      const d = meters(p, { lat, lng });
      if (d > radius || seen.has(title)) continue;
      seen.add(title);
      out.push([title, 'wikipedia article', Math.round(d), lat, lng, 'wikipedia', `${short(summary)} https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`.trim()]);
    }
    return out;
  }

  /** Its guide for a name: by title, by title without "(California)", or by a name that led to it. @param {string} name @returns {Promise<{ title: string, text: string } | null>} */
  async guide(name) {
    const n = norm(String(name));
    const g = this.manifest.guides.find((x) => [x.title, x.title.replace(/\s*\([^)]*\)$/, ''), ...x.asked].some((t) => norm(t) === n));
    if (!g) return null;
    const v = await this.#read(g.path).catch(() => null);
    return typeof v?.text === 'string' && v.text.trim() ? { title: g.title, text: v.text } : null;
  }

  /** The nearest sight, park, place to stay or Wikipedia article within 500 m, for live mode. @param {Point} p @returns {{ name: string, m: number } | null} */
  name(p) {
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const [name, lat, lng] of this.#names) {
      const m = meters(p, { lat, lng });
      if (m <= NAME_M && (!best || m < best.m)) best = { name, m };
    }
    return best;
  }
}

/** @param {any} a @returns {a is Area} */
const goodArea = (a) => Boolean(a) && isNum(a.radius) && Array.isArray(a.points) && a.points.length > 0 && a.points.every((/** @type {any} */ q) => Array.isArray(q) && isNum(q[0]) && isNum(q[1]));
/** @param {any} r @returns {r is OsmRow} */
const goodRow = (r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string' && typeof r[2] === 'string' && isNum(r[3]) && isNum(r[4]) && typeof r[5] === 'string' && typeof r[6] === 'string';
/** @param {any} w @returns {w is WikiPage} */
const goodPage = (w) => Array.isArray(w) && typeof w[0] === 'string' && isNum(w[1]) && isNum(w[2]) && typeof w[3] === 'string';

/** @type {Map<string, { hash: string, pack: Pack }>} */
const loaded = new Map();

/**
 * A trip's offline pack, read once for each version of its manifest; null when it has none.
 * @param {import('../workspace.js').Workspace} ws @param {string | null | undefined} scope @returns {Promise<Pack | null>}
 */
export async function loadPack(ws, scope) {
  if (!scope) return null;
  const got = await ws.read(scope, MANIFEST).catch(() => undefined);
  if (!got) {
    loaded.delete(scope);
    return null;
  }
  const hit = loaded.get(scope);
  if (hit && hit.hash === got.entry.hash) return hit.pack;
  const manifest = await readManifest(ws, scope);
  if (!manifest) return null;
  /** @type {{ area: Area, rows: OsmRow[], cut?: boolean }[]} */
  const osm = [];
  /** @type {WikiPage[]} */
  const wiki = [];
  for (const f of manifest.files) {
    if (f.kind === 'wikivoyage') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    if (f.kind === 'osm' && goodArea(v?.area) && Array.isArray(v.rows)) osm.push({ area: v.area, rows: v.rows.filter(goodRow), cut: v.cut === true });
    else if (f.kind === 'wikipedia' && Array.isArray(v?.pages)) wiki.push(...v.pages.filter(goodPage));
  }
  const pack = new Pack(manifest, osm, wiki, (path) => ws.readJSON(scope, path));
  loaded.set(scope, { hash: got.entry.hash, pack });
  if (loaded.size > 3) loaded.delete(/** @type {string} */ (loaded.keys().next().value));
  return pack;
}
