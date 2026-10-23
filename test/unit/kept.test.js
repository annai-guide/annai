import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Kept, fingerprint, keyPrint, MAX_TURNS } from '../../src/core/llm/kept.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_DEVICE } from '../../src/core/scopes.js';
import { loadGemini, KEY, endpointOf } from './gemini-kit.js';
import { startGeminiServer } from '../fakes/gemini-server.js';

/** Every stand-in server a test starts. A kit that throws after starting one (a plugin that won't install, say) never reaches its own close, and the open server keeps the run from ending. */
const started = new Set();
const startServer = async (/** @type {Parameters<typeof startGeminiServer>[0]} */ o) => {
  const s = await startGeminiServer(o);
  started.add(s);
  return s;
};
afterEach(async () => {
  for (const s of started) await s.close();
  started.clear();
});

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
/** The conversation so far as messages, after a call's reply. @param {any[]} messages @param {any} r */
const said1 = (messages, r) => [...messages, msg('assistant', ...r.reply.parts)];

/** A Kept on memory storage, on a clock the test moves; state.alive: whether a turn may be kept now, as the service checks it. */
async function keptKit() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const clock = { t: T0 };
  const state = { alive: true };
  const kept = new Kept({ ws, now: () => clock.t, alive: async () => state.alive });
  return { store, ws, clock, state, kept, file: async () => ws.readJSON(SYS_DEVICE, '/llm/kept.json') };
}
const A = { scope: 'trip-a', key: 'K' };
/** As the gemini type keeps them: tracked 55 days, a chain continued 23 hours; made by key K. @param {Partial<Parameters<Kept['record']>[0]>} [over] */
const turn = (over = {}) => ({ id: 'v1_a', endpoint: 'pv-g/chat', scope: 'trip-a', key: 'K', messages: [m1], reply: r1, days: 55, hours: 23, ...over });

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
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, tr], A), { id: 'v1_a', from: 2 });
});

test('a changed history, a one-off call, another endpoint or trip, a reply not as kept, nothing new after it: no match', async () => {
  const { kept } = await keptKit();
  await kept.record(turn());
  assert.equal(await kept.match('pv-g/chat', [msg('user', text('Where can we drink?')), r1, tr], A), null, 'a changed history');
  assert.equal(await kept.match('pv-g/chat', [msg('user', text('Summarize this.'))], A), null, 'a one-off call');
  assert.equal(await kept.match('pv-other/chat', [m1, r1, tr], A), null, 'another endpoint');
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr], { scope: 'trip-b', key: 'K' }), null, "another trip's conversation never continues this one's");
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr], { scope: 'trip-a', key: 'K2' }), null, 'another key or address');
  assert.equal(await kept.match('pv-g/chat', [m1, msg('assistant', text('cut short')), tr], A), null, 'a reply other than the one kept (cut off where it was heard)');
  assert.equal(await kept.match('pv-g/chat', [m1, r1], A), null, 'nothing after the reply to send');
});

test('the longest kept turn wins', async () => {
  const { kept, clock } = await keptKit();
  await kept.record(turn());
  clock.t += 60_000;
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a' }));
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, tr, r2, m3], A), { id: 'v1_b', from: 4 });
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, msg('user', text('Never mind.'))], A), { id: 'v1_a', from: 2 }, 'a shorter one still serves another way on');
});

test('two lifetimes, whatever the key: a chain is continued for 23 hours after its first turn (a free key keeps a turn a day), and each turn is tracked for 55 days, the longest Google keeps one', async () => {
  const { kept, clock, file } = await keptKit();
  await kept.record(turn());
  clock.t += 22 * 3600_000;
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, tr], A), { id: 'v1_a', from: 2 });
  clock.t += 1.5 * 3600_000; // 23.5 hours: an unmarked free key's first turn may be gone already
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr], A), null, 'sent whole: a fresh chain');
  assert.deepEqual(await kept.count(), { turns: 1, waiting: 0, until: T0 + 55 * DAY, endpoints: ['pv-g/chat'] }, 'still tracked, to be deleted when removed');
  clock.t = T0 + 55 * DAY + 1;
  assert.deepEqual(await kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
  assert.deepEqual(await file(), { turns: [], forget: [], pending: [] }, 'past 55 days Google has deleted it: dropped, nothing to delete');
});

test("a chain holds only while its first turn is there: Google silently drops a deleted or expired turn's content from the turns after it", async () => {
  const { kept, clock } = await keptKit();
  await kept.record(turn());
  clock.t += 20 * 3600_000;
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a' }));
  clock.t += 3.5 * 3600_000; // the first is 23.5 hours old
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr, r2, m3], A), null, 'sent whole: a new chain');
  assert.deepEqual(await kept.count({ provider: 'pv-g' }), { turns: 2, waiting: 0, until: T0 + 20 * 3600_000 + 55 * DAY, endpoints: ['pv-g/chat'] });
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
  assert.deepEqual(f.forget[0], { id: 'v1_old1', endpoint: 'pv-g/chat', key: 'K', until: T0 + 55 * DAY });
});

test('forget: a turn Google no longer has takes its chain with it; the rest of the chain is queued for deletion', async () => {
  const { kept, file } = await keptKit();
  await kept.record(turn());
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a' }));
  await kept.record(turn({ id: 'v1_other', messages: [msg('user', text('Hello'))], reply: msg('assistant', text('Hi')) }));
  await kept.forget('v1_b', true);
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

/** A conversation's turn (main, its parts kept), or another call, through callRole. free: the key is marked as on the free tier */
async function callKit(/** @type {any} */ replies, /** @type {Record<string, any>} */ tunables = {}, { free = false } = {}) {
  const s = await startServer({ key: KEY, replies });
  const k = await keptKit();
  const config = gemConfig(s.url, tunables, free);
  /** @param {any[]} messages @param {Record<string, any>} [o] */
  const call = (messages, o = {}) => callRole({
    role: 'main', config, types: new Map([['gemini', type]]), bench: new Bench(), keyFor: async () => KEY, kept: k.kept, scope: 'trip-a',
    record: { keepParts: true }, trace: modelTrace(k.store, 'trip-a'), request: { messages, tail: 'Now: 12:00, Kyōto.', tools: [TOOL] }, ...o,
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
      { type: 'user_input', content: [{ type: 'text', text: 'Now: 12:00, Kyōto.' }] },
    ], 'the tool result and the now block: nothing Google keeps');
    const [q1, q2] = await c.requests();
    assert.deepEqual([q1.kept, q2.kept], [undefined, { from: 2 }]);
    assert.deepEqual([q1.bytes, q2.bytes], [Buffer.byteLength(JSON.stringify(b1)), Buffer.byteLength(JSON.stringify(b2))], 'in bytes, as UTF-8: ō is two');
    assert.deepEqual(await c.kept.count(), { turns: 2, waiting: 0, until: T0 + 55 * DAY, endpoints: ['pv-g/chat'] });
    // Its third turn continues the second.
    await c.call([m1, said, tr, msg('assistant', ...second.reply.parts), m3]);
    assert.equal(c.s.bodies()[2].previous_interaction_id, 'v1_stand-in-2');
  } finally {
    await c.s.close();
  }
});

