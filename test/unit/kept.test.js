import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Kept, fingerprint, MAX_TURNS } from '../../src/core/llm/kept.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_DEVICE } from '../../src/core/scopes.js';
import { loadGemini, KEY } from './gemini-kit.js';
import { startGeminiServer } from '../fakes/gemini-server.js';

// Turns a provider keeps on its side (the Gemini design, "Kept on Google's side"): the store of them, a request that
// continues one, Google having forgotten one, and only a conversation's own turns kept.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 19, 9, 0);
const LITE = 'gemini-3.5-flash-lite';
const TOOL = { name: 'places', description: 'Places nearby.', input: { type: 'object', properties: { q: { type: 'string' } } } };
/** @param {'user' | 'assistant'} role @param {...any} parts @returns {any} */
const msg = (role, ...parts) => ({ role, parts });
const text = (/** @type {string} */ t) => ({ type: 'text', text: t });
const m1 = msg('user', text('Where can we eat?'));
const r1 = msg('assistant', { type: 'reasoning', text: '', signature: 'TS', model: LITE }, { type: 'tool_call', id: 'call_1', name: 'places', input: { q: 'ramen' }, extra: { signature: 'CS' }, model: LITE });
const tr = msg('user', { type: 'tool_result', id: 'call_1', content: 'Ichiran, 200 m' });
const r2 = msg('assistant', text('Ichiran is 200 m away.'));
const m3 = msg('user', text('Is it open now?'));

/** A Kept on memory storage, on a clock the test moves. */
async function keptKit() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const clock = { t: T0 };
  const kept = new Kept({ ws, now: () => clock.t });
  return { store, ws, clock, kept, file: async () => ws.readJSON(SYS_DEVICE, '/llm/kept.json') };
}
const PAID = { free: false, keepDays: 55, scope: 'trip-a' };
/** @param {Partial<Parameters<Kept['record']>[0]>} [over] */
const turn = (over = {}) => ({ id: 'v1_a', endpoint: 'pv-g/chat', model: LITE, scope: 'trip-a', messages: [m1], reply: r1, days: 55, ...over });

test('fingerprint: by content, stable; base64 hashed, never kept; what only the model that wrote it reads is left out', () => {
  const photo = { type: 'image', mediaType: 'image/jpeg', data: `${'A'.repeat(4000)}B` };
  const a = fingerprint(msg('user', text('Look'), photo));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, fingerprint(structuredClone(msg('user', text('Look'), photo))));
  assert.notEqual(a, fingerprint(msg('user', text('Look'), { ...photo, data: `${'A'.repeat(4000)}C` })), 'the whole photo counts');
  assert.notEqual(a, fingerprint(msg('assistant', text('Look'), photo)), 'and who said it');
  assert.ok(!a.includes('AAAA'));
  assert.equal(fingerprint(msg('user', { ...photo, hash: 'h1' })), fingerprint(msg('user', { ...photo, hash: 'h1', fileId: 'files/x' })), 'a photo by its hash, uploaded or not');
  // Signed thoughts and what a model wrote on its calls go back only to that model: another sees the same message without them.
  assert.equal(fingerprint(r1), fingerprint(msg('assistant', { type: 'tool_call', id: 'call_1', name: 'places', input: { q: 'ramen' } })));
  assert.notEqual(fingerprint(r1), fingerprint(msg('assistant', { type: 'tool_call', id: 'call_1', name: 'places', input: { q: 'udon' } })));
});

test('a request that continues a kept turn sends only what follows it', async () => {
  const { kept } = await keptKit();
  await kept.record(turn());
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, tr], PAID), { id: 'v1_a', from: 2 });
});

