// A write nobody waits on that fails says so, and what annai says itself is said before it is written (the storage-rest design, 2026-11-20): what
// is handed straight to a conversation that isn't open, or stopped before her turn took it, and a reminder's own entry, each refused, raise one
// card with the error, "Something for Shiori wasn't saved" (main.js shows the storage card in its place for a full phone); a reminder is shown and
// said whatever its entry's write does (spec §11.3: "shown or spoken directly").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip } from '../../src/core/scopes.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const NOT_SAVED = "Something for Shiori wasn't saved";
const LEAVE = 'Leave for the airport by 14:10';
/** The cards with a title. @param {any} k @param {string} title */
const titled = (k, title) => k.notices.filter((/** @type {any} */ n) => n.title === title);

for (const [what, wake] of /** @type {[string, (scope: string) => any][]} */ ([
  ['files added to it (bring-in)', (scope) => ({ kind: 'file', scope, files: ['/files/ticket.pdf'], text: 'New files: /trip/files/ticket.pdf' })],
  ['a hand-over of files alone', (scope) => ({ kind: 'user', scope, text: '(files)', handed: [{ path: '/trip/files/ticket.pdf', type: 'application/pdf', name: 'ticket.pdf', new: true }], handover: 'h-1' })],
  ["a watch's wake for a trip that isn't open", (scope) => ({ kind: 'trigger', scope, text: 'Your watch fired.' })],
])) {
  test(`${what}, handed straight to a conversation that isn't open and refused there: one card with the error, nothing given back, nothing left waiting`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]]);
    const store = refusing(k);
    const other = await createTrip(k.ws, { title: 'Kyoto' });
    store.full('all');
    await k.agent.wake(wake(other));
    const told = titled(k, NOT_SAVED);
    assert.equal(told.length, 1);
    assert.ok(told[0].error instanceof StorageFullError, 'the storage card shows in its place');
    assert.deepEqual(store.back, [], 'no typed words in it');
    await k.agent.idle();
    assert.equal(k.agent.busy, false);
  });
}

test("a tap she is still gathering when the user stops her, refused: a card says it wasn't saved, with the error (it has no box to go back to)", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  k.agent.typing(true);
  k.agent.send('Keep it', { chose: true });
  store.full('all');
  k.agent.interrupt();
  await k.agent.idle();
  assert.deepEqual(store.back, []);
  const told = titled(k, NOT_SAVED);
  assert.equal(told.length, 1);
  assert.ok(told[0].error instanceof StorageFullError);
});

/** Shiori as one, as two halves with Kokoro alone, and with Koe on a chat model (her reminders ride Koe's wake). */
const KOE = { talk: [say('Noted.')], type: [say('Noted.')] };
const MODES = /** @type {[string, any][]} */ ([['', {}], [' (Shiori as two halves, Kokoro only)', { halves: true }], [' (Shiori as two halves, Koe on)', { halves: true, koe: KOE }]]);

for (const [how, o] of MODES) {
  test(`a reminder on a phone too full to write it down is shown, then a card says it wasn't saved; nothing is thrown${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const store = refusing(k);
    store.full('all');
    await k.agent.remind([{ watch: 'w1', text: LEAVE }]);
    const shown = k.notices.map((/** @type {any} */ n) => n.title).filter((/** @type {string} */ x) => x === 'Reminder' || x === NOT_SAVED);
    assert.deepEqual(shown, ['Reminder', NOT_SAVED], 'shown first, then the refusal told');
    assert.equal(titled(k, 'Reminder')[0].body, LEAVE);
    assert.ok(titled(k, NOT_SAVED)[0].error instanceof StorageFullError);
    assert.deepEqual(await k.events(['reminder']), []);
    // Room again: the next one is written as ever.
    store.full(null);
    await k.agent.remind([{ watch: 'w2', text: 'Check out by 11' }]);
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), ['Check out by 11']);
    assert.equal(titled(k, NOT_SAVED).length, 1);
  });

  test(`a reminder riding a wake for the open conversation, whose turn the full phone stops at its first write, is shown once, before "Shiori stopped"${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const store = refusing(k);
    store.full('all');
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await until(() => titled(k, 'Shiori stopped').length > 0);
    await k.agent.idle();
    const titles = k.notices.map((/** @type {any} */ n) => n.title);
    assert.equal(titled(k, 'Reminder').length, 1, 'once');
    assert.equal(titled(k, 'Reminder')[0].body, LEAVE);
    // With Koe on, the reminder rides Koe's wake; Kokoro's own turn, woken beside it, may stop first, and Koe's same card is shown once (Halves).
    if (!o.koe) assert.ok(titles.indexOf('Reminder') < titles.indexOf('Shiori stopped'), 'before the turn that stopped is told');
    assert.equal(k.agent.busy, false);
  });
}

for (const [how, o] of MODES.slice(0, 2)) {
  test(`a typed line and a reminder queued for a conversation still opening when another is tapped, on a full phone: the reminder shows once, the line comes back, the open fails with the storage card, and a second try shows no second reminder${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Noted.')]], o);
    const store = refusing(k);
    const half = k.agent.kokoro ?? k.agent; // the loop's own queue, as the line reaches it while Kyoto opens
    const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
    const nara = await createTrip(k.ws, { title: 'Nara' });
    store.full('all');
    const toKyoto = k.agent.open(kyoto);
    half.send('Book the ryokan', { typed: true });
    half.enqueue({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    const failed = await k.agent.open(nara).then(() => null, (/** @type {unknown} */ e) => e);
    await toKyoto.catch(() => {});
    assert.ok(failed instanceof StorageFullError, "Nara didn't open: the storage card says so");
    assert.equal(titled(k, 'Reminder').length, 1);
    assert.deepEqual(store.back.map((x) => x.words), ['Book the ryokan'], 'the line is back in the box');
    assert.equal(store.back[0].error, failed, 'one refusal, one card');
    const again = await k.agent.open(nara).then(() => null, (/** @type {unknown} */ e) => e);
    assert.ok(again instanceof StorageFullError, "the watch's wake still waits for Kyoto");
    assert.equal(titled(k, 'Reminder').length, 1, 'no second reminder');
    assert.equal(store.back.length, 1);
    // Room again: Nara opens, and Kyoto has the watch's wake, once, and no reminder written twice.
    store.full(null);
    await k.agent.open(nara);
    await k.agent.idle();
    assert.equal(k.agent.trip, nara);
    const kept = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(kyoto, { types: ['wake', 'msg.user', 'reminder'] }));
    assert.deepEqual(kept.map((/** @type {any} */ e) => e.type), ['wake'], 'the line is in the traveller\'s hands, not written later');
    assert.equal(titled(k, 'Reminder').length, 1);
  });
}
