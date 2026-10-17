import { VERSION } from './version.js';
import { createIdbStore } from '../core/store-idb.js';
import { Workspace } from '../core/workspace.js';
import { makeSchemaFor } from '../core/schema.js';
import { kindOf, ensureBaseScopes, syncTripTitles, removeLeftovers, SYS } from '../core/scopes.js';
import { Registry } from '../core/registry.js';
import { PluginHost } from '../core/plugins.js';
import { logEvent } from '../core/events.js';
import { acquireInstanceLock } from '../core/lock.js';
import { startShell, showBlocking } from '../ui/shell.js';
import { h } from '../ui/dom.js';
import { isStandalone, requestPersist, watchForUpdates, platform, deviceName, connectionOf } from '../ui/platform.js';
import { explainStorageFull } from '../ui/storage-full.js';
import { StorageFullError } from '../core/errors.js';
import { createLlm } from '../core/llm/service.js';
import { finishSignIn } from '../ui/openrouter.js';
import { secretFreeLog } from '../core/agent/net.js';
import { offerPluginUpdates } from '../ui/plugin-updates.js';
import { Agent } from '../core/agent/loop.js';
import { codec } from '../ui/photo-codec.js';
import { selfTools } from '../core/agent/self-tools.js';
import { loadLinks } from '../core/links.js';
import { PRESETS, syncPersonalities, keepMine } from '../core/agent/personalities.js';
import { readAppSettings } from '../core/settings.js';
import { Voice } from '../core/voice/voice.js';
import { mediaKeys } from '../ui/media-keys.js';
import { armUnlock } from '../ui/unlock.js';
import { Live } from '../core/live/live.js';
import { watchTools } from '../core/live/watch-tools.js';
import { SimRun } from '../core/live/sim-run.js';
import { tellGps } from '../ui/live-help.js';
import { keepAwake } from '../ui/wake-lock.js';
import { PackKeeper } from '../core/pack/keeper.js';
import { createBackups } from '../core/backup.js';
import { ensureProvided } from '../core/llm/official.js';
import { startBackups } from '../ui/auto-backup.js';

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
  // What plugins say when they fail can echo a key: the log keeps none (spec §9.9).
  const registry = new Registry({ log: secretFreeLog(store, SYS) });
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // What a late request wrote into a removed trip goes now; if this fails, it goes at the next start (spec §4.9).
  await removeLeftovers(store).catch(() => {});
  syncTripTitles(ws);
  const plugins = new PluginHost({ registry, workspace: ws });
  await plugins.addBuiltin(new URL('../plugins/core-schemas/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/files/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/web/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/places/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/go/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/voice-browser/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/sensors/index.js', import.meta.url).href);
  /** @type {(v?: unknown) => void} */
  let pluginsStarted = () => {};
  const llm = createLlm({ store, ws, plugins, ready: new Promise((resolve) => { pluginsStarted = resolve; }), pluginsCanLoad: controllerReady });
  // Speaking and hearing (spec §10): the speech lists, through this device's player and microphone.
  const voice = new Voice({ llm, ws, registry, store, locale: navigator.language, where: platform() });
  voice.refresh().catch(() => {});
  // Sound may play only after a tap (an iPhone rule, spec §10.1): every tap tries until one works.
  armUnlock(window, () => voice.unlock());

  // Shiori (spec §6): one agent, talking about the trip that was open last.
  const agent = new Agent({ store, ws, llm, registry, codec, voice });
  // Steering-wheel and headset buttons tap Shiori while voice is on (spec §18, an experiment).
  mediaKeys({ session: /** @type {any} */ (navigator).mediaSession, agent, voice });
  agent.addLoopTools(selfTools(agent));
  // Live mode (spec §11): watches, the plan's own reminders, catch-up. The phone's sensors come in a plugin.
  const live = new Live({ store, ws, registry, agent });
  agent.addLoopTools(watchTools(live));
  agent.sense = () => live.nowInfo();
  const awake = keepAwake({ live, ws });
  // Developer → Simulate a trip (spec §13): one at a time, shared by its screen and the live chip.
  const sim = new SimRun({ store, ws, registry, agent, live });
  // The offline pack (spec §11.5): downloaded when asked, then kept up to date on Wi-Fi; it names places for live mode.
  const pack = new PackKeeper({ store, ws, agent, version: VERSION, connection: () => connectionOf(navigator), visible: () => document.visibilityState === 'visible' });
  live.namers.push((p) => pack.name(p));
  addEventListener('online', () => pack.poke());
  /** @type {any} */ (navigator).connection?.addEventListener?.('change', () => pack.poke());
  document.addEventListener('visibilitychange', () => pack.poke());
  const presets = await loadPresets();
  // The conversation starts opening before the first screen, which waits for it (agent.opening).
  const active = (await readAppSettings(ws)).activeTrip;
  const exists = active ? await store.tx(['scopes'], 'readonly', (t) => t.getScope(active)) : null;
  agent.open(exists ? active : null).catch((e) => console.warn('Shiori could not open the conversation', e));
  live.start().catch((e) => console.warn('Live mode could not start', e));
  // Backups to the places this device backs up to (spec §12.4). Choosing a kind of place installs its
  // plugin (§5.3), whose files load through the service worker.
  const device = deviceName();
  const backups = createBackups({
    store, ws, registry, app: VERSION, label: device.label, noun: device.noun,
    ensure: async (type) => {
      await controllerReady();
      await ensureProvided(plugins, 'storage-type', type);
    },
  });
  const shell = startShell(root, { store, ws, registry, plugins, llm, agent, voice, live, awake, pack, presets, backups, sim, version: VERSION });
  plugins.connect({ llm, agent, notices: shell.notices });
  agent.on('notice', (n) => shell.notices.card(n));
  tellGps({ live, notices: shell.notices });
  // Leaving the page cancels Shiori's request; WebKit does so before pagehide, as the navigation begins.
  // A beforeunload that leads nowhere (the page stays) is forgotten after a few seconds.
  addEventListener('beforeunload', () => {
    agent.leaving();
    setTimeout(() => agent.leaving(false), 3000);
  });
  addEventListener('pagehide', () => agent.leaving());
  addEventListener('pageshow', (e) => { if (e.persisted) agent.leaving(false); });
  offerPersonalityUpdates({ ws, agent, presets, notices: shell.notices });
  watchErrors(store, shell);
  if (isStandalone()) requestPersist();
  registerServiceWorker(store, shell);
  // Installed plugins start after the shell is up, so a plugin that hangs can never lock the user out of
  // Settings → Plugins (spec §17 rule 2). Each start has a time limit; see PluginHost.
  // Plugin updates are looked for at start and once a day, and only offered (spec §5.3).
  const lookForUpdates = () => controllerReady().then(() => offerPluginUpdates({ plugins, notices: shell.notices }));
  startPlugins(plugins, shell).finally(() => {
    pluginsStarted();
    lookForUpdates();
    // The link catalog is kept for offline use: fetched now, so it is there before the first offline moment (spec §7.2).
    loadLinks({ ws }).catch(() => {});
    // Automatic backups start once installed plugins have: a place's kind comes from its plugin.
    startBackups({ backups, store, notices: shell.notices, go: (hash) => { location.hash = hash; } });
  });
  setInterval(lookForUpdates, 24 * 60 * 60 * 1000);
  // OpenRouter's sign-in comes back to annai's address with a code (spec §9.8).
  finishSignIn({ llm, ws, store, notices: shell.notices }).then((was) => { if (was) shell.render(); });
}

