import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, pickProvider, savedBy, filterTrace, leaveSaved } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { SPEECH_LIST, KATKAT, refusal } from '../fakes/openrouter-speech.js';

// OpenRouter's voices in uncompressed audio (stream-voice-next), against a stand-in for its audio API shaped as the voice probe of
// 2026-11-19 found it (test/fixtures/voices/openrouter-pcm-probe.json: its Content-Type for raw 16-bit PCM, and HeyGen's voice refusing
// anything else with a 400), and, for a voice added by id (voice-id-next), as the real speech list and the main session's probes of
// 2026-11-20 found its makers: test/fakes/openrouter-speech.js, from test/fixtures/voices/openrouter-speech-list.json and
// openrouter-voices-probe.json (HeyGen's "HTTP 400: Voice not found" and Grok's bare 404 for Women KatKat's id). No request reaches OpenRouter.
const probe = JSON.parse(readFileSync(new URL('../fixtures/voices/openrouter-pcm-probe.json', import.meta.url), 'utf8'));
/** The words a refused sample shows: HeyGen's 400 says why; Grok's 404 gave none, so the card says the Voice may be unknown. */
const HEYGEN_REFUSED = 'The provider didn\'t accept the request: "HTTP 400: Voice not found".';
const NOT_FOUND = "The provider doesn't know this model, address or voice. Check the model id, the base URL and the Voice.";
/** The speech list the stand-in answers: up, or refused (a 503: the add then starts with the ability's voice, as offline). @param {boolean} up */
const speechList = (up) => (up ? { status: 200, type: 'application/json', body: JSON.stringify({ data: SPEECH_LIST }) }
  : { status: 503, type: 'application/json', body: JSON.stringify({ error: { message: 'Service unavailable', code: 503 } }) });
