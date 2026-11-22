// A reminder a turn owes when annai is closed or put away mid-turn reaches the traveller at the next start (the Deferred entry "A reminder owed as the
// page is left isn't shown at the next start", 2026-11-20, which this change closes; spec §11.3: "shown or spoken directly"). Nothing is shown on a page being left (a card there
// reaches no one), so the wake's record keeps the reminders it carried (`reminders`), and the open of that conversation shows what the log still owes,
// at once, through `remind` (the card, said with voice on, its entry, which settles it), whatever the transcript says of the turn; a restart it queues too
// says annai showed it, and doesn't carry it. "Still owed" is the loop's own rule read back from the log (Transcript.owedReminders): a reminder's entry
// settles it, and so does her reaching the user after it, in the half whose wake carried it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, idleAtOnce, inTime, raw, refusing, holdReminders, turnEnds } from './agent-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record } from '../../src/core/agent/log.js';
import { planWords } from '../../src/core/live/plan-watches.js';
import { ME, createTrip } from '../../src/core/scopes.js';
import { NETWORK_RETRIES, OVERLOAD_RETRIES } from '../../src/core/llm/fallback.js';

const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const asleep = { toolCalls: [sleep] };
const LEAVE = 'Leave for the airport by 14:10';
const CHECK_OUT = 'Check out by 11';
/** A restart wake's words when annai showed the user the reminder at the open (loop.js SHOWN). */
const SHOWN = /annai has already shown the user its reminder/;
/** A watch's wake, with its reminder. @param {string} [text] @param {string} [watch] */
const fired = (text = LEAVE, watch = 'w1') => ({ kind: 'trigger', text: `Your watch fired: ${text}.`, fallbacks: [{ watch, text }] });
/** The page is killed in her model call: every try of it fails as the page goes (the call retries a network failure). */
const KILLED = Array(1 + NETWORK_RETRIES.length).fill({ delayMs: 30, error: 'network', message: 'Load failed' });
/** The reminders' cards, by their words. @param {any[]} cards */
const reminders = (cards) => cards.filter((n) => n.title === 'Reminder').map((n) => n.body);
/** Which half raised each reminder's card (listen's `by`). @param {any[]} cards */
const raisedBy = (cards) => cards.filter((n) => n.title === 'Reminder').map((n) => n.by);
/** The reminders' entries in the log, by their words. @param {any} k */
const entries = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);

/** A loop tool that waits until it is let go: the page is left while it runs. @param {any} half */
function lingers(half) {
  const at = { lingering: false, go: () => {} };
  const held = new Promise((r) => { at.go = () => r(undefined); });
  half.addLoopTools([{ name: 'linger', pluginId: 'core', group: 'Time', description: 'Wait.', input: { type: 'object' }, run: async () => { at.lingering = true; await held; return 'Done.'; } }]);
  return at;
}
const linger = { name: 'linger', input: {} };

/**
 * The cards an agent (or both its halves) raises from now on, each with the half that raised it (`by`: 'one', 'kokoro' or 'koe'), and how many requests her
 * models had been given when the first reminder came: 0 is at the open, before any restart turn asked anything. @param {any} k @param {any} agent
 */
function listen(k, agent) {
  const asked = k.requests.length;
  /** @type {any[]} */
  const cards = [];
  const first = { requests: -1 };
  for (const half of agent.kokoro ? [agent.kokoro, agent.koe] : [agent]) {
    const by = !agent.kokoro ? 'one' : half === agent.kokoro ? 'kokoro' : 'koe';
    half.on('notice', (/** @type {any} */ n) => {
      cards.push({ ...n, by });
      if (n.title === 'Reminder' && first.requests < 0) first.requests = k.requests.length - asked;
    });
  }
  return { cards, first };
}

/**
 * The next start, one Shiori: a new page's agent opens the conversation, takes up what is owed, and is done. @param {any} k @param {string | null} [trip]
 * @returns {Promise<{ agent: any, cards: any[], first: { requests: number } }>}
 */
async function nextStart(k, trip = k.trip) {
  k.llm.bench.clear('m-0'); // a new page starts with no model benched
  const agent = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  agent.addLoopTools(selfTools(agent));
  const { cards, first } = listen(k, agent);
  await inTime(agent.open(trip), 'the open did not finish');
  await idleAtOnce({ agent });
  return { agent, cards, first };
}

