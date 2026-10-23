import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_USAGE, mergeUsage, addUsage, costOf, addCost, speechCost, pricesProblem, pricesAt } from '../../src/core/llm/cost.js';
import { LEVELS, ROLE_LEVELS, nearestLevel, levelPatch } from '../../src/core/llm/reasoning.js';

/** @param {number | undefined} a @param {number} b */
const close = (a, b) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('cost is usage × prices per million tokens, by kind of token (spec §9.9)', () => {
  const prices = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 };
  const usage = { ...NO_USAGE, input: 1000, cacheRead: 10_000, cacheWrite: 2000, cacheWrite1h: 1000, output: 500, reasoning: 200 };
  close(costOf(usage, prices), (1000 * 2 + 10_000 * 0.1 + 2000 * 2.5 + 1000 * 4 + 500 * 10) / 1e6);
});

test('a long prompt is priced by its tier', () => {
  const prices = { input: 0.1, output: 0.5, cacheRead: 0.01, tiers: [{ above: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05 }] };
  close(costOf({ ...NO_USAGE, input: 50_000, output: 1000 }, prices), (50_000 * 0.1 + 1000 * 0.5) / 1e6);
  close(costOf({ ...NO_USAGE, input: 90_000, cacheRead: 60_000, output: 1000 }, prices), (90_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
});

test('missing cache prices fall back to the input price; a reported cost wins; no prices is unknown', () => {
  close(costOf({ ...NO_USAGE, cacheRead: 1000, cacheWrite: 1000, cacheWrite1h: 1000 }, { input: 1, output: 1 }), 3000 / 1e6);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.5 }, { input: 1, output: 1 }), 0.5);
  assert.equal(costOf({ ...NO_USAGE, input: 1000 }, null), undefined);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.25 }, null), 0.25);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, output: 10 }, { input: 0, output: 0 }), 0);
});

test('mergeUsage keeps the latest number of each kind; addUsage and addCost sum calls', () => {
  const a = mergeUsage(mergeUsage({ ...NO_USAGE }, { input: 50, cacheRead: 8000, output: 1 }), { output: 7 });
  assert.deepEqual(a, { ...NO_USAGE, input: 50, cacheRead: 8000, output: 7 });
  assert.equal(mergeUsage(a, { cost: 0.01 }).cost, 0.01);
  assert.deepEqual(addUsage(a, { ...NO_USAGE, input: 1, output: 1, reasoning: 2 }), { ...NO_USAGE, input: 51, cacheRead: 8000, output: 8, reasoning: 2 });
  assert.equal(addCost(undefined, undefined), undefined);
  assert.equal(addCost(undefined, 0.5), 0.5);
  close(addCost(0.25, 0.5), 0.75);
});

test('audio tokens are priced by audioIn and audioOut, else as input and output; usage carries them only when a report gives them (K4)', () => {
  const live = { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 };
  close(costOf({ ...NO_USAGE, input: 1000, audioIn: 2000, output: 100, audioOut: 500 }, live), (1000 * 0.75 + 2000 * 3 + 100 * 4.5 + 500 * 12) / 1e6);
  close(costOf({ ...NO_USAGE, input: 1000, audioIn: 2000, output: 100, audioOut: 500 }, { input: 1, output: 2 }), (3000 * 1 + 600 * 2) / 1e6);
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { input: 5 }), { ...NO_USAGE, input: 5 }, 'no audio fields for a call without audio');
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { audioIn: 7, audioOut: 9 }), { ...NO_USAGE, audioIn: 7, audioOut: 9 });
  assert.deepEqual(addUsage({ ...NO_USAGE, audioIn: 7 }, { ...NO_USAGE, audioIn: 1, audioOut: 2 }), { ...NO_USAGE, audioIn: 8, audioOut: 2 });
  assert.deepEqual(addUsage({ ...NO_USAGE, input: 1 }, { ...NO_USAGE, input: 2 }), { ...NO_USAGE, input: 3 });
});

