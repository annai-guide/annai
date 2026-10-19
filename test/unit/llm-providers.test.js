import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS } from '../../src/core/scopes.js';
import { readConfig, modelOf, providerOf, getKey, saveProvider, saveModel, saveRoles, removeModel, removeProviderRecords, diffLayer, providerBase } from '../../src/core/llm/config.js';
import { addProvider, syncProviders, useSuggestion, addListedModel, addModelById, withSpeech, speechAdd, speechBehind } from '../../src/core/llm/providers.js';
import { ttlFor } from '../../src/core/agent/warmth.js';
import { OPENAI_SRC, ROUTER_SRC, ANTHROPIC_SRC, ANOTHER_SRC, PROTO, PROVIDER, site } from './provider-kit.js';
import { hostKit } from './package-kit.js';
import { createLlm } from '../../src/core/llm/service.js';

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
  assert.deepEqual(cfg.providers[id].template?.added, ['transcription'], 'its page says it is new');
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

/** A data-only provider plugin with models: chat through type-a (on), chat through type-b (off), a voice through type-v. @param {string} [version] @param {any} [more] */
const PX = (version = '1.0.0', more = {}) => ({
  'annai-plugin.json': JSON.stringify({
    id: 'provider-x', name: 'X', version, api: 1, requires: [{ id: 'proto-a', version: '^0' }, { id: 'proto-v', version: '^0' }],
    provider: {
      baseUrl: 'https://x.example/v1', key: 'required',
      abilities: {
        chat: { kind: 'chat', type: 'type-a', models: [{ providerId: 'x-1', name: 'X one' }] },
        extra: { kind: 'chat', type: 'type-b', on: false, models: [{ providerId: 'x-2', name: 'X two' }] },
        voice: { kind: 'voice', type: 'type-v', baseUrl: 'https://voice.x.example/v1', models: [{ providerId: 'v-1', name: 'X voice' }] },
        ...more,
      },
      roles: { recommended: { main: ['x-1'], 'speech-out': ['v-1'] } },
    },
  }),
});
/** Another provider plugin: chat through type-c. */
const PY = {
  'annai-plugin.json': JSON.stringify({ id: 'provider-y', name: 'Y', version: '1.0.0', api: 1, requires: [{ id: 'proto-c', version: '^0' }],
    provider: { baseUrl: 'https://y.example/v1', key: 'optional', abilities: { chat: { kind: 'chat', type: 'type-c', models: [{ providerId: 'y-1', name: 'Y one' }] } } } }),
};
const PLUGINS = () => ({
  'proto-a': PROTO('proto-a', 'type-a', '0.3.0', { list: true }), 'proto-b': PROTO('proto-b', 'type-b', '0.2.0'), 'proto-c': PROTO('proto-c', 'type-c', '0.1.0'),
  'proto-v': PROTO('proto-v', 'type-v', '0.1.0', { speech: 'out' }), 'provider-x': PX(), 'provider-y': PY,
});
/** The model service on a host with a stand-in catalog. @param {{ probe?: (url: string) => Promise<boolean>, fetch?: any }} [o] */
async function serviceKit(o = {}) {
  const k = await hostKit();
  const s = await site(PLUGINS());
  /** @type {string[]} */
  const reached = [];
  const get = async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).startsWith('https://')) {
      reached.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
      if (o.fetch) return o.fetch(url, init);
      return new Response(JSON.stringify({ data: [{ id: 'listed-1' }] }));
    }
    return s.fetch(url);
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: get, probe: o.probe });
  return { ...k, s, llm, reached };
}
const HI = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] });

test('the service adds a provider from a catalog plugin with what it requires, and a role call goes through its ability', async () => {
  const k = await serviceKit();
  const id = await k.llm.addProvider('provider-x', { key: 'sk-x-1234567890' });
  assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['proto-a', 'proto-v', 'provider-x'], 'proto-b: its ability starts off, and nothing requires it');
  assert.deepEqual(k.llm.providers().map((p) => [p.plugin, p.name, p.version]), [['provider-x', 'X', '1.0.0']]);
  const r = await k.llm.call({ request: HI });
  assert.equal(r.reply.text, 'hi from chat');
  assert.equal(r.answeredBy, 'X one');
  const [req] = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
  assert.equal(req.data.endpoint, 'X', "the trace's endpoint is the provider's name");
  assert.equal(await k.llm.keyFor(id), 'sk-x-1234567890');
  const voice = /** @type {any} */ (Object.values((await k.llm.config()).models).find((m) => m.ability === 'voice'));
  const clip = await k.llm.synthesize({ modelId: voice.id, text: 'Hello.' });
  assert.equal(clip.clip?.mediaType, 'audio/mpeg');
  assert.ok(k.reached.some((x) => x.startsWith('https://voice.x.example/v1/audio/speech')), "the voice goes to its ability's own address");
});

