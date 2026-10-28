import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { TALK_TAG, record } from '../../src/core/agent/log.js';
import { createTrip } from '../../src/core/scopes.js';
import { Agent, UNANSWERED, FORCED_STEPS } from '../../src/core/agent/loop.js';
import { NETWORK_RETRIES } from '../../src/core/llm/fallback.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { useClock } from './clock.js';
import { noReader } from '../../src/core/agent/reading.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

test('a typed message wakes Shiori; she speaks and sleeps; the whole turn is in the log, and survives a reload', async (t) => {
  useClock(t);
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

test('tool calls run in order, sleep last, and every call gets a result', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }, { name: 'write', input: { path: '/trip/notes/a.md', content: 'x' } }, { name: 'speak', input: { text: 'Noted.' } }] }]]);
  k.agent.send('Note x');
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.deepEqual(results.map((e) => e.data.name), ['write', 'speak', 'sleep']);
  assert.deepEqual(k.agent.transcript.open(), []);
});

test('fallback across two providers: the first is out of credit, the second answers (spec §9.6)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ error: 'credit', status: 402 }], [say('Here.')]]);
  k.agent.send('Hi');
  await k.agent.idle();
  const [turn] = await k.events(['model.turn']);
  assert.deepEqual(turn.data.attempts.map((/** @type {any} */ a) => a.outcome), ['credit', 'ok']);
  assert.equal(turn.data.tag, TALK_TAG);
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Here.');
});

test('ask waits for a tap; a later step continues with the answer', async (t) => {
  useClock(t);
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

test('the dock is told "Waiting for your OK" only while an ask waits; a wait is the user\'s turn (phone-fixes-1 item 5: IMG_3017)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'wait', input: { seconds: 60 } }] }, { toolCalls: [{ name: 'ask', input: { question: 'Keep it?', options: ['Yes', 'No'] } }] }, say('OK.')]]);
  /** @type {string[]} */
  const told = [];
  k.agent.on('state', (/** @type {any} */ s) => { if (s.name === 'waiting') told.push(s.label); });
  k.agent.send('Hello');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(told, ['Your turn'], 'what the dock was told, as it was told');
  assert.equal(k.agent.state.label, 'Your turn');
  k.agent.send('Still here');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(told, ['Your turn', 'Waiting for your OK']);
  const asked = (await k.events(['tool.call'])).find((/** @type {any} */ e) => e.data.name === 'ask');
  k.agent.answer(asked.data.id, 'Yes');
  await k.agent.idle();
});

test('typing answers a pending ask, and is not repeated as its own message', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['A', 'B'] } }] }, say('OK.')]]);
  k.agent.send('Start');
  await new Promise((r) => setTimeout(r, 30));
  k.agent.send('Neither, the café');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result']))[0].data.content, 'The user wrote: Neither, the café');
  const texts = JSON.stringify(k.requests[1].messages);
  assert.equal(texts.split('Neither, the café').length - 1, 1);
});

test('typing while she works arrives at her next call as "meanwhile" (spec §6.1)', async (t) => {
  useClock(t);
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

test('wait returns what the user typed, or that nothing came', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Ready?' } }, { name: 'wait', input: { seconds: 3 } }] }, { toolCalls: [{ name: 'wait', input: { seconds: 1 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  k.agent.send('Go');
  await new Promise((r) => setTimeout(r, 15));
  k.agent.send('Yes!');
  await k.agent.idle();
  const waits = (await k.events(['tool.result'])).filter((e) => e.data.name === 'wait');
  assert.deepEqual(waits.map((e) => e.data.content), ['The user wrote: Yes!', 'Nothing yet (1 seconds).']);
});

test('tapping Shiori stops a hanging tool and the turn; every call still has a result (spec §6.7)', async (t) => {
  useClock(t);
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

test("the user's message, answered only in plain text: she is asked once more; still nothing for the user, a card with Try again (spec §7.1, emulator pass)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ text: 'Big Sur is known for its coast.' }, { toolCalls: [{ name: 'sleep', input: {} }] }, say('Its wild coast, mostly.')]]);
  k.agent.send('What is Big Sur known for?');
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'asked once more, in the same turn');
  assert.match(JSON.stringify(k.requests[1].messages.at(-1)), new RegExp(UNANSWERED.slice(0, 40)));
  assert.match(k.requests[1].tail, /The user hasn't been answered/);
  assert.equal((await k.events(['wake'])).filter((e) => !e.data.meanwhile).length, 1, 'one turn');
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => [n.title, n.body, n.actions.map((/** @type {any} */ a) => a.label)]), [["Shiori didn't answer", 'Big Sur: Her model finished without saying anything to you.', ['Try again']]]);
  assert.equal((await k.events(['error']))[0].data.kind, 'silent');
  assert.equal(k.agent.transcript.unanswered, false, 'the card said so: a later start owes nothing');
  // Try again: her turn again, the user's, answered this time.
  k.notices[0].actions[0].run();
  await k.agent.idle();
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Its wild coast, mostly.');
  assert.match(k.requests[2].tail, /woke for: the user tapped Try again/);
  assert.equal(k.notices.length, 1);
});

test('a turn that spoke to the user, or one the user didn\'t start, ends as it is: no second ask, no card', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Big Sur: the coast.')]]);
  k.agent.send('What is Big Sur known for?');
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
  const quiet = await agentKit([[{ text: 'Low tide noted; nothing to say.' }]]);
  quiet.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await quiet.agent.idle();
  assert.equal(quiet.requests.length, 1);
  assert.deepEqual(quiet.notices, []);
});

test("the connection going and coming back sets a resting Shiori's state at once, not only at a turn's end (emulator pass m2b #10)", async (t) => {
  useClock(t);
  /** @type {Record<string, (() => void)[]>} */
  const on = { online: [], offline: [] };
  const g = /** @type {any} */ (globalThis);
  const had = g.addEventListener;
  g.addEventListener = (/** @type {string} */ type, /** @type {() => void} */ fn) => { on[type]?.push(fn); };
  let online = false;
  try {
    const k = await agentKit([[say('Hi.')]], { agent: { online: () => online } });
    assert.equal(k.agent.state.label, 'Offline · reminders still work', 'opened offline');
    online = true;
    for (const fn of on.online) fn();
    assert.equal(k.agent.state.label, 'Tap to talk');
    online = false;
    for (const fn of on.offline) fn();
    assert.equal(k.agent.state.name, 'offline');
  } finally {
    g.addEventListener = had;
  }
});

test('the warm model goes first only in the order it answered in: an order the user changed applies from the next turn (emulator pass)', async (t) => {
  useClock(t);
  const { readConfig, saveRoles } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[say('From the first.')], [say('From the second.')]]);
  const roles = (await readConfig(k.ws)).roles;
  await saveRoles(k.ws, { ...roles, main: { ...roles.main, models: ['m-1', 'm-0'] } });
  k.agent.send('One');
  await k.agent.idle();
  k.agent.send('Two');
  await k.agent.idle();
  assert.deepEqual((await k.events(['model.turn'])).map((e) => e.data.answeredBy), ['model-1', 'model-1'], 'its cache is warm: it stays first');
  // The user moves the other model to the top while the cache is warm.
  await saveRoles(k.ws, { ...roles, main: { ...roles.main, models: ['m-0', 'm-1'] } });
  k.agent.send('Three');
  await k.agent.idle();
  k.agent.send('Four');
  await k.agent.idle();
  assert.deepEqual((await k.events(['model.turn'])).map((e) => e.data.answeredBy), ['model-1', 'model-1', 'model-0', 'model-0']);
});

