import { test, expect } from '@playwright/test';

test('the avatar: states change her look, the level reaches the seat, and there is no innerHTML or style attribute', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    // A browser URL, not a file on disk: pass it as a value so the type checker doesn't resolve it.
    const at = (/** @type {string} */ p) => p;
    const { createAvatar } = await import(at('/src/ui/avatar.js'));
    const a = createAvatar({ size: 'big', label: 'Shiori' });
    a.el.id = 'probe';
    document.body.append(a.el);
    a.setState('thinking');
    a.setLevel(0.5, 'you');
    /** @type {any} */ (window).__a = a;
  });
  const av = page.locator('#probe .av');
  await expect(av).toHaveAttribute('data-state', 'thinking');
  await expect(page.locator('#probe')).toHaveAttribute('data-glow', 'you');
  expect(await page.locator('#probe').evaluate((el) => getComputedStyle(el).getPropertyValue('--amp').trim())).toBe('0.5');
  expect(await page.locator('#probe svg [style]').count()).toBe(0);
  expect(await page.locator('#probe svg .marker').count()).toBe(1);
  await page.evaluate(() => /** @type {any} */ (window).__a.setState('away'));
  await expect(av).toHaveAttribute('data-state', 'away');
});
