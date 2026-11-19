import { h, t, messageOf } from './dom.js';
import { parseHash, redirectOf } from './router.js';
import { talkHref } from './format.js';
import { talkOf } from './open-trip.js';
import { closeQuestions } from './ask.js';
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
import { renderSees } from './screens/sees.js';
import { renderTalk } from './screens/talk.js';
import { renderTools } from './screens/tools.js';
import { renderPlan } from './screens/plan.js';
import { renderBooking } from './screens/booking.js';
import { renderItem } from './screens/item.js';
import { renderVoice } from './screens/voice.js';
import { renderDrive } from './screens/drive.js';
import { renderBackups } from './screens/backups.js';
import { renderRecap } from './screens/recap.js';
import { renderReplay } from './screens/replay.js';
import { renderSimulate } from './screens/simulate.js';
import { renderNotifications } from './screens/notifications.js';
import { createDock } from './dock.js';
import { newConversation, tapShiori } from './plus.js';
import { tapKeepsKeyboard, takesTyping } from './tap-keeps-keyboard.js';
import { keepRows } from './keep-rows.js';
import { isStandalone } from './platform.js';
import { dockHidesWhileTyping } from './dock-hides.js';
import { keepAtEnd } from './at-end.js';
import { followDrive, followPlay, isField, drivingTrip } from './today.js';
import { renderExt, renderPluginPage, renderTripTab } from './screens/ext.js';
import { renderMcp } from './screens/mcp.js';
import { renderWelcome } from './screens/welcome.js';
import { renderAbout } from './screens/about.js';
import { renderUpdates } from './screens/updates.js';
import { renderLanguages } from './languages.js';
import { renderExperimental } from './screens/experimental.js';
import { uiSignature, syncThemes, cleanUp, slotEntries, component, dockKey, pluginUi, made } from './slots.js';

const SCREENS = { sees: renderSees, trips: renderTrips, trip: renderTrip, file: renderFile, settings: renderSettings, import: renderImport, trace: renderTrace, plugins: renderPlugins, add: renderAdd, 'plugin-install': renderPluginInstall, models: renderModels, shiori: renderShiori, talk: renderTalk, tools: renderTools, plan: renderPlan, booking: renderBooking, item: renderItem, voice: renderVoice, drive: renderDrive, backups: renderBackups, recap: renderRecap, replay: renderReplay, simulate: renderSimulate, notifications: renderNotifications, ext: renderExt, 'plugin-page': renderPluginPage, 'trip-ext': renderTripTab, mcp: renderMcp, welcome: renderWelcome, about: renderAbout, experimental: renderExperimental, updates: renderUpdates, languages: renderLanguages };

/** How often a draw waiting for the traveller looks again (whenFree's own figure): drawn within half a second of them letting go, a few reads a look. */
const LET_GO_MS = 500;

/**
 * @param {HTMLElement} root
 * @param {{ store: any, ws: any, registry: any, plugins: any, llm?: any, agent?: any, voice?: any, live?: any, awake?: any, pack?: any, presets?: Record<string, string>, backups?: any, sim?: any, push?: any,
 *   updates: import('./updates.js').Updates, chats?: import('../core/chats.js').Chats, appended?: (fn: (evs: import('../core/types.js').EventRecord[]) => void) => () => void,
 *   moveWaiting: () => Promise<string | null>, version: string }} core
 *   appended: follows the log entries each committed write appended, until what it returns is called; moveWaiting: the files waiting with Shiori into a
 *   conversation of their own (waiting.js), after an import and after an Undo that sent files back there, before the screen that follows is drawn
 */
