import { h, twoStep, messageOf as message } from '../dom.js';
import { andList } from '../format.js';
import { explainStorageFull } from '../storage-full.js';
import { officialUpdates, officialPlugins } from '../../core/llm/official.js';
import { addFromCatalog } from '../../core/requires.js';
import { providerOf } from '../../core/llm/config.js';
import { applyUpdates, knownAddressUpdates } from '../plugin-updates.js';
import { setPendingPackage } from '../plugin-pending.js';
import { sourceLine } from './plugin-install.js';
import { fetchPackage, PLUGIN_MAX_BYTES } from '../../core/packages.js';
import { readZip } from '../../core/zip.js';
import { tracedFetch } from '../../core/agent/net.js';
import { addressParts } from '../../core/address.js';
import { SYS } from '../../core/scopes.js';
import { renderPlugin } from './plugin.js';

const NOT_INSTALLABLE = "That file isn't something annai can install";

/**
 * Settings → Plugins (spec §5.3): what is installed, with updates; installing from a file, an
 * address or annai's catalog. A file or an address goes to the install screen first (choice 8).
 * A plugin's own page is #/plugins/<id> (milestone 8b, choice 11).
 * @param {any} ctx @param {{ parts?: string[] }} [route]
 */
export async function renderPlugins(ctx, route) {
  if (route?.parts?.[1]) return renderPlugin(ctx, route.parts[1]);
  const rows = await ctx.plugins.describe();
  const told = await removalWords(ctx, rows);
  const updates = [...await officialUpdates(ctx.plugins).catch(() => []), ...await knownAddressUpdates(ctx.plugins).catch(() => [])];
  const catalog = await officialPlugins().catch(() => null);
  const input = h('input', {
    id: 'plugin-file', type: 'file', class: 'visually-hidden', accept: '.zip,.md,application/zip,text/markdown',
    onchange: async () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) await fromFile(ctx, f);
    },
  });
  const address = h('input', { id: 'plugin-address', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://…/SKILL.md' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const get = h('button', { class: 'btn', type: 'button', onclick: () => fromAddress(ctx, address.value, get, error) }, 'Get it');
  address.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') get.click(); });
  const installed = new Set(rows.map((/** @type {any} */ r) => r.id));
  // Model providers are added in Settings → Models, which makes the provider too (Milestone 3 brings one Add screen for both).
  const offered = (catalog ?? []).filter((p) => !installed.has(p.id) && !p.abilities?.length);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Plugins' }),
    h('p', { class: 'risk-note', text: "A plugin with code gets full access to your trips and API keys. Data-only plugins can't run anything. Only install plugins you trust." }),
    h('ul', { class: 'cards' }, ...rows.map((/** @type {any} */ r) => row(ctx, r, updates.find((u) => u.id === r.id), told.get(r.id)))),
    h('section', { class: 'panel', 'aria-label': 'Add a plugin or skill' },
      h('h2', { class: 'section', text: 'Add a plugin or skill' }),
      h('div', { class: 'acts' }, h('label', { class: 'btn pri', for: 'plugin-file' }, 'Install from a file'), input),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Address of a plugin or skill' }), address),
      h('p', { class: 'sub', text: 'A zip file, an annai-plugin.json, or a SKILL.md, on a site that lets web apps read it (GitHub file pages work).' }),
      error,
      h('div', { class: 'acts' }, get)),
    h('section', { class: 'panel', 'aria-label': "From annai's catalog" },
      h('h2', { class: 'section', text: "From annai's catalog" }),
      h('p', { class: 'sub' }, 'Model providers are added in ', h('a', { href: '#/models' }, 'Settings → Models'), '.'),
      catalog === null ? h('p', { class: 'sub', text: "annai's catalog couldn't be loaded. Check the connection and open this screen again." })
        : offered.length ? h('ul', { class: 'cards' }, ...offered.map((p) => catalogRow(ctx, p)))
          : h('p', { class: 'sub', text: "Every plugin in annai's catalog is installed." })));
}

/** A file picked: a zip, or a SKILL.md on its own. @param {any} ctx @param {File} f */
async function fromFile(ctx, f) {
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    /** @type {Map<string, Uint8Array>} */
    let files;
    if (/\.md$/i.test(f.name)) files = new Map([['SKILL.md', bytes]]);
    else {
      try {
        files = await readZip(bytes, { maxTotal: PLUGIN_MAX_BYTES });
      } catch (e) {
        throw new Error(`this file isn't a plugin package annai can open: ${message(e)}`);
      }
    }
    const pkg = await ctx.plugins.inspect(files);
    setPendingPackage({ files, pkg, from: { source: 'file', file: f.name } });
    ctx.go('#/plugin-install');
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: NOT_INSTALLABLE, body: message(e) });
  }
}

/** The keys an address may hold, or none when it isn't one. @param {string} url */
function keysIn(url) {
  try {
    return addressParts(url).keys;
  } catch {
    return [];
  }
}

/**
 * An address given: the package is fetched (each request in the trace) and checked, then shown.
 * @param {any} ctx @param {string} value @param {HTMLButtonElement} button @param {HTMLElement} error
 */
async function fromAddress(ctx, value, button, error) {
  const url = value.trim();
  error.hidden = true;
  if (!url) {
    error.textContent = 'Paste the address of a zip file, an annai-plugin.json or a SKILL.md first.';
    error.hidden = false;
    return;
  }
  button.disabled = true;
  button.textContent = 'Getting it…';
  try {
    // A key in the address isn't a secret yet: the trace blanks it all the same (fix pass 8a-1).
    const files = await fetchPackage(url, { fetch: tracedFetch(ctx.store, SYS, { tool: 'plugins', blank: keysIn(url) }) });
    const pkg = await ctx.plugins.inspect(files);
    setPendingPackage({ files, pkg, from: { source: 'url', url } });
    ctx.go('#/plugin-install');
  } catch (e) {
    error.textContent = message(e);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Get it';
  }
}

