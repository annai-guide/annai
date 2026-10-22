import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, tapAdd } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// "Custom provider" looks for itself (milestone 5 of providers as plugins): its own Add flow asks a server for
// its model list and sends an empty request to each path annai knows, at no cost, then adds it with what it found.
// Stand-ins answer as each server does, on ports of their own (WebKit can't route a page's own requests).

const KEY = 'sk-test-router-probe-0123';

/** The results of a look. @param {import('@playwright/test').Page} page */
const found = (page) => page.locator('.checks-result li');

test('a router that never streams, with a key: the list, Chat Completions and Responses are found at no cost, Add with these installs only their protocols, and Test answers', async ({ page }) => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY, replies: [{ text: 'OK' }, { calls: [{ name: 'report_color', input: { color: 'red' } }] }] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await tapAdd(page, 'Custom provider');
    await expect(page.getByRole('heading', { level: 1, name: 'Custom provider' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: '← Add' })).toBeVisible();
    await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
    await page.getByLabel('API key (optional)').fill(KEY);
    await page.getByRole('button', { name: 'Look for what it offers' }).click();
    await expect(found(page)).toHaveText(['✓ Model list: 1 model', '✓ Chat Completions', '✓ OpenAI Responses', '✗ Anthropic Messages: not found', '✗ Transcription: not found', '✗ Voice: not found'], { timeout: 30_000 });
    await expect(page.getByText('Nothing here costs money; Test sends real requests.')).toBeVisible();
    // Nothing that could generate was sent: no request carried a model or an input.
    expect(s.requests.filter((q) => q.method === 'POST').every((q) => !['model', 'messages', 'input'].some((f) => f in q.body))).toBe(true);

    await page.getByRole('button', { name: 'Add with these' }).click();
    const host = new URL(s.origin).host;
    await expect(page.getByRole('heading', { level: 1, name: host })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(page.getByLabel('Use Chat Completions')).toBeChecked();
    await expect(page.getByLabel('Use OpenAI Responses')).toBeChecked();
    for (const off of ['Anthropic Messages', 'Transcription', 'Voice']) await expect(page.getByLabel(`Use ${off}`)).not.toBeChecked();
    // Only what was found needs a protocol: Remove names those, and no other.
    await expect(page.getByText(/with Chat Completions and OpenAI Responses, which nothing else needs\./)).toBeVisible();

    const chat = page.getByRole('region', { name: 'Chat Completions', exact: true });
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await chat.getByRole('button', { name: 'Add router-model' }).click();
    await expect(page.getByRole('link', { name: /^router-model/ })).toBeVisible();
    await page.getByRole('region', { name: 'Chat Completions', exact: true }).getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByText('Everything works.')).toBeVisible({ timeout: 30_000 });
    expect(s.requests.some((q) => q.method === 'POST' && q.body?.model === 'router-model'), 'Test sends real requests').toBe(true);
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await s.stop();
  }
});

test("a server that doesn't allow web apps is said to be blocked, in words, and nothing is offered to add", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'whole', cors: false });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await tapAdd(page, 'Custom provider');
    await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
    await page.getByRole('button', { name: 'Look for what it offers' }).click();
    await expect(page.getByText(/doesn't allow web apps like annai to call it \(no CORS headers\)/)).toBeVisible({ timeout: 30_000 });
    await expect(found(page).nth(1)).toHaveText("✗ Chat Completions: blocked: it doesn't allow web apps (no CORS)");
    await expect(page.getByRole('button', { name: 'Add with these' })).toHaveCount(0);
  } finally {
    await s.stop();
  }
});

