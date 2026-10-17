import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { WRITE_DOWN } from '../../src/core/voice/voice.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const speakOnly = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });
/** Taps Shiori and says one of the clips. @param {any} k @param {string} name */
async function tapAndSay(k, name) {
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, name);
  await k.agent.idle();
}

test('after a turn that worked, what was heard is written down and its sound let go; later turns send the words (spec §10.3)', async () => {
  const k = await agentKit([[say('Tacos are close.'), say('Still tacos.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  await tapAndSay(k, 'where-eat');
  const [written] = await k.events(['heard.text']);
  const [heard] = await k.events(['heard']);
  assert.deepEqual([written.data.of, written.data.text, written.data.by], [heard.data.id, 'where should we eat', 'ears']);
  assert.equal(k.voice.memory.size, 0);
  k.agent.send('And again?');
  await k.agent.idle();
  assert.deepEqual(k.transcribed, ['m-hear'], 'the transcript made for the reply was reused, and not made again');
  assert.deepEqual(k.requests[1].messages[0].parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'where should we eat' }]);
});

test('sound sent to a model that takes audio is written down by that model, after the turn (spec §10.3)', async () => {
  const k = await agentKit([[say('Tacos are close.'), { text: 'where should we eat' }]], { models: [{ input: ['text', 'image', 'audio'] }], voice: { speechIn: ['send-audio'] } });
  await tapAndSay(k, 'where-eat');
  assert.equal(k.requests[0].messages[0].parts[1].type, 'audio');
  assert.equal(k.requests[1].system, WRITE_DOWN);
  assert.deepEqual(k.requests[1].messages[0].parts.map((/** @type {any} */ p) => p.type), ['audio']);
  const [written] = await k.events(['heard.text']);
  assert.deepEqual([written.data.text, written.data.by], ['where should we eat', 'model-0']);
  assert.deepEqual(k.transcribed, []);
});

test('a turn that fails keeps what was heard; the next one still has the words, transcribed once (spec §10.3)', async () => {
  const k = await agentKit([[{ error: 'bad-request', status: 400 }, say('Now I hear you.')]], { voice: { speechIn: ['m-hear'], hears: ['find a gas station'] } });
  await tapAndSay(k, 'gas-station');
  assert.equal(k.notices.at(-1)?.title, "Shiori can't reach her model");
  assert.equal((await k.events(['heard.text'])).length, 0);
  assert.equal(k.voice.memory.size, 1);
  k.agent.send('Try again');
  await k.agent.idle();
  assert.match(JSON.stringify(k.requests[1].messages), /find a gas station/);
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.equal((await k.events(['heard.text'])).length, 1);
  assert.equal(k.voice.memory.size, 0);
});

test('keep voice clips: each clip is kept with the conversation, named by its heard event; off by default (spec §10.2, §4.9)', async () => {
  const kept = await agentKit([[say('Noted.')]], { voice: { speechIn: ['m-hear'], keepClips: true } });
  await tapAndSay(kept, 'where-eat');
  const [heard] = await kept.events(['heard']);
  assert.match(heard.data.clip, /^[0-9a-f]{64}$/);
  assert.deepEqual(heard.refs, [heard.data.clip]);
  const blob = await kept.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(heard.data.clip));
  assert.equal(blob?.type, 'audio/wav');
  const plain = await agentKit([[say('Noted.')]], { voice: { speechIn: ['m-hear'] } });
  await tapAndSay(plain, 'where-eat');
  const [unkept] = await plain.events(['heard']);
  assert.equal(unkept.data.clip, undefined);
  assert.equal(unkept.refs, undefined);
  const types = [];
  for (const b of await plain.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.listBlobs())) types.push((await plain.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(b.hash)))?.type);
  assert.ok(!types.some((t) => String(t).startsWith('audio/')), 'no sound is stored');
});