test("a tap while she's thinking stops her turn, and a new one starts at once with what was sent meanwhile; the dock says a tap stops her (item 17)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ delayMs: 5000, ...say('Never said.') }, say('Somewhere vegetarian, then: Big Sur Bakery.')]]);
  k.agent.send('Where should we eat?');
  await until(() => k.requests.length === 1);
  k.agent.send('Actually, somewhere vegetarian.');
  assert.deepEqual(k.agent.state, { name: 'thinking', label: 'Thinking · tap to stop' });
  assert.equal(k.agent.tap(), 'stopped');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  assert.match(JSON.stringify(k.requests[1].messages), /Where should we eat\?.*Actually, somewhere vegetarian\./);
  assert.deepEqual((await k.events(['out.speak'])).map((e) => e.data.text), ['Somewhere vegetarian, then: Big Sur Bakery.']);
  assert.equal((await k.events(['wake'])).filter((e) => !e.data.meanwhile).length, 2, 'the stopped turn, and a new one');
  assert.deepEqual(k.notices, []);
});

test("no model answers: a system card, never in Shiori's voice", async (t) => {
  useClock(t);
  const k = await agentKit([[{ error: 'auth', status: 401 }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.notices[0].title, "Shiori can't reach her model");
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal((await k.events(['error']))[0].data.kind, 'model');
});

test("a model error card is taken down when a later turn works: the same key, then a clear; a \"didn't answer\" card when she then speaks (the second emulator pass)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ error: 'auth', status: 401 }, say('Back again.')]]);
  /** @type {any[]} */
  const seen = [];
  k.agent.on('clear', (/** @type {string} */ key) => seen.push(key));
  k.agent.send('Hi');
  await k.agent.idle();
  assert.deepEqual(seen, []);
  assert.equal(k.notices[0].key, 'model', 'the card is named, so the app can take it down');
  k.llm.bench.clear('m-0');
  k.agent.send('Hi again');
  await k.agent.idle();
  assert.deepEqual(seen, ['model', `silent:${k.trip}`]);
  // The same for a turn that said nothing: its card goes with the turn that speaks.
  const q = await agentKit([[{ text: 'Plain.' }, { text: 'Plain again.' }, say('Now aloud.')]]);
  /** @type {any[]} */
  const qs = [];
  q.agent.on('clear', (/** @type {string} */ key) => qs.push(key));
  q.agent.send('Hi');
  await q.agent.idle();
  assert.deepEqual(q.notices.map((/** @type {any} */ n) => [n.title, n.key]), [["Shiori didn't answer", `silent:${q.trip}`]]);
  assert.deepEqual(qs, ['model'], "that turn worked, but said nothing: the card about saying nothing stays");
  q.agent.tryAgain();
  await q.agent.idle();
  assert.deepEqual(qs, ['model', 'model', `silent:${q.trip}`]);
  assert.equal((await q.events(['out.speak']))[0].data.text, 'Now aloud.');
});

test("the \"didn't answer\" card goes only with a later turn the user started in its conversation that spoke to them: not a reminder's, nor another conversation's (the fix pass)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ text: 'Plain.' }, { text: 'Plain again.' }, say('Fuel is low.'), say('Kyoto is lovely.'), say('Now aloud.')]]);
  /** @type {string[]} */
  const seen = [];
  k.agent.on('clear', (/** @type {string} */ key) => seen.push(key));
  k.agent.send('Hi');
  await k.agent.idle();
  const key = `silent:${k.trip}`;
  assert.equal(k.notices[0].key, key);
  await k.agent.wake({ kind: 'trigger', text: 'Fuel is low', scope: k.trip });
  await k.agent.idle();
  assert.equal((await k.events(['out.speak'])).length, 1);
  assert.ok(!seen.includes(key), "a reminder's turn that spoke");
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  await k.agent.open(other);
  k.agent.send('Hello there');
  await k.agent.idle();
  assert.ok(!seen.includes(key), "another conversation's turn of the user's");
  await k.agent.open(k.trip);
  k.agent.send('Hi again');
  await k.agent.idle();
  assert.ok(seen.includes(key));
});

test("the card says why each model failed on one line, each reason once, in words; offline, that the device is (emulator pass)", async (t) => {
  useClock(t);
  const busy = 'This model is currently experiencing high demand. Please try again later.';
  const k = await agentKit([[{ error: 'overloaded', message: busy }], [{ error: 'unreachable', message: 'Failed to fetch' }]], { models: [{}, { input: ['text'] }] });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.body), [`model-0: ${busy}\nmodel-1: annai couldn't reach this address. It may be down, or it may not allow web apps.`]);
  assert.equal((await k.events(['error']))[0].data.message, k.notices[0].body);
  const off = await agentKit([[{ error: 'unreachable', message: 'Failed to fetch' }]], { agent: { online: () => false } });
  off.agent.send('Hi');
  await off.agent.idle();
  assert.equal(off.notices[0].body, 'This device is offline.');
});

test("a model that reads no PDFs reads one: a model that does tells it in words, and says so; with none here, the result says that (the second emulator pass)", async (t) => {
  useClock(t);
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] }, say('Check-in is at 3 PM.')]], { models: [{ input: ['text', 'image'] }], utility: [{ text: 'Hotel booking: check-in 3 PM, 2 nights.' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text', 'pdf'] } });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /^The PDF \/trip\/files\/booking\.pdf\.\nWhat it says \(told by model-u, as you can't read PDFs\): Hotel booking: check-in 3 PM, 2 nights\.$/);
  assert.equal(r.data.document, undefined, 'the words in place of the document');
  const asked = k.sent['model-u'][0].messages[0].parts.find((/** @type {any} */ p) => p.type === 'document');
  assert.equal(asked.mediaType, 'application/pdf');
  assert.doesNotMatch(JSON.stringify(k.sent['model-0']), /"type":"document"/);
  // No model that reads PDFs: the result says so.
  const none = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] }, say('I cannot read it.')]], { models: [{ input: ['text', 'image'] }], utility: [{ text: 'never' }] });
  await none.ws.write(none.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  none.agent.send('When is check-in?');
  await none.agent.idle();
  const nr = (await none.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.equal(nr.data.content.split('\n').at(-1), noReader('pdf', { plugin: true }));
});

/** A Shiori whose model reads no PDFs, a Utility model that does, and a PDF in the trip. @param {any[]} script @param {any[]} utility */
async function pdfKit(script, utility) {
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([script], { models: [{ input: ['text', 'image'] }], utility });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text', 'pdf'] } });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  return k;
}
const readPdf = { toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] };

test('a PDF told only up to the output limit says it stops there; a second read in the session is told from what was told, never sent again (the fix pass, S6)', async (t) => {
  useClock(t);
  const k = await pdfKit([readPdf, readPdf, say('Check-in is at 3 PM.')], [{ text: 'Hotel booking: check-in 3 PM, 2 nights. Room', stop: 'length' }]);
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const reads = (await k.events(['tool.result'])).filter((e) => e.data.name === 'read').map((e) => e.data.content);
  assert.equal(reads.length, 2);
  assert.match(reads[0], /: Hotel booking: check-in 3 PM, 2 nights\. Room …\(it stops here: the PDF goes on\)$/);
  assert.equal(reads[1], reads[0]);
  assert.equal(k.sent['model-u'].length, 1, 'the PDF went to be told once');
});

