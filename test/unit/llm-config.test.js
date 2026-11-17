import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';
import {
  CHAT_ROLES, KOE_ROLES, SPEECH_ROLES, readConfig, providerOf, providerBase, endpointOf, modelOf, modelBase, diffLayer, newProvider, newModel,
  saveProvider, saveModel, saveRoles, removeProviderRecords, removeModel, setKey, getKey, abilityOf, speechKind, sendKey, modelNames, withProvider,
} from '../../src/core/llm/config.js';
import { addProvider } from '../../src/core/llm/providers.js';
import { official } from './provider-kit.js';
import { setWords, key } from '../../src/core/l10n.js';
import { readFile } from 'node:fs/promises';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}

/** A local speech server's template values: transcription at the provider's address, a voice at its own. */
const LOCAL_SPEECH_VALUES = {
  name: 'Local speech server', baseUrl: 'http://localhost:8000/v1',
  abilities: {
    transcription: { kind: 'transcription', type: 'openai-transcription', on: true },
    voice: { kind: 'voice', type: 'openai-speech', on: true, baseUrl: 'http://localhost:8880/v1', tunables: { voice: 'af_heart' } },
  },
};
/** OpenRouter's, with its headers, chat tunable and a voice. */
const ROUTER_VALUES = {
  name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: { 'HTTP-Referer': 'https://annai.guide', 'X-Title': 'annai' },
  abilities: {
    chat: { kind: 'chat', type: 'chat-completions', on: true, tunables: { reasoningField: 'reasoning' } },
    voice: { kind: 'voice', type: 'openai-speech', on: true, tunables: { listPath: '/models?output_modalities=speech' } },
  },
};
const router = () => newProvider('provider-openrouter', { template: { version: '1.0.0', values: ROUTER_VALUES } });
/** All the settings files, as text. @param {Workspace} ws */
const allSettingsFiles = async (ws) => Promise.all((await ws.list(SYS_SETTINGS, '/')).map((f) => ws.readText(SYS_SETTINGS, f.path)));

test("a provider round-trips; each ability resolves type defaults < description < user, and its address defaults to the provider's", async () => {
  const { ws } = await setup();
  const rec = newProvider('provider-local-speech', { template: { version: '1.0.0', values: LOCAL_SPEECH_VALUES } });
  assert.match(rec.id, /^pv-/);
  await saveProvider(ws, rec);
  const saved = (await readConfig(ws)).providers[rec.id];
  const p = providerOf(saved, (type) => (type === 'openai-speech' ? { path: '/audio/speech', voice: 'alloy' } : {}));
  assert.equal(p.name, 'Local speech server');
  assert.equal(p.plugin, 'provider-local-speech');
  assert.equal(p.abilities.transcription.baseUrl, 'http://localhost:8000/v1');
  assert.equal(p.abilities.voice.baseUrl, 'http://localhost:8880/v1');
  assert.deepEqual(p.abilities.voice.tunables, { path: '/audio/speech', voice: 'af_heart' });
  assert.equal(p.abilities.voice.on, true);
  const ep = endpointOf(saved, 'voice', { path: '/audio/speech' });
  assert.deepEqual(ep, {
    id: `${rec.id}/voice`, provider: rec.id, ability: 'voice', type: 'openai-speech', name: 'Local speech server',
    baseUrl: 'http://localhost:8880/v1', headers: {}, tunables: { path: '/audio/speech', voice: 'af_heart' }, extraBody: {},
  });
  const user = { ...saved, user: { name: 'Speech at home', abilities: { voice: { tunables: { voice: 'bf_emma' } } } } };
  assert.equal(providerOf(user).name, 'Speech at home');
  assert.deepEqual(providerOf(user).abilities.voice.tunables, { voice: 'bf_emma' });
  assert.equal(providerBase(user).abilities.voice.tunables.voice, 'af_heart', 'the base has no user layer');
  assert.equal(providerOf(newProvider('provider-x', { user: { abilities: { chat: { kind: 'chat', type: 'chat-completions' } } } })).name, 'provider-x', 'named by its plugin until it has a name');
});

