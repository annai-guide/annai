// The Koe role: one ordered list, taking chat and realtime models (the Koe and Kokoro design, "The halves and their
// models"; the user, 2026-10-19: one Koe model, like Main).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';
import { readConfig, saveRoles, modelOf, KOE_ROLE, CHAT_ROLES } from '../../src/core/llm/config.js';
import { candidates } from '../../src/core/llm/fallback.js';
import { ROLE_KINDS, checkProviderDesc } from '../../src/core/llm/provider-desc.js';
import { nearestLevel } from '../../src/core/llm/reasoning.js';
import { addProvider, useSuggestion } from '../../src/core/llm/providers.js';
import { splitOn, koePath, chatCandidates } from '../../src/core/llm/fallback.js';
import { ROUTER_SRC } from './provider-kit.js';

/** @param {Record<string, string[]>} lists @returns {any} */
const cfgOf = (lists) => ({ providers: {}, models: {}, roles: Object.fromEntries(Object.entries(lists).map(([r, models]) => [r, { models, level: 'off' }])) });

test('Koe is one list, never Main; empty: no split', () => {
  assert.equal(KOE_ROLE, 'koe');
  const one = cfgOf({ main: ['m1'], koe: ['k1', 'k2'] });
  assert.deepEqual(candidates(one, 'koe'), ['k1', 'k2']);
  assert.equal(splitOn(one), true);
  const none = cfgOf({ main: ['m1'], koe: [] });
  assert.deepEqual(candidates(none, 'koe'), [], 'no Koe model means no Koe, never Main');
  assert.equal(splitOn(none), false);
  assert.equal(splitOn(cfgOf({ main: ['m1'] })), false, 'a roles file from before the Koe role');
  // The chat roles still fall back to Main, as before.
  assert.deepEqual(candidates(none, 'utility'), ['m1']);
  assert.ok(!CHAT_ROLES.includes(KOE_ROLE), "Koe's list isn't a chat role that falls back to Main");
});

test('roles.json has the one Koe list; a saved file without it reads it as empty, and it takes chat and realtime models', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { main: { models: [], level: 'medium' } }, { author: 'user' });
  let { roles } = await readConfig(ws);
  assert.deepEqual(roles.koe, { models: [], level: 'low' }, "Koe thinks at low unless set (the user, 2026-10-19: low over off)");
  // A model whose map lacks low uses the nearest it has, the cheaper on a tie.
  assert.deepEqual([nearestLevel({ off: {}, medium: {} }, roles.koe.level), nearestLevel({ medium: {}, high: {} }, roles.koe.level)], ['off', 'medium']);
  assert.ok(!('koe-talk' in roles) && !('koe-type' in roles));
  await saveRoles(ws, { ...roles, koe: { models: [], level: 'medium', firstOutputSeconds: 8 } });
  ({ roles } = await readConfig(ws));
  assert.deepEqual(roles.koe, { models: [], level: 'medium', firstOutputSeconds: 8 });
  assert.deepEqual(ROLE_KINDS.koe, ['chat', 'realtime']);
  assert.ok(!('koe-talk' in ROLE_KINDS) && !('koe-type' in ROLE_KINDS));
});

test("a stored config with Koe's two old lists reads as one: the talking list's models, then the typing list's, without repeats; the old keys are gone", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  await addProvider({ ws, store }, structuredClone(ROUTER_SRC), { key: 'sk-r', roles: null });
  const cfg = await readConfig(ws);
  const idOf = (/** @type {string} */ name) => /** @type {string} */ (Object.values(cfg.models).find((m) => modelOf(m).name === name)?.id);
  const [big, small] = [idOf('Big'), idOf('Small (free)')];
  await ws.write(SYS_SETTINGS, '/llm/roles.json', {
    main: { models: [big], level: 'medium' },
    'koe-talk': { models: [small, big], level: 'off' }, 'koe-type': { models: [big, 'gone', small], level: 'off' },
  }, { author: 'user' });
  const { roles } = await readConfig(ws);
  assert.deepEqual(roles.koe.models, [small, big]);
  assert.ok(!('koe-talk' in roles) && !('koe-type' in roles));
  // Saved again, the file holds the one list.
  await saveRoles(ws, roles);
  const file = await ws.readJSON(SYS_SETTINGS, '/llm/roles.json');
  assert.deepEqual([file.koe.models, 'koe-talk' in file, 'koe-type' in file], [[small, big], false, false]);
});

