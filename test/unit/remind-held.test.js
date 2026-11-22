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
import { agentKit, until, idleAtOnce, inTime, holdAtDoor, raw } from './agent-kit.js';
import { liveKit, soon, tone, texts } from './koe-live-kit.js';
import { useClock } from './clock.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Halves } from '../../src/core/agent/halves.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record } from '../../src/core/agent/log.js';
import { ME, createTrip, removeTrip } from '../../src/core/scopes.js';
import { readConfig, saveRoles } from '../../src/core/llm/config.js';

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

// The wake is held for the conversation it is for (#push's scope is the target's): one that comes as that conversation is being opened is in its log, not
// in the one still open. Only one Shiori queues it then: Halves' route holds a wake behind an open under way (its refresh waits for the open), so it is
// not in a queue yet, which the Deferred entry "A reminder in memory can still be lost in annai's first seconds" names.
test("a watch's wake queued while its conversation is opening as the page is killed: it is held in that conversation's log, not the one still open, and the next start shows its reminder once", async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]]);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  const slow = slowOpen(k);
  slow.shut();
  const opening = k.agent.open(other);
  await until(slow.held); // the open waits on its first read of the log
  k.agent.wake(fired());
  await settled();
  assert.deepEqual(await heldIn(k, other), [LEAVE], 'held in the conversation being opened');
  assert.deepEqual(await heldIn(k), [], 'not in the one still open');
  const next = await nextStart(k, false, other);
  assert.deepEqual(reminders(next.cards), [LEAVE]);
  assert.deepEqual(await entries(k, other), [LEAVE]);
  slow.open();
  await opening;
  await idleAtOnce(k);
});

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
// conversation it was typed for, never the one being left (the code re-read's F1).
test("Koe on, then off, another conversation opening, a line typed, then Undo's or Erase's Stop: the line and its stopped are written in the conversation it was typed for", async (t) => {
  useClock(t);
  const k = await agentKit([[asleep]], { koe: { type: [asleep] } });
  await idleAtOnce(k);
  assert.equal(k.agent.koe.target, k.trip, 'Koe has had this conversation open');
  await saveRoles(k.ws, { ...(await readConfig(k.ws)).roles, 'koe-classic': { models: [], level: 'off' } });
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  const slow = slowOpen(k);
  slow.shut();
  const opening = k.agent.open(other);
  await until(slow.held);
  k.agent.send('Is the temple open?', { typed: true });
  await settled(); // in Kokoro's queue, for the conversation being opened
  assert.equal(k.agent.kokoro.scope, k.trip, 'the one being left is still open: Kokoro waits on its first read of the other');
  k.agent.stopKokoro();
  await idleAtOnce({ agent: k.agent.kokoro });
  const log = async (/** @type {string} */ scope, /** @type {string} */ type) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: [type] }))).map((/** @type {any} */ e) => e.data.text ?? e.data.kind);
  assert.deepEqual([await log(other, 'msg.user'), await log(other, 'error')], [['Is the temple open?'], ['stopped']], 'in the conversation it was typed for');
  assert.deepEqual([await log(k.trip, 'msg.user'), await log(k.trip, 'error')], [[], []], 'nothing in the one being left');
  slow.open();
  await opening;
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0, 'nothing answers it');
});

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
      await soon(async () => (await entries(k)).length === 1); // a tap holds the floor for the traveller for 2 s (#holdForUser): idle() waits that long
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
