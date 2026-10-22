import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startSettled } from './helpers.js';

// The screens' side of the user's iPhone findings (2026-10-22).

test('the dock hides while a field outside it has focus, comes back when focus leaves, and its own box still types', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  const dock = page.locator('nav.dock');
  await expect(dock).toBeVisible();
  const before = await dock.boundingBox();
  const field = page.getByLabel(/Summarize at/);
  await field.focus();
  await expect(dock).toBeHidden();
  // Hidden by visibility, not removed: its box stays, so the page doesn't move under the keyboard.
  expect(await dock.boundingBox()).toEqual(before);
  await field.blur();
  await expect(dock).toBeVisible();
  // The dock's own box: the dock stays while it is typed in.
  await page.getByRole('button', { name: 'Type' }).click();
  const box = page.getByLabel('Message to Shiori');
  await expect(box).toBeFocused();
  await box.fill('hello');
  await expect(dock).toBeVisible();
  await expect(box).toHaveValue('hello');
});

test('a button under the dock still takes a click while a field has focus: the dock comes back after the press, not at it', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  // A button where the dock is (under it, while it shows): pressing it lets go of the field.
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'under-dock';
    b.textContent = 'Under the dock';
    b.style.cssText = 'position: fixed; left: 8px; right: 8px; bottom: 8px; height: 40px; z-index: 1';
    b.addEventListener('click', () => { b.dataset.clicked = '1'; });
    document.querySelector('main')?.append(b);
  });
  await page.getByLabel(/Summarize at/).focus();
  await expect(page.locator('nav.dock')).toBeHidden();
  await page.locator('#under-dock').click();
  await expect(page.locator('#under-dock')).toHaveAttribute('data-clicked', '1');
  await expect(page.locator('nav.dock')).toBeVisible();
});

// "In the add, at model providers, if user type in something returns nothing, maybe we should put the 'another address' there ...
// same for voices and transcription. also maybe call that custom providers?" (the user, 2026-10-22)
for (const [filter, link, region] of [
  ['model providers', 'Add a provider', 'Model providers'],
  ['transcription', 'Add a provider for speech-in', 'Voices and transcription'],
  ['voice', 'Add a provider for speech-out', 'Voices and transcription'],
]) {
  test(`Add on ${filter}: a search that finds nothing offers Custom provider, by its address`, async ({ page }) => {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await startSettled(page);
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add' })).toBeVisible();
    await expect(page.getByRole('region', { name: region })).toBeVisible();
    const found = page.locator('.found');
    await page.getByLabel('Search the catalog').fill('zzqx');
    await expect(found.getByText('Not listed? Add it by its address.')).toBeVisible();
    await expect(found.locator('.card')).toHaveCount(1);
    await expect(found.locator('.card .name')).toHaveText('Custom provider');
    await expect(found.getByRole('button', { name: 'Add Custom provider' })).toBeVisible();
    // A search that finds something shows what it found, with no offer.
    await page.getByLabel('Search the catalog').fill('openai');
    await expect(found.getByText('Not listed?')).toHaveCount(0);
    await expect(found.getByRole('button', { name: 'Add OpenAI', exact: true })).toBeVisible();
  });
}

test('Add: nothing found among tools offers no Custom provider; and "custom" finds it by name', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await startSettled(page);
  await page.goto('/#/plugins');
  await page.getByRole('link', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Tools and MCP', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('zzqx');
  await expect(page.getByText('Nothing here matches. Try other words, or take a chip off.')).toBeVisible();
  await expect(page.getByText('Not listed?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools and MCP', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('custom');
  await expect(page.locator('.found .card .name')).toHaveText('Custom provider');
});
