/** Running from the Home Screen (installed), not in a browser tab. */
export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
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
 * Calls announce when a new version has installed and waits behind the one serving this page (spec §17 rule 5).
 * The first install is no update. WebKit can hand the page to it before saying it installed, so "a controller
 * exists" isn't enough: the controller has to be a different worker.
 * @param {ServiceWorkerContainer} container @param {ServiceWorkerRegistration} reg @param {() => void} announce
 */
export function watchForUpdates(container, reg, announce) {
  if (reg.waiting && container.controller) announce();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && container.controller && container.controller !== w) announce();
    });
  });
}
