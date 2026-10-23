import { test, expect } from '@playwright/test';
import { openApp, startModelServer, anthropicToolReply, modelSetUp } from './helpers.js';

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

/** The Languages section of Settings → Shiori, opened. @param {import('@playwright/test').Page} page */
async function openLanguages(page) {
  await openApp(page, '#/shiori');
  const panel = page.getByRole('region', { name: 'Languages', exact: true });
  await expect(panel.getByRole('heading', { name: 'Languages', exact: true })).toBeVisible();
  return { panel, list: panel.getByRole('list', { name: 'Languages you speak' }), add: panel.getByLabel('Add a language'), addButton: panel.getByRole('button', { name: 'Add', exact: true }) };
}

test('Settings → Shiori → Languages: the browser\'s language to begin with; add, reorder and remove, saved as they change and kept; Shiori answers in one language or follows you', async ({ page }) => {
  const { panel, list, add, addButton } = await openLanguages(page);
  // One number, the list's own (it was "1. 1. English" with the text numbered as well).
  await expect(list.getByRole('listitem')).toHaveText([/^English/]);
  expect(await list.getByRole('listitem').first().innerText()).not.toMatch(/^1\./);
  await expect(panel).toContainText('None picked: annai uses the browser’s language.');
  expect(await saved(page)).toBeUndefined();
  // Adding turns the default into the user's own list; the pick is made in the list and committed by Add.
  await add.selectOption('zh');
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(panel.getByRole('status')).toHaveText('Added Chinese (Mandarin). Saved');
  await expect(panel).not.toContainText('None picked'); // the note follows the list, not only a new visit
  await add.selectOption('ja');
  await addButton.click();
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Chinese \(Mandarin\)/, /^Japanese/]);
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'zh', 'ja'], answer: 'follow' });
  await panel.getByRole('button', { name: 'Move Japanese up' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Japanese/, /^Chinese \(Mandarin\)/]);
  await panel.getByRole('button', { name: 'Remove Chinese (Mandarin)' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Japanese/]);
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'ja'], answer: 'follow' });
  // The language she answers in: the one you speak to her, or one of those you listed, by its name and its own.
  const answer = panel.getByLabel('Shiori answers in');
  await expect(answer).toHaveValue('follow');
  await expect(answer.locator('option')).toHaveText(['The language you speak to her', 'English · English', 'Japanese · 日本語']);
  await answer.selectOption('ja');
  await expect(panel.getByRole('status')).toHaveText('Shiori answers in Japanese. Saved');
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'ja'], answer: 'ja' });
  await page.reload();
  const again = page.getByRole('region', { name: 'Languages', exact: true });
  await expect(again.getByRole('list', { name: 'Languages you speak' }).getByRole('listitem')).toHaveText([/^English/, /^Japanese/]);
  await expect(again.getByLabel('Shiori answers in')).toHaveValue('ja');
  await expect(again).not.toContainText('None picked');
});

test('the arrow keys in the Add a language list only choose: nothing is added until Add is pressed (review item 6)', async ({ page }) => {
  const { panel, list, add, addButton } = await openLanguages(page);
  await expect(addButton).toBeDisabled();
  await add.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(addButton).toBeEnabled();
  expect(await saved(page)).toBeUndefined();
  await expect(panel.getByRole('status')).toHaveText('');
  const picked = await add.inputValue();
  await addButton.click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(add).toHaveValue('');
  await expect(addButton).toBeDisabled();
  await expect.poll(() => saved(page)).toMatchObject({ spoken: ['en', picked] });
});

