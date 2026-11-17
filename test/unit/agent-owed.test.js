import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, rescript, until, hear } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record, TALK_TAG } from '../../src/core/agent/log.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createTrip } from '../../src/core/scopes.js';
import { useClock } from './clock.js';
import { undoHandover } from '../../src/core/handover.js';
import { tripTools } from '../../src/core/agent/trip-tools.js';
import { utf8 } from '../../src/core/bytes.js';

// Her question card answered (typed, tapped or spoken) is a line of the user's that is owed a reply, as a typed line that joins her turn is: she is asked
// once more if her reply shows them nothing (spec §7.1), and a second silence is the card "Shiori didn't answer". The real runs of 2026-11-14 (ask-sleep-r1):
// after an answered card 7 of 55 replies showed the user nothing (plain text she never sees 3, `sleep` only 2, and a `wait` of 120 s twice that the run's
// 40 s window closed on), and no nudge followed.

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

test('a tap that arrives before her question is up answers it when it is: the answer is owed, so her silent reply is asked once more (the final review\'s slice 2: F2)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ delayMs: 200, toolCalls: [{ name: 'speak', input: { text: 'Checking.' } }, ask] }, { text: 'Moved it to 7.' }, say('Moved to 7.')]]);
  k.agent.send('We are running late');
  await until(() => k.requests.length === 1);
  k.agent.answer('nobody-waits', 'Move it'); // her question isn't up yet: the tap is queued, and her question takes it
  await k.agent.idle();
  assert.deepEqual(k.requests.map((/** @type {any} */ r) => /hasn't been answered/.test(r.tail)), [false, false, true], 'asked once more after her silent reply');
  assert.deepEqual(k.notices, []);
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'Moved to 7.');
});

