import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, tapAdd } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// "Another address" looks for itself (milestone 5 of providers as plugins): its own Add flow asks a server for
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
    await tapAdd(page, 'Another address');
    await expect(page.getByRole('heading', { level: 1, name: 'Another address' })).toBeVisible({ timeout: 30_000 });
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
    await tapAdd(page, 'Another address');
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
    await tapAdd(page, 'Another address');
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
  await page.getByLabel('API key').fill('sk-or-typed-key-123');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  await expect(page.getByLabel('Use Chat', { exact: true })).toBeChecked();
});
