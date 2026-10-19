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
import { addFromTemplate, speechBehind } from '../../src/core/llm/templates.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { signInUrl, finishSignIn, addOpenRouterVoice, voiceMissing, VOICE_TEMPLATES } from '../../src/ui/openrouter.js';

// Sign in with OpenRouter also sets up OpenRouter's transcription and a voice, behind the phone's own
// (the user, 2026-10-18: "Add, behind phone"). OpenRouter is stood in for: no request leaves this test.
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

/** The endpoint made from a template, and its models by provider id. @param {import('../../src/core/llm/config.js').ModelConfig} cfg @param {string} tplId */
function made(cfg, tplId) {
  const ep = Object.values(cfg.endpoints).find((e) => e.template?.id === tplId);
  assert.ok(ep, `no endpoint from ${tplId}`);
  const models = Object.fromEntries(Object.values(cfg.models).filter((m) => m.endpoint === ep.id).map((m) => [modelOf(m).providerId, m.id]));
  return { id: ep.id, models };
}

test("OpenRouter's transcription and voice templates: OpenAI-style requests to its audio API with annai's attribution, and model lists by what they put out", async () => {
  const d = await device();
  const catalog = await d.llm.templates();
  const chat = catalog.endpoints.find((t) => t.id === 'openrouter');
  for (const id of VOICE_TEMPLATES) {
    const tpl = catalog.endpoints.find((t) => t.id === id);
    assert.ok(tpl, `${id} is in the catalog`);
    assert.equal(tpl.baseUrl, chat?.baseUrl);
    assert.deepEqual(tpl.headers, chat?.headers, 'the same app attribution as the chat template');
    for (const m of tpl.models ?? []) {
      const price = tpl.type === 'openai-transcription' ? m.prices?.perMinute : m.prices?.perMillionChars;
      assert.ok(typeof price === 'number' && (m.providerId.endsWith(':free') ? price === 0 : price > 0), `${id}/${m.providerId}: a price annai can count`);
      if (tpl.type === 'openai-speech') assert.equal(typeof m.tunables?.voice, 'string', `${id}/${m.providerId}: a voice of its own, or the provider's default ("")`);
    }
    await d.llm.ensureType(tpl.type);
    await addFromTemplate(d.ctx, tpl, { key: KEY, roles: null });
  }
  const cfg = await readConfig(d.ws);
  const ears = made(cfg, 'openrouter-transcription');
  const voice = made(cfg, 'openrouter-speech');

  const heard = await d.llm.transcribe({ modelId: ears.models['openai/whisper-large-v3-turbo'], audio: { data: WAV, mediaType: 'audio/wav', seconds: 0.1 } });
  assert.equal(/** @type {any} */ (heard).text, 'Where should we stop for lunch?');
  const [asked] = d.seen;
  assert.equal(asked.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
  assert.equal(asked.method, 'POST');
  assert.equal(asked.headers['HTTP-Referer'], 'https://annai.guide');
  assert.equal(asked.headers['X-Title'], 'annai');
  assert.ok(asked.body instanceof FormData, 'multipart, as OpenAI takes it');
  assert.equal(asked.body.get('model'), 'openai/whisper-large-v3-turbo');
  assert.equal(asked.body.get('response_format'), 'json', 'OpenRouter refuses text, srt and vtt');
  assert.equal(/** @type {File} */ (asked.body.get('file')).type, 'audio/wav');

  const said = await d.llm.synthesize({ modelId: voice.models['x-ai/grok-voice-tts-1.0'], text: 'Bixby Bridge is two miles ahead.' });
  assert.equal(/** @type {any} */ (said).clip.mediaType, 'audio/mpeg');
  const spoke = d.seen[1];
  assert.equal(spoke.url, 'https://openrouter.ai/api/v1/audio/speech');
  assert.equal(spoke.headers['X-Title'], 'annai');
  assert.deepEqual(JSON.parse(spoke.body), { model: 'x-ai/grok-voice-tts-1.0', input: 'Bixby Bridge is two miles ahead.', voice: 'ara', response_format: 'mp3' });
  // OpenRouter's free voice (the user, 2026-10-18): Fish Audio publishes no voice names, so annai asks for its default voice by sending none.
  await d.llm.synthesize({ modelId: voice.models['fish-audio/s2.1-pro-free:free'], text: 'Hello.' });
  assert.deepEqual(JSON.parse(d.seen[2].body), { model: 'fish-audio/s2.1-pro-free:free', input: 'Hello.', response_format: 'mp3' });
  d.seen.splice(2, 1);

  // OpenRouter's plain /models leaves speech models out; its lists by output_modalities have them, with their names.
  assert.deepEqual(await d.llm.listModels(ears.id), [{ providerId: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo' }, { providerId: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' }]);
  assert.equal(d.seen[2].url, 'https://openrouter.ai/api/v1/models?output_modalities=transcription');
  assert.deepEqual((await d.llm.listModels(voice.id)).map((m) => m.providerId), ['x-ai/grok-voice-tts-1.0']);
  assert.equal(d.seen[3].url, 'https://openrouter.ai/api/v1/models?output_modalities=speech');
});

test('Sign in with OpenRouter adds chat, transcription and a voice with one key, each endpoint keeping its own copy, and says what it set up', async () => {
  const d = await device();
  assert.equal(await signIn(d), true);
  const cfg = await readConfig(d.ws);
  assert.deepEqual(Object.values(cfg.endpoints).map((e) => e.template?.id).sort(), ['openrouter', 'openrouter-speech', 'openrouter-transcription']);
  for (const e of Object.values(cfg.endpoints)) assert.equal(await getKey(d.store, e.id), KEY, `${e.template?.id} has the key in its own secret`);
  const ids = await d.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds());
  assert.deepEqual(ids, Object.keys(cfg.endpoints).map((id) => `llm:${id}`).sort(), 'one secret per endpoint (one key per endpoint)');
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
  const ears = made(cfg, 'openrouter-transcription');
  const voice = made(cfg, 'openrouter-speech');
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
  const ears = made(cfg, 'openrouter-transcription');
  assert.deepEqual(cfg.roles['speech-in'].models, ['dictation', 'send-audio', ears.models['openai/whisper-large-v3-turbo']]);
  assert.deepEqual(cfg.roles['speech-out'].models, []);
});

