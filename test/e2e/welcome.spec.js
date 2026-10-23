import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker } from './helpers.js';
import { SOURCES, FONTS, ART } from '../../src/ui/credits.js';

// The welcome and Settings → About (the user, 2026-10-18).
const STEPS = ['Welcome to annai', 'Shiori, Koe and Kokoro', 'What annai can do', 'Your keys and your data', 'The fine print', 'Get started'];
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

test('Erase starts annai again as on a new device: the welcome shows again, and no sign-in or other annai state is left in the browser', async ({ page }) => {
  await openApp(page, '#/welcome');
  await expect.poll(async () => typeof (await appSettings(page)).welcomedAt).toBe('number');
  // A sign-in waiting (its verifier) and a return expected, as a provider plugin keeps them; scroll positions kept for this tab.
  await page.evaluate(() => {
    localStorage.setItem('annai.openrouter', JSON.stringify({ verifier: 'v', state: 's', at: Date.now(), mode: 'code', url: 'https://openrouter.ai/auth?x' }));
    localStorage.setItem('annai.return', JSON.stringify({ plugin: 'provider-openrouter', at: Date.now() }));
    localStorage.setItem('annai.backupTimings', '{}');
    localStorage.setItem('elsewhere', 'kept');
    sessionStorage.setItem('annai-scrolls', '[]');
  });
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await expect(h1(page)).toHaveText(STEPS[0]);
  expect(new URL(page.url()).hash).toBe('#/welcome');
  // annai.forceDownload is this test's own, set again at each load.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'annai.forceDownload').sort())).toEqual(['elsewhere']);
  expect(await page.evaluate(() => sessionStorage.getItem('annai-scrolls'))).toBeNull();
});

// The tap on Erase can be a start's first, whose sound unlock starts a silent clip (spec §10.1). WebKit on
// Linux deadlocks the page's process, and the service worker that shares it, when a clip is stopped while it
// starts: the reload then never finished (the Erase hang, 2026-10-18).
test("Erase as a start's first tap, five times over: the welcome shows each time, and no clip is still starting as annai goes away", async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let plays = 0;
    let starting = 0;
    HTMLMediaElement.prototype.play = function () {
      const p = play.call(this);
      plays++;
      starting++;
      const done = () => { starting--; };
      p.then(done, done);
      return p;
    };
    // Kept where Erase leaves it: a key of the test's own, not annai's.
    addEventListener('beforeunload', () => localStorage.setItem('test-clips', `${localStorage.getItem('test-clips') ?? ''}${plays} played, ${starting} starting; `));
  });
  await openApp(page, '#/welcome');
  for (let i = 1; i <= 5; i++) {
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await expect(h1(page), `Erase ${i}`).toHaveText(STEPS[0]);
  }
  const clips = String(await page.evaluate(() => localStorage.getItem('test-clips'))).split('; ').filter(Boolean);
  expect(clips).toHaveLength(5);
  for (const c of clips) expect(c).toMatch(/^[1-9]\d* played, 0 starting$/);
});

test("the last step, where annai isn't installed: on an iPhone in Safari, look around first, and set the model up in the Home Screen app; elsewhere, set up a model", async ({ page, browserName }) => {
  await openApp(page, '#/welcome/6');
  await expect(h1(page)).toHaveText(STEPS[5]);
  const primary = page.locator('.welcome .acts .btn.pri').last();
  if (browserName === 'webkit') {
    // The iPhone project: Safari, not the Home Screen app.
    await expect(primary).toHaveText('Look around first');
    await expect(page.locator('.welcome')).toContainText('A model set up here, in Safari, stays in Safari.');
  } else {
    await expect(primary).toHaveText('Set up a model');
    // Chrome on Android offers to install from a button, once the browser says it can.
    const install = page.locator('.welcome').getByRole('button', { name: 'Install annai' });
    await expect(install).toBeHidden();
    await page.evaluate(() => dispatchEvent(new Event('beforeinstallprompt')));
    await expect(install).toBeVisible();
  }
});

