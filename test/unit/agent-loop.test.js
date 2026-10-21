import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { TALK_TAG, record } from '../../src/core/agent/log.js';
import { createTrip } from '../../src/core/scopes.js';
import { Agent } from '../../src/core/agent/loop.js';
import { NETWORK_RETRIES } from '../../src/core/llm/fallback.js';
import { updateAppSettings } from '../../src/core/settings.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

test('a typed message wakes Shiori; she speaks and sleeps; the whole turn is in the log, and survives a reload', async () => {
  const k = await agentKit([[say('Nepenthe is 25 minutes south.')]]);
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (s) => states.push(s.name));
  k.agent.send('Where should we eat?');
  await k.agent.idle();
  const types = (await k.events()).map((e) => e.type).filter((t) => !['scope.create', 'file.write', 'net.request'].includes(t));
  assert.deepEqual(types, ['wake', 'msg.user', 'model.turn', 'tool.call', 'out.speak', 'tool.result', 'tool.call', 'tool.result']);
  const speak = (await k.events(['out.speak']))[0];
  assert.equal(speak.data.text, 'Nepenthe is 25 minutes south.');
  assert.deepEqual(states.at(0), 'thinking');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
  assert.match(k.requests[0].tail, /^<now>/);
  assert.deepEqual(k.requests[0].tools.map((/** @type {any} */ t) => t.name).slice(0, 5), ['speak', 'show', 'ask', 'wait', 'sleep']);
});

test('tool calls run in order, sleep last, and every call gets a result', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }, { name: 'write', input: { path: '/trip/notes/a.md', content: 'x' } }, { name: 'speak', input: { text: 'Noted.' } }] }]]);
  k.agent.send('Note x');
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.deepEqual(results.map((e) => e.data.name), ['write', 'speak', 'sleep']);
  assert.deepEqual(k.agent.transcript.open(), []);
});

test('fallback across two providers: the first is out of credit, the second answers (spec §9.6)', async () => {
  const k = await agentKit([[{ error: 'credit', status: 402 }], [say('Here.')]]);
  k.agent.send('Hi');
  await k.agent.idle();
  const [turn] = await k.events(['model.turn']);
  assert.deepEqual(turn.data.attempts.map((/** @type {any} */ a) => a.outcome), ['credit', 'ok']);
  assert.equal(turn.data.tag, TALK_TAG);
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Here.');
});

test('ask waits for a tap; a later step continues with the answer', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] }, say('Kept.')]]);
  k.agent.send('We are running late');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(k.agent.state.name, 'waiting');
  const [asked] = await k.events(['tool.call']);
  k.agent.answer(asked.data.id, 'Keep it');
  await k.agent.idle();
  const result = (await k.events(['tool.result']))[0];
  assert.equal(result.data.content, 'The user chose: Keep it');
  assert.equal(k.requests.length, 2);
});

test('typing answers a pending ask, and is not repeated as its own message', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['A', 'B'] } }] }, say('OK.')]]);
  k.agent.send('Start');
  await new Promise((r) => setTimeout(r, 30));
  k.agent.send('Neither, the café');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result']))[0].data.content, 'The user wrote: Neither, the café');
  const texts = JSON.stringify(k.requests[1].messages);
  assert.equal(texts.split('Neither, the café').length - 1, 1);
});

