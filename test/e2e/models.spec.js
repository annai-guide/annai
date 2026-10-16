import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint } from './helpers.js';

test('endpoints, models and roles are set in Settings → Models, survive a reload, and the key is never shown', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: 'https://a.example.test/v1', key: 'sk-test-secret-a', model: 'a-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'a-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByText('1. a-model')).toBeVisible();
  await page.getByLabel('Reasoning for main').selectOption('high');
  await expect(page.getByLabel('Reasoning for main')).toHaveValue('high');
  await page.reload();
  await expect(page.getByText('1. a-model')).toBeVisible();
  await expect(page.getByLabel('Reasoning for main')).toHaveValue('high');
  await page.getByRole('link', { name: /Endpoint A/ }).click();
  await expect(page.getByLabel('API key')).toHaveValue('');
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /saved/);
  expect(await page.content()).not.toContain('sk-test-secret-a');
});

test('a model is edited on its own page', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: 'https://a.example.test/v1', key: 'sk-a', model: 'a-model' });
  await page.getByRole('link', { name: /Endpoint A/ }).click();
  await page.getByRole('link', { name: /^a-model/ }).click();
  await expect(page.getByLabel('Provider model id')).toHaveValue('a-model');
  await page.getByLabel('Name', { exact: true }).fill('Fast one');
  await page.getByLabel('Context window (tokens)').fill('32000');
  await page.getByLabel('Takes photos').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('link', { name: '← Endpoint A' }).click();
  await expect(page.getByRole('link', { name: /^Fast one/ })).toContainText('32K context');
});

test('the Test button checks access, the key, tool calls and photos', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await page.getByLabel('Add an endpoint').selectOption({ label: 'Scripted model (for testing)' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scripted model (for testing)' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Tunables (JSON)').fill(JSON.stringify({ script: [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }] }));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Everything works.')).toBeVisible();
  await expect(page.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
});

test('a conversation falls back from one provider to another, and the trace shows every request (milestone 2, part 1)', async ({ page }) => {
  const reply = await readFile(new URL('../fixtures/llm/anthropic/text.sse', import.meta.url), 'utf8');
  const llm = await startModelServer({
    '/a/v1/chat/completions': { status: 402, type: 'application/json', body: JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }) },
    '/b/v1/messages': { status: 200, type: 'text/event-stream', body: reply },
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: `${llm.origin}/a/v1`, key: 'sk-test-secret-a', model: 'a-model' });
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Endpoint B', url: `${llm.origin}/b`, key: 'sk-test-secret-b', model: 'b-model' });
    for (const m of ['a-model', 'b-model']) {
      await page.getByLabel('Add a model to main').selectOption({ label: m });
      await page.getByRole('button', { name: 'Add to main' }).click();
    }
    await expect(page.getByText('2. b-model')).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('Hello');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.talk-text').last()).toHaveText('Hello from B.');
    await expect(page.getByText(/^b-model · .* after 1 failed attempt \(a-model: out of credit\)$/)).toBeVisible();
    await page.getByRole('link', { name: 'Trace' }).click();
    await page.getByLabel('Type contains').fill('model.turn');
    await expect(page.getByText(/main: b-model · 2 attempts/)).toBeVisible();
    await page.getByLabel('Type contains').fill('net.request');
    await expect(page.locator('ol.trace > li')).toHaveCount(2);
    await expect(page.getByText(/a-model · credit \(402\)/)).toBeVisible();
    await expect(page.getByText(/b-model · ok \(200\)/)).toBeVisible();
    for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
    expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
  } finally {
    await llm.stop();
  }
});

test('Sign in with OpenRouter: the key arrives and free models fill the roles (OpenRouter stood in for)', async ({ page, browserName }) => {
  // WebKit doesn't let page.route stand in for requests from a page a service worker controls, so there the
  // exchange would reach the real OpenRouter. The unit tests and the device checklist cover Safari.
  test.skip(browserName === 'webkit', "Playwright can't stand in for OpenRouter here in WebKit");
  let authUrl = '';
  await page.route('https://openrouter.ai/auth**', (route) => {
    authUrl = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>OpenRouter</p>' });
  });
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON();
    if (body.code !== 'test-code' || body.code_challenge_method !== 'S256' || !body.code_verifier) return route.fulfill({ status: 400, headers: cors, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key: 'sk-or-test-key-123' }) });
  });
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  const origin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Sign in with OpenRouter' }).click();
  await expect.poll(() => authUrl).toContain('code_challenge_method=S256');
  const sent = new URL(authUrl);
  expect(sent.searchParams.get('callback_url')).toBe(`${origin}/`);
  await page.goto(`/?code=test-code&state=${sent.searchParams.get('state')}`);
  await expect(page.getByText(/Signed in with OpenRouter/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('1. Google: Gemma 4 31B (free)')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(await page.content()).not.toContain('sk-or-test-key-123');
});

test('an endpoint that stores files has a switch for photo uploads, kept when saved (spec §4.8)', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: 'https://llm.invalid/b', key: 'sk-test-b', model: 'b-model' });
  await page.getByRole('link', { name: /Stand-in/ }).click();
  const uploads = page.getByLabel('Upload photos to this provider (each expires after 48 hours)');
  await expect(uploads).toBeChecked();
  await uploads.uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#endpoint-tunables')).toHaveValue(/"uploads": false/); // shown once it is saved
  await page.reload();
  await expect(page.getByLabel('Upload photos to this provider (each expires after 48 hours)')).not.toBeChecked();
});

test('a model keeps its photo limits on its page, to see and change (spec §9.2)', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: 'https://llm.invalid/b', key: 'sk-test-b', model: 'b-model' });
  await page.getByRole('link', { name: /Stand-in/ }).click();
  await page.getByRole('link', { name: /^b-model/ }).click();
  const limits = page.getByLabel('Photo limits (JSON)');
  await expect(limits).toHaveValue('{}');
  await limits.fill('{ "maxEdge": 1568, "maxBytes": 3000000 }');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Photo limits (JSON)')).toHaveValue(/\n  "maxEdge": 1568/); // shown again, formatted, once saved
  await page.reload();
  await expect(page.getByLabel('Photo limits (JSON)')).toHaveValue(/"maxBytes": 3000000/);
});
