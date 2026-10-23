import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply } from './helpers.js';

// "do you think we should have some way to let the user compact or clear the transcript / session manually?" (the user, 2026-10-23):
// a menu on the Conversation screen, Summarize now and Start fresh (spec §6.5, §16.2).
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const speak = (/** @type {string} */ text) => sse(anthropicToolReply([{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }]));

/** A trip, and Shiori's main model on a stand-in Anthropic endpoint. @param {import('@playwright/test').Page} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
}

/** Types one message and waits for her answer to it. @param {import('@playwright/test').Page} page @param {string} text @param {number} n her lines so far, after this one */
async function say(page, text, n) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.convo .shiori p')).toHaveCount(n, { timeout: 20_000 });
  await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
}

test('the Conversation has a menu with Summarize now and Start fresh; Start fresh asks first, and leaves a divider with every earlier line still there and out of her next request', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak('Pelicans nest on the cliffs.'), speak('A fresh answer.')] });
  try {
    await setUp(page, llm.origin);
    await say(page, 'Tell me about pelicans', 1);
    const toggle = page.getByRole('button', { name: 'Tidy up' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('group', { name: 'Tidy up the conversation' });
    await expect(menu.getByRole('button')).toHaveText(['Summarize now', 'Start fresh']);
    // Cancel changes nothing.
    await menu.getByRole('button', { name: 'Start fresh' }).click();
    const dialog = page.getByRole('dialog', { name: 'Start fresh?' });
    await expect(dialog).toContainText('nothing is deleted');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.convo .fresh-divider')).toHaveCount(0);
    // Confirmed: the divider, and the earlier lines still in the conversation.
    await toggle.click();
    await menu.getByRole('button', { name: 'Start fresh' }).click();
    await page.getByRole('dialog', { name: 'Start fresh?' }).getByRole('button', { name: 'Start fresh' }).click();
    await expect(page.locator('.convo .fresh-divider')).toHaveText('Started fresh');
    await expect(page.locator('.convo .you').first()).toHaveText('Tell me about pelicans');
    await expect(page.locator('.convo .shiori p').first()).toContainText('Pelicans nest on the cliffs.');
    // Her next request holds none of the earlier lines.
    await say(page, 'And the weather?', 2);
    const sent = JSON.stringify(llm.bodies('/b/v1/messages').at(-1).messages);
    expect(sent).toContain('And the weather?');
    expect(sent).not.toContain('pelicans');
    expect(sent).not.toContain('Pelicans nest');
    // The divider stays between the old lines and the new, and is still there on a reload.
    await page.reload();
    await expect(page.locator('.convo .fresh-divider')).toHaveText('Started fresh');
    await expect(page.locator('.convo .you')).toHaveText(['Tell me about pelicans', 'And the weather?']);
  } finally {
    await llm.stop();
  }
});

test('Summarize now: with too little said it says so; after a few exchanges it summarizes, and the lines stay in the conversation', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak('One.'), speak('Two.'), speak('Three.'), speak('Four.'), sse(anthropicToolReply([], 'They talked about numbers.'))] });
  try {
    await setUp(page, llm.origin);
    await say(page, 'First', 1);
    await page.getByRole('button', { name: 'Tidy up' }).click();
    await page.getByRole('button', { name: 'Summarize now' }).click();
    await expect(page.getByText('There is not enough yet to summarize.')).toBeVisible();
    await say(page, 'Second', 2);
    await say(page, 'Third', 3);
    await say(page, 'Fourth', 4);
    await page.getByRole('button', { name: 'Tidy up' }).click();
    await page.getByRole('button', { name: 'Summarize now' }).click();
    await expect(page.locator('.convo .system-line', { hasText: 'Earlier conversation summarized.' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.convo .you')).toHaveText(['First', 'Second', 'Third', 'Fourth']);
    await expect(page.locator('.convo .fresh-divider')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test('the menu closes on Escape and on a tap elsewhere', async ({ page }) => {
  await openApp(page, '#/talk');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Tidy up' });
  const menu = page.getByRole('group', { name: 'Tidy up the conversation' });
  await toggle.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await toggle.click();
  await page.locator('main').click({ position: { x: 5, y: 300 }, force: true });
  await expect(menu).toBeHidden();
});
