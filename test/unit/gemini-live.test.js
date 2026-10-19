import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { openLive } from '../../src/core/realtime/open.js';
import { activate } from '../../plugins-official/gemini-live/index.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

const KEY = 'AIza-gemini-live-test-0123456789';

/** The type as the plugin registers it. @returns {any} */
function geminiLive() {
  /** @type {any} */
  let t = null;
  activate({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'gemini-live' }; return () => {}; } }, helpers: { ProviderError, base64: { encode: toBase64, decode: fromBase64 } } });
  return t;
}
const TYPE = geminiLive();

/** @param {string} baseUrl @returns {any} */
const endpoint = (baseUrl) => ({ id: 'pv-g/live', provider: 'pv-g', ability: 'live', type: 'gemini-live', name: 'Google Gemini', baseUrl, headers: {}, tunables: TYPE.tunables, extraBody: {} });
/** @param {any} [over] @returns {any} */
const model = (over = {}) => ({ id: 'm-l', provider: 'pv-g', ability: 'live', name: 'Gemini 3.8 Live', providerId: 'gemini-3.8-live', input: ['text', 'image'], tools: true, contextWindow: 128000, maxOutput: null,
  prices: { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {}, ...over });
const TOOLS = [{ name: 'tell_kokoro', description: 'Ask Kokoro to check something.', input: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'immediate'] } }, required: ['text'], additionalProperties: false } }];
const setup = (/** @type {any} */ over = {}) => ({ instructions: 'You are Koe.', context: '<today>Big Sur, 10:00</today>', tools: TOOLS, audioIn: { format: /** @type {const} */ ('pcm16'), rate: 16000 }, audioOut: { format: /** @type {const} */ ('pcm16'), rate: 24000 }, ...over });

/** @param {any} s the stand-in @param {any} [o] */
function open(s, o = {}) {
  const store = createMemoryStore();
  const session = openLive({ type: TYPE, endpoint: endpoint(s.origin), model: model(), key: KEY, tunables: { ...TYPE.tunables, ...o.tunables }, setup: setup(o.setup), trace: modelTrace(store, SYS) });
  /** @type {any[]} */
  const events = [];
  session.on((e) => events.push(e));
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

test('setup: instructions, tools as parametersJsonSchema, manual activity, both transcripts, resumption, compression, proactive audio on v1alpha', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [] });
  try {
    const { session, store } = open(s, { tunables: { voice: 'Kore' } });
    await session.ready;
    const [c] = s.connections();
    assert.equal(c.version, 'v1alpha');
    assert.equal(c.key, KEY, 'the key goes in the address, the only way a browser can give it');
    const got = s.received()[0].setup;
    assert.equal(got.model, 'models/gemini-3.8-live');
    assert.deepEqual(got.generationConfig, { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } });
    assert.deepEqual(got.systemInstruction, { parts: [{ text: 'You are Koe.\n\n<today>Big Sur, 10:00</today>' }] });
    assert.deepEqual(got.tools, [{ functionDeclarations: [{ name: 'tell_kokoro', description: 'Ask Kokoro to check something.', parametersJsonSchema: TOOLS[0].input }] }]);
    assert.deepEqual(got.realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
    assert.deepEqual([got.inputAudioTranscription, got.outputAudioTranscription], [{}, {}]);
    assert.deepEqual(got.sessionResumption, {});
    assert.deepEqual(got.contextWindowCompression, { slidingWindow: {} });
    assert.deepEqual(got.proactivity, { proactiveAudio: true });
    session.close();
    await session.closed;
    // A handle resumes; with no tools and no voice, neither is sent; compression can be turned off.
    const again = open(s, { setup: { resume: 'h-7', tools: [] }, tunables: { compression: false, proactive: false } });
    await again.session.ready;
    const second = s.received().at(-1).setup;
    assert.deepEqual(second.sessionResumption, { handle: 'h-7' });
    assert.deepEqual([second.tools, second.contextWindowCompression, second.proactivity, second.generationConfig.speechConfig], [undefined, undefined, undefined, undefined]);
    again.session.close();
    await again.session.closed;
    const lives = (await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['live.session'] }))).map((e) => e.data.state);
    assert.deepEqual(lives, ['open', 'ready', 'closed']);
    const resumed = (await again.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['live.session'] }))).map((e) => e.data.state);
    assert.deepEqual(resumed, ['open', 'resumed', 'closed']);
  } finally {
    await s.stop();
  }
});

