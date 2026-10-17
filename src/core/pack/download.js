import { OVERPASS, overpassFilters, osmRow, KIND_NAMES } from './osm.js';
import { planFor, guideTitles, hashId, MAX_GUIDES, WIKI_RADIUS_M } from './plan.js';
import { answerJSON } from '../answer.js';
import { meters } from '../live/geo.js';
import { StorageFullError } from '../errors.js';

/**
 * Downloads a trip's offline pack (spec §11.5), one request at a time with a second between them:
 * the parts its plan needs that the pack doesn't have, or has from more than a month ago, then the
 * Wikivoyage guides for the names the trip, the plan and the Wikipedia summaries give. Parts the plan
 * no longer needs go. Each part is a file in the trip (§4.9: everything stored is named), so a
 * download that stops keeps what it got and the next goes on from there. Positions go only to
 * OpenStreetMap and Wikipedia (§11.7); Wikivoyage is asked about names, as the guide tool asks it.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {import('./plan.js').Part} Part
 * @typedef {import('./plan.js').PackPlan} PackPlan
 * @typedef {{ id: string, kind: 'osm' | 'wikipedia' | 'wikivoyage', path: string, bytes: number, items: number, at: number }} PackFile
 *   items: places, summaries, or 1 for a guide; at: when it was downloaded (ms). Not the file's own time: a
 *   download that brings the same bytes leaves the file as it was.
 * @typedef {{ title: string, asked: string[], path: string }} Guide
 *   asked: the names that led to it ("Hearst Castle" leads to San Simeon)
 * @typedef {{ format: 1, key: string, at: string, files: PackFile[], guides: Guide[],
 *   failed: { label: string, why: string }[], full: boolean, stopped: boolean, bytes: number }} Manifest
 *   key: the plan's when it was downloaded; full: it reached its 20 MB; stopped: it was stopped, or gave up
 * @typedef {{ done: number, total: number, label: string }} Progress
 * @typedef {(url: string, init: RequestInit, where: string) => Promise<any>} Ask
 */

export const DIR = '/offline/';
export const MANIFEST = '/offline/pack.json';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const WIKIVOYAGE = 'https://en.wikivoyage.org/w/api.php';
/** A second between requests: no service is asked twice at once (their usage policies). */
export const GAP_MS = 1000;
/** The most a pack takes on the phone. */
export const MAX_BYTES = 20 * 1024 * 1024;
/** A part older than this is downloaded again. */
export const STALE_MS = 30 * 86_400_000;
/** After this many failures in a row the download stops: the connection or the services are down. */
const GIVE_UP = 3;
/** Overpass gives at most this many places for each part. */
const OSM_LIMIT = 3000;
const TITLES_PER_ASK = 50;
const MAX_NAMES = 200;
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;

/** Where a part is kept. @param {Part} p */
export const pathOf = (p) => `${DIR}${p.kind}/${p.id}.json`;
/** Where a guide is kept. @param {string} title */
export function guideFile(title) {
  const id = `g${hashId(title)}`;
  return { id, path: `${DIR}wikivoyage/${id}.json` };
}

/** The pack's manifest, or null when there is none or it is broken. @param {Workspace} ws @param {string} scope @returns {Promise<Manifest | null>} */
export async function readManifest(ws, scope) {
  const m = await ws.readJSON(scope, MANIFEST).catch(() => null);
  if (!m || typeof m !== 'object' || m.format !== 1 || !Array.isArray(m.files) || !Array.isArray(m.guides) || !Array.isArray(m.failed)) return null;
  return {
    format: 1, key: String(m.key ?? ''), at: String(m.at ?? ''),
    files: m.files.filter((f) => typeof f?.path === 'string' && typeof f.id === 'string' && ['osm', 'wikipedia', 'wikivoyage'].includes(f.kind))
      .map((f) => ({ id: f.id, kind: f.kind, path: f.path, bytes: Number(f.bytes) || 0, items: Number(f.items) || 0, at: Number(f.at) || 0 })),
    guides: m.guides.filter((g) => typeof g?.title === 'string' && typeof g.path === 'string')
      .map((g) => ({ title: g.title, asked: Array.isArray(g.asked) ? g.asked.filter((a) => typeof a === 'string') : [], path: g.path })),
    failed: m.failed.filter((f) => typeof f?.label === 'string').map((f) => ({ label: f.label, why: String(f.why ?? '') })),
    full: m.full === true, stopped: m.stopped === true, bytes: Number(m.bytes) || 0,
  };
}