/** @param {any} ctx @param {any} entry an official plugin from annai's catalog */
function catalogRow(ctx, entry) {
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: `${entry.name} ${entry.version}` }),
    h('div', { class: 'acts' }, h('button', {
      class: 'btn', type: 'button', 'aria-label': `Install ${entry.name}`,
      onclick: async (/** @type {Event} */ e) => {
        const b = /** @type {HTMLButtonElement} */ (e.currentTarget);
        b.disabled = true;
        try {
          if (!navigator.serviceWorker?.controller) throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
          await addFromCatalog(ctx.plugins, entry.id, { tap: true }); // with what it requires
          ctx.notices.toast(`Installed ${entry.name}.`);
        } catch (err) {
          if (!explainStorageFull(ctx, err)) ctx.notices.card({ tone: 'warn', title: `${entry.name} wasn't installed`, body: message(err) });
        }
        ctx.render();
      },
    }, 'Install')));
}

/** The update offered for a plugin now, if any. @param {any} ctx @param {string} id */
export async function updateFor(ctx, id) {
  const all = [...await officialUpdates(ctx.plugins).catch(() => []), ...await knownAddressUpdates(ctx.plugins).catch(() => [])];
  return all.find((u) => u.id === id);
}

/** @param {any} r */
export function stateOf(r) {
  if (r.builtin) return 'Built in';
  if (r.restart) return 'Restart annai to run the new version';
  if (r.problem) return `Can't start: ${r.problem}`;
  if (r.failing) return 'Turned off after repeated errors';
  if (!r.enabled) return 'Off';
  return r.active ? 'On' : "On, but it didn't start";
}


/**
 * What Plugins says of each installed plugin besides its state (milestone 1): a provider plugin's
 * providers, what removing it takes with it, and the plugins that need one.
 * @param {any} ctx @param {any[]} rows @returns {Promise<Map<string, { providers: { id: string, name: string }[], lines: string[] }>>}
 */
export async function removalWords(ctx, rows) {
  const cfg = await ctx.llm?.config().catch(() => null);
  /** @type {Map<string, { providers: { id: string, name: string }[], lines: string[] }>} */
  const out = new Map();
  for (const r of rows) {
    const providers = Object.values(cfg?.providers ?? {}).filter((p) => p.plugin === r.id).map((p) => ({ id: p.id, name: providerOf(p).name }));
    const needs = rows.filter((o) => o.id !== r.id && (o.requires ?? []).some((/** @type {any} */ q) => q.id === r.id)).map((o) => o.name);
    const lines = [];
    if (r.provider) lines.push(providers.length ? `Providers: ${providers.map((p) => p.name).join(', ')}.` : 'No provider is set up from it yet.');
    if (r.provider && providers.length) lines.push(`Removing it removes ${andList(providers.map((p) => p.name))}, with their keys and models.`);
    if (needs.length) lines.push(`Needed by ${andList(needs)}.`);
    out.set(r.id, { providers, lines });
  }
  return out;
}

/** @param {any} ctx @param {any} r @param {any} [update] @param {{ lines: string[] }} [told] */
function row(ctx, r, update, told) {
  return h('li', { class: 'card' },
    h('a', { class: 'name', href: `#/plugins/${encodeURIComponent(r.id)}`, text: [r.name, r.shownVersion].filter(Boolean).join(' ') }),
    h('span', { class: 'sub', text: stateOf(r) }),
    r.builtin ? null : h('span', { class: 'sub', text: [r.kind === 'skill' ? 'Skill' : r.provider ? 'Model provider' : null, sourceLine(r)].filter(Boolean).join(' · ') }),
    r.description ? h('p', { class: 'sub', text: r.description }) : null,
    ...(told?.lines ?? []).map((t) => h('p', { class: 'sub', text: t })),
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
      await applyUpdates(ctx, [update], { addressFetch: tracedFetch(ctx.store, SYS, { tool: 'plugin updates' }), reload: () => restartAnnai(ctx) });
      ctx.render();
    },
  }, `Update to ${update.available}`);
}

/** Update, Restart, Turn off or on, and Remove, for an installed plugin. @param {any} ctx @param {any} r @param {any} [update] */
export function pluginActions(ctx, r, update) {
  const on = r.enabled && !r.failing;
  return h('div', { class: 'acts' },
      update ? updateButton(ctx, update) : null,
      r.restart ? h('button', { class: 'btn pri', type: 'button', onclick: () => restartAnnai(ctx) }, 'Restart annai') : null,
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await ctx.plugins.setEnabled(r.id, !on);
          } catch (e) {
            if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${r.name} didn't start`, body: message(e) });
          }
          ctx.render();
        },
      }, on ? 'Turn off' : 'Turn on'),
      twoStep('Remove', 'Tap again to remove', async () => {
        try {
          // A provider plugin takes the providers made from it, and the protocols nothing needs any more (spec §4.9).
          if (r.provider && ctx.llm) await ctx.llm.removeProviderPlugin(r.id);
          else await ctx.plugins.uninstall(r.id);
        } catch (e) {
          if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${r.name} wasn't removed`, body: `${message(e)} Try again.` });
        }
        ctx.go('#/plugins');
      }));
}
