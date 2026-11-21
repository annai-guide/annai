// A write nobody waits on that fails says so, and what annai says itself is said before it is written (the storage-rest design, 2026-11-20): what
// is handed straight to a conversation that isn't open, what waited for one the traveller left as another opens, what was stopped before her turn took
// it, and a reminder's own entry, each refused, raise one card with the error, "Something for Shiori wasn't saved" (main.js shows the storage card in its
// place for a full phone), and what wasn't kept is dropped with it, never held in memory (the step back's design check, 2026-11-20); a reminder is shown
// and said whatever its entry's write does (spec §11.3: "shown or spoken directly"), whichever way its wake fails on the way to a turn, and idle() waits
// for its entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until, holdAtDoor, holdReminders, holdEntries, settlesOnlyAfter, turnEnds, raw, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { ONE } from '../../src/core/agent/loop.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const NOT_SAVED = "Something for Shiori wasn't saved";
const LEAVE = 'Leave for the airport by 14:10';
/** The cards with a title, as the screens get them (Halves drops a repeat of the card just before it, within 5 s). @param {any} k @param {string} title */
const titled = (k, title) => k.notices.filter((/** @type {any} */ n) => n.title === title);
/** @param {any[]} cards @param {string} title */
const count = (cards, title) => cards.filter((n) => n.title === title).length;

/** Records the texts of the wakes a half queues, so a test waits for one to be queued rather than for a time. @param {any} half @returns {string[]} */
function queuedIn(half) {
  /** @type {string[]} */
  const texts = [];
  const enqueue = half.enqueue.bind(half);
  half.enqueue = (/** @type {any} */ w) => {
    texts.push(w.text);
    return enqueue(w);
  };
  return texts;
}

/** Shiori as one, as two halves with Kokoro alone, and with Koe on a chat model (her reminders ride Koe's wake). */
const KOE = { talk: [say('Noted.')], type: [say('Noted.')] };
const MODES = /** @type {[string, any][]} */ ([['', {}], [' (Shiori as two halves, Kokoro only)', { halves: true }], [' (Shiori as two halves, Koe on)', { halves: true, koe: KOE }]]);

