import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { openLive } from '../../src/core/realtime/open.js';
import { activate, usageOf } from '../../plugins-official/openai-realtime/index.js';
import { muLaw, fromMuLaw } from '../../plugins-official/openai-realtime/g711.js';
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
  assert.deepEqual(Object.keys(entry.files).sort(), ['annai-plugin.json', 'g711.js', 'index.js']);
  const { OFFICIAL_NAMES } = await import('../../src/core/official-names.js');
  assert.equal(OFFICIAL_NAMES['endpoint-type']['openai-realtime'], 'openai-realtime');
});