test("the told PDFs are keyed by the bytes told, in their conversation: a part claiming an earlier PDF's hash with other bytes is told afresh, and another conversation never gets the first one's words (the fix pass's security review)", async (t) => {
  useClock(t);
  const { toBase64 } = await import('../../src/core/bytes.js');
  const claim = { toolCalls: [{ name: 'claim', input: {} }] };
  const k = await pdfKit([readPdf, claim, say('Done.'), readPdf, say('Done.')], [{ text: 'Hotel booking: check-in 3 PM.' }, { text: 'Ferry ticket: 9:10 AM.' }, { text: 'Kyoto hotel: check-in 4 PM.' }]);
  const { entry } = /** @type {any} */ (await k.ws.read(k.trip, '/files/booking.pdf'));
  // A tool's PDF that names the booking's hash, with bytes of its own.
  k.registry.add('test', 'tool', { name: 'claim', description: 'A PDF.', input: { type: 'object' }, run: async () => ({ content: 'A ticket.', document: { mediaType: 'application/pdf', hash: entry.hash, data: toBase64(new TextEncoder().encode('%PDF-1.4 ferry')), name: 'ticket.pdf' } }) });
  k.agent.send('What do I have?');
  await k.agent.idle();
  const first = (await k.events(['tool.result'])).map((e) => e.data.content);
  assert.match(first[0], /Hotel booking: check-in 3 PM\.$/);
  assert.match(first[1], /Ferry ticket: 9:10 AM\.$/, 'told afresh: its bytes are not the booking');
  // The same bytes in another conversation are told there afresh.
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  await k.ws.write(other, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  await k.agent.open(other);
  k.agent.send('And here?');
  await k.agent.idle();
  assert.equal(k.sent['model-u'].length, 3, 'told in the other conversation afresh');
});

test('Erase forgets the PDFs told this session (the fix pass\'s security review)', async (t) => {
  useClock(t);
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([{ rules: [{ match: 'the user wrote', reply: readPdf, then: { toolCalls: [{ name: 'sleep', input: {} }] } }] }], { koe: { type: [{ toolCalls: [{ name: 'sleep', input: {} }] }] }, models: [{ input: ['text', 'image'] }], utility: [{ text: 'Hotel booking: check-in 3 PM.' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text', 'pdf'] } });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  k.agent.send('When is check-in?');
  await k.agent.idle();
  k.agent.send('And again?');
  await k.agent.idle();
  assert.equal(k.sent['model-u'].length, 1, 'told once');
  k.agent.hush('erase');
  k.agent.send('Once more?');
  await k.agent.idle();
  assert.equal(k.sent['model-u'].length, 2, 'forgotten at Erase');
});

test("a PDF has longer to be told than a photo to be described: a telling that takes more than a photo's 30 seconds still comes (the fix pass, S6)", async (t) => {
  useClock(t);
  const { DESCRIBE_S, DESCRIBE_PDF_S } = await import('../../src/core/agent/loop.js');
  assert.ok(DESCRIBE_PDF_S > DESCRIBE_S);
  // secondMs is 10 here: 30 seconds are 300 ms.
  const k = await pdfKit([readPdf, say('Check-in is at 3 PM.')], [{ delayMs: (DESCRIBE_S + 15) * 10, text: 'Hotel booking: check-in 3 PM.' }]);
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const read = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(read.data.content, /What it says \(told by model-u, as you can't read PDFs\): Hotel booking: check-in 3 PM\.$/);
});

test('a PDF read earlier does not close the conversation to a model that reads none: it goes as a note (the second emulator pass: halo, "type file is not supported")', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] }, say('Read it.')], [say('Anything else?')]], { models: [{ input: ['text', 'image', 'pdf'] }, { input: ['text', 'image'] }] });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  k.agent.send('Read the booking');
  await k.agent.idle();
  assert.match(JSON.stringify(k.sent['model-0'].at(-1).messages), /"type":"document"/, 'the first model had the PDF');
  const { saveRoles, readConfig } = await import('../../src/core/llm/config.js');
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, main: { ...cfg.roles.main, models: ['m-1'] } });
  k.agent.send('Thanks');
  await k.agent.idle();
  const asked = k.sent['model-1'].at(-1);
  assert.doesNotMatch(JSON.stringify(asked.messages), /"type":"document"/);
  assert.match(JSON.stringify(asked.messages), /\[a PDF: booking\.pdf\]/);
  assert.equal(k.notices.length, 0);
});

// Reading files (the bookings design, goals 11 and 12): whoever can read a tool's PDF or photo reads it.
const sleepStep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** A trip holding booking.pdf; Utility's model takes uInput when given. @param {any[]} scripts @param {any} opts @param {string[]} [uInput] */
async function bookingKit(scripts, opts, uInput) {
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit(scripts, opts);
  if (uInput) {
    const u = (await k.llm.config()).models['m-u'];
    await saveModel(k.ws, { ...u, user: { ...u.user, input: uInput } });
  }
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  return k;
}
/** A fake PDF pages plugin that draws count pages (at most max), tiny JPEG bytes each; asked: what it was asked. @param {any} k @param {number} count */
function fakePages(k, count) {
  /** @type {any[]} */
  const asked = [];
  const page = (/** @type {number} */ i) => ({ type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, i]), width: 1236, height: 1600 });
  k.registry.add('pdf-pages', 'pdf-pages', { id: 'fake', pages: async (/** @type {Uint8Array} */ b, /** @type {any} */ o) => { asked.push(o); return { count, pages: Array.from({ length: Math.min(count - (o.from ?? 1) + 1, o.max) }, (_, i) => page(i)) }; } });
  return asked;
}
/** Koe's model answering only a reading (a request with no wake line), with text. @param {any} reply */
const koeReads = (reply) => ({ rules: [{ match: '^$', reply }] });

test("Koe's model reads a PDF for Kokoro before Utility's does (bookings design, goal 11)", async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Check-in is at 3 PM.')]], { halves: true, models: [{ input: ['text', 'image'] }], koe: { type: koeReads({ text: 'Flight AN 123, SEA 08:05.' }), input: ['text', 'pdf'] }, utility: [{ text: 'never' }] }, ['text', 'pdf']);
  k.agent.send('When do I fly?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'kokoro');
  assert.match(r.data.content, /\nWhat it says \(told by model-koe, as you can't read PDFs\): Flight AN 123, SEA 08:05\.$/);
  assert.equal((k.sent['model-u'] ?? []).length, 0, 'Utility not asked');
});

test("with no Koe model that reads PDFs, Utility's reads it (the existing rule)", async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Check-in is at 3 PM.')]], { halves: true, models: [{ input: ['text', 'image'] }], koe: { type: koeReads({ text: 'never' }), input: ['text'] }, utility: [{ text: 'Flight AN 123.' }] }, ['text', 'pdf']);
  k.agent.send('When do I fly?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'kokoro');
  assert.match(r.data.content, /told by model-u, as you can't read PDFs/);
  assert.doesNotMatch(JSON.stringify(k.sent['model-koe'] ?? []), /"type":"document"/);
});

test("a reading has the reading's time, not the role's wait: Koe's short first-words wait doesn't cut a PDF", async (t) => {
  useClock(t);
  // A second is 100 ms here, so the PDF's 90 seconds are 9 s; Koe's wait for first words is 1 s (real time, as a role's wait is), and her reading takes 1.5 s.
  const k = await bookingKit([[readPdf, say('Check-in is at 3 PM.')]], { halves: true, agent: { secondMs: 100 }, models: [{ input: ['text', 'image'] }], koe: { type: koeReads({ delayMs: 1500, text: 'Flight AN 123, SEA 08:05.' }), input: ['text', 'pdf'] } });
  const { saveRoles, readConfig } = await import('../../src/core/llm/config.js');
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, 'koe-classic': { ...cfg.roles['koe-classic'], firstOutputSeconds: 1 } });
  k.agent.send('When do I fly?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'kokoro');
  assert.match(r.data.content, /told by model-koe, as you can't read PDFs\): Flight AN 123/);
  const describe = (await k.events(['model.turn'])).find((e) => e.data.tag === 'describe');
  assert.deepEqual(describe.data.attempts.map((/** @type {any} */ a) => a.outcome), ['ok']);
});

test('Koe still hands a PDF she can\'t read to Kokoro at once', async (t) => {
  useClock(t);
  const k = await bookingKit([[sleepStep]], { koe: { type: [readPdf, sleepStep], input: ['text'] }, utility: [{ text: 'Flight AN 123.' }] }, ['text', 'pdf']);
  k.agent.send('When do I fly?');
  await k.agent.idle();
  const koeRead = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'koe');
  assert.match(koeRead.data.content, /\nYou can't read PDFs; ask Kokoro about it\.$/);
  assert.equal((await k.events(['model.turn'])).filter((e) => e.data.tag === 'describe' && e.data.wake === koeRead.data.wake).length, 0);
});

test('with no reader, a model that sees photos gets the PDF\'s pages as pictures, kept with the result (goal 12)', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Your flight leaves at 8:05.')]], { models: [{ input: ['text', 'image'] }] });
  const asked = fakePages(k, 3);
  k.agent.send('When do I fly?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /^The PDF \/trip\/files\/booking\.pdf\.\nIts pages as pictures, as you can't read PDFs: pages 1–3 of 3\.$/);
  assert.equal(r.data.document, undefined);
  assert.equal(r.data.images.length, 3);
  for (const i of r.data.images) assert.match(i.hash, /^[0-9a-f]{64}$/, 'each page is a blob the result names');
  const next = k.sent['model-0'].at(-1).messages.at(-1).parts;
  assert.equal(next.filter((/** @type {any} */ p) => p.type === 'image').length, 3);
  assert.deepEqual(asked.map((/** @type {any} */ o) => [o.from ?? 1, o.max, o.edge]), [[1, 10, 1600]], 'the plugin was asked once, within the limits');
});

test('a PDF of 23 pages: the first 10 go, and the line says the rest weren\'t sent', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text', 'image'] }] });
  fakePages(k, 23);
  k.agent.send('Read it');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /pages 1–10 of 23; the rest weren't sent\.$/);
  assert.equal(r.data.images.length, 10);
});

test('a model that sees no photos gets the pages told in words by a reader role\'s model that sees them', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text'] }], utility: [{ text: 'Flight AN 123, SEA 08:05.' }] }, ['text', 'image']);
  fakePages(k, 3);
  k.agent.send('Read it');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /What it says \(told by model-u from pictures of its pages, as you can't read PDFs\): Flight AN 123, SEA 08:05\.$/);
  assert.equal(r.data.images, undefined);
  assert.equal(k.sent['model-u'][0].messages[0].parts.filter((/** @type {any} */ p) => p.type === 'image').length, 3);
});

test('pages that take longer than the PDF\'s limit stop there, and the result says it couldn\'t be read in time', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text', 'image'] }] });
  let sawAbort = false;
  k.registry.add('pdf-pages', 'pdf-pages', { id: 'slow', pages: (/** @type {any} */ _b, /** @type {any} */ o) => new Promise((_, no) => o.signal.addEventListener('abort', () => { sawAbort = true; no(new Error('Stopped.')); })) });
  k.agent.send('Read it');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.equal(sawAbort, true);
  assert.match(r.data.content, /\nIt couldn't be described in time \(90 seconds\)\.$/);
  assert.equal(r.data.images, undefined);
});

test('pages the plugin can\'t draw (a locked PDF) say why, and the note names the setting without the plugin', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text', 'image'] }] });
  k.registry.add('pdf-pages', 'pdf-pages', { id: 'locked', pages: async () => { throw new Error("This PDF is locked with a password, so its pages can't be drawn."); } });
  k.agent.send('Read it');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /\nThe PDF pages plugin couldn't draw its pages: This PDF is locked with a password, so its pages can't be drawn\.\nNo model here can read PDFs, .*Settings → Models\)\.$/s);
  assert.equal(k.registry.isDisabled('pdf-pages'), false);
});

