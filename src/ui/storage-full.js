import { StorageFullError } from '../core/errors.js';
import { t } from './dom.js';
import { deviceName } from './platform.js';

/**
 * Spec §17: "Storage full" shows a card with what works, the phone's own Settings first. Call it from any catch;
 * it shows the card when e is a full disk and says whether it did.
 * @param {any} ctx @param {unknown} e
 */
export function explainStorageFull(ctx, e) {
  if (!(e instanceof StorageFullError)) return false;
  // Not platform(): an iPad's says iPad Storage.
  const where = deviceName().label;
  ctx.notices.card({
    tone: 'warn', title: t`There's no room to save this`,
    // Removing a trip frees its space; deleting inside a trip keeps its history (spec §4.9).
    body: where === 'iPhone' ? t`Nothing was half-saved. Free up space on this iPhone in Settings → General → iPhone Storage, then try again. Removing a trip you no longer need also makes room in annai (back it up first).`
      : where === 'Android phone' ? t`Nothing was half-saved. Free up space on this phone in Settings → Storage, then try again. Removing a trip you no longer need also makes room in annai (back it up first).`
      : t`Nothing was half-saved. Free up space on this device, then try again. Removing a trip you no longer need also makes room in annai (back it up first).`,
    // Export not first: a backup file needs room too.
    actions: [
      { label: t`Export a backup`, run: () => ctx.go('#/settings') },
      { label: t`Go to Trips`, run: () => ctx.go('#/trips') },
    ],
  });
  return true;
}
