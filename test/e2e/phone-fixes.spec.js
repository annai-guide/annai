import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// The screens' side of the user's iPhone findings (2026-10-28, phone-fixes-1).

test("a backtick, an acute or a diaeresis on its own takes its own room: the Zen faces' marks don't sit on the next letter (item 7)", async ({ page }) => {
  await openApp(page);
  const widths = await page.evaluate(async () => {
    await document.fonts.load('400 16px "Zen Kaku Gothic New"', 'a`');
    await document.fonts.load('700 16px "Zen Maru Gothic"', 'a`');
    const width = (/** @type {string} */ font, /** @type {string} */ text) => {
      const s = document.createElement('span');
      s.style.cssText = `font: ${font}; white-space: pre; position: absolute`;
      s.textContent = text;
      document.body.append(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    };
    return ['400 16px "Zen Kaku Gothic New"', '700 16px "Zen Maru Gothic"'].map((f) => ['`', '´', '¨', '¸', 'ˆ', '˚', '˜'].map((c) => width(f, `${c}signature${c}`) - width(f, 'signature')));
  });
  for (const row of widths) for (const extra of row) expect(extra).toBeGreaterThan(4);
});

// "The top box for update looks bit cut off and not very clear that is supposed to be a seperate box" (IMG_3013).
const OFFER = 'New versions: Gemini API 0.9.0 → 0.10.1, Custom provider 2.1.4 → 2.2.1, OpenRouter 2.2.0 → 2.3.1, Remote trace (for developers) 0.1.2 → 0.2.1, and Anthropic 1.1.0 → 1.2.0. Nothing changes until you update. An updated plugin that is running now is off until annai restarts.';

for (const [width, height] of [[420, 912], [390, 844], [320, 544]]) {
  test(`a card is whole at ${width} x ${height}: all four edges in the box, a line under the cards, and More lined up with the words (item 3)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page, '#/trips');
    await page.evaluate(async (body) => {
      const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
      const notices = createNotices();
      notices.el.id = 'test-notices';
      document.querySelector('header.topbar')?.after(notices.el);
      notices.card({ title: 'Plugin updates are ready', body, actions: [{ label: 'Update', primary: true, run: () => {} }] });
    }, OFFER);
    const card = page.locator('.notice', { hasText: 'Plugin updates are ready' });
    await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
    const m = await page.locator('#test-notices').evaluate((box) => {
      const r = (/** @type {Element | null} */ el) => /** @type {Element} */ (el).getBoundingClientRect();
      const card = /** @type {HTMLElement} */ (box.querySelector('.notice'));
      const words = document.createRange();
      words.selectNodeContents(/** @type {Element} */ (card.querySelector('.more')));
      return {
        box: r(box), card: r(card), scrolled: box.scrollHeight - box.clientHeight, line: getComputedStyle(box).borderBottomWidth,
        text: r(card.querySelector('p')).left, more: words.getBoundingClientRect().left, update: r(card.querySelector('.acts .pri')).left,
      };
    });
    expect(m.scrolled, 'the box needs no scrolling to show the card').toBeLessThanOrEqual(0);
    expect(m.card.bottom).toBeLessThanOrEqual(m.box.bottom);
    expect(m.card.top).toBeGreaterThanOrEqual(m.box.top);
    expect(m.box.height).toBeLessThanOrEqual(height * 0.25 + 1);
    expect(m.line, 'a line parts the cards from the screen').not.toBe('0px');
    expect(Math.abs(m.more - m.text), 'More starts where the words do').toBeLessThanOrEqual(2);
    expect(Math.abs(m.update - m.text), 'and so does Update').toBeLessThanOrEqual(2);
    await expect(card.getByRole('button', { name: 'Dismiss' })).toBeInViewport();
  });
}
