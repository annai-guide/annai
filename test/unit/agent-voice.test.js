import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { clip, quiet, cat } from './voice-kit.js';

/** speak, as a model whose arguments stream would send it. @param {string} text @param {any} [more] */
const speakStep = (text, more = {}) => ({ stream: true, toolCalls: [{ name: 'speak', input: { text } }], ...more });
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** What played, in order. @param {any} k */
const plays = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('play ')).map((/** @type {string} */ l) => l.replace(/^play m-say:/, ''));
/** The microphone's openings and closings, in order. @param {any} k */
const mics = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic '));
/** Each call of a tool's result, in order. @param {any} k @param {string} name */
const results = async (k, name) => (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === name);

test('speak plays as the reply streams in, sentence by sentence, then listens; the spoken answer comes back as heard speech (spec §7.1, §10.1)', async () => {
  const k = await agentKit([[speakStep('There is a taco stand ahead. Want to stop?', { pieceMs: 15 }), say('Great.')]], { voice: { speechIn: ['m-hear'], hears: ['yes the first one'] } });
  let playedBeforeTheCall = -1;
  k.agent.on('event', (e) => { if (e.type === 'tool.call' && e.data.name === 'speak' && playedBeforeTheCall < 0) playedBeforeTheCall = plays(k).length; });
  k.agent.send('Where should we eat?');
  await until(() => k.agent.state.name === 'listening');
  assert.ok(playedBeforeTheCall >= 1, 'the first sentence played before the reply was complete');
  await hear(k, 'first-one');
  await k.agent.idle();
  assert.deepEqual(plays(k), ['There is a taco stand ahead.', 'Want to stop?', 'Great.']);
  const [speak] = await results(k, 'speak');
  assert.equal(speak.data.content, 'Said aloud. The user said:');
  const [heard] = await k.events(['heard']);
  assert.deepEqual(speak.data.heard, [heard.data.id]);
  assert.equal(heard.data.answer, speak.data.id);
  const last = k.requests[1].messages.at(-1);
  assert.deepEqual(last.parts.slice(0, 2), [{ type: 'tool_result', id: last.parts[0].id, content: 'Said aloud. The user said:' }, { type: 'text', text: 'yes the first one' }]);
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(mics(k).at(-1), 'mic close');
  assert.deepEqual(k.platform.sessions, ['playback', 'play-and-record', 'playback', 'playback']);
});

test('sleep in the same reply: she speaks and does not listen; the microphone never opens (spec §7.1)', async () => {
  const k = await agentKit([[say('Noted.')]], { voice: {} });
  k.agent.send('Dinner is at 6:30');
  await k.agent.idle();
  assert.deepEqual(plays(k), ['Noted.']);
  assert.equal(k.platform.opens, 0);
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud.');
  assert.equal((await k.events(['out.speak']))[0].data.voice, true);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('heard nothing: speak stops listening after the silence limit (spec §7.1)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  k.agent.send('Thanks');
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud. Heard nothing (8 seconds).');
  assert.deepEqual(k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic')), ['mic open', 'mic close']);
});

test('voice off: speak shows a bubble and listens to nothing; the now block says which; voice on asks for first words sooner (spec §6.3, §9.6)', async () => {
  const off = await agentKit([[say('Here.')]], { voice: { mode: 'off' } });
  off.agent.send('Hi');
  await off.agent.idle();
  assert.deepEqual(plays(off), []);
  assert.equal((await results(off, 'speak'))[0].data.content, 'shown');
  assert.match(off.requests[0].tail, /voice: off/);
  const on = await agentKit([[say('Here.')]], { voice: {} });
  /** @type {any[]} */
  const calls = [];
  const call = on.llm.call;
  on.llm.call = (/** @type {any} */ c) => { calls.push(c); return call(c); };
  on.agent.send('Hi');
  await on.agent.idle();
  assert.match(on.requests[0].tail, /voice: on/);
  assert.equal(calls[0].firstOutputMs, 15_000);
  assert.equal(typeof calls[0].speech, 'function');
});

test('tapping her while she speaks stops her, keeps where, and opens the microphone; what is said next answers (spec §10.4)', async () => {
  const k = await agentKit([[speakStep('Bixby Bridge is two miles ahead. It opened in 1932.'), say('OK, the beach.')]], { voice: { playMs: 60, speechIn: ['m-hear'], hears: ['tell me about the beach'] } });
  k.agent.send('What is ahead?');
  await until(() => plays(k).length === 1);
  assert.equal(k.agent.tap(), 'cut');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'The user stopped you after: "Bixby Bridge is…". The user said:');
  assert.ok(!plays(k).includes('It opened in 1932.'));
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1, 'one listening window, from the tap');
  assert.equal(k.requests.length, 2);
});