test('with nothing that reads it and no plugin, the note names Takes PDFs, and the plugin only when a model here sees photos', async (t) => {
  useClock(t);
  const seeingKit = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text', 'image'] }] });
  const blindKit = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text'] }] });
  for (const k of [seeingKit, blindKit]) {
    k.agent.send('Read it');
    await k.agent.idle();
  }
  const last = async (/** @type {any} */ k) => (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'read').data.content.split('\n').at(-1);
  assert.equal(await last(seeingKit), noReader('pdf', { plugin: true }));
  assert.equal(await last(blindKit), noReader('pdf', { plugin: false }));
});

test('pages are drawn once per conversation, never given to another, and forgotten at Erase', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, readPdf, say('Done.'), readPdf, say('Done.'), readPdf, say('Done.')]], { models: [{ input: ['text', 'image'] }] });
  const calls = fakePages(k, 3);
  k.agent.send('Read it twice');
  await k.agent.idle();
  assert.equal(calls.length, 1, 'drawn once in this conversation');
  const [first, second] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'read');
  assert.deepEqual(second.data.images.map((/** @type {any} */ i) => i.hash), first.data.images.map((/** @type {any} */ i) => i.hash));
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  await k.ws.write(other, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  await k.agent.open(other);
  k.agent.send('And here?');
  await k.agent.idle();
  assert.equal(calls.length, 2, 'drawn afresh in the other trip');
  k.agent.forgetTold(); // what Erase does (Halves.hush('erase'))
  k.agent.send('Once more?');
  await k.agent.idle();
  assert.equal(calls.length, 3, 'once here, once in the other trip, once after Erase');
});

test('a live Koe is never asked to read: realtime models are not chat models', async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, say('Done.')]], { models: [{ input: ['text'] }], koe: { type: [sleepStep], input: ['text'] }, live: { origin: 'http://127.0.0.1:9' } });
  k.agent.send('Read it');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read' && e.data.half === 'kokoro');
  assert.equal(r.data.content.split('\n').at(-1), noReader('pdf', { plugin: false }));
  const tried = (await k.events(['model.turn'])).filter((e) => e.data.tag === 'describe').flatMap((e) => e.data.attempts.map((/** @type {any} */ a) => a.model));
  assert.ok(!tried.includes('m-live'), 'the realtime model was never asked to read');
});

test('a model that takes no photos answers once the conversation holds one; a photo just sent goes to it last, read by whoever can, here no one (emulator pass; the bookings design, goal 11)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ error: 'credit', status: 402 }], [say('Pfeiffer Beach is close.')]], { models: [{}, { input: ['text'] }] });
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  // The one model that sees photos is out of credit, so the photo couldn't be described, and the result says so to the model that answers.
  assert.match(JSON.stringify(k.sent['model-1'][0].messages), /\[a photo: \/trip\/files\/p\.webp\] It couldn't be described: /);
  assert.equal(k.notices.length, 0);
  k.agent.send("What's around here?");
  await k.agent.idle();
  const asked = k.sent['model-1'].at(-1);
  assert.match(JSON.stringify(asked.messages), /\[a photo: \/trip\/files\/p\.webp\]/);
  assert.doesNotMatch(JSON.stringify(asked.messages), /"type":"image"/);
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Pfeiffer Beach is close.');
});

test('a reload before Shiori answered: the message still gets its answer', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Yes, here.')]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Are you there?', wake: 'w-0' } });
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Yes, here.');
  assert.match(JSON.stringify(k.requests[0].messages), /Are you there\?/);
});

test('a reload mid-turn: open tool calls get "interrupted by app restart", then a catch-up wake runs (spec §6.7)', async (t) => {
  useClock(t);
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

test('killed after her tool calls came back, before her next reply: opening the conversation takes the turn up (emulator pass m2b #21)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Vegetarian: Nepenthe has options.')]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Also, we are vegetarian.', wake: 'w-0' } });
  await modelTrace(k.store, k.trip).turn({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0' }, '', '',
    [{ type: 'tool_call', id: 'l1', name: 'list', input: { path: '/trip/' } }]);
  await record(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id: 'l1', name: 'list', ok: true, ms: 1, wake: 'w-0', content: 'path\ttype' } });
  assert.equal((await Transcript.load(k.store, k.trip)).unanswered, true, 'a result she has not seen is an unfinished turn');
  await k.agent.open(k.trip);
  await k.agent.idle();
  const wake = (await k.events(['wake'])).at(-1);
  assert.equal(wake.data.reasons[0].kind, 'restart');
  assert.match(wake.data.reasons[0].text, /in the middle of your turn/);
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Vegetarian: Nepenthe has options.');
  // Her turn ended with sleep: nothing is owed now.
  assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false);
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
});

test("a turn the user stopped isn't taken up when the conversation opens again, even if her tool calls had come back (spec §6.7)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, { delayMs: 5000, ...say('Never said.') }]]);
  k.agent.send('What is in the trip?');
  await until(() => k.requests.length === 2);
  k.agent.interrupt();
  await k.agent.idle();
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false);
  assert.equal(k.notices.length, 0, 'a stop is no error to show');
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'nothing ran again');
});

