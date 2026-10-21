// Opt-in: Gemini's own API (the gemini-api plugin, G1 and G2) with your own key. Never in CI.
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
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { Kept, keyPrint } from '../../src/core/llm/kept.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { loadGemini, loadTypes, endpointOf, modelOf } from '../unit/gemini-kit.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { pcm16, encodeWav } from '../../src/core/voice/pcm.js';

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

test('Google keeps the conversation (G2): turn 2 sends only the tool result after turn 1; a fallback turn in between continues the chain; a deleted turn is sent again whole; then every turn is deleted', { skip }, async (t) => {
  await pause();
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const kept = new Kept({ ws });
  const config = /** @type {any} */ ({
    providers: { 'pv-g': { id: 'pv-g', plugin: 'provider-gemini', template: null, user: { name: 'Google Gemini', baseUrl: endpoint.baseUrl, abilities: { chat: { kind: 'chat', type: 'gemini' } } }, created: 0 } },
    models: { 'm-g': { id: 'm-g', provider: 'pv-g', ability: 'chat', template: null, user: { providerId: MODEL, input: ['text', 'image', 'pdf', 'audio'], reasoning: levelsFor(MODEL) }, created: 0 } },
    roles: { main: { models: ['m-g'], level: 'low' } },
  });
  const system = 'You are a travel guide. Use tools for anything that changes. Answer briefly.';
  /** A conversation's turn, kept. @param {any[]} messages */
  const turn = async (messages) => {
    try {
      return await callRole({ role: 'main', config, types: new Map([['gemini', type]]), bench: new Bench(), keyFor: async () => KEY, kept, scope: 'trip-live',
        record: { keepParts: true }, fetch: fetching, firstOutputMs: 60_000, sleep: async () => {}, request: { system, tools: [TOOL], tail: NOW, messages } });
    } catch (e) {
      if (/** @type {any} */ (e)?.attempts?.some((/** @type {any} */ a) => /daily limit/.test(String(a.error)))) t.skip(`the free day is used up for ${MODEL}`);
      throw e;
    }
  };
  /** @param {'user' | 'assistant'} role @param {...any} parts @returns {any} */
  const msg = (role, ...parts) => ({ role, parts });
  const m1 = msg('user', { type: 'text', text: 'What is the weather in Kyoto right now? Use the tool.' });
  const t1 = await turn([m1]);
  const call1 = /** @type {any} */ (t1.reply.parts.find((p) => p.type === 'tool_call'));
  assert.ok(call1, 'a tool call');
  const r1 = msg('assistant', ...t1.reply.parts);
  const tr = msg('user', { type: 'tool_result', id: call1.id, content: '{"city":"Kyoto","temp_c":18,"sky":"light rain"}' });
  await pause();
  const t2 = await turn([m1, r1, tr]);
  const b2 = sent.at(-1);
  assert.ok(b2.previous_interaction_id, 'chained');
  assert.deepEqual(b2.input.map((/** @type {any} */ s) => s.type), ['function_result', 'user_input'], 'only the result and the now block');
  assert.match(t2.reply.text, /18/);
  // Another model answered the next question (Gemini was resting); Gemini carries on after its own last turn.
  const r2 = msg('assistant', ...t2.reply.parts);
  const m3 = msg('user', { type: 'text', text: 'And tomorrow?' });
  const r3 = msg('assistant', { type: 'text', text: 'Tomorrow looks dry, around 20 degrees.' });
  const m4 = msg('user', { type: 'text', text: 'Which day is warmer, today or tomorrow? Answer in one word.' });
  await pause();
  const t4 = await turn([m1, r1, tr, r2, m3, r3, m4]);
  const b4 = sent.at(-1);
  assert.equal(b4.previous_interaction_id, (await ws.readJSON('sys:device', '/llm/kept.json')).turns.find((/** @type {any} */ x) => x.n === 3)?.id);
  assert.deepEqual(b4.input.map((/** @type {any} */ s) => s.type), ['user_input', 'model_output', 'user_input']);
  assert.match(t4.reply.text, /tomorrow/i, 'it knew the tool result, kept on its side, and the other model\'s answer');
  // Google forgets the last kept turn: the next is sent again whole, to the same model.
  const last = /** @type {any} */ ((await ws.readJSON('sys:device', '/llm/kept.json')).turns.find((/** @type {any} */ x) => x.n === 7));
  const del = type.forgetRequest({ endpoint, key: KEY, id: last.id });
  assert.equal((await fetch(del.url, { method: del.method, headers: del.headers })).status, 200);
  await pause();
  const t5 = await turn([m1, r1, tr, r2, m3, r3, m4, msg('assistant', ...t4.reply.parts), msg('user', { type: 'text', text: 'Say that word again.' })]);
  assert.deepEqual(t5.attempts.map((a) => a.outcome), ['forgotten', 'ok']);
  assert.equal(sent.at(-1).previous_interaction_id, undefined);
  // Every turn Google keeps, deleted.
  await kept.queue();
  const done = await kept.drain({ fetch, resolve: async () => ({ type, endpoint, key: KEY, print: await keyPrint(KEY, endpoint.baseUrl) }) });
  assert.deepEqual(done.left, 0);
  assert.ok(done.done >= 3);
});

