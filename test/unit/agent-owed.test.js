import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { createTrip } from '../../src/core/scopes.js';
import { useClock } from './clock.js';

// Her question card answered (typed, tapped or spoken) is a line of the user's that is owed a reply, as a typed line that joins her turn is: she is asked
// once more if her reply shows them nothing (spec §7.1), and a second silence is the card "Shiori didn't answer". The real runs of 2026-11-14 (ask-sleep-r1):
// after an answered card 7 of 55 replies showed the user nothing (plain text she never sees, `sleep` only, `wait` only), and no nudge followed.

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const ask = { name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } };
const sleep = { name: 'sleep', input: {} };
/** What her reply to the answer holds, and what she does after it: the user was shown nothing by it. */
const silent = /** @type {const} */ ({
  'plain text': [{ text: 'Moved it to 7.' }],
  'sleep only': [{ toolCalls: [sleep] }],
  'wait only': [{ toolCalls: [{ name: 'wait', input: { seconds: 1 } }] }, { toolCalls: [sleep] }],
});
/** How the card is answered; the voice ones need the microphone. */
const answers = /** @type {const} */ ({
  typed: { voice: false, answer: (/** @type {any} */ k) => k.agent.send('Neither, the café') },
  tapped: { voice: false, answer: (/** @type {any} */ k) => k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it') },
  spoken: { voice: true, answer: (/** @type {any} */ k) => hear(k, 'first-one') },
});

for (const [how, { voice, answer }] of Object.entries(answers)) {
  for (const [shape, reply] of Object.entries(silent)) {
    for (const withSleep of [false, true]) {
      test(`her question${withSleep ? ' and sleep' : ''} answered ${how}, then a reply that shows them nothing (${shape}): she is asked once more, and answers`, async (t) => {
        useClock(t);
        const first = { toolCalls: withSleep ? [ask, sleep] : [ask] };
        const k = await agentKit([[first, ...reply, say('Moved to 7.')]], voice ? { voice: { playMs: 5, speechIn: ['m-hear'], hears: ['yes the first one'] } } : {});
        k.agent.send('We are running late');
        if (voice) await until(() => k.agent.state.name === 'listening');
        else await until(() => k.agent.pendingId !== null);
        await answer(k);
        await k.agent.idle();
        assert.equal(k.requests.length, 2 + reply.length, 'the answer, her reply, then the one request more');
        assert.match(k.requests.at(-1).tail, /The user hasn't been answered/);
        assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'Moved to 7.');
        assert.deepEqual(k.notices, [], 'she answered at the second asking: no card');
        assert.equal(k.agent.state.name, 'sleeping');
      });
    }
  }
}

test("a question answered, and her reply says nothing twice: the card \"Shiori didn't answer\" shows, with Try again, as for a typed line", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [ask] }, { text: 'Moved it to 7.' }, { toolCalls: [sleep] }, say('Moved to 7.')]]);
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await k.agent.idle();
  assert.equal(k.requests.length, 3, 'asked once more, not twice');
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => [n.title, n.actions.map((/** @type {any} */ a) => a.label)]), [["Shiori didn't answer", ['Try again']]]);
  assert.equal(k.agent.transcript.unanswered, false, 'the card says so: a later start owes nothing');
});

test('a question answered, then a reply that reaches them (speak or show): nothing is owed, so no second request for it', async (t) => {
  useClock(t);
  for (const reach of /** @type {any[]} */ ([{ name: 'speak', input: { text: 'Moved to 7.' } }, { name: 'show', input: { card: { title: 'Dinner', text: '7:00' } } }])) {
    const k = await agentKit([[{ toolCalls: [ask] }, { toolCalls: [reach, sleep] }]]);
    k.agent.send('We are running late');
    await until(() => k.agent.pendingId !== null);
    k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
    await k.agent.idle();
    assert.equal(k.requests.length, 2, `${reach.name}: no nudge`);
    assert.deepEqual(k.notices, []);
  }
});

test('a question answered, then a lookup before she speaks: the answer is owed only where her turn ends, so no cue between (as for a typed line)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [ask] }, { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, { toolCalls: [{ name: 'list', input: { path: '/me/' } }] }, say('Moved to 7.')]]);
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await k.agent.idle();
  assert.equal(k.requests.length, 4);
  assert.ok(k.requests.every((/** @type {any} */ r) => !/hasn't been answered/.test(r.tail)), 'no cue');
  assert.deepEqual(k.requests.map((/** @type {any} */ r) => r.toolRequired), [true, undefined, undefined, undefined], 'forced only as a first step, as before');
  assert.deepEqual(k.notices, []);
});

test('a question answered, and she speaks after it in the same reply: what she said reached them, so a bare sleep after that owes nothing', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [ask, { name: 'speak', input: { text: 'Checking.' } }, sleep] }, { toolCalls: [sleep] }]]);
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'her next reply is a bare sleep: nothing owed, no nudge');
  assert.deepEqual(k.notices, []);
});