/** The audio API's answer: a refusal as the real one gave it, else uncompressed audio where asked for it (HeyGen's takes nothing else), else a whole clip. @param {any} body */
const speaking = (body) => refusal(body)
  ?? (body?.response_format === 'pcm' ? { status: 200, type: probe.fishPcm.contentType, body: pcm } : /^heygen\//.test(body?.model) ? heygenRefuses : wav);

const STREAM = 'Stream her voice, so she starts sooner, uncompressed: several times the data (off: each sentence arrives whole first, compressed unless the voice sends only uncompressed audio)';
/** 0.3 s of a tone at 44.1 kHz, as raw 16-bit little-endian PCM. */
const pcm = Buffer.from(Int16Array.from({ length: 13230 }, (_, i) => Math.round(9000 * Math.sin(i / 7))).buffer);
/** A whole clip, for any other format asked. */
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const heygenRefuses = { status: probe.heygenMp3Refused.status, type: probe.heygenMp3Refused.contentType, body: probe.heygenMp3Refused.body };

test("OpenRouter's voice page: its Stream switch starts off, so Fish Audio is asked for MP3; switched on, Fish Audio streams its uncompressed audio through the stream player while Grok stays whole; HeyGen's free voice, which sends only uncompressed audio, added by id (in other case) starts with the voice OpenRouter's list gives it (it lists none, so its sibling's), and plays; with the list refused it starts with Women KatKat, which HeyGen refuses, and its sample says the server's reason, as does Grok's bare 404 (the Voice may be unknown); OpenAI's voice page, which no description gives the switch, has none; and a switch found on where it was typed in the JSON shows, and turns off", async ({ page }) => {
  let listUp = true;
  const server = await startModelServer({ '/api/v1/models': () => speechList(listUp), '/api/v1/audio/speech': speaking });
  try {
    // Every piece the stream player plays goes to its worklet as 16-bit PCM over its port; a whole clip plays in the audio element.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.__streamed = 0;
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = /** @type {any} */ (function (/** @type {any} */ m, /** @type {any} */ t) {
        if (m instanceof Int16Array) w.__streamed++;
        return /** @type {any} */ (post).call(this, m, t);
      });
    });
    const streamed = () => page.evaluate(() => /** @type {any} */ (window).__streamed);
    const said = () => server.bodies('/api/v1/audio/speech');
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'OpenRouter');
    await page.getByLabel('Address', { exact: true }).fill(`${server.origin}/api/v1`);
    await page.getByLabel('API key').fill('sk-or-test-key-123');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    const voice = page.getByRole('region', { name: 'Voice', exact: true });
    const streaming = voice.getByLabel(STREAM);
    await expect(streaming).not.toBeChecked();
    await expect(voice.getByText(/Fish Audio's voice starts 2 to 5 seconds sooner, for 5\.5 times a whole clip's data/)).toBeVisible();
    /** A voice's Test, on its own page, and back to OpenRouter's. @param {RegExp} link @param {string} name */
    const sample = async (link, name) => {
      await voice.getByRole('link', { name: link }).click();
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      const n = said().length;
      await page.getByRole('button', { name: 'Play a sample' }).click();
      await expect(page.getByText('It works: that was this voice.')).toBeVisible({ timeout: 20_000 });
      await page.goBack();
      await expect(page.getByRole('heading', { level: 1, name: 'OpenRouter' })).toBeVisible();
      return said().slice(n);
    };
    const fish = () => sample(/^Fish Audio: S2\.1 Pro Free \(free\)/, 'Fish Audio: S2.1 Pro Free (free)');
    // Off: Fish Audio asked for MP3, played whole.
    expect(await fish()).toEqual([expect.objectContaining({ model: 'fish-audio/s2.1-pro-free:free', response_format: 'mp3' })]);
    expect(await streamed()).toBe(0);
    // On: uncompressed audio, played piece by piece through Web Audio.
    await streaming.check();
    await expect(savedBy(streaming)).toHaveText('Saved');
    expect(await fish()).toEqual([expect.objectContaining({ model: 'fish-audio/s2.1-pro-free:free', response_format: 'pcm' })]);
    await expect.poll(streamed).toBeGreaterThan(0);
    // Grok gains little streamed (the probe), so it stays whole with the switch on.
    const before = await streamed();
    expect(await sample(/^SpaceXAI: Grok Voice TTS 1\.0 \(Ara\)/, 'SpaceXAI: Grok Voice TTS 1.0 (Ara)')).toEqual([expect.objectContaining({ model: 'x-ai/grok-voice-tts-1.0', response_format: 'mp3' })]);
    expect(await streamed()).toBe(before);
    // Off again, HeyGen's free voice, added by id (typed in other case): it lists no voice of its own and takes its sibling's, the real list's
    // first (nadine), as from Fetch model list (the list read for the add); it is stored and named by the list's id, with no "Added as" toast
    // (the typed id is not a name another model has taken), asked for uncompressed audio at once (no 400 spent), and played whole as a WAV clip.
    await streaming.uncheck();
    await expect(savedBy(streaming)).toHaveText('Saved');
    const addById = async (/** @type {string} */ id) => {
      await voice.getByLabel('Add a model by id').fill(id);
      await voice.getByRole('button', { name: 'Add model' }).click();
    };
    await addById('HeyGen/HeyGen-Voice-1-Turbo:Free');
    await expect(voice.getByRole('link', { name: /^heygen\/heygen-voice-1-turbo:free/ })).toBeVisible();
    // Counted at once, not waited for (an assertion that retries passes when the toast has gone): the toast comes before the page is drawn.
    expect(await page.locator('.toast', { hasText: 'Added as' }).count()).toBe(0);
    expect(await sample(/^heygen\/heygen-voice-1-turbo:free/, 'heygen/heygen-voice-1-turbo:free')).toEqual([expect.objectContaining({ model: 'heygen/heygen-voice-1-turbo:free', response_format: 'pcm', voice: 'nadine' })]);
    expect(await streamed()).toBe(before);
    // The list refused: the add starts with the provider's voice, Fish Audio's Women KatKat, as before. HeyGen's server doesn't know it, and
    // the sample says so in the server's own words.
    listUp = false;
    await addById('heygen/heygen-voice-1');
    await voice.getByRole('link', { name: /^heygen\/heygen-voice-1(?!-)/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'heygen/heygen-voice-1' })).toBeVisible();
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByRole('status').filter({ hasText: HEYGEN_REFUSED })).toBeVisible({ timeout: 20_000 });
    expect(said().at(-1)).toEqual(expect.objectContaining({ model: 'heygen/heygen-voice-1', voice: KATKAT }));
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'OpenRouter' })).toBeVisible();
    // Women KatKat's id typed into Grok's Voice: its server answers a bare 404, so the sample says the Voice may be what it doesn't know,
    // not only the model id and the address, which are right.
    await voice.getByRole('link', { name: /^SpaceXAI: Grok Voice TTS 1\.0/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^SpaceXAI: Grok Voice TTS 1\.0/ })).toBeVisible();
    const grokVoice = page.locator('#model-voice');
    await grokVoice.fill(KATKAT);
    await leaveSaved(grokVoice);
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByRole('status').filter({ hasText: NOT_FOUND })).toBeVisible({ timeout: 20_000 });
    expect(said().at(-1)).toEqual(expect.objectContaining({ model: 'x-ai/grok-voice-tts-1.0', voice: KATKAT }));
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'OpenRouter' })).toBeVisible();
    // The Trace: the streamed sample says what came.
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('.trace li').filter({ hasText: 'Fish Audio' }).filter({ hasText: 'streamed PCM at 44.1 kHz' }).first()).toBeVisible();
    // OpenAI's voices speak the same protocol, but no description names the switch there: their raw audio may name no rate.
    await page.goto('/#/models');
    await pickProvider(page, 'OpenAI');
    const openai = page.getByRole('region', { name: 'Voice', exact: true });
    await expect(openai.getByLabel('Tunables (JSON)')).toBeVisible();
    await expect(openai.getByLabel(STREAM)).toHaveCount(0);
    // Ticked all the same (typed in the JSON here), the voice would fail, and a page that hid the switch would leave no way to turn it
    // off: the switch shows, ticked, and turns it off for good.
    const json = openai.getByLabel('Tunables (JSON)');
    await json.fill(JSON.stringify({ ...JSON.parse(await json.inputValue()), stream: true }));
    await leaveSaved(json);
    await page.reload();
    const stored = page.getByRole('region', { name: 'Voice', exact: true }).getByLabel(STREAM);
    await expect(stored).toBeChecked();
    await stored.uncheck();
    await expect(savedBy(stored)).toHaveText('Saved');
    await page.reload();
    await expect(page.getByRole('region', { name: 'Voice', exact: true }).getByLabel('Tunables (JSON)')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Voice', exact: true }).getByLabel(STREAM)).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("A voice added by id reads OpenRouter's list for the add: if the address changes while the list is on its way, its voice is not used, and the add starts with Women KatKat, as when the list can't be read", async ({ page }) => {
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  let asked = false;
  const server = await startModelServer({
    // The list answers only when the test lets it, after the address is saved; the speech API answers at both addresses.
    '/api/v1/models': () => { asked = true; return { ...speechList(true), until: held }; },
    '/api/v1/audio/speech': speaking,
    '/other/api/v1/audio/speech': speaking,
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'OpenRouter');
    await page.getByLabel('Address', { exact: true }).fill(`${server.origin}/api/v1`);
    await page.getByLabel('API key').fill('sk-or-test-key-123');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(page.locator('.toast')).toHaveCount(0); // this save's "Saved" has gone, so the next one is the next save's
    const voice = page.getByRole('region', { name: 'Voice', exact: true });
    await voice.getByLabel('Add a model by id').fill('heygen/heygen-voice-1');
    await voice.getByRole('button', { name: 'Add model' }).click();
    await expect.poll(() => asked).toBe(true);
    const from = Date.now();
    await page.getByLabel('Address', { exact: true }).fill(`${server.origin}/other/api/v1`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast', { hasText: 'Saved' })).toBeVisible();
    release();
    // The list came in time (the add waits for it for 15 s), so it is the address that kept its voice out.
    expect(Date.now() - from).toBeLessThan(12_000);
    await voice.getByRole('link', { name: /^heygen\/heygen-voice-1/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'heygen/heygen-voice-1' })).toBeVisible();
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByRole('status').filter({ hasText: HEYGEN_REFUSED })).toBeVisible({ timeout: 20_000 });
    expect(server.bodies('/other/api/v1/audio/speech').at(-1)).toEqual(expect.objectContaining({ model: 'heygen/heygen-voice-1', voice: KATKAT }));
  } finally {
    await server.stop();
  }
});
