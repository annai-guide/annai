import { planFor, estimate, likelyGuides } from './plan.js';
import { downloadPack, readManifest, wanted, lacksIds, saysDown, DIR, MANIFEST, STALE_MS } from './download.js';
import { loadPack } from './read.js';
import { tracedFetch } from '../agent/net.js';
import { logEvent } from '../events.js';
import { PLAN_FILE } from '../plan.js';
import { APP } from '../settings.js';
import { SYS_SETTINGS } from '../scopes.js';
import { readingEditions, guideEditions } from '../wiki.js';

/**
 * Keeps each trip's offline pack (spec §11.5): what it holds and would take, downloading it when
 * asked, and, once a trip has one, bringing it up to date by itself on Wi-Fi while annai and that
 * trip are open ("whenever the phone is on Wi-Fi"): when the plan changed, the run was stopped, a source was down, a guide edition or a part is
 * missing, or it is a month old (but not after an answer annai can't use: that waits for Try again); by itself at most once an hour from the
 * start of any run, and the traveller's own Stop holds an hour. It names places from the open trip's pack for live mode, in the editions the
 * traveller's languages read.
 * @typedef {import('./download.js').Manifest} Manifest
 * @typedef {import('./download.js').Progress} Progress
 * @typedef {'plan' | 'missing' | 'old' | null} Why
 * @typedef {{ stops: number, manifest: Manifest | null, why: Why, byItself: boolean, estimate: number, running: (Progress & { scope: string }) | null }} PackStatus
 *   why: what an update would bring (null: nothing, or no pack yet); byItself: whether annai brings it by itself on Wi-Fi, or waits for the
 *   traveller's Try again; estimate: about how many bytes downloading takes now (spec §11.5: shown before downloading)
 */

/** By itself, annai waits for the plan to be quiet this long before it updates the pack. */
export const QUIET_MS = 60_000;
const POKE_MS = 2000;
const AUTO_EVERY_MS = 3_600_000;

