import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { openLive } from '../../src/core/realtime/open.js';
import { activate, usageOf, muLaw, fromMuLaw } from '../../plugins-official/openai-realtime/index.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

// OpenAI Realtime (K6), against the stand-in's openai flavour: no OpenAI key was at hand, so these hold the plugin
// to OpenAI's docs as the stand-in speaks them; test/live/openai-realtime.test.js holds it to the real API.

const KEY = 'sk-proj-openai-realtime-test-0123456789';

/** The type as the plugin registers it, and the notes it leaves. @param {any} [more] */
function openaiRealtime(more = {}) {
  /** @type {any} */
  let t = null;
  /** @type {any[]} */
  const notes = [];
  activate({
    providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'openai-realtime' }; return () => {}; } },
    helpers: { ProviderError, base64: { encode: toBase64, decode: fromBase64 } },
    events: { append: async (/** @type {string} */ scope, /** @type {string} */ type, /** @type {any} */ data) => { notes.push([scope, type, data]); } },
    ...more,
  });
  return { type: t, notes };
}
const { type: TYPE, notes: NOTES } = openaiRealtime();

/** @param {string} baseUrl @returns {any} */
const endpoint = (baseUrl) => ({ id: 'pv-o/realtime', provider: 'pv-o', ability: 'realtime', type: 'openai-realtime', name: 'OpenAI', baseUrl, headers: {}, tunables: TYPE.tunables, extraBody: {} });
/** @param {any} [over] @returns {any} */
const model = (over = {}) => ({ id: 'm-r', provider: 'pv-o', ability: 'realtime', name: 'GPT Realtime 2.1', providerId: 'gpt-realtime-2.1', input: ['text', 'image'], tools: true, contextWindow: 128000, maxOutput: 32000,
  prices: { input: 4, cacheRead: 0.4, audioIn: 32, image: 5, output: 24, audioOut: 64 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {}, ...over });
const TOOLS = [{ name: 'tell_kokoro', description: 'Ask Kokoro to check something.', input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
const setup = (/** @type {any} */ over = {}) => ({ instructions: 'You are Koe.', context: '<today>Big Sur, 10:00</today>', tools: TOOLS, ...over });

/** @param {any} s the stand-in @param {any} [o] */
function open(s, o = {}) {
  const store = createMemoryStore();
  const type = o.type ?? TYPE;
  const session = openLive({ type, endpoint: endpoint(`${s.origin}/v1`), model: model(o.model), key: o.key ?? KEY, tunables: { ...type.tunables, ...o.tunables }, setup: setup(o.setup), trace: modelTrace(store, SYS) });
  /** @type {any[]} */
  const events = [];
  session.on((e) => events.push({ ...e, at: Date.now() }));
  return { store, session, events };
}
/** @param {() => boolean} pred */
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** What the stand-in got, by type. @param {any} s */
const kinds = (s) => s.received().map((/** @type {any} */ m) => m.type);
/** 24 kHz 16-bit PCM, ms long, as bytes. @param {number} ms */
const voice = (ms) => new Uint8Array(Int16Array.from({ length: (ms * 24) | 0 }, (_, i) => Math.round(5000 * Math.sin(i / 7))).buffer);
const USAGE = { total_tokens: 1360, input_tokens: 1200, output_tokens: 160, input_token_details: { text_tokens: 700, audio_tokens: 400, image_tokens: 100, cached_tokens: 500,
  cached_tokens_details: { text_tokens: 300, audio_tokens: 150, image_tokens: 50 } }, output_token_details: { text_tokens: 40, audio_tokens: 120 } };

test('session.update: μ-law in, PCM 24 kHz out, no turn detection, transcription and far-field noise reduction, tools as functions; the key only as a subprotocol, never in the address or the trace', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, models: ['gpt-realtime-2.1'], turns: [] });
  try {
    const { session, store } = open(s);
    await session.ready;
    const [c] = s.connections();
    assert.deepEqual([c.path, c.model, c.key, c.protocols], ['/v1/realtime', 'gpt-realtime-2.1', KEY, ['realtime', `openai-insecure-api-key.${KEY}`]]);
    assert.deepEqual([session.audioIn, session.audioOut], [{ format: 'pcmu', rate: 8000 }, { format: 'pcm16', rate: 24000 }]);
    assert.deepEqual(s.received()[0], {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: 'You are Koe.\n\n<today>Big Sur, 10:00</today>',
        output_modalities: ['audio'],
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: null, transcription: { model: 'gpt-transcribe' }, noise_reduction: { type: 'far_field' } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
        },
        tools: [{ type: 'function', name: 'tell_kokoro', description: 'Ask Kokoro to check something.', parameters: TOOLS[0].input }],
        tool_choice: 'auto',
      },
    });
    session.close();
    await session.closed;
    assert.ok(!JSON.stringify(await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, {}))).includes(KEY), 'no key in the trace');
    // PCM both ways, A-law, no transcription and no noise reduction: what the tunables say.
    const pcm = open(s, { tunables: { input: 'pcm16', output: 'pcma', transcription: '', noiseReduction: '', voice: 'cedar' }, setup: { tools: [] } });
    await pcm.session.ready;
    const second = s.received().at(-1).session;
    assert.deepEqual(second.audio, { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null, transcription: null, noise_reduction: null }, output: { format: { type: 'audio/pcma' }, voice: 'cedar' } });
    assert.deepEqual([pcm.session.audioIn, pcm.session.audioOut], [{ format: 'pcm16', rate: 24000 }, { format: 'pcma', rate: 8000 }]);
    assert.deepEqual(second.tools, []);
    pcm.session.close();
  } finally {
    await s.stop();
  }
});

