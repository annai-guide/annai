import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, key } from '../../src/core/l10n.js';
import { timeIn, deviceZone } from '../../src/core/time.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { callRole, candidates, Bench, AllFailedError, COOLDOWN_MS, continueAfter, failedText, restText } from '../../src/core/llm/fallback.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/** A fresh scripted endpoint type, as the plugin registers it. @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}

/**
 * A config with one provider per script, its chat ability scripted, one model on each, and those models in main.
 * @param {any[][]} scripts @param {{ models?: any[], types?: [string, any][] , endpointTypes?: string[], off?: number[] }} [opts]
 *   endpointTypes: each chat ability's type; off: the providers whose chat ability is switched off
 */
function setup(scripts, { models = [], types = [], endpointTypes = [], off = [] } = {}) {
  /** @type {any} */
  const config = { providers: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  scripts.forEach((script, i) => {
    const chat = { kind: 'chat', type: endpointTypes[i] ?? 'scripted', tunables: { script }, ...(off.includes(i) ? { on: false } : {}) };
    config.providers[`pv-${i}`] = { id: `pv-${i}`, plugin: 'provider-test', template: null, user: { name: `E${i}`, abilities: { chat } }, created: 0 };
    config.models[`m-${i}`] = { id: `m-${i}`, provider: `pv-${i}`, ability: 'chat', template: null, user: { providerId: `model-${i}`, prices: { input: 1, output: 1 }, ...(models[i] ?? {}) }, created: 0 };
    config.roles.main.models.push(`m-${i}`);
  });
  /** @type {number[]} */
  const waits = [];
  let clock = 1_000_000;
  const store = createMemoryStore();
  return {
    config, waits, store,
    bench: new Bench(),
    types: new Map([['scripted', scriptedType()], ...types]),
    tick: (/** @type {number} */ ms) => { clock += ms; },
    base: () => ({ config, types: undefined, bench: undefined, keyFor: async () => null, sleep: async (/** @type {number} */ ms) => { waits.push(ms); }, now: () => clock, trace: modelTrace(store, SYS) }),
  };
}
/** @type {any} */
const hello = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] };
/** @param {ReturnType<typeof setup>} s @param {any} [over] */
const call = (s, over = {}) => callRole({ ...s.base(), types: s.types, bench: s.bench, role: 'main', request: hello, ...over });

test('the first model that answers is the answer, with no fallback', async () => {
  const s = setup([[{ text: 'Hi from A.' }], [{ text: 'Hi from B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, 'Hi from A.');
  assert.equal(r.answeredBy, 'model-0');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['ok']);
});

test('out of credit: the next model answers, and the first one rests (benched) for a while', async () => {
  const s = setup([[{ error: 'credit', status: 402 }], [{ text: 'Hi from B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, 'Hi from B.');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'ok']);
  const again = await call(s);
  assert.deepEqual(again.attempts.map((a) => a.outcome), ['benched', 'ok']);
  s.tick(COOLDOWN_MS + 1);
  assert.deepEqual((await call(s)).attempts.map((a) => a.outcome), ['credit', 'ok']);
  const turns = (await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }))).map((e) => e.data.answeredBy);
  assert.deepEqual(turns, ['model-1', 'model-1', 'model-1']);
});

test('overloaded: two quick retries, then the next model', async () => {
  const s = setup([[{ error: 'overloaded' }, { error: 'overloaded' }, { text: 'Third time lucky.' }]]);
  assert.equal((await call(s)).reply.text, 'Third time lucky.');
  assert.deepEqual(s.waits, [500, 1500]);
  const t = setup([[{ error: 'overloaded' }], [{ text: 'B.' }]]);
  const r = await call(t);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['overloaded', 'overloaded', 'overloaded', 'ok']);
  assert.deepEqual(t.waits, [500, 1500]);
});

test('rate-limited: a short wait is waited out; a long one benches the model for that long', async () => {
  const s = setup([[{ error: 'rate', retryAfter: 2000 }, { text: 'After the wait.' }]]);
  assert.equal((await call(s)).reply.text, 'After the wait.');
  assert.deepEqual(s.waits, [2000]);
  const t = setup([[{ error: 'rate', retryAfter: 60_000 }], [{ text: 'B.' }]]);
  assert.equal((await call(t)).reply.text, 'B.');
  assert.deepEqual(t.waits, []);
  assert.equal(t.bench.until('m-0'), 1_000_000 + 60_000);
});

test("a connection failure while the device is offline benches nobody and isn't retried; online, it still benches (emulator pass)", async () => {
  const s = setup([[{ error: 'unreachable', message: 'Failed to fetch' }], [{ error: 'network', message: 'The connection dropped.' }]]);
  await assert.rejects(call(s, { online: () => false }), (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'unreachable,network');
  assert.deepEqual(s.waits, []);
  assert.equal(s.bench.until('m-0'), 0);
  assert.equal(s.bench.until('m-1'), 0);
  // Back online, the same failure is the model's (a server that is down): it rests, so turns don't wait on it.
  await assert.rejects(call(s, { online: () => true }));
  assert.ok(s.bench.until('m-0') > 1_000_000);
  assert.ok(s.bench.until('m-1') > 1_000_000);
});

test('why every model failed, for a card: one line per model, each reason once, in words, never a code (emulator pass)', () => {
  const busy = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.';
  const attempts = [
    { model: 'm-0', name: 'Gemini 3.8 Flash', outcome: 'overloaded', ms: 1, error: busy },
    { model: 'm-0', name: 'Gemini 3.8 Flash', outcome: 'overloaded', ms: 1, error: busy },
    { model: 'm-0', name: 'Gemini 3.8 Flash', outcome: 'overloaded', ms: 1, error: busy },
    { model: 'm-1', name: 'Gemini 3.6 Flash', outcome: 'benched', ms: 0 },
    { model: 'm-2', name: 'Gemini 3.5 Flash Lite', outcome: 'benched', ms: 0, error: 'its daily limit is used up; it rests until 17:00' },
    { model: 'm-3', name: 'step-5-preview', outcome: 'no-images', ms: 0 },
    { model: 'm-4', name: 'Gemini 3.8 Live', outcome: 'not-chat', ms: 0 },
    { model: 'm-5', name: 'Far away', outcome: 'unreachable', ms: 3, error: 'Failed to fetch' },
  ];
  const text = failedText(attempts);
  assert.deepEqual(text.split('\n'), [
    `Gemini 3.8 Flash: ${busy}`,
    'Gemini 3.6 Flash: It is resting for a few minutes after an error.',
    'Gemini 3.5 Flash Lite: Its daily limit is used up; it rests until 17:00.',
    "step-5-preview: It doesn't take photos.",
    "Gemini 3.8 Live: It isn't a chat model.",
    "Far away: annai couldn't reach this address. It may be down, or it may not allow web apps.",
  ]);
  assert.equal(text.split(busy).length - 1, 1, 'said once');
  for (const code of ['benched', 'no-images', 'not-chat', 'Failed to fetch']) assert.doesNotMatch(text, new RegExp(code));
  // With no connection, that is the reason; models that couldn't have answered anyway still say why.
  assert.deepEqual(failedText([attempts[5], attempts[7], { model: 'm-0', name: 'E0', outcome: 'network', ms: 1, error: 'The connection dropped.' }], { offline: true }).split('\n'),
    ['This device is offline.', "step-5-preview: It doesn't take photos."]);
});

test('a model that declines has still answered', async () => {
  const s = setup([[{ text: "I can't help with that." }], [{ text: 'B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, "I can't help with that.");
  assert.equal(r.attempts.length, 1);
});

test("models that can't take the request are skipped: photos, tools, a window too small", async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }], [{ text: 'C.' }], [{ text: 'D.' }]], {
    models: [{}, { input: ['text', 'image'], tools: false }, { input: ['text', 'image'], contextWindow: 10 }, { input: ['text', 'image'] }],
  });
  const request = {
    messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'What is this?' }] }],
    tools: [{ name: 'look', description: 'Look.', input: { type: 'object' } }],
  };
  const r = await call(s, { request });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['no-images', 'no-tools', 'too-long', 'ok']);
  assert.equal(r.reply.text, 'D.');
});

