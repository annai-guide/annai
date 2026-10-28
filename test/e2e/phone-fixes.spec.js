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

