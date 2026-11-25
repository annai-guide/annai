// One row per way a turn of hers ends (the turn-end record, docs/superpowers/plans/2026-11-14-turn-end-record.md §1): what the log holds for
// the turn (turn.end with the hand-over it carried, an error's kind, a paused line), what a reload reads (owed, what waits, the hand-over still
// owed), and for a turn cut at its work, that the next open takes it up once with its hand-over. One Shiori with a hand-over (h-1), but for Koe's
// row 5; row 6 (annai takes Koe's owed notes at a switch) is halves.test.js's switch test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, idleAtOnce } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { record, TALK_TAG } from '../../src/core/agent/log.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { createTrip } from '../../src/core/scopes.js';
import { Agent } from '../../src/core/agent/loop.js';
import { NETWORK_RETRIES, OVERLOAD_RETRIES } from '../../src/core/llm/fallback.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { undoHandover } from '../../src/core/handover.js';
import { useClock } from './clock.js';

const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const say = (/** @type {string} */ text) => ({ toolCalls: [speak(text), sleep] });
const ask = { name: 'ask', input: { question: 'File it in Notes?', options: ['Yes', 'No'] } };
const failing = { name: 'read', input: { path: '/trip/nope/missing.md' } };
const linger = { name: 'linger', input: {} };
const fails = { error: 'server', status: 500, message: 'Scripted failure.' };
const flight = { path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
const files = { toolCalls: [{ name: 'write', input: { path: '/trip/notes/f.md', content: 'AS 123' } }, speak('Filed.'), sleep] };

/** The user hands her a file with a line: hand-over h-1. @param {any} k */
const hand = (k) => k.agent.send('Here is my flight', { handed: [flight], handover: 'h-1' });
/** What the log holds of the turns' ends, in order. @param {any} k @param {string} [scope] */
const ends = async (k, scope = k.trip) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: ['turn.end', 'error', 'paused'] })))
  .map((/** @type {any} */ e) => (e.type === 'turn.end' ? `turn.end:${e.data.handover}` : e.type === 'error' ? `error:${e.data.kind}` : 'paused'));
/** What a reload reads: owed, what waits (read only when owed), and the hand-over still owed. @param {any} k @param {string} [scope] */
const reads = async (k, scope = k.trip) => {
  const t = await Transcript.load(k.store, scope);
  return [t.unanswered, t.unanswered ? t.waiting : '', t.owedHandover];
};
/** Her writes, with the hand-over each carries. @param {any} k */
const hers = async (k) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['file.write'] }))).filter((/** @type {any} */ e) => e.actor === 'shiori').map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]);
/** A loop tool that takes a minute: a cut lands in it. @param {any} k */
const slow = (k) => {
  const at = { lingering: false };
  k.agent.addLoopTools([{ name: 'linger', pluginId: 'core', group: 'Time', description: 'Wait.', input: { type: 'object' }, run: async () => { at.lingering = true; await new Promise((r) => setTimeout(r, 60_000)); return 'Done.'; } }]);
  return at;
};
/** Another conversation opened, and come back to: the requests the return made. @param {any} k @param {() => Promise<unknown>} [cut] what opens it */
const away = async (k, cut) => {
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  await (cut ? cut() : k.agent.open(B));
  await idleAtOnce(k);
  const before = k.requests.length;
  return { A, B, back: async () => { await k.agent.open(A); await idleAtOnce(k); return k.requests.length - before; } };
};

test('row 1: a reply in words, the nudge declining (she had spoken): the loop logs her end, and the hand-over is answered', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [speak('On it.')] }, { text: 'Done.' }]]);
  hand(k);
  await idleAtOnce(k);
  assert.deepEqual(await ends(k), ['turn.end:h-1']);
  assert.deepEqual(await reads(k), [false, '', null]);
});

test('row 2: asleep, the nudge declining: the loop logs her end, and the hand-over is answered', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Filed.')]]);
  hand(k);
  await idleAtOnce(k);
  assert.deepEqual(await ends(k), ['turn.end:h-1']);
  assert.deepEqual(await reads(k), [false, '', null]);
});