test('a changed history, a one-off call, another endpoint or trip, a reply not as kept, nothing new after it: no match', async () => {
  const { kept } = await keptKit();
  await kept.record(turn());
  assert.equal(await kept.match('pv-g/chat', [msg('user', text('Where can we drink?')), r1, tr], PAID), null, 'a changed history');
  assert.equal(await kept.match('pv-g/chat', [msg('user', text('Summarize this.'))], PAID), null, 'a one-off call');
  assert.equal(await kept.match('pv-other/chat', [m1, r1, tr], PAID), null, 'another endpoint');
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr], { ...PAID, scope: 'trip-b' }), null, "another trip's conversation never continues this one's");
  assert.equal(await kept.match('pv-g/chat', [m1, msg('assistant', text('cut short')), tr], PAID), null, 'a reply other than the one kept (cut off where it was heard)');
  assert.equal(await kept.match('pv-g/chat', [m1, r1], PAID), null, 'nothing after the reply to send');
});

test('the longest kept turn wins', async () => {
  const { kept, clock } = await keptKit();
  await kept.record(turn());
  clock.t += 60_000;
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a' }));
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, tr, r2, m3], PAID), { id: 'v1_b', from: 4 });
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, msg('user', text('Never mind.'))], PAID), { id: 'v1_a', from: 2 }, 'a shorter one still serves another way on');
});

test('free tier keeps for a day, else keepDays: an expired turn is dropped without a deletion, as Google deleted it', async () => {
  const { kept, clock, file } = await keptKit();
  await kept.record(turn({ days: 1 }));
  clock.t += 25 * 3600_000;
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr], { ...PAID, free: true, keepDays: 55 }), null);
  assert.deepEqual(await file(), { turns: [], forget: [] }, 'dropped, and nothing to delete');
  const paid = await keptKit();
  await paid.kept.record(turn());
  paid.clock.t += 25 * 3600_000;
  assert.deepEqual(await paid.kept.match('pv-g/chat', [m1, r1, tr], PAID), { id: 'v1_a', from: 2 });
  // keepDays lowered to match AI Studio's: not continued once past it.
  assert.equal(await paid.kept.match('pv-g/chat', [m1, r1, tr], { ...PAID, keepDays: 1 }), null);
});

test("a chain holds only while its first turn is there: Google drops a deleted or expired turn's content from the turns after it, silently", async () => {
  const { kept, clock } = await keptKit();
  await kept.record(turn({ days: 1 }));
  clock.t += 20 * 3600_000;
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a', days: 1 }));
  clock.t += 3.5 * 3600_000; // the first is 23.5 hours old, within the hour before Google deletes it
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr, r2, m3], { ...PAID, free: true }), null, 'sent whole: a new chain');
  assert.deepEqual(await kept.count({ provider: 'pv-g' }), { turns: 2, waiting: 0, until: T0 + 20 * 3600_000 + DAY, endpoints: ['pv-g/chat'] }, 'both kept until Google deletes them, to be deleted when removed');
});

test(`at most ${MAX_TURNS} turns: the oldest chains go whole, each queued for deletion`, async () => {
  const { kept, clock, file } = await keptKit();
  await kept.record(turn({ id: 'v1_old1' }));
  await kept.record(turn({ id: 'v1_old2', messages: [m1, r1, tr], reply: r2, after: 'v1_old1' }));
  for (let i = 0; i < MAX_TURNS - 1; i++) {
    clock.t += 1000;
    await kept.record(turn({ id: `v1_${i}`, messages: [msg('user', text(`Question ${i}`))], reply: msg('assistant', text(`Answer ${i}`)) }));
  }
  const f = await file();
  assert.equal(f.turns.length, MAX_TURNS - 1);
  assert.deepEqual(f.forget.map((/** @type {any} */ x) => x.id), ['v1_old1', 'v1_old2'], 'its whole chain: what is left of one would lose what came before');
  assert.deepEqual(f.forget[0], { id: 'v1_old1', endpoint: 'pv-g/chat', until: T0 + 55 * DAY });
});