test("a realtime model's image and video tokens are priced by its image price, else as input (review)", () => {
  close(costOf({ ...NO_USAGE, input: 1000, image: 2000 }, { input: 0.75, image: 1, output: 4.5 }), (1000 * 0.75 + 2000 * 1) / 1e6);
  close(costOf({ ...NO_USAGE, input: 1000, image: 2000 }, { input: 0.75, output: 4.5 }), (3000 * 0.75) / 1e6);
  assert.deepEqual(addUsage({ ...NO_USAGE, image: 3 }, { ...NO_USAGE, image: 4 }), { ...NO_USAGE, image: 7 });
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { image: 5 }), { ...NO_USAGE, image: 5 });
});

test("a realtime model's cached audio tokens are priced by cacheReadAudio, else as cache reads, else as audio in (OpenAI's mini: $0.30 against $0.06 for cached text) (K6)", () => {
  const mini = { input: 0.6, cacheRead: 0.06, cacheReadAudio: 0.3, audioIn: 10, output: 2.4, audioOut: 20 };
  close(costOf({ ...NO_USAGE, input: 100, cacheRead: 1000, cacheReadAudio: 2000, audioIn: 50, output: 10, audioOut: 300 }, mini), (100 * 0.6 + 1000 * 0.06 + 2000 * 0.3 + 50 * 10 + 10 * 2.4 + 300 * 20) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadAudio: 2000 }, { input: 4, cacheRead: 0.4, audioIn: 32 }), (2000 * 0.4) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadAudio: 2000 }, { input: 4, audioIn: 32 }), (2000 * 32) / 1e6);
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { cacheReadAudio: 5 }), { ...NO_USAGE, cacheReadAudio: 5 });
  assert.deepEqual(addUsage({ ...NO_USAGE, cacheReadAudio: 3 }, { ...NO_USAGE }), { ...NO_USAGE, cacheReadAudio: 3 });
});

test("a realtime model's cached image tokens are priced by cacheReadImage, else as cache reads, else as images (OpenAI's: $0.50 against $0.40 for cached text) (review)", () => {
  close(costOf({ ...NO_USAGE, cacheRead: 1000, cacheReadImage: 2000 }, { input: 4, cacheRead: 0.4, cacheReadImage: 0.5, image: 5 }), (1000 * 0.4 + 2000 * 0.5) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadImage: 2000 }, { input: 4, cacheRead: 0.4, image: 5 }), (2000 * 0.4) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadImage: 2000 }, { input: 4, image: 5 }), (2000 * 5) / 1e6);
  assert.deepEqual(addUsage({ ...NO_USAGE, cacheReadImage: 3 }, { ...NO_USAGE, cacheReadImage: 4 }), { ...NO_USAGE, cacheReadImage: 7 });
});

