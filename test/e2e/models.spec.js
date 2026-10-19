import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, filterTrace, responsesReply, anthropicToolReply, savedBy, leaveSaved } from './helpers.js';

test('endpoints, models and roles are set in Settings → Models, survive a reload, and the key is never shown', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Chat Completions', { name: 'Endpoint A', url: 'https://a.example.test/v1', key: 'sk-test-secret-a', model: 'a-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'a-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByText('1. a-model')).toBeVisible();
  await page.getByLabel('Reasoning for main').selectOption('high');
  await expect(savedBy(page.getByLabel('Reasoning for main'))).toHaveText('Saved');
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
  // Each saves as it changes: no Save button (the user, 2026-10-18).
  await expect(page.getByRole('region', { name: 'Model', exact: true }).getByRole('button')).toHaveCount(0);
  await page.getByLabel('Name', { exact: true }).fill('Fast one');
  await page.getByLabel('Context window (tokens)').fill('32000');
  await page.getByLabel('Takes photos').check();
  await expect(savedBy(page.getByLabel('Takes photos'))).toHaveText('Saved');
  await expect(page.getByRole('heading', { name: 'Fast one', level: 1 })).toBeVisible();
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
  await leaveSaved(page.getByLabel('Tunables (JSON)'));
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Everything works.')).toBeVisible();
  await expect(page.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
});

test('a conversation falls back from one provider to another, and the trace shows every request (milestone 2, part 1)', async ({ page }) => {
  const llm = await startModelServer({
    '/a/v1/chat/completions': { status: 402, type: 'application/json', body: JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }) },
    '/b/v1/messages': { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Hello from B.' } }, { name: 'sleep', input: {} }]) },
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
    // Talking to the models is Shiori's conversation now; each model's page has "Try this model" (the user, 2026-10-18).
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Hello from B.');
    await page.getByRole('link', { name: 'Trace' }).click();
    await page.getByLabel('Type contains').fill('model.turn');
    await expect(page.getByText(/main: b-model · 2 attempts/)).toBeVisible();
    await filterTrace(page, { kind: 'Models', type: 'net.request' });
    await expect(page.locator('ol.trace > li')).toHaveCount(2);
    await expect(page.getByText(/a-model · credit \(402\)/)).toBeVisible();
    await expect(page.getByText(/b-model · ok \(200\)/)).toBeVisible();
    for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
    expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
  } finally {
    await llm.stop();
  }
});

