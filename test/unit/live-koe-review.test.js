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

test('item 2 (probe O): an append note that comes while a tool call is still being worked out goes in once it is answered', async () => {
  const k = await liveKit([{ said: 'Let me look.', audio: tone(0.1), tool: { name: 'list', args: { path: '/trip/' } } }, { said: 'Noted.', audio: tone(0.1) }], { pace: 0 });
  try {
    await k.voice.unlock();
    const orig = k.agent.koe.liveCall.bind(k.agent.koe);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((r) => { release = () => r(undefined); });
    k.agent.koe.liveCall = async (/** @type {any} */ c, /** @type {string} */ w) => { await held; return orig(c, w); };
    k.agent.send('List my trip');
    await soon(async () => (await k.events(['out.speak'])).length === 1); // the turn ended; the call is still held
    await k.agent.channel.send('kokoro', 'The trip has three days.', 'append', 'tool');
    await wait(50);
    assert.ok(!texts(k).some((t) => t.includes('three days')), 'not while the call is open');
    release();
    await until(() => texts(k).some((t) => t.includes('three days')), 3000);
  } finally {
    await k.done();
  }
});

test('item 3 (probe E2): two listen() calls in flight open one microphone, and closing the session closes it', async () => {
  const k = await liveKit([{ said: 'A long answer about the coast and its history that goes on for a while.', audio: tone(3) }, { said: 'Noted.', audio: tone(0.1) }], { pace: 1 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('Tell me');
    await until(() => k.agent.live.view.name === 'speaking', 3000);
    slowSettings(k, 40);
    k.agent.tap(); // she stops, and it listens
    await k.agent.live.wake({ kind: 'trigger', text: 'Fuel is low' }); // a trigger opens with the microphone too
    await wait(300);
    const count = (/** @type {string} */ l) => k.platform.log.filter((/** @type {string} */ x) => x === l).length;
    assert.equal(count('mic open'), 1, JSON.stringify(k.platform.log));
    k.agent.hush('away');
    assert.equal(count('mic close'), 1, 'every microphone opened is closed');
    assert.equal(k.agent.live.listening, false);
  } finally {
    await k.done();
  }
});

test('item 3 (probe A3): a close while listen() waits opens no microphone and throws nothing; a trigger that lost its session has its reminder shown, and is not said later', async () => {
  /** @type {string[]} */
  const rejections = [];
  const onRejection = (/** @type {any} */ e) => { rejections.push(String(e?.message ?? e)); };
  process.on('unhandledRejection', onRejection);
  const k = await liveKit([{ said: 'Sunset soon.', audio: tone(0.1) }]);
  try {
    slowSettings(k, 60);
    await k.voice.unlock();
    const p = k.agent.live.open('tap', { mic: true });
    await until(() => k.agent.live.state === 'open', 3000);
    await wait(5);
    hidden(true);
    k.agent.hush('away');
    assert.equal(await p, true);
    await wait(120);
    hidden(false);
    assert.ok(!k.platform.log.includes('mic open'), JSON.stringify(k.platform.log));
    assert.equal(k.agent.live.listening, false);
    assert.deepEqual(rejections, []);
    // A trigger whose session closes as its microphone opens (the quiet spell, say).
    k.agent.send('x');
    await until(() => k.agent.live.state === 'open', 3000);
    await k.agent.idle();
    const listen = k.agent.live.listen.bind(k.agent.live);
    k.agent.live.listen = async () => { k.agent.live.close('quiet'); return listen(); };
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await k.agent.idle();
    await until(() => k.notices.some((/** @type {any} */ n) => n.body === 'Sunset at 18:40'), 2000); // its reminder is shown
    k.agent.live.listen = listen;
    k.agent.send('y');
    await until(() => k.server.connections().length === 3, 3000);
    await k.agent.idle();
    assert.ok(!texts(k).some((t) => t.includes('Sunset in 30 minutes')), JSON.stringify(texts(k)));
    assert.deepEqual(rejections, []);
  } finally {
    hidden(false);
    process.off('unhandledRejection', onRejection);
    await k.done();
  }
});