test("Shiori's turns ask the model to call a tool (she reaches the user only through tools); housekeeping and the utility model's jobs don't, nor a turn with the model's own search on (item 15)", async (t) => {
  useClock(t);
  const k = await agentKit([[say('one'), say('two'), say('three'), say('four'), { text: 'Summary.' }]], { utility: [{ text: 'Summary.' }] });
  for (const m of ['first', 'second', 'third', 'fourth']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.ok(k.requests.slice(0, 4).every((/** @type {any} */ r) => r.toolRequired === true));
  assert.equal(await k.agent.compact('warm'), true);
  assert.equal(k.requests.at(-1).toolRequired, undefined, 'warm housekeeping');
  assert.equal(await k.agent.compact('cold', { forced: true }), true);
  assert.equal(k.sent['model-u'].at(-1).toolRequired, undefined, 'cold, on the utility model');
  const search = await agentKit([[say('Open till 10.')]], { models: [{ providerTools: [{ id: 'p-search', name: 'S', kind: 'search', patch: {} }] }] });
  await search.host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  search.agent.send('Is it open?');
  await search.agent.idle();
  assert.equal(search.requests[0].toolRequired, undefined, "its search answers in words, shown as written (G4): nothing is forced");
});

test("warm housekeeping asks to borrow the conversation's kept chain (it continues it and deletes its own response); cold housekeeping and turns don't", async (t) => {
  useClock(t);
  const k = await agentKit([[say('one'), say('two'), say('three'), say('four'), { text: 'Summary.' }]], { utility: [{ text: 'Summary.' }] });
  /** @type {any[]} */
  const calls = [];
  const was = k.llm.call;
  k.llm.call = (/** @type {any} */ c) => { calls.push(c); return was(c); };
  for (const m of ['first', 'second', 'third', 'fourth']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('warm'), true);
  assert.equal(await k.agent.compact('cold', { forced: true }), true);
  assert.deepEqual(calls.filter((c) => c.borrow).map((c) => c.record?.tag), ['compaction'], 'only the warm summary');
  assert.equal(calls.filter((c) => c.record?.tag === 'compaction').length, 2);
});

test("leaving the page, or tapping Shiori, cuts a warm housekeeping call short (the call then deletes the provider's turn it borrowed)", async (t) => {
  useClock(t);
  const k = await agentKit([[say('one'), say('two'), say('three'), say('four'), { text: 'Summary.' }]], { utility: [{ text: 'Summary.' }] });
  for (const m of ['first', 'second', 'third', 'fourth']) {
    k.agent.send(m);
    await k.agent.idle();
  }
  /** @type {AbortSignal[]} */
  const signals = [];
  const was = k.llm.call;
  k.llm.call = async (/** @type {any} */ c) => {
    if (!c.borrow) return was(c);
    signals.push(c.signal);
    await new Promise((r) => setTimeout(r, 200));
    if (c.signal?.aborted) throw new ProviderError('cancelled', 'Stopped.');
    return was(c);
  };
  const done = k.agent.compact('warm').catch((/** @type {any} */ e) => e);
  await new Promise((r) => setTimeout(r, 50));
  k.agent.leaving();
  k.agent.interrupt();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  const out = await done;
  assert.ok(out instanceof ProviderError && out.kind === 'cancelled');
});

test('a tool call is asked for only until she has reached the user in the turn: after that she may end in words (review A4)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Big Sur: the coast.' } }] }, { text: 'Done.' }]]);
  k.agent.send('What is Big Sur known for?');
  await k.agent.idle();
  assert.deepEqual(k.requests.map((/** @type {any} */ r) => r.toolRequired), [true, undefined]);
  assert.deepEqual(k.notices, [], 'it reached the user: no nudge');
});

test('with no steps-per-wake limit set, a long turn runs past 25 steps and reaches the user, with no step card', async (t) => {
  useClock(t);
  const a = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const b = { toolCalls: [{ name: 'list', input: { path: '/me/' } }] };
  const k = await agentKit([[...Array.from({ length: 30 }, (_, i) => (i % 2 ? b : a)), say('The whole day is planned.')]]);
  k.agent.send('Plan our whole Big Sur day');
  await k.agent.idle();
  assert.equal(k.requests.length, 31);
  assert.deepEqual(k.notices, [], 'no step-limit card, and she reached the user');
});

test(`forcing stops after ${FORCED_STEPS} forced calls without reaching the user: she may then end in words, is nudged once, and the card follows`, async (t) => {
  useClock(t);
  const a = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const b = { toolCalls: [{ name: 'list', input: { path: '/me/' } }] };
  const k = await agentKit([[...Array.from({ length: FORCED_STEPS }, (_, i) => (i % 2 ? b : a)), { text: 'Here is the plan.' }, { text: 'Still no tool.' }]]);
  k.agent.send('Plan our whole Big Sur day');
  await k.agent.idle();
  assert.equal(FORCED_STEPS, 10);
  assert.deepEqual(k.requests.map((/** @type {any} */ r) => r.toolRequired), [...Array(FORCED_STEPS).fill(true), undefined, undefined]);
  assert.match(JSON.stringify(k.requests[FORCED_STEPS + 1].messages.at(-1)), /hasn't been answered/, 'the one nudge');
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), ["Shiori didn't answer"]);
});

test("with the model's own search, Shiori's request has no web_search of annai's and asks for the provider's", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { models: [{ providerTools: [{ id: 'p-search', name: 'S', kind: 'search', patch: {} }] }] });
  k.host && await k.host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  k.agent.send('Hi');
  await k.agent.idle();
  const names = k.requests[0].tools.map((/** @type {any} */ t) => t.name);
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('fetch'), true);
  assert.deepEqual(k.requests[0].providerTools, { kinds: ['search'], off: [] });
});

