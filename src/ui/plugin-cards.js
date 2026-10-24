import { list } from './format.js';

/**
 * The card when a running plugin is switched off after repeated errors (spec §5.5). A system card,
 * never in Shiori's voice; the message has any key annai keeps blanked before it gets here.
 * @param {{ name: string, reason: string, message: string }} d
 */
export function disabledCard({ name, reason, message }) {
  return {
    tone: /** @type {const} */ ('warn'),
    title: `The plugin "${name}" was turned off`,
    body: `It ${reason}. The last error: ${message} You can turn it back on in Settings → Plugins.`,
  };
}

/** What needs a plugin says on a page no service worker took, where none can load (spec §5.3). */
export const NEEDS_RELOAD = "annai needs a reload: it opened without its offline service, so its plugins can't start.";

/** That page's one card, naming the plugins that are on, if any; Reload now is the user's own tap, so it can't loop. @param {string[]} names @param {() => void} reload */
export function reloadCard(names, reload) {
  return {
    tone: /** @type {const} */ ('warn'), title: 'annai needs a reload',
    body: `It opened without its offline service, so ${names.length ? `${names.length > 1 ? 'these plugins' : 'this plugin'} can't start: ${list(names)}` : "plugins can't start or be installed"}.`,
    actions: [{ label: 'Reload now', primary: true, run: reload }],
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
    const it = `The plugin "${name(f.id)}"`;
    if (f.disabled) cards.push({ title: `${it} was turned off`, body: `It didn't start the last few times annai opened: ${why} You can turn it back on in Settings → Plugins.` });
    else if (taken) cards.push({ title: `${it} didn't start`, body: `${why} You can turn it off in Settings → Plugins.` });
    else unloaded.push(name(f.id));
  }
  return { cards: cards.map((c) => ({ tone: /** @type {const} */ ('warn'), ...c })), unloaded };
}
