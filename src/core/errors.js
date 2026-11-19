/**
 * Errors every layer shares. As every error a model or the log may read: message is annai's English, and shown the screens' words
 * (the shown rule), which a screen shows as shown ?? message.
 */
import { t } from './l10n.js';
import { sentences } from './intl.js';

/** The device has no room left, whatever the browser calls the refusal (storeError). Nothing in the transaction that hit it was written (spec §17). */
export class StorageFullError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super(/* en */ "There's no room left. Free up space on this device, then try again.", cause === undefined ? undefined : { cause });
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
 * An Error whose words are annai's own developer English: a screen shows them marked lang="en" (dom.js englishOf).
 * en: true when all its words are English, or the part of its shown words that is.
 */
export class EnglishError extends Error {
  /** @type {boolean | string} */ en = true;
}

/**
 * The screens' words for an error annai names, by its name (an error kept as data has its name, not its words); undefined for
 * any other. @param {string} name
 */
export function shownFor(name) {
  // The storage card's title and words for any device (storage-full.js): no claim that holds only for some, such as that a trip can be removed
  if (name === 'StorageFullError') return sentences(t`There's no room left`, t`Free up space on this device, then try again.`);
  if (name === 'StoppedError') return t`annai has stopped in this tab because it was opened in another one. Reload this tab to use annai here.`;
  if (name === 'AllFailedError') return t`Shiori can't reach her model.`;
  return undefined;
}

/**
 * What a Store rethrows for a failed transaction: a write the browser refused becomes StorageFullError, by name and side, never words
 * (a full phone's isn't a quota error: the builder's probe of 2026-11-19 on Linux builds of WebKit and Chromium; not yet on a phone). @param {unknown} e
 * @param {{ write?: boolean, refused?: boolean, open?: boolean }} [o] write: read-write, or a connection that could not be opened (Chromium's
 *   backing store writes as it opens); refused: aborted after all its requests succeeded; open: a connection that could not be opened, the first open or
 *   any reopen: an UnknownError counts (Chromium at its last bytes), and an AbortError too (the reopen of a connection its failed write had closed: "The connection was closed")
 */
export function storeError(e, { write = false, refused = false, open = false } = {}) {
  const name = /** @type {any} */ (e)?.name;
  return name === 'QuotaExceededError' || (write && (refused || name === 'UnknownError')) || (open && name === 'AbortError') ? new StorageFullError(e) : e;
}
