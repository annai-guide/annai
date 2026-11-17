import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { setWords } from '../../src/core/l10n.js';
import { testModel, testLevels, TEST_IMAGE } from '../../src/core/llm/check.js';
import { REQUEST_MS, Uploads } from '../../src/core/llm/uploads.js';
import { readConfig, modelOf, saveProvider, saveModel, saveRoles, setKey } from '../../src/core/llm/config.js';
import { addProvider } from '../../src/core/llm/providers.js';
import { official } from './provider-kit.js';
import { createLlm } from '../../src/core/llm/service.js';
import { adjusted } from '../../src/core/llm/setup.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/** @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}
/** @param {any[]} script @param {any} [model] */
function scriptedCase(script, model = {}) {
  return {
    type: scriptedType(),
    endpoint: { id: `pv-${Math.random()}/chat`, provider: 'pv', ability: 'chat', type: 'scripted', name: 'S', baseUrl: '', headers: {}, tunables: { script }, extraBody: {} },
    model: { id: 'm', provider: 'pv', ability: 'chat', name: 'S', providerId: 'scripted', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...model },
    key: null,
  };
}

test('the Test button: access, key, tool calls and photos all work (spec §9.8)', async () => {
  const r = await testModel(scriptedCase([{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', true], ['images', true]]);
  assert.match(r.steps[1].detail, /The model said: "OK"/);
  assert.match(TEST_IMAGE, /^iVBORw0KGgo/);
});

test('a rejected key is a key problem, in plain words', async () => {
  const r = await testModel(scriptedCase([{ error: 'auth', status: 401 }]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => s.step), ['key']);
  assert.match(r.steps[0].detail, /key was rejected/);
});

test('"this address blocks web apps" is told apart from "annai couldn\'t reach it"', async () => {
  const type = /** @type {any} */ ({ type: 'http', name: 'HTTP', pluginId: 'p', build: () => ({ url: 'https://llm.test/v1/chat', headers: {}, body: {} }), read: async function* () {} });
  const c = scriptedCase([]);
  const base = { ...c, endpoint: { ...c.endpoint, baseUrl: 'https://llm.test/v1' }, type, fetch: async () => { throw new TypeError('Failed to fetch'); } };
  const blocked = await testModel({ ...base, probe: async () => true });
  assert.match(blocked.steps[0].detail, /doesn't allow web apps/);
  const down = await testModel({ ...base, probe: async () => false });
  assert.match(down.steps[0].detail, /couldn't reach this address/);
});

test("a 408 is the provider's own time limit, not a request it refused: Test says the model took too long, and sends no one to the tunables", async () => {
  const type = /** @type {any} */ ({ type: 'http', name: 'HTTP', pluginId: 'p', build: () => ({ url: 'https://llm.test/v1/chat', headers: {}, body: {} }), read: async function* () {} });
  const c = scriptedCase([]);
  // OpenRouter's shape for it (its error list: "408: Your request timed out").
  const timedOut = async () => Response.json({ error: { code: 408, message: 'Your request timed out' } }, { status: 408 });
  const r = await testModel({ ...c, endpoint: { ...c.endpoint, baseUrl: 'https://llm.test/v1' }, type, fetch: /** @type {any} */ (timedOut) });
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok, s.detail]), [['access', false, 'The model took too long to start answering.']]);
});

test("Test's level step says the model refused only for an answer that refused the request at that level: a time limit, a rate limit, a server's failure or a bad key is told as the other steps tell it, and sends no one to lower the level", async () => {
  const ok = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const at = async (/** @type {any} */ failure, role = { id: 'main', level: 'high' }) => (await testModel({ ...scriptedCase([...ok, failure], { reasoning: { off: { a: 0 }, high: { a: 1 } } }), role })).steps.find((s) => s.step === 'level');
  assert.deepEqual(await at({ error: 'bad-request', status: 400, message: 'Unsupported reasoning effort' }), {
    step: 'level', ok: false, detail: "At Main's level (high), this model refused: Unsupported reasoning effort. Lower Main's level in Settings → Models, or change this model's Reasoning levels on its page.",
  });
  // A 400 or a 413 that the core read by its words (or its status) as another kind is still the provider refusing the request.
  assert.match(String((await at({ error: 'context', status: 400, message: 'The thinking budget is too long' }, { id: 'utility', level: 'high' }))?.detail), /^At Utility's level \(high\), this model refused: The thinking budget is too long\. Lower Utility's level/);
  // A 404 too: the access step has just reached this model at this address, so a 404 now is the level's (a router with no route for it, say).
  assert.match(String((await at({ error: 'not-found', status: 404, message: 'No route for this reasoning setting' }))?.detail), /^At Main's level \(high\), this model refused: No route for this reasoning setting\. Lower Main's level/);
  // A refusal that ends as a sentence already (a Chinese 。, a "?", an ellipsis) gets no second stop, and the next sentence follows it as after any other.
  for (const [said, ended] of [['API 调用参数有误，请检查文档。', 'API 调用参数有误，请检查文档。'], ['Is reasoning supported?', 'Is reasoning supported?'], ['Not supported…', 'Not supported…'], ['Unsupported reasoning effort.', 'Unsupported reasoning effort.']]) {
    assert.equal((await at({ error: 'bad-request', status: 400, message: said }))?.detail, `At Main's level (high), this model refused: ${ended} Lower Main's level in Settings → Models, or change this model's Reasoning levels on its page.`, said);
  }
  for (const [failure, words] of /** @type {[any, string][]} */ ([
    [{ error: 'timeout', status: 408, message: 'Your request timed out' }, 'The model took too long to start answering.'],
    [{ error: 'rate', status: 429, message: 'Slow down' }, 'The provider says too many requests for now.'],
    [{ error: 'server', status: 500, message: 'Boom' }, 'The provider had a problem on its side.'],
    [{ error: 'auth', status: 401, message: 'Bad key' }, 'The key was rejected. Check it in Settings → Models.'],
  ])) assert.deepEqual(await at(failure), { step: 'level', ok: false, detail: words }, failure.error);
});

test("Test's level step on Japanese and Chinese screens ends the provider's refusal with 。 and no ASCII stop, whatever language it came in, and the next sentence follows it as after any other", async () => {
  const ok = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  try {
    for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) {
      setWords(tag, JSON.parse(await readFile(new URL(`../../l10n/${tag}.json`, import.meta.url), 'utf8')));
      for (const said of ['Unsupported reasoning effort', 'API 调用参数有误，请检查文档。', 'Is reasoning supported?']) {
        const r = await testModel({ ...scriptedCase([...ok, { error: 'bad-request', status: 400, message: said }], { reasoning: { off: { a: 0 }, high: { a: 1 } } }), role: { id: 'main', level: 'high' } });
        const detail = String(r.steps.find((x) => x.step === 'level')?.detail);
        const ended = said.endsWith('?') || said.endsWith('。') ? said : `${said}。`;
        const at = detail.indexOf(ended);
        assert.ok(at > 0, `${tag}: ${detail}`);
        assert.match(detail.slice(at + ended.length), /^[^ .]/, `${tag} joins the next sentence with no space and no ASCII stop: ${detail}`);
      }
    }
  } finally { setWords('en', null); }
});

test("a model that ignores the tool and doesn't see the square fails those steps only", async () => {
  const r = await testModel(scriptedCase([{ text: 'OK' }, { text: 'It is blue.' }]));
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', false], ['images', false]]);
  const textOnly = await testModel(scriptedCase([{ text: 'OK' }, { text: 'red' }], { input: ['text'], tools: false }));
  assert.deepEqual(textOnly.steps.map((s) => s.step), ['access', 'key']);
});

test('testLevels tries each reasoning level the model has (spec §9.3)', async () => {
  const r = await testLevels(scriptedCase([{ text: 'OK' }, { error: 'bad-request' }], { reasoning: { low: { a: 1 }, high: { a: 2 } } }));
  assert.deepEqual(r, { low: 'ok', high: 'bad-request' });
});

/** The real llm service over a memory store, with official plugins read from the repo. */
async function realLlm() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const root = new URL('../../', import.meta.url);
  const repoFetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws, importModule }), fetch: repoFetch });
  return { llm, ws, store };
}