test("on a key marked free tier, a paid-only search isn't the model's own (G4): Shiori keeps annai's web_search, and asks for none", async (t) => {
  useClock(t);
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

test("a reply grounded in the provider's own search is logged for the conversation as it came (G4: \"From Google Search\"), its suggestions kept as a blob the entry names", async (t) => {
  useClock(t);
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

test('a search whose replies are shown as written (Google Search): one Shiori is told so while it is on, in the same words every turn, so she writes that reply for the user; Kokoro, behind Koe, is not (G4)', async (t) => {
  useClock(t);
  const search = { id: 'g-search', name: 'Google Search', kind: 'search', patch: {}, paidOnly: true, shows: 'From Google Search' };
  const words = 'A reply in which you search with Google Search is shown to the user as you write it, under "From Google Search", with its sources. Write that reply for the user, with no private notes in it. You may still speak or show a shorter version of it, as usual.';
  const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
  const k = await agentKit([[say('Open till 10.')]], { models: [{ providerTools: [search] }] });
  await k.host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  k.agent.send('And tomorrow?');
  await k.agent.idle();
  assert.ok(k.requests[0].system.endsWith(`# Google Search\n${words}`));
  assert.equal(k.requests[1].system, k.requests[0].system, 'stable, so the cached prefix holds');
  // Switched off in Settings → Tools: no search, no words about it.
  const { setToolSwitch } = await import('../../src/core/agent/tools.js');
  await setToolSwitch(k.ws, 'provider:g-search', false);
  k.agent.send('Thanks.');
  await k.agent.idle();
  assert.ok(!k.requests[2].system.includes(words));
  const kokoro = await agentKit([[sleep]], { models: [{ providerTools: [search] }], agent: { half: { name: 'kokoro', tag: TALK_TAG, role: 'main', registryTools: true, voice: () => false, logVoice: true, housekeeping: true, rules: () => 'kokoro' } } });
  await kokoro.host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  kokoro.agent.send('Is Nepenthe open?');
  await kokoro.agent.idle();
  assert.deepEqual(kokoro.requests[0].providerTools, { kinds: ['search'], off: [] });
  assert.ok(!kokoro.requests[0].system.includes(words), 'Koe mode is as it was');
});

/** @param {any} k @param {string} scope @param {string[]} types */
const eventsIn = (k, scope, types) => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types }));
/** The user texts a request sends. @param {any} request */
const userTexts = (request) => JSON.stringify(request.messages);

test('opening two conversations in a row: the last one opens, and nothing of the first is written into it', async (t) => {
  useClock(t);
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

test('a message typed while a conversation opens waits for it, and reaches the model there', async (t) => {
  useClock(t);
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

test('opening another conversation while Shiori works: she stops, and a message still waiting is kept where it was typed', async (t) => {
  useClock(t);
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

test('the "didn\'t answer" cards of two conversations name their own: the trip, or Me (the third emulator pass)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ text: 'Plain.' }, { text: 'Plain again.' }, { text: 'Plain.' }, { text: 'Plain again.' }, { text: 'Plain.' }, { text: 'Plain again.' }]]);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.send('Hi');
  await k.agent.idle();
  await k.agent.open(other);
  k.agent.send('Hi');
  await k.agent.idle();
  await k.agent.open(null);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.body.split(':')[0]), ['Big Sur', 'Kyoto', 'Me']);
});

test('a turn cut by opening another conversation leaves a line in the one left, and a toast; she still picks it up when the user comes back (the third emulator pass)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ delayMs: 300, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Back in Big Sur.')]]);
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  /** @type {any[]} */
  const notices = [];
  k.agent.on('notice', (n) => notices.push(n));
  k.agent.send('first');
  await until(() => k.requests.length === 1); // her model call is under way
  await k.agent.open(B);
  await k.agent.idle();
  const left = await eventsIn(k, A, ['paused']);
  assert.equal(left.length, 1);
  assert.equal(left[0].data.text, 'Shiori was in the middle of something. She picks it up when you come back.');
  assert.equal(left[0].data.wake, undefined, 'not a turn that ended: the conversation is still owed an answer');
  assert.deepEqual(notices.map((n) => [n.toast, n.title]), [[true, 'Shiori was in the middle of something. She picks it up when you come back.']]);
  assert.equal((await eventsIn(k, B, ['paused'])).length, 0, 'the one opened is not told');
  await k.agent.open(A);
  await k.agent.idle();
  assert.deepEqual((await eventsIn(k, A, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Back in Big Sur.']);
  // Opening with nothing running says nothing.
  await k.agent.open(B);
  assert.equal((await eventsIn(k, B, ['paused'])).length, 0);
  assert.equal((await eventsIn(k, A, ['paused'])).length, 1);
});

test('no paused line when the turn was not left undone, or the cut is not one that gets taken up: finished after she spoke, her own Stop, the page leaving, a trip being removed (fix pass)', async (t) => {
  useClock(t);
  const slow = { delayMs: 300, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const notices = (/** @type {any} */ k) => { /** @type {any[]} */ const n = []; k.agent.on('notice', (/** @type {any} */ x) => n.push(x)); return n; };
  // She has spoken and slept: the last model call is done, and opening another conversation right then cuts nothing.
  const done = await agentKit([[say('All set.')]]);
  const B = await createTrip(done.ws, { title: 'Kyoto' });
  const n1 = notices(done);
  done.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'out.speak') done.agent.open(B); });
  done.agent.send('Hi');
  await done.agent.idle();
  assert.equal((await eventsIn(done, done.trip, ['out.speak'])).length, 1);
  assert.equal((await eventsIn(done, done.trip, ['paused'])).length, 0);
  assert.equal(n1.filter((n) => n.toast).length, 0);
  // Her own Stop, and then another conversation.
  const stopped = await agentKit([[slow, say('x')]]);
  const B2 = await createTrip(stopped.ws, { title: 'Kyoto' });
  stopped.agent.send('Hi');
  await until(() => stopped.requests.length === 1);
  stopped.agent.interrupt();
  await stopped.agent.open(B2);
  assert.equal((await eventsIn(stopped, stopped.trip, ['paused'])).length, 0);
  // The page going away.
  const leaving = await agentKit([[slow, say('x')]]);
  const B3 = await createTrip(leaving.ws, { title: 'Kyoto' });
  leaving.agent.send('Hi');
  await until(() => leaving.requests.length === 1);
  leaving.agent.leaving(true);
  await leaving.agent.open(B3);
  assert.equal((await eventsIn(leaving, leaving.trip, ['paused'])).length, 0);
  // The trip is being removed: nothing to come back to.
  const removed = await agentKit([[slow, say('x')]]);
  const n4 = notices(removed);
  removed.agent.send('Hi');
  await until(() => removed.requests.length === 1);
  await removed.agent.open(null, { quiet: true });
  assert.equal((await eventsIn(removed, removed.trip, ['paused'])).length, 0);
  assert.equal(n4.filter((n) => n.toast).length, 0);
});

