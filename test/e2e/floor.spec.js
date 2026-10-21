import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, modelSetUp } from './helpers.js';

// annai's floor is iOS 16.4; the emulator pass ran Chrome 113. Both lack what came later: each test takes it away.
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('without AbortSignal.any (Chrome 113, iOS 16.4 to 17.3), Shiori reaches her model and answers', async ({ page }) => {
  await page.addInitScript(() => { delete (/** @type {any} */ (AbortSignal)).any; });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Big Sur is lovely in November.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    expect(await page.evaluate(() => typeof (/** @type {any} */ (AbortSignal)).any)).toBe('undefined');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Is Big Sur nice now?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Big Sur is lovely in November.');
  } finally {
    await llm.stop();
  }
});