test("a spoken turn: G.711 μ-law appended, then commit and response.create at the cut; what was heard and said, Koe's voice as 16-bit PCM, a tool call once, its usage; the turn completes when its voice would have played", async () => {
  const audio = voice(400);
  const s = await startRealtimeServer({
    flavour: 'openai', key: KEY, pace: 0,
    turns: [{ heard: 'Is Nepenthe open now?', said: "I'm checking on that.", audio, tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open now?' } }, usage: USAGE }],
  });
  try {
    const { session, events, store } = open(s);
    await session.ready;
    const speech = Int16Array.from({ length: 800 }, (_, i) => Math.round(8000 * Math.sin(i / 3)));
    session.activity('start');
    session.audio(new Uint8Array(speech.buffer));
    session.activity('end');
    await until(() => events.some((e) => e.type === 'turn'));
    assert.deepEqual(kinds(s), ['session.update', 'input_audio_buffer.clear', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
    assert.deepEqual(fromBase64(s.received()[2].audio), muLaw(speech), '100 ms at 8 kHz, one byte a sample');
    assert.equal(events.filter((e) => e.type === 'heard').map((e) => e.text).join(''), 'Is Nepenthe open now?');
    assert.equal(events.filter((e) => e.type === 'said').map((e) => e.text).join(''), "I'm checking on that.");
    assert.deepEqual(new Uint8Array(events.filter((e) => e.type === 'audio').flatMap((e) => [...e.data])), audio);
    assert.deepEqual(events.filter((e) => e.type === 'tool').map(({ at, ...e }) => e), [{ type: 'tool', id: 'call_1', name: 'tell_kokoro', input: { text: 'Is Nepenthe open now?' } }], 'once, though OpenAI says it twice');
    assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 400, cacheRead: 350, cacheReadAudio: 150, audioIn: 250, image: 50, output: 40, audioOut: 120 });
    // OpenAI ends a response when it has made it, faster than it plays; the turn ends when playing it would.
    const first = events.find((e) => e.type === 'audio').at;
    const end = events.find((e) => e.type === 'turn');
    assert.equal(end.end, 'complete');
    assert.ok(end.at - first >= 350, `complete ${end.at - first} ms after the first audio of 400 ms`);
    const [req] = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
    assert.ok(Math.abs(req.data.cost - (400 * 4 + 350 * 0.4 + 150 * 0.4 + 250 * 32 + 50 * 5 + 40 * 24 + 120 * 64) / 1e6) < 1e-12);
    session.close();
  } finally {
    await s.stop();
  }
});

test('a tool answered silently starts no response; answered aloud, it starts one once the response in progress is done', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, pace: 0.5, turns: [{ said: 'Checking.', audio: voice(400), tool: { name: 'tell_kokoro', args: { text: 'Open?' } } }, { said: 'It is open.', audio: voice(100) }] });
  try {
    const { session, events } = open(s);
    await session.ready;
    session.text('Is Nepenthe open?');
    await until(() => events.some((e) => e.type === 'tool'));
    // Answered while OpenAI still makes the response: the answer waits for it to end, then goes.
    session.answer('call_1', 'tell_kokoro', 'sent', { silent: true });
    await sleep(30);
    assert.equal(kinds(s).length, 3, 'held while OpenAI makes the response');
    await until(() => kinds(s).length === 4);
    await sleep(100);
    assert.deepEqual(kinds(s), ['session.update', 'conversation.item.create', 'response.create', 'conversation.item.create']);
    assert.deepEqual(s.received()[3].item, { type: 'function_call_output', call_id: 'call_1', output: 'sent' });
    session.answer('call_2', 'read', '{"open":true}');
    await until(() => kinds(s).length === 6);
    assert.deepEqual(kinds(s).slice(4), ['conversation.item.create', 'response.create']);
    await until(() => events.filter((e) => e.type === 'turn').length === 2);
    assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['complete', 'complete']);
    session.close();
  } finally {
    await s.stop();
  }
});

