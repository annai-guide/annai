import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, fakeMicrophone } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
/** The stand-in voice's clip: a 0.3 s tone. */
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
/** @param {import('@playwright/test').Page} page @param {string} heading */
const roleItems = (page, heading) => page.locator('.role', { has: page.getByRole('heading', { name: heading }) }).locator('.role-item > span');

test("a voice in the speech-out list: added, put first, and its Test plays a sample (spec §9.6, §10.1)", async ({ page }) => {
  const speech = await startModelServer({ '/v1/audio/speech': wav });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Stand-in voice', url: `${speech.origin}/v1`, key: 'sk-voice-test', model: 'tts-test' });
    await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(["1. Browser voice (the browser's own; some voices go online)"]);
    await expect(roleItems(page, 'Speech in: how Shiori hears you')).toHaveText(['1. Send audio to the model (when the model takes audio)', "2. Phone dictation (the phone's own; usually goes to Google or Apple)"]);
    await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'tts-test' })).toHaveCount(0);
    await page.getByLabel('Add a model to speech-out').selectOption({ label: 'tts-test' });
    await page.getByRole('button', { name: 'Add to speech-out' }).click();
    // A voice goes ahead of the browser voice, which stays last.
    await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(['1. tts-test', "2. Browser voice (the browser's own; some voices go online)"]);
    await page.getByRole('link', { name: /Stand-in voice/ }).click();
    await page.getByRole('link', { name: /^tts-test/ }).click();
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByText('It works: that was this voice.')).toBeVisible();
    const [body] = speech.bodies('/v1/audio/speech');
    expect(body).toMatchObject({ model: 'tts-test', voice: 'marin', response_format: 'mp3' });
    expect(body.input).toContain('This is how I sound');
    expect(JSON.stringify(await page.content())).not.toContain('sk-voice-test');
  } finally {
    await speech.stop();
  }
});

test("a transcription model's Test: you say something and it writes it down (spec §10.2)", async ({ page }) => {
  const asr = await startModelServer({ '/v1/audio/transcriptions': { status: 200, type: 'application/json', body: JSON.stringify({ text: 'Where should we stop for lunch?' }) } });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Stand-in ears', url: `${asr.origin}/v1`, key: 'sk-asr-test', model: 'asr-test' });
    await page.getByRole('link', { name: /Stand-in ears/ }).click();
    await page.getByRole('link', { name: /^asr-test/ }).click();
    await page.getByRole('button', { name: 'Say something' }).click();
    await expect(page.getByText('It heard: "Where should we stop for lunch?"')).toBeVisible({ timeout: 20_000 });
    const [body] = asr.bodies('/v1/audio/transcriptions');
    const raw = Buffer.from(body).toString('latin1');
    expect(raw).toContain('name="model"');
    expect(raw).toContain('asr-test');
    expect(raw).toContain('RIFF');
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(1);
  } finally {
    await asr.stop();
  }
});

test('Settings → Voice: a voice that fails gives its sentence to the next one; the microphone test writes down what it heard', async ({ page }) => {
  const server = await startModelServer({
    '/bad/audio/speech': { status: 500, type: 'application/json', body: JSON.stringify({ error: { message: 'Voice server down' } }) },
    '/good/audio/speech': wav,
    '/ears/audio/transcriptions': { status: 200, type: 'application/json', body: JSON.stringify({ text: 'Is there a gas station nearby?' }) },
  });
  try {
    await fakeMicrophone(page, [clipPath('gas-station')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice A', url: `${server.origin}/bad`, key: 'sk-a-test', model: 'voice-a' });
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice B', url: `${server.origin}/good`, key: 'sk-b-test', model: 'voice-b' });
    await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Ears', url: `${server.origin}/ears`, key: 'sk-e-test', model: 'ears' });
    for (const m of ['voice-a', 'voice-b']) {
      await page.getByLabel('Add a model to speech-out').selectOption({ label: m });
      await page.getByRole('button', { name: 'Add to speech-out' }).click();
      // The screen is drawn again: once the voice has left the picker, the next choice is safe.
      await expect(page.getByLabel('Add a model to speech-out').locator('option', { hasText: m })).toHaveCount(0);
    }
    await page.getByLabel('Add a model to speech-in').selectOption({ label: 'ears' });
    await page.getByRole('button', { name: 'Add to speech-in' }).click();
    await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(['1. voice-a', '2. voice-b', "3. Browser voice (the browser's own; some voices go online)"]);
    await page.goto('/#/settings');
    await page.getByRole('link', { name: 'Voice', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible();
    await expect(page.getByText('Voices, tried in order: voice-a, voice-b, Browser voice.')).toBeVisible();
    await page.getByRole('button', { name: 'Test the voice' }).click();
    await expect(page.getByText('Spoken by voice-b.')).toBeVisible({ timeout: 20_000 });
    expect(server.bodies('/bad/audio/speech')).toHaveLength(1);
    expect(server.bodies('/good/audio/speech')).toHaveLength(2);
    await page.getByLabel('Pause that ends a sentence (ms)').fill('900');
    await page.getByRole('button', { name: 'Save the pause' }).click();
    await page.getByRole('button', { name: 'Test the microphone' }).click();
    await expect(page.getByText(/ears heard: "Is there a gas station nearby\?"/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Heard \d\.\d seconds of speech\./)).toBeVisible();
    await page.goto('/#/trace');
    await page.getByLabel('Kind').selectOption('Web');
    await expect(page.locator('.trace li').filter({ hasText: 'voice-a' }).first()).toBeVisible();
  } finally {
    await server.stop();
  }
});

test('Settings → Voice says where your voice goes: each speech-in entry, phone dictation included, and her voice (spec §11.7)', async ({ page }) => {
  // A dictation like Chrome's or Safari's, with no on-device recognition: the browser's own service hears it.
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.SpeechRecognition = w.webkitSpeechRecognition = class { start() {} abort() {} };
  });
  await openApp(page, '#/voice');
  const where = page.getByRole('region', { name: 'Where your voice goes' });
  await expect(where.getByText('Phone dictation', { exact: true })).toBeVisible();
  await expect(where.getByText(/^Your browser's own speech service hears it: on Android usually Google's servers, on iPhone Apple's/)).toBeVisible();
  await expect(where.getByText('Send audio to the model', { exact: true })).toBeVisible();
  await expect(where.getByText('Browser voice', { exact: true })).toBeVisible();
  await where.getByRole('link', { name: 'Settings → Models' }).click();
  await expect(page.getByRole('heading', { name: 'Speech in: how Shiori hears you' })).toBeVisible();
});