test('row 3: silent once, the cue, then she speaks and sleeps: one end, the hand-over answered', async (t) => {
  useClock(t);
  const k = await agentKit([[{ text: 'Filing it.' }, say('Filed.')]]);
  hand(k);
  await idleAtOnce(k);
  assert.match(k.requests[1].tail, /The user hasn't been answered/);
  assert.deepEqual(await ends(k), ['turn.end:h-1']);
  assert.deepEqual(await reads(k), [false, '', null]);
});

test('row 4: silent twice, "Shiori didn\'t answer": its error is the end, and the hand-over stays owed for Try again', async (t) => {
  useClock(t);
  for (const reply of [{ text: 'Filing it.' }, { toolCalls: [sleep] }]) {
    const k = await agentKit([[reply, reply]]);
    hand(k);
    await idleAtOnce(k);
    assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), ["Shiori didn't answer"]);
    assert.deepEqual(await ends(k), ['error:silent']);
    assert.deepEqual(await reads(k), [false, '', 'h-1']);
  }
});

test("row 5: Koe after its cue and two more steps, only Kokoro's notes owed: Koe's end is logged (annai's backstop shows the note), and reopening owes Koe nothing", async () => {
  const more = Array.from({ length: 40 }, (_, j) => ({ toolCalls: [{ name: 'tell_kokoro', input: { text: `More ${j}` } }] }));
  const CHECK = { toolCalls: [speak('Let me check.'), { name: 'tell_kokoro', input: { text: 'Is it open?' } }, { name: 'wait', input: { seconds: 600 } }] };
  const kokoro = [{ toolCalls: [{ name: 'tell_koe', input: { text: 'Say: it is open.', for_user: 'It is open.' } }, sleep] }];
  const k = await agentKit([kokoro], { koe: { type: [CHECK, ...more] } });
  k.agent.send('Is Nepenthe open?');
  await idleAtOnce(k);
  assert.equal(k.sent['model-koe'].length, 4, 'the step that owed, then two more after the cue');
  const koe = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(k.trip, { types: ['turn.end', 'error'] }))).filter((/** @type {any} */ e) => e.data.half === 'koe');
  assert.deepEqual(koe.map((/** @type {any} */ e) => `${e.type}:${e.data.kind ?? e.data.handover}`), ['turn.end:null']);
  assert.equal((await Transcript.load(k.store, k.trip, { half: 'koe' })).unanswered, false);
  // The user's own words owed too (a line typed into Koe's wait): the silent card instead, and no end of Koe's.
  const w = await agentKit([[{ delayMs: 300, ...kokoro[0] }, { toolCalls: [sleep] }]], { koe: { type: [CHECK, ...more] } });
  w.agent.send('Is Nepenthe open?');
  await until(() => w.agent.koe.waiting);
  w.agent.send('And tomorrow?');
  await idleAtOnce(w);
  const koeW = (await w.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(w.trip, { types: ['turn.end', 'error'] }))).filter((/** @type {any} */ e) => e.data.half === 'koe');
  const first = koeW.filter((/** @type {any} */ e) => e.data.wake === koeW[0].data.wake); // Kokoro's note, come later, is a Koe turn of its own
  assert.deepEqual(first.map((/** @type {any} */ e) => `${e.type}:${e.data.kind ?? e.data.handover}`), ['error:silent']);
});