export function startShell(root, core) {
  const notices = createNotices();
  const main = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  tapKeepsKeyboard();
  dockHidesWhileTyping(document);
  const ctx = {
    ...core, notices,
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
  // The cards sit at the top of the page (base.css: what a landing card moves follows them).
  // The + is the shell's, shown on home whatever the dock (a plugin's has none): a new conversation, with no naming step.
  const plus = core.agent && core.chats ? h('button', { class: 'plus', type: 'button', 'aria-label': t`New conversation`, onclick: () => newConversation(ctx) }, '+') : null;
  root.replaceChildren(notices.el, installBanner(), main, notices.toasts, ...(dock ? [dock.el] : []), ...(plus ? [plus] : []));
  // She speaks, listens or works: on home the whole dock shows, so an open microphone can be stopped there (shiori.css). Koe's own state decides (`over`
  // is it, beneath the dock's Thinking while Kokoro works behind a Koe at rest): Kokoro's work alone shows on home as the sign.
  const busy = (/** @type {{ name: string, over?: string }} */ s) => document.body.classList.toggle('dock-busy', (s.over ?? s.name) !== 'sleeping' && (s.over ?? s.name) !== 'offline');
  if (core.agent) {
    busy(core.agent.state);
    core.agent.on('state', busy);
  }
  // A page read to its end stays there when a phone turns or the dock changes height (at-end.js). After the cards' resize handler, which runs first.
  const { keep } = keepAtEnd();
  // The page and the cards make room for the dock as tall as it is now: voice on, typing open, or a plugin's. A screen being left (the address is
  // no longer the drawn one's: + opens the dock's box in its tap, on home, and the dock grows with its box) is not put back at its end: it is
  // about to be replaced, and a scroll under the box that has focus is one the app need not make.
  const dockSize = typeof ResizeObserver === 'function' ? new ResizeObserver(([e]) => {
    const set = () => document.documentElement.style.setProperty('--dock-h', `${Math.ceil(/** @type {HTMLElement} */ (e.target).getBoundingClientRect().height)}px`);
    if (location.hash === drawnHash) keep(set);
    else set();
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
  /** The address, the name and the entry's key of the screen drawn now. @type {{ hash: string, name: string, entry: string }} */
  let shown = { hash: '', name: '', entry: '' };
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
    return 0;
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
  /** The field of the screen that has the caret, if any. */
  const caretIn = () => {
    const a = document.activeElement;
    return a && main.contains(a) && isField(a) ? a : null;
  };
  // What the traveller does on the screen, in order (beats): typing or choosing in a control, the caret put in a field, a tap on a button or a
  // link. A draw again of the screen on show waits while it would take from under their hands what they did since their last tap (holds), and a
  // tap made meanwhile ends it: the tap's own action draws, if it does. What a tap used up (a Save's key, an Add's model id) is not waited for.
  // A draw nobody asked for (redraw) counts no tap, and waits on through one. Nothing is copied from one screen to the next.
  let beat = 0;
  let tappedAt = 0;
  /** When each control was last typed or chosen in, until a save stores it, and each field took the caret. @type {WeakMap<EventTarget, number>} */
  const typedAt = new WeakMap();
  /** @type {WeakMap<EventTarget, number>} */
  const enteredAt = new WeakMap();
  main.addEventListener('input', (e) => { if (e.target) typedAt.set(e.target, ++beat); }, true);
  main.addEventListener('focusin', (e) => { if (e.target) enteredAt.set(e.target, ++beat); }, true);
  main.addEventListener('stored', (e) => {
    const el = /** @type {Element} */ (e.target);
    for (const x of [el, ...el.querySelectorAll('input, select, textarea')]) typedAt.delete(x);
  }, true);
  main.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('button, a[href], summary, [role=button], input[type=submit], input[type=button]')) tappedAt = ++beat; }, true);
  /**
   * Would a draw again take what the traveller is doing: a control typed or chosen in and not stored (a save says so: `stored`), the caret in a
   * field they entered; with no tap asking (unasked), all of it, the caret in any field, an error shown (not data-kept) or a list being dragged.
   * @param {{ unasked?: boolean }} o
   */
  const holds = (o) => {
    if (location.hash !== drawnHash) return false; // the screen is being left: a draw now draws the address, as the move does
    const since = o.unasked ? 0 : tappedAt;
    const a = caretIn();
    return (a !== null && (enteredAt.get(a) ?? 0) > since)
      || [...main.querySelectorAll('input:not([type=file]), select, textarea')].some((el) => (typedAt.get(el) ?? 0) > since)
      || (o.unasked === true && main.querySelector('.role-item.dragging, [role=alert]:not([hidden]):not(:empty):not([data-kept])') !== null);
  };
  /** @param {{ moved?: boolean, unasked?: boolean }} [o] moved: a new screen or an entry of the history, not a redraw of this one; unasked: no tap asked for it */
  async function render(o = {}) {
    if (!o.moved) {
      const was = seq;
      const tap = tappedAt;
      while (holds(o)) {
        await new Promise((done) => { setTimeout(done, LET_GO_MS); });
        if (seq !== was) return superseded(was);
        if (!o.unasked && tappedAt !== tap) return; // a tap made meanwhile: its own action draws, if it does
      }
    }
    // An address that names no trip goes to the open one's, in place of this entry, so Back never lands on it again and bounces ("#/now": today's
    // Itinerary of the trip in play). A redraw of another trip's conversation (Shiori moved on: a hand-over, an Undo) goes to the open one's the
    // same way, opening nothing.
    const asked = parseHash(location.hash);
    // The trip in play is live mode's choice from the trips once it has read them; till then the open conversation stands in. "#/now" names it, so a
    // cold load there waits for that read, drawing nothing; a move made meanwhile is drawn by its own render.
    if (asked.name === 'now') {
      const at = location.hash;
      await core.live?.tripsRead;
      if (location.hash !== at) return landing.promise;
    }
    const target = core.agent?.target ?? null;
    const to = redirectOf(asked, target, { play: drivingTrip(core) })
      ?? (!o.moved && asked.name === 'talk' && asked.parts[0] === 'trip' && asked.parts[1] !== target ? talkOf(ctx) : null);
    if (to) return replaceHash(to);
    const my = ++seq;
    lastHash = location.hash;
    if (o.moved) {
      // Where you were on the screen you're leaving, now: a scroll event can come a frame late, after the move.
      if (shown.entry) scrolls.set(shown.entry, scrollY); // the screen's, not an entry passed over without drawing
      if (shown.name === 'trips') homeY = scrollY;
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
    // Where Driving's ← goes: the screen it was entered from.
    if (route.name === 'drive' && shown.name && shown.name !== 'drive') /** @type {any} */ (ctx).drivingFrom = shown.hash || '#/trips';
    shown = { hash: location.hash, name: route.name, entry };
    // The welcome is a page of its own: the install warning waits for its last step, which says the same.
    document.body.classList.toggle('welcoming', route.name === 'welcome');
    // Home, and `me`'s read-only lines: the dock rests as on home, so talking there is the + (a new chat).
    document.body.classList.toggle('home', route.name === 'trips' || (route.name === 'talk' && route.parts[0] !== 'trip' && route.parts[1] === 'me'));
    const screen = SCREENS[route.name] ?? SCREENS.trips;
    try {
      if (failed) throw failed.error;
      // Its screen's ctx says which render it is, so what it draws after a newer one began is cleaned up at once.
      const node = await screen(Object.create(ctx, { seq: { value: my }, moved: { value: o.moved === true }, entry: { value: entry }, tripScope: { value: scope } }), route);
      if (my !== seq) return superseded(my);
      if (!o.moved && holds(o)) { // begun while it was built: it waits, and is built again
        const r = await render(o);
        if (seq === my && landedAt < my) land(my); // a tap ended it: what it superseded ends too
        return r;
      }
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
        const to = now ? Math.max(0, scrollY + now.getBoundingClientRect().top - 0.4 * innerHeight) : home && homeY !== null ? homeY : want;
        // While a field is typed in, a page already there is not scrolled, nor one a phone's keyboard holds past its end, which is there as far as
        // the page goes: + opens the dock's box in its tap (plus.js), and the iPhone is bringing the dock above its keyboard as this screen lands, so
        // the app makes no scroll of its own under the box; the keyboard's scroll puts the page. That a scroll here is why an iPhone drew the caret
        // away from the box after + (the user, 2026-11-16) is inferred, not yet verified on the phone.
        const held = takesTyping(document.activeElement) && Math.min(scrollY, Math.max(0, document.documentElement.scrollHeight - innerHeight)) === to;
        if (!held) scrollTo(0, to);
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

  /** Does fn once a draw nobody asked for would take nothing from the traveller. @param {() => unknown} fn */
  const whenFree = (fn) => (holds({ unasked: true }) ? void setTimeout(() => whenFree(fn), LET_GO_MS) : fn());
  /** Draws the screen again, nobody having asked: it waits for the traveller (holds). */
  const redraw = () => { render({ unasked: true }); };
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
  // A trip opened by the user's choice on annai's card (carryOn). From home the address follows into the conversation (the timeline design,
  // "Moving into a trip"), once nothing typed would be lost: a new entry, so Back returns home, which opens nothing. Elsewhere the screen is drawn
  // again: a conversation left goes to the open one at its redraw (render: a replace, as its address is stale), Details and Settings stay.
  /** @type {any} */ (core.agent)?.on?.('went', (/** @type {{ trip: string }} */ { trip }) => {
    if (parseHash(location.hash).name !== 'trips') return redraw();
    whenFree(() => { if (parseHash(location.hash).name === 'trips' && core.agent?.target === trip) ctx.go(talkHref(trip)); });
  });
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
    /** Draws the screen again, nobody having asked (what Settings → Updates shows changed), once that takes nothing from the traveller. */
    redraw: () => redraw(),
    /** The keys' tap on Shiori (tapShiori). */
    tap: () => tapShiori(ctx),
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
