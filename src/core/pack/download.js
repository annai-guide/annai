import { overpassServers, overpassFilters, osmRow, KIND_NAMES } from './osm.js';
import { planFor, guideTitles, hashId, labelOf, WIKI_RADIUS_M } from './plan.js';
import { answerJSON, answerWords } from '../answer.js';
import { readAppSettings } from '../settings.js';
import { t } from '../l10n.js';
import { meters } from '../live/geo.js';
import { StorageFullError } from '../errors.js';
import { anySignal } from '../signals.js';
import { guideEditions, voyageApi, wikimediaTurn, isWikimedia, nearUrl, articlesOf, wikiSaid, agentHeader, sitelinksUrl, titlesOf, summariesUrl, SUMMARIES_PER_ASK } from '../wiki.js';
import { forget } from '../forget.js';

/**
 * Downloads a trip's offline pack (spec §11.5), one request at a time with a second between them: the parts its plan needs that the pack
 * lacks or has from more than a month ago (a Wikipedia part once per edition the traveller reads, and, with more than one, its second stage: each
 * edition's summary of the articles the part's lists hold that its own list lacks), the quick ones first: every Wikipedia part's lists (the stops'
 * and the way's), then the Wikivoyage guides for the names the trip, the plan and those lists' English summaries give (English's, found by
 * the names, or by an edition's link to English for a trip name English lacks; each of the traveller's editions' part is the page English's links
 * to), then the second stages, then OpenStreetMap's parts (Overpass answers one in 35 to 54 s). Parts the plan no longer needs go. Each part is a file in the trip, so a download that stops keeps what it got and the next goes on.
 * Positions go only to OpenStreetMap and Wikipedia (§11.7), and to VK's Overpass server while its switch is on; Wikidata is asked about
 * articles' ids, and Wikivoyage about names, as the guide tool asks it.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {import('./plan.js').Part} Part
 * @typedef {import('./plan.js').PackPlan} PackPlan
 * @typedef {{ id: string, kind: 'osm' | 'wikipedia' | 'wikipedia-editions' | 'wikivoyage', path: string, bytes: number, items: number, at: number, edition?: string }} PackFile
 *   kind: 'wikipedia-editions' is a Wikipedia part's second stage (morePath), a kind of its own so that an older annai, which knows the other
 *   three, never reads it as an edition's list (its download removes it, and this one's brings it again); items: places, summaries, or 1 for a
 *   guide; at: when it was downloaded (ms). Not the file's own time: a download that brings the same bytes leaves the file as it was. edition: a
 *   Wikipedia list's, written since editions (one without: English, no ids); a guide's file names its edition in its path, and in its guide's
 *   `also`; a second stage's rows name theirs, and its path the editions read
 * @typedef {{ part: Part, edition: string | null, path: string, editions?: string[] }} Want  a file a plan's pack holds: an edition's list of a
 *   Wikipedia part, an OpenStreetMap part (edition null), or a Wikipedia part's second stage (edition null; editions: the editions read, sorted)
 * @typedef {{ edition: string, title: string }} GuideEdition  the guide in another edition: its title there (its file is guideFile's, by the guide's title and the edition)
 * @typedef {{ title: string, asked: string[], path: string, also: GuideEdition[] }} Guide
 *   title and path: English's; asked: the names that led to it ("Hearst Castle" leads to San Simeon, 台湾 to Taiwan); also: the traveller's other
 *   editions English's page links to, in the reading order of the download, whether or not their text is in the pack (one written before editions has none)
 * @typedef {{ source: 'osm' | 'wikipedia' | 'wikidata', place: import('./plan.js').Place } | { source: 'wikivoyage', title?: string }} PartRef
 *   which part, as data: a part of the plan by where it is ('wikidata': a Wikipedia part's second stage, found through Wikidata), finding the
 *   guides, or one guide
 * @typedef {import('../answer.js').AnswerSaid | { code: 'late', where: string } | { code: 'early', where: string, remark: string }
 *   | { code: 'osm', inner: PackSaid | null, message: string | null } | { code: 'said', where: string, info: string } | { code: 'no-text', where?: string, title: string }} PackSaid
 *   one of annai's own failures, as data: a server's answer, its time running out, Overpass stopping early, no Overpass server answering
 *   (inner: the last one's, or message, the browser's words; both null: every server was left), a service's own error (info, its words),
 *   a guide with no text (where: its host; one kept by an older annai has none)
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
/** After this many failures in a row (see saysDown) from a source (OpenStreetMap, an edition, Wikidata, Wikivoyage) or an Overpass server, the run leaves it: a host that never answers costs 3 answer times, not one a part. */
const GIVE_UP = 3;
/** How long one Overpass answer may take: it runs a query for up to a minute, after waiting for a free slot. */
export const ANSWER_MS = 120_000;
/**
 * How long one Wikipedia, Wikidata or Wikivoyage answer may take: the foreground's 25 s (they answered in 0.2 to 0.56 s in the editions design's
 * real checks, 2026-11-20), so a hung request holds one of the app's three Wikimedia turns 25 s at most, not two minutes. (`answerMs`, for tests: every request's.)
 */