test('an immediate note: response.cancel, truncate at the played point, then the text and a response; the turn ends once, as interrupted', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, pace: 0.5, turns: [{ said: 'Bixby Bridge was finished in 1932, and the story goes on.', audio: voice(3000), usage: USAGE }, { said: 'Sorry, 1932 is right.', audio: voice(1000), usage: USAGE }] });
  try {
    NOTES.length = 0;
    const { session, events } = open(s);
    await session.ready;
    session.text('Tell me about Bixby Bridge.');
    await until(() => events.some((e) => e.type === 'audio'));
    const first = events.find((e) => e.type === 'audio').at;
    await sleep(400);
    session.text('<from_kokoro>It was finished in 1932.</from_kokoro>', { interrupt: true });
    const cutAt = Date.now();
    await until(() => kinds(s).length === 7);
    assert.deepEqual(kinds(s).slice(3), ['response.cancel', 'conversation.item.truncate', 'conversation.item.create', 'response.create']);
    const truncate = s.received()[4];
    assert.equal(truncate.content_index, 0);
    assert.ok(truncate.audio_end_ms >= 300 && truncate.audio_end_ms <= cutAt - first + 50, `cut at ${truncate.audio_end_ms} ms`);
    assert.equal(s.received()[5].item.content[0].text, '<from_kokoro>It was finished in 1932.</from_kokoro>');
    await until(() => events.filter((e) => e.type === 'turn').length === 2);
    await sleep(100);
    assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['interrupted', 'complete'], 'the cut turn ends once');
    assert.equal(events.filter((e) => e.type === 'usage').length, 2, 'the cut response is paid for too');
    // Cut off by voice after OpenAI has made the whole answer: nothing to cancel, only what wasn't heard to truncate.
    session.text('And Nepenthe?');
    await until(() => events.filter((e) => e.type === 'usage').length === 3);
    session.activity('start');
    await until(() => kinds(s).length === 11);
    assert.deepEqual(kinds(s).slice(7), ['conversation.item.create', 'response.create', 'conversation.item.truncate', 'input_audio_buffer.clear']);
    assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['interrupted', 'complete', 'interrupted']);
    // A cut with nothing playing is nothing.
    await sleep(50);
    session.activity('start');
    await sleep(50);
    assert.equal(events.filter((e) => e.type === 'turn').length, 3);
    session.close();
    assert.deepEqual(NOTES.filter((n) => n[1] === 'live.error'), [], 'OpenAI refused nothing');
  } finally {
    await s.stop();
  }
});

test('a photo is an input_image item and starts no response; a typed turn while Koe answers waits for that answer', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, pace: 0.3, turns: [{ said: 'A bridge.', audio: voice(600) }, { said: 'Yes.', audio: voice(100) }] });
  try {
    const { session, events } = open(s);
    await session.ready;
    session.image({ mediaType: 'image/jpeg', data: 'AAAA' });
    session.text('What is this?');
    await until(() => events.some((e) => e.type === 'audio'));
    session.text('Is it old?');
    await sleep(20);
    assert.deepEqual(kinds(s), ['session.update', 'conversation.item.create', 'conversation.item.create', 'response.create'], 'held until the answer is made');
    assert.deepEqual(s.received()[1].item, { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }] });
    await until(() => kinds(s).length === 6);
    assert.deepEqual(kinds(s).slice(4), ['conversation.item.create', 'response.create']);
    await until(() => events.filter((e) => e.type === 'turn').length === 2);
    assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['complete', 'complete']);
    session.close();
  } finally {
    await s.stop();
  }
});