// G3: transcription and voices. Each sentence is one request; the free tier allows a TTS model 3 a minute and 10 a day
// (measured 2026-10-20), so GEMINI_TTS names another when one's day is used up.
const types = loadTypes();
const TTS = process.env.GEMINI_TTS ?? 'gemini-3.8-flash-lite-tts';
/** @param {string} t @param {string} providerId @param {string} name */
const speechSpec = (t, providerId, name) => {
  const type = types.get(t);
  return { type, endpoint: endpointOf(type, { type: t, baseUrl: 'https://generativelanguage.googleapis.com' }), model: modelOf({ providerId, name, prices: null }), key: KEY, timeoutMs: 30_000 };
};
/** One speech call, or a polite skip when the free day is used up. @param {any} t @param {any} c */
async function speak(t, c) {
  try {
    return await speechCall(c);
  } catch (e) {
    if (/** @type {any} */ (e)?.kind === 'rate' && /** @type {any} */ (e).retryAfter > 10 * 60_000) t.skip(`the free day is used up for ${c.model.providerId}: ${/** @type {any} */ (e).message}`);
    throw e;
  }
}
const clip = async () => new Uint8Array(await readFile(new URL('../fixtures/voice/where-eat.ogg', import.meta.url)));

test("an Opus clip transcribed by Google's transcription model, and by Flash Lite told to write it down (G3)", { skip }, async (t) => {
  for (const id of ['gemini-3.5-transcribe', 'gemini-3.5-flash-lite']) {
    const r = await speak(t, { ...speechSpec('gemini-transcription', id, id), audio: { data: await clip(), mediaType: 'audio/ogg', seconds: 1 } });
    if (!r) return;
    assert.match(String(r.text), /where should we eat/i, id);
  }
});

// First audio, measured from the free key with the connection's setup: Flash Lite TTS 0.6 s, Flash TTS 1.6 s (2026-10-20).
const FIRST_MS = TTS.includes('lite') ? 1500 : 2500;

test("a second of silence transcribed is nothing heard: Google's tags for sounds don't come through as words (fix pass)", { skip }, async (t) => {
  const r = await speak(t, { ...speechSpec('gemini-transcription', 'gemini-3.5-transcribe', 'Transcribe'), audio: { data: encodeWav(new Float32Array(16000), 16000), mediaType: 'audio/wav', seconds: 1 } });
  if (!r) return;
  t.diagnostic(`heard: ${JSON.stringify(r.text)}`);
  assert.doesNotMatch(String(r.text), /[<>]/);
  assert.doesNotMatch(String(r.text), /noise|silence/i);
});

test('a 2-sentence voice reply, streamed at full quality: its first audio in under 1.5 s (Flash Lite TTS), each sentence 24 kHz PCM (G3)', { skip }, async (t) => {
  await pause();
  for (const text of ['Your train to Kyoto leaves at nine fifteen.', 'It goes from platform four, so we have time for coffee.']) {
    const started = Date.now();
    const r = await speak(t, { ...speechSpec('gemini-speech', TTS, TTS), text, stream: true });
    if (!r) return;
    const firstMs = Date.now() - started;
    assert.ok(r.stream, 'a stream');
    assert.equal(r.stream.rate, 24000);
    let samples = 0;
    for await (const pcm of r.stream.chunks) samples += pcm.length;
    t.diagnostic(`"${text}": first audio in ${firstMs} ms, ${(samples / 24000).toFixed(1)} s of speech`);
    assert.ok(firstMs < FIRST_MS, `first audio in ${firstMs} ms`);
    assert.ok(samples / 24000 > 1.5, 'a sentence of speech');
  }
});

test('phone quality, read whole: μ-law at 8 kHz, decoded into one WAV clip (G3)', { skip }, async (t) => {
  await pause();
  const c = speechSpec('gemini-speech', 'gemini-3.8-flash-tts', 'Flash TTS');
  const r = await speak(t, { ...c, endpoint: { ...c.endpoint, tunables: { ...c.endpoint.tunables, format: 'mulaw8' } }, text: 'Turn left at the next light.' });
  if (!r) return;
  assert.equal(r.clip?.mediaType, 'audio/wav');
  const { rate, pcm } = pcm16(/** @type {any} */ (r.clip).data);
  assert.equal(rate, 8000);
  assert.ok(pcm.length / rate > 1, 'a sentence of speech');
});