/** The next start with Shiori as two halves (a new page's Halves, Koe on or off as the models say). @param {any} k @returns {Promise<{ agent: any, cards: any[], first: { requests: number } }>} */
async function nextHalves(k) {
  for (const m of ['m-0', 'm-koe']) k.llm.bench.clear(m);
  const agent = new Halves({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, voice: null, timeZone: () => 'UTC', secondMs: 10 });
  agent.addLoopTools(selfTools(agent.kokoro));
  const { cards, first } = listen(k, agent);
  await inTime(agent.open(k.trip), 'the open did not finish');
  await idleAtOnce({ agent }); // Koe opens once Kokoro knows what is owed (Halves.open), which idle() doesn't wait for
  await inTime(agent.opening, 'Koe did not open');
  await idleAtOnce({ agent });
  return { agent, cards, first };
}

/** The restart wakes' records in the log. @param {any} k */
const restarts = async (k) => (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'restart'));

/** One Shiori, and two halves with Kokoro alone (as production builds it when no Koe model is set). */
const MODES = /** @type {[string, any][]} */ ([['', {}], [' (two halves, Kokoro alone)', { halves: true }]]);

for (const [mode, o] of MODES) {
  test(`closed in the model call of a watch's turn that owes a reminder, then started again: annai shows it at the open, once, and the restart is told so${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[...KILLED, asleep]], o);
    k.agent.wake(fired());
    await until(() => k.requests.length === 1);
    k.agent.leaving(); // pagehide: WebKit then cancels the request
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [], 'nothing on the page being left');
    const owed = (await Transcript.load(k.store, k.trip)).owedReminders;
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.equal(next.first.requests, 0, 'at the open: before her restart turn asked anything');
    assert.deepEqual(await entries(k), [LEAVE], 'its entry, once');
    assert.equal((await k.events(['reminder']))[0].data.unsaid, true);
    const [restart, ...more] = await restarts(k);
    assert.deepEqual(more, []);
    assert.match(restart.data.reasons[0].text, SHOWN, 'she is told annai showed it');
    assert.equal('reminders' in restart.data, false, 'the restart carries none: it is shown, not owed');
    assert.deepEqual(owed, [{ watch: 'w1', text: LEAVE }], 'the log said it was still owed');
    assert.deepEqual((await Transcript.load(k.store, k.trip)).owedReminders, [], 'settled by its entry: the start after that shows nothing');
    assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false);
  });

  test(`put away (${o.halves ? 'hidden, then pagehide' : 'pagehide'}) while a tool of hers runs in a watch's turn, the turn then ending by itself: its end is written as ever, and the next start shows the reminder once, with no restart and no model call${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger, sleep] }, asleep]], o);
    const tool = lingers(k.agent.kokoro ?? k.agent);
    k.agent.wake(fired());
    await until(() => tool.lingering);
    // As main.js does: hidden (visibilitychange: Halves' hush, which a plain Agent has not: production always builds Halves), then pagehide.
    // Her requests may run on, and the turn ends by itself.
    if (o.halves) k.agent.hush('away');
    k.agent.leaving();
    tool.go();
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [], 'nothing on the page being left');
    assert.equal((await k.events(['turn.end'])).length, 1, 'the turn ended: its end is written');
    assert.equal(k.requests.length, 1, 'her turn ended by itself');
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await restarts(k), [], 'the turn was over: nothing is taken up');
    assert.equal(k.requests.length, 1, 'no model call at the next start');
    assert.deepEqual(await entries(k), [LEAVE]);
    assert.equal((await k.events(['turn.end'])).length, 1);
  });

  test(`the turn cut by the page going together with the user's Stop (the Stop's turn is over, so nothing is taken up, and its show is skipped there): the next start still shows the reminder once${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[...KILLED]], o);
    k.agent.wake(fired());
    await until(() => k.requests.length === 1);
    k.agent.leaving();
    k.agent.interrupt();
    await idleAtOnce(k);
    assert.deepEqual((await k.events(['error'])).map((/** @type {any} */ e) => e.data.kind), ['stopped']);
    assert.deepEqual(reminders(k.notices), [], 'nothing on the page being left');
    assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false, 'a Stop settles the turn');
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await restarts(k), []);
    assert.deepEqual(await entries(k), [LEAVE]);
  });

  test(`an error written for the cut turn after the page went (a budget, a quiet card: its turn is over, so nothing is taken up): the next start still shows the reminder once${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[...KILLED]], o);
    k.agent.wake(fired());
    await until(() => k.requests.length === 1);
    k.agent.leaving();
    await idleAtOnce(k);
    const [wake] = await k.events(['wake']);
    assert.equal((await Transcript.load(k.store, k.trip)).unanswered, true, 'the cut turn is still owed before the error');
    await record(k.store, k.trip, { type: 'error', actor: 'system', data: { kind: 'budget', wake: wake.data.id, message: 'A limit was reached.', quiet: true } });
    assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false, 'the error ended the turn it was written for');
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await restarts(k), []);
    assert.deepEqual(await entries(k), [LEAVE]);
  });

  test(`killed between a turn's end and the show of its reminder (the log holds the end, and no entry): the next start shows it once, taking nothing up${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], o);
    const door = holdReminders(k); // the show waits at the door: the process is "killed" there
    const ended = turnEnds(k);
    k.agent.wake(fired());
    await ended;
    await until(() => door.reached());
    assert.deepEqual(await entries(k), [], 'no entry yet');
    assert.equal((await k.events(['turn.end'])).length, 1, 'the end is written');
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await restarts(k), []);
    assert.equal(k.requests.length, 1, 'no model call at the next start');
    assert.deepEqual(await entries(k), [LEAVE]);
    const again = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(again.cards), [], 'its entry settled it');
  });

  test(`a plan's reminder and an answer's, carried by a wake's record: shown at the next start in their own words, and kept as entries as they were${mode}`, async (t) => {
    useClock(t);
    const plan = { event: 'coming-up', what: { title: 'Dinner', at: Date.UTC(2026, 10, 21, 19, 0), tz: 'UTC' }, left: 15 };
    const answer = 'It is about twenty minutes ahead on Highway 1.';
    const k = await agentKit([[...KILLED, asleep]], o);
    k.agent.wake({ kind: 'trigger', text: 'Your watches fired.', fallbacks: [{ watch: 'plan:dinner:coming-up', text: 'Dinner soon', plan }, { watch: 'a1', text: answer, answer: true }] });
    await until(() => k.requests.length === 1);
    k.agent.leaving();
    await idleAtOnce(k);
    assert.deepEqual((await Transcript.load(k.store, k.trip)).owedReminders, [{ watch: 'plan:dinner:coming-up', text: 'Dinner soon', plan }, { watch: 'a1', text: answer, answer: true }]);
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(next.cards.filter((n) => n.title === 'Reminder' || n.title === "Shiori's answer").map((n) => [n.title, n.body]), [['Reminder', planWords(plan)], ["Shiori's answer", answer]]);
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.watch, e.data.text, e.data.plan, e.data.answer]), [['plan:dinner:coming-up', 'Dinner soon', plan, undefined], ['a1', answer, undefined, true]]);
  });

  // The guard in #showOwed: a turn that stops short (here, the phone refuses its first write, so it never reaches her model) shows what its wake carried, but
  // not on a page being left: a card there reaches no one. The next start is not read here: the wake's record was refused too (a full phone), so the log has
  // nothing for the open to show; the Deferred entry says C169's catch-up shows it then, by reading the code, which this test does not reach.
  for (const [leaving, shows] of /** @type {const} */ ([[true, []], [false, [LEAVE]]])) {
    test(`a watch's wake whose first write the phone refuses ${leaving ? 'as the page is being left' : 'on a page that stays'}: the turn stops short and ${leaving ? 'shows no card there' : 'shows the reminder, as it always did'}${mode}`, async (t) => {
      useClock(t);
      const k = await agentKit([[asleep]], o);
      const store = refusing(k);
      if (leaving) k.agent.leaving();
      store.full('all');
      k.agent.wake(fired());
      await idleAtOnce(k);
      assert.deepEqual(reminders(k.notices), shows);
      assert.equal(k.requests.length, 0, 'the turn never reached her model');
    });
  }
}

