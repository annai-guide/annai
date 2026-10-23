import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, anthropicToolReply, modelSetUp } from './helpers.js';

// Languages you speak (phase 2; the user, 2026-10-23): Settings → Shiori picks them, in order, and the language she answers in; they are
// saved in the app settings (so a backup carries them) and every model that hears or speaks is told.

/** What /app.json in sys:settings says about languages, through annai's own modules. @param {import('@playwright/test').Page} page */
const saved = (page) => page.evaluate(async () => {
  const load = (/** @type {string} */ url) => import(url);
  const { createIdbStore } = await load('/src/core/store-idb.js');
  const { Workspace } = await load('/src/core/workspace.js');
  const { readAppSettings } = await load('/src/core/settings.js');
  const store = await createIdbStore();
  try {
    return (await readAppSettings(new Workspace(store))).languages;
  } finally {
    store.close();
  }
});

test('Settings → Shiori → Languages: the browser\'s language to begin with; add, reorder and remove, saved as they change and kept; Shiori answers in one language or follows you', async ({ page }) => {
  await openApp(page, '#/shiori');
  const panel = page.getByRole('region', { name: 'Languages', exact: true });
  await expect(panel.getByRole('heading', { name: 'Languages', exact: true })).toBeVisible();
  const list = panel.getByRole('list', { name: 'Languages you speak' });
  await expect(list.getByRole('listitem')).toHaveText([/^1\. English/]);
  await expect(panel).toContainText('None picked: annai uses the browser’s language.');
  expect(await saved(page)).toBeUndefined();
  // Adding turns the default into the user's own list.
  const add = panel.getByLabel('Add a language');
  await add.selectOption('zh');
  await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await add.selectOption('ja');
  await expect(list.getByRole('listitem')).toHaveText([/^1\. English/, /^2\. Chinese \(Mandarin\)/, /^3\. Japanese/]);
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'zh', 'ja'] });
  await panel.getByRole('button', { name: 'Move Japanese up' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/^1\. English/, /^2\. Japanese/, /^3\. Chinese \(Mandarin\)/]);
  await panel.getByRole('button', { name: 'Remove Chinese (Mandarin)' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/^1\. English/, /^2\. Japanese/]);
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'ja'] });
  // The language she answers in: the one you speak to her, or one fixed.
  const answer = panel.getByLabel('Shiori answers in');
  await expect(answer).toHaveValue('follow');
  await expect(answer.locator('option').first()).toHaveText('The language you speak to her');
  await answer.selectOption({ label: 'Japanese' });
  await expect(panel.getByRole('status').filter({ hasText: 'Saved' }).last()).toBeVisible();
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'ja'], answer: 'ja' });
  await page.reload();
  const again = page.getByRole('region', { name: 'Languages', exact: true });
  await expect(again.getByRole('list', { name: 'Languages you speak' }).getByRole('listitem')).toHaveText([/^1\. English/, /^2\. Japanese/]);
  await expect(again.getByLabel('Shiori answers in')).toHaveValue('ja');
  await expect(again).not.toContainText('None picked');
});

test('the languages are told to the model: Shiori\'s system text holds them, and a change shows at her next turn', async ({ page }) => {
  const reply = { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Hello.' } }, { name: 'sleep', input: {} }]) };
  const llm = await startModelServer({ '/b/v1/messages': [reply, reply] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/shiori');
    const panel = page.getByRole('region', { name: 'Languages', exact: true });
    await panel.getByLabel('Add a language').selectOption('ja');
    await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.goto('/#/trips');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Hi');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0);
    const system = (/** @type {any} */ body) => body.system.map((/** @type {any} */ b) => b.text).join('\n');
    expect(system(llm.bodies('/b/v1/messages')[0])).toContain('# Languages\nThe user speaks English and Japanese; they may switch between these. Answer in the language they used. Never switch to another language because of one word you\'re unsure of; if you can\'t make out what they said, ask them to say it again.');
  } finally {
    await llm.stop();
  }
});
