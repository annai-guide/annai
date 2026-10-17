import { planFor, estimate, likelyGuides } from './plan.js';
import { downloadPack, readManifest, pathOf, DIR, MANIFEST, STALE_MS } from './download.js';
import { loadPack } from './read.js';
import { tracedFetch } from '../agent/net.js';
import { logEvent } from '../events.js';
import { PLAN_FILE } from '../plan.js';

/**
 * Keeps each trip's offline pack (spec §11.5): what it holds and would take, downloading it when
 * asked, and, once a trip has one, bringing it up to date by itself on Wi-Fi while annai and that
 * trip are open ("whenever the phone is on Wi-Fi"): when the plan changed, parts are missing, or it
 * is a month old; by itself at most once an hour. It names places from the open trip's pack for
 * live mode (choice 7).
 * @typedef {import('./download.js').Manifest} Manifest
 * @typedef {import('./download.js').Progress} Progress
 * @typedef {'plan' | 'missing' | 'old' | null} Why
 * @typedef {{ stops: number, cut: number, manifest: Manifest | null, why: Why, estimate: number, running: (Progress & { scope: string }) | null }} PackStatus
 *   why: what an update would bring (null: nothing, or no pack yet); estimate: about how many bytes
 *   downloading takes now (spec §11.5: shown before downloading)
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
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** @type {Map<string, number>} when annai last updated each trip's pack by itself */
  #autoAt = new Map();
  /** The plan changed (or the connection came) while a download ran: look again once it ends. */
  #again = false;
  /** @type {import('./read.js').Pack | null} the open trip's pack, for names */
  #named = null;
  /** @type {(() => unknown)[]} */
  #offs;

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace,
   *   agent: { target: string | null, on: (kind: 'open', fn: () => void) => () => unknown },
   *   version: string, connection: () => string, visible?: () => boolean, fetch?: import('./download.js').Fetch,
   *   quietMs?: number, pokeMs?: number, gapMs?: number, now?: () => number, maxBytes?: number }} o
   *   connection: 'wifi', 'cellular', 'unknown' or 'offline' (ui/platform.js connectionOf); fetch: for tests, instead of the traced one
   */
  constructor(o) {
    this.o = o;
    this.#offs = [o.ws.onChange((c) => this.#changed(c)), o.agent.on('open', () => this.#opened())];
    this.#loadNames();
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** What a trip's pack has, and what downloading would take now. @param {string} scope @returns {Promise<PackStatus>} */
  async status(scope) {
    const { ws } = this.o;
    const now = (this.o.now ?? Date.now)();
    const plan = await planFor(ws, scope);
    const manifest = await readManifest(ws, scope);
    const have = new Set((await ws.list(scope, DIR)).map((f) => f.path));
    const missing = plan.parts.filter((p) => !have.has(pathOf(p)));
    // Old by its oldest part: an update that brought only what the plan changed leaves the rest as old as it was.
    const oldest = manifest ? Math.min(Date.parse(manifest.at), ...manifest.files.map((f) => f.at || Infinity)) : NaN;
    const old = manifest !== null && !(now - oldest <= STALE_MS);
    /** @type {Why} */
    // A pack that reached its size limit holds all of its plan it can: the rest is no more to come (until it is old).
    const why = !manifest ? null
      : manifest.key !== plan.key ? 'plan'
        : !manifest.full && (missing.length || manifest.failed.length || manifest.stopped) ? 'missing'
          : old ? 'old' : null;
    const guides = manifest?.guides.length ? 0 : likelyGuides(plan);
    return {
      stops: plan.stops.length, cut: plan.cut, manifest, why,
      estimate: why === 'old' ? estimate(plan.parts, likelyGuides(plan)) : estimate(missing, guides),
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
    if (this.#job) return this.#job;
    const { store, ws, version } = this.o;
    const abort = new AbortController();
    this.#abort = abort;
    this.running = { scope, done: 0, total: 0, label: '' };
    this.#emit();
    this.#job = downloadPack({
      ws, scope, version, signal: abort.signal, gapMs: this.o.gapMs, now: this.o.now, maxBytes: this.o.maxBytes,
      fetch: this.o.fetch ?? tracedFetch(store, scope, { tool: 'offline-pack' }),
      onProgress: (p) => {
        this.running = { scope, ...p };
        this.#emit();
      },
    }).then(async (m) => {
      const data = { files: m.files.length, bytes: m.bytes, guides: m.guides.length, failed: m.failed.length, stopped: m.stopped, full: m.full, auto };
      await logEvent(store, scope, { type: 'pack.download', actor: 'system', data }).catch(() => {});
      return m;
    }).finally(() => {
      this.#job = null;
      this.#abort = null;
      this.running = null;
      this.#emit();
      if (this.#again) this.poke();
      this.#again = false;
    });
    return this.#job;
  }

  /** Stops the download that is running; what came stays. Settles once it has ended, its manifest written. */
  async stop() {
    this.#abort?.abort();
    await this.#job?.catch(() => {});
  }

  /** The connection or the screen changed: maybe the open trip's pack can be brought up to date. */
  poke() {
    this.#schedule(this.o.pokeMs ?? POKE_MS);
  }

  /** The nearest place the open trip's pack names within 500 m, for live mode. @param {{ lat: number, lng: number }} p */
  name(p) {
    return this.#named?.name(p) ?? null;
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
    // Another trip, or none (this one was removed): its download stops (choice 10).
    if (this.running && this.running.scope !== this.o.agent.target) this.stop().catch(() => {});
    this.#loadNames();
    this.poke();
  }

  /** @param {{ scope: string, path: string }} c */
  #changed(c) {
    if (c.scope !== this.o.agent.target) return;
    if (c.path === MANIFEST) this.#loadNames();
    else if (PLAN_FILE.test(c.path) || c.path === '/trip.json') this.#schedule(this.o.quietMs ?? QUIET_MS);
  }

  #loadNames() {
    const trip = this.o.agent.target;
    loadPack(this.o.ws, trip).then((pack) => {
      if (this.o.agent.target === trip) this.#named = pack;
    }, () => {});
  }

  /** @param {number} ms */
  #schedule(ms) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#auto().catch(() => {});
    }, ms);
  }

  async #auto() {
    const scope = this.o.agent.target;
    const now = (this.o.now ?? Date.now)();
    if (this.#job) this.#again = true; // a plan change in the middle of a download: looked at when it ends
    if (!scope || this.#job || this.o.connection() !== 'wifi' || !(this.o.visible?.() ?? true)) return;
    if (now - (this.#autoAt.get(scope) ?? -Infinity) < AUTO_EVERY_MS) return;
    const s = await this.status(scope);
    if (!s.manifest || !s.why) return;
    this.#autoAt.set(scope, now);
    await this.download(scope, { auto: true });
  }
}
