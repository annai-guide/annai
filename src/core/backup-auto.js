import { SYS, SYS_DEVICE } from './scopes.js';

/**
 * Automatic backups (spec §12.4): daily or after changes, while on Wi-Fi with the app open. Only
 * when something changed; never while changes are still coming in; and on a connection the browser
 * doesn't name (Safari), only small ones without asking.
 * @typedef {import('./backup-targets.js').Target} Target
 * @typedef {import('./backup.js').Backups} Backups
 * @typedef {import('./types.js').Store} Store
 * @typedef {'wifi' | 'cellular' | 'unknown' | 'offline'} Connection
 *   wifi: Wi-Fi or a cable; cellular: mobile data, or the user asked to save data; unknown: the browser doesn't say
 * @typedef {{ tickMs: number, quietMs: number, askAbove: number,
 *   gapMs: { tree: { changes: number, daily: number }, file: { changes: number, daily: number } } }} Timings
 *   tickMs: how often annai looks; quietMs: how long after the last change it waits; askAbove: the bytes it
 *   sends on an unnamed connection without asking; gapMs: the least time between backups to a place
 */

const HOUR = 3_600_000;

/** @type {Timings} */
export const TIMINGS = Object.freeze({
  tickMs: 60_000,
  quietMs: 2 * 60_000,
  askAbove: 25 * 1024 * 1024,
  gapMs: Object.freeze({ tree: Object.freeze({ changes: HOUR, daily: 24 * HOUR }), file: Object.freeze({ changes: 6 * HOUR, daily: 24 * HOUR }) }),
});

/**
 * Whether anything a backup holds changed after the one whose log positions are seqs, and when the
 * latest change was. The system log and this device's own scope don't count: a backup's own trace
 * and its own notes would otherwise call for the next backup.
 * @param {Store} store @param {Record<string, number> | null} seqs null: never backed up
 * @returns {Promise<{ changed: boolean, lastChangeAt: number | null }>}
 */
export function changedSince(store, seqs) {
  return store.tx(['scopes', 'events'], 'readonly', async (t) => {
    const counted = (/** @type {string} */ id) => id !== SYS && id !== SYS_DEVICE;
    const scopes = (await t.listScopes()).filter((s) => counted(s.id));
    let changed = !seqs;
    /** @type {number | null} */
    let lastChangeAt = null;
    for (const s of scopes) {
      const [e] = await t.listEvents(s.id, { reverse: true, limit: 1 });
      if (e && e.seq > (seqs?.[s.id] ?? 0)) {
        changed = true;
        lastChangeAt = Math.max(lastChangeAt ?? 0, e.ts);
      }
    }
    const here = new Set(scopes.map((s) => s.id));
    if (seqs && Object.keys(seqs).some((id) => counted(id) && !here.has(id))) changed = true; // a trip removed since
    return { changed, lastChangeAt };
  });
}

/**
 * Whether a place is due for an automatic backup now, and how much it may upload without asking.
 * @param {Target} t @param {'tree' | 'file'} stores
 * @param {{ now: number, visible: boolean, connection: Connection, changed: boolean, lastChangeAt: number | null }} env
 * @param {Timings} [timings]
 * @returns {{ run: true, maxUpload: number } | { run: false, why: string }}
 */
export function dueNow(t, stores, env, timings = TIMINGS) {
  /** @param {string} why @returns {{ run: false, why: string }} */
  const no = (why) => ({ run: false, why });
  if (t.auto === 'off') return no('off');
  if (!t.checked) return no('not set up');
  if (!env.visible) return no('not open');
  if (env.connection === 'offline') return no('offline');
  const h = t.hold;
  if (h?.kind === 'newer') return no('a newer backup is there');
  if (h?.kind === 'error' && env.now < h.retryAt) return no('waiting to try again');
  const free = env.connection === 'wifi' || t.mobileData;
  const changedSinceAsked = h?.kind === 'large' && env.lastChangeAt !== null && env.lastChangeAt > h.at;
  if (h?.kind === 'large' && !free && !changedSinceAsked) return no('waiting for your OK');
  if (env.connection === 'cellular' && !t.mobileData) return no('waiting for Wi-Fi');
  if (!env.changed) return no('nothing changed');
  if (env.lastChangeAt !== null && env.now - env.lastChangeAt < timings.quietMs) return no('changes still coming');
  if (t.last && env.now - t.last.at < timings.gapMs[stores][t.auto === 'daily' ? 'daily' : 'changes']) return no('backed up recently');
  return { run: true, maxUpload: free ? Infinity : timings.askAbove };
}

/** What a place waits on that the user should hear of, as a key to tell it once by; null for nothing. @param {Target} t */
export function holdKey(t) {
  const h = t.hold;
  if (h?.kind === 'newer') return `${t.id} newer ${h.remote.id}`;
  if (h?.kind === 'large') return `${t.id} large ${h.at}`;
  if (h?.kind === 'error' && h.needsYou) return `${t.id} error ${h.message}`;
  return null;
}

/**
 * Runs automatic backups while annai is open: each tick, every place that is due is backed up,
 * one at a time. onHold hears of each new reason a place waits for the user, once.
 * @param {{ backups: Backups, store: Store, env: () => { visible: boolean, connection: Connection }, onHold: (t: Target) => void,
 *   timings?: Timings, now?: () => number }} o
 * @returns {{ tick: () => Promise<void>, stop: () => void }}
 */
export function startAutoBackup({ backups, store, env, onHold, timings = TIMINGS, now = () => Date.now() }) {
  let stopped = false;
  /** @type {Promise<void> | null} */
  let busy = null;
  /** @type {Set<string>} */
  const told = new Set();
  async function run() {
    for (const t of await backups.list()) {
      if (stopped) return;
      const type = backups.typeOf(t.type);
      if (!type) continue;
      const { changed, lastChangeAt } = await changedSince(store, t.last?.seqs ?? null);
      const due = dueNow(t, type.stores, { ...env(), now: now(), changed, lastChangeAt }, timings);
      if (due.run) await backups.backUp(t.id, { reason: 'auto', maxUpload: due.maxUpload }).catch(() => {});
    }
    for (const t of await backups.list()) {
      const key = holdKey(t);
      if (key && !told.has(key)) {
        told.add(key);
        onHold(t);
      }
    }
  }
  /** One look at a time; a second call while one runs waits for it. */
  const tick = () => (busy ??= run().finally(() => { busy = null; }));
  const timer = setInterval(() => { tick().catch(() => {}); }, timings.tickMs);
  tick().catch(() => {});
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
