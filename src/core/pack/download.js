import { overpassServers, overpassFilters, osmRow, KIND_NAMES } from './osm.js';
import { planFor, guideTitles, hashId, labelOf, WIKI_RADIUS_M } from './plan.js';
import { answerJSON, answerWords } from '../answer.js';
import { readAppSettings } from '../settings.js';
import { t } from '../l10n.js';
import { meters } from '../live/geo.js';
import { StorageFullError } from '../errors.js';
import { anySignal } from '../signals.js';
import { guideEditions, voyageApi, wikimediaTurn, isWikimedia, nearUrl, articlesOf, wikiSaid, agentHeader } from '../wiki.js';

/**
 * Downloads a trip's offline pack (spec §11.5), one request at a time with a second between them: the parts its plan needs that the pack
 * lacks or has from more than a month ago (a Wikipedia part once per edition the traveller reads), the quick ones first: every Wikipedia part
 * (the stops' and the way's), then the Wikivoyage guides for the names the trip, the plan and those parts' English summaries give (English's, and
 * each of the traveller's editions' that has the guide, by English's links or by the trip's own names), then OpenStreetMap's parts (Overpass
 * answers one in 35 to 54 s). Parts the plan no longer needs go. Each part is a file in the trip, so a download that stops keeps what it got and the next goes on.
 * Positions go only to OpenStreetMap and Wikipedia (§11.7), and to VK's Overpass server while its switch is on; Wikivoyage is asked
 * about names, as the guide tool asks it.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {import('./plan.js').Part} Part
 * @typedef {import('./plan.js').PackPlan} PackPlan
 * @typedef {{ id: string, kind: 'osm' | 'wikipedia' | 'wikivoyage', path: string, bytes: number, items: number, at: number, edition?: string }} PackFile
 *   items: places, summaries, or 1 for a guide; at: when it was downloaded (ms). Not the file's own time: a
 *   download that brings the same bytes leaves the file as it was. edition: a Wikipedia file's, written since editions (one without: English, no
 *   ids); a guide's file names its edition in its path, and in its guide's entry
 * @typedef {{ part: Part, edition: string | null, path: string }} Want  a file a plan's pack holds
 * @typedef {{ edition: string, title: string }} GuideEdition  the guide in another edition: its title there (its file is guideFile's, by the guide's title and the edition)
 * @typedef {{ title: string, asked: string[], path: string, edition?: string, also: GuideEdition[] }} Guide
 *   title and path: English's, or the `edition`'s where English has no such guide (a guide only the traveller's edition has, found by the trip's
 *   own names); asked: the names that led to it ("Hearst Castle" leads to San Simeon); also: the traveller's other editions that have it, found
 *   by English's links, in the reading order of the download (one written before editions has none)
 * @typedef {{ source: 'osm' | 'wikipedia', place: import('./plan.js').Place } | { source: 'wikivoyage', title?: string }} PartRef
 *   which part, as data: a part of the plan by where it is, finding the guides, or one guide
 * @typedef {import('../answer.js').AnswerSaid | { code: 'late', where: string } | { code: 'early', where: string, remark: string }
 *   | { code: 'osm', inner: PackSaid | null, message: string | null } | { code: 'said', where: string, info: string } | { code: 'no-text', title: string }} PackSaid
 *   one of annai's own failures, as data: a server's answer, its time running out, Overpass stopping early, no Overpass server answering
 *   (inner: the last one's, or message, the browser's words; both null: every server was left), a service's own error (info, its words),
 *   a guide with no text
 * @typedef {{ label: string, why: string, part?: PartRef, said?: PackSaid | null }} Failure
 *   label and why: in annai's English, as the log keeps them; part and said: what the panel makes its words from (said null where why is
 *   the browser's or a service's own words). A failure kept by an older annai has neither.
 * @typedef {{ format: 1, key: string, at: string, files: PackFile[], guides: Guide[], voyage: string[],
 *   failed: Failure[], stopped: boolean, bytes: number, places: number, summaries: number }} Manifest
 *   key: the plan's when it was downloaded; voyage: the Wikivoyage editions the last guides pass that ran to its end asked (read as English
 *   alone for a pack written before Wikivoyage's editions); stopped: it was stopped, or gave up; places and summaries: each once, though
 *   the parts' areas overlap. A pack written before the size limit went may say `full`, which nothing reads.
 * @typedef {{ done: number, total: number, label: string }} Progress  label: what it is downloading, in the screens' words
 * @typedef {(url: string, init: RequestInit, where: string) => Promise<any>} Ask
 */

