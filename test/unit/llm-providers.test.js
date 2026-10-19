import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readConfig, modelOf, providerOf, getKey, saveProvider, saveModel, saveRoles, removeModel, removeProviderRecords, diffLayer, providerBase } from '../../src/core/llm/config.js';
import { addProvider, syncProviders, useSuggestion, addListedModel, addModelById, withSpeech, speechAdd, speechBehind } from '../../src/core/llm/providers.js';
import { ttlFor } from '../../src/core/agent/warmth.js';
import { OPENAI_SRC, ROUTER_SRC, ANTHROPIC_SRC, ANOTHER_SRC } from './provider-kit.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}

/** The names in a role, stand-ins by their ids. @param {import('../../src/core/llm/config.js').ModelConfig} cfg @param {string} role */
const names = (cfg, role) => cfg.roles[role].models.map((id) => (cfg.models[id] ? modelOf(cfg.models[id]).name : id));
/** @param {import('../../src/core/llm/config.js').ModelConfig} cfg */
const modelNames = (cfg) => Object.values(cfg.models).map((m) => modelOf(m).name);
/** A source at another version, changed by fn. @param {any} src @param {string} version @param {(p: any) => void} fn */
const bumped = (src, version, fn) => {
  const next = structuredClone(src);
  next.version = version;
  fn(next.provider);
  return next;
};

test('adding a provider: abilities and their models, one key, recommended chat models in empty roles, speech models behind the free entries', async () => {
  const ctx = await setup();
  const id = await addProvider(ctx, OPENAI_SRC, { key: 'sk-o' });
  const cfg = await readConfig(ctx.ws);
  assert.deepEqual(Object.keys(cfg.providers), [id]);
  assert.equal(cfg.providers[id].plugin, 'provider-openai');
  assert.equal(cfg.providers[id].template?.version, '1.0.0');
  const p = providerOf(cfg.providers[id]);
  assert.equal(p.name, 'OpenAI');
  assert.deepEqual(Object.keys(p.abilities), ['chat', 'chat-completions', 'transcription', 'voice']);
  assert.equal(p.abilities['chat-completions'].on, false);
  assert.equal(await getKey(ctx.store, id), 'sk-o');
  assert.deepEqual(names(cfg, 'main'), ['GPT-6.1 Sol']);
  assert.deepEqual(names(cfg, 'utility'), ['GPT-6 Luna']);
  assert.deepEqual(names(cfg, 'speech-out'), ['browser-voice', 'OpenAI: GPT-4o mini TTS (Marin)']); // behind, never ahead (anti-goal)
  assert.deepEqual(names(cfg, 'speech-in'), ['send-audio', 'dictation', 'OpenAI: GPT Transcribe']);
  const voice = Object.values(cfg.models).find((m) => m.ability === 'voice');
  assert.equal(voice?.template?.id, 'provider-openai/voice/gpt-4o-mini-tts');
  assert.deepEqual(modelOf(/** @type {any} */ (voice)).tunables, { voice: 'marin' });
});

test('two providers from one plugin: two keys, models named apart; removing one keeps the other whole (Review Focus 1)', async () => {
  const ctx = await setup();
  const a = await addProvider(ctx, OPENAI_SRC, { key: 'sk-a', name: 'OpenAI (work)' });
  const b = await addProvider(ctx, OPENAI_SRC, { key: 'sk-b', name: 'OpenAI (home)' });
  let cfg = await readConfig(ctx.ws);
  assert.ok(modelNames(cfg).includes('GPT-6 Luna (2)'), modelNames(cfg).join());
  assert.deepEqual([providerOf(cfg.providers[a]).name, providerOf(cfg.providers[b]).name], ['OpenAI (work)', 'OpenAI (home)']);
  assert.deepEqual(names(cfg, 'main'), ['GPT-6.1 Sol'], "the second fills no role the first has filled");
  assert.deepEqual(names(cfg, 'speech-out'), ['browser-voice', 'OpenAI: GPT-4o mini TTS (Marin)', 'OpenAI: GPT-4o mini TTS (Marin) (2)']);
  await removeProviderRecords(ctx.ws, ctx.store, a);
  cfg = await readConfig(ctx.ws);
  assert.equal(await getKey(ctx.store, b), 'sk-b');
  assert.equal(await getKey(ctx.store, a), null);
  assert.ok(Object.values(cfg.models).every((m) => m.provider === b));
  assert.equal(Object.values(cfg.models).length, 4);
  assert.deepEqual(names(cfg, 'speech-out'), ['browser-voice', 'OpenAI: GPT-4o mini TTS (Marin) (2)']);
});

