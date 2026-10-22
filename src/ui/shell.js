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
import { renderAdd } from './screens/add.js';
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
import { tapKeepsKeyboard } from './tap-keeps-keyboard.js';
import { dockHidesWhileTyping } from './dock-hides.js';
import { noteScreen } from './resume.js';
import { renderExt, renderPluginPage, renderTripTab } from './screens/ext.js';
import { renderMcp } from './screens/mcp.js';
import { renderWelcome } from './screens/welcome.js';
import { renderAbout } from './screens/about.js';
import { renderUpdates } from './screens/updates.js';
import { renderExperimental } from './screens/experimental.js';
import { readAppSettings } from '../core/settings.js';
import { uiSignature, syncThemes, cleanUp, slotEntries, component, dockKey, pluginUi, made } from './slots.js';

/** @type {Record<string, (ctx: any, route: any) => Promise<Node>>} */
/** The top bar's tab each screen belongs to, where it isn't the screen's own name. */
const SECTION = /** @type {Record<string, string>} */ ({
  trip: 'trips', file: 'trips', booking: 'trips', recap: 'trips', replay: 'trips', 'trip-ext': 'trips', import: 'trips', drive: 'now',
  plugins: 'settings', add: 'settings', 'plugin-install': 'settings', 'plugin-page': 'settings', models: 'settings', shiori: 'settings', tools: 'settings',
  voice: 'settings', backups: 'settings', notifications: 'settings', simulate: 'settings', mcp: 'settings', about: 'settings', experimental: 'settings', updates: 'settings',
});
const SCREENS = { trips: renderTrips, trip: renderTrip, file: renderFile, settings: renderSettings, import: renderImport, trace: renderTrace, plugins: renderPlugins, add: renderAdd, 'plugin-install': renderPluginInstall, models: renderModels, shiori: renderShiori, talk: renderTalk, tools: renderTools, plan: renderPlan, booking: renderBooking, voice: renderVoice, now: renderNow, drive: renderDrive, backups: renderBackups, recap: renderRecap, replay: renderReplay, simulate: renderSimulate, notifications: renderNotifications, ext: renderExt, 'plugin-page': renderPluginPage, 'trip-ext': renderTripTab, mcp: renderMcp, welcome: renderWelcome, about: renderAbout, experimental: renderExperimental, updates: renderUpdates };

