import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply } from './helpers.js';

test('the avatar: states change her look, the level reaches the seat, and there is no innerHTML or style attribute', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    // A browser URL, not a file on disk: pass it as a value so the type checker doesn't resolve it.
    const at = (/** @type {string} */ p) => p;
    const { createAvatar } = await import(at('/src/ui/avatar.js'));
    const a = createAvatar({ size: 'big', label: 'Shiori' });
    a.el.id = 'probe';
    document.body.append(a.el);
    a.setState('thinking');
    a.setLevel(0.5, 'you');
    /** @type {any} */ (window).__a = a;
  });
  const av = page.locator('#probe .av');
  await expect(av).toHaveAttribute('data-state', 'thinking');
  await expect(page.locator('#probe')).toHaveAttribute('data-glow', 'you');
  expect(await page.locator('#probe').evaluate((el) => getComputedStyle(el).getPropertyValue('--amp').trim())).toBe('0.5');
  expect(await page.locator('#probe svg [style]').count()).toBe(0);
  expect(await page.locator('#probe svg .marker').count()).toBe(1);
  await page.evaluate(() => /** @type {any} */ (window).__a.setState('away'));
  await expect(av).toHaveAttribute('data-state', 'away');
});

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** A trip, and Shiori's main model on a stand-in Anthropic endpoint. @param {any} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
}

test('the dock is on every screen; typing to Shiori shows her answer in the conversation', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Nepenthe is 25 minutes south.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    for (const hash of ['#/trips', '#/settings', '#/trace']) {
      await page.goto(`/${hash}`);
      await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where should we eat?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.convo .you')).toHaveText('Where should we eat?');
    await expect(page.locator('.convo .shiori p')).toHaveText('Nepenthe is 25 minutes south.');
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
  } finally {
    await llm.stop();
  }
});

test('hostile model output in a card stays text: no HTML, no javascript: links', async ({ page }) => {
  const card = { title: '<b>Hi</b>', text: '<img src=x onerror="window.__pwned=1"> [bad](javascript:window.__pwned=1) and [good](https://example.com/)', links: [{ label: 'evil', url: 'javascript:alert(1)' }] };
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'show', input: { card } }, { name: 'sleep', input: {} }]))] });
  try {
    await setUp(page, llm.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Show me');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .card-title')).toHaveText('<b>Hi</b>');
    expect(await page.locator('.convo img').count()).toBe(0);
    expect(await page.locator('.convo a[href^="javascript"]').count()).toBe(0);
    await expect(page.locator('.convo a[href="https://example.com/"]')).toHaveText('good');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
  } finally {
    await llm.stop();
  }
});
