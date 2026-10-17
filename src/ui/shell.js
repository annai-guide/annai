import { h } from './dom.js';
import { parseHash } from './router.js';
import { createNotices } from './notices.js';
import { installBanner } from './install.js';
import { setPendingImport } from './import-state.js';
import { renderTrips } from './screens/trips.js';
import { renderTrip } from './screens/trip.js';
import { renderFile } from './screens/file.js';
import { renderSettings } from './screens/settings.js';
import { renderImport } from './screens/import.js';
import { renderTrace } from './screens/trace.js';
import { renderPlugins } from './screens/plugins.js';
import { renderPluginInstall } from './screens/plugin-install.js';
import { renderModels } from './screens/models.js';
import { renderShiori } from './screens/shiori.js';
import { renderTalk } from './screens/talk.js';
import { renderTools } from './screens/tools.js';
import { renderPlan } from './screens/plan.js';
import { renderBooking } from './screens/booking.js';
import { renderVoice } from './screens/voice.js';
import { renderNow } from './screens/now.js';
import { renderDrive } from './screens/drive.js';
import { renderBackups } from './screens/backups.js';
import { renderRecap } from './screens/recap.js';
import { renderReplay } from './screens/replay.js';
import { renderSimulate } from './screens/simulate.js';
import { renderNotifications } from './screens/notifications.js';
import { createDock } from './dock.js';
import { renderExt, renderPluginPage, renderTripTab } from './screens/ext.js';
import { renderMcp } from './screens/mcp.js';
import { uiSignature, syncThemes, cleanUp, slotEntries, component, dockKey, pluginUi, made } from './slots.js';

/** @type {Record<string, (ctx: any, route: any) => Promise<Node>>} */
const SCREENS = { trips: renderTrips, trip: renderTrip, file: renderFile, settings: renderSettings, import: renderImport, trace: renderTrace, plugins: renderPlugins, 'plugin-install': renderPluginInstall, models: renderModels, shiori: renderShiori, talk: renderTalk, tools: renderTools, plan: renderPlan, booking: renderBooking, voice: renderVoice, now: renderNow, drive: renderDrive, backups: renderBackups, recap: renderRecap, replay: renderReplay, simulate: renderSimulate, notifications: renderNotifications, ext: renderExt, 'plugin-page': renderPluginPage, 'trip-ext': renderTripTab, mcp: renderMcp };

/**
 * @param {HTMLElement} root
 * @param {{ store: any, ws: any, registry: any, plugins: any, llm?: any, agent?: any, voice?: any, live?: any, awake?: any, pack?: any, presets?: Record<string, string>, backups?: any, sim?: any, push?: any, version: string }} core
 */
