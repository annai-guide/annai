import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, fixtureFiles, startSettled } from './helpers.js';

// One catalog (milestone 3 of providers as plugins): one Add screen for everything a user can add,
// searchable and browsable, opened where the user came from.

/** The plugins installed, by id. @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
const installedIds = (page) => page.evaluate(async () => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const store = await createIdbStore();
  const state = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
  store.close();
  return Object.keys(state ?? {}).sort();
});
/** @param {import('@playwright/test').Page} page */
const cards = (page) => page.locator('.found .card');
/** @param {import('@playwright/test').Page} page @param {string} name */
const chip = (page, name) => page.getByRole('button', { name, exact: true });

test('Models → Add a provider opens the catalog on model providers; "unsloth" finds llama.cpp saying "Also for: Unsloth"; Add installs it and opens its page', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await startSettled(page);
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add' })).toBeVisible();
  await expect(chip(page, 'Model providers')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Model providers' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Backup places' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add OpenAI', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install Remote trace (for developers)' })).toHaveCount(0);
  // Custom provider, the catch-all, comes after the providers annai knows.
  await expect(page.getByRole('region', { name: 'Model providers' }).locator('.card').last()).toContainText('Custom provider');

  await page.getByLabel('Search the catalog').fill('unsloth');
  await expect(cards(page)).toHaveCount(1);
  const row = cards(page).first();
  await expect(row.locator('.name')).toHaveText('llama.cpp');
  await expect(row).toContainText('Also for: Unsloth');
  await expect(row).toContainText('Local');
  await expect(row).toContainText(/Official · Has code · \d+(\.\d)? kB/); // it reads the context a server serves (decision 22)
  // Typing never draws the screen again: the box keeps what is typed and its focus.
  await expect(page.getByLabel('Search the catalog')).toBeFocused();
  await row.getByRole('button', { name: 'Add llama.cpp' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'llama.cpp' })).toBeVisible({ timeout: 30_000 });
  expect(await installedIds(page)).toEqual(['chat-completions', 'provider-llamacpp']);

  // A name match comes before a keyword match, and one set up already says so.
  await page.getByRole('link', { name: '← Models' }).click();
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await page.getByLabel('Search the catalog').fill('lmstudio');
  await expect(cards(page).nth(0).locator('.name')).toHaveText('LM Studio');
  await expect(cards(page).nth(1).locator('.name')).toHaveText('llama.cpp');
  await expect(cards(page).nth(1)).toContainText('Also for: LM Studio');
  await expect(cards(page).nth(1)).toContainText('Added');
  await expect(cards(page).nth(1).getByRole('button', { name: 'Add another llama.cpp' })).toBeVisible();
});

