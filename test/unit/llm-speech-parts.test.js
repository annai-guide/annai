import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callRole, Bench, gap } from '../../src/core/llm/fallback.js';
import { portable, ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { decide } from '../../src/core/llm/decide.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelOf } from '../../src/core/llm/config.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';
import { activate as chat } from '../../plugins-official/chat-completions/index.js';

const helpers = { sse, parsePartialJSON, ProviderError, errorFromResponse, retry };
/** @param {(annai: any) => any} activate @returns {any} */
function typeOf(activate) {
  /** @type {any} */
  let t = null;
  activate({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'p' }; return () => {}; } }, helpers });
  return t;
}
const scriptedType = typeOf(scripted);

/** Scripted models in the main role, in order, each taking the inputs given. @param {{ script: any[], input: string[] }[]} list @returns {any} */
function config(list) {
  /** @type {any} */
  const cfg = { providers: {}, models: {}, roles: { main: { models: [], level: 'off' } } };
  list.forEach(({ script, input }, i) => {
    cfg.providers[`pv-${i}`] = { id: `pv-${i}`, plugin: 'provider-test', template: null, user: { name: `E${i}`, abilities: { chat: { kind: 'chat', type: 'scripted', tunables: { script } } } }, created: 0 };
    cfg.models[`m-${i}`] = { id: `m-${i}`, provider: `pv-${i}`, ability: 'chat', template: null, user: { providerId: `model-${i}`, input }, created: 0 };
    cfg.roles.main.models.push(`m-${i}`);
  });
  return cfg;
}
/** @type {any} */
const heardRequest = { messages: [{ role: 'user', parts: [{ type: 'text', text: '[heard]' }, { type: 'speech', id: 's-1' }] }] };
/** Audio for a model that takes it, the words for one that doesn't. @param {any} model @param {any} request */
const resolve = async (model, request) => ({
  ...request,
  messages: request.messages.map((/** @type {any} */ m) => ({
    role: m.role,
    parts: m.parts.map((/** @type {any} */ p) => (p.type !== 'speech' ? p : model.input.includes('audio') ? { type: 'audio', mediaType: 'audio/wav', data: 'UklGRg==' } : { type: 'text', text: 'where should we eat' })),
  })),
});

test('heard speech is resolved again for every model attempt, against the model receiving it (spec §10.3)', async () => {
  const cfg = config([
    { script: [{ error: 'credit', status: 402 }], input: ['text', 'audio'] },
    { script: [{ error: 'auth', status: 401 }], input: ['text'] },
    { script: [{ text: 'ok' }], input: ['text', 'audio'] },
  ]);
  /** @type {string[][]} */
  const received = [];
  const watched = { ...scriptedType, run: (/** @type {any} */ c) => { received.push(c.request.messages[0].parts.map((/** @type {any} */ p) => p.type)); return scriptedType.run(c); } };
  /** @type {string[]} */
  const events = [];
  const r = await callRole({ role: 'main', request: heardRequest, config: cfg, types: new Map([['scripted', watched]]), keyFor: async () => null, bench: new Bench(), sleep: async () => {}, speech: resolve, onEvent: (e) => events.push(e.type) });
  assert.equal(r.reply.text, 'ok');
  assert.deepEqual(received, [['text', 'audio'], ['text', 'text'], ['text', 'audio']]);
  assert.equal(events.filter((t) => t === 'restart').length, 2, 'the stream listener hears each time a call starts over');
});

test('a model nothing in the speech-in list can reach is skipped as "no-speech"; the next one answers', async () => {
  const cfg = config([{ script: [{ text: 'never' }], input: ['text'] }, { script: [{ text: 'ok' }], input: ['text', 'audio'] }]);
  const r = await callRole({
    role: 'main', request: heardRequest, config: cfg, types: new Map([['scripted', scriptedType]]), keyFor: async () => null, bench: new Bench(),
    speech: async (model, request) => {
      if (!model.input.includes('audio')) throw new Error(`nothing in the speech-in list can hear it for ${model.name}`);
      return resolve(model, request);
    },
  });
  assert.equal(r.reply.text, 'ok');
  assert.deepEqual(r.attempts.map((a) => [a.outcome, a.error ?? '']), [['no-speech', 'nothing in the speech-in list can hear it for model-0'], ['ok', '']]);
});

