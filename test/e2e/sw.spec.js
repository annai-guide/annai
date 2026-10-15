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
    const { createIdbStore } = await import('/src/core/store-idb.js');
    const { Workspace } = await import('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:plugins', '/demo/hello.js', 'export const answer = 42;', { author: 'system' });
    store.close();
    const mod = await import('/plugins/demo/hello.js');
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