test("warm housekeeping borrows the live chain (Gemini too): previous_interaction_id and only what is new, its interaction deleted at once, nothing recorded, and the next real turn goes on from the last real one", async () => {
  const c = await callKit([{ text: 'Ichiran.' }, { text: 'Summary.' }, { text: 'Yes, until 23:00.' }]);
  try {
    const r = await c.call([m1]);
    const m = [...said1([m1], r), m3];
    const h = await c.call(m, { record: { tag: 'compaction' }, borrow: true, request: { messages: m, tail: '[annai: housekeeping] Summarize.', tools: [TOOL] } });
    assert.equal(h.reply.text, 'Summary.');
    const hb = c.s.bodies()[1];
    assert.deepEqual([hb.store, hb.previous_interaction_id], [true, 'v1_stand-in-1']);
    assert.match(JSON.stringify(hb.input), /Summarize/);
    assert.ok(JSON.stringify(hb.input).includes('Is it open now?') && !JSON.stringify(hb.input).includes('Where can we eat?'), 'only the new message and the summary request');
    assert.deepEqual(c.s.deleted(), ['v1_stand-in-2']);
    assert.deepEqual(c.s.stored(), ['v1_stand-in-1']);
    assert.deepEqual((await c.file()).turns.map((/** @type {any} */ t) => t.id), ['v1_stand-in-1']);
    await c.call(m);
    assert.equal(c.s.bodies()[2].previous_interaction_id, 'v1_stand-in-1');
    // No live chain: the whole conversation, stored nowhere.
    const fresh = await callKit([{ text: 'Summary.' }]);
    try {
      await fresh.call([m1], { record: { tag: 'compaction' }, borrow: true });
      assert.deepEqual([fresh.s.bodies()[0].store, fresh.s.bodies()[0].previous_interaction_id], [false, undefined]);
    } finally {
      await fresh.s.close();
    }
  } finally {
    await c.s.close();
  }
});

test("warm housekeeping in the agent's real shape (the conversation ends with the last reply) continues that very turn and sends only the summary request", async () => {
  const c = await callKit([{ text: 'Ichiran.' }, { text: 'Summary.' }]);
  try {
    const r = await c.call([m1]);
    const m = said1([m1], r); // [question, reply]
    await c.call(m, { record: { tag: 'compaction' }, borrow: true, request: { messages: m, tail: '[annai: housekeeping] Summarize.', tools: [TOOL] } });
    const hb = c.s.bodies()[1];
    assert.deepEqual([hb.store, hb.previous_interaction_id], [true, 'v1_stand-in-1']);
    assert.ok(JSON.stringify(hb.input).includes('Summarize') && !JSON.stringify(hb.input).includes('Where can we eat?'), 'only the summary request');
    assert.deepEqual(c.s.stored(), ['v1_stand-in-1']);
  } finally {
    await c.s.close();
  }
});

test('a real turn never matches a conversation with nothing new after the reply; only a borrow does', async () => {
  const { kept } = await keptKit();
  await kept.record(turn());
  assert.equal(await kept.match('pv-g/chat', [m1, r1], A), null);
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1], { ...A, borrow: true }), { id: 'v1_a', from: 2 });
});

test('the interaction id is written down as soon as Google names it, and replaced when the turn ends (pending)', async () => {
  const c = await callKit([{ text: 'Ichiran.', delayMs: 400 }]);
  try {
    const p = c.call([m1]);
    await new Promise((r) => setTimeout(r, 200));
    const mid = await c.file();
    assert.deepEqual(mid.pending.map((/** @type {any} */ x) => [x.id, x.endpoint, x.scope]), [['v1_stand-in-1', 'pv-g/chat', 'trip-a']]);
    await p;
    const end = await c.file();
    assert.deepEqual([end.pending, end.turns.map((/** @type {any} */ t) => t.id)], [[], ['v1_stand-in-1']]);
  } finally {
    await c.s.close();
  }
});

test("a pending turn older than a call can last is queued for deletion at the next drain, unless a call of this very process still owns it; a recent one stays; a removal lets go of a provider's", async () => {
  const { kept, clock, file, ws } = await keptKit();
  const send = { resolve: async () => null };
  await kept.pending({ id: 'v1_old', endpoint: 'pv-g/chat', scope: 'trip-a', key: 'K', days: 55 });
  clock.t += 20 * 60_000;
  await kept.pending({ id: 'v1_recent', endpoint: 'pv-g/chat', scope: 'trip-a', key: 'K', days: 55 });
  // Its call is still answering: a drain leaves it.
  await kept.drain({ ...send, fetch: async () => new Response('{}') });
  assert.deepEqual((await file()).forget, []);
  // annai started again (another Kept reads the file): no call owns it.
  const again = new Kept({ ws, now: () => clock.t });
  await again.drain({ ...send, fetch: async () => new Response('{}') });
  const f = await file();
  assert.deepEqual(f.forget.map((/** @type {any} */ d) => d.id), ['v1_old']);
  assert.deepEqual(f.pending.map((/** @type {any} */ d) => d.id), ['v1_recent']);
  await kept.drop('pv-g');
  assert.deepEqual((await file()).pending, []);
});

test('a call that ended no longer owns its pending id: the next drain, past the time, deletes it', async () => {
  const { kept, clock, file } = await keptKit();
  await kept.pending({ id: 'v1_a', endpoint: 'pv-g/chat', scope: 'trip-a', key: 'K', days: 55 });
  clock.t += 20 * 60_000;
  kept.ended('v1_a');
  await kept.drain({ resolve: async () => null, fetch: async () => new Response('{}') });
  assert.deepEqual((await file()).forget.map((/** @type {any} */ d) => d.id), ['v1_a']);
});