// Shape 4 and the gathered Stop go through Kokoro as production builds it (Halves, Kokoro alone, when no Koe model is set), as well as one Shiori.
for (const [how, o] of MODES.slice(0, 2)) {
  for (const [what, wake] of /** @type {[string, (scope: string) => any][]} */ ([
    ['files added to it (bring-in)', (scope) => ({ kind: 'file', scope, files: ['/files/ticket.pdf'], text: 'New files: /trip/files/ticket.pdf' })],
    ['a hand-over of files alone', (scope) => ({ kind: 'user', scope, text: '(files)', handed: [{ path: '/trip/files/ticket.pdf', type: 'application/pdf', name: 'ticket.pdf', new: true }], handover: 'h-1' })],
    ["a watch's wake for a trip that isn't open", (scope) => ({ kind: 'trigger', scope, text: 'Your watch fired.' })],
  ])) {
    test(`${what}, handed straight to a conversation that isn't open and refused there: one card with the error, nothing given back, nothing left waiting${how}`, async (t) => {
      useClock(t);
      const k = await agentKit([[say('Noted.')]], o);
      const cards = raw(k);
      const store = refusing(k);
      const other = await createTrip(k.ws, { title: 'Kyoto' });
      store.full('all');
      await k.agent.wake(wake(other));
      const told = cards.filter((n) => n.title === NOT_SAVED);
      assert.equal(told.length, 1);
      assert.ok(told[0].error instanceof StorageFullError, 'the storage card shows in its place');
      assert.deepEqual(store.back, [], 'no typed words in it');
      await k.agent.idle();
      assert.equal(k.agent.busy, false);
    });
  }

  test(`a tap she is still gathering when the user stops her, refused: a card says it wasn't saved, with the error (it has no box to go back to)${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    k.agent.typing(true);
    k.agent.send('Keep it', { chose: true });
    await new Promise((r) => setTimeout(r, 5)); // Halves' route hands it to Kokoro, which gathers it while they type (50 ms)
    store.full('all');
    k.agent.interrupt();
    await k.agent.idle();
    assert.deepEqual(store.back, []);
    const told = cards.filter((n) => n.title === NOT_SAVED);
    assert.equal(told.length, 1);
    assert.ok(told[0].error instanceof StorageFullError);
  });
}

for (const [how, o] of MODES) {
  test(`a reminder on a phone too full to write it down is shown and said, then a card says it wasn't saved; nothing is thrown${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], { ...o, voice: { mode: 'on' } });
    const cards = raw(k);
    const store = refusing(k);
    store.full('all');
    await k.agent.remind([{ watch: 'w1', text: LEAVE }]);
    const shown = k.notices.map((/** @type {any} */ n) => n.title).filter((/** @type {string} */ x) => x === 'Reminder' || x === NOT_SAVED);
    assert.deepEqual(shown, ['Reminder', NOT_SAVED], 'shown first, then the refusal told');
    assert.equal(count(cards, 'Reminder'), 1, 'once');
    assert.equal(titled(k, 'Reminder')[0].body, LEAVE);
    assert.ok(titled(k, NOT_SAVED)[0].error instanceof StorageFullError);
    await until(() => k.said.length > 0); // the voice is asked without being waited for
    assert.deepEqual(k.said, [LEAVE], 'said aloud with the voice on, whatever the entry did');
    assert.deepEqual(await k.events(['reminder']), []);
    // Room again: the next one is written as ever.
    store.full(null);
    await k.agent.remind([{ watch: 'w2', text: 'Check out by 11' }]);
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), ['Check out by 11']);
    assert.equal(titled(k, NOT_SAVED).length, 1);
  });

  test(`a reminder riding a wake for the open conversation, whose turn the full phone stops at its first write, is shown once, and "Shiori stopped" is told once${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    store.full('all');
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'once, in each half\'s own cards');
    assert.equal(titled(k, 'Reminder')[0].body, LEAVE);
    // With Koe on, the reminder rides Koe's wake and Kokoro's own turn, woken beside it, stops first on a full phone: "Shiori stopped" comes before
    // the Reminder there, and each half's turn tells its own stop (main.js shows the one storage card for both: the same words replace). Not an issue
    // (the main session's ruling: each is shown once), so the counts are asserted and the order is one Shiori's.
    assert.equal(count(cards, 'Shiori stopped'), o.koe ? 2 : 1, "each half's turn stopped once");
    if (!o.koe) {
      const titles = k.notices.map((/** @type {any} */ n) => n.title);
      assert.ok(titles.indexOf('Reminder') < titles.indexOf('Shiori stopped'), 'before the turn that stopped is told');
    }
    assert.equal(k.agent.busy, false);
  });

  // The wake's route fails before any turn has it: its reminders are shown, once, and the failure is told. Reads refused (Chromium at no byte
  // free), or reads and writes: the route's first read fails, and with one Shiori the budgets' read does.
  for (const [shape, which] of /** @type {const} */ ([['reads and writes refused', 'everything'], ['reads refused', 'reads']])) {
    test(`a watch's wake with a reminder that fails before it reaches a turn (${shape}): the reminder is shown once and a card says what failed${how}`, async (t) => {
      useClock(t);
      const k = await agentKit([[say('Noted.')]], o);
      const cards = raw(k);
      const store = refusing(k);
      store.full(which);
      k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
      await k.agent.idle();
      assert.equal(count(cards, 'Reminder'), 1, 'shown once');
      assert.equal(cards.find((n) => n.title === 'Reminder').body, LEAVE);
      // One card per error object: the failed read always, and with writes refused too, the reminder's refused entry (the storage card in its place).
      const told = cards.filter((n) => n.title === NOT_SAVED);
      assert.deepEqual(told.map((n) => n.error?.name), which === 'everything' ? ['StorageFullError', 'UnknownError'] : ['UnknownError'], 'each failure told once, with its error');
      assert.ok(cards.findIndex((n) => n.title === 'Reminder') < cards.findIndex((n) => n.title === NOT_SAVED), 'shown before the failure is told');
      assert.equal(k.agent.busy, false);
    });
  }
}

// A cue is owed only until a model has it (a place alert, hers to say or let pass): when no model will, annai shows it, as a turn's end does when she never
// answered. A wake that fails before it reaches a turn has no model, so wakeFailed shows its cues with its reminders, the same as a turn that stops at
// its first write (#showOwed); the route keeps cues out only of the reminders it shows ahead of a session that will have them.
for (const [how, o] of MODES) {
  for (const [shape, which] of /** @type {const} */ ([['fails before it reaches a turn (reads refused)', 'reads'], ['whose turn stops at its first write (writes refused)', 'all']])) {
    test(`a watch's wake with a reminder and a cue, ${shape}: both are shown, once${how}`, async (t) => {
      useClock(t);
      const k = await agentKit([[say('Noted.')]], o);
      const cards = raw(k);
      const store = refusing(k);
      store.full(which);
      k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }, { watch: 'w2', text: 'The station is on your left.', cue: true }] });
      await until(() => cards.some((n) => n.title === 'Shiori stopped' || n.title === NOT_SAVED));
      await k.agent.idle();
      assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE, 'The station is on your left.'], 'once each, in the wake\'s order');
      assert.equal(k.agent.busy, false);
    });
  }
}

