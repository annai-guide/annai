import { h, messageOf } from './dom.js';
import { made } from './slots.js';
import { platform, isStandalone } from './platform.js';
import { setKey } from '../core/llm/config.js';
import { setupOf } from '../core/llm/setup.js';
import { descOrigins, addressProblem } from '../core/llm/provider-desc.js';
import { officialPlugins, makesProvider } from '../core/llm/official.js';
import { isPluginBug } from '../core/registry.js';
import { NO_SERVICE } from './screens/plugin-install.js';

/**
 * Coming back to annai's address (decision 16): the plugin that sent the browser away expects the next load with a query, within 15 minutes, once.
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 */
const SLOT = 'annai.return';
const MAX_AGE = 15 * 60_000;

/** Notes that a plugin expects annai's address back. @param {string} pluginId @param {{ storage?: KeyValue, now?: number }} [o] */
export function expectReturn(pluginId, { storage = localStorage, now = Date.now() } = {}) {
  storage.setItem(SLOT, JSON.stringify({ plugin: pluginId, at: now }));
}

/** Whose return this page load is, or null; any query uses the note up. @param {string} search @param {{ storage?: KeyValue, now?: number }} [o] */
export function returnFor(search, { storage = localStorage, now = Date.now() } = {}) {
  const params = new URLSearchParams(search);
  if (!params.size) return null;
  /** @type {any} */
  let note = null;
  try {
    note = JSON.parse(storage.getItem(SLOT) ?? 'null');
  } catch {
    // unreadable: no one's
  }
  storage.removeItem(SLOT);
  const fresh = typeof note?.plugin === 'string' && typeof note.at === 'number' && now >= note.at && now - note.at <= MAX_AGE;
  return fresh ? { plugin: note.plugin, params } : null;
}

/**
 * A provider plugin's own part of its setup (decision 15): its panel, on its provider's page and as the
 * featured one-tap start, and a sign-in coming back to annai's address. The core names no provider: the
 * featured one is the catalog's (spec §9.8). @typedef {{ id: string, name: string, key: boolean }} PanelProvider
 */

/**
 * What a panel and a sign-in get (docs/plugins.md). add and keep work only on this plugin's providers, and
 * annai keeps the key in its secrets (§9.9). A key given as a function is asked for once all else is in
 * place, so no key is made that annai can't keep. added: told of a provider add made, as the plugin's own Add
 * flow opens its page. @param {any} ctx @param {string} pluginId @param {{ added?: (id: string) => unknown }} [o]
 */
export function setupUi(ctx, pluginId, { added } = {}) {
  /** @param {any} key */
  const take = async (key) => (typeof key === 'function' ? String(await key()) : key ?? null);
  return Object.freeze({
    plugin: pluginId,
    h,
    render: () => ctx.render?.(),
    /** A page annai opens comes back to Safari, not here: an iPhone Home Screen app. */
    get returnsElsewhere() {
      return platform() === 'ios' && isStandalone();
    },
    /** @param {{ key?: any, roles?: 'recommended' | 'free' | null, name?: string, baseUrl?: string, abilities?: Record<string, { on: boolean, baseUrl?: string }> }} [o] */
    add: async ({ key, roles, name, baseUrl, abilities } = {}) => {
      // Keys go where its description says, which its install screen named (§5.3); anywhere only for a provider of any address.
      const m = await ctx.plugins.manifestOf(pluginId);
      const where = descOrigins(m?.provider);
      for (const u of [baseUrl, ...Object.values(abilities ?? {}).map((a) => a?.baseUrl)].filter(Boolean)) {
        const wrong = addressProblem(String(u));
        if (wrong) throw new Error(wrong);
        const at = new URL(String(u)).origin;
        if (m?.catchAll !== true && !where.includes(at)) throw new Error(`${m?.name ?? pluginId} can't add a provider at ${at}: it sends keys only to ${where.join(', ') || 'none'}.`);
      }
      // What failed, in words a panel can show as they are: no plugin's id in them.
      const id = await ctx.llm.addProvider(pluginId, { key: typeof key === 'function' ? () => take(key) : key, roles, name, baseUrl, abilities })
        .catch((/** @type {unknown} */ e) => { throw new Error(messageOf(e), { cause: e }); });
      await added?.(id);
      return id;
    },
    /** @param {string} providerId @param {any} key */
    keep: async (providerId, key) => {
      const rec = (await ctx.llm.config()).providers[providerId];
      if (!rec) throw new Error('That provider no longer exists. Add it again in Settings → Models.');
      const mine = ctx.llm.providers().find((/** @type {any} */ s) => s.plugin === pluginId)?.name ?? pluginId;
      if (rec.plugin !== pluginId) throw new Error(`That provider isn't one of ${mine}'s, so it can't keep a key for it.`);
      await setKey(ctx.store, providerId, await take(key));
      await ctx.llm.unbench(providerId);
    },
    expectReturn: () => expectReturn(pluginId),
  });
}

