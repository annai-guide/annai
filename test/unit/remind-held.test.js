// A reminder held only in memory reaches the log (the Deferred entry "A reminder held only in memory is lost when annai is closed", which this change
// closes; spec §11.3). Whatever holds a watch's reminder in memory before a turn's wake record carries it (a wake queued behind her running turn; Koe's live
// session, out of view too) writes it to its conversation's log as it is first held (`reminder.held`), and the next open shows what the log still owes. A
// held one is no turn's yet: only its entry, or the record of the turn or session that takes it, settles it, never a line of hers written meanwhile. The
// open leaves what this page still holds to it. Each test is a hard kill, as the final review's probe was: the store keeps what was written, and nothing
// in memory survives (the first page is left as it is, its turn stuck, and a new page's agent opens the same store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, idleAtOnce, inTime } from './agent-kit.js';
import { liveKit, soon, tone, texts } from './koe-live-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record } from '../../src/core/agent/log.js';
import { ME, createTrip, removeTrip } from '../../src/core/scopes.js';

const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const asleep = { toolCalls: [sleep] };
const linger = { name: 'linger', input: {} };
const LEAVE = 'Leave for the airport by 14:10';
const TRAIN = 'Train at 10:40';
/** A watch's wake, with its reminder. @param {string} [text] @param {string} [watch] */
const fired = (text = LEAVE, watch = 'w1') => ({ kind: 'trigger', text: `Your watch fired: ${text}.`, fallbacks: [{ watch, text }] });
/** The reminders' cards, by their words. @param {any[]} cards */
const reminders = (cards) => cards.filter((n) => n.title === 'Reminder').map((n) => n.body);
/** The reminders' entries in a conversation's log, by their words. @param {any} k @param {string} [scope] */
const entries = async (k, scope = k.trip) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['reminder'] }))).map((/** @type {any} */ e) => e.data.text);
/** One Shiori, and two halves with Kokoro alone (as production builds it when no Koe model is set). */
const MODES = /** @type {[string, any][]} */ ([['', {}], [' (two halves, Kokoro alone)', { halves: true }]]);

/**
 * A loop tool whose every call waits until that call is let go (go[i]): her turn is stuck in it while the page is killed. @param {any} half
 * @returns {{ calls: number, go: (() => void)[] }}
 */
function gates(half) {
  const at = { calls: 0, go: /** @type {(() => void)[]} */ ([]) };
  half.addLoopTools([{ name: 'linger', pluginId: 'core', group: 'Time', description: 'Wait.', input: { type: 'object' }, run: () => new Promise((r) => { at.calls++; at.go.push(() => r('Done.')); }) }]);
  return at;
}

/** Until nothing more can run (the test's clock fires a timer only then): a wake just made is past its budgets' check, and waits in the queue. */
const settled = () => new Promise((r) => setTimeout(r, 30));

/** The cards an agent (or both its halves) raises from now on. @param {any} agent */
function listen(agent) {
  /** @type {any[]} */
  const cards = [];
  for (const half of agent.kokoro ? [agent.kokoro, agent.koe] : [agent]) half.on('notice', (/** @type {any} */ n) => cards.push(n));
  return cards;
}

/**
 * The next start: a new page's agent (one Shiori, or two halves as the kit was made) opens the conversation and is done. @param {any} k @param {boolean} [halves]
 * @param {string | null} [trip] @returns {Promise<{ agent: any, cards: any[] }>}
 */
async function nextStart(k, halves = false, trip = k.trip) {
  for (const m of ['m-0', 'm-koe']) k.llm.bench.clear(m);
  const c = { store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, voice: null, timeZone: () => 'UTC', secondMs: 10 };
  /** @type {any} */
  const agent = halves ? new Halves(c) : new Agent(c);
  agent.addLoopTools(selfTools(agent.kokoro ?? agent));
  const cards = listen(agent);
  await inTime(agent.open(trip), 'the open did not finish');
  await idleAtOnce({ agent });
  if (halves) {
    await inTime(agent.opening, 'Koe did not open');
    await idleAtOnce({ agent });
  }
  return { agent, cards };
}