// The same, as WebKit's full phone gives it (writes refused, reads fine): Koe came back from its rest, so the route's own write, Kokoro's "Koe is
// speaking again" block, is what fails before the wake reaches a turn.
test("a watch's wake with a reminder, when Koe is back from its rest and the phone refuses the block that tells Kokoro so: the reminder is shown once, said, and a card says what failed", async (t) => {
  useClock(t);
  let clock = Date.parse('2026-11-26T12:00:00Z');
  const calls = (/** @type {string} */ name, /** @type {any} */ input) => ({ toolCalls: [{ name, input }, { name: 'sleep', input: {} }] });
  const k = await agentKit([{ rules: [
    { match: 'the user wrote', reply: calls('tell_koe', { text: 'Open till 10.' }) },
    { match: "Koe can't speak", reply: calls('speak', { text: 'Nepenthe is open till 10.' }) },
    { match: '.', reply: sleep },
  ] }], { halves: true, voice: { mode: 'on' }, koe: { type: [{ delayMs: 60, error: 'auth', message: 'bad key' }, say('Hello again.')] }, agent: { now: () => clock } });
  const cards = raw(k);
  const store = refusing(k);
  k.agent.send('Is Nepenthe open?');
  await k.agent.idle();
  assert.equal(k.agent.koeState, 'down', "Koe's list failed whole: it rests");
  clock += 10 * 60_000;
  k.llm.bench.clear('m-koe');
  store.full('all');
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await k.agent.idle();
  assert.equal(k.agent.koeState, 'text', 'Koe is back: the route has its block to write');
  assert.deepEqual((await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state), ['koe-down'], 'the block was refused');
  assert.equal(count(cards, 'Reminder'), 1, 'shown once');
  await until(() => k.said.includes(LEAVE)); // and said: the voice is asked without being waited for
  assert.ok(cards.some((n) => n.title === NOT_SAVED && n.error instanceof StorageFullError), 'the failure told, the storage card in its place');
});

// A turn that stops shows what it still owes, once, from one place (#turn): whichever of its later writes the phone refuses.
for (const [how, o] of MODES.slice(0, 2)) {
  test(`a reminder that joins a running turn, whose join the full phone refuses, is shown once before "Shiori stopped"${how}`, async (t) => {
    useClock(t);
    /** @type {(() => void)[]} */
    const releases = [];
    const k = await agentKit([[{ toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Done.')]], { ...o, hold: async () => { if (!releases.length) await new Promise((r) => releases.push(() => r(undefined))); } });
    const cards = raw(k);
    const store = refusing(k);
    const queued = queuedIn(k.agent.kokoro ?? k.agent);
    k.agent.send('Where is Nepenthe?');
    await until(() => releases.length === 1); // her first request waits: the turn's first write is done
    store.full((ev) => ev.type === 'wake' && Boolean(ev.data.meanwhile));
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => queued.includes('Your watch fired.')); // it is queued, to join at the end of her step
    releases[0]();
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'once');
    assert.equal(cards.find((n) => n.title === 'Reminder').body, LEAVE);
    const titles = k.notices.map((/** @type {any} */ n) => n.title);
    assert.ok(titles.indexOf('Reminder') < titles.indexOf('Shiori stopped'), 'before the turn that stopped is told');
    assert.equal(k.agent.busy, false);
  });

  test(`a reminder a turn owes when the write of its end is refused is shown once before "Shiori stopped"${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[sleep]], o);
    const cards = raw(k);
    const store = refusing(k);
    store.full((ev) => ev.type === 'turn.end');
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'once');
    const titles = k.notices.map((/** @type {any} */ n) => n.title);
    assert.ok(titles.indexOf('Reminder') < titles.indexOf('Shiori stopped'), 'before the turn that stopped is told');
    assert.equal(k.agent.busy, false);
  });

  test(`a reminder the user's Stop cut the turn on is shown once, and the refusal of the Stop's own record shows it no second time${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[sleep]], o);
    const cards = raw(k);
    const store = refusing(k);
    store.full((ev) => ev.type === 'error' && ev.data.kind === 'stopped');
    // The Stop lands as she goes to sleep: the end shows the reminder, then writes "stopped", which the phone refuses.
    k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'tool.call' && e.data.name === 'sleep') k.agent.interrupt(); });
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'taken once: the card of the failure that follows adds none');
    assert.equal(k.agent.busy, false);
  });
}