export class PackKeeper {
  /** @type {(Progress & { scope: string }) | null} */
  running = null;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {Promise<Manifest> | null} */
  #job = null;
  /** The download that runs is one annai began by itself, which keeps to Wi-Fi: poke() stops it when the phone leaves Wi-Fi; a tap on Download makes it the traveller's. */
  #byItself = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} the one next look at the pack, due at #due (Date.now()'s ms) */
  #timer;
  #due = 0;
  /** When the plan last changed: a look waits until it has been quiet. */
  #changedAt = 0;
  /** @type {Map<string, number>} when annai last updated each trip's pack by itself */
  #autoAt = new Map();
  /** The plan changed while a download ran: look again once it ends, past the hourly gate. */
  #again = false;
  /** @type {{ pack: import('./read.js').Pack, editions: string[] } | null} the open trip's pack, for names */
  #named = null;
  /** @type {string | undefined} the editions the languages read as last seen: a settings write that leaves them as they are changes nothing here */
  #seen;
  /** @type {(() => unknown)[]} */
  #offs;

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace,
   *   agent: { target: string | null, on: (kind: 'open', fn: () => void) => () => unknown },
   *   version: string, locale: string, connection: () => string, visible?: () => boolean, fetch?: import('./download.js').Fetch,
   *   quietMs?: number, pokeMs?: number, autoMs?: number, gapMs?: number, now?: () => number }} o
   *   locale: the phone's; connection: 'wifi', 'cellular', 'unknown' or 'offline' (ui/platform.js connectionOf); fetch: for tests, instead of the traced one;
   *   autoMs: the hour between updates by itself, for tests
   */
  constructor(o) {
    this.o = o;
    this.#offs = [o.ws.onChange((c) => this.#changed(c)), o.agent.on('open', () => this.#opened())];
    this.#loadNames();
    this.#editions().then((e) => {
      this.#seen ??= e.join(' ');
    }, () => {});
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #editions() {
    return readingEditions(this.o.ws, this.o.locale);
  }

  /** What a trip's pack has, and what downloading would take now. @param {string} scope @returns {Promise<PackStatus>} */
  async status(scope) {
    const { ws } = this.o;
    const now = (this.o.now ?? Date.now)();
    const plan = await planFor(ws, scope);
    const manifest = await readManifest(ws, scope);
    const have = new Set((await ws.list(scope, DIR)).map((f) => f.path));
    const editions = await this.#editions();
    const want = wanted(plan, editions);
    const kept = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
    // A file the manifest doesn't name is missing too: a download that stopped before its manifest left it.
    const missing = want.filter((w) => !have.has(w.path) || !kept.has(w.path) || lacksIds(kept.get(w.path), editions));
    // The traveller's guide editions its guides weren't looked for in (a language added since, or a pack from before Wikivoyage's editions):
    // missing too. The guides it has in English stay, and are not downloaded again.
    const voyage = guideEditions(editions);
    const lacking = manifest ? voyage.filter((e) => !manifest.voyage.includes(e)) : voyage;
    // Old by its oldest part: an update that brought only what the plan changed leaves the rest as old as it was.
    const oldest = manifest ? Math.min(Date.parse(manifest.at), ...manifest.files.map((f) => f.at || Infinity)) : NaN;
    const old = manifest !== null && !(now - oldest <= STALE_MS);
    /** @type {Why} */
    const why = !manifest ? null
      : manifest.key !== plan.key ? 'plan'
        : missing.length || lacking.length || manifest.failed.length || manifest.stopped ? 'missing'
          : old ? 'old' : null;
    // Whether annai brings it by itself, for the hourly retry and every look alike: the plan changed, the pack is old ('missing' comes first
    // above), the run was stopped, a source was down, an edition is lacking, or a part is missing that no failure accounts for (a language
    // added; the count is of the parts' failures). Failures that are answers annai can't use (Overpass stopping early, no text) would only fail
    // again: they wait for Try again.
    const byItself = manifest !== null && why !== null
      && (why === 'plan' || old || manifest.stopped || lacking.length > 0 || manifest.failed.some(saysDown) || missing.length > manifest.failed.filter((f) => f.part && 'place' in f.part).length);
    // What downloading brings now: the files it lacks, and its guides in the editions it lacks (with no guides yet, those it would likely get).
    const needed = manifest?.guides.length ? estimate(missing, manifest.guides.length, lacking) : estimate(missing, likelyGuides(plan), voyage);
    return {
      stops: plan.stops.length, manifest, why, byItself,
      estimate: why === 'old' ? estimate(want, likelyGuides(plan), voyage) : needed,
      running: this.running?.scope === scope ? this.running : null,
    };
  }

  /**
   * Downloads a trip's pack: what it lacks, and what is a month old. One download at a time: a
   * second call while one runs gets that one.
   * @param {string} scope @param {{ auto?: boolean }} [o] auto: annai started it by itself
   * @returns {Promise<Manifest>}
   */
  download(scope, { auto = false } = {}) {
    if (this.#job) {
      if (!auto) this.#byItself = false;
      return this.#job;
    }
    const { store, ws, version } = this.o;
    const abort = new AbortController();
    this.#abort = abort;
    this.#byItself = auto;
    // The hour counts from the start of any run, the traveller's too.
    this.#autoAt.set(scope, (this.o.now ?? Date.now)());
    this.running = { scope, done: 0, total: 0, label: '' };
    this.#emit();
    this.#job = this.#editions().then((editions) => downloadPack({
      ws, scope, version, editions, signal: abort.signal, gapMs: this.o.gapMs, now: this.o.now,
      fetch: this.o.fetch ?? tracedFetch(store, scope, { tool: 'offline-pack' }),
      onProgress: (p) => {
        this.running = { scope, ...p };
        this.#emit();
      },
    })).then(async (m) => {
      const data = { files: m.files.length, bytes: m.bytes, guides: m.guides.length, failed: m.failed.length, stopped: m.stopped, auto };
      await logEvent(store, scope, { type: 'pack.download', actor: 'system', data }).catch(() => {});
      return m;
    }).finally(() => {
      this.#job = null;
      this.#abort = null;
      this.running = null;
      this.#emit();
      // What changed during it waits for no hourly gate: this download's own start doesn't count against it.
      if (this.#again) this.#autoAt.delete(scope);
      this.#again = false;
      // A look that fell on it was lost, and what annai may still bring by itself is tried again an hour on, by the same rule as any look.
      this.poke();
    });
    return this.#job;
  }

  /** Stops the download that is running; what came stays. Settles once it has ended, its manifest written. The traveller's Stop holds automatic runs an hour: a phone on a friend's hotspot says Wi-Fi. */
  async stop() {
    if (this.running && !this.#byItself) this.#autoAt.set(this.running.scope, (this.o.now ?? Date.now)());
    this.#abort?.abort();
    await this.#job?.catch(() => {});
  }

  /**
   * The connection or the screen changed: maybe the open trip's pack can be brought up to date; and a download annai began by itself stops
   * when the phone is off Wi-Fi (what came stays, the next look on Wi-Fi goes on): nothing else bounds one that runs over mobile data.
   */
  poke() {
    // A look while the stopped run winds down is lost (#auto returns while #job is set): look again once it has ended.
    if (this.#job && this.#byItself && this.o.connection() !== 'wifi') this.stop().then(() => this.poke(), () => {});
    this.#schedule(this.o.pokeMs ?? POKE_MS);
  }

  /** The nearest place the open trip's pack names within 500 m, for live mode. @param {{ lat: number, lng: number }} p */
  name(p) {
    return this.#named?.pack.name(p, this.#named.editions) ?? null;
  }

  dispose() {
    clearTimeout(this.#timer);
    this.stop().catch(() => {});
    for (const off of this.#offs) off();
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch {
        // a listener that fails changes nothing here
      }
    }
  }

  #opened() {
    // Another trip, or none (this one was removed): its download stops.
    if (this.running && this.running.scope !== this.o.agent.target) this.stop().catch(() => {});
    this.#loadNames();
    this.poke();
  }

  /** @param {{ scope: string, path: string }} c */
  #changed(c) {
    // The languages (app settings) change the names and may need another edition's files: looked at when the editions changed.
    if (c.scope === SYS_SETTINGS && c.path === APP) {
      this.#loadNames();
      this.#editions().then((editions) => {
        const now = editions.join(' ');
        if (now !== this.#seen) this.#planChanged();
        this.#seen = now;
      }, () => {});
      return;
    }
    if (c.scope !== this.o.agent.target) return;
    if (c.path === MANIFEST) this.#loadNames();
    else if (PLAN_FILE.test(c.path) || c.path === '/trip.json') this.#planChanged();
  }

  #planChanged() {
    this.#changedAt = Date.now();
    if (this.#job) this.#again = true; // a change in the middle of a download: looked at when it ends
    this.#schedule(this.o.quietMs ?? QUIET_MS);
  }

  #loadNames() {
    const trip = this.o.agent.target;
    Promise.all([loadPack(this.o.ws, trip), this.#editions()]).then(([pack, editions]) => {
      if (this.o.agent.target === trip) this.#named = pack && { pack, editions };
    }, () => {});
  }

  /** Proposes a look at the pack in ms; the earliest proposed stands, and #auto sets it later when it is too early. @param {number} ms */
  #schedule(ms) {
    const at = Date.now() + ms;
    if (this.#timer && this.#due <= at) return;
    clearTimeout(this.#timer);
    this.#due = at;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#auto().catch(() => {});
    }, ms);
  }

  async #auto() {
    const scope = this.o.agent.target;
    const now = (this.o.now ?? Date.now)();
    if (!scope || this.#job || this.o.connection() !== 'wifi' || !(this.o.visible?.() ?? true)) return;
    const s = await this.status(scope);
    if (!s.manifest || !s.why || !s.byItself) return;
    // Too early (the plan is still changing, or the hour isn't out): looked at then.
    const every = this.o.autoMs ?? AUTO_EVERY_MS;
    const wait = Math.max((this.o.quietMs ?? QUIET_MS) - (Date.now() - this.#changedAt), every - (now - (this.#autoAt.get(scope) ?? -Infinity)));
    if (wait > 0) return this.#schedule(wait);
    await this.download(scope, { auto: true });
  }
}