test('a model that takes no photos gets older ones as words, and is passed over only for a photo in the newest message (emulator pass)', async () => {
  /** @type {any[]} */
  const seen = [];
  const spy = /** @type {any} */ ({
    type: 'spy', name: 'Spy', pluginId: 'spy',
    run: async function* (/** @type {any} */ c) {
      seen.push(c.request);
      yield { type: 'text', text: 'From the text model.' };
      yield { type: 'stop', reason: 'end' };
    },
  });
  const s = setup([[{ error: 'credit', status: 402 }], []], { types: [['spy', spy]], endpointTypes: ['scripted', 'spy'], models: [{ input: ['text', 'image'] }, { input: ['text'] }] });
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/2026-10-18-1530.webp' };
  const older = { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Look at this' }, photo] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'sleep', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 't1', content: 'asleep' }, { type: 'text', text: "What's around here?" }] },
  ] };
  const r = await call(s, { request: older });
  assert.equal(r.reply.text, 'From the text model.');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'ok']);
  assert.deepEqual(seen[0].messages[0].parts, [{ type: 'text', text: 'Look at this' }, { type: 'text', text: '[a photo: /trip/files/2026-10-18-1530.webp]' }]);
  assert.equal(older.messages[0].parts[1], photo, "the request itself isn't changed: the next model may see photos");
  // The newest message is a photo: a model that can't see it can't answer it. The loop says so (newestPhoto); else the last line is read.
  const t = setup([[{ text: 'never' }]], { models: [{ input: ['text'] }] });
  await assert.rejects(call(t, { request: { ...older, newestPhoto: true } }), (e) => e instanceof AllFailedError && e.attempts[0].outcome === 'no-images');
  const asked = { messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 't1', content: 'asleep' }, { type: 'text', text: 'And this?' }, photo] }] };
  await assert.rejects(call(t, { request: asked }), (e) => e instanceof AllFailedError && e.attempts[0].outcome === 'no-images');
});

/** A PDF a tool's result brought, and a conversation that read it and went on. */
const pdf = { type: 'document', mediaType: 'application/pdf', data: 'AAAA', name: 'booking.pdf' };
/** @type {any} */
const older = { messages: [
  { role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'read', input: { path: '/trip/files/booking.pdf' } }] },
  { role: 'user', parts: [{ type: 'tool_result', id: 't1', content: 'The PDF.' }, pdf] },
  { role: 'assistant', parts: [{ type: 'text', text: 'Read it.' }] },
  { role: 'user', parts: [{ type: 'text', text: "What's around here?" }] },
] };

test('a model that reads no PDFs gets an older one as a note, and is passed over only for a PDF in the newest message (the second emulator pass)', async () => {
  /** @type {any[]} */
  const seen = [];
  const spy = /** @type {any} */ ({ type: 'spy', name: 'Spy', pluginId: 'spy', run: async function* (/** @type {any} */ c) { seen.push(c.request); yield { type: 'text', text: 'Fine.' }; yield { type: 'stop', reason: 'end' }; } });
  const s = setup([[{ error: 'credit', status: 402 }], []], { types: [['spy', spy]], endpointTypes: ['scripted', 'spy'], models: [{ input: ['text', 'pdf'] }, { input: ['text'] }] });
  const r = await call(s, { request: older });
  assert.equal(r.reply.text, 'Fine.');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'ok']);
  assert.deepEqual(seen[0].messages[1].parts[1], { type: 'text', text: '[a PDF: booking.pdf]' });
  assert.equal(older.messages[1].parts[1], pdf, "the request itself isn't changed: the next model may read PDFs");
  // The newest message holds the PDF: a model that can't read it can't answer it.
  const t = setup([[{ text: 'never' }]], { models: [{ input: ['text', 'image'] }] });
  const fresh = { messages: [older.messages[0], older.messages[1]] };
  await assert.rejects(call(t, { request: fresh }), (e) => e instanceof AllFailedError && e.attempts[0].outcome === 'no-documents' && /PDFs/.test(e.message + failedText(e.attempts)));
});

/** A model type that answers 'Booked.' and keeps each request it got. @param {any[]} seen */
const spyType = (seen) => /** @type {any} */ ({ type: 'spy', name: 'Spy', pluginId: 'spy', run: async function* (/** @type {any} */ c) { seen.push(c.request); yield { type: 'text', text: 'Booked.' }; yield { type: 'stop', reason: 'end' }; } });

test("a model a PDF in the newest message kept out is tried again once the rest failed, with what read made of it (the user's session, 2026-10-28)", async () => {
  /** @type {any[]} */ const seen = [];
  const s = setup([[{ error: 'credit', status: 402 }], []], { types: [['spy', spyType(seen)]], endpointTypes: ['scripted', 'spy'], models: [{ input: ['text', 'pdf'] }, { input: ['text'] }] });
  const fresh = { messages: [older.messages[0], older.messages[1]] };
  /** @type {any[]} */ const asked = [];
  const read = async (/** @type {any} */ part, /** @type {any} */ model) => { asked.push([part.type, model.providerId]); return [{ type: 'text', text: '[a PDF: booking.pdf] What it says (told by model-u, as you can\'t read PDFs): Flight AN 123.' }]; };
  const r = await call(s, { request: fresh, read });
  assert.equal(r.answeredBy, 'model-1');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'no-documents', 'ok']);
  assert.deepEqual(asked, [['document', 'model-1']]);
  assert.deepEqual(seen[0].messages[1].parts[1], { type: 'text', text: "[a PDF: booking.pdf] What it says (told by model-u, as you can't read PDFs): Flight AN 123." });
  assert.equal(fresh.messages[1].parts[1], pdf, 'the request itself is not changed');
});

test("read is asked only for the newest message's files: an older photo goes as words", async () => {
  /** @type {any[]} */ const seen = [];
  const s = setup([[]], { types: [['spy', spyType(seen)]], endpointTypes: ['spy'], models: [{ input: ['text'] }] });
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/2026-10-18-1530.webp' };
  const fresh = { type: 'image', mediaType: 'image/webp', data: 'BBBB', hash: 'h2', path: '/trip/files/new.webp' };
  const request = { newestPhoto: true, messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Look at this' }, photo] },
    { role: 'assistant', parts: [{ type: 'text', text: 'A beach.' }] },
    { role: 'user', parts: [{ type: 'text', text: "What's this?" }, fresh] },
  ] };
  /** @type {any[]} */ const asked = [];
  const read = async (/** @type {any} */ part, /** @type {any} */ model) => { asked.push([part.type, model.providerId]); return [{ type: 'text', text: `[a photo: ${part.path}] What it shows (described by model-u, as you can't see photos): A menu.` }]; };
  const r = await call(s, { request, read });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['no-images', 'ok']);
  assert.deepEqual(asked, [['image', 'model-0']]);
  assert.match(JSON.stringify(seen[0].messages), /"text":"\[a photo: \/trip\/files\/2026-10-18-1530\.webp\]"/);
  assert.deepEqual(seen[0].messages[2].parts[1], { type: 'text', text: "[a photo: /trip/files/new.webp] What it shows (described by model-u, as you can't see photos): A menu." });
});

