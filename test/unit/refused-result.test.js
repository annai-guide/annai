// A tool call whose result the phone refused (tool-result-next; the Deferred entry "A tool call whose result the phone refused leaves its conversation
// unable to hear the traveller"): her turn stops with the call open. The next turn's start gives it its result before its first line (loop.js #turn), so
// once there is room the traveller's next line there is in her request after it, not held behind the call (transcript.js #line); and an open whose own
// repair is refused goes on without it, told (#notSaved, the storage card on a full phone), so that conversation opens on a full phone and shows what it owes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, rescript, until, raw, idleAtOnce, inTime } from './agent-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { tripTools } from '../../src/core/agent/trip-tools.js';
import { Transcript, RESTARTED } from '../../src/core/agent/transcript.js';
import { record, TALK_TAG } from '../../src/core/agent/log.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createTrip } from '../../src/core/scopes.js';
import { StorageFullError } from '../../src/core/errors.js';

const NOT_SAVED = "Something for Shiori wasn't saved";
const LEAVE = 'Leave for the airport by 14:10';
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const ask = { toolCalls: [{ name: 'ask', input: { question: 'Lunch or dinner?', options: ['Lunch', 'Dinner'] } }] };
/** The words of a request's user lines. @param {any} req @returns {string[]} */
const lines = (req) => req.messages.filter((/** @type {any} */ m) => m.role === 'user').flatMap((/** @type {any} */ m) => m.parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text));
/** The calls of a request that its next message doesn't answer: a provider refuses such a request, or answers without reading what follows. @param {any} req */
function unanswered(req) {
  const ms = req.messages;
  return ms.flatMap((/** @type {any} */ m, /** @type {number} */ i) => {
    const answered = ms[i + 1]?.role === 'user' ? ms[i + 1].parts.filter((/** @type {any} */ p) => p.type === 'tool_result').map((/** @type {any} */ p) => p.id) : [];
    return m.parts.filter((/** @type {any} */ p) => p.type === 'tool_call' && !answered.includes(p.id)).map((/** @type {any} */ p) => p.name);
  });
}
/** Each card that says a write wasn't saved, a full phone's (main.js shows the storage card in its place). @param {any[]} cards */
const notSaved = (cards) => cards.filter((n) => n.title === NOT_SAVED).map((n) => (n.error instanceof StorageFullError ? 'storage' : String(n.error)));
/** Her questions with buttons, as they are written. @param {any} k @returns {any[]} */
const questions = (k) => {
  /** @type {any[]} */
  const got = [];
  k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'out.ask' && !e.data.own) got.push(e); });
  return got;
};
/** A full phone's refusals: her answer's line (the first write after the tap), or her call's result alone. */
const SHAPES = /** @type {const} */ ([['her answer and its result refused', 'all'], ['its result alone refused', 'result']]);

/**
 * Who asks: one Shiori, two halves with Koe off (Kokoro's rules are one Shiori's), or Koe · Classic's chat model with Koe on, its calls marked as Koe's
 * (repair's mark: the transcript reads only its own half's results). Each with the model that asks and the half whose transcript holds the call.
 * @type {[string, { koe?: boolean, halves?: boolean }][]}
 */
const WHO = [['', {}], [', two halves with Koe off', { halves: true }], [', Koe on: its question', { koe: true }]];
/** A kit whose asking model asks first, then answers in words. @param {{ koe?: boolean, halves?: boolean }} o */
async function askingKit(o) {
  const asks = [ask, say('Lunch by the water.')];
  const k = o.koe ? await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: asks } }) : await agentKit([asks], { halves: Boolean(o.halves) });
  return { ...k, half: /** @type {'koe' | 'one'} */ (o.koe ? 'koe' : 'one'), asked: () => k.sent[o.koe ? 'model-koe' : 'model-0'] ?? [] };
}

/**
 * Her question card waits; the phone fills; the traveller taps Lunch: her turn stops ("Shiori stopped") with the call open, in memory and in the log.
 * @param {any} k @param {ReturnType<typeof refusing>} store @param {'all' | 'result'} which
 */
