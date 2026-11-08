import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// Timeline stage 4: home is a timeline of trips and chats, and a + drops you into a new conversation with no naming step.

const plus = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('button', { name: 'New conversation', exact: true });
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');
/** The page's own store, through annai's modules. @param {import('@playwright/test').Page} page @param {string} id */
const record = (page, id) => page.evaluate(async (id) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const rec = await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  store.close();
  return rec;
}, id);
const draftOf = (/** @type {string} */ url) => decodeURIComponent(new URL(url).hash.split('/')[2]);

test('+ on home, voice off: the draft opens with the box ready; the first line names it, and the next + opens another', async ({ page }) => {
  await openApp(page, '#/trips');
  await expect(plus(page)).toBeVisible();
  await plus(page).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  const first = draftOf(page.url());
  expect((await record(page, first))?.draft).toBe(true);
  await expect(plus(page)).toBeHidden(); // home only
  await box(page).fill('Where should we eat tonight? Somewhere quiet.');
  await box(page).press('Enter');
  await expect.poll(async () => (await record(page, first))?.title).toBe('Where should we eat tonight?');
  expect((await record(page, first))?.draft).toBeUndefined();
  await page.goto('/#/trips');
  await plus(page).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  expect(draftOf(page.url())).not.toBe(first);
});