test('row 7: killed after a reply with no calls (a plain-text reply before the nudge decided, or a reply the provider paused): owed, and the open takes it up once with the hand-over', async (t) => {
  useClock(t);
  for (const paused of [false, true]) {
    const k = await agentKit([[files]], { open: false });
    await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }] } });
    await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Here is my flight', wake: 'w-0', handed: [flight], handover: 'h-1' } });
    const info = { role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0', handover: 'h-1', endLogged: true, ...(paused ? { stop: 'pause' } : {}) };
    await modelTrace(k.store, k.trip).turn(/** @type {any} */ (info), 'Looking at it.', '', [{ type: 'text', text: 'Looking at it.' }]);
    assert.deepEqual(await reads(k), [true, '', 'h-1'], paused ? 'paused' : 'plain text');
    await k.agent.open(k.trip);
    await idleAtOnce(k);
    const restarts = (await k.events(['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).filter((/** @type {any} */ r) => r.kind === 'restart');
    assert.equal(restarts.length, 1);
    assert.match(restarts[0].text, /^annai restarted before you answered\./);
    assert.equal(restarts[0].handover, 'h-1');
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']]);
  }
});

test('row 8: a sleep that gave way (a failed call, or her question came back): no end yet; a reload reads her turn under way, the hand-over owed', async (t) => {
  useClock(t);
  for (const first of [[failing, sleep], [ask, sleep]]) {
    const k = await agentKit([[{ toolCalls: first }, { delayMs: 300, ...say('Filed.') }]]);
    hand(k);
    if (first[0] === ask) {
      await until(() => k.agent.pendingId !== null);
      k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'Yes');
    }
    await until(() => k.requests.length === 2);
    assert.deepEqual(await ends(k), []);
    assert.deepEqual(await reads(k), [true, 'turn', 'h-1']);
    await idleAtOnce(k);
    assert.deepEqual(await ends(k), ['turn.end:h-1']);
  }
});

test('row 9: a budget, a stuck loop, every model failing, a tidy-up that failed: each its error, the end; the hand-over stays owed', async (t) => {
  useClock(t);
  const list = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  // A budget of one step a wake.
  const b = await agentKit([[{ toolCalls: [failing] }, say('Never.')]]);
  await updateAppSettings(b.ws, { shiori: { budgets: { stepsPerWake: 1 } } });
  hand(b);
  await idleAtOnce(b);
  // The same call three times with the same result.
  const s = await agentKit([[list, list, list, say('Never.')]]);
  hand(s);
  await idleAtOnce(s);
  // Every model failing.
  const m = await agentKit([[fails, fails, fails, fails]]);
  hand(m);
  await idleAtOnce(m);
  // The tidy-up the turn can't go on without fails (the request too long, then the utility model's call refused).
  const c = await agentKit([[say('one'), say('two'), { error: 'context', status: 413, message: 'prompt is too long' }]], { utility: [{ text: 'Summary.' }] });
  const was = c.llm.call;
  c.llm.call = async (/** @type {any} */ x) => {
    if (x.record?.tag !== 'compaction') return was(x);
    throw new ProviderError('server', 'Scripted failure.');
  };
  for (const line of ['first', 'second']) { c.agent.send(line); await idleAtOnce(c); }
  hand(c);
  await idleAtOnce(c);
  for (const [k, kind, before] of /** @type {[any, string, string[]][]} */ ([[b, 'budget', []], [s, 'stuck', []], [m, 'model', []], [c, 'compaction', ['turn.end:null', 'turn.end:null']]])) {
    assert.deepEqual(await ends(k), [...before, `error:${kind}`], kind);
    assert.deepEqual(await reads(k), [false, '', 'h-1'], kind);
  }
});

test("row 10: the user's Stop during a tool: its error alone, the hand-over owed to their next line; landing on the reply's sleep with every other call done: her end too, the hand-over answered", async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [speak('Filing it.'), linger, sleep] }, files]]);
  const at = slow(k);
  hand(k);
  await until(() => at.lingering);
  k.agent.interrupt();
  await idleAtOnce(k);
  assert.deepEqual(await ends(k), ['error:stopped']);
  assert.deepEqual(await reads(k), [false, '', 'h-1']);
  k.agent.send('Put it in Notes');
  await idleAtOnce(k);
  assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']], 'their next line carries it');
  // The Stop lands as the sleep is called.
  const s = await agentKit([[say('Filed.'), say('Never.')]]);
  s.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'tool.call' && e.data.name === 'sleep') s.agent.interrupt(); });
  hand(s);
  await idleAtOnce(s);
  assert.deepEqual(await ends(s), ['turn.end:h-1', 'error:stopped']);
  assert.deepEqual(await reads(s), [false, '', null]);
});