test('a model passed over for another reason is not tried again: too long, switched off', async () => {
  const s = setup([[{ text: 'never' }], [{ text: 'never' }]], { models: [{ input: ['text', 'pdf'], contextWindow: 10 }, { input: ['text'] }], off: [1] });
  let n = 0;
  await assert.rejects(call(s, { request: { messages: [older.messages[0], older.messages[1]] }, read: async () => { n++; return []; } }),
    (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'too-long,off');
  assert.equal(n, 0);
});

test('newestDocument: false sends a newest PDF as a note, as newestPhoto: false does a photo', async () => {
  /** @type {any[]} */ const seen = [];
  const s = setup([[]], { types: [['spy', spyType(seen)]], endpointTypes: ['spy'], models: [{ input: ['text'] }] });
  const r = await call(s, { request: { messages: [older.messages[0], older.messages[1]], newestDocument: false } });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['ok']);
  assert.deepEqual(seen[0].messages[1].parts[1], { type: 'text', text: '[a PDF: booking.pdf]' });
});

test('a model that refuses a required tool call is asked again without it, and not asked with it again this session (review A1)', async () => {
  /** @type {any[]} */
  const seen = [];
  const strict = /** @type {any} */ ({
    type: 'strict', name: 'Strict', pluginId: 'strict',
    run: async function* (/** @type {any} */ c) {
      seen.push(c.request.toolRequired === true);
      if (c.request.toolRequired) throw new ProviderError('bad-request', "Invalid 'tool_choice': 'required' is not supported with this model.", { status: 400 });
      yield { type: 'tool_call', id: 't1', name: 'speak', input: { text: 'Hi.' } };
      yield { type: 'stop', reason: 'tool' };
    },
  });
  const s = setup([[]], { types: [['strict', strict]], endpointTypes: ['strict'] });
  const request = { ...hello, tools: [{ name: 'speak', description: 'Say.', input: { type: 'object' } }], toolRequired: true };
  const r = await call(s, { request });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['bad-request', 'ok']);
  assert.deepEqual(seen, [true, false]);
  assert.equal(s.bench.until('m-0'), 0, 'not benched: it answered');
  await call(s, { request });
  assert.deepEqual(seen, [true, false, false], 'remembered for the session');
  // Any other bad request is the model's answer as before: no second try.
  const t = setup([[{ error: 'bad-request', status: 400, message: 'messages: Field required' }], [{ text: 'B.' }]]);
  assert.deepEqual((await call(t, { request: { ...hello, toolRequired: true } })).attempts.map((a) => a.outcome), ['bad-request', 'ok']);
});

test('a reply cut off partway is continued by the next model, without repeating it (spec §9.6)', async () => {
  /** @type {any} */
  let seen = null;
  const spy = /** @type {any} */ ({
    type: 'spy', name: 'Spy', pluginId: 'spy',
    run: async function* (/** @type {any} */ c) {
      seen = c.request;
      yield { type: 'text', text: ' the old capital.' };
      yield { type: 'stop', reason: 'end' };
    },
  });
  const s = setup([[{ text: 'Kyoto is', cut: true }], []], { types: [['spy', spy]], endpointTypes: ['scripted', 'spy'] });
  /** @type {string[]} */
  const streamed = [];
  const r = await call(s, { onEvent: (/** @type {any} */ e) => { if (e.type === 'text') streamed.push(e.text); } });
  assert.equal(r.reply.text, 'Kyoto is the old capital.');
  assert.equal(streamed.join(''), 'Kyoto is the old capital.');
  assert.match(seen.messages.at(-1).parts[0].text, /You had already said: "Kyoto is✂"/);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['network', 'ok']);
  assert.equal(continueAfter(hello, 'x').messages.length, 2);
});

test('when every model fails: AllFailedError with every attempt, and the trace still has the turn', async () => {
  const s = setup([[{ error: 'credit' }], [{ error: 'auth' }]]);
  await assert.rejects(call(s), (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'credit,auth');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.answeredBy, null);
  assert.equal(turn.data.attempts.length, 2);
});

test('an empty chat role uses the main list; other roles have only their own', () => {
  /** @type {any} */
  const config = { roles: { main: { models: ['a', 'b'], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: ['c'], level: 'off' } } };
  assert.deepEqual(candidates(config, 'utility'), ['a', 'b']);
  assert.deepEqual(candidates(config, 'decide'), ['c']);
  assert.deepEqual(candidates(config, 'speech-out'), []);
});

test('stopping a call stops the fallback too', async () => {
  const s = setup([[{ delayMs: 1000, text: 'Too late.' }], [{ text: 'B.' }]]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(call(s, { signal: stop.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled');
});

test('stopping keeps what the model had said so far, in the error and in the trace (spec §6.7)', async () => {
  const sayThenWait = { type: 'hang', name: 'Hang', pluginId: 'hang', async *run() { yield { type: 'text', text: 'Kyoto is' }; await new Promise(() => {}); } };
  const s = setup([[]], { types: [['hang', sayThenWait]], endpointTypes: ['hang'] });
  const stop = new AbortController();
  await assert.rejects(call(s, { signal: stop.signal, onEvent: () => stop.abort() }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled' && e.partial === 'Kyoto is');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turn.data.stored, ['reply']);
  const blob = await s.store.tx(['blobs'], 'readonly', (t) => t.getBlob(turn.refs[0]));
  assert.equal(new TextDecoder().decode(blob?.data), 'Kyoto is');
});

test('a timeout benches the model and the next one answers', async () => {
  const s = setup([[{ delayMs: 500, text: 'Slow.' }], [{ text: 'B.' }]]);
  const r = await call(s, { firstOutputMs: 20 });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['timeout', 'ok']);
  assert.ok(s.bench.until('m-0') > 1_000_000);
});

test("a role's own wait for the first words decides when a slow model is passed over", async () => {
  const s = setup([[{ delayMs: 1500, text: 'Slow.' }], [{ text: 'B.' }]]);
  s.config.roles.main.firstOutputSeconds = 1;
  const r = await call(s);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['timeout', 'ok']);
});

test('the trace keeps what the answering model reasoned', async () => {
  const s = setup([[{ reasoning: 'They want a greeting.', text: 'Hi.' }]]);
  await call(s);
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turn.data.stored, ['reply', 'reasoning']);
});

test('a model whose endpoint type is missing is skipped', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { endpointTypes: ['gone', 'scripted'] });
  assert.deepEqual((await call(s)).attempts.map((a) => a.outcome), ['type-missing', 'ok']);
});

test('a model of a switched-off ability is skipped as off, and the next model answers', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { off: [0], endpointTypes: ['gone', 'scripted'] });
  const r = await call(s);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['off', 'ok']);
  assert.equal(r.reply.text, 'B.');
});

test("a provider's key goes to its abilities, once per provider; with keyHeader it goes in that header, and the protocol gets none (decision 25)", async () => {
  /** @type {any[]} */
  const seen = [];
  const spy = { type: 'spy', name: 'Spy', pluginId: 'spy', async *run(/** @type {any} */ c) { seen.push({ key: c.key, headers: c.endpoint.headers, id: c.endpoint.id }); yield { type: 'text', text: 'ok' }; } };
  const s = setup([[]], { types: [['spy', spy]], endpointTypes: ['spy'] });
  /** @type {string[]} */
  const asked = [];
  await call(s, { keyFor: async (/** @type {string} */ id) => { asked.push(id); return 'sk-test-1'; } });
  assert.deepEqual(asked, ['pv-0']);
  assert.deepEqual(seen.at(-1), { key: 'sk-test-1', headers: {}, id: 'pv-0/chat' });
  s.config.providers['pv-0'].user.keyHeader = 'api-key';
  await call(s, { keyFor: async () => 'sk-test-1' });
  assert.deepEqual(seen.at(-1), { key: null, headers: { 'api-key': 'sk-test-1' }, id: 'pv-0/chat' });
});

test('a request that needs a provider tool skips models without one', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { models: [{}, { providerTools: [{ id: 'f', name: 'Fetch', kind: 'fetch', patch: {} }] }] });
  const r = await call(s, { request: { ...hello, providerTools: { kinds: ['fetch'] }, needsProviderTool: 'fetch' } });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['no-provider-tool', 'ok']);
});