/** annai's own personalities as shipped, for installing and "reset to original" (spec §14.1). @returns {Promise<Record<string, string>>} */
async function loadPresets() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const n of PRESETS) {
    try {
      const res = await fetch(`/assets/personalities/${n}.md`);
      if (res.ok) out[n] = await res.text();
    } catch {
      // offline before the first install: the personalities come on a later start
    }
  }
  return out;
}

/**
 * Installs missing personalities, updates unedited ones silently, and offers a new original to an
 * edited copy (spec §14.1).
 * @param {{ ws: Workspace, agent: Agent, presets: Record<string, string>, notices: any }} c
 */
async function offerPersonalityUpdates({ ws, agent, presets, notices }) {
  for (const o of await syncPersonalities({ ws, presets }).catch(() => [])) {
    notices.card({
      title: `A new version of the ${o.name} personality`,
      body: 'Yours has your own edits, so it was kept as it is.',
      actions: [
        { label: 'Compare', run: () => { location.hash = `#/shiori?compare=${o.name}`; } },
        { label: 'Keep mine', run: () => { keepMine(ws, o.name, o.text); } },
        { label: 'Let Shiori merge', primary: true, run: () => agent.wake({ kind: 'personality', text: `A new version of annai's "${o.name}" personality is out. Merge it into the current one with tune_personality, keeping the user's edits. The new original:\n\n${o.text}` }) },
      ],
    });
  }
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

/**
 * Settles once a service worker controls this page (or after 15 s), because installed plugin
 * files load through it (spec §5.3). On a first visit that takes a moment.
 */
function controllerReady(timeoutMs = 15_000) {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      resolve(undefined);
    };
    const t = setTimeout(done, timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
  });
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
    watchForUpdates(navigator.serviceWorker, reg, () => shell.setUpdateReady(() => {
      restartRequested = true;
      reg.waiting?.postMessage('skip-waiting');
    }));
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
