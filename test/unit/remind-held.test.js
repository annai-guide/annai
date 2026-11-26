// A reminder held only in memory reaches the log (the Deferred entry "A reminder held only in memory is lost when annai is closed", which this change
// closes; spec §11.3). Whatever holds a watch's reminder in memory before a turn's wake record carries it (a wake queued behind her running turn; Koe's live
// session, out of view too) writes it to its conversation's log as it is first held (`reminder.held`), and the next open shows what the log still owes. A
// held one is no turn's yet: only its entry, the live session's own word that it passed it on (`reminder.told`), or the record of the turn that takes it
// settles it, never a line of hers. The open leaves what this page still holds to it (by its page mark). A test is a kill, as the final review's probe was: a
// new page's agent opens the same store, so what it shows is only what the first page wrote. The first page is left as it is, frozen where the test's clock
// holds it (its turn stuck in a tool, its queue, its timers); the live tests keep the real clock and a real socket, so their first page is not frozen: its
// session goes on, or is closed as a page going out of view closes it, while the test runs. A Stop, a tap, and an open of the same conversation in the same
// page are no kill: those tests check what that page itself shows, and most then what a next start shows; the read rows read logs written by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, idleAtOnce, inTime, holdAtDoor, holdReminders, raw } from './agent-kit.js';
import { liveKit, soon, tone, texts, got, lives, say as sayClip } from './koe-live-kit.js';
import { codePlugin, storedModules } from './package-kit.js';
import { quietSession, tell, tell2, cues, notesIn, words, shown, wait, textsIn, SAID, PASS } from './live-flight-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record } from '../../src/core/agent/log.js';
import { ME, createTrip, removeTrip } from '../../src/core/scopes.js';
import { readConfig, saveRoles } from '../../src/core/llm/config.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { fakeSensors, at, iso, LA } from './live-kit.js';

const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const asleep = { toolCalls: [sleep] };
const say = (/** @type {string} */ text) => ({ toolCalls: [speak(text), sleep] });
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

/**
 * A conversation's opening that waits on its first read of the log, as on a phone slow to read: the door shuts when `shut()` is called, holds the next
 * read of the events only, and opens with `open()`. @param {any} k @returns {{ shut: () => void, held: () => boolean, open: () => void }}
 */
function slowOpen(k) {
  let on = false;
  let taken = false;
  const door = holdAtDoor(k, (stores, mode) => {
    if (!on || mode !== 'readonly' || !stores.includes('events')) return false;
    on = false;
    taken = true;
    return true;
  });
  return { shut: () => { on = true; taken = false; }, held: () => taken, open: door.open };
}

/**
 * Koe's own open held at the door until open() lets it go, as at a start (Koe opens after Kokoro); reached() says #live has read it, which is where a wake
 * waits for it: no timer decides that. @param {any} k @returns {{ open: () => void, reached: () => boolean }}
 */
function holdKoeOpen(k) {
  /** @type {() => void} */
  let open = () => {};
  const door = new Promise((r) => { open = () => r(undefined); });
  const real = k.agent.koe.opening;
  /** @type {Promise<unknown>} */
  let held = door.then(() => real);
  let reads = 0;
  Object.defineProperty(k.agent.koe, 'opening', { configurable: true, get: () => { reads++; return held; }, set: (v) => { held = v; } }); // Koe's own open chains on it
  return { open, reached: () => reads > 0 };
}

/** The reminder.held records a conversation's log holds, by their reminders' words. @param {any} k @param {string} [scope] */
const heldIn = async (k, scope = k.trip) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['reminder.held'] }))).flatMap((/** @type {any} */ e) => e.data.reminders.map((/** @type {any} */ r) => r.text));

/** The cards an agent (or both its halves) raises from now on, and Kokoro's own among them (one Shiori's are all hers). @param {any} agent @returns {{ cards: any[], kokoro: any[] }} */
function listen(agent) {
  /** @type {any[]} */
  const cards = [];
  /** @type {any[]} */
  const kokoro = [];
  const main = agent.kokoro ?? agent;
  for (const half of agent.kokoro ? [agent.kokoro, agent.koe] : [agent]) {
    half.on('notice', (/** @type {any} */ n) => {
      cards.push(n);
      if (half === main) kokoro.push(n);
    });
  }
  return { cards, kokoro };
}

/**
 * The next start: a new page's agent (one Shiori, or two halves as the kit was made) opens the conversation and is done. @param {any} k @param {boolean} [halves]
 * @param {string | null} [trip] @returns {Promise<{ agent: any, cards: any[], kokoro: any[] }>}
 */
async function nextStart(k, halves = false, trip = k.trip) {
  for (const m of ['m-0', 'm-koe']) k.llm.bench.clear(m);
  const c = { store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, voice: null, timeZone: () => 'UTC', secondMs: 10 };
  /** @type {any} */
  const agent = halves ? new Halves(c) : new Agent(c);
  agent.addLoopTools(selfTools(agent.kokoro ?? agent));
  const { cards, kokoro } = listen(agent);
  await inTime(agent.open(trip), 'the open did not finish');
  await idleAtOnce({ agent });
  if (halves) {
    await inTime(agent.opening, 'Koe did not open');
    await idleAtOnce({ agent });
  }
  return { agent, cards, kokoro };
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
    assert.deepEqual(await heldIn(k), [LEAVE], 'held once: the hold at its entry is not written again as it is queued');
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

  test(`a wake queued behind her turn in a trip that is then removed: its reminder is shown as the trip is left, and nothing of it shows at the next start${mode}`, async (t) => {
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
    assert.deepEqual(reminders(k.notices), [LEAVE], 'shown as the trip is left (its card, its entry in the log that then goes)');
    await removeTrip(k.store, k.trip);
    const next = await nextStart(k, o.halves, null);
    assert.deepEqual(reminders(next.cards), [], 'nothing of the removed trip shows');
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

// A wake is held as it first comes, before its budgets' check (the settings read) and, with two halves, before Halves' route (the Deferred entry "A reminder
// in memory can still be lost in annai's first seconds", shape (2)): the page is killed while that check never ends. On a241fd148 nothing was written until
// the wake reached a queue, and the next start showed nothing.
for (const [mode, o] of MODES) {
  test(`a watch's wake still in its budgets' check as the page is killed: it is held as it came, and the next start shows its reminder once, and the start after that nothing${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], o);
    const half = k.agent.kokoro ?? k.agent;
    let checking = false;
    half.settings = () => { checking = true; return new Promise(() => {}); }; // the read never ends: the page is killed in it
    k.agent.wake(fired());
    await until(() => checking);
    await settled();
    assert.deepEqual(reminders(k.notices), [], 'not shown on the first page');
    assert.deepEqual(await heldIn(k), [LEAVE], 'held once, as it came');
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await entries(k), [LEAVE], 'its entry, once');
    const again = await nextStart(k, o.halves);
    assert.deepEqual(reminders(again.cards), []);
  });
}

// The wake is held for the conversation it is for (the target's): one that comes as that conversation is being opened is in its log, not in the one still
// open. One Shiori queues it at once; Halves' route holds it behind the open under way (its refresh waits for the open), and it is held as it comes all
// the same (shape (2) of the Deferred entry above: on a241fd148 the two halves held nothing until the route ran).
for (const [mode, o] of MODES) {
  test(`a watch's wake that comes while its conversation is opening as the page is killed: it is held in that conversation's log, not the one still open, and the next start shows its reminder once${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], o);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const slow = slowOpen(k);
    slow.shut();
    const opening = k.agent.open(other);
    await until(slow.held); // the open waits on its first read of the log
    k.agent.wake(fired());
    await settled();
    assert.deepEqual(await heldIn(k, other), [LEAVE], 'held in the conversation being opened');
    assert.deepEqual(await heldIn(k), [], 'not in the one still open');
    const next = await nextStart(k, o.halves, other);
    assert.deepEqual(reminders(next.cards), [LEAVE]);
    assert.deepEqual(await entries(k, other), [LEAVE]);
    slow.open();
    await opening;
    await idleAtOnce(k);
  });
}

// A wake keeps the conversation it came for (the Deferred entry "A reminder on its way when another conversation opens is shown again at the next start"):
// a watch's wake for the open conversation, still in its budgets' read or, with two halves, in Halves' route, when another conversation opens. Where it
// lands, its own is no longer the open one: its reminder is shown now and the wake is written into its own log (#keepFor, as a firing for a conversation
// that isn't open is), and the reminder's entry settles the copy held there. On 50887655f it was queued in the conversation just opened and told there, and
// the first kept its held copy, shown once more at the next start that opened it. With no other conversation opened, the path is as before (the controls).
const KOE = { koe: { type: [asleep] } };
const BOTH = /** @type {[string, any][]} */ ([['', {}], [' (Koe and Kokoro, Koe on a chat model)', KOE]]);
const ALL = /** @type {[string, any][]} */ ([...BOTH, [' (two halves, Kokoro alone)', { halves: true }]]);

/**
 * The next call to a half's settings(), its budgets' read, waits at the door until open() lets it go; budgets, when given, are what it then reads.
 * @param {any} half @param {any} [budgets] @returns {{ reached: () => boolean, open: () => void }}
 */
function holdBudgets(half, budgets) {
  const real = half.settings.bind(half);
  let armed = true;
  let reached = false;
  /** @type {() => void} */
  let open = () => {};
  const door = new Promise((r) => { open = () => r(undefined); });
  half.settings = () => {
    if (!armed) return real();
    armed = false;
    reached = true;
    return door.then(real).then((/** @type {any} */ s) => (budgets ? { ...s, budgets } : s));
  };
  return { reached: () => reached, open };
}

/** Halves' routes wait at their refresh (`llm.ready`, which at a start waits for the plugins) until open() lets them go. @param {any} k */
function holdRoutes(k) {
  /** @type {() => void} */
  let open = () => {};
  k.llm.ready = new Promise((r) => { open = () => r(undefined); });
  return { open };
}

/** A conversation's records of a type, as written. @param {any} k @param {string} scope @param {string} type */
const recordsIn = async (k, scope, type) => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: [type] }));

/**
 * What the traveller got once the wake for Big Sur landed with Kyoto open: its reminder shown once, its entry in Big Sur, nothing of it in Kyoto (no entry,
 * no wake that tells it, no turn), the wake in Big Sur's own log; and the next start that opens Big Sur shows nothing more.
 * @param {any} k @param {any} o @param {string} other @param {any[]} cards @param {number} before the requests made before it came
 */
async function toldInItsOwn(k, o, other, cards, before) {
  assert.deepEqual(reminders(cards), [LEAVE], 'shown now, once');
  assert.deepEqual(await entries(k), [LEAVE], 'its entry, in its own conversation');
  assert.deepEqual(await entries(k, other), [], 'none in the one opened');
  assert.equal(JSON.stringify(await recordsIn(k, other, 'wake')).includes(LEAVE), false, 'no wake in the one opened tells it');
  assert.equal(k.requests.length, before, 'no turn took it in the one opened');
  assert.deepEqual((await recordsIn(k, k.trip, 'wake')).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'trigger')).map((/** @type {any} */ e) => [e.data.reasons[0].text.endsWith('(annai has already shown the user its reminder.)'), e.data.reminders ?? []]),
    [[true, []]], 'written into its own conversation, saying annai showed it, carrying none');
  const next = await nextStart(k, Boolean(o.halves || o.koe));
  assert.deepEqual(reminders(next.cards), [], 'the next start that opens it shows nothing more');
  assert.deepEqual(await entries(k), [LEAVE], 'and writes no second entry');
}

for (const [mode, o] of BOTH) {
  for (const opens of [true, false]) {
    test(`a watch's wake still in its budgets' read ${opens ? 'when another conversation opens: its reminder is shown now and the wake written into its own conversation, never told in the one opened, and the next start that opens its own shows nothing more' : 'and no other conversation opens (the control): her turn takes it in its own conversation, as before'}${mode}`, async (t) => {
      useClock(t);
      const k = await agentKit([[asleep]], o);
      await idleAtOnce(k);
      const cards = raw(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      const before = k.requests.length;
      const read = holdBudgets(k.agent.kokoro ?? k.agent);
      k.agent.wake(fired());
      await until(read.reached);
      await settled();
      assert.deepEqual(await heldIn(k), [LEAVE], 'held in its own conversation as it came');
      if (opens) await k.agent.open(other);
      read.open();
      await idleAtOnce(k);
      if (o.koe) await idleAtOnce(k);
      if (opens) return toldInItsOwn(k, o, other, cards, before);
      assert.ok(k.requests.length > before, 'her turn took it');
      assert.deepEqual((await recordsIn(k, k.trip, 'wake')).flatMap((/** @type {any} */ e) => (e.data.reminders ?? []).map((/** @type {any} */ r) => r.text)), [LEAVE], "her turn's record carries it");
      assert.deepEqual(reminders(cards), [LEAVE], 'she slept without telling it: annai shows it at her turn\'s end, once');
      const next = await nextStart(k, Boolean(o.koe));
      assert.deepEqual(reminders(next.cards), []);
    });
  }

  // The budgets' other exits (quiet hours, the hourly limit) show the reminder themselves: in the wake's own conversation, whichever is open by then.
  test(`a watch's wake in its budgets' read under quiet hours when another conversation opens: its reminder is shown in its own conversation, whose entry settles what was held, and nothing of it in the one opened${mode}`, async () => {
    const k = await agentKit([[asleep]], o);
    await idleAtOnce(k);
    const cards = raw(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const hh = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(11, 16);
    const read = holdBudgets(k.agent.kokoro ?? k.agent, { quietHours: { from: hh(Date.now() - 3_600_000), to: hh(Date.now() + 3_600_000) } });
    k.agent.wake(fired());
    await until(read.reached);
    await settled();
    await k.agent.open(other);
    read.open();
    await idleAtOnce(k);
    assert.deepEqual(reminders(cards), [LEAVE], 'shown now, once');
    assert.deepEqual([await entries(k), await entries(k, other)], [[LEAVE], []], 'its entry in its own conversation, none in the one opened');
    const next = await nextStart(k, Boolean(o.koe));
    assert.deepEqual(reminders(next.cards), [], 'the next start that opens it shows nothing more');
  });

  // The hour's limit is the other exit: reached while the wake is in its budgets' read, its reminder is shown in the wake's own conversation.
  test(`a watch's wake in its budgets' read when the hour's limit is reached and another conversation opens: its reminder is shown in its own conversation, whose entry settles what was held, and nothing of it in the one opened${mode}`, async () => {
    const k = await agentKit([[asleep], [asleep]], o);
    await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
    k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' }); // spends the hour
    await idleAtOnce(k);
    if (o.koe) await idleAtOnce(k);
    const cards = raw(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const before = k.requests.length;
    const read = holdBudgets(k.agent.kokoro ?? k.agent);
    k.agent.wake(fired());
    await until(read.reached);
    await settled();
    assert.deepEqual(await heldIn(k), [LEAVE], 'held in its own conversation as it came');
    await k.agent.open(other);
    read.open();
    await idleAtOnce(k);
    assert.deepEqual(reminders(cards), [LEAVE], 'shown now, once');
    assert.equal(cards.some((n) => n.title === 'Shiori skipped a wake'), true, 'and the skipped wake is said');
    assert.deepEqual([await entries(k), await entries(k, other)], [[LEAVE], []], 'its entry in its own conversation, none in the one opened');
    assert.deepEqual(await recordsIn(k, other, 'wake'), [], 'no wake record in the one opened');
    assert.equal(k.requests.length, before, 'no turn took it, in the one opened or elsewhere');
    const next = await nextStart(k, Boolean(o.koe));
    assert.deepEqual(reminders(next.cards), [], 'the next start that opens it shows nothing more');
  });

  // Quiet hours hold the wake, not its reminder; when they end with another conversation open, the wake (which keeps its conversation) is written into its own,
  // and no turn answers it where the traveller is.
  test(`a watch's wake held by quiet hours, whose end comes with another conversation open: written into its own conversation, and no turn answers it in the one open${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], o);
    await idleAtOnce(k);
    const cards = raw(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const hh = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(11, 16);
    const read = holdBudgets(k.agent.kokoro ?? k.agent, { quietHours: { from: hh(Date.now() - 3_600_000), to: hh(Date.now() + 3_600_000) } });
    k.agent.wake(fired());
    await until(read.reached);
    await settled();
    await k.agent.open(other);
    read.open();
    await idleAtOnce(k);
    const before = k.requests.length;
    assert.deepEqual([await recordsIn(k, k.trip, 'wake'), await recordsIn(k, other, 'wake')].map((l) => l.length), [0, 0], 'held, not written, while quiet hours last');
    assert.deepEqual(reminders(cards), [LEAVE], 'shown while quiet hours hold the wake');
    await new Promise((r) => setTimeout(r, 2 * 3_600_000)); // the test's clock: quiet hours end
    await idleAtOnce(k);
    if (o.koe) await idleAtOnce(k);
    assert.deepEqual((await recordsIn(k, k.trip, 'wake')).map((/** @type {any} */ e) => e.data.reasons[0].kind), ['trigger'], 'written into its own conversation');
    assert.deepEqual(await recordsIn(k, other, 'wake'), [], 'none in the one opened');
    assert.equal(k.requests.length, before, 'no turn answered it where the traveller is');
    assert.deepEqual(reminders(cards), [LEAVE], 'its reminder was shown once (when quiet hours held the wake), not again as they end');
    assert.deepEqual([await entries(k), await entries(k, other)], [[LEAVE], []], 'and entered once, in its own conversation');
  });
}

// A third-party plugin's `annai.wake` belongs to the conversation open when the plugin calls it (docs/plugins.md): annai reads its words for keys first, an
// asynchronous read of the secrets, and another conversation opened in that moment must not take it.
for (const [mode, o] of MODES) {
  test(`a third-party plugin's wake, with another conversation opened while annai reads its words for keys: written into the conversation it was called in, and no turn answers it in the one opened${mode}`, async () => {
    const k = await agentKit([[asleep]], o);
    k.host.importModule = storedModules(k.ws);
    k.host.connect({ llm: k.llm, agent: k.agent, notices: { card: () => {}, toast: () => {} } });
    await k.host.install(codePlugin('trails', 'globalThis.__trailsWake = annai;'));
    await k.host.start('trails');
    const annai = /** @type {any} */ (globalThis).__trailsWake;
    await idleAtOnce(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const before = k.requests.length;
    let reading = true; // the next read of the secrets, its words' check, is held
    const door = holdAtDoor(k, (stores) => reading && stores.includes('secrets'));
    const waking = annai.wake('The Pine Ridge trail closed.');
    reading = false;
    await k.agent.open(other);
    door.open();
    await waking;
    await idleAtOnce(k);
    if (o.halves) await idleAtOnce(k);
    assert.equal(JSON.stringify(await recordsIn(k, other, 'wake')).includes('Pine Ridge'), false, 'no wake in the one opened tells it');
    assert.equal(JSON.stringify(await recordsIn(k, k.trip, 'wake')).includes('Pine Ridge'), true, 'written into the conversation it was called in');
    assert.equal(k.requests.length, before, 'no turn took it in the one opened');
  });
}

// With two halves the wake waits in Halves' route (its refresh: at a start, the plugins; an open under way) before Kokoro has it.
for (const [mode, o] of ALL.slice(1)) {
  for (const opens of [true, false]) {
    test(`a watch's wake still in Halves' route ${opens ? 'when another conversation opens: its reminder is shown now and the wake written into its own conversation, never told in the one opened, and the next start that opens its own shows nothing more' : 'and no other conversation opens (the control): it goes on as before, told once in its own conversation'}${mode}`, async (t) => {
      useClock(t);
      const k = await agentKit([[asleep]], o);
      await idleAtOnce(k);
      const cards = raw(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      const before = k.requests.length;
      const route = holdRoutes(k);
      k.agent.wake(fired());
      await settled();
      assert.deepEqual(await heldIn(k), [LEAVE], 'held in its own conversation as it came');
      assert.equal(k.agent.busy, true, 'still in the route');
      if (opens) await k.agent.open(other);
      route.open();
      await idleAtOnce(k);
      await inTime(k.agent.opening, 'Koe did not open');
      await idleAtOnce(k);
      if (opens) return toldInItsOwn(k, o, other, cards, before);
      assert.ok(k.requests.length > before, 'a turn took it');
      assert.deepEqual(reminders(cards), [LEAVE], 'told once');
      assert.deepEqual(await entries(k, other), []);
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), []);
    });
  }
}

// A tap on another trip's notification as annai comes back on screen: the catch-up (live mode's, a real Live) gives the open conversation its own due
// reminder, and the tap opens the trip the notification was for while that wake's budgets are read. F1's notification flow (remind-first-next's final review).
for (const [mode, o] of BOTH) {
  test(`a tap on another trip's notification opens it as the catch-up gives the open conversation its own due reminder: told once, in its own conversation, never in the one opened, and the next start that opens its own shows nothing more${mode}`, async () => {
    const clock = new ManualClock(at('09:00'));
    const k = await agentKit([[asleep]], { ...o, agent: { now: clock.now, timeZone: () => LA } });
    const sensors = fakeSensors(k.registry);
    /** @type {any[]} */
    const news = [];
    const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA, news: async () => news.splice(0) });
    const settle = async () => {
      await live.settled();
      await idleAtOnce(k);
      await live.settled();
    };
    await live.start();
    await settle();
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    await live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: LEAVE });
    const train = await live.setWatch(other, { when: { type: 'time', at: iso('10:00') }, fallback: TRAIN });
    await settle();
    const cards = raw(k);
    const before = k.requests.length;
    // Put away. At 10:00 the phone shows Kyoto's notification, which the traveller taps, and tells annai of that one only: Big Sur's own was not shown (a phone
    // that shows it is told of it too, and annai then holds no reminder for it: Live shows only what the phone didn't), so annai's reminder for it is still owed.
    sensors.visible(false);
    await settle();
    await clock.advanceTo(at('10:05'), settle);
    const key = `${other}|${train.id}`;
    news.push({ kind: 'shown', key, scope: other, watch: train.id, at: at('10:00'), t: at('10:00:30') }, { kind: 'opened', key, scope: other, watch: train.id, title: 'Kyoto', body: TRAIN, t: at('10:05') });
    const read = holdBudgets(k.agent.kokoro ?? k.agent);
    sensors.visible(true); // the tap brings annai forward: its catch-up gives Big Sur its reminder
    await until(read.reached);
    assert.deepEqual(await heldIn(k), [LEAVE], 'held in its own conversation as it came');
    await k.agent.open(other); // and opens Kyoto, the notification's trip
    read.open();
    await settle();
    if (o.koe) await settle();
    live.dispose();
    assert.deepEqual(reminders(cards), [LEAVE], "shown now, once (Kyoto's was shown by the phone)");
    assert.deepEqual([await entries(k), await entries(k, other)], [[LEAVE], []], 'its entry in its own conversation, none in the one opened');
    assert.equal(JSON.stringify(await recordsIn(k, other, 'wake')).includes(LEAVE), false, 'no wake in the one opened tells it');
    assert.ok(JSON.stringify(await recordsIn(k, other, 'wake')).includes('from its notification'), "Kyoto's own catch-up is there, with the tap");
    assert.ok(k.requests.length > before, "a turn answered Kyoto's");
    const next = await nextStart(k, Boolean(o.koe));
    assert.deepEqual(reminders(next.cards), [], 'the next start that opens Big Sur shows nothing more');
  });
}