/** Waits, or stops waiting when the download is stopped. @param {number} ms @param {AbortSignal} signal */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve(undefined);
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve(undefined);
    }, { once: true });
  });
}

/**
 * @param {{ ws: Workspace, scope: string, fetch: Fetch, version: string, signal?: AbortSignal,
 *   onProgress?: (p: Progress) => void, gapMs?: number, now?: () => number, maxBytes?: number }} o
 * @returns {Promise<Manifest>}
 */
export async function downloadPack(o) {
  const { ws, scope } = o;
  const now = o.now ?? Date.now;
  const signal = o.signal ?? new AbortController().signal;
  const max = o.maxBytes ?? MAX_BYTES;
  const plan = await planFor(ws, scope);
  const old = await readManifest(ws, scope);
  const have = new Map((await ws.list(scope, DIR)).map((f) => [f.path, f]));
  const prev = new Map((old?.files ?? []).map((f) => [f.path, f]));
  const fresh = (/** @type {string} */ path) => {
    const f = have.get(path);
    return f !== undefined && now() - (prev.get(path)?.at || f.modified) <= STALE_MS;
  };
  /** @type {Map<string, PackFile>} */
  const files = new Map();
  /** @type {{ label: string, why: string }[]} */
  const failed = [];
  let bytes = 0;
  let full = false;
  let fails = 0;
  let asked = 0;
  const headers = { 'Api-User-Agent': `annai/${o.version} (https://annai.guide)` };
  /** @type {Ask} */
  const ask = async (url, init, where) => {
    if (asked++) await pause(o.gapMs ?? GAP_MS, signal);
    if (signal.aborted) throw new DOMException('The download was stopped.', 'AbortError');
    return answerJSON(await o.fetch(url, { ...init, signal }), where);
  };
  /** What the pack already has stays, as it is. @param {Omit<PackFile, 'bytes' | 'at' | 'items'>} f @param {number} [count] */
  const keepOld = (f, count) => {
    const size = have.get(f.path)?.size ?? 0;
    files.set(f.path, { ...f, bytes: size, items: count ?? prev.get(f.path)?.items ?? 0, at: prev.get(f.path)?.at || have.get(f.path)?.modified || 0 });
    bytes += size;
  };
  /** Writes a file, unless the pack would pass its limit. @param {Omit<PackFile, 'bytes' | 'at'>} f @param {unknown} content */
  const save = async (f, content) => {
    const text = JSON.stringify(content);
    const size = new TextEncoder().encode(text).byteLength;
    if (bytes + size > max) {
      full = true;
      return false;
    }
    await ws.write(scope, f.path, text, { author: 'system' });
    files.set(f.path, { ...f, bytes: size, at: now() });
    bytes += size;
    return true;
  };
  const over = () => signal.aborted || fails >= GIVE_UP || full;
  /** @param {string} label @param {unknown} e */
  const failure = (label, e) => {
    if (e instanceof StorageFullError) throw e; // the panel's storage-full card says what to do
    fails++;
    failed.push({ label, why: String(/** @type {any} */ (e)?.message ?? e) });
  };

  for (const p of plan.parts) if (fresh(pathOf(p))) keepOld({ id: p.id, kind: p.kind, path: pathOf(p) });
  const todo = plan.parts.filter((p) => !files.has(pathOf(p)));
  let total = todo.length + 1; // and finding the guides
  let done = 0;
  const progress = (/** @type {string} */ label) => o.onProgress?.({ done, total, label });
  for (const p of todo) {
    if (over()) break;
    const label = `${p.kind === 'osm' ? 'OpenStreetMap' : 'Wikipedia'} ${p.label}`;
    progress(label);
    try {
      const got = p.kind === 'osm' ? await osm(p, ask) : await wikipedia(p, ask, headers);
      if (!(await save({ id: p.id, kind: p.kind, path: pathOf(p), items: got.count }, got.content))) break;
      fails = 0;
    } catch (e) {
      if (signal.aborted) break;
      failure(label, e);
    }
    done++;
  }
  // A part this download didn't get stays as it was, however old.
  for (const p of todo) if (!files.has(pathOf(p)) && have.has(pathOf(p))) keepOld({ id: p.id, kind: p.kind, path: pathOf(p) });

  /** @type {Guide[]} */
  const guides = [];
  let guidesDone = false;
  if (!over()) {
    progress('Wikivoyage');
    try {
      const found = await findGuides(await namesFor(ws, scope, plan, files), ask, headers);
      done++;
      total += found.length;
      for (const g of found) {
        if (over()) break;
        const { id, path } = guideFile(g.title);
        if (fresh(path)) keepOld({ id, kind: 'wikivoyage', path }, 1);
        else {
          progress(`Wikivoyage: ${g.title}`);
          try {
            if (!(await save({ id, kind: 'wikivoyage', path, items: 1 }, { title: g.title, text: await article(g.title, ask, headers) }))) break;
            fails = 0;
          } catch (e) {
            if (signal.aborted) break;
            failure(`Wikivoyage: ${g.title}`, e);
            if (have.has(path)) keepOld({ id, kind: 'wikivoyage', path }, 1);
          }
        }
        if (files.has(path)) guides.push({ ...g, path });
        done++;
      }
      guidesDone = !over();
    } catch (e) {
      if (!signal.aborted) failure('Wikivoyage', e);
    }
  }
  if (!guidesDone) {
    // The guides this download didn't get to stay as they were.
    for (const g of old?.guides ?? []) {
      if (guides.some((x) => x.path === g.path) || !have.has(g.path)) continue;
      if (!files.has(g.path)) keepOld({ id: g.path.slice(DIR.length + 'wikivoyage/'.length, -'.json'.length), kind: 'wikivoyage', path: g.path }, 1);
      guides.push(g);
    }
  }
  /** @type {Manifest} */
  const manifest = {
    format: 1, key: plan.key, at: new Date(now()).toISOString(), files: [...files.values()], guides, failed,
    full, stopped: signal.aborted || fails >= GIVE_UP, bytes,
  };
  const gone = [...have.keys()].filter((path) => path !== MANIFEST && !files.has(path));
  await ws.writeMany(scope, [...gone.map((path) => ({ path, content: null })), { path: MANIFEST, content: JSON.stringify(manifest) }], { author: 'system' });
  return manifest;
}

