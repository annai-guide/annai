import { OVERPASS, overpassFilters, osmRow, KIND_NAMES } from './osm.js';
import { planFor, guideTitles, hashId, labelOf, MAX_GUIDES, WIKI_RADIUS_M } from './plan.js';
import { answerJSON, answerWords } from '../answer.js';
import { t } from '../l10n.js';
import { meters } from '../live/geo.js';
import { StorageFullError } from '../errors.js';
import { anySignal } from '../signals.js';

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
 * @typedef {{ source: 'osm' | 'wikipedia', place: import('./plan.js').Place } | { source: 'wikivoyage', title?: string }} PartRef
 *   which part, as data: a part of the plan by where it is, finding the guides, or one guide
 * @typedef {import('../answer.js').AnswerSaid | { code: 'late', where: string } | { code: 'early', where: string, remark: string }
 *   | { code: 'osm', inner: PackSaid | null, message: string } | { code: 'said', where: string, info: string } | { code: 'no-text', title: string }} PackSaid
 *   one of annai's own failures, as data: a server's answer, its time running out, Overpass stopping early, no Overpass server answering
 *   (inner: the last one's, or message, the browser's words), a service's own error (info, its words), a guide with no text
 * @typedef {{ label: string, why: string, part?: PartRef, said?: PackSaid | null }} Failure
 *   label and why: in annai's English, as the log keeps them; part and said: what the panel makes its words from. A failure kept since
 *   (localization L5h) always has part, and said null where why is the browser's or a service's own words; one from before has neither.
 * @typedef {{ format: 1, key: string, at: string, files: PackFile[], guides: Guide[],
 *   failed: Failure[], full: boolean, stopped: boolean, bytes: number, places: number, summaries: number }} Manifest
 *   key: the plan's when it was downloaded; full: it reached its 20 MB; stopped: it was stopped, or gave up;
 *   places and summaries: each once, though the parts' areas overlap
 * @typedef {{ done: number, total: number, label: string }} Progress  label: what it is downloading, in the screens' words
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
/** How long one answer may take: Overpass runs a query for up to a minute, after waiting for a free slot. */
export const ANSWER_MS = 120_000;
/** How long annai waits when Overpass says it has had too many requests (429). */
export const BUSY_MS = 30_000;
/** Overpass gives at most this many places for each part. */
const OSM_LIMIT = 3000;
const TITLES_PER_ASK = 50;
const MAX_NAMES = 200;
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;

/** Which part, in annai's English for the log. @param {PartRef} p */
const partLabel = (p) => /* en */ ('place' in p ? `${p.source === 'osm' ? 'OpenStreetMap' : 'Wikipedia'} ${labelOf(p.place)}` : p.title ? `Wikivoyage: ${p.title}` : 'Wikivoyage');

/** Which part, in the screens' words. @param {PartRef} p */
export function partWords(p) {
  if (!('place' in p)) return p.title ? t`Wikivoyage: ${p.title}` : /* en */ 'Wikivoyage';
  const [a, b] = p.place.names;
  if (p.source === 'osm') return p.place.how === 'between' ? t`OpenStreetMap between ${a} and ${b}` : t`OpenStreetMap around ${a}`;
  return p.place.how === 'between' ? t`Wikipedia between ${a} and ${b}` : t`Wikipedia near ${a}`;
}

/** One of annai's own failures in the screens' words, from its data. @param {PackSaid} s @returns {string} */
export function failWords(s) {
  switch (s.code) {
    case 'late': return t`${s.where} didn't answer in time.`;
    case 'early': return t`${s.where} stopped early: ${s.remark}.`;
    case 'osm': return t`OpenStreetMap didn't answer (${(s.inner ? failWords(s.inner) : s.message).replace(/[.。]$/u, '')}).`;
    case 'said': return t`${s.where} said: ${s.info}.`;
    case 'no-text': return t`Wikivoyage sent no text for ${s.title}.`;
    default: return answerWords(s);
  }
}

/** An error by the shown rule: message in annai's English, said its data. @param {string} en @param {PackSaid} said */
const fault = (en, said) => Object.assign(new Error(en), { said });