test('row 11: an open while her card waits, let go: its error, nothing taken up on return; the hand-over owed to their next line', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [ask] }, files]]);
  hand(k);
  await until(() => k.agent.pendingId !== null);
  const { back } = await away(k);
  assert.deepEqual(await ends(k), ['error:left']);
  assert.deepEqual(await reads(k), [false, '', 'h-1']);
  assert.equal(await back(), 0);
  k.agent.send('Yes, Notes');
  await idleAtOnce(k);
  assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']]);
});

test('row 12: an open that cuts her at work (in a call, between steps, in her model call): no end, the paused line, and the return takes it up once with the hand-over', async (t) => {
  useClock(t);
  const list = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  /** @type {[string, any[], (k: any, open: () => void) => Promise<void>][]} her replies, and when the open comes */
  const ways = [
    ['in a call', [{ toolCalls: [speak('Filing it.'), linger, sleep] }, files], async (k, open) => { const at = slow(k); hand(k); await until(() => at.lingering); open(); }],
    // As the last result of a reply without a sleep is logged: the step's end, before her next model call.
    ['between steps', [list, files], async (k, open) => { k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'tool.result' && e.data.name === 'list') open(); }); hand(k); }],
    ['in her model call', [list, { delayMs: 300, ...say('Never.') }, files], async (k, open) => { hand(k); await until(() => k.requests.length === 2); open(); }],
  ];
  for (const [what, script, cut] of ways) {
    const k = await agentKit([script]);
    const A = k.trip;
    const B = await createTrip(k.ws, { title: 'Kyoto' });
    /** @type {Promise<unknown> | null} */
    let opening = null;
    await cut(k, () => { opening ??= k.agent.open(B); });
    await until(() => opening !== null);
    await opening;
    await idleAtOnce(k);
    assert.deepEqual(await ends(k, A), ['paused'], what);
    assert.deepEqual(await reads(k, A), [true, 'turn', 'h-1'], what);
    const before = k.requests.length;
    await k.agent.open(A);
    await idleAtOnce(k);
    assert.equal(k.requests.length - before, 1, `${what}: taken up once`);
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']], what);
    assert.deepEqual((await undoHandover(k.ws, A, 'h-1')).undone, ['/notes/f.md'], what);
  }
});

test("row 13: an open that lands on the reply's sleep, every other call done: her end is logged, no paused line, and nothing is taken up on return", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Filed.'), say('Never.')]]);
  const A = k.trip;
  const B = await createTrip(k.ws, { title: 'Kyoto' });
  /** @type {Promise<unknown> | null} */
  let opening = null;
  k.agent.on('event', (/** @type {any} */ e) => { if (!opening && e.type === 'tool.call' && e.data.name === 'sleep') opening = k.agent.open(B); });
  hand(k);
  await until(() => opening !== null);
  await opening;
  await idleAtOnce(k);
  assert.deepEqual(await ends(k, A), ['turn.end:h-1']);
  assert.deepEqual(await reads(k, A), [false, '', null]);
  const before = k.requests.length;
  await k.agent.open(A);
  await idleAtOnce(k);
  assert.equal(k.requests.length - before, 0);
});