test('the service records what the Test button found on the model, and a model that works rests no more', async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const [id] = Object.keys((await readConfig(ws)).models);
  // A model that failed earlier rests; once Test reaches it with a working key, it is back at once.
  llm.bench.bench(id, 60_000);
  await llm.test(id);
  assert.equal(llm.bench.until(id), 0);
  // Saving a provider, or its key, puts its models back too: the user may have fixed what failed.
  llm.bench.bench(id, 60_000);
  await llm.unbench((await readConfig(ws)).models[id].provider);
  assert.equal(llm.bench.until(id), 0);
  const verified = (await readConfig(ws)).models[id].verified;
  assert.equal(verified?.access, true);
  assert.equal(verified?.key, true);
  assert.equal(typeof verified?.at, 'number');
  assert.equal(modelOf((await readConfig(ws)).models[id]).name, 'Scripted');
});

test('the service passes on the model to prefer and the photo repair (spec §9.6, §9.9)', async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [first] = Object.keys(cfg.models);
  const ep = cfg.providers[cfg.models[first].provider];
  await saveProvider(ws, { ...ep, user: { ...ep.user, abilities: { chat: { tunables: { script: [{ error: 'image', status: 400, message: 'too big' }, { text: 'Fixed.' }, { text: 'Second.' }] } } } } });
  await saveModel(ws, { ...cfg.models[first], id: 'm-second', user: { ...cfg.models[first].user, providerId: 'scripted-2', name: 'Second' } });
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [first, 'm-second'], level: 'medium' } });
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }] };
  let repaired = 0;
  const r = await llm.call({ role: 'main', request, repairImages: async (/** @type {any} */ _e, /** @type {string} */ _id, /** @type {any} */ req) => { repaired++; return req; } });
  assert.equal(r.reply.text, 'Fixed.');
  assert.equal(repaired, 1);
  assert.equal((await llm.call({ role: 'main', request, prefer: 'm-second' })).modelId, 'm-second');
});

