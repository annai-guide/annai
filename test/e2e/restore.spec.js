import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, modelSetUp, buildAndSave, pastWelcome } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

// The emulator pass (m9 #20, shot 310): a restore brought the providers back with the settings, but none of the
// plugins they need, and Another address could then be installed from nowhere.
test('a restore brings the providers back with the plugins they use, in one step, and Shiori answers', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Welcome back to Big Sur.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Export everything' }).click();
    const file = await buildAndSave(page);
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await pastWelcome(page);

    await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
    await page.getByLabel('Replace my settings').check();
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText(/^Installed what your providers use: .*Another address/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Installed what your providers use: .*Anthropic Messages/)).toBeVisible();

    // The sentence asking to restart comes with the button that does it (the second emulator re-check).
    await expect(page.getByText('Restart annai to use the imported settings and plugins.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart annai' })).toBeVisible();

    await page.goto('/#/plugins');
    await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Another address' }).getByText('On', { exact: true })).toBeVisible();
    // As the import asks: annai restarts, and the provider is there with its plugin.
    await page.reload();
    await page.goto('/#/trips');
    await page.getByRole('link', { name: /Big Sur/ }).click();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Hello again');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Welcome back to Big Sur.');
  } finally {
    await llm.stop();
  }
});
