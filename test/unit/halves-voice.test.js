// K2: voice through the speech pipeline (the Koe and Kokoro design; plan decisions 8, 15, 17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { updateAppSettings } from '../../src/core/settings.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** A reply that calls tools, then sleeps. @param {...[string, any]} calls */
const calls = (...calls) => ({ toolCalls: [...calls.map(([name, input]) => ({ name, input })), { name: 'sleep', input: {} }] });
/** What played, in order. @param {any} k */
const plays = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('play ')).map((/** @type {string} */ l) => l.replace(/^play m-say:/, ''));
/** How often the microphone opened. @param {any} k */
const micOpens = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic open')).length;
/** Each call of a tool's result, in order. @param {any} k @param {string} name */
const results = async (k, name) => (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === name);
/** The states a half went through. @param {any} half */
function states(half) {
  /** @type {string[]} */
  const seen = [];
  half.on('state', (/** @type {any} */ s) => seen.push(s.name));
  return seen;
}

test('voice on: Koe speaks and listens with the speech pipeline; Kokoro never opens the microphone', async () => {
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { talk: { rules: [{ match: 'the user spoke', reply: { toolCalls: [{ name: 'speak', input: { text: "That's Bixby Bridge, a 1932 concrete arch." } }] } }] } },
    voice: { speechIn: ['m-hear'], hears: ['what is that bridge'] },
  });
  const kokoro = states(k.agent.kokoro);
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await k.agent.idle();
  assert.deepEqual(plays(k), ["That's Bixby Bridge, a 1932 concrete arch."]);
  const [speak] = await results(k, 'speak');
  assert.equal(speak.data.half, 'koe');
  assert.equal(speak.data.content, 'Said aloud. Heard nothing (8 seconds).');
  assert.equal(micOpens(k), 2, "the tap's window, then the speak's");
  assert.equal(k.platform.log.at(-1), 'mic close');
  const turn = (await k.events(['model.turn'])).find((e) => e.data.tag === 'koe');
  assert.equal(turn?.data.role, 'koe-talk');
  assert.equal((await k.events(['out.speak']))[0].data.voice, true);
  assert.ok(!kokoro.includes('listening') && !kokoro.includes('speaking') && !kokoro.includes('hearing'), JSON.stringify(kokoro));
  assert.equal(k.agent.koeState, 'text');
  assert.deepEqual((await k.events(['halves'])).map((e) => e.data.state), []);
});

test("only the 'for typing' list set and voice on: that model talks, through the speech pipeline", async () => {
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { type: { rules: [{ match: 'the user wrote', reply: calls(['speak', { text: "I'm checking." }]) }] } },
    voice: { speechIn: ['m-hear'] },
  });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.deepEqual(plays(k), ["I'm checking."]);
  assert.ok(k.sent['model-koe']?.length >= 1);
  const turn = (await k.events(['model.turn'])).find((e) => e.data.tag === 'koe');
  assert.deepEqual([turn?.data.role, turn?.data.answeredBy], ['koe-talk', 'model-koe']);
  assert.match(k.sent['model-koe'][0].tail, /voice: on/);
});

test('Koe down with voice on: Kokoro speaks aloud as Shiori does today', async () => {
  const k = await agentKit([{ rules: [
    { match: 'the user wrote', reply: calls(['tell_koe', { text: 'Open till 10.' }]) },
    { match: "Koe can't speak", reply: calls(['speak', { text: 'Nepenthe is open till 10.' }]) },
  ] }], { koe: { talk: [{ delayMs: 30, error: 'auth', message: 'bad key' }] }, voice: { speechIn: ['m-hear'] } });
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.equal(k.agent.koeState, 'down');
  assert.deepEqual((await k.events(['halves'])).map((e) => e.data.state), ['koe-down']);
  assert.deepEqual(plays(k), ['Nepenthe is open till 10.']);
  const said = (await k.events(['out.speak'])).map((e) => [e.data.half, e.data.voice, e.data.text]);
  assert.deepEqual(said, [['kokoro', true, 'Nepenthe is open till 10.']]);
  assert.equal(k.agent.talking, k.agent.kokoro);
});

test('voice mode changes are logged once', async () => {
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: '.', reply: sleep }] } }, voice: { mode: 'off', speechIn: ['m-hear'] } });
  assert.equal(await k.agent.split(), true);
  for (const mode of ['on', 'off']) {
    await updateAppSettings(k.ws, { voice: { mode } });
    await k.voice.refresh();
  }
  await k.agent.idle();
  const logged = (await k.events(['state'])).filter((e) => e.data.voice).map((e) => e.data.voice);
  assert.deepEqual(logged, ['on', 'off']);
});

