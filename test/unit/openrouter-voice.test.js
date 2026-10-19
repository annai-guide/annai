import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createLlm } from '../../src/core/llm/service.js';
import { readConfig, modelOf, getKey, saveRoles, STAND_INS } from '../../src/core/llm/config.js';
import { speechBehind } from '../../src/core/llm/providers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { signInUrl, finishSignIn } from '../../src/ui/openrouter.js';

// Sign in with OpenRouter sets up one provider with one key for chat, transcription and voice; its speech
// models go behind the phone's own (the user, 2026-10-18: "Add, behind phone"). OpenRouter is stood in
// for: no request leaves this test. Its requests to the audio API are tested in official-providers.test.js.
const root = new URL('../../', import.meta.url);
const KEY = 'sk-or-v1-stand-in-key-0123456789abcdef';
const WAV = encodeWav(new Float32Array(1600), 16000);

/** OpenRouter's lists, by what the models put out, as its /models answers with output_modalities. */
const LISTS = /** @type {Record<string, any[]>} */ ({
  transcription: [{ id: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo', pricing: { prompt: '0.00000333', completion: '0' } }, { id: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' }],
  speech: [{ id: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0', supported_voices: ['eve', 'ara'] }],
  text: [{ id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)' }],
});

/** annai's own files, as its origin serves them, and a stand-in OpenRouter that notes what each request carried. */
function standIn() {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body: any }[]} */
  const seen = [];
  /** @param {any} url @param {any} [init] */
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.origin !== 'https://openrouter.ai') {
      try {
        return new Response(await readFile(new URL(`.${u.pathname}`, root)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    const headers = { ...(init.headers ?? {}) };
    seen.push({ url: String(url), method: init.method ?? 'GET', headers, body: init.body });
    if (headers.authorization !== `Bearer ${KEY}`) return Response.json({ error: { code: 401, message: 'No cookie auth credentials found' } }, { status: 401 });
    if (u.pathname === '/api/v1/audio/transcriptions') return Response.json({ text: ' Where should we stop for lunch? ', usage: { seconds: 2, cost: 0.0000067 } });
    if (u.pathname === '/api/v1/audio/speech') return new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
    if (u.pathname === '/api/v1/models') return Response.json({ data: LISTS[u.searchParams.get('output_modalities') ?? 'text'] ?? [] });
    return new Response('not found', { status: 404 });
  };
  return { fetch, seen };
}

/** A device with annai's service, its official plugins installed on demand from this repository. */
async function device() {
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
  const net = standIn();
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws, importModule }), fetch: net.fetch });
  /** @type {any[]} */
  const cards = [];
  /** @type {string[]} */
  const toasts = [];
  const ctx = { llm, ws, store, notices: { card: (/** @type {any} */ c) => cards.push(c), toast: (/** @type {string} */ t) => toasts.push(t) } };
  return { ...net, store, ws, llm, ctx, cards, toasts };
}

/** A Storage-like map. */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); } };
}

/** Signs in as OpenRouter's callback would finish it. @param {Awaited<ReturnType<typeof device>>} d */
async function signIn(d) {
  const storage = memoryStorage();
  const url = new URL(await signInUrl({ callback: 'https://annai.guide/', storage }));
  const exchange = async () => new Response(JSON.stringify({ key: KEY }));
  return finishSignIn(d.ctx, {
    location: /** @type {any} */ ({ search: `?code=abc&state=${url.searchParams.get('state')}`, pathname: '/' }),
    history: /** @type {any} */ ({ replaceState: () => {} }),
    fetch: exchange,
    storage,
  });
}

/** Every text annai keeps: files, log entries and stored content. @param {any} store */
const everything = (store) => store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
  const out = [];
  for (const s of await t.listScopes()) out.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
  for (const b of await t.listBlobs()) out.push(new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
  return out.join('\n');
});

/** The OpenRouter provider, and the models of one of its abilities by provider id. @param {import('../../src/core/llm/config.js').ModelConfig} cfg @param {string} ability */
function made(cfg, ability) {
  const p = Object.values(cfg.providers).find((x) => x.plugin === 'provider-openrouter');
  assert.ok(p, 'no OpenRouter provider');
  const models = Object.fromEntries(Object.values(cfg.models).filter((m) => m.provider === p.id && m.ability === ability).map((m) => [modelOf(m).providerId, m.id]));
  return { id: p.id, models };
}

