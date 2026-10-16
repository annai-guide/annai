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
import { addFromTemplate, withSpeech } from '../../src/core/llm/templates.js';
import { readConfig, modelOf } from '../../src/core/llm/config.js';

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
  assert.deepEqual(JSON.parse(r.body), { model: 'gpt-4o-mini-tts', input: 'Bixby Bridge is two miles ahead.', voice: 'marin', response_format: 'mp3', instructions: 'Warm and calm.', speed: 1.1 });
  const clip = await say.readSpeech(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }), s);
  assert.deepEqual([...clip.data], [1, 2]);
  assert.equal(clip.mediaType, 'audio/mpeg');
  const wav = await say.readSpeech(new Response(new Uint8Array([3]), { headers: { 'content-type': 'application/octet-stream' } }), { ...s, tunables: { ...s.tunables, format: 'wav' } });
  assert.equal(wav.mediaType, 'audio/wav');
  await assert.rejects(say.readSpeech(new Response(new Uint8Array([])), s), (e) => e instanceof ProviderError && e.kind === 'server');
});

test('errors by their codes; model lists from /models', () => {
  assert.equal(hear.classify(401, JSON.stringify({ error: { code: 'invalid_api_key' } })), 'auth');
  assert.equal(say.classify(429, JSON.stringify({ error: { code: 'insufficient_quota' } })), 'credit');
  assert.equal(say.classify(500, 'oops'), null);
  const s = spec(hear);
  assert.deepEqual(hear.listRequest({ endpoint: s.endpoint, key: 'sk-test' }), { url: 'https://api.openai.com/v1/models', headers: { authorization: 'Bearer sk-test', 'OpenAI-Organization': 'org-1' } });
  assert.deepEqual(hear.readList({ data: [{ id: 'whisper-1' }, { id: 7 }, { id: 'gpt-transcribe' }] }), [{ providerId: 'whisper-1' }, { providerId: 'gpt-transcribe' }]);
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

test('a template speech model joins its list: transcription after "Send audio to the model", a voice ahead of the browser voice (spec §10.3)', async () => {
  assert.deepEqual(withSpeech(['send-audio', 'dictation'], ['m-1'], 'speech-in'), ['send-audio', 'm-1', 'dictation']);
  assert.deepEqual(withSpeech(['dictation'], ['m-1'], 'speech-in'), ['m-1', 'dictation']);
  assert.deepEqual(withSpeech(['m-0', 'browser-voice'], ['m-1', 'm-0'], 'speech-out'), ['m-0', 'm-1', 'browser-voice']);
  assert.deepEqual(withSpeech([], ['m-1'], 'speech-out'), ['m-1']);
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const catalog = JSON.parse(await readFile(new URL('catalog/templates.json', root), 'utf8'));
  const tpl = (/** @type {string} */ id) => catalog.endpoints.find((/** @type {any} */ t) => t.id === id);
  await addFromTemplate({ ws, store }, tpl('groq-transcription'));
  await addFromTemplate({ ws, store }, tpl('openai-speech'));
  const cfg = await readConfig(ws);
  const name = (/** @type {string} */ id) => (cfg.models[id] ? modelOf(cfg.models[id]).name : id);
  assert.deepEqual(cfg.roles['speech-in'].models.map(name), ['send-audio', 'Groq: Whisper large v3 turbo', 'dictation']);
  assert.deepEqual(cfg.roles['speech-out'].models.map(name), ['OpenAI: GPT-4o mini TTS (Marin)', 'browser-voice']);
  assert.deepEqual(cfg.roles.main.models, [], 'a speech template suggests nothing for chat roles');
});
