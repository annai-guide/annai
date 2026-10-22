import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { TALK_TAG, record } from '../../src/core/agent/log.js';
import { createTrip } from '../../src/core/scopes.js';
import { Agent, UNANSWERED, FORCED_STEPS } from '../../src/core/agent/loop.js';
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

test("the user's message, answered only in plain text: she is asked once more; still nothing for the user, a card with Try again (spec §7.1, emulator pass)", async () => {
  const k = await agentKit([[{ text: 'Big Sur is known for its coast.' }, { toolCalls: [{ name: 'sleep', input: {} }] }, say('Its wild coast, mostly.')]]);
  k.agent.send('What is Big Sur known for?');
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'asked once more, in the same turn');
  assert.match(JSON.stringify(k.requests[1].messages.at(-1)), new RegExp(UNANSWERED.slice(0, 40)));
  assert.match(k.requests[1].tail, /The user hasn't been answered/);
  assert.equal((await k.events(['wake'])).filter((e) => !e.data.meanwhile).length, 1, 'one turn');
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => [n.title, n.body, n.actions.map((/** @type {any} */ a) => a.label)]), [["Shiori didn't answer", 'Her model finished without saying anything to you.', ['Try again']]]);
  assert.equal((await k.events(['error']))[0].data.kind, 'silent');
  assert.equal(k.agent.transcript.unanswered, false, 'the card said so: a later start owes nothing');
  // Try again: her turn again, the user's, answered this time.
  k.notices[0].actions[0].run();
  await k.agent.idle();
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Its wild coast, mostly.');
  assert.match(k.requests[2].tail, /woke for: the user tapped Try again/);
  assert.equal(k.notices.length, 1);
});

