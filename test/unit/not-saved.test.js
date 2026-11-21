// A write nobody waits on that fails says so, and what annai says itself is said before it is written (the storage-rest design, 2026-11-20): what
// is handed straight to a conversation that isn't open, or stopped before her turn took it, and a reminder's own entry, each refused, raise one
// card with the error, "Something for Shiori wasn't saved" (main.js shows the storage card in its place for a full phone); a reminder is shown and
// said whatever its entry's write does (spec §11.3: "shown or spoken directly"), whichever way its wake fails on the way to a turn, and idle() waits
// for its entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until, holdAtDoor, holdReminders, holdEntries, settlesOnlyAfter, turnEnds, raw } from './agent-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const NOT_SAVED = "Something for Shiori wasn't saved";
const LEAVE = 'Leave for the airport by 14:10';
/** The cards with a title, as the screens get them (Halves drops a repeat of the card just before it, within 5 s). @param {any} k @param {string} title */
const titled = (k, title) => k.notices.filter((/** @type {any} */ n) => n.title === title);
/** @param {any[]} cards @param {string} title */
const count = (cards, title) => cards.filter((n) => n.title === title).length;

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
    k.agent.send('Where is Nepenthe?');
    await until(() => releases.length === 1); // her first request waits: the turn's first write is done
    store.full((ev) => ev.type === 'wake' && Boolean(ev.data.meanwhile));
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await new Promise((r) => setTimeout(r, 30)); // it is queued, to join at the end of her step
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

// A wake queued behind a turn that stops waits in the queue (no turn takes it up until the next wake): its reminders are annai's to show with the stopped
// turn's, once, and the wake stays queued as ever. A second watch's wake comes while the first one's turn waits to write its start.
for (const [how, o] of MODES.slice(0, 2)) {
  test(`a reminder in a wake queued behind a turn the full phone stops is shown with the stopped turn's, once: a later stop of a turn that takes that wake up shows it no second time${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const cards = raw(k);
    const store = refusing(k);
    store.full('all');
    let held = false;
    const door = holdAtDoor(k, (_stores, mode) => mode === 'readwrite' && !held && (held = true)); // the turn's first write, as on a phone slow to write
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => held);
    k.agent.wake({ kind: 'trigger', text: 'Another watch fired.', fallbacks: [{ watch: 'w2', text: 'Check out by 11' }] });
    await new Promise((r) => setTimeout(r, 30)); // queued behind the turn that has not started
    door.open();
    await until(() => titled(k, 'Shiori stopped').length > 0);
    assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE, 'Check out by 11'], "both shown, the turn's own first");
    assert.equal(k.agent.busy, true, 'the wake still waits for the next one, as ever');
    // The next wake takes the waiting one up with it, and the phone refuses that turn too: only its own reminder is new.
    k.agent.wake({ kind: 'trigger', text: 'A third watch fired.', fallbacks: [{ watch: 'w3', text: 'Dinner at 7' }] });
    await until(() => titled(k, 'Shiori stopped').length > 0 && count(cards, 'Reminder') >= 3);
    await k.agent.idle();
    assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE, 'Check out by 11', 'Dinner at 7'], 'the second watch\'s is not shown again');
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
    k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'tool.call' && e.data.name === 'sleep') k.agent.interrupt(); });
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    assert.equal(count(cards, 'Reminder'), 1, 'once');
    assert.deepEqual(k.said, [], 'silently: the Stop stops her, not the reminder');
  });

  // A page being left shows nothing: its next start answers (spec §6.7).
  test(`a turn the full phone stops while the page is being left shows no reminder: the next start answers${how}`, async (t) => {
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

// The exception the typed-line hand-back first accepted: a typed line and a reminder queued for a conversation still opening when another is tapped.
// With Koe talking they are in Koe's queue (Halves sends both there), not Kokoro's.
for (const [how, o] of MODES) {
  test(`a typed line and a reminder queued for a conversation still opening when another is tapped, on a full phone: the reminder shows once, the line comes back, the open fails with the storage card, and a second try shows no second reminder${how}`, async (t) => {
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
    const failed = await k.agent.open(nara).then(() => null, (/** @type {unknown} */ e) => e);
    await toKyoto.catch(() => {});
    assert.ok(failed instanceof StorageFullError, "Nara didn't open: the storage card says so");
    assert.equal(count(cards, 'Reminder'), 1);
    assert.deepEqual(store.back.map((x) => x.words), ['Book the ryokan'], 'the line is back in the box');
    assert.equal(store.back[0].error, failed, 'one refusal, one card');
    const again = await k.agent.open(nara).then(() => null, (/** @type {unknown} */ e) => e);
    assert.ok(again instanceof StorageFullError, "the watch's wake still waits for Kyoto");
    assert.equal(count(cards, 'Reminder'), 1, 'no second reminder');
    assert.equal(store.back.length, 1);
    // Room again: Nara opens, and Kyoto has the watch's wake, once, and no reminder written twice.
    store.full(null);
    await k.agent.open(nara);
    await k.agent.idle();
    assert.equal(k.agent.trip, nara);
    const kept = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(kyoto, { types: ['wake', 'msg.user', 'reminder'] }));
    assert.deepEqual(kept.map((/** @type {any} */ e) => e.type), ['wake'], 'the line is in the traveller\'s hands, not written later');
    assert.equal(count(cards, 'Reminder'), 1);
  });
}

// A refused wake kept for one conversation does not stop the lines typed for the next one from coming back (#keepWakes goes on over its scopes, and the
// first refusal is the one the open fails with): a watch's wake queued for Kyoto while it opens, then Nara tapped, and a line typed while Nara opens. Nara's
// open fails on Kyoto's wake first; the line waiting for Nara is handed back all the same, once, and never written there later.
for (const [how, o] of MODES) {
  test(`a line typed for the conversation being opened, queued behind another conversation's refused wake, comes back to the box: it is not held in memory${how}`, async (t) => {
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
    half.send('Book the ryokan', { typed: true }); // queued for Nara, whose open then fails on Kyoto's wake
    const failed = await toNara.then(() => null, (/** @type {unknown} */ e) => e);
    await toKyoto.catch(() => {});
    assert.ok(failed instanceof StorageFullError, "Nara didn't open: the storage card says so");
    assert.deepEqual(store.back.map((x) => x.words), ['Book the ryokan'], 'the line is in the traveller\'s hands again');
    assert.equal(store.back[0].error instanceof StorageFullError, true);
    assert.equal(count(cards, 'Reminder'), 1, "the watch's reminder is shown once");
    // Room again: Nara opens and Kyoto has the watch's wake, once; the line is not written anywhere (it is the traveller's, in the box).
    store.full(null);
    await k.agent.open(nara);
    await k.agent.idle();
    assert.equal(k.agent.trip, nara);
    assert.deepEqual((await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(kyoto, { types: ['wake', 'msg.user', 'reminder'] }))).map((/** @type {any} */ e) => e.type), ['wake']);
    assert.deepEqual(await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(nara, { types: ['msg.user'] })), [], 'nothing written for the line');
    assert.equal(count(cards, 'Reminder'), 1);
    assert.equal(store.back.length, 1, 'it came back once');
  });
}