test('record: the model.turn carries the tag and wake, keeps the parts, and the result names the model', async () => {
  const s = setup([[{ text: 'Hi.', toolCalls: [{ name: 'sleep', input: {} }] }]]);
  const r = await call(s, { record: { tag: 'conversation', wake: 'w-1', keepParts: true } });
  assert.equal(r.modelId, 'm-0');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.tag, 'conversation');
  assert.equal(turn.data.wake, 'w-1');
  assert.deepEqual(turn.data.stored, ['reply', 'parts']);
  const blob = await s.store.tx(['blobs'], 'readonly', (t) => t.getBlob(turn.refs[1]));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(blob?.data)).map((/** @type {any} */ p) => p.type), ['text', 'tool_call']);
});

test('prefer: the model whose cache is warm is tried first (spec §9.6, switching back)', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]]);
  const r = await call(s, { prefer: 'm-1' });
  assert.equal(r.reply.text, 'B.');
  assert.deepEqual(r.attempts.map((a) => a.model), ['m-1']);
  assert.equal((await call(s, { prefer: 'm-gone' })).reply.text, 'A.');
});

test("a model turn names the role's first model, whichever was tried first: the Conversation's \"· … didn't answer\" is against it (the review of phone-fixes-1)", async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { off: [] });
  const warm = await call(s, { prefer: 'm-1' });
  assert.deepEqual([warm.answeredBy, warm.first, warm.tried], ['model-1', 'model-0', false], 'a warm model answered in its place: it was never asked');
  const plain = await call(s);
  assert.deepEqual([plain.first, plain.tried], ['model-0', true]);
  const turns = (await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }))).map((e) => [e.data.answeredBy, e.data.first]);
  assert.deepEqual(turns, [['model-1', 'model-0'], ['model-0', 'model-0']]);
});

test('an upload the provider no longer knows: the endpoint forgets its uploads, and the same model is tried once more (spec §9.9)', async () => {
  const s = setup([[{ error: 'upload', status: 404, message: 'File `file_1` not found.' }, { text: 'Seen.' }], [{ text: 'B.' }]]);
  let forgot = 0;
  const uploads = /** @type {any} */ ({ forget: async () => { forgot++; }, isOff: () => false, get: async () => null, set: async () => {}, off: () => {} });
  const r = await call(s, { uploads });
  assert.equal(r.reply.text, 'Seen.');
  assert.deepEqual(r.attempts.map((a) => [a.model, a.outcome]), [['m-0', 'upload'], ['m-0', 'ok']]);
  assert.equal(forgot, 1);
});

test("fix pass: a key sent in a header of its own (keyHeader) never reaches the trace, even under a header name that doesn't look like a credential and in an error that echoes it", async () => {
  const KEY = 'sk-test-access-code-0123456789';
  /** @type {any} */
  const echo = { type: 'echo', name: 'Echo', pluginId: 'echo', build: (/** @type {any} */ c) => ({ url: 'https://llm.example/v1/chat', headers: { ...c.endpoint.headers }, body: {} }), async *read() {} };
  const s = setup([[]], { types: [['echo', echo]], endpointTypes: ['echo'] });
  s.config.providers['pv-0'].user = { ...s.config.providers['pv-0'].user, baseUrl: 'https://llm.example/v1', keyHeader: 'X-Access-Code' };
  /** @type {any[]} */
  const sent = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    sent.push(init.headers);
    return new Response(JSON.stringify({ error: { message: `Bad X-Access-Code ${init.headers['X-Access-Code']}` } }), { status: 400 });
  };
  await assert.rejects(call(s, { keyFor: async () => KEY, fetch }));
  assert.equal(sent[0]['X-Access-Code'], KEY, 'the key went in its header');
  const events = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS));
  assert.ok(events.length > 0);
  assert.ok(!JSON.stringify(events).includes(KEY), 'no trace entry holds it');
});

test('a model that refuses the audio format it was sent gets the same request again with WAV, once; the trace says what each attempt carried (Koe and Kokoro design, "Audio formats")', async () => {
  const refusal = { error: 'bad-request', status: 400, message: 'Invalid value: ogg. Valid formats are: [wav, mp3]' };
  const s = setup([[refusal, { text: 'Heard you.' }], [{ text: 'B heard you.' }]], { models: [{ input: ['text', 'audio'] }, { input: ['text', 'audio'] }] });
  /** @type {boolean[]} */
  const plain = [];
  /** The heard speech as a resolver gives it: Ogg, or WAV when plain. @param {any} _m @param {any} _r @param {boolean} [wav] */
  const speech = async (_m, _r, wav) => {
    plain.push(Boolean(wav));
    return { messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: wav ? 'audio/wav' : 'audio/ogg', data: wav ? 'UklGRgAAAAA=' : 'T2dnUw==' }] }] };
  };
  const heard = { messages: [{ role: 'user', parts: [{ type: 'speech', id: 's-1' }] }] };
  const r = await call(s, { request: heard, speech });
  assert.equal(r.reply.text, 'Heard you.');
  assert.deepEqual(plain, [false, true]);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['bad-request', 'ok']);
  const sent = (await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }))).map((e) => e.data.audio);
  assert.deepEqual(sent, [[{ format: 'ogg', bytes: 4 }], [{ format: 'wav', bytes: 8 }]]);
  // WAV refused too, or a refusal of something else: the next model, as before.
  const t = setup([[refusal, refusal], [{ text: 'B heard you.' }]], { models: [{ input: ['text', 'audio'] }, { input: ['text', 'audio'] }] });
  plain.length = 0;
  assert.equal((await call(t, { request: heard, speech })).reply.text, 'B heard you.');
  assert.deepEqual(plain, [false, true, false]);
  const u = setup([[{ error: 'bad-request', status: 400, message: 'tools[0] is not valid' }], [{ text: 'B.' }]], { models: [{ input: ['text', 'audio'] }, { input: ['text', 'audio'] }] });
  plain.length = 0;
  assert.equal((await call(u, { request: heard, speech })).reply.text, 'B.');
  assert.deepEqual(plain, [false, false]);
});

test("Koe fix pass 10: a rest past 10 minutes (a provider's day limit) is said plainly, with when it ends, on the model's line, and while it rests", async () => {
  const t = setup([[{ error: 'rate', retryAfter: 18 * 3_600_000, message: 'You exceeded your current quota, please check your plan and billing details.' }], [{ text: 'B.' }]]);
  const r = await call(t);
  const until = new Date(1_000_000 + 18 * 3_600_000);
  assert.match(String(r.attempts[0].error), /^its daily limit is used up; it rests until .+/);
  assert.ok(String(r.attempts[0].error).includes(timeIn(until.getTime(), deviceZone()) ?? '?'), 'a 24-hour clock, as the models read times');
  assert.equal(r.attempts[0].restsUntil, until.getTime(), 'the attempt says when it rests until, for code to read');
  assert.doesNotMatch(String(r.attempts[0].error), /billing/);
  const again = await call(t);
  assert.deepEqual(again.attempts.map((a) => [a.outcome, a.error]), [['benched', r.attempts[0].error], ['ok', undefined]]);
  // A short rest keeps the provider's words.
  const s = setup([[{ error: 'rate', retryAfter: 60_000, message: 'Slow down.' }], [{ text: 'B.' }]]);
  assert.equal((await call(s)).attempts[0].error, 'Slow down.');
});

