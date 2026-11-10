// Reading another trip (the timeline design, "Reading another trip"; stage 5): from a chat, Shiori reads a trip once annai's own card is
// tapped; the conversation shows a quiet line, the Trace lists the read, and Settings → Shiori holds Always. The stand-in model plays her
// part. Synthetic data only: Testville is made up.
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, startTrip, writeRecords, filterTrace, savedBy } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const NOTE = 'Ramen at the corner of 3rd and Elm.';
const SWITCH = 'Let Shiori read my other trips without asking';
/** annai's question on Testville's card, with its dates as the screens write them ("Apr 1 – 8"). */
const ASKED = /Read Testville, Apr 1\s–\s8\?/;

/**
 * Her part: a user's line asks for Testville's food note; the result she gets back is said as it is, or that it wasn't read.
 * @param {{ id: string }} testville its id, known once the trip is made
 */
const shiori = (testville) => (/** @type {any} */ body) => {
  const last = JSON.stringify(body?.messages?.at(-1) ?? {});
  if (!/"tool_result"/.test(last)) return sse(anthropicToolReply([{ name: 'read_trip', input: { trip: testville.id, path: '/notes/food.md' } }]));
  const said = last.includes(NOTE) ? NOTE : last.includes('Not now') ? "I won't read it." : 'I could not read it.';
  return sse(anthropicToolReply([{ name: 'speak', input: { text: said } }, { name: 'sleep', input: {} }]));
};

/** A new chat from home, its conversation shown, and a line typed there. @param {import('@playwright/test').Page} page @param {string} name @param {string} line */
async function askIn(page, name, line) {
  await page.goto('/#/trips');
  const id = await startTrip(page, name);
  await page.goto(`/#/trip/${id}/talk`);
  await expect(page.getByRole('heading', { level: 1, name: 'Conversation' })).toBeVisible();
  await expect(page.locator('main').getByRole('link', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(line);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  return id;
}

test('from a chat, Shiori reads Testville after a tap on annai\'s own card; the quiet line, the Trace, and Always in Settings, which asks again once it is off', async ({ page }) => {
  const testville = { id: '' };
  const server = await startModelServer({ '/b/v1/messages': shiori(testville) });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
    await page.goto('/#/trips');
    testville.id = await startTrip(page, 'Testville', { start: '2027-04-01', end: '2027-04-08' });
    await writeRecords(page, testville.id, { text: { '/notes/food.md': NOTE } });

    // A chat: annai asks, with its own card; Allow, and she reads it here.
    await askIn(page, 'Ramen crawl', 'Where was the ramen place in Testville?');
    const card = page.locator('.convo li').filter({ hasText: ASKED });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('button')).toHaveText(['Allow', 'Always for my trips', 'Not now']);
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText(NOTE, { timeout: 15_000 });
    await expect(page.locator('.convo .system-line', { hasText: 'Shiori read Testville' })).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeDisabled();

    // The Trace lists the read.
    await page.goto('/#/trace');
    await filterTrace(page, { type: 'trip.read' });
    await expect(page.locator('ol.trace > li')).toHaveCount(1);
    await expect(page.locator('ol.trace > li')).toContainText('/notes/food.md');

    // Always, from Settings → Shiori: another chat reads with no card.
    await page.goto('/#/shiori');
    await page.getByLabel(SWITCH).check();
    await expect(savedBy(page.getByLabel(SWITCH))).toHaveText('Saved');
    await askIn(page, 'Museum day', 'And the ramen place?');
    await expect(page.locator('.convo .shiori p').last()).toHaveText(NOTE, { timeout: 15_000 });
    await expect(page.locator('.convo .system-line', { hasText: 'Shiori read Testville' })).toHaveCount(1);
    await expect(page.getByText(ASKED)).toHaveCount(0);

    // Off again: a new chat asks again.
    await page.goto('/#/shiori');
    await page.getByLabel(SWITCH).uncheck();
    await expect(savedBy(page.getByLabel(SWITCH))).toHaveText('Saved');
    await askIn(page, 'Lunch', 'The ramen place again?');
    const again = page.locator('.convo li').filter({ hasText: ASKED });
    await expect(again).toBeVisible({ timeout: 15_000 });
    await again.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText("I won't read it.", { timeout: 15_000 });
    await expect(page.locator('.convo .system-line', { hasText: 'Shiori read Testville' })).toHaveCount(0);
  } finally {
    await server.stop();
  }
});
