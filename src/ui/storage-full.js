import { StorageFullError } from '../core/errors.js';
import { sentences } from '../core/intl.js';
import { t } from './dom.js';
import { deviceName } from './platform.js';

/** The storage cards up on each notices object, by body: a card replaces one with the same words, not one that says something else. @type {WeakMap<object, Map<string, () => void>>} */
const up = new WeakMap();
/** The refusals whose card was shown: one error comes two ways (a line given back, then the turn that stopped on it). @type {WeakSet<object>} */
const shown = new WeakSet();

/**
 * Whether to suggest removing a trip: where a delete works on a full disk (Chromium's, until its last bytes; WebKit's, every iPhone and iPad browser,
 * refuses: the builder's probe, 2026-11-19, Linux; not yet on a phone). removal false: the caller's work was a removal, which the phone refused. @param {boolean} [removal]
 */
const suggestsRemoval = (removal = true) => removal && !['iPhone', 'iPad'].includes(deviceName().label);

/** What to do about a full device: its own Settings first. @param {boolean} [removal] false: no suggestion to remove a trip (a refused removal) */
export function storageFullSteps(removal = true) {
  const where = deviceName().label;
  const free = where === 'iPhone' ? t`Free up space on this iPhone in Settings → General → iPhone Storage, then try again.`
    : where === 'Android phone' ? t`Free up space on this phone in Settings → Storage, then try again.`
      : t`Free up space on this device, then try again.`;
  return sentences(free, suggestsRemoval(removal) ? t`Removing a trip you no longer need also makes room in annai (back it up first).` : '');
}

/** A card the agent made whose `error` is a full phone's: the storage card in its place, its title or its own `said` first. @param {any} ctx @param {{ title: string, said?: string, error?: unknown }} n */
export const explainNotice = (ctx, n) => explainStorageFull(ctx, n.error, { said: n.said ?? n.title });

/**
 * Spec §17: "Storage full" shows a card with what works, the phone's own Settings first. Call it from any catch; it shows the card
 * when e is a full disk and says whether it did. An error's card shows once.
 * @param {any} ctx @param {unknown} e
 * @param {{ said?: string, removal?: false }} [o] said: what the caller's work did not do, or what became of the user's words, said first ("Nothing was removed.");
 *   removal false: the caller's work was a removal, so none is suggested
 */
export function explainStorageFull(ctx, e, { said = '', removal } = {}) {
  if (!(e instanceof StorageFullError)) return false;
  if (shown.has(e)) return true;
  shown.add(e);
  const body = sentences(said, storageFullSteps(removal));
  const cards = up.get(ctx.notices) ?? new Map();
  up.set(ctx.notices, cards);
  cards.get(body)?.();
  cards.set(body, ctx.notices.card({
    tone: 'warn', title: t`There's no room left`, body,
    // Export a backup isn't the primary button: its file needs room too.
    actions: [
      { label: t`Export a backup`, run: () => ctx.go('#/settings') },
      ...(suggestsRemoval(removal) ? [{ label: t`Go to Trips`, run: () => ctx.go('#/trips') }] : []),
    ],
  }));
  return true;
}