test('forget: a turn Google no longer has takes its chain with it; the rest of the chain is queued for deletion', async () => {
  const { kept, file } = await keptKit();
  await kept.record(turn());
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a' }));
  await kept.record(turn({ id: 'v1_other', messages: [msg('user', text('Hello'))], reply: msg('assistant', text('Hi')) }));
  await kept.forget('v1_b');
  const f = await file();
  assert.deepEqual(f.turns.map((/** @type {any} */ x) => x.id), ['v1_other']);
  assert.deepEqual(f.forget.map((/** @type {any} */ x) => x.id), ['v1_a']);
});

// ---- Through callRole, against the stand-in Gemini server ----

const type = loadGemini();
/** A Gemini provider at the stand-in's address, its model in main and utility. @param {string} url @param {Record<string, any>} [tunables] @param {boolean} [free] */
const gemConfig = (url, tunables = {}, free = false) => /** @type {any} */ ({
  providers: { 'pv-g': { id: 'pv-g', plugin: 'provider-gemini', template: null, user: { name: 'Google Gemini', baseUrl: url, ...(free ? { free: true } : {}), abilities: { chat: { kind: 'chat', type: 'gemini', tunables } } }, created: 0 } },
  models: { 'm-l': { id: 'm-l', provider: 'pv-g', ability: 'chat', template: null, user: { providerId: LITE, input: ['text', 'image', 'pdf', 'audio'] }, created: 0 } },
  roles: { main: { models: ['m-l'], level: 'off' }, utility: { models: ['m-l'], level: 'off' } },
});

/** A conversation's turn (main, its parts kept), or another call, through callRole. */
async function callKit(/** @type {any} */ replies, /** @type {Record<string, any>} */ tunables = {}) {
  const s = await startGeminiServer({ key: KEY, replies });
  const k = await keptKit();
  const config = gemConfig(s.url, tunables);
  /** @param {any[]} messages @param {Record<string, any>} [o] */
  const call = (messages, o = {}) => callRole({
    role: 'main', config, types: new Map([['gemini', type]]), bench: new Bench(), keyFor: async () => KEY, kept: k.kept, scope: 'trip-a',
    record: { keepParts: true }, trace: modelTrace(k.store, 'trip-a'), request: { messages, tail: 'Now: 12:00.', tools: [TOOL] }, ...o,
  });
  const requests = async () => (await k.store.tx(['events'], 'readonly', (t) => t.listEvents('trip-a', { types: ['net.request'] }))).map((e) => e.data);
  return { s, ...k, call, requests };
}

test("a conversation's turns are kept, and the next one sends only what is new, with the turn it continues; the trace says so, and how much went", async () => {
  const c = await callKit([{ calls: [{ name: 'places', input: { q: 'ramen' }, signature: 'CS' }] }, { text: 'Ichiran is 200 m away.' }]);
  try {
    const first = await c.call([m1]);
    const said = msg('assistant', ...first.reply.parts);
    const second = await c.call([m1, said, tr]);
    assert.equal(second.reply.text, 'Ichiran is 200 m away.');
    const [b1, b2] = c.s.bodies();
    assert.deepEqual([b1.store, b1.previous_interaction_id], [true, undefined]);
    assert.deepEqual([b2.store, b2.previous_interaction_id], [true, 'v1_stand-in-1']);
    assert.deepEqual(b2.input, [
      { type: 'function_result', call_id: 'call_1', name: 'places', result: [{ type: 'text', text: 'Ichiran, 200 m' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'Now: 12:00.' }] },
    ], 'the tool result and the now block: nothing Google keeps');
    const [q1, q2] = await c.requests();
    assert.deepEqual([q1.kept, q2.kept], [undefined, { from: 2 }]);
    assert.deepEqual([q1.bytes, q2.bytes], [JSON.stringify(b1).length, JSON.stringify(b2).length]);
    assert.deepEqual(await c.kept.count(), { turns: 2, waiting: 0, until: T0 + 55 * DAY, endpoints: ['pv-g/chat'] });
    // Its third turn continues the second.
    await c.call([m1, said, tr, msg('assistant', ...second.reply.parts), m3]);
    assert.equal(c.s.bodies()[2].previous_interaction_id, 'v1_stand-in-2');
  } finally {
    await c.s.close();
  }
});

