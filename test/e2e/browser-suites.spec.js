import { test, expect } from '@playwright/test';

for (const suite of ['store-idb', 'platform', 'photo-codec', 'voice', 'audio-codecs', 'ui-slots', 'live-player']) {
  test(`browser suite: ${suite}`, async ({ page }) => {
    await page.goto(`/test/browser/index.html?suite=${suite}`);
    const handle = await page.waitForFunction(() => /** @type {any} */ (window).__results, null, { timeout: 120_000 });
    /** @type {{ name: string, ok: boolean, error?: string }[]} */
    const results = await handle.jsonValue();
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}\n${f.error}`).join('\n\n')).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(4);
  });
}
