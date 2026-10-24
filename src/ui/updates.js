import { checkPlugins, knownUpdates, offerCard } from './plugin-updates.js';
import { t } from './dom.js';

/**
 * Updates (spec §5.3, §17 rule 5), annai's and its plugins'. An iPhone Home Screen app that comes back from
 * the background only resumes, and the browser checks nothing then: annai checks at start, on coming back to
 * the screen, once a day, and on Check now, never offline. Checking isn't installing: what it finds waits
 * for a tap, and a restart waits for Shiori's turn to end.
 * @typedef {import('./plugin-updates.js').Update} Update
 * @typedef {{ offline?: boolean, failed: string[], found: Update[] }} Result
 * @typedef {{ app?: boolean, official?: boolean, address?: boolean, manual?: boolean }} Kinds
 */

/** Coming back checks annai and its official plugins at most this often, and plugins from an address daily. */
export const SOON = 15 * 60_000;
export const DAILY = 24 * 60 * 60_000;

export class Updates {
  /** annai's own, once its service worker is registered. @type {{ check: () => Promise<unknown>, state: () => 'none' | 'downloading' } | null} */
  app = null;
  /** Restarts into the version that waits. @type {(() => void) | null} */
  #swap = null;
  /** @type {Result | null} */
  last = null;
  /** When a check last reached the network. @type {number | null} */
  checkedAt = null;
  /** @type {any} */
  notices = null;
  /** @type {{ busy: boolean, idle: () => Promise<void> } | null} */
  agent = null;
  /** A tap's sound unlock, which nothing a tap starts may outrun. @type {{ settled: () => Promise<void> } | null} */
  voice = null;
  /** A check started or ended; waits: what waits changed too. @type {(waits: boolean) => void} */
  changed = () => {};
  #at = -Infinity;
  #addressAt = -Infinity;
  #started = false;
  /** @type {Promise<Result> | null} */
  #running = null;
  /** @type {Promise<boolean> | null} */
  #restarting = null;
  /** The restart asked for: Don't restart, or its swap, ends it. @type {object | null} */
  #asked = null;
  /** Counts checks: one given up on writes nothing if it answers late. */
  #gen = 0;
  /** What a card offered already, by id and version. */
  #offered = new Set();
  /** What the last check found, and whether this one changed it. */
  #found = '';
  #moved = false;
  /** @type {(() => void) | null} */
  #card = null;

  /** limitMs: a check that hangs on a stalled connection ends then. @param {{ host: any, env?: import('./plugin-updates.js').Env, now?: () => number, online?: () => boolean, reload?: () => void, limitMs?: number }} o */
  constructor({ host, env = {}, now = () => Date.now(), online = () => navigator.onLine !== false, reload = () => location.reload(), limitMs = 45_000 }) {
    this.host = host;
    this.limitMs = limitMs;
    this.env = env;
    this.now = now;
    this.online = online;
    this.reload = reload;
  }

  get checking() {
    return this.#running !== null;
  }

  /** A new version of annai waits. */
  get waiting() {
    return this.#swap !== null;
  }

  /** @returns {Promise<Update[]>} */
  plugins() {
    return knownUpdates(this.host);
  }

  /** A new version of annai has installed: swap restarts into it. @param {() => void} swap */
  ready(swap) {
    this.#swap = swap;
    this.changed(true);
  }

  /** At start: plugins of both kinds. The browser checks annai itself as it opens the page. */
  start() {
    this.#started = true;
    return this.#check({ official: true, address: true }, this.now());
  }