export const DIR = '/offline/';
export const MANIFEST = '/offline/pack.json';
const WIKIVOYAGE = voyageApi('en');
/** A second between requests: no service is asked twice at once (their usage policies). */
export const GAP_MS = 1000;
/** A part older than this is downloaded again. */
export const STALE_MS = 30 * 86_400_000;
/** After this many failures in a row (see saysDown) from a source (OpenStreetMap, an edition, Wikivoyage) or an Overpass server, the run leaves it: a host that never answers costs 3 answer times, not one a part. */
const GIVE_UP = 3;
/** How long one Overpass answer may take: it runs a query for up to a minute, after waiting for a free slot. */
export const ANSWER_MS = 120_000;
/**
 * How long one Wikipedia or Wikivoyage answer may take: the foreground's 25 s (they answered in 0.2 to 0.4 s in the editions design's real
 * checks, 2026-11-20), so a hung request holds one of the app's three Wikimedia turns 25 s at most, not two minutes. (`answerMs`, for tests: every request's.)
 */
export const WIKIMEDIA_MS = 25_000;
/** How long annai waits when Overpass says it has had too many requests (429). */
export const BUSY_MS = 30_000;
/** Overpass gives at most this many places for each part. */
const OSM_LIMIT = 3000;
/** The titles one request may name (MediaWiki's limit for a client without bot rights). */
const TITLES_PER_ASK = 50;
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
    case 'osm': {
      const why = s.inner ? failWords(s.inner) : s.message ?? t`every server was left for the rest of the run`;
      return t`OpenStreetMap didn't answer (${why.replace(/[.。]$/u, '')}).`;
    }
    case 'said': return t`${s.where} said: ${s.info}.`;
    case 'no-text': return t`Wikivoyage sent no text for ${s.title}.`;
    default: return answerWords(s);
  }
}

/** An error by the shown rule: message in annai's English, said its data. @param {string} en @param {PackSaid} said */
const fault = (en, said) => Object.assign(new Error(en), { said });

/**
 * Whether a failure says its source is down: no answer (late, quiet, unreachable, cut off, no `said`) or a refusal (429, a 5xx), not an answer
 * annai can't use (a remark, an error answer, no text, unreadable). Of an error as thrown, or of a manifest's Failure: both carry `said`.
 * @param {any} e
 */
export function saysDown(e) {
  const s = e?.said?.code === 'osm' ? e.said.inner : e?.said;
  return !s || s.code === 'late' || s.code === 'quiet' || s.code === 'cut' || s.code === 'unreachable' || (s.code === 'status' && (s.status === 429 || s.status >= 500));
}

/** Where a part is kept, a Wikipedia part's per edition (English's as before editions). @param {Part} p @param {string} [edition] */
export const pathOf = (p, edition = 'en') => `${DIR}${p.kind}/${p.id}${p.kind === 'wikipedia' && edition !== 'en' ? `.${edition}` : ''}.json`;
/** @param {PackPlan} plan @param {string[]} editions @returns {Want[]} */
export const wanted = (plan, editions) => plan.parts.flatMap((p) => /** @type {Want[]} */ (p.kind === 'wikipedia' ? editions.map((e) => ({ part: p, edition: e, path: pathOf(p, e) })) : [{ part: p, edition: null, path: pathOf(p) }]));
/** English rows from before editions, without ids to merge by, beside another edition: downloaded again, kept till then. @param {Pick<PackFile, 'kind' | 'edition'> | undefined} f @param {string[]} editions */
export const lacksIds = (f, editions) => f?.kind === 'wikipedia' && f.edition === undefined && editions.length > 1;
/** A guide file's id, from its path: its English title's fingerprint, whatever the edition. @param {string} path */
const idOf = (path) => path.slice(`${DIR}wikivoyage/`.length).split('.')[0];
/** Where a guide is kept, by its key (English's title, or ownKey where only the edition has it): English's file as before editions, another edition's beside it. @param {string} title @param {string} [edition] */
export function guideFile(title, edition = 'en') {
  const id = `g${hashId(title)}`;
  /* en */ return { id, path: `${DIR}wikivoyage/${id}${edition === 'en' ? '' : `.${edition}`}.json` };
}
/** The key of a guide only an edition has, so its file is never an English guide's twin's there (guideFile keys that by the English title). @param {string} edition @param {string} title */
export const ownKey = (edition, title) => `${edition}:${title}`;
/** Every edition a guide is held in, with its title there and its file: its own, and each of `also` where guideFile puts it. @param {Guide} g @returns {{ edition: string, title: string, path: string }[]} */
export const heldIn = (g) => [{ edition: g.edition ?? 'en', title: g.title, path: g.path }, ...g.also.map((a) => ({ ...a, path: guideFile(g.title, a.edition).path }))];

