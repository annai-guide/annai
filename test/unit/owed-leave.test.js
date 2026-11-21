// A reminder a turn owes when annai is closed or put away mid-turn reaches the traveller at the next start (the Deferred entry "A reminder owed as the
// page is left isn't shown at the next start", 2026-11-20; spec §11.3: "shown or spoken directly"). Nothing is shown on a page being left (a card
// there reaches no one), so the wake's record keeps the reminders it carried (`reminders`), and the open that takes the cut turn up puts those still
// owed on the restart wake, which owes them as any wake does: said by her, or shown by annai at its end. "Still owed" is the loop's own rule read
// back from the log (Transcript.owedReminders): a reminder's entry settles it, and so does her reaching the user after it, in the half whose wake
// carried it. A turn that ends by itself on a page being left with a reminder still owed writes no end, so the next start takes it up too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, idleAtOnce, raw } from './agent-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record } from '../../src/core/agent/log.js';
import { NETWORK_RETRIES, OVERLOAD_RETRIES } from '../../src/core/llm/fallback.js';

const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const asleep = { toolCalls: [sleep] };
const LEAVE = 'Leave for the airport by 14:10';
const CHECK_OUT = 'Check out by 11';
/** A watch's wake, with its reminder. @param {string} [text] @param {string} [watch] */
const fired = (text = LEAVE, watch = 'w1') => ({ kind: 'trigger', text: `Your watch fired: ${text}.`, fallbacks: [{ watch, text }] });
/** The page is killed in her model call: every try of it fails as the page goes (the call retries a network failure). */
const KILLED = Array(1 + NETWORK_RETRIES.length).fill({ delayMs: 30, error: 'network', message: 'Load failed' });
/** The reminders' cards, by their words. @param {any[]} cards */
const reminders = (cards) => cards.filter((n) => n.title === 'Reminder').map((n) => n.body);

/** A loop tool that waits until it is let go: the page is left while it runs. @param {any} half */
function lingers(half) {
  const at = { lingering: false, go: () => {} };
  const held = new Promise((r) => { at.go = () => r(undefined); });
  half.addLoopTools([{ name: 'linger', pluginId: 'core', group: 'Time', description: 'Wait.', input: { type: 'object' }, run: async () => { at.lingering = true; await held; return 'Done.'; } }]);
  return at;
}
const linger = { name: 'linger', input: {} };

/**
 * The next start, one Shiori: a new page's agent opens the conversation, takes up what is owed, and is done. @param {any} k
 * @returns {Promise<{ agent: any, cards: any[] }>}
 */
async function nextStart(k) {
  k.llm.bench.clear('m-0'); // a new page starts with no model benched
  const agent = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  agent.addLoopTools(selfTools(agent));
  /** @type {any[]} */
  const cards = [];
  agent.on('notice', (n) => cards.push(n));
  await agent.open(k.trip);
  await idleAtOnce({ agent });
  return { agent, cards };
}

/** The next start with Shiori as two halves (a new page's Halves, Koe on or off as the models say). @param {any} k @returns {Promise<{ agent: any, cards: any[] }>} */
async function nextHalves(k) {
  for (const m of ['m-0', 'm-koe']) k.llm.bench.clear(m);
  const agent = new Halves({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, voice: null, timeZone: () => 'UTC', secondMs: 10 });
  agent.addLoopTools(selfTools(agent.kokoro));
  const cards = raw({ agent });
  await agent.open(k.trip);
  await idleAtOnce({ agent }); // Koe opens once Kokoro knows what is owed (Halves.open), which idle() doesn't wait for
  await agent.opening;
  await idleAtOnce({ agent });
  return { agent, cards };
}

/** The restart wakes' records in the log: each one's reminders. @param {any} k */
const restarts = async (k) => (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'restart')).map((/** @type {any} */ e) => (e.data.reminders ?? []).map((/** @type {any} */ r) => r.text));

/** One Shiori, and two halves with Kokoro alone (as production builds it when no Koe model is set). */
const MODES = /** @type {[string, any][]} */ ([['', {}], [' (two halves, Kokoro alone)', { halves: true }]]);