test('adding a provider whose description recommends a Koe model fills Main but not Koe; "Use the recommended models" fills it; the two old names are ignored', async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const src = structuredClone(ROUTER_SRC);
  src.provider.roles = { recommended: { main: ['big'], koe: ['small:free'], 'koe-talk': ['big'], 'koe-type': ['big'] } };
  assert.deepEqual(checkProviderDesc(src.provider), [], 'a description may suggest Koe models, and an older one under the two old names still checks');
  assert.deepEqual(checkProviderDesc({ ...src.provider, roles: { recommended: { koe2: ['big'] } } }), ['$.roles.recommended.koe2: there is no such role']);
  const id = await addProvider({ ws, store }, src, { key: 'sk-r' });
  let cfg = await readConfig(ws);
  const name = (/** @type {string} */ role) => cfg.roles[role].models.map((m) => modelOf(cfg.models[m]).name);
  assert.deepEqual(name('main'), ['Big']);
  assert.deepEqual(name('koe'), [], 'the split is opt-in: adding a provider never turns it on');
  await useSuggestion({ ws }, id, src, 'recommended');
  cfg = await readConfig(ws);
  assert.deepEqual(name('koe'), ['Small (free)']);
  assert.ok(!('koe-talk' in cfg.roles) && !('koe-type' in cfg.roles));
});