test("Review Focus 2: turn 2 doesn't carry turn 1's photo", async () => {
  const PHOTO = Buffer.from('a photo of the ramen shop, standing in for its bytes').toString('base64');
  const c = await callKit([{ text: 'A ramen shop.' }, { text: 'It opens at 11.' }]);
  try {
    const first = msg('user', text('What is this?'), { type: 'image', mediaType: 'image/jpeg', data: PHOTO, hash: 'h-photo' });
    const r = await c.call([first]);
    await c.call([first, msg('assistant', ...r.reply.parts), m3]);
    const [b1, b2] = c.s.bodies();
    assert.ok(JSON.stringify(b1).includes(PHOTO));
    assert.ok(!JSON.stringify(b2).includes(PHOTO), 'Google has it already');
    assert.equal(b2.previous_interaction_id, 'v1_stand-in-1');
  } finally {
    await c.s.close();
  }
});

test('forgotten: Google no longer has the turn it continues, so the same model is asked once more, whole; its record goes, the reply arrives, the trace shows both', async () => {
  const c = await callKit([{ text: 'Ichiran.' }, { text: 'Yes, until 23:00.' }]);
  try {
    const r = await c.call([m1]);
    c.s.expire('v1_stand-in-1'); // Google deleted it (a day on the free tier)
    const again = await c.call([m1, msg('assistant', ...r.reply.parts), m3]);
    assert.equal(again.reply.text, 'Yes, until 23:00.');
    assert.deepEqual(again.attempts.map((a) => a.outcome), ['forgotten', 'ok']);
    const [, b2, b3] = c.s.bodies();
    assert.equal(b2.previous_interaction_id, 'v1_stand-in-1');
    assert.deepEqual([b3.previous_interaction_id, b3.input.length], [undefined, 3], 'whole');
    const reqs = await c.requests();
    assert.deepEqual(reqs.map((q) => [q.outcome, q.status]), [['ok', 200], ['forgotten', 404], ['ok', 200]]);
    const f = await c.file();
    assert.deepEqual(f.turns.map((/** @type {any} */ x) => x.id), ['v1_stand-in-2'], 'the forgotten one gone, the whole one a new chain');
    // A forgotten turn's 404 on a call that continued nothing is a model or address annai can't find.
    const { classify } = type;
    assert.equal(classify(404, await readFile(new URL('../fixtures/gemini/continue-deleted-404.json', import.meta.url), 'utf8')), 'forgotten');
  } finally {
    await c.s.close();
  }
});

test('nothing kept holds a key or a photo: fingerprints and ids', async () => {
  const PHOTO = Buffer.from('another photo standing in for its bytes, long enough to see').toString('base64');
  const c = await callKit([{ text: 'Nice.' }]);
  try {
    await c.call([msg('user', text('Look'), { type: 'image', mediaType: 'image/png', data: PHOTO })]);
    const raw = await c.ws.readText(SYS_DEVICE, '/llm/kept.json');
    assert.ok(raw?.includes('v1_stand-in-1'));
    assert.ok(!raw?.includes(KEY) && !raw?.includes(PHOTO) && !raw?.includes('Look'));
    assert.deepEqual(await c.ws.history(SYS_DEVICE, '/llm/kept.json'), [], 'kept without history: an old version would name a removed trip');
  } finally {
    await c.s.close();
  }
});