test('typing while she works arrives at her next call as "meanwhile" (spec §6.1)', async () => {
  const k = await agentKit([[{ delayMs: 40, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Both noted.')]]);
  k.agent.send('First thing');
  await new Promise((r) => setTimeout(r, 10));
  k.agent.send('Second thing');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  const last = k.requests[1].messages.at(-1);
  assert.deepEqual(last.parts.map((/** @type {any} */ p) => p.type), ['tool_result', 'text']);
  assert.equal(last.parts[1].text, '[meanwhile, the user wrote] Second thing');
});

test('wait returns what the user typed, or that nothing came', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Ready?' } }, { name: 'wait', input: { seconds: 3 } }] }, { toolCalls: [{ name: 'wait', input: { seconds: 1 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  k.agent.send('Go');
  await new Promise((r) => setTimeout(r, 15));
  k.agent.send('Yes!');
  await k.agent.idle();
  const waits = (await k.events(['tool.result'])).filter((e) => e.data.name === 'wait');
  assert.deepEqual(waits.map((e) => e.data.content), ['The user wrote: Yes!', 'Nothing yet (1 seconds).']);
});

test('tapping Shiori stops a hanging tool and the turn; every call still has a result (spec §6.7)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'hang', input: {} }, { name: 'speak', input: { text: 'Never said.' } }] }]]);
  /** @type {() => void} */
  let started = () => {};
  const hanging = new Promise((r) => { started = () => r(undefined); });
  k.registry.add('test', 'tool', { name: 'hang', description: 'Never ends.', input: { type: 'object' }, run: () => { started(); return new Promise(() => {}); } });
  k.agent.send('Go');
  await hanging; // the tap comes while the tool hangs, however long the turn took to reach it (it flaked at a fixed 20 ms under load)
  k.agent.interrupt();
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.deepEqual(results.map((e) => [e.data.name, e.data.content]), [['hang', 'Stopped by the user.'], ['speak', 'Stopped by the user.']]);
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal(k.agent.state.name, 'sleeping');
});

test("no model answers: a system card, never in Shiori's voice", async () => {
  const k = await agentKit([[{ error: 'auth', status: 401 }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.notices[0].title, "Shiori can't reach her model");
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal((await k.events(['error']))[0].data.kind, 'model');
});

test('a reload before Shiori answered: the message still gets its answer', async () => {
  const k = await agentKit([[say('Yes, here.')]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Are you there?', wake: 'w-0' } });
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Yes, here.');
  assert.match(JSON.stringify(k.requests[0].messages), /Are you there\?/);
});

test('a reload mid-turn: open tool calls get "interrupted by app restart", then a catch-up wake runs (spec §6.7)', async () => {
  const k = await agentKit([[say('Back again.')]], { open: false });
  await modelTrace(k.store, k.trip).turn({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0' }, '', '',
    [{ type: 'tool_call', id: 'f1', name: 'fetch', input: { url: 'https://x' } }]);
  await k.agent.open(k.trip);
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.equal(results[0].data.content, 'interrupted by app restart');
  const wakes = await k.events(['wake']);
  assert.equal(wakes[0].data.reasons[0].kind, 'restart');
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Back again.');
});

test("with the model's own search, Shiori's request has no web_search of annai's and asks for the provider's", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { models: [{ providerTools: [{ id: 'p-search', name: 'S', kind: 'search', patch: {} }] }] });
  k.host && await k.host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  k.agent.send('Hi');
  await k.agent.idle();
  const names = k.requests[0].tools.map((/** @type {any} */ t) => t.name);
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('fetch'), true);
  assert.deepEqual(k.requests[0].providerTools, { kinds: ['search'], off: [] });
});

test("on a key marked free tier, a paid-only search isn't the model's own (G4): Shiori keeps annai's web_search, and asks for none", async () => {
  const { readConfig, saveProvider } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { models: [{ providerTools: [{ id: 'g-search', name: 'Google Search', kind: 'search', patch: {}, paidOnly: true }] }] });
  const rec = (await readConfig(k.ws)).providers['pv-0'];
  await saveProvider(k.ws, { ...rec, user: { ...rec.user, free: true } });
  await k.host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.requests[0].tools.some((/** @type {any} */ t) => t.name === 'web_search'), true);
  assert.equal(k.requests[0].providerTools, undefined);
});

test("a reply grounded in the provider's own search is logged for the conversation as it came (G4: \"From Google Search\"), its suggestions kept as a blob the entry names", async () => {
  const k = await agentKit([[{ text: 'Open till 10.', toolCalls: [{ name: 'sleep', input: {} }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  const html = `<div class="container">${'<a class="chip" href="https://www.google.com/search?q=nepenthe">nepenthe</a>'.repeat(40)}</div>`;
  const scripted = k.llm.types().get('scripted');
  const run = scripted.run;
  let once = true;
  scripted.run = async function* (/** @type {any} */ c) {
    for await (const e of run(c)) {
      if (e.type === 'stop' && once) yield { type: 'attribution', source: 'Google Search', text: 'Open till 10.', links: [{ url: 'https://nepenthe.com', title: 'nepenthe.com' }, { url: 'javascript:alert(1)', title: 'x' }, { title: 'no address' }], html };
      if (e.type === 'stop') once = false;
      yield e;
    }
  };
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  const [g, more] = await k.events(['grounded']);
  assert.equal(more, undefined, 'one card');
  assert.equal(g.actor, 'shiori');
  assert.deepEqual({ source: g.data.source, links: g.data.links, text: g.data.text }, { source: 'Google Search', links: [{ url: 'https://nepenthe.com', title: 'nepenthe.com' }], text: 'Open till 10.' }, 'only web addresses, cleaned once, here');
  assert.ok(g.data.wake, 'the wake it answered');
  assert.deepEqual(g.data.stored, ['html'], 'the suggestions, a blob the entry names (spec §4.9)');
  const { storedTexts } = await import('../../src/core/agent/log.js');
  assert.equal((await storedTexts(k.store, g)).html, html);
  const turns = await k.events(['model.turn']);
  assert.ok(turns.length && !JSON.stringify(await Promise.all(turns.map((t) => storedTexts(k.store, t)))).includes('search?q=nepenthe'), "the turn's parts keep no copy of the card");
  // The model sees its own words once, never the card.
  k.agent.send('Thanks.');
  await k.agent.idle();
  assert.ok(!JSON.stringify(k.requests.at(-1).messages).includes('attribution'));
  assert.ok(JSON.stringify(k.requests.at(-1).messages).includes('Open till 10.'));
});

/** @param {any} k @param {string} scope @param {string[]} types */
const eventsIn = (k, scope, types) => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types }));
/** The user texts a request sends. @param {any} request */
const userTexts = (request) => JSON.stringify(request.messages);

test('opening two conversations in a row: the last one opens, and nothing of the first is written into it', async () => {
  const k = await agentKit([[say('About the temple.')]], { open: false });
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  await record(k.store, A, { type: 'msg.user', actor: 'user', data: { text: 'A: where to eat?', wake: 'wA' } });
  await modelTrace(k.store, A).turn({ role: 'main', level: 'medium', answeredBy: 'M', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'wA' }, '', '',
    [{ type: 'tool_call', id: 'A-1', name: 'fetch', input: { url: 'https://a.example/' } }]);
  await record(k.store, B, { type: 'msg.user', actor: 'user', data: { text: 'B: when is the temple open?', wake: 'wB' } });
  // main.js opens the last active trip; a link to another trip opens that one in the same moment.
  await Promise.all([k.agent.open(A), k.agent.open(B)]);
  await k.agent.idle();
  assert.equal(k.agent.scope, B);
  assert.equal(k.agent.trip, B);
  assert.equal((await eventsIn(k, B, ['tool.result'])).some((/** @type {any} */ e) => e.data.id === 'A-1'), false);
  assert.equal((await eventsIn(k, B, ['wake'])).length, 1);
  assert.equal(k.requests.length, 1);
  assert.match(userTexts(k.requests[0]), /B: when is the temple open/);
  assert.doesNotMatch(userTexts(k.requests[0]), /A: where to eat/);
  assert.doesNotMatch(JSON.stringify(k.agent.transcript.messages), /A: where to eat/);
});

test('a message typed while a conversation opens waits for it, and reaches the model there', async () => {
  const k = await agentKit([[say('Hello.')]], { open: false });
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  await k.agent.open(A);
  const opening = k.agent.open(B);
  k.agent.send('typed right away');
  await opening;
  await k.agent.idle();
  assert.deepEqual((await eventsIn(k, B, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['typed right away']);
  assert.deepEqual((await eventsIn(k, A, ['msg.user'])).length, 0);
  assert.match(userTexts(k.requests[0]), /typed right away/);
  assert.match(JSON.stringify(k.agent.transcript.messages), /typed right away/);
});

test('opening another conversation while Shiori works: she stops, and a message still waiting is kept where it was typed', async () => {
  const k = await agentKit([[{ delayMs: 60, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Back in Big Sur.')]]);
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.send('first');
  await new Promise((r) => setTimeout(r, 15));
  k.agent.send('second, typed while she thought');
  await k.agent.open(B);
  await k.agent.idle();
  assert.deepEqual((await eventsIn(k, A, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['first', 'second, typed while she thought']);
  assert.equal((await eventsIn(k, B, ['msg.user'])).length, 0);
  assert.equal(k.requests.length, 1);
  await k.agent.open(A);
  await k.agent.idle();
  assert.deepEqual((await eventsIn(k, A, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Back in Big Sur.']);
  assert.match(userTexts(k.requests[1]), /second, typed while she thought/);
});

test("opening a conversation leaves the last one's housekeeping behind: no compaction of the new one for the old one's size", async () => {
  const small = (/** @type {string} */ text) => ({ ...say(text), usage: { input: 50, output: 5 } });
  /** @type {any[]} */
  const timers = [];
  const k = await agentKit([[small('b1'), small('b2'), { ...say('a1'), usage: { input: 9500, output: 5 } }, small('b3'), small('b4')]], {
    models: [{ contextWindow: 10_000 }], utility: [{ text: 'Summary.' }],
    agent: { timers: { set: (/** @type {any} */ fn, /** @type {number} */ ms) => { timers.push({ fn, ms }); return timers.length; }, clear: (/** @type {number} */ h) => { timers[h - 1] = null; } } },
  });
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  await k.agent.open(B);
  for (const m of ['B: one', 'B: two']) { k.agent.send(m); await k.agent.idle(); }
  await k.agent.open(A);
  k.agent.send('A: long');
  await k.agent.idle();
  assert.ok(timers.some(Boolean), "A's turn made housekeeping due");
  await k.agent.open(B);
  assert.equal(timers.filter(Boolean).length, 0, "A's housekeeping timer is gone");
  k.agent.send('B: three');
  await k.agent.idle();
  assert.equal((await eventsIn(k, B, ['compaction'])).length, 0);
  assert.equal(timers.filter(Boolean).length, 0, 'nothing is due in B');
});

test('an error card and error event never show a key, even when the provider echoes it', async () => {
  const KEY = 'sk-ant-SECRETKEY1234567890';
  const k = await agentKit([[{ error: 'auth', status: 401, message: `Incorrect API key provided: ${KEY}` }]]);
  await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('llm:ep-0', KEY));
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.notices.length, 1);
  assert.match(k.notices[0].body, /«key»/);
  assert.doesNotMatch(JSON.stringify(k.notices), /SECRETKEY/);
  assert.doesNotMatch(JSON.stringify(await k.events(['error'])), /SECRETKEY/);
});

test("housekeeping that fails inside a turn ends it with a card and an error event that say so", async () => {
  const k = await agentKit([[say('one'), say('two'), { error: 'context', status: 413, message: 'prompt is too long' }]],
    { utility: [{ error: 'auth', status: 401, message: 'bad utility key' }] });
  for (const m of ['first', 'second', 'third']) { k.agent.send(m); await k.agent.idle(); }
  assert.deepEqual((await k.events(['error'])).map((e) => e.data.kind), ['compaction']);
  const card = k.notices.at(-1);
  assert.equal(card.title, "Shiori couldn't tidy up the conversation");
  assert.match(card.body, /bad utility key/);
  assert.equal(k.agent.transcript.unanswered, false);
});

test('a turn that failed is over: later starts do not wake Shiori again for it', async () => {
  const k = await agentKit([[{ error: 'auth', status: 401 }]]);
  k.agent.send('Hello?');
  await k.agent.idle();
  for (let i = 0; i < 3; i++) {
    await k.agent.open(k.trip);
    await k.agent.idle();
  }
  assert.equal((await k.events(['wake'])).length, 1);
  assert.equal((await k.events(['error'])).length, 1);
  assert.equal(k.notices.length, 1);
  assert.doesNotMatch(JSON.stringify(k.agent.transcript.messages), /\[annai\]/);
});

test('ask with options that are not a list of one to six strings is an error Shiori sees, and nothing is shown', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'ask', input: { question: 'Go?', options: 'yes' } }] },
    { toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['1', '2', '3', '4', '5', '6', '7'] } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]]);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal((await k.events(['out.ask'])).length, 0);
  const asks = (await k.events(['tool.result'])).filter((e) => e.data.name === 'ask');
  assert.deepEqual(asks.map((e) => e.data.ok), [false, false]);
  for (const a of asks) assert.match(a.data.content, /options: a list of 1 to 6/);
});

test('a request cut off because the page is being left is not a failed turn: the next start answers the message', async () => {
  // Every try of the first request fails (the call retries a network failure), then the model answers.
  const cut = { delayMs: 30, error: 'network', message: 'Load failed' };
  const k = await agentKit([[...Array(1 + NETWORK_RETRIES.length).fill(cut), say('Yes, still here.')]]);
  k.agent.send('Are you there?');
  await new Promise((r) => setTimeout(r, 10));
  k.agent.leaving(); // pagehide: WebKit then cancels the request while the page can still write
  await k.agent.idle();
  assert.equal((await k.events(['error'])).length, 0);
  k.llm.bench.clear('m-0'); // a new page starts with no model benched
  const next = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  await next.open(k.trip);
  await next.idle();
  assert.deepEqual((await k.events(['out.speak'])).map((e) => e.data.text), ['Yes, still here.']);
});

test('read sends a request copy, named by the turn that sends it, with both sizes; a later read reuses it', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/big.webp' } }] }, { toolCalls: [{ name: 'read', input: { path: '/trip/files/big.webp' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  await k.ws.write(k.trip, '/files/big.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  k.agent.send('Look');
  await k.agent.idle();
  const [first, second] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'read');
  assert.match(first.data.content, /4032×3024, sent as 2000×1500/);
  assert.equal(first.data.images[0].path, '/trip/files/big.webp');
  assert.equal(first.refs.at(-1), first.data.images[0].hash);
  assert.equal(second.data.images[0].hash, first.data.images[0].hash);
  assert.equal(k.codec.calls.length, 1);
  const sent = k.requests[1].messages.at(-1).parts.find((/** @type {any} */ p) => p.type === 'image');
  assert.equal(sent.hash, first.data.images[0].hash);
  assert.equal(sent.path, '/trip/files/big.webp');
});

test('read with a region sends a crop, kept in the conversation, and says which region was used', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp', region: [0.75, 0.6, 0.25, 0.1] } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('4000x3000'), { author: 'user', type: 'image/webp', meta: { width: 4000, height: 3000 } });
  k.agent.send('What does the menu say?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /part \[0\.25, 0\.1, 0\.75, 0\.6\] \(2000×1500 of 4000×3000\)/);
  assert.match(r.data.content, /swapped/);
  assert.deepEqual(r.data.images[0].region, [0.25, 0.1, 0.75, 0.6]);
  assert.deepEqual(k.codec.calls[0].crop, { x: 1000, y: 300, width: 2000, height: 1500 });
  assert.equal((await k.ws.list(k.trip, '/files/')).length, 1);
});

test('a photo the user sends goes in their message as a request copy, and comes back the same after a reload', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]]);
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  k.agent.send('What is this?', { photos: [{ path: '/trip/files/p.webp' }, { path: '/trip/files/p.webp', region: [0, 0, 0.5, 0.5] }] });
  await k.agent.idle();
  const [msg] = await k.events(['msg.user']);
  assert.deepEqual(msg.data.images.map((/** @type {any} */ i) => [i.path, i.region ?? null]), [['/trip/files/p.webp', null], ['/trip/files/p.webp', [0, 0, 0.5, 0.5]]]);
  assert.deepEqual(msg.refs.slice(-2), msg.data.images.map((/** @type {any} */ i) => i.hash));
  const user = k.requests[0].messages.at(-1);
  assert.deepEqual(user.parts.map((/** @type {any} */ p) => p.type), ['text', 'image', 'image']);
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
});