test("G.711 out, when the tunables ask: OpenAI's μ-law played as 16-bit PCM at 8 kHz", async () => {
  const pcm = Int16Array.from({ length: 1600 }, (_, i) => Math.round(9000 * Math.sin(i / 5)));
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, pace: 0, turns: [{ said: 'OK.', audio: muLaw(pcm) }] });
  try {
    const { session, events } = open(s, { tunables: { output: 'pcmu' } });
    await session.ready;
    assert.deepEqual(session.audioOut, { format: 'pcmu', rate: 8000 });
    assert.deepEqual(s.received()[0].session.audio.output.format, { type: 'audio/pcmu' });
    session.text('Say OK.');
    await until(() => events.some((e) => e.type === 'turn'));
    const got = new Uint8Array(events.filter((e) => e.type === 'audio').flatMap((e) => [...e.data]));
    assert.deepEqual(new Int16Array(got.buffer), fromMuLaw(muLaw(pcm)));
    session.close();
  } finally {
    await s.stop();
  }
});

test('refusals before the session is ready: a wrong key is auth with the key blanked, an unknown model not-found, a bad field bad-request; none counts against the plugin', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, models: ['gpt-realtime-2.1'], turns: [] });
  try {
    const wrong = open(s, { key: `${KEY}-old` });
    await assert.rejects(wrong.session.ready, (e) => e instanceof ProviderError && e.kind === 'auth' && e.message.includes('«key»') && !e.message.includes(KEY));
    assert.equal((await wrong.session.closed).kind, 'auth');
    assert.ok(!JSON.stringify(await wrong.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, {}))).includes(KEY), 'the echoed key is blanked in the trace');
    const unknown = open(s, { model: { providerId: 'gpt-nope' } });
    await assert.rejects(unknown.session.ready, (e) => e instanceof ProviderError && e.kind === 'not-found');
    const bad = open(s, { tunables: { voice: 'nobody' } });
    await assert.rejects(bad.session.ready, (e) => e instanceof ProviderError && e.kind === 'bad-request' && /voice/.test(e.message));
    assert.equal(TYPE.classifyClose(3000, 'server_error'), 'server');
    assert.equal(TYPE.classifyClose(3000, 'invalid_request_error'), 'bad-request');
    assert.equal(TYPE.classifyClose(1000, ''), null);
  } finally {
    await s.stop();
  }
});

test('OpenAI caps a session at an hour and has no resume handle: after renewMinutes it asks for a fresh session (goaway)', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, turns: [] });
  try {
    const { session, events } = open(s, { tunables: { renewMinutes: 0.002 } });
    await session.ready;
    await until(() => events.some((e) => e.type === 'goaway'));
    assert.equal(events.find((e) => e.type === 'goaway').ms, Math.round((60 - 0.002) * 60_000));
    assert.ok(!events.some((e) => e.type === 'resume'));
    session.close();
  } finally {
    await s.stop();
  }
});