// Live's delivery reads the open conversation once, at its start. One look finds firings for two conversations, the one that isn't open (Kyoto) listed before
// the open one (Big Sur); the traveller taps Kyoto's notification while Kyoto's reminder is written, and Kyoto opens. Big Sur's own firing, given after, is told
// in Big Sur (its reminder shown once, its entry and its wake there), never in Kyoto, whichever of its two ways it takes: the wake (online) or annai saying
// the reminder itself (no connection).
for (const [mode, o] of BOTH) {
  for (const online of [true, false]) {
    test(`a firing for the open conversation, listed after another conversation's whose notification is tapped meanwhile${online ? '' : ', with no connection'}: told in its own conversation, never in the one opened${mode}`, async () => {
      const clock = new ManualClock(at('09:00'));
      const k = await agentKit([[asleep], [asleep]], { ...o, agent: { now: clock.now, timeZone: () => LA } });
      const sensors = fakeSensors(k.registry);
      const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA, news: async () => [] });
      const settle = async () => {
        await live.settled();
        await idleAtOnce(k);
        await live.settled();
      };
      await live.start();
      await settle();
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      await live.setWatch(other, { when: { type: 'time', at: iso('10:00') }, fallback: TRAIN });
      await live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: LEAVE });
      await settle();
      const cards = raw(k);
      if (!online) sensors.online(false);
      sensors.visible(false);
      await settle();
      await clock.advanceTo(at('10:05'), settle);
      /** @type {string[]} */
      const order = [];
      // The tap lands while Kyoto's reminder is written.
      const remind = k.agent.remind.bind(k.agent);
      k.agent.remind = (/** @type {any} */ list, /** @type {any} */ scope, /** @type {any} */ opt) => {
        order.push(`remind ${list[0].text}`);
        const done = remind(list, scope, opt);
        if (scope === other && !order.includes('tap')) {
          order.push('tap');
          k.agent.open(other).catch(() => {});
        }
        return done;
      };
      sensors.visible(true);
      await settle();
      await settle();
      if (o.koe) await settle();
      live.dispose();
      assert.deepEqual(order.slice(0, 2), [`remind ${TRAIN}`, 'tap'], "Kyoto's firing came first, and the tap came as its reminder was written");
      assert.deepEqual(reminders(cards).sort(), [LEAVE, TRAIN], 'each shown once');
      assert.deepEqual([await entries(k), await entries(k, other)], [[LEAVE], [TRAIN]], "each entry in its own conversation: Big Sur's, not Kyoto's");
      assert.equal(JSON.stringify(await recordsIn(k, other, 'wake')).includes(LEAVE), false, "no wake in Kyoto tells Big Sur's");
      if (online) assert.deepEqual((await recordsIn(k, k.trip, 'wake')).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'catch-up')).map((/** @type {any} */ e) => [e.data.reasons[0].text.endsWith('(annai has already shown the user its reminder.)'), e.data.reminders ?? []]),
        [[true, []]], "Big Sur's wake is written into Big Sur, saying annai showed it, carrying none");
      const next = await nextStart(k, Boolean(o.koe));
      assert.deepEqual(reminders(next.cards), [], 'the next start that opens Big Sur shows nothing more');
      assert.deepEqual(await entries(k), [LEAVE], 'and writes no second entry');
    });
  }
}

// A Stop while a wake waits in Kokoro's queue with no turn started (a conversation opening: Undo's or Erase's, as the sign is hidden while one opens;
// housekeeping: the sign's): the wake is dropped, and its reminder is shown at the Stop, silently, once (the Stop stops her, not the reminder; spec §6.7), as a
// Stop of a gathering turn and Start fresh show theirs. Held until then, nothing else would show it in this page: its page mark hides it from this page's open,
// and the next start would be late.
/** What the Stop showed: its card once, said nowhere (voice on), and its entry (not said aloud) in the conversation. @param {any} k @param {any[]} cards @param {string} scope @param {string} [words] */
async function shownSilently(k, cards, scope, words = LEAVE) {
  assert.deepEqual(reminders(cards), [words], 'shown at the Stop, once');
  assert.equal(k.said.some((/** @type {string} */ x) => x.includes(words)), false, 'not said: silently');
  assert.deepEqual((await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['reminder'] }))).map((/** @type {any} */ e) => [e.data.text, e.data.aloud ?? false]), [[words, false]], 'its entry');
}

test("Undo's or Erase's Stop while a conversation opens, with a wake waiting for it in the queue: its reminder is shown at the Stop, silently, and the next start shows nothing", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, asleep]], { halves: true, voice: { mode: 'on' } });
  const cards = raw(k);
  const tool = gates(k.agent.kokoro);
  k.agent.send('What is near?');
  await until(() => tool.calls === 1);
  k.agent.wake(fired());
  await settled(); // queued behind her turn, held
  const slow = slowOpen(k);
  slow.shut();
  const opening = k.agent.open(k.trip); // her turn is halted, the wake waits on, and the open waits on its first read of the log
  await until(() => slow.held() && !k.agent.kokoro.turning);
  k.agent.stopKokoro();
  await idleAtOnce({ agent: k.agent.kokoro }); // the entry is written (the open itself still waits)
  await shownSilently(k, cards, k.trip);
  slow.open();
  await opening;
  await idleAtOnce(k);
  assert.deepEqual(reminders(cards), [LEAVE], 'and not again when the open is done');
  const next = await nextStart(k, true);
  assert.deepEqual(reminders(next.cards), [], 'nothing late');
  assert.deepEqual(await entries(k), [LEAVE]);
});

// A cue (a place, the road) is hers to say or let pass, held by no one and owed only until a model has it: one the Stop drops will be had by no model, so it is
// shown, as a wake that failed before a turn (wakeFailed) or a turn that ends unanswered (#showOwed) shows its own.
test("Undo's or Erase's Stop while a conversation opens, with a cue's wake (a place) waiting for it in the queue: the cue is shown at the Stop, silently, as no model will say it", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [linger] }, asleep]], { halves: true, voice: { mode: 'on' } });
  const cards = raw(k);
  const tool = gates(k.agent.kokoro);
  k.agent.send('What is near?');
  await until(() => tool.calls === 1);
  k.agent.wake({ kind: 'trigger', text: 'You are near Bixby Bridge.', fallbacks: [{ watch: 'w2', text: 'Bixby Bridge is near', cue: true }] });
  await settled(); // queued behind her turn; nothing is held for a cue
  const slow = slowOpen(k);
  slow.shut();
  const opening = k.agent.open(k.trip);
  await until(() => slow.held() && !k.agent.kokoro.turning);
  k.agent.stopKokoro();
  await idleAtOnce({ agent: k.agent.kokoro });
  await shownSilently(k, cards, k.trip, 'Bixby Bridge is near');
  slow.open();
  await opening;
  await idleAtOnce(k);
  assert.deepEqual(reminders(cards), ['Bixby Bridge is near'], 'and not again when the open is done');
});

test("the sign's Stop while housekeeping runs, with a wake waiting behind it in the queue: its reminder is shown at the Stop, silently, and the next start shows nothing", async (t) => {
  useClock(t);
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  let asked = false;
  let summarizing = false;
  const k = await agentKit([[say('One.'), say('Two.'), say('Three.'), { text: 'They said three things.' }]], {
    halves: true, voice: { mode: 'on' },
    hold: async () => { if (summarizing) { asked = true; await gate; } }, // the summary's call waits for the test
  });
  const cards = raw(k);
  for (const words of ['One', 'Two', 'Three']) {
    k.agent.send(words);
    await idleAtOnce(k);
  }
  summarizing = true;
  const summary = k.agent.summarizeNow();
  await until(() => asked);
  k.agent.wake(fired());
  await settled(); // behind the housekeeping, held
  assert.deepEqual(await heldIn(k), [LEAVE]);
  k.agent.stopKokoro();
  release();
  await idleAtOnce(k);
  assert.equal(await summary, 'stopped');
  await shownSilently(k, cards, k.trip);
  const next = await nextStart(k, true);
  assert.deepEqual(reminders(next.cards), [], 'nothing late');
  assert.deepEqual(await entries(k), [LEAVE]);
});

// The Stop of a turn still gathering the user's messages (one Shiori, or Kokoro's: #stopGathered): what waited is written down as stopped, and its reminder is
// shown at the Stop, silently, once. Held until then, nothing else would show it in this page (its page mark hides it from this page's open).
for (const [mode, o] of MODES) {
  test(`the Stop of a turn gathering the user's messages, with a watch's wake queued behind it: its reminder is shown at the Stop, silently, once, and the next start shows nothing${mode}`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], { ...o, voice: { mode: 'on' }, agent: { secondMs: 1000 } }); // a typing box held open for 5 s of the test's own clock
    const cards = raw(k);
    k.agent.typing(true);
    k.agent.send('What is near?');
    await settled();
    k.agent.wake(fired());
    await settled(); // queued behind the gather, held
    assert.deepEqual(await heldIn(k), [LEAVE]);
    (k.agent.stopKokoro ?? k.agent.interrupt).call(k.agent);
    await idleAtOnce(k);
    await shownSilently(k, cards, k.trip);
    assert.deepEqual((await k.events(['error'])).map((/** @type {any} */ e) => e.data.kind), ['stopped'], 'what waited is written down as stopped');
    k.agent.typing(false);
    const next = await nextStart(k, o.halves);
    assert.deepEqual(reminders(next.cards), [], 'nothing late');
    assert.deepEqual(await entries(k), [LEAVE]);
  });
}

