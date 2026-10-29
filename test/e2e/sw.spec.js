import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startServer } from './helpers.js';

test('annai opens offline after the first visit', async ({ page }) => {
  const server = await startServer(8791);
  try {
    await page.goto(`${server.origin}/#/trips`);
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
    await waitForServiceWorker(page);
    await server.stop();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  } finally {
    await server.stop();
  }
});

test('after the welcome, annai opens offline at its plain start, at Trips', async ({ page }, testInfo) => {
  const server = await startServer(8821 + testInfo.parallelIndex);
  try {
    await page.goto(`${server.origin}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to annai' })).toBeVisible();
    await waitForServiceWorker(page);
    await server.stop();
    await page.goto('about:blank');
    await page.goto(`${server.origin}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  } finally {
    await server.stop();
  }
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
    // PDF.js's packed CMaps and fonts (the PDF pages plugin) are bytes of no named type.
    await ws.write('sys:plugins', '/on/x.bcmap', new Uint8Array([0xe0, 1, 2, 3]), { author: 'system' });
    await ws.write('sys:plugins', '/off/ok.js', 'export const ok = 1;', { author: 'system' });
    await ws.write('sys:plugins', '/installed.json', { on: { enabled: true }, off: { enabled: false } }, { author: 'system' });
    store.close();
    const status = async (/** @type {string} */ url) => (await fetch(url)).status;
    const js = await fetch('/plugins/on/ok.js');
    const bcmap = await fetch('/plugins/on/x.bcmap');
    return {
      enabledJs: js.status, nosniff: js.headers.get('X-Content-Type-Options'),
      bytes: [bcmap.status, bcmap.headers.get('Content-Type'), bcmap.headers.get('X-Content-Type-Options')],
      html: await status('/plugins/on/page.html'), svg: await status('/plugins/on/pic.svg'),
      disabled: await status('/plugins/off/ok.js'), unknown: await status('/plugins/nobody/ok.js'),
    };
  });
  expect(result).toEqual({ enabledJs: 200, nosniff: 'nosniff', bytes: [200, 'application/octet-stream', 'nosniff'], html: 403, svg: 403, disabled: 403, unknown: 403 });
  const nav = await page.goto('/plugins/on/ok.js');
  expect(nav?.status()).toBe(403);
});

test('a plugin file named in decomposed Unicode, as macOS writes it, is still found', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const status = await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:plugins', '/demo/café.js', 'export const answer = 7;', { author: 'system' });
    await ws.write('sys:plugins', '/installed.json', { demo: { enabled: true } }, { author: 'system' });
    store.close();
    return (await fetch(`/plugins/demo/${encodeURIComponent('café.js'.normalize('NFD'))}`)).status;
  });
  expect(status).toBe(200);
});
