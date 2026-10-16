import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';

const choose = (/** @type {'A' | 'B'} */ letter) => ({ toolCalls: [{ name: 'decide', input: { option: letter } }] });
const speakOnly = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** The main model's requests, not the gate's. @param {any} k */
const mainRequests = (k) => k.requests.filter((/** @type {any} */ r) => !String(r.system ?? '').startsWith('You make one quick decision'));
/** The gate's requests. @param {any} k */
const gateRequests = (k) => k.requests.filter((/** @type {any} */ r) => String(r.system ?? '').startsWith('You make one quick decision'));

test('chatter after she speaks is recorded, and she goes back to sleep without a call (spec §10.4)', async () => {
  const k = await agentKit([[speakOnly('Bixby Bridge is ahead.')]], { voice: { decide: [choose('B')], speechIn: ['m-hear'], hears: ['turn the radio down'] } });
  k.agent.send('What is ahead?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  const speak = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'speak');
  assert.equal(speak.data.content, 'Said aloud. Someone spoke, but not to you; it is below. You went back to sleep.');
  const [heard] = await k.events(['heard']);
  assert.deepEqual([heard.data.dismissed, heard.data.answer, heard.data.gate], [true, speak.data.id, 'chatter']);
  assert.equal(mainRequests(k).length, 1, 'no call for chatter');
  assert.match(JSON.stringify(gateRequests(k)[0].messages), /turn the radio down/);
  assert.match(gateRequests(k)[0].messages[0].parts[0].text, /She last said aloud: "Bixby Bridge is ahead\."/);
  assert.equal(k.platform.log.at(-1), 'mic close');
  assert.equal(k.agent.state.name, 'sleeping');
});

test('meant for Shiori, or unsure: it reaches the main model (spec §10.4)', async () => {
  for (const [decide, gate] of /** @type {[any[], string][]} */ ([[[choose('A')], 'shiori'], [[{ error: 'bad-request', status: 400 }], 'unsure']])) {
    const k = await agentKit([[speakOnly('Want tacos?'), say('Tacos it is.')]], { voice: { decide, speechIn: ['m-hear'], hears: ['yes please'] } });
    k.agent.send('Lunch?');
    await until(() => k.agent.state.name === 'listening');
    await hear(k, 'first-one');
    await k.agent.idle();
    assert.equal(mainRequests(k).length, 2, String(gate));
    assert.equal((await k.events(['heard']))[0].data.gate, gate);
  }
});

test("a tap's first words need no gate; without a quick-decision model there is none", async () => {
  const k = await agentKit([[say('Sure.')]], { voice: { decide: [choose('B')], speechIn: ['m-hear'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await k.agent.idle();
  assert.equal(gateRequests(k).length, 0);
  assert.equal(mainRequests(k).length, 1);
  const plain = await agentKit([[speakOnly('Want tacos?'), say('OK.')]], { voice: { speechIn: ['m-hear'] } });
  plain.agent.send('Lunch?');
  await until(() => plain.agent.state.name === 'listening');
  await hear(plain, 'first-one');
  await plain.agent.idle();
  assert.equal((await plain.events(['heard']))[0].data.gate, undefined);
  assert.equal(mainRequests(plain).length, 2);
});

test('chatter while she thinks is written in at her next step, and wakes nothing (spec §10.4)', async () => {
  const k = await agentKit([[
    speakOnly('Want tacos?'),
    { delayMs: 120, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
    say('Tacos, noted.'),
  ]], { voice: { decide: [choose('A'), choose('B')], speechIn: ['m-hear'], hears: ['yes please', 'did you lock the car'] } });
  k.agent.send('Lunch?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => mainRequests(k).length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal(mainRequests(k).length, 3, 'chatter wakes no turn of its own');
  assert.deepEqual(mainRequests(k)[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard, not meant for you]' }, { type: 'text', text: 'did you lock the car' }]);
  const chatter = (await k.events(['heard']))[1];
  assert.deepEqual([chatter.data.dismissed, chatter.data.meanwhile], [true, true]);
});

test('chatter during an ask is written in, and the buttons keep waiting (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] },
    say('Kept.'),
  ]], { voice: { decide: [choose('B')], speechIn: ['m-hear'], hears: ['pass the water'] } });
  k.agent.send('We are late');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await until(() => k.agent.state.name === 'waiting');
  const ask = (await k.events(['tool.call'])).find((/** @type {any} */ e) => e.data.name === 'ask');
  k.agent.answer(ask.data.id, 'Keep it');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'ask').data.content, 'The user chose: Keep it');
  const heard = await k.events(['heard']);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].data.dismissed, true);
});