/** OpenStreetMap places for a part: every kind nearby knows, from the first Overpass server that answers. @param {import('./plan.js').OsmPart} p @param {Ask} ask */
async function osm(p, ask) {
  const around = `around:${p.radius},${p.points.map((q) => q.join(',')).join(',')}`;
  const query = `[out:json][timeout:60];(${overpassFilters(KIND_NAMES).map((f) => `nwr(${around})${f};`).join('')});out center tags ${OSM_LIMIT};`;
  /** @type {unknown} */
  let last = null;
  for (const server of OVERPASS) {
    const host = new URL(server).hostname;
    try {
      const data = await ask(server, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` }, host);
      if (!Array.isArray(data?.elements)) throw new Error(`${host} sent an answer annai can't read.`);
      if (typeof data.remark === 'string' && /error/i.test(data.remark)) throw new Error(`${host} stopped early: ${data.remark.trim().replace(/\.$/, '')}.`);
      const seen = new Set();
      /** @type {import('./osm.js').OsmRow[]} */
      const rows = [];
      for (const e of data.elements) {
        const r = osmRow(e);
        if (r && !seen.has(r[0])) {
          seen.add(r[0]);
          rows.push(r);
        }
      }
      return { count: rows.length, content: { area: { points: p.points, radius: p.radius }, rows } };
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      last = e;
    }
  }
  throw new Error(`OpenStreetMap didn't answer (${String(/** @type {any} */ (last)?.message ?? last).replace(/\.$/, '')}).`);
}

/** Wikipedia's summaries near a part's point. @param {import('./plan.js').WikiPart} p @param {Ask} ask @param {Record<string, string>} headers */
async function wikipedia(p, ask, headers) {
  const [lat, lng] = p.at;
  const r = await ask(`${WIKIPEDIA}?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=${WIKI_RADIUS_M}&ggslimit=20`
    + '&prop=extracts%7Ccoordinates&exintro=1&explaintext=1&exlimit=20&exchars=400&colimit=20', { headers }, 'Wikipedia');
  if (r?.error) throw new Error(`Wikipedia said: ${String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '')}.`);
  /** @type {[string, number, number, string][]} */
  const pages = [];
  for (const g of Array.isArray(r?.query?.pages) ? r.query.pages : []) {
    const c = Array.isArray(g?.coordinates) ? g.coordinates[0] : null;
    if (typeof g?.title !== 'string' || !isNum(c?.lat) || !isNum(c?.lon)) continue;
    pages.push([g.title, r4(c.lat), r4(c.lon), typeof g.extract === 'string' ? g.extract.trim() : '']);
  }
  return { count: pages.length, content: { at: p.at, radius: WIKI_RADIUS_M, pages } };
}

/**
 * The names to look for in Wikivoyage: the plan's (the trip's places, then the stops), then the
 * titles of the Wikipedia articles in the pack, nearest to their point first.
 * @param {Workspace} ws @param {string} scope @param {PackPlan} plan @param {Map<string, PackFile>} files
 */
async function namesFor(ws, scope, plan, files) {
  /** @type {[string, number][]} */
  const titles = [];
  for (const f of files.values()) {
    if (f.kind !== 'wikipedia') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    const at = Array.isArray(v?.at) && isNum(v.at[0]) && isNum(v.at[1]) ? { lat: v.at[0], lng: v.at[1] } : null;
    for (const g of Array.isArray(v?.pages) ? v.pages : []) {
      if (at && Array.isArray(g) && typeof g[0] === 'string' && isNum(g[1]) && isNum(g[2])) titles.push([g[0], meters(at, { lat: g[1], lng: g[2] })]);
    }
  }
  titles.sort((a, b) => a[1] - b[1]);
  return [...new Set([...plan.names, ...titles.map((t) => t[0])])].slice(0, MAX_NAMES);
}

/**
 * Which names have a Wikivoyage guide, in their order, at most 12, following its redirects and
 * leaving out its disambiguation pages. Only names are sent (choice 3).
 * @param {string[]} names @param {Ask} ask @param {Record<string, string>} headers
 * @returns {Promise<{ title: string, asked: string[] }[]>}
 */
async function findGuides(names, ask, headers) {
  const candidates = [...new Set(names.flatMap(guideTitles))];
  /** @type {Map<string, string | null>} what each candidate leads to */
  const resolved = new Map();
  for (let i = 0; i < candidates.length; i += TITLES_PER_ASK) {
    const batch = candidates.slice(i, i + TITLES_PER_ASK);
    const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(batch.join('|'))}`, { headers }, 'Wikivoyage');
    if (r?.error) throw new Error(`Wikivoyage said: ${String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '')}.`);
    const q = r?.query ?? {};
    const steps = new Map([...(Array.isArray(q.normalized) ? q.normalized : []), ...(Array.isArray(q.redirects) ? q.redirects : [])]
      .filter((x) => typeof x?.from === 'string' && typeof x?.to === 'string').map((x) => [x.from, x.to]));
    const ok = new Set((Array.isArray(q.pages) ? q.pages : [])
      .filter((p) => typeof p?.title === 'string' && !p.missing && !p.invalid && !(p.pageprops && typeof p.pageprops === 'object' && 'disambiguation' in p.pageprops))
      .map((p) => p.title));
    for (const c of batch) {
      let t = c;
      for (let k = 0; k < 3 && steps.has(t); k++) t = /** @type {string} */ (steps.get(t));
      resolved.set(c, ok.has(t) ? t : null);
    }
  }
  /** @type {Map<string, Set<string>>} */
  const guides = new Map();
  for (const n of names) {
    const t = guideTitles(n).map((c) => resolved.get(c)).find((x) => typeof x === 'string');
    if (!t || (!guides.has(t) && guides.size >= MAX_GUIDES)) continue;
    if (!guides.has(t)) guides.set(t, new Set());
    guides.get(t)?.add(n);
  }
  return [...guides].map(([title, asked]) => ({ title, asked: [...asked] }));
}

/** A Wikivoyage guide's text, with its sections marked "== See ==". @param {string} title @param {Ask} ask @param {Record<string, string>} headers */
async function article(title, ask, headers) {
  const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(title)}`, { headers }, 'Wikivoyage');
  const text = Array.isArray(r?.query?.pages) ? r.query.pages[0]?.extract : undefined;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`Wikivoyage sent no text for ${title}.`);
  return text;
}
