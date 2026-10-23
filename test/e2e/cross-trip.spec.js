import { test, expect } from '@playwright/test';
import { openApp, startTrip, filterTrace } from './helpers.js';

test("a trip's conversation never shows another trip's photo named by its hash; its own shows, and the Trace says what was refused (backlog-hash)", async ({ page }) => {
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
  const row = page.locator('ol.trace li', { hasText: 'content.refused' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("the conversation · asked for content that isn't this trip's, and got none");
  await expect(row).toContainText('Big Sur');
});
