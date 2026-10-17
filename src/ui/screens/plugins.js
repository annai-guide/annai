import { h, twoStep } from '../dom.js';
import { explainStorageFull } from '../storage-full.js';
import { officialUpdates, officialPlugins, installOfficial } from '../../core/llm/official.js';
import { applyUpdates, knownAddressUpdates } from '../plugin-updates.js';
import { setPendingPackage } from '../plugin-pending.js';
import { sourceLine } from './plugin-install.js';
import { fetchPackage, PLUGIN_MAX_BYTES } from '../../core/packages.js';
import { readZip } from '../../core/zip.js';
import { tracedFetch } from '../../core/agent/net.js';
import { SYS } from '../../core/scopes.js';

const message = (/** @type {any} */ e) => String(e?.message ?? e);
const NOT_INSTALLABLE = "That file isn't something annai can install";

/**
 * Settings → Plugins (spec §5.3): what is installed, with updates; installing from a file, an
 * address or annai's catalog. A file or an address goes to the install screen first (choice 8).
 * @param {any} ctx
 */
export async function renderPlugins(ctx) {
  const rows = await ctx.plugins.describe();
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
  const offered = (catalog ?? []).filter((p) => !installed.has(p.id));
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Plugins' }),
    h('p', { class: 'risk-note', text: 'A plugin gets full access to your trips and API keys. Only install plugins you trust.' }),
    h('ul', { class: 'cards' }, ...rows.map((/** @type {any} */ r) => row(ctx, r, updates.find((u) => u.id === r.id)))),
    h('section', { class: 'panel', 'aria-label': 'Add a plugin or skill' },
      h('h2', { class: 'section', text: 'Add a plugin or skill' }),
      h('div', { class: 'acts' }, h('label', { class: 'btn pri', for: 'plugin-file' }, 'Install from a file'), input),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Address of a plugin or skill' }), address),
      h('p', { class: 'sub', text: 'A zip file, an annai-plugin.json, or a SKILL.md, on a site that lets web apps read it (GitHub pages work).' }),
      error,
      h('div', { class: 'acts' }, get)),
    h('section', { class: 'panel', 'aria-label': "From annai's catalog" },
      h('h2', { class: 'section', text: "From annai's catalog" }),
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
    const files = await fetchPackage(url, { fetch: tracedFetch(ctx.store, SYS, { tool: 'plugins' }) });
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
          await installOfficial(ctx.plugins, entry);
          ctx.notices.toast(`Installed ${entry.name}.`);
        } catch (err) {
          if (!explainStorageFull(ctx, err)) ctx.notices.card({ tone: 'warn', title: `${entry.name} wasn't installed`, body: message(err) });
        }
        ctx.render();
      },
    }, 'Install')));
}

/** @param {any} r */
function stateOf(r) {
  if (r.builtin) return 'Built in';
  if (r.restart) return 'Restart annai to run the new version';
  if (r.problem) return `Can't start: ${r.problem}`;
  if (r.failing) return 'Turned off after repeated errors';
  if (!r.enabled) return 'Off';
  return r.active ? 'On' : "On, but it didn't start";
}

/** @param {any} ctx @param {any} r @param {any} [update] */
function row(ctx, r, update) {
  const on = r.enabled && !r.failing;
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: [r.name, r.shownVersion].filter(Boolean).join(' ') }),
    h('span', { class: 'sub', text: stateOf(r) }),
    r.builtin ? null : h('span', { class: 'sub', text: [r.kind === 'skill' ? 'Skill' : null, sourceLine(r)].filter(Boolean).join(' · ') }),
    r.description ? h('p', { class: 'sub', text: r.description }) : null,
    r.builtin ? null : h('div', { class: 'acts' },
      update ? h('button', {
        class: 'btn pri', type: 'button',
        onclick: async () => {
          await applyUpdates(ctx, [update], { addressFetch: tracedFetch(ctx.store, SYS, { tool: 'plugin updates' }) });
          ctx.render();
        },
      }, `Update to ${update.available}`) : null,
      r.restart ? h('button', { class: 'btn pri', type: 'button', onclick: () => location.reload() }, 'Restart annai') : null,
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
          await ctx.plugins.uninstall(r.id);
        } catch (e) {
          if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${r.name} wasn't removed`, body: `${message(e)} Try again.` });
        }
        ctx.render();
      })));
}
