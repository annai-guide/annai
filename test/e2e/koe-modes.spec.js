import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, pickProvider, savedBy, leaveSaved, startModelServer, anthropicToolReply } from './helpers.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

// Koe's two lists, Koe · Live and Koe · Chat, and the Live chip's switch (the user, 2026-11-04: "also the realtime mode on and off"). Gemini Live at the stand-in realtime server, Kokoro and Koe · Chat at a stand-in
// Anthropic server. Both browsers.

const KEY = 'AIza-e2e-koe-modes-stand-in-0123456789abcd';
const sse = (/** @type {{ name: string, input: any }[]} */ calls) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply(calls) });
const sleep = { name: 'sleep', input: {} };

/**
 * Kokoro and Koe · Chat on Custom provider, Gemini Live in Koe · Live (added by hand, so Realtime is the mode the lists
 * imply), and a trip. @param {import('@playwright/test').Page} page @param {string} models @param {string} live
 */
async function setUp(page, models, live) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Kokoro stand-in', url: `${models}/kokoro`, key: 'sk-test-kokoro', model: 'kokoro-model' });
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Koe stand-in', url: `${models}/koe`, key: 'sk-test-koe', model: 'koe-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'kokoro-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByText('1. kokoro-model')).toBeVisible();
  await page.getByLabel('Add a model to Koe · Chat').selectOption({ label: 'koe-model' });
  await page.getByRole('button', { name: 'Add to Koe · Chat' }).click();
  await expect(page.getByText('1. koe-model')).toBeVisible();
  await pickProvider(page, 'Google Gemini');
  await page.getByLabel('API key').fill(KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  const region = page.getByRole('region', { name: 'Live voice', exact: true });
  const use = region.getByLabel('Use Live voice');
  await use.check();
  await expect(savedBy(use)).toHaveText('Saved', { timeout: 30_000 });
  const address = region.getByLabel('Its own address');
  await address.fill(live);
  await leaveSaved(address);
  await page.goto('/#/models');
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await page.getByLabel('Add a model to Koe · Live').selectOption({ label: 'Gemini 3.8 Live' });
  await page.getByRole('button', { name: 'Add to Koe · Live' }).click();
  await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(1).getByText('1. Gemini 3.8 Live')).toBeVisible();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
}

test("the Live chip: one tap switches which of Koe's lists talks, kept across a reload and in koeMode's stored values; shown only with a live model; a tap with Voice off and Live on opens live; Live off, Classic's microphone", async ({ page }) => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [{ said: 'Hello.', audio: new Uint8Array(4800) }] });
  const llm = await startModelServer({ '/kokoro/v1/messages': sse([sleep]), '/koe/v1/messages': sse([{ name: 'speak', input: { text: 'Classic here.' } }, sleep]) });
  try {
    await setUp(page, llm.origin, s.origin);
    const chip = page.locator('.voice-chip');
    const live = page.locator('.koe-live-chip');
    // Live, as the lists imply (a live model in its list, nothing chosen yet), with voice off too.
    await expect(chip).toHaveText('Voice off');
    await expect(live).toHaveText('Live');
    await expect(live).toHaveAttribute('aria-pressed', 'true');
    // A tap on Shiori with voice off talks: live, for that exchange.
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(chip).toHaveText('Listening live');
    expect(s.connections().length).toBe(1);
    await page.getByRole('button', { name: 'Shiori' }).click(); // a tap while she listens closes it, and voice is off again
    await expect(chip).toHaveText('Voice off');
    // The switch, at once, and kept.
    await live.click();
    await expect(live).toHaveText('Live off');
    await expect(live).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(page.locator('.koe-live-chip')).toHaveText('Live off', { timeout: 15_000 });
    // Live off, voice off: a tap opens Classic's microphone, and no session.
    const before = s.connections().length;
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(page.locator('.talk-label')).not.toHaveText('Tap to talk');
    expect(s.connections().length).toBe(before);
    await page.getByRole('button', { name: 'Shiori' }).click();
    await page.locator('.koe-live-chip').click();
    await expect(page.locator('.koe-live-chip')).toHaveText('Live');
    // The live voice switched off on Gemini's page: no live model, no chip.
    await page.goto('/#/models');
    await page.getByRole('button', { name: 'Remove Gemini 3.8 Live from Koe · Live' }).click();
    await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(1).getByText('Empty: Koe has no live voice', { exact: false })).toBeVisible();
    await page.goto('/#/talk');
    await expect(page.locator('.koe-live-chip')).toBeHidden();
    // Voice off, typed: Koe types through its chat list; no live session opens.
    const opened = s.connections().length;
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Classic here.', { timeout: 15_000 });
    expect(s.connections().length).toBe(opened);
  } finally {
    await s.stop();
    await llm.stop();
  }
});

test("voice off with Realtime chosen and Gemini Live in its list: a typed message goes to Koe · Chat, never to a live session (a live reply would be sound nobody hears)", async ({ page }) => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [{ said: 'Hello.', audio: new Uint8Array(4800) }] });
  const llm = await startModelServer({ '/kokoro/v1/messages': sse([sleep]), '/koe/v1/messages': sse([{ name: 'speak', input: { text: 'Typed back, through Classic.' } }, sleep]) });
  try {
    await setUp(page, llm.origin, s.origin);
    await expect(page.locator('.voice-chip')).toHaveText('Voice off');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Where can we eat?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Typed back, through Classic.', { timeout: 15_000 });
    expect(s.connections().length).toBe(0);
  } finally {
    await s.stop();
    await llm.stop();
  }
});