test('a turn that spoke to the user, or one the user didn\'t start, ends as it is: no second ask, no card', async () => {
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

test("the connection going and coming back sets a resting Shiori's state at once, not only at a turn's end (emulator pass m2b #10)", async () => {
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

test('the warm model goes first only in the order it answered in: an order the user changed applies from the next turn (emulator pass)', async () => {
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

test("a tap while she's thinking stops her turn, and a new one starts at once with what was sent meanwhile; the dock says a tap stops her (item 17)", async () => {
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

test("no model answers: a system card, never in Shiori's voice", async () => {
  const k = await agentKit([[{ error: 'auth', status: 401 }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.notices[0].title, "Shiori can't reach her model");
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal((await k.events(['error']))[0].data.kind, 'model');
});

test("a model error card is taken down when a later turn works: the same key, then a clear; a \"didn't answer\" card when she then speaks (the second emulator pass)", async () => {
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

test("the \"didn't answer\" card goes only with a later turn the user started in its conversation that spoke to them: not a reminder's, nor another conversation's (the fix pass)", async () => {
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

test("the card says why each model failed on one line, each reason once, in words; offline, that the device is (emulator pass)", async () => {
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

test("a model that reads no PDFs reads one: a model that does tells it in words, and says so; with none here, the result says that (the second emulator pass)", async () => {
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
  assert.match(nr.data.content, /\nNo model here can read PDFs, so what it says can't be told\.$/);
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

test('a PDF told only up to the output limit says it stops there; a second read in the session is told from what was told, never sent again (the fix pass, S6)', async () => {
  const k = await pdfKit([readPdf, readPdf, say('Check-in is at 3 PM.')], [{ text: 'Hotel booking: check-in 3 PM, 2 nights. Room', stop: 'length' }]);
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const reads = (await k.events(['tool.result'])).filter((e) => e.data.name === 'read').map((e) => e.data.content);
  assert.equal(reads.length, 2);
  assert.match(reads[0], /: Hotel booking: check-in 3 PM, 2 nights\. Room …\(it stops here: the PDF goes on\)$/);
  assert.equal(reads[1], reads[0]);
  assert.equal(k.sent['model-u'].length, 1, 'the PDF went to be told once');
});

test("the told PDFs are keyed by the bytes told, in their conversation: a part claiming an earlier PDF's hash with other bytes is told afresh, and another conversation never gets the first one's words (the fix pass's security review)", async () => {
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

test('Erase forgets the PDFs told this session (the fix pass\'s security review)', async () => {
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

test("a PDF has longer to be told than a photo to be described: a telling that takes more than a photo's 30 seconds still comes (the fix pass, S6)", async () => {
  const { DESCRIBE_S, DESCRIBE_PDF_S } = await import('../../src/core/agent/loop.js');
  assert.ok(DESCRIBE_PDF_S > DESCRIBE_S);
  // secondMs is 10 here: 30 seconds are 300 ms.
  const k = await pdfKit([readPdf, say('Check-in is at 3 PM.')], [{ delayMs: (DESCRIBE_S + 15) * 10, text: 'Hotel booking: check-in 3 PM.' }]);
  k.agent.send('When is check-in?');
  await k.agent.idle();
  const read = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(read.data.content, /What it says \(told by model-u, as you can't read PDFs\): Hotel booking: check-in 3 PM\.$/);
});

test('a PDF read earlier does not close the conversation to a model that reads none: it goes as a note (the second emulator pass: halo, "type file is not supported")', async () => {
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

test('a model that takes no photos answers once the conversation holds one; a photo just sent needs a model that sees it (emulator pass)', async () => {
  const k = await agentKit([[{ error: 'credit', status: 402 }], [say('Pfeiffer Beach is close.')]], { models: [{}, { input: ['text'] }] });
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal(k.sent['model-1'], undefined, "passed over: it couldn't see the photo it was asked about");
  assert.match(k.notices[0].body, /model-1: It doesn't take photos\./);
  k.agent.send("What's around here?");
  await k.agent.idle();
  const [asked] = k.sent['model-1'];
  assert.match(JSON.stringify(asked.messages), /\[a photo: \/trip\/files\/p\.webp\]/);
  assert.doesNotMatch(JSON.stringify(asked.messages), /"type":"image"/);
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Pfeiffer Beach is close.');
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

test('killed after her tool calls came back, before her next reply: opening the conversation takes the turn up (emulator pass m2b #21)', async () => {
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

test("a turn the user stopped isn't taken up when the conversation opens again, even if her tool calls had come back (spec §6.7)", async () => {
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

test("Shiori's turns ask the model to call a tool (she reaches the user only through tools); housekeeping and the utility model's jobs don't, nor a turn with the model's own search on (item 15)", async () => {
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

test('a tool call is asked for only until she has reached the user in the turn: after that she may end in words (review A4)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Big Sur: the coast.' } }] }, { text: 'Done.' }]]);
  k.agent.send('What is Big Sur known for?');
  await k.agent.idle();
  assert.deepEqual(k.requests.map((/** @type {any} */ r) => r.toolRequired), [true, undefined]);
  assert.deepEqual(k.notices, [], 'it reached the user: no nudge');
});

test('with no steps-per-wake limit set, a long turn runs past 25 steps and reaches the user, with no step card', async () => {
  const a = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const b = { toolCalls: [{ name: 'list', input: { path: '/me/' } }] };
  const k = await agentKit([[...Array.from({ length: 30 }, (_, i) => (i % 2 ? b : a)), say('The whole day is planned.')]]);
  k.agent.send('Plan our whole Big Sur day');
  await k.agent.idle();
  assert.equal(k.requests.length, 31);
  assert.deepEqual(k.notices, [], 'no step-limit card, and she reached the user');
});

test(`forcing stops after ${FORCED_STEPS} forced calls without reaching the user: she may then end in words, is nudged once, and the card follows`, async () => {
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

test('a search whose replies are shown as written (Google Search): one Shiori is told so while it is on, in the same words every turn, so she writes that reply for the user; Kokoro, behind Koe, is not (G4)', async () => {
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
  assert.match(card.body, /bad utility key/i);
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

test("a model that can't see photos reads one: a model that can describes it, the part asked for too, and says it did (emulator pass, the user: 5b)", async () => {
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

test("a model that can't see photos reads one, and no model here can: the result says so", async () => {
  const { saveModel } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[{ toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }] }, say('I can\'t see it.')]], { models: [{ input: ['text'] }], utility: [{ text: 'never' }] });
  const u = (await k.llm.config()).models['m-u'];
  await saveModel(k.ws, { ...u, user: { ...u.user, input: ['text'] } });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('4000x3000'), { author: 'user', type: 'image/webp', meta: { width: 4000, height: 3000 } });
  k.agent.send('What does the menu say?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'read');
  assert.match(r.data.content, /\nNo model here can see photos, so what it shows can't be told\.$/);
  assert.equal(k.sent['model-u'], undefined);
});

test("describing a photo for a model that can't see it has a time limit, and stops with the turn; either way the result says so in words and the turn goes on (review A5)", async () => {
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

test("show keeps only http(s) links, a photo and a booking inside the trip (or /me), and choices that are words (the fix pass's security review)", async () => {
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

test("show and ask take only so much (the second fix pass): a title of 200 characters, a text of 4,000, 6 links and 6 choices of 100 characters, a URL of 2,000; a question of 500 and options of 100, else ask is refused", async () => {
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

test('show refuses a card with nothing to show, once what can\'t be shown is left out (the second fix pass)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'show', input: { card: { links: [{ label: 'Run', url: 'javascript:alert(1)' }] } } }, { name: 'sleep', input: {} }] }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  const [r] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'show');
  assert.equal(r.data.ok, false);
  assert.match(r.data.content, /nothing to show/);
  assert.equal((await k.events(['out.show'])).length, 0);
});

test('a wake already in the log that joins mid-turn (a review, "Koe answered the user") stays a line of the conversation: "woke for" gives it once, and later steps still read it (the second fix pass, M5)', async () => {
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