test("only a conversation's own turns are kept: a utility call, a one-off call in main's role, or the switch off sends store: false and keeps nothing", async () => {
  const c = await callKit([{ text: 'OK' }]);
  try {
    await c.call([m1], { role: 'utility' });
    await c.call([m1], { record: { tag: 'fetch' } });
    assert.deepEqual(c.s.bodies().map((b) => b.store), [false, false]);
    assert.deepEqual(await c.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
    const off = await callKit([{ text: 'OK' }], { keep: false });
    try {
      await off.call([m1]);
      assert.equal(off.s.bodies()[0].store, false);
      assert.deepEqual(await off.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
    } finally {
      await off.s.close();
    }
  } finally {
    await c.s.close();
  }
});

test('a call that fails after Google kept its turn has that turn queued for deletion', async () => {
  const k = await keptKit();
  const sse = [
    { event_type: 'interaction.created', interaction: { id: 'v1_half', object: 'interaction' } },
    { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
    { event_type: 'error', error: { code: 'internal', message: 'Internal error.' } },
  ].map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  await assert.rejects(callRole({
    role: 'main', config: gemConfig('https://generativelanguage.googleapis.com'), types: new Map([['gemini', type]]), bench: new Bench(), keyFor: async () => KEY,
    kept: k.kept, scope: 'trip-a', record: { keepParts: true }, sleep: async () => {}, request: { messages: [m1] },
    fetch: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
  }));
  assert.deepEqual((await k.file()).forget.map((/** @type {any} */ f) => f.id), ['v1_half'], 'once, though each of its three tries named it');
  assert.deepEqual((await k.file()).turns, []);
});

test('the Trace says when a call continued a kept turn and how much it sent, and each deletion', async () => {
  const { traceSummary } = await import('../../src/ui/screens/trace.js');
  assert.equal(traceSummary({ type: 'net.request', data: { model: 'Gemini 3.5 Flash Lite', outcome: 'ok', status: 200, ms: 800, bytes: 2400, kept: { from: 4 } } }),
    'Gemini 3.5 Flash Lite · ok (200) · 800 ms · 2.3 KB sent, after a kept turn');
  assert.equal(traceSummary({ type: 'net.request', data: { model: 'Gemini 3.5 Flash Lite', outcome: 'ok', status: 200, ms: 800, bytes: 24000 } }), 'Gemini 3.5 Flash Lite · ok (200) · 800 ms · 23 KB sent');
  assert.equal(traceSummary({ type: 'net.request', data: { kind: 'forget', endpoint: 'Google Gemini', outcome: 'ok', status: 200, ms: 120 } }), 'kept turn deleted · Google Gemini · 200 · 120 ms');
  assert.equal(traceSummary({ type: 'net.request', data: { kind: 'forget', endpoint: 'Google Gemini', outcome: 'waiting', status: 0, ms: 3 } }), 'kept turn not deleted yet · Google Gemini · no answer · 3 ms');
});

// ---- Deletions: a trip, the switch, the provider, Erase (Task 8), through the service with provider-gemini ----

/**
 * The service with Google Gemini added from annai's own files, at the stand-in's address, its recommended models in the roles,
 * and two trips. online: false makes every request to the stand-in fail, as with no connection.
 */
async function serviceKit() {
  const { hostKit } = await import('./package-kit.js');
  const { createLlm } = await import('../../src/core/llm/service.js');
  const { createTrip } = await import('../../src/core/scopes.js');
  const s = await startGeminiServer({ key: KEY, replies: [(b) => ({ text: `Answer ${b.input.length}` })] });
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const net = { online: true };
  /** @type {string[]} what happened, in order: each DELETE, and the key's removal */
  const order = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).startsWith(s.url)) {
      if (!net.online) throw new TypeError('Failed to fetch');
      if (init?.method === 'DELETE') order.push(`DELETE ${decodeURIComponent(String(url).split('/').pop() ?? '')}`);
      return globalThis.fetch(url, init);
    }
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider('provider-gemini', { key: KEY, baseUrl: s.url, official: true });
  const tripA = await createTrip(k.ws, { title: 'Kyoto' });
  const tripB = await createTrip(k.ws, { title: 'Osaka' });
  /** A conversation of n turns in a trip, each continuing the one before. @param {string} scope @param {number} n */
  const talk = async (scope, n) => {
    /** @type {any[]} */
    const messages = [];
    for (let i = 0; i < n; i++) {
      messages.push(msg('user', text(`${scope}: question ${i}`)));
      const r = await llm.call({ role: 'main', scope, request: { messages }, record: { keepParts: true } });
      messages.push(msg('assistant', ...r.reply.parts));
    }
  };
  const keptFile = async () => k.ws.readJSON(SYS_DEVICE, '/llm/kept.json');
  return { s, ...k, llm, id, tripA, tripB, talk, net, order, keptFile, fetch };
}

test('removing a trip queues its kept turns\' deletions and runs them: one DELETE per turn of that trip, none of another\'s', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    await c.talk(c.tripB, 1);
    assert.deepEqual(c.s.bodies().map((b) => b.previous_interaction_id), [undefined, 'v1_stand-in-1', undefined], 'each trip its own chain');
    assert.deepEqual(await c.llm.keptCount({ scope: c.tripA }), { turns: 2, waiting: 0, days: 55, who: ['Google'] });
    const { removeTrip } = await import('../../src/core/scopes.js');
    await removeTrip(c.store, c.tripA);
    assert.deepEqual(await c.llm.forgetScope(c.tripA), { queued: 2 });
    await c.llm.drainKept();
    assert.deepEqual(c.s.deleted().sort(), ['v1_stand-in-1', 'v1_stand-in-2']);
    assert.deepEqual(c.s.stored(), ['v1_stand-in-3'], "Osaka's stays");
    assert.deepEqual(await c.llm.keptCount(), { turns: 1, waiting: 0, days: 55, who: ['Google'] });
    // A request is traced as every one is, without the key or the turn's id.
    const traced = (await c.store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }))).map((e) => e.data).filter((d) => d.kind === 'forget');
    assert.deepEqual(traced.map((d) => [d.outcome, d.status]), [['ok', 200], ['ok', 200]]);
    assert.ok(!JSON.stringify(traced).includes('v1_stand-in') && !JSON.stringify(traced).includes(KEY));
  } finally {
    await c.s.close();
  }
});

