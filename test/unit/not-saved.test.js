// A write nobody waits on that fails says so, and what annai says itself is said before it is written (the storage-rest design, 2026-11-20): what
// is handed straight to a conversation that isn't open, or stopped before her turn took it, and a reminder's own entry, each refused, raise one
// card with the error, "Something for Shiori wasn't saved" (main.js shows the storage card in its place for a full phone); a reminder is shown and
// said whatever its entry's write does (spec §11.3: "shown or spoken directly"), whichever way its wake fails on the way to a turn, and idle() waits
// for its entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until, holdAtDoor, holdReminders, settlesOnlyAfter } from './agent-kit.js';
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
/**
 * Each half's own cards, as they are raised: what a "shown once" counts, since Halves' own list drops a card identical to the one before it
 * (its #notice), which hides a double show. Made before anything runs. @param {any} k @returns {any[]}
 */
function raw(k) {
  /** @type {any[]} */
  const got = [];
  for (const half of k.agent.kokoro ? [k.agent.kokoro, k.agent.koe] : [k.agent]) half.on('notice', (/** @type {any} */ n) => got.push(n));
  return got;
}
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
      const told = cards.filter((n) => n.title === NOT_SAVED);
      assert.ok(told.length >= 1 && told.every((n) => n.error), 'the failure told, with its error');
      assert.ok(cards.findIndex((n) => n.title === 'Reminder') < cards.findIndex((n) => n.title === NOT_SAVED), 'shown before the failure is told');
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

// idle() waits for a reminder's entry: it is shown first and written after, so the write is behind the card, and the callers that don't wait for it
// themselves count it (#checking, Halves' #sending). The first two (admit's budgets) fail on the store's own timing, with no door; for the others
// the card or the entry waits at the door (agent-kit's holdAtDoor), as on a phone slow to read or write, and idle() must wait for it.
/** The reminders' entries. @param {any} k */
const written = async (k) => (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text);

test("a wake skipped for the hour's limit, its reminder shown by annai: idle() settles once the entry is written", async () => {
  const k = await agentKit([[say('Noted.')]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await k.agent.idle();
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide now.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await k.agent.idle();
  assert.equal(titled(k, 'Reminder').length, 1);
  assert.deepEqual(await written(k), [LEAVE]);
});

test("a wake held for quiet hours, its reminder shown by annai: idle() settles once the entry is written", async () => {
  const k = await agentKit([[say('Noted.')]], { agent: { now: () => Date.parse('2026-11-26T23:00:00Z') } });
  await updateAppSettings(k.ws, { shiori: { budgets: { quietHours: { from: '22:00', to: '07:00' } } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await k.agent.idle();
  assert.equal(k.requests.length, 0, 'held');
  assert.equal(titled(k, 'Reminder').length, 1);
  assert.deepEqual(await written(k), [LEAVE]);
});

test('a reminder a Stop shows for what she was still gathering: idle() settles once the entry is written', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  k.agent.typing(true);
  k.agent.send('Keep it', { chose: true }); // the user's tap holds her turn while they type
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await new Promise((r) => setTimeout(r, 5)); // queued behind the tap, within the 50 ms the typing counts for
  const door = holdReminders(k); // the card waits at the door, as on a phone slow to read: the Stop's own writes are done long before
  k.agent.interrupt();
  await settlesOnlyAfter(k, door, 'idle() waits for the reminder the Stop shows');
  assert.equal(titled(k, 'Reminder').length, 1);
  assert.deepEqual(await written(k), [LEAVE]);
});

test("a reminder shown while her question waits for the user's answer: idle() settles once the entry is written, though her turn ends first", async () => {
  const ask = { name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } };
  const k = await agentKit([[{ toolCalls: [ask] }, say('Moved it.')]]);
  k.agent.send('We are running late');
  await until(() => k.agent.pendingId !== null);
  // The first write from here is the reminder's entry: it waits at the door, as a phone slow to write makes it wait, while her turn goes on.
  let first = true;
  const door = holdAtDoor(k, (_stores, mode) => mode === 'readwrite' && first && !(first = false));
  k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
  await until(() => titled(k, 'Reminder').length === 1);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Move it');
  await settlesOnlyAfter(k, door, 'idle() waits for the entry still being written');
  assert.deepEqual(await written(k), [LEAVE]);
});
