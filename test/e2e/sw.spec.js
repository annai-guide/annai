import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker } from './helpers.js';

test('annai opens offline after the first visit', async ({ page, context }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await context.setOffline(false);
});

test('installed plugin files are served from storage', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const answer = await page.evaluate(async () => {
    // Browser URLs, not files on disk: pass them as values so the type checker doesn't resolve them.
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:plugins', '/demo/hello.js', 'export const answer = 42;', { author: 'system' });
    await ws.write('sys:plugins', '/installed.json', { demo: { enabled: true } }, { author: 'system' });
    store.close();
    const mod = await import(at('/plugins/demo/hello.js'));
    return mod.answer;
  });
  expect(answer).toBe(42);
});

test('a shared file lands in the inbox', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const count = await page.evaluate(async () => {
    const form = new FormData();
    form.append('files', new File(['hello'], 'trip.annai.zip', { type: 'application/zip' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
    return (await (await caches.open('annai-inbox')).keys()).length;
  });
  expect(count).toBe(1);
});

test('plugin files are only served for enabled plugins, only as safe types, never as pages', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const result = await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:plugins', '/on/ok.js', 'export const ok = 1;', { author: 'system' });
    await ws.write('sys:plugins', '/on/page.html', '<script>alert(1)</script>', { author: 'system' });
    await ws.write('sys:plugins', '/on/pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { author: 'system' });
    await ws.write('sys:plugins', '/off/ok.js', 'export const ok = 1;', { author: 'system' });
    await ws.write('sys:plugins', '/installed.json', { on: { enabled: true }, off: { enabled: false } }, { author: 'system' });
    store.close();
    const status = async (/** @type {string} */ url) => (await fetch(url)).status;
    const js = await fetch('/plugins/on/ok.js');
    return {
      enabledJs: js.status, nosniff: js.headers.get('X-Content-Type-Options'),
      html: await status('/plugins/on/page.html'), svg: await status('/plugins/on/pic.svg'),
      disabled: await status('/plugins/off/ok.js'), unknown: await status('/plugins/nobody/ok.js'),
    };
  });
  expect(result).toEqual({ enabledJs: 200, nosniff: 'nosniff', html: 403, svg: 403, disabled: 403, unknown: 403 });
  const nav = await page.goto('/plugins/on/ok.js');
  expect(nav?.status()).toBe(403);
});
