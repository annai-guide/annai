import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { compactionNeed, cutAt, renderForSummary, coldSystem, summaryLanguage } from '../../src/core/agent/compaction.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { ME } from '../../src/core/scopes.js';
import { saveModel } from '../../src/core/llm/config.js';

const say = (/** @type {string} */ text, /** @type {any} */ extra = {}) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }], ...extra });

test('when housekeeping is due, and when it is forced', () => {
  const base = { window: 100_000, maxBytes: 8 * 2 ** 20, threshold: 0.7 };
  assert.equal(compactionNeed({ ...base, tokens: 50_000, bytes: 1000 }), null);
  assert.equal(compactionNeed({ ...base, tokens: 70_000, bytes: 1000 }), 'due');
  assert.equal(compactionNeed({ ...base, tokens: 91_000, bytes: 1000 }), 'forced');
  assert.equal(compactionNeed({ ...base, tokens: 10, bytes: 6 * 2 ** 20 }), 'due');
  assert.equal(compactionNeed({ ...base, tokens: 10, bytes: 9 * 2 ** 20 }), 'forced');
  assert.equal(compactionNeed({ ...base, window: null, tokens: 1e9, bytes: 10 }), null);
});

test('the cut keeps about a third of the threshold, never fewer than three exchanges, and always compacts the oldest', () => {
  const ex = (/** @type {number} */ seq) => [{ seq, tokens: 10, exchange: true }, { seq: seq + 1, tokens: 1000, exchange: false }];
  const items = [1, 3, 5, 7, 9, 11].flatMap(ex);
  assert.equal(cutAt(items, { keepTokens: 500 }), 7);
  assert.equal(cutAt(items, { keepTokens: 4000 }), 5);
  assert.equal(cutAt(items, { keepTokens: 1e9 }), 3);
  assert.equal(cutAt(items.slice(0, 6), { keepTokens: 0 }), null);
  assert.equal(cutAt(items.slice(0, 6), { keepTokens: 0, minExchanges: 1 }), 5);
});

test('cold: the utility model writes the summary; the last three exchanges stay word for word', async () => {
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'They planned dinner at Nepenthe.' }] });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Message ${i}`);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  const [c] = await k.events(['compaction']);
  assert.equal(c.data.mode, 'cold');
  const msgs = k.agent.transcript.messages;
  assert.match(/** @type {any} */ (msgs[0].parts[0]).text, /^\[Earlier conversation, summarized \(events \d+–\d+\); recall brings back the exact words\]\nThey planned dinner at Nepenthe\.$/);
  const all = JSON.stringify(msgs);
  // Without a model window, the part kept is large: everything but the oldest exchange, and never fewer than three.
  assert.equal(all.includes('Message 0'), false);
  for (const n of [2, 3, 4]) assert.equal(all.includes(`Message ${n}`), true);
  assert.match(k.requests.at(-1).messages[0].parts[0].text, /Message 0/);
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, msgs);
});

test('warm: the model holding the cache summarizes from the cached conversation, and may move facts into memory first', async () => {
  const k = await agentKit([[say('a'), say('b'), say('c'), say('d'),
    { toolCalls: [{ name: 'edit', input: { path: '/me/memory.md', old: '# Memory', new: '# Memory\n- Vegetarian' } }, { name: 'write', input: { path: '/trip/notes/x.md', content: 'no' } }] },
    { text: 'Four greetings; the user is vegetarian.' }]]);
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Hi ${i}`);
    await k.agent.idle();
  }
  const conversation = structuredClone(k.agent.transcript.messages);
  const lastTurn = k.requests.at(-1);
  assert.equal(await k.agent.compact('warm'), true);
  const asked = k.requests[4];
  assert.equal(asked.system, lastTurn.system);
  assert.deepEqual(asked.tools, lastTurn.tools);
  assert.deepEqual(asked.messages, conversation);
  assert.match(asked.tail, /housekeeping/);
  assert.match(await k.ws.readText(ME, '/memory.md'), /Vegetarian/);
  assert.equal(await k.ws.read(k.trip, '/notes/x.md'), undefined);
  assert.equal((await k.events(['compaction']))[0].data.mode, 'warm');
  assert.equal(k.requests.length, 6, "its summary is plain text, as asked: housekeeping isn't the user's turn, so nobody asks again (spec §7.1)");
  assert.deepEqual(k.notices, []);
});