/**
 * A plugin's panel (provider null: its own start); what it throws, or gives that isn't an element, counts
 * against it (§5.5), and there is none. @param {any} ctx @param {string} pluginId @param {PanelProvider | null} provider
 * @param {Parameters<typeof setupUi>[2]} [o] @returns {HTMLElement | null}
 */
export function drawPanel(ctx, pluginId, provider, o) {
  const s = setupOf(ctx.registry, pluginId);
  const panel = s?.panel;
  return panel ? made(ctx, { pluginId, item: s }, 'provider setup panel', () => panel(setupUi(ctx, pluginId, o), provider), (x) => (x === null || x instanceof Node ? null : 'its panel is no element')) : null;
}

/** A catalog entry that makes a model provider, by the rule a restore's plugins follow (review M1). */
export const isProviderEntry = makesProvider;

/**
 * Installs annai's own provider plugin that a provider record names but this device lacks, on the provider page's tap
 * (a restore brings records back without their plugins). Only a catalog entry that makes a model provider: a record
 * is data, and may name anything (review M1). One that then gives no provider is removed again. @param {any} ctx @param {any} entry
 */
export async function installMissing(ctx, entry) {
  if (!isProviderEntry(entry)) throw new Error(`${entry?.name ?? 'That plugin'} isn't a model provider.`);
  try {
    await ctx.llm.installProvider(entry.id, { official: true });
  } catch (e) {
    if ((await ctx.plugins.installed())[entry.id] && !ctx.llm.providers().some((/** @type {any} */ x) => x.plugin === entry.id)) await ctx.plugins.uninstall(entry.id).catch(() => {});
    throw e;
  }
}

/** @type {string | null} the plugin a sign-in is being finished for, by name */
let finishing = null;
/** @type {{ id: string, name: string, featured: string } | null} the catalog's featured provider, once ready in this run */
let featured = null;

/**
 * The featured provider (only annai's catalog marks one), its plugin installed in the background while no
 * provider exists, so its sign-in is there before the tap (spec §9.8). annai's own, installed and running,
 * is used as it is, with no wait on the catalog (a flaky connection, a sign-in coming back adding with it);
 * its manifest came from annai's catalog. null: none, or a provider exists. @param {any} ctx
 */
export async function readyFeatured(ctx) {
  await ctx.llm.ready;
  const state = await ctx.plugins.installed();
  const own = (/** @type {string} */ id) => state[id]?.source === 'official' && setupOf(ctx.registry, id)?.panel;
  if (featured && own(featured.id)) return featured;
  for (const e of ctx.registry.entries('provider-setup')) {
    const m = own(e.pluginId) ? await ctx.plugins.manifestOf(e.pluginId) : null;
    if (typeof m?.featured === 'string' && m.featured) return (featured = { id: e.pluginId, name: String(m.name), featured: m.featured });
  }
  const entry = (await officialPlugins().catch(() => {
    throw new Error('Connect to the internet to sign in.');
  })).find((p) => typeof p.featured === 'string' && p.featured);
  if (!entry || !(await ctx.llm.prepareStart(entry.id))) return null;
  return (featured = { id: entry.id, name: entry.name, featured: String(entry.featured) });
}

