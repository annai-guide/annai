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

// Fix pass 2, item 7: focus after a send goes to the keyboard button, never into the hidden box.
test('after a send from the box, focus is on the keyboard button, and keys typed then go nowhere hidden', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await box(page).fill('first');
  await box(page).press('Enter');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(box(page)).toBeHidden();
  await expect(typeButton(page)).toBeFocused();
  await page.keyboard.type('unseen'); // no space: a space on the focused button opens the box, as it should
  expect(await page.evaluate(() => /** @type {HTMLInputElement} */ (document.getElementById('dock-text')).value)).toBe('');
});

// Fix pass 2, item 11: a press elsewhere never closes the box under the finger: it closes with the press's click.
test('a press elsewhere closes the empty box only with its click, so nothing moves under the finger while it is down', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  const at = /** @type {{ x: number, y: number }} */ (await page.getByRole('heading', { name: 'Trips', exact: true }).boundingBox());
  await page.mouse.move(at.x + 5, at.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await expect(box(page)).toBeVisible();
  await page.mouse.up();
  await expect(box(page)).toBeHidden();
});

// Fix pass 2, item 12 and Step's S1: Android keyboards may send Enter as keyCode 229 with no composition: that Enter sends. A 229 Enter is
// held back only while composing, or right after a composition ended (Safari's confirming Enter), and a composition the box lost (blur,
// closed) holds nothing back afterwards.
test("Enter as keyCode 229 holds back only while composing or right after a composition ended; with none, an Android keyboard's Enter is let through", async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await box(page).fill('hello');
  // The whole sequence in the page: the box holds a 229 Enter back for 100 ms after a composition ended (by the events' own time stamps),
  // so "right after" has to be right after in the page's own time, not after a round trip to the test, which a slow machine stretches
  // past the 100 ms. "A while after" is a wait in the page too, and a timer never fires early.
  const held = await page.evaluate(async () => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('dock-text'));
    const enter229 = () => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const composition = (/** @type {'compositionstart' | 'compositionend'} */ type) => input.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    const out = { android: enter229(), composing: false, afterwards: false, later: true };
    composition('compositionstart');
    out.composing = enter229();
    composition('compositionend');
    out.afterwards = enter229();
    await new Promise((r) => setTimeout(r, 150));
    out.later = enter229();
    return out;
  });
  expect(held.android, 'no composition: Android').toBe(false);
  expect(held.composing, 'while composing').toBe(true);
  expect(held.afterwards, "Safari's Enter that confirms a candidate").toBe(true);
  expect(held.later, 'a while after the composition ended').toBe(false);
});

test('a composition the box lost (it closed, or lost focus) holds back nothing: a real Enter afterwards sends', async ({ page }) => {
  await onTrips(page);
  for (const lose of ['close', 'blur']) {
    await typeButton(page).click();
    await box(page).fill(`words after ${lose}`);
    await page.evaluate(() => { /** @type {HTMLInputElement} */ (document.getElementById('dock-text')).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    if (lose === 'close') {
      await typeButton(page).click();
      await expect(box(page)).toBeHidden();
      await typeButton(page).click();
    } else await page.evaluate(() => { /** @type {HTMLInputElement} */ (document.getElementById('dock-text')).blur(); });
    await page.waitForTimeout(300);
    await box(page).press('Enter');
    await expect(page.locator('.convo .you').last()).toHaveText(`words after ${lose}`);
  }
});

// Fix pass 3, item 6: iOS sends no click for a tap on plain content, or a drag: the box closes NO_CLICK_MS after the pointer is up.
test('a press elsewhere that brings no click (iOS, on plain content) still closes the empty box, a moment after it ends', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  // It is still open 100 ms after the pointer is up, looked at in the page: the box closes 400 ms after, by its own timer, and a look from the
  // test can come after that on a slow machine. The page's timers fire in the order of their times, so a wait of 100 ms there always comes
  // before the 400 ms close; and a close in a microtask or a zero-delay timer would be caught by it (NO_CLICK_MS at 0 fails this).
  const stillOpen = await page.evaluate(async () => {
    const el = /** @type {HTMLElement} */ (document.querySelector('main h1'));
    for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerType: 'touch' }));
    await new Promise((r) => setTimeout(r, 100));
    return /** @type {HTMLElement} */ (document.getElementById('dock-text')).offsetParent !== null;
  });
  expect(stillOpen, 'still open 100 ms after the pointer is up').toBe(true);
  await expect(box(page)).toBeHidden({ timeout: 2000 });
});

// Follow-up 4: a drag (the pointer moved) or a mouse (which always sends its click) is no tap elsewhere.
test('a drag elsewhere, or a mouse press with no click, leaves the empty box open', async ({ page }) => {
  await onTrips(page);
  await typeButton(page).click();
  await expect(box(page)).toBeVisible();
  await page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.querySelector('main h1'));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerType: 'touch', clientX: 20, clientY: 100 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'touch', clientX: 20, clientY: 160 }));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerType: 'mouse', clientX: 20, clientY: 100 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'mouse', clientX: 20, clientY: 100 }));
  });
  await page.waitForTimeout(800);
  await expect(box(page)).toBeVisible();
});
