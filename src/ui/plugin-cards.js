import { t, plural } from './dom.js';
import { list, sentences } from './format.js';

/**
 * The card when a running plugin is switched off after repeated errors (spec §5.5). A system card,
 * never in Shiori's voice; the message has any key annai keeps blanked before it gets here.
 * @param {{ name: string, reason: string, message: string }} d
 */
export function disabledCard({ name, reason, message }) {
  return {
    tone: /** @type {const} */ ('warn'),
    title: t`The plugin "${name}" was turned off`,
    // The reason is core's words (registry.js, hooks.js), in English for now.
    body: sentences(t`It ${reason}.`, t`The last error: ${message}`, t`You can turn it back on in Settings → Plugins.`),
  };
}

/** What needs a plugin says on a page no service worker took, where none can load (spec §5.3): on the screens, in their language. */
export const NEEDS_RELOAD = t`annai needs a reload: it opened without its offline service, so its plugins can't start.`;
/** The same, as models and the logs are told it: in English, as every word annai gives a model is (a role's attempts keep it). */
const NEEDS_RELOAD_EN = /* en */ "annai needs a reload: it opened without its offline service, so its plugins can't start.";
/** Why plugins can't load on this page, for models and the logs: English, or undefined when they can. @param {boolean} gaveUp @param {boolean} controlled */
export const pluginsHeld = (gaveUp, controlled) => (gaveUp && !controlled ? NEEDS_RELOAD_EN : undefined);
/** An error's words as a screen shows them: the held reason (pluginsHeld's, and no other words) in the screens' language. @param {string} words */
export const heldOnScreen = (words) => (words === NEEDS_RELOAD_EN ? NEEDS_RELOAD : words);

/** That page's one card, naming the plugins that are on, if any; Reload now is the user's own tap, so it can't loop. @param {string[]} names @param {() => void} reload */
export function reloadCard(names, reload) {
  return {
    tone: /** @type {const} */ ('warn'), title: t`annai needs a reload`,
    body: names.length ? plural(names.length, "It opened without its offline service, so this plugin can't start: {0}.", "It opened without its offline service, so these plugins can't start: {0}.", list(names))
      : t`It opened without its offline service, so plugins can't start or be installed.`,
    actions: [{ label: t`Reload now`, primary: true, run: reload }],
  };
}

/**
 * Cards for plugins that didn't start, by name. Where no service worker took the page, every import fails: those are
 * named for the reload card (unloaded), but one turned off after failing to start keeps its card.
 * @param {{ id: string, error: unknown, disabled: boolean }[]} failures @param {{ name: (id: string) => string, taken: boolean }} o
 */
export function startCards(failures, { name, taken }) {
  const cards = [];
  const unloaded = [];
  for (const f of failures) {
    const why = String(/** @type {any} */ (f.error)?.message ?? f.error);
    const it = name(f.id);
    if (f.disabled) cards.push({ title: t`The plugin "${it}" was turned off`, body: sentences(t`It didn't start the last few times annai opened: ${why}`, t`You can turn it back on in Settings → Plugins.`) });
    else if (taken) cards.push({ title: t`The plugin "${it}" didn't start`, body: sentences(why, t`You can turn it off in Settings → Plugins.`) });
    else unloaded.push(name(f.id));
  }
  return { cards: cards.map((c) => ({ tone: /** @type {const} */ ('warn'), ...c })), unloaded };
}