test("reasoning levels: the model's own, else the nearest, the cheaper on a tie (spec §9.3)", () => {
  assert.deepEqual(LEVELS, ['off', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(ROLE_LEVELS, { main: 'medium', utility: 'low', decide: 'off', 'koe-classic': 'low', 'koe-realtime': 'off' });
  const map = { low: { e: 'low' }, high: { e: 'high' } };
  assert.equal(nearestLevel(map, 'low'), 'low');
  assert.equal(nearestLevel(map, 'medium'), 'low', 'a tie goes to the cheaper level');
  assert.equal(nearestLevel(map, 'max'), 'high');
  assert.equal(nearestLevel(map, 'off'), 'low');
  assert.equal(nearestLevel({}, 'medium'), null);
  assert.equal(nearestLevel(undefined, 'medium'), null);
  assert.deepEqual(levelPatch(map, 'max'), { e: 'high' });
  assert.equal(levelPatch({}, 'high'), null);
});

test("a provider marked free tier costs nothing: a call's reply and trace, and a speech call's (the free-tier switch)", async () => {
  const { callOnce } = await import('../../src/core/llm/call.js');
  const { speechCall } = await import('../../src/core/llm/speech.js');
  const { createMemoryStore } = await import('../../src/core/store-memory.js');
  const { modelTrace } = await import('../../src/core/llm/trace.js');
  const { SYS } = await import('../../src/core/scopes.js');
  const { providerOf, endpointOf, newProvider } = await import('../../src/core/llm/config.js');
  const rec = newProvider('provider-gemini', { template: { version: '2.0.0', values: { name: 'Google Gemini', baseUrl: 'https://llm.test', abilities: { chat: { kind: 'chat', type: 'run' }, voice: { kind: 'voice', type: 'say' } } } }, user: { free: true } });
  assert.equal(providerOf(rec).free, true);
  assert.equal(providerOf({ ...rec, user: {} }).free, false);
  const endpoint = endpointOf(rec, 'chat');
  assert.equal(endpoint.free, true, "every ability's calls");
  const model = { id: 'm-1', provider: rec.id, ability: 'chat', name: 'Flash', providerId: 'flash', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
  const store = createMemoryStore();
  const type = /** @type {any} */ ({ type: 'run', name: 'Run', pluginId: 'p', run: async function* () { yield { type: 'text', text: 'Hi' }; yield { type: 'usage', usage: { input: 1000, output: 1000 } }; yield { type: 'stop', reason: 'end' }; } });
  const reply = await callOnce({ type, endpoint, model, key: null, request: { messages: [] }, trace: modelTrace(store, SYS) });
  assert.equal(reply.cost, 0);
  assert.equal((await callOnce({ type, endpoint: { ...endpoint, free: false }, model, key: null, request: { messages: [] } })).cost, 3000 / 1e6, 'the same call on a paid key');
  const say = /** @type {any} */ ({ type: 'say', name: 'Say', pluginId: 'p', speech: 'out', speechRequest: () => ({ url: 'https://llm.test/say', headers: {}, body: '{}' }), readSpeech: async () => ({ data: new Uint8Array(1), mediaType: 'audio/wav' }) });
  const spoken = await speechCall({ type: say, endpoint: endpointOf(rec, 'voice'), model: { ...model, prices: { perMillionChars: 10 } }, key: null, text: 'Hello there.', fetch: async () => new Response(new Uint8Array(1)), trace: modelTrace(store, SYS) });
  assert.equal(spoken.cost, 0);
  const costs = (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS))).map((/** @type {any} */ e) => e.data.cost);
  assert.deepEqual(costs, [0, 0], 'the trace says free, and Spend per day adds nothing');
});

// ---- A price with a date it starts from (Gemini's prices double on 2027-01-01) ----

test('a price schedule: an entry applies from its date (UTC midnight), later entries lay over earlier ones, and an entry with no usable date never applies', () => {
  const prices = { input: 1, output: 4, schedule: [{ from: '2027-01-01', input: 2, output: 8 }, { from: '2027-07-01', output: 10 }, { from: 'soon', input: 99 }, { from: '2027-13-45', input: 98 }] };
  const usage = { ...NO_USAGE, input: 1_000_000, output: 1_000_000 };
  const day = (/** @type {string} */ iso) => Date.parse(iso);
  close(costOf(usage, prices, [], day('2026-12-31T23:59:59.999Z')), 5);
  close(costOf(usage, prices, [], day('2027-01-01T00:00:00Z')), 10);
  close(costOf(usage, prices, [], day('2027-06-30T23:59:59Z')), 10);
  close(costOf(usage, prices, [], day('2027-07-01T00:00:00Z')), 12); // an entry names only what changes
  close(costOf(usage, { input: 1, output: 4 }, [], day('2030-01-01T00:00:00Z')), 5); // no schedule, no change
  close(speechCost({ perMillionChars: 15, schedule: [{ from: '2027-01-01', perMillionChars: 30 }] }, { chars: 1_000_000, at: day('2026-12-31T12:00:00Z') }), 15);
  close(speechCost({ perMillionChars: 15, schedule: [{ from: '2027-01-01', perMillionChars: 30 }] }, { chars: 1_000_000, at: day('2027-01-01T12:00:00Z') }), 30);
});

test("provider-gemini's prices: 3.8 and 3.6 Flash and the TTS voices double from 2027-01-01 on Google's pricing page (checked 2026-10-23); Flash Lite, Live and transcription do not", async () => {
  const { readFile } = await import('node:fs/promises');
  const d = JSON.parse(await readFile(new URL('../../plugins-official/provider-gemini/annai-plugin.json', import.meta.url), 'utf8'));
  const models = Object.fromEntries(Object.values(d.provider.abilities).flatMap((/** @type {any} */ a) => a.models.map((/** @type {any} */ m) => [`${a.kind}/${m.providerId}`, m.prices])));
  const before = Date.parse('2026-12-31T23:59:59Z');
  const after = Date.parse('2027-01-01T00:00:00Z');
  const usage = { ...NO_USAGE, input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  for (const id of ['chat/gemini-3.8-flash', 'chat/gemini-3.6-flash']) {
    close(costOf(usage, models[id], [], before), 0.75 + 0.075 + 3.75);
    close(costOf(usage, models[id], [], after), 1.5 + 0.15 + 7.5);
  }
  for (const [id, was] of [['voice/gemini-3.8-flash-tts', 15], ['voice/gemini-3.8-flash-lite-tts', 10]]) {
    close(speechCost(models[String(id)], { chars: 1_000_000, at: before }), Number(was));
    close(speechCost(models[String(id)], { chars: 1_000_000, at: after }), Number(was) * 2);
  }
  for (const id of ['chat/gemini-3.5-flash-lite', 'realtime/gemini-3.8-live', 'transcription/gemini-3.5-transcribe']) {
    assert.equal(models[id].schedule, undefined, id);
  }
});

test("a call is priced at the time it was made: the same Gemini 3.8 Flash call costs twice as much after the date (callOnce, with its clock)", async () => {
  const { readFile } = await import('node:fs/promises');
  const { callOnce } = await import('../../src/core/llm/call.js');
  const { startGeminiServer } = await import('../fakes/gemini-server.js');
  const { loadGemini, endpointOf, modelOf, KEY } = await import('./gemini-kit.js');
  const d = JSON.parse(await readFile(new URL('../../plugins-official/provider-gemini/annai-plugin.json', import.meta.url), 'utf8'));
  const prices = d.provider.abilities.chat.models.find((/** @type {any} */ m) => m.providerId === 'gemini-3.8-flash').prices;
  const type = loadGemini();
  const s = await startGeminiServer({ key: KEY, replies: [{ text: 'OK' }, { text: 'OK' }] });
  try {
    /** @param {string} iso */
    const costAt = async (iso) => (await callOnce({
      type, endpoint: endpointOf(type, { baseUrl: s.url }), model: modelOf({ providerId: 'gemini-3.8-flash', prices }), key: KEY,
      request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] }, now: () => Date.parse(iso),
    })).cost;
    const early = await costAt('2026-12-31T12:00:00Z');
    const late = await costAt('2027-01-02T12:00:00Z');
    close(early, (100 * 0.75 + 10 * 3.75) / 1e6);
    close(late, (100 * 1.5 + 10 * 7.5) / 1e6);
  } finally {
    await s.close();
  }
});