test('back on the page before it goes (the same tool, the page shown again): the turn ends as ever, showing the reminder at once, and nothing is shown later', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger, sleep] }, asleep]]);
  const tool = lingers(k.agent);
  k.agent.wake(fired());
  await until(() => tool.lingering);
  k.agent.leaving();
  k.agent.leaving(false); // pageshow from the back-forward cache, or a beforeunload that led nowhere
  tool.go();
  await idleAtOnce(k);
  assert.deepEqual(reminders(k.notices), [LEAVE]);
  assert.equal((await k.events(['turn.end'])).length, 1);
  const next = await nextStart(k);
  assert.deepEqual(reminders(next.cards), []);
  assert.deepEqual(await restarts(k), []);
});

test('a reminder she said before the cut is not shown again; one that joined her turn after her line is (the joined wake\'s own record keeps it)', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [speak(`${LEAVE}.`), linger] }, ...KILLED, asleep]]);
  const tool = lingers(k.agent);
  k.agent.wake(fired());
  await until(() => tool.lingering);
  k.agent.wake(fired(CHECK_OUT, 'w2')); // joins her turn at its next step, after her line
  await new Promise((r) => setTimeout(r, 30));
  tool.go();
  await until(() => k.requests.length === 2);
  k.agent.leaving();
  await idleAtOnce(k);
  const joined = (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.meanwhile);
  assert.deepEqual(joined.map((/** @type {any} */ e) => e.data.reminders), [[{ watch: 'w2', text: CHECK_OUT }]], 'the meanwhile record keeps the joined reminder');
  const next = await nextStart(k);
  assert.deepEqual(reminders(next.cards), [CHECK_OUT], 'only the one she had not said');
  assert.deepEqual(await entries(k), [CHECK_OUT]);
  assert.match((await restarts(k))[0].data.reasons[0].text, SHOWN);
});

