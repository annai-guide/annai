/** Errors every layer shares. */

/** The device has no room left. Nothing in the transaction that hit it was written (spec §17). */
export class StorageFullError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("annai's storage on this device is full. Export a backup, then delete photos or old trips to make room.", cause === undefined ? undefined : { cause });
    this.name = 'StorageFullError';
  }
}

/** What a Store rethrows for a failed transaction: a full disk becomes StorageFullError. @param {unknown} e */
export function storeError(e) {
  return /** @type {any} */ (e)?.name === 'QuotaExceededError' ? new StorageFullError(e) : e;
}