test('a call never installs a protocol plugin: a model whose type is missing is skipped as type-missing, and the next one answers (anti-goal 1)', async () => {
  const k = await serviceKit();
  await k.llm.addProvider('provider-x', { key: 'sk-x' });
  await k.llm.addProvider('provider-y', {});
  const cfg = await k.llm.config();
  await saveRoles(k.ws, { ...cfg.roles, main: { models: Object.values(cfg.models).filter((m) => m.ability === 'chat').map((m) => m.id), level: 'off' } });
  await k.host.uninstall('proto-a');
  k.s.asked.length = 0;
  const r = await k.llm.call({ request: HI });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['type-missing', 'ok']);
  assert.equal(r.reply.text, 'hi from chat');
  assert.equal(k.s.asked.filter((p) => p.startsWith('/plugins-official/') || p === '/catalog/plugins.json').length, 0);
  // A voice whose type is missing isn't installed by speaking either.
  await k.host.uninstall('proto-v');
  const voice = /** @type {any} */ (Object.values(cfg.models).find((m) => m.ability === 'voice'));
  await assert.rejects(k.llm.synthesize({ modelId: voice.id, text: 'Hello.' }), (/** @type {any} */ e) => e.kind === 'type-missing' && /Settings → Models/.test(e.message));
  assert.equal(k.s.asked.length, 0);
  // Setting up may install: Test fetches what the model needs, and its code (the same bytes) runs again at once.
  await k.llm.test(Object.values(cfg.models).find((m) => modelOf(m).providerId === 'x-1')?.id ?? '');
  assert.ok(k.s.asked.includes('/plugins-official/proto-a/index.js'));
  assert.ok(k.host.active.has('proto-a'));
});

test('removing the last provider of a plugin removes the plugin and the protocol plugins nothing else needs; removing one of two keeps both', async () => {
  const k = await serviceKit();
  const a = await k.llm.addProvider('provider-x', { key: 'sk-a' });
  const b = await k.llm.addProvider('provider-x', { key: 'sk-b', name: 'X (home)' });
  await k.llm.addProvider('provider-y', {});
  assert.deepEqual(await k.llm.removalOf(a), { plugin: null, protocols: [] }, 'what Remove would take, said before it is tapped');
  assert.deepEqual(await k.llm.removeProvider(a), { plugin: null, protocols: [] });
  assert.deepEqual(await k.llm.removalOf(b), { plugin: 'provider-x', protocols: ['proto-a', 'proto-v'] });
  assert.ok((await k.host.installed())['provider-x']);
  assert.equal(await k.llm.keyFor(a), null);
  assert.equal(await k.llm.keyFor(b), 'sk-b');
  assert.deepEqual(await k.llm.removeProvider(b), { plugin: 'provider-x', protocols: ['proto-a', 'proto-v'] });
  assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['proto-c', 'provider-y']);
  assert.deepEqual(Object.keys((await k.llm.config()).providers).length, 1);
});