/** Where a part is kept. @param {Part} p */
export const pathOf = (p) => `${DIR}${p.kind}/${p.id}.json`;
/** Where a guide is kept. @param {string} title */
export function guideFile(title) {
  const id = `g${hashId(title)}`;
  /* en */ return { id, path: `${DIR}wikivoyage/${id}.json` };
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
    failed: m.failed.filter((f) => typeof f?.label === 'string').map((f) => ({ label: f.label, why: String(f.why ?? ''), ...('part' in f ? { part: f.part, said: f.said ?? null } : {}) })),
    full: m.full === true, stopped: m.stopped === true, bytes: Number(m.bytes) || 0, places: Number(m.places) || 0, summaries: Number(m.summaries) || 0,
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
 *   onProgress?: (p: Progress) => void, gapMs?: number, now?: () => number, maxBytes?: number, answerMs?: number, busyMs?: number }} o
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
  /** @type {Failure[]} */
  const failed = [];
  let bytes = 0;
  let full = false;
  let fails = 0;
  let asked = 0;
  const headers = { 'Api-User-Agent': /* en */ `annai/${o.version} (https://annai.guide)` };
  /** @type {Ask} */
  const ask = async (url, init, where) => {
    if (asked++) await pause(o.gapMs ?? GAP_MS, signal);
    if (signal.aborted) throw new DOMException(/* en */ 'The download was stopped.', 'AbortError');
    // A request that never answers would hold the download forever: each has its time.
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(new DOMException(/* en */ 'No answer in time.', 'TimeoutError')), o.answerMs ?? ANSWER_MS);
    try {
      return await answerJSON(await o.fetch(url, { ...init, signal: anySignal([signal, late.signal]) }), where);
    } catch (e) {
      if (late.signal.aborted && !signal.aborted) throw fault(/* en */ `${where} didn't answer in time.`, { code: 'late', where });
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
  /** @param {PartRef} part @param {unknown} e */
  const failure = (part, e) => {
    if (e instanceof StorageFullError) throw e; // the panel's storage-full card says what to do
    fails++;
    failed.push({ label: partLabel(part), why: String(/** @type {any} */ (e)?.message ?? e), part, said: /** @type {any} */ (e)?.said ?? null });
  };

  for (const p of plan.parts) if (fresh(pathOf(p))) keepOld({ id: p.id, kind: p.kind, path: pathOf(p) });
  const todo = plan.parts.filter((p) => !files.has(pathOf(p)));
  let total = todo.length + 1; // and finding the guides
  let done = 0;
  const progress = (/** @type {PartRef} */ part) => o.onProgress?.({ done, total, label: partWords(part) });
  for (const p of todo) {
    if (over()) break;
    /** @type {PartRef} */
    const part = { source: p.kind, place: p.place };
    progress(part);
    try {
      const got = p.kind === 'osm' ? await osm(p, ask, () => pause(o.busyMs ?? BUSY_MS, signal)) : await wikipedia(p, ask, headers);
      if (!(await save({ id: p.id, kind: p.kind, path: pathOf(p), items: got.count }, got.content))) break;
      fails = 0;
    } catch (e) {
      if (signal.aborted) break;
      failure(part, e);
    }
    done++;
  }
  // A part this download didn't get stays as it was, however old.
  for (const p of todo) if (!files.has(pathOf(p)) && have.has(pathOf(p))) keepOld({ id: p.id, kind: p.kind, path: pathOf(p) });

  /** @type {Guide[]} */
  const guides = [];
  let guidesDone = false;
  if (!over()) {
    progress({ source: 'wikivoyage' });
    try {
      const found = await findGuides(await namesFor(ws, scope, plan, files), ask, headers);
      done++;
      total += found.length;
      for (const g of found) {
        if (over()) break;
        const { id, path } = guideFile(g.title);
        if (fresh(path)) keepOld({ id, kind: 'wikivoyage', path }, 1);
        else {
          progress({ source: 'wikivoyage', title: g.title });
          try {
            if (!(await save({ id, kind: 'wikivoyage', path, items: 1 }, { title: g.title, text: await article(g.title, ask, headers) }))) break;
            fails = 0;
          } catch (e) {
            if (signal.aborted) break;
            failure({ source: 'wikivoyage', title: g.title }, e);
            if (have.has(path)) keepOld({ id, kind: 'wikivoyage', path }, 1);
          }
        }
        if (files.has(path)) guides.push({ ...g, path });
        done++;
      }
      guidesDone = !over();
    } catch (e) {
      if (!signal.aborted) failure({ source: 'wikivoyage' }, e);
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
    full, stopped: signal.aborted || fails >= GIVE_UP, bytes, ...(await counted(ws, scope, files)),
  };
  const gone = [...have.keys()].filter((path) => path !== MANIFEST && !files.has(path));
  await ws.writeMany(scope, [...gone.map((path) => ({ path, content: null })), { path: MANIFEST, content: JSON.stringify(manifest) }], { author: 'system' });
  return manifest;
}

/** How many places and summaries the pack holds, each once. @param {Workspace} ws @param {string} scope @param {Map<string, PackFile>} files */
async function counted(ws, scope, files) {
  const places = new Set();
  const summaries = new Set();
  for (const f of files.values()) {
    if (f.kind === 'wikivoyage') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    for (const r of Array.isArray(v?.rows) ? v.rows : []) if (Array.isArray(r)) places.add(r[0]);
    for (const p of Array.isArray(v?.pages) ? v.pages : []) if (Array.isArray(p)) summaries.add(p[0]);
  }
  return { places: places.size, summaries: summaries.size };
}

/**
 * OpenStreetMap places for a part: every kind nearby knows, from the first Overpass server that answers.
 * @param {import('./plan.js').OsmPart} p @param {Ask} ask @param {() => Promise<unknown>} busy waits after a 429
 */
async function osm(p, ask, busy) {
  const around = `around:${p.radius},${p.points.map((q) => q.join(',')).join(',')}`;
  const query = `[out:json][timeout:60];(${overpassFilters(KIND_NAMES).map((f) => `nwr(${around})${f};`).join('')});out center tags ${OSM_LIMIT};`;
  /** @type {unknown} */
  let last = null;
  for (const server of OVERPASS) {
    const host = new URL(server).hostname;
    for (let tries = 0; tries < 2; tries++) {
      try {
        const data = await ask(server, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: /* en */ `data=${encodeURIComponent(query)}` }, host);
        if (!Array.isArray(data?.elements)) throw fault(/* en */ `${host} sent an answer annai can't read.`, { code: 'unreadable', where: host });
        const remark = typeof data.remark === 'string' && /error/i.test(data.remark) ? data.remark.trim().replace(/\.$/, '') : '';
        if (remark) throw fault(/* en */ `${host} stopped early: ${remark}.`, { code: 'early', where: host, remark });
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
        // At Overpass's limit, the part holds only some of what is there: it can't answer for its whole area (C1).
        const cut = data.elements.length >= OSM_LIMIT;
        return { count: rows.length, content: { area: { points: p.points, radius: p.radius }, rows, ...(cut ? { cut: true } : {}) } };
      } catch (e) {
        if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
        last = e;
        // Too many requests: Overpass asks for a pause (its usage policy), so annai waits once and asks again.
        if (/** @type {any} */ (e)?.status !== 429 || tries > 0) break;
        await busy();
      }
    }
  }
  const message = String(/** @type {any} */ (last)?.message ?? last).replace(/\.$/, '');
  throw fault(/* en */ `OpenStreetMap didn't answer (${message}).`, { code: 'osm', inner: /** @type {any} */ (last)?.said ?? null, message });
}

