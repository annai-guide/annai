import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkProviderDesc } from '../../src/core/llm/provider-desc.js';
import { catalogFacts } from '../../src/core/catalog-facts.js';
import { satisfies } from '../../src/core/requires.js';
import { readConfig, modelOf } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { hostKit } from './package-kit.js';
import { officialManifests, official } from './provider-kit.js';

const root = new URL('../../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8')).plugins;
/** @param {string} id */
const entry = (id) => catalog.find((/** @type {any} */ p) => p.id === id);
/** Whether a type comes from one of these requirements, in range of the catalog. @param {string} type @param {any[]} requires */
const providedBy = (type, requires = []) => requires.some((r) => entry(r.id)?.provides?.['endpoint-type']?.includes(type) && satisfies(entry(r.id).version, r.version));

/** The official providers with code. */
const CODE = ['provider-openrouter', 'provider-llamacpp', 'provider-ollama', 'provider-lmstudio'];

test('every official provider is valid, its id is provider-*, and its requires cover the abilities that start on, in range of the catalog', async () => {
  const providers = (await officialManifests()).filter((m) => m.provider);
  assert.equal(providers.length, 15);
  for (const m of providers) {
    assert.match(m.id, /^provider-[a-z0-9-]+$/);
    assert.deepEqual(checkProviderDesc(m.provider), [], m.id);
    // Data only, but for those with quirks no data can carry (milestone 4): OpenRouter's sign-in, and the context a server serves (decision 22).
    assert.equal(m.entry, CODE.includes(m.id) ? 'index.js' : undefined, `${m.id}: ${CODE.includes(m.id) ? 'has code' : 'data only'}`);
    for (const [id, a] of Object.entries(m.provider.abilities)) {
      if (/** @type {any} */ (a).on !== false) assert.ok(providedBy(/** @type {any} */ (a).type, m.requires), `${m.id}/${id}: ${/** @type {any} */ (a).type}`);
      else assert.ok(catalog.some((/** @type {any} */ p) => p.provides?.['endpoint-type']?.includes(/** @type {any} */ (a).type)), `${m.id}/${id}: a type annai has`);
    }
  }
});