test("count includes pending ids; queue leaves a call's own and takes an orphan's; release takes all", async () => {
  const { ws, clock, file } = await keptKit();
  // Another process left one pending; this one's call is answering another.
  await new Kept({ ws, now: () => clock.t }).pending({ id: 'v1_orphan', endpoint: 'pv-g/chat', scope: 'trip-a', key: 'K', days: 55 });
  const kept = new Kept({ ws, now: () => clock.t });
  await kept.pending({ id: 'v1_live', endpoint: 'pv-g/chat', scope: 'trip-a', key: 'K', days: 55 });
  assert.equal((await kept.count({ provider: 'pv-g' })).turns, 2);
  assert.equal(await kept.queue({ provider: 'pv-g' }), 0);
  assert.deepEqual((await file()).forget.map((/** @type {any} */ d) => d.id), ['v1_orphan'], "a call's own is left to that call; the other process's is not");
  await kept.release();
  assert.deepEqual((await file()).forget.map((/** @type {any} */ d) => d.id).sort(), ['v1_live', 'v1_orphan']);
  assert.deepEqual((await file()).pending, []);
});

test('record: a chain ends at the earliest limit given (a photo\'s expiry), carried down the chain', async () => {
  const { kept, clock, file } = await keptKit();
  await kept.record(turn({ limit: T0 + 2 * 3600_000 }));
  clock.t += 60_000;
  await kept.record(turn({ id: 'v1_b', messages: [m1, r1, tr], reply: r2, after: 'v1_a', limit: T0 + 5 * 3600_000 }));
  assert.deepEqual((await file()).turns.map((/** @type {any} */ t) => t.ends), [T0 + 2 * 3600_000, T0 + 2 * 3600_000]);
  assert.deepEqual(await kept.match('pv-g/chat', [m1, r1, tr, r2, m3], A), { id: 'v1_b', from: 4 });
  clock.t = T0 + 3 * 3600_000;
  assert.equal(await kept.match('pv-g/chat', [m1, r1, tr, r2, m3], A), null);
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

test('a call that fails after Google kept its turn deletes it before it settles; one it cannot delete is queued', async () => {
  const k = await keptKit();
  const sse = [
    { event_type: 'interaction.created', interaction: { id: 'v1_half', object: 'interaction' } },
    { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
    { event_type: 'error', error: { code: 'internal', message: 'Internal error.' } },
  ].map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  /** @type {string[]} */
  const deleted = [];
  let online = true;
  const call = () => callRole({
    role: 'main', config: gemConfig('https://generativelanguage.googleapis.com'), types: new Map([['gemini', type]]), bench: new Bench(), keyFor: async () => KEY,
    kept: k.kept, scope: 'trip-a', record: { keepParts: true }, sleep: async () => {}, request: { messages: [m1] },
    fetch: async (url, init) => {
      if (init.method === 'DELETE') {
        if (!online) throw new TypeError('Failed to fetch');
        deleted.push(String(url));
        return new Response('{}');
      }
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await assert.rejects(call());
  assert.deepEqual(deleted.map((u) => u.split('/').pop()), ['v1_half', 'v1_half', 'v1_half'], 'each of its three tries deleted what it kept');
  assert.deepEqual((await k.file())?.turns ?? [], [], 'nothing to remember');
  assert.deepEqual((await k.file())?.pending ?? [], [], 'and nothing pending');
  online = false;
  await assert.rejects(call());
  assert.deepEqual((await k.file()).forget.map((/** @type {any} */ f) => f.id), ['v1_half'], "a deletion that couldn't go waits, once");
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
 * and two trips. online: false makes every request to the stand-in fail, as with no connection. replyDelay: each answer
 * pauses after Google names its turn; deleteDelay: each deletion takes that long; anyKey: the stand-in takes any key.
 */
async function serviceKit({ replyDelay = 0, deleteDelay = 0, anyKey = false } = {}) {
  const { hostKit } = await import('./package-kit.js');
  const { createLlm } = await import('../../src/core/llm/service.js');
  const { createTrip } = await import('../../src/core/scopes.js');
  const s = await startServer({ ...(anyKey ? {} : { key: KEY }), replies: [(b) => ({ text: `Answer ${b.input.length}`, delayMs: replyDelay })] });
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const net = { online: true };
  /** @type {string[]} what happened, in order: each DELETE, and the key's removal */
  const order = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).startsWith(s.url)) {
      if (!net.online) throw new TypeError('Failed to fetch');
      if (init?.method === 'DELETE') {
        order.push(`DELETE ${decodeURIComponent(String(url).split('/').pop() ?? '')}`);
        if (deleteDelay) await new Promise((r) => setTimeout(r, deleteDelay));
      }
      return globalThis.fetch(url, init);
    }
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch });
  const id = await llm.addProvider('provider-gemini', { roles: 'recommended', key: KEY, baseUrl: s.url, official: true });
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
  /** A turn being answered in a trip: settles once Google has named it, with the call's own promise (wrapped, so it isn't awaited). @param {string} scope @param {string} q */
  const answering = async (scope, q) => {
    const n = s.bodies().length;
    const call = llm.call({ role: 'main', scope, request: { messages: [msg('user', text(q))] }, record: { keepParts: true } });
    call.catch(() => {});
    for (let i = 0; i < 200 && s.bodies().length === n; i++) await new Promise((r) => setTimeout(r, 5));
    return { call };
  };
  /** The Chat ability's keep switch, saved as the provider page saves it. @param {boolean} [on] */
  const switchOff = async (on = false) => {
    const { readConfig, saveProvider } = await import('../../src/core/llm/config.js');
    const rec = (await readConfig(k.ws)).providers[id];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user.abilities, chat: { ...rec.user.abilities?.chat, tunables: { keep: on } } } } });
  };
  const c = { s, ...k, llm, id, tripA, tripB, talk, net, order, keptFile, fetch, answering, switchOff };
  return c;
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
    await c.switchOff();
    assert.deepEqual(await c.llm.forgetEndpoint(`${c.id}/chat`), { queued: 3 });
    await c.llm.drainKept();
    assert.deepEqual(c.s.stored(), []);
    assert.equal(c.s.deleted().length, 3);
    // Back on: a new chain, sent whole.
    await c.switchOff(true);
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
    assert.deepEqual(await c.keptFile(), { turns: [], forget: [], pending: [] });

    const off = await serviceKit();
    try {
      await off.talk(off.tripA, 3);
      off.net.online = false;
      assert.deepEqual(await off.llm.keptCount({ provider: off.id }), { turns: 3, waiting: 0, days: 55, who: ['Google'] });
      const { keptWords } = await import('../../src/ui/screens/provider.js');
      assert.equal(keptWords(await off.llm.keptCount({ provider: off.id }), false), 'Google keeps 3 turns until they expire, up to 55 days.');
      assert.equal(keptWords(await off.llm.keptCount({ provider: off.id }), true, true),
        "With a new key or address, or Remove key, annai first asks Google to delete the 3 turns of your conversations it keeps; any it can't in 10 seconds, Google keeps until they expire, up to 55 days.");
      assert.equal(keptWords(await off.llm.keptCount({ provider: off.id }), false, true), 'Offline, a new key or address, or Remove key, leaves Google the 3 turns it keeps until they expire, up to 55 days.');
      const started = Date.now();
      await off.llm.removeProvider(off.id);
      assert.ok(Date.now() - started < 10_000);
      assert.deepEqual(await off.keptFile(), { turns: [], forget: [], pending: [] }, "none of that provider's");
      assert.deepEqual(off.s.deleted(), []);
    } finally {
      await off.s.close();
    }
  } finally {
    await c.s.close();
  }
});

