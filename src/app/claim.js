// Installed plugins load through the service worker, so they start once it controls the page (spec §5.3). A page loaded
// past an active worker (a hard reload; Android Chrome's for dark mode, size or density) asks to be taken, but Chromium
// takes it only if the worker's registration was in memory as it began to load. Else it reloads, at most every 2 minutes.

/** How long a page loaded past an active worker waits to be taken before it reloads. */
export const CLAIM_WAIT = 5_000;
/** How long after annai reloads itself it won't again: a reload that isn't taken either never loops. */
export const RELOAD_GAP = 2 * 60_000;
/** sessionStorage: when annai last reloaded itself to be taken. */
export const RELOADED = 'annai.reloadedForWorker';

/** @typedef {Pick<Storage, 'getItem' | 'setItem'>} KeyValue */

/**
 * The worker on its way to take this page: a first visit's (installing, or installed with none active), which takes it as it activates
 * (sw.js), or one activating; not an update beside an active worker. One answer for the wait and for what the screens say meanwhile.
 * @param {ServiceWorkerRegistration | undefined} reg @returns {ServiceWorker | null}
 */
export function onItsWay(reg) {
  const coming = reg?.installing ?? reg?.waiting ?? reg?.active;
  return coming && (coming.state === 'activating' || (!reg?.active && coming.state !== 'redundant')) ? coming : null;
}

/** Whether one is on its way now: a wait helps, a reload doesn't. @param {ServiceWorkerContainer | undefined} sw @returns {Promise<boolean>} */
export async function comingNow(sw) {
  return Boolean(sw && onItsWay(await sw.getRegistration().catch(() => undefined)));
}

/**
 * Whether a worker controls the page, within timeoutMs; it is asked to take the page. A worker still on its way at timeoutMs (onItsWay) is
 * waited for until it takes the page or its install fails, however long a slow connection makes that. Giving up on it would say a reload
 * is needed while none is.
 * @param {ServiceWorkerContainer | undefined} sw @returns {Promise<boolean>}
 */
export function controllerReady(sw, timeoutMs = 15_000) {
  if (!sw || sw.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      sw.removeEventListener('controllerchange', done);
      resolve(Boolean(sw.controller));
    };
    // Looked at when the time is up, and again at each step of a worker on its way.
    const look = () => {
      if (sw.controller) return done();
      sw.getRegistration().then((reg) => {
        const coming = onItsWay(reg);
        if (coming) coming.addEventListener('statechange', look, { once: true });
        else done();
      }, done);
    };
    const t = setTimeout(look, timeoutMs);
    sw.addEventListener('controllerchange', done);
    sw.getRegistration().then((reg) => reg?.active?.postMessage('claim')).catch(() => {});
  });
}

/**
 * Whether plugins may load (a failed import stays failed): once a worker controls the page, or none is active (a first
 * visit). Else it reloads, never settling, unless the user has acted on it or within RELOAD_GAP; false then, or with no lookup.
 * @param {{ sw: ServiceWorkerContainer | undefined, session: () => KeyValue, reload: () => void, used?: () => boolean, now?: () => number, wait?: number, lookup?: number }} o
 * @returns {Promise<boolean>}
 */
export async function pluginsMayLoad({ sw, session, reload, used = () => false, now = Date.now, wait = CLAIM_WAIT, lookup = 15_000 }) {
  if (!sw || sw.controller) return true;
  const none = {};
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  const reg = await Promise.race([sw.getRegistration(), new Promise((r) => { t = setTimeout(r, lookup, none); })]).catch(() => none);
  clearTimeout(t);
  if (reg === none) return false;
  if (!(/** @type {ServiceWorkerRegistration | undefined} */ (reg)?.active) || (await controllerReady(sw, wait))) return true;
  if (used() || !mayReload(session, now)) return false;
  reload();
  return new Promise(() => {});
}

/** Notes a reload now, unless one was within RELOAD_GAP (a time ahead, or unreadable, counts) or none can be noted. @param {() => KeyValue} session */
export function mayReload(session, now = Date.now) {
  try {
    const s = session();
    const was = s.getItem(RELOADED);
    const at = String(now());
    if (was !== null && !(/^\d+$/.test(was) && Number(at) - Number(was) > RELOAD_GAP)) return false;
    s.setItem(RELOADED, at);
    return s.getItem(RELOADED) === at;
  } catch {
    return false;
  }
}
