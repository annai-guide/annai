import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openApp, waitForServiceWorker, startModelServer, fakeMicrophone, pickProvider } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Sign in with OpenRouter sets up one provider, OpenRouter, with one key for its chat, transcription and
// voice; its speech models go behind the phone's own dictation and the browser voice (the user, 2026-10-18:
// "Add, behind phone"). OpenRouter is stood in for by a server on its own port; no request reaches the real one.

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
/** The stand-in voice's clip: a 0.3 s tone. */
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const heard = { status: 200, type: 'application/json', body: JSON.stringify({ text: 'Where should we stop for lunch?', usage: { seconds: 2, cost: 0.0000067 } }) };
/** @param {import('@playwright/test').Page} page @param {string} heading */
const roleItems = (page, heading) => page.locator('.role', { has: page.getByRole('heading', { name: heading }) }).locator('.role-item > span');
const IN = 'Speech in: how Shiori hears you';
const OUT = "Speech out: Shiori's voice";
const PHONE_IN = ['1. Send audio to the model (when the model takes audio)', "2. Phone dictation (the phone's own; usually goes to Google or Apple)", '3. OpenAI: Whisper Large V3 Turbo'];
const PHONE_OUT = ["1. Browser voice (the browser's own; some voices go online)", '2. Fish Audio: S2.1 Pro Free (free)', '3. SpaceXAI: Grok Voice TTS 1.0 (Ara)'];
const KEY = 'sk-or-test-key-123';
/** The ids of the secrets annai keeps, read through its own modules in the page. @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
const secretIds = (page) => page.evaluate(async () => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const ids = await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.listSecretIds());
  store.close();
  return ids;
});

/** From the Models screen: plays the voice's sample, then has the transcription model write down what the (fake) microphone says. @param {import('@playwright/test').Page} page */
async function testBoth(page) {
  await page.getByRole('link', { name: /^OpenRouter/ }).click();
  await page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^SpaceXAI: Grok Voice TTS 1\.0 \(Ara\)/ }).click();
  await page.getByRole('button', { name: 'Play a sample' }).click();
  await expect(page.getByText('It works: that was this voice.')).toBeVisible();
  await page.goto('/#/models');
  await page.getByRole('link', { name: /^OpenRouter/ }).click();
  await page.getByRole('region', { name: 'Transcription', exact: true }).getByRole('link', { name: /^OpenAI: Whisper Large V3 Turbo/ }).click();
  await page.getByRole('button', { name: 'Say something' }).click();
  await expect(page.getByText('It heard: "Where should we stop for lunch?"')).toBeVisible({ timeout: 20_000 });
}