// What the user typed while her turn was busy, still queued when the conversation opens again (a turn halted, no turn started), is kept by a Stop (Undo's or
// Erase's) as a gathering turn's is (spec §6.7: what they sent meanwhile is kept; nothing answers it): written down as stopped. Without the Stop, the open's end
// starts her turn on it.
for (const [what, stop] of /** @type {[string, boolean][]} */ ([["Undo's or Erase's Stop", true], ['no Stop (the control)', false]])) {
  test(`a line typed behind her running turn, which a conversation opening halts, then ${what}: ${stop ? 'it is written down as stopped, and nothing answers it' : 'it is written and answered'}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [linger] }, say('It is open until five.'), asleep]], { halves: true });
    const tool = gates(k.agent.kokoro);
    k.agent.send('What is near?');
    await until(() => tool.calls === 1);
    k.agent.send('Is the temple open?', { typed: true });
    k.agent.kokoro.enqueue({ kind: 'halves', text: "Koe can't speak right now; talk to the user directly.", logged: true }); // annai's own notice, logged where it came from
    await settled(); // both queued behind her turn, which is stuck in its tool
    const slow = slowOpen(k);
    slow.shut();
    const opening = k.agent.open(k.trip); // her turn is halted, the line waits on, and the open waits on its first read of the log
    await until(() => slow.held() && !k.agent.kokoro.turning);
    const log = async (/** @type {string[]} */ types) => (await k.events(types)).map((/** @type {any} */ e) => e.data.text ?? e.data.kind);
    if (stop) {
      k.agent.stopKokoro();
      await idleAtOnce({ agent: k.agent.kokoro });
      assert.deepEqual(await log(['error']), ['stopped'], "written by the time idle() returns, which is what Undo waits on (talk.js's settled)");
    }
    slow.open();
    await opening;
    await idleAtOnce(k);
    assert.deepEqual(await log(['msg.user']), ['What is near?', 'Is the temple open?'], 'written');
    assert.deepEqual(await log(['error']), stop ? ['stopped'] : [], 'and stopped, with the Stop');
    if (stop) assert.deepEqual((await k.events(['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons.map((/** @type {any} */ r) => r.kind)), ['user', 'user'], "annai's own notice is dropped, not written as a reason");
    assert.equal(k.requests.length, stop ? 1 : 2, stop ? 'no model was asked for it' : 'her turn took it up');
    assert.deepEqual(await log(['out.speak']), stop ? [] : ['It is open until five.']);
  });
}

// Once Koe has had a conversation open in this page, an open of another skips the halves' route (Halves.open), so with Koe since off, a line typed while that
// one opens is in Kokoro's queue for it while the one being left is still open: a Stop then (Undo's or Erase's) writes the line and its "stopped" into the
// conversation it was typed for, never the one being left (the code re-read's F1), and the open's transcript has the line, whether the Stop lands before
// the open reads the log (its read has it) or after (the open takes it in as a late entry: #logIn; the Stop wrote through `#keptIn`, which doesn't
// put a line into the transcript of a conversation being opened: the review's F-A).
for (const [when, late] of /** @type {[string, boolean][]} */ ([['before the open has read the log', false], ['after the open has read the log', true]])) {
  test(`Koe on, then off, another conversation opening, a line typed, then Undo's or Erase's Stop ${when}: the line and its stopped are written in the conversation it was typed for, and its transcript has the line`, async (t) => {
    useClock(t);
    const k = await agentKit([[asleep]], { koe: { type: [asleep] } });
    await idleAtOnce(k);
    assert.equal(k.agent.koe.target, k.trip, 'Koe has had this conversation open');
    await saveRoles(k.ws, { ...(await readConfig(k.ws)).roles, 'koe-classic': { models: [], level: 'off' } });
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    // The open waits at its first read of the log, or, after it, at the card of a reminder the log still owes (a reminder shown is a first call to the store).
    const slow = slowOpen(k);
    const card = holdReminders(k, k.agent.kokoro);
    if (late) await record(k.store, other, { type: 'wake', actor: 'system', data: { id: 'w-old', reasons: [], reminders: [{ watch: 'train', text: TRAIN }] } });
    else slow.shut();
    const opening = k.agent.open(other);
    await until(() => (late ? card.reached() : slow.held()));
    k.agent.send('Is the temple open?', { typed: true });
    await settled(); // in Kokoro's queue, for the conversation being opened
    assert.equal(k.agent.kokoro.scope, k.trip, 'the one being left is still open: Kokoro waits on its first read of the other');
    k.agent.stopKokoro();
    await idleAtOnce({ agent: k.agent.kokoro });
    const log = async (/** @type {string} */ scope, /** @type {string} */ type) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: [type] }))).map((/** @type {any} */ e) => e.data.text ?? e.data.kind);
    assert.deepEqual([await log(other, 'msg.user'), await log(other, 'error')], [['Is the temple open?'], ['stopped']], 'in the conversation it was typed for');
    assert.deepEqual([await log(k.trip, 'msg.user'), await log(k.trip, 'error')], [[], []], 'nothing in the one being left');
    slow.open();
    card.open();
    await opening;
    await idleAtOnce(k);
    assert.equal(k.agent.kokoro.scope, other, 'the open is done');
    const said = JSON.stringify(k.agent.kokoro.transcript.messages).split('Is the temple open?').length - 1;
    assert.equal(said, 1, "Kokoro's transcript of the conversation has the line, once");
    assert.deepEqual(await log(other, 'msg.user'), ['Is the temple open?'], 'written once');
    assert.equal(k.requests.length, 0, 'nothing answers it');
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
  assert.deepEqual(reminders(next.kokoro), [LEAVE], "Kokoro's half shows it");
  assert.deepEqual(reminders(next.cards), [LEAVE], "and Koe's shows none");
  assert.deepEqual(await entries(k), [LEAVE]);
  const again = await nextStart(k, true);
  assert.deepEqual(reminders(again.cards), []);
});

// Both halves carry one page mark: Koe's copy is this page's too, so Kokoro's open of the same conversation in the same page leaves it to Koe's own turn
// (given Koe its own id, the open showed it as another page's, and Koe's turn then showed it again).
test("Koe on a chat model holds a queued reminder, and the same page opens the conversation again: Koe's turn shows it once, Kokoro's open leaves it", async (t) => {
  useClock(t);
  const k = await agentKit([[asleep, asleep, asleep]], { koe: { type: [{ toolCalls: [linger] }, asleep, asleep] } });
  const cards = raw(k);
  const tool = gates(k.agent.koe);
  k.agent.send('What is near?');
  await until(() => tool.calls === 1);
  k.agent.wake(fired());
  await settled();
  await k.agent.open(k.trip); // the same page: Koe's turn is halted, its queue still holds the wake
  await idleAtOnce(k);
  assert.deepEqual(await entries(k), [LEAVE], 'one entry');
  assert.deepEqual(reminders(cards), [LEAVE], 'one card');
});

// The read, from logs written by hand: what settles a reminder a page held.
const R = { watch: 'w1', text: LEAVE };
const PAGE = 'p-dead';
/** @param {string} type @param {Record<string, any>} data @param {string} [actor] */
const ev = (type, data, actor = 'shiori') => ({ type, actor, data });
const held = () => ev('reminder.held', { reminders: [R], page: PAGE }, 'system');
const carried = (/** @type {Record<string, any>} */ more = {}) => ev('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'Fired.' }], reminders: [R], ...more }, 'system');
const line = (/** @type {Record<string, any>} */ more = {}) => ev('out.speak', { id: 's1', wake: 'w-0', text: 'Here is what I found.', ...more });
/** Koe's live session's word that it passed these on (LiveKoe#passed). @param {any[]} [reminders] */
const told = (reminders = [R]) => ev('reminder.told', { reminders }, 'system');
const URGENT = { watch: 'w2', text: TRAIN };
for (const [what, log, owed] of /** @type {[string, any[], any[]][]} */ ([
  ['held, with the page that held it', [held()], [{ ...R, held: PAGE }]],
  ['a line of hers after it does not settle it: no turn had it', [held(), line()], [{ ...R, held: PAGE }]],
  ['nor does a line of Koe\'s', [held(), line({ half: 'koe' })], [{ ...R, held: PAGE }]],
  ['its entry settles it', [held(), ev('reminder', { ...R, waiting: true }, 'system')], []],
  ['the record of the turn that takes it carries it from there, and her line after that settles it', [held(), line(), carried(), line()], []],
  ['taken by the turn, before her line', [held(), carried()], [R]],
  ["taken by a turn of Koe's (a text Koe's), then Kokoro's line: Koe still owes it", [held(), carried({ meanwhile: true, reasons: [], half: 'koe' }), line({ half: 'kokoro' })], [{ ...R }]],
  ["taken by a turn of Koe's, then Koe's line settles it", [held(), carried({ meanwhile: true, reasons: [], half: 'koe' }), line({ half: 'koe' })], []],
  ['held again after the turn took it (a second firing): held, so no line settles it', [carried(), held(), line()], [{ ...R, held: PAGE }]],
  ['passes over what is not a reminder, and a record with no list', [ev('reminder.held', { reminders: [null, { watch: 'w2' }, 'text', R], page: PAGE }, 'system'), ev('reminder.held', { page: PAGE }, 'system')], [{ ...R, held: PAGE }]],
  ['a record with no page is held by none', [ev('reminder.held', { reminders: [R] }, 'system')], [{ ...R, held: '' }]],
  ['held twice (a hand-on holds it again), by two pages: one copy, the newer one', [ev('reminder.held', { reminders: [R], page: 'p-older' }, 'system'), held()], [{ ...R, held: PAGE }]],
  ["Koe's live session's word that it passed it on (reminder.told) settles it, by watch and words", [held(), told()], []],
  ['and is never owed itself', [told()], []],
  ["it settles only what it names: another watch's held copy stays owed", [held(), told([URGENT])], [{ ...R, held: PAGE }]],
  ["it settles a copy a turn's record carries too, as an entry does", [carried(), told()], []],
  ['held again after it was told (a second firing): owed again', [held(), told(), held()], [{ ...R, held: PAGE }]],
  ["an urgent reminder held as Koe's live line for an earlier one ends (her quiet tail): that whole line, written after it, settles nothing", [ev('reminder.held', { reminders: [URGENT], page: PAGE }, 'system'), line({ half: 'koe', live: true })], [{ ...URGENT, held: PAGE }]],
  ["an old log's record of Koe's live session (its wake, with page, before reminder.told) reads by the plain rule: Kokoro's line leaves it owed, to every page", [carried({ meanwhile: true, reasons: [], half: 'koe', page: PAGE }), line({ half: 'kokoro' })], [R]],
  ["and Koe's line settles it", [carried({ meanwhile: true, reasons: [], half: 'koe', page: PAGE }), line({ half: 'koe' })], []],
  ["a cut line of a text Koe's (no live session) still settles what Koe took, as before", [carried({ half: 'koe' }), line({ half: 'koe', cut: true })], []],
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
/** The recap the traveller asked to hear aloud: a wake with no reminders, which Kokoro is not given while a session can take it. */
const RECAP = { kind: 'recap', aloud: true, text: 'Tell the recap of this trip, aloud.' };

test('Koe live: the session has the reminder and is still saying it as the page is killed: the next start shows it once, by Kokoro\'s half', async () => {
  // Her answer plays for 20 s at the server's own pace: the next page starts while it does (the first is not frozen: its session goes on), before her line is written.
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(20) }], { pace: 1 });
  try {
    await k.voice.unlock(); // an earlier tap
    await k.agent.wake(train());
    await soon(async () => texts(k).length === 1);
    await until(() => k.platform.streams.length === 1, 30_000);
    assert.deepEqual(await k.events(['out.speak']), [], 'her line is not written yet');
    assert.deepEqual((await k.events(['reminder.held'])).map((/** @type {any} */ e) => e.data.reminders), [[{ watch: 'train', text: TRAIN }]], 'held as it was handed to the session');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.kokoro), [TRAIN], "Kokoro's half shows it");
    assert.deepEqual(reminders(next.cards), [TRAIN], "and Koe's shows none");
    assert.deepEqual(await entries(k), [TRAIN]);
  } finally {
    await k.done();
  }
});

test("Koe live: the reminder has gone into the session, and the same page opens the conversation again before Koe says it: the open shows nothing, Koe says it once", async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(2) }], { pace: 1 });
  try {
    await k.voice.unlock();
    await k.agent.wake(train());
    await soon(async () => texts(k).length === 1); // the session has it, held in this page's name
    await until(() => k.platform.streams.length === 1, 30_000); // Koe is saying it
    await inTime(k.agent.open(k.trip), 'the open did not finish'); // carryOn's, Undo's: the same conversation, the same page
    assert.deepEqual(reminders(k.notices), [], "annai shows nothing: Koe is saying it (a second show would be annai's card over Koe's words)");
    assert.deepEqual(await k.events(['reminder']), [], 'and writes no entry');
    assert.equal(texts(k).length, 1, 'the session was given it once');
    await soon(async () => (await k.events(['out.speak'])).length === 1); // Koe says it, once
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Your train leaves in twenty minutes, from platform 4.']);
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [], 'still nothing of annai\'s own');
    assert.deepEqual(await k.events(['reminder']), []);
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
    await idleAtOnce(k);
    assert.deepEqual(await k.events(['reminder']), [], 'annai showed nothing: Koe said it');
    assert.deepEqual((await k.events(['reminder.told'])).map((/** @type {any} */ e) => e.data.reminders), [[{ watch: 'train', text: TRAIN }]], 'the session wrote that it passed it on');
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
    await idleAtOnce(k);
    assert.equal(k.server.connections().length, 0, 'out of view: no session opened, the reminder waits for the page to be back');
    assert.deepEqual(await k.events(['reminder']), [], 'nor did annai show it');
    hidden(false); // the next start is in view: the first page died out of view, the next one is opened by the traveller
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [TRAIN]);
    assert.deepEqual(await entries(k), [TRAIN]);
  } finally {
    hidden(false);
    await k.done();
  }
});

// The page goes out of view (or reloads) while Koe is saying the reminder, and iOS kills it later (hide first, kill later): Koe's line is written cut (✂), and
// the session still owes the reminder (it waits for the page to be back). No line settles the held copy; the session writes `reminder.told` only as it passes
// the reminder on (#passes), which a cut line never does, so the next start shows it. The page that comes back says it whole instead, and its told settles it.
const said = 'Your train leaves in twenty minutes, from platform 4.';
/** Koe is saying the reminder, in real time, and some of it is heard. @param {any} k */
async function sayingIt(k) {
  k.platform.streamSpeed = 1; // her sound plays in real time, so some of it is heard when the page goes
  await k.voice.unlock();
  await k.agent.wake(train());
  await soon(async () => texts(k).length === 1);
  await until(() => k.platform.streams.length === 1, 30_000);
  await new Promise((r) => setTimeout(r, 1000)); // an eighth of her 8 s is heard
}

test('Koe live: the page goes out of view while Koe is saying the reminder, and is killed later: the cut line settles nothing, so the next start shows it once', async () => {
  const k = await liveKit([{ said, audio: tone(8) }], { pace: 1 });
  try {
    await sayingIt(k);
    k.agent.hush('away'); // out of view mid-sentence (a reload does the same at pagehide)
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    const [line] = await k.events(['out.speak']);
    assert.equal(line.data.cut, true, 'her line is cut');
    assert.match(line.data.text, /✂$/);
    assert.deepEqual(await k.events(['reminder']), [], 'annai showed nothing: the page keeps it for when it is back');
    const next = await nextStart(k, true);
    assert.deepEqual(await k.events(['reminder.told']), [], 'the session never passed it on');
    assert.deepEqual(reminders(next.cards), [TRAIN], "Koe's cut line settled nothing");
    assert.deepEqual(await entries(k), [TRAIN]);
    const again = await nextStart(k, true);
    assert.deepEqual(reminders(again.cards), [], 'its entry settled it');
  } finally {
    await k.done();
  }
});

test('Koe live: the page goes out of view mid-sentence and comes back before it is killed: Koe says it whole in the session that opens, and the next start shows nothing', async () => {
  const k = await liveKit([{ said, audio: tone(8) }, { said, audio: tone(0.3) }], { pace: 1 });
  try {
    await sayingIt(k);
    k.agent.hush('away');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.shown(); // the page is back in view: the session that opens is given the reminder again
    await soon(async () => (await k.events(['out.speak'])).length === 2, 30_000);
    const [cut, whole] = await k.events(['out.speak']);
    assert.equal(cut.data.cut, true);
    assert.notEqual(whole.data.cut, true, 'said whole the second time');
    assert.equal(whole.data.text, said);
    await idleAtOnce(k);
    assert.deepEqual(await k.events(['reminder']), [], 'annai showed nothing');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [], "the session's word that it passed it on settled it");
    assert.deepEqual(await entries(k), []);
  } finally {
    await k.done();
  }
});

test("Koe live: the session closes (quiet) while Koe is saying the reminder: it is handed on and shown once, the same page's open shows nothing more, and nor does the next start", async () => {
  const k = await liveKit([{ said, audio: tone(8) }], { pace: 1 });
  try {
    await sayingIt(k);
    k.agent.live.close('quiet');
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [TRAIN], 'shown at the hand-on, once');
    await inTime(k.agent.open(k.trip), 'the open did not finish');
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [TRAIN], 'the same page opening again shows nothing more');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [], 'its entry settled it');
    assert.deepEqual(await entries(k), [TRAIN]);
  } finally {
    await k.done();
  }
});

// The session passes a reminder on only by its own rule (#passes), and says so itself (`reminder.told`): a line of hers that was no answer to it settles
// nothing. A line before a lookup she speaks after ("Let me look.", the reply goes on: real Gemini says "Checking your notes." and goes on 2.4 to 7.2 s later),
// then the page goes out of view during what she says after it and is killed later: the next start shows it. Never out of view, her line after the lookup passes
// it on, and the session's word, written before that line, settles it.
const LOOK = { said: 'Let me look.', audio: tone(0.3), tool: { name: 'list', args: { path: '/trip/' } }, andThen: true };
// A wake for the open conversation whose landing in the live session waits (on Koe's own open, or on the connection) when another conversation opens:
// it is never given to the session there, which would say it in the conversation opened; its reminder is shown in its own, whose entry settles what was held
// (#live, as Halves.wake checks where its route ends). annai's live tests keep the real clock: the stand-in server and its socket answer in real time.
for (const opens of [true, false]) {
  test(`Koe live: a watch's wake waiting for Koe's own open ${opens ? 'when another conversation opens: its reminder is shown in its own conversation, never given to the session there, and the next start that opens its own shows nothing more' : 'and no other conversation opens (the control): the session gets it, in its own conversation, as before'}`, async () => {
    const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(1) }], { pace: 1 });
    try {
      await k.voice.unlock();
      const cards = raw(k); // each half's own: Halves' list drops a card identical to the one before it
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      const koeOpen = holdKoeOpen(k); // Koe's open is under way, as at a start
      k.agent.wake(train());
      await until(koeOpen.reached, 30_000); // #live is waiting on it
      assert.deepEqual(await heldIn(k), [TRAIN], 'held in its own conversation as it came');
      assert.equal(texts(k).length, 0, 'Koe has not got it: its open is under way');
      const opening = opens ? k.agent.open(other) : Promise.resolve();
      koeOpen.open();
      await inTime(opening, 'the open did not finish', 5000);
      if (!opens) {
        await soon(async () => texts(k).length === 1);
        await soon(async () => (await k.events(['out.speak'])).length === 1);
        await idleAtOnce(k);
        assert.deepEqual(reminders(cards), [], 'Koe says it: annai shows nothing');
        assert.deepEqual(await entries(k), []);
        const next = await nextStart(k, true);
        assert.deepEqual(reminders(next.cards), []);
        return;
      }
      await soon(async () => reminders(cards).length > 0 || texts(k).length > 0); // annai shows it, or the session is given it, wherever
      await idleAtOnce(k);
      assert.deepEqual(reminders(cards), [TRAIN], 'shown now, once');
      assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes(TRAIN)), [TRAIN], 'said once');
      assert.deepEqual(await entries(k), [TRAIN], 'its entry, in its own conversation');
      assert.deepEqual(await entries(k, other), [], 'none in the one opened');
      assert.equal(texts(k).length, 0, 'the session was never given it');
      assert.deepEqual([await recordsIn(k, other, 'wake'), await recordsIn(k, other, 'out.speak')], [[], []], 'nothing of it told, or answered, in the one opened');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'the next start that opens its own shows nothing more');
      assert.deepEqual(await entries(k), [TRAIN], 'and writes no second entry');
    } finally {
      await k.done();
    }
  });
}

