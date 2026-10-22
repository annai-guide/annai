import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/speech-openai/index.js';
import { ProviderError, errorFromResponse, endpointTypes } from '../../src/core/llm/contract.js';
import { mergePatch } from '../../src/core/patch.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ensureType } from '../../src/core/llm/official.js';
import { addProvider, withSpeech, speechAdd } from '../../src/core/llm/providers.js';
import { official } from './provider-kit.js';
import { readConfig, modelOf } from '../../src/core/llm/config.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { speechCost } from '../../src/core/llm/cost.js';

/** @type {Record<string, any>} */
const types = {};
activate({ providers: { register: (/** @type {any} */ t) => { types[t.type] = t; return () => {}; } }, helpers: { ProviderError, errorFromResponse, mergePatch } });
const hear = types['openai-transcription'];
const say = types['openai-speech'];
/** @param {any} type @param {any} [over] */
const spec = (type, over = {}) => ({
  endpoint: { id: 'ep', type: type.type, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', headers: { 'OpenAI-Organization': 'org-1' }, tunables: { ...type.tunables }, extraBody: {} },
  model: { id: 'm', name: 'Ears', providerId: 'gpt-transcribe', tunables: {}, extraBody: {} },
  key: 'sk-test', tunables: { ...type.tunables }, ...over,
});

test('transcription: the audio as a multipart upload, json back (spec §10.2)', async () => {
  const s = spec(hear, { tunables: { ...hear.tunables, language: 'en' } });
  const r = hear.transcribeRequest({ ...s, audio: { data: new Uint8Array([82, 73, 70, 70]), mediaType: 'audio/wav' } });
  assert.equal(r.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.deepEqual(r.headers, { authorization: 'Bearer sk-test', 'OpenAI-Organization': 'org-1' });
  assert.ok(r.body instanceof FormData);
  assert.equal(r.body.get('model'), 'gpt-transcribe');
  assert.equal(r.body.get('response_format'), 'json');
  assert.equal(r.body.get('language'), 'en');
  assert.equal(r.body.get('prompt'), null);
  const file = /** @type {File} */ (r.body.get('file'));
  assert.equal(file.name, 'speech.wav');
  assert.equal(file.type, 'audio/wav');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [82, 73, 70, 70]);
  assert.deepEqual(await hear.readTranscript(Response.json({ text: 'Where should we eat?' }), s), { text: 'Where should we eat?' });
  assert.deepEqual(await hear.readTranscript(Response.json({ nothing: 1 }), s), { text: '' });
});

test('voice: the text as JSON, the audio back as it came (spec §10.1)', async () => {
  const s = spec(say, { model: { id: 'm', name: 'Marin', providerId: 'gpt-4o-mini-tts', tunables: {}, extraBody: { speed: 1.1 } }, tunables: { ...say.tunables, instructions: 'Warm and calm.' } });
  const r = say.speechRequest({ ...s, text: 'Bixby Bridge is two miles ahead.' });
  assert.equal(r.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(r.body), { model: 'gpt-4o-mini-tts', input: 'Bixby Bridge is two miles ahead.', voice: 'marin', response_format: 'mp3', instructions: 'Warm and calm', speed: 1.1 });
  const clip = await say.readSpeech(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }), s);
  assert.deepEqual([...clip.data], [1, 2]);
  assert.equal(clip.mediaType, 'audio/mpeg');
  const wav = await say.readSpeech(new Response(new Uint8Array([3]), { headers: { 'content-type': 'application/octet-stream' } }), { ...s, tunables: { ...s.tunables, format: 'wav' } });
  assert.equal(wav.mediaType, 'audio/wav');
  await assert.rejects(say.readSpeech(new Response(new Uint8Array([])), s), (e) => e instanceof ProviderError && e.kind === 'server');
});