test('after Move up, Move down or Remove focus stays where the user is, and the status line says what happened (review item 7)', async ({ page }) => {
  const { panel, list, add, addButton } = await openLanguages(page);
  for (const id of ['zh', 'ja']) {
    await add.selectOption(id);
    await addButton.click();
  }
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await panel.getByRole('button', { name: 'Move Japanese up' }).click();
  await expect(panel.getByRole('status')).toHaveText('Japanese moved to 2. Saved');
  await expect(panel.getByRole('button', { name: 'Move Japanese up' })).toBeFocused();
  await panel.getByRole('button', { name: 'Move Japanese up' }).press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Japanese moved to 1. Saved');
  await expect(list.getByRole('listitem')).toHaveText([/^Japanese/, /^English/, /^Chinese \(Mandarin\)/]);
  // At the top it has no Move up: focus goes to its Move down.
  await expect(panel.getByRole('button', { name: 'Move Japanese down' })).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Move Japanese up' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Move Japanese down' }).press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Japanese moved to 2. Saved');
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Japanese/, /^Chinese \(Mandarin\)/]);
  // Remove: focus goes to the next one's Remove, so the next press removes nothing by surprise but never loses its place.
  await panel.getByRole('button', { name: 'Remove Japanese' }).press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Japanese removed. Saved');
  await expect(panel.getByRole('button', { name: 'Remove Chinese (Mandarin)' })).toBeFocused();
  await panel.getByRole('button', { name: 'Remove Chinese (Mandarin)' }).press('Enter');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Remove English' })).toBeDisabled();
});

test('removing the language Shiori answers in resets her to follow you, in the same save; the answer list holds only the languages listed (review item 9)', async ({ page }) => {
  const { panel, list, add, addButton } = await openLanguages(page);
  const answer = panel.getByLabel('Shiori answers in');
  await expect(answer.locator('option')).toHaveText(['The language you speak to her', 'English · English']);
  await add.selectOption('ja');
  await addButton.click();
  await answer.selectOption('ja');
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'ja'], answer: 'ja' });
  await panel.getByRole('button', { name: 'Remove Japanese' }).click();
  await expect(panel.getByRole('status')).toHaveText('Japanese removed; Shiori answers in the language you speak to her again. Saved');
  await expect(answer).toHaveValue('follow');
  await expect(answer.locator('option')).toHaveText(['The language you speak to her', 'English · English']);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  expect(await saved(page)).toEqual({ spoken: ['en'], answer: 'follow' });
  await page.reload();
  await expect(page.getByLabel('Shiori answers in')).toHaveValue('follow');
});

/**
 * The section on a page of its own, over a store whose writes take 600 ms (what a slow phone does) and can be made to fail:
 * window.__writes holds what was written, window.__fail fails every write, window.__failAt the nth one.
 * @param {import('@playwright/test').Page} page
 */
async function mountProbe(page) {
  await page.goto('/#/trips');
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { languagesSection } = await load('/src/ui/languages.js');
    /** @type {any[]} */
    const writes = [];
    const w = /** @type {any} */ (window);
    w.__writes = writes;
    w.__fail = false;
    w.__failAt = 0;
    let calls = 0;
    const ws = {
      async patch(/** @type {string} */ _scope, /** @type {string} */ _path, /** @type {any} */ changes) {
        const n = ++calls;
        await new Promise((r) => setTimeout(r, 600));
        if (w.__fail || w.__failAt === n) throw new Error('The disk is full.');
        writes.push(JSON.parse(JSON.stringify(changes)));
      },
    };
    const el = languagesSection({ ws }, {});
    el.id = 'probe';
    document.body.append(el);
  });
  const probe = page.locator('#probe');
  return {
    probe, list: probe.getByRole('list', { name: 'Languages you speak' }),
    add: async (/** @type {string} */ id) => {
      await probe.getByLabel('Add a language').selectOption(id);
      await probe.getByRole('button', { name: 'Add', exact: true }).click();
    },
    writes: () => page.evaluate(() => /** @type {any} */ (window).__writes),
  };
}

test('two languages added before the first write lands are both kept; a write that fails puts the list back (Step S2)', async ({ page }) => {
  const { probe, list, add, writes } = await mountProbe(page);
  await add('zh');
  await add('ja');
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Chinese \(Mandarin\)/, /^Japanese/]);
  await expect.poll(async () => (await writes()).length, { timeout: 15_000 }).toBe(2);
  expect((await writes()).at(-1)).toEqual({ languages: { spoken: ['en', 'zh', 'ja'], answer: 'follow' } });
  // A write that fails, with nothing after it: the list goes back to what was kept, and the error is said.
  await page.evaluate(() => { /** @type {any} */ (window).__fail = true; });
  await add('ko');
  await expect(probe.getByRole('alert')).toHaveText('The disk is full.', { timeout: 15_000 });
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Chinese \(Mandarin\)/, /^Japanese/]);
});