// A wake queued behind a turn that stops gets its own turn at once (#drain drains again, as every end of a busy spell does): its reminders and cues are its
// own, shown by that turn if it stops too, and nothing waits for a next wake. A second watch's wake comes while the first one's turn waits to write its start.
const CUE = 'The station is on your left.';
for (const [how, o] of MODES) {
  test(`a wake queued behind a turn the full phone stops gets its own turn at once: its reminder and its cue are shown once each, by its own turn, and nothing is left busy${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    const queued = queuedIn(o.koe ? k.agent.koe : (k.agent.kokoro ?? k.agent)); // with Koe on, the reminders ride Koe's wake
    store.full('all');
    let held = false;
    const door = holdAtDoor(k, (_stores, mode) => mode === 'readwrite' && !held && (held = true)); // the turn's first write, as on a phone slow to write
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => held);
    k.agent.wake({ kind: 'trigger', text: 'Another watch fired.', fallbacks: [{ watch: 'w2', text: 'Check out by 11' }, { watch: 'w3', text: CUE, cue: true }] });
    await until(() => queued.includes('Another watch fired.')); // queued behind the turn that has not started
    door.open();
    await until(() => count(cards, 'Reminder') === 3); // its own turn stops too, with no next wake to start it
    await idleAtOnce(k);
    assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE, 'Check out by 11', CUE], 'each once, each by its own turn');
    // Each half's turn tells its own stop, as above: with Koe on, both halves' two turns each.
    assert.equal(count(cards, 'Shiori stopped'), o.koe ? 4 : 2);
    // Each by its own turn: the first turn's stop is told before the second wake's reminders are shown, which no turn has yet (a queued wake's reminders
    // taken at the first turn's end, as #showOwed once did, would show them with its Reminder, before "Shiori stopped").
    const seq = cards.map((n) => (n.title === 'Reminder' ? n.body : n.title));
    assert.ok(seq.indexOf('Shiori stopped', seq.indexOf(LEAVE)) < seq.indexOf('Check out by 11'), 'the stopped turn is told before the wake behind it is shown');
    assert.equal(k.agent.busy, false, 'nothing waits for a next wake');
  });
}

// The drain goes on only after a turn that took wakes threw (the queue is then shorter): a throw before any turn took one, here a bug in the half's rule for
// how long to gather, is told once and doesn't drain again at once, which would throw again in a loop; the wake waits for the next one, as ever.
test("a throw before any turn took the wakes (a bug in the half's gather rule) is told once, with no drain again: the wake waits for the next one", async (t) => {
  useClock(t);
  let holds = 0;
  const half = { ...ONE, hold: () => {
    holds++;
    if (holds === 1) throw new TypeError('hold is broken');
    return 0;
  } };
  const k = await agentKit([[say('Noted.')]], { agent: { half } });
  const cards = raw(k);
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.' });
  await until(() => count(cards, 'Shiori stopped') === 1);
  assert.equal(holds, 1, 'not gathered again at once');
  assert.equal(k.requests.length, 0, 'no turn took it');
  k.agent.wake({ kind: 'trigger', text: 'Another watch fired.' });
  await until(() => k.requests.length === 1);
  await k.agent.idle();
  assert.ok(JSON.stringify(k.requests[0]).includes('Your watch fired.'), 'the next wake took the one that waited with it');
  assert.equal(count(cards, 'Shiori stopped'), 1);
});

for (const [how, o] of MODES.slice(0, 2)) {
  // Only the first turn's start is refused (a phone at its brim, room again after it): the wake behind it gets its own turn, which works, so its cue goes
  // to the model, as a cue is owed only until a model has it, and no card shows it. A cue reaches her in the wake's own text (live.js: the reasons, whose words
  // are not the card's), so the test's wake carries one and the request is checked for it.
  test(`a wake queued behind a turn that only the first write stopped gets its own turn at once: its cue goes to the model, not to a card${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    const queued = queuedIn(k.agent.kokoro ?? k.agent);
    let refused = false;
    store.full((ev) => ev.type === 'wake' && !refused && (refused = true));
    let held = false;
    const door = holdAtDoor(k, (_stores, mode) => mode === 'readwrite' && !held && (held = true));
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => held);
    const reason = 'A place watch fired: you are at the station.';
    k.agent.wake({ kind: 'trigger', text: reason, fallbacks: [{ watch: 'w3', text: CUE, cue: true }] });
    await until(() => queued.includes(reason));
    door.open();
    await until(() => k.requests.length === 1); // its own turn, at once
    await k.agent.idle();
    assert.ok(JSON.stringify(k.requests[0]).includes(reason), "the model has the wake, with the cue's reason");
    assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE], 'only the stopped turn\'s own reminder: the cue is the model\'s');
    assert.equal(count(cards, 'Shiori stopped'), 1);
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Noted.']);
    assert.equal(k.agent.busy, false);
  });
}

// A turn that fails in its setup, before its steps (the half's rules, its voice, the rules read again), shows its reminders too: the one place for every
// way a turn stops short. The phone at no byte free (Chromium) closes the connection at the first refused write, and every transaction after it fails,
// reads too: with Koe on and voice on, Kokoro's copy of the wake (it carries no reminders) writes first and is refused, and Koe's turn then fails reading
// the voice's settings.
for (const [how, o] of MODES) {
  for (const voice of [false, true]) {
    test(`a reminder a wake owes when the first refused write makes every read fail too (no byte free) is shown once, voice ${voice ? 'on' : 'off'}${how}`, async (t) => {
      useClock(t);
      const k = await agentKit([[say('Noted.')]], { ...o, ...(voice ? { voice: { mode: 'on' } } : {}) });
      const cards = raw(k);
      const store = refusing(k);
      store.full(() => {
        store.full('everything');
        return true;
      });
      k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
      await until(() => titled(k, 'Shiori stopped').length > 0);
      await k.agent.idle();
      assert.equal(count(cards, 'Reminder'), 1, 'once');
      assert.equal(cards.find((n) => n.title === 'Reminder').body, LEAVE);
      assert.equal(k.agent.busy, false);
    });
  }
}

