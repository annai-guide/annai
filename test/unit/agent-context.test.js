import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { CORE } from '../../src/core/agent/instructions.js';
import { takeSnapshot, nextSnapshot, systemText, nowBlock, nextPlanItems, buildRequest, prefixFingerprint } from '../../src/core/agent/context.js';
import { Warmth, ttlFor } from '../../src/core/agent/warmth.js';
import { activate as anthropic } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur', start: '2026-11-25', end: '2026-11-29' });
  await ws.write(ME, '/personalities/shiori.md', '# Shiori\nWarm and brief.\n', { author: 'user' });
  await ws.write(ME, '/memory.md', '# Memory\n- Vegetarian\n', { author: 'user' });
  const registry = new Registry();
  registry.add('drive', 'skill', { name: 'driving', description: 'How to guide while the user drives.', text: '…' });
  return { store, ws, trip, registry };
}

test('the request is in cache order: core, personality, snapshot; tools; transcript; the now block last (spec §6.3)', async () => {
  const { ws, trip, registry } = await setup();
  const snap = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const system = systemText(snap);
  assert.ok(system.startsWith(CORE));
  const order = ['Warm and brief.', '- Vegetarian', 'driving: How to guide while the user drives.', '"title": "Big Sur"', '# Trip memory'].map((s) => system.indexOf(s));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`);
  const t = new Transcript();
  t.messages.push({ role: 'user', parts: [{ type: 'text', text: 'Hi' }] });
  const tools = [{ name: 'sleep', description: 'End the turn.', input: { type: 'object' } }];
  const req = buildRequest({ snapshot: snap, tools, transcript: t, tail: '<now>x</now>', cacheTtl: '5m' });
  assert.equal(req.system, system);
  assert.deepEqual(req.tools, tools);
  assert.deepEqual(req.messages, t.messages);
  assert.equal(req.tail, '<now>x</now>');
  assert.equal(req.cacheTtl, '5m');
});

test("what's cached of one request is a prefix of the next: the now block comes after the marker", async () => {
  /** @type {any} */
  let type;
  anthropic({ providers: { register: (/** @type {any} */ x) => { type = x; return () => {}; } }, helpers: { sse, ProviderError, errorFromResponse } });
  const { ws, trip, registry } = await setup();
  const snap = await takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const t = new Transcript();
  t.messages.push({ role: 'user', parts: [{ type: 'text', text: 'Hi' }] });
  const spec = (/** @type {any} */ request) => ({ endpoint: { baseUrl: 'https://api.anthropic.com', headers: {} }, model: { providerId: 'claude-haiku-5-5' }, key: 'k', tunables: { ...type.tunables }, request });
  const first = type.build(spec(buildRequest({ snapshot: snap, tools: [], transcript: t, tail: '<now>16:12</now>', cacheTtl: '5m' }))).body;
  t.messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'sleep', input: {} }] });
  t.messages.push({ role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'asleep' }, { type: 'text', text: 'And dinner?' }] });
  const second = type.build(spec(buildRequest({ snapshot: snap, tools: [], transcript: t, tail: '<now>16:20</now>', cacheTtl: '5m' }))).body;
  // The first request's cached part: everything up to and including its marked block.
  const cachedFirst = first.messages[0].content.findIndex((/** @type {any} */ b) => b.cache_control);
  const strip = (/** @type {any} */ b) => { const { cache_control: _c, ...rest } = b; return rest; };
  assert.deepEqual(first.messages[0].content.slice(0, cachedFirst + 1).map(strip), second.messages[0].content.slice(0, cachedFirst + 1).map(strip));
  assert.deepEqual(first.messages[0].content.at(-1), { type: 'text', text: '<now>16:12</now>' });
  assert.equal(JSON.stringify(second).includes('16:12'), false);
});

test('the snapshot: memory waits for a cold cache, a personality change comes at the next wake, a new trip is a new snapshot', async () => {
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const first = await take();
  await ws.write(ME, '/memory.md', '# Memory\n- Vegetarian\n- Loves tide pools\n', { author: 'shiori' });
  await ws.write(ME, '/personalities/shiori.md', '# Shiori\nWarm, brief, and quiet while driving.\n', { author: 'shiori' });
  const warm = nextSnapshot(first, await take(), { cold: false });
  assert.doesNotMatch(warm.memory, /tide pools/);
  assert.match(warm.personality, /quiet while driving/);
  assert.match(nextSnapshot(first, await take(), { cold: true }).memory, /tide pools/);
  const other = await createTrip(ws, { title: 'Kyoto' });
  assert.equal(nextSnapshot(first, await takeSnapshot({ ws, registry, trip: other, personalityName: 'shiori' }), { cold: false }).trip, other);
});

test('the now block: local time and zone, voice, connection, why she woke, and the next plan items as TSV', async () => {
  const { ws, trip } = await setup();
  const item = (/** @type {string} */ id, /** @type {string} */ at, /** @type {boolean} */ fixed) => ({ id, title: id, fixed, start: { at, tz: 'America/Los_Angeles' }, place: { name: `${id} place` } });
  await ws.write(trip, '/plan/past.json', item('past', '2026-11-26T10:00:00-08:00', false), { author: 'user' });
  await ws.write(trip, '/plan/dinner.json', item('dinner', '2026-11-26T18:30:00-08:00', true), { author: 'user' });
  await ws.write(trip, '/plan/sunset.json', item('sunset', '2026-11-26T16:53:00-08:00', false), { author: 'user' });
  const now = Date.parse('2026-11-26T16:12:00-08:00');
  const plan = await nextPlanItems(ws, trip, now);
  assert.deepEqual(plan.map((r) => r[1]), ['sunset', 'dinner']);
  const block = nowBlock({ now, timeZone: 'America/Los_Angeles', voice: 'off', online: true, reasons: ['the user wrote'], plan });
  assert.match(block, /^<now>\ntime: Thursday 2026-11-26 16:12, America\/Los_Angeles \(GMT-8\)\n/);
  assert.match(block, /\nvoice: off \(speak shows a bubble; wait waits for typing\)\n/);
  assert.match(block, /\nconnection: online\n/);
  assert.match(block, /\nwoke for: the user wrote\n/);
  assert.match(block, /\nnext in the plan:\nstart\ttitle\tfixed\tplace\n2026-11-26T16:53:00-08:00\tsunset\tno\tsunset place\n2026-11-26T18:30:00-08:00\tdinner\tyes\tdinner place\n<\/now>$/);
});

test('warmth: warm within the lifetime of the same prefix; cold after it, or for another prefix', async () => {
  const w = new Warmth();
  w.note('m-1', 'fp-a', 300_000, 1000);
  assert.deepEqual(w.state('m-1', 'fp-a', 200_000), { warm: true, expiresAt: 301_000 });
  assert.equal(w.state('m-1', 'fp-a', 302_000).warm, false);
  assert.equal(w.state('m-1', 'fp-b', 200_000).warm, false);
  assert.equal(w.state('m-2', 'fp-a', 200_000).warm, false);
  assert.equal(w.last?.modelId, 'm-1');
  assert.equal(ttlFor(/** @type {any} */ ({ cacheTtls: ['5m', '1h'] }), '1h'), '1h');
  assert.equal(ttlFor(/** @type {any} */ ({ cacheTtls: [] }), '1h'), '5m');
  const fp = await prefixFingerprint({ system: 'S', tools: [], messages: [] }, 7);
  assert.equal(fp, await prefixFingerprint({ system: 'S', tools: [], messages: [{ role: 'user', parts: [] }] }, 7));
  assert.notEqual(fp, await prefixFingerprint({ system: 'S2', tools: [], messages: [] }, 7));
  assert.notEqual(fp, await prefixFingerprint({ system: 'S', tools: [], messages: [] }, 8));
});

test('a skill installed or removed shows at her next wake, warm cache or not; each name once (choice 10)', async () => {
  const { ws, trip, registry } = await setup();
  const take = () => takeSnapshot({ ws, registry, trip, personalityName: 'shiori' });
  const first = await take();
  const off = registry.add('kit', 'skill', { name: 'tide-pools', description: 'Tide pools.', text: '' });
  registry.add('other', 'skill', { name: 'tide-pools', description: 'A second one.', text: '' });
  const warm = nextSnapshot(first, await take(), { cold: false });
  assert.deepEqual(warm.skills.map((s) => [s.name, s.description]), [['driving', 'How to guide while the user drives.'], ['tide-pools', 'Tide pools.']]);
  assert.equal(warm.memory, first.memory);
  off();
  assert.deepEqual(nextSnapshot(warm, await take(), { cold: false }).skills.map((s) => s.description), ['How to guide while the user drives.', 'A second one.']);
  const same = await take();
  assert.equal(nextSnapshot(same, await take(), { cold: false }), same); // nothing changed: the snapshot it had
});
