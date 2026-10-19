import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeServer } from '../fakes/model-server.js';
import { browserFetch } from '../fakes/browser-fetch.js';

// The stand-in answers as each server's documents say (the plan's "Facts relied on"), and as the
// user's own llama.cpp server (Unsloth Studio) did when measured on 2026-10-19: reasoning_content
// with an empty content beside it, a tool call in pieces, usage and timings when asked for.

const ANNAI = 'https://annai.guide';
const KEY = 'sk-stand-in-0123456789';
const fetchAs = browserFetch(ANNAI);

/** A chat request as annai's Chat Completions sends it. @param {any} [more] */
const chat = (more = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Hi' }], stream: true, stream_options: { include_usage: true }, ...more }),
});
/** The chunks of a stream, parsed. @param {Response} res @returns {Promise<any[]>} */
async function chunks(res) {
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    out.push(line === 'data: [DONE]' ? '[DONE]' : JSON.parse(line.slice(6)));
  }
  return out;
}
/** What the chunks' deltas say, joined. @param {any[]} cs @param {string} field */
const joined = (cs, field) => cs.filter((c) => c !== '[DONE]').flatMap((c) => c.choices ?? []).map((ch) => ch.delta?.[field] ?? '').join('');

test('llamacpp: /v1/models has one entry with architecture.input_modalities; a stream carries reasoning_content, a tool call in pieces, then usage and timings', async () => {
  const s = await startFakeServer({ flavour: 'llamacpp', replies: [{ reasoning: 'The user wants the weather.', calls: [{ name: 'weather', input: { place: 'Big Sur' } }], usage: { input: 300, output: 64 } }] });
  try {
    const list = await (await fetchAs(`${s.origin}/v1/models`)).json();
    assert.equal(list.data.length, 1);
    assert.deepEqual(list.data[0].architecture.input_modalities, ['text', 'image']);
    assert.equal(typeof list.data[0].meta.n_ctx_train, 'number');
    const props = await (await fetchAs(`${s.origin}/props`)).json();
    assert.equal(typeof props.default_generation_settings.n_ctx, 'number');
    const res = await fetchAs(`${s.origin}/v1/chat/completions`, chat());
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    const cs = await chunks(res);
    assert.equal(joined(cs, 'reasoning_content'), 'The user wants the weather.');
    assert.ok(cs.some((c) => c.choices?.[0]?.delta?.reasoning_content && c.choices[0].delta.content === ''), 'an empty content beside the reasoning, as the real server sends');
    const pieces = cs.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    assert.ok(pieces.length > 1, 'in pieces');
    assert.deepEqual([pieces[0].id?.length > 0, pieces[0].function.name, pieces.slice(1).every((p) => !p.id && !p.function.name)], [true, 'weather', true]);
    assert.deepEqual(JSON.parse(pieces.map((p) => p.function.arguments).join('')), { place: 'Big Sur' });
    assert.equal(cs.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
    const last = cs.at(-2);
    assert.deepEqual([last.choices, last.usage.prompt_tokens, last.usage.completion_tokens, typeof last.timings.predicted_n], [[], 300, 64, 'number']);
    assert.equal(cs.at(-1), '[DONE]');
    // Usage only when asked for, as the real server does.
    const quiet = await chunks(await fetchAs(`${s.origin}/v1/chat/completions`, chat({ stream_options: undefined })));
    assert.ok(!quiet.some((c) => c.usage));
    assert.deepEqual(s.requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body.model]), [['/v1/chat/completions', 'm'], ['/v1/chat/completions', 'm']]);
  } finally {
    await s.stop();
  }
});

test('vllm and sglang list max_model_len; vllm streams reasoning, sglang reasoning_content; each says text after it', async () => {
  for (const [flavour, field] of /** @type {const} */ ([['vllm', 'reasoning'], ['sglang', 'reasoning_content']])) {
    const s = await startFakeServer({ flavour, replies: [{ reasoning: 'Thinking.', text: 'Hello there.' }] });
    try {
      const list = await (await fetchAs(`${s.origin}/v1/models`)).json();
      assert.equal(list.data[0].max_model_len, 32768, flavour);
      const cs = await chunks(await fetchAs(`${s.origin}/v1/chat/completions`, chat()));
      assert.equal(joined(cs, field), 'Thinking.', flavour);
      assert.equal(joined(cs, field === 'reasoning' ? 'reasoning_content' : 'reasoning'), '', `${flavour}: one field only`);
      assert.equal(joined(cs, 'content'), 'Hello there.', flavour);
    } finally {
      await s.stop();
    }
  }
});