// The same setup, with its reads refused from the start (the wake goes in past its budgets): the voice's read fails in the turn's setup, and her reminder is shown.
for (const [how, o] of MODES.slice(0, 2)) {
  test(`a reminder a wake owes, whose turn can't read the voice's settings as it starts, is shown once${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], { ...o, voice: { mode: 'on' } });
    const cards = raw(k);
    const store = refusing(k);
    store.full('reads');
    (k.agent.kokoro ?? k.agent).enqueue({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'once');
    assert.equal(k.agent.busy, false);
  });
}

// The user's Stop shows the reminder silently, whichever write of the end the phone then refuses: it is shown (the Stop stops her, not the reminder they
// set) and not said, once. Voice on, the Stop lands as she goes to sleep, and the write of the turn's end is refused.
for (const [how, o] of MODES.slice(0, 2)) {
  test(`a reminder the user's Stop cut the turn on, when the write of the turn's end is refused, is shown once and not said${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[sleep]], { ...o, voice: { mode: 'on' } });
    const cards = raw(k);
    const store = refusing(k);
    store.full((/** @type {any} */ ev) => ev.type === 'turn.end');
    // The voice is asked without being waited for: a spy on it sees an ask at once, which the speech it makes later would not show yet.
    /** @type {string[]} */
    const asked = [];
    const ask = k.voice.say.bind(k.voice);
    k.voice.say = (/** @type {string} */ text, /** @type {any[]} */ ...rest) => {
      asked.push(text);
      return ask(text, ...rest);
    };
    k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'tool.call' && e.data.name === 'sleep') k.agent.interrupt(); });
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'once');
    assert.deepEqual(asked, [], 'silently: the Stop stops her, not the reminder');
    assert.deepEqual(k.said, []);
  });

  // A page being left shows nothing: a card there reaches no one, and on a phone too full to write nothing records the reminder either (a known
  // limitation: a reminder that comes due as annai is being closed, on a full phone, isn't shown then).
  test(`a turn the full phone stops while the page is being left shows no reminder${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    store.full('all');
    k.agent.leaving();
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 0, 'not shown: no turn is left to tell, and the page is going');
    assert.equal(k.agent.busy, false);
  });
}

/** What a conversation's log holds of what was meant for it. @param {any} k @param {string} scope */
const keptIn = async (k, scope) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: ['wake', 'msg.user', 'reminder'] }))).map((/** @type {any} */ e) => e.type);

// What waited for a conversation the traveller left, refused as another opens, is told and dropped (#keepWakes, as #keepFor drops a wake for a closed
// conversation): its reminders are shown first, typed words come back to the box, the rest goes with the card, and nothing waits in memory, so the open
// works. A typed line and a reminder queued for Kyoto while it opens, then Nara tapped. With Koe talking they are in Koe's queue (Halves sends both there).
for (const [how, o] of MODES) {
  test(`a typed line and a reminder queued for a conversation still opening when another is tapped, on a full phone: that one opens, the reminder shows once, the line comes back, and nothing waits for Kyoto${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    const half = o.koe ? k.agent.koe : (k.agent.kokoro ?? k.agent); // the loop's own queue, as the line reaches it while Kyoto opens
    const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
    const nara = await createTrip(k.ws, { title: 'Nara' });
    store.full('all');
    const toKyoto = k.agent.open(kyoto);
    half.send('Book the ryokan', { typed: true });
    half.enqueue({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await k.agent.open(nara); // a refused keep fails no open
    await toKyoto;
    await idleAtOnce(k);
    assert.equal(k.agent.trip, nara, 'Nara is open');
    assert.equal(count(cards, 'Reminder'), 1);
    assert.deepEqual(store.back.map((x) => x.words), ['Book the ryokan'], 'the line is back in the box');
    // Two cards: the reminder's refused entry, and the keep, which carries the hand-back's own error (the storage card shows once for it).
    const told = cards.filter((n) => n.title === NOT_SAVED);
    assert.equal(told.length, 2);
    assert.ok(told.some((n) => n.error === store.back[0].error), 'the keep is told with the error the line came back with');
    assert.ok(told.every((n) => n.error instanceof StorageFullError));
    assert.equal(k.agent.busy, false, 'nothing waits for Kyoto');
    // A third open works too, and shows nothing again.
    await k.agent.open(kyoto);
    assert.equal(k.agent.trip, kyoto);
    assert.equal(count(cards, 'Reminder'), 1, 'no second reminder');
    assert.equal(store.back.length, 1);
    // Room again: nothing is written into Kyoto later; the line is in the traveller's hands.
    store.full(null);
    await k.agent.open(nara);
    await idleAtOnce(k);
    assert.deepEqual(await keptIn(k, kyoto), [], 'nothing written late');
    assert.equal(count(cards, 'Reminder'), 1);
  });
}

// A refused wake kept for one conversation stops nothing for the next one: a watch's wake queued for Kyoto while it opens, then Nara tapped, and a line typed
// while Nara opens. Kyoto's wake is told and dropped, Nara opens, and the line, queued for Nara, comes back from its own turn there, which the phone stops.
for (const [how, o] of MODES) {
  test(`a line typed for the conversation being opened, behind another conversation's refused wake: that one opens, the wake is told and dropped, and the line comes back from its own turn${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    const half = o.koe ? k.agent.koe : (k.agent.kokoro ?? k.agent); // the loop's own queue, as the wake and the line reach it while the conversations open
    const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
    const nara = await createTrip(k.ws, { title: 'Nara' });
    store.full('all');
    const toKyoto = k.agent.open(kyoto);
    half.enqueue({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] }); // queued for Kyoto
    const toNara = k.agent.open(nara);
    half.send('Book the ryokan', { typed: true }); // queued for Nara
    await toNara;
    await toKyoto;
    await until(() => store.back.length === 1);
    await idleAtOnce(k);
    assert.equal(k.agent.trip, nara, 'Nara is open');
    assert.deepEqual(store.back.map((x) => x.words), ['Book the ryokan'], 'the line is in the traveller\'s hands again');
    const stopped = cards.filter((n) => n.title === 'Shiori stopped');
    assert.ok(stopped.some((n) => n.error === store.back[0].error), 'from its own turn: the turn that stopped on it carries the same error');
    assert.equal(count(cards, 'Reminder'), 1, "the watch's reminder is shown once");
    assert.equal(cards.filter((n) => n.title === NOT_SAVED && n.error instanceof StorageFullError).length, 2, "the reminder's entry and Kyoto's wake are each told");
    assert.equal(k.agent.busy, false);
    // Room again: nothing is written later, in Kyoto or in Nara.
    store.full(null);
    await k.agent.open(nara);
    await idleAtOnce(k);
    assert.deepEqual(await keptIn(k, kyoto), []);
    assert.deepEqual(await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(nara, { types: ['msg.user'] })), [], 'nothing written for the line');
    assert.equal(count(cards, 'Reminder'), 1);
    assert.equal(store.back.length, 1, 'it came back once');
  });
}

// With Koe talking, a refused open once split the halves (Kokoro in Nara, Koe still behind), and every line typed after it vanished. Kyoto's wake in Koe's
// queue no longer fails Koe's open: both halves are in Nara, and each line typed after comes back from its own turn.
test("lines typed after Kyoto's wake in Koe's queue is refused as Nara opens, with Koe on: no split, and each comes back to the box", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]], { halves: true, koe: KOE });
  const store = refusing(k);
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  const nara = await createTrip(k.ws, { title: 'Nara' });
  store.full('all');
  const toKyoto = k.agent.open(kyoto);
  k.agent.koe.enqueue({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  const toNara = k.agent.open(nara);
  k.agent.koe.send('First line', { typed: true });
  await toNara;
  await toKyoto;
  await until(() => store.back.length === 1);
  assert.deepEqual([k.agent.kokoro.target, k.agent.koe.target], [nara, nara], 'both halves are in Nara');
  k.agent.send('Second line', { typed: true });
  await until(() => store.back.length === 2);
  k.agent.send('Third line', { typed: true });
  await until(() => store.back.length === 3);
  await idleAtOnce(k);
  assert.deepEqual(store.back.map((x) => x.words), ['First line', 'Second line', 'Third line']);
  assert.equal(store.back.every((x) => x.error instanceof StorageFullError), true);
  assert.equal(k.agent.busy, false);
  // Room again: the lines the traveller has in the box were written nowhere.
  store.full(null);
  await k.agent.open(nara);
  await idleAtOnce(k);
  assert.deepEqual(await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(nara, { types: ['msg.user'] })), []);
});

// Two conversations' refused keeps are each told: wakes queued for Kyoto and for Nara as each opened, then Osaka tapped, the phone refusing every write.
for (const [how, o] of MODES) {
  test(`wakes waiting for two conversations the traveller left, both refused as a third opens: each is told with its own card, and the third opens${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    const half = o.koe ? k.agent.koe : (k.agent.kokoro ?? k.agent);
    const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
    const nara = await createTrip(k.ws, { title: 'Nara' });
    const osaka = await createTrip(k.ws, { title: 'Osaka' });
    store.full('all');
    const opens = [k.agent.open(kyoto)];
    half.enqueue({ kind: 'file', text: 'New files: /trip/files/ryokan.pdf', files: ['/files/ryokan.pdf'] }); // for Kyoto
    opens.push(k.agent.open(nara));
    half.enqueue({ kind: 'file', text: 'New files: /trip/files/deer-park.pdf', files: ['/files/deer-park.pdf'] }); // for Nara
    await k.agent.open(osaka);
    await Promise.all(opens);
    await idleAtOnce(k);
    assert.equal(k.agent.trip, osaka);
    const told = cards.filter((n) => n.title === NOT_SAVED);
    assert.equal(told.length, 2, 'one card for each conversation');
    assert.ok(told.every((n) => n.error instanceof StorageFullError));
    assert.notEqual(told[0].error, told[1].error, 'each its own refusal');
    assert.equal(k.agent.busy, false);
    // Room again: nothing was kept to be written there later.
    store.full(null);
    await k.agent.open(kyoto);
    await idleAtOnce(k);
    assert.deepEqual(await keptIn(k, kyoto), []);
    assert.deepEqual(await keptIn(k, nara), []);
  });
}

// A watch's wake that comes through Halves while Koe talks is in both halves' queues (Kokoro's copy carries no reminder, Koe's does). The turn for an earlier
// wake is not under way yet (Koe's waits to write its start, as a phone slow to write makes it wait; Kokoro's comes after it), the second wake comes and
// queues in each half, then Nara is tapped on a full phone: each half's keep is refused and told once with its own card, the reminder is shown once, and
// nothing waits in either half.
test("a watch's wake in both halves' queues (Halves, Koe on) for a conversation left as Nara opens, refused: each half tells its keep once, the reminder shows once, and nothing waits", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]], { halves: true, koe: KOE });
  const store = refusing(k);
  const nara = await createTrip(k.ws, { title: 'Nara' });
  const inKokoro = queuedIn(k.agent.kokoro);
  const inKoe = queuedIn(k.agent.koe);
  /** @type {any[]} */
  const kokoroCards = [];
  /** @type {any[]} */
  const koeCards = [];
  k.agent.kokoro.on('notice', (/** @type {any} */ n) => kokoroCards.push(n));
  k.agent.koe.on('notice', (/** @type {any} */ n) => koeCards.push(n));
  store.full('all');
  let holding = true;
  let held = 0;
  const door = holdAtDoor(k, (_stores, mode) => holding && mode === 'readwrite' && ++held > 0);
  const first = k.agent.trip; // the conversation open, and left
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.' }); // Koe's turn waits to write its start
  await until(() => held >= 1);
  k.agent.wake({ kind: 'trigger', text: 'Another watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await until(() => inKokoro.length === 2 && inKoe.length === 2); // a copy in each half, behind its turn
  const toNara = k.agent.open(nara);
  holding = false;
  door.open();
  await toNara;
  await idleAtOnce(k);
  assert.equal(k.agent.trip, nara);
  const all = [...kokoroCards, ...koeCards];
  const of = (/** @type {any[]} */ cards, /** @type {string} */ title) => cards.filter((n) => n.title === title);
  assert.equal(of(kokoroCards, NOT_SAVED).length, 1, "Kokoro's copy is told once");
  assert.equal(of(koeCards, NOT_SAVED).length, 2, "Koe's: the reminder's entry, and its copy, each told once");
  assert.ok(all.filter((n) => n.title === NOT_SAVED).every((n) => n.error instanceof StorageFullError));
  assert.equal(count(all, 'Reminder'), 1, 'the reminder is shown once, by the half that carries it');
  assert.equal(of(koeCards, 'Reminder')[0].body, LEAVE);
  assert.equal(k.agent.busy, false, 'nothing waits in either half');
  // Room again: neither copy was kept to be written into the conversation left later.
  store.full(null);
  await k.agent.open(first);
  await k.agent.idle();
  assert.deepEqual(await keptIn(k, first), []);
});