// Kokoro is not given a wake asked to be heard (the recap told aloud): the session alone has it, so when the conversation it was asked in is left while Koe's
// open is awaited, Kokoro writes it into its own conversation, and the session never gets it there.
test("Koe live: the recap asked to be told aloud, waiting for Koe's own open when another conversation opens: written into its own conversation, never given to the session there", async () => {
  const k = await liveKit([{ said: 'Here is where you went.', audio: tone(1) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const koeOpen = holdKoeOpen(k);
    k.agent.wake({ kind: 'recap', aloud: true, text: 'Tell the recap of this trip, aloud.' });
    await until(koeOpen.reached, 30_000); // #live is waiting on it
    const opening = k.agent.open(other);
    koeOpen.open();
    await inTime(opening, 'the open did not finish', 5000);
    await soon(async () => JSON.stringify(await recordsIn(k, k.trip, 'wake')).includes('Tell the recap') || texts(k).length > 0);
    await idleAtOnce(k);
    assert.equal(JSON.stringify(await recordsIn(k, k.trip, 'wake')).includes('Tell the recap'), true, 'written into its own conversation');
    assert.deepEqual([await recordsIn(k, other, 'wake'), await recordsIn(k, other, 'out.speak')], [[], []], 'nothing of it in the one opened');
    assert.equal(texts(k).length, 0, 'the session never got it');
  } finally {
    await k.done();
  }
});

// The wake is with the session, whose connection is slow, when another conversation opens, and the live model then rests (the test benches it as the switch
// abandons the connection, the state a refused connection leaves), so Koe's own list answers as text: the wake is not queued for Koe in the conversation opened; #live asks after the
// refresh that finds it so (#elsewhere), and shows the reminder in its own.
test("Koe live: an urgent watch's wake while the session is connecting when another conversation opens and the live model then rests: its reminder is shown in its own conversation, and Koe's text turn never takes it in the one opened", async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(1) }], { pace: 1, koe: { type: [asleep] } });
  try {
    await k.voice.unlock();
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const cards = raw(k);
    /** @type {() => void} */
    let open = () => {};
    const door = new Promise((r) => { open = () => r(undefined); });
    const live = k.llm.live.bind(k.llm);
    let reached = false;
    k.llm.live = async (/** @type {any} */ ...a) => { reached = true; await door; return /** @type {any} */ (live)(...a); };
    k.agent.wake({ ...train(), urgent: true });
    await until(() => reached, 30_000);
    const opening = k.agent.open(other);
    await settled();
    k.llm.bench.bench('m-live', 60_000); // the live model rests, as when its connection fails, and the refresh finds Koe's text list
    open();
    await inTime(opening, 'the open did not finish', 5000);
    await soon(async () => reminders(cards).length > 0 || (await recordsIn(k, other, 'wake')).length > 0);
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(reminders(cards), [TRAIN], 'shown now, once');
    assert.deepEqual([await entries(k), await entries(k, other)], [[TRAIN], []], 'its entry in its own conversation, none in the one opened');
    assert.deepEqual([await recordsIn(k, other, 'wake'), await recordsIn(k, other, 'out.speak')], [[], []], 'nothing of it told, or answered, in the one opened');
    assert.equal(k.sent['model-koe'], undefined, "Koe's chat model got no request: its text turn never took it in the one opened");
  } finally {
    await k.done();
  }
});

// The first live model refuses and the second is connecting when another conversation opens (a wait after #live's refresh): #live asks again after that wait
// too (#elsewhere), and shows the reminder in the wake's own conversation.
test("Koe live: an urgent watch's wake whose first live model refused and whose second is connecting when another conversation opens: its reminder is shown in its own conversation, once", async () => {
  const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(1) }], { pace: 1, live: { second: true } });
  try {
    await k.voice.unlock();
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const cards = raw(k);
    /** @type {() => void} */
    let first = () => {};
    /** @type {() => void} */
    let second = () => {};
    const doors = [new Promise((r) => { first = () => r(undefined); }), new Promise((r) => { second = () => r(undefined); })];
    const live = k.llm.live.bind(k.llm);
    let reached = '';
    k.llm.live = async (/** @type {string} */ id, /** @type {any} */ ...rest) => {
      reached = id;
      if (id === 'm-live') {
        await doors[0];
        throw new Error('the connection was refused');
      }
      await doors[1];
      return /** @type {any} */ (live)(id, ...rest);
    };
    k.agent.wake({ ...train(), urgent: true });
    await until(() => reached === 'm-live', 30_000);
    first();
    await until(() => reached === 'm-live2', 30_000); // the refresh found the second model, which the wake now waits on
    const opening = k.agent.open(other);
    await settled();
    second();
    await inTime(opening, 'the open did not finish', 5000);
    await soon(async () => reminders(cards).length > 0 || (await entries(k, other)).length > 0);
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(reminders(cards), [TRAIN], 'shown now, once');
    assert.deepEqual([await entries(k), await entries(k, other)], [[TRAIN], []], 'its entry in its own conversation, none in the one opened');
    assert.equal(texts(k).length, 0, 'the session never got it');
  } finally {
    await k.done();
  }
});

// The wake is with the session, whose connection is slow, when another conversation opens: the switch closes the session, which can't take it, and #live
// (#elsewhere, after its refresh) shows the reminder in its own conversation. The close lets go of what #live waits to place before it hands anything on
// (live.js #go), so the close writes no silent copy of its own: one entry in the conversation left, said once (on 4fb14e7d2 a wake that was not urgent had two
// there, the approved entry "A reminder can be written twice into its conversation when a switch lands while the live session connects", which this closes).
// An urgent wake goes through #now, which never queues it for a close to hand on: it was one entry on 4fb14e7d2 too (the control). The one opened has none.
for (const urgent of [true, false]) {
  test(`Koe live: ${urgent ? 'an urgent' : 'a'} watch's wake while the session is connecting when another conversation opens: its reminder is shown in its own conversation, once, said once, and never in the one opened, and the next start that opens its own shows nothing more`, async () => {
    const k = await liveKit([{ said: 'Your train leaves in twenty minutes, from platform 4.', audio: tone(1) }], { pace: 1 });
    try {
      await k.voice.unlock();
      const cards = raw(k); // each half's own: Halves' list drops a card identical to the one before it
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      const conn = slowConnection(k);
      k.agent.wake({ ...train(), ...(urgent ? { urgent: true } : {}) });
      await until(conn.reached, 30_000);
      const opening = k.agent.open(other);
      await settled();
      conn.open();
      await inTime(opening, 'the open did not finish', 5000);
      await soon(async () => reminders(cards).length >= 1); // wherever they are shown
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await entries(k), [TRAIN], 'its entry, in its own conversation, once');
      assert.deepEqual(await entries(k, other), [], 'none in the one opened');
      assert.deepEqual(reminders(cards), [TRAIN], 'shown once');
      assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes(TRAIN)), [TRAIN], 'said once');
      assert.deepEqual([await recordsIn(k, other, 'wake'), await recordsIn(k, other, 'out.speak')], [[], []], 'nothing of it told, or answered, in the one opened');
      assert.equal(texts(k).length, 0, 'the session never got it');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'the next start that opens its own shows nothing more');
      assert.deepEqual(await entries(k), [TRAIN], 'and writes no entry');
    } finally {
      await k.done();
    }
  });
}

/**
 * The live model's connection, held until open() lets it go (a slow connection): reached() says the session is connecting. @param {any} k
 * @returns {{ reached: () => boolean, open: () => void }}
 */
function slowConnection(k) {
  /** @type {() => void} */
  let open = () => {};
  const door = new Promise((r) => { open = () => r(undefined); });
  const live = k.llm.live.bind(k.llm);
  let reached = false;
  k.llm.live = async (/** @type {any} */ ...a) => { reached = true; await door; return /** @type {any} */ (live)(...a); };
  return { reached: () => reached, open };
}

/**
 * The microphone's start held until open() lets it go (a phone slow to start it): asked() says the session asked for it. @param {any} k
 * @returns {{ asked: () => boolean, open: () => void }}
 */
function slowMic(k) {
  /** @type {() => void} */
  let open = () => {};
  const door = new Promise((r) => { open = () => r(undefined); });
  const real = k.platform.mic.open;
  let asked = false;
  k.platform.mic.open = async (/** @type {any} */ o) => { asked = true; await door; return real(o); };
  return { asked: () => asked, open };
}

/**
 * Voice goes off (the chip, or auto mode as the car stops), which closes the session that is connecting; with other, the traveller opens that conversation
 * right after the close, before anything the close set going has run (a tap during the refreshes that follow it, which read the phone's store). @param {any} k
 * @param {string} [other] @returns {Promise<{ opening: Promise<void> | undefined }>}
 */
async function voiceOff(k, other) {
  const at = { opening: /** @type {Promise<void> | undefined} */ (undefined) };
  const close = k.agent.live.close.bind(k.agent.live);
  k.agent.live.close = (/** @type {string} */ why, /** @type {any} */ o) => {
    close(why, o);
    if (other && why === 'voice off' && !at.opening) at.opening = k.agent.open(other);
  };
  await k.voice.choose('off');
  if (other) await until(() => at.opening !== undefined, 30_000);
  return at;
}

/** Koe's (chat) wake records in a conversation that carry these words (a wake's reminders). @param {any} k @param {string} scope @param {string} words */
const koeWokeIn = async (k, scope, words) => (await recordsIn(k, scope, 'wake')).filter((/** @type {any} */ e) => e.data?.half === 'koe' && JSON.stringify(e.data).includes(words)).length;
/** The requests Koe's chat model got that carry these words. @param {any} k @param {string} words */
const koeAsked = (k, words) => (k.sent['model-koe'] ?? []).filter((/** @type {any} */ r) => JSON.stringify(r).includes(words)).length;

// Voice goes off while the session is connecting with a watch's wake (the deferred entry "Voice going off while the live session connects can give a reminder
// twice, or a note of Kokoro's to the conversation opened"): the close lets go of the wake #live waits to place, and #live places it once, after its refresh:
// Koe · Chat gets it (one turn, one entry when she sleeps on it), or, with no Koe model, annai shows it. On 4fb14e7d2 the close handed the session's copy on
// as well (#handOn): two Koe turns and two entries, or two entries.
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  test(`Koe live: a watch's wake with the session connecting when voice goes off: it is placed once, in its own conversation${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      const conn = slowConnection(k);
      k.agent.wake(train());
      await until(conn.reached, 30_000);
      await voiceOff(k);
      await soon(async () => (await entries(k)).length > 0);
      conn.open();
      await settled();
      await idleAtOnce(k);
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await entries(k), [TRAIN], 'one entry, in its own conversation');
      assert.deepEqual(reminders(cards), [TRAIN], 'one card');
      if (koe.koe) assert.equal(await koeWokeIn(k, k.trip, TRAIN), 1, 'Koe · Chat got it once');
      assert.equal(texts(k).length, 0, 'the session never got it');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'the next start shows nothing more');
    } finally {
      await k.done();
    }
  });
}

// The same, and the traveller opens another conversation just after voice went off (on 4fb14e7d2 both copies went to its own conversation: two entries there).
// #live alone places it, after its refresh (#elsewhere): shown once in its own conversation, nothing of it in the one opened.
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  test(`Koe live: a watch's wake with the session connecting when voice goes off and another conversation opens just after: its reminder is shown once, in its own conversation, and nothing of it in the one opened${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      const conn = slowConnection(k);
      k.agent.wake(train());
      await until(conn.reached, 30_000);
      const { opening } = await voiceOff(k, other);
      await inTime(/** @type {Promise<void>} */ (opening), 'the open did not finish', 5000);
      await soon(async () => reminders(cards).length > 0);
      conn.open();
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await entries(k), [TRAIN], 'one entry, in its own conversation');
      assert.deepEqual(reminders(cards), [TRAIN], 'one card');
      assert.deepEqual(await entries(k, other), [], 'none in the one opened');
      assert.deepEqual([await recordsIn(k, other, 'wake'), await recordsIn(k, other, 'out.speak')], [[], []], 'nothing of it told, or answered, in the one opened');
      assert.equal(texts(k).length, 0, 'the session never got it');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'the next start that opens its own shows nothing more');
    } finally {
      await k.done();
    }
  });
}

// A typed line and a watch's wake on one connecting session (voice-off-next's final review, F3, older than this build): as the connection opens, the typed line's
// session (no microphone) used to send the wake in while the wake's own wait was still for the microphone to start, and the typed line cut in on it, which showed it
// (a silent card and its entry); voice then went off before the microphone had started, the wake's wait ended with the close, and #live placed a second copy: two
// entries (on fea9ac9d9 and 4fb14e7d2). Now nothing waiting goes in until the microphone has started (#idle), so the close finds the wake still waiting and #live
// places it, once. The first assertion pins the gate: the typed line alone is in the session while the microphone starts (the outcome below is the same without it, the
// session's copy being cut and placed once). (#go's own check, that an item already out of its list is never placed again, is Start fresh's: the notes it shows itself, below.)
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  test(`Koe live: a typed line and a watch's wake on one connecting session, and voice goes off while the microphone starts: its reminder is shown once${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      const mic = slowMic(k);
      const conn = slowConnection(k);
      k.agent.send('Hello there');
      await until(conn.reached, 30_000);
      k.agent.wake(train());
      await until(() => k.agent.live.owing, 30_000);
      conn.open();
      await until(mic.asked, 30_000);
      await soon(async () => texts(k).length > 0); // the typed line is in
      await settled();
      assert.deepEqual(texts(k), ['[typed] Hello there'], 'the typed line alone: the wake waits for the microphone'); // what pins the gate: without it the wake goes in here too
      await voiceOff(k);
      await until(() => k.agent.live.state === 'closed', 30_000); // the close has come, with the microphone still starting
      mic.open();
      await settled();
      await idleAtOnce(k);
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await entries(k), [TRAIN], 'one entry');
      assert.deepEqual(reminders(cards), [TRAIN], 'one card');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'the next start shows nothing more');
    } finally {
      await k.done();
    }
  });
}

// The recap asked aloud on a typed line's connecting session (voice-off-next's re-review, Haiku src item 3: a regression against 4fb14e7d2): the typed line's session has
// no microphone, so it sent the recap in as it opened, while the recap's own wait was still for the microphone to start; voice going off, or the page going out of view,
// then closed the session in that window, which cut her answer to it, and nothing placed the recap again. Nothing waiting goes in while a part of Halves waits for the
// session to listen (#idle): the typed line goes in alone, the close lets go of the recap's wait, and Halves places it once (Koe · Chat has it, else Kokoro).
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  for (const [how, close] of /** @type {[string, (k: any) => unknown][]} */ ([['voice goes off', (k) => voiceOff(k)], ['the page goes out of view', (k) => k.agent.hush('away')]])) {
    test(`Koe live: the recap asked aloud on a typed line's connecting session, and ${how} while the microphone starts: the session never gets it, and it is placed once${mode}`, async () => {
      const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
      try {
        await k.voice.unlock();
        const mic = slowMic(k);
        const conn = slowConnection(k);
        k.agent.send('Hello there');
        await until(conn.reached, 30_000);
        k.agent.wake(RECAP);
        await settled();
        conn.open();
        await until(mic.asked, 30_000);
        await soon(async () => texts(k).length > 0); // the typed line is in
        await settled();
        assert.deepEqual(texts(k), ['[typed] Hello there'], 'the typed line alone: the recap waits for the microphone');
        await close(k);
        await until(() => k.agent.live.state === 'closed', 30_000); // the close has come, with the microphone still starting
        mic.open();
        await settled();
        await idleAtOnce(k);
        await settled();
        await idleAtOnce(k);
        assert.deepEqual(texts(k), ['[typed] Hello there'], 'the session never got it');
        assert.equal((await recordsIn(k, k.trip, 'wake')).filter((/** @type {any} */ e) => JSON.stringify(e.data).includes('Tell the recap')).length, 1, 'placed once: one wake carries it');
      } finally {
        await k.done();
      }
    });
  }
}

// A reminder waiting on the microphone's start while something runs #idle in that window (the re-review, Opus N1: `shown()`, or #heardFirst as the user's first turn
// after a tap ends): the reminder went into the session, and the page going out of view then put it back in its list (kept for the page's return) while #go's second
// look took it out again and placed it at once: said into a page going away, and not owed when the page was back. Nothing waiting goes in while a part of Halves waits
// for the session to listen, so the session is never given it; the close lets go of its wait and Halves places it once, as for any reminder a connecting session
// was to take (on 4fb14e7d2 too, which never sent it in: the same one copy).
test("Koe live: something runs #idle while a watch's wake waits for the microphone to start, and the page goes out of view: the session is never given the reminder, and it is shown once, nothing owed when the page is back", async () => {
  const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, koe: { type: [asleep, asleep, asleep] } });
  try {
    await k.voice.unlock();
    const cards = raw(k);
    const mic = slowMic(k);
    k.agent.wake(train());
    await until(mic.asked, 30_000);
    await k.agent.live.shown(); // what runs in that window: it would send what waits in
    await settled();
    assert.equal(texts(k).length, 0, 'the session was not given the reminder');
    hidden(true);
    k.agent.hush('away');
    await until(() => k.agent.live.state === 'closed', 30_000);
    mic.open();
    await settled();
    await idleAtOnce(k);
    assert.deepEqual([reminders(cards), await entries(k), k.agent.live.owing], [[TRAIN], [TRAIN], false], 'shown once, and nothing owed');
    hidden(false);
    await k.agent.shown();
    await settled();
    await idleAtOnce(k);
    assert.deepEqual([reminders(cards), await entries(k), texts(k).length], [[TRAIN], [TRAIN], 0], 'nothing more when the page is back');
  } finally {
    hidden(false);
    await k.done();
  }
});