for (const [mode, o] of MODES) {
  test(`a watch's wake queued behind her running turn as the page is killed: the next start shows its reminder once, and the start after that nothing${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled(); // the wake waits in the queue: her turn is in its tool
    assert.deepEqual(reminders(k.notices), [], 'not shown on the first page');
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await entries(k), [LEAVE], 'its entry, once');
    const again = await nextStart(k, o.halves);
    assert.deepEqual(reminders(again.cards), [], 'its entry settled it');
    assert.deepEqual((await k.events(['reminder.held'])).map((/** @type {any} */ e) => e.data.reminders), [[{ watch: 'w1', text: LEAVE }]], 'held as it was queued');
  });

  test(`her running turn speaks after a wake queued behind it, and the page is killed before the wake joins: that line was no answer to it, so the next start shows it once${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger, speak('Here is what I found.'), linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled();
    tool.go[0]();
    await until(() => tool.calls === 2); // her line is written, and her second tool waits: the wake hasn't joined her turn
    const log = (await k.events(['reminder.held', 'out.speak', 'wake'])).map((/** @type {any} */ e) => e.type);
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await entries(k), [LEAVE]);
    assert.deepEqual(log, ['wake', 'reminder.held', 'out.speak'], 'her line came after the reminder was held, and no record took it up');
  });

  test(`a wake queued behind her turn joins it, and she says its reminder before the page is killed: the next start shows nothing${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, { toolCalls: [speak(`${LEAVE}.`), linger] }]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled();
    tool.go[0]();
    await until(() => tool.calls === 2); // the wake joined her next step, which said it, and her turn waits again
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), [], 'she said it: the record of the turn that took it up owes it, and her line after it settles it');
    assert.deepEqual(await entries(k), []);
  });

  test(`a wake queued behind her turn, whose reminder annai shows as another conversation is opened, then the page is killed: the next start shows nothing more${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled();
    await k.agent.open(other); // what waited for Big Sur is written into it, its reminder shown first (#keepWakes): its entry, and a record that carries none
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [LEAVE]);
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), [], 'its entry settled what was held');
    assert.deepEqual(await entries(k), [LEAVE]);
  });

  test(`a wake queued behind her turn, then Start fresh, then the page killed: the reminder shown at Start fresh is not shown again${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled();
    assert.equal(await k.agent.startFresh(), 'done');
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [LEAVE], 'shown by Start fresh: what waited behind the turn it stopped is written down as stopped, its reminder shown');
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), []);
    assert.deepEqual(await entries(k), [LEAVE]);
  });

  test(`a wake queued behind her turn in a trip that is then removed: nothing shows at the next start, there or anywhere${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled();
    // Remove trip (the trip screen's removeTripNow): Shiori leaves it first, then it goes with its log.
    await k.agent.open(null, { quiet: true });
    await idleAtOnce(k);
    await removeTrip(k.store, k.trip);
    const next = await nextStart(k, o.halves, null);
    assert.deepEqual(reminders(next.cards), []);
    assert.deepEqual(await entries(k, ME), [], 'nothing of it reached the conversation that is open');
  });

  test(`a wake whose only fallback is a cue (a place, the road), queued behind her turn as the page is killed: a cue is no reminder, so nothing shows${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake({ kind: 'trigger', text: 'You are near Bixby Bridge.', fallbacks: [{ watch: 'w2', text: 'Bixby Bridge is near', cue: true }] });
    await settled();
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), []);
    assert.deepEqual(await k.events(['reminder.held']), [], 'nothing is held for a cue');
  });

  // What this page still holds is its own to say: an open of the same conversation in this page (its turn halted, the wake still queued behind it) doesn't
  // show it, and the turn that takes the wake says it, or annai shows it at that turn's end: once.
  test(`the open of the conversation this page holds a queued reminder for leaves it to the wake: shown once, by the turn that takes it${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, asleep]], o);
    const tool = gates(k.agent.kokoro ?? k.agent);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.wake(fired());
    await settled();
    await k.agent.open(k.trip); // the same conversation: her turn is halted, and the wake waits on
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [LEAVE], 'once: by the turn that took the wake up, at its end');
    assert.deepEqual(await entries(k), [LEAVE]);
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), []);
  });
}

// Koe on a chat model: the wake with the reminder waits in Koe's own queue behind Koe's turn. Kokoro's half shows it at the next start, once.
test("Koe on a chat model, a watch's wake queued behind Koe's running turn as the page is killed: the next start shows its reminder once, by Kokoro's half", async (t) => {
  useClock(t);
  const k = await agentKit([[asleep, asleep, asleep]], { koe: { type: [{ toolCalls: [linger] }, asleep, asleep] } });
  const tool = gates(k.agent.koe);
  k.agent.send('What is near?');
  await until(() => tool.calls === 1);
  k.agent.wake(fired());
  await settled();
  const next = await nextStart(k, true);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  assert.deepEqual(await entries(k), [LEAVE]);
  const again = await nextStart(k, true);
  assert.deepEqual(reminders(again.cards), []);
});

