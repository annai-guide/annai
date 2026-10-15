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
    body: 'Nothing was half-saved. Export a backup to keep a copy, then delete photos or old trips to make room.',
    actions: [
      { label: 'Export a backup', primary: true, run: () => ctx.go('#/settings') },
      { label: 'Go to Trips', run: () => ctx.go('#/trips') },
    ],
  });
  return true;
}
