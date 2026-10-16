import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, fakeMicrophone } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const json = (/** @type {any} */ o) => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });

test('a spoken back-and-forth: tap, ask aloud, hear her answer, answer her, and she goes back to sleep (spec §10)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'There is a taco stand two miles ahead. Want to stop there?' } }])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Great, I will tell you when to turn.' } }, { name: 'sleep', input: {} }])),
    ],
    '/ears/audio/transcriptions': [json({ text: 'Where should we eat?' }), json({ text: 'Yes, the first one.' })],
    '/voice/audio/speech': wav,
  });
  try {
    await fakeMicrophone(page, [clipPath('where-eat'), clipPath('first-one')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    // Every endpoint first: a role change re-renders the screen, and a choice made meanwhile is lost.
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-chat-test', model: 'b-model' });
    await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Ears', url: `${server.origin}/ears`, key: 'sk-ears-test', model: 'ears' });
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'voice' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText('1. b-model')).toBeVisible();
    await page.getByLabel('Add a model to speech-in').selectOption({ label: 'ears' });
    await page.getByRole('button', { name: 'Add to speech-in' }).click();
    await expect(page.getByText('2. ears')).toBeVisible(); // ahead of phone dictation, which comes last
    await page.getByLabel('Add a model to speech-out').selectOption({ label: 'voice' });
    await page.getByRole('button', { name: 'Add to speech-out' }).click();
    await expect(page.getByText('1. voice')).toBeVisible();
    await page.goto('/#/voice');
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    await expect(page.getByText('Voice is on.')).toBeVisible();
    await page.goto('/#/talk');
    const label = page.locator('.talk-label');
    await expect(label).toHaveText('Tap to talk');
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(label).not.toHaveText('Tap to talk');
    await expect.poll(() => server.bodies('/voice/audio/speech').length, { timeout: 30_000 }).toBe(3);
    await expect(label).toHaveText('Tap to talk', { timeout: 30_000 });
    expect(server.bodies('/ears/audio/transcriptions')).toHaveLength(2);
    const [first, second] = server.bodies('/b/v1/messages');
    expect(JSON.stringify(first.messages)).toContain('Where should we eat?');
    const answer = JSON.stringify(second.messages.at(-1));
    expect(answer).toContain('The user said:');
    expect(answer).toContain('Yes, the first one.');
    expect(server.bodies('/voice/audio/speech').map((/** @type {any} */ b) => b.input)).toEqual(['There is a taco stand two miles ahead.', 'Want to stop there?', 'Great, I will tell you when to turn.']);
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(2);
    await expect(page.locator('.convo .you')).toHaveText(['Where should we eat?', 'Yes, the first one.']);
    // Keep voice clips is off: nothing heard was kept as sound.
    const sounds = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('annai');
      open.onsuccess = () => {
        const all = open.result.transaction('blobs').objectStore('blobs').getAll();
        all.onsuccess = () => resolve(all.result.filter((/** @type {any} */ b) => String(b.type).startsWith('audio/')).length);
      };
    }));
    expect(sounds).toBe(0);
  } finally {
    await server.stop();
  }
});