test("opening a conversation leaves the last one's housekeeping behind: no compaction of the new one for the old one's size", async (t) => {
  useClock(t);
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

test('an error card and error event never show a key, even when the provider echoes it', async (t) => {
  useClock(t);
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

test("housekeeping that fails inside a turn ends it with a card and an error event that say so", async (t) => {
  useClock(t);
  const k = await agentKit([[say('one'), say('two'), { error: 'context', status: 413, message: 'prompt is too long' }]],
    { utility: [{ error: 'auth', status: 401, message: 'bad utility key' }] });
  for (const m of ['first', 'second', 'third']) { k.agent.send(m); await k.agent.idle(); }
  assert.deepEqual((await k.events(['error'])).map((e) => e.data.kind), ['compaction']);
  const card = k.notices.at(-1);
  assert.equal(card.title, "Shiori couldn't tidy up the conversation");
  assert.match(card.body, /bad utility key/i);
  assert.equal(k.agent.transcript.unanswered, false);
});

test("a tap on Shiori (or leaving) during the tidy-up a turn can't go on without is not a failure: no card, no error event", async (t) => {
  useClock(t);
  // In a turn that can't go on without it (the forced tidy-up).
  const k = await agentKit([[say('one'), say('two'), { error: 'context', status: 413, message: 'prompt is too long' }]], { utility: [{ text: 'Summary.' }] });
  const was = k.llm.call;
  k.llm.call = async (/** @type {any} */ c) => {
    if (c.record?.tag !== 'compaction') return was(c);
    k.agent.interrupt(); // the tap
    throw new ProviderError('cancelled', 'Stopped.');
  };
  for (const m of ['first', 'second', 'third']) { k.agent.send(m); await k.agent.idle(); }
  assert.deepEqual((await k.events(['error'])).map((e) => e.data.kind).filter((x) => x !== 'stopped'), []);
  assert.equal(k.notices.filter((n) => /tidy up/.test(n.title ?? '')).length, 0);
});

test("a tap on Shiori during the cold tidy-up that starts a turn (not forced, so it would ask for a card) is no failure either", async (t) => {
  useClock(t);
  // Housekeeping that came due waits for the cache to go cold, then runs at the start of the next turn (#tidyUp, not forced).
  const small = (/** @type {string} */ text) => ({ ...say(text), usage: { input: 50, output: 5 } });
  const clock = { t: Date.parse('2026-10-23T10:00:00Z') };
  const o = await agentKit([[small('b1'), small('b2'), { ...say('a1'), usage: { input: 9500, output: 5 } }, say('a2')]], {
    models: [{ contextWindow: 10_000 }], utility: [{ text: 'Summary.' }],
    agent: { now: () => clock.t, timers: { set: () => 1, clear: () => {} } },
  });
  for (const m of ['one', 'two', 'three']) { o.agent.send(m); await o.agent.idle(); }
  clock.t += 3_600_000; // the cache is cold
  const was2 = o.llm.call;
  let asked = 0;
  o.llm.call = async (/** @type {any} */ c) => {
    if (c.record?.tag !== 'compaction') return was2(c);
    asked++;
    throw new ProviderError('cancelled', 'Stopped.');
  };
  o.agent.send('four');
  await o.agent.idle();
  assert.ok(asked >= 1, 'the cold tidy-up at the start of the turn ran, and was cut short');
  assert.equal(o.notices.filter((n) => /tidy up/.test(n.title ?? '')).length, 0, 'no card');
});

test('a turn that failed is over: later starts do not wake Shiori again for it', async (t) => {
  useClock(t);
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

test('ask with options that are not a list of one to six strings is an error Shiori sees, and nothing is shown', async (t) => {
  useClock(t);
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

test('a request cut off because the page is being left is not a failed turn: the next start answers the message', async (t) => {
  useClock(t);
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

test('read sends a request copy, named by the turn that sends it, with both sizes; a later read reuses it', async (t) => {
  useClock(t);
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

test("a model that can't see photos reads one: a model that can describes it, the part asked for too, and says it did (emulator pass, the user: 5b)", async (t) => {
  useClock(t);
  const k = await agentKit([[
    { toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }, { name: 'read', input: { path: '/trip/files/menu.webp', region: [0.5, 0.5, 1, 1] } }] },
    say('The fish is $32.'),
  ]], { models: [{ input: ['text'] }], utility: [{ text: 'A menu; the fish dish is circled, $32.' }, { text: 'The bottom right: "Fish of the day $32".' }] });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('4000x3000'), { author: 'user', type: 'image/webp', meta: { width: 4000, height: 3000 } });
  k.agent.send('What does the menu say about fish?');
  await k.agent.idle();
  const [whole, part] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'read');
  assert.match(whole.data.content, /^The photo \/trip\/files\/menu\.webp, .*\nWhat it shows \(described by model-u, as you can't see photos\): A menu; the fish dish is circled, \$32\.$/s);
  assert.match(part.data.content, /part \[0\.5, 0\.5, 1, 1\].*\nWhat it shows \(described by model-u, as you can't see photos\): The bottom right: "Fish of the day \$32"\.$/s);
  assert.equal(whole.data.images, undefined, 'the words in place of the photo');
  // The describer saw the photo, and then the crop: the part asked for.
  const looked = k.sent['model-u'].map((/** @type {any} */ r) => r.messages[0].parts.find((/** @type {any} */ p) => p.type === 'image'));
  assert.equal(looked.length, 2);
  assert.match(Buffer.from(looked[1].data, 'base64').toString(), /^2000x1500:\{"x":2000,"y":1500,"width":2000,"height":1500\}/);
  assert.doesNotMatch(JSON.stringify(k.sent['model-0']), /"type":"image"/);
  assert.equal(JSON.stringify(k.requests[0].tools), JSON.stringify(k.sent['model-0'].at(-1).tools), 'the same tools: the cached prefix holds');
});

test("a model that can't see photos reads one, and no model here can: the result says so", async (t) => {
  useClock(t);
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }] }, say('I can\'t see it.')]], { models: [{ input: ['text'] }], utility: [{ text: 'never' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text'] } });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('4000x3000'), { author: 'user', type: 'image/webp', meta: { width: 4000, height: 3000 } });
  k.agent.send('What does the menu say?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.equal(r.data.content.split('\n').at(-1), noReader('image', { plugin: false }));
  assert.equal(k.sent['model-u'], undefined);
});

test("describing a photo for a model that can't see it has a time limit, and stops with the turn; either way the result says so in words and the turn goes on (review A5)", async (t) => {
  useClock(t);
  const photo = async (/** @type {any} */ k) => k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('4000x3000'), { author: 'user', type: 'image/webp', meta: { width: 4000, height: 3000 } });
  const read = { toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }] };
  // A describer slower than the limit (30 s; 300 ms at secondMs 10): words, and her turn goes on.
  const slow = await agentKit([[read, say('I could not see it.')]], { models: [{ input: ['text'] }], utility: [{ delayMs: 3000, text: 'Too late.' }] });
  await photo(slow);
  const t0 = Date.now();
  slow.agent.send('What does the menu say?');
  await slow.agent.idle();
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  const r = (await slow.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /\nIt couldn't be described in time \(30 seconds\)\.$/);
  assert.equal(r.data.ok, true);
  assert.deepEqual((await slow.events(['out.speak'])).map((e) => e.data.text), ['I could not see it.']);
  // The user stops her while it is described: the turn ends at once.
  const stopped = await agentKit([[read, say('Never said.')]], { models: [{ input: ['text'] }], utility: [{ delayMs: 3000, text: 'Too late.' }], agent: { secondMs: 1000 } });
  await photo(stopped);
  stopped.agent.send('What does the menu say?');
  await until(() => (stopped.sent['model-u'] ?? []).length === 1, 3000);
  const t1 = Date.now();
  stopped.agent.interrupt();
  await stopped.agent.idle();
  assert.ok(Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
  assert.equal((await stopped.events(['out.speak'])).length, 0);
});

test('read with a region sends a crop, kept in the conversation, and says which region was used', async (t) => {
  useClock(t);
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

test('a photo the user sends goes in their message as a request copy, and comes back the same after a reload', async (t) => {
  useClock(t);
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

test('a photo sent with no words says "(a photo)"; one sent while Shiori waits for an answer reaches her right after it', async (t) => {
  useClock(t);
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

test('a wake for a trip that is not open is written into its conversation, and answered when it opens (spec §7.3)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Your flight pass: I put it in the plan.')]]);
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.wake({ kind: 'file', scope: B, files: ['/files/flight.pkpass'], text: 'The user added a file to the trip: /trip/files/flight.pkpass (application/vnd.apple.pkpass).' });
  await k.agent.idle();
  assert.equal(k.requests.length, 0);
  assert.equal((await eventsIn(k, A, ['wake'])).length, 0);
  assert.deepEqual((await eventsIn(k, B, ['wake'])).map((/** @type {any} */ e) => e.data.reasons.map((/** @type {any} */ r) => [r.kind, r.files])), [[['file', ['/files/flight.pkpass']]]]);
  await k.agent.open(B);
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
  assert.match(userTexts(k.requests[0]), /flight\.pkpass/);
  // She isn't told annai restarted: it came while the conversation was closed.
  assert.doesNotMatch(userTexts(k.requests[0]), /The conversation closed before you answered/);
  assert.match(userTexts(k.requests[0]), /You haven't answered this yet: it came while this conversation was closed/);
  assert.deepEqual((await eventsIn(k, B, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Your flight pass: I put it in the plan.']);
});

test('a wake kept for a trip that is not open is written by the time wake() settles', async (t) => {
  useClock(t);
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

test('a wake for the open trip, named by its scope, runs there as before', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Got it.')]]);
  k.agent.wake({ kind: 'file', scope: k.trip, text: 'The user added a file to the trip: /trip/files/a.pdf (application/pdf).' });
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
});

test("show: a plugin's card type joins the tool's card, its data is checked, and an unknown type is refused (spec §16.4)", async (t) => {
  useClock(t);
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

test("show keeps only http(s) links, a photo and a booking inside the trip (or /me), and choices that are words (the fix pass's security review)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [
    { name: 'show', input: { card: { title: 'Bixby', links: [{ label: 'Map', url: 'https://maps.example' }, { label: 'Run', url: 'javascript:alert(1)' }], image: '/etc/hosts', booking: '/me/../trip/x.json', choice: ['Go', { no: 1 }] } } },
    { name: 'show', input: { card: { title: 'Kept', image: '/trip/files/bixby.webp', booking: '/trip/bookings/hotel.json' } } },
    { name: 'sleep', input: {} },
  ] }]]);
  k.agent.send('Bixby?');
  await k.agent.idle();
  assert.deepEqual((await k.events(['out.show'])).map((e) => e.data.card), [
    { title: 'Bixby', links: [{ label: 'Map', url: 'https://maps.example' }], choice: ['Go'] },
    { title: 'Kept', image: '/trip/files/bixby.webp', booking: '/trip/bookings/hotel.json' },
  ]);
});

test("show and ask take only so much (the second fix pass): a title of 200 characters, a text of 4,000, 6 links and 6 choices of 100 characters, a URL of 2,000; a question of 500 and options of 100, else ask is refused", async (t) => {
  useClock(t);
  const long = (/** @type {number} */ n) => 'x'.repeat(n);
  const links = [{ label: long(150), url: 'https://e.example/0' }, ...Array.from({ length: 6 }, (_, i) => ({ label: `L${i + 1}`, url: `https://e.example/${i + 1}` }))];
  const card = { title: long(300), text: long(5000), place: { name: long(300), address: 'Big Sur' }, links: [{ label: 'far', url: `https://e.example/${long(2100)}` }, ...links], choice: [long(150), ...Array.from({ length: 7 }, (_, i) => `C${i}`)] };
  const k = await agentKit([[{ toolCalls: [
    { name: 'show', input: { card } },
    { name: 'ask', input: { question: long(600), options: ['Yes'] } },
    { name: 'ask', input: { question: 'Which?', options: ['Yes', long(150)] } },
    { name: 'sleep', input: {} },
  ] }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  const [shown] = await k.events(['out.show']);
  const c = shown.data.card;
  assert.deepEqual([c.title.length, c.text.length, c.place.name.length, c.title.at(-1)], [200, 4000, 200, '…']);
  assert.equal(c.place.address, 'Big Sur');
  assert.deepEqual(c.links.map((/** @type {any} */ l) => l.url), Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`), 'the URL too long for a browser left out, then 6');
  assert.equal(c.links[0].label.length, 100);
  assert.deepEqual(c.choice, ['C0', 'C1', 'C2', 'C3', 'C4', 'C5']);
  const asks = (await k.events(['tool.result'])).filter((e) => e.data.name === 'ask');
  assert.deepEqual(asks.map((e) => e.data.ok), [false, false]);
  assert.match(asks[0].data.content, /500 characters/);
  assert.match(asks[1].data.content, /100 characters/);
  assert.equal((await k.events(['out.ask'])).length, 0);
});

test('show refuses a card with nothing to show, once what can\'t be shown is left out (the second fix pass)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'show', input: { card: { links: [{ label: 'Run', url: 'javascript:alert(1)' }] } } }, { name: 'sleep', input: {} }] }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  const [r] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'show');
  assert.equal(r.data.ok, false);
  assert.match(r.data.content, /nothing to show/);
  assert.equal((await k.events(['out.show'])).length, 0);
});

test('a wake already in the log that joins mid-turn (a review, "Koe answered the user") stays a line of the conversation: "woke for" gives it once, and later steps still read it (the second fix pass, M5)', async (t) => {
  useClock(t);
  const list = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const k = await agentKit([[{ delayMs: 200, ...list }, list, say('Nothing to add.')]]);
  k.agent.send('Look around');
  await until(() => k.requests.length === 1);
  k.agent.enqueue({ kind: 'cue', text: 'a review: tell Koe what it got wrong; otherwise sleep', logged: true });
  await k.agent.idle();
  assert.equal(k.requests.length, 3);
  assert.match(k.requests[1].tail, /woke for: a review: tell Koe what it got wrong/);
  assert.doesNotMatch(k.requests[2].tail, /woke for/);
  assert.match(JSON.stringify(k.requests[2].messages), /\[annai\] a review: tell Koe what it got wrong; otherwise sleep/);
});

test("8c-1: an image a tool returns that isn't base64 is that tool's error; Shiori's turn goes on", async (t) => {
  useClock(t);
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

test('the cache lasts an hour unless the user chose five minutes; a model without the hour asks for five minutes (the user, 2026-10-18)', async (t) => {
  useClock(t);
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

test('a tool result with a photo and a PDF, for a model that reads PDFs but sees no photos: the photo in words, the PDF as it is (fix pass)', async (t) => {
  useClock(t);
  const { toBase64 } = await import('../../src/core/bytes.js');
  const k = await agentKit([[{ toolCalls: [{ name: 'claim', input: {} }] }, say('Seen.')]], { models: [{ input: ['text', 'pdf'] }] });
  k.registry.add('test', 'tool', { name: 'claim', description: 'Both.', input: { type: 'object' }, run: async () => ({
    content: 'Two files.', images: [{ mediaType: 'image/png', data: toBase64(new TextEncoder().encode('png')) }],
    document: { mediaType: 'application/pdf', data: toBase64(new TextEncoder().encode('%PDF-1.4 booking')), name: 'booking.pdf' },
  }) });
  k.agent.send('Look');
  await k.agent.idle();
  const second = JSON.stringify(k.sent['model-0'][1].messages);
  assert.match(second, /No model here can see photos/);
  assert.match(second, /"type":"document"/, 'the PDF is kept');
  assert.doesNotMatch(second, /"type":"image"/);
});

test('describing is never started once the turn is stopped: an already-stopped signal sends nothing to a model (fix pass)', async (t) => {
  useClock(t);
  const { toBase64 } = await import('../../src/core/bytes.js');
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[say('x')]], { models: [{ input: ['text', 'image'] }], utility: [{ text: 'never' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text', 'pdf'] } });
  const stopped = new AbortController();
  stopped.abort();
  const out = await k.agent.describe({ content: 'A PDF.', document: { mediaType: 'application/pdf', data: toBase64(new TextEncoder().encode('%PDF-1.4 booking')) } }, 'w1', stopped.signal, { input: ['text'] });
  assert.equal((k.sent['model-u'] ?? []).length, 0);
  assert.match(out.content, /It wasn't described: /);
});

test("each of Shiori's lines carries the model that wrote it, the role's first, and whether that was tried (the second review of phone-fixes-1)", async (t) => {
  useClock(t);
  const k = await agentKit([[{ error: 'auth', message: 'bad key' }], [say('Hi.')]]);
  k.agent.send('Hello');
  await k.agent.idle();
  const [line] = await k.events(['out.speak']);
  assert.deepEqual(line.data.by, { name: 'model-1', first: 'model-0', tried: true });
});

test("the reader fails after reading, and a model that reads no PDFs answers with it told in words (2026-10-28, 04:04: 'It doesn't read PDFs' on every model)", async (t) => {
  useClock(t);
  const k = await bookingKit([[readPdf, { error: 'credit', status: 402 }], [say('Check-in is at 3 PM.')]], { models: [{ input: ['text', 'pdf'] }, { input: ['text'] }], utility: [{ text: 'Hotel booking: check-in 3 PM.' }] }, ['text', 'pdf']);
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const sent = JSON.stringify(k.sent['model-1'][0].messages);
  assert.match(sent, /\[a PDF: booking\.pdf\] What it says \(told by model-u, as you can't read PDFs\): Hotel booking: check-in 3 PM\./);
  assert.doesNotMatch(sent, /"type":"document"/);
  const turn = (await k.events(['model.turn'])).find((e) => e.data.answeredBy === 'model-1');
  assert.deepEqual(turn.data.attempts.map((/** @type {any} */ a) => a.outcome), ['credit', 'no-documents', 'ok']);
  assert.equal((await k.events(['error'])).length, 0, 'no failure shown');
});

test('the user\'s photo, when no model of Kokoro\'s sees photos: described by one that does, then answered', async (t) => {
  useClock(t);
  const k = await agentKit([[say('A menu.')]], { models: [{ input: ['text'] }], utility: [{ text: 'A menu; the fish is circled.' }] });
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send("What's this?", { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.match(JSON.stringify(k.sent['model-0'][0].messages), /\[a photo: \/trip\/files\/[^\]]+\] What it shows \(described by model-u, as you can't see photos\): A menu; the fish is circled\./);
  assert.equal((await k.events(['error'])).length, 0);
});

test("Koe's turn has no second pass: a PDF in her newest message is never read for a model of hers that can't take it, as she answers at once", async (t) => {
  useClock(t);
  const { saveModel } = await import('../../src/core/llm/config.js');
  // Koe's first model reads PDFs, reads the booking, then is out of credit; her second reads none. Utility's could read it.
  const k = await bookingKit([[sleepStep]], { koe: { talk: [readPdf, { error: 'credit', status: 402 }], type: [say('One moment.')] }, utility: [{ text: 'Flight AN 123.' }] }, ['text', 'pdf']);
  const cfg = await k.llm.config();
  await saveModel(k.ws, { ...cfg.models['m-koet'], user: { ...cfg.models['m-koet'].user, input: ['text', 'pdf'] } });
  await saveModel(k.ws, { ...cfg.models['m-koe'], user: { ...cfg.models['m-koe'].user, input: ['text'] } });
  k.agent.send('When do I fly?');
  await k.agent.idle();
  assert.equal((await k.events(['model.turn'])).filter((e) => e.data.tag === 'describe').length, 0, 'nobody was asked to read it for Koe');
  assert.equal((k.sent['model-u'] ?? []).length, 0);
});