/** Wikipedia's summaries near a part's point. @param {import('./plan.js').WikiPart} p @param {Ask} ask @param {Record<string, string>} headers */
async function wikipedia(p, ask, headers) {
  const [lat, lng] = p.at;
  /* en */ const r = await ask(`${WIKIPEDIA}?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=${WIKI_RADIUS_M}&ggslimit=20`
    + '&prop=extracts%7Ccoordinates&exintro=1&explaintext=1&exlimit=20&exchars=400&colimit=20', { headers }, 'Wikipedia');
  const info = r?.error ? String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '') : '';
  if (info) throw fault(/* en */ `Wikipedia said: ${info}.`, { code: 'said', where: /* en */ 'Wikipedia', info });
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
    /* en */ const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(batch.join('|'))}`, { headers }, 'Wikivoyage');
    const info = r?.error ? String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '') : '';
    if (info) throw fault(/* en */ `Wikivoyage said: ${info}.`, { code: 'said', where: /* en */ 'Wikivoyage', info });
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
  /* en */ const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(title)}`, { headers }, 'Wikivoyage');
  const text = Array.isArray(r?.query?.pages) ? r.query.pages[0]?.extract : undefined;
  if (typeof text !== 'string' || !text.trim()) throw fault(/* en */ `Wikivoyage sent no text for ${title}.`, { code: 'no-text', title });
  return text;
}
