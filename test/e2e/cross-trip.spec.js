import { test, expect } from '@playwright/test';
import { openApp, startTrip, filterTrace, watchConsole } from './helpers.js';

test("a trip's conversation never shows another trip's photo named by its hash, and its own shows; reading its own entries is quiet (backlog-hash)", async ({ page }) => {
  await openApp(page);
  const kyoto = await startTrip(page, 'Kyoto');
  await page.goto('/#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  const bigSur = await startTrip(page, 'Big Sur'); // the conversation open now
  // A photo in each trip (Kyoto's 30 px wide, Big Sur's 40), and a message in Big Sur's conversation that names both by
  // their hash only in its data, as an entry written past annai's checks would.
  await page.evaluate(async ({ kyoto, bigSur }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { logEvent } = await load('/src/core/events.js');
    const png = async (/** @type {number} */ w) => {
      const c = new OffscreenCanvas(w, 20);
      /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d')).fillRect(0, 0, w, 20);
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    };
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const a = await ws.write(kyoto, '/files/temple.png', await png(30), { author: 'user', type: 'image/png' });
    const b = await ws.write(bigSur, '/files/coast.png', await png(40), { author: 'user', type: 'image/png' });
    await logEvent(store, bigSur, { type: 'msg.user', actor: 'user', data: { text: 'Look at these', images: [{ hash: a.hash, mediaType: 'image/png' }, { hash: b.hash, mediaType: 'image/png' }] } });
    store.close();
  }, { kyoto, bigSur });
  await page.goto('/#/talk');
  const bubble = page.locator('.convo .you', { hasText: 'Look at these' });
  await expect(bubble).toBeVisible();
  const shown = bubble.locator('img');
  await expect(shown).toHaveCount(1);
  // The one shown is Big Sur's own, 40 px wide.
  await expect.poll(() => shown.evaluate((/** @type {HTMLImageElement} */ i) => i.naturalWidth)).toBe(40);
  await page.goto('/#/trace');
  await expect(page.getByRole('heading', { level: 1, name: 'Trace' })).toBeVisible();
  await filterTrace(page, { kind: 'Errors' });
  // The message's own data, read back: no refusal to log, however often the screen is drawn (review, 5b).
  await expect(page.locator('ol.trace li', { hasText: 'content.refused' })).toHaveCount(0);
});

test("a file's history says which versions this copy doesn't hold, and a version gone from the device is said, never thrown (review, 14)", async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await page.evaluate(async (trip) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write(trip, '/notes/a.md', 'first', { author: 'user' });
    await ws.write(trip, '/notes/a.md', 'second', { author: 'user' });
    await store.tx(['events'], 'readwrite', async (/** @type {any} */ t) => {
      // A version an import didn't carry, and (from before the import named only what it carries) one whose content is gone.
      await t.appendEvent(trip, { ts: Date.now(), type: 'file.write', actor: 'user', data: { path: '/notes/a.md', old: null, new: null, was: { new: 'e'.repeat(64) } } });
      await t.appendEvent(trip, { ts: Date.now(), type: 'file.write', actor: 'user', data: { path: '/notes/a.md', old: null, new: 'd'.repeat(64) } });
    });
    store.close();
  }, trip);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/notes/a.md')}`);
  const rows = page.getByRole('region', { name: 'History' }).locator('li');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('Not kept in this copy');
  await expect(rows.nth(2)).toContainText('Current');
  await rows.nth(0).getByRole('button', { name: 'Restore this version' }).click();
  await expect(page.getByText("That version isn't stored on this device.")).toBeVisible();
  await rows.nth(3).getByRole('button', { name: 'Restore this version' }).click();
  await expect(page.getByText('Version restored')).toBeVisible();
  expect(errors.filter((e) => /restore|doesn't exist|unhandled/i.test(e))).toEqual([]);
});
