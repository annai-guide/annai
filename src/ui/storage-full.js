import { StorageFullError } from '../core/errors.js';

/**
 * Spec §17: "Storage full" shows a card with real options. Call it from any catch;
 * it shows the card when e is a full disk and says whether it did.
 * @param {any} ctx @param {unknown} e
 */
export function explainStorageFull(ctx, e) {
  if (!(e instanceof StorageFullError)) return false;
  ctx.notices.card({
    tone: 'warn', title: "annai's storage is full",
    // Removing a trip frees its space; deleting inside a trip keeps its history (spec §4.9).
    body: 'Nothing was half-saved. To make room, remove a trip you no longer need (back it up first), or free up space on this device.',
    actions: [
      { label: 'Export a backup', primary: true, run: () => ctx.go('#/settings') },
      { label: 'Go to Trips', run: () => ctx.go('#/trips') },
    ],
  });
  return true;
}