test("Sign in with OpenRouter makes one provider with one key: free chat models, and its transcription and voice behind the phone's own; their Tests reach OpenRouter's audio API", async ({ page, browserName }) => {
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
    await expect(page.getByText("It also adds OpenRouter's transcription and voices, a free one among them")).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with OpenRouter' }).click();
    await expect.poll(() => authUrl).toContain('key_label=annai');
    await page.goto(`/?code=test-code&state=${new URL(authUrl).searchParams.get('state')}`);
    // Back from OpenRouter, the Models screen shows at once, saying the sign-in is being finished.
    await expect(page.getByText('Finishing the sign-in with OpenRouter…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeDisabled();
    release();
    const card = page.locator('.notice', { hasText: 'Signed in with OpenRouter' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("behind the phone's own dictation and the browser voice. Its free voice comes first");
    await expect(card).toContainText('uses one of the free requests a day the chat models use too');
    await expect(card).toContainText('move them up under Roles');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeHidden();
    await expect(page.getByText('1. Google: Gemma 4 31B (free)')).toBeVisible();
    await expect(roleItems(page, IN)).toHaveText(PHONE_IN);
    await expect(roleItems(page, OUT)).toHaveText(PHONE_OUT);
    // One provider, with its three abilities, and one key.
    const providers = page.getByRole('region', { name: 'Providers' }).getByRole('listitem');
    await expect(providers).toHaveCount(1);
    await expect(providers).toContainText('Chat, Transcription, Voice');
    expect(await secretIds(page)).toHaveLength(1);
    await testBoth(page);
    const [said] = server.bodies('/api/v1/audio/speech');
    expect(said).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', response_format: 'mp3' });
    const raw = Buffer.from(server.bodies('/api/v1/audio/transcriptions')[0]).toString('latin1');
    expect(raw).toContain('openai/whisper-large-v3-turbo');
    // The smallest file both sides take: Opus in WebM, from the browser's own encoder (Koe and Kokoro design, "Audio formats").
    expect(raw).toContain('filename="speech.webm"');
    // One key, the sign-in's, on each request, with annai's attribution as on the chat endpoint.
    expect(sent).toHaveLength(2);
    for (const h of sent) expect(h).toMatchObject({ authorization: `Bearer ${KEY}`, 'x-title': 'annai', 'http-referer': 'https://annai.guide' });
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await server.stop();
  }
});

test("OpenRouter added from Add a provider with a key: one provider whose chat, transcription and voice share its address and key; speech behind the phone's own; their Tests work", async ({ page }) => {
  const server = await startModelServer({ '/api/v1/audio/speech': wav, '/api/v1/audio/transcriptions': heard });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await pickProvider(page, 'OpenRouter');
    await expect(page.getByRole('link', { name: 'Get a key' })).toHaveAttribute('href', 'https://openrouter.ai/settings/keys');
    for (const ability of ['Chat', 'Transcription', 'Voice']) await expect(page.getByLabel(`Use ${ability}`)).toBeChecked();
    // Its one address: the stand-in, for every ability.
    await page.getByLabel('Address', { exact: true }).fill(`${server.origin}/api/v1`);
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue(`${server.origin}/api/v1`);
    await page.getByRole('link', { name: '← Models' }).click();
    await expect(roleItems(page, IN)).toHaveText(PHONE_IN);
    await expect(roleItems(page, OUT)).toHaveText(PHONE_OUT);
    expect(await secretIds(page)).toHaveLength(1);
    await testBoth(page);
    expect(server.bodies('/api/v1/audio/speech')[0]).toMatchObject({ model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', response_format: 'mp3' });
    expect(Buffer.from(server.bodies('/api/v1/audio/transcriptions')[0]).toString('latin1')).toContain('openai/whisper-large-v3-turbo');
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await server.stop();
  }
});

/**
 * Chromium dressed as an iPhone Home Screen app, so OpenRouter can be stood in for on the code path
 * (WebKit can't route a page's requests while a service worker controls it). OpenRouter's key exchange
 * takes a code only with the verifier of the challenge its sign-in page was last opened with.
 * @param {import('@playwright/test').Page} page @param {{ refuseFirst?: boolean }} [o]
 */
async function iPhoneSignIn(page, { refuseFirst = false } = {}) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', configurable: true });
  });
  /** @type {string[]} */
  const opened = [];
  await page.context().route('https://openrouter.ai/auth**', (route) => {
    opened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Your code</p>' });
  });
  let asked = 0;
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { code_verifier: verifier } = route.request().postDataJSON();
    const fits = createHash('sha256').update(verifier).digest('base64url') === new URL(opened.at(-1) ?? 'http://x/').searchParams.get('code_challenge');
    if ((refuseFirst && asked++ === 0) || !fits) return route.fulfill({ status: 403, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: { code: 403, message: 'Invalid code or code_verifier' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key: KEY }) });
  });
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  const link = page.getByRole('link', { name: 'Sign in with OpenRouter' });
  await expect(link).toHaveAttribute('href', /^https:\/\/openrouter\.ai\/auth\?/);
  return {
    link,
    /** Taps the link: OpenRouter opens, and the user comes back. */
    tap: async () => {
      const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      await popup.close();
    },
    /** @param {string} code */
    paste: async (code) => {
      await page.getByLabel('Paste the code OpenRouter showed you').fill(code);
      await page.getByRole('button', { name: 'Connect' }).click();
    },
    /** Time passes: the sign-in waiting is made older. @param {number} minutes */
    age: (minutes) => page.evaluate((ms) => {
      const s = JSON.parse(/** @type {string} */ (localStorage.getItem('annai.openrouter')));
      localStorage.setItem('annai.openrouter', JSON.stringify({ ...s, at: s.at - ms }));
    }, minutes * 60_000),
  };
}

