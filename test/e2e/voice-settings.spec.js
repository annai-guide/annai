import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider, addProvider, startModelServer, leaveSaved } from './helpers.js';
import { startGeminiServer } from '../fakes/gemini-server.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Voice settings per model (phone1-voices, spec §10.1): a voice model's page has a Voice and a Style, saved as they change and sent with
// every request, by Test's sample too. Gemini suggests Google's 30 voices and sends the style as speech_metadata; an OpenAI-compatible
// server gets voice and instructions, and a voice that can't take a style (styled: false) says so and is sent none.

const KEY = 'AIza-e2e-gemini-stand-in-0123456789abcdef';
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };

/** Waits until the screen has stopped being drawn again: a page just opened is drawn once more as the plugins it needs arrive, and what is typed meanwhile is lost. */
async function still(/** @type {import('@playwright/test').Page} */ page) {
  await page.evaluate(() => new Promise((resolve) => {
    let t = setTimeout(resolve, 500);
    let last = document.querySelector('.screen');
    new MutationObserver(() => {
      const now = document.querySelector('.screen');
      if (now !== last) { last = now; clearTimeout(t); t = setTimeout(resolve, 500); }
    }).observe(document.body, { childList: true, subtree: true });
  }));
}

test("a Gemini voice's page: Sulafat and the default style (young, cheerful and lively, yet calm and gentle), Google's voices to pick from; what is typed is saved and sent by the sample", async ({ page }) => {
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
    await still(page);
    const voice = page.getByRole('combobox', { name: 'Voice' });
    const style = page.getByLabel('Style', { exact: true });
    await expect(voice).toHaveValue('Sulafat');
    await expect(style).toHaveValue('young, cheerful and lively, yet calm and gentle');
    await expect(page.locator('#model-voices option')).toHaveCount(30);
    await expect(page.locator('#model-voices option[value="Achird"]')).toHaveCount(1);
    await expect(page.locator('#model-style-note')).toContainText('How she should sound');
    // The default goes with the sample: Google's turn-level style on the text.
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    const asked = () => s.bodies().filter((b) => b.response_format?.type === 'audio');
    expect(asked()[0].generation_config).toEqual({ speech_config: [{ voice: 'Sulafat' }] });
    expect(asked()[0].input[0].content[0].annotations).toEqual([{ type: 'speech_metadata', style: 'young, cheerful and lively, yet calm and gentle' }]);
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
    await still(page);
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('Achird');
    await expect(page.getByLabel('Style', { exact: true })).toHaveValue('slow and gentle');
    await expect(page.locator('#model-voices option')).toHaveCount(30);
    // Voice and style have fields of their own: the JSON holds neither.
    expect(JSON.parse(await page.getByLabel('Tunables (JSON)').inputValue())).toEqual({});
    // The provider page's Tunables name a style for the whole ability. The model's own, emptied, is none: it must beat the ability's
    // (a deleted key would let the ability's through), and the request stays as small as before there was one.
    await page.getByRole('link', { name: 'Google Gemini', exact: true }).click();
    const abilityJson = page.getByRole('region', { name: 'Voice', exact: true }).getByLabel('Tunables (JSON)');
    await abilityJson.fill(JSON.stringify({ ...JSON.parse(await abilityJson.inputValue()), style: 'ability style' }));
    await leaveSaved(abilityJson);
    await page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^Gemini 3\.8 Flash Lite TTS/ }).click();
    await still(page);
    await expect(page.getByLabel('Style', { exact: true })).toHaveValue('slow and gentle');
    await page.getByLabel('Style', { exact: true }).fill('');
    await leaveSaved(page.getByLabel('Style', { exact: true }));
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => asked().length).toBe(3);
    expect(asked()[2].input[0].content[0]).toEqual({ type: 'text', text: expect.any(String) });
    // An emptied voice is the model's default (here Google's Sulafat), shown as the placeholder: Gemini is sent a voice either way.
    await page.getByRole('combobox', { name: 'Voice' }).fill('');
    await leaveSaved(page.getByRole('combobox', { name: 'Voice' }));
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveAttribute('placeholder', 'Sulafat');
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => asked().length).toBe(4);
    expect(asked()[3].generation_config).toEqual({ speech_config: [{ voice: 'Sulafat' }] });
    await page.getByRole('combobox', { name: 'Voice' }).fill('Achird');
    await leaveSaved(page.getByRole('combobox', { name: 'Voice' }));
    // Saving the other tunables keeps the voices listed and the voice and style typed.
    const json = page.getByLabel('Tunables (JSON)');
    await json.fill(JSON.stringify({ format: 'mulaw8' }));
    await leaveSaved(json);
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('Achird');
    await page.reload();
    await still(page);
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
    await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'Speech stand-in', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'tts-model' });
    await page.getByRole('link', { name: /^Speech stand-in/ }).click();
    await page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^tts-model/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'tts-model' })).toBeVisible();
    await still(page);
    const voice = page.getByRole('combobox', { name: 'Voice' });
    const style = page.getByLabel('Style', { exact: true });
    await expect(voice).toHaveValue('marin');
    await expect(voice).toHaveAttribute('placeholder', 'marin');
    await expect(style).toHaveAttribute('maxlength', '200');
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
    await expect(page.locator('#model-style-note')).toHaveText("This voice can't take a style: it is kept, not sent.", { timeout: 2000 }); // no reload
    await json.fill(JSON.stringify({ styled: true }));
    await leaveSaved(json);
    await expect(page.locator('#model-style-note')).not.toContainText("can't take a style");
    await json.fill(JSON.stringify({ styled: false }));
    await leaveSaved(json);
    await page.reload();
    await still(page);
    await expect(page.locator('#model-style-note')).toHaveText("This voice can't take a style: it is kept, not sent.");
    await expect(page.getByLabel('Style', { exact: true })).toHaveValue('calm and warm');
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(2);
    expect(server.bodies('/voice/audio/speech')[1]).toEqual({ model: 'tts-model', input: expect.any(String), voice: 'af_heart', response_format: expect.any(String) });
    // Emptied, the voice is the model's default (here the type's marin, shown as the placeholder), not none: OpenAI-style servers want one.
    await page.getByRole('combobox', { name: 'Voice' }).fill('');
    await leaveSaved(page.getByRole('combobox', { name: 'Voice' }));
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(3);
    expect(server.bodies('/voice/audio/speech')[2].voice).toBe('marin');
    // The save landed: the page comes back with the default as its value, and nothing of the old voice is kept.
    await page.reload();
    await still(page);
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('marin');
    expect(JSON.parse(await page.getByLabel('Tunables (JSON)').inputValue())).toEqual({ styled: false });
  } finally {
    await server.stop();
  }
});