// open() throws while a watch's wake waits on it (the re-review, Haiku src F; found with a read refused as the microphone starts, which no longer fails it, the
// tests of the reads below: the open is stubbed to throw, by no cause known now): the wake's failure shows its reminder (Kokoro's wakeFailed), and #go takes the
// reminder back from the list it waited in, so the session that opens later for a typed line is never given it as well. On 90e35a763 it stayed in the list, and
// that session said it a second time.
test("Koe live: open() throws while a watch's wake waits on it: its reminder is shown once, and a session that opens later is never given it", async () => {
  const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const cards = raw(k);
    const open = k.agent.live.open.bind(k.agent.live);
    k.agent.live.open = async () => { // the wake's wait finds the open failing, once
      k.agent.live.open = open;
      throw new Error('the open failed');
    };
    k.agent.wake(train());
    await soon(async () => reminders(cards).length > 0);
    await settled();
    k.agent.send('Hello there'); // a session opens for it, and what waits goes in with it
    await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')));
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(texts(k), ['[typed] Hello there'], 'the session was never given the reminder');
    assert.deepEqual(reminders(cards), [TRAIN], 'one card');
    assert.deepEqual(await entries(k), [TRAIN], 'one entry');
  } finally {
    await k.done();
  }
});

// The traveller's tap stops the session a first tap opened while a watch's wake waits on it (the review's second opinions, F8; the user's floor pick, "annai neither
// shows nor says anything of it at the tap", is older than this branch and the main session's own entry): the close for a tap lets go of nothing, so the wake's wait
// goes on until the connection attempt ends, as on 4fb14e7d2; on fea9ac9d9 annai showed (and said) it at the tap itself.
test("Koe live: a tap stops the session another tap opened while a watch's wake waits on it: nothing is said or shown at the tap, and once the attempt ends it is shown once", async () => {
  const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const cards = raw(k);
    const conn = slowConnection(k);
    k.agent.tap();
    await until(conn.reached, 30_000);
    k.agent.wake(train());
    await until(() => k.agent.live.owing, 30_000);
    assert.equal(k.agent.tap(), 'stopped');
    await until(() => k.agent.live.state === 'closed', 30_000);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([reminders(cards), await entries(k), k.said.filter((/** @type {string} */ x) => x.includes(TRAIN))], [[], [], []], 'nothing shown or said at the tap');
    conn.open(); // the attempt ends
    await soon(async () => (await entries(k)).length > 0);
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(await entries(k), [TRAIN], 'then one entry');
    assert.deepEqual(reminders(cards), [TRAIN], 'one card');
  } finally {
    await k.done();
  }
});

const ANSWER = 'The Bixby bridge viewpoint is open until ten tonight.';
/** The cards of Kokoro's answers annai shows, by their words. @param {any[]} cards */
const answers = (cards) => cards.filter((n) => n.title === "Shiori's answer").map((n) => n.body);
/** Kokoro tells Koe something for the user (tell_koe with for_user): logged in the conversation open, then given to Koe. @param {any} k */
const tellKoe = (k) => k.agent.channel.send('kokoro', ANSWER, 'append', 'tool', undefined, undefined, false, ANSWER);
/**
 * annai's entries in a conversation that carry the answer. A Koe turn or speech that has it is no entry of its own: the tests check those where they matter,
 * by what Koe's chat model was asked (koeAsked) and what was said (k.said). @param {any} k @param {string} scope
 */
const answerIn = async (k, scope) => (await entries(k, scope)).filter((/** @type {string} */ x) => x === ANSWER);

// open() throws while something of Kokoro's waits on it (the re-review of fix round 2, Opus P-a, Haiku F-A, F-B, F-D; found with a read refused as the session opens,
// which no longer fails it, the tests of the reads below: the open is stubbed to throw, by no cause known now): live.js #go takes what it waited with out of its list and rethrows, so no later session gets it, and what its route carried is placed by Halves' catch, which showed
// only the failure: a note of Kokoro's for the user is shown now (#backstop: "Shiori's answer", said with voice on, as when no session can take it), and the recap
// asked aloud, which Kokoro was never given, is Kokoro's (as #live hands it on when no session takes it). On 90639e58a the note's words were on no card and in no later
// session, and the recap was answered by no one (on 4fb14e7d2 and main both stayed owed and the next session got them). An immediate note (#now) never was in a list: the same.
/** The next open() of the live session throws, once. @param {any} k */
function refuseOpenOnce(k) {
  const open = k.agent.live.open.bind(k.agent.live);
  k.agent.live.open = async () => {
    k.agent.live.open = open;
    throw new Error('the open failed');
  };
}
/** The cards that say a route failed (Agent.notSaved). @param {any[]} cards */
const notSaved = (cards) => cards.filter((n) => n.title === "Something for Shiori wasn't saved").map((n) => n.body);
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  for (const [what, send] of /** @type {[string, (k: any) => unknown][]} */ ([
    ["a note of Kokoro's for the user", tellKoe],
    ["an immediate note of Kokoro's for the user", (k) => k.agent.channel.send('kokoro', ANSWER, 'immediate', 'tool', undefined, undefined, false, ANSWER)],
  ])) {
    test(`Koe live: open() throws while ${what} waits on it: its words are shown once and said, the failure is told, and a session that opens later is never given it${mode}`, async () => {
      const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
      try {
        await k.voice.unlock();
        const cards = raw(k);
        refuseOpenOnce(k);
        await send(k);
        await soon(async () => notSaved(cards).length > 0); // the failure is told, after its words are shown
        await settled();
        await idleAtOnce(k);
        k.agent.send('Hello there'); // a session opens for it, and what waits goes in with it
        await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')));
        await settled();
        await idleAtOnce(k);
        assert.deepEqual(texts(k), ['[typed] Hello there'], 'the session was never given it');
        assert.deepEqual(cards.map((n) => n.title).filter((x) => x === "Shiori's answer" || x === "Something for Shiori wasn't saved"), ["Shiori's answer", "Something for Shiori wasn't saved"], 'its words, then the failure');
        assert.deepEqual(answers(cards), [ANSWER], 'one card with its words');
        assert.deepEqual(notSaved(cards), ['the open failed'], 'and the failure told once');
        assert.deepEqual(await answerIn(k, k.trip), [ANSWER], 'one entry');
        assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes('Bixby')), [ANSWER], 'said once');
      } finally {
        await k.done();
      }
    });
  }

  test(`Koe live: open() throws while the recap asked aloud waits on it: Kokoro has it once, the failure is told, and a session that opens later is never given it${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      refuseOpenOnce(k);
      k.agent.wake(RECAP);
      await soon(async () => notSaved(cards).length > 0);
      await settled();
      await idleAtOnce(k);
      await settled();
      await idleAtOnce(k);
      k.agent.send('Hello there'); // a session opens for it, and what waits goes in with it
      await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')));
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(texts(k), ['[typed] Hello there'], 'the session was never given it');
      assert.deepEqual((await recordsIn(k, k.trip, 'wake')).filter((/** @type {any} */ e) => JSON.stringify(e.data).includes('Tell the recap')).map((/** @type {any} */ e) => e.data.half), ['kokoro'], "Kokoro's wake carries it, once");
      assert.deepEqual(notSaved(cards), ['the open failed'], 'the failure told once');
    } finally {
      await k.done();
    }
  });
}

// A read the phone refuses as a live session opens says nothing of the setting it reads, so the session opens with what it holds (the design check
// go-fail-design, (d)): the spend (#over, which the session's usage check asks again) and the settings in #start, the pause in #listen. What waited on it goes
// in once, as with no refusal: nothing for annai to place, and no "wasn't saved" card. On 7b995be58 open() threw at each of the three: a final text and
// "nothing to add" were said by no one, a watch's reminder, a note for the traveller and the recap were annai's with a failure card, a typed line was never
// answered, a tap's microphone never started, and a session refused at #start's read was left "opening" with its socket open.
/**
 * Refuses one of the live session's reads once: the spend's (its budgets'), the settings' in #start (the session opening) or the pause's in #listen (the
 * session open, its microphone starting). @param {any} k @param {'spend' | 'start' | 'listen'} read @returns {() => number} how many were refused
 */
function refuseRead(k, read) {
  let refused = 0;
  const live = k.agent.live;
  if (read === 'spend') {
    const budgets = live.c.budgets;
    live.c.budgets = () => {
      live.c.budgets = budgets;
      refused++;
      return Promise.reject(new Error('the phone refused a read'));
    };
  } else {
    const settings = k.voice.settings;
    k.voice.settings = (/** @type {any[]} */ ...a) => {
      if (live.state !== (read === 'start' ? 'opening' : 'open')) return settings.apply(k.voice, a);
      k.voice.settings = settings;
      refused++;
      return Promise.reject(new Error('the phone refused a read'));
    };
  }
  return () => refused;
}
const READS = /** @type {['spend' | 'start' | 'listen', string][]} */ ([['spend', 'the spend refused as the session opens'], ['start', 'the settings refused as the session opens'], ['listen', 'the pause refused as its microphone starts']]);
const FINAL = 'The castle gardens close at six.';
/** The cards annai shows of its own for what no session took, and the failure's: what the tests wait on, for a card that may come. @param {any[]} cards */
const annaiCards = (cards) => cards.filter((n) => ['Reminder', "Shiori's answer", "Something for Shiori wasn't saved"].includes(n.title)).map((n) => `${n.title}: ${n.body}`);
/** Every card Halves showed (k.notices: its own, live Koe's and each half's), by its words: what "nothing of annai's own" asserts is that this is empty, whatever its title. @param {any} k */
const everyCard = (k) => k.notices.map((/** @type {any} */ n) => `${n.title}: ${n.body}`);
for (const [read, which] of READS) {
  for (const [what, send, words] of /** @type {[string, (k: any) => unknown, string][]} */ ([
    ["Kokoro's final text", (k) => k.agent.channel.send('kokoro', FINAL, 'append', 'final-text'), FINAL],
    ['"nothing to add"', (k) => k.agent.channel.send('kokoro', 'Kokoro has nothing to add.', 'append', 'nothing-to-add'), 'nothing to add'],
    ["a watch's wake", (k) => k.agent.wake(train()), 'Train in 20 minutes'],
    ["an immediate note of Kokoro's for the user", (k) => k.agent.channel.send('kokoro', ANSWER, 'immediate', 'tool', undefined, undefined, false, ANSWER), 'Bixby'],
    ['the recap asked aloud', (k) => k.agent.wake(RECAP), 'Tell the recap'],
  ])) {
    test(`Koe live: a read of ${which}, for ${what}: the session is given it once, and annai shows nothing of its own`, async () => {
      const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
      try {
        await k.voice.unlock();
        const cards = raw(k);
        const refused = refuseRead(k, read);
        const given = () => texts(k).filter((/** @type {string} */ x) => x.includes(words)).length;
        await send(k);
        await soon(async () => given() > 0 || annaiCards(cards).length > 0);
        await settled();
        await idleAtOnce(k);
        assert.equal(refused(), 1, 'the read was refused');
        assert.deepEqual(everyCard(k), [], 'no failure is told, and annai shows nothing of its own');
        assert.equal(given(), 1, 'the session was given it');
        k.agent.send('Hello there');
        await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')));
        await settled();
        await idleAtOnce(k);
        assert.equal(given(), 1, 'and never again');
        assert.deepEqual(everyCard(k), [], 'still nothing of annai\'s');
        assert.deepEqual([await entries(k), (await recordsIn(k, k.trip, 'wake')).filter((/** @type {any} */ e) => e.data.half === 'kokoro' && JSON.stringify(e.data).includes('Tell the recap')).length], [[], 0], 'no reminder entry, and Kokoro never had the recap');
      } finally {
        await k.done();
      }
    });
  }
}

for (const read of /** @type {('spend' | 'start')[]} */ (['spend', 'start'])) {
  test(`Koe live: a read of ${read === 'spend' ? 'the spend' : 'the settings'} refused as the session opens for a typed line: the session is given the line`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      const refused = refuseRead(k, read);
      k.agent.send('Hello there');
      await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')) || annaiCards(cards).length > 0);
      assert.equal(refused(), 1, 'the read was refused');
      assert.deepEqual(texts(k), ['[typed] Hello there'], 'the session was given the line');
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(everyCard(k), [], 'no failure is told, and nothing else is shown');
    } finally {
      await k.done();
    }
  });
}

test('Koe live: a read of the pause refused as a tap starts the microphone: the microphone listens', async () => {
  const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const refused = refuseRead(k, 'listen');
    assert.equal(k.agent.tap(), 'listening');
    const tapped = await k.agent.live.tapping;
    assert.equal(refused(), 1, 'the read was refused');
    assert.equal(tapped, 'ok', 'the tap did not fail');
    await until(() => k.agent.live.listening, 30_000);
    assert.equal(k.platform.mic.isOpen(), true, 'the microphone is open');
  } finally {
    await k.done();
  }
});

test("Koe live: a read of the settings refused as the session opens leaves it open, not opening with its socket open; the next opens on the first's handle", async () => {
  const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const cards = raw(k);
    const refused = refuseRead(k, 'start');
    await k.agent.channel.send('kokoro', FINAL, 'append', 'final-text');
    await soon(async () => texts(k).length > 0 || annaiCards(cards).length > 0);
    assert.equal(refused(), 1, 'the read was refused');
    assert.equal(k.agent.live.state, 'open', 'open');
    await soon(async () => (await lives(k, 'closed')).length > 0); // nobody asked to talk: it closes once its answer window is over
    k.agent.send('Hello there');
    await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')));
    await settled();
    await idleAtOnce(k);
    assert.deepEqual((await lives(k)).map((/** @type {any} */ e) => e.data.state), ['open', 'ready', 'closed', 'open', 'resumed'], 'the first closed, and the next went on from it');
  } finally {
    await k.done();
  }
});

// A close that lands while #start reads the settings (open-reads-next's final review, F1; on 7b995be58 too): the read is made before the connection, so
// nothing is awaited between #start's last look at the close and "open". On 6be3017b0 it came after, and a tap or the page going out of view inside the read
// left the session "open" with no socket: a tap answered "listening" with no microphone, a typed line went to no session and no card said so, and the quiet
// spell never ended it. The read takes 20 ms here, and the close comes 5 ms into it.
for (const [how, close] of /** @type {[string, (k: any) => unknown][]} */ ([['a second tap', (k) => k.agent.tap()], ['the page going out of view', (k) => k.agent.hush('away')]])) {
  test(`Koe live: ${how} while the session reads the settings as it opens: it is closed, not open with no socket; the next tap listens and a typed line is given`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1 });
    try {
      await k.voice.unlock();
      const live = k.agent.live;
      const settings = k.voice.settings;
      let slowed = 0;
      k.voice.settings = async (/** @type {any[]} */ ...a) => {
        if (live.state !== 'opening') return settings.apply(k.voice, a);
        k.voice.settings = settings;
        slowed++;
        setTimeout(() => close(k), 5);
        await new Promise((r) => setTimeout(r, 20));
        return settings.apply(k.voice, a);
      };
      assert.equal(k.agent.tap(), 'listening');
      await soon(async () => slowed === 1);
      await new Promise((r) => setTimeout(r, 300)); // the read ends, and the open runs on: whatever it leaves is there by now
      assert.equal(live.state, 'closed', 'the close stands: the session is not open');
      await soon(async () => !live.busy, 5000).catch(() => assert.fail('the session is busy for ever: open, with no socket'));
      await settled();
      await idleAtOnce(k);
      assert.equal(k.agent.tap(), 'listening');
      assert.equal(await live.tapping, 'ok', 'the next tap did not fail');
      await until(() => live.listening, 3000).catch(() => assert.fail('the next tap said "listening" and nothing listens'));
      assert.equal(k.platform.mic.isOpen(), true, 'the microphone is open');
      k.agent.send('Hello there');
      await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('[typed]')), 5000).catch(() => {});
      assert.deepEqual(texts(k), ['[typed] Hello there'], 'the session was given the line');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(k.server.openCount(), 1, 'one socket is open, the next tap\'s: the one the closed open made is closed');
    } finally {
      await k.done();
    }
  });
}

// "The settings it last had" (spec §10.8, Opening): a read refused as the next session opens leaves it the quiet spell and the pause the last one had, not the
// defaults (30 s, 700 ms). The kit's spell is 3 s, not the default's 0.3 s; the pause test below sets the pause to 1.5 s.
test("Koe live: a read of the settings refused as the next session opens: it closes on the last one's quiet spell, not the default's", async () => {
  const k = await liveKit([{ said, audio: tone(0.3) }, { said, audio: tone(0.3) }], { pace: 1 });
  try {
    await k.voice.unlock();
    k.agent.send('Hi');
    await soon(async () => texts(k).length === 1);
    k.agent.hush('away');
    await soon(async () => !k.agent.live.busy && k.agent.live.state === 'closed');
    const refused = refuseRead(k, 'start');
    k.agent.send('Hello there');
    await soon(async () => texts(k).length === 2);
    assert.equal(refused(), 1, 'the read was refused');
    await new Promise((r) => setTimeout(r, 1500)); // past the default's 0.3 s after her short answer, short of the kit's 3 s
    assert.equal(k.agent.live.state, 'open', 'still open: the default spell would have closed it');
    await soon(async () => (await lives(k, 'closed')).length === 2, 10_000);
    assert.deepEqual((await lives(k, 'closed')).map((/** @type {any} */ e) => e.data.why), ['away', 'quiet'], 'and it closes on the quiet spell');
  } finally {
    await k.done();
  }
});

test("Koe live: a read of the pause refused as the next session's microphone starts: it ends a turn on the last one's pause, not the default's", async () => {
  const { quiet } = await import('./voice-kit.js');
  const k = await liveKit([{ said, audio: tone(0.3) }], { pace: 1 });
  try {
    await updateAppSettings(k.ws, { voice: { pauseMs: 1500 } });
    await k.voice.unlock();
    /** @param {any} k */
    const turnEnds = (k) => k.server.received().filter((/** @type {any} */ m) => m.realtimeInput?.activityEnd).length;
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    k.agent.hush('away');
    await soon(async () => !k.agent.live.busy && k.agent.live.state === 'closed');
    const refused = refuseRead(k, 'listen');
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    assert.equal(refused(), 1, 'the read was refused');
    await sayClip(k, 'where-eat'); // a sentence, then 1 s of quiet: a turn's end at 700 ms, not at 1.5 s
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(turnEnds(k), 0, "the turn is not over: the last session's pause, not the default's 700 ms");
    k.platform.mic.feed(quiet(1), 16_000);
    await soon(async () => turnEnds(k) === 1, 5000).catch(() => assert.fail('the turn never ended'));
  } finally {
    await k.done();
  }
});

// A note of Kokoro's for the traveller is with the session that is connecting when voice goes off, and the traveller opens another conversation just after:
// the note carries the conversation it was written in (Channel.send), so #live, after its refresh, shows it there (#elsewhere, as a switch shows what it
// leaves), and nothing of it goes to the one opened: no card's entry, no Koe turn. Voice is off, so nothing is said either way: that the note is shown silently
// is pinned by the tests below, where voice is on. On 4fb14e7d2 the close's hand-on and #live's copy both went to the conversation opened (Koe · Chat's turn
// there, or "Shiori's answer" there), and nothing of it to its own.
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  test(`Koe live: a note of Kokoro's for the user with the session connecting when voice goes off and another conversation opens just after: it is shown in its own conversation, and nothing of it in the one opened${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      const conn = slowConnection(k);
      await tellKoe(k);
      await until(conn.reached, 30_000);
      const { opening } = await voiceOff(k, other);
      await inTime(/** @type {Promise<void>} */ (opening), 'the open did not finish', 5000);
      await soon(async () => answers(cards).length > 0 || koeAsked(k, 'Bixby') > 0 || (await answerIn(k, other)).length > 0);
      conn.open();
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await answerIn(k, other), [], 'nothing of it in the one opened');
      assert.deepEqual(await answerIn(k, k.trip), [ANSWER], 'shown in its own conversation, once');
      assert.deepEqual(answers(cards), [ANSWER], 'one card');
      assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes('Bixby')), [], 'never said');
      assert.equal(koeAsked(k, 'Bixby'), 0, 'Koe · Chat never had it');
      assert.equal(texts(k).length, 0, 'the session never got it');
    } finally {
      await k.done();
    }
  });
}

