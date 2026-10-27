import { startAutoBackup, TIMINGS } from '../core/backup-auto.js';
import { holdWords, oldHold } from '../core/backup.js';
import { connectionOf } from './platform.js';
import { setPendingImport } from './import-state.js';
import { t, messageOf } from './dom.js';
import { newerText, placeHref, size, localDay, gettingFiles, sentences } from './format.js';

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
    onHold: (target) => holdCard(ctx, target),
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

/** Where a place is, in its kind's words. @param {Ctx} ctx @param {Target} target */
export function whereOf(ctx, target) {
  try {
    return String(ctx.backups.typeOf(target.type)?.where(target.config) || target.name);
  } catch {
    return target.name;
  }
}

/**
 * What a backup place's screen and cards call this device (backup.js's noun, from platform.js's deviceName), one message each.
 * @type {Record<string, { over: string, wifi: string }>}
 */
const THIS_DEVICE = {
  phone: { over: t`Back up this phone over it`, wifi: t`annai can't tell whether this phone is on Wi-Fi, so larger backups wait for your OK.` },
  iPad: { over: t`Back up this iPad over it`, wifi: t`annai can't tell whether this iPad is on Wi-Fi, so larger backups wait for your OK.` },
  computer: { over: t`Back up this computer over it`, wifi: t`annai can't tell whether this computer is on Wi-Fi, so larger backups wait for your OK.` },
};
/** This device's words, by its noun. @param {string} noun */
export const thisDevice = (noun) => THIS_DEVICE[noun] ?? THIS_DEVICE.computer;

/** The card for what a place waits on. @param {Ctx} ctx @param {Target} target */
function holdCard(ctx, target) {
  const h = target.hold;
  const me = thisDevice(ctx.backups.noun);
  const open = { label: t`Open Backups`, run: () => ctx.go(placeHref(target.id)) };
  if (h?.kind === 'newer') {
    const tree = ctx.backups.typeOf(target.type)?.stores === 'tree';
    // Progress lines stay on the Backups screen; a card's restore says only how it starts, or why it failed.
    const say = (/** @type {string} */ s, progress = false) => { if (!progress) ctx.notices.toast(s); };
    ctx.notices.card({
      tone: 'warn', title: t`A newer backup is on ${target.name}`, body: newerText(target, { where: whereOf(ctx, target), noun: ctx.backups.noun, tree }),
      actions: [
        // No signal: a card belongs to no screen, so there is no leaving to stop it; it ends by opening the import screen, which has Cancel.
        { label: t`Import it as a copy`, primary: true, run: () => { restoreFrom(ctx, target, h.remote, say); } },
        { label: me.over, run: () => { backUpFromCard(ctx, target.id, { over: true }); } },
      ],
    });
  } else if (h?.kind === 'large') {
    ctx.notices.card({
      title: t`A large backup is waiting`,
      body: sentences(t`This backup uploads ${size(h.bytes)} to ${target.name}.`, me.wifi),
      actions: [{ label: t`Back up now`, primary: true, run: () => { backUpFromCard(ctx, target.id, {}); } }, open],
    });
  } else if (h?.kind === 'error') {
    const where = whereOf(ctx, target);
    ctx.notices.card({ tone: 'warn', title: where === target.name ? t`Backups to ${target.name} stopped` : t`Backups to ${target.name} (${where}) stopped`,
      ...(oldHold(h) ? { body: t`Open Backups to fix it.`, en: String(h.message ?? '') } : { body: sentences(holdWords(h), t`Open Backups to fix it.`) }), actions: [open] });
  }
}

/** @param {Ctx} ctx @param {string} id @param {{ over?: boolean }} o */
function backUpFromCard(ctx, id, o) {
  ctx.notices.toast(t`Backing up…`);
  ctx.backups.backUp(id, o).then(
    () => ctx.notices.toast(t`Backed up.`),
    (/** @type {any} */ e) => {
      if (e?.name !== 'AbortError') ctx.notices.card({ tone: 'warn', title: t`The backup didn't finish`, body: messageOf(e) });
    },
  );
}

/**
 * Opens a backup from a place on the import screen, where the user chooses what comes in (spec §12.3). A place that can tell
 * what a backup holds from its manifest alone (a git place) opens at once, and its files come when the user imports; any other
 * place sends the whole backup first.
 * say: what it is doing, and whether that is a progress line (how many files it has got).
 * @param {Ctx} ctx @param {Target} target @param {RemoteBackup} remote @param {(status: string, progress?: boolean) => void} say @param {{ signal?: AbortSignal }} [o]
 */
export async function restoreFrom(ctx, target, remote, say, { signal } = {}) {
  const from = { target: target.id, remote };
  const type = ctx.backups.typeOf?.(target.type);
  if (type?.stores === 'tree' && typeof type.peek === 'function') {
    try {
      say(t`Opening the backup…`);
      const peeked = await ctx.backups.peek(target.id, remote.id, { signal });
      if (peeked) {
        setPendingImport([], { archive: true, from, peeked });
        ctx.go('#/import');
        return;
      }
    } catch (e) {
      say(messageOf(e));
      return;
    }
  }
  const off = ctx.backups.on(() => {
    const p = ctx.backups.progress(target.id);
    if (p?.phase === 'downloading') say(gettingFiles(p), p.total > 1);
  });
  try {
    // An automatic backup in the way stops; one the user started is waited for, and the user is told.
    const downloading = ctx.backups.download(target.id, remote.id, { signal });
    say(ctx.backups.running().some((r) => r.reason === 'user') ? t`Waiting for the backup that's running to finish…` : gettingFiles(null));
    const blob = await downloading;
    const day = localDay(remote.at || Date.now());
    setPendingImport([new File([blob], /* en */ `annai-backup-${day}.annai.zip`, { type: 'application/zip' })], { archive: true, from });
    ctx.go('#/import');
  } catch (e) {
    say(messageOf(e));
  } finally {
    off();
  }
}
