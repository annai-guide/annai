import { t, plural } from '../core/l10n.js';
import { list } from '../core/intl.js';
/**
 * Files picked or dropped on one screen and opened on the import screen (hash routes can't carry files).
 * @typedef {{ target: string, remote: import('../core/backup-targets.js').RemoteBackup }} From a backup opened from a backup place
 */
/** @type {{ files: File[], archive: boolean, from: From | null, peeked: any } | null} */
let pending = null;
/**
 * @param {File[]} files @param {{ archive?: boolean, from?: From | null, peeked?: any }} [o]
 *   archive: picked as an annai file, so it is one whatever its name; from: the backup place it came from;
 *   peeked: that backup's manifest, when the place told it without sending the files (they come when the user imports)
 */
export function setPendingImport(files, { archive = false, from = null, peeked = null } = {}) { pending = files.length || (peeked && from) ? { files, archive, from, peeked } : null; }
export function takePendingImport() {
  const f = pending;
  pending = null;
  return f;
}

/** An annai archive (or a zip that may be one), as opposed to a file for a trip, such as a Wallet pass. @param {string} name */
export function isArchiveName(name) {
  return /\.annai(\.zip)?$/i.test(name) || /\.zip$/i.test(name);
}

/**
 * A signal that aborts when the user leaves the screen it was made for (any move to another address: Cancel, a crumb, Back, the dock,
 * a swipe). done() lets go of the listening, for when the work is over; it lets go by itself once the screen is left.
 * @param {Pick<EventTarget, 'addEventListener' | 'removeEventListener'>} [target]
 */
export function leaveSignal(target = globalThis) {
  const quit = new AbortController();
  const out = () => quit.abort();
  target.addEventListener('hashchange', out, { once: true });
  const done = () => target.removeEventListener('hashchange', out);
  quit.signal.addEventListener('abort', done, { once: true });
  return { signal: quit.signal, abort: out, done };
}

/**
 * An import that finished after the user left its screen: a toast says what came in, since the screen's own words are not seen.
 * @param {{ notices?: { toast: (words: string) => void } }} ctx @param {AbortSignal} left @param {string[]} titles the trips that came
 * @param {string | null | undefined} place the backup place it came from
 */
export function toldIfLeft(ctx, left, titles, place) {
  if (!left.aborted) return;
  const what = titles.length > 2 ? plural(titles.length, '# trip', '# trips') : list(titles);
  ctx.notices?.toast(what ? (place ? t`Imported ${what} from ${place}.` : t`Imported ${what}.`) : place ? t`Imported from ${place}.` : t`Imported.`);
}