test("a model's prices with a schedule are valid when each entry has a real date and prices that are not negative; anything else is refused", async () => {
  const { saveModel, newModel, saveProvider, newProvider } = await import('../../src/core/llm/config.js');
  const { createMemoryStore } = await import('../../src/core/store-memory.js');
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const provider = newProvider('provider-x', { user: { name: 'X', abilities: { chat: { kind: 'chat', type: 'x' } } } });
  await saveProvider(ws, provider);
  const save = (/** @type {any} */ prices) => saveModel(ws, newModel(provider.id, 'chat', { user: { providerId: 'm', prices } }));
  await save({ input: 1, output: 2, schedule: [{ from: '2027-01-01', input: 2, output: 4 }] });
  for (const bad of [[{ input: 2 }], [{ from: '2027-13-45', input: 2 }], [{ from: 'soon', input: 2 }], [{ from: '2027-01-01', input: -1 }], 'tomorrow']) {
    await assert.rejects(save({ input: 1, schedule: bad }), undefined, JSON.stringify(bad));
  }
});

// ---- A typed price against a description's schedule ----

/** A scheduled model as a description gives it, and a way to save the user's changes to it. */
async function scheduledModel() {
  const { saveModel, saveProvider, newProvider, newModel } = await import('../../src/core/llm/config.js');
  const { createMemoryStore } = await import('../../src/core/store-memory.js');
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const provider = newProvider('provider-x', { user: { name: 'X', abilities: { chat: { kind: 'chat', type: 'x' } } } });
  await saveProvider(ws, provider);
  const prices = { input: 0.75, output: 3.75, cacheRead: 0.075, schedule: [{ from: '2027-01-01', input: 1.5, output: 7.5, cacheRead: 0.15 }] };
  const rec = newModel(provider.id, 'chat', { template: { id: 'x/chat/m', version: '1.0.0', values: { providerId: 'm', prices } } });
  await saveModel(ws, rec);
  return { ws, rec, saveModel };
}

