import { h, twoStep } from '../dom.js';
import { explainStorageFull } from '../storage-full.js';

const message = (/** @type {any} */ e) => String(e?.message ?? e);

/** @param {any} ctx */
export async function renderPlugins(ctx) {
  const rows = await ctx.plugins.describe();
  const input = h('input', {
    id: 'plugin-file', type: 'file', class: 'visually-hidden', accept: '.zip,application/zip',
    onchange: async () => {
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      await install(ctx, f);
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

/** Installs, then starts, a plugin; a failure in each step says which step it was. @param {any} ctx @param {File} f */
async function install(ctx, f) {
  /** @type {any} */
  let manifest;
  try {
    if (!navigator.serviceWorker?.controller) {
      throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
    }
    manifest = await ctx.plugins.installZip(new Uint8Array(await f.arrayBuffer()), { source: f.name });
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: "That plugin wasn't installed", body: message(e) });
    return;
  }
  if (ctx.plugins.needsRestart(manifest.id)) {
    restartCard(ctx, `Restart annai to run the new version of ${manifest.name}.`);
    return;
  }
  try {
    await ctx.plugins.start(manifest.id);
    ctx.notices.toast(`Installed ${manifest.name}.`);
  } catch (e) {
    ctx.notices.card({ tone: 'warn', title: `${manifest.name} was installed, but it didn't start`, body: `${message(e)} You can turn it off or uninstall it below.` });
  }
}

/** @param {any} ctx @param {string} title */
function restartCard(ctx, title) {
  ctx.notices.card({ title, body: 'The browser keeps the old code until annai starts again.', actions: [{ label: 'Restart annai', primary: true, run: () => location.reload() }] });
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

/** @param {any} ctx @param {any} r */
function row(ctx, r) {
  const on = r.enabled && !r.failing;
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: `${r.name} ${r.version}` }),
    h('span', { class: 'sub', text: stateOf(r) }),
    r.description ? h('p', { class: 'sub', text: r.description }) : null,
    r.builtin ? null : h('div', { class: 'acts' },
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
      twoStep('Uninstall', 'Tap again to uninstall', async () => { await ctx.plugins.uninstall(r.id); ctx.render(); })));
}
