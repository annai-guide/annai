/** Running from the Home Screen (installed), not in a browser tab. */
export function isStandalone() {
  return matchMedia(/* en */ '(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
}

/** @returns {'ios' | 'android' | 'desktop'} */
export function platform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export async function storageStatus() {
  const persisted = (await navigator.storage?.persisted?.().catch(() => false)) ?? false;
  const est = /** @type {StorageEstimate} */ ((await navigator.storage?.estimate?.().catch(() => ({}))) ?? {});
  return { persisted, usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

/** Asks the browser not to clear annai's storage under pressure (spec §4.6). */
export async function requestPersist() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Calls announce when a new version has installed and waits behind the one serving this page (spec §17 rule 5),
 * and failed when one didn't finish installing (a file of it didn't download). The first install is no update.
 * WebKit can hand the page to it before saying it installed, so "a controller exists" isn't enough: the
 * controller has to be a different worker.
 * @param {ServiceWorkerContainer} container @param {ServiceWorkerRegistration} reg @param {() => void} announce @param {() => void} [failed]
 */
export function watchForUpdates(container, reg, announce, failed = () => {}) {
  if (reg.waiting && container.controller) announce();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    let installed = false;
    w?.addEventListener('statechange', () => {
      if (!container.controller || container.controller === w) return;
      if (w.state === 'installed') {
        installed = true;
        announce();
      } else if (w.state === 'redundant' && !installed) failed();
    });
  });
}

/**
 * Restart now, into the version that waits: annai reloads once it takes over, or after fallbackMs if it never
 * does (its activate failed, or it went redundant). Only once.
 * @param {ServiceWorkerContainer} container @param {ServiceWorkerRegistration} reg @param {{ reload?: () => void, fallbackMs?: number }} [o]
 */
export function restartInto(container, reg, { reload = () => location.reload(), fallbackMs = 5000 } = {}) {
  let asked = false;
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    reload();
  };
  container.addEventListener('controllerchange', () => { if (asked) once(); }); // never the first install's
  return () => {
    asked = true;
    if (!reg.waiting) return once();
    reg.waiting.postMessage('skip-waiting');
    setTimeout(once, fallbackMs);
  };
}

/**
 * The connection, as far as the browser says (spec §12.4: automatic backups on Wi-Fi). Chrome on
 * Android names it; Safari doesn't, which is "unknown". Data Saver counts as mobile data.
 * @param {{ onLine?: boolean, connection?: { type?: string, saveData?: boolean } }} nav
 * @returns {import('../core/backup-auto.js').Connection}
 */
export function connectionOf(nav) {
  if (nav.onLine === false) return 'offline';
  const c = nav.connection;
  if (c?.type === 'none') return 'offline';
  if (c?.saveData || c?.type === 'cellular' || c?.type === 'bluetooth' || c?.type === 'wimax') return 'cellular';
  if (c?.type === 'wifi' || c?.type === 'ethernet') return 'wifi';
  return 'unknown';
}

/**
 * What this device is called in the backups it makes ("iPhone"), and what the user calls it ("phone"): data, in English, as the
 * label leaves the device in backups' names; the screens make their words from the noun.
 * @param {string} [ua] @param {number} [touch] @returns {{ label: string, noun: string }}
 */
export function deviceName(ua = navigator.userAgent, touch = navigator.maxTouchPoints) {
  if (/iPad/.test(ua) || (ua.includes('Macintosh') && touch > 1)) return /* en */ { label: 'iPad', noun: 'iPad' };
  if (/iPhone|iPod/.test(ua)) return /* en */ { label: 'iPhone', noun: 'phone' };
  if (/Android/.test(ua)) return /* en */ { label: 'Android phone', noun: 'phone' };
  return /* en */ { label: 'computer', noun: 'computer' };
}
