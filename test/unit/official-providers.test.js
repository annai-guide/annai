import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkProviderDesc } from '../../src/core/llm/provider-desc.js';
import { catalogFacts } from '../../src/core/catalog-facts.js';
import { satisfies } from '../../src/core/requires.js';
import { readConfig, modelOf, providerOf, saveRoles } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { hostKit } from './package-kit.js';
import { officialManifests, official } from './provider-kit.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

const root = new URL('../../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8')).plugins;
/** @param {string} id */
const entry = (id) => catalog.find((/** @type {any} */ p) => p.id === id);
/** Whether a type comes from one of these requirements, in range of the catalog. @param {string} type @param {any[]} requires */
const providedBy = (type, requires = []) => requires.some((r) => entry(r.id)?.provides?.['endpoint-type']?.includes(type) && satisfies(entry(r.id).version, r.version));

/** The official providers with code. */
const CODE = ['provider-openrouter', 'provider-llamacpp', 'provider-ollama', 'provider-lmstudio', 'provider-another-address'];

test('every official provider is valid, its id is provider-*, and its requires cover the abilities that start on, in range of the catalog', async () => {
  const providers = (await officialManifests()).filter((m) => m.provider);
  assert.equal(providers.length, 15);
  for (const m of providers) {
    assert.match(m.id, /^provider-[a-z0-9-]+$/);
    assert.deepEqual(checkProviderDesc(m.provider), [], m.id);
    // Data only, but for those with quirks no data can carry: OpenRouter's sign-in and the context a server serves (milestone 4, decision 22), and Custom provider's look at what an address offers (milestone 5).
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
  gemini: ['provider-gemini', 'chat', 'gemini', ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']],
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
  assert.match(or.provider.abilities.voice.note ?? '', /suggested in the model's Voice/);
  assert.match((await official('provider-openai')).provider.abilities.chat.note ?? '', /call tools only through Responses/);
  assert.match((await official('provider-gemini')).provider.note ?? '', /Gemini's own API/);
  assert.equal((await official('provider-local-speech')).provider.local, true, 'its page shows the shared note for local servers');
  assert.match((await official('provider-another-address')).provider.abilities.responses.note ?? '', /"phase": false/);
  // The roles each suggested, OpenRouter's speech in its recommended set.
  assert.deepEqual(or.provider.roles, {
    free: { main: ['google/gemma-4-31b-it:free'], utility: ['google/gemma-4-26b-a4b-it:free'], decide: ['google/gemma-4-26b-a4b-it:free'] },
    recommended: { main: ['anthropic/claude-sonnet-5.5'], utility: ['anthropic/claude-haiku-5.5'], decide: ['anthropic/claude-haiku-5.5'], 'speech-in': ['openai/whisper-large-v3-turbo'], 'speech-out': ['fish-audio/s2.1-pro-free:free', 'x-ai/grok-voice-tts-1.0'] },
  });
  assert.deepEqual((await official('provider-openai')).provider.roles?.recommended, { main: ['gpt-6.1-sol'], utility: ['gpt-6-luna'], decide: ['gpt-6-luna'], 'speech-in': ['gpt-transcribe'], 'speech-out': ['gpt-4o-mini-tts'] });
});

test("every official voice model has one fixed voice, never the provider's pick, its own or its ability's or its type's; a model that takes a style has one, a model that doesn't says so (phone1-voices)", async () => {
  // The user chose it from the samples, 2026-10-23: Fish's 'Women KatKat' (14) and Gemini's Sulafat (9), with this style note.
  const KATKAT = 'bddf65d5a84c4a9aa36b7136bdac57a9';
  const STYLE = 'young, cheerful and lively, yet calm and gentle';
  /** @param {string} id */
  const voiceAbility = async (id) => /** @type {any} */ ((await official(id)).provider.abilities.voice);
  /** What a model is sent: its own tunables over its ability's, over its type's. @param {any} ability @param {Record<string, any>} type */
  const effective = (ability, type) => Object.fromEntries((ability.models ?? []).map((/** @type {any} */ m) => [m.providerId, { ...type, ...ability.tunables, ...m.tunables }]));
  const or = effective(await voiceAbility('provider-openrouter'), { voice: 'marin' });
  const oai = effective(await voiceAbility('provider-openai'), { voice: 'marin' });
  const gem = effective(await voiceAbility('provider-gemini'), { voice: 'Sulafat' });
  const openrouter = await voiceAbility('provider-openrouter');
  // Fish Audio picks another speaker for each request when sent none: the ability gives every model of its family Women KatKat, and a model added by id too.
  assert.deepEqual([openrouter.tunables.voice, openrouter.tunables.style], [KATKAT, STYLE]);
  assert.equal(openrouter.models.find((/** @type {any} */ m) => m.providerId === 'fish-audio/s2.1-pro-free:free').tunables, undefined, 'it has the ability\'s, once');
  assert.equal(or['fish-audio/s2.1-pro-free:free'].voice, KATKAT);
  for (const id of ['x-ai/grok-voice-tts-1.0', 'mistralai/voxtral-mini-tts-2603', 'hexgrad/kokoro-82m']) {
    assert.equal(or[id].styled, false, `${id}: OpenRouter's audio docs: only OpenAI's mini TTS, Gemini and Fish Audio take instructions`);
    assert.notEqual(or[id].voice, KATKAT, `${id}: a voice of its own`);
  }
  assert.deepEqual({ ...oai['gpt-4o-mini-tts'], voices: undefined }, { voice: 'marin', style: 'Speak in a young, cheerful and lively, yet calm and gentle tone.', voices: undefined });
  assert.equal(oai['tts-1'].styled, false);
  assert.equal(oai['tts-1-hd'].styled, false);
  assert.equal(oai['tts-1'].voices.length, 9, "tts-1's smaller set");
  assert.equal(oai['gpt-4o-mini-tts'].voices.length, 13);
  // Gemini's models carry no voice: the type's Sulafat, or the voice named in the provider page's Tunables, which wins again.
  for (const m of ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']) {
    assert.deepEqual((await voiceAbility('provider-gemini')).models.find((/** @type {any} */ x) => x.providerId === m).tunables, { style: STYLE }, 'a style short enough to send each time, and no voice of its own');
    assert.deepEqual(gem[m], { voice: 'Sulafat', style: STYLE });
  }
  for (const [name, models] of Object.entries({ openrouter: or, openai: oai, gemini: gem })) {
    for (const [id, t] of Object.entries(models)) {
      assert.ok(t.voice, `${name}/${id}: a voice`);
      if (t.voices) assert.ok(t.voices.includes(t.voice), `${name}/${id}: its voice is one of its list`);
      if (t.styled !== false) assert.ok(t.style, `${name}/${id}: takes a style, so has one`);
    }
  }
  const local = /** @type {any} */ ((await official('provider-local-speech')).provider.abilities.voice);
  assert.deepEqual(local.modelDefaults, { tunables: { styled: false } }, 'Kokoro and Speaches take no style');
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
  // Its free voice is asked for one fixed voice and a style (phone1-voices): with none, Fish Audio picks another speaker each time.
  await llm.synthesize({ modelId: by('fish-audio/s2.1-pro-free:free'), text: 'Hello.' });
  assert.deepEqual(JSON.parse(seen[2].body), { model: 'fish-audio/s2.1-pro-free:free', input: 'Hello.', voice: 'bddf65d5a84c4a9aa36b7136bdac57a9', response_format: 'mp3', instructions: 'young, cheerful and lively, yet calm and gentle' });
  // Plain /models leaves speech models out; its lists by output_modalities have them, with their names.
  assert.deepEqual(await llm.listModels(id, 'transcription'), [{ providerId: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo' }, { providerId: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' }]);
  assert.equal(seen[3].url, 'https://openrouter.ai/api/v1/models?output_modalities=transcription');
  assert.deepEqual((await llm.listModels(id, 'voice')).map((m) => m.providerId), ['x-ai/grok-voice-tts-1.0']);
  assert.equal(seen[4].url, 'https://openrouter.ai/api/v1/models?output_modalities=speech');
  // A model added from the chat list gets OpenRouter web search (decision 26).
  const { addListedModel } = await import('../../src/core/llm/providers.js');
  const listed = await addListedModel(k, id, 'chat', { providerId: 'some/new-model' });
  assert.deepEqual(modelOf((await readConfig(k.ws)).models[listed]).providerTools.map((t) => t.id), ['openrouter-web-search']);
  // A voice added from the speech list keeps the voices OpenRouter lists for it, for its Voice field, and its first (a warm one else), and that Grok ignores a style (phone1-voices).
  const [grok] = await llm.listModels(id, 'voice');
  const grokId = await addListedModel(k, id, 'voice', grok);
  assert.deepEqual(modelOf((await readConfig(k.ws)).models[grokId]).tunables, { voice: 'eve', voices: ['eve', 'ara'], styled: false });
  // A Fish Audio model added by id starts with Women KatKat and the style, the ability's: sent none, Fish Audio would pick a speaker for each sentence.
  const { addModelById } = await import('../../src/core/llm/providers.js');
  const fishId = await addModelById(k, id, 'voice', 'fish-audio/s2.1-pro');
  await llm.synthesize({ modelId: fishId, text: 'Hello.' });
  assert.deepEqual(JSON.parse(seen.at(-1).body), { model: 'fish-audio/s2.1-pro', input: 'Hello.', voice: 'bddf65d5a84c4a9aa36b7136bdac57a9', response_format: 'mp3', instructions: 'young, cheerful and lively, yet calm and gentle' });
  // The free voice of a user who once emptied its Voice, before an emptied field meant the default (the old page saved voice: null, a deletion): Women KatKat too.
  const fishFree = by('fish-audio/s2.1-pro-free:free');
  const rec = (await readConfig(k.ws)).models[fishFree];
  const { saveModel } = await import('../../src/core/llm/config.js');
  await saveModel(k.ws, { ...rec, user: { ...rec.user, tunables: { voice: null } } });
  await llm.synthesize({ modelId: fishFree, text: 'Again.' });
  assert.equal(JSON.parse(seen.at(-1).body).voice, 'bddf65d5a84c4a9aa36b7136bdac57a9');
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

test('every official transcription and Chat Completions ability declares the audio it takes (audioIn), every voice what it gives (audioOut), WAV and MP3 always among them (Koe and Kokoro design, "Audio formats")', async () => {
  /** @type {Record<string, any>} */
  const defaults = {};
  const register = (/** @type {any} */ t) => { defaults[t.type] = t.tunables ?? {}; return () => {}; };
  const helpers = { ProviderError: Error, errorFromResponse: () => new Error(), mergePatch: (/** @type {any} */ a, /** @type {any} */ b) => ({ ...a, ...b }), sse: () => {} };
  (await import('../../plugins-official/speech-openai/index.js')).activate({ providers: { register }, helpers });
  (await import('../../plugins-official/chat-completions/index.js')).activate({ providers: { register }, helpers });
  (await import('../../plugins-official/gemini-api/index.js')).activate({ providers: { register }, helpers });
  assert.deepEqual(defaults['chat-completions'].audioIn, ['wav', 'mp3'], "Chat Completions' input_audio: OpenAI's takes WAV and MP3 only");
  const known = ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'];
  /** @type {Record<string, any>} */
  const declared = {};
  for (const m of (await officialManifests()).filter((x) => x.provider)) {
    for (const [id, a] of Object.entries(/** @type {Record<string, any>} */ (m.provider.abilities))) {
      const t = { ...defaults[a.type], ...a.tunables };
      if (a.kind === 'transcription' || a.type === 'chat-completions' || a.type === 'gemini') {
        assert.ok(t.audioIn.includes('wav') && t.audioIn.every((/** @type {string} */ f) => known.includes(f)), `${m.id}/${id}: ${t.audioIn}`);
        declared[`${m.id}/${id}`] = t.audioIn;
      }
      if (a.kind === 'voice' && a.type === 'gemini-speech') {
        // Google sends a voice only as PCM or G.711, which the plugin hands annai as WAV or PCM: its own format tunable (G3).
        assert.deepEqual([t.format, t.audioOut], ['pcm24', undefined], `${m.id}/${id}`);
        continue;
      }
      if (a.kind === 'voice') {
        assert.ok(t.audioOut.includes('mp3') && t.format === 'auto', `${m.id}/${id}`);
        declared[`${m.id}/${id}`] = t.audioOut;
      }
    }
  }
  const opus = ['webm', 'ogg', 'mp4', 'mp3', 'flac', 'wav'];
  assert.deepEqual(declared['provider-groq/transcription'], opus);
  assert.deepEqual(declared['provider-local-speech/transcription'], opus);
  assert.deepEqual(declared['provider-vllm/transcription'], opus);
  assert.deepEqual(declared['provider-openai/transcription'], ['webm', 'mp4', 'mp3', 'wav']);
  assert.deepEqual(declared['provider-openrouter/chat'], ['ogg', 'aac', 'mp4', 'mp3', 'flac', 'wav']);
  assert.deepEqual(declared['provider-gemini/chat'], ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'], "Gemini's own API takes every format annai makes");
  assert.deepEqual(declared['provider-gemini/transcription'], ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'], 'and so does its transcription (G3)');
  assert.deepEqual(declared['provider-openrouter/voice'], ['mp3'], "OpenRouter's voices send MP3 (or raw PCM) only");
  assert.deepEqual(declared['provider-openai/voice'], ['opus', 'aac', 'mp3', 'flac', 'wav']);
  assert.deepEqual(declared['provider-local-speech/voice'], ['mp3', 'wav'], 'Speaches refuses opus and aac; Kokoro-FastAPI takes MP3 too');
});

test("Gemini's Live voice: off until switched on; Test opens a session that answers OK aloud, recorded on the model; the recommended models put it in Koe (K4)", async () => {
  const desc = (await official('provider-gemini')).provider;
  const live = /** @type {any} */ (desc.abilities.live);
  assert.deepEqual([live.kind, live.type, live.name, live.on, live.baseUrl], ['realtime', 'gemini-live', 'Live voice', false, 'https://generativelanguage.googleapis.com']);
  assert.deepEqual(live.models.map((/** @type {any} */ m) => m.providerId), ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking']);
  assert.deepEqual(live.models[0].prices, { input: 0.75, audioIn: 3, image: 1, output: 4.5, audioOut: 12 });
  assert.ok(live.models.every((/** @type {any} */ m) => m.input.join() === 'text,image'), 'it takes photos (and prices their tokens)');
  const GKEY = 'AIza-stand-in-gemini-key-0123456789';
  const s = await startRealtimeServer({ flavour: 'gemini', key: GKEY, pace: 0.05, turns: [{ said: 'OK.', audio: new Uint8Array(9600), usage: { promptTokenCount: 500, responseTokenCount: 20, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 500 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 20 }] } }] });
  try {
    const k = await hostKit();
    const fetch = async (/** @type {any} */ url) => {
      try {
        return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    };
    const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
    const id = await llm.addProvider('provider-gemini', { roles: 'recommended', key: GKEY, abilities: { live: { on: false, baseUrl: s.origin } } });
    assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['gemini-api', 'provider-gemini'], 'nothing for live sessions until they are switched on');
    const cfg = await readConfig(k.ws);
    assert.deepEqual([cfg.roles['koe-realtime'].models, cfg.roles['koe-classic'].models], [[], []], 'adding Gemini never fills Koe (the split is opt-in)');
    const liveId = /** @type {string} */ (Object.values(cfg.models).find((m) => modelOf(m).providerId === 'gemini-3.8-live')?.id);
    await llm.setAbility(id, 'live', true);
    assert.ok((await k.host.installed())['gemini-live'], 'switching it on installs its protocol');
    /** @type {number[]} */
    const heard = [];
    const r = await llm.test(liveId, { onAudio: (/** @type {Uint8Array} */ d, /** @type {any} */ f) => heard.push(d.length, f.rate) });
    assert.deepEqual(r.steps.map((/** @type {any} */ x) => [x.step, x.ok]), [['access', true], ['key', true], ['live', true]]);
    assert.equal(r.steps[2].detail, 'It answered aloud: OK.');
    assert.equal(heard.reduce((n, x, i) => (i % 2 ? n : n + x), 0), 9600, 'its voice, to play');
    assert.equal(heard[1], 24_000);
    assert.equal(s.received()[0].setup.model, 'models/gemini-3.8-live');
    assert.deepEqual(s.received()[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: 'Say OK.' }] }], turnComplete: true } });
    const verified = (await readConfig(k.ws)).models[liveId].verified;
    assert.deepEqual([verified?.access, verified?.key, verified?.live], [true, true, true]);
    assert.ok(!JSON.stringify(await k.log()).includes(GKEY), 'no key in any entry');
    // A key Gemini refuses is said as one.
    await llm.unbench(id);
    const { setKey } = await import('../../src/core/llm/config.js');
    await setKey(k.store, id, 'AIza-wrong');
    const bad = await llm.test(liveId);
    assert.deepEqual(bad.steps.map((/** @type {any} */ x) => [x.step, x.ok]), [['key', false]]);
    assert.match(bad.steps[0].detail, /key was rejected/);
    await llm.useSuggestion(id, 'recommended');
    const lite = Object.values((await readConfig(k.ws)).models).find((m) => m.ability === 'chat' && modelOf(m).providerId === 'gemini-3.5-flash-lite')?.id;
    const after = await readConfig(k.ws);
    assert.deepEqual([after.roles['koe-realtime'].models, after.roles['koe-classic'].models, after.koeMode], [[liveId], [lite], 'realtime'],
      '"Use the recommended models" puts Live in Koe · Realtime and flash-lite in Koe · Classic, and Realtime is chosen');
  } finally {
    await s.stop();
  }
});

test('provider-gemini 2.5.1: Gemini through its own API (gemini-api), its chat models priced as Google publishes them, the free-tier switch offered, no stand-in signature', async () => {
  const m = await official('provider-gemini');
  const { levelsFor } = await import('../../plugins-official/gemini-api/levels.js');
  assert.equal(m.version, '2.5.1');
  assert.deepEqual((await officialManifests()).find((x) => x.id === 'provider-gemini').requires, [{ id: 'gemini-api', version: '^0' }], 'not chat-completions; gemini-live comes when Live is switched on');
  const d = m.provider;
  assert.deepEqual([d.baseUrl, d.freeTier, d.keyUrl], ['https://generativelanguage.googleapis.com', 'Google', 'https://aistudio.google.com/apikey'], "who doesn't charge, by name");
  const chat = /** @type {any} */ (d.abilities.chat);
  assert.deepEqual([chat.kind, chat.type, chat.baseUrl, chat.tunables], ['chat', 'gemini', undefined, undefined], 'no standInCallExtra, no audio limit');
  assert.ok(!JSON.stringify(m).includes('standInCallExtra'));
  // Paid prices from Google's pricing page, 2026-10-19 (Standard tier, through 2026-12-31). 3.7-flash is left out: Google answers it as 3.8-flash.
  // No audioIn or cacheReadAudio: the page gives each one input and one caching price, for every kind of input (flash-lite's says
  // "text / image / video / audio"; 3.8's and 3.6's have no audio row; checked again in the fix pass), so audio costs what words do.
  assert.deepEqual(chat.models.map((/** @type {any} */ x) => [x.providerId, x.prices]), [
    ['gemini-3.8-flash', { input: 0.75, output: 3.75, cacheRead: 0.075 }],
    ['gemini-3.6-flash', { input: 0.75, output: 3.75, cacheRead: 0.075 }],
    ['gemini-3.5-flash-lite', { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  ]);
  for (const x of chat.models) {
    assert.deepEqual(x.reasoning, levelsFor(x.providerId), x.providerId);
    assert.deepEqual([x.contextWindow, x.maxOutput, x.input], [1048576, 65536, ['text', 'image', 'pdf', 'audio']], x.providerId);
  }
  assert.ok(d.abilities.live.models?.every((/** @type {any} */ x) => x.input.join() === 'text,image'), 'the live models take photos');
  assert.deepEqual(d.roles, { recommended: {
    main: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'], utility: ['gemini-3.5-flash-lite'], decide: ['gemini-3.5-flash-lite'],
    'koe-realtime': ['gemini-3.8-live'], 'koe-classic': ['gemini-3.5-flash-lite'],
    'speech-in': ['gemini-3.5-transcribe', 'gemini-3.5-flash-lite'], 'speech-out': ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'],
  } }, 'different quotas: a used-up day falls to the next flash, a used-up minute to the next voice');
  assert.match(chat.noWindowNote ?? '', /add it again with Fetch model list/, "what to do when a model from before 2.0 can't be kept, in words, shown while one is there");
  assert.equal(chat.note, undefined);
});

test("provider-gemini 2.2.0's Google Search (G4): a provider tool on each Gemini 3 chat model, paid only, 5,000 a month free then $0.014 each, with its switch's words for the provider's page", async () => {
  const chat = /** @type {any} */ ((await official('provider-gemini')).provider.abilities.chat);
  for (const x of chat.models) {
    assert.deepEqual(x.providerTools, [{
      id: 'gemini-google-search', name: 'Google Search', kind: 'search', patch: { 'tools+': [{ type: 'google_search' }] }, pricePerCall: 0.014, usageKey: 'google_search', paidOnly: true, freePerMonth: 5000,
      label: 'Let Gemini search Google',
      note: "Google gives 5,000 searches a month free on paid projects, then $14 per 1,000: annai counts this phone's. Google keeps searched prompts for 30 days, which annai can't delete.",
      shows: 'From Google Search',
    }], x.providerId);
  }
  assert.equal(chat.modelDefaults, undefined, 'not on a model added from the list: Gemma has no Google Search');
  // Through annai: Main's request that asks for the model's own search sends Google's, and the grounded reply is priced
  // within this phone's monthly allowance; on a key marked free tier, it isn't sent.
  const { startGeminiServer } = await import('../fakes/gemini-server.js');
  const { SYS_DEVICE } = await import('../../src/core/scopes.js');
  const s = await startGeminiServer({ replies: [{ text: 'Open till 10.', search: { queries: ['nepenthe hours', 'nepenthe big sur'], suggestions: '<div>chips</div>', links: [{ url: 'https://nepenthe.com', title: 'nepenthe.com' }] } }] });
  try {
    const k = await hostKit();
    const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => (String(url).startsWith(s.url) ? globalThis.fetch(url, init) : new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)).catch(() => 'not found'), { status: 200 }));
    const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
    const id = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-paid', baseUrl: s.url });
    const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'Is Nepenthe open?' }] }], providerTools: { kinds: ['search'] } };
    const paid = await llm.call({ role: 'main', request });
    assert.deepEqual(s.bodies()[0].tools, [{ type: 'google_search' }]);
    assert.deepEqual(paid.reply.parts.map((/** @type {any} */ p) => p.type), ['provider', 'provider', 'text']);
    assert.deepEqual(paid.reply.attribution, { source: 'Google Search', text: 'Open till 10.', links: [{ url: 'https://nepenthe.com', title: 'nepenthe.com' }], html: '<div>chips</div>' });
    assert.equal(paid.reply.usage.serverTools?.google_search, 2);
    assert.equal(Number(paid.cost?.toFixed(6)), Number(((100 * 0.75 + 10 * 3.75) / 1e6).toFixed(6)), "two searches of this phone's first 5,000 this month: free");
    assert.deepEqual(Object.values((await k.ws.readJSON(SYS_DEVICE, '/llm/tool-calls.json')).counts), [2]);
    await llm.setFree(id, true);
    const free = await llm.call({ role: 'main', request });
    assert.equal(s.bodies()[1].tools, undefined, "a free key's request never offers it");
    assert.deepEqual([free.cost, free.reply.parts.map((/** @type {any} */ p) => p.type), free.reply.attribution], [0, ['text'], undefined]);
  } finally {
    await s.close();
  }
});

