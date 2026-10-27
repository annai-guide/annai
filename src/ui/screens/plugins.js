import { h, crumb, t, twoStep, plural, otherLang, messageOf as message } from '../dom.js';
import { list, sentences } from '../format.js';
import { explainStorageFull } from '../storage-full.js';
import { officialUpdates } from '../../core/llm/official.js';
import { providerOf } from '../../core/llm/config.js';
import { applyUpdates, knownAddressUpdates } from '../plugin-updates.js';
import { sourceLine } from './plugin-install.js';
import { tracedFetch } from '../../core/agent/net.js';
import { SYS } from '../../core/scopes.js';
import { renderPlugin } from './plugin.js';
import { warnKept } from './provider.js';
import { finder, byKind } from './add.js';

/**
 * Settings → Plugins (spec §5.3, §16.2): what is installed, with updates, searched and filtered as
 * the catalog is (provider plugins under Model providers, naming the providers made from them). Add
 * opens the catalog's Add screen, where annai's catalog, a file or an address is installed from.
 * A plugin's own page is #/plugins/<id> (milestone 8b, choice 11).
 * @param {any} ctx @param {{ parts?: string[] }} [route]
 */
export async function renderPlugins(ctx, route) {
  if (route?.parts?.[1]) return renderPlugin(ctx, route.parts[1]);
  const rows = await ctx.plugins.describe();
  const told = await removalWords(ctx, rows);
  const updates = [...await officialUpdates(ctx.plugins).catch(() => []), ...await knownAddressUpdates(ctx.plugins).catch(() => [])];
  // Built in, or from annai's catalog, is official; from a file or an address, third-party.
  const entries = rows.map((/** @type {any} */ r) => ({ ...r, official: r.builtin || r.source === 'official' }));
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: t`Plugins` }),
    h('div', { class: 'acts' }, h('a', { class: 'btn pri', href: '#/add' }, t`Add`)),
    finder({ label: t`Search your plugins`, entries, draw: (found, typed) => byKind(found, typed, (x) => row(ctx, x.entry, updates.find((u) => u.id === x.entry.id), told.get(x.entry.id))) }).el);
}

/** The update offered for a plugin now, if any. @param {any} ctx @param {string} id */
export async function updateFor(ctx, id) {
  const all = [...await officialUpdates(ctx.plugins).catch(() => []), ...await knownAddressUpdates(ctx.plugins).catch(() => [])];
  return all.find((u) => u.id === id);
}

/** @param {any} r */
export function stateOf(r) {
  if (r.builtin) return t`Built in`;
  if (r.restart) return t`Restart annai to run the new version`;
  if (r.problem) return t`Can't start: ${r.problem}`;
  if (r.failing) return t`Turned off after repeated errors`;
  if (!r.enabled) return t`Off`;
  return r.active ? t`On` : t`On, but it didn't start`;
}


/**
 * What Plugins says of each installed plugin besides its state (milestone 1): a provider plugin's
 * providers (named: a plugin's page lists them instead), what removing it takes with it, and the plugins that need one.
 * @param {any} ctx @param {any[]} rows @returns {Promise<Map<string, { providers: { id: string, name: string }[], named: string | null, lines: string[] }>>}
 */
export async function removalWords(ctx, rows) {
  const cfg = await ctx.llm?.config().catch(() => null);
  /** @type {Map<string, { providers: { id: string, name: string }[], named: string | null, lines: string[] }>} */
  const out = new Map();
  for (const r of rows) {
    const providers = Object.values(cfg?.providers ?? {}).filter((p) => p.plugin === r.id).map((p) => ({ id: p.id, name: providerOf(p).name }));
    const needs = rows.filter((o) => o.id !== r.id && (o.requires ?? []).some((/** @type {any} */ q) => q.id === r.id)).map((o) => o.name);
    const names = providers.map((p) => p.name);
    const named = r.provider && providers.length ? t`Providers: ${list(names, 'plain')}.` : null;
    const lines = [];
    if (r.provider && !providers.length) lines.push(t`No provider is set up from it yet.`);
    if (named) lines.push(plural(providers.length, 'Removing it removes {0}, with its key and models.', 'Removing it removes {0}, with their keys and models.', list(names)));
    if (needs.length) lines.push(t`Needed by ${list(needs)}.`);
    out.set(r.id, { providers, named, lines });
  }
  return out;
}

/** @param {any} ctx @param {any} r @param {any} [update] @param {{ named: string | null, lines: string[] }} [told] */
function row(ctx, r, update, told) {
  return h('li', { class: 'card' },
    h('a', { class: 'name', href: `#/plugins/${encodeURIComponent(r.id)}`, text: [r.name, r.shownVersion].filter(Boolean).join(' ') }),
    h('span', { class: 'sub', text: stateOf(r) }),
    r.builtin ? null : h('span', { class: 'sub', text: [r.kind === 'skill' ? t`Skill` : r.provider ? t`Model provider` : null, sourceLine(r)].filter(Boolean).join(' · ') }),
    r.description ? h('p', { class: 'sub', text: r.description, lang: otherLang(r.lang) }) : null,
    ...[told?.named, ...(told?.lines ?? [])].filter(Boolean).map((line) => h('p', { class: 'sub', text: line })),
    r.builtin ? null : pluginActions(ctx, r, update));
}

/** Restarts annai, after Shiori's turn and into a new version that waits (Updates.restart). @param {any} ctx */
export const restartAnnai = (ctx) => ctx.updates?.restart() ?? location.reload();

/** "Update to 1.1.0": here, on a plugin's page and on Settings → Updates. @param {any} ctx @param {any} update */
export function updateButton(ctx, update) {
  return h('button', {
    class: 'btn pri', type: 'button',
    onclick: async (/** @type {Event} */ e) => {
      /** @type {HTMLButtonElement} */ (e.currentTarget).disabled = true;
      await applyUpdates(ctx, [update], { addressFetch: tracedFetch(ctx.store, SYS, { tool: /* en */ 'plugin updates' }), reload: () => restartAnnai(ctx) });
      ctx.render();
    },
  }, t`Update to ${update.available}`);
}

/** Update, Restart, Turn off or on, and Remove, for an installed plugin. @param {any} ctx @param {any} r @param {any} [update] */
export function pluginActions(ctx, r, update) {
  const on = r.enabled && !r.failing;
  // What its providers keep, named as Remove is armed (G2).
  const kept = h('p', { class: 'sub' });
  return h('div', { class: 'acts' },
      update ? updateButton(ctx, update) : null,
      r.restart ? h('button', { class: 'btn pri', type: 'button', onclick: () => restartAnnai(ctx) }, t`Restart annai`) : null,
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await ctx.plugins.setEnabled(r.id, !on);
          } catch (e) {
            if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: t`${r.name} didn't start`, body: message(e) });
          }
          ctx.render();
        },
      }, on ? t`Turn off` : t`Turn on`),
      twoStep(t`Remove`, t`Tap again to remove`, async () => {
        try {
          // A provider plugin takes the providers made from it, and the protocols nothing needs any more (spec §4.9).
          if (r.provider && ctx.llm) await ctx.llm.removeProviderPlugin(r.id);
          else await ctx.plugins.uninstall(r.id);
        } catch (e) {
          if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: t`${r.name} wasn't removed`, body: sentences(message(e), t`Try again.`) });
        }
        ctx.go('#/plugins');
      }, () => { if (r.provider) warnKept(ctx, kept, { plugin: r.id }); }),
      kept);
}