  /** Coming back, or a day on: whatever is due. @returns {Promise<Result | null>} */
  async auto() {
    const now = this.now();
    const soon = now - this.#at >= SOON;
    const address = now - this.#addressAt >= DAILY;
    if (!this.#started || this.#running || (!soon && !address)) return null;
    return this.#check({ app: soon, official: soon, address }, now);
  }

  /** Check now: annai and every plugin, address ones too. */
  async checkNow() {
    await this.voice?.settled();
    while (this.#running) await this.#running;
    return this.#check({ app: true, official: true, address: true, manual: true }, this.now());
  }

  /** @param {Kinds} what @param {number} at */
  #check(what, at) {
    if (!this.online()) {
      this.last = { offline: true, failed: [], found: [] };
      this.changed(false);
      return Promise.resolve(this.last);
    }
    if (what.app || what.official) this.#at = at;
    if (what.address) this.#addressAt = at;
    const gen = ++this.#gen;
    /** @type {any} */
    let timer;
    /** @type {Promise<Result>} */
    const slow = new Promise((r) => {
      timer = setTimeout(() => {
        this.#gen++;
        r((this.last = { failed: [t`The check took too long. Check the connection, and try again.`], found: this.last?.found ?? [] }));
      }, this.limitMs);
    });
    const run = Promise.race([this.#run(what, gen), slow]).finally(() => {
      clearTimeout(timer);
      this.#running = null;
      this.changed(this.#moved);
    });
    this.#running = run;
    this.changed(false);
    return run;
  }

  /** @param {Kinds} what @param {number} gen @returns {Promise<Result>} */
  async #run(what, gen) {
    /** @type {string[]} */
    const failed = [];
    if (what.app) {
      if (!this.app) failed.push(t`annai's offline service hasn't started yet, so annai itself wasn't checked. Try again in a moment.`);
      else await this.app.check().catch(() => failed.push(t`annai couldn't check for a new version of itself. Check the connection and try again.`));
    }
    const current = () => gen === this.#gen;
    const plugins = await checkPlugins(this.host, this.env, what, current);
    if (!current()) return /** @type {Result} */ (this.last);
    this.checkedAt = this.now();
    this.last = { failed: [...failed, ...plugins.failed], found: plugins.found };
    this.#offer(plugins.found, Boolean(what.manual));
    return this.last;
  }

  /** New updates get one card, in place of the last; Check now's show where it was tapped. @param {Update[]} found @param {boolean} manual */
  #offer(found, manual) {
    const key = (/** @type {Update} */ u) => `${u.id} ${u.available} ${u.url ?? ''}`;
    const keys = found.map(key).join('\n');
    this.#moved = keys !== this.#found;
    this.#found = keys;
    const fresh = found.some((u) => !this.#offered.has(key(u)));
    for (const u of found) this.#offered.add(key(u));
    if (!fresh || manual || !this.notices) return;
    this.#card?.();
    this.#card = offerCard({ plugins: this.host, notices: this.notices }, found, { ...this.env, reload: () => this.restart(), applied: () => this.changed(true) });
  }

  /** The new version found didn't finish downloading: said, and "It is downloading" goes. */
  downloadFailed() {
    this.last = { failed: [t`The download of the new version didn't finish. annai tries again the next time it checks.`], found: this.last?.found ?? [] };
    this.changed(false);
  }

  /** Restarts annai, into the version that waits if one does, once Shiori's turn is over and a tap's unlock settled. Says whether it did (not if called off). @returns {Promise<boolean>} */
  restart() {
    this.#restarting ??= this.#restartOnce({});
    return this.#restarting;
  }

  /** @param {object} me */
  async #restartOnce(me) {
    this.#asked = me;
    const off = () => this.#asked !== me;
    try {
      if (this.agent?.busy) {
        this.notices?.card({
          title: t`annai restarts once Shiori has finished`, body: t`She is in the middle of something, and an update never lands during her turn. Tap her to stop her now.`,
          actions: [{ label: t`Don't restart`, run: () => { this.#asked = this.#restarting = null; this.changed(false); } }],
        });
        while (this.agent.busy && !off()) await this.agent.idle();
      }
      await this.voice?.settled();
      if (off()) return false;
      (this.#swap ?? this.reload)();
      return true;
    } finally {
      if (!off()) this.#asked = this.#restarting = null;
    }
  }
}
