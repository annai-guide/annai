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

test('spoken words stay hidden unless asked: folded in the conversation, and shown over the dock on request (spec §2, §16.1, §16.2)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': sse(anthropicToolReply([{ name: 'speak', input: { text: 'Nepenthe is 25 minutes south.' } }, { name: 'sleep', input: {} }])),
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
    await page.goto('/#/trips'); // the Models screen has a Send button of its own
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where should we eat?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(1);
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk', { timeout: 20_000 });
    const said = page.locator('.convo .shiori.said');
    await expect(said).toContainText('Said aloud');
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeHidden();
    await said.getByRole('button', { name: 'Show what she said' }).click();
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeVisible();
    const caption = page.locator('.dock .caption');
    await expect(caption).toBeHidden();
    await page.getByRole('button', { name: "Show what she's saying" }).click();
    await expect(caption).toHaveText('Nepenthe is 25 minutes south.');
  } finally {
    await server.stop();
  }
});