test("scripted rules: the request after the model's own tool results is a follow-up (its rule's `then`), whatever came with the results: words the other half said, or a wake that joined the turn with its reason in the tail", async () => {
  const type = scriptedType();
  const endpoint = { id: 'e-1', tunables: { rules: [{ match: 'the user wrote', reply: { toolCalls: [{ name: 'list', input: {} }] }, then: { text: 'Done.' } }] } };
  /** @param {any} request */
  const run = async (request) => {
    /** @type {any[]} */
    const out = [];
    for await (const ev of type.run({ endpoint, request })) out.push(ev);
    return out;
  };
  const results = { type: 'tool_result', id: 'scripted_0_0', content: 'ok' };
  const user = [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }];
  await run({ messages: user, tail: 'woke for: the user wrote\n' });
  const said = { type: 'text', text: '[Koe said] "I\'m checking."' };
  const after = (/** @type {any[]} */ parts, /** @type {string} */ tail) => run({ messages: [...user, { role: 'assistant', parts: [] }, { role: 'user', parts }], tail });
  const words = async (/** @type {any[]} */ parts, /** @type {string} */ tail) => (await after(parts, tail)).map((e) => e.text ?? '').join('');
  assert.equal(await words([results], 'connection: online\n'), 'Done.', 'results last');
  assert.equal(await words([results, said], 'connection: online\n'), 'Done.', 'a note after the results, no wake');
  assert.equal(await words([results, said], 'woke for: the weather changed\nconnection: online\n'), 'Done.', 'a wake that joined the turn, and no rule for it');
  /** @type {any[]} */ (endpoint.tunables.rules).push({ match: 'weather', reply: { text: 'Rain.' } });
  await run({ messages: user, tail: 'woke for: the user wrote\n' });
  assert.equal(await words([results, said], 'woke for: the weather changed\nconnection: online\n'), 'Rain.', 'a wake that joined the turn, and a rule for it');
  // Without results it is a new request, matched by what woke her: no rule here, so she sleeps.
  assert.equal(await words([said], 'woke for: a bell rang\n'), '');
});

test('a day limit\'s sentence is for models and code, so no language changes it; the card\'s sentence for the user is made when it is shown', async () => {
  const t = setup([[{ error: 'rate', retryAfter: 18 * 3_600_000, message: 'You exceeded your current quota.' }], [{ text: 'B.' }]]);
  const plain = restText(1_000_000 + 18 * 3_600_000, 1_000_000);
  setWords('en', null, (english) => `⟦${english}⟧`);
  try {
    const r = await call(t);
    assert.equal(r.attempts[0].error, plain, 'not made through t');
    assert.match(plain, /^its daily limit is used up; it rests until (\w+ )?\d\d:\d\d$/);
    const [rested] = (await call(t)).attempts;
    assert.equal(rested.outcome, 'benched');
    assert.equal(rested.restsUntil, r.attempts[0].restsUntil, 'a later turn, skipping the resting model, still says when');
    // The card says it in the screens\' words, whole, without changing any case.
    assert.match(failedText([rested], { now: 1_000_000, plain: true }), /^.+: Its daily limit is used up; it rests until [^⟦⟧]+\.$/, 'a model that reads it (a photo\'s stand-in) gets the English');
    // The model's name and its line are a label and its words: a message of their own ("{0}: {1}").
    assert.match(failedText([rested], { now: 1_000_000 }), /^⟦.+: ⟦Its daily limit is used up; it rests until .+\.⟧⟧$/);
  } finally {
    setWords('en', null);
  }
  const at = new Date(1_000_000 + 18 * 3_600_000);
  const shown = failedText([{ model: 'm', name: 'Gemini', outcome: 'benched', ms: 0, error: plain, restsUntil: at.getTime() }], { now: 1_000_000 });
  assert.match(shown, /^Gemini: Its daily limit is used up; it rests until .+\.$/);
  setWords('ja', { [key('Its daily limit is used up; it rests until {0}.')]: '1日の上限に達しました。{0}まで休みます。' });
  try {
    assert.match(failedText([{ model: 'm', name: 'Gemini', outcome: 'benched', ms: 0, error: plain, restsUntil: at.getTime() }], { now: 1_000_000 }), /^Gemini: 1日の上限に達しました。.+まで休みます。$/);
  } finally {
    setWords('en', null);
  }
});

