import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, pickProvider, savedBy, filterTrace, leaveSaved } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// OpenRouter's voices in uncompressed audio (stream-voice-next), against a stand-in for its audio API shaped as the voice probe of
// 2026-11-19 found it (test/fixtures/voices/openrouter-pcm-probe.json: its Content-Type for raw 16-bit PCM, and HeyGen's voice refusing
// anything else with a 400), and as the main session's probe of 2026-11-20 found its makers but Fish Audio: a 400 for a request with no
// voice, and "Voice not found" for one its list doesn't give that model (voice-id-next). No request reaches OpenRouter.
const probe = JSON.parse(readFileSync(new URL('../fixtures/voices/openrouter-pcm-probe.json', import.meta.url), 'utf8'));
/** Its speech list (/models?output_modalities=speech): Fish Audio's take any library voice; HeyGen's voice names are stand-ins. */
const SPEECH = [
  { id: 'fish-audio/s2.1-pro-free:free', name: 'Fish Audio: S2.1 Pro Free (free)', supported_voices: null },
  { id: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0', supported_voices: ['eve', 'ara', 'rex', 'sal', 'leo'] },
  { id: 'heygen/heygen-voice-1', name: 'HeyGen: Voice 1', supported_voices: ['Allison', 'Ivy'] },
];
/** OpenRouter's 400, as the probes recorded its bodies. @param {string} message */
const refusing = (message) => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: { message, code: 400 } }) });

const STREAM = 'Stream her voice, so she starts sooner, uncompressed: several times the data (off: each sentence arrives whole first, compressed unless the voice sends only uncompressed audio)';
/** 0.3 s of a tone at 44.1 kHz, as raw 16-bit little-endian PCM. */
const pcm = Buffer.from(Int16Array.from({ length: 13230 }, (_, i) => Math.round(9000 * Math.sin(i / 7))).buffer);
/** A whole clip, for any other format asked. */
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const heygenRefuses = { status: probe.heygenMp3Refused.status, type: probe.heygenMp3Refused.contentType, body: probe.heygenMp3Refused.body };

test("OpenRouter's voice page: its Stream switch starts off, so Fish Audio is asked for MP3; switched on, Fish Audio streams its uncompressed audio through the stream player while Grok stays whole; HeyGen's voice, which sends only uncompressed audio, added by id starts with the voice OpenRouter's list gives it, and plays; one the list doesn't have is refused, and its sample says the server's reason; OpenAI's voice page, which no description gives the switch, has none; and a switch found on where it was typed in the JSON shows, and turns off", async ({ page }) => {
  const server = await startModelServer({
    '/api/v1/models': { status: 200, type: 'application/json', body: JSON.stringify({ data: SPEECH }) },
    '/api/v1/audio/speech': (/** @type {any} */ body) => {
      if (!/^fish-audio\//.test(body?.model)) {
        if (!body?.voice) return refusing(/^heygen\//.test(body?.model) ? 'An explicit voice is required unless input_references carries a reference recording.' : 'An explicit voice is required for this TTS provider.');
        if (!(SPEECH.find((m) => m.id === body.model)?.supported_voices ?? []).includes(body.voice)) return refusing('Voice not found');
      }
      return body?.response_format === 'pcm' ? { status: 200, type: probe.fishPcm.contentType, body: pcm } : /^heygen\//.test(body?.model) ? heygenRefuses : wav;
    },
  });
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
    // Off again, HeyGen's voice, added by id: with the voice OpenRouter's list gives it, as from Fetch model list (the list read for the
    // add), asked for uncompressed audio at once (no 400 spent), played whole as a WAV clip.
    await streaming.uncheck();
    await expect(savedBy(streaming)).toHaveText('Saved');
    await voice.getByLabel('Add a model by id').fill('heygen/heygen-voice-1');
    await voice.getByRole('button', { name: 'Add model' }).click();
    expect(await sample(/^heygen\/heygen-voice-1/, 'heygen/heygen-voice-1')).toEqual([expect.objectContaining({ model: 'heygen/heygen-voice-1', response_format: 'pcm', voice: 'Allison' })]);
    expect(await streamed()).toBe(before);
    // An id the list doesn't have starts with the provider's voice, Fish Audio's Women KatKat, as before: HeyGen's server doesn't know it,
    // and the sample says so in the server's own words.
    await voice.getByLabel('Add a model by id').fill('heygen/heygen-voice-9');
    await voice.getByRole('button', { name: 'Add model' }).click();
    await voice.getByRole('link', { name: /^heygen\/heygen-voice-9/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'heygen/heygen-voice-9' })).toBeVisible();
    await page.getByRole('button', { name: 'Play a sample' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The provider didn\'t accept the request: "Voice not found".' })).toBeVisible({ timeout: 20_000 });
    expect(said().at(-1)).toEqual(expect.objectContaining({ model: 'heygen/heygen-voice-9', voice: 'bddf65d5a84c4a9aa36b7136bdac57a9' }));
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
