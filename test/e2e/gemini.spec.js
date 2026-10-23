import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, pickProvider, savedBy, leaveSaved, fakeMicrophone, filterTrace, startTrip } from './helpers.js';
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
    // Koe's two lists: Gemini Live in Realtime, flash-lite in Classic (the user, 2026-10-22).
    await page.goto('/#/models');
    const roles = page.getByRole('region', { name: 'Roles' });
    await expect(roles.locator('.role').nth(1).locator('.role-item')).toHaveText([/^1\. Gemini 3\.8 Live/]);
    await expect(roles.locator('.role').nth(2).locator('.role-item')).toHaveText([/^1\. Gemini 3\.5 Flash Lite/]);
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
    expect(voiceBodies()[0]).toMatchObject({ stream: true, store: false, response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 }, generation_config: { speech_config: [{ voice: 'Sulafat' }] } });
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

// Google Search (G4): the grounded answer as Google gave it, in a card of its own; Google's suggestions in a sandboxed frame.
const GROUNDED = 'Nepenthe closes at 10:00 PM tonight; the kitchen stops at 9:30.';
// With a handler of the kind the frame's own policy must stop (no script runs there but its own).
const SUGGESTIONS = '<style>.chip { border: solid 1px; border-radius: 16px; padding: 5px 16px; }</style><div class="container"><a class="chip" href="https://www.google.com/search?q=Nepenthe+hours">Nepenthe hours</a><img src="data:," alt="" onerror="document.body.dataset.ran = \'yes\'"></div>';
const SEARCH = { queries: ['Nepenthe hours', 'Nepenthe Big Sur closing time'], suggestions: SUGGESTIONS, links: [{ url: 'https://nepenthe.example/hours', title: 'nepenthe.example' }, { url: 'https://bigsur.example/eat', title: 'bigsur.example' }] };
/** The tools a request offered, by name or type. @param {any} b */
const offered = (b) => (b.tools ?? []).map((/** @type {any} */ t) => t.name ?? t.type);

/** Google Gemini at the stand-in's address, then a trip. @param {import('@playwright/test').Page} page @param {string} url */
async function geminiTrip(page, url) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'Google Gemini');
  await page.getByLabel('Address', { exact: true }).fill(url);
  await page.getByLabel('API key').fill(KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function type(page, text) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The card's checks: Google's words as they came, its links plain, its suggestions in a frame that can't reach annai. @param {import('@playwright/test').Page} page */
async function cardShown(page) {
  const card = page.locator('.convo .grounded');
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card.locator('.card-title')).toHaveText('From Google Search');
  await expect(card.locator('p')).toHaveText(GROUNDED);
  const links = card.locator('.sources a');
  await expect(links).toHaveText(['nepenthe.example', 'bigsur.example']);
  for (const [i, url] of ['https://nepenthe.example/hours', 'https://bigsur.example/eat'].entries()) {
    await expect(links.nth(i)).toHaveAttribute('href', url);
    await expect(links.nth(i)).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(links.nth(i)).toHaveAttribute('target', '_blank');
  }
  const frame = card.locator('iframe[sandbox]');
  await expect(frame).toHaveAttribute('src', '/src/ui/grounding.html');
  expect((await frame.getAttribute('sandbox'))?.split(/\s+/)).not.toContain('allow-same-origin');
  const inside = page.frameLocator('.convo .grounded iframe');
  await expect(inside.getByRole('link', { name: 'Nepenthe hours' })).toHaveAttribute('href', 'https://www.google.com/search?q=Nepenthe+hours');
  await expect(inside.locator('img')).toHaveCount(1);
  await expect(inside.locator('body[data-ran]'), "the frame's policy runs no handler in Google's HTML").toHaveCount(0);
  // The frame sized itself to the suggestions.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(10);
}