// The moment after a silent reply (words only, or a bare sleep): the loop has logged it and not yet decided whether to ask her once more, and
// the decline it would make for the cut must not be written as her end. One test for each shape and each cut.
/** @type {[string, any, (e: any) => boolean][]} her silent reply, and the event that is the moment after it */
const MOMENTS = [
  ['words only', { text: 'Filing it.' }, (e) => e.type === 'model.turn'],
  ['a bare sleep', { toolCalls: [sleep] }, (e) => e.type === 'tool.call' && e.data.name === 'sleep'],
];
for (const [what, silent, moment] of MOMENTS) {
  test(`row 15: an open in the moment after a silent reply (${what}): no end is logged, the paused line shows, and the return takes the turn up once with the hand-over`, async (t) => {
    useClock(t);
    const k = await agentKit([[silent, files]]);
    const A = k.trip;
    const B = await createTrip(k.ws, { title: 'Kyoto' });
    /** @type {Promise<unknown> | null} */
    let opening = null;
    k.agent.on('event', (/** @type {any} */ e) => { if (!opening && moment(e)) opening = k.agent.open(B); });
    hand(k);
    await until(() => opening !== null);
    await opening;
    await idleAtOnce(k);
    assert.deepEqual(await ends(k, A), ['paused']);
    const [owed, , handover] = await reads(k, A);
    assert.deepEqual([owed, handover], [true, 'h-1']);
    const before = k.requests.length;
    await k.agent.open(A);
    await idleAtOnce(k);
    assert.equal(k.requests.length - before, 1, 'taken up once');
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']]);
  });

  test(`row 15: the user's Stop in the moment after a silent reply (${what}): its error alone, and the hand-over is owed to their next line`, async (t) => {
    useClock(t);
    const k = await agentKit([[silent, files]]);
    let stopped = false;
    k.agent.on('event', (/** @type {any} */ e) => { if (!stopped && moment(e)) { stopped = true; k.agent.interrupt(); } });
    hand(k);
    await idleAtOnce(k);
    assert.deepEqual(await ends(k), ['error:stopped']);
    assert.deepEqual(await reads(k), [false, '', 'h-1']);
    k.agent.send('Put it in Notes');
    await idleAtOnce(k);
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']], 'their next line carries it');
  });
}