// A note of Kokoro's for the traveller whose write is still in flight when the traveller opens another conversation (the approved entry "Live Koe's tool
// calls in flight when another conversation opens are written into the conversation opened", its note in flight): it is written in the conversation left,
// and stays there (Koe's delivery asks #elsewhere): shown there, silently, never said or given to Koe in the one opened. On 4fb14e7d2 the live session that opened
// there was given it (Koe live), or annai showed it there as "Shiori's answer" (Koe on a chat model, voice off).
for (const [mode, chat] of /** @type {[string, boolean][]} */ ([[' (Koe live)', false], [' (Koe on a chat model, voice off)', true]])) {
  test(`Koe: a note of Kokoro's for the user still being written when another conversation opens: it stays in its own conversation, and nothing of it in the one opened${mode}`, async () => {
    const k = await liveKit([{ said: 'The viewpoint is open until ten.', audio: tone(0.5) }], { pace: 1, koe: { type: [asleep, asleep, asleep] } });
    try {
      await k.voice.unlock();
      if (chat) await k.voice.choose('off'); // Koe · Chat talks
      await soon(async () => k.agent.koeState === (chat ? 'text' : 'live'));
      const cards = raw(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      /** @type {() => void} */
      let open = () => {};
      const door = new Promise((r) => { open = () => r(undefined); });
      const log = k.agent.kokoro.log.bind(k.agent.kokoro);
      k.agent.kokoro.log = async (/** @type {any} */ ev, /** @type {any} */ o) => {
        const e = await log(ev, o);
        if (ev.type === 'note') await door; // written; Channel.send still waits on it
        return e;
      };
      const sending = tellKoe(k);
      await soon(async () => (await recordsIn(k, k.trip, 'note')).length > 0);
      const opening = k.agent.open(other);
      open();
      await inTime(opening, 'the open did not finish', 5000);
      await sending;
      await soon(async () => answers(cards).length > 0 || koeAsked(k, 'Bixby') > 0 || texts(k).length > 0);
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await answerIn(k, other), [], 'nothing of it in the one opened');
      assert.equal(texts(k).length, 0, 'no session had it');
      assert.equal(koeAsked(k, 'Bixby'), 0, 'Koe · Chat never had it');
      assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes('Bixby')), [], 'never said');
      assert.deepEqual(answers(cards), [ANSWER], 'one card');
      assert.deepEqual(await answerIn(k, k.trip), [ANSWER], 'shown in its own conversation, once');
    } finally {
      await k.done();
    }
  });
}

/** Kokoro's question for the traveller (a gated ask): logged in the conversation open, then given to Koe. @param {any} k */
const askKoe = (k) => k.agent.channel.send('kokoro', 'Kokoro wants to ask: Which bridge first?', 'append', 'gated:ask', 'wk1', { name: 'ask', input: { question: 'Which bridge first?', options: ['Bixby', 'Golden Gate'] } });

// Start fresh while the session is connecting with a note of Kokoro's for the traveller (voice-off-next's final review, F1; its re-review, Haiku src item 2): the
// close Start fresh makes shows Kokoro's notes itself, silently, above the divider (Kokoro's words for the user that Koe still owes are shown above it, spec §6.8),
// the one a part of Halves waits to place included, and takes them out of their lists; Halves' read of what is shown (#startFresh) holds them, whatever #live awaits
// (round 1's check in #live won that race by about two microtask ticks), and #go finds them gone and places no second copy. A question of Kokoro's is let go there,
// with a Trace line, never a live card below it. On 4fb14e7d2 the close showed it, and without this the note fell to #backstop, which says it aloud and writes it
// below the divider, and the question became a card.
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  for (const [what, send] of /** @type {[string, (k: any) => Promise<string>][]} */ ([["a note of Kokoro's for the user", tellKoe], ["a question of Kokoro's", askKoe]])) {
    test(`Koe live: ${what} with the session connecting when Start fresh runs: ${what.includes('question') ? 'it is let go above the divider, with a Trace line and no card' : 'it is shown above the divider, silently'}, and nothing of it below${mode}`, async () => {
      const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
      try {
        await k.voice.unlock();
        const cards = raw(k);
        const conn = slowConnection(k);
        await send(k);
        await until(conn.reached, 30_000);
        await until(() => k.agent.live.owing, 30_000);
        assert.equal(await k.agent.startFresh(), 'done');
        conn.open();
        await settled();
        await idleAtOnce(k);
        await settled();
        await idleAtOnce(k);
        const all = await k.events(['reminder', 'out.ask', 'error', 'compaction']);
        const question = what.includes('question');
        assert.deepEqual(all.map((/** @type {any} */ e) => e.type), question ? ['error', 'compaction'] : ['reminder', 'compaction'], 'all of it above the divider, nothing below');
        if (question) assert.equal(all[0].data.kind, 'unshown', 'a Trace line');
        else assert.deepEqual([all[0].data.text, all[0].data.unsaid, all[0].data.aloud], [ANSWER, true, undefined], 'its words, silently');
        assert.deepEqual(answers(cards), question ? [] : [ANSWER], question ? 'no card' : 'one card');
        assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes('Bixby') || x.includes('bridge')), [], 'never said');
        assert.equal(koeAsked(k, question ? 'Which bridge' : 'Bixby'), 0, 'Koe · Chat never had it');
        assert.equal(texts(k).length, 0, 'the session never got it');
      } finally {
        await k.done();
      }
    });
  }
}

