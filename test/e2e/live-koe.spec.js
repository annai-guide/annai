import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, addProvider, pickProvider, savedBy, leaveSaved, startModelServer, anthropicToolReply, fakeMicrophone, filterTrace } from './helpers.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

// Koe live (the Koe and Kokoro plan, K5): Gemini Live as Koe, against the stand-in realtime server, with a
// fake microphone; Kokoro on a stand-in Anthropic server. Both browsers.

const KEY = 'AIza-e2e-koe-live-stand-in-0123456789abcd';
const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
/** Seconds of a voice-like tone, as 24 kHz 16-bit PCM bytes. @param {number} seconds */
const voice = (seconds) => new Uint8Array(Int16Array.from({ length: Math.round(24_000 * seconds) }, (_, i) => Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 24_000) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / 24_000)))).buffer);
const usage = { promptTokenCount: 900, responseTokenCount: 40, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 600 }, { modality: 'AUDIO', tokenCount: 300 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 40 }] };
const sse = (/** @type {{ name: string, input: any }[]} */ calls) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply(calls) });
const sleep = { name: 'sleep', input: {} };

/** The two realtime providers, as their pages name them. */
const GEMINI = { provider: 'Google Gemini', key: KEY, ability: 'Live voice', address: (/** @type {string} */ o) => o, model: 'Gemini 3.8 Live' };
const OPENAI = { provider: 'OpenAI', key: 'sk-proj-e2e-koe-live-stand-in-0123456789abcdef', ability: 'Realtime voice', address: (/** @type {string} */ o) => `${o}/v1`, model: 'GPT Realtime 2.1' };

/**
 * Kokoro on Another address, then a realtime provider (Gemini by default) with its realtime voice at the stand-in, its
 * model in Koe's list, a trip, and voice on. @param {import('@playwright/test').Page} page @param {string} kokoro @param {string} live
 */
async function liveSetUp(page, kokoro, live, p = GEMINI) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Kokoro stand-in', url: `${kokoro}/kokoro`, key: 'sk-test-kokoro', model: 'kokoro-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'kokoro-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await expect(page.getByText('1. kokoro-model')).toBeVisible();
  await pickProvider(page, p.provider);
  await page.getByLabel('API key').fill(p.key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  const region = page.getByRole('region', { name: p.ability, exact: true });
  const use = region.getByLabel(`Use ${p.ability}`);
  await use.check();
  await expect(savedBy(use)).toHaveText('Saved', { timeout: 30_000 });
  const address = region.getByLabel('Its own address');
  await address.fill(p.address(live));
  await leaveSaved(address);
  await page.goto('/#/models');
  await page.getByLabel('Add a model to Koe').selectOption({ label: p.model });
  await page.getByRole('button', { name: 'Add to Koe' }).click();
  await expect(page.getByLabel('Add a model to Koe').locator('option', { hasText: new RegExp(`^${p.model.replace(/\./g, '\\.')}$`) })).toHaveCount(0);
  await expect(page.getByText('With voice off, a text model here answers before a live voice, whose sound nobody would hear.')).toBeVisible();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  await page.locator('.voice-chip').click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(page.locator('.voice-chip')).toHaveText('Voice on');
}

test('voice on, a tap: "Listening live"; a spoken question gets "checking" aloud and a tell_kokoro; Kokoro\'s answer arrives as <from_kokoro> text and is said; the microphone streamed only speech; voice off closes it; Trace shows the session, its data and cost, never the key', async ({ page }) => {
  const s = await startRealtimeServer({
    flavour: 'gemini', key: KEY,
    turns: [
      { heard: 'Is Nepenthe open now?', said: "I'm checking.", audio: voice(0.6), tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open now?' } }, usage },
      { said: "It's open until ten tonight.", audio: voice(0.8), usage },
    ],
  });
  const kokoro = await startModelServer({ '/kokoro/v1/messages': [sse([{ name: 'tell_koe', input: { text: 'Nepenthe is open until 22:00 tonight (nepenthe.com).' } }, sleep]), sse([sleep])] });
  try {
    await fakeMicrophone(page, [clipPath('where-eat')]);
    await liveSetUp(page, kokoro.origin, s.origin);
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Listening live');
    // Kokoro's note goes in once Koe's "checking" has played out, marked with this start's nonce.
    await expect.poll(() => s.received().filter((/** @type {any} */ m) => m.clientContent).length, { timeout: 30_000 }).toBe(1);
    const note = s.received().find((/** @type {any} */ m) => m.clientContent).clientContent.turns[0].parts[0].text;
    expect(note).toMatch(/^<from_kokoro id="[0-9a-f]{16}">Nepenthe is open until 22:00 tonight \(nepenthe\.com\)\.<\/from_kokoro>$/);
    const answer = s.received().find((/** @type {any} */ m) => m.toolResponse).toolResponse.functionResponses[0];
    expect([answer.name, answer.response, answer.scheduling]).toEqual(['tell_kokoro', { result: 'sent' }, 'SILENT']);
    // The microphone sent one sentence: activityStart, its audio, activityEnd; nothing while nobody spoke.
    const input = s.received().filter((/** @type {any} */ m) => m.realtimeInput).map((/** @type {any} */ m) => Object.keys(m.realtimeInput)[0]);
    expect(input[0]).toBe('activityStart');
    expect(input.filter((/** @type {string} */ x) => x === 'activityStart')).toHaveLength(1);
    expect(input.filter((/** @type {string} */ x) => x === 'activityEnd')).toHaveLength(1);
    expect(input.lastIndexOf('audio')).toBeLessThan(input.indexOf('activityEnd'));
    expect(input.filter((/** @type {string} */ x) => x === 'audio').length).toBeGreaterThan(5);
    const kokoroSaw = JSON.stringify(kokoro.bodies('/kokoro/v1/messages')[0].messages);
    expect(kokoroSaw).toContain('[heard]');
    expect(kokoroSaw).toContain('Is Nepenthe open now?');
    expect(kokoroSaw).toContain('[Koe asks]');
    expect(kokoroSaw).toContain('A live voice session opened');
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.locator('.convo .you')).toHaveText(['Is Nepenthe open now?']);
    const said = page.locator('.convo .shiori.said');
    await expect(said).toHaveCount(2, { timeout: 20_000 });
    await expect(said.nth(0)).toContainText("I'm checking.");
    await expect(said.nth(1)).toContainText("It's open until ten tonight.");
    await expect(page.locator('.convo .system-line').filter({ hasText: /Kokoro|Koe/ })).toHaveCount(0);
    // Voice off closes it, the microphone with it.
    await page.locator('.voice-chip').click();
    await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Voice off');
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(1);
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Models', type: 'live.session' });
    const closed = page.getByText(/live session closed · Gemini 3\.8 Live/).first();
    await expect(closed).toBeVisible({ timeout: 15_000 });
    await expect(closed).toContainText('voice off');
    await expect(closed).toContainText(/\d+ KB in, \d+ KB out · \$0\.\d+/);
    expect(await page.content()).not.toContain(KEY);
  } finally {
    await s.stop();
    await kokoro.stop();
  }
});