test("provider-gemini's transcription and voices (G3): Google's transcription model and Flash Lite, priced per minute, and its two TTS models, priced per character, from Google's token rates", async () => {
  const d = (await official('provider-gemini')).provider;
  const hear = /** @type {any} */ (d.abilities.transcription);
  const say = /** @type {any} */ (d.abilities.voice);
  assert.deepEqual([hear.kind, hear.type, hear.on, say.kind, say.type, say.on], ['transcription', 'gemini-transcription', undefined, 'voice', 'gemini-speech', undefined]);
  // Google's pricing page, 2026-10-20, Standard tier through 2026-12-31: Transcribe's own estimate, $0.005 a minute; Flash Lite's audio at
  // $0.30 a million tokens, 25 a second, and about 175 words' tokens a minute out at $2.50; the voices' audio at $6 and $9 a million
  // tokens, 25 a second, at about 15 characters a second.
  assert.deepEqual(hear.models.map((/** @type {any} */ x) => [x.providerId, x.name, x.prices]), [
    ['gemini-3.5-transcribe', 'Gemini 3.5 Transcribe', { perMinute: 0.005 }],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite (transcription)', { perMinute: 0.0009 }],
  ]);
  assert.deepEqual(say.models.map((/** @type {any} */ x) => [x.providerId, x.name, x.prices]), [
    ['gemini-3.8-flash-lite-tts', 'Gemini 3.8 Flash Lite TTS', { perMillionChars: 10 }],
    ['gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', { perMillionChars: 15 }],
  ]);
  assert.match(say.note, /only 10 requests a day and 3 a minute: far fewer than a day of replies/, "the free tier's limits, too small for a day of replies, in words");
  assert.match(say.note, /Switch streaming off/);
  assert.doesNotMatch(`${say.note} ${hear.note}`, /measured|2026/, 'no dates in what the user reads (fix pass)');
});

