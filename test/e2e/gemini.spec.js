import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, pickProvider, savedBy, leaveSaved, fakeMicrophone, filterTrace } from './helpers.js';
import { startGeminiServer } from '../fakes/gemini-server.js';

// Gemini through its own API (G1), against the stand-in Gemini server on a port of its own: the catalog's Google Gemini
// at the stand-in's address, its list, Test (a tool and a photo, and an upload), Try this model, the free-tier switch,
// and the key only ever in its header.

const KEY = 'AIza-e2e-gemini-stand-in-0123456789abcdef';

test('Google Gemini from the catalog speaks Gemini\'s own API: Fetch model list, Test with the tool and the photo, Try this model; the key goes only in x-goog-api-key; the free-tier switch makes its calls free', async ({ page }) => {
  const s = await startGeminiServer({ key: KEY });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'Google Gemini');
    await page.getByLabel('Address', { exact: true }).fill(s.url);
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(page.getByText(/Uses Gemini's own API/)).toBeVisible();
    const free = page.getByLabel("This key is on the free tier (Google doesn't charge)");
    await expect(free).not.toBeChecked();
    const chat = page.getByRole('region', { name: 'Chat', exact: true });
    await expect(chat.getByText('Gemini API', { exact: true })).toBeVisible();
    // The note for models from before 2.0 shows only while one without a context window is there.
    await expect(chat.getByText(/add it again with Fetch model list/)).toHaveCount(0);
    // Its list: chat models only, each added with its context window.
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('9 models.')).toBeVisible();
    await expect(chat.getByText('Gemini 3.7 Flash (gemini-3.7-flash)')).toBeVisible();
    await expect(chat.locator('ul.listed').getByText(/-tts|-live|embedding|image/)).toHaveCount(0);
    await chat.getByRole('button', { name: 'Add gemini-3.7-flash' }).click();
    await expect(chat.getByRole('link', { name: /^Gemini 3\.7 Flash.*1049K context/ })).toBeVisible();
    await expect(chat.getByText(/add it again with Fetch model list/)).toHaveCount(0);
    await chat.getByLabel('Add a model by id').fill('gemini-3.5-flash');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByRole('link', { name: /^gemini-3\.5-flash\s*$/ })).toBeVisible();
    await expect(chat.getByText(/add it again with Fetch model list/)).toBeVisible();
    // Test: a tiny request, then one with the tool and the photo, at Main's level, and an upload.
    await expect(chat.getByRole('link', { name: /^Gemini 3\.8 Flash.*1049K context · \$0\.75 in, \$3\.75 out/ })).toBeVisible();
    await chat.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(chat.getByText('Everything works.')).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByText('✓ Tool calls work.')).toBeVisible();
    await expect(chat.getByText('✓ Photos work: it saw the red square.')).toBeVisible();
    await expect(chat.getByText(/✓ Photo uploads work/)).toBeVisible();
    const sent = s.bodies();
    expect(sent.some((b) => b.input?.[0]?.content?.some((/** @type {any} */ c) => c.type === 'image' && c.mime_type === 'image/png' && c.data))).toBe(true);
    expect(sent.some((b) => b.tools?.[0]?.name === 'report_color' && b.generation_config?.thinking_summaries === 'auto')).toBe(true);
    expect(sent.some((b) => b.generation_config?.thinking_level === 'medium'), "Main's level, as Test asks it").toBe(true);
    // Try this model: its words, its tokens and what they cost.
    await chat.getByRole('link', { name: /^Gemini 3\.8 Flash/ }).click();
    const tryIt = page.getByRole('region', { name: 'Try this model' });
    await tryIt.getByLabel('Message', { exact: true }).fill('Hello');
    await tryIt.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(tryIt.locator('.talk-text').last()).toHaveText('OK');
    await expect(tryIt.getByText('110 tokens · $0.0001')).toBeVisible();
    // The key went only in its header: never in an address or a body.
    for (const r of s.requests()) {
      expect(r.headers['x-goog-api-key'], r.url).toBe(KEY);
      expect(r.url.includes(KEY) || JSON.stringify(r.body).includes(KEY), r.url).toBe(false);
    }
    // The free-tier switch: this provider's calls cost nothing.
    await page.getByRole('link', { name: '← Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    await free.check();
    await expect(savedBy(free)).toHaveText('Saved');
    // "Use the recommended models" switches Live on for Koe, and says so.
    await page.getByRole('button', { name: 'Use the recommended models' }).click();
    await expect(page.locator('.toast', { hasText: 'Roles updated. Live voice switched on.' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Live voice', exact: true }).getByLabel('Use Live voice')).toBeChecked();
    await page.getByRole('region', { name: 'Chat', exact: true }).getByRole('link', { name: /^Gemini 3\.8 Flash/ }).click();
    await tryIt.getByLabel('Message', { exact: true }).fill('Hello again');
    await tryIt.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(tryIt.getByText('110 tokens · free')).toBeVisible();
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await s.close();
  }
});

test("the free-tier switch shows only for a provider whose description offers it", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'Anthropic');
  await expect(page.getByLabel('API key')).toBeVisible();
  await expect(page.getByText(/This key is on the free tier/)).toHaveCount(0);
});

