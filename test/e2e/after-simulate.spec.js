import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };

/** Shiori's main model on a stand-in endpoint. @param {any} page @param {string} origin */
async function mainModel(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
}

test('Simulate a trip at ten times real time: the chip says so, it pauses and stops, and live mode is as it was (spec §13)', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])) });
  try {
    await mainModel(page, llm.origin);
    await page.goto('/#/settings');
    await page.getByRole('link', { name: 'Simulate a trip' }).click();
    await expect(page.getByRole('heading', { name: 'Simulate a trip' })).toBeVisible();
    await expect(page.getByLabel(/^Big Sur on Highway 1/)).toBeChecked();
    await expect(page.getByLabel('Speed')).toHaveValue('10');
    await page.getByRole('button', { name: 'Start the simulation' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur on Highway 1: Monterey to Cambria (simulation)' })).toBeVisible();
    await expect(page.locator('.sim-time')).toContainText(/Nov 27|27 Nov/);
    await expect(page.locator('.live-chip')).toHaveText(/^Simulation/);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0); // Shiori heard live mode come on
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.locator('.live-chip').click();
    await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Stop the simulation' }).click();
    await expect(page.getByText('You stopped the simulation.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Replay it' })).toBeVisible();
    await expect(page.locator('.live-chip')).toHaveText('Live off');
  } finally {
    await llm.stop();
  }
});

test('an itinerary file that is not one says so, and starts nothing', async ({ page }) => {
  await openApp(page, '#/simulate');
  await page.getByLabel('An itinerary file').check();
  await page.getByLabel('Itinerary file', { exact: true }).setInputFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from('{"name": "Nowhere", "route": []}') });
  await page.getByRole('button', { name: 'Start the simulation' }).click();
  await expect(page.getByRole('alert')).toHaveText(/^An itinerary needs a start/);
});
