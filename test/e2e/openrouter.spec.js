import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, startModelServer, fakeMicrophone } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Sign in with OpenRouter also sets up OpenRouter's transcription and a voice, behind the phone's own
// dictation and the browser voice (the user, 2026-10-18: "Add, behind phone"). OpenRouter is stood in
// for by a server on its own port; no request reaches the real one.

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
/** The stand-in voice's clip: a 0.3 s tone. */
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const heard = { status: 200, type: 'application/json', body: JSON.stringify({ text: 'Where should we stop for lunch?', usage: { seconds: 2, cost: 0.0000067 } }) };
/** @param {import('@playwright/test').Page} page @param {string} heading */
const roleItems = (page, heading) => page.locator('.role', { has: page.getByRole('heading', { name: heading }) }).locator('.role-item > span');
const IN = 'Speech in: how Shiori hears you';
const OUT = "Speech out: Shiori's voice";
const PHONE_IN = ['1. Send audio to the model (when the model takes audio)', "2. Phone dictation (the phone's own; usually goes to Google or Apple)", '3. OpenAI: Whisper Large V3 Turbo'];
const PHONE_OUT = ["1. Browser voice (the browser's own; some voices go online)", '2. SpaceXAI: Grok Voice TTS 1.0 (Ara)'];
const KEY = 'sk-or-test-key-123';

/** From the Models screen: plays the voice's sample, then has the transcription model write down what the (fake) microphone says. @param {import('@playwright/test').Page} page */
async function testBoth(page) {
  await page.getByRole('link', { name: /^OpenRouter: voice/ }).click();
  await page.getByRole('link', { name: /^SpaceXAI: Grok Voice TTS 1\.0 \(Ara\)/ }).click();
  await page.getByRole('button', { name: 'Play a sample' }).click();
  await expect(page.getByText('It works: that was this voice.')).toBeVisible();
  await page.goto('/#/models');
  await page.getByRole('link', { name: /^OpenRouter: transcription/ }).click();
  await page.getByRole('link', { name: /^OpenAI: Whisper Large V3 Turbo/ }).click();
  await page.getByRole('button', { name: 'Say something' }).click();
  await expect(page.getByText('It heard: "Where should we stop for lunch?"')).toBeVisible({ timeout: 20_000 });
}

test("Sign in with OpenRouter sets up free chat models, and OpenRouter's transcription and voice behind the phone's own; their Tests reach OpenRouter's audio API", async ({ page, browserName }) => {
  // WebKit doesn't let page.route stand in for a page's requests while a service worker controls it, and the
  // sign-in's addresses are OpenRouter's own; the next test covers WebKit, the unit tests cover the rest.
  test.skip(browserName === 'webkit', "Playwright can't stand in for OpenRouter's sign-in in WebKit");
  const server = await startModelServer({ '/api/v1/audio/speech': wav, '/api/v1/audio/transcriptions': heard });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    let authUrl = '';
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => { release = () => resolve(undefined); });
    await page.route('https://openrouter.ai/auth**', (route) => {
      authUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>OpenRouter</p>' });
    });
    await page.route('https://openrouter.ai/api/v1/auth/keys', async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key: KEY }) });
    });
    // OpenRouter's audio API, passed on to the stand-in server; what annai sent with each request is kept.
    /** @type {Record<string, string>[]} */
    const sent = [];
    await page.route('https://openrouter.ai/api/v1/audio/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'OPTIONS') sent.push(req.headers());
      const body = req.method() === 'POST' ? req.postDataBuffer() : null;
      const res = await fetch(server.origin + new URL(req.url()).pathname, {
        method: req.method(), headers: { 'content-type': req.headers()['content-type'] ?? 'text/plain' }, body: body ? new Uint8Array(body) : undefined,
      });
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await expect(page.getByText("It also adds OpenRouter's transcription and a voice")).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with OpenRouter' }).click();
    await expect.poll(() => authUrl).toContain('key_label=annai');
    await page.goto(`/?code=test-code&state=${new URL(authUrl).searchParams.get('state')}`);
    // Back from OpenRouter, the Models screen shows at once, saying the sign-in is being finished.
    await expect(page.getByText('Finishing the sign-in with OpenRouter…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeDisabled();
    release();
    const card = page.locator('.notice', { hasText: 'Signed in with OpenRouter' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("behind the phone's own dictation and the browser voice, which are free");
    await expect(card).toContainText('move them up under Roles');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeHidden();
    await expect(page.getByText('1. Google: Gemma 4 31B (free)')).toBeVisible();
    await expect(roleItems(page, IN)).toHaveText(PHONE_IN);
    await expect(roleItems(page, OUT)).toHaveText(PHONE_OUT);
    await testBoth(page);
    const [said] = server.bodies('/api/v1/audio/speech');
    expect(said).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', response_format: 'mp3' });
    const raw = Buffer.from(server.bodies('/api/v1/audio/transcriptions')[0]).toString('latin1');
    expect(raw).toContain('openai/whisper-large-v3-turbo');
    expect(raw).toContain('RIFF');
    // One key, the sign-in's, on each request, with annai's attribution as on the chat endpoint.
    expect(sent).toHaveLength(2);
    for (const h of sent) expect(h).toMatchObject({ authorization: `Bearer ${KEY}`, 'x-title': 'annai', 'http-referer': 'https://annai.guide' });
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await server.stop();
  }
});

test("signed in before the voice came: the OpenRouter endpoint's page adds OpenRouter's transcription and voice with its key, behind the phone's own, and their Tests work", async ({ page }) => {
  const server = await startModelServer({ '/api/v1/audio/speech': wav, '/api/v1/audio/transcriptions': heard });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    // The chat endpoint only, as Sign in with OpenRouter set it up before.
    await page.getByLabel('Add an endpoint').selectOption({ label: 'OpenRouter' });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'OpenRouter', exact: true })).toBeVisible({ timeout: 30_000 });
    const add = page.getByRole('button', { name: "Add OpenRouter's voice" });
    await expect(add).toBeDisabled();
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(add).toBeEnabled();
    await add.click();
    await expect(add).toBeHidden();
    await page.getByRole('link', { name: '← Models' }).click();
    await expect(roleItems(page, IN)).toHaveText(PHONE_IN);
    await expect(roleItems(page, OUT)).toHaveText(PHONE_OUT);
    // Each endpoint has the key of its own: it says so, and the key is never shown.
    for (const name of ['OpenRouter: voice', 'OpenRouter: transcription']) {
      await page.getByRole('link', { name: new RegExp(`^${name}`) }).click();
      await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
      await page.getByLabel('Base URL').fill(`${server.origin}/api/v1`);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByLabel('Base URL')).toHaveValue(`${server.origin}/api/v1`);
      await page.getByRole('link', { name: '← Models' }).click();
    }
    await testBoth(page);
    expect(server.bodies('/api/v1/audio/speech')[0]).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', response_format: 'mp3' });
    expect(Buffer.from(server.bodies('/api/v1/audio/transcriptions')[0]).toString('latin1')).toContain('openai/whisper-large-v3-turbo');
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await server.stop();
  }
});
