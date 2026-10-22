// Installed plugins load through the service worker, so they start once it controls the page (spec §5.3). A page loaded
// past an active worker (a hard reload; Android Chrome's for dark mode, size or density) asks to be taken, but Chromium
// takes it only if the worker's registration was in memory as it began to load. Else it reloads once per page session.

/** How long a page loaded past an active worker waits to be taken before it reloads. */
export const CLAIM_WAIT = 5_000;
/** sessionStorage: when this page session reloaded to be taken. */
export const RELOADED = 'annai.reloadedForWorker';

/** @typedef {Pick<Storage, 'getItem' | 'setItem'>} KeyValue */

/**
 * Whether a worker controls the page, within timeoutMs; it is asked to take the page.
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
    const t = setTimeout(done, timeoutMs);
    sw.addEventListener('controllerchange', done);
    sw.getRegistration().then((reg) => reg?.active?.postMessage('claim')).catch(() => {});
  });
}

/**
 * Whether plugins may load: a failed import stays failed until annai restarts. True once a worker controls the page, or
 * with none active (a first visit); a page an active one doesn't take reloads (never settling); false if it did already.
 * @param {{ sw: ServiceWorkerContainer | undefined, session: () => KeyValue, reload: () => void, now?: () => number, wait?: number }} o
 * @returns {Promise<boolean>}
 */
export async function pluginsMayLoad({ sw, session, reload, now = Date.now, wait = CLAIM_WAIT }) {
  if (!sw || sw.controller) return true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  const reg = await Promise.race([sw.getRegistration().catch(() => undefined), new Promise((r) => { t = setTimeout(r, 15_000); })]);
  clearTimeout(t);
  if (!(/** @type {ServiceWorkerRegistration | undefined} */ (reg)?.active) || (await controllerReady(sw, wait))) return true;
  if (!reloadOnce(session, now)) return false;
  reload();
  return new Promise(() => {});
}

/** Notes this page session's one reload, with its time: false if it had one, or can't note it (never a loop). @param {() => KeyValue} session */
export function reloadOnce(session, now = Date.now) {
  try {
    const s = session();
    if (s.getItem(RELOADED) !== null) return false;
    s.setItem(RELOADED, String(now()));
    return s.getItem(RELOADED) !== null;
  } catch {
    return false;
  }
}