async function refusedAnswer(k, store, which) {
  const asked = questions(k);
  k.agent.send('Plans for today?');
  await until(() => asked.length === 1);
  await until(() => k.agent.state.name === 'waiting');
  store.full(which === 'all' ? 'all' : (ev) => ev.type === 'tool.result');
  k.agent.answer(asked[0].data.id, 'Lunch');
  await idleAtOnce(k);
  assert.ok(k.notices.some((/** @type {any} */ n) => n.title === 'Shiori stopped' && n.error instanceof StorageFullError), 'her turn stopped, with the storage card');
  assert.deepEqual((await Transcript.load(k.store, k.trip, { half: k.half })).open().map((c) => c.name), ['ask'], 'her call has no result in the log');
  return asked[0].data.id;
}

/** Once there is room, the traveller's next line there is in her request, after her call's result, which the turn wrote first. @param {any} k @param {string} id */
async function heardWithRoom(k, id) {
  const before = k.asked().length;
  k.agent.send('Where should we eat?', { typed: true });
  await idleAtOnce(k);
  assert.equal(k.asked().length, before + 1, 'her model was asked once');
  const req = k.asked().at(-1);
  assert.ok(lines(req).some((x) => x.includes('Where should we eat?')), `their line is in her request: ${JSON.stringify(lines(req))}`);
  assert.deepEqual(unanswered(req), [], 'every call of hers in it has its result');
  // A scripted model's ids repeat across halves (scripted_0_0): the asking half's own, by its mark.
  const results = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.id === id && (e.data.half === 'koe') === (k.half === 'koe'));
  assert.deepEqual(results.map((/** @type {any} */ e) => [e.data.content, e.data.cut]), [[RESTARTED, true]], 'the call got one result, written once');
  const [line] = (await k.events(['msg.user'])).filter((/** @type {any} */ e) => e.data.text === 'Where should we eat?');
  assert.ok(results[0].seq < line.seq, 'written before their line');
  assert.equal((await Transcript.load(k.store, k.trip, { half: k.half })).open().length, 0, 'nothing open in the log');
}

for (const [who, o] of WHO) {
  for (const [what, which] of SHAPES) {
    test(`her question card answered as the phone fills (${what})${who}: on the full phone a line typed there comes back to the box; once there is room the next one is heard`, async (t) => {
      useClock(t);
      const k = await askingKit(o);
      const store = refusing(k);
      const id = await refusedAnswer(k, store, which);
      // Still full for the result: the turn's start gives the call its result first, refused, so the turn stops there, before its first write: the line comes back.
      store.full((ev) => ev.type === 'tool.result');
      const asked = k.asked().length;
      k.agent.send('Hello?', { typed: true });
      await idleAtOnce(k);
      assert.equal(k.asked().length, asked, 'no request while the phone is full');
      assert.deepEqual(store.back.map((x) => x.words).at(-1), 'Hello?', 'the typed line comes back to the box');
      store.full(null);
      await heardWithRoom(k, id);
    });
  }
}

// The turn's start repairs inside its setup, so a refused repair stops it as a refused read of its setup does (#showOwed): a reminder it carried is shown.
test("her question card's answer refused, then a watch fires there on the full phone: the turn stops at its repair and shows the reminder once", async (t) => {
  useClock(t);
  const k = await askingKit({});
  const store = refusing(k);
  await refusedAnswer(k, store, 'all');
  store.full((ev) => ev.type === 'tool.result');
  const asked = k.asked().length;
  k.agent.wake({ kind: 'trigger', text: `Your watch fired: ${LEAVE}.`, fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await idleAtOnce(k);
  assert.equal(k.asked().length, asked, 'no request while the phone is full');
  assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === 'Reminder').map((/** @type {any} */ n) => n.body), [LEAVE]);
});

