import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, fakeMicrophone } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Koe and Kokoro, K2: voice through the speech pipeline (docs/superpowers/specs/2026-10-19-koe-kokoro-design.md).

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const sse = (/** @type {{ name: string, input: any }[]} */ calls) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply(calls) });
const json = (/** @type {any} */ o) => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });
const sleep = { name: 'sleep', input: {} };

test("spoken: a live question gets \"checking\" aloud, then the answer aloud; a passenger's chatter gets silence; the conversation shows heard lines and Koe's", async ({ page }) => {
  const server = await startModelServer({
    '/koe/v1/messages': [
      sse([{ name: 'speak', input: { text: "I'm checking." } }, { name: 'tell_kokoro', input: { text: 'Is Nepenthe open now?' } }, { name: 'wait', input: { seconds: 30 } }]),
      sse([{ name: 'speak', input: { text: "It's open till 10 tonight." } }, sleep]),
      sse([sleep]),
    ],
    // Kokoro takes a while: the passenger speaks meanwhile.
    '/kokoro/v1/messages': [{ ...sse([{ name: 'tell_koe', input: { text: 'Nepenthe is open till 10 tonight (nepenthe.com).' } }, sleep]), delayMs: 5000 }, sse([sleep])],
    '/d/v1/messages': sse([{ name: 'decide', input: { option: 'B' } }]),
    '/ears/audio/transcriptions': [json({ text: 'Is Nepenthe open now?' }), json({ text: 'Did you lock the car?' })],
    '/voice/audio/speech': wav,
  });
  try {
    await fakeMicrophone(page, [clipPath('where-eat'), clipPath('gas-station')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Kokoro stand-in', url: `${server.origin}/kokoro`, key: 'sk-test-kokoro', model: 'kokoro-model' });
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Koe stand-in', url: `${server.origin}/koe`, key: 'sk-test-koe', model: 'koe-model' });
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Decider', url: `${server.origin}/d`, key: 'sk-decide-test', model: 'd-model' });
    await addProvider(page, 'Custom provider', { ability: 'Transcription', name: 'Ears', url: `${server.origin}/ears`, key: 'sk-ears-test', model: 'ears' });
    await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'Voice', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'voice' });
    /** @type {[string, string][]} */
    const roles = [['main', 'kokoro-model'], ['Koe · Classic', 'koe-model'], ['decide', 'd-model'], ['speech-in', 'ears'], ['speech-out', 'voice']];
    for (const [role, model] of roles) {
      await page.getByLabel(`Add a model to ${role}`).selectOption({ label: model });
      await page.getByRole('button', { name: `Add to ${role}` }).click();
      await expect(page.getByLabel(`Add a model to ${role}`).locator('option', { hasText: model })).toHaveCount(0);
    }
    await page.goto('/#/trips');
    await page.getByLabel('Trip name').fill('Big Sur');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    await page.locator('.voice-chip').click();
    await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · Classic');
    // What the conversation's announcer says (fix pass 2, S2: the words heard, once they are in).
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      const announcer = /** @type {HTMLElement} */ (document.querySelector('main [aria-live="polite"]'));
      w.announced = [];
      new MutationObserver(() => w.announced.push(announcer.textContent)).observe(announcer, { childList: true, characterData: true, subtree: true });
    });

    await page.getByRole('button', { name: 'Shiori' }).click();
    const sign = page.getByRole('status').filter({ hasText: 'Kokoro is working' });
    await expect(sign).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => server.bodies('/voice/audio/speech').length, { timeout: 40_000 }).toBe(2);
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk', { timeout: 30_000 });
    expect(server.bodies('/voice/audio/speech').map((/** @type {any} */ b) => b.input)).toEqual(["I'm checking.", "It's open till 10 tonight."]);
    // The chatter: heard, dismissed by the quick decision, and answered by nobody.
    expect(JSON.stringify(server.bodies('/d/v1/messages')[0].messages)).toContain('Did you lock the car?');
    expect(server.bodies('/koe/v1/messages')).toHaveLength(2);
    expect(server.bodies('/kokoro/v1/messages')).toHaveLength(1);
    const kokoro = JSON.stringify(server.bodies('/kokoro/v1/messages')[0].messages);
    expect(kokoro).toContain('[heard]');
    expect(kokoro).toContain('Is Nepenthe open now?');
    expect(kokoro).toContain('[Koe said aloud]');
    // Koe's second call has Kokoro's note, and the chatter, as heard.
    const koe = JSON.stringify(server.bodies('/koe/v1/messages')[1].messages);
    expect(koe).toContain('Nepenthe is open till 10 tonight (nepenthe.com).');
    expect(koe).toContain('Did you lock the car?');
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.locator('.convo .you')).toHaveText(['Is Nepenthe open now?']);
    await expect(page.locator('.convo .system-line').filter({ hasText: 'Heard, not for Shiori' })).toHaveText('Heard, not for Shiori: Did you lock the car?');
    await expect(page.locator('.convo .shiori.said')).toHaveCount(2);
    // The halves' notes show by default (the user, 2026-10-23), as quiet lines between the bubbles.
    await expect(page.locator('.convo .halves-note')).toContainText(['Koe to Kokoro: Is Nepenthe open now?', 'Kokoro to Koe: Nepenthe is open till 10 tonight (nepenthe.com).']);
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(2);
    const announced = await page.evaluate(() => /** @type {any} */ (window).announced);
    // Each once, in whatever order the words heard are written down; never Kokoro's note, nor an empty "Shiori woke" for what was heard.
    expect(announced.filter((/** @type {string} */ t) => /Heard|Nepenthe|lock the car|Shiori/.test(t)).sort()).toEqual(['Heard, not for Shiori: Did you lock the car?', 'Heard: Is Nepenthe open now?', "Shiori: I'm checking.", "Shiori: It's open till 10 tonight."]);
    await expect(page.locator('.convo .system-line', { hasText: 'Shiori woke' })).toHaveCount(0);
  } finally {
    await server.stop();
  }
});
