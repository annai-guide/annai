import { VERSION } from './version.js';
import { createIdbStore } from '../core/store-idb.js';
import { Workspace } from '../core/workspace.js';
import { makeSchemaFor } from '../core/schema.js';
import { kindOf, ensureBaseScopes, syncTripTitles, removeLeftovers, SYS } from '../core/scopes.js';
import { Registry } from '../core/registry.js';
import { PluginHost } from '../core/plugins.js';
import { watchAppends, deliverHooks } from '../core/hooks.js';
import { logEvent } from '../core/events.js';
import { acquireInstanceLock } from '../core/lock.js';
import { startShell, showBlocking } from '../ui/shell.js';
import { h } from '../ui/dom.js';
import { isStandalone, requestPersist, watchForUpdates, restartInto, platform, deviceName, connectionOf } from '../ui/platform.js';
import { explainStorageFull } from '../ui/storage-full.js';
import { StorageFullError } from '../core/errors.js';
import { createLlm } from '../core/llm/service.js';
import { moveOver } from '../core/llm/move-over.js';
import { finishReturn } from '../ui/provider-setup.js';
import { secretFreeLog, tracedFetch, withoutSecrets } from '../core/agent/net.js';
import { disabledCard } from '../ui/plugin-cards.js';
import { Updates, DAILY } from '../ui/updates.js';
import { Halves } from '../core/agent/halves.js';
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
import { SimRun, recoverSimulation } from '../core/live/sim-run.js';
import { tellGps } from '../ui/live-help.js';
import { keepAwake } from '../ui/wake-lock.js';
import { PackKeeper } from '../core/pack/keeper.js';
import { createBackups } from '../core/backup.js';
import { ensureProvided } from '../core/llm/official.js';
import { startBackups } from '../ui/auto-backup.js';
import { PushMirror } from '../core/push/mirror.js';
import { browserSource, takeNews, onPushMessage, closeNotifications } from '../ui/push.js';
import { shouldWelcome } from '../ui/welcome.js';

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

  // Every committed log append goes to plugins' hooks (spec §5.4), once the registry exists.
  let deliver = (/** @type {any[]} */ _evs) => {};
  const store = watchAppends(await createIdbStore(), (evs) => deliver(evs));
  running = { store };
  // What plugins say when they fail can echo a key: the log keeps none (spec §9.9).
  const registry = new Registry({ log: secretFreeLog(store, SYS) });
  deliver = (evs) => deliverHooks(registry, evs);
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // What a late request wrote into a removed trip goes now; if this fails, it goes at the next start (spec §4.9).
  await removeLeftovers(store).catch(() => {});
  // Endpoints from before providers go, with their keys, before Models is first drawn; a card says so once the shell is up.
  const moved = await moveOver(ws, store).catch((e) => { console.warn("the old endpoints couldn't be moved over", e); return null; });
  syncTripTitles(ws);
  const plugins = new PluginHost({ registry, workspace: ws });
  await plugins.addBuiltin(new URL('../plugins/core-schemas/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/files/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/web/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/places/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/go/index.js', import.meta.url).href);
  await plugins.addBuiltin(new URL('../plugins/skills/index.js', import.meta.url).href);
  // MCP servers the user adds give Shiori their tools (spec §5.1).
  await plugins.addBuiltin(new URL('../plugins/mcp/index.js', import.meta.url).href);
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

  // Shiori (spec §6), talking about the trip that was open last: one half, or two when a Koe model is set
  // (the Koe and Kokoro design). Her own tools are Kokoro's, the half that is Shiori as she always was.
  const agent = new Halves({ store, ws, llm, registry, codec, voice });
  // Steering-wheel and headset buttons tap Shiori while voice is on (spec §18, an experiment).
  mediaKeys({ session: /** @type {any} */ (navigator).mediaSession, agent, voice });
  agent.addLoopTools(selfTools(agent.kokoro));
  // Live mode (spec §11): watches, the plan's own reminders, catch-up. The phone's sensors come in a plugin.
  // Notifications for a closed annai (spec §11.6): what the service worker saw is read at each
  // catch-up; the mirror keeps the push relay in step with live mode.
  /** @type {PushMirror | null} */
  let push = null;
  const news = async () => {
    const list = await takeNews().catch(() => []);
    push?.delivered(list);
    return list;
  };
  /** @type {unknown[]} live mode's problems from before the shell is up */
  const liveEarly = [];
  let liveProblem = (/** @type {unknown} */ e) => { liveEarly.push(e); };
  const live = new Live({ store, ws, registry, agent, news, problem: (e) => liveProblem(e), close: (keys) => { closeNotifications(keys).catch(() => {}); } });
  /** @type {any[]} cards from before the shell is up */
  const early = [];
  let pushCard = (/** @type {any} */ n) => { early.push(n); };
  push = new PushMirror({ store, ws, live, source: browserSource(), notice: (n) => pushCard(n), online: () => navigator.onLine !== false });
  agent.addLoopTools(watchTools(live));
  agent.sense = () => live.nowInfo();
  // Koe's view of the trip names the open conversation's next reminder.
  agent.next = async () => (await live.reminders())?.find((r) => r.scope === agent.scope && r.due >= Date.now()) ?? null;
  const awake = keepAwake({ live, ws });
  // Developer → Simulate a trip (spec §13): one at a time, shared by its screen and the live chip.
  const sim = new SimRun({ store, ws, registry, agent, live, llm });
  // The offline pack (spec §11.5): downloaded when asked, then kept up to date on Wi-Fi; it names places for live mode.
  const pack = new PackKeeper({ store, ws, agent, version: VERSION, connection: () => connectionOf(navigator), visible: () => document.visibilityState === 'visible' });
  live.namers.push((p) => pack.name(p));
  addEventListener('online', () => pack.poke());
  /** @type {any} */ (navigator).connection?.addEventListener?.('change', () => pack.poke());
  document.addEventListener('visibilitychange', () => pack.poke());
  const presets = await loadPresets();
  // The conversation starts opening before the first screen, which waits for it (agent.opening).
  // A simulation the page went away in the middle of is over: the trip open before it comes back (spec §13).
  await recoverSimulation({ store, ws }).catch(() => {});
  const active = (await readAppSettings(ws)).activeTrip;
  const exists = active ? await store.tx(['scopes'], 'readonly', (t) => t.getScope(active)) : null;
  agent.open(exists ? active : null).catch((e) => console.warn('Shiori could not open the conversation', e));
  // Notifications start once live mode has loaded (their reminders are live mode's); each failure says whose it is.
  live.start().then(
    () => push?.start().catch((e) => console.warn('Notifications could not start', e)),
    (e) => console.warn('Live mode could not start', e),
  );
  // Backups to the places this device backs up to (spec §12.4). Choosing a kind of place installs its
  // plugin (§5.3), whose files load through the service worker.
  const device = deviceName();
  const backups = createBackups({
    store, ws, registry, app: VERSION, label: device.label, noun: device.noun, online: () => navigator.onLine !== false,
    ensure: async (type, o = {}) => {
      await controllerReady();
      await ensureProvided(plugins, 'storage-type', type, { keepOff: o.keepOff });
    },
  });
  // The welcome, once per device, at annai's plain start (the user, 2026-10-18): a link that opens a screen
  // (a shared trip, a share, the sign-in coming back) is never interrupted. Decided before the first draw.
  if (await shouldWelcome(ws, location).catch(() => false)) history.replaceState(history.state, '', '#/welcome');
  // Updates (spec §5.3, §17 rule 5): annai's own and its plugins', checked at start, on coming back to the screen,
  // once a day, and on Check now. Packages installed from an address are checked there, each request in the trace.
  const updates = new Updates({ host: plugins, env: { addressFetch: tracedFetch(store, SYS, { tool: 'plugin updates' }) } });
  updates.agent = agent;
  updates.voice = voice;
  const shell = startShell(root, { store, ws, registry, plugins, llm, agent, voice, live, awake, pack, presets, backups, sim, push, updates, version: VERSION });
  updates.notices = shell.notices;
  updates.changed = (waits) => { if (/^#\/updates\b/.test(location.hash) || (waits && /^#\/(settings|plugins)\b/.test(location.hash))) shell.redraw(); };
  pushCard = (n) => shell.notices.card({ tone: 'warn', title: n.title, body: n.body, actions: [{ label: 'Notifications', run: () => { location.hash = '#/notifications'; } }] });
  if (moved) {
    shell.notices.card({
      title: 'Settings → Models changed',
      body: `annai now sets up providers: one address and one key for all a provider offers. Your endpoints (${moved.names.join(', ')}) and their keys were removed. Add them again in Settings → Models.`,
      actions: [{ label: 'Open Models', primary: true, run: () => { location.hash = '#/models'; } }],
    });
  }
  for (const n of early.splice(0)) pushCard(n);
  // A plugin switched off after repeated errors gets a card saying why (spec §5.5), with no key in it.
  registry.onDisabled(async (d) => {
    const row = (await plugins.describe().catch(() => [])).find((/** @type {any} */ r) => r.id === d.pluginId);
    shell.notices.card({
      ...disabledCard({ name: row?.name ?? d.pluginId, reason: d.reason, message: await withoutSecrets(store, d.message) }),
      actions: [{ label: 'Plugins', run: () => { location.hash = '#/plugins'; } }],
    });
  });
  // Open and on screen: the service worker's news now (a notification annai already said is closed).
  onPushMessage(async () => {
    if (document.visibilityState !== 'visible') return; // read at the catch-up
    // In live mode's own queue (news() above reads it, and tells the mirror), so a catch-up starting now reads it once (fix pass N2).
    closeNotifications(await live.newsArrived()).catch(() => {});
  });
  addEventListener('online', () => { push?.sync().catch(() => {}); });
  // Deletions of what providers keep of the conversations, waiting for a connection (G2).
  addEventListener('online', () => { llm.drainKept().catch(() => {}); });
  plugins.connect({ llm, agent, notices: shell.notices });
  // A card the agent names (key) is taken down when a later turn works, and replaced by a newer one of its name.
  /** @type {Map<string, () => void>} */
  const named = new Map();
  agent.on('clear', (/** @type {string} */ key) => named.get(key)?.());
  agent.on('notice', (n) => {
    if (n.key) named.get(n.key)?.();
    const dismiss = shell.notices.card(n);
    if (n.key) named.set(n.key, dismiss);
  });
  tellGps({ live, notices: shell.notices });
  // Leaving the page cancels Shiori's request; WebKit does so before pagehide, as the navigation begins.
  // A beforeunload that leads nowhere (the page stays) is forgotten after a few seconds.
  addEventListener('beforeunload', () => {
    agent.leaving();
    setTimeout(() => agent.leaving(false), 3000);
  });
  addEventListener('pagehide', () => {
    agent.leaving();
    agent.hush('away');
  });
  // A live session (K5) closes when the page goes out of view: its microphone never runs unseen. What comes meanwhile waits for it.
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? agent.hush('away') : agent.shown()));
  addEventListener('pageshow', (e) => { if (e.persisted) agent.leaving(false); });
  offerPersonalityUpdates({ ws, agent, presets, notices: shell.notices });
  // Live mode's own failures (a log it can't write) are reported like any unexpected error (spec §17 rule 4).
  liveProblem = watchErrors(store, shell);
  for (const e of liveEarly.splice(0)) liveProblem(e);
  if (isStandalone()) requestPersist();
  registerServiceWorker(store, shell, updates);
  // Installed plugins start after the shell is up, so a plugin that hangs can never lock the user out of
  // Settings → Plugins (spec §17 rule 2). Each start has a time limit; see PluginHost.
  pluginsMayLoad().then(() => startPlugins(plugins, shell)).finally(() => {
    pluginsStarted();
    controllerReady().then(() => updates.start()).catch(() => {});
    // The link catalog is kept for offline use: fetched now, so it is there before the first offline moment (spec §7.2).
    loadLinks({ ws }).catch(() => {});
    // Automatic backups start once installed plugins have: a place's kind comes from its plugin.
    startBackups({ backups, store, notices: shell.notices, go: (hash) => { location.hash = hash; } });
  });
  // An iPhone Home Screen app that comes back from the background only resumes: the browser checks nothing then.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updates.auto().catch(() => {}); });
  setInterval(() => updates.auto().catch(() => {}), DAILY);
  // A sign-in comes back to annai's address, for the plugin that started it (decision 16).
  finishReturn({ llm, store, registry, plugins, notices: shell.notices, render: shell.render, go: (/** @type {string} */ hash) => { location.hash = hash; } })
    .then((was) => { if (was) shell.render(); });
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
 * @param {{ ws: Workspace, agent: Halves, presets: Record<string, string>, notices: any }} c
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
 * files load through it (spec §5.3). On a first visit that takes a moment. A page loaded past an
 * active worker (a hard reload, or Android Chrome's for dark mode) asks it to take the page.
 */
function controllerReady(timeoutMs = 15_000) {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return Promise.resolve();
  const sw = navigator.serviceWorker;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      resolve(undefined);
    };
    const t = setTimeout(done, timeoutMs);
    sw.addEventListener('controllerchange', done, { once: true });
    sw.getRegistration().then((reg) => reg?.active?.postMessage('claim')).catch(() => {});
  });
}