// The read, from logs written by hand: what settles a reminder a page held.
const R = { watch: 'w1', text: LEAVE };
const PAGE = 'p-dead';
/** @param {string} type @param {Record<string, any>} data @param {string} [actor] */
const ev = (type, data, actor = 'shiori') => ({ type, actor, data });
const held = () => ev('reminder.held', { reminders: [R], page: PAGE }, 'system');
const carried = (/** @type {Record<string, any>} */ more = {}) => ev('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'Fired.' }], reminders: [R], ...more }, 'system');
const line = (/** @type {Record<string, any>} */ more = {}) => ev('out.speak', { id: 's1', wake: 'w-0', text: 'Here is what I found.', ...more });
for (const [what, log, owed] of /** @type {[string, any[], any[]][]} */ ([
  ['held, with the page that held it', [held()], [{ ...R, held: PAGE }]],
  ['a line of hers after it does not settle it: no turn had it', [held(), line()], [{ ...R, held: PAGE }]],
  ['nor does a line of Koe\'s', [held(), line({ half: 'koe' })], [{ ...R, held: PAGE }]],
  ['its entry settles it', [held(), ev('reminder', { ...R, waiting: true }, 'system')], []],
  ['the record of the turn that takes it carries it from there, and her line after that settles it', [held(), line(), carried(), line()], []],
  ['taken by the turn, before her line', [held(), carried()], [R]],
  ["taken by Koe's session, then Kokoro's line: Koe still owes it", [held(), carried({ meanwhile: true, reasons: [], half: 'koe' }), line({ half: 'kokoro' })], [{ ...R }]],
  ["taken by Koe's session, then Koe's line settles it", [held(), carried({ meanwhile: true, reasons: [], half: 'koe' }), line({ half: 'koe' })], []],
  ['held again after the turn took it (a second firing): held, so no line settles it', [carried(), held(), line()], [{ ...R, held: PAGE }]],
  ['passes over what is not a reminder, and a record with no list', [ev('reminder.held', { reminders: [null, { watch: 'w2' }, 'text', R], page: PAGE }, 'system'), ev('reminder.held', { page: PAGE }, 'system')], [{ ...R, held: PAGE }]],
  ['a record with no page is held by none', [ev('reminder.held', { reminders: [R] }, 'system')], [{ ...R, held: '' }]],
])) {
  test(`the read of what is still owed, held by a page: ${what}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], { open: false });
    for (const e of log) await record(k.store, k.trip, e);
    for (const half of /** @type {const} */ (['one', 'kokoro', 'koe'])) assert.deepEqual((await Transcript.load(k.store, k.trip, { half })).owedReminders, owed, `read by ${half}'s rules`);
  });
}

// Koe live (Koe · Realtime): the session holds a watch's reminder to say. The live tests keep the real clock (a live socket).
/** The page out of view, or back, as the browser says it. @param {boolean} on */
function hidden(on) {
  if (on) /** @type {any} */ (globalThis).document = { visibilityState: 'hidden' };
  else delete (/** @type {any} */ (globalThis).document);
}
const train = () => ({ kind: 'trigger', text: 'Train in 20 minutes', fallbacks: [{ watch: 'train', text: TRAIN }] });

test('Koe live: the session has the reminder and is still saying it as the page is killed: the next start shows it once, by Kokoro\'s half', async () => {
  // Her answer plays for 20 s at the server's own pace: the page is killed while it does, before her line is written.
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(20) }], { pace: 1 });
  try {
    await k.voice.unlock(); // an earlier tap
    await k.agent.wake(train());
    await soon(async () => texts(k).length === 1);
    await until(() => k.platform.streams.length === 1, 30_000);
    assert.deepEqual(await k.events(['out.speak']), [], 'her line is not written yet');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [TRAIN]);
    assert.deepEqual(await entries(k), [TRAIN]);
  } finally {
    await k.done();
  }
});

test('Koe live: the session said the reminder before the page was killed: the next start shows nothing', async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(0.3) }]);
  try {
    await k.voice.unlock();
    await k.agent.wake(train());
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    assert.deepEqual(await k.events(['reminder']), [], 'annai showed nothing: Koe said it');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), []);
    assert.deepEqual(await entries(k), []);
  } finally {
    await k.done();
  }
});

test('Koe live: the session holds the reminder while the page is out of view (it went out of view as the session was being reached), and the page is killed: the next start shows it once', async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(0.3) }]);
  try {
    await k.voice.unlock();
    /** @type {() => void} */
    let release = () => {};
    k.agent.koe.opening = new Promise((r) => { release = () => r(undefined); }); // Koe's open is under way as the wake comes
    await k.agent.wake(train()); // in view: it is the session's to say
    await until(() => k.requests.length === 1, 30_000); // Kokoro is told Koe says it: the route is past its look at the page, the session's part waits for Koe's open
    hidden(true); // out of view before the session takes it: it waits for the page to be back
    release();
    await k.agent.idle();
    assert.equal(k.server.connections().length, 0, 'out of view: no session opened, the reminder waits for the page to be back');
    assert.deepEqual(await k.events(['reminder']), [], 'nor did annai show it');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [TRAIN]);
    assert.deepEqual(await entries(k), [TRAIN]);
  } finally {
    hidden(false);
    await k.done();
  }
});