test("the move-over from provider-gemini 1.x: the chat ability's type becomes gemini, the user's models and key stay, and 2.0's models join no role", async () => {
  const { syncProviders, addListedModel } = await import('../../src/core/llm/providers.js');
  const { setKey, getKey } = await import('../../src/core/llm/config.js');
  const k = await hostKit();
  const v2 = await official('provider-gemini');
  const v1 = /** @type {any} */ ({ ...v2, version: '1.5.0', provider: { ...v2.provider, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', freeTier: undefined, roles: { recommended: { koe: ['gemini-3.8-live'] } },
    abilities: { chat: { kind: 'chat', type: 'chat-completions', tunables: { standInCallExtra: { google: { thought_signature: 'skip_thought_signature_validator' } }, audioIn: ['wav', 'mp3'] } }, live: v2.provider.abilities.live } } });
  const { addProvider } = await import('../../src/core/llm/providers.js');
  const id = await addProvider({ ws: k.ws, store: k.store }, v1, { key: 'AIza-kept' });
  const old = await addListedModel({ ws: k.ws }, id, 'chat', { providerId: 'models/gemini-3.6-flash' });
  await saveRoles(k.ws, { ...(await readConfig(k.ws)).roles, main: { models: [old], level: 'medium' } });
  assert.equal(await syncProviders({ ws: k.ws }, [v2]), 1);
  const cfg = await readConfig(k.ws);
  const p = providerOf(cfg.providers[id]);
  assert.deepEqual([p.baseUrl, p.abilities.chat.type, p.abilities.chat.tunables], ['https://generativelanguage.googleapis.com', 'gemini', {}], 'the stand-in and the audio limit are gone with 1.x');
  assert.equal(modelOf(cfg.models[old]).providerId, 'models/gemini-3.6-flash', "kept: build asks for it by its id");
  assert.deepEqual(cfg.roles.main.models, [old]);
  assert.ok(Object.values(cfg.models).some((m) => modelOf(m).providerId === 'gemini-3.8-flash'), "2.0's models arrive, in no role");
  assert.equal(await getKey(k.store, id), 'AIza-kept');
  await setKey(k.store, id, null);
});