test('Review Focus 5: offline, deletions wait, kept across a restart, and run when a connection comes back; a turn whose trip is gone is found at the next drain', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    const { removeTrip } = await import('../../src/core/scopes.js');
    await removeTrip(c.store, c.tripA);
    c.net.online = false;
    await c.llm.forgetScope(c.tripA);
    assert.deepEqual(await c.llm.drainKept(), { done: 0, left: 2 });
    assert.deepEqual(await c.llm.keptCount({ provider: c.id }), { turns: 0, waiting: 2, days: 55, who: ['Google'] });
    // annai starts again: the queue is in the file.
    const again = new Kept({ ws: c.ws });
    assert.deepEqual(await again.count(), { turns: 0, waiting: 2, until: (await c.keptFile()).forget[1].until, endpoints: [`${c.id}/chat`] });
    c.net.online = true;
    assert.deepEqual(await c.llm.drainKept(), { done: 2, left: 0 });
    assert.equal(c.s.deleted().length, 2);
    // A call that ended after its trip was removed kept a turn there: the next drain finds it.
    await c.talk(c.tripB, 1);
    await removeTrip(c.store, c.tripB);
    assert.deepEqual(await c.llm.drainKept(), { done: 1, left: 0 });
    assert.deepEqual(c.s.stored(), []);
  } finally {
    await c.s.close();
  }
});

test('switching keep off queues all of that ability\'s turns and deletes them; switched back on, chains start afresh', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    await c.talk(c.tripB, 1);
    assert.deepEqual(await c.llm.forgetEndpoint(`${c.id}/chat`), { queued: 3 });
    await c.llm.drainKept();
    assert.deepEqual(c.s.stored(), []);
    assert.equal(c.s.deleted().length, 3);
    // Back on (as the switch saves it): a new chain, sent whole.
    await c.talk(c.tripA, 1);
    assert.equal(c.s.bodies().at(-1).previous_interaction_id, undefined);
    assert.equal(c.s.bodies().at(-1).store, true);
  } finally {
    await c.s.close();
  }
});

