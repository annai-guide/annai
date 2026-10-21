import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider, startTrip, pastWelcome, savedBy } from './helpers.js';
import { startGeminiServer } from '../fakes/gemini-server.js';

// Google keeps the conversation (G2), against the stand-in Gemini server: the switch and its note, Shiori's next turn sent
// after the one Google kept, deletions waiting offline and sent on coming online, the words before a removal, and Erase.

const KEY = 'AIza-e2e-gemini-kept-0123456789abcdef';
/** Shiori's answer to each turn: she says it, then sleeps, so each message is one request. @type {any} */
const SAY = (/** @type {any} */ b) => ({ calls: [{ name: 'speak', input: { text: `Answer ${b.input.length}.` }, signature: 'CS' }, { name: 'sleep', input: {} }] });

/** Google Gemini at the stand-in's address, with its recommended models, then a trip. @param {import('@playwright/test').Page} page @param {string} url */
async function geminiTrip(page, url, trip = 'Kyoto') {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'Google Gemini');
  await page.getByLabel('Address', { exact: true }).fill(url);
  await page.getByLabel('API key').fill(KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  await page.goto('/#/trips');
  return startTrip(page, trip);
}

/** Types to Shiori and waits for her answer. @param {import('@playwright/test').Page} page @param {string} text @param {number} n her answers so far, after this one */
async function say(page, text, n) {
  await page.getByLabel('Message to Shiori').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.convo .shiori')).toHaveCount(n, { timeout: 30_000 });
}