test("Gemini's voice and transcription (G3): a sample streams Google's PCM through the stream player; phone quality asks for μ-law; with streaming off it plays whole; the transcription Test sends the phone's Opus as audio/ogg", async ({ page }) => {
  const s = await startGeminiServer({ key: KEY });
  try {
    // Every piece the stream player schedules starts an AudioBufferSourceNode; a whole clip plays in the audio element.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.__streamed = 0;
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when, offset, duration) { w.__streamed++; return start.call(this, when, offset, duration); };
    });
    await fakeMicrophone(page, [fileURLToPath(new URL('../fixtures/voice/where-eat.wav', import.meta.url))]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'Google Gemini');
    await page.getByLabel('Address', { exact: true }).fill(s.url);
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    const voice = page.getByRole('region', { name: 'Voice', exact: true });
    await expect(voice.getByText('Gemini API voice', { exact: true })).toBeVisible();
    await expect(voice.getByText(/only 10 requests a day and 3 a minute/)).toBeVisible();
    const full = voice.getByRole('radio', { name: 'Full quality (the most data: about 4 MB a minute of speech)' });
    const phone = voice.getByRole('radio', { name: 'Phone quality, 8 kHz (about 0.8 MB a minute)' });
    const streaming = voice.getByLabel('Stream her voice, so she starts sooner (off: each sentence arrives whole first)');
    await expect(full).toBeChecked();
    await expect(streaming).toBeChecked();
    const streamed = () => page.evaluate(() => /** @type {any} */ (window).__streamed);
    const voiceBodies = () => s.bodies().filter((b) => b.response_format?.type === 'audio');
    // A sample: streamed at full quality, played piece by piece through Web Audio.
    await voice.getByRole('button', { name: 'Play a sample' }).click();
    await expect(voice.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    // The Test is the ability's first model's, whichever of the two TTS models that is.
    expect(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']).toContain(voiceBodies()[0].model);
    expect(voiceBodies()[0]).toMatchObject({ stream: true, store: false, response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 }, generation_config: { speech_config: [{ voice: 'Kore' }] } });
    expect(voiceBodies()[0].input[0].content[0].text).toContain('This is how I sound');
    const first = await streamed();
    expect(first).toBeGreaterThan(0);
    // Phone quality: μ-law at 8 kHz, still streamed.
    await phone.check();
    await expect(savedBy(phone)).toHaveText('Saved');
    await voice.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => voiceBodies().length).toBe(2);
    await expect(voice.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    expect(voiceBodies()[1].response_format).toEqual({ type: 'audio', mime_type: 'audio/mulaw', sample_rate: 8000 });
    await expect.poll(streamed).toBeGreaterThan(first);
    // Streaming off: the same request, read whole and played as one WAV clip, not through the stream player.
    await streaming.uncheck();
    await expect(savedBy(streaming)).toHaveText('Saved');
    const before = await streamed();
    await voice.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => voiceBodies().length).toBe(3);
    await expect(voice.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    expect(await streamed()).toBe(before);
    // Changed in the tunables' JSON, the choices above it show it (fix pass).
    const json = voice.getByLabel('Tunables (JSON)');
    await json.fill(JSON.stringify({ ...JSON.parse(await json.inputValue()), format: 'pcm24', stream: true }));
    await leaveSaved(json);
    await expect(full).toBeChecked();
    await expect(phone).not.toBeChecked();
    await expect(streaming).toBeChecked();
    // The transcription Test: the phone's Opus, in Ogg, to Google's transcription model with its transcription_config, or to Flash Lite told to write it down.
    const ears = page.getByRole('region', { name: 'Transcription', exact: true });
    await expect(ears.getByText('Gemini API transcription', { exact: true })).toBeVisible();
    await ears.getByRole('button', { name: 'Say something' }).click();
    await expect(ears.getByText('It heard: "Where should we eat?"')).toBeVisible({ timeout: 20_000 });
    const heard = s.bodies().find((b) => b.input?.[0]?.content?.some((/** @type {any} */ c) => c.type === 'audio'));
    expect(heard.store).toBe(false);
    expect(heard.input[0].content.find((/** @type {any} */ c) => c.type === 'audio')).toMatchObject({ mime_type: 'audio/ogg' });
    if (heard.model === 'gemini-3.5-transcribe') expect(heard.generation_config).toEqual({ transcription_config: { language_codes: [] } });
    else expect(heard).toMatchObject({ model: 'gemini-3.5-flash-lite', generation_config: { temperature: 0, thinking_level: 'minimal' } });
    // The key went only in its header.
    for (const r of s.requests()) expect(r.url.includes(KEY) || JSON.stringify(r.body).includes(KEY), r.url).toBe(false);
    // The Trace: the streamed sample says what came, and how much.
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('.trace li').filter({ hasText: /Gemini 3\.8 Flash (Lite )?TTS/ }).filter({ hasText: 'streamed PCM at 24 kHz' }).first()).toBeVisible();
  } finally {
    await s.close();
  }
});