test('audio goes only to a model that takes audio, and speech never reaches a provider unresolved', () => {
  const model = modelOf({ id: 'm', provider: 'p', ability: 'chat', template: null, user: { providerId: 'x', input: ['text'] }, created: 0 });
  /** @type {any} */
  const withAudio = { messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: 'audio/wav', data: 'AA==' }] }] };
  assert.equal(gap(model, withAudio), 'no-audio');
  assert.equal(gap({ ...model, input: ['text', 'audio'] }, withAudio), null);
  /** @type {any} */
  const messages = [{ role: 'user', parts: [{ type: 'speech', id: 's-1', text: 'hi there' }, { type: 'speech', id: 's-2' }, { type: 'audio', mediaType: 'audio/wav', data: 'AA==' }] }];
  assert.deepEqual(portable(messages, 'x')[0].parts, [{ type: 'text', text: 'hi there' }, { type: 'text', text: '[audio, not transcribed]' }, { type: 'audio', mediaType: 'audio/wav', data: 'AA==' }]);
});

test('a decision can carry heard speech; without a fallback, an unsure answer stays unsure (spec §10.4)', async () => {
  /** @type {any[]} */
  const asked = [];
  const call = async (/** @type {string} */ role, /** @type {any} */ request) => {
    asked.push([role, request.messages[0].parts.map((/** @type {any} */ p) => p.type)]);
    return { reply: { parts: [], text: 'B', logprobs: [{ token: 'A', logprob: Math.log(0.45) }, { token: 'B', logprob: Math.log(0.55) }] } };
  };
  const options = [{ id: 'shiori', label: 'For Shiori' }, { id: 'chatter', label: 'Not for her' }];
  const r = await decide({ prompt: 'Is it for her?', options, call, logprobs: true, parts: [{ type: 'speech', id: 's-1' }], fallback: false });
  assert.equal(r.by, 'unsure');
  assert.ok(Math.abs(r.probabilities.chatter - 0.55) < 1e-9);
  assert.deepEqual(asked, [['decide', ['text', 'speech']]], 'the main model was not asked');
  const sure = await decide({ prompt: 'Is it for her?', options, call: async () => ({ reply: { parts: [], text: 'A', logprobs: [{ token: 'A', logprob: Math.log(0.9) }] } }), logprobs: true, fallback: false });
  assert.equal(sure.by, 'decide');
});

test('Chat Completions sends audio as input_audio, after the tool results it answers; its list keeps audio input', () => {
  const type = typeOf(chat);
  const endpoint = { id: 'ep', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm', name: 'Flash', providerId: 'google/gemini-flash', input: ['text', 'audio'], tools: true, maxOutput: null, tunables: {}, extraBody: {} };
  const { body } = type.build({
    endpoint, model, key: 'k', tunables: { ...type.tunables },
    request: { messages: [
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'speak', input: { text: 'Want tacos?' } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'The user said:' }, { type: 'audio', mediaType: 'audio/wav', data: 'UklGRg==' }] },
    ] },
  });
  assert.deepEqual(body.messages.slice(-2), [
    { role: 'tool', tool_call_id: 'c1', content: 'The user said:' },
    { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } }] },
  ]);
  assert.deepEqual(type.readList({ data: [{ id: 'g', architecture: { input_modalities: ['text', 'image', 'audio'] } }] })[0].input, ['text', 'image', 'audio']);
});

test("the scripted model can stream a tool call's arguments, as real endpoints do", async () => {
  const text = 'Bixby Bridge is two miles ahead. Want to stop?';
  const endpoint = { id: 'ep-s', type: 'scripted', name: 'S', baseUrl: '', headers: {}, tunables: { script: [{ stream: true, toolCalls: [{ name: 'speak', input: { text } }] }] }, extraBody: {} };
  /** @type {any[]} */
  const events = [];
  for await (const e of scriptedType.run({ endpoint, model: {}, key: null, tunables: {}, request: { messages: [] } })) events.push(e);
  const partials = events.filter((e) => e.type === 'tool_input');
  assert.ok(partials.length > 3);
  assert.equal(parsePartialJSON(partials[2].partial)?.text, 'Bixby Bridge is');
  assert.deepEqual(JSON.parse(partials.at(-1).partial), { text });
  const call = events.findIndex((e) => e.type === 'tool_call');
  assert.equal(events[call].input.text, text);
  assert.equal(events[call].id, partials[0].id);
  assert.ok(call > events.findIndex((e) => e.type === 'tool_input'));
});