test('due at a pause: housekeeping waits until shortly before the cache expires', async () => {
  /** @type {{ fn: () => void, ms: number }[]} */
  const timers = [];
  const k = await agentKit([[say('x', { usage: { input: 7500, output: 5 } })]], {
    models: [{ contextWindow: 10000 }],
    agent: { timers: { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, ms }), clear: () => {} } },
  });
  k.agent.send('Hello');
  await k.agent.idle();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms > 250_000 && timers[0].ms <= 255_000, String(timers[0].ms));
});

test('forced: a turn about to overflow is compacted before its next call', async () => {
  const k = await agentKit([[say('1'), say('2'), say('3'),
    { toolCalls: [{ name: 'list', input: { path: '/trip/' } }], usage: { input: 9500, output: 5 } },
    { text: 'Summary of 1 to 3.' },
    say('done')]], { models: [{ contextWindow: 10000 }] });
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Turn ${i}`);
    await k.agent.idle();
  }
  assert.equal((await k.events(['compaction'])).length, 1);
  assert.match(k.requests.at(-1).messages[0].parts[0].text, /^\[Earlier conversation, summarized/);
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'done');
});

test('"request too long" from every model: compact cold first, then try again', async () => {
  const k = await agentKit([[say('1'), say('2'), say('3'), { error: 'context', status: 400, message: 'prompt is too long' }, say('fits now')]], { utility: [{ text: 'Summary.' }] });
  for (let i = 0; i < 4; i++) {
    k.agent.send(`Turn ${i}`);
    await k.agent.idle();
  }
  assert.equal((await k.events(['compaction']))[0].data.mode, 'cold');
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'fits now');
  assert.equal(k.notices.length, 0);
});

test('renderForSummary: within a size, the start and the end kept and the middle said to be left out', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: `Message ${i} ${'x'.repeat(200)}` }] }));
  const text = renderForSummary(messages, 2000);
  assert.ok(text.length <= 2000, `${text.length}`);
  assert.match(text, /^User: Message 0 /);
  assert.match(text, /Message 39 x+$/);
  assert.match(text, /\[… \d+ characters left out …\]/);
  assert.equal(renderForSummary(messages.slice(0, 2), 2000), renderForSummary(messages.slice(0, 2)));
});

test("cold: what the utility model is sent fits its window, so a huge exchange can't keep it from summarizing", async () => {
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, contextWindow: 2000 } });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Message ${i} ${'y'.repeat(6000)}`);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  const sent = k.requests.at(-1);
  assert.equal(sent.system, coldSystem(summaryLanguage(`Message 4 ${'y'.repeat(6000)}`)));
  assert.ok(sent.messages[0].parts[0].text.length <= 2000 * 3.5 * 0.5, `${sent.messages[0].parts[0].text.length}`);
});

test('summaries see photos as stubs with their path and part', async () => {
  const text = renderForSummary([{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'x', path: '/trip/files/menu.webp', region: [0, 0, 0.5, 0.5] }] }]);
  assert.equal(text, 'User: [photo /trip/files/menu.webp, part [0, 0, 0.5, 0.5]]');
});

test('requestBytes: photos uploaded to the provider count as their id (spec §6.5)', async () => {
  const { requestBytes } = await import('../../src/core/agent/compaction.js');
  const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'image', mediaType: 'image/webp', data: 'A'.repeat(100_000), hash: 'h' }] }] };
  assert.ok(requestBytes(request) > 100_000);
  assert.ok(requestBytes(request, { uploaded: true }) < 1000);
});