test('a question answered, then her reply is shown as written (grounded by the model\'s own search): it reached them, so nothing is owed and no second request follows (the final review\'s slice 2: F3)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [ask] }, { text: 'Moved it to 7.', toolCalls: [sleep] }, say('Moved to 7.')]]);
  const scripted = k.llm.types().get('scripted');
  const run = scripted.run;
  let n = 0;
  scripted.run = async function* (/** @type {any} */ c) {
    const mine = n++;
    for await (const e of run(c)) {
      if (e.type === 'stop' && mine === 1) yield { type: 'attribution', source: 'Google Search', text: 'Moved it to 7.', links: [], html: '<div></div>' };
      yield e;
    }
  };
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await k.agent.idle();
  assert.equal((await k.events(['grounded'])).length, 1, 'her words were shown as written');
  assert.equal(k.requests.length, 2, 'no nudge after words that reached them');
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
    const out = await undoHandover(k.ws, k.trip, 'h-1');
    assert.deepEqual(out.undone, ['/notes/f.md'], 'its Undo takes it back');
    assert.equal(await k.ws.read(k.trip, '/notes/f.md'), undefined);
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

// A hand-over's turn that ends with no end logged is still owed its hand-over, however her reply ended in words: Try again, the user's next
// line, or the turn taken up carries it, and its Undo takes back what she files then (the turn-end record: the Deferred F2 with N1, L2 and L1).
const flight = { path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
const files = { toolCalls: [{ name: 'write', input: { path: '/trip/notes/f.md', content: 'AS 123' } }, { name: 'speak', input: { text: 'Filed.' } }, sleep] };
const fails = { error: 'server', status: 500, message: 'Scripted failure.' };
/** Her writes in the trip, with the hand-over each carries. @param {any} k */
const hers = async (k) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori').map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]);
/** The hand-over's Undo takes back what she filed. @param {any} k @param {string} what */
const undone = async (k, what) => {
  assert.deepEqual((await undoHandover(k.ws, k.trip, 'h-1')).undone, ['/notes/f.md'], `${what}: its Undo takes it back`);
  assert.equal(await k.ws.read(k.trip, '/notes/f.md'), undefined);
};

test("a hand-over, her card answered, her reply to the answer silent, and the one more request failing (Try again) or cut (the page left and back): what she files then is the hand-over's, so its Undo takes it back (the final review's F2, and N1's wait then sleep)", async (t) => {
  useClock(t);
  for (const first of [[ask], [ask, sleep]]) {
    for (const [shape, reply] of Object.entries(silent)) {
      const what = `${first.length === 2 ? 'ask and sleep' : 'ask'}, then ${shape}`;
      // The one more request fails; Try again.
      const k = await agentKit([[{ toolCalls: first }, ...reply, fails, fails, fails, fails, files]]);
      k.agent.send('Here', { handed: [flight], handover: 'h-1' });
      await until(() => k.agent.pendingId !== null);
      k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Yes');
      await k.agent.idle();
      assert.match(k.requests[1 + reply.length].tail, /The user hasn't been answered/, `${what}: the cue was sent, and failed`);
      k.agent.tryAgain();
      await k.agent.idle();
      assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']], `${what}: Try again's write is the hand-over's`);
      await undone(k, what);
      // The one more request cut by another conversation opened, and returned to.
      const c = await agentKit([[{ toolCalls: first }, ...reply, { delayMs: 300, ...say('x') }, files]]);
      const other = await createTrip(c.ws, { title: 'Kyoto' });
      c.agent.send('Here', { handed: [flight], handover: 'h-1' });
      await until(() => c.agent.pendingId !== null);
      c.agent.answer(/** @type {string} */ (c.agent.pendingId), 'Yes');
      await until(() => c.requests.length === 2 + reply.length);
      assert.equal((await Transcript.load(c.store, c.trip)).handover, 'h-1', `${what}: a reload now finds the hand-over owed`);
      await c.agent.open(other);
      await c.agent.idle();
      await c.agent.open(c.trip);
      await c.agent.idle();
      assert.deepEqual(await hers(c), [['/notes/f.md', 'h-1']], `${what}: the turn taken up on return carries it`);
      await undone(c, `${what}, cut`);
    }
  }
});

test("a typed line with a hand-over, her reply silent (plain text, a bare sleep), and the one more request failing (Try again) or cut (the page left and back, or a reload): what she files then is the hand-over's (the typed line's sibling of F2, L2)", async (t) => {
  useClock(t);
  for (const [shape, reply] of Object.entries({ 'plain text': { text: 'I will file it.' }, 'a bare sleep': { toolCalls: [sleep] } })) {
    const k = await agentKit([[reply, fails, fails, fails, fails, files]]);
    k.agent.send('Here is my flight', { handed: [flight], handover: 'h-1' });
    await k.agent.idle();
    assert.equal((await Transcript.load(k.store, k.trip)).owedHandover, 'h-1', `${shape}: after the failure the hand-over is still owed`);
    k.agent.tryAgain();
    await k.agent.idle();
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']], `${shape}: Try again's write is the hand-over's`);
    await undone(k, shape);
    const c = await agentKit([[reply, { delayMs: 300, ...say('x') }, files]]);
    const other = await createTrip(c.ws, { title: 'Kyoto' });
    c.agent.send('Here is my flight', { handed: [flight], handover: 'h-1' });
    await until(() => c.requests.length === 2);
    assert.deepEqual([(await Transcript.load(c.store, c.trip)).unanswered, (await Transcript.load(c.store, c.trip)).handover], [true, 'h-1'], `${shape}: a reload now takes the turn up with the hand-over`);
    await c.agent.open(other);
    await c.agent.idle();
    await c.agent.open(c.trip);
    await c.agent.idle();
    assert.deepEqual(await hers(c), [['/notes/f.md', 'h-1']], `${shape}: the turn taken up on return carries it`);
    await undone(c, `${shape}, cut`);
  }
});

// L1: a turn that went on past a sleep beside a failed call twice (all a turn allows), then a reply that speaks and holds a sleep, cut at its work:
// no end is logged, so it is taken up on return (an open) or its hand-over goes to the user's next line (a Stop), as with one failed reply before it.
const failing = { name: 'read', input: { path: '/trip/nope/missing.md' } };
/** A loop tool that takes a minute: the cut lands in it. @param {any} k */
const slow = (k) => {
  const at = { lingering: false };
  k.agent.addLoopTools([{ name: 'linger', pluginId: 'core', group: 'Time', description: 'Wait.', input: { type: 'object' }, run: async () => { at.lingering = true; await new Promise((r) => setTimeout(r, 60_000)); return 'Done.'; } }]);
  return at;
};
/** After the cut: an open comes back to the conversation, a Stop has the user's next line. @param {any} k @param {string} how */
const after = async (k, how) => {
  const A = k.trip;
  const before = k.requests.length;
  if (how === 'stop') k.agent.send('Put it in Notes');
  else await k.agent.open(A);
  await k.agent.idle();
  const paused = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(A, { types: ['paused'] }))).length;
  return { paused, requests: k.requests.length - before };
};
for (const how of ['open', 'stop']) {
  for (const spent of [true, false]) {
    test(`a hand-over's turn ${spent ? 'past two sleeps beside failed calls' : 'past one sleep beside a failed call'}, then [speak, ask, sleep] cut by ${how === 'open' ? 'an open' : 'a Stop'} while she speaks: ${how === 'open' ? 'a paused line, taken up on return' : 'the next line'} with the hand-over (L1)`, async (t) => {
      useClock(t);
      const k = await agentKit([[{ toolCalls: [failing, sleep] }, ...(spent ? [{ toolCalls: [failing, sleep] }] : []), { toolCalls: [{ name: 'speak', input: { text: 'Which notebook should this go in?' } }, ask, sleep] }, files, files]], { voice: { playMs: 60_000 } });
      k.agent.send('Here is my flight', { handed: [flight], handover: 'h-1' });
      await until(() => k.said.includes('Which notebook should this go in?'));
      const B = await createTrip(k.ws, { title: 'Kyoto' });
      if (how === 'open') await k.agent.open(B);
      else k.agent.interrupt();
      await k.agent.idle();
      assert.deepEqual(await after(k, how), { paused: how === 'open' ? 1 : 0, requests: 1 });
      assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']]);
      await undone(k, `${how}, ${spent ? 'spent' : 'control'}`);
    });
  }
  test(`a hand-over's turn past two sleeps beside failed calls, then [speak, a slow call, sleep] cut by ${how === 'open' ? 'an open' : 'a Stop'} in the slow call: ${how === 'open' ? 'a paused line, taken up on return' : 'the next line'} with the hand-over (L1, a write)`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [failing, sleep] }, { toolCalls: [failing, sleep] }, { toolCalls: [{ name: 'speak', input: { text: 'Filing it.' } }, { name: 'linger', input: {} }, sleep] }, files, files]]);
    const at = slow(k);
    k.agent.send('Here is my flight', { handed: [flight], handover: 'h-1' });
    await until(() => at.lingering);
    const B = await createTrip(k.ws, { title: 'Kyoto' });
    if (how === 'open') await k.agent.open(B);
    else k.agent.interrupt();
    await k.agent.idle();
    assert.deepEqual(await after(k, how), { paused: how === 'open' ? 1 : 0, requests: 1 });
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']]);
    await undone(k, how);
  });
}
test("a turn past two sleeps beside failed calls, then a reply cut by an open in a slow call (nothing said first; said first; no sleep): taken up on return (L1)", async (t) => {
  useClock(t);
  const shapes = { 'nothing said first': [{ name: 'linger', input: {} }, sleep], 'said first': [{ name: 'speak', input: { text: 'Filing it.' } }, { name: 'linger', input: {} }, sleep], 'no sleep': [{ name: 'speak', input: { text: 'Filing it.' } }, { name: 'linger', input: {} }] };
  for (const [what, calls] of Object.entries(shapes)) {
    const k = await agentKit([[{ toolCalls: [failing, sleep] }, { toolCalls: [failing, sleep] }, { toolCalls: calls }, say('Back.'), say('again')]]);
    const at = slow(k);
    k.agent.send('Plan the afternoon');
    await until(() => at.lingering);
    await k.agent.open(await createTrip(k.ws, { title: 'Kyoto' }));
    await k.agent.idle();
    assert.deepEqual(await after(k, 'open'), { paused: 1, requests: 1 }, what);
  }
});