test('Google Search (G4): Shiori\'s request offers it; a grounded reply shows "From Google Search" with the words as Google gave them, the links plain and the suggestions in a sandboxed frame; the provider page\'s switch, off with the free tier', async ({ page }) => {
  let searched = 0;
  // Shiori searches, writes her answer for the user (shown as written), and says a shorter one.
  const s = await startGeminiServer({ key: KEY, replies: [(b) => (offered(b).includes('google_search') && !searched++
    ? { text: GROUNDED, search: SEARCH, calls: [{ name: 'speak', input: { text: 'It closes at ten tonight.' } }, { name: 'sleep', input: {} }] }
    : { calls: [{ name: 'speak', input: { text: 'Any time.' } }, { name: 'sleep', input: {} }] })] });
  try {
    await geminiTrip(page, s.url);
    // The switch: on by default, with what it costs and what Google keeps.
    const chat = page.getByRole('region', { name: 'Chat', exact: true });
    const search = chat.getByLabel('Let Gemini search Google');
    await expect(search).toBeChecked();
    await expect(search).toBeEnabled();
    await expect(chat.getByText(/^Google gives 5,000 searches a month free on paid projects, then \$14 per 1,000: annai counts this phone's\. Google keeps searched prompts for 30 days, which annai can't delete\.$/)).toBeVisible();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');
    await type(page, 'Is Nepenthe open tonight?');
    await cardShown(page);
    await expect(page.locator('.convo .shiori p').filter({ hasText: 'It closes at ten tonight.' })).toBeVisible();
    const asked = s.bodies().find((b) => offered(b).includes('google_search'));
    expect(asked, "Shiori's turn offers Google's search").toBeTruthy();
    expect(offered(asked)).not.toContain('web_search');
    expect(asked.system_instruction, 'she is told the reply that searched is shown as written').toContain('A reply in which you search with Google Search is shown to the user as you write it, under "From Google Search", with its sources. Write that reply for the user, with no private notes in it.');
    // A height from anything but its frame changes nothing; a frame that loads a second time goes, and the card stays.
    const frame = page.locator('.convo .grounded iframe');
    const tall = (await frame.boundingBox())?.height;
    await page.evaluate(() => new Promise((done) => {
      addEventListener('message', function after(e) { if (e.data === 'after') { removeEventListener('message', after); done(undefined); } });
      postMessage({ height: 300 }, '*');
      postMessage('after', '*');
    }));
    expect((await frame.boundingBox())?.height).toBe(tall);
    await page.evaluate(() => document.querySelector('.convo .grounded iframe')?.setAttribute('src', '/src/ui/grounding.html'));
    await expect(frame).toHaveCount(0);
    await expect(page.locator('.convo .grounded p')).toHaveText(GROUNDED);
    // The next turn continues the one Google kept, its search and all; the card goes to no model.
    await type(page, 'Thanks!');
    await expect.poll(() => s.bodies().length, { timeout: 30_000 }).toBeGreaterThan(s.bodies().indexOf(asked) + 1);
    const next = s.bodies().at(-1);
    expect(next.previous_interaction_id).toBeTruthy();
    expect(JSON.stringify(next.input)).not.toContain('From Google Search');
    expect(JSON.stringify(next.input)).not.toContain('attribution');
    await expect(page.locator('.convo .grounded')).toHaveCount(1);

    // The free tier: the switch is off, and says why; Shiori's turns no longer offer it.
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    const free = page.getByLabel("This key is on the free tier (Google doesn't charge)");
    await free.check();
    await expect(savedBy(free)).toHaveText('Saved');
    await expect(search).not.toBeChecked();
    await expect(search).toBeDisabled();
    await expect(chat.getByText("Google doesn't offer search on the free tier.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    await expect(search).toBeDisabled();
    await expect(search).not.toBeChecked();
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Conversation' })).toBeVisible();
    const before = s.bodies().length;
    await type(page, 'And tomorrow?');
    await expect.poll(() => s.bodies().length, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(s.bodies().slice(before).some((b) => offered(b).includes('google_search')), 'a free key never offers it').toBe(false);
    expect(offered(s.bodies().at(-1))).toContain('web_search');
    expect(s.bodies().at(-1).system_instruction).not.toContain('is shown to the user as you write it');
    // Off the free tier again, the switch is as it was.
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.locator('a.card', { hasText: 'Google Gemini' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Google Gemini' })).toBeVisible();
    await free.uncheck();
    await expect(savedBy(free)).toHaveText('Saved');
    await expect(search).toBeEnabled();
    await expect(search).toBeChecked();
  } finally {
    await s.close();
  }
});

test('Google Search with Koe on and the halves\' notes hidden: Kokoro\'s grounded answer still shows as "From Google Search", and Koe says it in her own words', async ({ page }) => {
  let koe = 0;
  let searched = 0;
  const s = await startGeminiServer({ key: KEY, replies: [(b) => {
    const tools = offered(b);
    if (tools.includes('tell_kokoro')) {
      koe++;
      if (koe === 1) return { calls: [{ name: 'speak', input: { text: 'Let me check.' } }, { name: 'tell_kokoro', input: { text: 'Is Nepenthe open tonight?' } }, { name: 'sleep', input: {} }] };
      if (koe === 2) return { calls: [{ name: 'speak', input: { text: "Good news: it's open until ten." } }, { name: 'sleep', input: {} }] };
      return { calls: [{ name: 'sleep', input: {} }] };
    }
    // Kokoro searches once, and answers in words alone: they reach Koe as a note.
    return tools.includes('google_search') && !searched++ ? { text: GROUNDED, search: SEARCH } : { calls: [{ name: 'sleep', input: {} }] };
  }] });
  try {
    await geminiTrip(page, s.url);
    await page.goto('/#/models');
    await page.getByLabel('Add a model to Koe · Classic').selectOption({ label: 'Gemini 3.5 Flash Lite' });
    await page.getByRole('button', { name: 'Add to Koe · Classic' }).click();
    await expect(page.getByRole('region', { name: 'Roles' }).locator('.role').nth(2).getByText('1. Gemini 3.5 Flash Lite')).toBeVisible();
    await page.goto('/#/trips');
    await startTrip(page, 'Big Sur');
    await type(page, 'Is Nepenthe open tonight?');
    await expect(page.locator('.convo .shiori p').last()).toHaveText("Good news: it's open until ten.", { timeout: 30_000 });
    await cardShown(page);
    await expect(page.getByLabel('Show what the halves tell each other')).not.toBeChecked();
    await expect(page.locator('.convo .system-line')).toHaveCount(0);
    expect(s.bodies().filter((b) => offered(b).includes('tell_kokoro')).every((b) => !offered(b).includes('google_search')), "Koe's quick turns never search").toBe(true);
    expect(s.bodies().find((b) => offered(b).includes('google_search')).system_instruction, 'Kokoro writes for Koe, as before').not.toContain('is shown to the user as you write it');
  } finally {
    await s.close();
  }
});