export const WIKIMEDIA_MS = 25_000;
/** How long annai waits when Overpass says it has had too many requests (429). */
export const BUSY_MS = 30_000;
/** Overpass gives at most this many places for each part. */
const OSM_LIMIT = 3000;
/** The titles one request may name, or the items (MediaWiki's limit for a client without bot rights; Wikidata's `ids` the same). */
const TITLES_PER_ASK = 50;
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;

/** Which part, in annai's English for the log. @param {PartRef} p */
const partLabel = (p) => /* en */ ('place' in p ? `${p.source === 'osm' ? 'OpenStreetMap' : p.source === 'wikidata' ? "Wikipedia's other editions" : 'Wikipedia'} ${labelOf(p.place)}` : p.title ? `Wikivoyage: ${p.title}` : 'Wikivoyage');

/** Which part, in the screens' words. @param {PartRef} p */
export function partWords(p) {
  if (!('place' in p)) return p.title ? t`Wikivoyage: ${p.title}` : /* en */ 'Wikivoyage';
  const [a, b] = p.place.names;
  if (p.source === 'osm') return p.place.how === 'between' ? t`OpenStreetMap between ${a} and ${b}` : t`OpenStreetMap around ${a}`;
  if (p.source === 'wikidata') return p.place.how === 'between' ? t`Wikipedia's other editions between ${a} and ${b}` : t`Wikipedia's other editions near ${a}`;
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
    case 'no-text': {
      const where = s.where ?? /* en */ 'Wikivoyage';
      return t`${where} sent no text for ${s.title}.`;
    }
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
/**
 * Where a Wikipedia part's second stage is kept: named by the part and the editions read, sorted (lesson 2026-11-19: a variant's file is named
 * by both), so a language added or taken off is a new file (the old one goes at the download that brings the new one), and a reorder stores nothing.
 * @param {Pick<Part, 'id'>} p @param {string[]} editions
 */
export const morePath = (p, editions) => `${DIR}wikipedia/${p.id}.x.${[...editions].sort().join('.')}.json`;
/** Its files: each part's, a Wikipedia part's in every edition and, with more than one edition, its second stage after them. @param {PackPlan} plan @param {string[]} editions @returns {Want[]} */
export const wanted = (plan, editions) => plan.parts.flatMap((p) => {
  if (p.kind !== 'wikipedia') return [{ part: p, edition: null, path: pathOf(p) }];
  /** @type {Want[]} */
  const lists = editions.map((e) => ({ part: p, edition: e, path: pathOf(p, e) }));
  return editions.length > 1 ? [...lists, { part: p, edition: null, path: morePath(p, editions), editions: [...editions].sort() }] : lists;
});
/** English rows from before editions, without ids to merge by, beside another edition: downloaded again, kept till then. @param {Pick<PackFile, 'kind' | 'edition'> | undefined} f @param {string[]} editions */
export const lacksIds = (f, editions) => f?.kind === 'wikipedia' && f.edition === undefined && editions.length > 1;
/** A guide file's id, from its path: its English title's fingerprint, whatever the edition. @param {string} path */
const idOf = (path) => path.slice(`${DIR}wikivoyage/`.length).split('.')[0];
/** Where a guide is kept, by its English title: English's file as before editions, another edition's beside it. @param {string} title @param {string} [edition] */
export function guideFile(title, edition = 'en') {
  const id = `g${hashId(title)}`;
  /* en */ return { id, path: `${DIR}wikivoyage/${id}${edition === 'en' ? '' : `.${edition}`}.json` };
}
/** Every edition a guide is in, with its title there and its file (missing where a text didn't come). @param {Guide} g @returns {{ edition: string, title: string, path: string }[]} */
export const heldIn = (g) => [{ edition: 'en', title: g.title, path: g.path }, ...g.also.map((a) => ({ ...a, path: guideFile(g.title, a.edition).path }))];

/** The pack's manifest, or null when there is none or it is broken. @param {Workspace} ws @param {string} scope @returns {Promise<Manifest | null>} */
export async function readManifest(ws, scope) {
  const m = await ws.readJSON(scope, MANIFEST).catch(() => null);
  if (!m || typeof m !== 'object' || m.format !== 1 || !Array.isArray(m.files) || !Array.isArray(m.guides) || !Array.isArray(m.failed)) return null;
  return {
    format: 1, key: String(m.key ?? ''), at: String(m.at ?? ''),
    files: m.files.filter((f) => typeof f?.path === 'string' && typeof f.id === 'string' && ['osm', 'wikipedia', 'wikipedia-editions', 'wikivoyage'].includes(f.kind))
      .map((f) => ({ id: f.id, kind: f.kind, path: f.path, bytes: Number(f.bytes) || 0, items: Number(f.items) || 0, at: Number(f.at) || 0, ...(typeof f.edition === 'string' ? { edition: f.edition } : {}) })),
    // A guide written before Wikivoyage's editions is English's alone, and such a pack asked English alone.
    guides: m.guides.filter((g) => typeof g?.title === 'string' && typeof g.path === 'string')
      .map((g) => ({
        title: g.title, asked: Array.isArray(g.asked) ? g.asked.filter((a) => typeof a === 'string') : [], path: g.path,
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
  try {
    return await fetchPack(o);
  } finally {
    // The pack keeps no history (spec §4.9): what a download replaced or removed goes with its content, a stopped or failed one's too
    // (as a plugin's package's does). A forget refused on a full phone waits for the next download.
    await forget(o.ws.store, o.scope, { history: (p) => p.startsWith(DIR) }).catch(() => {});
  }
}

/** The download itself. @param {Parameters<typeof downloadPack>[0]} o @returns {Promise<Manifest>} */
async function fetchPack(o) {
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
  /** @type {Map<string, { n: number, last?: Failure }>} failures in a row by host ('osm', 'wikivoyage' (English's), an edition's Wikipedia, 'wikidata', another edition's Wikivoyage host), and the last */
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
  /** @param {PartRef} part @param {string} source @param {unknown} e @returns {Failure} */
  const failure = (part, source, e) => {
    if (e instanceof StorageFullError) throw e; // the panel's storage-full card says what to do
    /** @type {Failure} */
    const f = { label: partLabel(part), why: String(/** @type {any} */ (e)?.message ?? e), part, said: /** @type {any} */ (e)?.said ?? null };
    failed.push(f);
    // An answer annai can't use shows the source is there: the count starts over.
    fails.set(source, saysDown(e) ? { n: (fails.get(source)?.n ?? 0) + 1, last: f } : { n: 0 });
    return f;
  };

  /** A part left for the rest of the run, with the failure that gave its source up: the panel counts it too. @param {PartRef} part @param {string} source @returns {Failure} */
  const left = (part, source) => {
    const f = /** @type {Failure} */ ({ ...fails.get(source)?.last, label: partLabel(part), part });
    failed.push(f);
    return f;
  };
  /** A file's manifest entry as its path says: another edition's names it, English's doesn't; a save writes 'en', keepOld what the old entry said. */
  const entry = (/** @type {Want} */ w) => ({ id: w.part.id, kind: w.editions ? /** @type {const} */ ('wikipedia-editions') : w.part.kind, path: w.path, ...(w.edition && w.edition !== 'en' ? { edition: w.edition } : {}) });
  /** When a file the pack has came: the manifest's time, else the file's own (a run stopped before its manifest). @param {string} path */
  const cameAt = (path) => prev.get(path)?.at || have.get(path)?.modified || 0;
  /** A second stage's lists: its part's file in each edition. @param {Want} w */
  const listsOf = (w) => (w.editions ?? []).map((e) => pathOf(w.part, e));
  const want = wanted(plan, o.editions);
  // A second stage holds the other editions' summaries of the articles its lists hold: it is kept while they are, and fetched again when any of
  // them is fetched again in this run (they may name other articles) or came after it (a stage that failed after its lists came keeps its old copy,
  // which then covers older lists: the next run brings it), or, as every part, when it is a month old.
  for (const w of want) {
    if (fresh(entry(w)) && listsOf(w).every((l) => files.has(l) && cameAt(l) <= cameAt(w.path))) keepOld(entry(w));
  }
  const todo = want.filter((w) => !files.has(w.path));
  /** @type {Map<string, Failure>} what each file this run didn't get failed with */
  const lost = new Map();
  let total = todo.length + 1; // and finding the guides
  let done = 0;
  const progress = (/** @type {PartRef} */ part) => o.onProgress?.({ done, total, label: partWords(part) });
  /**
   * The parts in a list, in order, each in every edition in the reading order; one this download doesn't get stays as it was, however old. A second
   * stage is left, counted with the failure that gave its source up, when Wikidata or any edition it reads is given up: it is never asked then.
   * @param {Want[]} list
   */
  const fetchParts = async (list) => {
    for (const w of list) {
      if (signal.aborted) break;
      const p = w.part;
      const source = w.editions ? 'wikidata' : w.edition ?? p.kind;
      /** @type {PartRef} */
      const part = { source: w.editions ? 'wikidata' : p.kind, place: p.place };
      const out = (w.editions ? [source, ...w.editions] : [source]).find(gaveUp);
      if (out !== undefined) {
        lost.set(w.path, left(part, out));
        done++;
        continue;
      }
      // A second stage needs every edition's list of its part: one this run didn't get leaves it for the next, counted with that list's failure.
      const gap = listsOf(w).find((l) => lost.has(l));
      if (gap) {
        failed.push(/** @type {Failure} */ ({ ...lost.get(gap), label: partLabel(part), part }));
        done++;
        continue;
      }
      progress(part);
      try {
        // The Overpass servers by the switch as it is now, part by part: turned off, VK's server is asked nothing more.
        const got = p.kind === 'osm' ? await osm(p, ask, () => pause(o.busyMs ?? BUSY_MS, signal), overpassServers(await readAppSettings(ws)), hosts)
          : w.editions ? await more(p, o.editions, (path) => ws.readJSON(scope, path), ask, headers, (host) => fails.set(host, { n: 0 })) : await wikipedia(p, w.edition ?? 'en', ask, headers);
        await save({ ...entry(w), items: got.count, ...(w.edition ? { edition: w.edition } : {}) }, got.content);
        // A second stage's requests start each host's count over as they answer (more); a failure of one counts under that host's own key.
        if (!w.editions) fails.set(source, { n: 0 });
      } catch (e) {
        if (signal.aborted) break;
        lost.set(w.path, failure(part, typeof /** @type {any} */ (e)?.source === 'string' ? /** @type {any} */ (e).source : source, e));
      }
      done++;
    }
    for (const w of list) {
      if (files.has(w.path)) continue;
      if (have.has(w.path)) keepOld(entry(w));
      else if (w.editions) {
        // A stage named by other editions than the pack's (a language added or taken off) has a new file: until it comes, the part's former one
        // stays (it holds what the old set had, and the reader keeps the rows of the editions read), so a run that stops or fails first
        // doesn't lose it. It goes at the download that brings the new one, as a file no longer wanted does.
        for (const path of have.keys()) if (path.startsWith(`${DIR}wikipedia/${w.part.id}.x.`) && !files.has(path)) keepOld({ id: w.part.id, kind: 'wikipedia-editions', path });
      }
    }
  };
  // The quick ones first, a request a second: every Wikipedia part's lists, the stops' and the way's, so the guides read the titles they give; then the
  // guides (they read English's lists alone); then the second stages, which need every list of their part; then what takes long, OpenStreetMap's parts
  // (Overpass answers one in 35 to 54 s: hours for a long trip). At three editions a part is 3 list requests and about 5 for its stage (8 in all: the
  // editions design's count, 2026-11-20); at about 1.4 s a request (the 1 s gap and an answer of 0.2 to 0.56 s) a 105-part trip's lists take about
  // 7 minutes and its stages about 12 more, so the guides come in between: with the stages first, the first guide came 20 minutes in.
  const isList = (/** @type {Want} */ w) => w.part.kind === 'wikipedia' && !w.editions;
  await fetchParts(todo.filter(isList));

  /** @type {Guide[]} */
  const guides = [];
  let guidesDone = false;
  // The traveller's other Wikivoyage editions, each read by the titles English's guides link to; voyage: those this pass asked.
  const others = guideEditions(o.editions).filter((e) => e !== 'en');
  const voyage = ['en'];
  /** Where a guide's text comes from, as a source that can be given up: English Wikivoyage, or another edition's host. @param {string} edition */
  const textSource = (edition) => (edition === 'en' ? 'wikivoyage' : `${edition}.wikivoyage.org`);
  // English Wikivoyage gave up, or the download was stopped.
  const guidesStuck = () => signal.aborted || gaveUp('wikivoyage');
  /**
   * A guide's file in an edition, by its English title and its title there: a fresh one stays; one the pack lacks is left, and counted, when its
   * source is given up, and not asked for once the guides are stuck (a stop makes them so); one not got keeps its old copy. Whether the pack has it now.
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
      const { guides: found, missing } = await findGuides(await namesFor(ws, scope, plan, files), 'en', ask, headers);
      done++;
      /** Adds names to English's guide of that title in `found`, or the guide with them. @param {string} title @param {string[]} names */
      const join = (title, names) => {
        const g = found.find((x) => x.title === title);
        if (g) g.asked.push(...names.filter((n) => !g.asked.includes(n)));
        else if (names.length) found.push({ title, asked: [...new Set(names)] });
      };
      // English turns a name into a place once. A name it has no page for (a disambiguation page is its answer, a list) goes to the traveller's editions
      // in turn while one is left: the first with a page decides, and its link to English is the place (no link, no guide). A failed lookup ends the
      // turn: that edition and those after it stay out of voyage, and the guides the pack had by the names left stay.
      let rest = plan.names.filter((n) => missing.has(n));
      /** @type {Map<string, string[]>} English's titles those pages link to, with the names that led to them */
      const translated = new Map();
      /** @type {Set<string>} the editions asked the names left, or with none left to ask */
      const named = new Set();
      for (const e of others) {
        if (rest.length) {
          if (guidesStuck()) break;
          try {
            const { guides: pages } = await findGuides(rest, e, ask, headers);
            fails.set(textSource(e), { n: 0 });
            for (const g of pages) if (g.en) translated.set(g.en, [...(translated.get(g.en) ?? []), ...g.asked]);
            const settled = new Set(pages.flatMap((g) => g.asked)); // a name that found a page, linked or not, is settled
            rest = rest.filter((n) => !settled.has(n));
          } catch (err) {
            if (signal.aborted) throw err;
            failure({ source: 'wikivoyage' }, textSource(e), err);
            break;
          }
        }
        named.add(e);
      }
      // English's own page for each title they link to (redirects followed, a disambiguation page left out).
      if (translated.size) for (const g of (await findGuides([...translated.keys()], 'en', ask, headers)).guides) join(g.title, g.asked.flatMap((t) => translated.get(t) ?? []));
      if (rest.length && named.size < others.length) for (const g of old?.guides ?? []) join(g.title, g.asked.filter((n) => rest.includes(n)));
      /** @type {Map<string, Map<string, string>>} each other edition's titles by English's, for the editions whose lookup came */
      const linked = new Map();
      for (const e of others) {
        if (guidesStuck()) break;
        try {
          linked.set(e, await linksIn(found.map((g) => g.title), e, ask, headers));
          fails.set('wikivoyage', { n: 0 });
          if (named.has(e)) voyage.push(e);
        } catch (err) {
          if (signal.aborted) throw err;
          failure({ source: 'wikivoyage' }, 'wikivoyage', err);
        }
      }
      total += found.length + [...linked.values()].reduce((n, m) => n + m.size, 0);
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
          if (links) {
            const title = links.get(g.title);
            // The link stays when the text fails: the next download brings the text.
            if (title) {
              await guideIn(g.title, e, title);
              also.push({ edition: e, title });
            }
            continue;
          }
          // Its lookup didn't come: what the pack had of the guide in it stays as it was.
          const was = old?.guides.find((x) => x.path === path)?.also.find((a) => a.edition === e);
          if (!was) continue;
          const kept = guideFile(g.title, e);
          if (have.has(kept.path) && !files.has(kept.path)) keepOld({ ...kept, kind: 'wikivoyage' }, 1);
          also.push(was);
        }
        guides.push({ ...g, path, also });
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
      for (const h of heldIn(g)) if (!files.has(h.path) && have.has(h.path)) keepOld({ id: idOf(h.path), kind: 'wikivoyage', path: h.path }, 1);
      guides.push(g);
    }
  }
  await fetchParts(todo.filter((w) => w.editions));
  await fetchParts(todo.filter((w) => w.part.kind === 'osm'));
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

/** An edition's nearest summaries to a part's point, with ids: as many as one request gives (SUMMARIES_PER_ASK). @param {import('./plan.js').WikiPart} p @param {string} edition @param {Ask} ask @param {Record<string, string>} headers */
async function wikipedia(p, edition, ask, headers) {
  /* en */ const where = edition === 'en' ? 'Wikipedia' : `${edition}.wikipedia.org`;
  const r = await ask(nearUrl(edition, p.at, WIKI_RADIUS_M, SUMMARIES_PER_ASK, { extracts: true }), { headers }, where);
  const info = wikiSaid(r);
  if (info) throw fault(/* en */ `${where} said: ${info}.`, { code: 'said', where, info });
  const pages = articlesOf(r, edition).map((a) => [a.title, r4(a.lat), r4(a.lng), a.summary, a.id]);
  return { count: pages.length, content: { at: p.at, radius: WIKI_RADIUS_M, pages } };
}

/**
 * A Wikipedia part's second stage: for each article its editions' lists hold (by Wikidata id; a row with none is its edition's alone), each
 * edition's summary that edition's list lacks: Wikidata says which editions have each item and its title there (TITLES_PER_ASK ids a request),
 * then each edition is asked by those titles (SUMMARIES_PER_ASK a request). An edition's list holds only its own nearest 20, so the lists alone
 * leave most articles in one edition (Tokyo Station: 2 of 38 in ja and en; the editions design, 2026-11-20). Rows as a list's, with the
 * edition: [title, lat, lng, summary, id, edition], at the place the lists give the item. Any request that fails fails the stage: no file. Each
 * request counts under its own host, as a list's does ('wikidata', or the edition's label): an answer starts that host's count over (`up`), and a
 * failure carries its host as `source`.
 * @param {import('./plan.js').WikiPart} p @param {string[]} editions the reading order's @param {(path: string) => Promise<any>} read
 * @param {Ask} ask @param {Record<string, string>} headers @param {(source: string) => void} up
 */
async function more(p, editions, read, ask, headers, up) {
  /**
   * One request to a host, its answer read as an answer annai can use.
   * @param {string} source @param {string} url @param {string} where
   */
  const from = async (source, url, where) => {
    try {
      const r = await ask(url, { headers }, where);
      const info = wikiSaid(r);
      if (info) throw fault(/* en */ `${where} said: ${info}.`, { code: 'said', where, info });
      up(source);
      return r;
    } catch (e) {
      throw Object.assign(/** @type {any} */ (e), { source });
    }
  };
  /** @type {Map<string, { lat: number, lng: number, has: Set<string> }>} each item the lists hold: where, and the editions whose list holds it */
  const items = new Map();
  for (const e of editions) {
    const v = await read(pathOf(p, e)).catch(() => null);
    for (const r of Array.isArray(v?.pages) ? v.pages : []) {
      if (!Array.isArray(r) || typeof r[4] !== 'string' || !r[4] || !isNum(r[1]) || !isNum(r[2])) continue;
      const item = items.get(r[4]) ?? { lat: r[1], lng: r[2], has: new Set() };
      item.has.add(e);
      items.set(r[4], item);
    }
  }
  /** @type {Map<string, Map<string, string>>} */
  const titles = new Map();
  const ids = [...items.keys()];
  for (let i = 0; i < ids.length; i += TITLES_PER_ASK) {
    const r = await from('wikidata', sitelinksUrl(ids.slice(i, i + TITLES_PER_ASK), editions), /* en */ 'Wikidata');
    for (const [id, t] of titlesOf(r, editions)) titles.set(id, t);
  }
  /** @type {[string, number, number, string, string, string][]} */
  const rows = [];
  for (const e of editions) {
    /* en */ const where = e === 'en' ? 'Wikipedia' : `${e}.wikipedia.org`;
    /** @type {Map<string, string>} the titles to ask this edition for, each to its item */
    const wants = new Map();
    for (const [id, item] of items) {
      const title = titles.get(id)?.get(e);
      if (title && !item.has.has(e)) wants.set(title, id);
    }
    const asked = new Set(wants.values());
    const names = [...wants.keys()];
    for (let i = 0; i < names.length; i += SUMMARIES_PER_ASK) {
      const r = await from(e, summariesUrl(e, names.slice(i, i + SUMMARIES_PER_ASK)), where);
      for (const g of Array.isArray(r?.query?.pages) ? r.query.pages : []) {
        // By the item it is: a title that now leads to another item's article is not this one's.
        const id = g?.pageprops?.wikibase_item;
        const item = items.get(id);
        if (typeof g?.title !== 'string' || !item || !asked.delete(id)) continue;
        rows.push([g.title, item.lat, item.lng, typeof g.extract === 'string' ? g.extract.trim() : '', id, e]);
      }
    }
  }
  return { count: rows.length, content: { at: p.at, pages: rows } };
}

/**
 * The names to look for in English Wikivoyage: the plan's (the trip's places, then the stops: every one), then the titles of the English
 * Wikipedia articles in English's lists, nearest first (the second stages' English rows, which come after the guides, are not read). No bound on them: a part holds 20 at most, so 240 stops are 4,800 titles, 96 requests, about
 * two minutes against hours of Overpass; and they reach guides the names don't (2026-11-20, five made-up stops at real hotels and lodges, 10 km:
 * one lodge's titles lead to a region's guide, one hotel's to a city's, the stops' own names to none).
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
 * Which names have a guide in an edition of Wikivoyage, in their order (redirects followed, variants converted, disambiguation pages left out), and
 * which have no page at all (a disambiguation page is not none: the edition lists the name as several places). In another edition each guide has
 * `en` too, English's page it links to. Only names are sent.
 * @param {string[]} names @param {string} edition @param {Ask} ask @param {Record<string, string>} headers
 * @returns {Promise<{ guides: { title: string, asked: string[], en?: string }[], missing: Set<string> }>}
 */
async function findGuides(names, edition, ask, headers) {
  const where = voyageWhere(edition);
  const candidates = [...new Set(names.flatMap(guideTitles))];
  /** @type {Map<string, string | null>} what each candidate leads to */
  const resolved = new Map();
  /** @type {Set<string>} the candidates that lead to a disambiguation page */
  const lists = new Set();
  /** @type {Map<string, string>} each page's English title (another edition's) */
  const english = new Map();
  // Another edition's pages come with their link to English (one at most, so an answer is never continued, as linksIn's).
  const props = edition === 'en' ? 'pageprops' : `pageprops%7Clanglinks&lllang=en&lllimit=${TITLES_PER_ASK}`;
  for (let i = 0; i < candidates.length; i += TITLES_PER_ASK) {
    const batch = candidates.slice(i, i + TITLES_PER_ASK);
    /* en */ const r = await ask(`${voyageApi(edition)}?action=query&format=json&formatversion=2&origin=*&redirects=1&converttitles=1&prop=${props}&ppprop=disambiguation&titles=${encodeURIComponent(batch.join('|'))}`, { headers }, where);
    const info = wikiSaid(r);
    if (info) throw fault(/* en */ `${where} said: ${info}.`, { code: 'said', where, info });
    const q = r?.query ?? {};
    const steps = new Map([...(Array.isArray(q.normalized) ? q.normalized : []), ...(Array.isArray(q.converted) ? q.converted : []), ...(Array.isArray(q.redirects) ? q.redirects : [])]
      .filter((x) => typeof x?.from === 'string' && typeof x?.to === 'string').map((x) => [x.from, x.to]));
    const pages = (Array.isArray(q.pages) ? q.pages : []).filter((p) => typeof p?.title === 'string' && !p.missing && !p.invalid);
    const ambiguous = new Set(pages.filter((p) => p.pageprops && typeof p.pageprops === 'object' && 'disambiguation' in p.pageprops).map((p) => p.title));
    const ok = new Set(pages.map((p) => p.title).filter((t) => !ambiguous.has(t)));
    for (const p of pages) {
      const link = (Array.isArray(p.langlinks) ? p.langlinks : []).find((/** @type {any} */ l) => l?.lang === 'en' && typeof l.title === 'string' && l.title);
      if (link) english.set(p.title, link.title);
    }
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
  const missing = new Set();
  for (const n of names) {
    const t = guideTitles(n).map((c) => resolved.get(c)).find((x) => typeof x === 'string');
    if (!t) {
      if (!guideTitles(n).some((c) => lists.has(c))) missing.add(n);
      continue;
    }
    if (!guides.has(t)) guides.set(t, new Set());
    guides.get(t)?.add(n);
  }
  return { guides: [...guides].map(([title, asked]) => ({ title, asked: [...asked], ...(english.has(title) ? { en: english.get(title) } : {}) })), missing };
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
  if (typeof text !== 'string' || !text.trim()) throw fault(/* en */ `${where} sent no text for ${title}.`, { code: 'no-text', where, title });
  return text;
}