for (const [mode, o] of MODES) {
  for (const [how, then, said] of /** @type {const} */ ([
    ['she sleeps without a word', asleep, false],
    ['she says it', { toolCalls: [speak(LEAVE), sleep] }, true],
  ])) {
    test(`closed in the model call of a watch's turn that owes a reminder, then started again (${how}): the reminder reaches them once, by her or by annai${mode}`, async (t) => {
      useClock(t);
      const k = await agentKit([[...KILLED, then]], o);
      k.agent.wake(fired());
      await until(() => k.requests.length === 1);
      k.agent.leaving(); // pagehide: WebKit then cancels the request
      await idleAtOnce(k);
      assert.deepEqual(reminders(k.notices), [], 'nothing on the page being left');
      const owed = (await Transcript.load(k.store, k.trip)).owedReminders;
      const next = await (o.halves ? nextHalves(k) : nextStart(k));
      assert.deepEqual(reminders(next.cards), said ? [] : [LEAVE], said ? 'she said it: nothing to show' : 'annai shows it at the restart turn\'s end');
      assert.deepEqual(await restarts(k), [[LEAVE]], 'the restart wake carries it');
      assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), said ? [LEAVE] : []);
      assert.deepEqual(owed, [{ watch: 'w1', text: LEAVE }], 'the log said it was still owed');
      assert.deepEqual((await Transcript.load(k.store, k.trip)).owedReminders, [], 'settled: the start after that takes nothing up for it');
      assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false);
    });
  }

  test(`put away (hidden, then pagehide) while a tool of hers runs in a watch's turn, the turn then ending by itself: no end is written, and the next start takes it up and shows the reminder once${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger, sleep] }, asleep]], o);
    const tool = lingers(k.agent.kokoro ?? k.agent);
    k.agent.wake(fired());
    await until(() => tool.lingering);
    // As main.js does: hidden (visibilitychange), then pagehide. Her requests may run on, and the turn ends by itself.
    k.agent.hush?.('away');
    k.agent.leaving();
    tool.go();
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [], 'nothing on the page being left');
    assert.deepEqual(await k.events(['turn.end']), [], 'the turn still owes it: no end');
    assert.equal(k.requests.length, 1, 'her turn ended by itself');
    const next = await (o.halves ? nextHalves(k) : nextStart(k));
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.match((await k.events(['wake'])).at(-1).data.reasons[0].text, /in the middle of your turn/);
    assert.equal((await k.events(['turn.end'])).length, 1, 'the restart turn ends');
  });
}

test('back on the page before it goes (the same tool, the page shown again): the turn ends as ever, showing the reminder at once, and nothing is taken up later', async (t) => {
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
  assert.deepEqual(await restarts(k), [[CHECK_OUT]]);
  assert.deepEqual(reminders(next.cards), [CHECK_OUT], 'only the one she had not said');
});

test("a reminder that joins the user's turn meanwhile, the page closed in her next call: the next start shows it once", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, ...KILLED, { toolCalls: [speak('Here is what I found.'), sleep] }]]);
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
  // Her line answers the user's words, and reaches them after the reminder came: it settles it, as at any turn's end (the loop's rule).
  assert.deepEqual(await restarts(k), [[LEAVE]]);
  assert.deepEqual(reminders(next.cards), [], 'she reached them in the restart turn: settled');
  assert.deepEqual((await Transcript.load(k.store, k.trip)).owedReminders, []);
});

test("a reminder that joins the user's turn meanwhile, the page closed in her next call, and the restart turn reaching nobody: annai shows it", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, ...KILLED, asleep]]);
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
});

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
  assert.deepEqual(await restarts(k), [[CHECK_OUT]]);
  assert.deepEqual(reminders(next.cards), [CHECK_OUT]);
});

test('the restart turn cut by the page going too: the start after that shows the reminder once, not once per take-up', async (t) => {
  useClock(t);
  const k = await agentKit([[...KILLED, ...KILLED, asleep]]);
  k.agent.wake(fired());
  await until(() => k.requests.length === 1);
  k.agent.leaving();
  await idleAtOnce(k);
  // The second page: its restart turn is killed in its call as well.
  k.llm.bench.clear('m-0');
  const second = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  /** @type {any[]} */
  const cards = [];
  second.on('notice', (n) => cards.push(n));
  await second.open(k.trip);
  await until(() => k.requests.length === KILLED.length + 1);
  second.leaving();
  await idleAtOnce({ agent: second });
  assert.deepEqual(reminders(cards), []);
  const owed = (await Transcript.load(k.store, k.trip)).owedReminders;
  const third = await nextStart(k);
  assert.deepEqual(reminders(third.cards), [LEAVE]);
  assert.deepEqual(owed, [{ watch: 'w1', text: LEAVE }], 'once, though two records carry it');
});

test("a watch's wake with a reminder and a cue, closed mid-turn, and the next start can't reach her model: annai shows the reminder, never the cue (a note for her, whose moment has gone)", async (t) => {
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
});

test("a block of annai's own that joins her turn with reminders and no line of its own (Koe gone down, Kokoro told to talk directly): its reminders are kept, and the next start shows them", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, ...KILLED, asleep]], { halves: true });
  const tool = lingers(k.agent.kokoro);
  k.agent.send('What is near?');
  await until(() => tool.lingering);
  k.agent.kokoro.enqueue({ kind: 'halves', text: "Koe can't speak right now.", logged: true, fallbacks: [{ watch: 'w1', text: LEAVE }] }); // as Halves' #talkDirectly does
  tool.go();
  await until(() => k.requests.length === 2);
  k.agent.leaving();
  await idleAtOnce(k);
  const next = await nextHalves(k);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  const joined = (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.meanwhile);
  assert.deepEqual(joined.map((/** @type {any} */ e) => [e.data.reasons, e.data.reminders]), [[[], [{ watch: 'w1', text: LEAVE }]]], 'a record with no reasons: no line for her');
});

test('an old log, whose wake records keep no reminders, opens as before: the restart carries none, and nothing is shown', async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'trigger', text: `Your watch fired: ${LEAVE}.` }] } });
  const owed = (await Transcript.load(k.store, k.trip)).owedReminders;
  const next = await nextStart(k);
  const [restart] = (await k.events(['wake'])).slice(1);
  assert.equal(restart.data.reasons[0].kind, 'restart');
  assert.equal('reminders' in restart.data, false, 'a wake that carries none has no key');
  assert.deepEqual(reminders(next.cards), []);
  assert.deepEqual(owed, [], 'read as none');
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

// Koe on: a watch's reminder rides Koe's wake (spec §11.3: so it is said once), and Kokoro is told Koe says it. Koe's own records keep it.
const KOE_KILLED = { type: [...KILLED, asleep] };
for (const [who, kokoro] of /** @type {const} */ ([
  ['Koe takes its own turn up (Kokoro had finished)', [asleep]],
  ['Kokoro takes both up (its turn was cut too), with the reminder Koe owed', [...KILLED, asleep]],
])) {
  test(`Koe on, closed in Koe's model call of a watch's turn: ${who}, and the reminder is shown once`, async (t) => {
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
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(wakes.filter((/** @type {any} */ e) => e.data.half === 'koe').map((/** @type {any} */ e) => e.data.reminders), [[{ watch: 'w1', text: LEAVE }]], "Koe's wake record keeps it");
    assert.equal(wakes.filter((/** @type {any} */ e) => e.data.half === 'kokoro' && e.data.reminders).length, 0, "Kokoro's copy carries none");
    const taken = (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'restart'));
    assert.deepEqual(taken.map((/** @type {any} */ e) => [e.data.half, e.data.reminders?.map((/** @type {any} */ r) => r.text)]), [[kokoro.length === 1 ? 'koe' : 'kokoro', [LEAVE]]]);
  });
}

test("Koe on, put away (hidden, then pagehide) while a tool of Koe's runs in a watch's turn, Koe's turn then ending by itself: no end of Koe's is written, and the next start's Koe takes it up and shows the reminder once", async (t) => {
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
  const ends = (await k.events(['turn.end'])).map((/** @type {any} */ e) => e.data.half);
  const next = await nextHalves(k);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  assert.deepEqual(ends, ['kokoro'], "Kokoro's turn ended; Koe's owed the reminder still");
  const taken = (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'restart'));
  assert.deepEqual(taken.map((/** @type {any} */ e) => e.data.half), ['koe']);
});