test("OpenAI's gpt-4o-mini-tts page: a style the user set before the Style field (instructions in the provider's Tunables) is shown, sent and wins over the description's; typing a style replaces it; an emptied voice is the description's", async ({ page }) => {
  const server = await startModelServer({ '/v1/audio/speech': wav });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'OpenAI');
    await page.getByLabel('Address', { exact: true }).fill(`${server.origin}/v1`);
    await page.getByLabel('API key').fill('sk-openai-test');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    const region = page.getByRole('region', { name: 'Voice', exact: true });
    // From before the Style field: the tunable was named instructions, and was the user's.
    const abilityJson = region.getByLabel('Tunables (JSON)');
    await abilityJson.fill(JSON.stringify({ ...JSON.parse(await abilityJson.inputValue()), instructions: 'Old words' }));
    await leaveSaved(abilityJson);
    await region.getByRole('link', { name: /^OpenAI: GPT-4o mini TTS/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /GPT-4o mini TTS/ })).toBeVisible();
    await still(page);
    const voice = page.getByRole('combobox', { name: 'Voice' });
    const style = page.getByLabel('Style', { exact: true });
    await expect(voice).toHaveValue('marin');
    await expect(style).toHaveValue('Old words');
    await expect(page.locator('#model-voices option')).toHaveCount(13);
    const spoken = () => server.bodies('/v1/audio/speech');
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
    expect(spoken()[0]).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', instructions: 'Old words' });
    // The description's style stays the default for those who set none: typing one replaces the old instructions for good.
    await style.fill('Slow and kind.');
    await leaveSaved(style);
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => spoken().length).toBe(2);
    expect(spoken()[1].instructions).toBe('Slow and kind');
    await style.fill('');
    await leaveSaved(style);
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => spoken().length).toBe(3);
    expect(spoken()[2].instructions, 'emptied is none: neither the old instructions nor the description\'s come back').toBeUndefined();
    // An emptied voice is the description's marin; another one is kept.
    await voice.fill('cedar');
    await leaveSaved(voice);
    await voice.fill('');
    await leaveSaved(voice);
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => spoken().length).toBe(4);
    expect(spoken()[3].voice).toBe('marin');
    await page.reload();
    await still(page);
    await expect(page.getByLabel('Style', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Style', { exact: true })).toHaveAttribute('placeholder', 'Speak in a young, cheerful and lively, yet calm and gentle tone.');
    // The style that is the default is no override: put back, it follows the description again.
    await page.getByLabel('Style', { exact: true }).fill('Speak in a young, cheerful and lively, yet calm and gentle tone.');
    await leaveSaved(page.getByLabel('Style', { exact: true }));
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect.poll(() => spoken().length).toBe(5);
    expect(spoken()[4].instructions).toBe('Speak in a young, cheerful and lively, yet calm and gentle tone');
  } finally {
    await server.stop();
  }
});

