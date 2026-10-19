import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };

/** Shiori's main model on a stand-in endpoint. @param {any} page @param {string} origin */
async function mainModel(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  // The role's list is drawn again once a model joins it: wait for that before anything else on the screen.
  await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
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

const RECAP = '# Big Sur on Highway 1\n\n## Friday, November 27\n\nFrom Monterey down the coast: Bixby Bridge, lunch at Nepenthe, McWay Falls, and the castle at San Simeon.\n\n## Highlights\n\n- Lunch at Nepenthe';

test('the Big Sur trip, simulated through the app, is replayed and recapped, and its card has its stamps (spec §20, milestone 7)', async ({ page }) => {
  test.setTimeout(300_000);
  const card = { title: 'Highway 1 today', text: 'Fog until ten, then sun all the way to Cambria.' };
  const llm = await startModelServer({
    '/b/v1/messages': [sse(anthropicToolReply([{ name: 'show', input: { card } }, sleep])), sse(anthropicToolReply([sleep]))],
    '/u/v1/messages': sse(anthropicToolReply([], RECAP)),
  });
  try {
    await mainModel(page, llm.origin);
    await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Writer', url: `${llm.origin}/u`, key: 'sk-test-u', model: 'u-model' });
    await page.getByLabel('Add a model to utility').selectOption({ label: 'u-model' });
    await page.getByRole('button', { name: 'Add to utility' }).click();
    await expect(page.getByLabel('Add a model to utility').locator('option', { hasText: 'u-model' })).toHaveCount(0);
    await page.goto('/#/simulate');
    await page.getByLabel('Speed').selectOption('fast');
    await page.getByRole('button', { name: 'Start the simulation' }).click();
    await expect(page.getByText('The simulation has ended.')).toBeVisible({ timeout: 240_000 });

    // Replay: the timeline, the route and the stamps.
    await page.getByRole('link', { name: 'Replay it' }).click();
    await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible();
    const timeline = page.getByRole('list', { name: 'Timeline' });
    for (const place of ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']) await expect(timeline).toContainText(`${place} · `);
    await expect(timeline).toContainText('Shiori: Highway 1 today');
    await expect(timeline).toContainText('partly unseen: the phone was locked');
    await expect(page.getByRole('img', { name: '5 stamps: Bixby Creek Bridge, Nepenthe, McWay Falls, Hearst Castle, Cambria Pines Lodge' }).first()).toBeVisible();
    await expect(page.getByRole('img', { name: /^The route: \d+\.\d km on the road, from Bixby Creek Bridge to Cambria Pines Lodge, with \d+ stops and 5 stamps\.$/ })).toBeVisible();
    // The sample's road is straight between its route points, so thinning keeps their corners: a dozen or so, not thousands.
    expect((await page.locator('svg.route-map polyline.route-all').first().getAttribute('points'))?.split(' ').length).toBeGreaterThan(10);
    await expect(page.locator('svg.route-map polyline.route-all')).toHaveCount(2); // the phone was locked once
    await page.getByLabel('Time in the trip').fill(String(Date.parse('2026-11-27T12:30:00-08:00')));
    await expect(page.locator('.replay-where')).toHaveText('At Nepenthe');
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.replay-where')).not.toHaveText('At Nepenthe', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Pause' }).click();

    // Recap: by the utility model, from the trip in words.
    await page.goto('/#/simulate');
    await page.getByRole('link', { name: 'Recap it' }).click();
    await page.getByRole('button', { name: 'Write the recap' }).click();
    await expect(page.locator('.recap-text')).toContainText('lunch at Nepenthe', { timeout: 20_000 });
    const sent = JSON.stringify(llm.bodies('/u/v1/messages').at(-1));
    expect(sent).toContain('stayed\\tNepenthe');
    expect(sent).toMatch(/worked out from \d{4} location points/);
    expect(sent.length).toBeLessThan(40_000);

    // The trip card.
    await page.goto('/#/trips');
    await expect(page.getByRole('link', { name: /\(simulation\)/ })).toContainText('5 stamps');
  } finally {
    await llm.stop();
  }
});
