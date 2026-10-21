import { test, expect } from '@playwright/test';
import { openApp, watchConsole, pastWelcome } from './helpers.js';

test('starts without errors and shows Trips', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the dock says "Offline · reminders still work" as the connection goes, and "Tap to talk" as it comes back (emulator pass m2b #10)', async ({ page, context }) => {
  await openApp(page);
  const label = page.locator('.talk-label');
  await expect(label).toHaveText('Tap to talk');
  await context.setOffline(true);
  await expect(label).toHaveText('Offline · reminders still work');
  await context.setOffline(false);
  await expect(label).toHaveText('Tap to talk');
});

test('the install warning shows in a browser tab and explains how', async ({ page }) => {
  await openApp(page);
  const banner = page.getByRole('region', { name: 'Install annai' });
  await expect(banner).toContainText("annai isn't installed yet");
  await banner.getByRole('button', { name: 'Show me how' }).click();
  await expect(banner.getByRole('listitem').first()).toBeVisible();
});

test("on iPhone the install warning says the Home Screen app keeps trips of its own, and how to bring them over", async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'the iPhone wording');
  await openApp(page);
  const banner = page.getByRole('region', { name: 'Install annai' });
  await expect(banner).toContainText("the Home Screen app keeps trips of its own: what you start here won't be there");
  await banner.getByRole('button', { name: 'Show me how' }).click();
  await expect(banner.getByRole('listitem').last()).toContainText('Open a trip someone sent you');
});

test('only one tab runs annai at a time', async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.goto('/#/trips');
  await expect(second.getByRole('heading', { name: 'annai is open in another tab' })).toBeVisible();
  await second.getByRole('button', { name: 'Use it here' }).click();
  await expect(second.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'annai was opened in another tab' })).toBeVisible();
});

test('an unexpected error shows a card and annai keeps running', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { setTimeout(() => { throw new Error('test boom'); }, 0); });
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await expect(page.getByText('annai kept running. The details are in Trace.')).toBeVisible();
  await page.getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});

test("an unexpected error whose details can't be written down says so, rather than that they are in Trace", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    // Nothing more can be written (the database is closing, as an iPhone's can).
    for (const m of /** @type {const} */ (['add', 'put'])) IDBObjectStore.prototype[m] = () => { throw new DOMException('The database connection is closing.', 'InvalidStateError'); };
    setTimeout(() => { throw new Error('test boom'); }, 0);
  });
  await expect(page.getByText("annai kept running, but couldn't write down what happened, so it isn't in Trace either.", { exact: false }).first()).toBeVisible();
  await expect(page.getByText('The details are in Trace.')).toHaveCount(0);
});

test('a mangled link opens Trips', async ({ page }) => {
  await openApp(page, '#/trip/%E6');
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});

test('dropping a file on annai opens it', async ({ page }) => {
  await openApp(page);
  const files = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['not a zip'], 'trip.annai.zip', { type: 'application/zip' }));
    return d;
  });
  await page.dispatchEvent('main.view', 'dragover', { dataTransfer: files });
  await page.dispatchEvent('main.view', 'drop', { dataTransfer: files });
  await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText("isn't an annai file");
});

test('Erase everything starts annai again as on a new device, the welcome then an empty Trips, with no error on the way', async ({ page }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (/couldn't open|Something went wrong/.test(document.body.textContent ?? '')) sessionStorage.setItem('erase-error', '1');
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await pastWelcome(page);
  await expect(page.getByText('No trips yet.')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('erase-error'))).toBeNull();
});

test("minors 26: a field in a column keeps its own height: no empty gap between a trip's name and its dates", async ({ page }) => {
  await openApp(page);
  const name = page.locator('label.field', { has: page.getByLabel('Trip name') });
  const dates = page.locator('.row', { has: page.getByLabel('Starts') });
  const [a, b] = [await name.boundingBox(), await dates.boundingBox()];
  expect(a && b).toBeTruthy();
  if (!a || !b) return;
  expect(a.height).toBeLessThan(100);
  expect(b.y - (a.y + a.height)).toBeLessThan(30);
  // In a row, fields still share it.
  const [start, end] = [await page.locator('label.field', { has: page.getByLabel('Starts') }).boundingBox(), await page.locator('label.field', { has: page.getByLabel('Ends') }).boundingBox()];
  expect(Math.abs((start?.width ?? 0) - (end?.width ?? 1))).toBeLessThan(2);
});

// The second emulator re-check: after typing a key, the first tap on Save only focused it (the keyboard going down laid the screen
// out again under the finger) and the second saved. A finger's tap leaves the field focused until the click, and the click lets go
// of it first of all: change, then click, as with a mouse (the review: the field's own saving must not run after the button).
test('a finger tap on a screen\'s button while typing: the field changes, then the button is clicked, at the first tap, even when the screen shifts as the field lets go', async ({ page }) => {
  await openApp(page, '#/notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  const field = page.getByLabel('Relay address');
  const save = page.getByRole('button', { name: 'Save address' });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__order = [];
    const input = /** @type {HTMLInputElement} */ (document.getElementById('push-relay'));
    const button = [...document.querySelectorAll('main button')].find((b) => b.textContent === 'Save address');
    input.addEventListener('change', () => w.__order.push('change'));
    // The keyboard going down: the screen is laid out again as the field lets go.
    input.addEventListener('blur', () => { if (w.__shifted) return; w.__shifted = true; const gap = document.createElement('div'); gap.style.height = '120px'; input.closest('section')?.prepend(gap); });
    button?.addEventListener('click', (e) => { w.__order.push('click'); e.stopImmediatePropagation(); }, true);
  });
  await field.click();
  await field.pressSequentially('x');
  const at = /** @type {{ x: number, y: number, width: number, height: number }} */ (await save.boundingBox());
  await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__order)).toEqual(['change', 'click']);
  // A mouse is left as it is: it takes the focus and the field changes at the press.
  await field.click();
  await field.pressSequentially('y');
  await save.click();
  expect(await page.evaluate(() => /** @type {any} */ (window).__order)).toEqual(['change', 'click', 'change', 'click']);
});
