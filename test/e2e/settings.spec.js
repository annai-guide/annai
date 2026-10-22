import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, savedBy, tapAdd } from './helpers.js';

// Settings in the order a user reaches for them, Settings → Experimental, and the Jina key's link (the user, 2026-10-18).

/** The Settings sections' headings, top to bottom. @param {import('@playwright/test').Page} page */
const sections = (page) => page.locator('main .screen > section.panel > h2').allTextContents();

test('Settings lists what a user reaches for most often first, and Erase last', async ({ page }) => {
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  expect(await sections(page)).toEqual(['Models', 'Voice', 'Notifications', 'Backup', 'Shiori', 'Photos', 'Tools', 'Plugins', 'Storage',
    'Updates', 'About', 'Diagnostics', 'Developer', 'Experimental', 'Erase']);
  // Open an annai file sits with Backup.
  await expect(page.locator('section.panel', { has: page.getByRole('heading', { name: 'Backup' }) }).getByText('Open an annai file')).toBeVisible();
  // The version, which the App section showed, is on About's line.
  await expect(page.locator('section.panel', { has: page.getByRole('heading', { name: 'About' }) })).toContainText('annai 0.1.0');
});

test('Settings → Experimental: swiping between tabs is off by default, kept in the app settings when turned on', async ({ page }) => {
  await openApp(page, '#/settings');
  await page.getByRole('link', { name: 'Experimental' }).click();
  await expect(page.getByRole('heading', { name: 'Experimental', level: 1 })).toBeVisible();
  await expect(page.getByText('Features that are still being tried. They may have bugs, and their fixes may come slower than the rest of annai.')).toBeVisible();
  const swipe = page.getByRole('checkbox', { name: 'Swipe sideways to move between tabs' });
  await expect(swipe).not.toBeChecked();
  await swipe.check();
  await expect.poll(() => page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { readAppSettings } = await load('/src/core/settings.js');
    const store = await createIdbStore();
    try {
      return (await readAppSettings(new Workspace(store))).experimental?.swipeTabs;
    } finally {
      store.close();
    }
  })).toBe(true);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Swipe sideways to move between tabs' })).toBeChecked();
  await expect(page.locator('main.view')).toHaveCSS('touch-action', 'pan-y pinch-zoom');
});

test('Settings → Tools links the Jina key to where Jina gives one, opening outside annai', async ({ page }) => {
  await openApp(page, '#/tools');
  const link = page.getByRole('link', { name: 'Get a free key from Jina' });
  await expect(link).toHaveAttribute('href', 'https://jina.ai/api-dashboard/key-manager/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('Settings → Experimental points developers to Remote trace: install it from the catalog, or open it once installed', async ({ page }) => {
  await openApp(page, '#/experimental');
  const panel = page.getByRole('region', { name: 'Remote trace (for developers)' });
  await expect(panel).toContainText("Sends annai's trace to a server you run");
  await expect(panel.getByRole('link', { name: "Get it from annai's catalog" })).toHaveAttribute('href', '#/add?kind=developer&from=experimental');
});

// Settings → Models takes the request settings, and settings save as they change (the user, 2026-10-18).

test('Spend per day, the cache and housekeeping are on Settings → Models, and gone from Settings → Shiori', async ({ page }) => {
  await openApp(page, '#/models');
  for (const name of ['Spend per day', 'Cache', 'Housekeeping']) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  await expect(page.getByLabel('Spend per day (USD)')).toHaveValue('');
  await expect(page.getByRole('radio', { name: '1 hour' })).toBeChecked(); // an hour unless you choose five minutes
  await expect(page.getByLabel('Summarize at (% of the context)')).toHaveValue('70');
  await expect(page.getByLabel('Largest request (MiB)')).toHaveValue('8');
  await page.goto('/#/shiori');
  await expect(page.getByRole('heading', { name: 'Shiori', level: 1 })).toBeVisible();
  const own = page.getByRole('region', { name: 'How often she acts on her own' });
  for (const label of ['Wakes per hour, not counting yours', 'Quiet from', 'Quiet until', 'Steps per wake']) await expect(own.getByLabel(label)).toBeVisible();
  for (const name of ['Budgets', 'Housekeeping', 'Cache']) await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Spend per day (USD)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(1); // the personality's text alone
});

test('a setting saves as it changes, with no Save button, and is still there after a reload: a checkbox, a radio, a number, a time, a choice and JSON', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Stand-in', url: 'https://llm.invalid/b', key: 'sk-test-b', model: 'b-model', look: false });
  const fiveMinutes = page.getByRole('radio', { name: '5 minutes' });
  await fiveMinutes.check();
  await expect(savedBy(fiveMinutes)).toHaveText('Saved');
  const spend = page.getByLabel('Spend per day (USD)');
  await spend.fill('2.5');
  await spend.press('Tab');
  await expect(savedBy(spend)).toHaveText('Saved');
  await page.getByRole('link', { name: /Stand-in/ }).click();
  await page.getByRole('link', { name: /^b-model/ }).click();
  await expect(page.getByRole('heading', { name: 'b-model' })).toBeVisible();
  const limits = page.getByLabel('Photo limits (JSON)');
  await limits.fill('{ "maxEdge": 1568 }');
  await limits.blur();
  await expect(savedBy(limits)).toHaveText('Saved');
  await page.goto('/#/shiori');
  const from = page.getByLabel('Quiet from');
  await from.fill('22:00');
  await from.blur();
  const until = page.getByLabel('Quiet until');
  await until.fill('07:00');
  await until.blur();
  await expect(savedBy(until)).toHaveText('Saved');
  await page.goto('/#/settings');
  const keep = page.getByRole('checkbox', { name: 'Keep originals: store photos exactly as taken' });
  await keep.check();
  await expect(savedBy(keep)).toHaveText('Saved');
  const format = page.getByLabel('Save photos as');
  await format.selectOption('jpeg');
  await expect(savedBy(format)).toHaveText('Saved');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Keep originals: store photos exactly as taken' })).toBeChecked();
  await expect(page.getByLabel('Save photos as')).toHaveValue('jpeg');
  await page.goto('/#/shiori');
  await expect(page.getByLabel('Quiet from')).toHaveValue('22:00');
  await expect(page.getByLabel('Quiet until')).toHaveValue('07:00');
  await page.goto('/#/models');
  await expect(page.getByRole('radio', { name: '5 minutes' })).toBeChecked();
  await expect(page.getByLabel('Spend per day (USD)')).toHaveValue('2.5');
  await page.getByRole('link', { name: /Stand-in/ }).click();
  await page.getByRole('link', { name: /^b-model/ }).click();
  await expect(page.getByLabel('Photo limits (JSON)')).toHaveValue(/"maxEdge": 1568/);
});

