import { h, autosave, queueSave } from './dom.js';
import { reorderable } from './screens/models.js';
import { readAppSettings, updateAppSettings } from '../core/settings.js';
import { orderSearch, searchOffIn, cooldowns, FREE_SERVICES } from '../core/web-search.js';

/**
 * Where searches go, in words (Settings → Tools and the welcome, the user 2026-10-23): annai's free
 * search, three services each on until the user unticks it, and the other search providers, all in
 * the order web_search tries them.
 */
export const SEARCH_NOTE = "Free search sends your searches to Exa, Parallel or Firecrawl: just the words searched, nothing of your trips. They're free tiers that can change or stop. Exa also reads a page that no other reader can, which sends it the page's address.";

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
  const input = h('input', { type: 'checkbox', checked: on, 'aria-label': `Use ${name}` });
  return h('span', { class: 'saving' }, h('label', { class: 'check' }, input, h('span', { text: 'Use' })), ...autosave(input, () => input.checked, (v) => setSearchOn(ws, id, v)));
}

/** The free services with a tick each, all on until unticked: the welcome's list, saving to the same settings as Tools. @param {any} ws */
export async function freeTicks(ws) {
  const off = searchOffIn((await readAppSettings(ws)).web, FREE_SERVICES);
  return h('ul', { class: 'file-list free-search' }, ...FREE_SERVICES.map((s) => {
    const input = h('input', { type: 'checkbox', checked: !off.includes(s.id) });
    return h('li', { class: 'saving' }, h('label', { class: 'check' }, input, h('span', { text: s.name })), ...autosave(input, () => input.checked, (v) => setSearchOn(ws, s.id, v)));
  }));
}

/** A provider's state in a few words. @param {any} p */
async function stateOf(p) {
  if (p.always) return 'always on, the last resort';
  const left = cooldowns.left(p.id);
  if (left > 0) return `resting after a failure, tries again in ${Math.ceil(left / 60_000)} min`;
  const ready = p.ready ? await Promise.resolve(p.ready()).catch(() => ({ ok: false, why: "couldn't check" })) : { ok: true };
  if (!ready.ok) return String(ready.why ?? 'not ready');
  return p.free ? 'free, no key' : 'ready';
}

/** Settings → Tools → Search: the providers in the order web_search tries them, each with a tick. @param {any} ctx */
export async function searchPanel(ctx) {
  const web = (await readAppSettings(ctx.ws)).web ?? {};
  const all = orderSearch(/** @type {any[]} */ (ctx.registry.list('search')), web);
  const off = searchOffIn(web, all);
  /** @param {string} _role @param {(ids: string[]) => string[]} change */
  const list = async (_role, change) => {
    const here = location.hash;
    await queueSave(async () => {
      const now = orderSearch(/** @type {any[]} */ (ctx.registry.list('search')), (await readAppSettings(ctx.ws)).web).map((p) => p.id);
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
  const items = await Promise.all(all.map(async (p, i) => reorderable('search', p.id, i, all.length, p.name, false, await stateOf(p), move, list,
    p.always ? h('span', { class: 'sub', text: 'On' }) : tick(ctx.ws, p.id, p.name, !off.includes(p.id)))));
  return h('section', { class: 'panel', 'aria-label': 'Search' },
    h('h2', { class: 'section', text: 'Search' }),
    h('p', { class: 'sub', text: 'web_search tries these from the top, and the first that answers wins. One that fails rests for a while, then is tried again. Untick one to stop using it.' }),
    h('ol', { class: 'role-list', id: 'search-order' }, ...items),
    h('p', { class: 'sub', text: SEARCH_NOTE }),
    h('p', { class: 'sub', text: 'More search providers are plugins: add one from the catalog (Tavily, Serper, your own SearXNG), and its key goes on its own page.' }),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/add?kind=tools' }, 'Find a search plugin')));
}
