// K5's fix pass: the privacy and security review's findings, each from its probe (scratchpad review-koe-k5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { liveKit, got, texts, soon, tone, say, sleep, blocks, lives } from './koe-live-kit.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** The page out of view, or back. @param {boolean} on */
function hidden(on) {
  if (on) /** @type {any} */ (globalThis).document = { visibilityState: 'hidden' };
  else delete (/** @type {any} */ (globalThis).document);
}
/** Voice settings that take a while, so a listen() spans a close. @param {any} k @param {number} ms */
function slowSettings(k, ms) {
  const orig = k.voice.settings.bind(k.voice);
  k.voice.settings = async () => { await wait(ms); return orig(); };
}
const speak = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

test("item 1 (probe K2): a typed message when no live session can open: Kokoro is woken to answer directly, at once, and a card says Koe's voice couldn't start", async () => {
  const server = await startRealtimeServer({ flavour: 'gemini', turns: [], closeWith: { code: 1011, reason: 'Internal error encountered.' } });
  const k = await agentKit([{ rules: [
    { match: 'the user wrote', reply: { delayMs: 150, ...speak('Kokoro here: tacos ahead.') } },
    { match: "Koe can't speak", reply: speak('Kokoro, directly: tacos ahead.') },
    { match: '.', reply: sleep },
  ] }], { live: { origin: server.origin }, voice: { speechIn: ['m-hear'] } });
  try {
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'live');
    k.agent.send('Where can we eat?');
    await soon(async () => (await k.events(['out.speak'])).some((/** @type {any} */ e) => e.data.half === 'kokoro'), 3000);
    await k.agent.idle();
    assert.equal(k.agent.koeState, 'down');
    const said = (await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.half, e.data.text]);
    assert.ok(said.some(([half, text]) => half === 'kokoro' && /tacos ahead/.test(text)), JSON.stringify(said));
    assert.ok(k.notices.some((/** @type {any} */ n) => /Koe's live voice couldn't start/.test(n.title)), JSON.stringify(k.notices));
    assert.ok((await blocks(k)).includes('koe-down'));
  } finally {
    k.agent.hush('away');
    await server.stop();
  }
});