// The kept wake says its reminder was shown: a watch's wake queued for Kyoto as it opens, Nara tapped, and only the reminder's entry refused. The wake is
// written into Kyoto with annai's word that it showed the reminder, so her turn there doesn't tell the traveller again.
test("a watch's wake kept for a conversation the traveller left, whose reminder annai showed, says so in that conversation, even when the reminder's entry is refused", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const cards = raw(k);
  const store = refusing(k);
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  const nara = await createTrip(k.ws, { title: 'Nara' });
  store.full((ev) => ev.type === 'reminder');
  const toKyoto = k.agent.open(kyoto);
  k.agent.enqueue({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] }); // queued for Kyoto
  await k.agent.open(nara);
  await toKyoto;
  await k.agent.idle();
  assert.equal(count(cards, 'Reminder'), 1);
  assert.equal(count(cards, NOT_SAVED), 1, "the reminder's entry, told");
  const [wake] = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(kyoto, { types: ['wake'] }));
  assert.equal(wake.data.reasons[0].text, 'Your watch fired. (annai has already shown the user its reminder.)');
});

// idle() waits for a reminder's entry: it is shown first and written after, so the write is behind the card, and the callers that don't wait for it
// themselves count it (#checking, Halves' #sending). The entry's write waits at the door (agent-kit's holdEntries: the first write after the card, as on a
// phone slow to write) and idle() must wait for it: the store's own queue would show the entry to whoever looks, and hide a wait that doesn't count it.
// The rest of the work (her turn's end) is done before idle() is looked at, so the wait that is seen is the door's.
/** The reminders' entries. @param {any} k */
const written = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);

