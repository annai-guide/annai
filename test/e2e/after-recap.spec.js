import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, startTrip, watchConsole } from './helpers.js';
import { seedMorning } from './after-kit.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };
const RECAP = '# A morning on Highway 1\n\n## Friday, November 27\n\nThe fog lifted over **Bixby Creek Bridge**. [More](javascript:alert(1)) <img src=x onerror="window.__pwned=1">';

/** Shiori's main model and a utility model, each on a stand-in Anthropic endpoint. @param {any} page @param {string} origin */
async function models(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Writer', url: `${origin}/u`, key: 'sk-test-u', model: 'u-model' });
  // Each role's list is drawn again once a model joins it: wait for that before the next.
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
  await page.getByLabel('Add a model to utility').selectOption({ label: 'u-model' });
  await page.getByRole('button', { name: 'Add to utility' }).click();
  await expect(page.getByLabel('Add a model to utility').locator('option', { hasText: 'u-model' })).toHaveCount(0);
}

test('the recap: written by the utility model from the trip in words, shown safely, told by Shiori (spec §13)', async ({ page }) => {
  const errors = watchConsole(page);
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])), '/u/v1/messages': sse(anthropicToolReply([], RECAP)) });
  try {
    await models(page, llm.origin);
    // Another address's look at each address is answered 404 and 400 by design, which a browser logs as failed loads.
    errors.splice(0, errors.length, ...errors.filter((e) => !/^Failed to load resource: the server responded with a status of 40[045] /.test(e)));
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    await seedMorning(page, trip);
    await page.getByRole('link', { name: 'Recap' }).click();
    await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
    await expect(page.getByText('No recap yet.')).toBeVisible();
    await expect(page.getByText(/^What goes to u-model/)).toBeVisible();
    await page.getByRole('button', { name: 'Write the recap' }).click();
    const text = page.locator('.recap-text');
    await expect(text).toContainText('The fog lifted over Bixby Creek Bridge.', { timeout: 20_000 });
    await expect(text.locator('strong')).toHaveText('Bixby Creek Bridge');
    await expect(text.locator('a')).toHaveCount(0); // a javascript: link stays text
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
    const sent = JSON.stringify(llm.bodies('/u/v1/messages')[0]);
    expect(sent).toContain('stayed\\tBixby Creek Bridge\\t\\tyes');
    expect(sent).toContain('Sam wants to see the sea lions.');
    expect(sent).toContain('/trip/files/2026-11-27-0945.jpg'); // listed
    expect(sent).not.toContain('"type":"image"'); // not sent: this model takes no photos (7a choice 4)
    expect((sent.match(/-121\.\d{3,}/g) ?? []).length).toBeLessThanOrEqual(2); // never the track itself
    await page.getByRole('button', { name: 'Hear Shiori tell it' }).click();
    await expect.poll(() => JSON.stringify(llm.bodies('/b/v1/messages').at(-1) ?? '')).toContain("asked to hear the trip's recap");
    await expect(page.getByRole('button', { name: 'Write it again' })).toBeVisible();
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: '/recap.md' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test("a recap that can't be written says why and what to do; with no model the button waits for one", async ({ page }) => {
  const refused = { status: 401, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) };
  const llm = await startModelServer({ '/b/v1/messages': refused, '/u/v1/messages': refused });
  try {
    await openApp(page);
    const bare = await startTrip(page, 'No models yet');
    await page.goto(`/#/trip/${encodeURIComponent(bare)}/recap`);
    await expect(page.getByRole('button', { name: 'Write the recap' })).toBeDisabled();
    await expect(page.getByText('No model is set up to write it yet.')).toBeVisible();
    await models(page, llm.origin);
    await page.goto(`/#/trip/${encodeURIComponent(bare)}/recap`);
    await page.getByRole('button', { name: 'Write the recap' }).click();
    await expect(page.locator('.notice', { hasText: "The recap wasn't written" })).toContainText('Check Settings → Models, then try again.');
    await expect(page.getByRole('button', { name: 'Write the recap' })).toBeEnabled();
  } finally {
    await llm.stop();
  }
});

test('a recap being written is remembered when the screen is drawn again, so it is written once; leaving the screen stops it', async ({ page }) => {
  const slow = { ...sse(anthropicToolReply([], RECAP)), delayMs: 3000 };
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])), '/u/v1/messages': slow });
  try {
    await models(page, llm.origin);
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    await seedMorning(page, trip);
    await page.goto(`/#/trip/${encodeURIComponent(trip)}/recap`);
    await page.getByRole('button', { name: 'Write the recap' }).click();
    await expect.poll(() => llm.bodies('/u/v1/messages').length).toBe(1);
    await page.evaluate(() => dispatchEvent(new HashChangeEvent('hashchange'))); // the screen is drawn again
    await expect(page.getByRole('button', { name: 'Write the recap' })).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Writing it' })).toBeVisible();
    await expect(page.locator('.recap-text')).toContainText('The fog lifted over Bixby Creek Bridge.', { timeout: 20_000 });
    expect(llm.bodies('/u/v1/messages').length).toBe(1);
    // Write it again, then leave: it stops, and the recap stays as it was.
    await page.getByRole('button', { name: 'Write it again' }).click();
    await expect.poll(() => llm.bodies('/u/v1/messages').length).toBe(2);
    await page.goto('/#/trips');
    await page.waitForTimeout(4000); // the model's answer came meanwhile, to a request that was stopped
    await page.goto(`/#/trip/${encodeURIComponent(trip)}/recap`);
    await expect(page.getByRole('button', { name: 'Write it again' })).toBeEnabled();
    const versions = await page.evaluate(async (id) => {
      const load = (/** @type {string} */ url) => import(url);
      const { createIdbStore } = await load('/src/core/store-idb.js');
      const { Workspace } = await load('/src/core/workspace.js');
      const store = await createIdbStore();
      const n = (await new Workspace(store).history(id, '/recap.md')).length;
      store.close();
      return n;
    }, trip);
    expect(versions).toBe(1);
  } finally {
    await llm.stop();
  }
});