test("removing a trip, and Erase, forget the photos' hashes kept for uploads: removing means removing in memory too (re-verification, 3)", async () => {
  const { photoHash } = await import('../../src/core/llm/call.js');
  const c = await serviceKit();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let digests = 0;
  crypto.subtle.digest = /** @type {any} */ ((/** @type {any[]} */ ...a) => { digests++; return /** @type {any} */ (digest)(...a); });
  try {
    for (const forget of [() => c.llm.forgetScope(c.tripA), () => c.llm.forgetAll({ timeoutMs: 0 })]) {
      await photoHash('a2lvdG8gcGhvdG8=');
      digests = 0;
      await photoHash('a2lvdG8gcGhvdG8=');
      assert.equal(digests, 0, 'kept');
      await forget();
      await photoHash('a2lvdG8gcGhvdG8=');
      assert.equal(digests, 1, 'forgotten');
    }
  } finally {
    crypto.subtle.digest = digest;
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
    // Erase lasts: a turn answered after it is deleted at once, with its call's key.
    await c.talk(c.tripA, 1);
    assert.deepEqual(c.s.stored(), []);
  } finally {
    await c.s.close();
  }
  const off = await serviceKit();
  try {
    await off.talk(off.tripA, 1);
    off.net.online = false;
    assert.deepEqual(await off.llm.forgetAll({ timeoutMs: 200 }), { left: 1 });
  } finally {
    await off.s.close();
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
  /** @type {string[]} */
  const deleted = [];
  const r = await callRole({
    role: 'main', config: gemConfig('https://generativelanguage.googleapis.com'), types: new Map([['gemini', loadGemini()]]), bench: new Bench(), keyFor: async () => KEY,
    kept: k.kept, scope: 'trip-a', record: { keepParts: true }, request: { messages: [m1] },
    fetch: async (url, init) => (init.method === 'DELETE' ? (deleted.push(String(url).split('/').pop() ?? ''), new Response('{}')) : new Response(sse, { headers: { 'content-type': 'text/event-stream' } })),
  });
  assert.equal(r.reply.stop, 'refusal');
  assert.deepEqual(deleted, ['v1_refused']);
  assert.deepEqual((await k.file())?.turns ?? [], [], 'never remembered');
  assert.deepEqual((await k.file())?.pending ?? [], []);
});

test('the record-time check: a turn still being answered when it may no longer be kept (its provider going, its key changed, its switch off, its trip gone) is deleted at once, with the key its call holds', async () => {
  const c = await callKit([{ text: 'Ichiran.', delayMs: 300 }]);
  try {
    const answering = c.call([m1]);
    for (let i = 0; i < 100 && !c.s.bodies().length; i++) await new Promise((r) => setTimeout(r, 5));
    c.state.alive = false; // as the service would answer now
    assert.equal((await answering).reply.text, 'Ichiran.');
    assert.deepEqual(c.s.deleted(), ['v1_stand-in-1']);
    assert.deepEqual(c.s.stored(), []);
    assert.deepEqual(await c.kept.count(), { turns: 0, waiting: 0, until: 0, endpoints: [] });
  } finally {
    await c.s.close();
  }
});

test("a key marked free that is really paid: its turns are still tracked, and deleted when their trip is removed on day 10", async () => {
  const c = await callKit([{ text: 'OK' }], {}, { free: true });
  try {
    await c.call([m1]);
    c.clock.t += 10 * DAY;
    assert.equal(await c.kept.queue({ scope: 'trip-a' }), 1);
    const done = await c.kept.drain({ fetch, resolve: async () => ({ type, endpoint: endpointOf(type, { baseUrl: c.s.url }), key: KEY, print: await keyPrint(KEY, c.s.url) }) });
    assert.deepEqual([done, c.s.deleted()], [{ done: 1, left: 0 }, ['v1_stand-in-1']]);
  } finally {
    await c.s.close();
  }
});

test('an unmarked free key: a chain 23.5 hours old is sent whole, as its first turn may be gone', async () => {
  const c = await callKit([{ text: 'Ichiran.' }, { text: 'Yes.' }]);
  try {
    const r = await c.call([m1]);
    c.clock.t += 23.5 * 3600_000;
    await c.call([m1, msg('assistant', ...r.reply.parts), m3]);
    assert.equal(c.s.bodies()[1].previous_interaction_id, undefined);
  } finally {
    await c.s.close();
  }
});

test('a chained call Google refuses as a bad request is sent once more whole, so chaining is never worse than a whole send; a forgotten turn on a call that continued nothing is not-found; a whole retry that fails again stops', async () => {
  const BAD = { error: { status: 400, body: { error: { message: 'Invalid value at input.', code: 'invalid_request' } } } };
  const NF = { error: { status: 404, body: { error: { message: 'Requested entity was not found.', code: 'not_found' } } } };
  const c = await callKit([(/** @type {any} */ b) => (b.previous_interaction_id ? BAD : { text: 'OK' })]);
  try {
    const r = await c.call([m1]);
    const again = await c.call([m1, msg('assistant', ...r.reply.parts), m3]);
    assert.deepEqual(again.attempts.map((a) => a.outcome), ['bad-request', 'ok']);
    assert.deepEqual(c.s.bodies().map((b) => Boolean(b.previous_interaction_id)), [false, true, false]);
  } finally {
    await c.s.close();
  }
  const d = await callKit([{ text: 'A' }, NF]);
  try {
    const r = await d.call([m1]);
    const failed = await d.call([m1, msg('assistant', ...r.reply.parts), m3], { sleep: async () => {} }).catch((e) => e);
    assert.deepEqual(failed.attempts.map((/** @type {any} */ a) => a.outcome), ['forgotten', 'not-found'], 'once whole, then no more');
    assert.equal(d.s.bodies().length, 3);
    const unchained = await d.call([msg('user', text('Fresh.'))], { sleep: async () => {} }).catch((e) => e);
    assert.deepEqual(unchained.attempts.map((/** @type {any} */ a) => a.outcome), ['not-found']);
  } finally {
    await d.s.close();
  }
});

test("the placeholder for heard words nothing wrote down isn't the segment: once written down, the message differs and goes whole", async () => {
  const c = await callKit([{ text: 'Sorry?' }, { text: 'Ichiran.' }]);
  try {
    let written = false;
    const speech = async (/** @type {any} */ _model, /** @type {any} */ request) => ({ ...request, messages: request.messages.map((/** @type {any} */ m) => ({ ...m,
      parts: m.parts.map((/** @type {any} */ p) => (p.type !== 'speech' ? p : { type: 'text', text: written ? 'Where can we eat?' : '[audio, not transcribed]' })) })) });
    const heard = msg('user', { type: 'speech', id: 'heard-2' });
    const r = await c.call([heard], { speech });
    written = true;
    await c.call([heard, msg('assistant', ...r.reply.parts), m3], { speech });
    assert.equal(c.s.bodies()[1].previous_interaction_id, undefined);
  } finally {
    await c.s.close();
  }
});

test("a turn that can't be written down (storage full) is deleted at once with the call's key, and the store reads its file again", async () => {
  const c = await callKit([{ text: 'OK' }, { text: 'Again.' }]);
  try {
    const write = c.ws.write.bind(c.ws);
    c.ws.write = async () => { throw new Error('QuotaExceededError'); };
    await c.call([m1]);
    assert.deepEqual([c.s.deleted(), c.s.stored()], [['v1_stand-in-1'], []]);
    c.ws.write = write;
    await c.call([m1]);
    assert.deepEqual((await c.file()).turns.map((/** @type {any} */ t) => t.id), ['v1_stand-in-2'], 'nothing of the failed write left in memory');
  } finally {
    await c.s.close();
  }
});

test('a 429 to a deletion rests that endpoint until later: the next drain sends nothing to it until then', async () => {
  const k = await keptKit();
  await k.kept.record(turn());
  await k.kept.record(turn({ id: 'v1_b', messages: [msg('user', text('Other'))], reply: r2 }));
  await k.kept.queue();
  /** @type {string[]} */
  const sent = [];
  let busy = true;
  const deleting = async (/** @type {any} */ url) => { sent.push(String(url)); return busy ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : new Response('{}'); };
  const resolve = async () => ({ type, endpoint: endpointOf(type), key: KEY, print: 'K' });
  assert.deepEqual(await k.kept.drain({ fetch: deleting, resolve }), { done: 0, left: 2 });
  assert.equal(sent.length, 1, 'stopped at the first 429');
  busy = false;
  assert.deepEqual(await k.kept.drain({ fetch: deleting, resolve }), { done: 0, left: 2 }, 'still resting');
  assert.equal(sent.length, 1);
  k.clock.t += 31_000;
  assert.deepEqual(await k.kept.drain({ fetch: deleting, resolve }), { done: 2, left: 0 });
});

// ---- Removals racing with a turn still being answered (the review's RACE 1–3) ----

test('RACE 1: the provider is removed while a turn is answered: the turn, kept during the removal, is deleted with the key its call holds', async () => {
  const c = await serviceKit({ replyDelay: 150, deleteDelay: 400 });
  try {
    await c.talk(c.tripA, 1); // one kept already, so the removal's deletions take a while
    const { call: p } = await c.answering(c.tripA, 'still being answered');
    await c.llm.removeProvider(c.id);
    await p.catch(() => {});
    assert.deepEqual(c.s.stored(), [], 'nothing left with Google');
    assert.deepEqual(await c.keptFile(), { turns: [], forget: [], pending: [] });
  } finally {
    await c.s.close();
  }
});

test('RACE 2: the switch is turned off while a turn is answered: that turn is deleted too, and later turns, switched on again, are kept', async () => {
  const c = await serviceKit({ replyDelay: 200 });
  try {
    const { call: p } = await c.answering(c.tripA, 'q');
    await c.switchOff();
    await c.llm.forgetEndpoint(`${c.id}/chat`);
    await p;
    await c.llm.drainKept();
    assert.deepEqual(c.s.stored(), [], 'switched off: nothing left with Google');
    await c.switchOff(true);
    await c.talk(c.tripA, 1);
    assert.equal(c.s.stored().length, 1, 'on again: kept as before');
  } finally {
    await c.s.close();
  }
});

test('RACE 3: the trip is removed while a turn is answered: once the call ends, its turn is deleted', async () => {
  const c = await serviceKit({ replyDelay: 200 });
  try {
    const { call: p } = await c.answering(c.tripA, 'q');
    const { removeTrip } = await import('../../src/core/scopes.js');
    await removeTrip(c.store, c.tripA);
    await c.llm.forgetScope(c.tripA);
    await p;
    for (let i = 0; i < 100 && c.s.stored().length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(c.s.stored(), [], 'deleted soon after');
  } finally {
    await c.s.close();
  }
});

test('Remove key, or a new key: what Google keeps is deleted first with the old key; what is left goes with it; nothing is ever deleted with a key other than the one that made it', async () => {
  const c = await serviceKit({ anyKey: true, replyDelay: 150 });
  try {
    const { setKey, getKey } = await import('../../src/core/llm/config.js');
    await c.talk(c.tripA, 1);
    await c.llm.reconnect(c.id, () => setKey(c.store, c.id, 'AIza-the-new-key-0123456789'));
    await c.talk(c.tripB, 1);
    const { call: p } = await c.answering(c.tripB, 'answered while the key goes');
    await c.llm.reconnect(c.id, () => setKey(c.store, c.id, null));
    await p;
    assert.equal(await getKey(c.store, c.id), null);
    const deletes = c.s.requests().filter((r) => r.method === 'DELETE').map((r) => [decodeURIComponent(r.url.split('/').pop() ?? ''), r.headers['x-goog-api-key']]);
    assert.deepEqual(deletes.sort(), [['v1_stand-in-1', KEY], ['v1_stand-in-2', 'AIza-the-new-key-0123456789'], ['v1_stand-in-3', 'AIza-the-new-key-0123456789']]);
    assert.deepEqual([c.s.stored(), await c.keptFile()], [[], { turns: [], forget: [], pending: [] }]);
    // Offline, a key change lets go of what it couldn't delete: no other key will ever try.
    await setKey(c.store, c.id, KEY);
    await c.talk(c.tripA, 1);
    c.net.online = false;
    await c.llm.reconnect(c.id, () => setKey(c.store, c.id, 'AIza-another-key-0123456789'));
    assert.deepEqual(await c.keptFile(), { turns: [], forget: [], pending: [] });
  } finally {
    await c.s.close();
  }
});

test("deletions of a provider that vanished another way (a restore replacing settings) wait, never dropped, until Google has deleted the turns anyway", async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 1);
    c.net.online = false;
    await c.llm.forgetScope(c.tripA);
    await c.llm.drainKept();
    const { removeProviderRecords } = await import('../../src/core/llm/config.js');
    await removeProviderRecords(c.ws, c.store, c.id); // not through annai's removal
    c.net.online = true;
    assert.deepEqual(await c.llm.drainKept(), { done: 0, left: 1 });
    assert.deepEqual(c.s.deleted(), []);
  } finally {
    await c.s.close();
  }
});