/** The pack's manifest, or null when there is none or it is broken. @param {Workspace} ws @param {string} scope @returns {Promise<Manifest | null>} */
export async function readManifest(ws, scope) {
  const m = await ws.readJSON(scope, MANIFEST).catch(() => null);
  if (!m || typeof m !== 'object' || m.format !== 1 || !Array.isArray(m.files) || !Array.isArray(m.guides) || !Array.isArray(m.failed)) return null;
  return {
    format: 1, key: String(m.key ?? ''), at: String(m.at ?? ''),
    files: m.files.filter((f) => typeof f?.path === 'string' && typeof f.id === 'string' && ['osm', 'wikipedia', 'wikivoyage'].includes(f.kind))
      .map((f) => ({ id: f.id, kind: f.kind, path: f.path, bytes: Number(f.bytes) || 0, items: Number(f.items) || 0, at: Number(f.at) || 0, ...(typeof f.edition === 'string' ? { edition: f.edition } : {}) })),
    // A guide written before Wikivoyage's editions is English's alone, and such a pack asked English alone.
    guides: m.guides.filter((g) => typeof g?.title === 'string' && typeof g.path === 'string')
      .map((g) => ({
        title: g.title, asked: Array.isArray(g.asked) ? g.asked.filter((a) => typeof a === 'string') : [], path: g.path,
        ...(typeof g.edition === 'string' ? { edition: g.edition } : {}),
        also: (Array.isArray(g.also) ? g.also : []).filter((a) => typeof a?.edition === 'string' && typeof a.title === 'string')
          .map((a) => ({ edition: a.edition, title: a.title })),
      })),
    voyage: Array.isArray(m.voyage) ? m.voyage.filter((e) => typeof e === 'string') : ['en'],
    failed: m.failed.filter((f) => typeof f?.label === 'string').map((f) => ({ label: f.label, why: String(f.why ?? ''), ...('part' in f ? { part: f.part, said: f.said ?? null } : {}) })),
    stopped: m.stopped === true, bytes: Number(m.bytes) || 0, places: Number(m.places) || 0, summaries: Number(m.summaries) || 0,
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
 * @param {{ ws: Workspace, scope: string, fetch: Fetch, version: string, editions: string[], signal?: AbortSignal,
 *   onProgress?: (p: Progress) => void, gapMs?: number, now?: () => number, answerMs?: number, busyMs?: number }} o
 *   editions: the Wikipedia editions the traveller's languages read (wiki.js editionsOf); the guides' are those of them with a Wikivoyage
 * @returns {Promise<Manifest>}
 */
export async function downloadPack(o) {
  const { ws, scope } = o;
  const now = o.now ?? Date.now;
  const signal = o.signal ?? new AbortController().signal;
  const plan = await planFor(ws, scope);
  const old = await readManifest(ws, scope);
  const have = new Map((await ws.list(scope, DIR)).map((f) => [f.path, f]));
  const prev = new Map((old?.files ?? []).map((f) => [f.path, f]));
  // A file the manifest doesn't name (a run stopped before it) is as its path says (see `entry`).
  const fresh = (/** @type {Omit<PackFile, 'bytes' | 'at' | 'items'>} */ e) => {
    const f = have.get(e.path);
    return f !== undefined && now() - (prev.get(e.path)?.at || f.modified) <= STALE_MS && !lacksIds(prev.get(e.path) ?? e, o.editions);
  };
  /** @type {Map<string, PackFile>} */
  const files = new Map();
  /** @type {Failure[]} */
  const failed = [];
  let bytes = 0;
  /** @type {Map<string, number>} failures in a row by Overpass server */
  const hosts = new Map();
  /** @type {Map<string, { n: number, last?: Failure }>} failures in a row by source ('osm', 'wikivoyage' (English's), an edition, another edition's Wikivoyage host), and the last */
  const fails = new Map();
  const gaveUp = (/** @type {string} */ source) => (fails.get(source)?.n ?? 0) >= GIVE_UP;
  let asked = 0;
  const headers = agentHeader(o.version);
  /** @type {Ask} */
  const ask = async (url, init, where) => {
    if (asked++) await pause(o.gapMs ?? GAP_MS, signal);
    if (signal.aborted) throw new DOMException(/* en */ 'The download was stopped.', 'AbortError');
    // A request that never answers would hold the download forever: each has its time.
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(new DOMException(/* en */ 'No answer in time.', 'TimeoutError')), o.answerMs ?? (isWikimedia(url) ? WIKIMEDIA_MS : ANSWER_MS));
    try {
      const ends = anySignal([signal, late.signal]);
      return await wikimediaTurn(url, async () => answerJSON(await o.fetch(url, { ...init, signal: ends }), where), ends);
    } catch (e) {
      if (late.signal.aborted && !signal.aborted) throw fault(/* en */ `${where} didn't answer in time.`, { code: 'late', where });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  /** What the pack already has stays, as it is: its edition as the old entry says, else as given. @param {Omit<PackFile, 'bytes' | 'at' | 'items'>} f @param {number} [count] */
  const keepOld = (f, count) => {
    const size = have.get(f.path)?.size ?? 0;
    const was = prev.get(f.path);
    files.set(f.path, { ...f, bytes: size, items: count ?? was?.items ?? 0, at: was?.at || have.get(f.path)?.modified || 0, ...(was?.edition === undefined ? {} : { edition: was.edition }) });
    bytes += size;
  };
  /** Writes a file. @param {Omit<PackFile, 'bytes' | 'at'>} f @param {unknown} content */
  const save = async (f, content) => {
    const text = JSON.stringify(content);
    const size = new TextEncoder().encode(text).byteLength;
    await ws.write(scope, f.path, text, { author: 'system' });
    files.set(f.path, { ...f, bytes: size, at: now() });
    bytes += size;
  };
  /** @param {PartRef} part @param {string} source @param {unknown} e */
  const failure = (part, source, e) => {
    if (e instanceof StorageFullError) throw e; // the panel's storage-full card says what to do
    /** @type {Failure} */
    const f = { label: partLabel(part), why: String(/** @type {any} */ (e)?.message ?? e), part, said: /** @type {any} */ (e)?.said ?? null };
    failed.push(f);
    // An answer annai can't use shows the source is there: the count starts over.
    fails.set(source, saysDown(e) ? { n: (fails.get(source)?.n ?? 0) + 1, last: f } : { n: 0 });
  };

  /** A part left for the rest of the run, with the failure that gave its source up: the panel counts it too. @param {PartRef} part @param {string} source */
  const left = (part, source) => failed.push(/** @type {Failure} */ ({ ...fails.get(source)?.last, label: partLabel(part), part }));
  /** A file's manifest entry as its path says: another edition's names it, English's doesn't; a save writes 'en', keepOld what the old entry said. */
  const entry = (/** @type {Want} */ w) => ({ id: w.part.id, kind: w.part.kind, path: w.path, ...(w.edition && w.edition !== 'en' ? { edition: w.edition } : {}) });
  const want = wanted(plan, o.editions);
  for (const w of want) if (fresh(entry(w))) keepOld(entry(w));
  const todo = want.filter((w) => !files.has(w.path));
  let total = todo.length + 1; // and finding the guides
  let done = 0;
  const progress = (/** @type {PartRef} */ part) => o.onProgress?.({ done, total, label: partWords(part) });
  /**
   * The parts in a list, in order, each in every edition in the reading order; one this download doesn't get stays as it was, however old.
   * @param {Want[]} list
   */
  const fetchParts = async (list) => {
    for (const w of list) {
      if (signal.aborted) break;
      const p = w.part;
      const source = w.edition ?? p.kind;
      /** @type {PartRef} */
      const part = { source: p.kind, place: p.place };
      if (gaveUp(source)) {
        left(part, source);
        done++;
        continue;
      }
      progress(part);
      try {
        // The Overpass servers by the switch as it is now, part by part: turned off, VK's server is asked nothing more.
        const got = p.kind === 'osm' ? await osm(p, ask, () => pause(o.busyMs ?? BUSY_MS, signal), overpassServers(await readAppSettings(ws)), hosts) : await wikipedia(p, w.edition ?? 'en', ask, headers);
        await save({ ...entry(w), items: got.count, ...(w.edition ? { edition: w.edition } : {}) }, got.content);
        fails.set(source, { n: 0 });
      } catch (e) {
        if (signal.aborted) break;
        failure(part, source, e);
      }
      done++;
    }
    for (const w of list) if (!files.has(w.path) && have.has(w.path)) keepOld(entry(w));
  };
  // The quick ones first (a request a second, minutes in all): every Wikipedia part, the stops' and the way's, so the guides read the titles they
  // give; then the guides; then what takes long, OpenStreetMap's parts (Overpass answers one in 35 to 54 s: hours for a long trip).
  const quick = (/** @type {Want} */ w) => w.part.kind === 'wikipedia';
  await fetchParts(todo.filter(quick));

  /** @type {Guide[]} */
  const guides = [];
  let guidesDone = false;
  // The traveller's other Wikivoyage editions, each read by the titles its English guides link to, and by the trip's own names; voyage: those this pass asked.
  const others = guideEditions(o.editions).filter((e) => e !== 'en');
  const voyage = ['en'];
  /** Where a guide's text comes from, as a source that can be given up: English Wikivoyage, or another edition's host. @param {string} edition */
  const textSource = (edition) => (edition === 'en' ? 'wikivoyage' : `${edition}.wikivoyage.org`);
  // English Wikivoyage gave up, or the download was stopped.
  const guidesStuck = () => signal.aborted || gaveUp('wikivoyage');
  /**
   * A guide's file in an edition, by its title (English's, or the edition's own for a guide only it has) and its title there: a fresh one stays;
   * one the pack lacks is left, and counted, when its source is given up, and not asked for once the guides are stuck (a stop makes them so, and
   * every guide after it keeps what the pack had); one not got keeps its old copy. Whether the pack has it now.
   * @param {string} key @param {string} edition @param {string} title
   */
  const guideIn = async (key, edition, title) => {
    const f = { ...guideFile(key, edition), kind: /** @type {const} */ ('wikivoyage') };
    const source = textSource(edition);
    if (fresh(f)) keepOld(f, 1);
    else if (guidesStuck() || gaveUp(source)) {
      if (gaveUp(source)) left({ source: 'wikivoyage', title }, source);
      if (have.has(f.path)) keepOld(f, 1);
    } else {
      progress({ source: 'wikivoyage', title });
      try {
        await save({ ...f, items: 1 }, { title, text: await article(edition, title, ask, headers) });
        fails.set(source, { n: 0 });
      } catch (e) {
        // A stop is no failure; what the pack had stays.
        if (!signal.aborted) failure({ source: 'wikivoyage', title }, source, e);
        if (have.has(f.path)) keepOld(f, 1);
      }
    }
    done++;
    return files.has(f.path);
  };
  if (!guidesStuck()) {
    progress({ source: 'wikivoyage' });
    try {
      const { guides: found, several } = await findGuides(await namesFor(ws, scope, plan, files), 'en', ask, headers);
      done++;
      /** @type {Map<string, Map<string, string>>} each other edition's titles by English's, for the editions whose lookup came */
      const linked = new Map();
      /** @type {Map<string, { title: string, asked: string[] }[]>} the guides each of them has by the trip's own names that English's links don't give (only it has them), for the editions whose lookup came */
      const own = new Map();
      for (const e of others) {
        if (guidesStuck()) break;
        /** @type {Map<string, string>} */
        let links;
        try {
          links = await linksIn(found.map((g) => g.title), e, ask, headers);
          linked.set(e, links);
          fails.set('wikivoyage', { n: 0 });
        } catch (err) {
          if (signal.aborted) throw err;
          failure({ source: 'wikivoyage' }, 'wikivoyage', err);
          continue;
        }
        try {
          // A name English lists as several places is not asked of another edition, which would bring its one meaning of it.
          const twins = new Set(links.values());
          own.set(e, (await findGuides(plan.names.filter((n) => !several.has(n)), e, ask, headers)).guides.filter((g) => !twins.has(g.title)));
          fails.set(textSource(e), { n: 0 });
          voyage.push(e);
        } catch (err) {
          if (signal.aborted) throw err;
          failure({ source: 'wikivoyage' }, textSource(e), err);
        }
      }
      total += found.length + [...linked.values()].reduce((n, m) => n + m.size, 0) + [...own.values()].reduce((n, l) => n + l.length, 0);
      for (const g of found) {
        // English's first: a guide is in the pack by its English file.
        const { path } = guideFile(g.title);
        if (!(await guideIn(g.title, 'en', g.title))) {
          done += others.filter((e) => linked.get(e)?.has(g.title)).length; // its other editions are left with it
          continue;
        }
        /** @type {GuideEdition[]} */
        const also = [];
        for (const e of others) {
          const links = linked.get(e);
          const title = links?.get(g.title);
          if (links) {
            if (title && (await guideIn(g.title, e, title))) also.push({ edition: e, title });
            continue;
          }
          // Its lookup didn't come: what the pack had of the guide in it stays as it was.
          const was = old?.guides.find((x) => x.path === path)?.also.find((a) => a.edition === e);
          const kept = guideFile(g.title, e);
          if (was && have.has(kept.path)) {
            if (!files.has(kept.path)) keepOld({ ...kept, kind: 'wikivoyage' }, 1);
            also.push(was);
          }
        }
        guides.push({ ...g, path, also });
      }
      // The guides only an edition has: by its own title, after English's.
      for (const e of others) {
        const mine = own.get(e);
        if (mine) {
          for (const g of mine) {
            if (await guideIn(ownKey(e, g.title), e, g.title)) guides.push({ title: g.title, asked: g.asked, path: guideFile(ownKey(e, g.title), e).path, edition: e, also: [] });
          }
        } else {
          // Its lookup didn't come: the guides the pack had only in it stay as they were.
          for (const g of old?.guides ?? []) {
            if (g.edition !== e || !have.has(g.path)) continue;
            if (!files.has(g.path)) keepOld({ id: idOf(g.path), kind: 'wikivoyage', path: g.path }, 1);
            guides.push(g);
          }
        }
      }
      guidesDone = !guidesStuck();
    } catch (e) {
      if (!signal.aborted) failure({ source: 'wikivoyage' }, 'wikivoyage', e);
    }
  }
  if (!guidesDone) {
    // The guides this download didn't get to stay as they were, in each edition the pack had them in.
    for (const g of old?.guides ?? []) {
      if (guides.some((x) => x.path === g.path) || !have.has(g.path)) continue;
      const kept = { ...g, also: g.also.filter((a) => have.has(guideFile(g.title, a.edition).path)) };
      for (const h of heldIn(kept)) if (!files.has(h.path)) keepOld({ id: idOf(h.path), kind: 'wikivoyage', path: h.path }, 1);
      guides.push(kept);
    }
  }
  await fetchParts(todo.filter((w) => !quick(w)));
  /** @type {Manifest} */
  const manifest = {
    format: 1, key: plan.key, at: new Date(now()).toISOString(), files: [...files.values()], guides, voyage: guidesDone ? voyage : old?.voyage ?? ['en'], failed,
    stopped: signal.aborted || [...fails.keys()].some(gaveUp), bytes, ...(await counted(ws, scope, files)),
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
    // An article in two editions counts once, by its Wikidata id.
    for (const p of Array.isArray(v?.pages) ? v.pages : []) if (Array.isArray(p)) summaries.add(typeof p[4] === 'string' && p[4] ? p[4] : `${f.edition ?? 'en'} ${p[0]}`);
  }
  return { places: places.size, summaries: summaries.size };
}

/**
 * OpenStreetMap places for a part: every kind nearby knows, from the first Overpass server that answers, asked in turn (one that gave up is left out).
 * @param {import('./plan.js').OsmPart} p @param {Ask} ask @param {() => Promise<unknown>} busy waits after a 429 @param {string[]} servers @param {Map<string, number>} hosts
 */
async function osm(p, ask, busy, servers, hosts) {
  const around = `around:${p.radius},${p.points.map((q) => q.join(',')).join(',')}`;
  const query = `[out:json][timeout:60];(${overpassFilters(KIND_NAMES).map((f) => `nwr(${around})${f};`).join('')});out center tags ${OSM_LIMIT};`;
  /** @type {unknown} */
  let last = null;
  for (const server of servers) {
    const host = new URL(server).hostname;
    if ((hosts.get(host) ?? 0) >= GIVE_UP) continue;
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
        hosts.set(host, 0);
        return { count: rows.length, content: { area: { points: p.points, radius: p.radius }, rows, ...(cut ? { cut: true } : {}) } };
      } catch (e) {
        if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
        last = e;
        // Too many requests: Overpass asks for a pause (its usage policy), so annai waits once and asks again.
        if (/** @type {any} */ (e)?.status !== 429 || tries > 0) {
          hosts.set(host, saysDown(e) ? (hosts.get(host) ?? 0) + 1 : 0);
          break;
        }
        await busy();
      }
    }
  }
  // No server was asked when every one was left: nothing to quote.
  const message = last === null ? null : String(/** @type {any} */ (last)?.message ?? last).replace(/\.$/, '');
  throw fault(/* en */ `OpenStreetMap didn't answer (${message ?? 'every server was left for the rest of the run'}).`, { code: 'osm', inner: /** @type {any} */ (last)?.said ?? null, message });
}

/** An edition's nearest 20 summaries to a part's point, with ids. @param {import('./plan.js').WikiPart} p @param {string} edition @param {Ask} ask @param {Record<string, string>} headers */
async function wikipedia(p, edition, ask, headers) {
  /* en */ const where = edition === 'en' ? 'Wikipedia' : `${edition}.wikipedia.org`;
  const r = await ask(nearUrl(edition, p.at, WIKI_RADIUS_M, 20, { extracts: true }), { headers }, where);
  const info = wikiSaid(r);
  if (info) throw fault(/* en */ `${where} said: ${info}.`, { code: 'said', where, info });
  const pages = articlesOf(r, edition).map((a) => [a.title, r4(a.lat), r4(a.lng), a.summary, a.id]);
  return { count: pages.length, content: { at: p.at, radius: WIKI_RADIUS_M, pages } };
}

/**
 * The names to look for in English Wikivoyage: the plan's (the trip's places, then the stops: every one), then the titles of the English
 * Wikipedia articles in the pack, nearest first. No bound on them: a part holds 20 at most, so 240 stops are 4,800 titles, 96 requests, under
 * two minutes against hours of Overpass; and they reach guides the names don't (2026-11-20, 5 real hotel and lodge stops, 10 km: Cambria Pines
 * Lodge's titles lead to "Central Coast (California)", Shinjuku Washington Hotel's to "Tokyo", the stops' own names to none).
 * @param {Workspace} ws @param {string} scope @param {PackPlan} plan @param {Map<string, PackFile>} files
 */
async function namesFor(ws, scope, plan, files) {
  /** @type {[string, number][]} */
  const titles = [];
  // English Wikipedia's titles, as English Wikivoyage is found by English names.
  for (const f of files.values()) {
    if (f.kind !== 'wikipedia' || (f.edition ?? 'en') !== 'en') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    const at = Array.isArray(v?.at) && isNum(v.at[0]) && isNum(v.at[1]) ? { lat: v.at[0], lng: v.at[1] } : null;
    for (const g of Array.isArray(v?.pages) ? v.pages : []) {
      if (at && Array.isArray(g) && typeof g[0] === 'string' && isNum(g[1]) && isNum(g[2])) titles.push([g[0], meters(at, { lat: g[1], lng: g[2] })]);
    }
  }
  titles.sort((a, b) => a[1] - b[1]);
  return [...new Set([...plan.names, ...titles.map((t) => t[0])])];
}

/** Which host a Wikivoyage request is to, for the words about it: English's is just Wikivoyage. @param {string} edition */
const voyageWhere = (edition) => (edition === 'en' ? 'Wikivoyage' : `${edition}.wikivoyage.org`);

/**
 * Which names have a guide in an edition of Wikivoyage, in their order, following its redirects and converting variants (Chinese's), and
 * leaving out its disambiguation pages, with the names that have none but a disambiguation page: the edition lists them as several places.
 * Only names are sent.
 * @param {string[]} names @param {string} edition @param {Ask} ask @param {Record<string, string>} headers
 * @returns {Promise<{ guides: { title: string, asked: string[] }[], several: Set<string> }>}
 */
async function findGuides(names, edition, ask, headers) {
  const where = voyageWhere(edition);
  const candidates = [...new Set(names.flatMap(guideTitles))];
  /** @type {Map<string, string | null>} what each candidate leads to */
  const resolved = new Map();
  /** @type {Set<string>} the candidates that lead to a disambiguation page */
  const lists = new Set();
  for (let i = 0; i < candidates.length; i += TITLES_PER_ASK) {
    const batch = candidates.slice(i, i + TITLES_PER_ASK);
    /* en */ const r = await ask(`${voyageApi(edition)}?action=query&format=json&formatversion=2&origin=*&redirects=1&converttitles=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(batch.join('|'))}`, { headers }, where);
    const info = wikiSaid(r);
    if (info) throw fault(/* en */ `${where} said: ${info}.`, { code: 'said', where, info });
    const q = r?.query ?? {};
    const steps = new Map([...(Array.isArray(q.normalized) ? q.normalized : []), ...(Array.isArray(q.converted) ? q.converted : []), ...(Array.isArray(q.redirects) ? q.redirects : [])]
      .filter((x) => typeof x?.from === 'string' && typeof x?.to === 'string').map((x) => [x.from, x.to]));
    const pages = (Array.isArray(q.pages) ? q.pages : []).filter((p) => typeof p?.title === 'string' && !p.missing && !p.invalid);
    const ambiguous = new Set(pages.filter((p) => p.pageprops && typeof p.pageprops === 'object' && 'disambiguation' in p.pageprops).map((p) => p.title));
    const ok = new Set(pages.map((p) => p.title).filter((t) => !ambiguous.has(t)));
    for (const c of batch) {
      let t = c;
      for (let k = 0; k < 3 && steps.has(t); k++) t = /** @type {string} */ (steps.get(t));
      resolved.set(c, ok.has(t) ? t : null);
      if (ambiguous.has(t)) lists.add(c);
    }
  }
  /** @type {Map<string, Set<string>>} */
  const guides = new Map();
  /** @type {Set<string>} */
  const several = new Set();
  for (const n of names) {
    const t = guideTitles(n).map((c) => resolved.get(c)).find((x) => typeof x === 'string');
    if (!t) {
      if (guideTitles(n).some((c) => lists.has(c))) several.add(n);
      continue;
    }
    if (!guides.has(t)) guides.set(t, new Set());
    guides.get(t)?.add(n);
  }
  return { guides: [...guides].map(([title, asked]) => ({ title, asked: [...asked] })), several };
}

/**
 * The titles English Wikivoyage's guides have in another edition, by their links (only titles are sent): a guide with none there is not in the
 * map. A request for each TITLES_PER_ASK titles; a page has one link at most in an edition, so an answer holds TITLES_PER_ASK at most and is
 * never continued.
 * @param {string[]} titles English's @param {string} edition @param {Ask} ask @param {Record<string, string>} headers @returns {Promise<Map<string, string>>}
 */
async function linksIn(titles, edition, ask, headers) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < titles.length; i += TITLES_PER_ASK) {
    const batch = titles.slice(i, i + TITLES_PER_ASK);
    /* en */ const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&prop=langlinks&lllang=${edition}&lllimit=${TITLES_PER_ASK}&titles=${encodeURIComponent(batch.join('|'))}`, { headers }, 'Wikivoyage');
    const info = wikiSaid(r);
    if (info) throw fault(/* en */ `Wikivoyage said: ${info}.`, { code: 'said', where: /* en */ 'Wikivoyage', info });
    for (const p of Array.isArray(r?.query?.pages) ? r.query.pages : []) {
      const link = (Array.isArray(p?.langlinks) ? p.langlinks : []).find((/** @type {any} */ l) => l?.lang === edition && typeof l.title === 'string' && l.title);
      if (typeof p?.title === 'string' && link) out.set(p.title, link.title);
    }
  }
  return out;
}

/**
 * A Wikivoyage guide's text in an edition, with its sections marked "== See ==", following a redirect there.
 * @param {string} edition @param {string} title its title there @param {Ask} ask @param {Record<string, string>} headers
 */
async function article(edition, title, ask, headers) {
  const where = voyageWhere(edition);
  /* en */ const r = await ask(`${voyageApi(edition)}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(title)}`, { headers }, where);
  const info = wikiSaid(r);
  if (info) throw fault(/* en */ `${where} said: ${info}.`, { code: 'said', where, info });
  const text = Array.isArray(r?.query?.pages) ? r.query.pages[0]?.extract : undefined;
  if (typeof text !== 'string' || !text.trim()) throw fault(/* en */ `Wikivoyage sent no text for ${title}.`, { code: 'no-text', title });
  return text;
}