test("its address is the ability's own, wss: for https, the model in the query; with no key, no key subprotocol; what it takes and gives", () => {
  assert.deepEqual(TYPE.open({ endpoint: endpoint('https://api.openai.com/v1'), key: 'sk-x', tunables: TYPE.tunables, model: model() }),
    { url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1', protocols: ['realtime', 'openai-insecure-api-key.sk-x'] });
  assert.deepEqual(TYPE.open({ endpoint: endpoint('http://127.0.0.1:9000/v1/'), key: null, tunables: TYPE.tunables, model: model({ providerId: 'my model' }) }),
    { url: 'ws://127.0.0.1:9000/v1/realtime?model=my%20model', protocols: ['realtime'] });
  assert.deepEqual(TYPE.audio, { in: [{ format: 'pcmu', rate: 8000 }, { format: 'pcma', rate: 8000 }, { format: 'pcm16', rate: 24000 }], out: [{ format: 'pcm16', rate: 24000 }, { format: 'pcmu', rate: 8000 }, { format: 'pcma', rate: 8000 }] });
  assert.deepEqual(TYPE.tunables, { input: 'pcmu', output: 'pcm16', voice: 'marin', transcription: 'gpt-transcribe', noiseReduction: 'far_field', renewMinutes: 55 });
});

test('usage: text, audio and image apart, cached ones apart, the cached audio as cacheReadAudio; a report without details is all text', () => {
  assert.deepEqual(usageOf(USAGE), { input: 400, cacheRead: 350, cacheReadAudio: 150, audioIn: 250, image: 50, output: 40, audioOut: 120 });
  assert.deepEqual(usageOf({ input_tokens: 90, output_tokens: 10 }), { input: 90, cacheRead: 0, cacheReadAudio: 0, audioIn: 0, output: 10, audioOut: 0 });
  assert.deepEqual(usageOf({ input_tokens: 90, output_tokens: 10, input_token_details: { cached_tokens: 40 } }), { input: 50, cacheRead: 40, cacheReadAudio: 0, audioIn: 0, output: 10, audioOut: 0 });
});

test('after it is ready, what OpenAI refuses is noted in the trace with the key blanked, never a crash; a frame that is not JSON is skipped with a note', async () => {
  const { type, notes } = openaiRealtime({ secrets: { blank: async (/** @type {any} */ v) => JSON.parse(JSON.stringify(v).split(KEY).join('«key»')) } });
  /** @type {(d: string | Uint8Array) => void} */
  let deliver = () => {};
  /** @type {any[]} */
  const sent = [];
  /** @type {any[]} */
  const events = [];
  const driver = type.attach({ send: (/** @type {string} */ d) => sent.push(JSON.parse(d)), on: (/** @type {any} */ fn) => { deliver = fn; } },
    { model: model(), tunables: type.tunables, setup: { ...setup(), audioIn: { format: 'pcmu', rate: 8000 }, audioOut: { format: 'pcm16', rate: 24000 } }, emit: (/** @type {any} */ e) => events.push(e) });
  assert.doesNotThrow(() => deliver('<html>Bad gateway</html>'));
  deliver(JSON.stringify({ type: 'session.created', session: {} }));
  deliver(JSON.stringify({ type: 'session.updated', session: {} }));
  await driver.ready;
  deliver(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: `Something about ${KEY} went wrong.`, param: null } }));
  deliver(JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_1', error: { code: 'audio_unintelligible', message: 'Could not hear it.' } }));
  await sleep(10);
  assert.deepEqual(notes, [
    ['sys', 'live.skipped', { bytes: 24 }],
    ['sys', 'live.error', { code: 'invalid_value', message: 'Something about «key» went wrong.' }],
    ['sys', 'live.error', { code: 'audio_unintelligible', message: 'Could not hear it.' }],
  ]);
  assert.deepEqual(events, []);
  driver.close();
});

test("openai-realtime is a protocol in annai's catalog: a keyed name, reserved as annai's", async () => {
  const catalog = JSON.parse(await readFile(new URL('../../catalog/plugins.json', import.meta.url), 'utf8')).plugins;
  const entry = catalog.find((/** @type {any} */ p) => p.id === 'openai-realtime');
  assert.deepEqual(entry.provides, { 'endpoint-type': ['openai-realtime'] });
  assert.deepEqual(Object.keys(entry.files).sort(), ['annai-plugin.json', 'index.js']);
  const { OFFICIAL_NAMES } = await import('../../src/core/official-names.js');
  assert.equal(OFFICIAL_NAMES['endpoint-type']['openai-realtime'], 'openai-realtime');
});