test('Gemini can be added while the user has Gemini Live turned off: it requires only gemini-api, and Live stays off', async () => {
  const k = await hostKit();
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  await llm.ensureType('gemini-live');
  await k.host.setEnabled('gemini-live', false);
  const id = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-stand-in' });
  assert.ok((await readConfig(k.ws)).providers[id]);
  assert.equal((await k.host.installed())['gemini-live'].enabled, false, 'still off, as the user left it');
});

test('"Use the recommended models" switches on every ability whose models it names: Live, installing its protocol, then fills the roles; adding the provider alone leaves Koe empty', async () => {
  const k = await hostKit();
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-stand-in' });
  const cfg = await readConfig(k.ws);
  const byId = (/** @type {string} */ pid) => Object.values(cfg.models).find((x) => x.ability !== 'transcription' && modelOf(x).providerId === pid)?.id;
  assert.deepEqual([cfg.roles['koe-realtime'].models, cfg.roles['koe-classic'].models], [[], []], 'adding Gemini never fills Koe (the split is opt-in)');
  assert.deepEqual(cfg.roles.main.models, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].map(byId));
  assert.equal(providerOf(cfg.providers[id]).abilities.live.on, false);
  assert.equal((await k.host.installed())['gemini-live'], undefined);
  assert.deepEqual(await llm.useSuggestion(id, 'recommended'), { on: ['Live voice'], failed: [] }, 'what it switched on, for the words after the tap');
  const after = await readConfig(k.ws);
  assert.equal(providerOf(after.providers[id]).abilities.live.on, true);
  assert.ok((await k.host.installed())['gemini-live'], 'switched on through setAbility, which installs its protocol');
  assert.deepEqual([after.roles['koe-realtime'].models, after.roles['koe-classic'].models, after.koeMode], [[byId('gemini-3.8-live')], [byId('gemini-3.5-flash-lite')], 'realtime'], 'Live switched on: Realtime chosen');
});

