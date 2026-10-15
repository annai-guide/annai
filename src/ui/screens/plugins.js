import { h, twoStep } from '../dom.js';
import { readZip } from '../../core/zip.js';

/** @param {any} ctx */
export async function renderPlugins(ctx) {
  const rows = await ctx.plugins.describe();
  const input = h('input', {
    id: 'plugin-file', type: 'file', class: 'visually-hidden', accept: '.zip,application/zip',
    onchange: async () => {
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      try {
        if (!navigator.serviceWorker?.controller) {
          throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
        }
        const files = await readZip(new Uint8Array(await f.arrayBuffer()));
        const manifest = await ctx.plugins.install(files, { source: f.name });
        await ctx.plugins.start(manifest.id);
        ctx.notices.toast(`Installed ${manifest.name}.`);
      } catch (e) {
        ctx.notices.card({ tone: 'warn', title: "That plugin wasn't installed", body: String(/** @type {any} */ (e)?.message ?? e) });
      }
      ctx.render();
    },
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Plugins' }),
    h('p', { class: 'risk-note', text: 'A plugin gets full access to your trips and API keys. Only install plugins you trust.' }),
    h('ul', { class: 'cards' }, ...rows.map((/** @type {any} */ r) => row(ctx, r))),
    h('div', { class: 'acts' }, h('label', { class: 'btn pri', for: 'plugin-file' }, 'Install a plugin from a file'), input));
}

/** @param {any} ctx @param {any} r */
function row(ctx, r) {
  const on = r.enabled && !r.failing;
  const state = r.builtin ? 'Built in' : r.failing ? 'Turned off after repeated errors' : r.enabled ? (r.active ? 'On' : "On, but it didn't start") : 'Off';
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: `${r.name} ${r.version}` }),
    h('span', { class: 'sub', text: state }),
    r.description ? h('p', { class: 'sub', text: r.description }) : null,
    r.builtin ? null : h('div', { class: 'acts' },
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await ctx.plugins.setEnabled(r.id, !on);
          } catch (e) {
            ctx.notices.card({ tone: 'warn', title: `${r.name} didn't start`, body: String(/** @type {any} */ (e)?.message ?? e) });
          }
          ctx.render();
        },
      }, on ? 'Turn off' : 'Turn on'),
      twoStep('Uninstall', 'Tap again to uninstall', async () => { await ctx.plugins.uninstall(r.id); ctx.render(); })));
}