test("a hand-over, her reply silent twice (the card \"Shiori didn't answer\"), Try again, and she files: the write is the hand-over's, and its Undo takes it back", async (t) => {
  useClock(t);
  for (const [shape, reply] of Object.entries({ 'plain text': { text: 'Filed it.' }, 'a bare sleep': { toolCalls: [sleep] } })) {
    const k = await agentKit([[reply, reply, files]]);
    k.agent.send('Here', { handed: [flight], handover: 'h-1' });
    await k.agent.idle();
    assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), ["Shiori didn't answer"], shape);
    assert.equal((await Transcript.load(k.store, k.trip)).owedHandover, 'h-1', `${shape}: the card's turn left it owed`);
    k.agent.tryAgain();
    await k.agent.idle();
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']], shape);
    await undone(k, shape);
  }
});

test("a hand-over, annai restarted while her card waited (or between her answer and her sleep, or in a call after she spoke): the turn taken up carries the hand-over, so what she files is its Undo's (the final reviews' slice 1 F1 and slice 3 F1)", async (t) => {
  useClock(t);
  const flight = { path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
  const files = { toolCalls: [{ name: 'write', input: { path: '/trip/notes/f.md', content: 'AS 123' } }, { name: 'speak', input: { text: 'Filed.' } }, sleep] };
  const calls = (/** @type {any[]} */ ...cs) => cs.map(([id, name, input]) => ({ type: 'tool_call', id, name, input }));
  const q = ['q', 'ask', { question: 'File it?', options: ['Yes'] }];
  const z = ['z', 'sleep', {}];
  const w = ['w', 'write', { path: '/trip/notes/g.md', content: 'x' }];
  /** Her reply, what the log holds of it when annai was killed: results that came back, lines she had shown. */
  const shapes = /** @type {[string, any[], { result?: string[], spoke?: boolean }][]} */ ([
    ['her card waiting, ask and sleep', [q, z], {}],
    ['her card waiting, ask alone', [q], {}],
    ['answered, her sleep not yet run', [q, z], { result: ['q'] }],
    ['she spoke, then a call running, then her sleep', [['s', 'speak', { text: 'Filing it.' }], w, z], { result: ['s'], spoke: true }],
  ]);
  for (const [what, cs, { result = [], spoke = false }] of shapes) {
    const k = await agentKit([[files]], { open: false });
    const info = { role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0', handover: 'h-1', endLogged: true };
    await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }] } });
    await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Here', wake: 'w-0', handed: [flight], handover: 'h-1' } });
    await modelTrace(k.store, k.trip).turn(/** @type {any} */ (info), '', '', /** @type {any} */ (calls(...cs)));
    if (spoke) await record(k.store, k.trip, { type: 'out.speak', actor: 'shiori', data: { id: 's', wake: 'w-0' }, texts: [['text', 'Filing it.']] });
    if (cs.includes(q)) await record(k.store, k.trip, { type: 'out.ask', actor: 'shiori', data: { id: 'q', wake: 'w-0', question: 'File it?', options: ['Yes'] } }); // her question is shown before it waits
    for (const id of result) await record(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id, name: cs.find((c) => c[0] === id)[1], ok: true, cut: false, ms: 1, wake: 'w-0' }, texts: [['content', 'The user chose: Yes']] });
    await k.agent.open(k.trip);
    await k.agent.idle();
    const hers = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori' && e.data.path === '/notes/f.md');
    assert.deepEqual(hers.map((/** @type {any} */ e) => e.data.handover ?? null), ['h-1'], `${what}: the turn taken up carries the hand-over`);
    const restart = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['wake'] }))).filter((/** @type {any} */ e) => !e.data.meanwhile).at(-1);
    assert.equal(restart.data.handover, 'h-1', `${what}: the restart's wake names it, so the Undo line follows it`);
  }
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