// A reminder that joins the user's turn is shown at the open whatever she then does: it is not hers to settle on a restart (the open shows what the log owes).
for (const [what, then] of /** @type {const} */ ([['she speaks', { toolCalls: [speak('Here is what I found.'), sleep] }], ['she sleeps without a word', asleep]])) {
  test(`a reminder that joins the user's turn meanwhile, the page closed in her next call: the next start shows it once, at the open, and ${what}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, ...KILLED, then]]);
    const tool = lingers(k.agent);
    k.agent.send('What is near?');
    await until(() => tool.lingering);
    k.agent.wake(fired());
    await new Promise((r) => setTimeout(r, 30));
    tool.go();
    await until(() => k.requests.length === 2);
    k.agent.leaving();
    await idleAtOnce(k);
    const next = await nextStart(k);
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.equal(next.first.requests, 0, 'at the open');
    assert.deepEqual(await entries(k), [LEAVE]);
    assert.match((await restarts(k))[0].data.reasons[0].text, SHOWN);
    assert.deepEqual((await Transcript.load(k.store, k.trip)).owedReminders, []);
  });
}

test('a reminder the user\'s Stop showed is not shown again when a later turn is cut by the page going; that later turn\'s own reminder is', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, ...KILLED, asleep]]);
  const tool = lingers(k.agent);
  k.agent.wake(fired());
  await until(() => tool.lingering);
  k.agent.interrupt(); // the Stop: the turn's end shows its reminder, silently, and writes its entry
  await idleAtOnce(k);
  assert.deepEqual(reminders(k.notices), [LEAVE]);
  k.agent.wake(fired(CHECK_OUT, 'w2'));
  await until(() => k.requests.length === 2);
  k.agent.leaving();
  await idleAtOnce(k);
  const next = await nextStart(k);
  assert.deepEqual(reminders(next.cards), [CHECK_OUT]);
  assert.deepEqual(await entries(k), [LEAVE, CHECK_OUT]);
});

test('the restart turn cut by the page going too: the reminder was shown at the open that took it up, so the start after that shows nothing', async (t) => {
  useClock(t);
  const k = await agentKit([[...KILLED, ...KILLED, asleep]]);
  k.agent.wake(fired());
  await until(() => k.requests.length === 1);
  k.agent.leaving();
  await idleAtOnce(k);
  // The second page: it shows the reminder at its open, and its restart turn is killed in its call as well.
  k.llm.bench.clear('m-0');
  const second = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  const { cards } = listen(k, second);
  await inTime(second.open(k.trip), 'the open did not finish');
  await until(() => k.requests.length === KILLED.length + 1);
  second.leaving();
  await idleAtOnce({ agent: second });
  assert.deepEqual(reminders(cards), [LEAVE], 'shown at the second page\'s open');
  const third = await nextStart(k);
  assert.deepEqual(reminders(third.cards), [], 'once: its entry settled it');
  assert.deepEqual(await entries(k), [LEAVE]);
});

test("a watch's wake with a reminder and a cue, closed mid-turn, and the next start can't reach her model: annai shows the reminder once, never the cue (a note for her, whose moment has gone)", async (t) => {
  useClock(t);
  const FAILED = Array(1 + OVERLOAD_RETRIES.length).fill({ error: 'server', status: 500, message: 'Scripted failure.' });
  const k = await agentKit([[...KILLED, ...FAILED]]);
  k.agent.wake({ ...fired(), fallbacks: [{ watch: 'w1', text: LEAVE }, { watch: 'w9', text: 'Nepenthe is 2 km away', cue: true }] });
  await until(() => k.requests.length === 1);
  k.agent.leaving();
  await idleAtOnce(k);
  const next = await nextStart(k);
  assert.ok(next.cards.some((n) => n.title === "Shiori can't reach her model"));
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  assert.deepEqual((await k.events(['wake']))[0].data.reminders, [{ watch: 'w1', text: LEAVE }], 'the record keeps no cue');
  assert.deepEqual(await entries(k), [LEAVE]);
});

// What Halves' #talkDirectly enqueues for Kokoro when Koe's models are down (kind 'halves', logged already, the reminders a wake carried): a stand-in, as
// the real path needs a live session to fail first (BLOCKS['koe-down'] is not exported).
test("a block of annai's own that joins her turn with reminders and no line of its own (the shape of Halves' #talkDirectly): its reminders are kept, and the next start shows them", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, ...KILLED, asleep]], { halves: true });
  const tool = lingers(k.agent.kokoro);
  k.agent.send('What is near?');
  await until(() => tool.lingering);
  k.agent.kokoro.enqueue({ kind: 'halves', text: "Koe can't speak right now.", logged: true, fallbacks: [{ watch: 'w1', text: LEAVE }] });
  tool.go();
  await until(() => k.requests.length === 2);
  k.agent.leaving();
  await idleAtOnce(k);
  const next = await nextHalves(k);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  const joined = (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.meanwhile);
  assert.deepEqual(joined.map((/** @type {any} */ e) => [e.data.reasons, e.data.reminders]), [[[], [{ watch: 'w1', text: LEAVE }]]], 'a record with no reasons: no line for her');
});

test('an old log, whose wake records keep no reminders, opens as before: the restart carries none and says nothing was shown, and nothing is shown', async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'trigger', text: `Your watch fired: ${LEAVE}.` }] } });
  const owed = (await Transcript.load(k.store, k.trip)).owedReminders;
  const next = await nextStart(k);
  const [restart] = await restarts(k);
  assert.doesNotMatch(restart.data.reasons[0].text, SHOWN);
  assert.equal('reminders' in restart.data, false, 'a wake that carries none has no key');
  assert.deepEqual(reminders(next.cards), []);
  assert.deepEqual(owed, [], 'read as none');
});

test("a reminder owed in the `me` conversation is shown at its open too (a reminder is the traveller's in any scope; `me` takes no turn, so nothing is queued)", async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]], { open: false });
  await record(k.store, ME, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'trigger', text: `Your watch fired: ${LEAVE}.` }], reminders: [{ watch: 'w1', text: LEAVE }] } });
  const next = await nextStart(k, null);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  assert.equal(k.requests.length, 0);
  const mine = await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(ME, { types: ['reminder'] }));
  assert.deepEqual(mine.map((/** @type {any} */ e) => e.data.text), [LEAVE]);
});

// C169: a phone too full to write refuses the entry, so nothing settles the reminder, and it shows again at each start, and each time its conversation opens (C174; this test checks starts). No state is kept to stop it.
test('on a phone too full to write the entry, the open shows the reminder and tells the refusal; it shows again at the next start, and settles once there is room', async (t) => {
  useClock(t);
  const k = await agentKit([[...KILLED, asleep, asleep, asleep]]);
  k.agent.wake(fired());
  await until(() => k.requests.length === 1);
  k.agent.leaving();
  await idleAtOnce(k);
  const store = refusing(k);
  store.full('all');
  const first = await nextStart(k);
  assert.deepEqual(reminders(first.cards), [LEAVE]);
  assert.ok(first.cards.some((n) => n.title === "Something for Shiori wasn't saved"), 'the refusal is told');
  const second = await nextStart(k);
  assert.deepEqual(reminders(second.cards), [LEAVE], 'shown again');
  store.full(null);
  const third = await nextStart(k);
  assert.deepEqual(reminders(third.cards), [LEAVE]);
  assert.deepEqual(await entries(k), [LEAVE], 'written now');
  const fourth = await nextStart(k);
  assert.deepEqual(reminders(fourth.cards), []);
});

test('the read takes a record\'s reminders as written and passes over what is not one: no words, not an object', async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]], { open: false });
  const plan = { kind: 'leave', title: 'Flight UA123' };
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'trigger', text: 'Fired.' }], reminders: [null, { watch: 'w1' }, { watch: 'w2', text: '' }, 'text', { watch: 'w3', text: LEAVE, plan }] } });
  assert.deepEqual((await Transcript.load(k.store, k.trip)).owedReminders, [{ watch: 'w3', text: LEAVE, plan }]);
});

// The read, from logs written by hand: what settles a reminder a wake's record carried, by the loop's own rule (#steps' settle and remind).
const R = { watch: 'w1', text: LEAVE };
/** @param {string} type @param {Record<string, any>} data @param {string} [actor] */
const ev = (type, data, actor = 'shiori') => ({ type, actor, data });
const carried = (/** @type {Record<string, any>} */ half = {}) => ev('wake', { id: 'w-0', reasons: [{ kind: 'trigger', text: 'Fired.' }], reminders: [R], ...half }, 'system');
for (const [what, log, owed] of /** @type {[string, any[], any[]][]} */ ([
  ['her line after it settles it', [carried(), ev('out.speak', { id: 's1', wake: 'w-0', text: 'Off you go.' })], []],
  ['her card (show) or question (ask) after it too', [carried(), ev('out.show', { id: 's1', wake: 'w-0', card: { title: 'Go' } })], []],
  ['a reply shown as written (grounded by the model\'s own search) too', [carried(), ev('grounded', { wake: 'w-0', source: 'Google Search', text: 'Go now.' })], []],
  ['her line before it does not', [ev('out.speak', { id: 's1', wake: 'w-0', text: 'Hello.' }), carried()], [R]],
  ["annai's own card (confirm) after it does not: it is annai's, not hers", [carried(), ev('out.ask', { id: 'c1', question: 'Open Kyoto?', options: ['Open'], own: true }, 'system')], [R]],
  ['its entry settles it (annai showed it)', [carried(), ev('reminder', { watch: 'w1', text: LEAVE, unsaid: true }, 'system')], []],
  ["another reminder's entry does not", [carried(), ev('reminder', { watch: 'w2', text: LEAVE }, 'system'), ev('reminder', { watch: 'w1', text: CHECK_OUT }, 'system')], [R]],
  ["Koe's wake's, by Koe's line", [carried({ half: 'koe' }), ev('out.speak', { id: 's1', wake: 'w-0', text: 'Off you go.', half: 'koe' })], []],
  ["Koe's wake's, not by Kokoro's line (annai showing a note of Kokoro's): Koe still owes it", [carried({ half: 'koe' }), ev('out.show', { id: 'c1', card: { title: 'Dinner at 7' }, half: 'kokoro' })], [R]],
  ["Kokoro's wake's, not by Koe's line", [carried({ half: 'kokoro' }), ev('out.speak', { id: 's1', wake: 'w-1', text: 'Hi.', half: 'koe' })], [R]],
  ["Koe's, carried again by Kokoro's take-up: the newest carrier owes it, so Kokoro's line settles it", [carried({ half: 'koe' }), carried({ half: 'kokoro' }), ev('out.speak', { id: 's1', wake: 'w-0', text: 'Off you go.', half: 'kokoro' })], []],
  ["Kokoro's, carried again by Koe's take-up: Kokoro's line no longer settles it", [carried({ half: 'kokoro' }), carried({ half: 'koe' }), ev('out.speak', { id: 's1', wake: 'w-0', text: 'Hi.', half: 'kokoro' })], [R]],
  ['carried by two records (a take-up of a take-up): owed once', [carried(), carried()], [R]],
])) {
  test(`the read of what is still owed: ${what}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], { open: false });
    for (const e of log) await record(k.store, k.trip, e);
    for (const half of /** @type {const} */ (['one', 'kokoro', 'koe'])) assert.deepEqual((await Transcript.load(k.store, k.trip, { half })).owedReminders, owed, `read by ${half}'s rules`);
  });
}