/** Installed plugins start once an active worker controls the page: a failed import stays failed (spec §5.3). At most 15 s. */
async function pluginsMayLoad(timeoutMs = 15_000) {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  const reg = await Promise.race([navigator.serviceWorker.getRegistration().catch(() => undefined), new Promise((r) => { t = setTimeout(r, timeoutMs); })]);
  clearTimeout(t);
  if (/** @type {ServiceWorkerRegistration | undefined} */ (reg)?.active) await controllerReady(timeoutMs);
}

/** @param {any} store @param {ReturnType<typeof startShell>} shell @param {Updates} updates */
async function registerServiceWorker(store, shell, updates) {
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  try {
    const reg = await sw.register('/sw.js', { scope: '/' });
    // A version behind the one running, not the first install.
    const behind = (/** @type {ServiceWorker | null} */ w) => Boolean(w && sw.controller && sw.controller !== w);
    updates.app = { check: () => reg.update(), state: () => (behind(reg.installing) ? 'downloading' : 'none') };
    // Restart now, here and on Settings → Updates, waits for Shiori's turn to end (Updates.restart).
    const swap = restartInto(sw, reg);
    watchForUpdates(sw, reg, () => {
      updates.ready(swap);
      shell.setUpdateReady(() => { updates.restart(); });
    }, () => updates.downloadFailed());
  } catch (e) {
    logEvent(store, SYS, { type: 'error', data: { message: `The offline service didn't start: ${/** @type {any} */ (e)?.message ?? e}` } }).catch(() => {});
  }
}

