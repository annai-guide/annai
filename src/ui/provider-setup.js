import { h, messageOf } from './dom.js';
import { made } from './slots.js';
import { platform, isStandalone } from './platform.js';
import { expectReturn, returnFor } from './returns.js';
import { setKey } from '../core/llm/config.js';
import { setupOf } from '../core/llm/setup.js';
import { isPluginBug } from '../core/registry.js';

/**
 * A provider plugin's own part of its setup (decision 15): its panel, on its provider's page and as the
 * featured one-tap start, and a sign-in coming back to annai's address. The core names no provider: the
 * featured one is the catalog's (spec §9.8). @typedef {{ id: string, name: string, key: boolean }} PanelProvider
 */

/**
 * What a panel and a sign-in get (docs/plugins.md). add and keep work only on this plugin's providers, and
 * annai keeps the key in its secrets (§9.9). A key given as a function is asked for once all else is in
 * place, so no key is made that annai can't keep. @param {any} ctx @param {string} pluginId
 */
export function setupUi(ctx, pluginId) {
  /** @param {any} key */
  const take = async (key) => (typeof key === 'function' ? String(await key()) : key ?? null);
  return Object.freeze({
    plugin: pluginId,
    h,
    go: (/** @type {string} */ hash) => ctx.go(String(hash)),
    toast: (/** @type {string} */ text) => ctx.notices.toast(String(text)),
    card: (/** @type {any} */ c) => ctx.notices.card({ title: String(c?.title ?? ''), body: c?.body === undefined ? undefined : String(c.body), tone: c?.tone, actions: c?.actions }),
    render: () => ctx.render?.(),
    /** A page annai opens comes back to Safari, not here: an iPhone Home Screen app. */
    get returnsElsewhere() {
      return platform() === 'ios' && isStandalone();
    },
    /** @param {{ key?: any, roles?: 'recommended' | 'free' | null, name?: string, baseUrl?: string, abilities?: Record<string, { on: boolean, baseUrl?: string }> }} [o] */
    add: ({ key, roles, name, baseUrl, abilities } = {}) => ctx.llm.addProvider(pluginId, { key: typeof key === 'function' ? () => take(key) : key, roles, name, baseUrl, abilities }),
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
 * against it (§5.5), and there is none. @param {any} ctx @param {string} pluginId @param {PanelProvider | null} provider @returns {HTMLElement | null}
 */
export function drawPanel(ctx, pluginId, provider) {
  const s = setupOf(ctx.registry, pluginId);
  const panel = s?.panel;
  return panel ? made(ctx, { pluginId, item: s }, 'provider setup panel', () => panel(setupUi(ctx, pluginId), provider), (x) => (x === null || x instanceof Node ? null : 'its panel is no element')) : null;
}

/** A provider page's panel, and whether the key field follows it (always, when no panel drew). @param {any} ctx @param {string} pluginId @param {PanelProvider} provider */
export function connection(ctx, pluginId, provider) {
  const panel = drawPanel(ctx, pluginId, provider);
  return { panel, keyField: !panel || setupOf(ctx.registry, pluginId)?.keyField !== false };
}

/** The plugin a sign-in is being finished for, by name, while it is. @type {string | null} */
let finishing = null;
export const returning = () => finishing;

/**
 * When this page load is annai's address coming back to the plugin that expected it (decision 16): the
 * query leaves the address, Models says it is finishing, and the plugin's returned() takes the rest once
 * plugins have started; how it ends is on a card. Any other query is removed and ignored.
 * @param {any} ctx llm, store, registry, plugins, notices, render, go
 * @param {{ location?: { search: string, pathname: string, hash: string }, history?: { replaceState: History['replaceState'] }, storage?: import('./returns.js').KeyValue, now?: number }} [env]
 * @returns {Promise<boolean>} whether it was a return
 */
export async function finishReturn(ctx, env = {}) {
  const loc = env.location ?? location;
  if (!loc.search) return false;
  const back = returnFor(loc.search, env);
  (env.history ?? history).replaceState(null, '', `${loc.pathname}${back ? '#/models' : loc.hash}`);
  if (!back) return false;
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
