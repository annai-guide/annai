// K1 Task 2: the Koe role, with a list for talking and one for typing (Koe and Kokoro design, "The halves and their models").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';
import { readConfig, saveRoles, modelOf, KOE_ROLES, CHAT_ROLES } from '../../src/core/llm/config.js';
import { candidates } from '../../src/core/llm/fallback.js';
import { ROLE_LEVELS } from '../../src/core/llm/reasoning.js';
import { ROLE_KINDS, checkProviderDesc } from '../../src/core/llm/provider-desc.js';
import { addProvider, useSuggestion } from '../../src/core/llm/providers.js';
import { koeList, splitOn } from '../../src/core/llm/fallback.js';
import { ROUTER_SRC } from './provider-kit.js';

/** @param {Record<string, string[]>} lists @returns {any} */
const cfgOf = (lists) => ({ providers: {}, models: {}, roles: Object.fromEntries(Object.entries(lists).map(([r, models]) => [r, { models, level: 'off' }])) });

test('an empty Koe list uses the other Koe list, never Main; both empty: no split', () => {
  const one = cfgOf({ main: ['m1'], 'koe-talk': [], 'koe-type': ['k1'] });
  assert.deepEqual(candidates(one, 'koe-talk'), ['k1']);
  assert.deepEqual(candidates(one, 'koe-type'), ['k1']);
  assert.equal(splitOn(one), true);
  const none = cfgOf({ main: ['m1'], 'koe-talk': [], 'koe-type': [] });
  assert.deepEqual(candidates(none, 'koe-talk'), []);
  assert.deepEqual(candidates(none, 'koe-type'), []);
  assert.equal(splitOn(none), false);
  assert.equal(splitOn(cfgOf({ main: ['m1'] })), false, 'a roles file from before the Koe role');
  // The chat roles still fall back to Main, as before.
  assert.deepEqual(candidates(none, 'utility'), ['m1']);
  assert.deepEqual(KOE_ROLES, ['koe-talk', 'koe-type']);
  assert.ok(!KOE_ROLES.some((r) => CHAT_ROLES.includes(r)), "Koe's lists aren't chat roles that fall back to Main");
});

test('koeList follows voice: on → koe-talk, off → koe-type, each falling back to the other', () => {
  const both = cfgOf({ 'koe-talk': ['live'], 'koe-type': ['fast'] });
  assert.deepEqual(koeList(both, true), { role: 'koe-talk', models: ['live'] });
  assert.deepEqual(koeList(both, false), { role: 'koe-type', models: ['fast'] });
  const talkOnly = cfgOf({ 'koe-talk': ['live'], 'koe-type': [] });
  assert.deepEqual(koeList(talkOnly, false), { role: 'koe-type', models: ['live'] }, 'voice off with only a talking model: that model, in text');
  const typeOnly = cfgOf({ 'koe-talk': [], 'koe-type': ['fast'] });
  assert.deepEqual(koeList(typeOnly, true), { role: 'koe-talk', models: ['fast'] }, 'voice on with only a typing model: that model, with the speech pipeline');
  assert.deepEqual(koeList(cfgOf({}), true), { role: 'koe-talk', models: [] });
});

test('roles.json keeps the Koe roles at level off; a saved file without them reads them as empty', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { main: { models: [], level: 'medium' } }, { author: 'user' });
  let { roles } = await readConfig(ws);
  assert.deepEqual(roles['koe-talk'], { models: [], level: 'off' });
  assert.deepEqual(roles['koe-type'], { models: [], level: 'off' });
  assert.equal(/** @type {any} */ (ROLE_LEVELS)['koe-talk'], 'off');
  assert.equal(/** @type {any} */ (ROLE_LEVELS)['koe-type'], 'off');
  await saveRoles(ws, { ...roles, 'koe-type': { models: [], level: 'low', firstOutputSeconds: 8 } });
  ({ roles } = await readConfig(ws));
  assert.deepEqual(roles['koe-type'], { models: [], level: 'low', firstOutputSeconds: 8 });
  // Koe's lists take chat models and realtime voice models (K4).
  assert.deepEqual(ROLE_KINDS['koe-talk'], ['chat', 'realtime']);
  assert.deepEqual(ROLE_KINDS['koe-type'], ['chat', 'realtime']);
});

test('adding a provider whose description recommends Koe models fills Main but no Koe list; "Use the recommended models" fills them', async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const src = structuredClone(ROUTER_SRC);
  src.provider.roles = { recommended: { main: ['big'], 'koe-type': ['small:free'], 'koe-talk': ['small:free'] } };
  assert.deepEqual(checkProviderDesc(src.provider), [], 'a description may suggest Koe models');
  const id = await addProvider({ ws, store }, src, { key: 'sk-r' });
  let cfg = await readConfig(ws);
  const name = (/** @type {string} */ role) => cfg.roles[role].models.map((m) => modelOf(cfg.models[m]).name);
  assert.deepEqual(name('main'), ['Big']);
  assert.deepEqual(name('koe-type'), [], 'the split is opt-in: adding a provider never turns it on');
  assert.deepEqual(name('koe-talk'), []);
  await useSuggestion({ ws }, id, src, 'recommended');
  cfg = await readConfig(ws);
  assert.deepEqual(name('koe-type'), ['Small (free)']);
  assert.deepEqual(name('koe-talk'), ['Small (free)']);
});

test("Koe's wait for the first words is 8 seconds unless the user set one (Koe answers at once)", async () => {
  const { callRole, Bench } = await import('../../src/core/llm/fallback.js');
  /** @type {number[]} */
  const waits = [];
  const config = /** @type {any} */ ({
    providers: { p: { id: 'p', plugin: 'x', template: null, user: { name: 'P', baseUrl: 'https://p.test', abilities: { chat: { kind: 'chat', type: 't' } } }, created: 0 } },
    models: { k: { id: 'k', provider: 'p', ability: 'chat', template: null, user: { providerId: 'fast' }, created: 0 } },
    roles: { 'koe-type': { models: ['k'], level: 'off' }, 'koe-talk': { models: [], level: 'off', firstOutputSeconds: 3 } },
  });
  const type = { type: 't', name: 'T', pluginId: 'x', async* run() { yield { type: 'text', text: 'hi' }; } };
  const types = new Map([['t', /** @type {any} */ (type)]]);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = /** @type {any} */ ((/** @type {any} */ fn, /** @type {number} */ ms) => { waits.push(ms); return realSetTimeout(fn, 2 ** 30).unref(); });
  try {
    await callRole({ role: 'koe-type', request: { messages: [] }, config, types, keyFor: async () => null, bench: new Bench() });
    await callRole({ role: 'koe-talk', request: { messages: [] }, config, types, keyFor: async () => null, bench: new Bench() });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(waits[0], 8000);
  assert.ok(waits.includes(3000), 'koe-talk uses its own setting, with koe-type\'s models');
});