test('a photo sent with no words says "(a photo)"; one sent while Shiori waits for an answer reaches her right after it', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['A', 'B'] } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send('Hi');
  // Until she waits for the answer to her question, however busy the machine is (a fixed 20 ms flaked under load).
  for (let i = 0; i < 200 && k.agent.state.name !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(k.agent.state.name, 'waiting');
  k.agent.send('', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  const msgs = await k.events(['msg.user']);
  assert.deepEqual(msgs.map((e) => e.data.text), ['Hi', '(a photo)', '(a photo)']);
  assert.equal(msgs[2].data.images.length, 1);
  const last = k.requests[1].messages.at(-1).parts;
  assert.deepEqual(last.map((/** @type {any} */ p) => p.type), ['tool_result', 'text', 'image']);
});

test('a wake for a trip that is not open is written into its conversation, and answered when it opens (spec §7.3)', async () => {
  const k = await agentKit([[say('Your flight pass: I put it in the plan.')]]);
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.wake({ kind: 'file', scope: B, text: 'The user added a file to the trip: /trip/files/flight.pkpass (application/vnd.apple.pkpass).' });
  await k.agent.idle();
  assert.equal(k.requests.length, 0);
  assert.equal((await eventsIn(k, A, ['wake'])).length, 0);
  assert.deepEqual((await eventsIn(k, B, ['wake'])).map((/** @type {any} */ e) => e.data.reasons.map((/** @type {any} */ r) => r.kind)), [['file']]);
  await k.agent.open(B);
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
  assert.match(userTexts(k.requests[0]), /flight\.pkpass/);
  // She isn't told annai restarted: it came while the conversation was closed.
  assert.doesNotMatch(userTexts(k.requests[0]), /The conversation closed before you answered/);
  assert.match(userTexts(k.requests[0]), /You haven't answered this yet: it came while this conversation was closed/);
  assert.deepEqual((await eventsIn(k, B, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Your flight pass: I put it in the plan.']);
});

test('a wake kept for a trip that is not open is written by the time wake() settles', async () => {
  const k = await agentKit([[say('Noted.')]]);
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  // A slow disk: a write starts a moment later, so only waiting for it finds it written.
  const tx = k.store.tx;
  k.store.tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) =>
    (mode === 'readwrite' ? new Promise((r) => setTimeout(r, 20)).then(() => tx(stores, mode, fn)) : tx(stores, mode, fn));
  await k.agent.wake({ kind: 'file', scope: B, text: 'The user added a file to the trip: /trip/files/flight.pkpass (application/vnd.apple.pkpass).' });
  assert.deepEqual((await eventsIn(k, B, ['wake'])).map((/** @type {any} */ e) => e.data.reasons.map((/** @type {any} */ r) => r.kind)), [['file']]);
  k.store.tx = tx;
  await k.agent.idle();
});

test('a wake for the open trip, named by its scope, runs there as before', async () => {
  const k = await agentKit([[say('Got it.')]]);
  k.agent.wake({ kind: 'file', scope: k.trip, text: 'The user added a file to the trip: /trip/files/a.pdf (application/pdf).' });
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
});

test("show: a plugin's card type joins the tool's card, its data is checked, and an unknown type is refused (spec §16.4)", async () => {
  const k = await agentKit([[{ toolCalls: [
    { name: 'show', input: { card: { type: 'tides', data: { low: '05:40' } } } },
    { name: 'show', input: { card: { type: 'tides', data: { low: 540 } } } },
    { name: 'show', input: { card: { type: 'ferries', data: {} } } },
    { name: 'sleep', input: {} },
  ] }]]);
  k.registry.add('tides', 'ui:card-type', { type: 'tides', name: 'Tides', description: 'Low and high tides.', schema: { type: 'object', required: ['low'], properties: { low: { type: 'string' } } }, render: () => {} });
  k.agent.send('Tides?');
  await k.agent.idle();
  const show = k.requests[0].tools.find((/** @type {any} */ t) => t.name === 'show');
  assert.deepEqual(show.input.properties.card.properties.type.enum, ['tides']);
  assert.match(show.description, /Card types plugins add: tides \(Tides\): Low and high tides\./);
  const results = (await k.events(['tool.result'])).filter((e) => e.data.name === 'show').map((e) => e.data.content);
  assert.equal(results[0], 'shown');
  assert.match(results[1], /^Error: the tides card's data isn't valid: .*low/);
  assert.equal(results[2], 'Error: there is no card type ferries. Types: tides.');
  assert.equal((await k.events(['out.show'])).length, 1);
});

test("8c-1: an image a tool returns that isn't base64 is that tool's error; Shiori's turn goes on", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'snap', input: {} }] }, say('That picture was broken.')]]);
  k.registry.add('test', 'tool', { name: 'snap', description: 'A picture.', input: { type: 'object' }, run: async () => ({ content: 'A picture.', images: [{ mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }] }) });
  k.agent.send('Show me the trail.');
  await k.agent.idle();
  const [snap] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'snap');
  assert.equal(snap.data.ok, false);
  assert.equal(snap.data.images, undefined);
  assert.match(snap.data.content, /snap gave back an image annai can't read/);
  assert.equal((await k.events(['out.speak']))[0]?.data.text, 'That picture was broken.');
  assert.deepEqual(k.agent.transcript.open(), []);
});

test('the cache lasts an hour unless the user chose five minutes; a model without the hour asks for five minutes (the user, 2026-10-18)', async () => {
  const k = await agentKit([[say('One.'), say('Two.')], [say('Three.')]], { models: [{ cacheTtls: ['5m', '1h'] }, {}] });
  assert.equal((await k.agent.settings()).cacheTtl, '1h'); // never chosen
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.requests.at(-1).cacheTtl, '1h');
  assert.equal(k.agent.cacheState()?.ttlMs, 60 * 60_000);
  await updateAppSettings(k.ws, { shiori: { cacheTtl: '5m' } });
  assert.equal((await k.agent.settings()).cacheTtl, '5m'); // chosen: kept
  await updateAppSettings(k.ws, { shiori: { cacheTtl: '1h' } });
  // The first model rests; the second lists no hour, so it is asked for five minutes, and its warmth lasts five.
  k.llm.bench.bench('m-0', 60_000);
  k.agent.send('Again');
  await k.agent.idle();
  assert.equal(k.requests.at(-1).cacheTtl, '5m');
  assert.equal(k.agent.cacheState()?.ttlMs, 5 * 60_000);
});