test("a value that isn't valid shows why by its field and isn't saved", async ({ page }) => {
  await openApp(page, '#/models');
  const share = page.getByLabel('Summarize at (% of the context)');
  await share.fill('95');
  await share.press('Tab');
  await expect(page.getByText('Summarize at a share from 50 to 90%.')).toBeVisible();
  await expect(share).toHaveAttribute('aria-invalid', 'true');
  await page.reload();
  await expect(page.getByLabel('Summarize at (% of the context)')).toHaveValue('70');
});

/** A file of the user's, as stored. @param {import('@playwright/test').Page} page @param {string} path */
const meFile = (page, path) => page.evaluate(async (p) => {
  const load = (/** @type {string} */ url) => import(url);
  const { createIdbStore } = await load('/src/core/store-idb.js');
  const { Workspace } = await load('/src/core/workspace.js');
  const store = await createIdbStore();
  try {
    return await new Workspace(store).readText('me', p);
  } finally {
    store.close();
  }
}, path);

test('choosing another personality moves the editor to it, so its Save writes that one (review, 2026-10-18)', async ({ page }) => {
  await openApp(page);
  await expect.poll(() => meFile(page, '/personalities/storyteller.md')).toBeTruthy(); // installed as annai starts
  await page.goto('/#/shiori');
  const shiori = await meFile(page, '/personalities/shiori.md');
  const storyteller = page.getByRole('radio', { name: 'storyteller' });
  await storyteller.check();
  await expect(savedBy(storyteller)).toHaveText('Saved');
  await expect(page.getByLabel('"storyteller"')).toHaveValue(/\S/);
  await page.getByLabel('"storyteller"').fill('# Storyteller\nTell the stories of each place.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => meFile(page, '/personalities/storyteller.md')).toBe('# Storyteller\nTell the stories of each place.');
  expect(await meFile(page, '/personalities/shiori.md')).toBe(shiori);
});

test("quiet hours set halfway ask for the other time quietly, and say they need both only once the pair is left (review, 2026-10-18)", async ({ page }) => {
  await openApp(page, '#/shiori');
  const from = page.getByLabel('Quiet from');
  const until = page.getByLabel('Quiet until');
  await from.fill('22:00');
  await until.focus();
  await expect(page.getByRole('status').filter({ hasText: 'Set the other time too.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Quiet hours need both times' })).toHaveCount(0);
  await page.getByLabel('Steps per wake').focus();
  await expect(page.getByRole('alert')).toHaveText('Quiet hours need both times. Clear both for none.');
  await expect(until).toHaveAttribute('aria-invalid', 'true');
  await until.fill('07:00');
  await until.blur();
  await expect(savedBy(until)).toHaveText('Saved');
  await expect(page.getByRole('alert').filter({ hasText: 'Quiet hours' })).toHaveCount(0);
  await expect(until).not.toHaveAttribute('aria-invalid', 'true');
});

/** Holds the save queue until `release()`: a save tapped now stays "Saving…" for as long as the test likes. @param {import('@playwright/test').Page} page */
const holdSaves = (page) => page.evaluate(async () => {
  const w = /** @type {any} */ (window);
  const load = (/** @type {string} */ url) => import(url);
  const { queueSave } = await load('/src/ui/dom.js');
  const held = new Promise((r) => { w.release = r; });
  queueSave(() => held);
});

/**
 * Taps Save with the queue held: "Saving…" is on screen, beside the button on its line (not at the top of the page, under the bar),
 * until the queue is let go; with field, until the field shows the key saved, and the toast no sooner.
 * @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} save @param {{ label: string, saved: RegExp }} [field]
 */
async function savingBesideIt(page, save, field) {
  await holdSaves(page);
  await save.click();
  const line = page.locator('.acts', { has: save });
  const note = line.getByText('Saving…');
  await expect(note).toBeVisible();
  const [n, b] = [await note.boundingBox(), await save.boundingBox()];
  expect(Math.abs((n?.y ?? -999) - (b?.y ?? 999)), 'on the button\'s line').toBeLessThan(30);
  expect(n?.x).toBeGreaterThan((b?.x ?? 0) + (b?.width ?? 0) - 1);
  expect(n?.y).toBeGreaterThan(60); // under the top bar, not at the top of the page
  // What the key's field says the moment "Saving…" goes, and as the toast first shows (the re-check: it went 2 to 3 s
  // before the field showed the key saved, with "Saved" in between).
  if (field) {
    await page.evaluate((label) => {
      const w = /** @type {any} */ (window);
      const placeholder = () => [...document.querySelectorAll('label.field')].find((l) => l.querySelector('.field-label')?.textContent === label)?.querySelector('input')?.placeholder ?? null;
      w.seen = {};
      const look = () => {
        if (!w.seen.gone && ![...document.querySelectorAll('.sub')].some((e) => e.textContent === 'Saving…')) w.seen.gone = placeholder();
        if (!w.seen.toast && document.querySelector('.toast')) w.seen.toast = placeholder();
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, field.label);
  }
  await page.evaluate(() => /** @type {any} */ (window).release());
  await expect(note).toHaveCount(0);
  if (field) {
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).seen.toast ?? null)).not.toBeNull();
    const seen = await page.evaluate(() => /** @type {any} */ (window).seen);
    expect(seen.gone, '"Saving…" lasts until the field shows the key saved').toMatch(field.saved);
    expect(seen.toast, 'the toast comes with the field saved').toMatch(field.saved);
  }
}

