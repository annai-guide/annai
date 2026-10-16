import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, startModelServer } from './helpers.js';

/**
 * From the Models screen: adds an endpoint from a template (installing its plugin), names it,
 * sets its base URL and key, adds one model by id, and comes back.
 * @param {import('@playwright/test').Page} page @param {string} template
 * @param {{ name: string, url: string, key: string, model: string }} o
 */
export async function addEndpoint(page, template, { name, url, key, model }) {
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await page.getByLabel('Add an endpoint').selectOption({ label: template });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: template })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Base URL').fill(url);
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByLabel('Add a model by id').fill(model);
  await page.getByRole('button', { name: 'Add model' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^${model}`) })).toBeVisible();
  await page.getByRole('link', { name: '← Models' }).click();
}

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
