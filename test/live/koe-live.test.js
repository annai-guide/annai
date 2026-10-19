// Opt-in: Koe live against the real Gemini Live API, with your own key (the Koe and Kokoro plan, K5). Never in CI.
//   GEMINI_KEY=… node --test test/live/koe-live.test.js
// Each test runs annai's own Halves and LiveKoe with gemini-3.8-live as Koe for talking, a scripted Kokoro, and a fake
// device whose voice plays in real time. What the model says varies: the checks are on what annai does around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from '../unit/agent-kit.js';
import { clip, quiet, cat } from '../unit/voice-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { ProviderError } from '../../src/core/llm/contract.js';

const KEY = process.env.GEMINI_KEY ?? '';
const skip = KEY ? false : 'GEMINI_KEY is not set';
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const HOURS = 'Nepenthe is open today until 22:00 (nepenthe.com).';

/** Waits for an async condition. @param {() => Promise<boolean>} fn */
async function soon(fn, ms = 40_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Shiori as two halves, Koe live on the real API; Kokoro answers any question of Koe's with the hours. @param {any} [koe] a typing model's script */
async function kit(koe) {
  const k = await agentKit([{ rules: [{ match: 'Koe (asks|notes)', reply: { delayMs: 2000, toolCalls: [{ name: 'tell_koe', input: { text: HOURS } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] }], {
    live: { origin: 'https://generativelanguage.googleapis.com', key: KEY, tunables: { proactive: true } }, voice: { speechIn: ['m-hear'] },
    agent: { secondMs: 1000 }, ...(koe ? { koe: { type: koe } } : {}),
  });
  k.platform.streamSpeed = 1; // her voice plays in real time
  await k.agent.idle();
  await k.voice.unlock();
  const said = async () => (await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data);
  const states = async () => (await k.events(['live.session'])).map((/** @type {any} */ e) => e.data.state);
  return { k, said, states, done: () => k.agent.hush('away') };
}

test('a spoken question: heard, answered aloud, and a question to Kokoro whose note goes in marked and is said in Koe\'s words', { skip }, async () => {
  const { k, said, done } = await kit();
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening, 15_000);
    k.platform.mic.feed(cat(quiet(0.3), await clip('where-lunch'), quiet(1)), 16_000);
    await soon(async () => (await k.events(['heard'])).length > 0);
    // Ask it something it must check, typed, so the test doesn't hang on what the model makes of lunch.
    k.agent.send('Is Nepenthe open right now?');
    await soon(async () => (await said()).some((s) => /10|ten|22/i.test(s.text)));
    await k.agent.idle();
    const notes = await k.events(['note']);
    assert.ok(notes.some((/** @type {any} */ e) => e.data.from === 'koe'), 'Koe asked Kokoro');
    assert.ok(notes.some((/** @type {any} */ e) => e.data.from === 'kokoro'), "and Kokoro's note came");
    const lines = await said();
    assert.ok(lines.every((s) => s.live && s.voice && !/kokoro|note/i.test(s.text)), JSON.stringify(lines));
  } finally {
    done();
  }
});

test('an immediate note cuts Koe off mid-sentence; its line is kept, cut, and Koe says the correction', { skip }, async () => {
  const { k, said, done } = await kit();
  try {
    k.agent.send('Tell me about Bixby Bridge, in three or four sentences.');
    await until(() => k.agent.live.view.name === 'speaking', 30_000);
    await new Promise((r) => setTimeout(r, 2000));
    await k.agent.channel.send('kokoro', 'Correction, with its source: Bixby Bridge is 714 feet long, and it opened on 15 November 1932 (Caltrans).', 'immediate', 'tool');
    await soon(async () => (await said()).length >= 2);
    await k.agent.idle();
    const [cut, fixed] = await said();
    assert.ok(cut.cut && cut.text.endsWith('✂'), JSON.stringify(cut));
    assert.match(fixed.text, /714|seven hundred|1932|nineteen thirty/i);
  } finally {
    done();
  }
});

test('a quiet spell closes the session; a trigger opens it again with its handle, says it, then listens', { skip }, async () => {
  const { k, said, states, done } = await kit();
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 10 } });
    k.agent.send('Hi, just say hello back in a few words.');
    await soon(async () => (await said()).length >= 1);
    await until(() => k.agent.live.state === 'closed', 40_000);
    await k.agent.wake({ kind: 'trigger', text: 'Sunset is in 30 minutes, at 18:40', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await soon(async () => (await said()).length >= 2);
    await k.agent.idle();
    assert.ok((await states()).includes('resumed'));
    assert.ok(k.agent.live.listening);
    assert.deepEqual(await k.events(['reminder']), [], 'annai said nothing itself');
  } finally {
    done();
  }
});

test('a dropped connection resumes with its handle, and the conversation goes on', { skip }, async () => {
  const { k, said, states, done } = await kit();
  try {
    k.agent.send('Tell me one short fact about Bixby Bridge.');
    await soon(async () => (await said()).length >= 1);
    await k.agent.idle();
    k.sockets.at(-1)?.close(3000, 'a tunnel');
    await soon(async () => (await states()).includes('resumed'));
    k.agent.send('What did I just ask you about? Answer in a few words.');
    await soon(async () => (await said()).length >= 2);
    assert.match((await said())[1].text, /bixby|bridge/i);
  } finally {
    done();
  }
});

test("a drop that can't resume: the typing model finishes the answer, through the speech pipeline", { skip }, async () => {
  const finish = '(the typing model finishing the answer)';
  const { k, said, done } = await kit({ rules: [{ match: 'the live session dropped', reply: { toolCalls: [{ name: 'speak', input: { text: finish } }, { name: 'sleep', input: {} }] } }, { match: '.', reply: sleep }] });
  try {
    k.agent.send('Tell me about Big Sur, in four or five sentences.');
    await until(() => k.agent.live.view.name === 'speaking', 30_000);
    await new Promise((r) => setTimeout(r, 1500));
    k.llm.live = async () => { throw new ProviderError('unreachable', "annai couldn't reach the provider."); };
    k.sockets.at(-1)?.close(3000, 'a tunnel');
    await soon(async () => (await said()).some((s) => s.text === finish));
    await k.agent.idle();
    assert.ok((await said())[0].text.endsWith('✂'));
    assert.equal(k.agent.koeState, 'text');
    assert.ok(k.platform.log.includes(`play m-say:${finish}`));
  } finally {
    done();
  }
});
