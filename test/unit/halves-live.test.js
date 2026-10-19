// K5: Koe live (the Koe and Kokoro design, "Realtime sessions"; plan K5), against the stand-in realtime server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { clip, quiet, cat } from './voice-kit.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';
import { updateAppSettings } from '../../src/core/settings.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** Voice-like 24 kHz 16-bit PCM, seconds long. @param {number} [seconds] */
export const tone = (seconds = 0.6) => new Uint8Array(Int16Array.from({ length: Math.round(24_000 * seconds) }, (_, i) => Math.round(6000 * Math.sin(i / 9))).buffer);

/**
 * Shiori as two halves with a realtime model (m-live) first in Koe for talking, at a stand-in Gemini Live server
 * that answers with turns; a voice (on unless voice says otherwise), and Kokoro's scripts.
 * @param {any[]} turns @param {{ pace?: number, kokoro?: any[], koe?: any, voice?: any, live?: any, agent?: any }} [o]
 */
export async function liveKit(turns, o = {}) {
  const server = await startRealtimeServer({ flavour: 'gemini', turns, pace: o.pace ?? 0.05 });
  const k = await agentKit(o.kokoro ?? [{ rules: [{ match: '.', reply: sleep }] }], {
    live: { origin: server.origin, ...o.live }, koe: o.koe, agent: o.agent, voice: { speechIn: ['m-hear'], ...o.voice },
  });
  await k.agent.idle();
  return { ...k, server, done: async () => { k.agent.hush('away'); await server.stop(); } };
}
/** @param {any} k @param {string} [state] the live.session entries, or those in one state */
const lives = async (k, state) => (await k.events(['live.session'])).filter((/** @type {any} */ e) => !state || e.data.state === state);
/** The instruction blocks Kokoro got. @param {any} k */
const blocks = async (k) => (await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state);
/** What the stand-in got, of one kind. @param {any} k @param {string} key */
const got = (k, key) => k.server.received().filter((/** @type {any} */ m) => m[key]);
/** The text turns it got. @param {any} k */
const texts = (k) => got(k, 'clientContent').flatMap((/** @type {any} */ m) => m.clientContent.turns.flatMap((/** @type {any} */ t) => t.parts.filter((/** @type {any} */ p) => p.text).map((/** @type {any} */ p) => p.text)));
/** Waits for an async condition. @param {() => Promise<boolean>} fn */
async function soon(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** The user says one of the speech clips into the microphone. @param {any} k @param {string} name */
const say = async (k, name) => k.platform.mic.feed(cat(quiet(0.3), await clip(name), quiet(1)), 16_000);

// Task 1: choosing the pathway.
test("a realtime model first in Koe for talking: Koe is live; resting, the text model after it talks", async () => {
  const k = await liveKit([], { koe: { talk: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    assert.equal(k.agent.koeState, 'live');
    k.llm.bench.bench('m-live', 60_000);
    assert.equal(await k.agent.split(), true);
    assert.equal(k.agent.koeState, 'text');
  } finally {
    await k.done();
  }
});

// Task 2: a session's life.
test("voice on with a realtime Koe: a tap opens a session with Koe's live instructions, its view of the trip and its tools, and the microphone", async () => {
  const k = await liveKit([]);
  try {
    assert.equal(k.agent.tap(), 'listening');
    await until(() => k.agent.live.listening);
    const { setup } = got(k, 'setup')[0];
    const system = setup.systemInstruction.parts[0].text;
    assert.match(system, /^You are Koe, the voice of Shiori, a travel guide in the annai app, talking with the user in a live voice conversation/);
    assert.match(system, /<now>[\s\S]*voice: on: you speak aloud in this live session[\s\S]*<\/now>/);
    assert.match(system, /<today>\ntrip: Big Sur/);
    assert.ok(system.includes(`Kokoro's notes carry id="${k.agent.nonce}".`));
    const names = setup.tools[0].functionDeclarations.map((/** @type {any} */ f) => f.name);
    for (const n of ['show', 'ask', 'recall', 'list', 'read', 'write', 'tell_kokoro']) assert.ok(names.includes(n), n);
    for (const n of ['speak', 'wait', 'sleep']) assert.ok(!names.includes(n), `no ${n}: it speaks natively, and its turns end by themselves`);
    assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1);
    assert.equal(k.platform.sessions.at(-1), 'play-and-record');
    assert.deepEqual(await blocks(k), ['live-open']);
    assert.equal(k.agent.state.name, 'listening');
  } finally {
    await k.done();
  }
});

test('a quiet spell closes it: the microphone closes, full-quality playback comes back, and Kokoro is told', async () => {
  const k = await liveKit([]);
  try {
    k.agent.tap();
    await until(() => k.agent.live.listening);
    await until(() => k.agent.live.state === 'closed', 3000); // 30 seconds, at 10 ms a second
    assert.equal(k.platform.log.at(-1), 'mic close');
    assert.equal(k.platform.sessions.at(-1), 'playback');
    await soon(async () => (await lives(k, 'closed')).length === 1);
    assert.deepEqual(await blocks(k), ['live-open', 'live-closed']);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'quiet');
    assert.equal(k.agent.state.name, 'sleeping');
  } finally {
    await k.done();
  }
});

test('voice off, a conversation switch, the page going and Erase each close it at once, its microphone with it', async () => {
  const k = await liveKit([]);
  try {
    /** @param {() => unknown} close @param {string} why */
    const closes = async (close, why) => {
      k.agent.tap();
      await until(() => k.agent.live.listening);
      await close();
      await until(() => k.agent.live.state === 'closed');
      assert.equal(k.platform.log.at(-1), 'mic close', why);
      assert.equal(k.platform.sessions.at(-1), 'playback', why);
      await soon(async () => (await lives(k, 'closed')).at(-1)?.data.why === why);
    };
    await closes(() => k.agent.hush('away'), 'away');
    await closes(() => k.agent.hush('erase'), 'erase');
    await closes(async () => {
      await updateAppSettings(k.ws, { voice: { mode: 'off' } });
      await k.voice.refresh();
      await k.agent.idle();
    }, 'voice off');
    await updateAppSettings(k.ws, { voice: { mode: 'on' } });
    await k.voice.refresh();
    await k.agent.idle();
    await closes(() => k.agent.open(null), 'switch');
  } finally {
    await k.done();
  }
});

test('a trigger opens a session, says it, then listens; its reminder is never said by annai too', async () => {
  const k = await liveKit([{ said: 'The sun sets in half an hour.', audio: tone() }]);
  try {
    await k.voice.unlock(); // an earlier tap
    await k.agent.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    assert.deepEqual(texts(k), ['[annai] "Sunset in 30 minutes"']);
    const [said] = await k.events(['out.speak']);
    assert.deepEqual([said.data.text, said.data.voice, said.data.live, said.data.half], ['The sun sets in half an hour.', true, true, 'koe']);
    assert.equal(k.platform.streams.length, 1);
    assert.ok(k.platform.streams[0].ended && !k.platform.streams[0].stopped);
    assert.ok(k.agent.live.listening, 'then it listens');
    assert.deepEqual(await k.events(['reminder']), []);
    assert.ok(!k.said.includes('Sunset at 18:40'));
    // Kokoro got the trigger too, without the reminder, and its now block says Koe is live.
    const [kokoro] = k.sent['model-0'];
    assert.match(kokoro.tail, /koe: talking with the user live \(use tell_koe\)/);
  } finally {
    await k.done();
  }
});

test('GoAway: a new connection with the handle, and the conversation carries on there', async () => {
  const k = await liveKit([{ said: 'Hello there.', audio: tone(0.2), handle: 'h-2', goAway: 10 }, { said: 'Yes, I remember.', audio: tone(0.2) }]);
  try {
    k.agent.send('Hi');
    await until(() => k.server.connections().length === 2);
    await soon(async () => (await lives(k, 'resumed')).length === 1);
    k.agent.send('Do you remember?');
    await soon(async () => (await k.events(['out.speak'])).length === 2);
    const setups = got(k, 'setup');
    assert.equal(setups[1].setup.sessionResumption.handle, 'h-2');
    const order = k.server.received().map((/** @type {any} */ m) => (m.setup ? 'setup' : m.clientContent ? m.clientContent.turns[0].parts[0].text : Object.keys(m)[0]));
    assert.deepEqual(order, ['setup', 'Hi', 'setup', 'Do you remember?']);
    // The new connection is ready before the old one closes.
    assert.deepEqual((await lives(k)).map((/** @type {any} */ e) => e.data.state), ['open', 'ready', 'goaway', 'open', 'resumed', 'closed']);
    assert.equal((await lives(k, 'closed'))[0].data.why, 'goaway');
    assert.deepEqual(await blocks(k), ['live-open'], 'one session as Kokoro sees it');
  } finally {
    await k.done();
  }
});
