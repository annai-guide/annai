import { h } from './dom.js';
import { made } from './slots.js';
import { platform, isStandalone } from './platform.js';
import { expectReturn } from './returns.js';
import { setKey } from '../core/llm/config.js';
import { setupOf } from '../core/llm/setup.js';

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
