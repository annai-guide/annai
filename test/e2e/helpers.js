import { expect } from '@playwright/test';

/** Collects console errors and uncaught page errors. @param {import('@playwright/test').Page} page */
export function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Opens annai and waits for the first screen. Exports always download in tests (no share sheet). @param {import('@playwright/test').Page} page @param {string} [hash] */
export async function openApp(page, hash = '') {
  await page.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await page.goto('/' + hash);
  await expect(page.locator('main.view > *')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
export async function waitForServiceWorker(page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
}