test('what the server says becomes events: audio, both transcripts, the turn, a tool call, the handle, goAway, interrupted', async () => {
  const audio = Uint8Array.from({ length: 24_000 }, (_, i) => (i * 7) % 256);
  const s = await startRealtimeServer({
    flavour: 'gemini', key: KEY, pace: 0.02,
    turns: [
      { heard: 'Is Nepenthe open now?', said: "I'm checking on that.", audio, tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open now?' } }, handle: 'h-2', goAway: 30 },
      { said: 'Bixby Bridge was finished in 1932, and the story goes on.', audio: new Uint8Array(48_000 * 3) },
    ],
  });
  try {
    const { session, events } = open(s);
    await session.ready;
    session.activity('start');
    session.audio(new Uint8Array(3200));
    session.activity('end');
    await until(() => events.some((e) => e.type === 'goaway'));
    assert.equal(events.filter((e) => e.type === 'heard').map((e) => e.text).join(''), 'Is Nepenthe open now?');
    assert.equal(events.filter((e) => e.type === 'said').map((e) => e.text).join(''), "I'm checking on that.");
    const heard = new Uint8Array(events.filter((e) => e.type === 'audio').flatMap((e) => [...e.data]));
    assert.deepEqual(heard, audio);
    assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', id: 'call_1', name: 'tell_kokoro', input: { text: 'Is Nepenthe open now?' } });
    assert.ok(events.some((e) => e.type === 'turn' && e.end === 'complete'));
    assert.equal(session.handle, 'h-2');
    assert.equal(events.find((e) => e.type === 'goaway').ms, 30_000);
    // What it sent: the activity, the audio as Gemini's PCM, at 16 kHz.
    const sent = s.received().slice(1, 4);
    assert.deepEqual(sent[0], { realtimeInput: { activityStart: {} } });
    assert.deepEqual(sent[1], { realtimeInput: { audio: { data: toBase64(new Uint8Array(3200)), mimeType: 'audio/pcm;rate=16000' } } });
    assert.deepEqual(sent[2], { realtimeInput: { activityEnd: {} } });
    // A typed turn that talks on, cut off by the user's voice.
    session.text('Tell me about Bixby Bridge.');
    await until(() => events.some((e) => e.type === 'said' && e.text.startsWith('Bixby')));
    session.activity('start');
    await until(() => events.some((e) => e.type === 'turn' && e.end === 'interrupted'));
    // Gemini ends the cut turn with a turnComplete of its own: still one end for that turn.
    await until(() => s.received().length >= 6);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events.filter((e) => e.type === 'turn').map((e) => e.end), ['complete', 'interrupted']);
    session.close();
  } finally {
    await s.stop();
  }
});

test('a tool answer carries scheduling SILENT; a text turn is clientContent with turnComplete; a photo is a turn of its own', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, pace: 0, turns: [{ said: 'Checking.' }] });
  try {
    const { session } = open(s);
    await session.ready;
    session.answer('call_9', 'tell_kokoro', 'sent', { silent: true });
    session.answer('call_10', 'read', '{"ok":true}');
    session.text('<from_kokoro>Nepenthe is open until 10 pm.</from_kokoro>', { interrupt: true });
    session.image({ mediaType: 'image/jpeg', data: 'AAAA' });
    await until(() => s.received().length >= 5);
    const [, a, b, t, img] = s.received();
    assert.deepEqual(a, { toolResponse: { functionResponses: [{ id: 'call_9', name: 'tell_kokoro', response: { result: 'sent' }, scheduling: 'SILENT' }] } });
    assert.deepEqual(b, { toolResponse: { functionResponses: [{ id: 'call_10', name: 'read', response: { result: '{"ok":true}' } }] } });
    assert.deepEqual(t, { clientContent: { turns: [{ role: 'user', parts: [{ text: '<from_kokoro>Nepenthe is open until 10 pm.</from_kokoro>' }] }], turnComplete: true } });
    assert.deepEqual(img, { clientContent: { turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] }], turnComplete: false } });
    session.close();
  } finally {
    await s.stop();
  }
});