test('Review Focus 1 through callRole: Gemini rate-limited, another provider answers; the next Gemini turn goes after its own kept one, the other model\'s reply as a model_output, nothing twice', async () => {
  const k = await keptKit();
  const s = await startServer({ key: KEY, replies: [(/** @type {any} */ b) => (JSON.stringify(b.input).includes('Is it open?')
    && !JSON.stringify(b.input).includes('Book it.') ? { error: { status: 429, body: { error: { message: 'Resource exhausted. Please retry in 44s.', code: 'too_many_requests' } } } } : { text: 'Ichiran, 200 m away.' })] });
  try {
    const config = gemConfig(s.url);
    config.providers['pv-o'] = { id: 'pv-o', plugin: 'provider-other', template: null, user: { name: 'Other', baseUrl: 'https://other.test', abilities: { chat: { kind: 'chat', type: 'other' } } }, created: 0 };
    config.models['m-o'] = { id: 'm-o', provider: 'pv-o', ability: 'chat', template: null, user: { providerId: 'other-1' }, created: 0 };
    config.roles.main.models = ['m-l', 'm-o'];
    const other = { type: 'other', name: 'Other', pluginId: 'other', run: async function* () { yield { type: 'text', text: 'Yes, until 23:00.' }; } };
    const call = (/** @type {any[]} */ messages) => callRole({ role: 'main', config, types: new Map([['gemini', type], ['other', other]]), bench: new Bench(), keyFor: async () => KEY,
      kept: k.kept, scope: 'trip-a', record: { keepParts: true }, sleep: async () => {}, request: { messages } });
    const a = await call([m1]);
    const r1x = msg('assistant', ...a.reply.parts);
    const m2 = msg('user', text('Is it open?'));
    const b = await call([m1, r1x, m2]);
    assert.equal(b.answeredBy, 'other-1');
    const r2x = msg('assistant', ...b.reply.parts);
    await call([m1, r1x, m2, r2x, msg('user', text('Book it.'))]);
    const last = s.bodies().at(-1);
    assert.equal(last.previous_interaction_id, 'v1_stand-in-1');
    assert.deepEqual(last.input, [
      { type: 'user_input', content: [{ type: 'text', text: 'Is it open?' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Yes, until 23:00.' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'Book it.' }] },
    ]);
  } finally {
    await s.close();
  }
});

test("a deletion is sent only with the key and address that made the turn: under another key it waits, never sent", async () => {
  const k = await keptKit();
  await k.kept.record(turn());
  await k.kept.queue();
  /** @type {string[]} */
  const sent = [];
  const fetchAll = async (/** @type {any} */ url) => { sent.push(String(url)); return new Response('{}'); };
  assert.deepEqual(await k.kept.drain({ fetch: fetchAll, resolve: async () => ({ type, endpoint: endpointOf(type), key: 'AIza-another', print: 'K2' }) }), { done: 0, left: 1 });
  assert.deepEqual(sent, []);
  assert.deepEqual(await k.kept.drain({ fetch: fetchAll, resolve: async () => ({ type, endpoint: endpointOf(type), key: KEY, print: 'K' }) }), { done: 1, left: 0 });
});

test('a drain goes on past a deletion that failed to the rest; no answer (offline) leaves the rest of that endpoint for next time', async () => {
  const k = await keptKit();
  await k.kept.record(turn());
  await k.kept.record(turn({ id: 'v1_b', messages: [msg('user', text('Other'))], reply: r2 }));
  await k.kept.queue();
  /** @type {string[]} */
  const sent = [];
  const resolve = async () => ({ type, endpoint: endpointOf(type), key: KEY, print: 'K' });
  const failing = async (/** @type {any} */ url) => { sent.push(String(url).split('/').pop() ?? ''); return new Response('{}', { status: sent.length === 1 ? 500 : 200 }); };
  assert.deepEqual(await k.kept.drain({ fetch: failing, resolve }), { done: 1, left: 1 });
  assert.deepEqual(sent, ['v1_a', 'v1_b']);
  const offline = async () => { sent.push('x'); throw new TypeError('Failed to fetch'); };
  await k.kept.record(turn({ id: 'v1_c', messages: [msg('user', text('Third'))], reply: r2 }));
  await k.kept.queue();
  assert.deepEqual(await k.kept.drain({ fetch: offline, resolve }), { done: 0, left: 2 });
  assert.equal(sent.length, 3, 'one try, then that endpoint waits');
});

// ---- The second review's VERIFY A–E ----

test('VERIFY A: switch off, then a new key, while a turn is answered: no deletion goes with the new key', async () => {
  const c = await serviceKit({ anyKey: true, replyDelay: 300 });
  try {
    const { setKey } = await import('../../src/core/llm/config.js');
    const { call: p } = await c.answering(c.tripA, 'q');
    await c.switchOff();
    await c.llm.forgetEndpoint(`${c.id}/chat`);
    await c.llm.reconnect(c.id, () => setKey(c.store, c.id, 'AIza-the-new-key-0123456789'));
    await p;
    await c.llm.drainKept();
    const deletes = c.s.requests().filter((r) => r.method === 'DELETE').map((r) => [decodeURIComponent(r.url.split('/').pop() ?? ''), r.headers['x-goog-api-key']]);
    assert.deepEqual(deletes, [['v1_stand-in-1', KEY]], 'once, with the key that made it');
    assert.deepEqual(c.s.stored(), []);
  } finally {
    await c.s.close();
  }
});

test('VERIFY B: a chained bad request: the turn it continued is still at Google, so its deletion is queued, not dropped', async () => {
  const BAD = { error: { status: 400, body: { error: { message: 'Invalid value at input.', code: 'invalid_request' } } } };
  const c = await callKit([(/** @type {any} */ b) => (b.previous_interaction_id ? BAD : { text: 'OK' })]);
  try {
    const r = await c.call([m1]);
    await c.call([m1, msg('assistant', ...r.reply.parts), m3]);
    const f = await c.file();
    const known = new Set([...f.turns.map((/** @type {any} */ t) => t.id), ...f.forget.map((/** @type {any} */ d) => d.id)]);
    assert.ok(c.s.stored().every((id) => known.has(id)), 'every turn at Google is one annai knows');
    assert.deepEqual(f.forget.map((/** @type {any} */ d) => d.id), ['v1_stand-in-1']);
  } finally {
    await c.s.close();
  }
});

test('VERIFY C: the switch goes off while the first model of the list fails; the next model keeps nothing, as it is checked when its turn is recorded', async () => {
  const k = await keptKit();
  const s = await startServer({ key: KEY, replies: [{ text: 'OK' }] });
  try {
    const { ProviderError } = await import('../../src/core/llm/contract.js');
    const config = gemConfig(s.url);
    config.providers['pv-o'] = { id: 'pv-o', plugin: 'provider-other', template: null, user: { name: 'Other', baseUrl: 'https://other.test', abilities: { chat: { kind: 'chat', type: 'other' } } }, created: 0 };
    config.models['m-o'] = { id: 'm-o', provider: 'pv-o', ability: 'chat', template: null, user: { providerId: 'other-1' }, created: 0 };
    config.roles.main.models = ['m-o', 'm-l'];
    const other = { type: 'other', name: 'Other', pluginId: 'other', run: async function* () { await new Promise((r) => setTimeout(r, 100)); throw new ProviderError('auth', 'no'); } };
    const p = callRole({ role: 'main', config, types: new Map([['gemini', type], ['other', other]]), bench: new Bench(), keyFor: async () => KEY,
      kept: k.kept, scope: 'trip-a', record: { keepParts: true }, sleep: async () => {}, request: { messages: [m1] } });
    await new Promise((r) => setTimeout(r, 20));
    k.state.alive = false; // the switch saved off
    await k.kept.queue({ endpoint: 'pv-g/chat' });
    const r = await p;
    assert.equal(r.answeredBy, LITE);
    assert.deepEqual(s.stored(), [], 'switched off: Google keeps nothing');
  } finally {
    await s.close();
  }
});

test('VERIFY D: a drain already running when a key changes never sends the old key\'s deletion with the new key', async () => {
  const { hostKit } = await import('./package-kit.js');
  const { createLlm } = await import('../../src/core/llm/service.js');
  const { createTrip } = await import('../../src/core/scopes.js');
  const { setKey, readConfig, saveRoles } = await import('../../src/core/llm/config.js');
  const s = await startServer({ replies: [() => ({ text: 'P' })] });
  const s2 = await startServer({ replies: [() => ({ text: 'Q' })], ids: 'v1_q-' });
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const fetching = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = String(url);
    if (u.startsWith(s.url) || u.startsWith(s2.url)) {
      if (init?.method === 'DELETE' && u.startsWith(s2.url)) await new Promise((r) => setTimeout(r, 600));
      return globalThis.fetch(url, init);
    }
    try { return new Response(await readFile(new URL(`.${new URL(u, 'http://annai.test').pathname}`, root))); } catch { return new Response('not found', { status: 404 }); }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: fetching });
  const P = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-old-key-P-0123456789', baseUrl: s.url, official: true });
  const Q = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-key-Q-0123456789', baseUrl: s2.url, official: true });
  const trip = await createTrip(k.ws, { title: 'Kyoto' });
  const cfg = await readConfig(k.ws);
  const mOf = (/** @type {string} */ pid) => /** @type {any} */ (Object.values(cfg.models).find((m) => m.provider === pid && m.ability === 'chat')).id;
  const ask = async (/** @type {string} */ pid, /** @type {string} */ q) => {
    await saveRoles(k.ws, { ...cfg.roles, main: { ...cfg.roles.main, models: [mOf(pid)] } });
    return llm.call({ role: 'main', scope: trip, request: { messages: [msg('user', text(q))] }, record: { keepParts: true } });
  };
  try {
    await ask(Q, 'on Q');
    await ask(P, 'on P');
    llm.forgetScope(trip); // both deletions queued; a drain starts, Q's slow one first
    await new Promise((r) => setTimeout(r, 50));
    await llm.reconnect(P, () => setKey(k.store, P, 'AIza-the-new-key-0123456789'));
    await llm.drainKept();
    const deletes = s.requests().filter((r) => r.method === 'DELETE').map((r) => r.headers['x-goog-api-key']);
    assert.ok(!deletes.includes('AIza-the-new-key-0123456789'), "P's turn never deleted with the new key");
    assert.deepEqual(deletes, ['AIza-old-key-P-0123456789'], 'deleted first, with its own key');
  } finally {
    await s.close();
    await s2.close();
  }
});

test('VERIFY E: a Save that fails changes no key, and lets go of nothing', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 1);
    c.net.online = false;
    await assert.rejects(c.llm.reconnect(c.id, async () => { throw new Error("Extra headers (JSON) isn't valid JSON."); }));
    const f = await c.keptFile();
    assert.equal(f.turns.length + f.forget.length, 1, 'still known, to be deleted');
    c.net.online = true;
    await c.llm.drainKept();
    assert.deepEqual(c.s.stored(), []);
  } finally {
    await c.s.close();
  }
});