test("a wake skipped for the hour's limit, its reminder shown by annai: idle() settles once the entry is written", async () => {
  const k = await agentKit([[say('Noted.')]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await k.agent.idle();
  const door = holdEntries(k);
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide now.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await until(() => titled(k, 'Reminder').length === 1);
  await settlesOnlyAfter(k, door, 'idle() waits for the entry still being written');
  assert.deepEqual(await written(k), [LEAVE]);
});

test("a wake held for quiet hours, its reminder shown by annai: idle() settles once the entry is written", async () => {
  const k = await agentKit([[say('Noted.')]], { agent: { now: () => Date.parse('2026-11-26T23:00:00Z') } });
  await updateAppSettings(k.ws, { shiori: { budgets: { quietHours: { from: '22:00', to: '07:00' } } } });
  const door = holdEntries(k);
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await until(() => titled(k, 'Reminder').length === 1);
  await settlesOnlyAfter(k, door, 'idle() waits for the entry still being written');
  assert.equal(k.requests.length, 0, 'held');
  assert.deepEqual(await written(k), [LEAVE]);
});

test('a reminder a Stop shows for what she was still gathering: idle() settles once the entry is written', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  k.agent.typing(true);
  k.agent.send('Keep it', { chose: true }); // the user's tap holds her turn while they type
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await new Promise((r) => setTimeout(r, 5)); // queued behind the tap, within the 50 ms the typing counts for
  const door = holdEntries(k); // the entry waits at the door, as on a phone slow to write: the Stop's own writes come first
  k.agent.interrupt();
  await until(() => titled(k, 'Reminder').length === 1);
  await settlesOnlyAfter(k, door, 'idle() waits for the reminder the Stop shows, entry and all');
  assert.deepEqual(await written(k), [LEAVE]);
});

test("a reminder shown while her question waits for the user's answer: idle() settles once the entry is written, though her turn ends first", async () => {
  const ask = { name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } };
  const k = await agentKit([[{ toolCalls: [ask] }, say('Moved it.')]]);
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  const door = holdEntries(k); // the reminder's entry waits at the door, as a phone slow to write makes it wait, while her turn goes on
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await until(() => titled(k, 'Reminder').length === 1);
  const ended = turnEnds(k);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await settlesOnlyAfter(k, door, 'idle() waits for the entry still being written', () => ended);
  assert.deepEqual(await written(k), [LEAVE]);
});