test('after a cut-in, what the cancelled answer still sends is dropped: its voice and its words were never heard', async () => {
  const { type } = openaiRealtime();
  /** @type {(d: string | Uint8Array) => void} */
  let deliver = () => {};
  /** @type {any[]} */
  const sent = [];
  /** @type {any[]} */
  const events = [];
  const driver = type.attach({ send: (/** @type {string} */ d) => sent.push(JSON.parse(d)), on: (/** @type {any} */ fn) => { deliver = fn; } },
    { model: model(), tunables: type.tunables, setup: { ...setup(), audioIn: { format: 'pcmu', rate: 8000 }, audioOut: { format: 'pcm16', rate: 24000 } }, emit: (/** @type {any} */ e) => events.push(e) });
  const say = (/** @type {any} */ m) => deliver(JSON.stringify(m));
  say({ type: 'session.updated', session: {} });
  await driver.ready;
  driver.text('Tell me about Bixby Bridge.');
  say({ type: 'response.created', response: { id: 'resp_1' } });
  say({ type: 'response.output_audio.delta', item_id: 'item_1', delta: toBase64(voice(1000)) });
  say({ type: 'response.output_audio_transcript.delta', item_id: 'item_1', delta: 'Bixby Bridge ' });
  driver.text('<from_kokoro>1932.</from_kokoro>', { interrupt: true });
  say({ type: 'response.output_audio.delta', item_id: 'item_1', delta: toBase64(voice(1000)) });
  say({ type: 'response.output_audio_transcript.delta', item_id: 'item_1', delta: 'was built in steel' });
  say({ type: 'response.output_audio_transcript.done', item_id: 'item_1', transcript: 'Bixby Bridge was built in steel' });
  assert.deepEqual(events.map((e) => e.type === 'said' ? `said:${e.text}` : e.type === 'turn' ? `turn:${e.end}` : e.type), ['audio', 'said:Bixby Bridge ', 'turn:interrupted']);
  assert.deepEqual(sent.map((m) => m.type).slice(1), ['conversation.item.create', 'response.create', 'response.cancel', 'conversation.item.truncate']);
  say({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled', output: [] } });
  assert.deepEqual(sent.map((m) => m.type).slice(5), ['conversation.item.create', 'response.create'], 'the note goes once the cancelled answer is done');
  assert.equal(events.filter((e) => e.type === 'turn').length, 1);
  driver.close();
});

test('a response OpenAI refuses ends that turn and frees what waits behind it: the next turn goes, and is answered (review)', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: KEY, pace: 0, turns: [{ refuse: 'response_refused' }, { said: 'Yes, I am here.', audio: voice(200) }] });
  try {
    NOTES.length = 0;
    const { session, events } = open(s);
    await session.ready;
    session.text('Hello');
    await until(() => events.some((e) => e.type === 'turn'));
    assert.deepEqual(events.filter((e) => e.type !== 'usage').map((e) => e.type === 'turn' ? `turn:${e.end}` : e.type), ['turn:complete'], 'nothing waits for an answer that will never come');
    session.text('Are you there?');
    await until(() => events.filter((e) => e.type === 'turn').length === 2);
    assert.equal(events.filter((e) => e.type === 'said').map((e) => e.text).join(''), 'Yes, I am here.');
    const creates = s.received().filter((m) => m.type === 'response.create');
    assert.equal(creates.length, 2);
    assert.ok(creates.every((m) => typeof m.event_id === 'string' && m.event_id), 'each response.create says which it is, so a refusal can name it');
    await sleep(20);
    assert.deepEqual(NOTES.filter((n) => n[1] === 'live.error').map((n) => n[2].code), ['response_refused']);
    session.close();
  } finally {
    await s.stop();
  }
});

/** The driver on a fake socket, ready: what it sent, what it told, and a way to say what OpenAI says. @param {any} [setupOver] */
async function bare(setupOver = {}) {
  const { type, notes } = openaiRealtime();
  /** @type {(d: string | Uint8Array) => void} */
  let deliver = () => {};
  /** @type {any[]} */
  const sent = [];
  /** @type {any[]} */
  const events = [];
  const driver = type.attach({ send: (/** @type {string} */ d) => sent.push(JSON.parse(d)), on: (/** @type {any} */ fn) => { deliver = fn; } },
    { model: model(), tunables: type.tunables, setup: { ...setup(), audioIn: { format: 'pcmu', rate: 8000 }, audioOut: { format: 'pcm16', rate: 24000 }, ...setupOver }, emit: (/** @type {any} */ e) => events.push(e) });
  const say = (/** @type {any} */ m) => deliver(JSON.stringify(m));
  say({ type: 'session.updated', session: {} });
  await driver.ready;
  return { driver, sent, events, notes, say };
}

