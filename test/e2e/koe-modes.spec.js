import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, pickProvider, savedBy, leaveSaved, startModelServer, anthropicToolReply } from './helpers.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

// Koe's two lists, Realtime and Classic, and the switch on the voice chip (the user, 2026-10-22: "Two lists + a switch",
// named "Realtime / Classic"). Gemini Live at the stand-in realtime server, Kokoro and Koe · Classic at a stand-in
// Anthropic server. Both browsers.

const KEY = 'AIza-e2e-koe-modes-stand-in-0123456789abcd';
const sse = (/** @type {{ name: string, input: any }[]} */ calls) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply(calls) });
const sleep = { name: 'sleep', input: {} };

/**
 * Kokoro and Koe · Classic on Custom provider, Gemini Live in Koe · Realtime (added by hand, so Realtime is the mode the lists
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
  await page.getByLabel('Add a model to Koe · Classic').selectOption({ label: 'koe-model' });
  await page.getByRole('button', { name: 'Add to Koe · Classic' }).click();
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
  await page.getByLabel('Add a model to Koe · Realtime').selectOption({ label: 'Gemini 3.8 Live' });
  await page.getByRole('button', { name: 'Add to Koe · Realtime' }).click();
  await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(1).getByText('1. Gemini 3.8 Live')).toBeVisible();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
}

/** The voice chip's menu, opened. @param {import('@playwright/test').Page} page */
async function menu(page) {
  await page.locator('.voice-chip').click();
  return page.locator('#voice-menu');
}

test("the voice chip says which of Koe's lists talks and switches it, kept across a reload; Realtime switched off or emptied, it says Classic stands in and why; voice off, Koe types through Classic with no live session", async ({ page }) => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [{ said: 'Hello.', audio: new Uint8Array(4800) }] });
  const llm = await startModelServer({ '/kokoro/v1/messages': sse([sleep]), '/koe/v1/messages': sse([{ name: 'speak', input: { text: 'Classic here.' } }, sleep]) });
  try {
    await setUp(page, llm.origin, s.origin);
    const chip = page.locator('.voice-chip');
    // Voice on: Realtime, as the lists imply (a realtime model in its list, nothing chosen yet).
    let m = await menu(page);
    await m.getByRole('button', { name: 'On', exact: true }).click();
    await expect(chip).toHaveText('Voice on · Realtime');
    // The switch: Classic, at once.
    m = await menu(page);
    await expect(m.getByRole('group', { name: 'Koe' }).getByRole('button', { name: 'Realtime', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await m.getByRole('group', { name: 'Koe' }).getByRole('button', { name: 'Classic', exact: true }).click();
    await expect(chip).toHaveText('Voice on · Classic');
    await page.reload();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · Classic', { timeout: 15_000 });
    m = await menu(page);
    await expect(m.getByRole('group', { name: 'Koe' }).getByRole('button', { name: 'Classic', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await m.getByRole('group', { name: 'Koe' }).getByRole('button', { name: 'Realtime', exact: true }).click();
    await expect(chip).toHaveText('Voice on · Realtime');
    // Live voice switched off on Gemini's page: Realtime can't answer, and the chip says Classic stands in.
    await page.goto('/#/models');
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    const use = page.getByRole('region', { name: 'Live voice', exact: true }).getByLabel('Use Live voice');
    await use.uncheck();
    await expect(savedBy(use)).toHaveText('Saved', { timeout: 30_000 });
    await page.goto('/#/talk');
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · Classic (Realtime off)');
    // The reason stays on one line: a narrow phone wraps before it.
    await expect(page.locator('.voice-chip .voice-chip-why')).toHaveCSS('white-space', 'nowrap');
    m = await menu(page);
    await expect(m.getByText("Realtime's live voice is switched off, or its plugin isn't running. Classic talks meanwhile.")).toBeVisible();
    await expect(m.getByRole('group', { name: 'Koe' }).getByRole('button', { name: 'Realtime', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    // Classic emptied too: Koe is down and Kokoro answers directly, which the chip says; never "Classic".
    await page.goto('/#/models');
    await page.getByRole('button', { name: 'Remove koe-model from Koe · Classic' }).click();
    await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(2).getByText('Empty: in Classic', { exact: false })).toBeVisible();
    await page.goto('/#/talk');
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · Realtime off');
    m = await menu(page);
    await expect(m.getByText('Shiori answers directly until it can.')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/#/models');
    await page.getByLabel('Add a model to Koe · Classic').selectOption({ label: 'koe-model' });
    await page.getByRole('button', { name: 'Add to Koe · Classic' }).click();
    await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(2).getByText('1. koe-model')).toBeVisible();
    // Realtime's list emptied in Settings → Models: it has no model.
    await page.getByRole('button', { name: 'Remove Gemini 3.8 Live from Koe · Realtime' }).click();
    await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(1).getByText('Empty: Koe has no realtime voice', { exact: false })).toBeVisible();
    await page.goto('/#/talk');
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · Classic (no Realtime model)');
    // Voice off: the chip says only the voice, as before, and Koe types through Classic; no live session opens.
    m = await menu(page);
    await m.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Voice off');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Classic here.', { timeout: 15_000 });
    expect(llm.bodies('/koe/v1/messages').length).toBe(1);
    expect(s.connections().length).toBe(0);
  } finally {
    await s.stop();
    await llm.stop();
  }
});

test("voice off with Realtime chosen and Gemini Live in its list: a typed message goes to Koe · Classic, never to a live session (a live reply would be sound nobody hears)", async ({ page }) => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [{ said: 'Hello.', audio: new Uint8Array(4800) }] });
  const llm = await startModelServer({ '/kokoro/v1/messages': sse([sleep]), '/koe/v1/messages': sse([{ name: 'speak', input: { text: 'Typed back, through Classic.' } }, sleep]) });
  try {
    await setUp(page, llm.origin, s.origin);
    const m = await menu(page);
    await m.getByRole('button', { name: 'Off', exact: true }).click();
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