/** Spec §17 rule 4: record unexpected errors, show a card, keep running. Returns how to report one. */
function watchErrors(/** @type {any} */ store, /** @type {ReturnType<typeof startShell>} */ shell) {
  const report = (/** @type {any} */ err) => {
    if (err instanceof StorageFullError) {
      // Logging it would need the space that ran out; the card says what to do.
      explainStorageFull({ notices: shell.notices, go: (/** @type {string} */ hash) => { location.hash = hash; } }, err);
      return;
    }
    // The card says the details are in Trace only once they are: what failed may be the writing itself (live mode's log).
    logEvent(store, SYS, { type: 'error', data: { message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 2000) } }).then(() => true, () => false).then((noted) => shell.notices.card({
      tone: 'warn', title: 'Something went wrong',
      body: noted ? 'annai kept running. The details are in Trace.' : "annai kept running, but couldn't write down what happened, so it isn't in Trace either. If it keeps happening, close annai and open it again.",
      actions: noted ? [{ label: 'Open Trace', run: () => { location.hash = '#/trace'; } }] : [],
    }));
  };
  addEventListener('error', (e) => report(e.error ?? e.message));
  addEventListener('unhandledrejection', (e) => report(e.reason));
  return report;
}

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('div', { class: 'blocking' },
    h('h1', { class: 'title', text: "annai couldn't start" }),
    h('p', { text: String(e?.message ?? e) }),
    h('p', { text: 'If this keeps happening, your browser may be blocking storage (for example, in a private window).' }),
    h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => location.reload() }, 'Try again'))));
});