// What Start fresh's own rule leaves alone (the re-review, Haiku src item 2: the close shows Kokoro's notes itself, so Halves' read of what is shown above the divider holds
// them): a watch's reminder that the session was connecting to take is still placed by #live, and said once, above the divider; and the recap asked aloud is still
// handed to Kokoro, which the close would have lost had it shown it (Start fresh forgets the session's notes). Both as on 90e35a763: guards for the rule's reach.
for (const [mode, koe] of /** @type {[string, any][]} */ ([[' (Koe on a chat model)', { koe: { type: [asleep, asleep, asleep] } }], [' (no Koe model)', {}]])) {
  test(`Koe live: a watch's wake with the session connecting when Start fresh runs: its reminder is shown once and said once, above the divider${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const cards = raw(k);
      const conn = slowConnection(k);
      k.agent.wake(train());
      await until(conn.reached, 30_000);
      await until(() => k.agent.live.owing, 30_000);
      assert.equal(await k.agent.startFresh(), 'done');
      conn.open();
      await settled();
      await idleAtOnce(k);
      await settled();
      await idleAtOnce(k);
      const all = await k.events(['reminder', 'compaction']);
      assert.deepEqual(all.map((/** @type {any} */ e) => e.type), ['reminder', 'compaction'], 'above the divider, nothing below');
      assert.deepEqual(reminders(cards), [TRAIN], 'one card');
      assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes(TRAIN)), [TRAIN], 'said once');
      assert.equal(texts(k).length, 0, 'the session never got it');
    } finally {
      await k.done();
    }
  });

  test(`Koe live: the recap asked aloud with the session connecting when Start fresh runs: Kokoro has it, and the session never does${mode}`, async () => {
    const k = await liveKit([{ said, audio: tone(1) }], { pace: 1, ...koe });
    try {
      await k.voice.unlock();
      const conn = slowConnection(k);
      k.agent.wake(RECAP);
      await until(conn.reached, 30_000);
      await k.agent.startFresh();
      conn.open();
      await settled();
      await idleAtOnce(k);
      await settled();
      await idleAtOnce(k);
      assert.deepEqual((await recordsIn(k, k.trip, 'wake')).filter((/** @type {any} */ e) => JSON.stringify(e.data).includes('Tell the recap')).map((/** @type {any} */ e) => e.data.half), ['kokoro'], "Kokoro's wake carries it, once");
      assert.equal(texts(k).length, 0, 'the session never got it');
    } finally {
      await k.done();
    }
  });
}

// The session has the reminder, or Kokoro's note for the traveller, and is saying it when voice goes off, and another conversation opens just after (voice-off-next's
// final review, F2: #handOn's own check, which no other test reaches: what #go waited for is let go to #live, so only a copy the session already had comes here). The
// close hands it on, and #handOn, after its refresh, shows it in its own conversation (#elsewhere); without that, Koe · Chat's text turn in the one opened was given it.
for (const [what, send, own] of /** @type {[string, (k: any) => unknown, (k: any, scope: string) => Promise<string[]>][]} */ ([
  ['a watch\'s reminder', (k) => k.agent.wake(train()), async (k, scope) => entries(k, scope)],
  ["Kokoro's note for the user", tellKoe, answerIn],
])) {
  test(`Koe live: the session has ${what} and is saying it when voice goes off and another conversation opens just after: it lands in its own conversation, and nothing of it in the one opened (Koe on a chat model)`, async () => {
    const k = await liveKit([{ said, audio: tone(5) }], { pace: 1, koe: { type: [asleep, asleep, asleep] } });
    try {
      k.platform.streamSpeed = 1; // her sound plays in real time: she is saying it when voice goes off
      await k.voice.unlock();
      const cards = raw(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      await send(k);
      await soon(async () => texts(k).length === 1);
      await until(() => k.platform.streams.length === 1, 30_000);
      await new Promise((r) => setTimeout(r, 600));
      const { opening } = await voiceOff(k, other);
      await inTime(/** @type {Promise<void>} */ (opening), 'the open did not finish', 5000);
      await soon(async () => (await own(k, k.trip)).length > 0 || (await own(k, other)).length > 0); // wherever it lands, so a regression fails at the assertions below
      await settled();
      await idleAtOnce(k);
      assert.deepEqual(await own(k, k.trip), [what.includes('note') ? ANSWER : TRAIN], 'shown in its own conversation, once');
      assert.deepEqual(await own(k, other), [], 'no entry in the one opened');
      assert.deepEqual((await Promise.all(['wake', 'out.speak'].map((type) => recordsIn(k, other, type)))).flat().filter((/** @type {any} */ e) => /Bixby|train/i.test(JSON.stringify(e.data))), [], 'nothing of it told, or answered, in the one opened');
      assert.equal(koeAsked(k, what.includes('note') ? 'Bixby' : TRAIN), 0, 'Koe · Chat never had it');
      assert.equal(what.includes('note') ? answers(cards).length : reminders(cards).length, 1, 'one card');
      assert.equal(texts(k).length, 1, 'the session was given it once, before voice went off');
    } finally {
      await k.done();
    }
  });
}

// An immediate note of Kokoro's for the conversation the traveller has left (its write was still in flight when the other opened) stays there, and cuts nothing in the
// one opened (the review's second opinion, src F3): Koe · Chat's answer to a line typed in the one opened is not stopped by it. On fea9ac9d9 Channel.send cut Koe
// after the delivery that had put the note elsewhere.
test("Koe · Chat: an immediate note of Kokoro's for the user, for the conversation left, arrives while Koe answers a line typed in the one opened: Koe is not cut in on (cutIn is never called), and the note is shown in its own conversation", async () => {
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => { release = () => r(undefined); });
  const k = await liveKit([{ said: 'The viewpoint is open until ten.', audio: tone(0.5) }], { pace: 1, koe: { type: [asleep, asleep, asleep] }, hold: async (c) => { if (c.model.providerId === 'model-koe') await held; } });
  try {
    await k.voice.unlock();
    await k.voice.choose('off'); // Koe · Chat talks
    await soon(async () => k.agent.koeState === 'text');
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    /** @type {() => void} */
    let open = () => {};
    const door = new Promise((r) => { open = () => r(undefined); });
    const log = k.agent.kokoro.log.bind(k.agent.kokoro);
    k.agent.kokoro.log = async (/** @type {any} */ ev, /** @type {any} */ o) => {
      const e = await log(ev, o);
      if (ev.type === 'note') await door; // written; Channel.send still waits on it
      return e;
    };
    let cuts = 0;
    const cutIn = k.agent.koe.cutIn.bind(k.agent.koe);
    k.agent.koe.cutIn = () => { cuts++; cutIn(); };
    const sending = k.agent.channel.send('kokoro', ANSWER, 'immediate', 'tool', undefined, undefined, false, ANSWER);
    await soon(async () => (await recordsIn(k, k.trip, 'note')).length > 0);
    await inTime(k.agent.open(other), 'the open did not finish', 5000);
    k.agent.send('Is the viewpoint open?'); // Koe · Chat's call for it is held: its answer is in flight
    await soon(async () => koeAsked(k, 'Is the viewpoint open?') === 1);
    open(); // the note's write ends: its delivery finds the conversation gone
    await sending;
    await settled();
    assert.equal(cuts, 0, 'Koe was not cut');
    release();
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(await answerIn(k, k.trip), [ANSWER], 'the note is shown in its own conversation');
    assert.deepEqual(await answerIn(k, other), [], 'and nothing of it in the one opened');
  } finally {
    await k.done();
  }
});

// Kokoro's note for the traveller went in and the session said nothing of it, twice: annai takes it over (the session's `unsaid`, a route of Halves', #backstop),
// and another conversation opens before that route runs: it is shown in its own conversation, silently (#elsewhere), as the wake's reminder is shown in
// its own (the test below). On 4fb14e7d2 annai showed it as "Shiori's answer" in the one opened, and said it there.
test("Koe live: a note of Kokoro's for the user the session passed on in no words, asked once more, when another conversation opens as annai takes it over: it is shown in its own conversation, silently, and nothing of it in the one opened", async () => {
  const k = await liveKit([{ said: 'Silent.', audio: tone(0.4) }, { said: 'Silent.', audio: tone(0.4) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const cards = raw(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const unsaid = k.agent.live.c.unsaid;
    const order = /** @type {string[]} */ ([]);
    k.agent.live.c.unsaid = (/** @type {any[]} */ notes) => { // the route that shows them is queued; the traveller opens another conversation before it runs
      order.push(`taken over ${notes.length}`);
      unsaid(notes);
      order.push('open');
      k.agent.open(other).catch(() => {});
    };
    await tellKoe(k);
    await soon(async () => order.length === 2, 30_000);
    await soon(async () => answers(cards).length > 0);
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(order, ['taken over 1', 'open']);
    assert.deepEqual(await answerIn(k, other), [], 'nothing of it in the one opened');
    assert.deepEqual(await answerIn(k, k.trip), [ANSWER], 'shown in its own conversation, once');
    assert.deepEqual(answers(cards), [ANSWER], 'one card');
    assert.deepEqual(k.said.filter((/** @type {string} */ x) => x.includes('Bixby')), [], 'not said');
  } finally {
    await k.done();
  }
});

// The session was asked once more and said nothing of the reminder: annai takes it over (the session's `unsaid`, a route of Halves' that shows it, #backstop),
// and another conversation opens before that route runs: it shows the reminder in the wake's own conversation (the wake's scope), as everything that waits does.
test('Koe live: a watch\'s wake the session passed on in no words, asked once more, when another conversation opens as annai takes it over: its reminder is shown in its own conversation, and nothing of it in the one opened', async () => {
  const k = await liveKit([{ said: 'Silent.', audio: tone(0.4) }, { said: 'Silent.', audio: tone(0.4) }], { pace: 1 });
  try {
    await k.voice.unlock();
    const cards = raw(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    const unsaid = k.agent.live.c.unsaid;
    const order = /** @type {string[]} */ ([]);
    k.agent.live.c.unsaid = (/** @type {any[]} */ notes) => { // the route that shows them is queued; the traveller opens another conversation before it runs
      order.push(`taken over ${notes.length}`);
      unsaid(notes);
      order.push('open');
      k.agent.open(other).catch(() => {});
    };
    k.agent.wake(train());
    await soon(async () => order.length === 2, 30_000);
    await soon(async () => reminders(cards).length > 0);
    await settled();
    await idleAtOnce(k);
    assert.deepEqual(order, ['taken over 1', 'open']);
    assert.deepEqual(await entries(k, other), [], 'none in the one opened');
    assert.deepEqual(reminders(cards), [TRAIN], 'shown once');
    assert.deepEqual(await entries(k), [TRAIN], 'its entry, in its own conversation');
  } finally {
    await k.done();
  }
});

// No session can open (today's spend reached) and Koe stays live: the recap asked aloud, which Kokoro was never given, is hers to write and answer in text
// (#live's last branch), not written nowhere.
test("Koe live: the recap asked to be told aloud when no session can open (today's spend reached) and Koe stays live: Kokoro has it, in its own conversation", async () => {
  const usage = { promptTokenCount: 1_000_000, responseTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }] };
  const k = await liveKit([{ said: 'Sure.', audio: tone(0.1), usage }], { pace: 1 });
  try {
    await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
    k.agent.send('Hi');
    await soon(async () => (await lives(k, 'closed')).length > 0);
    await idleAtOnce(k);
    const had = texts(k).length; // the line that spent the day's budget
    k.agent.wake({ kind: 'recap', aloud: true, text: 'Tell the recap of this trip, aloud.' });
    await settled();
    await idleAtOnce(k);
    assert.equal(k.agent.koeState, 'live', 'Koe stays live');
    assert.equal(JSON.stringify(await recordsIn(k, k.trip, 'wake')).includes('Tell the recap'), true, "written into the conversation (Kokoro's turn has it)");
    assert.equal(texts(k).length, had, 'no session had it');
  } finally {
    await k.done();
  }
});

// The live model can't connect and Koe has no other way (no chat model): Koe is down, a card says so, and Kokoro talks directly. The recap asked aloud, which
// Kokoro was never given, is hers with the koe-down wake (#live's down branch), not written nowhere.
test("Koe live: the recap asked to be told aloud when the live model can't connect and Koe has no other way (Koe down): Kokoro has it", async () => {
  const k = await liveKit([{ said: 'Sure.', audio: tone(0.1) }], { pace: 1 });
  try {
    k.llm.live = async () => {
      k.llm.bench.bench('m-live', 60_000); // the live model rests, as a refused connection leaves it
      throw new Error('the connection was refused');
    };
    k.agent.wake({ kind: 'recap', aloud: true, text: 'Tell the recap of this trip, aloud.' });
    await soon(async () => k.agent.koeState === 'down' && (await recordsIn(k, k.trip, 'wake')).length > 0);
    await settled();
    await idleAtOnce(k);
    assert.equal(k.agent.koeState, 'down', 'Koe is down');
    assert.equal(JSON.stringify(await recordsIn(k, k.trip, 'wake')).includes('Tell the recap'), true, "written into the conversation (Kokoro's turn has it)");
    assert.equal(texts(k).length, 0, 'no session had it');
  } finally {
    await k.done();
  }
});

for (const away of [true, false]) {
  test(`Koe live: Koe says "Let me look." and looks it up first, ${away ? 'the page goes out of view while she says the rest, and is killed later: the next start shows the reminder once, the start after nothing' : 'and says the rest with the page in view: the session writes that it passed it on, and the next start shows nothing'}`, async () => {
    const k = await liveKit([LOOK, { said, audio: tone(away ? 8 : 0.3) }], { pace: 1 });
    try {
      k.platform.streamSpeed = 1;
      await k.voice.unlock();
      await k.agent.wake(train());
      await soon(async () => (await k.events(['out.speak'])).length === 1); // "Let me look.", whole
      if (away) {
        await until(() => k.platform.streams.length === 2, 30_000); // what she says after it plays
        await new Promise((r) => setTimeout(r, 1000));
        k.agent.hush('away');
      }
      await soon(async () => (await k.events(['out.speak'])).length === 2, 30_000);
      const log = (await k.events(['reminder.held', 'reminder.told', 'out.speak'])).map((/** @type {any} */ e) => (e.type !== 'out.speak' ? e.type : e.data.cut ? 'her line, cut' : e.data.text));
      assert.deepEqual(log, away ? ['reminder.held', 'Let me look.', 'her line, cut'] : ['reminder.held', 'Let me look.', 'reminder.told', said]);
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), away ? [TRAIN] : []);
      assert.deepEqual(await entries(k), away ? [TRAIN] : []);
      const again = await nextStart(k, true);
      assert.deepEqual(reminders(again.cards), []);
    } finally {
      await k.done();
    }
  });
}

// Her first line is only one of annai's own words to her ("Silent."): no answer (#passes), so annai asks once more, and the page goes out of view while she
// answers that, and is killed later: the next start shows the reminder once.
test('Koe live: Koe\'s first line is a bare "Silent.", she is asked once more, and the page goes out of view while she answers and is killed later: the next start shows the reminder once', async () => {
  const k = await liveKit([{ said: 'Silent.', audio: tone(0.4) }, { said, audio: tone(8) }], { pace: 1 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    await k.agent.wake(train());
    await until(() => k.platform.streams.length === 2, 30_000); // her answer to the ask once more plays
    await new Promise((r) => setTimeout(r, 1000));
    k.agent.hush('away');
    await soon(async () => (await k.events(['out.speak'])).length === 2, 30_000);
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => Boolean(e.data.cut)), [false, true], '"Silent." whole, her answer cut');
    assert.equal(texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length, 1, 'asked once more');
    assert.deepEqual(await k.events(['reminder.told']), [], 'the session never passed it on');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [TRAIN]);
    assert.deepEqual(await entries(k), [TRAIN]);
    const again = await nextStart(k, true);
    assert.deepEqual(reminders(again.cards), []);
  } finally {
    await k.done();
  }
});

// An urgent reminder cuts in on her quiet tail (her words said and their loud part heard, the silence after them still playing), and the page is killed before her
// answer to it: her line before it, whole, was no answer to it (#passes: its words began before the reminder went in, wordAt), so the session writes no
// `reminder.told` for it and the next start shows it. Without the check, the end of that line wrote it as told, and the reminder was lost.
test('Koe live: an urgent reminder cuts in on her quiet tail, and the page is killed before her answer: that line was no answer to it, so the next start shows it once', async () => {
  const loud = tone(3);
  const tail = new Uint8Array(Math.round(24_000 * 4) * 2); // four seconds of silence after her words
  const line = new Uint8Array(loud.length + tail.length);
  line.set(loud, 0);
  line.set(tail, loud.length);
  const k = await liveKit([{ said: 'The weather is fine here today.', audio: line }, { said, audio: tone(8) }], { pace: 0 });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    await k.agent.wake({ kind: 'trigger', text: 'Your watch fired: Weather.', fallbacks: [{ watch: 'weather', text: 'Weather', cue: true }] });
    await until(() => k.platform.streams.length === 1, 30_000);
    await new Promise((r) => setTimeout(r, 3500)); // her words are said and their loud part heard (3 s): her quiet tail still plays
    await k.agent.wake({ ...train(), urgent: true }); // it cuts in on that tail
    await until(() => k.platform.streams.length === 2, 30_000); // her answer to it plays
    await new Promise((r) => setTimeout(r, 1000));
    k.agent.hush('away'); // out of view mid-answer, killed later
    await soon(async () => (await k.events(['out.speak'])).length === 2, 30_000);
    assert.deepEqual(await k.events(['reminder.told']), [], 'the session passed nothing on');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [TRAIN]);
    assert.deepEqual(await entries(k), [TRAIN]);
    const again = await nextStart(k, true);
    assert.deepEqual(reminders(again.cards), []);
  } finally {
    await k.done();
  }
});

// A card or question passes on what was in flight when its call came, and no more (#tool): an urgent reminder that goes in while a `show` call runs is no note the
// card answered. Koe then says only "Silent." (one of annai's own words: no answer), so she is asked once more, and then annai shows it, never written as
// told, which would settle the held copy for a reminder no one was given. The control: the card answered first, then the reminder.
for (const [what, race] of /** @type {[string, boolean][]} */ ([['while the card is being shown', true], ['after the card is answered (the control)', false]])) {
  test(`Koe live: an urgent reminder goes in ${what}, and Koe says only "Silent.": she is asked once more, then annai shows it, and the session never writes it as told`, async () => {
    const card = { name: 'show', args: { card: { title: 'Bixby Bridge', text: 'About twenty minutes ahead.' } } };
    // The answer to the reminder is slow (delayMs), so the call comes back before it is said, as it can on a phone: the call, then "Silent.".
    const k = await liveKit([{ tool: card }, { said: 'Silent.', audio: tone(0.3), delayMs: race ? 1500 : 0 }, { said: 'Silent.', audio: tone(0.3) }], { pace: 0 });
    /** @type {() => void} */
    let release = () => {};
    let calling = false;
    try {
      if (race) {
        const gate = new Promise((r) => { release = () => r(undefined); });
        const call = k.agent.koe.liveCall.bind(k.agent.koe);
        k.agent.koe.liveCall = async (/** @type {any} */ c, /** @type {any[]} */ ...rest) => {
          if (c.name === 'show') { calling = true; await gate; }
          return call(c, ...rest);
        };
      }
      /** @type {number[]} */
      const askedAt = []; // the asks that had gone in as each reminder's card was raised
      k.agent.on('notice', (/** @type {any} */ n) => { if (n.title === 'Reminder') askedAt.push(texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length); });
      await k.voice.unlock();
      k.agent.send('Show me the bridge');
      if (race) await until(() => calling, 30_000);
      else await soon(async () => (await k.events(['out.show'])).length === 1);
      await k.agent.wake({ ...train(), urgent: true });
      await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('Train in 20 minutes'))); // it is with the session
      release(); // the card is shown now
      await soon(async () => (await k.events(['out.show'])).length === 1);
      await soon(async () => texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length === 1, 10_000); // asked once more
      await soon(async () => (await entries(k)).length === 1, 30_000); // she says only "Silent." again: annai shows it
      assert.deepEqual(reminders(k.notices), [TRAIN], 'shown once');
      assert.deepEqual(askedAt, [1], 'she was asked once more before annai showed it, not after: the card\'s own turn settles nothing that went in during its call');
      assert.deepEqual(await k.events(['reminder.told']), [], 'never written as told: no one was given it');
      assert.equal(texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length, 1, 'asked once, not more');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'its entry settled it');
    } finally {
      release();
      await k.done();
    }
  });
}

/**
 * A slow link from the stand-in: from the first message that matches `at.match` (set by the test), that message and every one after it wait, in order,
 * until `at.go()`, as messages already sent wait on a slow mobile link. `go('after')` lets out only those before the provider's cut of her turn
 * (`interrupted`) and holds the cut and all after it until the page has sent its answer to a tool call: the link delivers her call, the page answers it,
 * and only then the cut comes. Taken by the sessions opened after it. @returns {{ match: RegExp | null, held: boolean, waiting: () => string[], go: (order?: 'with' | 'after') => void, restore: () => void }}
 */
function slowLink() {
  const Real = globalThis.WebSocket;
  const says = (/** @type {any} */ e) => (typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
  const at = { match: /** @type {RegExp | null} */ (null), held: false, waiting: () => /** @type {string[]} */ ([]), go: (/** @type {'with' | 'after' | undefined} */ _order) => {}, restore: () => { globalThis.WebSocket = Real; } };
  globalThis.WebSocket = /** @type {any} */ (function Slow(/** @type {string} */ url, /** @type {string[]} */ protocols) {
    const w = new Real(url, protocols);
    /** @type {(() => void) | null} */
    let onAnswer = null; // lets out what still waits, once the page's answer to a tool call has gone out (go('after'))
    const send = w.send.bind(w);
    /** @type {any} */ (w).send = (/** @type {any} */ data) => {
      send(data);
      if (onAnswer && typeof data === 'string' && data.includes('"toolResponse"')) setTimeout(onAnswer, 0); // after the code that sent it has run on
    };
    const add = w.addEventListener.bind(w);
    /** @type {any} */ (w).addEventListener = (/** @type {string} */ type, /** @type {(e: any) => void} */ fn, /** @type {any[]} */ ...rest) => {
      if (type !== 'message') return add(type, fn, ...rest);
      /** @type {any[] | null} */
      let queue = null;
      const release = () => {
        const q = queue ?? [];
        queue = null;
        at.held = false;
        for (const x of q) fn(x);
      };
      return add('message', (/** @type {any} */ e) => {
        if (queue) return void queue.push(e);
        if (at.match?.test(says(e))) {
          at.match = null;
          at.held = true;
          queue = [e];
          at.waiting = () => (queue ?? []).map(says);
          at.go = (order = 'with') => {
            const q = queue ?? [];
            const cut = order === 'after' ? q.findIndex((x) => says(x).includes('"interrupted"')) : -1;
            if (cut < 0) return release();
            queue = q.slice(cut); // the cut and all after it wait for the page's answer to the call
            onAnswer = () => { onAnswer = null; release(); };
            for (const x of q.slice(0, cut)) fn(x);
          };
          return;
        }
        fn(e);
      }, ...rest);
    };
    return w;
  });
  return at;
}

// Shape (3) of the Deferred entry "A reminder in memory can still be lost in annai's first seconds" (closed by remind-first-next, 2026-11-23): Koe is saying a line
// with a card after it when an urgent reminder cuts in, and the card's call, sent before the reminder reached the provider, comes after it went in (a slow link).
// That call is her cut turn's, begun before the reminder went in: it passes nothing on (#tool), and that turn is no miss of it either (#settle), whichever order the
// provider's cut of her turn and the page's answer come in: the cut with the call, or only once the page has answered it. With Gemini a cut ends the turn with no
// #settle (#on ends it without #complete, and the adapter drops the turnComplete that follows an interrupted: gemini-live's `cut`), so the cut-first order is the
// control; the rule is pinned by the after order (the page's answer ends the turn, #endNow) and by the race test above.
// Her answer to the reminder is only "Silent.", so she is asked once more, and then annai shows it, never written as told. On a241fd148 the card passed the
// reminder on as told, and nothing showed it; on d26249410 the page's answer, first, counted her cut turn as a miss: annai showed it with no ask first, and a
// stray ask followed (the order was the machine's load, a flaky test).
for (const [what, order] of /** @type {[string, 'with' | 'after'][]} */ ([['with the call', 'with'], ['only after the page has answered it', 'after']])) {
  test(`Koe live: an urgent reminder cuts in while Koe talks, and the card she had already sent comes after it, the provider's cut of her turn ${what}: the card passes nothing on, and after a bare answer annai shows it, once, never written as told`, async () => {
    const card = { name: 'show', args: { card: { title: 'Bixby Bridge', text: 'About twenty minutes ahead.' } } };
    const link = slowLink(); // before the session opens
    const k = await liveKit([{ said: 'Here is the bridge.', audio: tone(3), tool: card }, { said: 'Silent.', audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }], { pace: 1 });
    const asks = () => texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length;
    try {
      k.platform.streamSpeed = 1;
      await k.voice.unlock();
      /** @type {number[]} */
      const askedAt = []; // the asks that had gone in as the reminder's card was raised
      k.agent.on('notice', (/** @type {any} */ n) => { if (n.title === 'Reminder') askedAt.push(asks()); });
      link.match = /"toolCall"/;
      k.agent.send('Show me the bridge');
      await until(() => link.held && k.platform.streams.length === 1, 30_000); // her words play, and her card's call is on its way
      await k.agent.wake({ ...train(), urgent: true }); // it cuts in on her
      await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('Train in 20 minutes'))); // it is with the session
      await until(() => link.waiting().some((x) => x.includes('"interrupted"')), 30_000); // the provider's cut of her turn is on the link too: which comes first is the test's
      link.go(order); // the call comes now, after the reminder went in
      await soon(async () => (await k.events(['out.show'])).length === 1);
      // Her answer is only "Silent.": annai shows it (on a241fd148 the card had written it as told, and nothing showed it).
      await soon(async () => (await entries(k)).length === 1 || (await k.events(['reminder.told'])).length > 0, 30_000);
      assert.deepEqual((await k.events(['reminder.told'])).map((/** @type {any} */ e) => e.data.reminders.map((/** @type {any} */ r) => r.text)), [], 'never written as told: the card was no answer to it');
      assert.deepEqual(reminders(k.notices), [TRAIN], 'shown once');
      assert.deepEqual(askedAt, [1], 'asked once more first: her cut turn missed nothing either');
      assert.equal(asks(), 1, 'asked once, not more');
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'its entry settled it');
      assert.equal(asks(), 1, 'asked once, not more, to the end');
    } finally {
      link.restore();
      await k.done();
    }
  });
}