test("a newer plugin version refreshes its providers: the user's renames, prices, deleted headers, switched-off abilities and address stay; new models arrive in no role; a new ability arrives off (Review Focus 2)", async () => {
  const ctx = await setup();
  const id = await addProvider(ctx, ROUTER_SRC, { key: 'sk-r', roles: 'free' });
  let cfg = await readConfig(ctx.ws);
  const rec = cfg.providers[id];
  const base = providerBase(rec);
  // The user's own changes: a name, an address, a header deleted, the voice switched off.
  await saveProvider(ctx.ws, { ...rec, user: { name: 'My router', ...diffLayer({ baseUrl: 'https://mine.test/v1', headers: { 'X-Title': 'annai' } }, base), abilities: { voice: { on: false } } } });
  const big = /** @type {any} */ (Object.values(cfg.models).find((m) => modelOf(m).providerId === 'big'));
  await saveModel(ctx.ws, { ...big, user: { name: 'Big one', prices: { input: 1, output: 5 } } });
  const paid = /** @type {any} */ (Object.values(cfg.models).find((m) => modelOf(m).providerId === 'paid-voice'));
  await removeModel(ctx.ws, paid.id);
  const roles = (await readConfig(ctx.ws)).roles;
  assert.equal(await syncProviders(ctx, [ROUTER_SRC]), 0, 'the same version changes nothing');
  const next = bumped(ROUTER_SRC, '1.1.0', (p) => {
    p.baseUrl = 'https://router.test/api/v2';
    p.abilities.chat.models.push({ providerId: 'new-one', name: 'New one', prices: { input: 1, output: 1 } });
    p.abilities.chat.models[0].contextWindow = 2000000;
    p.abilities.chat.models[0].prices = { input: 3, output: 12 };
    p.abilities.transcription = { kind: 'transcription', type: 'openai-transcription', models: [{ providerId: 'ears', name: 'Ears', prices: { perMinute: 0.001 } }] };
  });
  assert.equal(await syncProviders(ctx, [next, OPENAI_SRC]), 1);
  cfg = await readConfig(ctx.ws);
  const p = providerOf(cfg.providers[id]);
  assert.equal(p.name, 'My router');
  assert.equal(p.baseUrl, 'https://mine.test/v1');
  assert.deepEqual(p.headers, { 'X-Title': 'annai' });
  assert.equal(p.abilities.voice.on, false);
  assert.equal(p.abilities.transcription.on, false, 'a new ability arrives off');
  assert.equal(cfg.providers[id].template?.version, '1.1.0');
  const mine = modelOf(cfg.models[big.id]);
  assert.deepEqual([mine.name, mine.prices, mine.contextWindow], ['Big one', { input: 1, output: 5 }, 2000000]);
  assert.ok(modelNames(cfg).includes('New one') && modelNames(cfg).includes('Ears'));
  assert.ok(!modelNames(cfg).includes('Paid voice'), "a model the user removed isn't added again");
  assert.deepEqual(cfg.roles, roles, 'new models join no role');
  assert.equal(await syncProviders(ctx, [next]), 0, 'once is enough');
});

test('Use the recommended models replaces the chat roles and puts speech models ahead of the stand-ins, on the tap only', async () => {
  const ctx = await setup();
  const id = await addProvider(ctx, ROUTER_SRC, { key: 'sk-r', roles: 'free' });
  let cfg = await readConfig(ctx.ws);
  assert.deepEqual(names(cfg, 'main'), ['Small (free)']);
  assert.deepEqual(names(cfg, 'speech-out'), ['browser-voice', 'Free voice', 'Paid voice'], "the free suggestion has no voice: the recommended one's go behind");
  await useSuggestion(ctx, id, ROUTER_SRC, 'recommended');
  cfg = await readConfig(ctx.ws);
  assert.deepEqual(names(cfg, 'main'), ['Big']);
  assert.deepEqual(names(cfg, 'speech-out'), ['Free voice', 'Paid voice', 'browser-voice']);
});