test('removing the provider deletes first, while its key is there; offline, what is left is named before (count and days), and goes from this phone with the key', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 2);
    const { getKey } = await import('../../src/core/llm/config.js');
    const removeKey = c.store.tx.bind(c.store);
    // The key's removal joins the order the moment it happens.
    c.store.tx = /** @type {any} */ (async (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => removeKey(stores, mode, async (/** @type {any} */ t) => {
      if (stores.includes('secrets') && mode === 'readwrite') {
        const del = t.deleteSecret.bind(t);
        t = Object.assign(Object.create(t), { deleteSecret: async (/** @type {string} */ s) => { c.order.push('key removed'); return del(s); } });
      }
      return fn(t);
    }));
    await c.llm.removeProvider(c.id);
    assert.deepEqual(c.order.slice(0, 3), ['DELETE v1_stand-in-1', 'DELETE v1_stand-in-2', 'key removed'], 'every DELETE before the key goes (its plugin\'s secrets go after)');
    assert.equal(c.order.filter((x) => x.startsWith('DELETE')).length, 2);
    assert.equal(await getKey(c.store, c.id), null);
    assert.deepEqual(await c.keptFile(), { turns: [], forget: [] });

    const off = await serviceKit();
    try {
      await off.talk(off.tripA, 3);
      off.net.online = false;
      assert.deepEqual(await off.llm.keptCount({ provider: off.id }), { turns: 3, waiting: 0, days: 55, who: ['Google'] });
      const { keptWords } = await import('../../src/ui/screens/provider.js');
      assert.equal(keptWords(await off.llm.keptCount({ provider: off.id }), false), 'Google keeps 3 turns until they expire, up to 55 days.');
      const started = Date.now();
      await off.llm.removeProvider(off.id);
      assert.ok(Date.now() - started < 10_000);
      assert.deepEqual(await off.keptFile(), { turns: [], forget: [] }, "none of that provider's");
      assert.deepEqual(off.s.deleted(), []);
    } finally {
      await off.s.close();
    }
  } finally {
    await c.s.close();
  }
});

test('Erase: forgetAll asks for every deletion first, for up to its time, and says what is left', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 1);
    await c.talk(c.tripB, 1);
    assert.deepEqual(await c.llm.forgetAll({ timeoutMs: 10_000 }), { left: 0 });
    assert.deepEqual(c.s.stored(), []);
    await c.talk(c.tripA, 1);
    c.net.online = false;
    assert.deepEqual(await c.llm.forgetAll({ timeoutMs: 200 }), { left: 1 });
  } finally {
    await c.s.close();
  }
});

test('keptWords: what Google keeps, named before a removal, online and off', async () => {
  const { keptWords } = await import('../../src/ui/screens/provider.js');
  assert.equal(keptWords({ turns: 0, waiting: 0, days: 0, who: [] }, true), '');
  assert.equal(keptWords({ turns: 2, waiting: 1, days: 55, who: ['Google'] }, true), "First, annai asks Google to delete the 3 turns of your conversations it keeps; any it can't in 10 seconds, Google keeps until they expire, up to 55 days.");
  assert.equal(keptWords({ turns: 1, waiting: 0, days: 1, who: ['Google'] }, false), 'Google keeps 1 turn until it expires, up to 1 day.');
});

test('annai starting again sends the deletions that waited, by itself', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 1);
    c.net.online = false;
    const { removeTrip } = await import('../../src/core/scopes.js');
    await removeTrip(c.store, c.tripA);
    await c.llm.forgetScope(c.tripA);
    await c.llm.drainKept();
    assert.deepEqual(c.s.deleted(), []);
    c.net.online = true;
    const { createLlm } = await import('../../src/core/llm/service.js');
    /** @type {(v?: unknown) => void} */
    let started = () => {};
    createLlm({ store: c.store, ws: c.ws, plugins: c.host, fetch: c.fetch, ready: new Promise((r) => { started = r; }) });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(c.s.deleted(), [], 'not before its plugins have started');
    started();
    for (let i = 0; i < 100 && !c.s.deleted().length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(c.s.deleted(), ['v1_stand-in-1']);
  } finally {
    await c.s.close();
  }
});