test('with uploads, a big photo makes no housekeeping due (spec §6.5, review I7)', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  for (const uploading of [false, true]) {
    /** @type {any[]} */
    const timers = [];
    const k = await agentKit([[say('ok')]], { uploading, agent: { timers: { set: (/** @type {any} */ fn) => { timers.push(fn); return timers.length; }, clear: (/** @type {number} */ h) => { timers[h - 1] = null; } } } });
    await updateAppSettings(k.ws, { shiori: { compaction: { maxRequestMiB: 1 } } });
    await k.ws.write(k.trip, '/files/big.webp', new TextEncoder().encode('x'.repeat(700_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
    k.agent.send('Look', { photos: [{ path: '/trip/files/big.webp' }] });
    await k.agent.idle();
    assert.equal(timers.some(Boolean), !uploading, uploading ? 'uploaded: counted as its id' : 'sent as bytes: due');
  }
});

test('housekeeping reads the conversation by type: location points and the like are not walked (A6)', async () => {
  const { noteQueries } = await import('./store-spy.js');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'They planned dinner at Nepenthe.' }] });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Message ${i}`);
    await k.agent.idle();
  }
  const queries = noteQueries(k.store);
  assert.equal(await k.agent.compact('cold'), true);
  const untyped = queries.filter((q) => !(Array.isArray(q.types) && q.types.length));
  assert.deepEqual(untyped, []);
});

test("warm housekeeping, whose request still offers the model's own search (so the cached prefix holds), asks for no search (G4)", async () => {
  const { instruction } = await import('../../src/core/agent/compaction.js');
  assert.match(instruction('event 12', 'English'), /Don't search the web now\./);
});

test("a few words in another script don't decide the language: the script must make up most of the letters; and the last few messages are read, not one (review A6)", async () => {
  const { languageOf } = await import('../../src/core/agent/compaction.js');
  assert.equal(languageOf('Is 一蘭 near 渋谷駅 still open tonight?'), 'English');
  assert.equal(languageOf('Can we try the ラーメン place by the station?'), 'English');
  assert.equal(languageOf('Is the Café Пушкин open on Sundays?'), 'English');
  assert.equal(languageOf('今日の夕食はどこにしますか'), 'Japanese');
  assert.equal(languageOf('我们今晚去哪里吃饭'), 'Chinese');
  assert.equal(languageOf('Где можно поужинать сегодня вечером?'), 'Russian');
  assert.equal(summaryLanguage(['We are vegetarian.', 'Also no nuts, please.', 'OK']), 'English, the language the user wrote in last');
  assert.equal(summaryLanguage(['OK']), 'the language the user wrote in last: "OK"');
});

test('the summary is asked for in a language named: the one the user wrote in last, else the app\'s (emulator pass: a Spanish summary of an English talk)', async () => {
  assert.equal(summaryLanguage('Also, we are vegetarian.'), 'English, the language the user wrote in last');
  assert.equal(summaryLanguage('¿Dónde podemos cenar esta noche?'), 'Spanish, the language the user wrote in last');
  assert.equal(summaryLanguage('Où est le restaurant ?'), 'French, the language the user wrote in last');
  assert.equal(summaryLanguage('今日の夕食はどこにしますか'), 'Japanese, the language the user wrote in last');
  assert.equal(summaryLanguage(''), "English, the app's language (the user hasn't written anything yet)");
  assert.equal(summaryLanguage('OK'), 'the language the user wrote in last: "OK"');
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'Summary.' }] });
  for (const m of ['Where should we eat tonight?', 'And tomorrow?', 'We are vegetarian, by the way.', 'Is it far?', 'Thanks, that is all for today.']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  assert.match(k.requests.at(-1).system, /as plain text, in English, the language the user wrote in last\.$/);
  const { instruction } = await import('../../src/core/agent/compaction.js');
  assert.match(instruction('event 12', 'Spanish, the language the user wrote in last'), /as plain text, in Spanish, the language the user wrote in last\.$/);
});