// Koe on: a watch's reminder rides Koe's wake (spec §11.3: so it is said once), and Kokoro is told Koe says it. Koe's own records keep it. At the next start
// Kokoro's half shows what the log still owes, once, and whichever half queues the restart says so when its own read was made before the entry (Koe's does not:
// on a first open Halves opens Koe once Kokoro's open is done, so Koe reads the entry itself; Koe's restart hook, asked only when its turn was cut, waits for
// Kokoro's open).
const KOE_KILLED = { type: [...KILLED, asleep] };
for (const [who, kokoro] of /** @type {const} */ ([
  ['Koe takes its own turn up (Kokoro had finished)', [asleep]],
  ['Kokoro takes both up (its turn was cut too)', [...KILLED, asleep]],
])) {
  test(`Koe on, closed in Koe's model call of a watch's turn: ${who}, Kokoro's half shows the reminder once at the open, and the restart carries none (Kokoro's is told it was shown, Koe's reads the entry)`, async (t) => {
    useClock(t);
    const k = await agentKit([kokoro], { koe: KOE_KILLED });
    const cards = raw(k);
    k.agent.wake(fired());
    await until(() => (k.sent['model-koe']?.length ?? 0) === 1 && (k.sent['model-0']?.length ?? 0) === 1);
    if (kokoro.length === 1) await idleAtOnce({ agent: k.agent.kokoro }); // its sleep ended its turn
    k.agent.leaving();
    await idleAtOnce(k);
    assert.deepEqual(reminders(cards), []);
    const wakes = await k.events(['wake']);
    const next = await nextHalves(k);
    assert.deepEqual(reminders(next.cards), [LEAVE], 'once, though both halves open the conversation');
    assert.deepEqual(raisedBy(next.cards), ['kokoro'], "by Kokoro's half: the open shows the card on the half that isn't Koe's");
    assert.equal(next.first.requests, 0, 'at the open');
    assert.deepEqual(await entries(k), [LEAVE]);
    assert.deepEqual(wakes.filter((/** @type {any} */ e) => e.data.half === 'koe').map((/** @type {any} */ e) => e.data.reminders), [[{ watch: 'w1', text: LEAVE }]], "Koe's wake record keeps it");
    assert.equal(wakes.filter((/** @type {any} */ e) => e.data.half === 'kokoro' && e.data.reminders).length, 0, "Kokoro's copy carries none");
    const taken = await restarts(k);
    assert.deepEqual(taken.map((/** @type {any} */ e) => e.data.half), [kokoro.length === 1 ? 'koe' : 'kokoro']);
    assert.equal('reminders' in taken[0].data, false);
    // Kokoro's restart is told annai showed it. Koe opens after Kokoro's open is done here, so it reads the entry itself, and its restart has nothing to be told.
    if (kokoro.length === 1) {
      assert.doesNotMatch(taken[0].data.reasons[0].text, SHOWN);
      assert.match(JSON.stringify(k.sent['model-koe'].at(-1).messages), /Shown by annai itself.*Leave for the airport/);
    } else assert.match(taken[0].data.reasons[0].text, SHOWN);
  });
}