export function startShell(root, core) {
  const notices = createNotices();
  const main = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const builtIn = [['#/now', 'Now'], ['#/trips', 'Trips'], ['#/plan', 'Plan'], ['#/talk', 'Conversation'], ['#/trace', 'Trace'], ['#/settings', 'Settings']].map(([href, label]) => h('a', { href }, label));
  /** @type {HTMLAnchorElement[]} the top bar's links: annai's, then plugins' screens with a tab (choice 5 of milestone 8b) */
  let links = builtIn;
  const nav = h('nav', { class: 'topnav', 'aria-label': 'Main' }, ...links);
  const header = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/trips', 'aria-label': 'annai' }, 'ann', h('span', { class: 'brand-ai' }, 'ai')),
    nav);
  const drawTabs = () => {
    const tabs = slotEntries({ registry: core.registry }, 'ui:screen').filter((e) => e.item?.tab)
      .map((e) => h('a', { href: `#/ext/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.item.id)}`, text: String(e.item.title) }));
    links = [...builtIn, ...tabs];
    nav.replaceChildren(...links);
  };
  drawTabs();

  const update = { ready: false, apply: () => {} };
  const ctx = {
    ...core, notices, update,
    go: (/** @type {string} */ hash) => { if (location.hash === hash) render(); else location.hash = hash; },
    render: () => render(),
  };
  // The dock sits at the bottom of every screen (spec §16.2).
  // A plugin may make the whole dock (spec §16.4: named components); when its dock fails, annai's own is used.
  const makeDock = () => {
    const c = component(ctx, 'dock');
    const theirs = c && made(ctx, c, 'dock', () => c.item.create(pluginUi(ctx, c.pluginId)), (/** @type {any} */ d) =>
      d?.el instanceof Node ? null : 'its dock create() must return { el }');
    return theirs ? { el: theirs.el, setLarge() {}, refreshSlots() {} } : createDock(ctx);
  };
  let dock = core.agent ? makeDock() : null;
  let dockMadeFor = dockKey(ctx);
  /** @type {any} */ (ctx).dock = dock;
  root.replaceChildren(header, installBanner(), main, notices.el, ...(dock ? [dock.el] : []));
  const remakeDock = () => {
    if (!dock || dockKey(ctx) === dockMadeFor) return false;
    dockMadeFor = dockKey(ctx);
    cleanUp('dock');
    /** @type {any} */ (dock).dispose?.(); // what the old one listened to (minors 13)
    const made = makeDock();
    dock.el.replaceWith(made.el);
    dock = made;
    /** @type {any} */ (ctx).dock = dock;
    return true;
  };
  let seq = 0;
  async function render() {
    const my = ++seq;
    cleanUp('screen', my); // what plugins drew on the screen before
    const route = parseHash(location.hash);
    const section = route.name === 'simulate' || route.name === 'mcp' ? 'settings' : route.name === 'plan' ? 'plan' : route.name === 'drive' ? 'now' : route.parts[0] === 'trip' ? 'trips' : route.parts[0];
    const current = route.name === 'ext' ? location.hash : `#/${section}`;
    for (const a of links) {
      if (a.getAttribute('href') === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const screen = SCREENS[route.name] ?? SCREENS.trips;
    try {
      // Its screen's ctx says which render it is, so what it draws after a newer one began is cleaned up at once (minors 15).
      const node = await screen(Object.create(ctx, { seq: { value: my } }), route);
      if (my !== seq) return;
      main.replaceChildren(node);
    } catch (e) {
      if (my !== seq) return;
      main.replaceChildren(h('div', { class: 'screen' },
        h('h1', { class: 'title', text: "This screen couldn't open" }),
        h('p', { text: String(/** @type {any} */ (e)?.message ?? e) }),
        h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips'))));
      dispatchEvent(new ErrorEvent('error', { error: e, message: String(e) }));
    }
  }
  addEventListener('hashchange', render);
  // What plugins add redraws when it changes (choice 9 of milestone 8b): once per change, not per item.
  if (core.registry) {
    syncThemes(core.registry, document.head);
    let drawn = uiSignature(core.registry);
    let queued = false;
    core.registry.onChange(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        const now = uiSignature(core.registry);
        if (now === drawn) return;
        drawn = now;
        syncThemes(core.registry, document.head);
        drawTabs();
        if (!remakeDock()) /** @type {any} */ (ctx).dock?.refreshSlots?.();
        render();
      }, 0);
    });
  }
  // Spec §12.3: a file dropped anywhere on annai opens on the import screen.
  addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    setPendingImport(files);
    ctx.go('#/import');
  });
  render();
  return {
    notices,
    render,
    /** Shown in Settings → App once a new version is waiting. @param {() => void} apply */
    setUpdateReady(apply) {
      update.ready = true;
      update.apply = apply;
      notices.card({ title: 'An update is ready', body: 'It will be used the next time annai starts.', actions: [{ label: 'Restart now', primary: true, run: apply }] });
    },
  };
}

/**
 * A full-screen message with one action, used for the single-instance lock.
 * @param {HTMLElement} root
 * @param {{ title: string, body: string, action: string, onAction?: () => void }} msg
 * @returns {Promise<boolean>} resolves true when the action is chosen
 */
export function showBlocking(root, { title, body, action, onAction }) {
  return new Promise((resolve) => {
    root.replaceChildren(h('div', { class: 'blocking' },
      h('h1', { class: 'title', text: title }),
      h('p', { text: body }),
      h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => { onAction?.(); resolve(true); } }, action))));
  });
}