test('usage by modality becomes input, output, audioIn and audioOut, and is priced', async () => {
  const usage = {
    promptTokenCount: 646, responseTokenCount: 75, totalTokenCount: 721, thoughtsTokenCount: 21, cachedContentTokenCount: 100,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 359 }, { modality: 'AUDIO', tokenCount: 222 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 54 }],
  };
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, pace: 0, turns: [{ said: 'OK.', usage }] });
  try {
    const { session, events, store } = open(s);
    await session.ready;
    session.text('Say OK.');
    await until(() => events.some((e) => e.type === 'usage'));
    // Prompt: 222 audio, 100 cached, the rest (324) text; response: 54 audio, 21 other, and 21 thinking counted as output.
    assert.deepEqual(events.find((e) => e.type === 'usage').usage, { input: 324, cacheRead: 100, audioIn: 222, output: 42, reasoning: 21, audioOut: 54 });
    const [req] = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
    assert.ok(Math.abs(req.data.cost - (324 * 0.75 + 100 * 0.75 + 222 * 3 + 42 * 4.5 + 54 * 12) / 1e6) < 1e-12);
    session.close();
  } finally {
    await s.stop();
  }
});

test('a 1007 about proactivity reconnects once on v1beta without it (decision 11); a wrong key is auth, an unknown model not-found', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, models: ['gemini-3.8-live'], turns: [] });
  try {
    const { session } = open(s, { tunables: { apiVersion: 'v1beta' } });
    await session.ready;
    assert.deepEqual(s.connections().map((c) => c.version), ['v1beta', 'v1beta']);
    assert.deepEqual(s.received().map((m) => Boolean(m.setup.proactivity)), [true, false]);
    assert.equal(session.tunables.proactive, false);
    session.close();
    const wrong = openLive({ type: TYPE, endpoint: endpoint(s.origin), model: model(), key: 'nope', tunables: TYPE.tunables, setup: setup(), trace: null });
    await assert.rejects(wrong.ready, (e) => e instanceof ProviderError && e.kind === 'auth');
    const unknown = openLive({ type: TYPE, endpoint: endpoint(s.origin), model: model({ providerId: 'gemini-nope' }), key: KEY, tunables: TYPE.tunables, setup: setup(), trace: null });
    await assert.rejects(unknown.ready, (e) => e instanceof ProviderError && e.kind === 'not-found' && /gemini-nope is not found/.test(e.message));
    assert.equal(TYPE.classifyClose(1007, 'Invalid JSON payload received. Unknown name "x"'), 'bad-request');
  } finally {
    await s.stop();
  }
});

test("its address is the ability's own, as wss: for https and ws: for a server on this device", () => {
  assert.equal(TYPE.open({ endpoint: endpoint('https://generativelanguage.googleapis.com'), key: 'k', tunables: TYPE.tunables, model: model() }).url,
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=k');
  assert.equal(TYPE.open({ endpoint: endpoint('http://127.0.0.1:9000/'), key: 'a b', tunables: { ...TYPE.tunables, apiVersion: 'v1beta' }, model: model() }).url,
    'ws://127.0.0.1:9000/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=a%20b');
  assert.deepEqual(TYPE.audio, { in: [{ format: 'pcm16', rate: 16000 }], out: [{ format: 'pcm16', rate: 24000 }] });
  assert.deepEqual(TYPE.tunables, { apiVersion: 'v1alpha', proactive: true, voice: '', compression: true });
});
