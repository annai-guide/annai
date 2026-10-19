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

test('item 4 (probe H): a tap that cuts Koe off tells the provider how much of her turn was heard (cut), for one that truncates its record there', async () => {
  const k = await liveKit([{ said: 'Bixby Bridge is a concrete arch from 1932, and one of the most photographed bridges on the coast.', audio: tone(4) }], { pace: 1 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    k.agent.send('Tell me about the bridge');
    await until(() => k.agent.live.view.name === 'speaking', 3000);
    await wait(500);
    /** @type {number[]} */
    const cuts = [];
    k.sessions.at(-1).cut = (/** @type {number} */ ms) => { cuts.push(ms); };
    assert.equal(k.agent.tap(), 'cut');
    assert.equal(cuts.length, 1);
    assert.ok(cuts[0] >= 400 && cuts[0] < 1500, String(cuts[0]));
  } finally {
    await k.done();
  }
});

test('item 5 (probe L): a server that drops every session it resumes is given up on after three tries with no turn between them, waiting longer each time; Koe goes on without it', async () => {
  const k = await liveKit([{ said: 'Hi.', audio: tone(0.1), handle: 'h' }]);
  try {
    await k.voice.unlock();
    k.agent.send('Hello');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    for (let i = 1; i <= 3; i++) {
      k.server.close(1011, 'Internal error encountered.');
      await until(() => k.server.connections().length === i + 1, 3000);
      await soon(async () => k.agent.live.state === 'open' && !k.agent.live.busy);
    }
    k.server.close(1011, 'Internal error encountered.');
    await soon(async () => (await blocks(k)).includes('live-dropped'));
    await wait(100);
    assert.equal(k.server.connections().length, 4, 'no fourth resume');
    assert.notEqual(k.agent.koeState, 'live');
    assert.ok(k.llm.bench.until('m-live') > Date.now(), 'the live model rests');
  } finally {
    await k.done();
  }
});

test('item 14 (K6): a drop with no resume handle (OpenAI has none) still goes on, in a fresh session', async () => {
  const k = await liveKit([{ said: 'Hi.', audio: tone(0.1) }, { said: 'Still here.', audio: tone(0.1) }], { live: { type: 'openai-realtime' } });
  try {
    k.agent.send('Hello');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    k.server.close(1011, 'server_error');
    await until(() => k.server.connections().length === 2, 3000);
    await soon(async () => k.agent.live.state === 'open' && !k.agent.live.busy);
    k.agent.send('Are you there?');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    assert.equal(k.agent.koeState, 'live');
    assert.deepEqual(await blocks(k), ['live-open'], 'one session, as Kokoro sees it');
  } finally {
    await k.done();
  }
});

test('item 6 (probe M): a tool call being worked out when the session drops is answered in the session that resumes it', async () => {
  const k = await liveKit([{ said: 'Looking.', audio: tone(0.1), tool: { name: 'list', args: { path: '/trip/' } } }], { pace: 1 });
  try {
    await k.voice.unlock();
    const orig = k.agent.koe.liveCall.bind(k.agent.koe);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((r) => { release = () => r(undefined); });
    k.agent.koe.liveCall = async (/** @type {any} */ c, /** @type {string} */ w) => { await held; return orig(c, w); };
    k.agent.send('List my trip');
    await until(() => k.agent.live.busy && k.server.received().some((/** @type {any} */ m) => m.clientContent), 3000);
    await wait(80); // the call has come, and is held
    k.server.close(1011, 'Internal error encountered.');
    await until(() => k.server.connections().length === 2, 3000);
    await soon(async () => (await lives(k, 'resumed')).length === 1);
    release();
    await until(() => got(k, 'toolResponse').length === 1, 3000);
    const at = k.server.received().findIndex((/** @type {any} */ m) => m.toolResponse);
    const resumedAt = k.server.received().findLastIndex((/** @type {any} */ m) => m.setup);
    assert.ok(at > resumedAt, 'answered in the resumed session');
  } finally {
    await k.done();
  }
});

test('item 7 (probe C): a session closed while it opens tells Kokoro nothing: no live-closed without its live-open', async () => {
  const k = await liveKit([]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.state === 'opening', 3000);
    k.agent.hush('away');
    await k.agent.idle();
    await wait(100);
    assert.deepEqual(await blocks(k), []);
  } finally {
    await k.done();
  }
});