test("a price the user typed stays theirs after a scheduled date: the description's schedule never lays over a field the user set", async () => {
  const { modelOf, diffLayer, modelBase } = await import('../../src/core/llm/config.js');
  const { rec } = await scheduledModel();
  const usage = { ...NO_USAGE, input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  const before = Date.parse('2026-12-31T12:00:00Z');
  const after = Date.parse('2027-01-02T12:00:00Z');
  // The Prices box shows the prices in force; the user changes input to 0.5 and the editor saves the difference.
  const shown = modelOf(rec).prices;
  const edited = { ...rec, user: diffLayer({ prices: { ...shown, input: 0.5 } }, modelBase(rec)) };
  const prices = /** @type {any} */ (modelOf(edited).prices);
  close(costOf(usage, prices, [], before), 0.5 + 0.075 + 3.75);
  close(costOf(usage, prices, [], after), 0.5 + 0.15 + 7.5); // input stays 0.5; what the user left alone still follows the schedule
  // A field the user set and the schedule changes: all of them set, none follows.
  const all = modelOf(/** @type {any} */ ({ ...rec, user: { prices: { input: 1, output: 2, cacheRead: 0.1 } } })).prices;
  close(costOf(usage, all, [], after), 1 + 0.1 + 2);
});

test('the schedule can be deleted in the Prices box: null on the user layer removes the description\'s, and it saves', async () => {
  const { modelOf, diffLayer, modelBase } = await import('../../src/core/llm/config.js');
  const { ws, rec, saveModel: save } = await scheduledModel();
  const { schedule: _gone, ...without } = /** @type {any} */ (modelOf(rec).prices);
  const next = { ...rec, user: diffLayer({ prices: without }, modelBase(rec)) };
  assert.deepEqual(next.user, { prices: { schedule: null } });
  await save(ws, next);
  const prices = modelOf(next).prices;
  assert.equal(/** @type {any} */ (prices).schedule, undefined);
  close(costOf({ ...NO_USAGE, input: 1_000_000 }, prices, [], Date.parse('2027-06-01T00:00:00Z')), 0.75);
});

test("pricesProblem: what is wrong with a model's prices, in plain words, or nothing (the editor's save path)", () => {
  assert.equal(pricesProblem({ input: 1, output: 4, perMinute: 0, tiers: [{ above: 200000, input: 2 }], schedule: [{ from: '2027-01-01', input: 2 }] }), null);
  assert.match(String(pricesProblem({ input: -1 })), /input.*not a price/);
  assert.match(String(pricesProblem({ output: '4' })), /output.*not a price/);
  assert.match(String(pricesProblem({ schedule: 'later' })), /schedule.*list/);
  assert.match(String(pricesProblem({ schedule: [{ input: 2 }] })), /from/);
  assert.match(String(pricesProblem({ schedule: [{ from: '2027-02-30', input: 2 }] })), /2027-02-30.*not a date/);
  assert.match(String(pricesProblem({ schedule: [{ from: '2027-01-01', input: 2 }, { from: '2027-01-01', output: 3 }] })), /2027-01-01.*twice/);
  assert.match(String(pricesProblem({ schedule: [{ from: '2027-01-01', inptu: 2 }] })), /inptu.*isn't a price/);
  assert.match(String(pricesProblem({ schedule: [{ from: '2027-01-01', input: -2 }] })), /input.*not a price/);
});

test("the Prices box: editing one price after another keeps each the user's past the date, an untouched schedule stays the description's, and a bad price is refused by the box", async () => {
  const { fieldSaver, pricesInto } = await import('../../src/ui/screens/model.js');
  const { modelOf, readConfig } = await import('../../src/core/llm/config.js');
  const { ws, rec } = await scheduledModel();
  const ctx = { ws, llm: { config: () => readConfig(ws), bench: { clear() {} } } };
  // The box's text is what is in effect; each edit changes one price in it.
  const current = async () => modelOf((await ctx.llm.config()).models[rec.id]).prices;
  const save = fieldSaver(/** @type {any} */ (ctx), rec.id);
  await save('prices', { .../** @type {any} */ (await current()), input: 0.5 });
  await save('prices', { .../** @type {any} */ (await current()), output: 3 });
  const prices = /** @type {any} */ (await current());
  const usage = { ...NO_USAGE, input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  close(costOf(usage, prices, [], Date.parse('2027-02-01T00:00:00Z')), 0.5 + 0.15 + 3); // input and output stay the user's; cacheRead follows the schedule
  assert.throws(() => pricesInto({ input: -1 }), /input is not a price/);
  assert.equal(pricesInto({}), null);
});

test("a model is free by the prices in force today: free that a past schedule made paid is not free, free until a date to come is", async () => {
  const { free } = await import('../../src/core/llm/providers.js');
  const { newProvider, newModel } = await import('../../src/core/llm/config.js');
  /** @param {string} from */
  const cfgFor = (from) => {
    const provider = newProvider('provider-x', { user: { name: 'X', abilities: { chat: { kind: 'chat', type: 'x' } } } });
    const model = newModel(provider.id, 'chat', { user: { providerId: 'm', prices: { input: 0, output: 0, schedule: [{ from, input: 1, output: 4 }] } } });
    return /** @type {any} */ ({ providers: { [provider.id]: provider }, models: { [model.id]: model }, roles: {} });
  };
  for (const [from, was] of [['2020-01-01', false], ['2999-01-01', true]]) {
    const cfg = cfgFor(String(from));
    assert.equal(free(cfg, Object.keys(cfg.models)[0]), was, String(from));
  }
});

// ---- Verification findings on prices: malformed schedules, a deleted schedule's stored form, an edited schedule against typed prices ----

/** The Prices box on a scheduled model: its text is the prices in effect, and each edit saves the box. */
async function priceBox() {
  const { fieldSaver, pricesInto } = await import('../../src/ui/screens/model.js');
  const { modelOf, readConfig } = await import('../../src/core/llm/config.js');
  const { ws, rec } = await scheduledModel();
  const ctx = { ws, llm: { config: () => readConfig(ws), bench: { clear() {} } } };
  const save = fieldSaver(/** @type {any} */ (ctx), rec.id);
  const stored = async () => (await readConfig(ws)).models[rec.id];
  const box = async () => JSON.parse(JSON.stringify(modelOf(await stored()).prices ?? {}));
  /** @param {(b: any) => void} change */
  const edit = async (change) => {
    const b = await box();
    change(b);
    await save('prices', pricesInto(b));
  };
  return { ws, rec, save, stored, box, edit, effective: async () => modelOf(await stored()).prices };
}
const AFTER = Date.parse('2027-01-02T00:00:00Z');

test('a malformed schedule is ignored, never thrown at: not a list, entries that are not objects, entries without a real date', async () => {
  const { catalogFacts } = await import('../../src/core/catalog-facts.js');
  for (const schedule of ['later', {}, 5, [null, 5, 'a', [], { from: 'soon', input: 9 }, { input: 9 }]]) {
    assert.deepEqual(pricesAt(/** @type {any} */ ({ input: 1, schedule }), AFTER), { input: 1 }, JSON.stringify(schedule));
  }
  assert.deepEqual(pricesAt(/** @type {any} */ ({ input: 1, schedule: [null, { from: '2027-01-01', input: 2 }] }), AFTER), { input: 2 });
  const facts = catalogFacts({ id: 'x', name: 'X', version: '1.0.0', api: 1, provider: { abilities: { a: { kind: 'chat', models: [{ providerId: 'p', prices: { input: 0, schedule: [null, 'x'] } }] } } } });
  assert.equal(facts.free, true);
});

test('deleting the schedule in the Prices box stores an empty list, which older builds accept; null on the user layer still reads as removed', async () => {
  const { modelOf } = await import('../../src/core/llm/config.js');
  const { rec, edit, stored, effective } = await priceBox();
  await edit((b) => { delete b.schedule; });
  assert.deepEqual((await stored()).user.prices, { schedule: [] });
  assert.equal(/** @type {any} */ (await effective()).schedule, undefined, 'no schedule in effect, and none shown');
  assert.equal(/** @type {any} */ (modelOf({ ...rec, user: { prices: { schedule: null } } }).prices).schedule, undefined);
});

test("a price the user typed wins over a schedule the user edited too: the user's entries lose the fields the user typed", async () => {
  const { edit, effective } = await priceBox();
  await edit((b) => { b.schedule[0].output = 9; });
  await edit((b) => { b.input = 0.4; });
  const prices = /** @type {any} */ (await effective());
  assert.deepEqual(pricesAtOf(prices), { input: 0.4, output: 9, cacheRead: 0.15 }, 'input stays 0.4; output and cacheRead follow the edited schedule');
});

/** @param {any} prices */
const pricesAtOf = (prices) => pricesAt(prices, AFTER);

test('the box emptied and a price typed again shows no schedule of nothing', async () => {
  const { edit, save, effective, box } = await priceBox();
  await save('prices', null);
  await edit((b) => { b.input = 1; });
  assert.deepEqual(await box(), { input: 1 });
  assert.equal(/** @type {any} */ (await effective()).schedule, undefined);
});

test('pricesProblem also flags a base name annai does not know and a bad tier', () => {
  assert.match(String(pricesProblem({ inptu: 3 })), /inptu.*isn't a price/);
  assert.equal(pricesProblem({ input: 1, tiers: [{ above: 200000, input: 2 }] }), null);
  assert.match(String(pricesProblem({ tiers: 'big' })), /tiers.*list/);
  assert.match(String(pricesProblem({ tiers: [{ above: 'x', input: 2 }] })), /tier.*above/);
  assert.match(String(pricesProblem({ tiers: [{ above: 100, input: -5 }] })), /input is not a price/);
  assert.match(String(pricesProblem({ schedule: [{ from: '2027-01-01', tiers: [{ above: 'x' }] }] })), /tier.*above/);
});

test("one save that changes a base price and the same price in a schedule entry keeps both: the entry's new value is the user's word for its date", async () => {
  const { edit, effective } = await priceBox();
  await edit((b) => { b.schedule[0].output = 9; }); // a schedule of the user's own
  await edit((b) => { b.input = 0.4; b.schedule[0].input = 2; });
  const prices = /** @type {any} */ (await effective());
  assert.equal(prices.input, 0.4, 'before the date');
  assert.deepEqual(pricesAtOf(prices), { input: 2, output: 9, cacheRead: 0.15 }, 'from the date the entry says 2');
});