/** A model service on a fresh host that installs annai's own plugins from this repository. */
async function geminiKit() {
  const k = await hostKit();
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  return { ...k, llm: createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch }) };
}

test('"Use the recommended models" never switches on an ability the user switched off; one new in an update, which arrived off, it does', async () => {
  const k = await geminiKit();
  const id = await k.llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-stand-in' });
  await k.llm.setAbility(id, 'chat', false); // on by the description, off by the user
  assert.deepEqual(await k.llm.useSuggestion(id, 'recommended'), { on: ['Live voice'], failed: [] });
  const cfg = await readConfig(k.ws);
  assert.equal(providerOf(cfg.providers[id]).abilities.chat.on, false, 'the user\'s choice stands');
  assert.deepEqual([cfg.roles['koe-realtime'].models.map((m) => modelOf(cfg.models[m]).providerId), cfg.roles['koe-classic'].models], [['gemini-3.8-live'], []], 'only what is on');
  // An ability an update brought arrives switched off in the user's layer: that isn't the user's choice.
  const rec = cfg.providers[id];
  const { saveProvider } = await import('../../src/core/llm/config.js');
  await saveProvider(k.ws, { ...rec, template: { ...rec.template, added: ['chat'] } });
  assert.deepEqual((await k.llm.useSuggestion(id, 'recommended')).on, ['Chat']);
  assert.equal(providerOf((await readConfig(k.ws)).providers[id]).abilities.chat.on, true);
});