test("iPhone Home Screen app: Models left open longer than annai's 15 minutes still takes the code a tap brings back (fix pass)", async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', "Playwright can't stand in for OpenRouter's key exchange in WebKit");
  const s = await iPhoneSignIn(page);
  await s.age(20);
  await s.tap();
  await s.paste('fresh-code');
  await expect(page.locator('.notice', { hasText: 'Signed in with OpenRouter' })).toBeVisible({ timeout: 30_000 });
});

test('iPhone Home Screen app: after a refused code and then annai\'s 15 minutes, the paste box goes and the next tap brings a new sign-in whose code works (fix pass)', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', "Playwright can't stand in for OpenRouter's key exchange in WebKit");
  const s = await iPhoneSignIn(page, { refuseFirst: true });
  await s.tap();
  await s.paste('typo');
  await expect(page.getByText('a code works once, for 10 minutes')).toBeVisible();
  await expect(page.getByLabel('Paste the code OpenRouter showed you')).toBeVisible();
  const before = await s.link.getAttribute('href');
  await s.age(16);
  await s.paste('late-code');
  await expect(page.getByText('This sign-in has expired')).toBeVisible();
  await expect(page.getByLabel('Paste the code OpenRouter showed you')).toBeHidden();
  await expect(s.link).not.toHaveAttribute('href', /** @type {string} */ (before));
  await s.tap();
  await s.paste('new-code');
  await expect(page.locator('.notice', { hasText: 'Signed in with OpenRouter' })).toBeVisible({ timeout: 30_000 });
});

test("OpenRouter's page has its plugin's sign-in in the key's place, the key field after it; Sign in again keeps the new key on that provider; its plugin page says it has code", async ({ page, browserName }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'OpenRouter');
  const conn = page.getByRole('region', { name: 'Provider' });
  await expect(conn.getByText('Sign in with OpenRouter for a key, or give one below.')).toBeVisible();
  await expect(conn.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeVisible();
  await conn.getByLabel('API key').fill('sk-or-typed-key-123');
  await conn.getByRole('button', { name: 'Save' }).click();
  await expect(conn.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  await expect(conn.getByText('Sign in again for a new key, in place of the one saved.')).toBeVisible();
  await page.goto('/#/plugins/provider-openrouter');
  await expect(page.getByText(/^A model provider · has code · version 2\.1\.2/)).toBeVisible();
  if (browserName === 'webkit') return; // WebKit can't stand in for OpenRouter's sign-in; the unit tests cover the rest
  let authUrl = '';
  await page.route('https://openrouter.ai/auth**', (route) => {
    authUrl = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>OpenRouter</p>' });
  });
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key: KEY }) });
  });
  await page.goto('/#/models');
  await page.getByRole('link', { name: /^OpenRouter/ }).click();
  await page.getByRole('region', { name: 'Provider' }).getByRole('button', { name: 'Sign in again' }).click();
  await expect.poll(() => authUrl).toContain('code_challenge_method=S256');
  await page.goto(`/?code=test-code&state=${new URL(authUrl).searchParams.get('state')}`);
  await expect(page.locator('.notice', { hasText: 'Signed in with OpenRouter' })).toContainText('annai keeps the new key');
  await expect(page.getByRole('region', { name: 'Providers' }).getByRole('listitem')).toHaveCount(1);
  expect(await secretIds(page)).toHaveLength(1);
  const kept = await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const store = await createIdbStore();
    const ids = await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.listSecretIds());
    const value = await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(ids[0]));
    store.close();
    return value;
  });
  expect(kept).toBe(KEY);
});