test('a write that fails while an earlier one was still going puts the list back to what the earlier one sent, not to the change that failed (review follow-up 2)', async ({ page }) => {
  const { probe, list, add, writes } = await mountProbe(page);
  await page.evaluate(() => { /** @type {any} */ (window).__failAt = 2; });
  await add('zh'); // its write takes 600 ms...
  await add('ja'); // ...and this one is made in the meantime, and fails
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Chinese \(Mandarin\)/, /^Japanese/]);
  await expect(probe.getByRole('alert')).toHaveText('The disk is full.', { timeout: 15_000 });
  await expect(list.getByRole('listitem')).toHaveText([/^English/, /^Chinese \(Mandarin\)/]);
  expect(await writes()).toEqual([{ languages: { spoken: ['en', 'zh'], answer: 'follow' } }]);
});

test('choosing the answer language before choosing any saves only the answer: the list stays the browser\'s, not the user\'s (review follow-up 1)', async ({ page }) => {
  const { panel } = await openLanguages(page);
  await expect(panel).toContainText('None picked');
  const answer = panel.getByLabel('Shiori answers in');
  await answer.selectOption('en');
  await expect(panel.getByRole('status')).toHaveText('Shiori answers in English. Saved');
  await expect.poll(() => saved(page)).toEqual({ answer: 'en' });
  await expect(panel).toContainText('None picked');
  await page.reload();
  const again = page.getByRole('region', { name: 'Languages', exact: true });
  await expect(again).toContainText('None picked');
  await expect(again.getByLabel('Shiori answers in')).toHaveValue('en');
  await expect(again.getByRole('list', { name: 'Languages you speak' }).getByRole('listitem')).toHaveCount(1);
  // The first language added starts the user's own list, with the answer kept.
  await again.getByLabel('Add a language').selectOption('ja');
  await again.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => saved(page)).toEqual({ spoken: ['en', 'ja'], answer: 'en' });
});

test('removing a language down to one leaves focus on that language\'s item, not on a disabled button that drops it to the page (review follow-up 6)', async ({ page }) => {
  const { panel, list, add, addButton } = await openLanguages(page);
  await add.selectOption('ja');
  await addButton.click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Remove English' }).press('Enter');
  await expect(panel.getByRole('status')).toHaveText('English removed. Saved');
  await expect(list.getByRole('listitem')).toHaveText([/^Japanese/]);
  await expect(list.getByRole('listitem')).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Remove Japanese' })).toBeDisabled();
});

test('the languages are told to the model: Shiori\'s system text holds them, and a change shows at her next turn (review: a later request, not only the first)', async ({ page }) => {
  const reply = { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Hello.' } }, { name: 'sleep', input: {} }]) };
  const llm = await startModelServer({ '/b/v1/messages': [reply, reply, reply, reply] });
  const system = (/** @type {any} */ body) => body.system.map((/** @type {any} */ b) => b.text).join('\n');
  const rest = "Never switch to another language because of one word you're unsure of; if you can't make out what they said, ask them to say it again.";
  try {
    await modelSetUp(page, llm.origin);
    const { panel, add, addButton } = await openLanguages(page);
    await add.selectOption('ja');
    await addButton.click();
    await expect(panel.getByRole('status')).toHaveText('Added Japanese. Saved');
    await page.goto('/#/trips');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Hi');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0);
    expect(system(llm.bodies('/b/v1/messages')[0])).toContain(`# Languages\nThe user speaks English and Japanese; they may switch between these. Answer in the language they used. ${rest}`);
    // A change made afterwards is in the next turn's request.
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0);
    const before = llm.bodies('/b/v1/messages').length;
    await openLanguages(page);
    await page.getByLabel('Add a language').selectOption('zh');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Languages', exact: true }).getByRole('status')).toHaveText('Added Chinese (Mandarin). Saved');
    await page.goto('/#/trips');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('And dinner?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(before);
    expect(system(llm.bodies('/b/v1/messages').at(-1))).toContain(`# Languages\nThe user speaks English, Japanese and Chinese (Mandarin); they may switch between these. Answer in the language they used. ${rest}`);
  } finally {
    await llm.stop();
  }
});