/** A Test case whose endpoint stores files. @param {any} c */
const withUploads = (c) => ({
  ...c, endpoint: { ...c.endpoint, baseUrl: 'https://files.test/v1' },
  type: { ...c.type, uploadRequest: () => ({ url: 'https://files.test/v1/files', headers: {}, body: new FormData() }), readUpload: (/** @type {any} */ j) => ({ id: j.id }) },
});
const PHOTOS_INSTEAD = 'annai will send photos in each request instead.';

test('the Test button checks photo uploads where the endpoint stores files (spec §9.8)', async () => {
  const script = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const ok = await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => new Response(JSON.stringify({ id: 'file_1' })) });
  assert.deepEqual(ok.steps.map((s) => [s.step, s.ok]).at(-1), ['upload', true]);
  assert.equal(ok.ok, true);
  const refused = await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => new Response('no', { status: 403 }) });
  const last = /** @type {any} */ (refused.steps.at(-1));
  assert.deepEqual([last.step, last.ok], ['upload', false]);
  assert.equal(last.detail, "Uploading photos didn't work with this key. annai will send photos in each request instead.");
  assert.equal(refused.ok, true, 'photos still work, sent in each request');
  // No answer at all is not the key's: it has the first step's words for an address annai can't reach.
  const down = await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const none = /** @type {any} */ (down.steps.at(-1));
  assert.deepEqual([none.step, none.ok], ['upload', false]);
  assert.equal(none.detail, "annai couldn't reach this address. It may be down, or it may not allow web apps. annai will send photos in each request instead.");
  assert.equal(down.ok, true, 'photos still work, sent in each request');
  const noAnswer = "annai couldn't reach this address. It may be down, or it may not allow web apps. annai will send photos in each request instead.";
  // A body that breaks off after a 200, or stalls past the time limit, is no answer either (the sweep's list reads it so too); only a body that arrived and isn't an upload is the key's.
  const after = (/** @type {string} */ sent, /** @type {unknown} */ why) => /** @type {any} */ (async () => new Response(new ReadableStream({ start(c) { if (sent) c.enqueue(new TextEncoder().encode(sent)); c.error(why); } }), { status: 200 }));
  for (const fetch of [after('{"id"', new TypeError('network error')), after('', new DOMException('The operation timed out.', 'TimeoutError'))]) {
    const cut = /** @type {any} */ ((await testModel({ ...withUploads(scriptedCase(script)), fetch })).steps.at(-1));
    assert.deepEqual([cut.step, cut.ok, cut.detail], ['upload', false, noAnswer]);
  }
  const odd = /** @type {any} */ ((await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => new Response('not json', { status: 200 }) })).steps.at(-1));
  assert.equal(odd.detail, "Uploading photos didn't work with this key. annai will send photos in each request instead.", 'a 200 that arrived whole and is no upload is the key\'s words, as before');
});

