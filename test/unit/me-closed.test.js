import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, idleAtOnce } from './agent-kit.js';
import { record } from '../../src/core/agent/log.js';
import { ME } from '../../src/core/scopes.js';
import { useClock } from './clock.js';
import { openDraft } from '../../src/ui/plus.js';

// Timeline stage 7: `me`, the conversation outside any trip, takes no more turns (the user, 2026-11-05, "Read-only row": "You can read it; talking
// starts a new chat."), and with nothing else open the standing draft is (2026-11-14, "Open the new conversation (Recommended)"). The loop's one guard
// covers a draft that can't be made: with nothing open, no turn runs.

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const eventsIn = (/** @type {any} */ k, /** @type {string} */ scope, /** @type {string[]} */ types) => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types }));
/** A line of the user's in `me` with no reply, as an older annai left it: a turn owed there. @param {any} k */
const owedInMe = (k) => record(k.store, ME, { type: 'msg.user', actor: 'user', data: { wake: 'w-old' }, texts: [['text', 'Anything near Testville?']] });
const watchWake = { kind: 'trigger', text: 'A watch fired: "Call the Hotel Aurora Test".', fallbacks: [{ watch: 'w1', text: 'Call the Hotel Aurora Test.' }] };

test("an old turn owed in `me` and its watches, while a trip is open: the reminder is said and the wake written into `me`, with no request and no restart (Review Focus 2)", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Unused.')]]);
  await owedInMe(k);
  // Live mode says a reminder for a conversation that isn't open, then writes its wake there, carrying none (live.js #deliver): a wake written into a
  // conversation that isn't open shows the reminders it carries itself (#keepFor), so carrying them too would show them twice.
  await k.agent.remind(watchWake.fallbacks, ME);
  await k.agent.wake({ kind: watchWake.kind, text: watchWake.text, scope: ME });
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0);
  assert.deepEqual((await eventsIn(k, ME, ['reminder'])).map((e) => e.data.text), ['Call the Hotel Aurora Test.']);
  assert.deepEqual((await eventsIn(k, ME, ['wake'])).map((e) => e.data.reasons.map((/** @type {any} */ r) => r.kind)), [['trigger']]);
  assert.equal(k.notices.filter((n) => n.title === 'Reminder').length, 1);
});

test('with nothing open (no draft could be made), no turn runs: an owed turn in `me` gets no restart, and what comes is written there with its reminders said (the guard)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Unused.')]]);
  await owedInMe(k);
  await k.agent.open(null);
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0, 'no restart wake');
  // A watch firing in `me` with it "open" (live mode's path for the open conversation), and a line sent straight to the agent (a plugin's ui.shiori.send opens the draft first, plus.js, and gets here only when the draft's open fails).
  await k.agent.wake(watchWake);
  k.agent.send('Hello, with nothing open');
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0);
  assert.deepEqual((await eventsIn(k, ME, ['reminder'])).map((e) => e.data.text), ['Call the Hotel Aurora Test.']);
  assert.equal(k.notices.filter((n) => n.title === 'Reminder').length, 1);
  const kinds = (await eventsIn(k, ME, ['wake'])).flatMap((e) => e.data.reasons.map((/** @type {any} */ r) => r.kind));
  assert.deepEqual(kinds.sort(), ['trigger', 'user']);
  assert.deepEqual((await eventsIn(k, ME, ['msg.user'])).map((e) => e.data.text), ['Anything near Testville?', 'Hello, with nothing open']);
  assert.equal(k.agent.state.name, 'sleeping');
  // Opening a trip afterwards takes nothing of `me`'s up.
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0);
});

test("a trip removed while open leaves nothing owed in `me`: a turn under way is let go there (open(null, quiet)), and no restart wake is queued", async (t) => {
  useClock(t);
  const k = await agentKit([[{ delayMs: 300, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('x')]]);
  await owedInMe(k);
  k.agent.send('Hi');
  await until(() => k.requests.length === 1);
  await k.agent.open(null, { quiet: true });
  await idleAtOnce(k);
  assert.equal(k.requests.length, 1);
  assert.equal((await eventsIn(k, ME, ['wake', 'paused'])).length, 0);
});

test('openDraft opens the standing draft as the open conversation; with no draft possible it rejects, opening nothing and writing nothing into `me` (Review Focus 3)', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Unused.')]]);
  await k.agent.open(null);
  /** @type {any} */
  const ctx = { ws: k.ws, agent: k.agent, chats: { whenReady: () => Promise.reject(new Error('The store failed.')) } };
  await assert.rejects(openDraft(ctx), /The store failed/);
  assert.equal(k.agent.target, null);
  assert.equal((await eventsIn(k, ME, ['msg.user', 'wake'])).length, 0);
  ctx.chats.whenReady = () => Promise.resolve(k.trip);
  assert.equal(await openDraft(ctx), k.trip);
  assert.equal(k.agent.target, k.trip);
  assert.equal(k.agent.trip, k.trip, 'open once it resolves');
});