test("a call stopped part-way costs what its provider had reported: the model turn and the day's spend count it (the second review of phone-fixes-1)", async () => {
  // A reply that reports its prompt's usage first (as Anthropic's message_start does), then is stopped before it finishes.
  const hang = { type: 'hang', name: 'Hang', tail: true, async *run(/** @type {any} */ { signal }) {
    yield { type: 'usage', usage: { input: 1_000_000, output: 0 } };
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  const s = setup([[{ text: 'unused' }]], { endpointTypes: ['hang'], types: [['hang', hang]] });
  const stop = new AbortController();
  const done = call(s, { signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(done, (/** @type {any} */ e) => e.kind === 'cancelled');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.cost, 1, '1M input tokens at $1 per million');
  assert.equal(turn.data.usage.input, 1_000_000);
});

test("the first model a line names is one that can answer: a model whose chat ability is off is passed over (the second review of phone-fixes-1)", async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { off: [0] });
  const r = await call(s);
  assert.deepEqual([r.answeredBy, r.first, r.tried], ['model-1', 'model-1', true]);
});

test("the first model, tried and failed: the line says it didn't answer", async () => {
  const s = setup([[{ error: 'auth', status: 401 }], [{ text: 'B.' }]]);
  const r = await call(s);
  assert.deepEqual([r.answeredBy, r.first, r.tried], ['model-1', 'model-0', true]);
});

test("a first model that never got the request (it can't read the PDF in it) wasn't tried: the line says another answered instead; a resting one was (third review of phone-fixes-1)", async () => {
  const pdf = { messages: [{ role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBE', name: 'stay.pdf' }, { type: 'text', text: 'Read it' }] }] };
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { models: [{ input: ['text'] }, { input: ['text', 'pdf'] }] });
  const r = await call(s, { request: pdf });
  assert.deepEqual([r.answeredBy, r.first, r.tried], ['model-1', 'model-0', false]);
  s.bench.bench('m-0', 60_000);
  const rested = await call(s);
  assert.deepEqual([rested.answeredBy, rested.first, rested.tried], ['model-1', 'model-0', true], 'resting: it "didn\'t answer"');
  // In a turn's own call too, where a resting model goes to the end and another answers first (round 9).
  const own = await call(s, { askResting: true });
  assert.deepEqual([own.answeredBy, own.first, own.tried], ['model-1', 'model-0', true]);
  assert.deepEqual(own.attempts.map((a) => `${a.model}:${a.outcome}`), ['m-0:benched', 'm-1:ok'], 'the Trace lists the resting model it never reached');
});

test("a call that times out or is cut off part-way costs what it had used too: the turn's cost counts it with the answer's (third review of phone-fixes-1)", async () => {
  for (const kind of /** @type {const} */ (['timeout', 'network'])) {
    const failing = { type: 'failing', name: 'Failing', tail: true, async *run() {
      yield { type: 'usage', usage: { input: 1_000_000, output: 0 } };
      throw new ProviderError(kind, `Scripted ${kind}.`);
    } };
    const s = setup([[{ text: 'unused' }], [{ text: 'B.', usage: { input: 0, output: 0 } }]], { endpointTypes: ['failing'], types: [['failing', failing]] });
    const r = await call(s);
    assert.equal(r.answeredBy, 'model-1');
    // Each call to the first model (a network failure is tried again) used a million input tokens, at $1.
    const first = r.attempts.filter((a) => a.model === 'm-0');
    assert.ok(first.length >= 1);
    assert.equal(r.cost, first.length, kind);
    assert.ok(first.every((a) => a.cost === 1));
  }
});

test("speech cut when another model starts over is named by the model that spoke it, not one passed over in between (the third review of phone-fixes-1, R1)", async () => {
  const cutting = { type: 'cutting', name: 'Cutting', tail: true, async *run() {
    yield { type: 'tool_input', id: 't1', name: 'speak', partial: '{"text":"Bixby Bridge is' };
    yield { type: 'text', text: 'Bixby ' };
    throw new ProviderError('network', 'The connection dropped.');
  } };
  const s = setup([[{ text: 'unused' }], [{ text: 'B.' }], [{ text: 'C.' }]], { endpointTypes: ['cutting'], types: [['cutting', cutting]] });
  s.bench.bench('m-1', 600_000, Date.now());
  /** @type {any[]} */
  const restarts = [];
  const r = await call(s, { onEvent: (/** @type {any} */ ev) => { if (ev.type === 'restart') restarts.push(ev.by); } });
  assert.equal(r.answeredBy, 'model-2');
  assert.ok(r.attempts.some((a) => a.model === 'm-1' && a.outcome === 'benched'), 'model-1 rested in between');
  assert.ok(restarts.length >= 1);
  assert.ok(restarts.every((by) => by.name === 'model-0'), JSON.stringify(restarts));
});

test("output that started and then stopped says so, not that none started (the real-PDF check, 2026-10-28)", async () => {
  const stalls = /** @type {any} */ ({ type: 'stalls', name: 'Stalls', pluginId: 'stalls', run: async function* (/** @type {any} */ c) {
    yield { type: 'text', text: 'Let me' };
    await new Promise((_, no) => c.signal?.addEventListener('abort', () => no(c.signal.reason)));
  } });
  const s = setup([[]], { types: [['stalls', stalls]], endpointTypes: ['stalls'] });
  await assert.rejects(call(s, { firstOutputMs: 1000 }), (e) => e instanceof AllFailedError && e.attempts[0].outcome === 'timeout' && /^Its output stopped for 1 second\.$/.test(e.attempts[0].error ?? '') && e.attempts[0].said?.code === 'paused');
});

test("when every model the role could use is resting, the one whose rest ends soonest is asked anyway (the real-PDF check: one stall failed the next turn; round 8)", async () => {
  const s = setup([[{ text: 'From model-0.' }], [{ text: 'From model-1.' }]]);
  s.bench.bench('m-1', 300_000, 1_000_000 - 60_000); // its rest ends first
  s.bench.bench('m-0', 300_000, 1_000_000 - 1_000);
  const r = await call(s, { askResting: true });
  assert.equal(r.answeredBy, 'model-1');
  assert.deepEqual(r.attempts.map((a) => `${a.model}:${a.outcome}`), ['m-0:benched', 'm-1:ok'], 'a resting model goes at the end of the list, the soonest first; the one not reached is in the Trace (round 9)');
  // Only a turn's own call: a side job (a reader, housekeeping, a plugin's call) fails as before (round 6).
  s.bench.bench('m-1', 300_000, 1_000_000);
  await assert.rejects(call(s), (e) => e instanceof AllFailedError && e.attempts.every((a) => a.outcome === 'benched'));
  // With a model that can answer, resting still passes the others over.
  const t = setup([[{ text: 'never' }], [{ text: 'From model-1.' }]]);
  t.bench.bench('m-0', 300_000, 1_000_000);
  assert.equal((await call(t, { askResting: true })).answeredBy, 'model-1');
});

// Round 7.
/** A spy type answering each model by its own script (one step per call), and keeping each request it gets, by model. */
function spyWorld(/** @type {{ input?: string[], images?: any, script?: any[] }[]} */ models) {
  /** @type {{ model: string, request: any }[]} */
  const seen = [];
  const n = new Map();
  const spy = /** @type {any} */ ({ type: 'spy', name: 'Spy', pluginId: 'spy', run: async function* (/** @type {any} */ c) {
    seen.push({ model: c.model.providerId, request: c.request });
    const i = n.get(c.model.providerId) ?? 0;
    n.set(c.model.providerId, i + 1);
    const script = c.endpoint?.tunables?.script ?? [];
    const step = script.length ? script[Math.min(i, script.length - 1)] : { text: `From ${c.model.providerId}.` };
    if (step.error) throw new ProviderError(step.error, step.error);
    yield { type: 'text', text: step.text };
    yield { type: 'stop', reason: 'end' };
  } });
  const s = setup(models.map((m) => m.script ?? []), { types: [['spy', spy]], endpointTypes: models.map(() => 'spy'), models: models.map((m) => ({ input: m.input ?? ['text'], ...(m.images ? { images: m.images } : {}) })) });
  return { s, seen };
}

test('the resting pass asks only a model that can take the request: the longest-resting text model is passed over for a photo (round 7)', async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'] }]);
  s.bench.bench('m-0', 300_000, 1_000_000 - 60_000);
  s.bench.bench('m-1', 300_000, 1_000_000 - 1_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const r = await call(s, { askResting: true, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What is this?' }] }] } });
  assert.equal(r.answeredBy, 'model-1');
  assert.deepEqual(seen.map((x) => x.model), ['model-1']);
});

test('with read, a resting model that can take the request as it is goes before one that needs its files read (rounds 7 and 8)', async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'] }]);
  s.bench.bench('m-0', 300_000, 1_000_000 - 60_000);
  s.bench.bench('m-1', 300_000, 1_000_000 - 1_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const read = async () => [{ type: 'text', text: '[a photo: /trip/files/menu.webp] It shows a menu.' }];
  const r = await call(s, { askResting: true, read, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What is this?' }] }] } });
  assert.equal(r.answeredBy, 'model-1');
  assert.deepEqual(seen.map((x) => x.model), ['model-1']);
  // With no resting model that sees photos, the text one is asked with the photo read.
  const t = spyWorld([{ input: ['text'] }, { input: ['text'] }]);
  t.s.bench.bench('m-0', 300_000, 1_000_000 - 60_000);
  t.s.bench.bench('m-1', 300_000, 1_000_000 - 1_000);
  const u = await call(t.s, { askResting: true, read, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What is this?' }] }] } });
  assert.equal(u.answeredBy, 'model-0');
  assert.match(JSON.stringify(t.seen[0].request.messages), /It shows a menu/);
});

test('a model resting from before is asked when the one tried in this call failed and now rests too (round 7)', async () => {
  const { s, seen } = spyWorld([{ script: [{ error: 'overloaded' }] }, { script: [{ text: 'From model-1.' }] }]);
  s.bench.bench('m-1', 300_000, 1_000_000 - 60_000);
  const r = await call(s, { askResting: true });
  assert.equal(r.answeredBy, 'model-1');
  assert.equal(seen.at(-1).model, 'model-1');
});

test('a model asked anyway that answers rests no more: the next call asks it first again (round 7)', async () => {
  const { s } = spyWorld([{}, {}]);
  s.bench.bench('m-0', 400_000, 1_000_000 - 200_000);
  s.bench.bench('m-1', 400_000, 1_000_000 - 100_000);
  assert.equal((await call(s, { askResting: true })).answeredBy, 'model-0');
  assert.equal(s.bench.until('m-0'), 0);
  const next = await call(s, { askResting: true });
  assert.deepEqual(next.attempts.map((a) => `${a.model}:${a.outcome}`), ['m-1:benched', 'm-0:ok'], 'the primary answers at once; the other still rests');
});

test("the second pass's pictures go once: a page the read returns that an earlier message holds stays there, the later copy said once (round 7)", async () => {
  const { s, seen } = spyWorld([{ input: ['text', 'image'] }]);
  const page = { type: 'image', mediaType: 'image/jpeg', data: 'AAAA', hash: 'h1', page: 1 };
  const request = { messages: [
    { role: 'user', parts: [{ type: 'text', text: '[a PDF: booking.pdf] Its pages as pictures: page 1 of 1.' }, page] },
    { role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', hash: 'd1', name: 'booking.pdf' }, { type: 'text', text: 'Read the booking' }] },
  ] };
  const read = async () => [{ type: 'text', text: '[a PDF: booking.pdf] Its pages as pictures: page 1 of 1.' }, { ...page }];
  await call(s, { request, read });
  const images = seen[0].request.messages.flatMap((/** @type {any} */ m) => m.parts.filter((/** @type {any} */ p) => p.type === 'image'));
  assert.equal(images.length, 1);
  assert.equal(seen[0].request.messages[0].parts[1].type, 'image', 'the earlier copy stays');
});

// Round 8.
test("a dead model asked anyway doesn't stay first: whose rest ends soonest is asked, so the choice turns to the other (round 8, S1)", async () => {
  const { s, seen } = spyWorld([{ script: [{ error: 'timeout' }] }, { script: [{ error: 'timeout' }, { text: 'B is back.' }] }]);
  s.bench.bench('m-0', 180_000, 1_000_000 - 60_000); // A rests from an earlier turn
  await assert.rejects(call(s, { askResting: true }), AllFailedError); // B fails; A is asked anyway, fails
  let clock = 1_000_000;
  /** @type {any} */ let answered = null;
  for (let turn = 2; turn <= 6 && !answered; turn++) {
    clock += 30_000;
    answered = await call(s, { askResting: true, now: () => clock }).catch(() => null);
  }
  assert.equal(answered?.answeredBy, 'model-1', 'B is asked again, and answers');
  assert.ok(seen.filter((x) => x.model === 'model-1').length >= 2);
});

test('a model resting on a long rest the provider stated is never asked anyway (round 8)', async () => {
  const { s, seen } = spyWorld([{}]);
  s.bench.bench('m-0', 3_600_000, 1_000_000 - 1_000, 'It is resting until 17:00 (its daily limit).');
  await assert.rejects(call(s, { askResting: true }), AllFailedError);
  assert.equal(seen.length, 0);
});

test("a candidate that can't take the request for another reason (too long) isn't read for: no reading wasted (round 8, S4)", async () => {
  const { s } = spyWorld([{ input: ['text'] }, { input: ['text'] }]);
  s.config.models['m-0'].user.contextWindow = 5;
  let reads = 0;
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const read = async () => { reads++; return [{ type: 'text', text: '[a photo] It shows a menu.' }]; };
  const r = await call(s, { read, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What is this? '.repeat(20) }] }] } });
  assert.equal(r.answeredBy, 'model-1');
  assert.equal(reads, 1, 'read only for the model that then answered');
});

test("each model gets its photo limit of the raw request's distinct pictures, the newest first, each sent once at its earliest place (round 8, D1)", async () => {
  const { s, seen } = spyWorld([{ input: ['text', 'image'], images: { maxCount: 1 } }]);
  const photo = (/** @type {string} */ hash, /** @type {string} */ path) => ({ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash, path });
  const request = { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Here is the menu' }, photo('hA', '/trip/files/menu.webp')] },
    { role: 'user', parts: [{ type: 'text', text: 'And the hotel' }, photo('hB', '/trip/files/hotel.webp')] },
    { role: 'user', parts: [{ type: 'text', text: 'Look at the menu again' }, photo('hA', '/trip/files/menu.webp')] },
  ] };
  await call(s, { request });
  const shown = seen[0].request.messages.map((/** @type {any} */ m) => m.parts.map((/** @type {any} */ p) => (p.type === 'image' ? p.hash : p.text)));
  assert.deepEqual(shown, [
    ['Here is the menu', 'hA'],
    ['And the hotel', '[photo /trip/files/hotel.webp, not sent again: read it to see it]'],
    ['Look at the menu again', '[photo /trip/files/menu.webp, the same as above]'],
  ]);
});

// Round 9.
test("the second pass's check before reading counts the model's photo limit, not every picture (round 9, N7)", async () => {
  const { s, seen } = spyWorld([{ input: ['text', 'image'], images: { maxCount: 2 } }]);
  s.config.models['m-0'].user.contextWindow = 8000;
  let reads = 0;
  const older = Array.from({ length: 10 }, (_, i) => ({ role: 'user', parts: [{ type: 'text', text: `photo ${i}` }, { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: `h${i}`, path: `/trip/files/${i}.webp` }] }));
  const request = { messages: [...older, { role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', hash: 'd1', name: 'booking.pdf' }, { type: 'text', text: 'When is my flight?' }] }] };
  const read = async () => { reads++; return [{ type: 'text', text: '[a PDF: booking.pdf] What it says: flight AN 123 at 08:05.' }]; };
  const r = await call(s, { read, request });
  assert.equal(r.answeredBy, 'model-0');
  assert.equal(reads, 1);
  assert.equal(seen.length, 1);
});

test("models that aren't resting have both passes before a resting one is asked: a dead photo model at rest doesn't hold up every photo turn (round 9, N2)", async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'timeout' }] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 10_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const read = async () => [{ type: 'text', text: '[a photo] It shows a menu.' }];
  const r = await call(s, { askResting: true, read, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] } });
  assert.equal(r.answeredBy, 'model-0');
  assert.deepEqual(seen.map((x) => x.model), ['model-0'], 'the resting photo model was never asked');
});

test('the second pass never reads for a resting model once another resting model was asked (round 9, N1)', async () => {
  const { s } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'timeout' }] }]);
  s.bench.bench('m-0', 300_000, 1_000_000 - 200_000);
  s.bench.bench('m-1', 300_000, 1_000_000 - 1_000);
  let reads = 0;
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const read = async () => { reads++; return [{ type: 'text', text: '[a photo] It shows a menu.' }]; };
  await assert.rejects(call(s, { askResting: true, read, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] } }), AllFailedError);
  assert.equal(reads, 0);
});

test('a refused photo count is repaired though the request carries kept pages: the model gets what the repair allowed (round 9)', async () => {
  /** @type {number[]} */ const sizes = [];
  const strict = /** @type {any} */ ({ type: 'strict', name: 'Strict', pluginId: 'strict', run: async function* (/** @type {any} */ c) {
    const n = c.request.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image').length;
    sizes.push(n);
    if (n > 3) throw new ProviderError('image', 'Too many images: at most 3 images per request.');
    yield { type: 'text', text: 'ok' };
    yield { type: 'stop', reason: 'end' };
  } });
  const s = setup([[]], { types: [['strict', strict]], endpointTypes: ['strict'], models: [{ input: ['text', 'image'] }] });
  const { limitImages } = await import('../../src/core/agent/refusals.js');
  const img = (/** @type {string} */ hash) => ({ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash, path: `/trip/files/${hash}.webp` });
  const pages = [1, 2, 3].map((n) => ({ mediaType: 'image/jpeg', data: 'AAAA', hash: `P${n}`, page: n }));
  const request = { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'two photos' }, img('A'), img('B')] },
    { role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', hash: 'd1', name: 'booking.pdf' }, { type: 'text', text: 'my booking' }] },
    { role: 'user', parts: [{ type: 'text', text: 'When is the flight?' }] },
  ] };
  const readings = (/** @type {string} */ hash, /** @type {boolean} */ sees) => (hash === 'd1' && sees ? { text: 'Its pages as pictures: pages 1–3 of 3.', images: pages } : null);
  const repairImages = async (/** @type {any} */ _e, /** @type {string} */ _id, /** @type {any} */ req) => ({ ...req, messages: limitImages(req.messages, 3) });
  const r = await call(s, { request, readings, repairImages });
  assert.equal(r.answeredBy, 'model-0');
  assert.deepEqual(sizes, [5, 3]);
});

