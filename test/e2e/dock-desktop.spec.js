import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// The dock's box on a desktop (the user, 2026-11-16, in the main session's words to them: the desktop keeps today's behaviour). Where the pointer is
// coarse (a phone or a tablet's touch keyboard; dock-text.spec.js, whose projects are touch) Enter adds a line; where it is fine (a mouse or
// trackpad) Enter sends and Shift+Enter adds a line; Ctrl or ⌘ with Enter sends on both. A desktop's scroll bars are classic: Playwright hides a
// headless Chromium's by default, so they are put back.
test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 }, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const typeButton = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('button', { name: 'Type', exact: true });
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');
/** @param {import('@playwright/test').Page} page */
async function inConversation(page) {
  await openApp(page, '#/talk');
  await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible();
}
/** The box's height, and whether it scrolls. @param {import('@playwright/test').Page} page */
const sizes = (page) => page.evaluate(() => {
  const el = /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text'));
  return { height: Math.round(el.getBoundingClientRect().height), scrolls: el.scrollHeight > el.clientHeight + 1 };
});
/** n lines of words, each short enough for one line of the box. @param {number} n */
const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n');

/** @param {import('@playwright/test').Page} page */
const finePointer = async (page) => expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches), 'a fine pointer').toBe(true);

test('Enter sends and the box closes; Shift+Enter adds a line, and the lines are sent as typed; Ctrl+Enter and ⌘+Enter send too', async ({ page }) => {
  await inConversation(page);
  await finePointer(page);
  await typeButton(page).click();
  await box(page).fill('Where is the nearest petrol station?');
  await box(page).press('Shift+Enter');
  await box(page).pressSequentially('And a café?');
  await expect(box(page)).toHaveValue('Where is the nearest petrol station?\nAnd a café?');
  await expect(page.locator('.convo .you')).toHaveCount(0); // nothing sent by Shift+Enter
  await box(page).press('Enter');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect.poll(() => page.locator('.convo .you p').first().evaluate((el) => /** @type {HTMLElement} */ (el).innerText)).toBe('Where is the nearest petrol station?\nAnd a café?');
  await expect(box(page)).toBeHidden();
  for (const [key, words] of [['Control+Enter', 'Thanks'], ['Meta+Enter', 'Thanks again']]) {
    await typeButton(page).click();
    await box(page).fill(words);
    await box(page).press(key);
    await expect(page.locator('.convo .you p').last()).toHaveText(words);
    await expect(box(page)).toBeHidden();
  }
});

test('Enter while an IME is composing neither sends nor adds a line, and the Enter that confirms in Safari (keyCode 229, right after the composition) does not send either; a real Enter later sends', async ({ page }) => {
  await inConversation(page);
  await finePointer(page);
  await typeButton(page).click();
  await box(page).fill('にほん');
  const prevented = await page.evaluate(() => {
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('dock-text'));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const a = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(a);
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const b = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    input.dispatchEvent(b);
    return [a.defaultPrevented, b.defaultPrevented];
  });
  expect(prevented).toEqual([true, true]);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveValue('にほん');
  await expect(page.locator('.convo .you')).toHaveCount(0); // nothing sent
  await page.waitForTimeout(300);
  await box(page).press('Enter');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.convo .you').first()).toContainText('にほん');
});

test("at its cap the box scrolls with no scroll bar of its own, so the send arrow covers none and the text keeps its width; the wheel still scrolls it", async ({ page }) => {
  await inConversation(page);
  await typeButton(page).click();
  await box(page).fill(lines(8));
  await expect.poll(async () => (await sizes(page)).height).toBe(144);
  expect((await sizes(page)).scrolls).toBe(true);
  // The box's width less its text column is its two 1 px borders: a classic scroll bar's 15 px would show here.
  const taken = () => box(page).evaluate((el) => /** @type {HTMLElement} */ (el).offsetWidth - el.clientWidth);
  expect(await taken()).toBe(2);
  await box(page).evaluate((el) => { el.scrollTop = 0; });
  await box(page).hover({ position: { x: 100, y: 40 } });
  await page.mouse.wheel(0, 60);
  await expect.poll(() => box(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});