test("a model's Tunables (JSON) never loses a key that has no field on its page, and voices typed in it become the Voice field's list", async ({ page }) => {
  const server = await startModelServer({ '/ears/audio/transcriptions': { status: 200, type: 'application/json', body: '{"text":"ok"}' }, '/voice/audio/speech': wav });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Transcription', name: 'Ears stand-in', url: `${server.origin}/ears`, key: 'sk-ears-test', model: 'ears' });
    await page.getByRole('link', { name: /^Ears stand-in/ }).click();
    await page.getByRole('region', { name: 'Transcription', exact: true }).getByRole('link', { name: /^ears/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ears' })).toBeVisible();
    await still(page);
    // A transcription model has no Voice or Style: whatever it holds under those names is the user's, kept as typed.
    const keys = { voice: 'v', style: 's', voices: ['a', 'b'], language: 'en' };
    const json = page.getByLabel('Tunables (JSON)');
    await json.fill(JSON.stringify(keys));
    await leaveSaved(json);
    expect(JSON.parse(await json.inputValue())).toMatchObject(keys);
    await page.reload();
    await still(page);
    expect(JSON.parse(await page.getByLabel('Tunables (JSON)').inputValue())).toMatchObject(keys);
    // A voice has a field for the voice and the style, not for the voices: they are in the JSON, editable, and the field's list follows them.
    await page.goto('/#/models');
    await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'Speech stand-in', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'tts-model' });
    await page.getByRole('link', { name: /^Speech stand-in/ }).click();
    await page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^tts-model/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'tts-model' })).toBeVisible();
    await still(page);
    const vjson = page.getByLabel('Tunables (JSON)');
    await vjson.fill(JSON.stringify({ voices: ['alpha', 'beta'], format: 'wav' }));
    await leaveSaved(vjson);
    await expect(page.locator('#model-voices option')).toHaveCount(2);
    const voice = page.getByRole('combobox', { name: 'Voice' });
    await voice.fill('beta');
    await leaveSaved(voice);
    await page.reload();
    await still(page);
    expect(JSON.parse(await page.getByLabel('Tunables (JSON)').inputValue())).toEqual({ voices: ['alpha', 'beta'], format: 'wav' });
    await expect(page.locator('#model-voices option')).toHaveCount(2);
    await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('beta');
    await page.getByLabel('Style', { exact: true }).fill('gentle');
    await leaveSaved(page.getByLabel('Style', { exact: true }));
    // A field saved: the JSON keeps its keys.
    expect(JSON.parse(await page.getByLabel('Tunables (JSON)').inputValue())).toEqual({ voices: ['alpha', 'beta'], format: 'wav' });
  } finally {
    await server.stop();
  }
});
