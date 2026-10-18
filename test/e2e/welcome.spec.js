import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker } from './helpers.js';
import { SOURCES, FONTS, ART } from '../../src/ui/credits.js';

// The welcome and Settings → About (the user, 2026-10-18).
const STEPS = ['Welcome to annai', 'What annai can do', 'Your keys and your data', 'The fine print', 'Get started'];
const h1 = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('heading', { level: 1 });

/** What /app.json in sys:settings says, through annai's own modules. @param {import('@playwright/test').Page} page */
const appSettings = (page) => page.evaluate(async () => {
  const load = (/** @type {string} */ url) => import(url);
  const { createIdbStore } = await load('/src/core/store-idb.js');
  const { Workspace } = await load('/src/core/workspace.js');
  const { readAppSettings } = await load('/src/core/settings.js');
  const store = await createIdbStore();
  try {
    return await readAppSettings(new Workspace(store));
  } finally {
    store.close();
  }
});

/** A new start of annai at its plain address. @param {import('@playwright/test').Page} page */
async function plainStart(page) {
  await page.goto('about:blank');
  await page.goto('/');
}

test('a fresh device is welcomed at its first plain start, and only once', async ({ page }) => {
  await page.goto('/');
  await expect(h1(page)).toHaveText(STEPS[0]);
  expect(new URL(page.url()).hash).toBe('#/welcome');
  await expect(h1(page)).toBeFocused();
  // Noted in the app's settings, not in localStorage.
  await expect.poll(async () => typeof (await appSettings(page)).welcomedAt).toBe('number');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /welcome/i.test(k)))).toEqual([]);
  // Shiori is the dock's, the only one on the screen.
  await expect(page.locator('.seat')).toHaveCount(1);
  await plainStart(page);
  await expect(h1(page)).toHaveText('Trips');
});

test.describe('a link that opens a screen is never interrupted', () => {
  test.use({ serviceWorkers: 'block' });

  test('a shared trip link opens its preview, and the welcome waits for the next plain start', async ({ page }) => {
    await page.route('https://files.example.test/shared.annai.zip', (route) => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'gone' }));
    await page.goto('/#import=' + encodeURIComponent('https://files.example.test/shared.annai.zip'));
    await expect(h1(page)).toHaveText('Open a trip');
    await page.waitForTimeout(300);
    await expect(h1(page)).toHaveText('Open a trip');
    expect((await appSettings(page)).welcomedAt).toBeUndefined();
    await plainStart(page);
    await expect(h1(page)).toHaveText(STEPS[0]);
  });

  test('a share from another app opens on the import screen, with no welcome', async ({ page }) => {
    await page.goto('/#/import?inbox=1');
    await expect(h1(page)).not.toHaveText(STEPS[0]);
    await expect(page.locator('main.view > *')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/import?inbox=1');
    expect((await appSettings(page)).welcomedAt).toBeUndefined();
  });
});

test('every step is reached with the keyboard alone, its heading taking the focus; Back goes to the one before', async ({ page }) => {
  await openApp(page, '#/welcome');
  /** Tabs until the focus is on the button with this name. @param {string} name */
  const tabTo = async (name) => {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === name) return;
    }
    throw new Error(`Tab never reached ${name}`);
  };
  for (const [i, step] of STEPS.entries()) {
    await expect(h1(page)).toHaveText(step);
    await expect(h1(page)).toBeFocused();
    if (i < STEPS.length - 1) {
      await tabTo('Next');
      await page.keyboard.press('Enter');
    }
  }
  await tabTo('Back');
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText(STEPS[3]);
  await expect(h1(page)).toBeFocused();
  // Skip goes to the last step, which ends on the onboarding: Settings → Models.
  await tabTo('Skip');
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText(STEPS[4]);
  await tabTo('Set up a model');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' }).or(page.getByRole('link', { name: 'Sign in with OpenRouter' }))).toBeVisible();
});

test('the welcome fits a phone 320 px wide: no step scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page, '#/welcome');
  /** @type {string[]} */
  const wide = [];
  for (const [i, step] of STEPS.entries()) {
    await page.evaluate((n) => { location.hash = n === 1 ? '#/welcome' : `#/welcome/${n}`; }, i + 1);
    await expect(h1(page)).toHaveText(step);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) wide.push(`${step} by ${over}px`);
  }
  expect(wide).toEqual([]);
});

test('Settings → About: the build, the licence, the source, and every credit; it shows the welcome again', async ({ page }) => {
  await openApp(page, '#/settings');
  await waitForServiceWorker(page);
  await page.getByRole('link', { name: 'About annai' }).click();
  await expect(h1(page)).toHaveText('About annai');
  const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
  const build = /const BUILD = '([^']+)'/.exec(sw)?.[1];
  await expect(page.getByText(`annai 0.1.0 · build ${build}`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Licence and source' }).getByRole('link', { name: 'github.com/annai-guide/annai', exact: true })).toHaveAttribute('href', 'https://github.com/annai-guide/annai');
  await expect(page.getByRole('link', { name: 'github.com/annai-guide/annai/issues' })).toHaveAttribute('href', 'https://github.com/annai-guide/annai/issues');
  for (const s of SOURCES) {
    const credit = page.locator('.credit', { has: page.getByRole('heading', { name: s.name, exact: true }) });
    await expect(credit, s.name).toContainText(s.credit);
    for (const l of s.links) await expect(credit.getByRole('link', { name: l.text, exact: true }), `${s.name}: ${l.text}`).toHaveAttribute('href', l.href);
  }
  for (const f of FONTS) await expect(page.getByText(f.name, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(ART)).toBeVisible();
  // The same words as the welcome's.
  await expect(page.getByRole('heading', { name: 'Your keys and your data' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The fine print' })).toBeVisible();

  await page.getByRole('link', { name: 'Read the licence' }).click();
  await expect(h1(page)).toHaveText('GNU Affero General Public License');
  await expect(page.getByText('Version 3, 19 November 2007')).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'Read the font licences' }).click();
  await expect(page.getByText('SIL OPEN FONT LICENSE Version 1.1').first()).toBeVisible();
  await page.goBack();

  await page.getByRole('link', { name: 'Show the welcome again' }).click();
  await expect(h1(page)).toHaveText(STEPS[0]);
  await expect(h1(page)).toBeFocused();
});

test('About fits a phone 320 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const at of ['#/about', '#/about/licence', '#/about/fonts', '#/experimental']) {
    await openApp(page, at);
    await expect(h1(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), at).toBe(0);
  }
});