test('after a reload, the conversation has the same heard speech (spec §6.7)', async () => {
  const k = await agentKit([[speakOnly('Want tacos?'), say('Done.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat', 'yes'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => k.agent.state.name === 'listening' && k.requests.length === 1);
  await hear(k, 'first-one');
  await k.agent.idle();
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
});

test("no usable entry: a tap says what to add; speak says it couldn't listen, without a card each time (spec §10.3)", async () => {
  const k = await agentKit([[speakOnly('Hello?'), speakOnly('Still there?'), { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { speechIn: [] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].title, "Shiori can't hear you yet");
  assert.match(k.notices[0].body, /speech-in list is empty/);
  k.agent.send('Hi');
  await k.agent.idle();
  const speaks = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'speak');
  assert.match(speaks[0].data.content, /^Said aloud\. annai couldn't listen: Shiori can't hear you: the speech-in list is empty\./);
  assert.equal(k.notices.length, 1);
  assert.equal(k.platform.opens, 0);
});

test('a microphone that is refused: a card with this phone’s steps (spec §17 rule 3)', async () => {
  const k = await agentKit([[say('x')]], { voice: { micFails: 'NotAllowedError' } });
  k.agent.tap();
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].title, "annai can't use the microphone");
  assert.match(k.notices[0].body, /Settings → Apps → Safari → Microphone/);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('phone dictation in the loop: its words need no transcription; when it fails, recording takes over (spec §10.3)', async () => {
  const k = await agentKit([[say('A gas station is 2 miles on.'), say('And a café.')]], { voice: { dictation: true, speechIn: ['dictation', 'm-hear'], hears: ['and a coffee'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.say('is there a gas station nearby');
  await k.agent.idle();
  assert.deepEqual(k.requests[0].messages[0].parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'is there a gas station nearby' }]);
  assert.deepEqual(k.transcribed, []);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.fail('network');
  await until(() => k.platform.log.includes('mic open'));
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.match(JSON.stringify(k.requests[1].messages.at(-1)), /and a coffee/);
});

test('phone dictation that hears a noise and no words: the silence limit starts again, so speak hears nothing and a tap window closes (spec §7.1, §10.4)', async () => {
  const k = await agentKit([[speakOnly('Anything else?'), { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { dictation: true, speechIn: ['dictation'] } });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.noise();
  await until(() => k.agent.state.name === 'sleeping', 1500);
  await k.agent.idle();
  const [speak] = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'speak');
  assert.equal(speak.data.content, 'Said aloud. Heard nothing (8 seconds).');
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.noise();
  await until(() => k.agent.state.name === 'sleeping', 1500);
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l.startsWith('dictation ')).at(-1), 'dictation close');
});

test('a write-down that fails keeps the sound: nothing is written as not transcribed, and the next turn that works writes the words (spec §10.3)', async () => {
  const k = await agentKit([[say('Tacos are close.'), { error: 'bad-request', status: 400 }, say('Still tacos.'), { text: 'where should we eat' }]], { models: [{ input: ['text', 'image', 'audio'] }], voice: { speechIn: ['send-audio'] } });
  await tapAndSay(k, 'where-eat');
  assert.equal(k.requests[1].system, WRITE_DOWN);
  assert.equal((await k.events(['heard.text'])).length, 0, 'nothing is written while the sound is at hand');
  assert.equal(k.voice.memory.size, 1);
  k.agent.send('And again?');
  await k.agent.idle();
  assert.equal(k.requests[2].messages[0].parts[1].type, 'audio', 'the next turn still sends the sound');
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), ['where should we eat']);
  assert.equal(k.voice.memory.size, 0);
});

test('a segment that three turns in a row could not write down is written as not transcribed, and its sound let go (spec §10.3)', async () => {
  const fail = { error: 'bad-request', status: 400 };
  const k = await agentKit([[say('One.'), fail, say('Two.'), fail, say('Three.'), fail]], { models: [{ input: ['text', 'image', 'audio'] }], voice: { speechIn: ['send-audio'] } });
  await tapAndSay(k, 'where-eat');
  for (const text of ['Again', 'And again']) {
    assert.equal((await k.events(['heard.text'])).length, 0);
    k.agent.send(text);
    await k.agent.idle();
  }
  assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.text), ['[audio, not transcribed]']);
  assert.equal(k.voice.memory.size, 0);
});
