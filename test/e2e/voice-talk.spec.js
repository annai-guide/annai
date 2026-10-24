import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, fakeMicrophone, filterTrace, savedBy } from './helpers.js';
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
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-chat-test', model: 'b-model' });
    await addProvider(page, 'Custom provider', { ability: 'Transcription', name: 'Ears', url: `${server.origin}/ears`, key: 'sk-ears-test', model: 'ears' });
    await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'Voice', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'voice' });
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

/** A voice clip of seconds, so there is time to cut her off. @param {number} seconds */
const longWav = (seconds) => ({ status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) });

/** Endpoints for a spoken exchange: main, ears, voice (and a quick-decision model). @param {import('@playwright/test').Page} page @param {string} origin @param {{ decide?: boolean }} [o] */
async function setUpVoice(page, origin, { decide = false } = {}) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-chat-test', model: 'b-model' });
  await addProvider(page, 'Custom provider', { ability: 'Transcription', name: 'Ears', url: `${origin}/ears`, key: 'sk-ears-test', model: 'ears' });
  await addProvider(page, 'Custom provider', { ability: 'Voice', name: 'Voice', url: `${origin}/voice`, key: 'sk-voice-test', model: 'voice' });
  if (decide) await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Decider', url: `${origin}/d`, key: 'sk-decide-test', model: 'd-model' });
  /** @type {[string, string][]} */
  const roles = [['main', 'b-model'], ['speech-in', 'ears'], ['speech-out', 'voice'], ...(decide ? [/** @type {[string, string]} */ (['decide', 'd-model'])] : [])];
  for (const [role, model] of roles) {
    await page.getByLabel(`Add a model to ${role}`).selectOption({ label: model });
    await page.getByRole('button', { name: `Add to ${role}` }).click();
    await expect(page.getByLabel(`Add a model to ${role}`).locator('option', { hasText: model })).toHaveCount(0);
  }
  await page.locator('.voice-chip').click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(page.locator('.voice-chip')).toHaveText('Voice on');
  await page.goto('/#/trips'); // the Models screen has a Send button of its own
}

test('cutting her off: a tap stops her mid-sentence and listens; she hears where she was stopped (spec §10.4)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead. It opened in 1932, and it was one of the tallest bridges of its kind.' } }])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'The beach it is.' } }, { name: 'sleep', input: {} }])),
    ],
    '/ears/audio/transcriptions': json({ text: 'Tell me about the beach instead.' }),
    '/voice/audio/speech': longWav(3),
  });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        /** @type {any} */ (window).__voice = this; // the element her voice plays on
        return play.call(this);
      };
    });
    await setUpVoice(page, server.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('What is ahead?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const label = page.locator('.talk-label');
    await expect(label).toHaveText('Tap to interrupt', { timeout: 20_000 });
    // Mid-sentence is when her voice has played a while by its own clock: 0.8 s of the 3 s clip, past the first words of the sentence (a wait
    // of the test's, 800 ms, is not that on a slow machine, where the tap came before she had said anything).
    await page.waitForFunction(() => /** @type {any} */ (window).__voice?.currentTime > 0.8);
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(label).toHaveText('Tap to talk', { timeout: 30_000 });
    const [, second] = server.bodies('/b/v1/messages');
    const answer = JSON.stringify(second.messages.at(-1));
    expect(answer).toContain('The user stopped you after:');
    expect(answer).toContain('Tell me about the beach instead.');
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(1);
  } finally {
    await server.stop();
  }
});

test('chatter: with a quick-decision model, talk that is not for her is recorded, and she sleeps (spec §10.4)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead.' } }])), sse(anthropicToolReply([{ name: 'sleep', input: {} }]))],
    '/d/v1/messages': sse(anthropicToolReply([{ name: 'decide', input: { option: 'B' } }])),
    '/ears/audio/transcriptions': json({ text: 'Can you pass the water?' }),
    '/voice/audio/speech': wav,
  });
  try {
    await fakeMicrophone(page, [clipPath('gas-station')]);
    await setUpVoice(page, server.origin, { decide: true });
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('What is ahead?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const label = page.locator('.talk-label');
    await expect(label).not.toHaveText('Tap to talk');
    await expect(label).toHaveText('Tap to talk', { timeout: 30_000 });
    expect(server.bodies('/b/v1/messages')).toHaveLength(1);
    expect(JSON.stringify(server.bodies('/d/v1/messages')[0].messages)).toContain('Can you pass the water?');
    await expect(page.locator('.convo .system-line').filter({ hasText: 'Heard, not for Shiori' })).toHaveText('Heard, not for Shiori: Can you pass the water?');
  } finally {
    await server.stop();
  }
});

test("kept voice clips: kept as the smallest file the phone makes and plays, played from the Trace; the player lets the clip's address go when it leaves (spec §10.2, §10.6)", async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Noted.' } }, { name: 'sleep', input: {} }]))],
    '/ears/audio/transcriptions': json({ text: 'Dinner is at half past six.' }),
    '/voice/audio/speech': wav,
  });
  try {
    await fakeMicrophone(page, [clipPath('where-eat')]);
    await setUpVoice(page, server.origin);
    await page.goto('/#/voice');
    const keep = page.getByLabel('Keep voice clips');
    await keep.check();
    await expect(savedBy(keep)).toHaveText('Saved');
    await page.goto('/#/talk');
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length, { timeout: 30_000 }).toBe(1);
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Conversation' });
    const heard = page.locator('.trace li').filter({ hasText: 'clip kept' }).first();
    // Both browsers make Opus and play Ogg.
    await expect(heard.locator('.d')).toHaveText(/ · clip kept: ogg, \d+(\.\d)? kB$/);
    await heard.locator('summary').click();
    await heard.getByRole('button', { name: 'Show what was stored' }).click();
    const src = String(await heard.locator('audio').getAttribute('src'));
    expect(src).toMatch(/^blob:/);
    /** Whether an audio element can still load the clip's address. */
    const loads = () => page.evaluate((u) => new Promise((resolve) => {
      const a = new Audio();
      a.onloadedmetadata = () => resolve('loads');
      a.onerror = () => resolve('let go');
      a.src = u;
    }), src);
    expect(await loads()).toBe('loads');
    await page.goto('/#/talk');
    await expect.poll(loads).toBe('let go');
  } finally {
    await server.stop();
  }
});