test('the page out of view: the session closes and the microphone stops; back in view, nothing listens until a tap (security review)', async ({ page }) => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [{ said: 'Hello.', audio: voice(0.3) }] });
  const kokoro = await startModelServer({ '/kokoro/v1/messages': sse([sleep]) });
  try {
    await fakeMicrophone(page, [clipPath('where-eat')]);
    await liveSetUp(page, kokoro.origin, s.origin);
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Listening live');
    /** @param {'hidden' | 'visible'} state */
    const view = (state) => page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await view('hidden');
    await expect(page.locator('.voice-chip')).toHaveText('Voice on');
    await view('visible');
    await page.waitForTimeout(500);
    await expect(page.locator('.voice-chip')).toHaveText('Voice on');
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(1);
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Models', type: 'live.session' });
    await expect(page.getByText(/live session closed · Gemini 3\.8 Live/).first()).toContainText('away');
  } finally {
    await s.stop();
    await kokoro.stop();
  }
});

// K6's plan, Task 3: the same conversation through OpenAI Realtime, against the stand-in's openai flavour.
test("OpenAI Realtime as Koe: the same conversation: \"Listening live\", a spoken question answered and passed to Kokoro, whose note goes in marked and is said; voice off closes it; the key never shows", async ({ page }) => {
  const usage = { input_tokens: 900, output_tokens: 40, input_token_details: { text_tokens: 600, audio_tokens: 300 }, output_token_details: { audio_tokens: 40 } };
  const s = await startRealtimeServer({
    flavour: 'openai', key: OPENAI.key,
    turns: [
      { heard: 'Is Nepenthe open now?', said: "I'm checking.", audio: voice(0.6), tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open now?' } }, usage },
      { said: "It's open until ten tonight.", audio: voice(0.8), usage },
    ],
  });
  const kokoro = await startModelServer({ '/kokoro/v1/messages': [sse([{ name: 'tell_koe', input: { text: 'Nepenthe is open until 22:00 tonight (nepenthe.com).' } }, sleep]), sse([sleep])] });
  try {
    await fakeMicrophone(page, [clipPath('where-eat')]);
    await liveSetUp(page, kokoro.origin, s.origin, OPENAI);
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Listening live');
    /** The text items annai sent. */
    const items = () => s.received().filter((/** @type {any} */ m) => m.type === 'conversation.item.create' && m.item.type === 'message').map((/** @type {any} */ m) => m.item.content[0].text);
    await expect.poll(() => items().length, { timeout: 30_000 }).toBe(1);
    expect(items()[0]).toMatch(/^<from_kokoro id="[0-9a-f]{16}">Nepenthe is open until 22:00 tonight \(nepenthe\.com\)\.<\/from_kokoro>$/);
    const answer = s.received().find((/** @type {any} */ m) => m.item?.type === 'function_call_output');
    expect(answer.item.output).toBe('sent');
    // One sentence of μ-law, committed at its end; nothing appended after it.
    const kinds = s.received().map((/** @type {any} */ m) => m.type);
    expect(kinds.filter((/** @type {string} */ k) => k === 'input_audio_buffer.commit')).toHaveLength(1);
    expect(kinds.filter((/** @type {string} */ k) => k === 'input_audio_buffer.append').length).toBeGreaterThan(5);
    expect(kinds.lastIndexOf('input_audio_buffer.append')).toBeLessThan(kinds.indexOf('input_audio_buffer.commit'));
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.locator('.convo .you')).toHaveText(['Is Nepenthe open now?']);
    const said = page.locator('.convo .shiori.said');
    await expect(said).toHaveCount(2, { timeout: 20_000 });
    await expect(said.nth(1)).toContainText("It's open until ten tonight.");
    await page.locator('.voice-chip').click();
    await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Voice off');
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Models', type: 'live.session' });
    const closed = page.getByText(/live session closed · GPT Realtime 2\.1/).first();
    await expect(closed).toBeVisible({ timeout: 15_000 });
    await expect(closed).toContainText('voice off');
    expect(await page.content()).not.toContain(OPENAI.key);
  } finally {
    await s.stop();
    await kokoro.stop();
  }
});