/** Where each of the 22 templates went (plan, "Where each of today's templates goes"): plugin, ability, protocol, its models. */
const WENT = {
  openrouter: ['provider-openrouter', 'chat', 'chat-completions', ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-opus-5.5', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free']],
  anthropic: ['provider-anthropic', 'chat', 'anthropic-messages', ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']],
  'openai-responses': ['provider-openai', 'chat', 'openai-responses', ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']],
  openai: ['provider-openai', 'chat-completions', 'chat-completions', []],
  gemini: ['provider-gemini', 'chat', 'chat-completions', []],
  groq: ['provider-groq', 'chat', 'chat-completions', []],
  deepseek: ['provider-deepseek', 'chat', 'chat-completions', []],
  mistral: ['provider-mistral', 'chat', 'chat-completions', []],
  local: ['provider-another-address', 'chat-completions', 'chat-completions', []],
  'custom-chat-completions': ['provider-another-address', 'chat-completions', 'chat-completions', []],
  'custom-anthropic': ['provider-another-address', 'messages', 'anthropic-messages', []],
  'custom-openai-responses': ['provider-another-address', 'responses', 'openai-responses', []],
  'openrouter-transcription': ['provider-openrouter', 'transcription', 'openai-transcription', ['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3', 'x-ai/grok-stt-1.0', 'mistralai/voxtral-mini-transcribe']],
  'openrouter-speech': ['provider-openrouter', 'voice', 'openai-speech', ['fish-audio/s2.1-pro-free:free', 'x-ai/grok-voice-tts-1.0', 'mistralai/voxtral-mini-tts-2603', 'hexgrad/kokoro-82m']],
  'openai-transcription': ['provider-openai', 'transcription', 'openai-transcription', ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']],
  'groq-transcription': ['provider-groq', 'transcription', 'openai-transcription', ['whisper-large-v3-turbo', 'whisper-large-v3']],
  'openai-speech': ['provider-openai', 'voice', 'openai-speech', ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']],
  'local-transcription': ['provider-local-speech', 'transcription', 'openai-transcription', []],
  'local-speech': ['provider-local-speech', 'voice', 'openai-speech', []],
  'custom-transcription': ['provider-another-address', 'transcription', 'openai-transcription', []],
  'custom-speech': ['provider-another-address', 'voice', 'openai-speech', []],
  scripted: ['provider-scripted', 'chat', 'scripted', ['scripted']],
};

test("today's 22 templates are all somewhere: models, prices, notes and roles kept (OpenRouter's three in one provider)", async () => {
  assert.equal(Object.keys(WENT).length, 22);
  for (const [tpl, went] of Object.entries(WENT)) {
    const [plugin, ability, type, models] = /** @type {[string, string, string, string[]]} */ (went);
    const a = (await official(plugin)).provider.abilities[ability];
    assert.ok(a, `${tpl} → ${plugin}/${ability}`);
    assert.equal(a.type, type, tpl);
    assert.deepEqual((a.models ?? []).map((m) => m.providerId), models, tpl);
    for (const m of a.models ?? []) assert.ok(m.prices && Object.values(m.prices).some((v) => typeof v === 'number'), `${tpl}/${m.providerId}: prices`);
  }
  const or = await official('provider-openrouter');
  const p = (/** @type {string} */ ab, /** @type {string} */ id) => or.provider.abilities[ab].models?.find((m) => m.providerId === id)?.prices;
  assert.deepEqual(p('chat', 'anthropic/claude-sonnet-5.5'), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 });
  assert.deepEqual(p('transcription', 'openai/whisper-large-v3-turbo'), { perMinute: 0.0002 });
  assert.deepEqual(p('voice', 'fish-audio/s2.1-pro-free:free'), { perMillionChars: 0 });
  assert.deepEqual((await official('provider-groq')).provider.abilities.transcription.models?.[0].prices, { perMinute: 0.000667, minSeconds: 10 });
  // The notes, merged where three templates became one.
  assert.match(or.provider.note ?? '', /Free models allow 50 requests a day/);
  assert.match(or.provider.abilities.voice.note ?? '', /put one in the model's Voice/);
  assert.match((await official('provider-openai')).provider.abilities.chat.note ?? '', /call tools only through Responses/);
  assert.match((await official('provider-gemini')).provider.note ?? '', /OpenAI-compatible endpoint/);
  assert.match((await official('provider-local-speech')).provider.note ?? '', /needs an HTTPS address/);
  assert.match((await official('provider-another-address')).provider.abilities.responses.note ?? '', /"phase": false/);
  // The roles each suggested, OpenRouter's speech in its recommended set.
  assert.deepEqual(or.provider.roles, {
    free: { main: ['google/gemma-4-31b-it:free'], utility: ['google/gemma-4-26b-a4b-it:free'], decide: ['google/gemma-4-26b-a4b-it:free'] },
    recommended: { main: ['anthropic/claude-sonnet-5.5'], utility: ['anthropic/claude-haiku-5.5'], decide: ['anthropic/claude-haiku-5.5'], 'speech-in': ['openai/whisper-large-v3-turbo'], 'speech-out': ['fish-audio/s2.1-pro-free:free', 'x-ai/grok-voice-tts-1.0'] },
  });
  assert.deepEqual((await official('provider-openai')).provider.roles?.recommended, { main: ['gpt-6.1-sol'], utility: ['gpt-6-luna'], decide: ['gpt-6-luna'], 'speech-in': ['gpt-transcribe'], 'speech-out': ['gpt-4o-mini-tts'] });
});

test('Anthropic, OpenRouter and OpenAI chat models list their web tools; Responses models carry their reasoning maps (spec §9.3, §9.5)', async () => {
  for (const id of ['provider-anthropic', 'provider-openrouter', 'provider-openai']) {
    for (const m of (await official(id)).provider.abilities.chat.models ?? []) assert.ok(m.providerTools?.some((t) => t.kind === 'search'), `${id} ${m.providerId}`);
  }
  const openai = (await official('provider-openai')).provider.abilities.chat;
  const byId = Object.fromEntries((openai.models ?? []).map((m) => [m.providerId, m]));
  // The efforts OpenAI documents for each: Astra and Sol have no "none", so they have no "off".
  const efforts = (/** @type {any} */ m) => Object.fromEntries(Object.entries(m.reasoning).map(([level, patch]) => [level, /** @type {any} */ (patch).reasoning.effort]));
  assert.deepEqual(efforts(byId['gpt-6-astra']), { low: 'low', medium: 'medium', high: 'high', max: 'max' });
  assert.deepEqual(efforts(byId['gpt-6.1-sol']), { low: 'low', medium: 'medium', high: 'high', max: 'max' });
  assert.deepEqual(efforts(byId['gpt-6-luna']), { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'max' });
  for (const m of openai.models ?? []) {
    const prices = /** @type {any} */ (m.prices);
    assert.deepEqual(Object.keys(prices).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'tiers'], m.providerId);
    assert.equal(prices.tiers[0].above, 272000, 'prompts over 272K cost more');
    assert.equal(m.contextWindow, 922000, 'the most input the 1,050,000-token window takes');
    assert.deepEqual(m.images, { formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxEdge: 5000, maxBytes: 20000000, maxCount: 1500 });
  }
  const cc = (await official('provider-openai')).provider.abilities['chat-completions'];
  assert.deepEqual([cc.on, cc.tunables], [false, { maxTokensField: 'max_completion_tokens', systemRole: 'developer' }]);
  assert.match(cc.note ?? '', /Prefer Chat \(Responses\)/);
});

test("OpenRouter's and Anthropic's chat abilities offer web search to every model added from their lists (modelDefaults, §9.2)", async () => {
  assert.deepEqual((await official('provider-openrouter')).provider.abilities.chat.modelDefaults?.providerTools?.map((t) => t.id), ['openrouter-web-search']);
  const claude = (await official('provider-anthropic')).provider.abilities.chat.modelDefaults;
  assert.deepEqual([claude?.cacheTtls, claude?.providerTools?.map((t) => t.id)], [['5m', '1h'], ['anthropic-web-search']]);
  assert.deepEqual((await official('provider-another-address')).provider.abilities.messages.modelDefaults, { cacheTtls: ['5m', '1h'] });
});

/** OpenRouter's lists by what the models put out, as its /models answers with output_modalities. */
const LISTS = /** @type {Record<string, any[]>} */ ({
  transcription: [{ id: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo', pricing: { prompt: '0.00000333', completion: '0' } }, { id: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' }],
  speech: [{ id: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0', supported_voices: ['eve', 'ara'] }],
  text: [{ id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)' }],
});
const KEY = 'sk-or-v1-stand-in-key-0123456789abcdef';

test("OpenRouter's speech abilities: OpenAI-style requests to its audio API with annai's attribution and the one key, and model lists by what they put out (listPath)", async () => {
  const k = await hostKit();
  /** @type {{ url: string, method: string, headers: Record<string, string>, body: any }[]} */
  const seen = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
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
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider('provider-openrouter', { key: KEY, roles: 'free' });
  assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['chat-completions', 'provider-openrouter', 'speech-openai']);
  const cfg = await readConfig(k.ws);
  assert.deepEqual(Object.keys(cfg.providers), [id], 'one provider');
  assert.deepEqual(await k.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [`llm:${id}`], 'one key');
  const by = (/** @type {string} */ pid) => /** @type {string} */ (Object.values(cfg.models).find((m) => modelOf(m).providerId === pid)?.id);
  const heard = await llm.transcribe({ modelId: by('openai/whisper-large-v3-turbo'), audio: { data: encodeWav(new Float32Array(1600), 16000), mediaType: 'audio/wav', seconds: 0.1 } });
  assert.equal(/** @type {any} */ (heard).text, 'Where should we stop for lunch?');
  const [asked] = seen;
  assert.equal(asked.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
  assert.equal(asked.headers['HTTP-Referer'], 'https://annai.guide');
  assert.equal(asked.headers['X-Title'], 'annai');
  assert.equal(asked.body.get('model'), 'openai/whisper-large-v3-turbo');
  assert.equal(asked.body.get('response_format'), 'json', 'OpenRouter refuses text, srt and vtt');
  await llm.synthesize({ modelId: by('x-ai/grok-voice-tts-1.0'), text: 'Bixby Bridge is two miles ahead.' });
  assert.equal(seen[1].url, 'https://openrouter.ai/api/v1/audio/speech');
  assert.equal(seen[1].headers['X-Title'], 'annai');
  assert.deepEqual(JSON.parse(seen[1].body), { model: 'x-ai/grok-voice-tts-1.0', input: 'Bixby Bridge is two miles ahead.', voice: 'ara', response_format: 'mp3' });
  // Its free voice is asked for its default voice by sending none (the user, 2026-10-18).
  await llm.synthesize({ modelId: by('fish-audio/s2.1-pro-free:free'), text: 'Hello.' });
  assert.deepEqual(JSON.parse(seen[2].body), { model: 'fish-audio/s2.1-pro-free:free', input: 'Hello.', response_format: 'mp3' });
  // Plain /models leaves speech models out; its lists by output_modalities have them, with their names.
  assert.deepEqual(await llm.listModels(id, 'transcription'), [{ providerId: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo' }, { providerId: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' }]);
  assert.equal(seen[3].url, 'https://openrouter.ai/api/v1/models?output_modalities=transcription');
  assert.deepEqual((await llm.listModels(id, 'voice')).map((m) => m.providerId), ['x-ai/grok-voice-tts-1.0']);
  assert.equal(seen[4].url, 'https://openrouter.ai/api/v1/models?output_modalities=speech');
  // A model added from the chat list gets OpenRouter web search (decision 26).
  const { addListedModel } = await import('../../src/core/llm/providers.js');
  const listed = await addListedModel(k, id, 'chat', { providerId: 'some/new-model' });
  assert.deepEqual(modelOf((await readConfig(k.ws)).models[listed]).providerTools.map((t) => t.id), ['openrouter-web-search']);
});

test('catalogFacts: abilities in order, free from zero prices, local, code, the category derived when it is absent', async () => {
  const facts = (/** @type {any} */ m) => catalogFacts({ id: 'x', name: 'X', version: '1.0.0', api: 1, ...m }, { size: 1234 });
  const router = catalogFacts(await (async () => JSON.parse(await readFile(new URL('plugins-official/provider-openrouter/annai-plugin.json', root), 'utf8')))(), { size: 9 });
  assert.deepEqual([router.abilities, router.free, router.local, router.code, router.category, router.size], [['chat', 'transcription', 'voice'], true, false, true, 'providers', 9]);
  assert.deepEqual(router.requires.map((r) => r.id), ['chat-completions', 'speech-openai']);
  assert.equal(facts({ provider: { abilities: { a: { kind: 'transcription' }, b: { kind: 'voice' } } } }).category, 'speech');
  assert.equal(facts({ provider: { local: true, abilities: { a: { kind: 'chat', models: [{ providerId: 'p', prices: { input: 1, output: 0 } }] } } } }).free, false);
  assert.equal(facts({ provider: { local: true, abilities: {} } }).local, true);
  assert.equal(facts({ entry: 'index.js', provides: { 'storage-type': ['s3'] } }).category, 'backup');
  assert.equal(facts({ entry: 'index.js', provides: { 'endpoint-type': ['x'] } }).category, 'developer');
  assert.equal(facts({ skills: ['s'] }).category, 'skills');
  assert.equal(facts({ entry: 'index.js' }).category, 'tools');
  assert.equal(facts({ entry: 'index.js', category: 'developer' }).category, 'developer');
  assert.deepEqual([facts({ entry: 'index.js' }).code, facts({ keywords: ['LM Studio'] }).keywords], [true, ['LM Studio']]);
  // The catalog carries them, and the kinds the plan gives: protocols, the scripted model and Remote trace under Developer.
  for (const id of ['chat-completions', 'scripted-model', 'remote-trace', 'provider-scripted']) assert.equal(entry(id).category, 'developer', id);
  for (const id of ['storage-s3', 'storage-github']) assert.equal(entry(id).category, 'backup', id);
  assert.equal(entry('provider-local-speech').category, 'speech');
  assert.deepEqual(entry('provider-local-speech').keywords, ['Speaches', 'whisper.cpp', 'Kokoro']);
  assert.ok(catalog.every((/** @type {any} */ p) => p.size > 0));
  // The one-tap start's provider (spec §9.8), marked in annai's own catalog only.
  assert.deepEqual(catalog.filter((/** @type {any} */ p) => p.featured).map((/** @type {any} */ p) => [p.id, p.featured]), [['provider-openrouter', 'Sign in with OpenRouter is the quickest way, and it starts you on free models.']]);
});