/** The one-tap start: the featured provider's panel; until it is in, a disabled button, never a link without an address. @param {any} ctx */
export function featuredStart(ctx) {
  const slot = h('div', {});
  const status = h('p', { class: 'sub', role: 'status', text: finishing ? `Finishing the sign-in with ${finishing}…` : '' });
  /** @param {{ id: string, name: string }} f */
  const show = (f) => {
    const panel = drawPanel(ctx, f.id, null);
    slot.replaceChildren(...(panel ? [panel] : []));
    if (!panel) status.textContent = `${f.name}'s sign-in couldn't be shown. Add it from Add a provider instead.`;
  };
  const section = h('section', { class: 'panel', 'aria-label': 'Sign in' }, h('h2', { class: 'section', text: 'The quickest start' }), slot, status);
  if (featured && setupOf(ctx.registry, featured.id)?.panel) show(featured);
  else {
    const wait = h('p', { class: 'sub' });
    slot.append(h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', disabled: true }, 'Getting the sign-in ready…')), wait);
    // Its plugin loads through the offline service: still none after a few seconds (or none in this browser), say so.
    const sw = globalThis.navigator?.serviceWorker;
    if (!sw?.controller) setTimeout(() => { if (!sw?.controller) wait.textContent = NO_SERVICE; }, sw ? 3000 : 0);
    readyFeatured(ctx).then((f) => (f ? show(f) : section.remove()), (e) => {
      slot.replaceChildren();
      status.textContent = messageOf(e);
    });
  }
  return section;
}

/**
 * When this page load is annai's address coming back to the plugin that expected it (decision 16): the
 * query leaves the address, Models says it is finishing, and the plugin's returned() takes the rest once
 * plugins have started; how it ends is on a card. Any other query is removed, and a card says a sign-in came back too late.
 * @param {any} ctx llm, store, registry, plugins, notices, render, go
 * @param {{ location?: { search: string, pathname: string, hash: string }, history?: { replaceState: History['replaceState'] }, storage?: KeyValue, now?: number }} [env]
 * @returns {Promise<boolean>} whether it was a return
 */
export async function finishReturn(ctx, env = {}) {
  const loc = env.location ?? location;
  if (!loc.search) return false;
  const back = returnFor(loc.search, env);
  (env.history ?? history).replaceState(null, '', `${loc.pathname}${back ? '#/models' : loc.hash}`);
  if (!back) {
    // In annai's own words: no plugin's are known for it.
    if (new URLSearchParams(loc.search).size) ctx.notices.card({ tone: 'warn', title: 'A sign-in came back too late', body: 'A sign-in came back, but annai no longer expected it: more than 15 minutes passed, or it was finished already. Start it again from Settings → Models.' });
    return false;
  }
  const name = String((await ctx.plugins.installed())[back.plugin]?.name ?? back.plugin);
  finishing = name;
  try {
    ctx.render?.();
    await ctx.llm.ready;
    const returned = setupOf(ctx.registry, back.plugin)?.returned;
    if (!returned) throw new Error(`${name} isn't running. Look at it in Settings → Plugins, then sign in again.`);
    await Promise.resolve(returned(back.params, setupUi(ctx, back.plugin))).catch((e) => {
      if (isPluginBug(e)) ctx.registry.fail(back.plugin, 'sign-in', e);
      throw e;
    });
  } catch (e) {
    ctx.notices.card({ tone: 'warn', title: `Signing in with ${name} didn't finish`, body: messageOf(e) });
  } finally {
    finishing = null;
  }
  return true;
}