test('a line the user typed to her, not at a card, still needs its own reply: the answer rule adds nothing to a turn that had no question (control)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [sleep] }]]);
  k.agent.send('Hello');
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'asked once more, as before');
  assert.equal(k.notices.length, 1);
});

test("her ask and sleep answered, her hand-over's turn goes on: what she does after the answer is the hand-over's, so its Undo takes it back (Try again after her next call fails)", async (t) => {
  useClock(t);
  const flight = { path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
  const files = { toolCalls: [{ name: 'write', input: { path: '/trip/notes/f.md', content: 'AS 123' } }, { name: 'speak', input: { text: 'Filed.' } }, sleep] };
  const fails = { error: 'server', status: 500, message: 'Scripted failure.' };
  const hers = async (/** @type {any} */ k) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori');
  /** @type {any[]} */
  const got = [];
  for (const first of [[ask, sleep], [ask], [{ name: 'read', input: { path: '/trip/nope/missing.md' } }, sleep], [{ name: 'read', input: { path: '/trip/nope/missing.md' } }]]) {
    const k = await agentKit([[{ toolCalls: first }, fails, fails, fails, fails, files]]);
    k.agent.send('Here', { handed: [flight], handover: 'h-1' });
    if (first[0] === ask) {
      await until(() => k.agent.pendingId !== null);
      k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Yes');
    }
    await k.agent.idle();
    k.agent.tryAgain();
    await k.agent.idle();
    got.push((await hers(k)).map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]));
  }
  assert.deepEqual(got, Array(4).fill([['/notes/f.md', 'h-1']]), 'the same for a sleep beside the call and none');
});

test("her ask and sleep answered with a hand-over, the page left during her next call and returned to: a reload still finds the hand-over owed, and the turn taken up carries it", async (t) => {
  useClock(t);
  const flight = { path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
  const files = { toolCalls: [{ name: 'write', input: { path: '/trip/notes/f.md', content: 'AS 123' } }, { name: 'speak', input: { text: 'Filed.' } }, sleep] };
  const k = await agentKit([[{ toolCalls: [ask, sleep] }, { delayMs: 300, ...say('x') }, files]]);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.send('Here', { handed: [flight], handover: 'h-1' });
  await until(() => k.agent.pendingId !== null);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Yes');
  await until(() => k.requests.length === 2);
  assert.equal((await Transcript.load(k.store, k.trip)).handover, 'h-1', 'a reload now: the answer is owed, with its hand-over');
  await k.agent.open(other);
  await k.agent.idle();
  await k.agent.open(k.trip);
  await k.agent.idle();
  const writes = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori');
  assert.deepEqual(writes.map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]), [['/notes/f.md', 'h-1']]);
});

test("a sleep that gave way is stored as such whatever became of its input: one that was not an object, beside an answered question, is taken up after a reload", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [ask, { name: 'sleep', input: 'not-an-object' }] }, { delayMs: 300, ...say('Moved to 7.') }, say('Taken up.')]]);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await until(() => k.requests.length === 2);
  const stored = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'sleep');
  assert.equal(stored.data.awake, true, 'the stored result says the sleep gave way');
  await k.agent.open(other);
  await k.agent.idle();
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal(k.requests.length, 3, 'taken up on return');
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'Taken up.');
});

test("a question waiting with a sleep beside it, and another conversation opened: let go as the question alone is (the sleep cut with it is stored as one that gave way, and nothing is taken up on return)", async (t) => {
  useClock(t);
  for (const calls of [[ask], [ask, sleep]]) {
    const k = await agentKit([[{ toolCalls: calls }, say('Back to it.')]]);
    k.agent.send('Plan tonight');
    await until(() => k.agent.pendingId !== null);
    await k.agent.open(await createTrip(k.ws, { title: 'Kyoto' }));
    await k.agent.idle();
    const events = (/** @type {string[]} */ types) => k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types }));
    const stored = (await events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'sleep');
    assert.equal(stored?.data.awake, calls.length === 2 ? true : undefined, 'a sleep cut before it ran, whose turn was going on, says so');
    const before = k.requests.length;
    await k.agent.open(k.trip);
    await k.agent.idle();
    assert.deepEqual([(await events(['paused'])).length, k.requests.length - before], [0, 0], `${calls.length} calls: no paused line, nothing taken up`);
  }
});