test("a user's changes to one ability never touch another's, and headers belong to the provider", async () => {
  const { ws } = await setup();
  const rec = router();
  const base = providerBase(rec);
  // The screen saves an ability's fields as a layer of that ability alone.
  const voiceLayer = diffLayer({ tunables: { ...base.abilities.voice.tunables, listPath: '/mine' }, baseUrl: 'https://voice.example/v1' }, base.abilities.voice);
  const headers = diffLayer({ headers: { 'HTTP-Referer': 'https://annai.guide' } }, base);
  await saveProvider(ws, { ...rec, user: { ...headers, abilities: { voice: voiceLayer, chat: { on: false } } } });
  const p = providerOf((await readConfig(ws)).providers[rec.id]);
  assert.deepEqual(p.abilities.chat.tunables, { reasoningField: 'reasoning' });
  assert.equal(p.abilities.chat.on, false);
  assert.equal(p.abilities.chat.baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(p.abilities.voice.tunables, { listPath: '/mine' });
  assert.equal(p.abilities.voice.baseUrl, 'https://voice.example/v1');
  assert.deepEqual(p.headers, { 'HTTP-Referer': 'https://annai.guide' }, "a deleted header stays deleted, for every ability");
  assert.deepEqual(endpointOf((await readConfig(ws)).providers[rec.id], 'chat').headers, { 'HTTP-Referer': 'https://annai.guide' });
});

test('one key per provider, only in secrets (spec §9.9)', async () => {
  const { ws, store } = await setup();
  const rec = router();
  await saveProvider(ws, rec);
  await setKey(store, rec.id, 'sk-or-secret-one');
  assert.equal(await getKey(store, rec.id), 'sk-or-secret-one');
  assert.deepEqual(await store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [`llm:${rec.id}`]);
  assert.ok(!JSON.stringify(await allSettingsFiles(ws)).includes('sk-or-secret'));
  await setKey(store, rec.id, null);
  assert.equal(await getKey(store, rec.id), null);
});

test('removing a provider removes its models, their places in roles, its key and its uploads, and nothing of another provider', async () => {
  const { ws, store } = await setup();
  const a = router();
  const b = newProvider('provider-local-speech', { template: { version: '1.0.0', values: LOCAL_SPEECH_VALUES } });
  const chat = newModel(a.id, 'chat', { user: { providerId: 'a/chat' } });
  const voice = newModel(a.id, 'voice', { user: { providerId: 'a/voice' } });
  const other = newModel(b.id, 'voice', { user: { providerId: 'b/voice' } });
  await saveProvider(ws, a, [chat, voice]);
  await saveProvider(ws, b, [other]);
  await saveRoles(ws, { main: { models: [chat.id], level: 'medium' }, 'speech-out': { models: ['browser-voice', voice.id, other.id], level: 'off' } });
  await setKey(store, a.id, 'sk-a-123456789');
  await setKey(store, b.id, 'sk-b-123456789');
  await ws.write(SYS_SETTINGS, '/llm/uploads.json', { [`${a.id}/chat`]: { h1: { id: 'file-1', expiresAt: 9e15 } }, [`${b.id}/voice`]: { h2: { id: 'file-2', expiresAt: 9e15 } } }, { author: 'system' });
  const removed = await removeProviderRecords(ws, store, a.id);
  assert.deepEqual(removed.sort(), [chat.id, voice.id].sort());
  const cfg = await readConfig(ws);
  assert.deepEqual(Object.keys(cfg.providers), [b.id]);
  assert.deepEqual(Object.keys(cfg.models), [other.id]);
  assert.deepEqual(cfg.roles.main.models, []);
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice', other.id]);
  assert.equal(await getKey(store, a.id), null);
  assert.equal(await getKey(store, b.id), 'sk-b-123456789');
  assert.deepEqual(Object.keys(await ws.readJSON(SYS_SETTINGS, '/llm/uploads.json')), [`${b.id}/voice`]);
  await removeModel(ws, other.id);
  assert.deepEqual((await readConfig(ws)).roles['speech-out'].models, ['browser-voice']);
});

test('a model whose ability the provider no longer has is skipped on read; records that are not valid are refused on save and skipped on read', async () => {
  const { ws } = await setup();
  const rec = router();
  const chat = newModel(rec.id, 'chat', { user: { providerId: 'x/y' } });
  const lost = newModel(rec.id, 'transcription', { user: { providerId: 'x/ears' } });
  await saveProvider(ws, rec, [chat, lost]);
  assert.deepEqual(Object.keys((await readConfig(ws)).models), [chat.id]);
  await assert.rejects(saveProvider(ws, /** @type {any} */ ({ id: 'BAD ID', plugin: '', template: null, user: {}, created: 1 })), ValidationError);
  await assert.rejects(saveProvider(ws, /** @type {any} */ ({ ...rec, template: { version: 3, values: {} } })), ValidationError, 'a template version is a plugin version');
  await ws.write(SYS_SETTINGS, '/llm/providers/broken.json', { nope: true }, { author: 'user' });
  // A model from before providers (it names an endpoint) is no model now.
  await ws.write(SYS_SETTINGS, '/llm/models/m-old.json', { id: 'm-old', endpoint: 'ep-1', template: null, user: { providerId: 'old' }, created: 1 }, { author: 'user' });
  const cfg = await readConfig(ws);
  assert.deepEqual(Object.keys(cfg.providers), [rec.id]);
  assert.deepEqual(Object.keys(cfg.models), [chat.id]);
  assert.equal(abilityOf(cfg, chat.id)?.kind, 'chat');
  assert.equal(abilityOf(cfg, 'm-old'), null);
});

test('model names are unique, whatever their case; a model needs its provider and that ability', async () => {
  const { ws } = await setup();
  const rec = router();
  await saveProvider(ws, rec);
  await saveModel(ws, newModel(rec.id, 'chat', { user: { providerId: 'a/b', name: 'Haiku' } }));
  await assert.rejects(saveModel(ws, newModel(rec.id, 'voice', { user: { providerId: 'c/d', name: 'haiku' } })), (e) => e instanceof ValidationError && /already used/.test(e.errors.join()));
  await assert.rejects(saveModel(ws, newModel(rec.id, 'chat', { user: {} })), ValidationError);
  await assert.rejects(saveModel(ws, newModel('pv-gone', 'chat', { user: { providerId: 'z' } })), ValidationError);
  await assert.rejects(saveModel(ws, newModel(rec.id, 'transcription', { user: { providerId: 'z' } })), (e) => e instanceof ValidationError && /ability/.test(e.errors.join()));
});

test('roles: every chat and speech role, its default level, and only models that exist and their own stand-ins', async () => {
  const { ws } = await setup();
  const rec = router();
  const a = newModel(rec.id, 'chat', { user: { providerId: 'a' } });
  await saveProvider(ws, rec, [a]);
  await saveRoles(ws, { main: { models: [a.id, 'm-gone'], level: 'high', firstOutputSeconds: 20 }, utility: { models: [], level: 'low' }, 'speech-in': { models: ['browser-voice', 'dictation'], level: 'off' } });
  const { roles } = await readConfig(ws);
  assert.deepEqual(Object.keys(roles).sort(), [...CHAT_ROLES, ...KOE_ROLES, ...SPEECH_ROLES].sort());
  assert.deepEqual(roles.main, { models: [a.id], level: 'high', firstOutputSeconds: 20 });
  assert.deepEqual(roles.decide, { models: [], level: 'off' });
  assert.deepEqual(roles['speech-in'].models, ['dictation'], "the browser voice isn't speech-in's");
  assert.deepEqual(roles['speech-out'].models, ['browser-voice'], 'a list never saved holds the defaults');
  await assert.rejects(saveRoles(ws, { main: { models: [], level: 'extreme' } }), ValidationError);
});

test('speechKind comes from the ability: in for transcription, out for voice, null when the ability is off or its type is not running', async () => {
  const { ws } = await setup();
  const rec = newProvider('provider-local-speech', { template: { version: '1.0.0', values: LOCAL_SPEECH_VALUES } });
  const ears = newModel(rec.id, 'transcription', { user: { providerId: 'whisper' } });
  const voice = newModel(rec.id, 'voice', { user: { providerId: 'kokoro' } });
  await saveProvider(ws, rec, [ears, voice]);
  const types = new Map([['openai-transcription', { speech: 'in' }], ['openai-speech', { speech: 'out' }]]);
  let cfg = await readConfig(ws);
  assert.equal(speechKind(cfg, types, ears.id), 'in');
  assert.equal(speechKind(cfg, types, voice.id), 'out');
  assert.equal(speechKind(cfg, new Map([['openai-transcription', { speech: 'in' }]]), voice.id), null, 'its type is not running');
  await saveProvider(ws, { ...rec, user: { abilities: { voice: { on: false } } } });
  cfg = await readConfig(ws);
  assert.equal(speechKind(cfg, types, voice.id), null, 'its ability is off');
  assert.equal(speechKind(cfg, types, 'm-gone'), null);
});

test('a provider with keyHeader sends its key in that header and gives the protocol no key; without it the protocol gets the key', () => {
  const EP = endpointOf(router(), 'chat');
  assert.deepEqual(sendKey(EP, 'k1', 'api-key'), { endpoint: { ...EP, headers: { ...EP.headers, 'api-key': 'k1' } }, key: null });
  assert.deepEqual(sendKey(EP, 'k1'), { endpoint: EP, key: 'k1' });
  assert.deepEqual(sendKey(EP, null, 'api-key'), { endpoint: EP, key: null });
  const azure = newProvider('provider-azure', { template: { version: '1.0.0', values: { ...ROUTER_VALUES, keyHeader: 'api-key' } } });
  assert.equal(providerOf(azure).keyHeader, 'api-key');
});

test("a newer description changes what the user left alone, never what they changed", () => {
  const rec = newModel('pv-1', 'chat', { template: { id: 'p/chat/x', version: '1.0.0', values: { providerId: 'x', contextWindow: 1000, maxOutput: 100 } }, user: { maxOutput: 50 } });
  const updated = { ...rec, template: { id: 'p/chat/x', version: '1.1.0', values: { providerId: 'x', contextWindow: 2000, maxOutput: 200 } } };
  assert.equal(modelOf(updated).contextWindow, 2000);
  assert.equal(modelOf(updated).maxOutput, 50);
  assert.equal(modelOf(updated).name, 'x', 'a model is named by its provider id until the user names it');
  assert.deepEqual([modelOf(updated).provider, modelOf(updated).ability], ['pv-1', 'chat']);
  assert.equal(modelBase(updated).maxOutput, 200);
});

test('diffLayer keeps only what the user changed; it covers only the fields a screen edits', () => {
  const base = { name: 'OpenRouter', baseUrl: 'https://x', headers: {}, tunables: { a: 1 }, extraBody: {} };
  assert.deepEqual(diffLayer({ ...base }, base), {});
  assert.deepEqual(diffLayer({ ...base, name: 'Mine', tunables: { a: 2 } }, base), { name: 'Mine', tunables: { a: 2 } });
  const m = { name: 'Haiku', providerTools: [{ id: 'p', name: 'S', kind: 'search', patch: {} }], logprobs: false };
  assert.deepEqual(diffLayer({ name: 'Mine' }, m), { name: 'Mine' });
});

test("deleting a reasoning level that came from a description sticks", () => {
  const m = newModel('pv-1', 'chat', { template: { id: 'p/chat/opus', version: '1.0.0', values: { providerId: 'opus', reasoning: { low: { effort: 'low' }, max: { effort: 'max' } } } } });
  const mBase = modelBase(m);
  assert.deepEqual(modelOf({ ...m, user: diffLayer({ ...mBase, reasoning: { low: { effort: 'low' } } }, mBase) }).reasoning, { low: { effort: 'low' } });
});

// The user, 2026-11-16: "I have official a\\ api and openrouter, they both have opus 5.5 and stuff, hard to distinguish which one if from
// openrouter and which one if from official api". Every screen names a model by its provider's name, then its own.
test("a model is named by its provider's name first, from the one rule every screen takes: Anthropic's Opus and OpenRouter's are told apart", async () => {
  const ctx = await setup();
  await addProvider(ctx, await official('provider-anthropic'), { key: 'sk-a' });
  await addProvider(ctx, await official('provider-openrouter'), { key: 'sk-r' });
  // OpenRouter a second time, under the user's own name: its models have the same names, made unique by "(2)" (providers.js named).
  await addProvider(ctx, await official('provider-openrouter'), { key: 'sk-w', name: 'OpenRouter (work)' });
  const cfg = await readConfig(ctx.ws);
  const names = modelNames(cfg);
  assert.equal(names('Claude Opus 5.5'), 'Anthropic / Claude Opus 5.5');
  assert.equal(names('Anthropic: Claude Opus 5.5'), 'OpenRouter / Anthropic: Claude Opus 5.5');
  assert.equal(names('Anthropic: Claude Opus 5.5 (2)'), 'OpenRouter (work) / Anthropic: Claude Opus 5.5 (2)');
  // Every model has one, and no two are named alike.
  const shown = Object.values(cfg.models).map((m) => names(modelOf(m).name));
  assert.ok(shown.every((n) => / \/ /.test(n)), shown.join());
  assert.equal(new Set(shown).size, shown.length);
});

test("a model is named by its provider's name as the user renamed it; a name no model has now, or none, is shown as it is", async () => {
  const ctx = await setup();
  const p = router();
  const m = newModel(p.id, 'chat', { user: { providerId: 'anthropic/claude-opus-5.5', name: 'Opus' } });
  await saveProvider(ctx.ws, p, [m]);
  assert.equal(modelNames(await readConfig(ctx.ws))('Opus'), 'OpenRouter / Opus');
  await saveProvider(ctx.ws, { ...p, user: { name: 'My router' } });
  assert.equal(modelNames(await readConfig(ctx.ws))('Opus'), 'My router / Opus', "the provider's name as Models' list of providers shows it");
  // A line written by a model removed since, a stand-in's name, and a screen with no configuration read keep the name they have.
  await removeModel(ctx.ws, m.id);
  const now = modelNames(await readConfig(ctx.ws));
  assert.equal(now('Opus'), 'Opus');
  assert.equal(now('Phone dictation'), 'Phone dictation');
  assert.equal(modelNames(null)('Opus'), 'Opus');
  assert.equal(withProvider('', 'Opus'), 'Opus');
});

test("a name two providers' models both have names no provider, never the wrong one: a catalog update can rename a model to another's name (the final review's finding src1-D)", async () => {
  const ctx = await setup();
  const [a, b] = [router(), router()];
  await saveProvider(ctx.ws, { ...a, user: { name: 'Provider A' } }, [newModel(a.id, 'chat', { user: { providerId: 'x/one', name: 'Shared' } }), newModel(a.id, 'chat', { user: { providerId: 'x/two', name: 'Only A' } })]);
  await saveProvider(ctx.ws, { ...b, user: { name: 'Provider B' } }, [newModel(b.id, 'chat', { user: { providerId: 'y/one', name: 'Shared' } })]);
  const names = modelNames(await readConfig(ctx.ws));
  assert.equal(names('Shared'), 'Shared', 'either provider could be meant');
  assert.equal(names('Only A'), 'Provider A / Only A', 'a name only one has keeps its provider');
});

test("the provider's name comes first in each language's own row for the pair, the slash that binds tighter than a label's dots", async (t) => {
  t.after(() => setWords('en', null));
  assert.equal(withProvider('OpenRouter', 'Claude Opus 5.5'), 'OpenRouter / Claude Opus 5.5');
  for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) {
    const words = JSON.parse(await readFile(new URL(`../../l10n/${tag}.json`, import.meta.url), 'utf8'));
    // The row is the language's own: the one with the context "a model, after its provider" (a message's key is its context and its English).
    const row = words[key('{0} / {1}', 'a model, after its provider')];
    assert.equal(typeof row, 'string', `${tag} has the row`);
    setWords(tag, words);
    assert.equal(withProvider('OpenRouter', 'Claude Opus 5.5'), row.replace('{0}', 'OpenRouter').replace('{1}', 'Claude Opus 5.5'), tag);
    assert.match(withProvider('OpenRouter', 'Claude Opus 5.5'), /^OpenRouter ?\/ ?Claude Opus 5\.5$/, `${tag}: the pair is one name with a slash, never the label's dot`);
  }
});