// Round 10.
test("a repair is that model's own: the next model gets the request as the conversation holds it (round 10)", async () => {
  /** @type {Record<string, any[]>} */ const got = {};
  const spy = /** @type {any} */ ({ type: 'spy', name: 'Spy', pluginId: 'spy', run: async function* (/** @type {any} */ c) {
    const id = c.model.providerId;
    const parts = c.request.messages.flatMap((/** @type {any} */ m) => m.parts);
    (got[id] ??= []).push(parts.map((/** @type {any} */ p) => (p.type === 'image' ? `IMG:${p.hash}` : p.type === 'document' ? 'DOC' : String(p.text ?? p.type).slice(0, 80))));
    if (id === 'model-0' && parts.filter((/** @type {any} */ p) => p.type === 'image').length > 3) throw new ProviderError('image', 'Too many images: at most 3 images per request.');
    if (id !== 'model-2') throw new ProviderError('timeout', 'stalled');
    yield { type: 'text', text: `ok from ${id}` };
    yield { type: 'stop', reason: 'end' };
  } });
  const s = setup([[], [], []], { types: [['spy', spy]], endpointTypes: ['spy', 'spy', 'spy'], models: [{ input: ['text', 'image'] }, { input: ['text', 'image', 'pdf'] }, { input: ['text'] }] });
  const { limitImages } = await import('../../src/core/agent/refusals.js');
  const img = (/** @type {string} */ hash) => ({ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash, path: `/trip/files/${hash}.webp` });
  const pages = [1, 2, 3].map((n) => ({ mediaType: 'image/jpeg', data: 'AAAA', hash: `P${n}`, page: n }));
  const request = { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'two photos' }, img('A'), img('B')] },
    { role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', hash: 'd1', name: 'booking.pdf' }, { type: 'text', text: 'my booking' }] },
    { role: 'user', parts: [{ type: 'text', text: 'When is the flight?' }] },
  ] };
  const readings = (/** @type {string} */ hash, /** @type {boolean} */ sees) => (hash !== 'd1' ? null : sees ? { text: 'Its pages as pictures: pages 1–3 of 3.', images: pages } : { text: 'What it says: flight AN 123 at 08:05.', images: [] });
  const repairImages = async (/** @type {any} */ _e, /** @type {string} */ _id, /** @type {any} */ req) => ({ ...req, messages: limitImages(req.messages, 3) });
  const r = await call(s, { request, readings, repairImages });
  assert.equal(r.answeredBy, 'model-2');
  assert.deepEqual(got['model-1'][0], ['two photos', 'IMG:A', 'IMG:B', 'DOC', 'my booking', 'When is the flight?'], 'the PDF reader gets the document and both photos');
  assert.ok(got['model-2'][0].some((/** @type {string} */ x) => /flight AN 123/.test(x)), "the text model gets the booking's kept words");
});

