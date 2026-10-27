import { h, autosave, queueSave, t } from './dom.js';
import { relTime } from './format.js';
import { reorderable } from './screens/models.js';
import { readAppSettings, updateAppSettings } from '../core/settings.js';
import { orderSearch, searchOffIn, cooldowns, trusted, FREE_SERVICES, READY_MS } from '../core/web-search.js';

/**
 * Where searches go, in words (Settings → Tools and the welcome, the user 2026-10-23): annai's free
 * search, three services each on until the user unticks it, and the other search providers, all in
 * the order web_search tries them.
 */
export const SEARCH_NOTE = t`Free search sends your searches to Exa, Parallel or Firecrawl: just the words searched, not your files or your location. Exa also reads a page that no other reader can, which sends it that page's address. They are free tiers that can change or stop, and Exa and Parallel may use what is searched to train their models, so keep names and addresses out of your searches. Behind them, a last resort that is always on asks Wikimedia (Wikivoyage and Wikipedia) and OpenStreetMap (Nominatim) the same words; only Search via: Off stops it.`;

/** The welcome's line under the ticks: the same facts, for someone who hasn't seen Tools yet. */
export const WELCOME_SEARCH = t`Only the words she searches for go to the ones you leave ticked, and Exa also gets the addresses of pages it reads for her: not your files or your location. They're free tiers that can change or stop, and Exa and Parallel may use searches to train their models, so keep names and addresses out of them. Behind them, Wikimedia (Wikivoyage and Wikipedia) and OpenStreetMap (Nominatim) are always asked as a last resort; only Settings → Tools → Search via: Off stops that. You can change all this there.`;

/** Ticks or unticks a search service: the ids switched off are web.searchOff, read fresh so no other change is lost. It runs inside autosave's queue. @param {any} ws @param {string} id @param {boolean} on */
export async function setSearchOn(ws, id, on) {
  const off = new Set(((await readAppSettings(ws)).web?.searchOff ?? []).map(String));
  if (on) off.delete(id);
  else off.add(id);
  await updateAppSettings(ws, { web: { searchOff: [...off] } });
}

/**
 * A tick for a search provider, saved as it changes, with its quiet Saved and its error.
 * @param {any} ws @param {string} id @param {string} name @param {boolean} on
 */
function tick(ws, id, name, on) {
  const input = h('input', { type: 'checkbox', checked: on, 'aria-label': t`Use ${name}` });
  return h('div', { class: 'saving' }, h('label', { class: 'check' }, input, h('span', { text: t`Use` })), ...autosave(input, () => input.checked, (v) => setSearchOn(ws, id, v)));
}

/** The free services with a tick each, all on until unticked: the welcome's list, saving to the same settings as Tools. @param {any} ws */
export async function freeTicks(ws) {
  const off = searchOffIn((await readAppSettings(ws)).web, FREE_SERVICES);
  return h('ul', { class: 'file-list free-search' }, ...FREE_SERVICES.map((s) => {
    const input = h('input', { type: 'checkbox', checked: !off.includes(s.id) });
    return h('li', { class: 'saving' }, h('label', { class: 'check' }, input, h('span', { text: s.name })), ...autosave(input, () => input.checked, (v) => setSearchOn(ws, s.id, v)));
  }));
}

/** A provider's state in a few words; its ready() is given a moment (READY_MS) to say. @param {any} p */
export async function stateOf(p) {
  const left = cooldowns.left(p.id);
  if (left > 0) {
    const now = Date.now(); // one reading, so the last minute is "in 1 minute", not "now"
    return t`resting after a failure, tries again ${relTime(now + Math.ceil(left / 60_000) * 60_000, now)}`;
  }
  if (p.always) return t`Wikimedia and OpenStreetMap; always on, the last resort`;
  if (!p.ready) return p.free ? t`free, no key` : t`ready`;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, why: t`couldn't check` }), READY_MS.ms); });
  try {
    const ready = /** @type {any} */ (await Promise.race([Promise.resolve().then(() => p.ready()).catch(() => ({ ok: false, why: t`couldn't check` })), slow]));
    return ready.ok ? (p.free ? t`free, no key` : t`ready`) : String(ready.shown ?? ready.why ?? t`not ready`);
  } finally {
    clearTimeout(timer);
  }
}

/** Settings → Tools → Search: the providers in the order web_search tries them, each with a tick. @param {any} ctx */
export async function searchPanel(ctx) {
  const web = (await readAppSettings(ctx.ws)).web ?? {};
  const all = orderSearch(/** @type {any[]} */ (trusted(ctx.registry.entries('search'))), web);
  const off = searchOffIn(web, all);
  /** @param {string} _role @param {(ids: string[]) => string[]} change */
  const list = async (_role, change) => {
    const here = location.hash;
    await queueSave(async () => {
      const now = orderSearch(/** @type {any[]} */ (trusted(ctx.registry.entries('search'))), (await readAppSettings(ctx.ws)).web).map((p) => p.id);
      await updateAppSettings(ctx.ws, { web: { search: change(now) } });
    });
    if (location.hash === here) await ctx.render();
  };
  /** @param {string} id @param {number} by */
  const move = (id, by) => list('search', (ids) => {
    const next = ids.slice();
    const i = next.indexOf(id);
    if (i >= 0 && next[i + by]) [next[i], next[i + by]] = [next[i + by], next[i]];
    return next;
  });
  // A provider's name and why are Shiori's (English); shown is the screen's, where it has one.
  const items = await Promise.all(all.map(async (p, i) => reorderable('search', p.id, i, all.length, p.shown ?? p.name, false, await stateOf(p), move, list,
    p.always ? h('span', { class: 'sub', text: t`On` }) : tick(ctx.ws, p.id, p.shown ?? p.name, !off.includes(p.id)))));
  return h('section', { class: 'panel', 'aria-label': t`Search` },
    h('h2', { class: 'section', text: t`Search` }),
    h('p', { class: 'sub', text: t`web_search tries these from the top, and the first that answers wins. One that fails rests for a while, then is tried again. Untick one to stop using it.` }),
    h('ol', { class: 'role-list', id: 'search-order' }, ...items),
    h('p', { class: 'sub', text: SEARCH_NOTE }),
    h('p', { class: 'sub', text: t`More search providers are plugins: add one from the catalog (Tavily, Serper, your own SearXNG), and its key goes on its own page.` }),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/add?kind=tools' }, t`Find a search plugin`)));
}
