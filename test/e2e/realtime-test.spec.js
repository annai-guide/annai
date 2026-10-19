import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider, savedBy, leaveSaved, filterTrace } from './helpers.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

// Gemini Live through its protocol plugin (the Koe and Kokoro plan, K4), against the stand-in realtime server on a
// port of its own: the security policy must let the page open ws://127.0.0.1, and the key must stay out of the Trace.

const KEY = 'AIza-e2e-live-stand-in-0123456789abcdef';
/** 0.6 s of a voice-like tone, as 24 kHz 16-bit PCM bytes. */
const voice = () => new Uint8Array(Int16Array.from({ length: 14_400 }, (_, i) => Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 24_000) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / 24_000)))).buffer);
const usage = { promptTokenCount: 600, responseTokenCount: 30, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 600 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 30 }] };

test("Gemini's Live voice: switched on, gemini-live installs; Test opens a session that answers aloud; the Trace shows the session, never the key", async ({ page }) => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [{ heard: '', said: 'OK.', audio: voice(), usage }] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'Google Gemini');
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    const live = page.getByRole('region', { name: 'Live voice', exact: true });
    await expect(live.getByText(/what you say goes to Google as audio/)).toBeVisible();
    const use = live.getByLabel('Use Live voice');
    await expect(use).not.toBeChecked();
    await use.check();
    await expect(savedBy(use)).toHaveText('Saved', { timeout: 30_000 }); // gemini-live, installed first
    const address = live.getByLabel('Its own address');
    await address.fill(s.origin);
    await leaveSaved(address);
    await expect(live.getByRole('link', { name: /^Gemini 3\.8 Live\b/ }).first()).toBeVisible();
    await live.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(live.getByText('It answered aloud: OK.')).toBeVisible({ timeout: 30_000 });
    await expect(live.getByText('It works.')).toBeVisible();
    const [c] = s.connections();
    expect(c.key, 'the key went to the stand-in, in the address').toBe(KEY);
    expect(c.version).toBe('v1alpha');
    expect(s.received()[0].setup.model, 'the first of its models').toMatch(/^models\/gemini-3\.8-live/);
    expect(s.received()[1].clientContent.turns[0].parts[0].text).toBe('Say OK.');
    // Trace → Models: the session opened, was ready and closed, and its turn was priced; no key anywhere.
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Models', type: 'live.session' });
    await expect(page.getByText(/live session closed · Gemini 3\.8 Live/).first()).toBeVisible();
    await expect(page.getByText(/live session ready · Gemini 3\.8 Live/).first()).toBeVisible();
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await s.stop();
  }
});