test("a refusal that names no event still frees a response.create OpenAI hadn't taken up (the reviewer's probe)", async () => {
  const { driver, sent, events, say } = await bare();
  driver.text('Hello');
  say({ type: 'error', error: { type: 'invalid_request_error', code: 'some_refusal', message: 'The response could not be created.', param: null, event_id: null } });
  driver.text('Are you there?');
  driver.answer('call_x', 'tool', 'ok');
  assert.deepEqual(sent.slice(3).map((m) => m.type), ['conversation.item.create', 'response.create'], 'the queue moves again');
  assert.deepEqual(events.map((e) => e.end), ['complete']);
  // Once OpenAI takes a response up, a refusal that names nothing is about something else.
  say({ type: 'response.created', response: { id: 'resp_2' } });
  say({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Something else.', param: null, event_id: null } });
  assert.equal(sent.length, 5, 'the rest waits for that response');
  say({ type: 'response.done', response: { id: 'resp_2', status: 'completed', output: [] } });
  assert.deepEqual(sent.slice(5).map((m) => m.type), ['conversation.item.create', 'response.create']);
  driver.close();
});

test("a cancel that crosses an answer's natural end is no error: nothing noted, and the turn ends once, as cut (the reviewer's probe)", async () => {
  const { driver, sent, events, notes, say } = await bare();
  driver.text('Tell me a story');
  say({ type: 'response.created', response: { id: 'r1' } });
  say({ type: 'response.output_audio.delta', item_id: 'i1', delta: toBase64(new Uint8Array(48_000)) });
  driver.activity('start');
  assert.deepEqual(sent.slice(3).map((m) => m.type), ['response.cancel', 'conversation.item.truncate']);
  say({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
  say({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found', param: null, event_id: sent[3].event_id ?? null } });
  driver.activity('end');
  say({ type: 'error', error: { type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty', message: 'Error committing input audio buffer: buffer too small.', param: null, event_id: null } });
  await sleep(10);
  assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['interrupted']);
  assert.deepEqual(notes, [], 'races annai expects are not errors to report');
  driver.close();
});

test('a transcript ends with a final piece even when its pieces said it all (review)', async () => {
  const { driver, events, say } = await bare();
  say({ type: 'response.output_audio_transcript.delta', item_id: 'i1', delta: 'Hi ' });
  say({ type: 'response.output_audio_transcript.delta', item_id: 'i1', delta: 'there.' });
  say({ type: 'response.output_audio_transcript.done', item_id: 'i1', transcript: 'Hi there.' });
  say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Hello.' });
  assert.deepEqual(events.map(({ type, text, final }) => [type, text, final]), [['said', 'Hi ', false], ['said', 'there.', false], ['said', '', true], ['heard', 'Hello.', true]]);
  driver.close();
});

test("told how much of the turn was heard (playedMs, K5's), it truncates there, item by item; told nothing, by the clock (review)", async () => {
  const { driver, sent, events, say } = await bare();
  driver.text('Tell me about Bixby Bridge.');
  say({ type: 'response.created', response: { id: 'r1' } });
  say({ type: 'response.output_audio.delta', item_id: 'i1', delta: toBase64(voice(400)) });
  say({ type: 'response.output_audio.delta', item_id: 'i2', delta: toBase64(voice(600)) });
  driver.text('<from_kokoro>It opened in 1932.</from_kokoro>', { interrupt: true, playedMs: 700 });
  assert.deepEqual(sent.filter((m) => m.type === 'conversation.item.truncate').map((m) => [m.item_id, m.audio_end_ms]), [['i2', 300]], 'the first item was heard whole');
  say({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
  say({ type: 'response.created', response: { id: 'r2' } });
  say({ type: 'response.output_audio.delta', item_id: 'i3', delta: toBase64(voice(1000)) });
  say({ type: 'response.done', response: { id: 'r2', status: 'completed', output: [] } });
  await sleep(60);
  // The player started late: it says 20 ms, where the clock would say more.
  driver.activity('start', { playedMs: 20 });
  assert.deepEqual(sent.filter((m) => m.type === 'conversation.item.truncate').map((m) => [m.item_id, m.audio_end_ms]).at(-1), ['i3', 20]);
  assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['interrupted', 'interrupted']);
  // The voice played out by the clock, and annai's player still says only part of it was heard: truncated there, the turn ended once.
  driver.activity('end');
  say({ type: 'response.created', response: { id: 'r3' } });
  say({ type: 'response.output_audio.delta', item_id: 'i4', delta: toBase64(voice(30)) });
  say({ type: 'response.done', response: { id: 'r3', status: 'completed', output: [] } });
  await sleep(80);
  driver.activity('start', { playedMs: 10 });
  assert.deepEqual(sent.filter((m) => m.type === 'conversation.item.truncate').map((m) => [m.item_id, m.audio_end_ms]).at(-1), ['i4', 10]);
  assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['interrupted', 'interrupted', 'complete']);
  driver.close();
});
