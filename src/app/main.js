import { VERSION } from './version.js';
import { createIdbStore } from '../core/store-idb.js';
import { Workspace } from '../core/workspace.js';
import { makeSchemaFor } from '../core/schema.js';
import { kindOf, ensureBaseScopes, syncTripTitles, SYS } from '../core/scopes.js';
import { Registry } from '../core/registry.js';
import { PluginHost } from '../core/plugins.js';
import { logEvent } from '../core/events.js';
import { acquireInstanceLock } from '../core/lock.js';
import { startShell, showBlocking } from '../ui/shell.js';
import { h } from '../ui/dom.js';
import { isStandalone, requestPersist } from '../ui/platform.js';
import { explainStorageFull } from '../ui/storage-full.js';
import { StorageFullError } from '../core/errors.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
/** @type {{ store: import('../core/types.js').Store } | null} */
let running = null;

async function boot() {
  const held = await acquireInstanceLock({
    onHeldElsewhere: () => showBlocking(root, {
      title: 'annai is open in another tab',
      body: 'Only one copy of annai runs at a time, so your trips stay consistent.',
      action: 'Use it here',
    }),
    onStolen: () => {
      running?.store.close();
      showBlocking(root, {
        title: 'annai was opened in another tab',
        body: 'This tab has stopped, so your trips stay consistent.',
        action: 'Use it here instead',
        onAction: () => location.reload(),
      });
    },
  });
  if (!held) return;

  const store = await createIdbStore();
  running = { store };
  const registry = new Registry({ log: (ev) => logEvent(store, SYS, ev) });
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  syncTripTitles(ws);
  const plugins = new PluginHost({ registry, workspace: ws });
  await plugins.addBuiltin(new URL('../plugins/core-schemas/index.js', import.meta.url).href);

  const shell = startShell(root, { store, ws, registry, plugins, version: VERSION });
  watchErrors(store, shell);
  if (isStandalone()) requestPersist();
  registerServiceWorker(store, shell);
  // Installed plugins start after the shell is up, so a plugin that hangs can never lock the user out of
  // Settings → Plugins (spec §17 rule 2). Each start has a time limit; see PluginHost.
  startPlugins(plugins, shell);
}

/** @param {PluginHost} plugins @param {{ notices: ReturnType<typeof import("../ui/notices.js").createNotices>, render: () => unknown }} shell */
async function startPlugins(plugins, shell) {
  const failures = await plugins.startInstalled();
  for (const f of failures) {
    const why = String(/** @type {any} */ (f.error)?.message ?? f.error);
    shell.notices.card(f.disabled
      ? { tone: 'warn', title: `The plugin "${f.id}" was turned off`, body: `It didn't start the last few times annai opened: ${why} You can turn it back on in Settings → Plugins.` }
      : { tone: 'warn', title: `The plugin "${f.id}" didn't start`, body: `${why} You can turn it off in Settings → Plugins.` });
  }
  if (location.hash.startsWith('#/plugins')) shell.render(); // show which plugins are now running
}

/** @param {any} store @param {ReturnType<typeof startShell>} shell */
async function registerServiceWorker(store, shell) {
  if (!('serviceWorker' in navigator)) return;
  let restartRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (restartRequested) location.reload(); // never on the first install, which also changes the controller
  });
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const announce = () => shell.setUpdateReady(() => {
      restartRequested = true;
      reg.waiting?.postMessage('skip-waiting');
    });
    if (reg.waiting && navigator.serviceWorker.controller) announce();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) announce();
      });
    });
  } catch (e) {
    logEvent(store, SYS, { type: 'error', data: { message: `The offline service didn't start: ${/** @type {any} */ (e)?.message ?? e}` } }).catch(() => {});
  }
}

/** Spec §17 rule 4: record unexpected errors, show a card, keep running. */
function watchErrors(/** @type {any} */ store, /** @type {ReturnType<typeof startShell>} */ shell) {
  const report = (/** @type {any} */ err) => {
    if (err instanceof StorageFullError) {
      // Logging it would need the space that ran out; the card says what to do.
      explainStorageFull({ notices: shell.notices, go: (/** @type {string} */ hash) => { location.hash = hash; } }, err);
      return;
    }
    logEvent(store, SYS, { type: 'error', data: { message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 2000) } }).catch(() => {});
    shell.notices.card({
      tone: 'warn', title: 'Something went wrong',
      body: 'annai kept running. The details are in Trace.',
      actions: [{ label: 'Open Trace', run: () => { location.hash = '#/trace'; } }],
    });
  };
  addEventListener('error', (e) => report(e.error ?? e.message));
  addEventListener('unhandledrejection', (e) => report(e.reason));
}

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('div', { class: 'blocking' },
    h('h1', { class: 'title', text: "annai couldn't start" }),
    h('p', { text: String(e?.message ?? e) }),
    h('p', { text: 'If this keeps happening, your browser may be blocking storage (for example, in a private window).' }),
    h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => location.reload() }, 'Try again'))));
});
