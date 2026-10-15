import { h } from './dom.js';
import { parseHash } from './router.js';
import { createNotices } from './notices.js';
import { installBanner } from './install.js';
import { renderTrips } from './screens/trips.js';
import { renderTrip } from './screens/trip.js';
import { renderFile } from './screens/file.js';
import { renderSettings } from './screens/settings.js';
import { renderImport } from './screens/import.js';
import { renderTrace } from './screens/trace.js';
import { renderPlugins } from './screens/plugins.js';

/** @type {Record<string, (ctx: any, route: any) => Promise<Node>>} */
const SCREENS = { trips: renderTrips, trip: renderTrip, file: renderFile, settings: renderSettings, import: renderImport, trace: renderTrace, plugins: renderPlugins };

/**
 * @param {HTMLElement} root
 * @param {{ store: any, ws: any, registry: any, plugins: any, version: string }} core
 */
export function startShell(root, core) {
  const notices = createNotices();
  const main = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const links = [['#/trips', 'Trips'], ['#/trace', 'Trace'], ['#/settings', 'Settings']].map(([href, label]) => h('a', { href }, label));
  const header = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/trips', 'aria-label': 'annai' }, 'ann', h('span', { class: 'brand-ai' }, 'ai')),
    h('nav', { class: 'topnav', 'aria-label': 'Main' }, ...links));
  root.replaceChildren(header, installBanner(), main, notices.el);

  const update = { ready: false, apply: () => {} };
  const ctx = {
    ...core, notices, update,
    go: (/** @type {string} */ hash) => { if (location.hash === hash) render(); else location.hash = hash; },
    render: () => render(),
  };
  let seq = 0;
  async function render() {
    const my = ++seq;
    const route = parseHash(location.hash);
    for (const a of links) {
      const on = a.getAttribute('href') === `#/${route.parts[0]}` || (route.parts[0] === 'trip' && a.getAttribute('href') === '#/trips');
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const screen = SCREENS[route.name] ?? SCREENS.trips;
    try {
      const node = await screen(ctx, route);
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