// With Koe talking the split that follows a refused open (Kokoro in Nara, Koe still behind) made every line typed after it vanish the same way: each send
// asks Koe to open Nara again, and its keep stopped on Kyoto's wake. Now each comes back.
test("lines typed after a refused open, with Koe on and Kyoto's wake still waiting in its queue, each come back to the box", async (t) => {
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
  await toNara.catch(() => {});
  await toKyoto.catch(() => {});
  assert.deepEqual(store.back.map((x) => x.words), ['First line']);
  assert.equal(k.agent.kokoro.target, nara, 'Kokoro is in Nara: the screen follows it, and the traveller types there');
  k.agent.send('Second line', { typed: true });
  await until(() => store.back.length === 2);
  k.agent.send('Third line', { typed: true });
  await until(() => store.back.length === 3);
  assert.deepEqual(store.back.map((x) => x.words), ['First line', 'Second line', 'Third line']);
  assert.equal(store.back.every((x) => x.error instanceof StorageFullError), true);
  // Room again: the lines the traveller has in the box were written nowhere.
  store.full(null);
  await k.agent.open(nara);
  await k.agent.idle();
  assert.deepEqual(await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(nara, { types: ['msg.user'] })), []);
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

// Start fresh shows what waited behind the turn it stopped, silently, and idle() waits for it: Koe's half is not busy while Halves waits for it.
test("Start fresh in Koe · Classic, a reminder waiting behind the turn it stops is shown, and idle() settles once its entry is written", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: 'the user wrote', reply: { ...say('Sure.'), delayMs: 1500 } }, { match: '.', reply: sleep }] } } });
  const cards = raw(k);
  k.agent.send('Is Nepenthe open?');
  await until(() => (k.sent['model-koe']?.length ?? 0) >= 1); // Koe's slow turn is under way
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await new Promise((r) => setTimeout(r, 50)); // behind it, in Koe's queue
  let reminding = false;
  const koe = k.agent.koe;
  const remind = koe.remind.bind(koe);
  koe.remind = (/** @type {any[]} */ ...a) => {
    reminding = true;
    return remind(...a);
  };
  const door = holdReminders(k, koe); // its card's read waits at the door, as on a phone slow to read
  const fresh = k.agent.startFresh();
  await until(() => reminding);
  await settlesOnlyAfter(k, door, "idle() waits for the reminder Start fresh shows");
  assert.equal(await fresh, 'done');
  assert.equal(count(cards, 'Reminder'), 1, 'once');
  assert.deepEqual(await written(k), [LEAVE]);
});