test('"Try this model" on a model\'s page answers from that model alone: one that fails says so, and no other model is asked; Models has no "Talk to your models"', async ({ page }) => {
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
    await expect(page.getByRole('region', { name: 'Talk to your models' })).toHaveCount(0);
    await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
    // B answers itself, with its tokens and cost.
    await page.getByRole('link', { name: /Endpoint B/ }).click();
    await page.getByRole('link', { name: /^b-model/ }).click();
    const tryIt = page.getByRole('region', { name: 'Try this model' });
    await expect(tryIt).toContainText('no other model answers');
    await tryIt.getByLabel('Message', { exact: true }).fill('Hello');
    await tryIt.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(tryIt.locator('.talk-text').last()).toHaveText('Hello from B.');
    await expect(tryIt.getByText(/^\d+ tokens · /)).toBeVisible();
    expect(llm.bodies('/b/v1/messages')).toHaveLength(1);
    // A is out of credit: it says so, and B, next in the main role, isn't asked.
    await page.goto('/#/models');
    await page.getByRole('link', { name: /Endpoint A/ }).click();
    await page.getByRole('link', { name: /^a-model/ }).click();
    await tryIt.getByLabel('Message', { exact: true }).fill('Hello');
    await tryIt.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(tryIt.getByText(/^a-model didn't answer: out of credit .*No other model was asked\.$/)).toBeVisible();
    expect(llm.bodies('/a/v1/chat/completions')).toHaveLength(1);
    expect(llm.bodies('/b/v1/messages')).toHaveLength(1);
    expect(await page.content()).not.toContain('sk-test-secret');
    // Nothing is kept but the trace.
    await page.getByRole('link', { name: 'Trace' }).click();
    await page.getByLabel('Type contains').fill('model.turn');
    await expect(page.getByText(/try: b-model · 1 attempt/)).toBeVisible();
    await expect(page.getByText(/try: no answer · 1 attempt/)).toBeVisible();
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

test("on an iPhone Home Screen app, Sign in with OpenRouter is a link made before the tap: it opens OpenRouter for a code, and the paste box waits, also after annai reopens", async ({ page, context, browserName }) => {
  test.skip(browserName !== 'webkit', 'the iPhone Home Screen path');
  // Safari opens a page only from the tap itself, not after an await (the user's bug, 2026-10-18).
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
  await context.route('https://openrouter.ai/auth**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Your code</p>' }));
  await openApp(page, '#/models');
  const link = page.getByRole('link', { name: 'Sign in with OpenRouter' });
  await expect(link).toHaveAttribute('href', /^https:\/\/openrouter\.ai\/auth\?/);
  await expect(link).toHaveAttribute('target', '_blank');
  const href = /** @type {string} */ (await link.getAttribute('href'));
  const sent = new URL(href);
  expect(sent.searchParams.get('callback_url')).toBeNull();
  expect(sent.searchParams.get('code_challenge')).toBeTruthy();
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  expect(popup.url()).toBe(href);
  await popup.close();
  await expect(page.getByLabel('Paste the code OpenRouter showed you')).toBeVisible();
  // iPhone may close annai while the user is in Safari: the same sign-in is still waiting for its code.
  await page.reload();
  await expect(page.getByLabel('Paste the code OpenRouter showed you')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with OpenRouter' })).toHaveAttribute('href', href);
});

test('an endpoint that stores files has a switch for photo uploads, kept when saved (spec §4.8)', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: 'https://llm.invalid/b', key: 'sk-test-b', model: 'b-model' });
  await page.getByRole('link', { name: /Stand-in/ }).click();
  const uploads = page.getByLabel('Upload photos to this provider (each expires after 48 hours)');
  await expect(uploads).toBeChecked();
  await uploads.uncheck();
  await expect(savedBy(uploads)).toHaveText('Saved'); // as it changes: the Save button is the connection's
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
  await leaveSaved(limits);
  await expect(page.getByLabel('Photo limits (JSON)')).toHaveValue(/\n  "maxEdge": 1568/); // shown again, formatted, once saved
  await page.reload();
  await expect(page.getByLabel('Photo limits (JSON)')).toHaveValue(/"maxBytes": 3000000/);
  // A limit the model's settings refuse says which, and isn't saved (review, 2026-10-18).
  await page.getByLabel('Photo limits (JSON)').fill('{ "maxEdge": 10 }');
  await page.getByLabel('Photo limits (JSON)').blur();
  await expect(page.getByRole('alert')).toHaveText('maxEdge must be at least 16');
  await page.reload();
  await expect(page.getByLabel('Photo limits (JSON)')).toHaveValue(/"maxEdge": 1568/);
  // Added by id on an Anthropic endpoint, it takes both cache lifetimes, so it gets the hour (review, 2026-10-18).
  await expect(page.getByLabel('Cache lifetimes (5m, 1h)')).toHaveValue('5m, 1h');
  // A save that fails puts the field back to what is stored, and says why.
  await page.getByRole('link', { name: '← Stand-in' }).click();
  await page.getByLabel('Add a model by id').fill('c-model');
  await page.getByRole('button', { name: 'Add model' }).click();
  await page.getByRole('link', { name: /^c-model/ }).click();
  await expect(page.getByRole('heading', { name: 'c-model', level: 1 })).toBeVisible(); // not the endpoint's Name, still shown a moment
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('b-model');
  await name.blur();
  await expect(page.getByRole('alert')).toHaveText('"b-model" is already used by another model');
  await expect(name).toHaveValue('c-model');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
});

