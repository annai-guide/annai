import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, pickProvider, startSettled } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// Servers you run (milestone 2): a provider plugin per local server, whose quirks are data. The stand-ins
// answer as each server does, on ports of their own (WebKit can't stand in for a page's own requests).

test('llama.cpp through its plugin: its address and key, Fetch model list, a model that takes photos, Test, and Try this model streams its words', async ({ page }) => {
  const key = 'sk-unsloth-stand-in-0123456789';
  const s = await startFakeServer({
    flavour: 'llamacpp', key, gapMs: 300,
    replies: [
      { text: 'OK' }, // Test: the tiny request
      { calls: [{ name: 'report_color', input: { color: 'red' } }] }, // Test: the tool and the photo
      { reasoning: 'The user greets me. Say hello back.', text: 'Hello! Where would you like to go today?' },
    ],
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'llama.cpp');
    // Its default address, and the words for a phone.
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue('http://localhost:9931/v1');
    await expect(page.getByText(/On a phone, localhost is the phone itself\./)).toBeVisible();
    await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    const chat = page.getByRole('region', { name: 'Chat', exact: true });
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await expect(chat.locator('ul.listed li')).toContainText('qwen3.8-flash · loaded'); // the one the server has loaded now
    await chat.getByRole('button', { name: 'Add qwen3.8-flash' }).click();
    // The context the server serves, from its /props (decision 22).
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toContainText('33K context');
    // The list said it reads images: it takes photos.
    await page.getByRole('link', { name: /^qwen3\.8-flash/ }).click();
    await expect(page.getByLabel('Takes photos')).toBeChecked();
    await page.getByRole('link', { name: 'llama.cpp', exact: true }).click();
    // The model's page has a Test button too: its provider's page first (CI, 2026-10-19).
    await expect(page.getByRole('heading', { level: 1, name: 'llama.cpp', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByText('Everything works.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('✓ Tool calls work.')).toBeVisible();
    await expect(page.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
    const sent = s.requests.filter((r) => r.method === 'POST').map((r) => r.body);
    expect(sent.map((b) => [b.stream, b.reasoning_effort, b.chat_template_kwargs]), 'Test asks at level off: no thinking').toEqual([[true, 'none', { enable_thinking: false }], [true, 'none', { enable_thinking: false }]]);
    // Try this model: its words show while it is still writing, and its tokens once it has finished.
    await page.getByRole('link', { name: /^qwen3\.8-flash/ }).click();
    const tryIt = page.getByRole('region', { name: 'Try this model' });
    await tryIt.getByLabel('Message', { exact: true }).fill('Hello');
    await tryIt.getByRole('button', { name: 'Send', exact: true }).click();
    const words = tryIt.locator('.talk-text').last();
    await expect(words).toHaveText(/^Hello!/);
    await expect(tryIt.getByRole('button', { name: 'Stop' }), 'still writing').toBeVisible();
    await expect(words).toHaveText('Hello! Where would you like to go today?');
    await expect(tryIt.getByText(/^\d+ tokens · /)).toBeVisible();
    expect(s.requests.filter((r) => r.method === 'POST').at(-1)?.body.chat_template_kwargs, "Try this model asks at main's level, thinking on").toEqual({ enable_thinking: true });
    expect(await page.content()).not.toContain(key);
  } finally {
    await s.stop();
  }
});

test("a router that never streams, through Custom provider's Chat Completions: Test passes, and Try this model answers", async ({ page }) => {
  const s = await startFakeServer({
    flavour: 'whole', key: 'sk-test-router-0123',
    replies: [{ text: 'OK' }, { calls: [{ name: 'report_color', input: { color: 'red' } }] }, { text: 'Here you are: Nepenthe is open till 10.' }],
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await startSettled(page);
    await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add llama.cpp', exact: true })).toHaveCount(1);
    await page.getByRole('link', { name: 'Models', exact: true }).click();
    await addProvider(page, 'Custom provider', { ability: 'Chat Completions', name: 'Router', url: `${s.origin}/v1`, key: 'sk-test-router-0123', model: 'router-model' });
    await page.getByRole('link', { name: /Router/ }).click();
    await expect(page.getByText(/never streams.*Wait for the first words/)).toBeVisible();
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByText('Everything works.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('✓ Tool calls work.')).toBeVisible();
    await page.getByRole('link', { name: /^router-model/ }).click();
    const tryIt = page.getByRole('region', { name: 'Try this model' });
    await tryIt.getByLabel('Message', { exact: true }).fill('When does Nepenthe close?');
    await tryIt.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(tryIt.locator('.talk-text').last()).toHaveText('Here you are: Nepenthe is open till 10.');
    await expect(tryIt.getByText(/^\d+ tokens · /)).toBeVisible();
    // Each request with a model (not Custom provider's empty look at what the server offers).
    expect(s.requests.filter((r) => r.method === 'POST' && r.body?.model).every((r) => r.body.stream === true), 'a stream is still asked for').toBe(true);
  } finally {
    await s.stop();
  }
});

test('an address on your network over plain http is refused in words that say how to reach it', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'Ollama');
  await expect(page.getByLabel('API key'), 'Ollama takes no key').toHaveCount(0);
  await expect(page.getByText(/OLLAMA_ORIGINS=https:\/\/annai\.guide/)).toBeVisible();
  await page.getByLabel('Address', { exact: true }).fill('http://192.168.1.20:11434/v1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/needs one\. Tailscale Serve can give it: tailscale serve --bg --https=8443 http:\/\/localhost:11434\. The server must also allow CORS from annai\.guide/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Address', { exact: true }), 'nothing was saved').toHaveValue('http://localhost:11434/v1');
});
