import { h, t, messageOf } from './dom.js';
import { parseHash, redirectOf } from './router.js';
import { talkOf } from './open-trip.js';
import { closeQuestions } from './ask.js';
import { createNotices } from './notices.js';
import { installBanner } from './install.js';
import { setPendingImport } from './import-state.js';
import { renderTrips } from './screens/trips.js';
import { renderTrip } from './screens/trip.js';
import { renderFile, cameFrom } from './screens/file.js';
import { renderSettings } from './screens/settings.js';
import { renderImport } from './screens/import.js';
import { renderTrace } from './screens/trace.js';
import { renderPlugins } from './screens/plugins.js';
import { renderAdd } from './screens/add.js';
import { renderPluginInstall } from './screens/plugin-install.js';
import { renderModels } from './screens/models.js';
import { renderShiori } from './screens/shiori.js';
import { renderSees } from './screens/sees.js';
import { renderTalk } from './screens/talk.js';
import { renderTools } from './screens/tools.js';
import { renderPlan } from './screens/plan.js';
import { renderBooking } from './screens/booking.js';
import { renderItem } from './screens/item.js';
import { renderVoice } from './screens/voice.js';
import { renderNow } from './screens/now.js';
import { renderDrive } from './screens/drive.js';
import { renderBackups } from './screens/backups.js';
import { renderRecap } from './screens/recap.js';
import { renderReplay } from './screens/replay.js';
import { renderSimulate } from './screens/simulate.js';
import { renderNotifications } from './screens/notifications.js';
import { createDock } from './dock.js';
import { newConversation } from './plus.js';
import { tapKeepsKeyboard } from './tap-keeps-keyboard.js';
import { keepRows } from './keep-rows.js';
import { isStandalone } from './platform.js';
import { dockHidesWhileTyping } from './dock-hides.js';
import { keepAtEnd } from './at-end.js';
import { noteScreen } from './resume.js';
import { followDrive, followPlay, isField, drivingTrip } from './today.js';
import { renderExt, renderPluginPage, renderTripTab } from './screens/ext.js';
import { renderMcp } from './screens/mcp.js';
import { renderWelcome } from './screens/welcome.js';
import { renderAbout } from './screens/about.js';
import { renderUpdates } from './screens/updates.js';
import { renderLanguages } from './languages.js';
import { renderExperimental } from './screens/experimental.js';
import { readAppSettings } from '../core/settings.js';
import { uiSignature, syncThemes, cleanUp, slotEntries, component, dockKey, pluginUi, made } from './slots.js';

/** @type {Record<string, (ctx: any, route: any) => Promise<Node>>} */
/** The top bar's tab each screen belongs to, where it isn't the screen's own name. */
const SECTION = /** @type {Record<string, string>} */ ({
  sees: 'talk', talk: 'talk',
  trip: 'trips', file: 'trips', 'waiting-file': 'trips', booking: 'plan', item: 'plan', plan: 'plan', recap: 'trips', replay: 'trips', 'trip-ext': 'trips', import: 'trips', drive: 'now',
  plugins: 'settings', add: 'settings', 'plugin-install': 'settings', 'plugin-page': 'settings', models: 'settings', shiori: 'settings', tools: 'settings',
  voice: 'settings', languages: 'settings', backups: 'settings', notifications: 'settings', simulate: 'settings', mcp: 'settings', about: 'settings', experimental: 'settings', updates: 'settings',
});
const SCREENS = { sees: renderSees, trips: renderTrips, trip: renderTrip, file: renderFile, 'waiting-file': renderFile, settings: renderSettings, import: renderImport, trace: renderTrace, plugins: renderPlugins, add: renderAdd, 'plugin-install': renderPluginInstall, models: renderModels, shiori: renderShiori, talk: renderTalk, tools: renderTools, plan: renderPlan, booking: renderBooking, item: renderItem, voice: renderVoice, now: renderNow, drive: renderDrive, backups: renderBackups, recap: renderRecap, replay: renderReplay, simulate: renderSimulate, notifications: renderNotifications, ext: renderExt, 'plugin-page': renderPluginPage, 'trip-ext': renderTripTab, mcp: renderMcp, welcome: renderWelcome, about: renderAbout, experimental: renderExperimental, updates: renderUpdates, languages: renderLanguages };