test("formats (Koe and Kokoro design, \"Audio formats\"): transcription takes OpenAI's webm, mp4, mp3 and wav, each named for its kind; a voice offers opus, aac, mp3, flac and wav, and answers in the one annai chose", async () => {
  assert.deepEqual(hear.tunables.audioIn, ['webm', 'mp4', 'mp3', 'wav']);
  assert.deepEqual(say.tunables.audioOut, ['opus', 'aac', 'mp3', 'flac', 'wav']);
  assert.equal(say.tunables.format, 'auto');
  const names = [];
  for (const mediaType of ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/flac', 'audio/wav']) {
    names.push(/** @type {File} */ (hear.transcribeRequest({ ...spec(hear), audio: { data: new Uint8Array(1), mediaType } }).body.get('file')).name);
  }
  assert.deepEqual(names, ['speech.webm', 'speech.ogg', 'speech.m4a', 'speech.aac', 'speech.mp3', 'speech.flac', 'speech.wav']);
  const opus = { ...spec(say), tunables: { ...say.tunables, format: 'opus' } };
  assert.equal(JSON.parse(say.speechRequest({ ...opus, text: 'Hi.' }).body).response_format, 'opus');
  assert.equal((await say.readSpeech(new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/octet-stream' } }), opus)).mediaType, 'audio/ogg', "OpenAI's opus is Ogg Opus");
  assert.equal(JSON.parse(say.speechRequest({ ...spec(say), text: 'Hi.' }).body).response_format, 'mp3', 'auto that annai left unresolved (an older annai): MP3, as before');
});

test("format auto asks OpenAI for opus when the device plays Ogg Opus, mp3 when it plays only mp3", async () => {
  /** @type {string[]} */
  const asked = [];
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    asked.push(JSON.parse(init.body).response_format);
    return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/ogg' } });
  };
  const s = spec(say);
  for (const plays of [['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'], ['mp4', 'aac', 'mp3', 'wav'], ['mp3', 'wav']]) {
    await speechCall({ type: say, endpoint: { ...s.endpoint, baseUrl: 'https://api.openai.com/v1' }, model: /** @type {any} */ (s.model), key: null, text: 'Hi.', fetch, plays });
  }
  assert.deepEqual(asked, ['opus', 'aac', 'mp3']);
});

test('errors by their codes; model lists from /models', () => {
  assert.equal(hear.classify(401, JSON.stringify({ error: { code: 'invalid_api_key' } })), 'auth');
  assert.equal(say.classify(429, JSON.stringify({ error: { code: 'insufficient_quota' } })), 'credit');
  assert.equal(say.classify(500, 'oops'), null);
  const s = spec(hear);
  assert.deepEqual(hear.listRequest({ endpoint: s.endpoint, key: 'sk-test' }), { url: 'https://api.openai.com/v1/models', headers: { authorization: 'Bearer sk-test', 'OpenAI-Organization': 'org-1' } });
  assert.deepEqual(hear.readList({ data: [{ id: 'whisper-1' }, { id: 7 }, { id: 'gpt-transcribe' }] }), [{ providerId: 'whisper-1' }, { providerId: 'gpt-transcribe' }]);
});

test("a list of the endpoint's own (OpenRouter lists speech models by what they put out), with the names it gives", () => {
  assert.equal(hear.tunables.listPath, '/models');
  assert.equal(say.tunables.listPath, '/models');
  const s = spec(say);
  const endpoint = { ...s.endpoint, baseUrl: 'https://openrouter.ai/api/v1', headers: {}, tunables: { ...say.tunables, listPath: '/models?output_modalities=speech' } };
  assert.deepEqual(say.listRequest({ endpoint, key: 'sk-test' }), { url: 'https://openrouter.ai/api/v1/models?output_modalities=speech', headers: { authorization: 'Bearer sk-test' } });
  assert.deepEqual(say.readList({ data: [{ id: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0' }, { id: 'tts-1', name: '' }, { id: 'gpt-4o-mini-tts' }] }),
    [{ providerId: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0' }, { providerId: 'tts-1' }, { providerId: 'gpt-4o-mini-tts' }], "without supported_voices it is not OpenRouter's list: read as it is");
  // A voice left empty is not sent. Fish Audio's free voice then speaks in a speaker of its own choosing, a different one
  // each request (measured 2026-10-22), so its description names a voice.
  const fish = { ...s, model: { ...s.model, providerId: 'fish-audio/s2.1-pro-free:free', tunables: { voice: '' } }, tunables: { ...say.tunables, voice: '' } };
  assert.deepEqual(JSON.parse(say.speechRequest({ ...fish, text: 'Hi.' }).body), { model: 'fish-audio/s2.1-pro-free:free', input: 'Hi.', response_format: 'mp3' });
  // OpenRouter's error codes are numbers: its status decides the kind.
  assert.equal(say.classify(402, JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } })), null);
});

test("voice settings (phone1-voices): the model's voice and style go with every request; style is OpenAI's instructions, and a user's own older instructions tunable wins over a description's style", () => {
  const mini = (/** @type {any} */ t) => ({ ...spec(say), model: { id: 'm', name: 'Marin', providerId: 'gpt-4o-mini-tts', tunables: {}, extraBody: {} }, tunables: { ...say.tunables, ...t } });
  const body = (/** @type {any} */ s) => JSON.parse(say.speechRequest({ ...s, text: 'Hi.' }).body);
  assert.equal(say.tunables.style, '', 'a type default: no style');
  assert.deepEqual(body(mini({ voice: 'marin', style: 'Calm and warm.' })), { model: 'gpt-4o-mini-tts', input: 'Hi.', voice: 'marin', response_format: 'mp3', instructions: 'Calm and warm' });
  assert.equal(body(mini({ voice: 'marin', instructions: 'Old name.' })).instructions, 'Old name', 'a tunable saved before the Style field');
  // A description brings a style of its own (spec §9.2: an update never overrides what the user set): the user's older instructions are the user's, so they win.
  assert.equal(body(mini({ style: 'Description default.', instructions: 'Old name.' })).instructions, 'Old name');
  assert.equal(body(mini({ style: 'Description default.', instructions: '' })).instructions, 'Description default', 'emptied (the page does it when the style is typed in its field): the style');
  assert.equal('instructions' in body(mini({ style: '   ' })), false, 'a blank style is not sent: the request stays small and the same');
  assert.equal(body(mini({ style: ' Calm. ' })).instructions, 'Calm', 'trimmed, so the same words are the same bytes');
});

test("a style is plain words (phone1-voices): whitespace collapsed, no trailing punctuation, at most 200 characters, however it got there (a pasted JSON, a long paste)", () => {
  const sent = (/** @type {string} */ style) => JSON.parse(say.speechRequest({ ...spec(say), model: { id: 'm', name: 'Marin', providerId: 'gpt-4o-mini-tts', tunables: {}, extraBody: {} }, tunables: { ...say.tunables, style }, text: 'Hi.' }).body).instructions;
  assert.equal(sent('calm\nwarm\t  and   friendly \n'), 'calm warm and friendly');
  assert.equal(sent('Speak slowly: kindly, and low!!  '), 'Speak slowly: kindly, and low', "a colon inside is the user's own (instructions is a field of its own)");
  assert.equal(sent('Speak calmly. Then warmly.'), 'Speak calmly. Then warmly');
  assert.equal(sent('x'.repeat(1000)).length, 200);
  assert.equal(sent(`${'word '.repeat(60)}end.`).length <= 200, true);
  assert.equal(sent(' ,. '), undefined, 'only punctuation is no style');
});

test("a voice that can't take a style (styled: false: tts-1, Kokoro, Grok, Mistral) is not sent one; styled unknown (a server of the user's) is sent it", () => {
  const body = (/** @type {any} */ t) => JSON.parse(say.speechRequest({ ...spec(say), model: { id: 'm', name: 'Nova', providerId: 'tts-1', tunables: {}, extraBody: {} }, tunables: { ...say.tunables, voice: 'nova', ...t }, text: 'Hi.' }).body);
  assert.equal('instructions' in body({ style: 'Calm.', styled: false }), false);
  assert.equal(body({ style: 'Calm.' }).instructions, 'Calm');
  assert.equal(body({ style: 'Calm.', styled: true }).instructions, 'Calm');
  assert.equal('instructions' in body({ instructions: 'Old.', styled: false }), false, 'nor an older instructions');
  assert.equal(body({ style: 'Calm.', styled: false }).voice, 'nova', 'the voice always goes');
});

test("a model's extraBody still wins over voice and style (spec §9.2): a user can send what annai doesn't know, or send none with null", () => {
  const s = { ...spec(say), model: { id: 'm', name: 'x', providerId: 'fish-audio/s2.1-pro-free:free', tunables: {}, extraBody: { voice: 'other', instructions: null } }, tunables: { ...say.tunables, voice: 'abc', style: 'Calm.' } };
  assert.deepEqual(JSON.parse(say.speechRequest({ ...s, text: 'Hi.' }).body), { model: 'fish-audio/s2.1-pro-free:free', input: 'Hi.', voice: 'other', response_format: 'mp3' });
  const none = { ...s, model: { ...s.model, extraBody: { voice: null } } };
  assert.equal('voice' in JSON.parse(say.speechRequest({ ...none, text: 'Hi.' }).body), false, 'no voice at all: the provider picks');
});

test("OpenRouter's speech list (its entries carry supported_voices): each model's voices become its suggestions and its first voice, a vendor that ignores instructions is marked styled: false (OpenRouter's audio docs: only OpenAI gpt-4o-mini-tts, Gemini and Fish Audio take them); no other server's list is guessed at", () => {
  const got = say.readList({ data: [
    { id: 'fish-audio/s2.1-pro-free:free', name: 'Fish', supported_voices: null },
    { id: 'x-ai/grok-voice-tts-1.0', name: 'Grok', supported_voices: ['eve', 'ara'] },
    { id: 'google/gemini-3.8-flash-tts', name: 'Gemini', supported_voices: ['Zephyr', 'Kore', 'Sulafat'] },
    { id: 'mistralai/voxtral-mini-tts-2603', supported_voices: ['en_paul_sad', 'en_paul_neutral', 'gb_jane_neutral'] },
    { id: 'hexgrad/kokoro-82m', supported_voices: ['af_alloy', 'af_heart'] },
    { id: 'openai/gpt-4o-mini-tts-2025-12-15', name: 'OpenAI', supported_voices: ['alloy', 'marin'] },
    { id: 'junk/voices', supported_voices: ['ok', 7, '', 'fine'] },
  ] });
  const by = Object.fromEntries(got.map((/** @type {any} */ m) => [m.providerId, m]));
  assert.deepEqual(by['fish-audio/s2.1-pro-free:free'], { providerId: 'fish-audio/s2.1-pro-free:free', name: 'Fish' }, 'Fish Audio lists none: it takes the ability\'s voice and style (provider-openrouter\'s description)');
  assert.deepEqual(by['x-ai/grok-voice-tts-1.0'].tunables, { voice: 'eve', voices: ['eve', 'ara'], styled: false }, 'else the first');
  assert.deepEqual(by['google/gemini-3.8-flash-tts'].tunables, { voice: 'Sulafat', voices: ['Zephyr', 'Kore', 'Sulafat'] }, 'a calm, warm one when the list has one');
  assert.equal(by['mistralai/voxtral-mini-tts-2603'].tunables.voice, 'en_paul_neutral');
  assert.equal(by['hexgrad/kokoro-82m'].tunables.voice, 'af_heart');
  assert.equal(by['openai/gpt-4o-mini-tts-2025-12-15'].tunables.voice, 'marin');
  assert.equal(by['openai/gpt-4o-mini-tts-2025-12-15'].tunables.styled, undefined);
  assert.deepEqual(by['junk/voices'].tunables, { voice: 'ok', voices: ['ok', 'fine'], styled: false });
  // Any other server's list (OpenAI's, Speaches', Kokoro's: no supported_voices) is read as it is: a style is sent when the user typed one.
  assert.deepEqual(say.readList({ data: [{ id: 'tts-1' }, { id: 'vendor/model', name: 'V' }, { id: 'kokoro' }] }), [{ providerId: 'tts-1' }, { providerId: 'vendor/model', name: 'V' }, { providerId: 'kokoro' }]);
  assert.deepEqual(hear.readList({ data: [{ id: 'x/y', supported_voices: ['a'] }] }), [{ providerId: 'x/y' }], 'transcription lists have no voices');
});

test("a voice asked to go without its style (unstyled: the server refused instructions) is sent none; Fish Audio's style is billed with the text, and so is any other's", async () => {
  const fishModel = { id: 'm', name: 'Fish', providerId: 'fish-audio/s2.1-pro', prices: { perMillionChars: 15 }, tunables: { voice: 'abc', style: 'calm, warm and friendly' }, extraBody: {} };
  const s = spec(say);
  const endpoint = { ...s.endpoint, baseUrl: 'https://openrouter.ai/api/v1', headers: {} };
  /** @type {any[]} */
  const bodies = [];
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) => { bodies.push(JSON.parse(init.body)); return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }); };
  const text = 'x'.repeat(100);
  const styled = await speechCall({ type: say, endpoint, model: /** @type {any} */ (fishModel), key: null, text, fetch });
  const plain = await speechCall({ type: say, endpoint, model: /** @type {any} */ (fishModel), key: null, text, fetch, unstyled: true });
  assert.equal(bodies[0].instructions, 'calm, warm and friendly');
  assert.equal('instructions' in bodies[1], false);
  // OpenRouter puts the style in [brackets] before the text of a Fish Audio model, and bills what it added: the style and 3 characters.
  assert.equal(styled.cost, speechCost(fishModel.prices, { chars: 100 + 'calm, warm and friendly'.length + 3 }));
  assert.equal(plain.cost, speechCost(fishModel.prices, { chars: 100 }));
  const mini = { ...fishModel, providerId: 'gpt-4o-mini-tts' };
  assert.equal((await speechCall({ type: say, endpoint, model: /** @type {any} */ (mini), key: null, text, fetch })).cost, speechCost(fishModel.prices, { chars: 100 + 'calm, warm and friendly'.length }), "OpenAI's instructions are input too");
  const noStyle = { ...fishModel, tunables: { voice: 'abc' } };
  assert.equal((await speechCall({ type: say, endpoint, model: /** @type {any} */ (noStyle), key: null, text, fetch })).cost, speechCost(fishModel.prices, { chars: 100 }));
  const ignored = { ...fishModel, tunables: { ...fishModel.tunables, styled: false } };
  assert.equal((await speechCall({ type: say, endpoint, model: /** @type {any} */ (ignored), key: null, text, fetch })).cost, speechCost(fishModel.prices, { chars: 100 }), 'not sent, not billed');
});

test('replays the real OpenRouter calls to Fish Audio free (2026-10-22, test/fixtures/voices): the requests annai builds are the ones that were sent, and the clip reads as MP3', async () => {
  const fx = JSON.parse(await readFile(new URL('../fixtures/voices/openrouter-fish-free.json', import.meta.url), 'utf8'));
  const LAURA = 'e3cd384158934cc9a01029cd7d278634';
  const s = (/** @type {any} */ t) => ({ ...spec(say), endpoint: { ...spec(say).endpoint, baseUrl: 'https://openrouter.ai/api/v1', headers: {} }, model: { id: 'm', name: 'Fish', providerId: 'fish-audio/s2.1-pro-free:free', tunables: {}, extraBody: {} }, tunables: { ...say.tunables, ...t } });
  const built = (/** @type {any} */ t, /** @type {string} */ text) => JSON.parse(say.speechRequest({ ...s(t), text }).body);
  const { requests: r } = fx;
  assert.deepEqual(built({ voice: '' }, r.noVoice.input), r.noVoice, 'what the user had before: no voice, and Fish Audio chose one');
  assert.deepEqual(built({ voice: LAURA }, r.voice.input), r.voice);
  assert.deepEqual(built({ voice: LAURA, style: 'calm, warm and friendly' }, r.voiceAndStyle.input), r.voiceAndStyle);
  assert.deepEqual(built({ voice: LAURA, style: 'calm, warm and friendly' }, r.voiceAndStyleOtherText.input), r.voiceAndStyleOtherText);
  const clip = await say.readSpeech(new Response(Buffer.from(fx.response.clipBase64, 'base64'), { headers: { 'content-type': fx.response.contentType } }), s({}));
  assert.equal(clip.mediaType, 'audio/mpeg');
  assert.equal(clip.data.length, 1500);
});

const root = new URL('../../', import.meta.url);
test('choosing a speech endpoint type installs the official plugin, checked against the catalog (spec §5.3)', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  await ensureType(host, 'openai-speech', { fetch });
  assert.equal((await host.installed())['speech-openai']?.source, 'official');
  assert.deepEqual([...endpointTypes(registry).keys()].sort(), ['openai-speech', 'openai-transcription']);
});

test('a suggested speech model joins its list: transcription after "Send audio to the model", a voice ahead of the browser voice (spec §10.3); a provider added puts its own behind the free entries (decision 6)', async () => {
  assert.deepEqual(withSpeech(['send-audio', 'dictation'], ['m-1'], 'speech-in'), ['send-audio', 'm-1', 'dictation']);
  assert.deepEqual(withSpeech(['dictation'], ['m-1'], 'speech-in'), ['m-1', 'dictation']);
  assert.deepEqual(withSpeech(['m-0', 'browser-voice'], ['m-1', 'm-0'], 'speech-out'), ['m-0', 'm-1', 'browser-voice']);
  assert.deepEqual(withSpeech([], ['m-1'], 'speech-out'), ['m-1']);
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  await addProvider({ ws, store }, await official('provider-groq'));
  await addProvider({ ws, store }, await official('provider-openai'));
  const cfg = await readConfig(ws);
  const name = (/** @type {string} */ id) => (cfg.models[id] ? modelOf(cfg.models[id]).name : id);
  assert.deepEqual(cfg.roles['speech-in'].models.map(name), ['send-audio', 'dictation', 'Groq: Whisper large v3 turbo', 'OpenAI: GPT Transcribe']);
  assert.deepEqual(cfg.roles['speech-out'].models.map(name), ['browser-voice', 'OpenAI: GPT-4o mini TTS (Marin)']);
  assert.deepEqual(cfg.roles.main.models.map(name), ['GPT-6.1 Sol'], "Groq suggests nothing for chat roles; OpenAI has nothing free, so Main, which must not stay empty, gets its recommended model");
});

test('a speech model the user adds goes where a template would put it; a stand-in added back goes last', () => {
  assert.deepEqual(speechAdd(['send-audio', 'dictation'], 'm-1', 'speech-in'), ['send-audio', 'm-1', 'dictation']);
  assert.deepEqual(speechAdd(['browser-voice'], 'm-2', 'speech-out'), ['m-2', 'browser-voice']);
  assert.deepEqual(speechAdd(['send-audio', 'm-1'], 'dictation', 'speech-in'), ['send-audio', 'm-1', 'dictation']);
  assert.deepEqual(speechAdd(['m-2'], 'browser-voice', 'speech-out'), ['m-2', 'browser-voice']);
});