test('signed in before: the voice is added later with the OpenRouter endpoint\'s key, once, and only when asked', async () => {
  const d = await device();
  const catalog = await d.llm.templates();
  const chat = /** @type {any} */ (catalog.endpoints.find((t) => t.id === 'openrouter'));
  await d.llm.ensureType(chat.type);
  const or = await addFromTemplate(d.ctx, chat, { key: KEY, roles: 'free' });
  let cfg = await readConfig(d.ws);
  assert.equal(Object.keys(cfg.endpoints).length, 1, 'nothing is added by itself');
  assert.deepEqual(await addOpenRouterVoice(d.ctx, /** @type {string} */ (await d.llm.keyFor(or))), ['openrouter-transcription', 'openrouter-speech']);
  cfg = await readConfig(d.ws);
  const ears = made(cfg, 'openrouter-transcription');
  const voice = made(cfg, 'openrouter-speech');
  assert.equal(await getKey(d.store, ears.id), KEY);
  assert.equal(await getKey(d.store, voice.id), KEY);
  assert.deepEqual(cfg.roles['speech-in'].models, ['send-audio', 'dictation', ears.models['openai/whisper-large-v3-turbo']]);
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice', voice.models['fish-audio/s2.1-pro-free:free'], voice.models['x-ai/grok-voice-tts-1.0']]);
  assert.deepEqual(await addOpenRouterVoice(d.ctx, KEY), [], 'asked again: nothing twice');
  assert.equal(Object.keys((await readConfig(d.ws)).endpoints).length, 3);
  await assert.rejects(addOpenRouterVoice(d.ctx, ''), /key/);
});

test('the key is in no file, log entry or trace: not after sign-in, nor after a transcription and a voice clip', async () => {
  const d = await device();
  await signIn(d);
  const cfg = await readConfig(d.ws);
  await d.llm.transcribe({ modelId: made(cfg, 'openrouter-transcription').models['openai/whisper-large-v3-turbo'], audio: { data: WAV, mediaType: 'audio/wav', seconds: 0.1 } });
  await d.llm.synthesize({ modelId: made(cfg, 'openrouter-speech').models['x-ai/grok-voice-tts-1.0'], text: 'Hello.' });
  const kept = await everything(d.store);
  assert.ok(kept.includes('net.request'), 'the speech requests are traced');
  assert.ok(!kept.includes(KEY));
  assert.ok(!JSON.stringify(d.cards).includes(KEY));
});

/** The workspace, failing to save an endpoint made from one template (a full disk, say). @param {any} ws @param {string[]} tplIds */
const failingFor = (ws, tplIds) => new Proxy(ws, {
  get: (t, k) => (k === 'writeMany'
    ? (/** @type {any} */ scope, /** @type {any[]} */ entries, /** @type {any} */ o) => (entries.some((e) => tplIds.includes(e.content?.template?.id)) ? Promise.reject(new Error('The disk is full.')) : t.writeMany(scope, entries, o))
    : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
});

test("a sign-in whose voice can't be added still signs in, says so, and the OpenRouter endpoint's page offers what is missing (fix pass)", async () => {
  // All of it fails: chat only, and both are offered.
  const d = await device();
  d.ctx.ws = failingFor(d.ws, ['openrouter-transcription', 'openrouter-speech']);
  assert.equal(await signIn(d), true);
  let cfg = await readConfig(d.ws);
  assert.deepEqual(Object.values(cfg.endpoints).map((e) => e.template?.id), ['openrouter']);
  assert.equal(d.cards[0].title, 'Signed in with OpenRouter');
  assert.match(d.cards[0].body, /couldn't add all of OpenRouter's voice just now: the OpenRouter endpoint's page can add the rest/);
  const catalog = await d.llm.templates();
  assert.deepEqual(voiceMissing(cfg, catalog), ['openrouter-transcription', 'openrouter-speech']);
  // Half of it fails: the transcription is there, the voice is offered.
  const h = await device();
  h.ctx.ws = failingFor(h.ws, ['openrouter-speech']);
  await signIn(h);
  cfg = await readConfig(h.ws);
  assert.deepEqual(Object.values(cfg.endpoints).map((e) => e.template?.id).sort(), ['openrouter', 'openrouter-transcription']);
  assert.match(h.cards[0].body, /couldn't add all of OpenRouter's voice/);
  assert.deepEqual(voiceMissing(cfg, catalog), ['openrouter-speech']);
  h.ctx.ws = h.ws;
  assert.deepEqual(await addOpenRouterVoice(h.ctx, KEY), ['openrouter-speech'], 'the page adds the rest');
});
