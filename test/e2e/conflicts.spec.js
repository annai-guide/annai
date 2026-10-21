import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, fixtureFiles, zipOf, modelSetUp, pickFile, pickAddress } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const file = (/** @type {Buffer} */ body, type = 'text/plain') => ({ status: 200, type, body });

test('a plugin whose tool name is taken: its page says Not used, naming who provides it; Use this one instead swaps them, shown on both pages and undone there', async ({ page }) => {
  const kit = await fixtureFiles('clash-tool');
  const site = await startModelServer({ '/kits/clash-tool/annai-plugin.json': file(kit['annai-plugin.json'], 'application/json'), '/kits/clash-tool/index.js': file(kit['index.js'], 'text/javascript') });
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'weather', input: {} }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Always sunny, it says.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await pickAddress(page, `${site.origin}/kits/clash-tool/annai-plugin.json`);
    await expect(page.getByRole('heading', { name: 'Install Clash tool?' })).toBeVisible();
    await page.getByRole('button', { name: 'Install anyway' }).click();
    await expect(page.locator('.card', { hasText: 'Clash tool' }).getByText('On', { exact: true })).toBeVisible();
    await page.goto('/#/plugins/clash-tool');
    const names = page.getByRole('region', { name: 'Names' });
    await expect(names.getByText('Not used: the tool weather is already provided by Places tools.')).toBeVisible();
    await names.getByRole('button', { name: 'Use this one instead' }).click();
    await expect(names.getByText('The tool weather: this one is used (your choice).')).toBeVisible();
    // The other's page says so too.
    await page.goto('/#/plugins/places');
    await expect(page.getByRole('region', { name: 'Names' }).getByText('The tool weather: the one from Clash tool (clash-tool) is used (your choice).')).toBeVisible();
    // Shiori uses it.
    await page.getByRole('navigation', { name: 'Shiori' }).getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill("What's the weather?");
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Always sunny, it says.');
    const [first, second] = llm.bodies('/b/v1/messages').map((b) => JSON.stringify(b));
    expect(first).toContain('The weather, from Clash tool.');
    expect(second).toContain('Clash weather: always sunny.');
    // Undone on the other's page: Places is used again, with nothing to say, and Clash tool's page says Not used.
    await page.goto('/#/plugins/places');
    await page.getByRole('region', { name: 'Names' }).getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('region', { name: 'Names' })).toHaveCount(0);
    await page.goto('/#/plugins/clash-tool');
    await expect(page.getByRole('region', { name: 'Names' }).getByText('Not used: the tool weather is already provided by Places tools.')).toBeVisible();
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('a plugin that replaces the avatar asks "It replaces how Shiori looks" at install; chosen, the dock shows it; Undo brings annai\'s back', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    const dock = page.getByRole('navigation', { name: 'Shiori' });
    // Kept as annai's: installed, and Not used.
    await pickFile(page, { name: 'mountain.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('avatar-replaces')) });
    await expect(page.getByText('It replaces how Shiori looks from annai.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: "Install, keep annai's" }).click();
    await expect(page.locator('.card', { hasText: 'Mountain look' }).getByText('On', { exact: true })).toBeVisible();
    await expect(dock.locator('.mountain-avatar')).toHaveCount(0);
    await page.goto('/#/plugins/avatar-replaces');
    await expect(page.getByRole('region', { name: 'Names' }).getByText('Not used: how Shiori looks is already provided by annai.')).toBeVisible();
    // Installed again, and used.
    await pickFile(page, { name: 'mountain.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('avatar-replaces')) });
    await page.getByRole('button', { name: 'Install and use it' }).click();
    await expect(dock.locator('.mountain-avatar')).toBeVisible();
    await page.goto('/#/plugins/avatar-replaces');
    const names = page.getByRole('region', { name: 'Names' });
    await expect(names.getByText('How Shiori looks: this one is used (your choice).')).toBeVisible();
    await names.getByRole('button', { name: 'Undo' }).click();
    await expect(names.getByText('Not used: how Shiori looks is already provided by annai.')).toBeVisible();
    await expect(dock.locator('.mountain-avatar')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test('a package from another place over an installed one says what it would get; Install fresh removes what that one kept, its choices too', async ({ page }) => {
  const kit = await fixtureFiles('clash-tool');
  const site = await startModelServer({ '/kits/clash-tool/annai-plugin.json': file(kit['annai-plugin.json'], 'application/json'), '/kits/clash-tool/index.js': file(kit['index.js'], 'text/javascript') });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await pickAddress(page, `${site.origin}/kits/clash-tool/annai-plugin.json`);
    await page.getByRole('button', { name: 'Install anyway' }).click();
    await expect(page.locator('.card', { hasText: 'Clash tool' }).getByText('On', { exact: true })).toBeVisible();
    await page.goto('/#/plugins/clash-tool');
    const names = page.getByRole('region', { name: 'Names' });
    await names.getByRole('button', { name: 'Use this one instead' }).click();
    await expect(names.getByText('The tool weather: this one is used (your choice).')).toBeVisible();
    // The same package, from a file.
    await pickFile(page, { name: 'clash-tool.zip', mimeType: 'application/zip', buffer: await zipOf(kit) });
    await expect(page.getByText(/not where this one comes from\. Kept, its settings, keys and your choices for its names go to this one; fresh, they are removed\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install, keep its settings and keys' })).toBeVisible();
    await page.getByRole('button', { name: 'Install fresh' }).click();
    await expect(page.locator('.card', { hasText: 'Clash tool' }).getByText('On', { exact: true })).toBeVisible();
    await page.goto('/#/plugins/clash-tool');
    await expect(names.getByText('Not used: the tool weather is already provided by Places tools.')).toBeVisible();
  } finally {
    await site.stop();
    await llm.stop();
  }
});
