/** Errors every layer shares. */

/** The device has no room left. Nothing in the transaction that hit it was written (spec §17). */
export class StorageFullError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("annai's storage on this device is full. Remove a trip you no longer need (back it up first), or free up space on this device.", cause === undefined ? undefined : { cause });
    this.name = 'StorageFullError';
  }
}

/** What a Store rethrows for a failed transaction: a full disk becomes StorageFullError. @param {unknown} e */
export function storeError(e) {
  return /** @type {any} */ (e)?.name === 'QuotaExceededError' ? new StorageFullError(e) : e;
}
