import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, pickProvider } from './helpers.js';

// Opt-in: OpenRouter's real files API from the page, in Chromium and WebKit (spec §4.8), with your own key, a few cents at most.
// Skipped without the key; never in CI. The key goes into the page and nowhere else: no trace, video or screenshot is kept.
//   ANNAI_LIVE_OPENROUTER_KEY=sk-or-… npx playwright test openrouter-files-live
// On the served page: OpenRouter added with the key, its uploads switch on by default with its words and note; Test uploads
// the test photo, finds it in the list and deletes it; a photo goes to a model once and then by id, through annai's own call
// code in the page (each request from the browser, past OpenRouter's CORS check); then Remove deletes every upload of annai's
// there, and OpenRouter's list holds none.

const key = process.env.ANNAI_LIVE_OPENROUTER_KEY;
test.skip(!key, 'ANNAI_LIVE_OPENROUTER_KEY is not set');
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const BASE = 'https://openrouter.ai/api/v1';
const SWITCH = 'Upload photos to this provider (annai deletes each once it is 48 hours old, the next time annai starts or comes online)';
/** A request from here (not the page), tried again on a dropped connection (seen once from the container, 2026-11-14). @param {string} url @param {RequestInit} [init] */
async function ask(url, init = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { ...init, headers: { authorization: `Bearer ${key}` } });
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}
/** annai's own files in the key's workspace. */
async function ours() {
  const res = await ask(`${BASE}/files?limit=1000`);
  expect(res.status).toBe(200);
  const j = await res.json();
  return j.data.filter((/** @type {any} */ f) => /^annai-(?:[0-9a-f]{16}|test)\.[a-z0-9]+$/.test(f.filename));
}
/** What a run cut short left behind, deleted, so the next starts from none. */
async function cleanUp() {
  for (const f of await ours()) await ask(`${BASE}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
}
test.beforeEach(cleanUp);
test.afterEach(cleanUp);

test('OpenRouter for real: uploads on with their switch, Test deletes its photo, a photo goes by id from the page, and Remove leaves no upload', async ({ page }) => {
  test.setTimeout(300_000);
  expect(await ours(), 'nothing of annai’s there before').toEqual([]);
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'OpenRouter');
  await page.getByLabel('API key').fill(/** @type {string} */ (key));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  await expect(chat.getByLabel(SWITCH)).toBeChecked();
  await expect(chat.getByText(/Zero Data Retention doesn't cover stored files/)).toBeVisible();
  // Test: its upload, then the test photo found in OpenRouter's list and deleted, all from the page.
  await chat.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(chat.getByText(/✓ Photo uploads work: each photo is uploaded once, and annai deletes it after 48 hours \(it just deleted the test photo\)\./)).toBeVisible({ timeout: 90_000 });
  expect((await ours()).filter((f) => f.filename === 'annai-test.png')).toEqual([]);
  // A photo by id: annai's own call code in the page, its uploads kept in memory here.
  const data = (await readFile(new URL('../fixtures/llm/files/made-up-sign.webp', import.meta.url))).toString('base64');
  const r = await page.evaluate(async ({ key, data }) => {
    const at = (/** @type {string} */ p) => p;
    const { activate } = await import(at('/plugins-official/chat-completions/index.js'));
    const { sse } = await import(at('/src/core/llm/sse.js'));
    const { parsePartialJSON } = await import(at('/src/core/llm/partial-json.js'));
    const { retry } = await import(at('/src/core/llm/retry.js'));
    const { ProviderError, errorFromResponse } = await import(at('/src/core/llm/contract.js'));
    const { callOnce } = await import(at('/src/core/llm/call.js'));
    /** @type {any} */
    let type;
    activate({ providers: { register: (/** @type {any} */ x) => { type = x; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
    /** @type {Map<string, { id: string, expiresAt: number }>} */
    const held = new Map();
    const uploads = {
      get: async (/** @type {string} */ _e, /** @type {string} */ h) => held.get(h)?.id ?? null,
      expires: async (/** @type {string} */ _e, /** @type {string} */ h) => held.get(h)?.expiresAt ?? 0,
      set: async (/** @type {string} */ _e, /** @type {string} */ h, /** @type {string} */ id, /** @type {number} */ expiresAt) => { held.set(h, { id, expiresAt }); },
      forget: async () => held.clear(), isOff: () => false, off: () => {},
    };
    const endpoint = { id: 'live/chat', provider: 'live', ability: 'chat', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: { 'HTTP-Referer': 'https://annai.guide', 'X-Title': 'annai tests' }, tunables: { ...type.tunables, reasoningField: 'reasoning', uploads: true }, extraBody: {} };
    const model = { id: 'nano', provider: 'live', ability: 'chat', name: 'nano', providerId: 'openai/gpt-4.1-nano', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {} };
    /** @type {string[]} */
    const bodies = [];
    const watch = (/** @type {string} */ u, /** @type {any} */ i) => { if (u.endsWith('/chat/completions')) bodies.push(String(i.body)); return fetch(u, i); };
    const request = { messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data, hash: 'live-sign' }, { type: 'text', text: 'What text does the picture say? Quote it exactly, and nothing else.' }] }], maxOutput: 100 };
    const first = await callOnce({ type, endpoint, model, key, request, uploads, fetch: watch });
    const second = await callOnce({ type, endpoint, model, key, request, uploads, fetch: watch });
    return { texts: [first.text, second.text], ids: bodies.map((b) => /"file_id":"(or_file_[^"]+)"/.exec(b)?.[1] ?? null), inline: bodies.some((b) => b.includes(data.slice(0, 40))) };
  }, { key, data });
  expect(r.texts[0]).toMatch(/LYCHEE\s*9T27/i);
  expect(r.texts[1]).toMatch(/LYCHEE\s*9T27/i);
  expect(r.ids[0]).toBeTruthy();
  expect(r.ids[1]).toBe(r.ids[0]);
  expect(r.inline).toBe(false);
  const listed = await ours();
  expect(listed.map((f) => f.id)).toContain(r.ids[0]);
  // Remove: every upload of annai's in the workspace goes first, with the key.
  await page.getByRole('button', { name: 'Remove provider' }).click();
  await page.getByRole('button', { name: 'Tap again to remove it' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await ours()).length, { timeout: 20_000 }).toBe(0);
});