test("ollama allows only its own origins unless told: annai's page is blocked; with cors ['https://annai.guide'] it reads; LM Studio is off until Enable CORS", async () => {
  const own = await startFakeServer({ flavour: 'ollama' });
  const told = await startFakeServer({ flavour: 'ollama', cors: [ANNAI] });
  const lms = await startFakeServer({ flavour: 'lmstudio' });
  try {
    await assert.rejects(fetchAs(`${own.origin}/v1/models`), TypeError);
    await assert.rejects(fetchAs(`${own.origin}/v1/chat/completions`, chat()), TypeError);
    assert.equal((await browserFetch('http://localhost:5173')(`${own.origin}/v1/models`)).status, 200, 'its own origins');
    assert.deepEqual((await (await fetchAs(`${told.origin}/v1/models`)).json()).data.map((/** @type {any} */ m) => m.id), ['qwen3:8b']);
    const cs = await chunks(await fetchAs(`${told.origin}/v1/chat/completions`, chat()));
    assert.equal(cs.at(-1), '[DONE]');
    await assert.rejects(fetchAs(`${lms.origin}/v1/models`), TypeError);
  } finally {
    await Promise.all([own.stop(), told.stop(), lms.stop()]);
  }
});

test('whole ignores stream: true and answers one application/json chat.completion, its reasoning, words, calls and usage', async () => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY, replies: [{ reasoning: 'Hmm.', text: 'Here.', calls: [{ name: 'show', input: { card: { title: 'Nepenthe' } } }] }] });
  try {
    const res = await fetchAs(`${s.origin}/v1/chat/completions`, { ...chat(), headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } });
    assert.equal(res.headers.get('content-type'), 'application/json');
    const j = await res.json();
    assert.equal(j.object, 'chat.completion');
    const m = j.choices[0].message;
    assert.deepEqual([m.content, m.reasoning_content, m.tool_calls[0].function.name, JSON.parse(m.tool_calls[0].function.arguments), j.choices[0].finish_reason], ['Here.', 'Hmm.', 'show', { card: { title: 'Nepenthe' } }, 'tool_calls']);
    assert.equal(typeof j.usage.prompt_tokens, 'number');
  } finally {
    await s.stop();
  }
});

test('an empty POST is 400 on a route it has, 404 elsewhere, 405 for GET on a POST route; a key is asked for; authEverywhere answers 401 on any /v1 path without the key; spa answers 200 text/html for any unknown path', async () => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY });
  const auth = { authorization: `Bearer ${KEY}` };
  try {
    const post = (/** @type {string} */ path, /** @type {any} */ headers = auth) => fetchAs(`${s.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '' });
    assert.equal((await post('/v1/chat/completions')).status, 400);
    assert.equal((await post('/v1/responses')).status, 400);
    assert.equal((await post('/v1/audio/speech')).status, 404);
    assert.equal((await fetchAs(`${s.origin}/v1/chat/completions`, { headers: auth })).status, 405);
    const no = await post('/v1/chat/completions', {});
    assert.equal(no.status, 401);
    assert.equal((await no.json()).error.type, 'authentication_error');
    assert.equal((await post('/v1/no-such-path', {})).status, 404, 'an unknown path is 404 without the key, unless auth is everywhere');
  } finally {
    await s.stop();
  }
  const everywhere = await startFakeServer({ flavour: 'llamacpp', key: KEY, authEverywhere: true });
  const spa = await startFakeServer({ flavour: 'lmstudio', cors: '*', spa: true });
  try {
    for (const path of ['/v1/chat/completions', '/v1/no-such-path']) assert.equal((await fetchAs(`${everywhere.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' })).status, 401, path);
    const page = await fetchAs(`${spa.origin}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' });
    assert.deepEqual([page.status, page.headers.get('content-type')], [200, 'text/html; charset=utf-8']);
    assert.equal((await fetchAs(`${spa.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' })).status, 400, 'a real route still answers as itself');
  } finally {
    await Promise.all([everywhere.stop(), spa.stop()]);
  }
});
