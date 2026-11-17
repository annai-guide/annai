import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// A provider page's model adds, Add model (by its id) and a listed model's Add, are busy from the tap (model-names-next): a double tap adds
// once. Two clicks in the same instant are the closest a double tap comes; a later one finds the row already gone.

/**
 * Clicks a button twice in the same instant. @param {import('@playwright/test').Locator} button
 * @returns {Promise<boolean>} whether the first click left it disabled
 */
const doubleTap = (button) => button.evaluate((b) => {
  const btn = /** @type {HTMLButtonElement} */ (b);
  btn.click();
  const busy = btn.disabled;
  btn.click();
  return busy;
});

/**
 * A llama.cpp provider on the stand-in server, its page open. @param {import('@playwright/test').Page} page @param {{ origin: string }} s @param {string} key
 * @returns {Promise<import('@playwright/test').Locator>} the page's Chat part
 */
async function addLlamaCpp(page, s, key) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'llama.cpp');
  await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  return page.getByRole('region', { name: 'Chat', exact: true });
}

test("a double tap on a model's Add adds it once, by its id and from the list", async ({ page }) => {
  const key = 'sk-double-tap-stand-in-0123';
  const s = await startFakeServer({
    flavour: 'llamacpp', key,
    models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', object: 'model', owned_by: 'llamacpp' }],
  });
  try {
    const chat = await addLlamaCpp(page, s, key);
    // By its id.
    await chat.getByLabel('Add a model by id').fill('by-id-1');
    expect.soft(await doubleTap(chat.getByRole('button', { name: 'Add model' })), 'Add model is busy from the tap').toBe(true);
    await expect(chat.getByRole('link', { name: /^by-id-1/ })).toBeVisible();
    // From the list.
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    expect.soft(await doubleTap(chat.getByRole('button', { name: 'Add qwen3.8-flash' })), 'a listed Add is busy from the tap').toBe(true);
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toBeVisible();
    // One more add after them: where a second tap had landed, its add would have ended before this one shows (they went one at a time).
    await chat.getByLabel('Add a model by id').fill('by-id-2');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByRole('link', { name: /^by-id-2/ })).toBeVisible();
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ }), 'one model, not "qwen3.8-flash (2)" too').toHaveCount(1);
    await expect(chat.getByRole('link', { name: /^by-id-1/ })).toHaveCount(1);
    await expect(chat.getByText(/already used by another model/), 'no second add was refused').toHaveCount(0);
  } finally {
    await s.stop();
  }
});

test("a listed Add that fails, on the last row of a long list, says why where the traveller is looking, and can be tapped again", async ({ page }) => {
  const key = 'sk-refused-stand-in-0123';
  // The list shows up to 50 rows in a box of its own, so the last row's refusal can be out of sight above or below it.
  const s = await startFakeServer({
    flavour: 'llamacpp', key,
    models: Array.from({ length: 40 }, (_, i) => ({ id: `long-list-${String(i).padStart(2, '0')}`, object: 'model', owned_by: 'llamacpp' })),
  });
  try {
    const chat = await addLlamaCpp(page, s, key);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('40 models.')).toBeVisible();
    // Its provider gone while the list was shown.
    await page.evaluate(async () => {
      const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
      const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
      const { readConfig, removeProviderRecords } = await import(/** @type {string} */ ('/src/core/llm/config.js'));
      const store = await createIdbStore();
      const ws = new Workspace(store);
      for (const id of Object.keys((await readConfig(ws)).providers)) await removeProviderRecords(ws, store, id);
      store.close();
    });
    const last = chat.getByRole('button', { name: 'Add long-list-39' });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    const row = chat.locator('ul.listed li', { hasText: 'long-list-39' });
    await expect(row.getByText('That provider no longer exists.')).toBeInViewport();
    await expect(chat.getByText('That provider no longer exists.'), 'said in the row, not in the models\' status line above the list').toHaveCount(1);
    await expect(last).toBeEnabled();
  } finally {
    await s.stop();
  }
});
