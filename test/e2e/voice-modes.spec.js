import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** Audio devices with names, as a phone gives them once the microphone is allowed. @param {import('@playwright/test').Page} page @param {string[]} labels */
async function fakeDevices(page, labels) {
  await page.addInitScript((names) => {
    if (typeof MediaDevices === 'undefined') return;
    MediaDevices.prototype.enumerateDevices = async () => /** @type {any} */ (names.map((label, i) => ({ kind: 'audioinput', label, deviceId: String(i), groupId: String(i) })));
  }, labels);
}

test('the voice chip: Auto turns voice on with headphones; On and Off are one tap away; the dock grows with voice (spec §10.5, §16.2)', async ({ page }) => {
  await fakeDevices(page, ['iPhone Microphone', 'AirPods Pro']);
  await openApp(page, '#/trips');
  const chip = page.locator('.voice-chip');
  await expect(chip).toHaveText('Voice on · headphones');
  await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' }).click();
  await expect(chip).toHaveText('Voice off');
  await expect(page.locator('nav.dock')).not.toHaveClass(/\bvoice\b/);
  await chip.click();
  await expect(page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(chip).toHaveText('Voice on');
  await page.goto('/#/voice');
  await expect(page.getByRole('radio', { name: 'On', exact: true })).toBeChecked();
});

test('the voice menu says it pops up, and a tap elsewhere closes it', async ({ page }) => {
  await fakeDevices(page, ['iPhone Microphone', 'AirPods Pro']);
  await openApp(page, '#/trips');
  const chip = page.locator('.voice-chip');
  const menu = page.getByRole('group', { name: 'Voice' });
  await expect(chip).toHaveAttribute('aria-haspopup', 'true');
  await chip.click();
  await expect(menu).toBeVisible();
  await expect(chip).toHaveAttribute('aria-controls', String(await menu.getAttribute('id')));
  await page.getByRole('heading', { name: 'Trips', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  // A tap inside it still chooses.
  await chip.click();
  await menu.getByRole('button', { name: 'Off' }).click();
  await expect(chip).toHaveText('Voice off');
});

test('where annai cannot tell what audio is connected, Auto follows your last choice (spec §10.5)', async ({ page }) => {
  await fakeDevices(page, ['', '']);
  await openApp(page, '#/trips');
  const chip = page.locator('.voice-chip');
  await expect(chip).toHaveText('Voice auto · off');
  await chip.click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(chip).toHaveText('Voice on');
  await chip.click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Auto' }).click();
  await expect(chip).toHaveText('Voice on · your last choice');
});

/** Her one spoken line, from a stand-in model and a stand-in voice; fn runs with the page on Trips and voice on. */
async function sheSpeaks(/** @type {import('@playwright/test').Page} */ page, /** @type {(server: Awaited<ReturnType<typeof startModelServer>>) => Promise<void>} */ fn, /** @type {() => Promise<void>} */ before = async () => {}, /** @type {string} */ words = 'Nepenthe is 25 minutes south.') {
  const server = await startModelServer({
    '/b/v1/messages': sse(anthropicToolReply([{ name: 'speak', input: { text: words } }, { name: 'sleep', input: {} }])),
    '/voice/audio/speech': wav,
  });
  try {
    await fakeDevices(page, ['Toyota Camry']);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-chat-test', model: 'b-model' });
    await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'Voice', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'voice' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText('1. b-model')).toBeVisible();
    await page.getByLabel('Add a model to speech-out').selectOption({ label: 'voice' });
    await page.getByRole('button', { name: 'Add to speech-out' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · car audio');
    await before();
    await page.goto('/#/talk'); // the Models screen has a Send button of its own
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      // The bubble above Shiori: the words it showed while she was speaking ("Tap to interrupt"), if it ever did.
      const caption = /** @type {HTMLElement} */ (document.querySelector('.dock .caption'));
      const label = /** @type {HTMLElement} */ (document.querySelector('.dock .talk-label'));
      w.sawBubble = '';
      const look = () => { if (!caption.hidden && label.textContent === 'Tap to interrupt' && caption.textContent) { w.sawBubble = caption.textContent; w.sawBubbleLook = { lang: caption.getAttribute('lang'), dir: caption.getAttribute('dir'), style: getComputedStyle(caption).fontStyle }; } };
      for (const el of [caption, label]) new MutationObserver(look).observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
      // What the conversation's announcer said, each time.
      const announcer = /** @type {HTMLElement} */ (document.querySelector('main [aria-live="polite"]'));
      w.announced = [];
      new MutationObserver(() => w.announced.push(announcer.textContent)).observe(announcer, { childList: true, characterData: true, subtree: true });
    });
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where should we eat?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(1);
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk', { timeout: 20_000 });
    await fn(server);
  } finally {
    await server.stop();
  }
}

// "for the shiori said aloud card, it is a bit redundant ... maybe let's just show what she is speaking? this also let us able to remove the
// captions button?" and "I still want the transcript of what she said available to look back if I missed it" (the user, 2026-10-23)
test('what she says aloud is shown: its words in the conversation, marked "said aloud", and in the bubble over the dock while she speaks, with no Captions chip (spec §2, §16.1, §16.2)', async ({ page }) => {
  await sheSpeaks(page, async () => {
    const said = page.locator('.convo .shiori.said');
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeVisible();
    await expect(said.getByText('said aloud')).toBeVisible();
    await expect(said.getByRole('button', { name: 'Show what she said' })).toHaveCount(0);
    // Quieter than a line she wrote or the user's (the user, 2026-10-23: the bubble above her is where they are read live): smaller and muted.
    const look = (/** @type {import('@playwright/test').Locator} */ l) => l.evaluate((el) => { const s = getComputedStyle(el); return { size: Number.parseFloat(s.fontSize), color: s.color }; });
    const quiet = await look(said.locator('p'));
    const loud = await look(page.locator('.convo .you p').first());
    expect(quiet.size).toBeLessThan(loud.size);
    expect(quiet.color).not.toBe(loud.color);
    expect(await page.evaluate(() => /** @type {any} */ (window).sawBubble), 'the bubble held her words while she spoke').toBe('Nepenthe is 25 minutes south.');
    expect((await page.evaluate(() => /** @type {any} */ (window).sawBubbleLook)).style, 'English in the bubble stays slanted, with no language of its own').toBe('italic');
    await expect(page.locator('.dock .caption')).toHaveText('Nepenthe is 25 minutes south.');
    await expect(page.getByRole('button', { name: 'Captions' })).toHaveCount(0);
    // One route for a screen reader (fix pass 2, item 10): the conversation's announcer says her spoken line once; the list holding the same
    // words is not live, and the bubble is no live region.
    expect(await page.evaluate(() => /** @type {any} */ (window).announced.filter((/** @type {string} */ t) => t.includes('Nepenthe is 25 minutes south.')))).toEqual(['Shiori: Nepenthe is 25 minutes south.']);
    expect(await page.evaluate(() => !!document.querySelector('.convo .shiori.said')?.closest('[aria-live]:not([aria-live="off"])'))).toBe(false);
    await expect(page.locator('.dock .caption')).toHaveAttribute('aria-live', 'off');
    // It lets go a moment after she stops.
    await expect(page.locator('.dock .caption')).toBeHidden({ timeout: 8000 });
    // The transcript stays: the line is still there to look back on.
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeVisible();
  });
});

// Localization L3: the bubble carries the language of her words, so a Japanese line is drawn with Japanese shapes and not slanted.
test('her words in the bubble carry their language: a Japanese line is "ja" and upright, an English one is slanted', async ({ page }) => {
  await sheSpeaks(page, async () => {
    expect(await page.evaluate(() => /** @type {any} */ (window).sawBubbleLook)).toEqual({ lang: 'ja', dir: 'auto', style: 'normal' });
    await expect(page.locator('.convo .said p')).toHaveAttribute('lang', 'ja');
  }, async () => {}, '直角三角形の骨組みです。');
});

test('"Show what she says" in Settings → Voice is on, and off it hides both: the bubble, and the words in the conversation until asked', async ({ page }) => {
  await sheSpeaks(page, async () => {
    expect(await page.evaluate(() => /** @type {any} */ (window).sawBubble), 'no bubble').toBe('');
    // Her words still reach a screen reader, once, through the conversation's announcer (fix pass 2, item 10).
    expect(await page.evaluate(() => /** @type {any} */ (window).announced.filter((/** @type {string} */ t) => t.includes('Nepenthe is 25 minutes south.')))).toEqual(['Shiori: Nepenthe is 25 minutes south.']);
    await expect(page.getByRole('button', { name: 'Captions' })).toHaveCount(0);
    const said = page.locator('.convo .shiori.said');
    await expect(said).toContainText('Said aloud');
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeHidden();
    await said.getByRole('button', { name: 'Show what she said' }).click();
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeVisible();
    await page.goto('/#/voice');
    await expect(page.getByLabel('Show what she says')).not.toBeChecked();
  }, async () => {
    await page.goto('/#/voice');
    const show = page.getByLabel('Show what she says');
    await expect(show).toBeChecked();
    await show.uncheck();
    await expect(page.locator('.saving', { hasText: 'Show what she says' }).locator('.saved')).toHaveText('Saved');
  });
});