test('an OpenAI Responses endpoint: its model list, the Test button with the tool, the photo and the upload, and a conversation with one tool call (stood in for)', async ({ page }) => {
  const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
  const encrypted = 'gAAAAABe2eEncryptedReasoning==';
  const llm = await startModelServer({
    '/v1/models': { status: 200, type: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', owned_by: 'system' }, { id: 'gpt-6.1-sol', object: 'model', owned_by: 'system' }] }) },
    '/v1/files': { status: 200, type: 'application/json', body: JSON.stringify({ id: 'file-e2e', object: 'file', purpose: 'vision', expires_at: Math.floor(Date.now() / 1000) + 3600 }) },
    '/v1/responses': [
      sse(responsesReply({ text: 'OK' })), // Test: the tiny request
      sse(responsesReply({ calls: [{ name: 'report_color', input: { color: 'red' } }] })), // Test: the tool and the photo
      sse(responsesReply({ reasoning: { id: 'rs_e2e', summary: 'Show the hours.', encrypted }, calls: [{ name: 'show', input: { card: { title: 'Nepenthe', text: 'Open till 10.' } } }] })),
      sse(responsesReply({ text: 'Shown.' })),
    ],
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await page.getByLabel('Add an endpoint').selectOption({ label: 'Other: OpenAI Responses' });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Other: OpenAI Responses' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Name', { exact: true }).fill('Responses stand-in');
    await page.getByLabel('Base URL').fill(`${llm.origin}/v1`);
    await page.getByLabel('API key').fill('sk-test-secret-r');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Responses stand-in' })).toBeVisible();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(page.getByLabel('Upload photos to this provider (each expires after 48 hours)')).toBeChecked();
    // The model list, from GET /models.
    await page.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(page.getByText('2 models.')).toBeVisible();
    await page.getByRole('button', { name: 'Add gpt-6-luna' }).click();
    await page.getByRole('link', { name: /^gpt-6-luna/ }).click();
    await page.getByLabel('Takes photos').check();
    await expect(savedBy(page.getByLabel('Takes photos'))).toHaveText('Saved');
    await page.getByRole('link', { name: '← Responses stand-in' }).click();
    // The Test button: access and the key, then the tool with the photo, then an upload.
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByText('Everything works.')).toBeVisible();
    await expect(page.getByText('✓ Tool calls work.')).toBeVisible();
    await expect(page.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
    await expect(page.getByText(/^✓ Photo uploads work/)).toBeVisible();
    expect(llm.bodies('/v1/files').length).toBe(1);
    const photo = llm.bodies('/v1/responses')[1].input[0].content;
    expect(photo.find((/** @type {any} */ c) => c.type === 'input_image').image_url).toMatch(/^data:image\/png;base64,/);
    // A conversation: Shiori shows a card, then says she has.
    await page.getByRole('link', { name: '← Models' }).click();
    await page.getByLabel('Add a model to main').selectOption({ label: 'gpt-6-luna' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText('1. gpt-6-luna')).toBeVisible();
    await page.goto('/#/trips');
    await page.getByLabel('Trip name').fill('Big Sur');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('When does Nepenthe close?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .card-title')).toHaveText('Nepenthe');
    await expect.poll(() => llm.bodies('/v1/responses').length).toBe(4);
    const [first, second] = llm.bodies('/v1/responses').slice(2);
    for (const body of [first, second]) {
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.input.at(-1).role).toBe('developer'); // the now block, out of the cached prefix
    }
    expect(first.instructions).toBeTruthy();
    expect(first.tools.find((/** @type {any} */ t) => t.name === 'show')).toMatchObject({ type: 'function', strict: false });
    // The second request carries the first reply back: its encrypted reasoning, then the call, then the call's result.
    const items = second.input;
    const at = items.findIndex((/** @type {any} */ x) => x.type === 'reasoning');
    expect(items[at]).toEqual({ id: 'rs_e2e', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Show the hours.' }], encrypted_content: encrypted });
    expect(items[at + 1]).toMatchObject({ type: 'function_call', name: 'show' });
    expect(items[at + 2]).toMatchObject({ type: 'function_call_output', call_id: items[at + 1].call_id });
    expect(await page.content()).not.toContain('sk-test-secret-r');
  } finally {
    await llm.stop();
  }
});