test('turning an ability on installs its official protocol plugin; offline it says so and stays off', async () => {
  const k = await serviceKit();
  const id = await k.llm.addProvider('provider-x', { key: 'sk-x' });
  k.s.offline = true;
  await assert.rejects(k.llm.setAbility(id, 'extra', true), /couldn't be loaded.*connection/);
  assert.equal(providerOf((await k.llm.config()).providers[id]).abilities.extra.on, false);
  k.s.offline = false;
  await k.llm.setAbility(id, 'extra', true);
  assert.ok((await k.host.installed())['proto-b']);
  assert.equal(providerOf((await k.llm.config()).providers[id]).abilities.extra.on, true);
  await k.llm.setAbility(id, 'extra', false);
  assert.deepEqual((await k.llm.config()).providers[id].user.abilities?.extra ?? {}, {}, 'back as the description has it: no layer of its own');
  // Security review: a protocol the user switched off isn't switched on by turning an ability on.
  await k.llm.setAbility(id, 'extra', true);
  await k.host.setEnabled('proto-b', false);
  await k.llm.setAbility(id, 'extra', false);
  await assert.rejects(k.llm.setAbility(id, 'extra', true), /you turned off/);
  assert.equal((await k.host.installed())['proto-b'].enabled, false);
});

test('a started data-only provider plugin registers its description, and a newer version refreshes the providers made from it', async () => {
  const k = await serviceKit();
  const id = await k.llm.addProvider('provider-x', { key: 'sk-x' });
  await k.host.install(new Map(Object.entries(PX('1.1.0', { ears: { kind: 'transcription', type: 'type-v', models: [{ providerId: 'e-1', name: 'X ears' }] } })).map(([n, t]) => [n, new TextEncoder().encode(t)])), { source: 'official' });
  await k.host.start('provider-x');
  assert.equal(k.llm.providers()[0].version, '1.1.0');
  assert.equal(await k.llm.syncProviders(), 1);
  const cfg = await k.llm.config();
  assert.equal(providerOf(cfg.providers[id]).abilities.ears.on, false, 'new in the update: off');
  assert.ok(Object.values(cfg.models).some((m) => modelOf(m).name === 'X ears'));
});

test("listing an ability's models: by its address, with the provider's key; an address that doesn't allow web apps says so by its host, not the browser's \"Load failed\"", async () => {
  let answers = true;
  const k = await serviceKit({ probe: async () => answers, fetch: async (/** @type {string} */ url) => { if (url.startsWith('https://blocked.example/')) throw new TypeError('Load failed'); return new Response(JSON.stringify({ data: [{ id: 'listed-1' }] })); } });
  const id = await k.llm.addProvider('provider-x', { key: 'sk-x-1' });
  assert.deepEqual((await k.llm.listModels(id, 'chat')).map((m) => m.providerId), ['listed-1']);
  assert.match(k.reached.at(-1) ?? '', /^https:\/\/x\.example\/v1\/models .*Bearer sk-x-1/);
  const rec = (await k.llm.config()).providers[id];
  await saveProvider(k.ws, { ...rec, user: { baseUrl: 'https://blocked.example/step_plan/v1' } });
  await assert.rejects(k.llm.listModels(id, 'chat'), (/** @type {any} */ e) => e.kind === 'blocked' && /blocked\.example/.test(e.message) && /web apps/.test(e.message) && !/Load failed/.test(e.message));
  answers = false;
  await assert.rejects(k.llm.listModels(id, 'chat'), (/** @type {any} */ e) => e.kind === 'unreachable' && /blocked\.example/.test(e.message) && /couldn't reach/.test(e.message));
  // A provider whose key goes in a header of its own (decision 25).
  await saveProvider(k.ws, { ...rec, template: { ...rec.template, values: { ...rec.template?.values, keyHeader: 'api-key' } } });
  await k.llm.listModels(id, 'chat');
  assert.match(k.reached.at(-1) ?? '', /"api-key":"sk-x-1"/);
  assert.doesNotMatch(k.reached.at(-1) ?? '', /Bearer/);
  // A list path that steers the joined address to another host is refused, and nothing is sent (fix pass, Critical).
  const before = k.reached.length;
  await saveProvider(k.ws, { ...rec, user: { baseUrl: 'https://x.example', abilities: { chat: { tunables: { listPath: '.attacker.example/models' } } } } });
  await assert.rejects(k.llm.listModels(id, 'chat'), (/** @type {any} */ e) => e.kind === 'bad-request' && /built a request to https:\/\/x\.example\.attacker\.example/.test(e.message));
  assert.equal(k.reached.length, before);
});

test("security review: an installed copy of an official provider's id that came from elsewhere is never used as annai's own; one from annai whose files no longer match the catalog is fetched again", async () => {
  const k = await serviceKit();
  // As if it slipped in (a restored backup, an older annai): a provider-x from a file.
  await k.host.install(new Map(Object.entries(PX('9.0.0')).map(([n, t]) => [n, new TextEncoder().encode(t)])), { source: 'file' });
  await k.host.start('provider-x');
  await assert.rejects(k.llm.installProvider('provider-x', { official: true }), /annai's own plugin uses this name, but the one installed came from elsewhere/);
  await assert.rejects(k.llm.addProvider('provider-x', { key: 'sk-x-secret', official: true }), /came from elsewhere/);
  assert.deepEqual(Object.keys((await k.llm.config()).providers), []);
  assert.deepEqual(await k.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [], 'no key was kept for it');
  // annai's own, its files changed in storage: fetched again from the catalog before it is used.
  const { host, llm, ws, s } = await serviceKit();
  await llm.installProvider('provider-x', { official: true });
  await ws.write('sys:plugins', '/provider-x/annai-plugin.json', JSON.parse(PX()['annai-plugin.json']), { author: 'system' });
  assert.equal(await host.verifyOfficial('provider-x', /** @type {any} */ (s.entries.find((e) => e.id === 'provider-x'))), false);
  await llm.installProvider('provider-x', { official: true });
  assert.equal(await host.verifyOfficial('provider-x', /** @type {any} */ (s.entries.find((e) => e.id === 'provider-x'))), true);
});

test('fix pass (Important): remove the last provider (its protocol is pruned), then add another needing the same protocol, in one session: it works, with no restart', async () => {
  const k = await hostKit();
  const s = await site({
    'proto-a': PROTO('proto-a', 'type-a', '0.3.0'),
    'provider-x': PROVIDER('provider-x', [{ id: 'proto-a', version: '^0' }], ['type-a']),
    'provider-y': PROVIDER('provider-y', [{ id: 'proto-a', version: '^0' }], ['type-a']),
  });
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: (/** @type {any} */ u) => s.fetch(u) });
  const x = await llm.addProvider('provider-x', { key: 'k1' });
  assert.ok(k.host.active.has('proto-a'));
  assert.deepEqual(await llm.removeProvider(x), { plugin: 'provider-x', protocols: ['proto-a'] });
  assert.equal(k.host.needsRestart('proto-a'), false, 'the same bytes are cached: starting them again is right');
  const y = await llm.addProvider('provider-y', { key: 'k2' });
  assert.ok(k.host.active.has('proto-a') && k.host.active.has('provider-y'));
  assert.deepEqual(Object.keys((await llm.config()).providers), [y]);
  await llm.ensureType('type-a');
});

test("fix pass: a failed add leaves no provider plugin installed without a provider, nor what it alone brought", async () => {
  const k = await hostKit();
  const s = await site({
    'proto-a': PROTO('proto-a', 'type-a', '0.3.0'),
    // Its second ability starts on, but its type is one annai has no plugin for.
    'provider-z': PROVIDER('provider-z', [{ id: 'proto-a', version: '^0' }], ['type-a', 'type-nowhere']),
  });
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: (/** @type {any} */ u) => s.fetch(u) });
  await assert.rejects(llm.addProvider('provider-z', { key: 'k' }), /type-nowhere/);
  assert.deepEqual(Object.keys(await k.host.installed()), []);
  assert.deepEqual(Object.keys((await llm.config()).providers), []);
  assert.deepEqual(await k.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), []);
});

test('fix pass: a speech call to a provider whose key goes in a header of its own keeps the key out of the trace, even in an error that echoes it', async () => {
  const KEY = 'sk-test-access-code-9876543210';
  const k = await serviceKit({ fetch: async (/** @type {any} */ url, /** @type {any} */ init) => new Response(`refused X-Access-Code=${init.headers['X-Access-Code']}`, { status: 403 }) });
  const id = await k.llm.addProvider('provider-x', { key: KEY });
  const rec = (await k.llm.config()).providers[id];
  await saveProvider(k.ws, { ...rec, user: { keyHeader: 'X-Access-Code' } });
  const voice = /** @type {any} */ (Object.values((await k.llm.config()).models).find((m) => m.ability === 'voice'));
  await assert.rejects(k.llm.synthesize({ modelId: voice.id, text: 'Hello.' }), (/** @type {any} */ e) => e.kind === 'auth');
  assert.ok(k.reached.some((r) => r.includes(KEY)), 'the key went in its header');
  const events = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS));
  assert.ok(events.some((e) => e.type === 'net.request'));
  assert.ok(!JSON.stringify(events).includes(KEY), 'no trace entry holds it');
});
