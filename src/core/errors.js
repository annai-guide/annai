/** Errors every layer shares. */

/** The device has no room left. Nothing in the transaction that hit it was written (spec §17). */
export class StorageFullError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("annai's storage on this device is full. Remove a trip you no longer need (back it up first), or free up space on this device.", cause === undefined ? undefined : { cause });
    this.name = 'StorageFullError';
  }
}

/** The store was closed because another tab took over (spec §4.6): this tab must not read or write again. */
export class StoppedError extends Error {
  constructor() {
    super('annai has stopped in this tab because it was opened in another one. Reload this tab to use annai here.');
    this.name = 'StoppedError';
  }
}

/** What a Store rethrows for a failed transaction: a full disk becomes StorageFullError. @param {unknown} e */
export function storeError(e) {
  return /** @type {any} */ (e)?.name === 'QuotaExceededError' ? new StorageFullError(e) : e;
}