test("a speech role's Add opens on providers with transcription; Plugins → Add opens on everything, grouped by kind; the chips filter", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await startSettled(page);
  await page.getByRole('link', { name: 'Add a provider for speech-in' }).click();
  await expect(chip(page, 'Transcription')).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['OpenAI', 'Groq', 'Local speech server']) await expect(page.getByRole('button', { name: `Add ${name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Anthropic', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Voices and transcription' })).toBeVisible();
  await page.getByRole('link', { name: '← Models' }).click();
  await page.getByRole('link', { name: 'Add a provider for speech-out' }).click();
  await expect(chip(page, 'Voice')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Add OpenAI', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Groq', exact: true })).toHaveCount(0);

  await page.goto('/#/plugins');
  await page.getByRole('link', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add' })).toBeVisible();
  await expect(page.getByRole('link', { name: '← Plugins' })).toBeVisible();
  for (const kind of ['Model providers', 'Voices and transcription', 'Backup places', 'Tools and MCP', 'Developer']) {
    await expect(page.getByRole('region', { name: kind })).toBeVisible();
    await expect(chip(page, kind)).toHaveAttribute('aria-pressed', 'false');
  }
  // Only kinds with something in them: no skill is in annai's catalog, and none is installed.
  await expect(page.getByRole('region', { name: 'Skills and personalities' })).toHaveCount(0);
  await expect(chip(page, 'Skills and personalities')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Tools and MCP' }).getByRole('link', { name: 'Set up An MCP server' })).toHaveAttribute('href', '#/mcp');

  await chip(page, 'Free').click();
  await expect(chip(page, 'Free')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Add OpenRouter', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add OpenAI', exact: true })).toHaveCount(0);
  await chip(page, 'Local').click();
  await expect(page.getByText('Nothing here matches. Try other words, or take a chip off.')).toBeVisible();
  await chip(page, 'Local').click();
  await chip(page, 'Free').click();
  await page.getByLabel('Search the catalog').fill('free voice');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first().locator('.name')).toHaveText('OpenRouter');
  await page.getByLabel('Search the catalog').fill('');

  // A backup place is set up on Backups, with its kind chosen.
  await chip(page, 'Backup places').click();
  await expect(page.getByRole('region', { name: 'Model providers' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Set up S3-compatible storage' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Backups' })).toBeVisible();
  await expect(page.getByLabel('Add a place to back up to')).toHaveValue('s3');
});

test('installing from an address is on the Add screen and goes to the install screen first', async ({ page }) => {
  const skill = await fixtureFiles('tide-pools');
  const md = (/** @type {Buffer} */ body) => ({ status: 200, type: 'text/markdown', body });
  const site = await startModelServer({ '/kits/tide-pools/SKILL.md': md(skill['SKILL.md']), '/kits/tide-pools/references/safety.md': md(skill['references/safety.md']) });
  try {
    await openApp(page, '#/plugins');
    await waitForServiceWorker(page);
    await page.getByRole('link', { name: 'Add', exact: true }).click();
    const elsewhere = page.getByRole('region', { name: 'Install from an address or a file' });
    await expect(elsewhere).toContainText('A plugin with code gets full access to your trips and API keys.');
    await elsewhere.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tide-pools/SKILL.md`);
    await elsewhere.getByRole('button', { name: 'Get it' }).click();
    await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible();
    expect(await installedIds(page), 'nothing is stored before Install').toEqual([]);
    // Its crumb and Cancel go back to the Add screen it came from, not to Plugins.
    await expect(page.getByRole('link', { name: '← Add' })).toHaveAttribute('href', '#/add');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add' })).toBeVisible();
    await elsewhere.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tide-pools/SKILL.md`);
    await elsewhere.getByRole('button', { name: 'Get it' }).click();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('tide-pools 1.2')).toBeVisible();

    // Installed, it lists in the catalog as what it is: third-party, from its address's host.
    await page.goto('/#/add');
    await chip(page, 'Third-party').click();
    await expect(cards(page)).toHaveCount(1);
    const region = page.getByRole('region', { name: 'Skills and personalities' });
    await expect(region.locator('.card')).toContainText(`From 127.0.0.1:${new URL(site.origin).port} · Data only`);
    await region.getByRole('link', { name: 'Open tide-pools' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'tide-pools' })).toBeVisible();
  } finally {
    await site.stop();
  }
});

test("Add's crumb goes back where it was opened from: Models, Plugins, or Experimental, whose Remote trace opens it on Developer", async ({ page }) => {
  await openApp(page, '#/experimental');
  await waitForServiceWorker(page);
  await page.getByRole('link', { name: "Get it from annai's catalog" }).click();
  await expect(chip(page, 'Developer')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Install Remote trace (for developers)' })).toBeVisible();
  await page.getByRole('link', { name: '← Experimental' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Experimental' })).toBeVisible();
  await page.goto('/#/models');
  await startSettled(page);
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await page.getByRole('link', { name: '← Models' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  // The crumb follows where it came from, not its filters: a chip off still goes back to Models.
  await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
  await chip(page, 'Model providers').click();
  await expect(page.getByRole('link', { name: '← Models' })).toHaveAttribute('href', '#/models');
  await page.goto('/#/plugins');
  await page.getByRole('link', { name: 'Add', exact: true }).click();
  await page.getByRole('link', { name: '← Plugins' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
});