test('Sign in with OpenRouter makes one provider, with chat, transcription and voice and one key, and says what it set up', async () => {
  const d = await device();
  assert.equal(await signIn(d), true);
  const cfg = await readConfig(d.ws);
  assert.deepEqual(Object.values(cfg.providers).map((p) => p.plugin), ['provider-openrouter']);
  const [p] = Object.values(cfg.providers);
  assert.deepEqual([...new Set(Object.values(cfg.models).map((m) => m.ability))].sort(), ['chat', 'transcription', 'voice']);
  assert.equal(await getKey(d.store, p.id), KEY);
  const ids = await d.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds());
  assert.deepEqual(ids, [`llm:${p.id}`], 'one key for the provider (spec §9.9)');
  assert.equal(d.cards.length, 1);
  const [card] = d.cards;
  assert.equal(card.title, 'Signed in with OpenRouter');
  assert.match(card.body, /free models/);
  assert.match(card.body, /transcription and voices, behind the phone's own dictation and the browser voice/);
  assert.match(card.body, /Its free voice comes first: each sentence it says uses one of the free requests a day the chat models use too/);
  assert.match(card.body, /The others cost a little/);
  assert.match(card.body, /move them up under Roles/);
  assert.equal(d.toasts.length, 0);
});

test("the role order after sign-in: the free path first, OpenRouter's speech models behind the stand-ins, nothing priced ahead of it", async () => {
  const d = await device();
  await signIn(d);
  const cfg = await readConfig(d.ws);
  const ears = made(cfg, 'transcription');
  const voice = made(cfg, 'voice');
  assert.deepEqual(cfg.roles['speech-in'].models, ['send-audio', 'dictation', ears.models['openai/whisper-large-v3-turbo']], '"Send audio to the model" keeps its place');
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice', voice.models['fish-audio/s2.1-pro-free:free'], voice.models['x-ai/grok-voice-tts-1.0']], 'the free voice before the one that costs money');
  /** @param {string} id */
  const free = (id) => Boolean(STAND_INS[id]) || Object.values(modelOf(cfg.models[id]).prices ?? { x: 1 }).every((v) => v === 0);
  for (const [role, r] of Object.entries(cfg.roles)) {
    const priced = r.models.findIndex((id) => !free(id));
    assert.ok(priced === -1 || r.models.slice(priced).every((id) => !free(id)), `${role}: something free comes after something priced (${r.models})`);
  }
  for (const role of ['main', 'utility', 'decide']) assert.ok(cfg.roles[role].models.every(free), `${role}: free models only`);
});

test("signing in keeps the user's own speech lists: the OpenRouter models join at the end, and a list the user emptied stays empty", async () => {
  assert.deepEqual(speechBehind(['dictation', 'send-audio'], ['m-1']), ['dictation', 'send-audio', 'm-1']);
  assert.deepEqual(speechBehind(['my-voice', 'browser-voice'], ['m-2', 'my-voice']), ['my-voice', 'browser-voice', 'm-2']);
  assert.deepEqual(speechBehind([], ['m-3']), [], 'no voice of its own ahead, so none that costs money either');
  const d = await device();
  await saveRoles(d.ws, { ...(await readConfig(d.ws)).roles, 'speech-in': { models: ['dictation', 'send-audio'], level: 'off' }, 'speech-out': { models: [], level: 'off' } });
  await signIn(d);
  const cfg = await readConfig(d.ws);
  const ears = made(cfg, 'transcription');
  assert.deepEqual(cfg.roles['speech-in'].models, ['dictation', 'send-audio', ears.models['openai/whisper-large-v3-turbo']]);
  assert.deepEqual(cfg.roles['speech-out'].models, []);
});

test('the key is in no file, log entry or trace: not after sign-in, nor after a transcription and a voice clip', async () => {
  const d = await device();
  await signIn(d);
  const cfg = await readConfig(d.ws);
  await d.llm.transcribe({ modelId: made(cfg, 'transcription').models['openai/whisper-large-v3-turbo'], audio: { data: WAV, mediaType: 'audio/wav', seconds: 0.1 } });
  await d.llm.synthesize({ modelId: made(cfg, 'voice').models['x-ai/grok-voice-tts-1.0'], text: 'Hello.' });
  const kept = await everything(d.store);
  assert.ok(kept.includes('net.request'), 'the speech requests are traced');
  assert.ok(!kept.includes(KEY));
  assert.ok(!JSON.stringify(d.cards).includes(KEY));
});