test('a server behind a key on every path, looked at without the key: no telling, and the key is asked for; with it, what it has is found', async ({ page }) => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY, authEverywhere: true });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await tapAdd(page, 'Custom provider');
    await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
    await page.getByRole('button', { name: 'Look for what it offers' }).click();
    await expect(found(page).nth(1)).toHaveText('? Chat Completions: it asks for a key before it says what it has: give the key, then look again.', { timeout: 30_000 });
    await expect(found(page).filter({ hasText: '✓' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add with these' })).toHaveCount(0);
    // A look is for the address and key it looked with.
    await page.getByLabel('API key (optional)').fill(KEY);
    await expect(found(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Look for what it offers' }).click();
    await expect(found(page).nth(1)).toHaveText('✓ Chat Completions', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Add with these' })).toBeVisible();
  } finally {
    await s.stop();
  }
});

test("a provider plugin's own Add flow, by hand: OpenRouter's Add shows its sign-in, and Add by hand opens its page with the key field", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await tapAdd(page, 'OpenRouter');
  await expect(page.getByRole('heading', { level: 1, name: 'OpenRouter' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' }).or(page.getByRole('link', { name: 'Sign in with OpenRouter' }))).toBeVisible();
  await page.getByRole('button', { name: 'Add by hand' }).click();
  await expect(page.getByRole('button', { name: 'Remove provider' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.toast', { hasText: "now use OpenRouter's free models." })).toBeVisible();
  await page.getByLabel('API key').fill('sk-or-typed-key-123');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  await expect(page.getByLabel('Use Chat', { exact: true })).toBeChecked();
  // Adding put OpenRouter's free models in the empty chat roles, and said so; never the recommended Claude models, which cost money
  // (the second emulator re-check: a summary was paid for that nobody had chosen).
  await page.getByRole('link', { name: '← Models' }).click();
  const roles = page.getByRole('region', { name: 'Roles' });
  await expect(roles.locator('.role').first().getByText(/^1\. Google: Gemma 4 31B/)).toBeVisible();
  await expect(roles.locator('.role-item > span').filter({ hasText: /Claude/ })).toHaveCount(0);
});

/** The plugins installed, by id. @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
const installedIds = (page) => page.evaluate(async () => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const store = await createIdbStore();
  const state = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
  store.close();
  return Object.keys(state ?? {}).sort();
});

test("leaving Custom provider's Add flow without adding takes its plugin away again; a provider whose plugin draws no Add flow there still has Add by hand", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await tapAdd(page, 'Custom provider');
  await expect(page.getByRole('button', { name: 'Look for what it offers' })).toBeVisible({ timeout: 30_000 });
  expect(await installedIds(page)).toContain('provider-another-address');
  await page.getByRole('link', { name: '← Add' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add' })).toBeVisible();
  await expect.poll(() => installedIds(page)).not.toContain('provider-another-address');
  // OpenAI's plugin is data only: its Add flow, asked for by address, has nothing of its own, and Add by hand still adds.
  await page.goto('/#/models');
  await tapAdd(page, 'OpenAI');
  await expect(page.getByRole('button', { name: 'Remove provider' })).toBeVisible({ timeout: 30_000 });
  await page.goto('/#/models/provider?new=provider-openai');
  await expect(page.getByText(/OpenAI has no way of its own to add it here/)).toBeVisible();
  await page.getByRole('button', { name: 'Add by hand' }).click();
  await expect(page.getByRole('button', { name: 'Remove provider' })).toBeVisible({ timeout: 30_000 });
  await page.goto('/#/models');
  await expect(page.locator('a.card', { hasText: 'OpenAI' })).toHaveCount(2);
});

test('a fetched list marks a model another provider already has, as adding it by id refuses it, rather than adding it again as "utils (2)" (the emulator pass)', async ({ page }) => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY, models: [{ id: 'utils', object: 'model', owned_by: 'router' }, { id: 'qwen-free', object: 'model', owned_by: 'router' }] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    const host = new URL(s.origin).host;
    for (const n of [1, 2]) {
      await tapAdd(page, 'Custom provider');
      await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
      await page.getByLabel('API key (optional)').fill(KEY);
      await page.getByRole('button', { name: 'Look for what it offers' }).click();
      await page.getByRole('button', { name: 'Add with these' }).click({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1, name: host })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel('Name', { exact: true }).fill(`Router ${n}`);
      await page.getByLabel('Name', { exact: true }).blur();
      await expect(page.getByRole('heading', { level: 1, name: `Router ${n}` })).toBeVisible();
      const chat = page.getByRole('region', { name: 'Chat Completions', exact: true });
      await chat.getByRole('button', { name: 'Fetch model list' }).click();
      await expect(chat.getByText('2 models.')).toBeVisible();
      if (n === 1) {
        await chat.getByRole('button', { name: 'Add utils' }).click();
        await expect(page.getByRole('link', { name: /^utils/ })).toBeVisible();
      } else {
        const listed = chat.locator('ul.listed');
        await expect(listed.getByRole('button', { name: 'Add utils' })).toHaveCount(0);
        await expect(listed.locator('li', { hasText: 'utils' })).toContainText('Already added, on Router 1');
        await expect(listed.getByRole('button', { name: 'Add qwen-free' })).toBeVisible();
        await chat.getByLabel('Add a model by id').fill('utils');
        await chat.getByRole('button', { name: 'Add model' }).click();
        await expect(chat.getByText('"utils" is already used by another model')).toBeVisible();
        await expect(page.getByRole('link', { name: /utils \(2\)/ })).toHaveCount(0);
      }
      await page.getByRole('link', { name: '← Models' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
    }
  } finally {
    await s.stop();
  }
});