test("item 8 (probe G): a close while the user speaks keeps their half line, marked ✂, as a drop does", async () => {
  const k = await liveKit([{ heard: 'Where should we', heardFirst: true, said: 'x', audio: tone(0.1) }]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    const { clip, quiet, cat } = await import('./voice-kit.js');
    const words = await clip('where-eat');
    k.platform.mic.feed(cat(quiet(0.3), words.subarray(0, Math.floor(words.length / 2))), 16_000);
    await until(() => got(k, 'realtimeInput').some((/** @type {any} */ m) => m.realtimeInput.activityStart));
    await wait(30);
    k.agent.hush('away');
    await soon(async () => (await k.events(['heard'])).length === 1);
    assert.equal((await k.events(['heard']))[0].data.text, 'Where should we✂');
  } finally {
    await k.done();
  }
});

test('item 10: a session hushed while it moves to a new connection (GoAway) closes the old one at once, not when the new one is ready', async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.1), handle: 'h-2', goAway: 10 }]);
  try {
    const live = k.llm.live;
    k.llm.live = async (/** @type {string} */ id, /** @type {any} */ setup, /** @type {any} */ o) => {
      if (k.sessions.length) await wait(400); // the new connection takes a while
      return live(id, setup, o);
    };
    k.agent.send('Hi');
    await until(() => k.agent.live.busy && k.sessions.length === 1, 3000);
    await soon(async () => (await lives(k, 'goaway')).length === 1);
    await wait(50); // the move has begun
    /** @type {any} */
    let closed = null;
    k.sessions[0].closed.then((/** @type {any} */ c) => { closed = c; });
    k.agent.hush('away');
    await wait(100);
    assert.ok(closed, 'the old connection closed at once');
  } finally {
    await k.done();
  }
});

test('item 9 (probe I): a trigger while the page is out of view shows its reminder now, as annai does for any, and Koe says it when the page is back', async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes.', audio: tone(0.1) }]);
  try {
    await k.voice.unlock();
    hidden(true);
    await k.agent.wake({ kind: 'trigger', text: 'Train in 20 minutes', fallbacks: [{ watch: 'train', text: 'Train at 10:40' }] });
    await k.agent.idle();
    await until(() => k.notices.some((/** @type {any} */ n) => n.body === 'Train at 10:40'), 2000);
    assert.equal(k.server.connections().length, 0);
    hidden(false);
    k.agent.shown();
    await soon(async () => (await k.events(['out.speak'])).length === 1);
  } finally {
    hidden(false);
    await k.done();
  }
});

test("item 11 (consent): a session a trigger opened listens after it speaks only for the answer window (Settings → Voice's \"Listen for an answer\"), not the quiet spell; once the user speaks, or taps, the spell holds", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone(0.1) }, { heard: 'thanks', said: 'You are welcome.', audio: tone(0.1) }]);
  try {
    await updateAppSettings(k.ws, { voice: { closeAfterSeconds: 300, silenceSeconds: 2 } }); // 3 s and 20 ms here
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes' });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    assert.ok(k.agent.live.listening, 'it listens after');
    await until(() => k.agent.live.state === 'closed', 1000); // the answer window, not the 3 s spell
    // Tapped open, the spell holds, a trigger after it changing nothing.
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await k.agent.wake({ kind: 'trigger', text: 'Fuel is low' });
    await wait(400);
    assert.equal(k.agent.live.state, 'open');
  } finally {
    await k.done();
  }
});