test("adding keeps the user's own speech lists: models join at their end, and a list the user emptied stays empty", async () => {
  const ctx = await setup();
  await saveRoles(ctx.ws, { 'speech-in': { models: ['dictation'], level: 'off' }, 'speech-out': { models: [], level: 'off' } });
  await addProvider(ctx, OPENAI_SRC, { key: 'sk-o' });
  const cfg = await readConfig(ctx.ws);
  assert.deepEqual(names(cfg, 'speech-in'), ['dictation', 'OpenAI: GPT Transcribe']);
  assert.deepEqual(names(cfg, 'speech-out'), []);
});

test("a model added by id or from a list starts with its ability's modelDefaults: an Anthropic model takes both cache lifetimes, so it gets the hour", async () => {
  const ctx = await setup();
  const claude = await addProvider(ctx, ANTHROPIC_SRC, { key: 'sk-ant' });
  const other = await addProvider(ctx, ROUTER_SRC, { roles: null });
  const model = async (/** @type {string} */ id) => modelOf((await readConfig(ctx.ws)).models[id]);
  const haiku = await addModelById(ctx, claude, 'chat', 'claude-haiku-6');
  assert.deepEqual((await model(haiku)).cacheTtls, ['5m', '1h']);
  assert.equal(ttlFor(await model(haiku), '1h'), '1h');
  assert.deepEqual((await model(haiku)).providerTools.map((t) => t.id), ['anthropic-web-search']);
  const listed = await addListedModel(ctx, claude, 'chat', { providerId: 'claude-sonnet-6', name: 'Claude Sonnet 6', contextWindow: 1000 });
  assert.deepEqual([(await model(listed)).cacheTtls, (await model(listed)).contextWindow], [['5m', '1h'], 1000]);
  assert.equal((await readConfig(ctx.ws)).models[listed].template?.id, 'list/claude-sonnet-6');
  assert.deepEqual((await model(await addModelById(ctx, other, 'chat', 'some/model'))).cacheTtls, []);
  const twice = await addListedModel(ctx, other, 'chat', { providerId: 'x/big', name: 'Big' });
  assert.equal((await model(twice)).name, 'Big (2)', 'a listed model gets a name of its own');
  await assert.rejects(addModelById(ctx, claude, 'voice', 'x'), /ability/);
});

test('Another address: abilities start off; an ability added on with its own address keeps it', async () => {
  const ctx = await setup();
  const id = await addProvider(ctx, ANOTHER_SRC, { name: 'maiGo', baseUrl: 'https://router.example/v1', key: 'sk-m', abilities: { 'chat-completions': { on: true }, voice: { on: true, baseUrl: 'https://voice.example/v1' } } });
  const p = providerOf((await readConfig(ctx.ws)).providers[id]);
  assert.equal(p.name, 'maiGo');
  assert.deepEqual(Object.fromEntries(Object.values(p.abilities).map((a) => [a.id, [a.on, a.baseUrl]])), {
    'chat-completions': [true, 'https://router.example/v1'], messages: [false, 'https://router.example/v1'], voice: [true, 'https://voice.example/v1'],
  });
  const second = await addProvider(ctx, ANOTHER_SRC, {});
  const plain = providerOf((await readConfig(ctx.ws)).providers[second]);
  assert.ok(Object.values(plain.abilities).every((a) => !a.on));
  assert.equal(plain.name, 'Another address');
});

test('speech lists: a transcription model after "Send audio", a voice ahead of the browser voice; behind puts them last; a stand-in added back goes last', () => {
  assert.deepEqual(withSpeech(['send-audio', 'dictation'], ['m1'], 'speech-in'), ['send-audio', 'm1', 'dictation']);
  assert.deepEqual(withSpeech(['browser-voice'], ['v1', 'v1'], 'speech-out'), ['v1', 'browser-voice']);
  assert.deepEqual(speechBehind(['send-audio', 'dictation'], ['m1', 'dictation']), ['send-audio', 'dictation', 'm1']);
  assert.deepEqual(speechBehind([], ['m1']), []);
  assert.deepEqual(speechAdd(['dictation', 'm1'], 'dictation', 'speech-in'), ['m1', 'dictation']);
});