test("Koe's wait for the first words is 8 seconds unless the user set one (Koe answers at once)", async () => {
  const { callRole, Bench } = await import('../../src/core/llm/fallback.js');
  /** @type {number[]} */
  const waits = [];
  /** @param {number} [firstOutputSeconds] */
  const config = (firstOutputSeconds) => /** @type {any} */ ({
    providers: { p: { id: 'p', plugin: 'x', template: null, user: { name: 'P', baseUrl: 'https://p.test', abilities: { chat: { kind: 'chat', type: 't' } } }, created: 0 } },
    models: { k: { id: 'k', provider: 'p', ability: 'chat', template: null, user: { providerId: 'fast' }, created: 0 } },
    roles: { koe: { models: ['k'], level: 'off', ...(firstOutputSeconds ? { firstOutputSeconds } : {}) } },
  });
  const type = { type: 't', name: 'T', pluginId: 'x', async* run() { yield { type: 'text', text: 'hi' }; } };
  const types = new Map([['t', /** @type {any} */ (type)]]);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = /** @type {any} */ ((/** @type {any} */ fn, /** @type {number} */ ms) => { waits.push(ms); return realSetTimeout(fn, 2 ** 30).unref(); });
  try {
    await callRole({ role: 'koe', request: { messages: [] }, config: config(), types, keyFor: async () => null, bench: new Bench() });
    await callRole({ role: 'koe', request: { messages: [] }, config: config(3), types, keyFor: async () => null, bench: new Bench() });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(waits[0], 8000);
  assert.ok(waits.includes(3000), 'its own setting');
});

test("Koe's pathway, voice on: the first model in its list that can answer; a realtime one runs a live session, a chat one the loop", () => {
  /** @type {any} */
  const cfg = {
    providers: { pv: { id: 'pv', plugin: 'provider-gemini', template: null, created: 0, user: { name: 'Gemini', abilities: { live: { kind: 'realtime', type: 'gemini-live' }, chat: { kind: 'chat', type: 'chat-completions' } } } } },
    models: {
      live: { id: 'live', provider: 'pv', ability: 'live', template: null, created: 0, user: { providerId: 'gemini-3.8-live' } },
      fast: { id: 'fast', provider: 'pv', ability: 'chat', template: null, created: 0, user: { providerId: 'gemini-3.5-flash-lite' } },
    },
    roles: { main: { models: [], level: 'off' }, koe: { models: ['live', 'fast'], level: 'off' } },
  };
  const types = new Map([['gemini-live', { realtime: true }], ['chat-completions', {}]]);
  const on = { voiceOn: true, types, until: () => 0, now: 1000 };
  assert.deepEqual(koePath(cfg, on), { kind: 'live', modelId: 'live' });
  // A live model that can't go on (resting after a drop or a limit, off, or its protocol not running): the next model down.
  assert.deepEqual(koePath(cfg, { ...on, until: (/** @type {string} */ id) => (id === 'live' ? 5000 : 0) }), { kind: 'text' }, 'resting: the text model after it');
  assert.deepEqual(koePath(cfg, { ...on, types: new Map([['chat-completions', {}]]) }), { kind: 'text' }, 'its protocol not running');
  const off = structuredClone(cfg);
  off.providers.pv.user.abilities.live.on = false;
  assert.deepEqual(koePath(off, on), { kind: 'text' }, 'Live voice switched off');
  // A chat model first: the loop, though a realtime model follows it.
  const chatFirst = { ...cfg, roles: { ...cfg.roles, koe: { models: ['fast', 'live'], level: 'off' } } };
  assert.deepEqual(koePath(chatFirst, on), { kind: 'text' });
  assert.deepEqual(koePath(chatFirst, { ...on, until: (/** @type {string} */ id) => (id === 'fast' ? 5000 : 0) }), { kind: 'live', modelId: 'live' }, 'the chat model resting: the live one after it');
  // The realtime model alone: live; resting, with nothing after it, Koe is down.
  const liveOnly = { ...cfg, roles: { ...cfg.roles, koe: { models: ['live'], level: 'off' } } };
  assert.equal(splitOn(liveOnly), true);
  assert.deepEqual(koePath(liveOnly, on), { kind: 'live', modelId: 'live' });
  assert.equal(koePath(liveOnly, { ...on, until: () => 5000 }), null, 'resting, and nothing after it: Koe is down');
  // A text Koe calls the same list; its realtime models are passed over by callRole as not-chat, and by chatCandidates,
  // which says which model is a text Koe's first (to hear, to upload to), with those of an ability switched off.
  assert.deepEqual(candidates(cfg, 'koe'), ['live', 'fast']);
  assert.deepEqual(chatCandidates(cfg, 'koe'), ['fast']);
  const chatOff = structuredClone(cfg);
  chatOff.providers.pv.user.abilities.chat.on = false;
  assert.deepEqual(chatCandidates(chatOff, 'koe'), []);
});

test("Koe's pathway, voice off: a chat model that can answer comes before a realtime one ahead of it in the list (a live session's reply is sound nobody hears); with none, the realtime one runs muted", () => {
  /** @type {any} */
  const cfg = {
    providers: { pv: { id: 'pv', plugin: 'provider-gemini', template: null, created: 0, user: { name: 'Gemini', abilities: { live: { kind: 'realtime', type: 'gemini-live' }, chat: { kind: 'chat', type: 'chat-completions' } } } } },
    models: {
      live: { id: 'live', provider: 'pv', ability: 'live', template: null, created: 0, user: { providerId: 'gemini-3.8-live' } },
      fast: { id: 'fast', provider: 'pv', ability: 'chat', template: null, created: 0, user: { providerId: 'gemini-3.5-flash-lite' } },
    },
    roles: { main: { models: [], level: 'off' }, koe: { models: ['live', 'fast'], level: 'off' } },
  };
  const off = { voiceOn: false, types: new Map([['gemini-live', { realtime: true }], ['chat-completions', {}]]), until: () => 0, now: 1000 };
  assert.deepEqual(koePath(cfg, off), { kind: 'text' }, 'Gemini Live first, flash-lite after it: flash-lite, in the loop');
  assert.deepEqual(koePath(cfg, { ...off, voiceOn: true }), { kind: 'live', modelId: 'live' }, 'voice on: Gemini Live');
  assert.deepEqual(koePath(cfg, { ...off, until: (/** @type {string} */ id) => (id === 'fast' ? 5000 : 0) }), { kind: 'live', modelId: 'live' }, 'the chat model resting: the live one, muted');
  const liveOnly = { ...cfg, roles: { ...cfg.roles, koe: { models: ['live'], level: 'off' } } };
  assert.deepEqual(koePath(liveOnly, off), { kind: 'live', modelId: 'live' }, 'no chat model: the live one, muted');
  assert.equal(koePath(liveOnly, { ...off, until: () => 5000 }), null);
  const chatFirst = { ...cfg, roles: { ...cfg.roles, koe: { models: ['fast', 'live'], level: 'off' } } };
  assert.deepEqual(koePath(chatFirst, off), { kind: 'text' });
  // A chat model that can't be called (its ability off, or its protocol not running) can't answer, as callRole has it:
  // the live model runs muted; with nothing else, Koe is down.
  const chatOff = structuredClone(cfg);
  chatOff.providers.pv.user.abilities.chat.on = false;
  assert.deepEqual(koePath(chatOff, off), { kind: 'live', modelId: 'live' }, 'its chat ability off');
  assert.deepEqual(koePath(cfg, { ...off, types: new Map([['gemini-live', { realtime: true }]]) }), { kind: 'live', modelId: 'live' }, 'its protocol not running');
  assert.equal(koePath(chatOff, { ...off, until: (/** @type {string} */ id) => (id === 'live' ? 5000 : 0) }), null, 'the live one resting too: none can');
  assert.equal(koePath({ ...chatOff, roles: { ...cfg.roles, koe: { models: ['fast'], level: 'off' } } }, { ...off, voiceOn: true }), null, 'voice on, the chat model alone and off');
});
