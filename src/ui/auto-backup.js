import { startAutoBackup, TIMINGS } from '../core/backup-auto.js';
import { connectionOf } from './platform.js';
import { setPendingImport } from './import-state.js';
import { newerText, placeHref, bytes, localDay, gettingFiles } from './format.js';

/**
 * @typedef {import('../core/backup-targets.js').Target} Target
 * @typedef {import('../core/backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {{ backups: import('../core/backup.js').Backups, store: any, notices: any, go: (hash: string) => void }} Ctx
 */

/**
 * Automatic backups while annai is open (spec §12.4), and the system cards (never in Shiori's
 * voice, §16.1) that ask the user when a place waits for them. Tests shorten the timings through
 * localStorage "annai.backupTimings" ({ tickMs, quietMs, gapMs, askAbove }), as "annai.forceDownload"
 * works for saving files.
 * @param {Ctx} ctx
 */
export function startBackups(ctx) {
  const auto = startAutoBackup({
    backups: ctx.backups, store: ctx.store, timings: timings(),
    env: () => ({ visible: document.visibilityState === 'visible', connection: connectionOf(navigator) }),
    onHold: (t) => holdCard(ctx, t),
  });
  const look = () => { auto.tick().catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') look(); });
  addEventListener('online', look);
  return auto;
}

/** @returns {import('../core/backup-auto.js').Timings} */
function timings() {
  /** @type {any} */
  let o = null;
  try {
    o = JSON.parse(localStorage.getItem('annai.backupTimings') ?? 'null');
  } catch {
    // storage blocked, or not JSON: the usual timings
  }
  if (!o || typeof o !== 'object') return TIMINGS;
  const n = (/** @type {unknown} */ v, /** @type {number} */ usual) => (typeof v === 'number' && v >= 0 ? v : usual);
  const gap = typeof o.gapMs === 'number' ? { changes: o.gapMs, daily: o.gapMs } : null;
  return {
    tickMs: n(o.tickMs, TIMINGS.tickMs), quietMs: n(o.quietMs, TIMINGS.quietMs), askAbove: n(o.askAbove, TIMINGS.askAbove),
    gapMs: gap ? { tree: gap, file: gap } : TIMINGS.gapMs,
  };
}

/** Where a place is, in its kind's words. @param {Ctx} ctx @param {Target} t */
export function whereOf(ctx, t) {
  try {
    return String(ctx.backups.typeOf(t.type)?.where(t.config) || t.name);
  } catch {
    return t.name;
  }
}

/** The card for what a place waits on. @param {Ctx} ctx @param {Target} t */
function holdCard(ctx, t) {
  const h = t.hold;
  const noun = ctx.backups.noun;
  const open = { label: 'Open Backups', run: () => ctx.go(placeHref(t.id)) };
  if (h?.kind === 'newer') {
    const tree = ctx.backups.typeOf(t.type)?.stores === 'tree';
    // Progress lines stay on the Backups screen; a card's restore says only how it starts, or why it failed.
    const say = (/** @type {string} */ s) => { if (!/^Getting files/.test(s)) ctx.notices.toast(s); };
    ctx.notices.card({
      tone: 'warn', title: `A newer backup is on ${t.name}`, body: newerText(t, { where: whereOf(ctx, t), noun, tree }),
      actions: [
        { label: 'Import it as a copy', primary: true, run: () => { restoreFrom(ctx, t, h.remote, say); } },
        { label: `Back up this ${noun} over it`, run: () => { backUpFromCard(ctx, t.id, { over: true }); } },
      ],
    });
  } else if (h?.kind === 'large') {
    ctx.notices.card({
      title: 'A large backup is waiting',
      body: `This backup uploads ${bytes(h.bytes)} to ${t.name}. annai can't tell whether this ${noun} is on Wi-Fi, so larger backups wait for your OK.`,
      actions: [{ label: 'Back up now', primary: true, run: () => { backUpFromCard(ctx, t.id, {}); } }, open],
    });
  } else if (h?.kind === 'error') {
    const where = whereOf(ctx, t);
    ctx.notices.card({ tone: 'warn', title: `Backups to ${t.name}${where === t.name ? '' : ` (${where})`} stopped`, body: `${h.message} Open Backups to fix it.`, actions: [open] });
  }
}

/** @param {Ctx} ctx @param {string} id @param {{ over?: boolean }} o */
function backUpFromCard(ctx, id, o) {
  ctx.notices.toast('Backing up…');
  ctx.backups.backUp(id, o).then(
    () => ctx.notices.toast('Backed up.'),
    (/** @type {any} */ e) => {
      if (e?.name !== 'AbortError') ctx.notices.card({ tone: 'warn', title: "The backup didn't finish", body: String(e?.message ?? e) });
    },
  );
}

/**
 * Opens a backup from a place on the import screen, where the user chooses what comes in (spec §12.3). A place that can tell
 * what a backup holds from its manifest alone (a git place) opens at once, and its files come when the user imports; any other
 * place sends the whole backup first.
 * @param {Ctx} ctx @param {Target} t @param {RemoteBackup} remote @param {(status: string) => void} say @param {{ signal?: AbortSignal }} [o]
 */
export async function restoreFrom(ctx, t, remote, say, { signal } = {}) {
  const from = { target: t.id, remote };
  const type = ctx.backups.typeOf?.(t.type);
  if (type?.stores === 'tree' && typeof type.peek === 'function') {
    try {
      say('Opening the backup…');
      const peeked = await ctx.backups.peek(t.id, remote.id, { signal });
      if (peeked) {
        setPendingImport([], { archive: true, from, peeked });
        ctx.go('#/import');
        return;
      }
    } catch (e) {
      say(String(/** @type {any} */ (e)?.message ?? e));
      return;
    }
  }
  const off = ctx.backups.on(() => {
    const p = ctx.backups.progress(t.id);
    if (p?.phase === 'downloading') say(gettingFiles(p));
  });
  try {
    // An automatic backup in the way stops; one the user started is waited for, and the user is told.
    const downloading = ctx.backups.download(t.id, remote.id, { signal });
    say(ctx.backups.running().some((r) => r.reason === 'user') ? "Waiting for the backup that's running to finish…" : gettingFiles(null));
    const blob = await downloading;
    const day = localDay(remote.at || Date.now());
    setPendingImport([new File([blob], `annai-backup-${day}.annai.zip`, { type: 'application/zip' })], { archive: true, from });
    ctx.go('#/import');
  } catch (e) {
    say(String(/** @type {any} */ (e)?.message ?? e));
  } finally {
    off();
  }
}
