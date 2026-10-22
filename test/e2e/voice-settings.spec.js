import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider, addProvider, startModelServer, savedBy, leaveSaved } from './helpers.js';
import { startGeminiServer } from '../fakes/gemini-server.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Voice settings per model (phone1-voices, spec §10.1): a voice model's page has a Voice and a Style, saved as they change and sent with
// every request, by Test's sample too. Gemini suggests Google's 30 voices and sends the style as speech_metadata; an OpenAI-compatible
// server gets voice and instructions, and a voice that can't take a style (styled: false) says so and is sent none.

const KEY = 'AIza-e2e-gemini-stand-in-0123456789abcdef';
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };

test("a Gemini voice's page: Sulafat and a calm, warm style by default, Google's voices to pick from; what is typed is saved and sent by the sample", async ({ page }) => {
  const s = await startGeminiServer({ key: KEY });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'Google Gemini');
    await page.getByLabel('Address', { exact: true }).fill(s.url);
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^Gemini 3\.8 Flash Lite TTS/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Gemini 3.8 Flash Lite TTS' })).toBeVisible();
    const voice = page.getByRole('combobox', { name: 'Voice' });
    const style = page.getByLabel('Style', { exact: true });
    await expect(voice).toHaveValue('Sulafat');
    await expect(style).toHaveValue('calm, warm and friendly');
    await expect(page.locator('#model-voices option')).toHaveCount(30);
    await expect(page.locator('#model-voices option[value="Achird"]')).toHaveCount(1);
    await expect(page.locator('#model-style-note')).toContainText('How she should sound');
    // The default goes with the sample: Google's turn-level style on the text.
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    const asked = () => s.bodies().filter((b) => b.response_format?.type === 'audio');
    expect(asked()[0].generation_config).toEqual({ speech_config: [{ voice: 'Sulafat' }] });
    expect(asked()[0].input[0].content[0].annotations).toEqual([{ type: 'speech_metadata', style: 'calm, warm and friendly' }]);
    // Both fields save as they change, and the next sample sends them.
    await voice.fill('Achird');
    await leaveSaved(voice);
    await style.fill('slow and gentle');
    await leaveSaved(style);
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => asked().length).toBe(2);
    expect(asked()[1].generation_config).toEqual({ speech_config: [{ voice: 'Achird' }] });
    expect(asked()[1].input[0].content[0].annotations).toEqual([{ type: 'speech_metadata', style: 'slow and gentle' }]);
    // They are kept: the page comes back with them, and the JSON field doesn't hold them twice or hide that the voices are listed.
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('Achird');
    await expect(page.getByLabel('Style', { exact: true })).toHaveValue('slow and gentle');
    await expect(page.locator('#model-voices option')).toHaveCount(30);
    expect(JSON.parse(await page.getByLabel('Tunables (JSON)').inputValue())).toEqual({});
    // Emptied, the style is not sent: the request stays as small as before there was one; the voice is the type's own.
    await page.getByLabel('Style', { exact: true }).fill('');
    await leaveSaved(page.getByLabel('Style', { exact: true }));
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => asked().length).toBe(3);
    expect(asked()[2].input[0].content[0]).toEqual({ type: 'text', text: expect.any(String) });
    // Saving the other tunables keeps the voices listed and the voice and style typed.
    const json = page.getByLabel('Tunables (JSON)');
    await json.fill(JSON.stringify({ format: 'mulaw8' }));
    await leaveSaved(json);
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('Achird');
    await page.reload();
    await expect(page.locator('#model-voices option')).toHaveCount(30);
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('Achird');
  } finally {
    await s.close();
  }
});

test("an OpenAI-compatible voice's page: the voice and the style go as voice and instructions; styled: false says it can't take a style and none is sent", async ({ page }) => {
  const server = await startModelServer({ '/voice/audio/speech': wav });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Another address', { ability: 'Voice', name: 'Speech stand-in', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'tts-model' });
    await page.getByRole('link', { name: /^Speech stand-in/ }).click();
    await page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^tts-model/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'tts-model' })).toBeVisible();
    const voice = page.getByRole('combobox', { name: 'Voice' });
    const style = page.getByLabel('Style', { exact: true });
    await expect(voice).toHaveValue('');
    await expect(voice).toHaveAttribute('placeholder', 'marin');
    await expect(page.locator('#model-voices option')).toHaveCount(0);
    await expect(page.locator('#model-style-note')).not.toContainText("can't take a style");
    await voice.fill('af_heart');
    await leaveSaved(voice);
    await style.fill('calm and warm');
    await leaveSaved(style);
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    expect(server.bodies('/voice/audio/speech')[0]).toMatchObject({ model: 'tts-model', voice: 'af_heart', instructions: 'calm and warm' });
    // A voice that ignores a style: kept on the page, not sent. The page says so once it is drawn again.
    const json = page.getByLabel('Tunables (JSON)');
    await json.fill(JSON.stringify({ styled: false }));
    await leaveSaved(json);
    await expect(voice).toHaveValue('af_heart');
    await expect(style).toHaveValue('calm and warm');
    await page.reload();
    await expect(page.locator('#model-style-note')).toHaveText("This voice can't take a style: it is kept, not sent.");
    await expect(page.getByLabel('Style', { exact: true })).toHaveValue('calm and warm');
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(2);
    expect(server.bodies('/voice/audio/speech')[1]).toEqual({ model: 'tts-model', input: expect.any(String), voice: 'af_heart', response_format: expect.any(String) });
    // Emptied after being set, the voice is sent as none, not as the type's marin.
    await page.getByRole('combobox', { name: 'Voice' }).fill('');
    await leaveSaved(page.getByRole('combobox', { name: 'Voice' }));
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(3);
    expect(server.bodies('/voice/audio/speech')[2].voice).toBeUndefined();
    expect(savedBy(page.getByRole('combobox', { name: 'Voice' }))).toBeTruthy();
  } finally {
    await server.stop();
  }
});