/**
 * @param {HTMLElement} root
 * @param {{ store: any, ws: any, registry: any, plugins: any, llm?: any, agent?: any, voice?: any, live?: any, awake?: any, pack?: any, presets?: Record<string, string>, backups?: any, sim?: any, push?: any,
 *   updates: import('./updates.js').Updates, chats?: import('../core/chats.js').Chats, appended?: (fn: (evs: import('../core/types.js').EventRecord[]) => void) => () => void, version: string }} core
 *   appended: follows the log entries each committed write appended, until what it returns is called
 */
export function startShell(root, core) {
  const notices = createNotices();
  const main = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const builtIn = [['#/now', t`Now`], ['#/trips', t`Trips`], ['#/plan', t`Itinerary`], ['#/talk', t`Conversation`], ['#/trace', t`Trace`], ['#/settings', t`Settings`]].map(([href, label]) => h('a', { href }, label));
  /** @type {HTMLAnchorElement[]} the top bar's links: annai's, then plugins' screens with a tab */
  let links = builtIn;
  const nav = h('nav', { class: 'topnav', 'aria-label': t`Main` }, ...links);
  // A tab naming no trip goes straight to the open trip's own address, so tapped on its own screen it adds no entry for Back to show again.
  nav.addEventListener('click', (e) => {
    const a = /** @type {Element} */ (e.target).closest('a');
    const to = a && redirectOf(parseHash(a.getAttribute('href') ?? ''), core.agent?.target ?? null);
    if (!to || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (location.hash !== to) location.hash = to;
  });
  const header = h('header', { class: 'topbar' },
    /* en */ h('a', { class: 'brand', href: '#/trips', 'aria-label': 'annai' }, 'ann', h('span', { class: 'brand-ai' }, 'ai')),
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
  dockHidesWhileTyping(document, { ended: () => notices.hold() });
  drawTabs();

  // Swiping sideways between tabs is experimental, off until Settings → Experimental turns it on. Off, the screen
  // leaves sideways panning to the browser (no touch-action of its own).
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
    replace: (/** @type {string} */ hash) => replaceHash(hash),
    /** Trip id was removed: leaves its screens the way Back does (see `render`); at the first entry, Trips there. Not if the user went elsewhere meanwhile. @param {string} id */
    removed: (id) => {
      const at = parseHash(location.hash);
      if (at.parts[0] !== 'trip' || at.parts[1] !== id) return;
      if (lastIdx > 0) {
        removing = passing = true;
        history.back();
      } else replaceHash('#/trips');
    },
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
  // The + is the shell's, shown on home whatever the dock (a plugin's has none): a new conversation, with no naming step.
  const plus = core.agent && core.chats ? h('button', { class: 'plus', type: 'button', 'aria-label': t`New conversation`, onclick: () => newConversation(ctx) }, '+') : null;
  root.replaceChildren(header, notices.el, installBanner(), main, notices.toasts, ...(dock ? [dock.el] : []), ...(plus ? [plus] : []));
  // She speaks, listens or works: on home the whole dock shows, so an open microphone can be stopped there (shiori.css).
  const busy = (/** @type {{ name: string }} */ s) => document.body.classList.toggle('dock-busy', s.name !== 'sleeping' && s.name !== 'offline');
  if (core.agent) {
    busy(core.agent.state);
    core.agent.on('state', busy);
  }
  // A screen's own sticky row (the Conversation's title and ⋯) sits right under the bar, however tall it is on this phone.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(([e]) => document.documentElement.style.setProperty('--topbar-h', `${Math.floor(/** @type {HTMLElement} */ (e.target).getBoundingClientRect().height)}px`)).observe(header);
  }
  // A page read to its end stays there when a phone turns or the dock changes height (at-end.js). After the cards' resize handler, which runs first.
  const { toEnd } = keepAtEnd();
  // The page and the cards make room for the dock as tall as it is now: voice on, typing open, or a plugin's.
  const dockSize = typeof ResizeObserver === 'function' ? new ResizeObserver(([e]) => {
    document.documentElement.style.setProperty('--dock-h', `${Math.ceil(/** @type {HTMLElement} */ (e.target).getBoundingClientRect().height)}px`);
    toEnd();
  }) : null;
  if (dock) dockSize?.observe(dock.el);
  const remakeDock = () => {
    if (!dock || dockKey(ctx) === dockMadeFor) return false;
    dockMadeFor = dockKey(ctx);
    cleanUp('dock');
    /** @type {any} */ (dock).dispose?.(); // what the old one listened to
    const made = makeDock();
    dockSize?.unobserve(dock.el);
    dock.el.replaceWith(made.el);
    dockSize?.observe(made.el);
    dock = made;
    /** @type {any} */ (ctx).dock = dock;
    return true;
  };
  let seq = 0;
  // Where you were: a screen you go to opens at its top; Back or Forward brings you back to where you were on it.
  // Each history entry gets a key, and where you were is kept by key.
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
  // Each tab's screen you last had open, and where you were on it: swiping into the tab brings you back there.
  /** @type {Map<string, { hash: string, y: number }>} by the tab's link */
  const lastIn = new Map();
  /** The tab, the address, the name and the entry's key of the screen drawn now. @type {{ tab: string | null, hash: string, name: string, entry: string }} */
  let shown = { tab: null, hash: '', name: '', entry: '' };
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
  // Each entry numbers its place in the history (annaiIdx): a new one is one past the entry drawn last, and the shell's own replace keeps it
  // (location.replace drops history.state); what opens over a screen takes one between (dom.js). `top`: the newest at or ahead.
  let lastIdx = -1;
  let top = -1;
  // `top` is kept for the tab's life as it changes, so a Forward after a reload still knows what is ahead. Each load of annai in the tab numbers its
  // entries from 0 and marks them with its own id (annaiLoad), kept through reloads; `top` is kept by that id, so Back into an older load reads its own.
  const TOP = 'annai-top';
  const load = typeof history.state?.annaiLoad === 'string' ? history.state.annaiLoad : Math.random().toString(36).slice(2, 10);
  /** @returns {Record<string, number>} */
  const tops = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(TOP) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; // a number: an older annai's, of no load known
    } catch {
      return {}; // not kept: after a reload, as far as the entry reloaded
    }
  };
  top = typeof tops()[load] === 'number' ? tops()[load] : -1;
  const keepTop = (/** @type {number} */ v) => {
    top = v;
    try {
      sessionStorage.setItem(TOP, JSON.stringify({ ...tops(), [load]: v }));
    } catch {
      // not kept
    }
  };
  /** The last move: -1 Back, 1 Forward, 0 a replace or not known (an unnumbered entry). */
  let way = 0;
  /** A Back or Forward is passing entries it doesn't draw: how many, and whether it is going back to the last drawn. */
  let passing = false;
  let steps = 0;
  let returning = false;
  /** A trip was removed: Back goes on over its entries and Trips'. */
  let removing = false;
  /** The address of the draw begun last. */
  let lastHash = '';
  /** The address of the screen on show, whose draw landed. */
  let drawnHash = '';
  /** The entry arrived at last is new: no place on it to come back to. */
  let firstVisit = false;
  /** Where you were on home when you last left it, in this page. @type {number | null} */
  let homeY = null;
  /** This history entry's key, and where to scroll to on it. @returns {number} */
  const arrive = () => {
    const st = history.state ?? {};
    const seen = typeof st.annaiScroll === 'string';
    const idx = typeof st.annaiIdx === 'number' ? st.annaiIdx : seen ? -1 : Math.floor(lastIdx) + 1; // -1: from before entries were numbered
    way = idx < 0 || lastIdx < 0 ? 0 : Math.sign(idx - lastIdx);
    keepTop(seen || 'annaiIdx' in st ? Math.max(top, idx) : idx); // a new entry cuts off what was ahead
    lastIdx = idx;
    firstVisit = !seen;
    if (seen) {
      entry = st.annaiScroll;
      return scrolls.get(entry) ?? 0;
    }
    entry = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    history.replaceState({ ...st, annaiScroll: entry, annaiIdx: idx, annaiLoad: load }, '');
    const y = swipedTo ?? 0;
    swipedTo = null;
    return y;
  };
  /** This entry becomes another address, keeping its number, and is drawn. @param {string} to */
  const replaceHash = (to) => {
    closeQuestions();
    history.replaceState(typeof history.state?.annaiIdx === 'number' ? { annaiIdx: history.state.annaiIdx, annaiLoad: load } : null, '', to);
    return render({ moved: true });
  };

  const nextLanding = () => {
    let done = () => {};
    const promise = /** @type {Promise<void>} */ (new Promise((resolve) => { done = () => resolve(undefined); }));
    return { promise, done };
  };
  /**
   * The next draw to land on screen, a screen or the error page. A draw that a newer one supersedes ends when that lands, not at once
   * (a caller that awaits it, such as a save before its toast, finds the screen drawn) and not on one particular draw, which may
   * never finish: whichever draw lands next ends it, or one that landed already, which began after it.
   */
  let landing = nextLanding();
  let landedAt = 0;
  /** @param {number} my the draw that landed */
  const land = (my) => {
    const was = landing;
    landedAt = my;
    landing = nextLanding();
    was.done();
  };
  /** What a draw that a newer one superseded ends with. @param {number} my */
  const superseded = (my) => (landedAt > my ? undefined : landing.promise);
  /** @param {{ moved?: boolean }} [o] moved: a new screen or an entry of the history, not a redraw of this one */
  async function render(o = {}) {
    // An address that names no trip goes to the open one's, in place of this entry, so Back never lands on it again and bounces. A
    // redraw of another trip's conversation (Shiori moved on: a hand-over, an Undo) goes to the open one's the same way, opening nothing.
    const asked = parseHash(location.hash);
    const target = core.agent?.target ?? null;
    const to = redirectOf(asked, target)
      ?? (!o.moved && asked.name === 'talk' && asked.parts[0] === 'trip' && asked.parts[1] !== target ? talkOf(ctx) : null);
    if (to) return replaceHash(to);
    const my = ++seq;
    lastHash = location.hash;
    if (o.moved) {
      // Where you were on the screen you're leaving, now: a scroll event can come a frame late, after the move.
      if (shown.entry) scrolls.set(shown.entry, scrollY); // the screen's, not an entry passed over without drawing
      if (shown.name === 'trips') homeY = scrollY;
      if (shown.tab && !PASSING.has(shown.name)) lastIn.set(shown.tab, { hash: shown.hash, y: scrollY });
      pending = arrive();
    }
    // A trip that isn't here has no screen at any of its addresses; a failed read is not "gone": its error is the screen's (below).
    let scope = null;
    let gone = false;
    /** @type {{ error: unknown } | null} */
    let failed = null;
    if (asked.parts[0] === 'trip') {
      try {
        scope = await core.store.tx(['scopes'], 'readonly', (/** @type {any} */ x) => x.getScope(asked.parts[1] ?? ''));
        gone = scope?.kind !== 'trip';
      } catch (error) {
        failed = { error };
      }
      if (my !== seq) return superseded(my);
    }
    if (gone && !o.moved) return replaceHash('#/trips');
    if (o.moved) {
      if (returning) { // back at the entry it left, whose screen is still shown
        returning = passing = false;
        steps = 0;
        if (location.hash === drawnHash) {
          pending = null; // nothing is drawn: a later redraw keeps its place
          return;
        } // its draw was superseded (a Forward inside it): drawn now
      }
      const overlay = history.state?.annaiViewer || history.state?.annaiAsk;
      if (overlay && !shown.name) { // a reload on what was open over a screen: that screen, the entry behind
        passing = true;
        keepTop(lastIdx); // its push cut off what was ahead
        history.back();
        return landing.promise;
      }
      // Back or Forward goes on over a gone trip's entries, those at the address it left, and an overlay's entry reached from another address.
      const canGo = way < 0 ? lastIdx > 0 : way > 0 && lastIdx < top;
      const skip = gone || (canGo && overlay) || (passing && lastHash === shown.hash) || (removing && asked.name === 'trips');
      if (skip || removing) {
        const on = skip && canGo;
        if (skip) steps++;
        passing = on;
        removing &&= on;
        if (on) history.go(way);
        else if (skip && way > 0 && (shown.name === 'trips' || lastHash === shown.hash)) { // Forward would draw Trips or the screen again: back to the entry it left
          passing = returning = true;
          history.go(-steps);
        } else {
          steps = 0;
          if (skip) return replaceHash('#/trips'); // the end of the history: Trips in its place
          location.hash = '#/trips'; // removing, on the first other screen: Trips after it, which cuts off the trip's entries ahead
        }
        return landing.promise;
      }
      passing = false;
      steps = 0;
    }
    cleanUp('screen', my); // what plugins drew on the screen before
    const route = asked;
    // A file opened from the Plan, a booking or Now is in that tab.
    const from = ['file', 'booking', 'item'].includes(route.name) ? cameFrom(route.params.from, route.parts[1], core.agent?.trip ?? null) : null;
    const at = from ? parseHash(from.hash) : route;
    const section = SECTION[at.name] ?? (at.parts[0] === 'trip' ? 'trips' : at.parts[0]);
    const current = route.name === 'ext' ? location.hash : `#/${section}`;
    for (const a of links) {
      if (a.getAttribute('href') === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    // The screen you are on stays in view in the top bar, however far along it is.
    const on = links.find((a) => a.hasAttribute('aria-current'));
    // Where Driving's ← goes: the screen it was entered from.
    if (route.name === 'drive' && shown.name && shown.name !== 'drive') /** @type {any} */ (ctx).drivingFrom = shown.hash || '#/trips';
    shown = { tab: on?.getAttribute('href') ?? null, hash: location.hash, name: route.name, entry };
    noteScreen(location.hash);
    // The welcome is a page of its own: the install warning waits for its last step, which says the same.
    document.body.classList.toggle('welcoming', route.name === 'welcome');
    document.body.classList.toggle('home', route.name === 'trips');
    if (on && o.moved) nav.scrollLeft = Math.max(0, Math.min(nav.scrollLeft, on.offsetLeft - nav.offsetLeft), on.offsetLeft - nav.offsetLeft + on.offsetWidth - nav.clientWidth + 32); // clear of the fade
    showMore();
    const screen = SCREENS[route.name] ?? SCREENS.trips;
    try {
      if (failed) throw failed.error;
      // Its screen's ctx says which render it is, so what it draws after a newer one began is cleaned up at once.
      const node = await screen(Object.create(ctx, { seq: { value: my }, moved: { value: o.moved === true }, entry: { value: entry }, tripScope: { value: scope } }), route);
      if (my !== seq) return superseded(my);
      // Home drawn again in place (the clock, a hand-over, a Delete): the first row in view that is still shown stays where it was (keepRows).
      const draw = () => main.replaceChildren(node);
      if (pending === null && route.name === 'trips' && drawnHash === shown.hash) keepRows(main, draw, node);
      else draw();
      drawnHash = shown.hash;
      if (pending !== null) {
        const want = pending;
        pending = null;
        // Home, newly come to, opens with the now line 40% down, or where you last were on it (← is a new entry); Back brings you to where
        // you were on it. With nothing past there is nothing to scroll past: the screen stays at its top, its notices in view. While annai isn't
        // installed it opens at its top too, the data-safety banner first: a long past would put the banner far above the screen, unseen.
        const home = route.name === 'trips' && firstVisit && !want;
        const now = home && homeY === null && isStandalone() && main.querySelector('.past > li') ? main.querySelector('.now-line') : null;
        scrollTo(0, now ? Math.max(0, scrollY + now.getBoundingClientRect().top - 0.4 * innerHeight) : home && homeY !== null ? homeY : want);
        // A screen that fills in a moment later is scrolled again as it grows, for up to 2 seconds or until you
        // touch it; not the Conversation, which goes to its last message itself, nor home, drawn whole.
        if (want && route.name !== 'talk' && route.name !== 'trips') follow(my, want);
      }
      land(my);
    } catch (e) {
      if (my !== seq) return superseded(my);
      main.replaceChildren(h('div', { class: 'screen' },
        h('h1', { class: 'title', text: t`This screen couldn't open` }),
        h('p', { text: messageOf(e) }),
        h('p', {}, h('a', { href: '#/trips' }, t`Back to Trips`))));
      drawnHash = shown.hash;
      land(my);
      dispatchEvent(new ErrorEvent('error', { error: e, message: String(e) }));
    }
  }
  addEventListener('hashchange', () => render({ moved: true }));
  // Passing can land on an entry at the same address, which fires no hashchange.
  addEventListener('popstate', () => {
    const st = history.state;
    if (location.hash !== lastHash) return; // a hashchange follows
    if (passing) render({ moved: true });
    else if (st?.annaiIdx === lastIdx) keepTop(lastIdx); // back from what was open over this screen: its entry was the newest
    // Forward onto an overlay's entry, closed (each closes at any popstate): on to what is ahead, or back, so it shows nothing twice.
    else if ((st?.annaiViewer || st?.annaiAsk) && st.annaiIdx > lastIdx) history.go(st.annaiIdx < top ? 1 : -1);
  });

  // Swiping a screen sideways moves to the next or the previous tab of the top bar. Not from the screen's edges
  // (the phone's own back gesture), nor on anything that moves sideways itself.
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
  /** What a redraw now would lose: a field being typed in, a key typed and not saved, an error shown (not one the screen draws again itself: data-kept), or a list being dragged. */
  const typing = () => {
    const a = document.activeElement;
    if (a && main.contains(a) && isField(a)) return true;
    if (main.querySelector('.role-item.dragging')) return true; // a list being dragged
    return [...main.querySelectorAll('input[type=password]')].some((i) => /** @type {HTMLInputElement} */ (i).value)
      || Boolean(main.querySelector('[role=alert]:not([hidden]):not(:empty):not([data-kept])'));
  };
  /** Draws the screen again once nothing typed would be lost, unless it was drawn meanwhile. */
  const redraw = (screen = main.firstElementChild) => {
    if (main.firstElementChild !== screen) return;
    if (typing()) setTimeout(() => redraw(screen), 500);
    else render();
  };
  // What plugins add redraws when it changes: once per change, not per item.
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
  // Shiori opened a trip she started or chose for a hand-over (Halves.openWhenDone): the screen shows it, its top bar the trip, once
  // nothing typed would be lost.
  /** @type {any} */ (core.agent)?.on?.('went', () => redraw());
  render({ moved: true });
  // Driving, or a plugin's screen for the activity, takes over once per drive. The dock's box is outside main, so typing there counts here.
  const seedActivity = followDrive(core.live, { screens: () => slotEntries(ctx, 'ui:screen'), hash: () => location.hash, typing: () => isField(document.activeElement), trip: () => drivingTrip(core), go: (to) => ctx.go(to) });
  // Driving shows the trip in play, which a reload learns late, midnight can change and a line said moves.
  followPlay(core.live, () => drivingTrip(core), () => { if (shown.name === 'drive') redraw(); });
  let readyCard = () => {};
  return {
    notices,
    render,
    /** Live mode has restored the drive record: the activity changes from what it restored. */
    seedActivity,
    /** Draws the screen again once nothing typed would be lost (what Settings → Updates shows changed). */
    redraw: () => redraw(),
    /** A new version of annai waits (Settings → Updates says so too): one card, the newest. @param {() => void} apply */
    setUpdateReady(apply) {
      readyCard();
      readyCard = notices.card({ title: t`An update is ready`, body: t`It will be used the next time annai starts.`, actions: [{ label: t`Restart now`, primary: true, run: apply }] });
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