test('row 14: the page left (or killed) in her model call: nothing logged, a reload reads her turn under way, and the next start takes it up once with the hand-over', async (t) => {
  useClock(t);
  // Every try of the request fails as the page goes (the call retries a network failure), then the next page's model answers.
  const cut = { delayMs: 30, error: 'network', message: 'Load failed' };
  const write = { toolCalls: [{ name: 'write', input: { path: '/trip/notes/a.md', content: 'AS' } }] };
  const k = await agentKit([[write, ...Array(1 + NETWORK_RETRIES.length).fill(cut), files]]);
  hand(k);
  await until(() => k.requests.length === 2);
  k.agent.leaving();
  await idleAtOnce(k);
  assert.deepEqual(await ends(k), []);
  assert.deepEqual(await reads(k), [true, 'turn', 'h-1']);
  k.llm.bench.clear('m-0'); // a new page starts with no model benched
  const next = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  await next.open(k.trip);
  await idleAtOnce({ agent: next });
  const restarts = (await k.events(['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).filter((/** @type {any} */ r) => r.kind === 'restart');
  assert.deepEqual(restarts.map((/** @type {any} */ r) => r.handover), ['h-1']);
  assert.deepEqual(await hers(k), [['/notes/a.md', 'h-1'], ['/notes/f.md', 'h-1']]);
  assert.deepEqual((await undoHandover(k.ws, k.trip, 'h-1')).undone.sort(), ['/notes/a.md', '/notes/f.md']);
});

// The restart of a cut turn carries the hand-over that turn carried, as its own wake records name it (its first, and a take-up), never an older
// one still owed by a turn that failed; a wake written while the conversation was closed carries what it brought, and for one of annai's own,
// nothing more (the Deferred entry "The restart of a turn annai started carries a hand-over still owed by an older failed turn").
/** The page is killed in her model call: every try of it fails as the page goes (the call retries a network failure). */
const KILLED = Array(1 + NETWORK_RETRIES.length).fill({ delayMs: 30, error: 'network', message: 'Load failed' });
/** Every try of her model call fails: "Shiori can't reach her model". */
const FAILED = Array(1 + OVERLOAD_RETRIES.length).fill(fails);
/** A write of hers, alone in its reply. @param {string} name */
const note = (name) => ({ toolCalls: [{ name: 'write', input: { path: `/trip/notes/${name}.md`, content: name } }] });
/** The next page opens the conversation and takes up what is owed: the restart wakes' reasons. @param {any} k */
const nextPage = async (k) => {
  k.llm.bench.clear('m-0'); // a new page starts with no model benched
  const next = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  await next.open(k.trip);
  await idleAtOnce({ agent: next });
  return (await k.events(['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).filter((/** @type {any} */ r) => r.kind === 'restart');
};
const WATCH = 'The watch fired: Nepenthe is 2 km away.';

for (const cut of ['before her first reply', 'after a write']) {
  test(`a hand-over's turn fails and is left alone, then a watch's turn is killed ${cut}: the restart carries no hand-over, and the hand-over's Undo leaves what she filed for the watch`, async (t) => {
    useClock(t);
    const first = cut === 'after a write' ? [note('watch-1')] : [];
    const k = await agentKit([[...FAILED, ...first, ...KILLED, { toolCalls: [...note('watch-2').toolCalls, speak('Noted.'), sleep] }]]);
    hand(k);
    await idleAtOnce(k);
    assert.deepEqual(await ends(k), ['error:model'], "Shiori can't reach her model; no Try again");
    k.agent.wake({ kind: 'trigger', text: WATCH });
    await until(() => k.requests.length === FAILED.length + first.length + 1);
    k.agent.leaving();
    await idleAtOnce(k);
    const t0 = await Transcript.load(k.store, k.trip);
    assert.deepEqual([t0.unanswered, t0.handover, t0.owedHandover], [true, null, 'h-1'], "under way, carrying none; h-1 still owed to the user's next line");
    const restarts = await nextPage(k);
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0].handover, undefined, 'the restart carries none');
    assert.deepEqual(await hers(k), [...(first.length ? [['/notes/watch-1.md', null]] : []), ['/notes/watch-2.md', null]]);
    assert.deepEqual((await undoHandover(k.ws, k.trip, 'h-1')).undone, [], "the hand-over's Undo takes back nothing she filed for the watch");
    assert.notEqual(await k.ws.read(k.trip, '/notes/watch-2.md'), undefined);
  });
}

test("a hand-over's turn fails and is left alone, then a watch fires while another conversation is open: the wake written into this one carries no hand-over when it is taken up, and the hand-over's Undo leaves what she filed for it", async (t) => {
  useClock(t);
  const k = await agentKit([[...FAILED, { toolCalls: [...note('watch-1').toolCalls, speak('Noted.'), sleep] }]]);
  hand(k);
  await idleAtOnce(k);
  const { A, back } = await away(k);
  await k.agent.wake({ kind: 'trigger', text: WATCH, scope: A });
  const t0 = await Transcript.load(k.store, A);
  assert.deepEqual([t0.unanswered, t0.handover, t0.owedHandover], [true, null, 'h-1']);
  assert.equal(await back(), 1, 'taken up once');
  const restarts = (await k.events(['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).filter((/** @type {any} */ r) => r.kind === 'restart');
  assert.match(restarts[0].text, /came while this conversation was closed/);
  assert.equal(restarts[0].handover, undefined);
  assert.deepEqual(await hers(k), [['/notes/watch-1.md', null]]);
  assert.deepEqual((await undoHandover(k.ws, A, 'h-1')).undone, []);
});

// The final review's F1: a line the user typed before leaving the conversation took the owed hand-over up, and a wake of annai's kept after it keeps it.
for (const order of ['the line, then the watch', 'the watch, then the line']) {
  test(`a hand-over's turn fails and is left alone, then, while another conversation is open, wakes are kept for this one (${order}): taken up on return, the user's line carries the hand-over, so its Undo takes back what she files`, async (t) => {
    useClock(t);
    const k = await agentKit([[...FAILED, files]]);
    hand(k);
    await idleAtOnce(k);
    const { A, back } = await away(k);
    const line = () => k.agent.wake({ kind: 'user', text: 'Please file my flight', scope: A });
    const watch = () => k.agent.wake({ kind: 'trigger', text: WATCH, scope: A });
    for (const keep of order.startsWith('the line') ? [line, watch] : [watch, line]) await keep();
    const t0 = await Transcript.load(k.store, A);
    assert.deepEqual([t0.unanswered, t0.handover, t0.owedHandover], [true, 'h-1', 'h-1'], 'the line took the owed one up, whichever wake came after');
    assert.equal(await back(), 1, 'taken up once');
    const restarts = (await k.events(['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).filter((/** @type {any} */ r) => r.kind === 'restart');
    assert.equal(restarts[0].handover, 'h-1');
    assert.deepEqual(await hers(k), [['/notes/f.md', 'h-1']]);
    assert.deepEqual((await undoHandover(k.ws, A, 'h-1')).undone, ['/notes/f.md']);
  });
}

test("a cut turn that did carry a hand-over still restarts with it: the user's hand-over killed before her first reply, and a watch's turn that took the owed hand-over up when the user's words joined it, killed after its write", async (t) => {
  useClock(t);
  // The user's own: killed in her first model call.
  const own = await agentKit([[...KILLED, files]]);
  hand(own);
  await until(() => own.requests.length === 1);
  own.agent.leaving();
  await idleAtOnce(own);
  assert.deepEqual((await nextPage(own)).map((/** @type {any} */ r) => r.handover), ['h-1']);
  assert.deepEqual(await hers(own), [['/notes/f.md', 'h-1']]);
  assert.deepEqual((await undoHandover(own.ws, own.trip, 'h-1')).undone, ['/notes/f.md']);
  // A watch's turn, carrying none; the user's words join it while h-1 is owed (the take-up record), she writes, and the page is killed.
  let calls = 0;
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => { release = () => r(undefined); });
  const k = await agentKit([[...FAILED, { toolCalls: [speak('The watch fired.')] }, note('watch-1'), ...KILLED, files]], { hold: async () => { if (++calls === FAILED.length + 1) await held; } });
  hand(k);
  await idleAtOnce(k);
  k.agent.wake({ kind: 'trigger', text: WATCH });
  await until(() => calls === FAILED.length + 1);
  k.agent.send('Please file my flight');
  await new Promise((r) => setTimeout(r, 30));
  release();
  await until(() => k.requests.length === FAILED.length + 3);
  k.agent.leaving();
  await idleAtOnce(k);
  const took = (await k.events(['wake'])).filter((/** @type {any} */ e) => e.data.meanwhile && 'handover' in e.data);
  assert.deepEqual(took.map((/** @type {any} */ e) => e.data.handover), ['h-1'], 'the take-up record');
  assert.deepEqual((await nextPage(k)).map((/** @type {any} */ r) => r.handover), ['h-1']);
  assert.deepEqual(await hers(k), [['/notes/watch-1.md', 'h-1'], ['/notes/f.md', 'h-1']]);
  assert.deepEqual((await undoHandover(k.ws, k.trip, 'h-1')).undone.sort(), ['/notes/f.md', '/notes/watch-1.md']);
});

// A log the version before this one wrote has no turn.end and no endLogged key: each of its replies is read as the end of its turn (the approved
// known limitation "Turns the version before this update left unfinished are read as finished"). A user's line she never replied to is still owed.
/** A turn the older version logged: the user's line with a hand-over (h-1), then her replies without the key. @param {any} k @param {any[][]} replies tool calls or [] for words */
const older = async (k, replies) => {
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }] } });
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Here is my flight', wake: 'w-0', handed: [flight], handover: 'h-1' } });
  for (const calls of replies) {
    const parts = calls.length ? calls.map(([id, name, input]) => ({ type: 'tool_call', id, name, input })) : [{ type: 'text', text: 'Filing it.' }];
    await modelTrace(k.store, k.trip).turn(/** @type {any} */ ({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0', handover: 'h-1' }), '', '', /** @type {any} */ (parts));
  }
};
const CUT = 'Cut off: another conversation was opened while this ran. It may have finished: check before you do it again.';

test('turns the version before this update left unfinished are read as finished: (a) one paused by an open is not picked up, and its hand-over reads as answered', async (t) => {
  useClock(t);
  const k = await agentKit([[files]], { open: false });
  await older(k, [[['r', 'read', { path: '/trip/files/flight.pdf' }]]]);
  await record(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id: 'r', name: 'read', ok: false, cut: true, ms: 1, wake: 'w-0' }, texts: [['content', CUT]] });
  await record(k.store, k.trip, { type: 'paused', actor: 'system', data: { text: 'Shiori was in the middle of something. She picks it up when you come back.' } });
  assert.deepEqual(await reads(k), [false, '', null]);
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0, 'opening runs nothing');
});

test('turns the version before this update left unfinished are read as finished: (b) one closed after her calls had come back is not picked up', async (t) => {
  useClock(t);
  const k = await agentKit([[files]], { open: false });
  await older(k, [[['l', 'list', { path: '/trip/' }]]]);
  await record(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id: 'l', name: 'list', ok: true, cut: false, ms: 1, wake: 'w-0' }, texts: [['content', 'path\ttype']] });
  assert.deepEqual(await reads(k), [false, '', null]);
});

test('turns the version before this update left unfinished are read as finished: (d) one killed while her calls ran is picked up once, and what she files is outside the hand-over', async (t) => {
  useClock(t);
  const k = await agentKit([[files]], { open: false });
  await older(k, [[['w', 'write', { path: '/trip/notes/a.md', content: 'AS' }]]]);
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  assert.equal(k.requests.length, 1, 'repair() answered her open call, so the open takes it up');
  assert.deepEqual(await hers(k), [['/notes/f.md', null]]);
});

test('turns the version before this update left unfinished are read as finished: (e) Try again on a "Shiori didn\'t answer" card from before carries no hand-over', async (t) => {
  useClock(t);
  const k = await agentKit([[files]], { open: false });
  await older(k, [[]]);
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', meanwhile: true, reasons: [{ kind: 'cue', text: "The user hasn't been answered." }] } });
  await modelTrace(k.store, k.trip).turn(/** @type {any} */ ({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0', handover: 'h-1' }), '', '', [{ type: 'text', text: 'Filed it.' }]);
  await record(k.store, k.trip, { type: 'error', actor: 'system', data: { kind: 'silent', wake: 'w-0', message: 'Her model finished without saying anything to you.' } });
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  assert.equal(k.requests.length, 0);
  k.agent.tryAgain();
  await idleAtOnce(k);
  assert.deepEqual(await hers(k), [['/notes/f.md', null]]);
});

test('turns the version before this update left unfinished are read as finished: a line of the user\'s after her last reply is still owed', async (t) => {
  useClock(t);
  const k = await agentKit([[files]], { open: false });
  await older(k, [[['s', 'speak', { text: 'Got it.' }], ['z', 'sleep', {}]]]);
  for (const [id, name, c] of [['s', 'speak', 'Said.'], ['z', 'sleep', 'asleep']]) await record(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id, name, ok: true, cut: false, ms: 1, wake: 'w-0' }, texts: [['content', c]] });
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'And file it, please', wake: 'w-0', meanwhile: true } });
  assert.deepEqual(await reads(k), [true, 'user', null]);
});

test('turns the version before this update left unfinished are read as finished: a turn of this version after an old one is read by its record', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'write', input: { path: '/trip/notes/b.md', content: 'x' } }] }, { delayMs: 300, ...say('Filed.') }]], { open: false });
  await older(k, [[]]);
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  k.agent.send('And this one', { handed: [flight], handover: 'h-2' });
  await until(() => k.requests.length === 2);
  assert.deepEqual(await reads(k), [true, 'turn', 'h-2'], 'her reply has the key, and no end yet: under way');
  await idleAtOnce(k);
  assert.deepEqual(await ends(k), ['turn.end:h-2']);
  assert.deepEqual(await reads(k), [false, '', null]);
});