// The same shape on OpenAI Realtime (the Deferred entry "With OpenAI Realtime, a card's call from a cut reply can pass an urgent reminder on", remind-first-next's
// second opinion, 2026-11-23): OpenAI has no cut of its own, so the plugin cancels her reply, and her turn ends when that reply's response.done comes, after what of
// it was already on its way. The link holds her card's call, and the cancelled reply's end behind it, until the cancel has gone out; the reminder waits in the plugin
// meanwhile (OpenAI makes one response at a time). The card is her cut turn's, and passes nothing on; her answer to the reminder is only "Silent.", so she is asked
// once more, and then annai shows it, never written as told. On 150b8446c the plugin ended her turn as it sent the cancel, so the call opened a new turn, which
// wrote the reminder as told, and nothing showed it.
test("Koe live on OpenAI Realtime: an urgent reminder cuts in while Koe talks, and the card she had already sent comes after the cancel: the card passes nothing on, and after a bare answer annai shows it, once, never written as told", async () => {
  const card = { name: 'show', args: { card: { title: 'Bixby Bridge', text: 'About twenty minutes ahead.' } } };
  const link = slowLink(); // before the session opens
  const k = await liveKit([{ said: 'Here is the bridge.', audio: tone(3), tool: card }, { said: 'Silent.', audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }], { pace: 1, live: { type: 'openai-realtime' } });
  const asks = () => textsIn(k).filter((x) => x.includes("hasn't reached the user")).length;
  const reminderIn = () => textsIn(k).some((x) => x.includes('Train in 20 minutes'));
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    /** @type {number[]} */
    const askedAt = []; // the asks that had gone in as the reminder's card was raised
    k.agent.on('notice', (/** @type {any} */ n) => { if (n.title === 'Reminder') askedAt.push(asks()); });
    link.match = /"response\.function_call_arguments\./;
    k.agent.send('Show me the bridge');
    await until(() => link.held && k.platform.streams.length === 1, 30_000); // her words play, and her card's call is on its way
    await k.agent.wake({ ...train(), urgent: true }); // it cuts in on her
    await until(() => link.waiting().some((x) => x.includes('"response.done"')), 30_000); // the cancel went out: the reply's end is on the link, behind the call
    assert.equal(reminderIn(), false, 'the reminder waits in the plugin for the cancelled reply to end');
    link.go(); // the call comes now, then the reply's end
    await soon(async () => (await k.events(['out.show'])).length === 1);
    await soon(async () => reminderIn(), 30_000); // it went in once the reply ended
    // Her answer is only "Silent.": annai shows it (on 150b8446c the card had written it as told, and nothing showed it).
    await soon(async () => (await entries(k)).length === 1 || (await k.events(['reminder.told'])).length > 0, 30_000);
    assert.deepEqual((await k.events(['reminder.told'])).map((/** @type {any} */ e) => e.data.reminders.map((/** @type {any} */ r) => r.text)), [], 'never written as told: the card was no answer to it');
    assert.deepEqual(reminders(k.notices), [TRAIN], 'shown once');
    assert.deepEqual(askedAt, [1], 'asked once more first: her cut turn missed nothing either');
    assert.equal(asks(), 1, 'asked once, not more');
    const next = await nextStart(k, true);
    assert.deepEqual(reminders(next.cards), [], 'its entry settled it');
    assert.equal(asks(), 1, 'asked once, not more, to the end');
  } finally {
    link.restore();
    await k.done();
  }
});

// What ends her cut turn when the cancelled reply's response.done never comes: the connection drops with it still on the link. The page's own close path lets her
// turn go (#closed) and connects again, and the reminder in flight goes in again there; she says it, once, and nothing waits on the end that never came. (A guard
// for the change above: it passes on 150b8446c too.)
test("Koe live on OpenAI Realtime: an urgent reminder cuts in while Koe talks, and the connection drops before the cut reply's end comes: her turn ends with the drop, and the next connection gets the reminder, which she says once", async () => {
  const card = { name: 'show', args: { card: { title: 'Bixby Bridge', text: 'About twenty minutes ahead.' } } };
  const link = slowLink(); // before the session opens
  const k = await liveKit([{ said: 'Here is the bridge.', audio: tone(3), tool: card }, { said, audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }], { pace: 1, live: { type: 'openai-realtime' } });
  try {
    k.platform.streamSpeed = 1;
    await k.voice.unlock();
    link.match = /"response\.function_call_arguments\./;
    k.agent.send('Show me the bridge');
    await until(() => link.held && k.platform.streams.length === 1, 30_000); // her words play, and her card's call is on its way
    await k.agent.wake({ ...train(), urgent: true }); // it cuts in on her
    await until(() => link.waiting().some((x) => x.includes('"response.done"')), 30_000); // the cancel went out: the reply's end is on the link
    k.server.close(1011, 'Internal error'); // and never comes
    await soon(async () => (await k.events(['reminder.told'])).length + (await entries(k)).length >= 1, 30_000);
    await idleAtOnce(k); // nothing of hers is left open
    assert.equal(k.server.connections().length, 2, 'connected again');
    assert.deepEqual((await k.events(['reminder.told'])).map((/** @type {any} */ e) => e.data.reminders.map((/** @type {any} */ r) => r.text)), [[TRAIN]], 'written as told, once: she said it');
    assert.deepEqual(reminders(k.notices), [], 'no card for it');
    assert.equal(textsIn(k).filter((x) => x.includes('Train in 20 minutes')).length, 1, 'it went in once, on the next connection');
  } finally {
    link.restore();
    await k.done();
  }
});

// A card answered as her whole reply (#tool: a call alone, answered silently, ends her turn at the page's answer, #endNow) while the provider's end of that turn is still
// on its way, and a note or an urgent reminder that goes in after it: her turn began before it went in, so its end is no miss of it (#settle), and the provider's end,
// when it comes, is swallowed as the end of a turn annai ended itself (#endedEarly). The stand-in sends the turn's generationComplete and turnComplete right after
// its call; the link (slowLink) holds that message and all after it, and the test lets them out `afterMs` after the note or the reminder went in, which is after
// the page's answer to the call (the test waits for the answer first), as a slow link would. 3 s is past TURN_END_S (2 s), the timer that ends a turn whose sound began
// and whose end did not come; a card-only turn has none, so its end is swallowed however late it comes.
const ENDS = /** @type {[string, number][]} */ ([['at once', 0], ['3 s late', 3000]]);
const CARD = { name: 'show', args: { card: { title: 'Bixby Bridge', text: 'About twenty minutes ahead.' } } };
/** The page's answers to tool calls that the stand-in has got. @param {any} k */
const answered = (k) => got(k, 'toolResponse').length;

for (const [what, afterMs] of ENDS) {
  test(`Koe live: her only answer to a note is a card, answered before the provider's end of that turn, and the next note went in after it: that end, ${what}, is no miss of it, so nothing is asked once more`, async () => {
    const link = slowLink(); // before the session opens
    /** @type {any} */
    let k;
    /** @type {any} */
    let w;
    try {
      ({ k, w } = await quietSession([{ tool: CARD }, { said: PASS, audio: tone(0.3) }]));
      link.match = /"generationComplete"/;
      await tell(k);
      await tell2(k); // waits behind the first
      await soon(async () => answered(k) === 1, 30_000); // her card is answered: the next note goes in
      await soon(async () => notesIn(k).length === 2, 30_000);
      await wait(afterMs);
      link.go();
      await soon(async () => (await words(k)).includes(PASS), 30_000);
      assert.equal(cues(k).length, 0, 'never asked once more: her turn began before the second note went in');
      assert.deepEqual((await words(k)).filter((x) => x === PASS), [PASS], 'her answer to the second note, once');
      assert.deepEqual(await shown(k), [], 'annai showed nothing');
    } finally {
      w?.stop();
      link.restore();
      await k?.done();
    }
  });

  test(`Koe live: her only answer is a card, answered before the provider's end of that turn, an urgent reminder goes in after it, and her answer to it is bare: that end, ${what}, is no miss of the reminder, so she is asked once more first, and says it, once`, async () => {
    const link = slowLink();
    /** @type {any} */
    let k;
    try {
      k = await liveKit([{ tool: CARD }, { said: 'Silent.', audio: tone(0.3) }, { said, audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }], { pace: 1, agent: { secondMs: 1000 } });
      const asks = () => texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length;
      await k.voice.unlock();
      /** @type {number[]} */
      const askedAt = []; // the asks that had gone in as a reminder's card was raised
      k.agent.on('notice', (/** @type {any} */ n) => { if (n.title === 'Reminder') askedAt.push(asks()); });
      link.match = /"generationComplete"/;
      k.agent.send('Show me the bridge');
      await soon(async () => answered(k) === 1, 30_000); // her card is answered
      await k.agent.wake({ ...train(), urgent: true });
      await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('Train in 20 minutes')), 30_000); // it is with the session
      await wait(afterMs);
      link.go();
      await soon(async () => (await k.events(['reminder.told'])).length + (await entries(k)).length >= 1, 30_000);
      await idleAtOnce(k);
      assert.deepEqual(askedAt, [], 'annai showed nothing: she said it');
      assert.equal(asks(), 1, 'asked once more, once, after her bare answer');
      assert.deepEqual((await k.events(['reminder.told'])).map((/** @type {any} */ e) => e.data.reminders.map((/** @type {any} */ r) => r.text)), [[TRAIN]], 'written as told, once: she said it');
      assert.deepEqual(reminders(k.notices), [], 'no card for it');
    } finally {
      link.restore();
      await k?.done();
    }
  });
}

// The card's turn never gets its end from the provider, and her answer to the note is an empty turn (a turnComplete, no sound, no words, no call: what Gemini gives
// music, and what spec §7.1 plans for: "ends with no words ... it gets the same words once"). The card's turn is over at the page's answer (#endNow), so that empty
// turn is her answer to the note, and she is asked once more. Had the card's turn been kept as over with its end still to come (as a round of this fix did), the empty
// turn's end would have been read as the card's, and the note would have waited in flight until the quiet spell closed the session (300 s in these kits). The stand-in ends the card's turn only as the next text
// meets it, as Gemini does (interrupted, then its turnComplete 20 ms later), and the link holds that and her empty turn until the page's answer has gone out.
const EMPTY = {};

test('Koe live: her only answer to a note is a card whose end never comes, the next note goes in at its answer, and her answer to that is an empty turn: she is asked once more, and says it', async () => {
  const link = slowLink(); // before the session opens
  /** @type {any} */
  let k;
  /** @type {any} */
  let w;
  try {
    ({ k, w } = await quietSession([{ tool: CARD, noEnd: true }, EMPTY, { said: PASS, audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }]));
    link.match = /"generationComplete"/;
    await tell(k);
    await tell2(k); // waits behind the first
    await soon(async () => answered(k) === 1, 30_000); // her card is answered: the next note goes in
    await soon(async () => notesIn(k).length === 2, 30_000);
    link.go();
    // The ask once more went in at 252 ms in a probe, with the close 300 s on: this bound ends only a failing test.
    await soon(async () => cues(k).length === 1, 10_000).catch(() => assert.fail('never asked once more: her empty answer was read as the end of the card turn, and the note waits in flight for the session to close'));
    await soon(async () => (await words(k)).includes(PASS), 30_000);
    assert.deepEqual(await words(k), ['Hello there.', PASS], 'she said it, once');
    assert.equal(cues(k).length, 1, 'asked once more, once');
    assert.deepEqual(await shown(k), [], 'annai showed nothing');
  } finally {
    w?.stop();
    link.restore();
    await k?.done();
  }
});

test('Koe live: her only answer is a card whose end never comes, an urgent reminder goes in at its answer, and her answer to that is an empty turn: she is asked once more, and says it, once', async () => {
  const link = slowLink();
  /** @type {any} */
  let k;
  try {
    k = await liveKit([{ tool: CARD, noEnd: true }, EMPTY, { said, audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }], { pace: 1, agent: { secondMs: 1000 } });
    const asks = () => texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length;
    await k.voice.unlock();
    link.match = /"generationComplete"/;
    k.agent.send('Show me the bridge');
    await soon(async () => answered(k) === 1, 30_000); // her card is answered
    await k.agent.wake({ ...train(), urgent: true });
    await soon(async () => texts(k).some((/** @type {string} */ x) => x.includes('Train in 20 minutes')), 30_000); // it is with the session
    link.go();
    // Nothing of hers plays in the urgent mark, so it ends at its cap, 8 s past the reminder (URGENT_S, a real second here): the ask once more goes in then (8.0 s in a
    // probe), with the close 300 s on. This bound ends only a failing test.
    await soon(async () => (await k.events(['reminder.told'])).length + (await entries(k)).length >= 1, 30_000).catch(() => assert.fail(`the reminder reached no one (asked once more ${asks()}): her empty answer was read as the end of the card turn`));
    await idleAtOnce(k);
    assert.equal(asks(), 1, 'asked once more, once');
    assert.deepEqual((await k.events(['reminder.told'])).map((/** @type {any} */ e) => e.data.reminders.map((/** @type {any} */ r) => r.text)), [[TRAIN]], 'written as told, once: she said it');
    assert.deepEqual(reminders(k.notices), [], 'no card for it');
  } finally {
    link.restore();
    await k?.done();
  }
});

// The same rule where no call is involved: her answer to the first note is a line with no sound (bubbles, no voice), written as her turn ends (#complete), which lets
// the second note in (#said, #idle) before that turn is settled. Her turn began before the second went in: it is no miss of it, so nothing is asked once more.
test('Koe live: a note goes in as her line for the one before it is written, as her turn ends: that turn is no miss of it, so nothing is asked once more', async () => {
  const { k, w } = await quietSession([{ said: SAID, audio: tone(0.3) }, { said: PASS, audio: tone(0.3) }, { said: 'Silent.', audio: tone(0.3) }]);
  try {
    k.platform.player.stream = null; // no sound: her lines are bubbles, written as each turn ends
    await tell(k);
    await tell2(k); // waits for the first to be passed on
    await soon(async () => (await words(k)).includes(PASS) || cues(k).length > 0, 30_000);
    assert.equal(cues(k).length, 0, 'never asked once more');
    assert.deepEqual(await words(k), ['Hello there.', SAID, PASS], 'each note said once, in order');
    assert.deepEqual(await shown(k), [], 'annai showed nothing');
  } finally {
    w.stop();
    await k.done();
  }
});

// The ask once more is owed from her first bare answer, and waits behind the urgent mark (#idle); her second bare answer follows at once (andThen: the stand-in's next turn,
// with no input between), before the ask went in, so annai shows the reminder (#settle's unsaid branch). Shown, nothing is owed: the ask not yet gone in is stale and is never sent
// (it would have her say the reminder, and the card shows it too).
test('Koe live: an urgent reminder, her first bare answer owes the ask once more behind the urgent mark, and her second follows at once: annai shows it, and the ask is never sent', async () => {
  const k = await liveKit([{ said: 'Silent.', audio: tone(0.3), andThen: true }, { said: 'Silent.', audio: tone(0.3) }, { said, audio: tone(0.3) }], { pace: 1, agent: { secondMs: 1000 } });
  try {
    await k.voice.unlock();
    await k.agent.wake({ ...train(), urgent: true });
    await soon(async () => (await entries(k)).length === 1, 30_000); // her second bare answer: annai shows it
    // The stray ask went in 6 ms after the card in a probe, and her answer to it makes the dock speak: it listens again only once that is over, or if there was none.
    await soon(async () => k.agent.live.view.name === 'listening', 30_000);
    await idleAtOnce(k);
    assert.deepEqual(reminders(k.notices), [TRAIN], 'shown once');
    assert.equal(texts(k).filter((/** @type {string} */ x) => x.includes("hasn't reached the user")).length, 0, 'no ask once more: the reminder was shown, so nothing was owed');
    assert.deepEqual(await k.events(['reminder.told']), [], 'never written as told: she said none of it');
  } finally {
    await k.done();
  }
});

// Cut off before she passed it on (§10.4, §7.1): a tap while Koe is saying it, a line typed then, or a tap on an urgent reminder she hasn't begun shows what the
// traveller didn't hear at once, silently, and its entry settles the held copy. The session passed nothing on, so it writes no `reminder.told`.
for (const [what, turns, cut] of /** @type {[string, any[], (k: any) => Promise<void>][]} */ ([
  ['a tap while Koe is saying the reminder', [{ said, audio: tone(8) }], async (k) => {
    await sayingIt(k);
    assert.equal(k.agent.tap(), 'cut');
  }],
  ['a line typed while Koe is saying the reminder', [{ said, audio: tone(8) }, { said: 'From platform 4.', audio: tone(0.3) }], async (k) => {
    await sayingIt(k);
    k.agent.send('Which platform?', { typed: true });
  }],
  ['a tap on an urgent reminder Koe has not begun', [{ said, audio: tone(0.3), delayMs: 5000 }], async (k) => {
    await k.voice.unlock();
    await k.agent.wake({ ...train(), urgent: true }); // said now, the page in view: the session opens with the microphone
    await soon(async () => texts(k).length === 1 && k.agent.live.listening);
    assert.equal(k.agent.tap(), 'stopped');
  }],
])) {
  test(`Koe live: ${what}: a silent card and its entry now, no word from the session that it passed it on, and nothing at the next start`, async () => {
    const k = await liveKit(turns, { pace: 1 });
    try {
      await cut(k);
      await soon(async () => (await entries(k)).length === 1); // a tap holds the floor for the traveller for two seconds of the session's clock, 1 s in this kit (#holdForUser: 2 * max(500 ms, secondMs)): idle() waits that long
      assert.deepEqual(reminders(k.notices), [TRAIN], 'shown once');
      assert.equal(k.said.some((/** @type {string} */ x) => x.includes(TRAIN)), false, 'silently');
      assert.deepEqual(await k.events(['reminder.told']), []);
      const next = await nextStart(k, true);
      assert.deepEqual(reminders(next.cards), [], 'its entry settled it');
      assert.deepEqual(await entries(k), [TRAIN]);
    } finally {
      await k.done();
    }
  });
}