test('a voice message sent as sound, then as its words once written down, is the same message: the next turn still goes after the kept one', async () => {
  const c = await callKit([{ text: 'Ichiran.' }, { text: 'Until 23:00.' }]);
  try {
    const CLIP = Buffer.from('a voice message standing in for its sound').toString('base64');
    let written = false;
    // As annai's speech-in list resolves heard speech: sound while it is in memory, its words once written down (spec §10.3).
    const speech = async (/** @type {any} */ _model, /** @type {any} */ request) => ({ ...request, messages: request.messages.map((/** @type {any} */ m) => ({ ...m,
      parts: m.parts.map((/** @type {any} */ p) => (p.type !== 'speech' ? p : written ? { type: 'text', text: 'Where can we eat?' } : { type: 'audio', mediaType: 'audio/ogg', data: CLIP })) })) });
    const heard = msg('user', { type: 'speech', id: 'heard-1' });
    const r = await c.call([heard], { speech });
    written = true;
    await c.call([heard, msg('assistant', ...r.reply.parts), m3], { speech });
    const [b1, b2] = c.s.bodies();
    assert.equal(b1.input[0].content[0].type, 'audio');
    assert.equal(b2.previous_interaction_id, 'v1_stand-in-1');
    assert.ok(!JSON.stringify(b2).includes('Where can we eat?') && !JSON.stringify(b2).includes(CLIP), 'neither its sound nor its words again');
  } finally {
    await c.s.close();
  }
});

test("a turn Google refused isn't continued: what it blocked would be in every later turn's history, so it is deleted, and the next goes after the turn before it", async () => {
  const k = await keptKit();
  const blocked = JSON.parse(await readFile(new URL('../fixtures/gemini/safety-block-400.json', import.meta.url), 'utf8')).error;
  const sse = [
    { event_type: 'interaction.created', interaction: { id: 'v1_refused', object: 'interaction' } },
    { event_type: 'error', error: blocked },
  ].map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const r = await callRole({
    role: 'main', config: gemConfig('https://generativelanguage.googleapis.com'), types: new Map([['gemini', loadGemini()]]), bench: new Bench(), keyFor: async () => KEY,
    kept: k.kept, scope: 'trip-a', record: { keepParts: true }, request: { messages: [m1] },
    fetch: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(r.reply.stop, 'refusal');
  assert.deepEqual((await k.file()).turns, []);
  assert.deepEqual((await k.file()).forget.map((/** @type {any} */ f) => f.id), ['v1_refused']);
});

test('a turn still being answered when its provider is removed is deleted at once, with the key the call still holds: nothing of it is left with Google', async () => {
  const c = await callKit([{ text: 'Ichiran.', delayMs: 300 }]);
  try {
    const answering = c.call([m1]);
    for (let i = 0; i < 100 && !c.s.bodies().length; i++) await new Promise((r) => setTimeout(r, 5));
    await c.kept.drop('pv-g'); // removeProvider's last step, its key going with it
    assert.equal((await answering).reply.text, 'Ichiran.');
    assert.deepEqual(c.s.deleted(), ['v1_stand-in-1']);
    assert.deepEqual(c.s.stored(), []);
    assert.deepEqual(await c.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
  } finally {
    await c.s.close();
  }
});

test("keepDays only lowers how long a turn counts as kept: raised past the type's own (Google's longest), the type's holds, so a chain Google has partly dropped isn't continued", async () => {
  const c = await callKit([{ text: 'OK' }], { keepDays: 100 });
  try {
    await c.call([m1]);
    assert.equal((await c.file()).turns[0].days, 55);
    const low = await callKit([{ text: 'OK' }], { keepDays: 7 });
    try {
      await low.call([m1]);
      assert.equal((await low.file()).turns[0].days, 7);
    } finally {
      await low.s.close();
    }
  } finally {
    await c.s.close();
  }
});
