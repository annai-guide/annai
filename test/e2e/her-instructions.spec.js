import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, writeRecords } from './helpers.js';

// "I kinda want to check kokoro and koe's prompt template. maybe should also be viewable and adjustable by user?" and "is there way to see kokoro's transcript?" (the user, 2026-11-04).
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('Settings → Shiori: her instructions show annai\'s text, Save makes them the user\'s, Reset to original brings annai\'s back, and they reach her next request', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Hello.' } }, { name: 'sleep', input: {} }])), sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/shiori');
    const panel = page.getByRole('region', { name: 'Her instructions' });
    await expect(panel.getByText('These hold how Shiori works, including her safety rules.')).toBeVisible();
    const core = panel.locator('details[data-instructions="shiori"]');
    await core.locator('summary').click();
    const area = core.getByLabel("Shiori's core", { exact: true });
    await expect(area).toHaveValue(/^You are Shiori, the guide inside annai/);
    await expect(core.getByRole('button', { name: "Reset to original: Shiori's core" })).toBeHidden();
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
    await area.fill('You are Shiori. These are the words I chose.');
    await core.getByRole('button', { name: "Save: Shiori's core" }).click();
    await expect(page.getByText('Saved. It applies at her next wake.')).toBeVisible();
    await expect(core.getByText('changed', { exact: true })).toBeVisible();
    // They reach her next request.
    await page.goto('/#/talk');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Hi');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p')).toHaveCount(1, { timeout: 20_000 });
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[0].system)).toContain('These are the words I chose.');
    // A reload keeps them; Reset brings annai's back.
    await page.goto('/#/shiori');
    await page.reload();
    const again = page.locator('details[data-instructions="shiori"]');
    await again.locator('summary').click();
    await expect(again.getByLabel("Shiori's core", { exact: true })).toHaveValue('You are Shiori. These are the words I chose.');
    await again.getByRole('button', { name: "Reset to original: Shiori's core" }).click();
    await expect(page.getByText('Back to the original. It applies at her next wake.')).toBeVisible();
    await expect(again.getByLabel("Shiori's core", { exact: true })).toHaveValue(/^You are Shiori, the guide inside annai/);
    await expect(again.getByRole('button', { name: "Reset to original: Shiori's core" })).toBeHidden();
  } finally {
    await llm.stop();
  }
});

test("the Conversation's ⋯ opens what each half sees: its instructions and its conversation, with Copy, and no sideways scroll on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Pelicans nest on the cliffs.' } }, { name: 'sleep', input: {} }]))] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await page.getByLabel('Trip name').fill('Test coast');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await expect(page.getByRole('heading', { name: 'Test coast' })).toBeVisible();
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Tell me about pelicans');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p')).toHaveCount(1, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    // One full-width link of 44 px, 15 px text, and nothing else added to the menu.
    const link = page.getByRole('link', { name: 'What each half sees' });
    const menu = page.getByRole('group', { name: 'Conversation menu' });
    const [box, size] = [/** @type {any} */ (await link.boundingBox()), await link.evaluate((el) => getComputedStyle(el).fontSize)];
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(size).toBe('15px');
    expect(box.width).toBeGreaterThan(/** @type {any} */ ((await menu.boundingBox())).width - 30);
    // Turned sideways with it open, and opened again there: the menu is the screen's height at most (CSS only), and the link is reachable.
    const toggle = page.getByRole('button', { name: 'Conversation menu', exact: true });
    const height = async () => /** @type {any} */ ((await menu.boundingBox())).height;
    for (const size of [{ width: 844, height: 390 }, { width: 320, height: 568 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); // as a finger brings the title up under the bar (a page with room to scroll)
      const dock = /** @type {any} */ (await page.locator('.dock:not(.seat)').boundingBox()).height; // the dock is over the page's bottom: the menu stops above it
      const most = size.height - 56 - 64 - dock; // the screen less the bar (56 px), the room the title and its ⋯ take, and the dock
      await expect.poll(height, { message: `open, ${size.width}x${size.height}` }).toBeLessThanOrEqual(most + 1);
      await toggle.click();
      await toggle.click();
      await expect.poll(height, { message: `opened again, ${size.width}x${size.height}` }).toBeLessThanOrEqual(most + 1);
      expect(await height()).toBeGreaterThan(Math.min(200, most - 1)); // never the 120 px box: all the room there is, up to its content
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport({ ratio: 1 });
    }
    await link.click();
    await expect(page.getByRole('heading', { level: 1, name: 'What Kokoro sees' })).toBeVisible();
    await expect(page.getByText('Shiori is one half right now')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Its instructions' })).toContainText('You are Shiori, the guide inside annai');
    const talk = page.getByRole('region', { name: 'Its conversation' });
    await expect(talk).toContainText('Tell me about pelicans');
    // The instructions and the tools are folded, so the conversation is near the top; they open, and Copy takes everything.
    await expect(page.locator('section[aria-label="Its instructions"] details')).toHaveJSProperty('open', false);
    await expect(page.locator('section[aria-label="Its tools"] details')).toHaveJSProperty('open', false);
    expect(/** @type {any} */ ((await talk.boundingBox())).y).toBeLessThan(844); // in the first screenful, where it was about 4,000 px down
    await page.getByText('Its instructions', { exact: true }).click();
    await expect(page.getByText('You are Shiori, the guide inside annai').first()).toBeVisible();
    await expect(talk).toContainText('[it calls] speak');
    await expect(page.getByRole('region', { name: 'The block that ends the request' })).toContainText('<now>');
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText(/^Copied\.|^Copying didn't work here/)).toBeVisible();
    // The screen has a Kokoro | Koe switch; the route stands alone, and Koe with no model says so.
    const switcher = page.getByRole('group', { name: 'Which half' });
    await expect(switcher.getByRole('link', { name: 'Kokoro' })).toHaveAttribute('aria-current', 'page');
    await switcher.getByRole('link', { name: 'Koe', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'What Koe sees' })).toBeVisible();
    await expect(page.getByText("Koe isn't in use")).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test("a new original of a text the user changed opens its fold and says so in its summary, so a stale text never hides after an update", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, '#/shiori');
  // A file with no record of the text it was based on is one annai's text has changed under.
  await writeRecords(page, 'me', { text: { '/instructions/koe.md': 'My Koe words.' } });
  await page.reload();
  const koe = page.locator('details[data-instructions="koe"]');
  await expect(koe).toHaveJSProperty('open', true);
  await expect(koe.locator('summary')).toContainText('annai has a new original');
  await expect(koe.getByRole('button', { name: 'Use the new original: Koe, chat' })).toBeVisible();
  // The others stay folded.
  await expect(page.locator('details[data-instructions="shiori"]')).toHaveJSProperty('open', false);
  // Merging by hand beside the new original, then Keep mine: the typing stays in the box (unsaved, as it was).
  await koe.locator('textarea').fill('My Koe words, with a line from the new original.');
  await koe.getByRole('button', { name: 'Keep mine: Koe, chat' }).click();
  await expect(koe.locator('summary')).not.toContainText('new original');
  await expect(koe.locator('textarea')).toHaveValue('My Koe words, with a line from the new original.');
  await expect(koe.locator('summary')).toContainText('changed');
});