for (const [what, which] of SHAPES) {
  test(`her question card answered as the phone fills (${what}): the conversation opens again on the full phone, the refused repair told once; once there is room the next line is heard`, async (t) => {
    useClock(t);
    const k = await askingKit({});
    const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
    const store = refusing(k);
    const id = await refusedAnswer(k, store, which);
    store.full('all');
    await k.agent.open(kyoto);
    const cards = raw(k);
    await inTime(k.agent.open(k.trip), 'the open did not finish');
    await idleAtOnce(k);
    assert.equal(k.agent.trip, k.trip, 'it opened');
    assert.deepEqual(notSaved(cards), ['storage'], 'the refused repair, told once');
    assert.equal(k.agent.transcript.open().length, 1, 'the call is still open in memory');
    store.full(null);
    await heardWithRoom(k, id);
  });
}

// trip-tools.js open_trip: the traveller taps Open on annai's card, and the phone fills before her call's result (MOVED) is written; Kyoto opens.
test("Open on annai's card, the phone full before her call's result: back in the chat on the full phone it opens, told once; once there is room the next line there is heard", async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  const kyoto = await createTrip(k.ws, { title: 'Kyoto', start: '2027-04-01', end: '2027-04-08' });
  await k.agent.opening;
  /** @type {any[]} */
  const cards = [];
  k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'out.ask' && e.data.own) cards.push(e); });
  await rescript(k, { rules: [
    { match: 'the user wrote', reply: { toolCalls: [{ name: 'open_trip', input: { trip: kyoto, recap: 'We talked of Kyoto.' } }] }, then: say('We stay here, then.'), times: 1 },
    { match: 'the user wrote', reply: say('By the water.') },
    { match: '.', reply: sleep },
  ] });
  const store = refusing(k);
  const carry = k.agent.carryOn.bind(k.agent);
  k.agent.carryOn = (/** @type {any[]} */ ...a) => {
    store.full('all'); // after the tap's line is written, before her call's result
    return carry(...a);
  };
  const chat = { ...k, half: 'one', asked: () => k.sent['model-0'] ?? [] };
  k.agent.send("Let's carry on in Kyoto");
  await until(() => cards.length === 1);
  k.agent.answer(cards[0].data.tap, 'Open');
  await until(() => k.notices.some((/** @type {any} */ n) => n.title === 'Shiori stopped'));
  let settled = false;
  k.agent.kokoro.opening.catch(() => {}).finally(() => { settled = true; });
  await until(() => settled);
  assert.equal(k.agent.trip, kyoto, 'Kyoto opened');
  const [call] = (await Transcript.load(k.store, k.trip)).open();
  assert.equal(call?.name, 'open_trip', "the chat's log holds her call with no result");
  await idleAtOnce(k);
  const told = raw(k);
  await inTime(k.agent.open(k.trip), 'the open did not finish');
  await idleAtOnce(k);
  assert.equal(k.agent.trip, k.trip, 'the chat opened on the full phone');
  assert.deepEqual(notSaved(told), ['storage'], 'the refused repair, told once');
  store.full(null);
  await heardWithRoom(chat, call.id);
});

// The owed-leave entry's clause: the reminder a cut turn still owes is shown at its conversation's open, which its repair no longer stops on a full phone.
test('a conversation whose turn was cut in the middle of a call, owing a reminder: a new start on the full phone opens it and shows the reminder', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Back again.')]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'trigger', text: `Your watch fired: ${LEAVE}.` }], reminders: [{ watch: 'w1', text: LEAVE }] } });
  await modelTrace(k.store, k.trip).turn({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0' }, '', '',
    [{ type: 'tool_call', id: 'f1', name: 'list', input: { path: '/trip/' } }]);
  const store = refusing(k);
  store.full('all');
  const agent = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  agent.addLoopTools(selfTools(agent));
  /** @type {any[]} */
  const cards = [];
  agent.on('notice', (/** @type {any} */ n) => cards.push(n));
  await inTime(agent.open(k.trip), 'the open did not finish');
  await idleAtOnce({ agent });
  assert.equal(agent.trip, k.trip, 'it opened');
  assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE], 'the reminder is shown');
  assert.equal(k.requests.length, 0, 'nothing reached her model on the full phone');
});