test("Google keeps the conversation: the switch and its note; Shiori's next turn sends only what is new; offline, a removed trip's deletions wait, named on the provider's page, and go on coming online", async ({ page }) => {
  const s = await startGeminiServer({ key: KEY, replies: [SAY] });
  try {
    const trip = await geminiTrip(page, s.url);
    await page.getByRole('button', { name: 'Type' }).click();
    await say(page, 'Where can we eat near the station?', 1);
    await say(page, 'Is it open now?', 2);
    const kept = s.bodies().filter((b) => b.store);
    expect(kept.length).toBe(2);
    expect(kept[0].previous_interaction_id).toBeUndefined();
    expect(kept[1].previous_interaction_id).toBeTruthy();
    expect(JSON.stringify(kept[1].input)).toContain('Is it open now?');
    expect(JSON.stringify(kept[1].input), 'Google has the first turn already').not.toContain('near the station');
    expect(s.bodies().filter((b) => !b.store).every((b) => !b.previous_interaction_id)).toBe(true);

    // The provider's page: the switch, on, and what it means.
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    const chat = page.getByRole('region', { name: 'Chat', exact: true });
    await expect(chat.getByLabel('Let Google keep the conversation between turns: sends less each time.')).toBeChecked();
    await expect(chat.getByText(/Google keeps your conversations with Shiori, with their photos, voice messages and where you are as she knows it: a day on a free key, up to 55 days on a paid one/)).toBeVisible();
    await expect(chat.getByText(/annai deletes them when you remove their trip, this provider or everything \(Erase\), change or remove its key, or turn this off/)).toBeVisible();
    await expect(page.getByText(/^With a new key or address, or Remove key, annai first asks Google to delete the 2 turns/)).toBeVisible();
    await expect(page.getByText(/^First, annai asks Google to delete the 2 turns of your conversations it keeps/)).toBeVisible();

    // Offline, the trip is removed: its deletions wait.
    await page.context().setOffline(true);
    await page.evaluate((id) => { location.hash = `#/trip/${encodeURIComponent(id)}`; }, trip);
    await page.getByRole('button', { name: 'Remove trip' }).click();
    await expect(page.getByRole('dialog', { name: 'Kyoto' })).toContainText("Google keeps 2 turns of its conversations: annai asks for them to be deleted, once you're back online.");
    await page.getByRole('dialog', { name: 'Kyoto' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    await expect(chat.getByText('2 deletions waiting: annai sends them when it can reach Google.')).toBeVisible();
    await expect(page.getByText('Google keeps 2 turns until they expire, up to 55 days.')).toBeVisible();
    await expect(page.getByText('Offline, a new key or address, or Remove key, leaves Google the 2 turns it keeps until they expire, up to 55 days.')).toBeVisible();
    expect(s.deleted()).toEqual([]);

    // Back online: they go.
    await page.context().setOffline(false);
    await expect.poll(() => s.deleted().length, { timeout: 15_000 }).toBe(2);
    expect(s.stored()).toEqual([]);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    await expect(chat.getByText(/deletions? waiting/)).toHaveCount(0);
    for (const r of s.requests()) expect(r.url.includes(KEY), r.url).toBe(false);
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await s.close();
  }
});

test("Erase names what Google keeps before the tap, and asks Google to delete it before anything goes", async ({ page }) => {
  const s = await startGeminiServer({ key: KEY, replies: [SAY] });
  try {
    await geminiTrip(page, s.url);
    await page.getByRole('button', { name: 'Type' }).click();
    await say(page, 'Hello!', 1);
    expect(s.stored().length).toBe(1);
    await page.goto('/#/settings');
    const erase = page.getByRole('region', { name: 'Erase' });
    await expect(erase.getByText("First, annai asks Google to delete the 1 turn of your conversations it keeps; any it can't in 10 seconds, Google keeps until it expires, up to 55 days.")).toBeVisible();
    await erase.getByLabel('Type ERASE to confirm').fill('ERASE');
    await erase.getByRole('button', { name: 'Erase now' }).click();
    await pastWelcome(page);
    await expect(page.getByText('No trips yet.')).toBeVisible();
    // Nothing of annai is left to say which: Google's copy went before the reload.
    expect(s.stored()).toEqual([]);
    expect(s.deleted().length).toBe(1);
  } finally {
    await s.close();
  }
});

test('turning the switch off deletes what Google keeps, and later turns are sent whole, kept nowhere', async ({ page }) => {
  const s = await startGeminiServer({ key: KEY, replies: [SAY] });
  try {
    await geminiTrip(page, s.url);
    await page.getByRole('button', { name: 'Type' }).click();
    await say(page, 'Where is the station?', 1);
    expect(s.stored().length).toBe(1);
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    const keep = page.getByRole('region', { name: 'Chat', exact: true }).getByLabel('Let Google keep the conversation between turns: sends less each time.');
    await keep.uncheck();
    await expect(savedBy(keep)).toHaveText('Saved');
    await expect.poll(() => s.deleted().length, { timeout: 15_000 }).toBe(1);
    expect(s.stored()).toEqual([]);
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Conversation' })).toBeVisible();
    await page.getByRole('button', { name: 'Type' }).click();
    await say(page, 'And the bus stop?', 2);
    const last = s.bodies().at(-1);
    expect([last.store, last.previous_interaction_id]).toEqual([false, undefined]);
    expect(JSON.stringify(last.input)).toContain('Where is the station?');
  } finally {
    await s.close();
  }
});

test("Erase while Shiori is answering: her turn stops first, so it leaves nothing on Google's side", async ({ page }) => {
  const long = (/** @type {any} */ b) => JSON.stringify(b.input).includes('a long answer');
  const s = await startGeminiServer({ key: KEY, replies: [(/** @type {any} */ b) => ({ ...SAY(b), ...(long(b) ? { delayMs: 4000 } : {}) })] });
  try {
    await geminiTrip(page, s.url);
    await page.getByRole('button', { name: 'Type' }).click();
    await say(page, 'Hello!', 1);
    await page.getByLabel('Message to Shiori').fill('And now a long answer, please.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => s.bodies().some(long)).toBe(true); // Google has named her turn, and is still answering
    await page.getByRole('link', { name: 'Settings' }).click();
    const erase = page.getByRole('region', { name: 'Erase' });
    await erase.getByLabel('Type ERASE to confirm').fill('ERASE');
    await erase.getByRole('button', { name: 'Erase now' }).click();
    await pastWelcome(page);
    await page.waitForTimeout(4500); // past the answer's end, had it gone on
    expect(s.stored()).toEqual([]);
  } finally {
    await s.close();
  }
});

test('Remove key: what Google keeps is deleted first, with that key, before it goes', async ({ page }) => {
  const s = await startGeminiServer({ key: KEY, replies: [SAY] });
  try {
    await geminiTrip(page, s.url);
    await page.getByRole('button', { name: 'Type' }).click();
    await say(page, 'Where is the station?', 1);
    expect(s.stored().length).toBe(1);
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove key' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', 'not set');
    expect(s.stored()).toEqual([]);
    const deleted = s.requests().filter((r) => r.method === 'DELETE');
    expect(deleted.map((r) => r.headers['x-goog-api-key'])).toEqual([KEY]);
  } finally {
    await s.close();
  }
});

