import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// A smart text box (the user, 2026-10-23): "the send and close are on the left side … put it at the right side … do we need the close
// button? maybe click on the keyboard button again closes the input box? … maybe we can also close the box when the message is sent?
// let's make the text box only there when it is needed and reduce the amount the user need to interact with the screen (make it 'smart')"

/** @param {import('@playwright/test').Page} page */
async function onTrips(page) {
  await openApp(page, '#/trips');
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
}
const typeButton = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('button', { name: 'Type', exact: true });
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');

test('the keyboard button opens the box with focus, and tapping it again closes it; there is no Close button', async ({ page }) => {
  await onTrips(page);
  await expect(box(page)).toBeHidden();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'false');
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
  await typeButton(page).click();
  await expect(box(page)).toBeHidden();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'false');
});

test('the box is a single line whose keyboard key says Send; Enter sends, and the box closes after sending', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await expect(box(page)).toHaveJSProperty('tagName', 'INPUT');
  await expect(box(page)).toHaveAttribute('enterkeyhint', 'send');
  await box(page).fill('Where is the nearest petrol station?');
  await box(page).press('Enter');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.convo .you').first()).toContainText('Where is the nearest petrol station?');
  await expect(box(page)).toBeHidden();
  // Opened again, it is empty.
  await typeButton(page).click();
  await expect(box(page)).toHaveValue('');
});

test('a small send arrow sits inside the box, on its right, for a keyboard with no send key and for a mouse; it sends and closes the box', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  const field = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box(page).boundingBox());
  const arrow = /** @type {{ x: number, y: number, width: number, height: number }} */ (await send.boundingBox());
  // Inside the box's frame, in its right half.
  expect(arrow.x).toBeGreaterThan(field.x + field.width / 2);
  expect(arrow.x + arrow.width).toBeLessThanOrEqual(field.x + field.width + 1);
  expect(arrow.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(arrow.y + arrow.height).toBeLessThanOrEqual(field.y + field.height + 1);
  await box(page).fill('Hello Shiori');
  await send.click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.convo .you').first()).toContainText('Hello Shiori');
  await expect(box(page)).toBeHidden();
});

test('Escape closes the box and keeps the draft', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await box(page).fill('half a thought');
  await box(page).press('Escape');
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  await expect(box(page)).toHaveValue('half a thought');
});

test('a tap elsewhere on the page closes the box when it is empty, and leaves it, with its draft, when it is not', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  await page.locator('main').click({ position: { x: 5, y: 5 }, force: true });
  await expect(box(page)).toBeHidden();
  await typeButton(page).click();
  await box(page).fill('still typing');
  await page.locator('main').click({ position: { x: 5, y: 5 }, force: true });
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveValue('still typing');
  // Taps inside the box and on its send arrow are not "elsewhere".
  await box(page).click();
  await expect(box(page)).toBeVisible();
});

test("the dock steps aside for a field outside it on a touch screen, but never for its own box (the box's own input is still in the dock)", async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await box(page).fill('hi');
  await expect(page.locator('html')).not.toHaveClass(/typing-elsewhere/);
  await expect(page.getByRole('navigation', { name: 'Shiori' })).toBeVisible();
});

test('the box and its send arrow are labelled for a screen reader, and the keyboard button says whether the box is open', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await expect(page.getByRole('textbox', { name: 'Message to Shiori' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(typeButton(page)).toHaveAttribute('aria-expanded', 'true');
});

// The user types Chinese and Japanese: Enter that picks a candidate in an IME must never send the half-composed text.
test('Enter while an IME is composing does not send; nothing is sent until a real Enter after the composition ends', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await box(page).fill('にほん');
  const prevented = await page.evaluate(() => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('dock-text'));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // Chrome and Firefox say isComposing; Safari's Enter that ends a composition comes after compositionend with keyCode 229.
    const a = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(a);
    // The form's own submit (implicit submission) while composing.
    input.form?.requestSubmit();
    return a.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveValue('にほん');
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('dock-text'));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    // Safari: keydown Enter with keyCode 229 right after compositionend.
    const b = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    input.dispatchEvent(b);
    return b.defaultPrevented;
  }).then((p) => expect(p, 'the 229 Enter is not allowed to submit the form').toBe(true));
  await expect(box(page)).toHaveValue('にほん');
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  // A real Enter, later, sends.
  await page.waitForTimeout(300);
  await box(page).press('Enter');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.convo .you').first()).toContainText('にほん');
});