// Coming back to the conversation from another one: both halves open it at once (Halves.open), Koe's read made before Kokoro's show, so its transcript
// still lists the reminder: Koe doesn't show it, the restart that is queued (Koe's, or Kokoro's when its turn was cut too) says annai did, and Koe's
// transcript gets the entry Kokoro wrote (the other half's copy: Koe's next turn knows annai showed it, and doesn't owe it).
for (const [who, kokoro, restarter] of /** @type {const} */ ([
  ['Kokoro had finished, Koe was cut', [asleep], 'koe'],
  ['both were cut', [...KILLED, asleep], 'kokoro'],
])) {
  test(`Koe on, the conversation opened from another one (${who}): Kokoro shows the reminder once, the restart is told so, and Koe's transcript holds its entry`, async (t) => {
    useClock(t);
    const k = await agentKit([kokoro], { koe: KOE_KILLED });
    k.agent.wake(fired());
    await until(() => (k.sent['model-koe']?.length ?? 0) === 1 && (k.sent['model-0']?.length ?? 0) === 1);
    if (kokoro.length === 1) await idleAtOnce({ agent: k.agent.kokoro }); // its sleep ended its turn
    k.agent.leaving();
    await idleAtOnce(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    for (const m of ['m-0', 'm-koe']) k.llm.bench.clear(m);
    const agent = new Halves({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, voice: null, timeZone: () => 'UTC', secondMs: 10 });
    agent.addLoopTools(selfTools(agent.kokoro));
    const { cards } = listen(k, agent);
    await inTime(agent.open(other), 'the open did not finish');
    await idleAtOnce({ agent });
    await inTime(agent.opening, 'Koe did not open');
    assert.deepEqual(reminders(cards), [], 'another conversation: nothing owed there');
    await inTime(agent.open(k.trip), 'the open did not finish');
    await idleAtOnce({ agent });
    await inTime(agent.opening, 'Koe did not open');
    await idleAtOnce({ agent });
    assert.deepEqual(reminders(cards), [LEAVE], 'once');
    assert.deepEqual(raisedBy(cards), ['kokoro']);
    assert.deepEqual(await entries(k), [LEAVE]);
    const taken = await restarts(k);
    assert.deepEqual(taken.map((/** @type {any} */ e) => e.data.half), [restarter]);
    assert.match(taken[0].data.reasons[0].text, SHOWN);
    assert.deepEqual(agent.koe.transcript.owedReminders, [], "Koe's transcript holds the entry that settles it");
    assert.match(JSON.stringify(agent.koe.transcript.messages), /Shown by annai itself.*Leave for the airport/);
  });
}

// The final review's finding (Fable 2): Kokoro's restart turn carried the reminder, could not settle it while Koe worked (Koe's line never reaches Kokoro's
// count), and showed it at its end, after a Koe that said it. Now no turn owes it: annai shows it once at the open, before anything is told to Koe, and the
// restart says so. What a scripted Koe says is its model's own choice, as it is when Kokoro passes it on; the test pins that annai adds no second card.
test("Koe on, both halves cut, Kokoro's restart tells Koe and Koe says the reminder: annai showed it once, at the open, and no turn shows a second card", async (t) => {
  useClock(t);
  const tell = { toolCalls: [{ name: 'tell_koe', input: { text: `Say: ${LEAVE}` } }, sleep] };
  const k = await agentKit([[...KILLED, tell]], { koe: { type: [...KILLED, { toolCalls: [speak(LEAVE), sleep] }] } });
  k.agent.wake(fired());
  await until(() => (k.sent['model-koe']?.length ?? 0) === 1 && (k.sent['model-0']?.length ?? 0) === 1);
  k.agent.leaving();
  await idleAtOnce(k);
  const next = await nextHalves(k);
  assert.deepEqual(reminders(next.cards), [LEAVE], 'one card');
  assert.deepEqual(raisedBy(next.cards), ['kokoro']);
  assert.deepEqual(await entries(k), [LEAVE], 'one entry');
  const taken = await restarts(k);
  assert.deepEqual(taken.map((/** @type {any} */ e) => e.data.half), ['kokoro'], 'one restart, Kokoro\'s: Koe takes none up');
  assert.match(taken[0].data.reasons[0].text, SHOWN);
  assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.half, e.data.text]), [['koe', LEAVE]], "Koe's own line, as its model chose");
});

test("Koe on, put away (hidden, then pagehide) while a tool of Koe's runs in a watch's turn, Koe's turn then ending by itself: its end is written, and the next start shows the reminder once with no restart", async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]], { koe: { type: [{ toolCalls: [linger, sleep] }, asleep] } });
  const cards = raw(k);
  const tool = lingers(k.agent.koe);
  k.agent.wake(fired());
  await until(() => tool.lingering);
  await idleAtOnce({ agent: k.agent.kokoro });
  k.agent.hush('away');
  k.agent.leaving();
  tool.go();
  await idleAtOnce(k);
  assert.deepEqual(reminders(cards), []);
  const ends = (await k.events(['turn.end'])).map((/** @type {any} */ e) => e.data.half).sort();
  const asked = k.requests.length;
  const next = await nextHalves(k);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  assert.deepEqual(raisedBy(next.cards), ['kokoro']);
  assert.deepEqual(ends, ['koe', 'kokoro'], 'both turns ended');
  assert.deepEqual(await restarts(k), []);
  assert.equal(k.requests.length, asked, 'no model call at the next start');
});
