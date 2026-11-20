import { meters } from '../live/geo.js';
import { MANIFEST, readManifest, heldIn } from './download.js';
import { merged, articleUrl, readingEditions } from '../wiki.js';
import { isCJK } from '../languages.js';

/**
 * The offline pack as the places tools and live mode read it (spec §8: "the tools read the offline
 * pack first"). A part that is missing or broken is left out, never an error: the pack helps; it is
 * never a must.
 * @typedef {import('./osm.js').OsmRow} OsmRow
 * @typedef {import('./download.js').Manifest} Manifest
 * @typedef {{ points: [number, number][], radius: number }} Area
 * @typedef {[title: string, lat: number, lng: number, summary: string, wikidata?: string | null, edition?: string]} WikiPage  as stored; no id before
 *   editions; edition: a second stage's row's (an edition's list says its edition in the manifest)
 * @typedef {import('../wiki.js').Article} Article
 * @typedef {{ lat: number, lng: number }} Point
 */

/** Live mode is told it is near a place the pack names this close. */
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

/** A CJK character's share of a summary's 200: annai's catalog's English takes 1.7 characters per Japanese one (median, 963 messages), 2.5 per Chinese (921, 922). */
const CJK_WEIGHT = 2;
const MARKS = [...'、。，；！？'];
/** A summary cut to about 200 characters of English (CJK_WEIGHT), at a word: before the last space, or after the last mark. @param {string} s */
function short(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  let room = 200;
  let end = 0;
  for (const c of t) {
    room -= isCJK(c) ? CJK_WEIGHT : 1;
    if (room < 0) break;
    end += c.length;
  }
  if (end >= t.length) return t;
  const head = t.slice(0, end);
  const at = Math.max(head.lastIndexOf(' '), ...MARKS.map((m) => head.lastIndexOf(m) + 1));
  return `${at > 0 ? head.slice(0, at).trimEnd() : head}…`;
}

export class Pack {
  /** @type {{ area: Area, rows: OsmRow[], cut?: boolean }[]} cut: Overpass stopped at its limit there, so the part has only some of the places */
  #osm;
  /** @type {Article[]} */
  #wiki;
  /** @type {[string, number, number][]} OpenStreetMap's named places */
  #names = [];
  /** @type {(path: string) => Promise<any>} */
  #read;

  /** @param {Manifest} manifest @param {{ area: Area, rows: OsmRow[], cut?: boolean }[]} osm @param {Article[]} wiki @param {(path: string) => Promise<any>} read */
  constructor(manifest, osm, wiki, read) {
    this.manifest = manifest;
    this.#osm = osm;
    this.#wiki = wiki;
    this.#read = read;
    for (const { rows } of osm) for (const r of rows) if (r[1] && r[6].split(',').some((k) => NAMED.has(k))) this.#names.push([r[1], r[3], r[4]]);
  }

  /** The day it was downloaded, "2026-10-16": its manifest's, else its newest part's; '' when nothing says. */
  get day() {
    const at = Date.parse(this.manifest.at);
    const t = Number.isFinite(at) ? at : Math.max(0, ...this.manifest.files.map((f) => f.at));
    return t > 0 ? new Date(t).toISOString().slice(0, 10) : '';
  }