/**
 * @param {HTMLElement} root
 * @param {{ store: any, ws: any, registry: any, plugins: any, llm?: any, agent?: any, voice?: any, live?: any, awake?: any, pack?: any, presets?: Record<string, string>, backups?: any, sim?: any, push?: any,
 *   updates?: import('./updates.js').Updates, version: string }} core
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
    showMore();
  };
  /** The top bar fades at its end while there is more of it to scroll to. */
  const showMore = () => nav.classList.toggle('more', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
  nav.addEventListener('scroll', showMore, { passive: true });
  addEventListener('resize', showMore);
  document.fonts?.ready.then(showMore); // the tabs widen once annai's fonts arrive
  tapKeepsKeyboard();
  dockHidesWhileTyping();
  drawTabs();

  // Swiping sideways between tabs is experimental, off until Settings → Experimental turns it on (the user,
  // 2026-10-18). Off, the screen leaves sideways panning to the browser (no touch-action of its own).
  let swipes = false;
  const setSwipes = (/** @type {boolean} */ on) => {
    swipes = on;
    main.classList.toggle('swipes', on);
  };
  if (core.ws) readAppSettings(core.ws).then((a) => setSwipes(a.experimental?.swipeTabs === true)).catch(() => {});
  const ctx = {
    ...core, notices, setSwipes,
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
  // The cards sit under the top bar, in the page (base.css: what a landing card moves follows them).
  root.replaceChildren(header, notices.el, installBanner(), main, notices.toasts, ...(dock ? [dock.el] : []));
  // The page and the cards make room for the dock as tall as it is now: voice on, typing open, or a plugin's.
  const dockSize = typeof ResizeObserver === 'function' ? new ResizeObserver(([e]) => {
    document.documentElement.style.setProperty('--dock-h', `${Math.ceil(/** @type {HTMLElement} */ (e.target).getBoundingClientRect().height)}px`);
  }) : null;
  if (dock) dockSize?.observe(dock.el);
  const remakeDock = () => {
    if (!dock || dockKey(ctx) === dockMadeFor) return false;
    dockMadeFor = dockKey(ctx);
    cleanUp('dock');
    /** @type {any} */ (dock).dispose?.(); // what the old one listened to (minors 13)
    const made = makeDock();
    dockSize?.unobserve(dock.el);
    dock.el.replaceWith(made.el);
    dockSize?.observe(made.el);
    dock = made;
    /** @type {any} */ (ctx).dock = dock;
    return true;
  };
  let seq = 0;
  // Where you were (the user, 2026-10-18): a screen you go to opens at its top; Back or Forward brings you
  // back to where you were on it. Each history entry gets a key, and where you were is kept by key.
  history.scrollRestoration = 'manual';
  // Kept for the tab's life, so a reload (iPhone reloads an app it set aside) still knows.
  const KEPT = 'annai-scrolls';
  /** @type {Map<string, number>} */
  const scrolls = new Map((() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEPT) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number') : [];
    } catch {
      return [];
    }
  })());
  let entry = '';
  // Each tab's screen you last had open, and where you were on it: swiping into the tab brings you back
  // there (the page-persistence bug, 2026-10-18), where it always opened the tab's first screen at its top.
  /** @type {Map<string, { hash: string, y: number }>} by the tab's link */
  const lastIn = new Map();
  /** The tab, the address and the name of the screen drawn now. @type {{ tab: string | null, hash: string, name: string }} */
  let shown = { tab: null, hash: '', name: '' };
  /** Screens passed through, never the one a swipe brings back: opening a file or a link to one, installing a plugin. */
  const PASSING = new Set(['import', 'plugin-install', 'welcome']);
  /** Where a swipe's new history entry scrolls to, once. @type {number | null} */
  let swipedTo = null;
  addEventListener('scroll', () => { if (entry) scrolls.set(entry, scrollY); }, { passive: true });
  addEventListener('pagehide', () => {
    if (entry) scrolls.set(entry, scrollY);
    try {
      sessionStorage.setItem(KEPT, JSON.stringify([...scrolls].slice(-50)));
    } catch {
      // not kept: a reload then opens at the top
    }
  });
  /** Scrolls to want while the screen grows toward it, until it's there, you move, or 2 s pass. @param {number} my @param {number} want */
  const follow = (my, want) => {
    const until = performance.now() + 2000;
    const stop = () => {
      grows.disconnect();
      for (const t of ['pointerdown', 'wheel', 'keydown']) removeEventListener(t, stop, true);
    };
    const grows = new ResizeObserver(() => {
      if (my !== seq || performance.now() > until) return stop();
      scrollTo(0, want);
      if (Math.abs(scrollY - want) <= 2) stop();
    });
    for (const t of ['pointerdown', 'wheel', 'keydown']) addEventListener(t, stop, true);
    grows.observe(main);
    setTimeout(stop, 2000);
  };
  /** Where a screen still being drawn should scroll to: whichever drawing finishes first after a move uses it. @type {number | null} */
  let pending = null;
  /** This history entry's key, and where to scroll to on it. @returns {number} */
  const arrive = () => {
    const had = history.state?.annaiScroll;
    if (typeof had === 'string') {
      entry = had;
      return scrolls.get(had) ?? 0;
    }
    entry = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    history.replaceState({ ...(history.state ?? {}), annaiScroll: entry }, '');
    const y = swipedTo ?? 0;
    swipedTo = null;
    return y;
  };

  /** @param {{ moved?: boolean }} [o] moved: a new screen or an entry of the history, not a redraw of this one */
  async function render(o = {}) {
    const my = ++seq;
    if (o.moved) {
      // Where you were on the screen you're leaving, now: a scroll event can come a frame late, after the move.
      if (entry) scrolls.set(entry, scrollY);
      if (shown.tab && !PASSING.has(shown.name)) lastIn.set(shown.tab, { hash: shown.hash, y: scrollY });
      pending = arrive();
    }
    cleanUp('screen', my); // what plugins drew on the screen before
    const route = parseHash(location.hash);
    const section = SECTION[route.name] ?? (route.parts[0] === 'trip' ? 'trips' : route.parts[0]);
    const current = route.name === 'ext' ? location.hash : `#/${section}`;
    for (const a of links) {
      if (a.getAttribute('href') === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    // The screen you are on stays in view in the top bar, however far along it is.
    const on = links.find((a) => a.hasAttribute('aria-current'));
    shown = { tab: on?.getAttribute('href') ?? null, hash: location.hash, name: route.name };
    noteScreen(location.hash);
    // The welcome is a page of its own: the install warning waits for its last step, which says the same.
    document.body.classList.toggle('welcoming', route.name === 'welcome');
    if (on) nav.scrollLeft = Math.max(0, Math.min(nav.scrollLeft, on.offsetLeft - nav.offsetLeft), on.offsetLeft - nav.offsetLeft + on.offsetWidth - nav.clientWidth + 32); // clear of the fade
    showMore();
    const screen = SCREENS[route.name] ?? SCREENS.trips;
    try {
      // Its screen's ctx says which render it is, so what it draws after a newer one began is cleaned up at once (minors 15).
      const node = await screen(Object.create(ctx, { seq: { value: my } }), route);
      if (my !== seq) return;
      main.replaceChildren(node);
      if (pending !== null) {
        const want = pending;
        pending = null;
        scrollTo(0, want);
        // A screen that fills in a moment later is scrolled again as it grows, for up to 2 seconds or until you
        // touch it; not the Conversation, which goes to its last message itself.
        if (want && route.name !== 'talk') follow(my, want);
      }
    } catch (e) {
      if (my !== seq) return;
      main.replaceChildren(h('div', { class: 'screen' },
        h('h1', { class: 'title', text: "This screen couldn't open" }),
        h('p', { text: String(/** @type {any} */ (e)?.message ?? e) }),
        h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips'))));
      dispatchEvent(new ErrorEvent('error', { error: e, message: String(e) }));
    }
  }
  addEventListener('hashchange', () => render({ moved: true }));

  // Swiping a screen sideways moves to the next or the previous tab of the top bar (the user, 2026-10-18). Not
  // from the screen's edges (the phone's own back gesture), nor on anything that moves sideways itself.
  /** @type {{ x: number, y: number, t: number } | null} */
  let swipe = null;
  const ownsSideways = (/** @type {EventTarget | null} */ t) => {
    for (let n = t instanceof Element ? t : null; n && n !== main; n = n.parentElement) {
      if (n.matches('input, textarea, select, [contenteditable], canvas, .viewer-stage, .no-swipe')) return true;
      if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  main.addEventListener('pointerdown', (e) => {
    swipe = swipes && e.pointerType === 'touch' && e.isPrimary && e.clientX > 24 && e.clientX < innerWidth - 24 && !ownsSideways(e.target)
      ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  main.addEventListener('pointercancel', () => { swipe = null; });
  main.addEventListener('pointerup', (e) => {
    const s = swipe;
    swipe = null;
    if (!s || e.pointerType !== 'touch') return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) < 80 || Math.abs(dx) < 2 * Math.abs(e.clientY - s.y) || e.timeStamp - s.t > 700) return;
    const i = links.findIndex((a) => a.hasAttribute('aria-current'));
    const to = i < 0 ? null : links[i + (dx < 0 ? 1 : -1)];
    if (!to) return;
    const tab = /** @type {string} */ (to.getAttribute('href'));
    const last = lastIn.get(tab);
    swipedTo = last?.y ?? null;
    location.hash = last?.hash ?? tab;
  });
  /** What a redraw now would lose: a field being typed in, a key typed and not saved, an error shown, or a list being dragged. */
  const typing = () => {
    const a = document.activeElement;
    if (a && main.contains(a) && a.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])')) return true;
    if (main.querySelector('.role-item.dragging')) return true; // a list being dragged
    return [...main.querySelectorAll('input[type=password]')].some((i) => /** @type {HTMLInputElement} */ (i).value)
      || Boolean(main.querySelector('[role=alert]:not([hidden]):not(:empty)'));
  };
  /** Draws the screen again once nothing typed would be lost, unless it was drawn meanwhile. */
  const redraw = (screen = main.firstElementChild) => {
    if (main.firstElementChild !== screen) return;
    if (typing()) setTimeout(() => redraw(screen), 500);
    else render();
  };
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
        redraw();
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
  render({ moved: true });
  let readyCard = () => {};
  return {
    notices,
    render,
    /** Draws the screen again once nothing typed would be lost (what Settings → Updates shows changed). */
    redraw: () => redraw(),
    /** A new version of annai waits (Settings → Updates says so too): one card, the newest. @param {() => void} apply */
    setUpdateReady(apply) {
      readyCard();
      readyCard = notices.card({ title: 'An update is ready', body: 'It will be used the next time annai starts.', actions: [{ label: 'Restart now', primary: true, run: apply }] });
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