// The opt-in rule, for voice: with no Koe model, Halves sends, says, hears and logs exactly what Shiori as one did.
test('with no Koe model and voice on, Halves and the one Agent send the same requests, say and hear the same, and write the same log', async () => {
  const NOW = Date.parse('2026-11-26T12:00:00Z');
  const script = [
    { stream: true, toolCalls: [{ name: 'speak', input: { text: 'There is a taco stand ahead. Want to stop?' } }] },
    { toolCalls: [{ name: 'speak', input: { text: 'Great.' } }, { name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'speak', input: { text: 'You are welcome.' } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
    { toolCalls: [{ name: 'speak', input: { text: 'Sunset is soon.' } }, { name: 'wait', input: { seconds: 2 } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ];
  /** @param {boolean} halves */
  const run = async (halves) => {
    const k = await agentKit([script], { halves, agent: { now: () => NOW }, voice: { speechIn: ['m-hear'], hears: ['where should we eat', 'yes the first one'] } });
    const a = k.agent;
    a.tap();
    await until(() => a.state.name === 'listening');
    await hear(k, 'where-eat');
    await until(() => (halves ? a.kokoro : a).state.name === 'listening' && k.requests.length === 1);
    await hear(k, 'first-one');
    await a.idle();
    a.send('Thanks');
    await a.idle();
    await a.wake({ kind: 'trigger', text: 'Sunset in 30 minutes', fallbacks: [{ watch: 'sun', text: 'Sunset at 18:40' }] });
    await a.idle();
    /** @param {any} x */
    const norm = (x) => JSON.parse(JSON.stringify(x, (key, v) => {
      if (['id', 'wake', 'ms', 'firstMs', 'ts', 'seq', 'prefix', 'now', 'answer', 'of', 'hash', 'refs', 'new', 'old', 'heard', 'at'].includes(key)) return undefined;
      return typeof v === 'string' ? v.replace(/scripted_\d+_\d+|\b[wctsh]-[a-z0-9]+/g, 'ID').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TIME') : v;
    }));
    return {
      requests: norm(k.requests), events: (await k.events()).map((e) => ({ type: e.type, actor: e.actor, data: norm(e.data) })),
      notices: k.notices.map((/** @type {any} */ n) => n.title), device: k.platform.log, sessions: k.platform.sessions, transcribed: k.transcribed,
    };
  };
  const one = await run(false);
  const two = await run(true);
  assert.ok(one.device.some((/** @type {string} */ l) => l === 'play m-say:Great.'), JSON.stringify(one.device));
  assert.deepEqual(two.requests, one.requests);
  assert.deepEqual(two.events, one.events);
  assert.deepEqual(two.notices, one.notices);
  assert.deepEqual(two.device, one.device);
  assert.deepEqual(two.sessions, one.sessions);
  assert.deepEqual(two.transcribed, one.transcribed);
});

test("the sign's Stop ends Kokoro's turn and leaves Koe's voice playing", async () => {
  const k = await agentKit([{ rules: [{ match: '.', reply: { delayMs: 2000, toolCalls: [{ name: 'sleep', input: {} }] } }] }], {
    koe: { type: { rules: [{ match: 'the user wrote', reply: calls(['speak', { text: 'Bixby Bridge is two miles ahead. It opened in 1932.' }]) }] } },
    voice: { playMs: 80, speechIn: ['m-hear'] },
  });
  k.agent.send('What is ahead?');
  await until(() => plays(k).length === 1 && k.agent.kokoro.busy);
  k.agent.stopKokoro();
  await k.agent.idle();
  assert.deepEqual(plays(k), ['Bixby Bridge is two miles ahead.', 'It opened in 1932.']);
  assert.ok(!k.platform.log.some((/** @type {string} */ l) => l.startsWith('stop ')), JSON.stringify(k.platform.log));
});

test("listening is judged against Koe's model: audio goes to it, and it writes the words down, from its own list", async () => {
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], {
    koe: { talk: { rules: [{ match: 'the user spoke', reply: calls(['speak', { text: 'Sure.' }]) }] }, input: ['text', 'audio'] },
    voice: { speechIn: ['send-audio'] },
  });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.notices.length, 0, JSON.stringify(k.notices));
  await hear(k, 'where-eat');
  await k.agent.idle();
  const [first, writeDown] = k.sent['model-koet'];
  assert.ok(first.messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.type === 'audio')), 'Koe heard it as sound');
  assert.match(String(writeDown?.system), /^Write down exactly what is said/);
  assert.equal(k.sent['model-0'], undefined, 'Kokoro was never asked');
  const [text] = await k.events(['heard.text']);
  assert.equal(text.data.by, 'model-koet');
});