test("the Test button's photo upload has the sweeps' time limit (uploads.js REQUEST_MS), and a stall ends in the no-answer words", async () => {
  const script = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  // AbortSignal.timeout can't be driven by fake timers: ask for its limit, make it short, and keep the signal it returns.
  const real = AbortSignal.timeout;
  /** @type {number[]} */
  const asked = [];
  /** @type {AbortSignal[]} */
  const made = [];
  AbortSignal.timeout = (ms) => { asked.push(ms); const s = real.call(AbortSignal, 20); made.push(s); return s; };
  try {
    // A connection that is accepted and never answered: the request ends only when its signal does. The stub records the signal it got; the
    // test asserts on it outside the stub, where a throw would be taken for the no-answer words it is looking for.
    /** @type {(AbortSignal | null | undefined)[]} */
    const got = [];
    const stalled = async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
      const { signal } = init;
      got.push(signal);
      if (!signal || !made.includes(signal)) throw new Error('not the time limit: a stall would wait for ever');
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    const r = await testModel({ ...withUploads(scriptedCase(script)), fetch: /** @type {any} */ (stalled) });
    const last = /** @type {any} */ (r.steps.at(-1));
    assert.deepEqual(asked, [REQUEST_MS], 'one request, with the limit the sweeps use');
    assert.equal(got.length, 1);
    assert.equal(got[0], made[0], 'the fetch got the limit it was made with');
    assert.deepEqual([last.step, last.ok], ['upload', false]);
    assert.equal(last.detail, `annai couldn't reach this address. It may be down, or it may not allow web apps. ${PHOTOS_INSTEAD}`);
    assert.equal(r.ok, true, 'photos still work, sent in each request');
  } finally {
    AbortSignal.timeout = real;
  }
});

test("a Test whose photo upload is answered 408, 402, 429 or with a server error is not told as the key's: a 408 is no answer, the others are read as the first step reads them (typeError: the protocol's and the provider's own reading first) (review of openrouter-f1, F1, G1)", async () => {
  const script = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const rows = /** @type {[number, string, string?][]} */ ([
    [408, "annai couldn't reach this address. It may be down, or it may not allow web apps."],
    [429, 'The provider says too many requests for now.'],
    // A 429 whose body speaks of quota, billing or credit is the account's, as the first step reads it (the second opinion's lead 5).
    [429, 'This account is out of credit.', '{"error":{"message":"Insufficient credits: add more to continue."}}'],
    // A 402 is the account's too, as the first step reads it (the design check's Call 5).
    [402, 'This account is out of credit.'],
    [500, 'The provider had a problem on its side.'],
    [502, 'The provider had a problem on its side.'],
    [503, 'The provider is overloaded right now.'],
    [504, 'The provider had a problem on its side.'],
    // An answer about the key or the request is still the key's.
    [400, "Uploading photos didn't work with this key."],
    [401, "Uploading photos didn't work with this key."],
    [404, "Uploading photos didn't work with this key."],
  ]);
  for (const [status, words, body = 'no'] of rows) {
    const r = await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => new Response(body, { status }) });
    const last = /** @type {any} */ (r.steps.at(-1));
    assert.deepEqual([status, body, last.step, last.ok, last.detail], [status, body, 'upload', false, `${words} ${PHOTOS_INSTEAD}`]);
    assert.equal(r.ok, true, 'photos still work, sent in each request');
  }
  // The protocol's and the provider's own reading comes first, as on the first step (typeError): Gemini's 429 says "quota" and is too many requests.
  const { classify } = await import('../../plugins-official/gemini-api/chat.js');
  const quota = '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}';
  const g = withUploads(scriptedCase(script));
  const read = /** @type {any} */ ((await testModel({ ...g, type: { ...g.type, classify }, fetch: async () => new Response(quota, { status: 429 }) })).steps.at(-1));
  assert.equal(read.detail, `The provider says too many requests for now. ${PHOTOS_INSTEAD}`);
  // A 429's body that breaks off is read as empty: the answer still came, so it is "too many requests", not no answer.
  const broken = /** @type {any} */ ((await testModel({ ...withUploads(scriptedCase(script)), fetch: /** @type {any} */ (async () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('network error')); } }), { status: 429 })) })).steps.at(-1));
  assert.equal(broken.detail, `The provider says too many requests for now. ${PHOTOS_INSTEAD}`);
});

