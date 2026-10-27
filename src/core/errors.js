/**
 * Errors every layer shares. As every error a model or the log may read: message is annai's English, and shown the screens' words
 * (the rule of LESSONS 2026-10-27), which a screen shows as shown ?? message.
 */
import { t } from './l10n.js';

/** The device has no room left. Nothing in the transaction that hit it was written (spec §17). */
export class StorageFullError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super(/* en */ "annai's storage on this device is full. Remove a trip you no longer need (back it up first), or free up space on this device.", cause === undefined ? undefined : { cause });
    this.name = /* en */ 'StorageFullError';
    this.shown = shownFor(this.name);
  }
}

/** The store was closed because another tab took over (spec §4.6): this tab must not read or write again. */
export class StoppedError extends Error {
  constructor() {
    super(/* en */ 'annai has stopped in this tab because it was opened in another one. Reload this tab to use annai here.');
    this.name = /* en */ 'StoppedError';
    this.shown = shownFor(this.name);
  }
}

/**
 * The screens' words for an error annai names, by its name (an error kept as data has its name, not its words); undefined for
 * any other. @param {string} name
 */
export function shownFor(name) {
  if (name === 'StorageFullError') return t`annai's storage on this device is full. Remove a trip you no longer need (back it up first), or free up space on this device.`;
  if (name === 'StoppedError') return t`annai has stopped in this tab because it was opened in another one. Reload this tab to use annai here.`;
  if (name === 'AllFailedError') return t`Shiori can't reach her model.`;
  return undefined;
}

/** What a Store rethrows for a failed transaction: a full disk becomes StorageFullError. @param {unknown} e */
export function storeError(e) {
  return /** @type {any} */ (e)?.name === 'QuotaExceededError' ? new StorageFullError(e) : e;
}
