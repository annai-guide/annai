// Opt-in: Gemini's own API (the gemini-api plugin, G1) with your own key. Never in CI.
//   GEMINI_KEY="$(sed -n 1p /root/annai-test-keys/gemini)" node --test test/live/gemini-api.test.js
// It pauses 13 s between calls to one model (a free key's flash allows 5 a minute; flash-lite more), and skips, saying
// so, when the free day is used up. What Google changes in the Interactions API shows up here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { callOnce } from '../../src/core/llm/call.js';
import { toBase64 } from '../../src/core/bytes.js';
import { levelsFor } from '../../plugins-official/gemini-api/levels.js';
import { STAND_IN_SIGNATURE } from '../../plugins-official/gemini-api/steps.js';
import { TEST_IMAGE } from '../../src/core/llm/check.js';
import { loadGemini, endpointOf, modelOf } from '../unit/gemini-kit.js';

const KEY = process.env.GEMINI_KEY ?? '';
const skip = KEY ? false : 'GEMINI_KEY is not set';
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const type = loadGemini();
const endpoint = endpointOf(type, { baseUrl: 'https://generativelanguage.googleapis.com' });
const model = modelOf({ providerId: MODEL, name: MODEL, reasoning: levelsFor(MODEL) });
const TOOL = { name: 'get_weather', description: 'Current weather in a city.', input: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const pause = () => new Promise((r) => setTimeout(r, 13_000));
/** The now block, as annai sends it with every turn of Shiori's (last, in the final user input). */
const NOW = 'Now: Saturday 19 October 2026, 11:40, in Kyoto, near the station.';

/** What went to Google, each request's body. @type {any[]} */
const sent = [];
/** @type {import('../../src/core/llm/call.js').Fetch} */
const fetching = (url, init) => {
  sent.push(JSON.parse(String(init.body)));
  return fetch(url, init);
};

/** One call, or a polite skip when the free day is used up. @param {any} t @param {any} request @param {string} [level] */
async function call(t, request, level = 'low') {
  try {
    return await callOnce({ type, endpoint, model, key: KEY, request, level, fetch: fetching, firstOutputMs: 60_000 });
  } catch (e) {
    if (/** @type {any} */ (e)?.kind === 'rate' && /** @type {any} */ (e).retryAfter > 10 * 60_000) t.skip(`the free day is used up for ${MODEL}: ${/** @type {any} */ (e).message}`);
    throw e;
  }
}

test('two turns with a tool call: turn 2 carries both signatures back, and the answer uses the tool result', { skip }, async (t) => {
  const ask = { role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'What is the weather in Kyoto right now? Use the tool.' }] };
  const first = await call(t, { system: 'You are a travel guide. Use tools for anything that changes.', messages: [ask], tools: [TOOL], tail: NOW });
  if (!first) return;
  const thought = first.parts.find((p) => p.type === 'reasoning');
  const toolCall = /** @type {any} */ (first.parts.find((p) => p.type === 'tool_call'));
  assert.equal(first.stop, 'tool');
  assert.equal(toolCall?.name, 'get_weather');
  assert.match(String(toolCall.input.city), /kyoto/i);
  assert.ok(toolCall.extra?.signature, "the call's own signature");
  await pause();
  const second = await call(t, { system: 'You are a travel guide. Use tools for anything that changes.', tools: [TOOL], tail: NOW, messages: [
    ask,
    { role: 'assistant', parts: first.parts },
    { role: 'user', parts: [{ type: 'tool_result', id: toolCall.id, content: '{"city":"Kyoto","temp_c":18,"sky":"light rain"}' }] },
  ] });
  if (!second) return;
  const input = sent.at(-1).input;
  assert.deepEqual(input.at(-1), { type: 'user_input', content: [{ type: 'text', text: NOW }] }, 'the now block, last, after the result');
  if (/** @type {any} */ (thought)?.signature) assert.ok(input.some((/** @type {any} */ s) => s.type === 'thought' && s.signature === /** @type {any} */ (thought).signature), "the thought's signature, back");
  assert.ok(input.some((/** @type {any} */ s) => s.type === 'function_call' && s.signature === toolCall.extra.signature), "the call's signature, back");
  assert.equal(second.stop, 'end');
  assert.match(second.text, /18/);
  assert.ok(second.usage.input > 0 && second.usage.output > 0);
});

test("a call another model wrote, answered with a photo, with the now block: Gemini takes it (the stand-in signature) and sees the photo", { skip }, async (t) => {
  await pause();
  const show = { name: 'show_photo', description: 'Shows the photo the user took last.', input: { type: 'object', properties: {} } };
  const r = await call(t, { system: 'You are a travel guide.', tools: [show], tail: NOW, messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Look at the photo I just took and tell me its colour, in one word.' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_other_1', name: 'show_photo', input: {} }] }, // a fallback's: no signature of Gemini's
    { role: 'user', parts: [{ type: 'tool_result', id: 'call_other_1', content: 'The photo follows.' }, { type: 'image', mediaType: 'image/png', data: TEST_IMAGE }] },
  ] });
  if (!r) return;
  const input = sent.at(-1).input;
  assert.equal(input.find((/** @type {any} */ s) => s.type === 'function_call').signature, STAND_IN_SIGNATURE);
  assert.deepEqual(input.at(-1).content.map((/** @type {any} */ c) => c.type), ['image', 'text'], 'the photo, then the now block, after the result');
  assert.equal(r.stop, 'end');
  assert.match(r.text, /red/i);
});

test('an Opus clip as an audio part, answered', { skip }, async (t) => {
  await pause();
  const clip = toBase64(new Uint8Array(await readFile(new URL('../fixtures/voice/where-eat.ogg', import.meta.url))));
  const r = await call(t, { messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: 'audio/ogg', data: clip }, { type: 'text', text: 'Write down exactly what this voice message says, and nothing else.' }] }] });
  if (!r) return;
  assert.equal(sent.at(-1).input[0].content[0].mime_type, 'audio/ogg');
  assert.match(r.text, /eat/i);
  assert.ok((r.usage.audioIn ?? 0) > 0, 'its audio tokens, counted apart');
});

test('Fetch model list gives a context window for gemini-3.5-flash-lite', { skip }, async () => {
  const req = type.listRequest({ endpoint, key: KEY });
  const res = await fetch(req.url, { headers: req.headers });
  assert.equal(res.status, 200);
  const lite = type.readList(await res.json()).find((/** @type {any} */ m) => m.providerId === 'gemini-3.5-flash-lite');
  assert.deepEqual([lite?.contextWindow, lite?.maxOutput], [1048576, 65536]);
  assert.deepEqual(lite?.reasoning, levelsFor('gemini-3.5-flash-lite'));
});