// A hand-over her sleep settled is answered: it is not given back to a later turn that was never hers, so its Undo takes back only what she did under it
// (the ask-owed re-review's R1: a move into that trip, its recap logged as a `meanwhile` wake, gave the old hand-over back to the move's turn).
for (const recap of ['with a recap', 'no recap']) {
  test(`a hand-over in Kyoto that her sleep settled, then a carry-on into Kyoto from the chat (open_trip ${recap}): what she files in the move turn is not the hand-over's, and its Undo leaves it`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [sleep] }]], { halves: true });
    k.agent.addLoopTools(tripTools(k.agent));
    const kyoto = await createTrip(k.ws, { title: 'Kyoto', start: '2027-04-01', end: '2027-04-08' });
    await k.agent.opening;
    const asks = /** @type {any[]} */ ([]);
    k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'out.ask' && e.data.own) asks.push(e); });
    const writes = (/** @type {string} */ path, /** @type {string} */ text) => ({ toolCalls: [{ name: 'write', input: { path, content: 'x' } }, { name: 'speak', input: { text } }, sleep] });
    await rescript(k, { rules: [
      { match: 'You moved the user here', reply: writes('/trip/notes/b.md', 'Here in Kyoto.') },
      { match: 'the user wrote', reply: writes('/trip/notes/a.md', 'Filed.'), times: 1 },
      { match: 'the user wrote', reply: { toolCalls: [{ name: 'open_trip', input: { trip: kyoto, ...(recap === 'with a recap' ? { recap: 'We found the ramen place.' } : {}) } }] }, then: say('We stay here, then.') },
    ] });
    await k.agent.open(kyoto);
    await k.agent.idle();
    await k.ws.write(kyoto, '/files/hotel.pdf', utf8('%PDF hotel'), { author: 'user', type: 'application/pdf' });
    k.agent.send('Here', { handed: [{ path: '/trip/files/hotel.pdf', type: 'application/pdf', name: 'hotel.pdf', new: true }], handover: 'h-0' });
    await k.agent.idle();
    assert.equal((await Transcript.load(k.store, kyoto)).owedHandover, null, 'her sleep settled h-0');
    await k.agent.open(k.trip);
    await k.agent.idle();
    k.agent.send("Let's carry on in Kyoto");
    await until(() => asks.length === 1);
    k.agent.answer(asks[0].data.tap, 'Open');
    await until(() => k.agent.target === kyoto);
    await k.agent.idle();
    const hers = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(kyoto, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori');
    assert.deepEqual(hers.map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]), [['/notes/a.md', 'h-0'], ['/notes/b.md', null]]);
    const out = await undoHandover(k.ws, kyoto, 'h-0');
    assert.deepEqual(out.undone, ['/notes/a.md']);
    assert.notEqual(await k.ws.read(kyoto, '/notes/b.md'), undefined, 'what she filed after the move is still there');
  });
}