test('a provider removal that fails leaves the provider as it was: its next turn is kept, not deleted at once (verification)', async () => {
  const c = await serviceKit();
  try {
    await c.talk(c.tripA, 1);
    const many = c.ws.writeMany.bind(c.ws);
    c.ws.writeMany = async (/** @type {any} */ scope, /** @type {any} */ files, /** @type {any} */ o) => { if (JSON.stringify(files).includes('/llm/providers/')) throw new Error('disk full'); return many(scope, files, o); };
    await assert.rejects(c.llm.removeProvider(c.id));
    c.ws.writeMany = many;
    const before = c.s.stored().length;
    await c.talk(c.tripA, 1);
    assert.equal(c.s.stored().length, before + 1, 'the new turn is kept at Google');
    const f = await c.keptFile();
    assert.ok(f.turns.length >= 1, 'and annai tracks it');
  } finally {
    await c.s.close();
  }
});

// The verification's tests (2026-10-21): through the real service and config, so a check removed from alive() or the drain fails one.
async function realKit(/** @type {{ slowModel?: string, deleteDelay?: number }} */ o = {}) {
  const { hostKit } = await import('./package-kit.js');
  const { createLlm } = await import('../../src/core/llm/service.js');
  const { createTrip } = await import('../../src/core/scopes.js');
  const s = await startServer({ replies: [(/** @type {any} */ b) => (b.model === o.slowModel ? { error: { status: 401, body: { error: { message: 'API key not valid.', code: 'unauthenticated' } } } } : { text: 'OK', delayMs: 300 })] });
  const s2 = await startServer({ replies: [() => ({ text: 'Q' })], ids: 'v1_q-' });
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const fetching = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = String(url);
    if (u.startsWith(s.url) || u.startsWith(s2.url)) {
      if (init?.method === 'POST' && o.slowModel && String(init.body ?? '').includes(`"model":"${o.slowModel}"`)) await new Promise((r) => setTimeout(r, 200));
      if (init?.method === 'DELETE' && u.startsWith(s2.url) && o.deleteDelay) await new Promise((r) => setTimeout(r, o.deleteDelay));
      return globalThis.fetch(url, init);
    }
    try { return new Response(await readFile(new URL(`.${new URL(u, 'http://annai.test').pathname}`, root))); } catch { return new Response('not found', { status: 404 }); }
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: fetching });
  const P = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-old-key-P-0123456789', baseUrl: s.url, official: true });
  const trip = await createTrip(k.ws, { title: 'Kyoto' });
  return { s, s2, k, llm, P, trip };
}