test('"Use the recommended models" with Gemini Live turned off in Settings → Plugins: Live stays off, says why, and every role it can fill is filled', async () => {
  const k = await geminiKit();
  const id = await k.llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-stand-in' });
  await k.llm.ensureType('gemini-live');
  await k.host.setEnabled('gemini-live', false);
  await saveRoles(k.ws, { ...(await readConfig(k.ws)).roles, main: { models: [], level: 'medium' } });
  const r = await k.llm.useSuggestion(id, 'recommended');
  assert.deepEqual([r.on, r.failed.map((f) => f.name)], [[], ['Live voice']]);
  assert.match(String(/** @type {any} */ (r.failed[0].error)?.message), /turned off|Turn it on/);
  const cfg = await readConfig(k.ws);
  assert.equal(providerOf(cfg.providers[id]).abilities.live.on, false);
  assert.equal((await k.host.installed())['gemini-live'].enabled, false, 'the plugin stays as the user left it');
  assert.deepEqual(cfg.roles.main.models.map((m) => modelOf(cfg.models[m]).providerId), ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'], 'Main is filled all the same');
  assert.deepEqual([cfg.roles['koe-realtime'].models, cfg.roles['koe-classic'].models.map((m) => modelOf(cfg.models[m]).providerId), cfg.koeMode], [[], ['gemini-3.5-flash-lite'], 'classic'], 'Live stays off: Classic');
});

test("OpenAI's Realtime voice: off until switched on, which installs openai-realtime; Test opens a session through the key as a subprotocol that answers OK aloud, in 24 kHz PCM; a refused key is said as one (K6)", async () => {
  const desc = (await official('provider-openai')).provider;
  const rt = /** @type {any} */ (desc.abilities.realtime);
  assert.deepEqual([rt.kind, rt.type, rt.name, rt.on, rt.baseUrl], ['realtime', 'openai-realtime', 'Realtime voice', false, undefined], 'at the provider\'s own address');
  assert.deepEqual(rt.models.map((/** @type {any} */ m) => m.providerId), ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']);
  assert.deepEqual(rt.models.map((/** @type {any} */ m) => m.prices), [
    { input: 4, cacheRead: 0.4, audioIn: 32, cacheReadAudio: 0.4, image: 5, cacheReadImage: 0.5, output: 24, audioOut: 64 },
    { input: 0.6, cacheRead: 0.06, audioIn: 10, cacheReadAudio: 0.3, image: 0.8, cacheReadImage: 0.08, output: 2.4, audioOut: 20 },
  ]);
  assert.ok(rt.models.every((/** @type {any} */ m) => m.input.includes('image') && m.contextWindow === 128000));
  assert.match(rt.note, /short-lived/);
  assert.ok(!desc.roles?.recommended?.['koe-realtime'] && !desc.roles?.recommended?.koe, 'not recommended for Koe until a real key has shown OpenAI takes one from a browser');
  assert.ok(!entry('provider-openai').requires.some((/** @type {any} */ r) => r.id === 'openai-realtime'), 'it brings its protocol only when switched on');
  assert.ok(entry('provider-openai').version > '1.0.0', 'a version past the one released');
  const SK = 'sk-proj-stand-in-openai-key-0123456789';
  const s = await startRealtimeServer({ flavour: 'openai', key: SK, pace: 0.05, turns: [{ said: 'OK.', audio: new Uint8Array(9600), usage: { input_tokens: 500, output_tokens: 20, input_token_details: { text_tokens: 500 }, output_token_details: { audio_tokens: 20 } } }] });
  try {
    const k = await hostKit();
    const fetch = async (/** @type {any} */ url) => {
      try {
        return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    };
    const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
    const id = await llm.addProvider('provider-openai', { key: SK, abilities: { realtime: { on: false, baseUrl: `${s.origin}/v1` } } });
    assert.ok(!(await k.host.installed())['openai-realtime'], 'nothing for live sessions until they are switched on');
    const cfg = await readConfig(k.ws);
    assert.deepEqual([cfg.roles['koe-realtime'].models, cfg.roles['koe-classic'].models], [[], []], 'adding OpenAI never fills Koe (the split is opt-in)');
    const rtId = /** @type {string} */ (Object.values(cfg.models).find((m) => modelOf(m).providerId === 'gpt-realtime-2.1')?.id);
    await llm.setAbility(id, 'realtime', true);
    assert.ok((await k.host.installed())['openai-realtime'], 'switching it on installs its protocol');
    /** @type {number[]} */
    const heard = [];
    const r = await llm.test(rtId, { onAudio: (/** @type {Uint8Array} */ d, /** @type {any} */ f) => heard.push(d.length, f.rate) });
    assert.deepEqual(r.steps.map((/** @type {any} */ x) => [x.step, x.ok]), [['access', true], ['key', true], ['live', true]]);
    assert.equal(r.steps[2].detail, 'It answered aloud: OK.');
    assert.equal(heard.reduce((n, x, i) => (i % 2 ? n : n + x), 0), 9600, 'its voice, to play');
    assert.equal(heard[1], 24_000);
    const [c] = s.connections();
    assert.deepEqual([c.path, c.model, c.key], ['/v1/realtime', 'gpt-realtime-2.1', SK], 'the key went to the stand-in as a subprotocol, nowhere in the address');
    assert.deepEqual(s.received().map((m) => m.type), ['session.update', 'conversation.item.create', 'response.create']);
    assert.deepEqual(s.received()[0].session.audio.input.format, { type: 'audio/pcmu' });
    assert.equal(s.received()[1].item.content[0].text, 'Say OK.');
    assert.deepEqual((await readConfig(k.ws)).models[rtId].verified?.live, true);
    assert.ok(!JSON.stringify(await k.log()).includes(SK), 'no key in any entry');
    // A key OpenAI refuses is said as one, though the stand-in says it back.
    await llm.unbench(id);
    const { setKey } = await import('../../src/core/llm/config.js');
    await setKey(k.store, id, 'sk-proj-wrong-0123456789');
    const bad = await llm.test(rtId);
    assert.deepEqual(bad.steps.map((/** @type {any} */ x) => [x.step, x.ok]), [['key', false]]);
    assert.match(bad.steps[0].detail, /key was rejected/);
    assert.ok(!JSON.stringify(await k.log()).includes('sk-proj-wrong-0123456789'));
  } finally {
    await s.stop();
  }
});

test('Custom provider has a Realtime voice ability, off, for any server that speaks OpenAI Realtime (K6)', async () => {
  const m = await official('provider-another-address');
  const rt = /** @type {any} */ (m.provider.abilities.realtime);
  assert.deepEqual([rt.kind, rt.type, rt.on], ['realtime', 'openai-realtime', false]);
  assert.ok(entry('provider-another-address').version > '2.0.0', 'a version past the one released');
});