test('a key field says "Saving…" beside its Save button, on screen, until the save lands: Jina\'s key, a plugin\'s secret setting and a provider\'s key (the third emulator pass)', async ({ page }) => {
  await openApp(page, '#/tools');
  await page.getByLabel('Jina key').fill('jina_test_key_0123');
  await savingBesideIt(page, page.getByRole('button', { name: 'Save key' }), { label: 'Jina key', saved: /^A key is set$/ });
  await expect(page.getByLabel('Jina key')).toHaveAttribute('placeholder', 'A key is set');
  // A plugin's secret: Remote trace has a token.
  await page.goto('/#/add');
  await waitForServiceWorker(page);
  await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
  await expect(page.getByText('Installed Remote trace (for developers).')).toBeVisible();
  await page.getByRole('link', { name: 'Open Remote trace (for developers)' }).click();
  await page.getByLabel('Token').fill('e2e-token-0123456789');
  await savingBesideIt(page, page.getByRole('button', { name: 'Save', exact: true }));
  await expect(page.getByLabel('Token')).toHaveAttribute('placeholder', 'saved');
  // A provider's own page.
  await openApp(page, '#/models');
  await tapAdd(page, 'OpenRouter');
  await expect(page.getByRole('heading', { level: 1, name: 'OpenRouter' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add by hand' }).click();
  await expect(page.getByRole('button', { name: 'Remove provider' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('API key').fill('sk-or-typed-key-123');
  await savingBesideIt(page, page.getByRole('button', { name: 'Save', exact: true }), { label: 'API key', saved: /^saved/ });
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
});
