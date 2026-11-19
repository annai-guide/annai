import { StorageFullError } from '../core/errors.js';
import { sentences } from '../core/intl.js';
import { t } from './dom.js';
import { deviceName, platform } from './platform.js';

/** The card up on each screen's notices, taken down before another: a full phone refuses every save. @type {WeakMap<object, () => void>} */
const up = new WeakMap();
/** The refusals whose card was shown: one error comes by more than one way (a line given back, then the turn that stopped on it). @type {WeakSet<object>} */
const shown = new WeakSet();

/** What to do about a full device: its Settings first. Removing a trip makes room only where a delete works on a full disk: Chromium's does, WebKit's
 * (every iPhone and iPad browser) refuses (measured on Linux builds, 2026-11-19; not yet on a phone). */
export function storageFullSteps() {
  const where = deviceName().label;
  const free = where === 'iPhone' ? t`Free up space on this iPhone in Settings → General → iPhone Storage, then try again.`
    : where === 'Android phone' ? t`Free up space on this phone in Settings → Storage, then try again.`
      : t`Free up space on this device, then try again.`;
  return sentences(free, platform() === 'ios' ? '' : t`Removing a trip you no longer need also makes room in annai (back it up first).`);
}

/**
 * Spec §17: "Storage full" shows a card with what works, the phone's own Settings first. Call it from any catch; it shows the card
 * when e is a full disk and says whether it did. One card at a time: the one before it goes, and an error's card shows once.
 * @param {any} ctx @param {unknown} e
 * @param {{ said?: string, words?: string, inBox?: boolean }} [o] said: what the caller's work did not do, said first ("Nothing was removed.");
 *   words: the line typed to Shiori that this refusal gave back, which the card says is back in the box (inBox) or shows
 */
export function explainStorageFull(ctx, e, { said = '', words = '', inBox = false } = {}) {
  if (!(e instanceof StorageFullError)) return false;
  if (shown.has(e)) return true;
  shown.add(e);
  up.get(ctx.notices)?.();
  up.set(ctx.notices, ctx.notices.card({
    tone: 'warn', title: t`There's no room left`,
    body: sentences(said, storageFullSteps(), words ? (inBox ? t`Your message is back in the box.` : t`Your message wasn't saved: ${words}`) : ''),
    // Export not first: a backup file needs room too.
    actions: [
      { label: t`Export a backup`, run: () => ctx.go('#/settings') },
      { label: t`Go to Trips`, run: () => ctx.go('#/trips') },
    ],
  }));
  return true;
}