// Start fresh shows what waited behind the turn it stopped, silently, and idle() waits for its entry: Koe's half is not busy while Halves waits for it. Its
// card's read waits at the door until the waiting wake is written down as stopped, so the first write after the card is the entry's, held at a second door.
test("Start fresh in Koe · Classic, a reminder waiting behind the turn it stops is shown, and idle() settles once its entry is written", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: 'the user wrote', reply: { ...say('Sure.'), delayMs: 1500 } }, { match: '.', reply: sleep }] } } });
  const cards = raw(k);
  const koe = k.agent.koe;
  const queued = queuedIn(koe);
  k.agent.send('Is Nepenthe open?');
  await until(() => (k.sent['model-koe']?.length ?? 0) >= 1); // Koe's slow turn is under way
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await until(() => queued.includes('Your watch fired.')); // behind it, in Koe's queue
  // The waiting wake's own stop record: the turn's own "stopped" (the user's Stop) comes before it, and is not what the door waits for.
  let watchWake = '';
  let stopped = false;
  koe.on('event', (/** @type {any} */ e) => {
    if (e.type === 'wake' && e.data.reasons.some((/** @type {any} */ r) => r.text.includes('Your watch fired.'))) watchWake = e.data.id;
    if (e.type === 'error' && e.data.kind === 'stopped' && e.data.quiet && watchWake && e.data.wake === watchWake) stopped = true;
  });
  const cardDoor = holdReminders(k, koe); // its card's read waits at the door, as on a phone slow to read
  const fresh = k.agent.startFresh();
  await until(() => cardDoor.reached() && stopped); // the waiting wake is written down as stopped: nothing else of Start fresh writes before the entry
  const entryDoor = holdEntries(k);
  cardDoor.open();
  await until(() => entryDoor.cardShown());
  assert.equal(koe.busy, true, "Koe's half is busy for the entry it waits for (Kokoro's writes are behind it in Halves' lock, so only this tells the entry is awaited)");
  await settlesOnlyAfter(k, entryDoor, "idle() waits for the entry of the reminder Start fresh shows");
  assert.equal(await fresh, 'done');
  assert.equal(count(cards, 'Reminder'), 1, 'once');
  assert.deepEqual(await written(k), [LEAVE]);
});