test("a Test's photo upload reads OpenRouter's free-model limit by its own layered reading (too many requests, as a 429 or a 402), and Anthropic's out-of-credit 400 by its classify (out of credit), not as the key's", async () => {
  const script = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  /** A protocol plugin's registered type. @param {(annai: any) => unknown} activate @returns {any} */
  const protocol = (activate) => {
    /** @type {any} */
    let t = null;
    activate({ providers: { register: (/** @type {any} */ x) => { t = x; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
    return t;
  };
  // OpenRouter: Chat Completions' reading, with the provider's own classify asked first, as adjusted() builds the type for every call of its abilities.
  const { activate: chatCompletions } = await import('../../plugins-official/chat-completions/index.js');
  const { freeLimit } = await import('../../plugins-official/provider-openrouter/index.js');
  const registry = new Registry();
  registry.add('provider-openrouter', 'provider-setup', { keyField: true, classify: freeLimit });
  const daily = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } });
  for (const status of [429, 402]) {
    const c = withUploads(scriptedCase(script));
    const { type } = adjusted(registry, 'provider-openrouter', { ...c.type, classify: protocol(chatCompletions).classify }, c.endpoint);
    const last = /** @type {any} */ ((await testModel({ ...c, type, fetch: async () => new Response(daily, { status }) })).steps.at(-1));
    assert.deepEqual([status, last.step, last.ok, last.detail], [status, 'upload', false, `The provider says too many requests for now. ${PHOTOS_INSTEAD}`]);
  }
  // Anthropic: out of credit is a 400 whose words say so (its classify), which core alone would read as the key's.
  const { activate: anthropic } = await import('../../plugins-official/anthropic-messages/index.js');
  const credit = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
  const c = withUploads(scriptedCase(script));
  const last = /** @type {any} */ ((await testModel({ ...c, type: { ...c.type, classify: protocol(anthropic).classify }, fetch: async () => new Response(credit, { status: 400 }) })).steps.at(-1));
  assert.deepEqual([last.step, last.ok, last.detail], ['upload', false, `This account is out of credit. ${PHOTOS_INSTEAD}`]);
});

test("a Test whose photo upload failed turns uploads off there, as a call's failed upload does, so \"annai will send photos in each request instead\" is true; one that passes turns them on (review of openrouter-f1, the second opinion's lead 3)", async () => {
  const script = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const ws = new Workspace(createMemoryStore());
  const cut = (/** @type {unknown} */ why) => /** @type {any} */ (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"id"')); c.error(why); } }), { status: 200 }));
  const failures = /** @type {[string, any][]} */ ([
    ['refused', async () => new Response('no', { status: 403 })],
    ['a 404', async () => new Response('no', { status: 404 })],
    ['a 408', async () => new Response('slow', { status: 408 })],
    ['a 429', async () => new Response('slow down', { status: 429 })],
    ['a 503', async () => new Response('busy', { status: 503 })],
    ['no answer', async () => { throw new TypeError('Failed to fetch'); }],
    ['a body that breaks off', cut(new TypeError('network error'))],
    ['a body that is no upload', async () => new Response('not json', { status: 200 })],
  ]);
  for (const [what, fetch] of failures) {
    const uploads = new Uploads(ws);
    const c = withUploads(scriptedCase(script));
    const r = await testModel({ ...c, fetch, uploads });
    assert.equal(/** @type {any} */ (r.steps.at(-1)).step, 'upload');
    assert.equal(uploads.isOff(c.endpoint.id), true, `uploads are off after ${what}`);
  }
  // One that works turns them on again (a Test that passes), where an earlier failure had turned them off.
  const uploads = new Uploads(ws);
  const c = withUploads(scriptedCase(script));
  uploads.off(c.endpoint.id);
  const ok = await testModel({ ...c, fetch: async () => new Response(JSON.stringify({ id: 'file_1' })), uploads });
  assert.deepEqual(ok.steps.map((x) => [x.step, x.ok]).at(-1), ['upload', true]);
  assert.equal(uploads.isOff(c.endpoint.id), false);
});

test("what the Test button says never shows a key, whatever the provider's message holds (spec §9.9)", async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [id] = Object.keys(cfg.models);
  const ep = cfg.providers[cfg.models[id].provider];
  await setKey(store, ep.id, 'sk-live-0123456789abcdef');
  // A kind the plugin made up has no plain words of annai's: the provider's own message is shown, blanked.
  await saveProvider(ws, { ...ep, user: { ...ep.user, abilities: { chat: { tunables: { script: [{ error: 'quota-ish', status: 400, message: 'Key sk-live-0123456789abcdef may not use this model.' }] } } } } });
  const r = await llm.test(id);
  assert.equal(r.ok, false);
  assert.match(r.steps[0].detail, /may not use this model/);
  assert.doesNotMatch(JSON.stringify(r), /0123456789abcdef/);
});

test("a model that takes no photos is asked something it can answer with the tool, with room to think first; a reply cut off by its length says so (the user's DeepSeek, 2026-10-18)", async () => {
  const c = scriptedCase([{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }], { input: ['text'], tools: true });
  /** @type {any[]} */
  const seen = [];
  const run = c.type.run;
  c.type.run = (/** @type {any} */ x) => { seen.push(x.request); return run(x); };
  const r = await testModel(c);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', true]]);
  const ask = seen[1];
  const words = ask.messages[0].parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text).join(' ');
  assert.ok(!ask.messages[0].parts.some((/** @type {any} */ p) => p.type === 'image'));
  assert.match(words, /red/, 'without a picture, the question carries the answer');
  assert.doesNotMatch(words, /What color is the square\?/);
  assert.ok(ask.maxOutput >= 4096, `room for a thinking model before its tool call: ${ask.maxOutput}`);
  const cut = await testModel(scriptedCase([{ text: 'OK' }, { text: 'Let me think about the', stop: 'length' }], { input: ['text'], tools: true }));
  assert.match(cut.steps[2].detail, /ran out of room|length/i);
});