test("the welcome's last step names the featured provider's sign-in from annai's catalog; outside Safari on an iPhone, its plugin installs in the background, so Models' sign-in is ready before the tap", async ({ page, browserName }) => {
  await openApp(page, '#/welcome/6');
  await waitForServiceWorker(page);
  const lead = page.locator('.welcome p', { hasText: 'so Shiori can think' });
  await expect(lead).toContainText('Sign in with OpenRouter is the quickest way, and it starts you on free models.');
  const installed = () => page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const state = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
    store.close();
    return Object.keys(state ?? {}).sort();
  });
  if (browserName === 'webkit') {
    // The iPhone project is Safari, not the Home Screen app: the model is set up there, so nothing installs here.
    await expect(lead).toContainText('A model set up here, in Safari, stays in Safari.');
    await page.waitForTimeout(1000);
    expect(await installed()).toEqual([]);
  } else {
    await expect.poll(installed, { timeout: 30_000 }).toEqual(['chat-completions', 'provider-openrouter', 'speech-openai']);
  }
});

test("the welcome's sentence on the featured sign-in comes with annai's catalog, not seconds later once its plugin has installed (the emulator pass)", async ({ page, context }) => {
  // Its plugin's files come slowly, as on a phone's connection after Erase.
  await context.route('**/plugins-official/provider-openrouter/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await route.continue().catch(() => {});
  });
  await openApp(page, '#/welcome/6');
  await expect(page.locator('.welcome p', { hasText: 'so Shiori can think' })).toContainText('Sign in with OpenRouter is the quickest way', { timeout: 4000 });
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

// "should we also introduce the user to our main architecture? and explain who is shiori, what is kokoro and what is koe?" (the user, 2026-10-23)
test('a step says who Shiori is, and what Koe (声) and Kokoro (心) each do, plainly and short', async ({ page }) => {
  await openApp(page, '#/welcome/2');
  await expect(h1(page)).toHaveText('Shiori, Koe and Kokoro');
  const step = page.locator('.welcome');
  await expect(step).toContainText('Shiori is your guide. She has two halves that work together.');
  await expect(step.locator('li', { hasText: 'Koe' })).toContainText('声');
  await expect(step.locator('li', { hasText: 'Koe' })).toContainText('talks with you and answers at once');
  await expect(step.locator('li', { hasText: 'Kokoro' })).toContainText('心');
  await expect(step.locator('li', { hasText: 'Kokoro' })).toContainText('thinks things through and does the work');
  // The Japanese words are marked as such, for a screen reader (fix pass 2); and where the halves' notes are, said rightly.
  await expect(step.locator('[lang="ja"]')).toHaveText(['声', '心']);
  await expect(step).toContainText('What they tell each other shows in the conversation; Settings → Shiori can hide it.');
  await expect(step.getByText('2 of 6')).toBeVisible();
  // It is skippable like every step: Next goes on, Back returns.
  await step.getByRole('button', { name: 'Next' }).click();
  await expect(h1(page)).toHaveText('What annai can do');
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
  await expect(h1(page)).toHaveText(STEPS[4]);
  await expect(h1(page)).toBeFocused();
  // Skip goes to the last step, which ends on the onboarding: Settings → Models.
  await tabTo('Skip');
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText(STEPS[5]);
  await tabTo('Set up a model');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  // From the featured provider's plugin, installed in the background once the offline service runs.
  await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' }).or(page.getByRole('link', { name: 'Sign in with OpenRouter' }))).toBeVisible({ timeout: 30_000 });
});

// The flaky keyboard test above (fixes-ui 14): in WebKit on Linux, a tap's sound unlock loading its silent clip again
// over one still starting (a tap is pointerup, touchend and click; Enter on a button is keydown and click) wedged
// the page, about half the time with quick keys. One unlock at a time (Voice.unlock); this held 0 of 8 before it.
test('quick keys on the welcome never stall the page: one sound unlock at a time', async ({ page }) => {
  await openApp(page, '#/welcome');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
  }
  await expect(h1(page)).toHaveText(STEPS[0]);
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
  // The page is drawn at once; the build comes when the service worker answers.
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