  /** " (downloaded 2026-10-16)", or nothing when the day isn't known. */
  get downloaded() {
    return this.day ? ` (downloaded ${this.day})` : '';
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

  /**
   * Its articles of these editions within radius, each once (parts overlap), with `also`, its rows in the later editions it holds: a language taken
   * off the list is no more read, though its files stay till the next download. @param {Point} p @param {number} radius @param {string[]} editions
   */
  articles(p, radius, editions) {
    return merged(this.#wiki.filter((w) => editions.includes(w.edition) && meters(p, w) <= radius), editions);
  }

  /**
   * nearby's rows for its Wikipedia articles within radius, named in the first edition that has it: its note, each edition's it holds, in the order,
   * its cut summary and address, joined by " · ". @param {Point} p @param {number} radius @param {string[]} editions @returns {any[][]}
   */
  pages(p, radius, editions) {
    /* en */ return this.articles(p, radius, editions).map((w) => [w.title, 'wikipedia article', Math.round(meters(p, w)), w.lat, w.lng, 'wikipedia', [w, ...w.also].map((x) => `${short(x.summary)} ${articleUrl(x.edition, x.title)}`.trim()).join(' · ')]);
  }

  /**
   * Its one guide for a name, by the first kind of match that finds any: its English title, a name that led to it, its title in an edition: only
   * what the tool matches online, which never drops a bracket ("Georgia" is not "Georgia (country)": online, English's list answers it), so the pack and
   * the tool agree on a name (apart from a trip name written with a comma, which the download also looks up as its bracketed form), and a name
   * held only under its bracketed title reads online; in each of these editions it is in, in their order, the
   * text empty where the file is missing or broken. None, [].
   * @param {string} name @param {string[]} editions the traveller's guide editions, in the reading order (wiki.js guideEditions)
   * @returns {Promise<{ edition: string, title: string, text: string }[]>}
   */
  async guide(name, editions) {
    const n = norm(String(name));
    const { guides } = this.manifest;
    const g = guides.find((x) => norm(x.title) === n) ?? guides.find((x) => x.asked.some((a) => norm(a) === n)) ?? guides.find((x) => x.also.some((a) => norm(a.title) === n));
    const held = g ? heldIn(g) : [];
    /** @type {{ edition: string, title: string, text: string }[]} */
    const out = [];
    for (const e of editions) {
      const h = held.find((x) => x.edition === e);
      if (!h) continue;
      const v = await this.#read(h.path).catch(() => null);
      out.push({ edition: e, title: h.title, text: typeof v?.text === 'string' && v.text.trim() ? v.text : '' });
    }
    return out;
  }

  /** The nearest sight, park, place to stay or Wikipedia article within 500 m, for live mode. @param {Point} p @param {string[]} editions @returns {{ name: string, m: number } | null} */
  name(p, editions) {
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const [name, lat, lng] of [...this.#names, ...this.articles(p, NAME_M, editions).map((w) => /** @type {const} */ ([w.title, w.lat, w.lng]))]) {
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
/** A second stage's row: a list's, with its id and its edition. @param {any} w @returns {w is [string, number, number, string, string, string]} */
const goodMore = (w) => goodPage(w) && typeof w[4] === 'string' && w[4] !== '' && typeof w[5] === 'string' && w[5] !== '';

/** A trip's pack as the journey's namer (the recap's, Replay's). @param {import('../workspace.js').Workspace} ws @param {string} scope @param {string} locale @returns {Promise<(p: Point) => { name: string, m: number } | null>} */
export async function packNamer(ws, scope, locale) {
  const [pack, editions] = await Promise.all([loadPack(ws, scope).catch(() => null), readingEditions(ws, locale)]);
  return (p) => pack?.name(p, editions) ?? null;
}

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
  /** @type {Article[]} */
  const wiki = [];
  for (const f of manifest.files) {
    if (f.kind === 'wikivoyage') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    if (f.kind === 'osm' && goodArea(v?.area) && Array.isArray(v.rows)) osm.push({ area: v.area, rows: v.rows.filter(goodRow), cut: v.cut === true });
    // A part from before editions is English.
    else if (f.kind === 'wikipedia' && Array.isArray(v?.pages)) {
      for (const [title, lat, lng, summary, id] of v.pages.filter(goodPage)) wiki.push({ title, lat, lng, summary, id: typeof id === 'string' && id ? id : null, edition: f.edition ?? 'en' });
    } else if (f.kind === 'wikipedia-editions' && Array.isArray(v?.pages)) {
      // A second stage's rows go to the articles of their editions, merged by id where they are read, as the lists' are.
      for (const [title, lat, lng, summary, id, edition] of v.pages.filter(goodMore)) wiki.push({ title, lat, lng, summary, id, edition });
    }
  }
  const pack = new Pack(manifest, osm, wiki, (path) => ws.readJSON(scope, path));
  loaded.set(scope, { hash: got.entry.hash, pack });
  if (loaded.size > 3) loaded.delete(/** @type {string} */ (loaded.keys().next().value));
  return pack;
}
