import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig, modelOf, saveRoles, saveModel } from '../../src/core/llm/config.js';
import { addListedModel } from '../../src/core/llm/providers.js';
import { createLlm } from '../../src/core/llm/service.js';
import { startFakeServer } from '../fakes/model-server.js';
import { browserFetch } from '../fakes/browser-fetch.js';
import { hostKit } from './package-kit.js';
import { official } from './provider-kit.js';

// The servers people run themselves (milestone 2): llama.cpp, vLLM, SGLang, Ollama and LM Studio, each a
// data-only provider plugin whose quirks are data. Calls go to stand-ins that answer as each server does,
// through a fetch that keeps a browser's CORS rules for a page at annai's address.

const root = new URL('../../', import.meta.url);
const ANNAI = 'https://annai.guide';
const LOCAL = ['provider-llamacpp', 'provider-vllm', 'provider-sglang', 'provider-ollama', 'provider-lmstudio'];
const HI = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] });

/** The model service, with annai's catalog and official plugins from this repository, and the stand-in reached as a browser would. */
async function kit() {
  const k = await hostKit();
  const asBrowser = browserFetch(ANNAI);
  const get = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.hostname === '127.0.0.1') return asBrowser(String(url), init);
    try {
      return new Response(await readFile(new URL(`.${u.pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  // The check a browser makes without its access rules (no-cors): the server is there, whatever its CORS says.
  const probe = (/** @type {string} */ url) => fetch(url).then(() => true, () => false);
  return { ...k, llm: createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: get, probe }) };
}

/**
 * A local server's provider at a stand-in's address, its first listed model added and put in main.
 * @param {Awaited<ReturnType<typeof kit>>} k @param {string} plugin @param {string} origin @param {{ key?: string, model?: string }} [o]
 */
async function setUp(k, plugin, origin, { key, model } = {}) {
  const id = await k.llm.addProvider(plugin, { official: true, baseUrl: `${origin}/v1`, roles: null, ...(key ? { key } : {}) });
  const all = await k.llm.listModels(id, 'chat');
  const listed = model ? all.find((m) => m.providerId === model) : all[0];
  const modelId = await addListedModel(k, id, 'chat', listed);
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, main: { models: [modelId], level: 'medium' } });
  return { id, modelId, model: modelOf((await readConfig(k.ws)).models[modelId]) };
}

/** The chat requests a stand-in was sent. @param {{ requests: any[] }} s */
const lastChats = (s) => s.requests.filter((r) => r.method === 'POST' && r.path === '/v1/chat/completions');
/** The last chat request a stand-in was sent. @param {{ requests: any[] }} s */
const lastChat = (s) => s.requests.filter((r) => r.method === 'POST' && r.path === '/v1/chat/completions').at(-1)?.body;
/** Some fields of an object. @param {any} o @param {string[]} keys */
const pick = (o, keys) => Object.fromEntries(keys.filter((x) => x in o).map((x) => [x, o[x]]));

test('llama.cpp: keywords Unsloth, LM Studio and KoboldCpp; its default address on port 9931; a listed model that reads images takes photos, and the context it is served is read from /props', async () => {
  const m = JSON.parse(await readFile(new URL('plugins-official/provider-llamacpp/annai-plugin.json', root), 'utf8'));
  assert.deepEqual([m.name, m.category, m.keywords, m.entry], ['llama.cpp', 'providers', ['Unsloth', 'LM Studio', 'KoboldCpp'], 'index.js']);
  assert.deepEqual([m.provider.baseUrl, m.provider.key, m.provider.local], ['http://localhost:9931/v1', 'optional', true]);
  assert.deepEqual(m.requires, [{ id: 'chat-completions', version: '^0' }]);
  const k = await kit();
  const s = await startFakeServer({ flavour: 'llamacpp', key: 'sk-unsloth-stand-in' });
  try {
    const { model } = await setUp(k, 'provider-llamacpp', s.origin, { key: 'sk-unsloth-stand-in' });
    assert.deepEqual([model.providerId, model.input], ['qwen3.8-flash', ['text', 'image']]);
    assert.equal(model.contextWindow, 32768, "its list gives the training context; /props, the one each conversation is served (decision 22)");
    assert.equal(s.requests.find((r) => r.method === 'GET' && r.path === '/v1/models')?.headers.authorization, 'Bearer sk-unsloth-stand-in');
    assert.equal(s.requests.find((r) => r.method === 'GET' && r.path === '/props')?.headers.authorization, 'Bearer sk-unsloth-stand-in', 'the key goes to its own address only');
    assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['chat-completions', 'provider-llamacpp']);
  } finally {
    await s.stop();
  }
});

/** Each local server's thinking switch, at level off and at medium (the plan's Local servers table). */
const CASES = /** @type {[string, import('../fakes/model-server.js').Flavour, Record<string, any>, Record<string, any>][]} */ ([
  ['provider-llamacpp', 'llamacpp', { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } }, { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } }],
  // vLLM and SGLang: reasoning_effort too, for models switched by effort (gpt-oss); explicit chat_template_kwargs win on both (fix pass 3).
  ['provider-vllm', 'vllm', { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false, thinking: false } }, { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true, thinking: true } }],
  ['provider-sglang', 'sglang', { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false, thinking: false } }, { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true, thinking: true } }],
  // Ollama: a model whose capabilities list thinking (qwen3, listed first) gets the named levels from its list (decision 22);
  // one that can't think keeps only off named, as it refuses a named level (fix pass 1).
  ['provider-ollama', 'ollama', { reasoning_effort: 'none' }, { reasoning_effort: 'medium' }],
  ['provider-lmstudio', 'lmstudio', {}, {}],
]);

test("each local server's off level sends its own thinking switch: llama.cpp reasoning_effort none and enable_thinking false; vLLM and SGLang reasoning_effort and chat_template_kwargs; Ollama reasoning_effort none; LM Studio nothing", async () => {
  for (const [plugin, flavour, off, medium] of CASES) {
    const k = await kit();
    const s = await startFakeServer({ flavour, cors: '*' });
    try {
      await setUp(k, plugin, s.origin);
      const fields = ['reasoning_effort', 'chat_template_kwargs', 'reasoning'];
      await k.llm.call({ request: HI, level: 'off' });
      assert.deepEqual(pick(lastChat(s), fields), off, `${plugin} off`);
      await k.llm.call({ request: HI });
      assert.deepEqual(pick(lastChat(s), fields), medium, `${plugin} medium`);
      // The quick decision asks at level off, and so does the main model it falls back to: no thinking, so it stays quick.
      const before = s.requests.length;
      await k.llm.decide({ prompt: 'Is it raining?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] });
      const decided = s.requests.slice(before).filter((r) => r.method === 'POST').map((r) => r.body);
      assert.deepEqual(decided.map((b) => [Boolean(b.tool_choice), pick(b, fields)]), [[true, off], [false, off]], `${plugin} decide`);
      assert.equal(lastChat(s).stream, true);
      assert.deepEqual(lastChat(s).stream_options, { include_usage: true });
    } finally {
      await s.stop();
    }
  }
});

test("a streamed reply's reasoning shows as reasoning_delta and ends as one reasoning block, through each local plugin; llama.cpp's stream also carries a tool call and usage", async () => {
  for (const [plugin, flavour] of CASES) {
    const k = await kit();
    const s = await startFakeServer({
      flavour, cors: '*',
      replies: [{ reasoning: 'The user said hi. Greet them back.', text: 'Hello! Where to today?', ...(flavour === 'llamacpp' ? { calls: [{ name: 'weather', input: { place: 'Big Sur' } }], usage: { input: 300, output: 64, cached: 42 } } : {}) }],
    });
    try {
      await setUp(k, plugin, s.origin);
      /** @type {any[]} */
      const events = [];
      const tools = [{ name: 'weather', description: 'The weather at a place.', input: { type: 'object', properties: { place: { type: 'string' } } } }];
      const r = await k.llm.call({ request: { ...HI, tools }, onEvent: (e) => events.push(e) });
      const deltas = events.filter((e) => e.type === 'reasoning_delta');
      assert.ok(deltas.length > 1, `${plugin}: reasoning streams in pieces`);
      assert.equal(deltas.map((e) => e.text).join(''), 'The user said hi. Greet them back.', plugin);
      assert.deepEqual(r.reply.parts.filter((p) => p.type === 'reasoning').map((p) => /** @type {any} */ (p).text), ['The user said hi. Greet them back.'], plugin);
      assert.equal(r.reply.text, 'Hello! Where to today?', plugin);
      if (flavour !== 'llamacpp') continue;
      assert.deepEqual(r.reply.parts.filter((p) => p.type === 'tool_call').map((p) => [/** @type {any} */ (p).name, /** @type {any} */ (p).input]), [['weather', { place: 'Big Sur' }]]);
      assert.deepEqual([r.usage.input, r.usage.cacheRead, r.usage.output], [258, 42, 64]);
    } finally {
      await s.stop();
    }
  }
});

test("Ollama's and LM Studio's notes say how to let annai's address in; vLLM's and SGLang's say which flags tool calls need; each says a phone needs HTTPS in front", async () => {
  const note = async (/** @type {string} */ id) => {
    const d = (await official(id)).provider;
    return [d.note, ...Object.values(d.abilities).map((a) => a.note)].filter(Boolean).join(' ');
  };
  assert.match(await note('provider-ollama'), /OLLAMA_ORIGINS=https:\/\/annai\.guide/);
  assert.match(await note('provider-ollama'), /OLLAMA_CONTEXT_LENGTH/);
  assert.match(await note('provider-lmstudio'), /Enable CORS/);
  assert.match(await note('provider-vllm'), /--enable-auto-tool-choice --tool-call-parser/);
  assert.match(await note('provider-vllm'), /--reasoning-parser/);
  assert.match(await note('provider-sglang'), /--tool-call-parser/);
  assert.match(await note('provider-llamacpp'), /Unsloth Studio/);
  assert.match(await note('provider-llamacpp'), /--cors-origins/);
  for (const id of LOCAL) {
    const m = JSON.parse(await readFile(new URL(`plugins-official/${id}/annai-plugin.json`, root), 'utf8'));
    assert.equal(m.provider.local, true, id);
    assert.match(await note(id), /HTTPS/, id);
  }
  // What Ollama's CORS does to annai's page unless told, as Test and Fetch model list would meet it.
  const k = await kit();
  const s = await startFakeServer({ flavour: 'ollama' });
  try {
    const id = await k.llm.addProvider('provider-ollama', { official: true, baseUrl: `${s.origin}/v1`, roles: null });
    await assert.rejects(k.llm.listModels(id, 'chat'), (/** @type {any} */ e) => e.kind === 'blocked' && /doesn't allow web apps/.test(e.message));
  } finally {
    await s.stop();
  }
});

test("vLLM's transcription starts off, and brings its protocol when turned on; Another address says what to do for a server that never streams", async () => {
  const v = (await official('provider-vllm')).provider.abilities;
  assert.deepEqual([v.chat.on, v.transcription.on, v.transcription.kind, v.transcription.type], [undefined, false, 'transcription', 'openai-transcription']);
  const another = JSON.parse(await readFile(new URL('plugins-official/provider-another-address/annai-plugin.json', root), 'utf8'));
  assert.equal(another.version, '1.2.0', 'its note came in 1.1.0; catchAll, which lists it last, in 1.2.0');
  assert.equal(another.catchAll, true);
  assert.match(another.provider.note, /Wait for the first words/);
  assert.match(another.provider.note, /never streams/);
});

test("the user's llama.cpp server (Unsloth Studio), as recorded on 2026-10-19, reads as its stand-in does: reasoning_content beside an empty content, a tool call in pieces, usage with cached tokens, and its own model list", async () => {
  const { activate } = await import('../../plugins-official/chat-completions/index.js');
  const { sse } = await import('../../src/core/llm/sse.js');
  const { ProviderError, errorFromResponse } = await import('../../src/core/llm/contract.js');
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, ProviderError, errorFromResponse } });
  const recorded = (/** @type {string} */ name) => readFile(new URL(`test/fixtures/llm/local/${name}`, root));
  const read = async (/** @type {string} */ name) => {
    const out = [];
    for await (const e of type.read(new Response(await recorded(name), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }), { tunables: { ...type.tunables } })) out.push(e);
    return out;
  };
  const plain = await read('unsloth-studio-reasoning.sse');
  assert.ok(plain.filter((e) => e.type === 'reasoning_delta').length > 30);
  assert.deepEqual(plain.filter((e) => e.type !== 'reasoning_delta').map((e) => e.type), ['reasoning', 'text', 'text', 'usage', 'stop']);
  assert.equal(plain.filter((e) => e.type === 'text').map((e) => e.text).join(''), '42');
  assert.deepEqual(plain.find((e) => e.type === 'usage').usage, { input: 22, cacheRead: 42, cacheWrite: 0, output: 41, reasoning: 0 });
  const tool = await read('unsloth-studio-tool.sse');
  assert.deepEqual(tool.filter((e) => e.type === 'tool_call').map((e) => [e.name, e.input]), [['weather', { place: 'Big Sur' }]]);
  assert.equal(tool.at(-1).reason, 'tool');
  // Studio lists its models in a shape of its own: context_length for a loaded model, and nothing on photos.
  assert.deepEqual(type.readList(JSON.parse(String(await recorded('unsloth-studio-models.json')))), [
    { providerId: 'unsloth/Qwen3.8-Flash-Next-GGUF', contextWindow: 262144 },
    { providerId: 'unsloth/Qwen3.8-27B-GGUF' },
  ]);
});

test("Ollama: a model that can't think answers at every level, as only off is named for it (fix pass 1); one that thinks gets the named levels from its list (decision 22)", async () => {
  const levels = (await official('provider-ollama')).provider.abilities.chat.modelDefaults?.reasoning;
  assert.deepEqual(levels, { off: { reasoning_effort: 'none' }, low: {}, medium: {}, high: {} }, 'no max: it would be the model default on gpt-oss anyway (fix pass 4)');
  const { levelPatch, nearestLevel } = await import('../../src/core/llm/reasoning.js');
  assert.deepEqual([nearestLevel(levels, 'max'), levelPatch(levels, 'max'), levelPatch(levels, 'medium')], ['high', {}, {}], 'an empty level is a level, and sends nothing');
  const k = await kit();
  const s = await startFakeServer({ flavour: 'ollama', cors: '*', replies: [{ text: 'Hello!' }] });
  try {
    const { modelId } = await setUp(k, 'provider-ollama', s.origin, { model: 'llama3.2:latest' });
    for (const level of ['low', 'medium', 'high', 'max', 'off']) {
      const r = await k.llm.call({ request: HI, level });
      assert.equal(r.reply.text, 'Hello!', level);
    }
    assert.deepEqual(lastChats(s).map((r) => r.body.reasoning_effort), [undefined, undefined, undefined, undefined, 'none']);
    assert.equal((await k.llm.config()).models[modelId].ability, 'chat');
    assert.match((await official('provider-ollama')).provider.abilities.chat.note ?? '', /A model that thinks gets low, medium and high; for one that can't, annai only switches thinking off/);
  } finally {
    await s.stop();
  }
});

test('llama.cpp enforces tool calls: a quick decision forces its one tool as tool_choice "required", which llama-server parses where it drops a named one; the others keep the named form (fix pass 2; the user, 2026-10-19)', async () => {
  assert.deepEqual((await official('provider-llamacpp')).provider.abilities.chat.tunables, { enforceToolCall: true });
  // A model that answers in words unless the server forces a call, and doesn't start its words with a letter.
  const replies = [{ text: 'To someone else, I think.', forced: { name: 'decide', input: { option: 'B' } } }];
  const options = [{ id: 'shiori', label: 'To the guide' }, { id: 'chatter', label: 'To someone else' }];
  for (const [plugin, flavour, choice] of /** @type {const} */ ([['provider-llamacpp', 'llamacpp', 'required'], ['provider-vllm', 'vllm', 'named']])) {
    const k = await kit();
    const s = await startFakeServer({ flavour, cors: '*', replies });
    try {
      await setUp(k, plugin, s.origin);
      const result = await k.llm.decide({ prompt: '"Pass me the water, please." Who was it said to?', options });
      const sent = s.requests.filter((r) => r.method === 'POST').map((r) => r.body);
      assert.deepEqual(sent[0].tool_choice, choice === 'required' ? 'required' : { type: 'function', function: { name: 'decide' } }, plugin);
      assert.deepEqual([sent.length, result], [1, { shiori: 0, chatter: 1 }], `${plugin}: decided by its tool call, with no second call`);
      // A turn offering Shiori's tools forces none, and is sent as it was.
      await k.llm.call({ request: { ...HI, tools: [{ name: 'weather', description: 'Weather.', input: { type: 'object' } }, { name: 'show', description: 'Show.', input: { type: 'object' } }] } });
      assert.equal('tool_choice' in s.requests.filter((r) => r.method === 'POST').at(-1).body, false, plugin);
    } finally {
      await s.stop();
    }
  }
});

test("Test also asks at the level a role will use: a model Main asks at medium that refuses it says so in plain words, and one that answers says that too; with no role asking more, there's no extra call (fix pass 7)", async () => {
  const k = await kit();
  const s = await startFakeServer({ flavour: 'ollama', cors: '*', replies: [{ text: 'OK' }, { calls: [{ name: 'report_color', input: { color: 'red' } }] }] });
  try {
    const { modelId } = await setUp(k, 'provider-ollama', s.origin, { model: 'llama3.2:latest' });
    const posts = () => lastChats(s).map((r) => r.body);
    // Ollama's map before the fix pass: a named level, which a model that can't think refuses.
    const rec = (await readConfig(k.ws)).models[modelId];
    await saveModel(k.ws, { ...rec, user: { ...rec.user, reasoning: { off: { reasoning_effort: 'none' }, medium: { reasoning_effort: 'medium' } } } });
    const refused = await k.llm.test(modelId);
    assert.equal(refused.ok, false);
    const step = refused.steps.find((x) => x.step === 'level');
    assert.equal(step?.ok, false);
    assert.equal(step?.detail, 'At Main\'s level (medium), this model refused: "llama3.2:latest" does not support thinking. Lower Main\'s level in Settings → Models, or change this model\'s Reasoning levels on its page.');
    assert.deepEqual(posts().map((b) => b.reasoning_effort), ['none', 'none', 'medium'], 'one extra tiny call, at medium');
    assert.equal(posts().at(-1).tools, undefined);
    assert.equal((await readConfig(k.ws)).models[modelId].verified?.level, false);
    // Ollama's map as it is now: medium sends nothing, and the model answers.
    await saveModel(k.ws, { ...rec, user: { ...rec.user } });
    const fine = await k.llm.test(modelId);
    assert.equal(fine.ok, true);
    assert.deepEqual(fine.steps.find((x) => x.step === 'level'), { step: 'level', ok: true, detail: "It also answers at Main's level (medium)." });
    // Main at off, or the model in no role: Test asks at off alone.
    const cfg = await readConfig(k.ws);
    await saveRoles(k.ws, { ...cfg.roles, main: { models: [modelId], level: 'off' } });
    const before = posts().length;
    assert.equal((await k.llm.test(modelId)).steps.some((x) => x.step === 'level'), false);
    await saveRoles(k.ws, { ...cfg.roles, main: { models: [], level: 'high' } });
    assert.equal((await k.llm.test(modelId)).steps.some((x) => x.step === 'level'), false);
    assert.equal(posts().length - before, 4, 'two calls each');
  } finally {
    await s.stop();
  }
});

test("Test's extra call is made only where the role's level sends something other than off's: a model with no reasoning map is asked once (fix pass 7)", async () => {
  const k = await kit();
  const s = await startFakeServer({ flavour: 'lmstudio', cors: '*', replies: [{ text: 'OK' }, { calls: [{ name: 'report_color', input: { color: 'red' } }] }] });
  try {
    const { modelId } = await setUp(k, 'provider-lmstudio', s.origin);
    const r = await k.llm.test(modelId);
    assert.deepEqual([r.ok, r.steps.map((x) => x.step)], [true, ['access', 'key', 'tools']]);
    assert.equal(s.requests.filter((x) => x.method === 'POST').length, 2);
  } finally {
    await s.stop();
  }
});

// Decision 22 (the user, 2026-10-18: "yes add the code for reading context windows"): llama.cpp, Ollama and LM Studio
// read the context a server serves, which their model lists don't say, through the provider contract's list.

test("the user's Unsloth Studio (llama.cpp), as measured on 2026-10-19: /props gives the loaded model's context and says it reads images, which Studio's own list doesn't; its unexplained max_context_length is left alone", async () => {
  const k = await kit();
  const listed = JSON.parse(await readFile(new URL('test/fixtures/llm/local/unsloth-studio-models.json', root), 'utf8')).data;
  const props = JSON.parse(await readFile(new URL('test/fixtures/llm/local/unsloth-studio-props.json', root), 'utf8'));
  const s = await startFakeServer({ flavour: 'llamacpp', key: 'sk-unsloth-stand-in', models: listed, props });
  try {
    const id = await k.llm.addProvider('provider-llamacpp', { official: true, baseUrl: `${s.origin}/v1`, key: 'sk-unsloth-stand-in', roles: null });
    const all = await k.llm.listModels(id, 'chat');
    assert.deepEqual(all.map((m) => pick(m, ['providerId', 'contextWindow', 'input'])), [
      { providerId: 'unsloth/Qwen3.8-Flash-Next-GGUF', contextWindow: 262144, input: ['text', 'image'] },
      { providerId: 'unsloth/Qwen3.8-27B-GGUF' },
    ], 'only the model /props names: another may be loaded with another context');
  } finally {
    await s.stop();
  }
});

test("llama.cpp: a server without /props, or one that won't say, still lists its models as the protocol does", async () => {
  const k = await kit();
  const s = await startFakeServer({ flavour: 'vllm' }); // no /props: 404
  try {
    const id = await k.llm.addProvider('provider-llamacpp', { official: true, baseUrl: `${s.origin}/v1`, roles: null });
    assert.deepEqual((await k.llm.listModels(id, 'chat')).map((m) => pick(m, ['providerId', 'contextWindow'])), [{ providerId: 'Qwen/Qwen3-8B', contextWindow: 32768 }]);
  } finally {
    await s.stop();
  }
});

test("Ollama: the context a loaded model was given (/api/ps), else its Modelfile's num_ctx, never its training context; photos and tools from its capabilities; the named thinking levels only for a model that thinks", async () => {
  const k = await kit();
  const s = await startFakeServer({ flavour: 'ollama', cors: [ANNAI] });
  try {
    const id = await k.llm.addProvider('provider-ollama', { official: true, baseUrl: `${s.origin}/v1`, roles: null });
    const all = await k.llm.listModels(id, 'chat');
    assert.deepEqual(all.map((m) => pick(m, ['providerId', 'contextWindow', 'input', 'tools', 'reasoning'])), [
      { providerId: 'qwen3:8b', contextWindow: 4096, input: ['text'], tools: true,
        reasoning: { off: { reasoning_effort: 'none' }, low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } } },
      { providerId: 'llama3.2:latest', contextWindow: 8192, input: ['text'], tools: true },
    ]);
    assert.deepEqual(s.requests.filter((r) => r.method === 'POST' && r.path === '/api/show').map((r) => r.body), [{ model: 'qwen3:8b' }, { model: 'llama3.2:latest' }]);
    // Added, the one that can't think keeps the plugin's map: only off is named.
    const llama = await addListedModel(k, id, 'chat', /** @type {any} */ (all[1]));
    assert.deepEqual(modelOf((await readConfig(k.ws)).models[llama]).reasoning, { off: { reasoning_effort: 'none' }, low: {}, medium: {}, high: {} });
  } finally {
    await s.stop();
  }
});

test('LM Studio: a loaded instance\'s context, never the most it could take; photos and tools from its own list', async () => {
  const k = await kit();
  const s = await startFakeServer({ flavour: 'lmstudio', cors: '*', key: 'lm-token-stand-in' });
  try {
    const id = await k.llm.addProvider('provider-lmstudio', { official: true, baseUrl: `${s.origin}/v1`, key: 'lm-token-stand-in', roles: null });
    assert.deepEqual((await k.llm.listModels(id, 'chat')).map((m) => pick(m, ['providerId', 'contextWindow', 'input', 'tools'])), [
      { providerId: 'qwen/qwen3-8b', contextWindow: 8192, input: ['text'], tools: true },
    ]);
    assert.equal(s.requests.find((r) => r.method === 'GET' && r.path === '/api/v1/models')?.headers.authorization, 'Bearer lm-token-stand-in');
  } finally {
    await s.stop();
  }
});