test('through the service: a role\'s second model, on the config read before the switch went off, keeps nothing', async () => {
  const { readConfig, saveRoles, saveProvider, modelOf } = await import('../../src/core/llm/config.js');
  const probe = await realKit();
  const cfg0 = await readConfig(probe.k.ws);
  const chat = Object.values(cfg0.models).filter((m) => m.provider === probe.P && m.ability === 'chat');
  await probe.s.close(); await probe.s2.close();
  const slow = modelOf(chat[0]).providerId.replace(/^models\//, '');
  const { s, s2, k, llm, P, trip } = await realKit({ slowModel: slow });
  try {
    const cfg = await readConfig(k.ws);
    const all = Object.values(cfg.models).filter((m) => m.provider === P && m.ability === 'chat');
    const ms = [all.find((m) => modelOf(m).providerId.replace(/^models\//, '') === slow), all.find((m) => modelOf(m).providerId.replace(/^models\//, '') !== slow)].map((m) => /** @type {any} */ (m).id);
    await saveRoles(k.ws, { ...cfg.roles, main: { ...cfg.roles.main, models: ms.slice(0, 2) } });
    const p = llm.call({ role: 'main', scope: trip, request: { messages: [msg('user', text('q'))] }, record: { keepParts: true } });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const rec = (await readConfig(k.ws)).providers[P];
    await saveProvider(k.ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user.abilities, chat: { ...rec.user.abilities?.chat, tunables: { keep: false } } } } });
    await llm.forgetEndpoint(`${P}/chat`);
    const r = await p;
    assert.deepEqual(s.stored(), [], 'switched off, yet Google keeps it');
  } finally { await s.close(); await s2.close(); }
});

test('through the service: a new key saved while a turn is answered: that turn is deleted with the key that made it', async () => {
  const { setKey } = await import('../../src/core/llm/config.js');
  const { s, s2, llm, P, trip, k } = await realKit();
  try {
    const p = llm.call({ role: 'main', scope: trip, request: { messages: [msg('user', text('q'))] }, record: { keepParts: true } });
    for (let i = 0; i < 100 && !s.bodies().length; i++) await new Promise((r) => setTimeout(r, 5));
    await llm.reconnect(P, () => setKey(k.store, P, 'AIza-the-new-key-0123456789'));
    await p;
    await llm.drainKept();
    const f = (await k.ws.readJSON(SYS_DEVICE, '/llm/kept.json').catch(() => null)) ?? { turns: [], forget: [], pending: [] };
    assert.deepEqual(s.stored(), [], 'kept at Google, never to be deleted');
  } finally { await s.close(); await s2.close(); }
});

test('through the service: a drain already running across the whole key change sends nothing with the new key (its slow DELETE outlasts the 10 s)', async () => {
  const { setKey, readConfig, saveRoles } = await import('../../src/core/llm/config.js');
  const { s, s2, k, llm, P, trip } = await realKit({ deleteDelay: 11_500 });
  const Q = await llm.addProvider('provider-gemini', { roles: 'recommended', key: 'AIza-key-Q-0123456789', baseUrl: s2.url, official: true });
  const cfg = await readConfig(k.ws);
  const mOf = (/** @type {string} */ pid) => /** @type {any} */ (Object.values(cfg.models).find((m) => m.provider === pid && m.ability === 'chat')).id;
  const ask = async (/** @type {string} */ pid, /** @type {string} */ q) => {
    await saveRoles(k.ws, { ...cfg.roles, main: { ...cfg.roles.main, models: [mOf(pid)] } });
    return llm.call({ role: 'main', scope: trip, request: { messages: [msg('user', text(q))] }, record: { keepParts: true } });
  };
  try {
    await ask(Q, 'on Q');
    await ask(P, 'on P');
    llm.forgetScope(trip);
    await new Promise((r) => setTimeout(r, 50));
    await llm.reconnect(P, () => setKey(k.store, P, 'AIza-the-new-key-0123456789'));
    await new Promise((r) => setTimeout(r, 2500));
    const deletes = s.requests().filter((r) => r.method === 'DELETE').map((r) => r.headers['x-goog-api-key']);
    assert.ok(!deletes.includes('AIza-the-new-key-0123456789'));
  } finally { await s.close(); await s2.close(); }
});