test('every Test request leaves room for a model that must think before it answers: 4096 tokens, or the model\'s own limit when lower (the user, 2026-10-18)', async () => {
  /** @param {any} c */
  const watch = (c) => {
    /** @type {number[]} */
    const asked = [];
    const run = c.type.run;
    c.type.run = (/** @type {any} */ x) => { asked.push(x.request.maxOutput); return run(x); };
    return asked;
  };
  const ok = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const c = scriptedCase(ok);
  const asked = watch(c);
  await testModel(c);
  assert.deepEqual(asked, [4096, 4096]);
  const small = scriptedCase(ok, { maxOutput: 1024 });
  const askedSmall = watch(small);
  await testModel(small);
  assert.deepEqual(askedSmall, [1024, 1024]);
  const levels = scriptedCase([{ text: 'OK' }, { text: 'OK' }], { reasoning: { low: {}, high: {} } });
  const askedLevels = watch(levels);
  await testLevels(levels);
  assert.deepEqual(askedLevels, [4096, 4096]);
});

test('Try this model calls that model alone: no fallback when it fails, a model resting is still asked, and the trace keeps the call (the user, 2026-10-18)', async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [one] = Object.keys(cfg.models);
  const ep = cfg.providers[cfg.models[one].provider];
  await saveProvider(ws, { ...ep, user: { ...ep.user, abilities: { chat: { tunables: { script: [{ error: 'credit', status: 402 }] } } } } });
  await saveProvider(ws, { ...ep, id: 'pv-two', user: { ...ep.user, name: 'Two', abilities: { chat: { tunables: { script: [{ text: 'From two.' }] } } } } });
  await saveModel(ws, { ...cfg.models[one], id: 'm-two', provider: 'pv-two', user: { ...cfg.models[one].user, providerId: 'scripted-2', name: 'Two' } });
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [one, 'm-two'], level: 'medium' } });
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }] };
  // The main role would fall back to Two; the one model asked does not.
  const failed = await llm.callModel({ modelId: one, request }).then(() => null, (/** @type {any} */ e) => e);
  assert.equal(failed?.name, 'AllFailedError');
  assert.deepEqual(failed.attempts.map((/** @type {any} */ a) => [a.model, a.outcome]), [[one, 'credit']]);
  assert.equal(llm.bench.until(one), 0, "a try doesn't rest the model for Shiori");
  // A model resting is asked all the same, and once it answers it rests no more.
  llm.bench.bench('m-two', 60_000);
  const r = await llm.callModel({ modelId: 'm-two', request });
  assert.equal(r.reply.text, 'From two.');
  assert.equal(r.answeredBy, 'Two');
  assert.equal(llm.bench.until('m-two'), 0);
  const turns = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turns.map((e) => [e.data.role, e.data.answeredBy, e.data.attempts.length]), [['try', null, 1], ['try', 'Two', 1]]);
});