test('a spoken question answered only in plain text is asked again too, as a typed one is (review a2)', async () => {
  const k = await agentKit([[{ text: 'Nepenthe is a good choice.' }, say('Nepenthe, on the cliffs.')]], { voice: { playMs: 5, speechIn: ['m-hear'], hears: ['where should we eat'] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  assert.match(k.requests[1].tail, /The user hasn't been answered/);
  assert.deepEqual((await k.events(['out.speak'])).map((e) => e.data.text), ['Nepenthe, on the cliffs.']);
});

test('two speaks in one streamed reply: the second plays after the first has listened, never over the open microphone (spec §10.4)', async () => {
  const k = await agentKit([[
    { stream: true, toolCalls: [{ name: 'speak', input: { text: 'First thing.' } }, { name: 'speak', input: { text: 'Second thing.' } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { voice: { playMs: 40, speechIn: ['m-hear'] } });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.deepEqual(k.platform.log, ['play m-say:First thing.', 'mic open', 'mic close', 'play m-say:Second thing.', 'mic open', 'mic close']);
});

test('once she is stopped, a later speak in the same reply is not said and does not listen; it shows as a bubble (spec §10.4)', async () => {
  const k = await agentKit([[
    { stream: true, toolCalls: [{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead. It opened in 1932.' } }, { name: 'speak', input: { text: 'Want to stop there?' } }] },
    say('OK, the beach.'),
  ]], { voice: { playMs: 60, speechIn: ['m-hear'], hears: ['tell me about the beach'] } });
  k.agent.send('What is ahead?');
  await until(() => plays(k).length === 1);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  const [a, b] = await results(k, 'speak');
  assert.match(a.data.content, /^The user stopped you after: "Bixby Bridge is…"\. The user said:/);
  assert.equal(b.data.content, 'Not said aloud: the user stopped you. It was shown on screen.');
  assert.ok(!plays(k).includes('Want to stop there?'));
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1, 'one listening window, from the tap');
  assert.equal((await k.events(['out.speak']))[1].data.voice, undefined, 'shown, not said');
  assert.equal(k.requests.length, 2);
});

test('tapping her while she sleeps starts listening; the first thing said wakes her; the microphone closes after her turn (spec §10.4)', async () => {
  const k = await agentKit([[say('Yes, there is a café ahead.')]], { voice: { speechIn: ['m-hear'], hears: ['is there coffee nearby'] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.requests[0].messages.at(-1).parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'is there coffee nearby' }]);
  assert.match(k.requests[0].tail, /woke for: the user spoke/);
  assert.deepEqual(plays(k), ['Yes, there is a café ahead.']);
  assert.equal(mics(k).at(-1), 'mic close');
  assert.equal(k.agent.state.name, 'sleeping');
});

test('a tap nobody speaks into closes after the silence limit; a tap while she listens stops listening; voice off opens typing', async () => {
  const k = await agentKit([[say('x')]], { voice: {} });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await until(() => k.agent.state.name === 'sleeping', 1000);
  assert.deepEqual(mics(k), ['mic open', 'mic close']);
  assert.equal(k.requests.length, 0);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.agent.tap(), 'stopped');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(mics(k).at(-1), 'mic close');
  const off = await agentKit([[say('x')]], { voice: { mode: 'off' } });
  assert.equal(off.agent.tap(), 'typing');
});

test('while she thinks, the microphone keeps recording; what is heard reaches her next call as heard while you were thinking (spec §6.1, §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Want tacos?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
    say('Tacos and a coffee, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['yes please', 'and a coffee'] } });
  k.agent.send('Lunch ideas?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and a coffee' }]);
  assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => [Boolean(e.data.answer), Boolean(e.data.meanwhile)]), [[true, false], [false, true]]);
});

test('speech heard while she thinks: her next speak does not wait a silence for an answer; what was said reaches her at once (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Want tacos?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'speak', input: { text: 'Tacos it is.' } }] },
    say('And a coffee, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['yes please', 'and a coffee'] } });
  k.agent.send('Lunch ideas?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  const second = (await results(k, 'speak'))[1];
  assert.equal(second.data.content, 'Said aloud. Not listening for an answer: the user spoke while you were thinking; it follows.');
  assert.ok(second.data.ms < 80, `it took ${second.data.ms} ms: no silence limit (80 ms here) was waited`);
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and a coffee' }]);
});

test('nothing heard is lost: speech that comes as she goes to sleep starts a new turn (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'sleep', input: {} }] },
    say('Got it, a gas station.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['no thanks', 'actually find gas'] } });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal(k.requests.length, 3);
  assert.equal((await k.events(['wake'])).length, 2);
  assert.match(JSON.stringify(k.requests[2].messages.at(-1)), /actually find gas/);
  assert.equal(plays(k).at(-1), 'Got it, a gas station.');
});

test('speech still going on when the microphone closes for her to speak is kept, and reaches her (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'One moment.' } }] },
    { delayMs: 60, stream: true, toolCalls: [{ name: 'speak', input: { text: 'Here is what I found.' } }] },
    say('And the rest, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['ok', 'and also'] } });
  k.agent.send('Find a park');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  k.platform.mic.feed(cat(quiet(0.3), (await clip('gas-station')).subarray(0, 12_000)), 16_000); // mid-sentence when she starts to speak
  await k.agent.idle();
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and also' }]);
});

test('a reply that breaks off mid-speak stops what it had begun; the next model says its own, whole (spec §9.6)', async () => {
  const k = await agentKit([[speakStep('First sentence here. Second one never comes.', { breakAt: 4 })], [say('From the other model.')]], { voice: {} });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(plays(k).at(-1), 'From the other model.');
  assert.ok(!plays(k).includes('Second one never comes.'));
  assert.equal((await k.events(['out.speak'])).length, 1);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('ask is spoken too, and a spoken answer answers it; wait listens (spec §7.1)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 10 } }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 10 } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { voice: { speechIn: ['m-hear'], hears: ['keep it', 'one more thing'] } });
  k.agent.send('We are late');
  await until(() => k.agent.state.name === 'listening');
  assert.deepEqual(plays(k), ['Keep the 6:30 dinner?']);
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2 && k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal((await results(k, 'ask'))[0].data.content, 'The user said:');
  assert.deepEqual((await results(k, 'wait')).map((/** @type {any} */ e) => e.data.content), ['The user said:', 'Nothing yet (10 seconds).']);
});