test("when an awake model's reading of the file failed, a resting model that takes the file as it is is asked first (round 10, R1)", async () => {
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const request = { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described: model-1 is resting." }], { unread: true });
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 10_000);
  const r = await call(s, { askResting: true, read: failed, request });
  assert.equal(r.answeredBy, 'model-1', 'the resting photo model answers from the photo');
  assert.deepEqual(seen.map((x) => x.model), ['model-1']);
  // If it fails too, the awake model answers with the failed reading, as before.
  const t = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'timeout' }] }]);
  t.s.bench.bench('m-1', 180_000, 1_000_000 - 10_000);
  const u = await call(t.s, { askResting: true, read: failed, request });
  assert.equal(u.answeredBy, 'model-0');
  assert.match(JSON.stringify(t.seen.at(-1).request.messages), /It couldn't be described/);
});

// Round 11.
test("the hold-back asks a resting photo model that reads no PDFs, when the older PDF would go to it as its note (round 11, B3)", async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 10_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described." }], { unread: true });
  const request = { messages: [
    { role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', hash: 'd1', name: 'booking.pdf' }, { type: 'text', text: 'my booking' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Got it.' }] },
    { role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] },
  ] };
  const r = await call(s, { askResting: true, read: failed, request });
  assert.equal(r.answeredBy, 'model-1');
  assert.deepEqual(seen.map((x) => x.model), ['model-1']);
});

test("the hold-back counts only a resting model that would be asked: one too long doesn't hold the awake model back (round 11, B4)", async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'] }, { input: ['text'], script: [{ error: 'timeout' }] }]);
  s.config.models['m-1'].user.contextWindow = 5;
  s.bench.bench('m-1', 180_000, 1_000_000 - 20_000);
  s.bench.bench('m-2', 180_000, 1_000_000 - 10_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described." }], { unread: true });
  const r = await call(s, { askResting: true, read: failed, request: { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say? '.repeat(10) }] }] } });
  assert.equal(r.answeredBy, 'model-0');
  assert.deepEqual(seen.map((x) => x.model), ['model-0'], 'no resting model was waited on');
});

test("a resting model that failed when asked doesn't hold an awake model back again in this rest: no wait on every photo turn (rounds 11 and 12, T1)", async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'timeout' }] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 10_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described." }], { unread: true });
  const request = { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] };
  assert.equal((await call(s, { askResting: true, read: failed, request })).answeredBy, 'model-0');
  assert.deepEqual(seen.map((x) => x.model), ['model-1', 'model-0'], 'tried once, while it rests');
  seen.length = 0;
  assert.equal((await call(s, { askResting: true, read: failed, request })).answeredBy, 'model-0');
  assert.deepEqual(seen.map((x) => x.model), ['model-0'], 'not held for again in the same rest: the text model answers at once');
});

test('two resting photo models, the first dead: the first turn tries it and answers blind; the next turn asks the live one (round 11, T3)', async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'timeout' }] }, { input: ['text', 'image'] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 20_000); // its rest ends first
  s.bench.bench('m-2', 180_000, 1_000_000 - 10_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described." }], { unread: true });
  const request = { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] };
  const first = await call(s, { askResting: true, read: failed, request });
  assert.equal(first.answeredBy, 'model-0');
  assert.deepEqual(seen.map((x) => x.model), ['model-1', 'model-0']);
  seen.length = 0;
  const next = await call(s, { askResting: true, read: failed, request });
  assert.equal(next.answeredBy, 'model-2');
  assert.deepEqual(seen.map((x) => x.model), ['model-2']);
});

// Round 12.
test("the only model, resting after two stalls, is still asked once a turn: the next turn answers as soon as the server is back (round 12, T1)", async () => {
  const { s, seen } = spyWorld([{ script: [{ error: 'timeout' }, { error: 'timeout' }, { text: 'Back.' }] }]);
  let clock = 1_000_000;
  const turn = () => call(s, { askResting: true, now: () => clock });
  await assert.rejects(turn(), AllFailedError); // stalls: it rests
  clock += 10_000;
  await assert.rejects(turn(), AllFailedError); // asked while resting, stalls again
  clock += 10_000;
  const r = await turn(); // the server is back: asked, not failed at once as "resting"
  assert.equal(r.answeredBy, 'model-0');
  assert.equal(seen.length, 3);
});

test('asked while resting and offline: the failure renews no rest, so nothing marks it, and it is asked when the connection is back (round 12, T3)', async () => {
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described." }], { unread: true });
  const request = { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] };
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'network' }, { text: 'A menu.' }] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 10_000);
  let online = false;
  await call(s, { askResting: true, read: failed, request, online: () => online }); // offline: the photo model's ask fails, the text model answers blind
  assert.equal(s.bench.triedResting('m-1'), false);
  online = true;
  seen.length = 0;
  const r = await call(s, { askResting: true, read: failed, request, online: () => online });
  assert.equal(r.answeredBy, 'model-1', 'asked again once online, held for as before');
});

test("two resting photo models, the first dead on a short rest: turn 2 asks the live one, as a model that failed when asked goes after the other resting ones (round 12, T3-2turns)", async () => {
  const { s, seen } = spyWorld([{ input: ['text'] }, { input: ['text', 'image'], script: [{ error: 'overloaded' }] }, { input: ['text', 'image'] }]);
  s.bench.bench('m-1', 180_000, 1_000_000 - 60_000); // its rest ends first
  s.bench.bench('m-2', 300_000, 1_000_000 - 60_000);
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1', path: '/trip/files/menu.webp' };
  const failed = async () => Object.assign([{ type: 'text', text: "[a photo: /trip/files/menu.webp] It couldn't be described." }], { unread: true });
  const request = { messages: [{ role: 'user', parts: [photo, { type: 'text', text: 'What does this menu say?' }] }] };
  assert.equal((await call(s, { askResting: true, read: failed, request })).answeredBy, 'model-0');
  seen.length = 0;
  const next = await call(s, { askResting: true, read: failed, request, now: () => 1_030_000 });
  assert.equal(next.answeredBy, 'model-2');
  assert.deepEqual(seen.map((x) => x.model), ['model-2']);
});
