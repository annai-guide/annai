// Koe's two lists, Realtime and Classic, and the switch between them (the user, 2026-10-22: "Two lists + a switch",
// named "Realtime / Classic"; before, one list from 2026-10-19, and two lists for talking and typing before that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';
import { readConfig, saveRoles, saveKoeMode, removeModel, removeProviderRecords, splitOldKoe, modelOf, KOE_REALTIME, KOE_CLASSIC, KOE_ROLES, CHAT_ROLES } from '../../src/core/llm/config.js';
import { koeWords } from '../../src/core/voice/mode.js';
import { candidates, chatCandidates, koeWay } from '../../src/core/llm/fallback.js';
import { ROLE_KINDS, checkProviderDesc } from '../../src/core/llm/provider-desc.js';
import { ROLE_LEVELS } from '../../src/core/llm/reasoning.js';
import { addProvider, useSuggestion } from '../../src/core/llm/providers.js';
import { ROUTER_SRC } from './provider-kit.js';

/** The router's description with a realtime ability (Live voice, on). @returns {any} */
const withLive = () => {
  const src = structuredClone(ROUTER_SRC);
  /** @type {any} */ (src.provider.abilities).live = { kind: 'realtime', type: 'gemini-live', name: 'Live voice', models: [{ providerId: 'live-1', name: 'Live One' }] };
  return src;
};

/** A workspace with the router (Big, Small (free), Live One), and its models' ids by name. */
async function setup(src = withLive()) {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const pid = await addProvider({ ws, store }, src, { key: 'sk-r', roles: null });
  const cfg = await readConfig(ws);
  const id = (/** @type {string} */ name) => /** @type {string} */ (Object.values(cfg.models).find((m) => modelOf(m).name === name)?.id);
  return { ws, store, pid, src, big: id('Big'), small: id('Small (free)'), live: id('Live One') };
}

test("Koe's two lists: Realtime takes realtime models, Classic chat models; neither falls back to Main; Classic thinks at low, Realtime has no level to use", async () => {
  assert.deepEqual([KOE_REALTIME, KOE_CLASSIC], ['koe-realtime', 'koe-classic']);
  assert.deepEqual(KOE_ROLES, [KOE_REALTIME, KOE_CLASSIC]);
  assert.deepEqual([ROLE_KINDS[KOE_REALTIME], ROLE_KINDS[KOE_CLASSIC]], [['realtime'], ['chat']]);
  assert.ok(!('koe' in ROLE_KINDS), 'the one list is gone');
  assert.deepEqual([/** @type {any} */ (ROLE_LEVELS)[KOE_CLASSIC], /** @type {any} */ (ROLE_LEVELS)[KOE_REALTIME]], ['low', 'off']);
  for (const r of KOE_ROLES) assert.ok(!CHAT_ROLES.includes(r));
  const cfg = /** @type {any} */ ({ providers: {}, models: {}, roles: { main: { models: ['m1'], level: 'off' }, [KOE_CLASSIC]: { models: [], level: 'low' } } });
  assert.deepEqual(candidates(cfg, KOE_CLASSIC), [], 'no Koe model means no Koe, never Main');
  assert.deepEqual(candidates(cfg, KOE_REALTIME), []);
  assert.deepEqual(candidates(cfg, 'utility'), ['m1'], 'the chat roles still fall back to Main');
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { main: { models: [], level: 'medium' } }, { author: 'user' });
  const read = await readConfig(ws);
  assert.deepEqual([read.roles[KOE_REALTIME], read.roles[KOE_CLASSIC]], [{ models: [], level: 'off' }, { models: [], level: 'low' }]);
  assert.ok(!('koe' in read.roles) && !('koe-talk' in read.roles) && !('koe-type' in read.roles));
  assert.deepEqual([read.koeMode, read.koeChosen], ['classic', null], 'nothing chosen and nothing in Realtime: Classic');
});

test("the one Koe list of a stored config splits: its realtime models into Realtime, the rest into Classic, in order; Classic keeps its level and wait; the mode is the first usable model's", async () => {
  const { ws, big, small, live } = await setup();
  const old = { main: { models: [big], level: 'medium' }, koe: { models: [live, small, 'gone', big], level: 'medium', firstOutputSeconds: 5 } };
  await ws.write(SYS_SETTINGS, '/llm/roles.json', old, { author: 'user' });
  const cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles[KOE_REALTIME], { models: [live], level: 'off' });
  assert.deepEqual(cfg.roles[KOE_CLASSIC], { models: [small, big], level: 'medium', firstOutputSeconds: 5 });
  assert.ok(!('koe' in cfg.roles));
  assert.deepEqual([cfg.koeMode, cfg.koeChosen], ['realtime', 'realtime'], 'Gemini Live first: Realtime');
  // Saved again: the file holds the two lists and the mode, never the old list; reading and saving again changes nothing.
  await saveRoles(ws, cfg.roles);
  const file = await ws.readJSON(SYS_SETTINGS, '/llm/roles.json');
  assert.deepEqual([file[KOE_REALTIME].models, file[KOE_CLASSIC].models, file['koe-mode'], 'koe' in file], [[live], [small, big], 'realtime', false]);
  const again = await readConfig(ws);
  assert.deepEqual([again.roles, again.koeMode, again.koeChosen], [cfg.roles, 'realtime', 'realtime']);
  await saveRoles(ws, again.roles);
  assert.deepEqual(await ws.readJSON(SYS_SETTINGS, '/llm/roles.json'), file, 'idempotent');
  // An old backup restored brings the old file back: it reads the same way again.
  await ws.write(SYS_SETTINGS, '/llm/roles.json', old, { author: 'user' });
  const restored = await readConfig(ws);
  assert.deepEqual([restored.roles, restored.koeMode], [cfg.roles, 'realtime']);
});

test("the mode from the old list: a chat model first is Classic; a model whose ability is off isn't usable, the next one decides; an empty list chooses nothing", async () => {
  const { ws, pid, big, small, live } = await setup();
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { koe: { models: [small, live], level: 'low' } }, { author: 'user' });
  let cfg = await readConfig(ws);
  assert.deepEqual([cfg.roles[KOE_REALTIME].models, cfg.roles[KOE_CLASSIC].models, cfg.koeMode], [[live], [small], 'classic'], 'the order across the lists is gone, so the mode keeps it');
  // Live voice switched off: the chat model after it was the first that could answer.
  const rec = cfg.providers[pid];
  await ws.write(SYS_SETTINGS, `/llm/providers/${pid}.json`, { ...rec, user: { ...rec.user, abilities: { live: { on: false } } } }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { koe: { models: [live, big] } }, { author: 'user' });
  cfg = await readConfig(ws);
  assert.deepEqual([cfg.roles[KOE_REALTIME].models, cfg.roles[KOE_CLASSIC].models, cfg.koeMode], [[live], [big], 'classic']);
  assert.equal(cfg.roles[KOE_CLASSIC].level, 'low', 'a list with no level saved gets the default');
  // Only a model that is off: it still says which.
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { koe: { models: [live] } }, { author: 'user' });
  assert.equal((await readConfig(ws)).koeChosen, 'realtime');
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { koe: { models: [], level: 'low' } }, { author: 'user' });
  assert.equal((await readConfig(ws)).koeChosen, null);
});

test("Koe's two lists from before 2026-10-19 (for talking, for typing) still read: one list as before, then split; not their saved level", async () => {
  const { ws, big, small, live } = await setup();
  await ws.write(SYS_SETTINGS, '/llm/roles.json', {
    'koe-talk': { models: [live, small], level: 'off', firstOutputSeconds: 5 }, 'koe-type': { models: [big, small], level: 'off', firstOutputSeconds: 12 },
  }, { author: 'user' });
  const cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles[KOE_REALTIME], { models: [live], level: 'off' });
  assert.deepEqual(cfg.roles[KOE_CLASSIC], { models: [small, big], level: 'low', firstOutputSeconds: 5 });
  assert.equal(cfg.koeMode, 'realtime');
  assert.ok(!('koe-talk' in cfg.roles) && !('koe-type' in cfg.roles));
});

test("the mode: chosen, it is kept by every save of the roles (a model removed too); not chosen, it follows the lists: Realtime when its list holds a model", async () => {
  const { ws, big, small, live } = await setup();
  await saveRoles(ws, { ...(await readConfig(ws)).roles, [KOE_CLASSIC]: { models: [small], level: 'low' } });
  assert.deepEqual([(await readConfig(ws)).koeMode, (await readConfig(ws)).koeChosen], ['classic', null]);
  await saveRoles(ws, { ...(await readConfig(ws)).roles, [KOE_REALTIME]: { models: [live], level: 'off' } });
  assert.deepEqual([(await readConfig(ws)).koeMode, (await readConfig(ws)).koeChosen], ['realtime', null], 'a realtime model added: Realtime, until the user chooses');
  await saveKoeMode(ws, 'classic');
  let cfg = await readConfig(ws);
  assert.deepEqual([cfg.koeMode, cfg.koeChosen], ['classic', 'classic']);
  await saveRoles(ws, { ...cfg.roles, [KOE_CLASSIC]: { models: [small, big], level: 'low' } });
  await removeModel(ws, big);
  cfg = await readConfig(ws);
  assert.deepEqual([cfg.koeMode, cfg.roles[KOE_CLASSIC].models], ['classic', [small]]);
  await saveKoeMode(ws, 'realtime');
  assert.equal((await readConfig(ws)).koeMode, 'realtime');
  await assert.rejects(saveKoeMode(ws, /** @type {any} */ ('loud')));
});

/** Gemini's two abilities, Live (realtime) and chat, with a live model and a chat one. @returns {any} */
const geminiCfg = (/** @type {string[]} */ realtime, /** @type {string[]} */ classic, /** @type {'realtime' | 'classic'} */ mode) => ({
  providers: { pv: { id: 'pv', plugin: 'provider-gemini', template: null, created: 0, user: { name: 'Gemini', abilities: { live: { kind: 'realtime', type: 'gemini-live' }, chat: { kind: 'chat', type: 'chat-completions' } } } } },
  models: {
    live: { id: 'live', provider: 'pv', ability: 'live', template: null, created: 0, user: { providerId: 'gemini-3.8-live' } },
    fast: { id: 'fast', provider: 'pv', ability: 'chat', template: null, created: 0, user: { providerId: 'gemini-3.5-flash-lite' } },
  },
  roles: { main: { models: [], level: 'off' }, [KOE_REALTIME]: { models: realtime, level: 'off' }, [KOE_CLASSIC]: { models: classic, level: 'low' } },
  koeMode: mode,
});

test("Koe's way, for every mode, voice, list and model health: Realtime runs only chosen, with voice on and a model that can answer; otherwise Classic, and why", () => {
  const types = new Map([['gemini-live', { realtime: true }], ['chat-completions', {}]]);
  /** @typedef {'none' | 'ok' | 'resting'} Health */
  /** @type {Health[]} */
  const healths = ['none', 'ok', 'resting'];
  for (const mode of /** @type {const} */ (['realtime', 'classic'])) {
    for (const voiceOn of [true, false]) {
      for (const r of healths) {
        for (const c of healths) {
          const cfg = geminiCfg(r === 'none' ? [] : ['live'], c === 'none' ? [] : ['fast'], mode);
          const rest = new Set([...(r === 'resting' ? ['live'] : []), ...(c === 'resting' ? ['fast'] : [])]);
          const way = koeWay(cfg, { voiceOn, types, until: (id) => (rest.has(id) ? 5000 : 0), now: 1000 });
          const at = `${mode}, voice ${voiceOn ? 'on' : 'off'}, Realtime ${r}, Classic ${c}`;
          const wants = mode === 'realtime' && voiceOn;
          assert.equal(way.mode, mode, at);
          assert.equal(way.koe, r !== 'none' || c !== 'none', `${at}: Koe is set up`);
          if (wants && r === 'ok') {
            assert.deepEqual([way.using, way.why, way.split, way.path], ['realtime', '', true, { kind: 'live', modelId: 'live' }], at);
            continue;
          }
          assert.equal(way.using, 'classic', at);
          assert.equal(way.why, mode === 'classic' ? '' : !voiceOn ? 'voice off' : r === 'none' ? 'none' : 'resting', at);
          // Classic empty: Shiori is one, unless Realtime is wanted and has a model (then it is down, as a live voice that can't start was).
          assert.equal(way.split, c !== 'none' || (wants && r !== 'none'), `${at}: split`);
          assert.deepEqual(way.path, c === 'ok' ? { kind: 'text' } : null, `${at}: path`);
        }
      }
    }
  }
});

test("Koe's way passes over a model it can't call: an ability off, its protocol not running; Realtime's list takes only realtime models, Classic's only chat ones", () => {
  const types = new Map([['gemini-live', { realtime: true }], ['chat-completions', {}]]);
  const on = { voiceOn: true, types, until: () => 0, now: 1000 };
  const cfg = geminiCfg(['live'], ['fast'], 'realtime');
  const off = structuredClone(cfg);
  off.providers.pv.user.abilities.live.on = false;
  assert.deepEqual([koeWay(off, on).using, koeWay(off, on).why], ['classic', 'off'], 'Live voice switched off: off, not resting (nothing to wait for)');
  assert.deepEqual([koeWay(cfg, { ...on, types: new Map([['chat-completions', {}]]) }).why], ['off'], 'its protocol not running');
  assert.equal(koeWay(off, { ...on, until: () => 5000 }).why, 'off', 'off and resting: off says what to do');
  const chatOff = structuredClone(cfg);
  chatOff.providers.pv.user.abilities.chat.on = false;
  assert.equal(koeWay({ ...chatOff, koeMode: 'classic' }, on).path, null, 'Classic, its chat ability off: Koe is down');
  // A model of the wrong kind in a list (a file edited by hand) is passed over.
  assert.deepEqual(koeWay(geminiCfg(['fast'], ['live'], 'realtime'), on), { mode: 'realtime', using: 'classic', why: 'off', koe: true, split: true, path: null });
  // A text Koe's models: Classic's chat models (to hear, to upload to), those of an ability switched on.
  assert.deepEqual(chatCandidates(cfg, KOE_CLASSIC), ['fast']);
  assert.deepEqual(chatCandidates(chatOff, KOE_CLASSIC), []);
  // A config read without a mode (a test's, or one built by hand) follows the lists.
  const { koeMode: _, ...bare } = cfg;
  assert.equal(koeWay(/** @type {any} */ (bare), on).mode, 'realtime');
  assert.equal(koeWay(/** @type {any} */ ({ ...bare, roles: { ...bare.roles, [KOE_REALTIME]: { models: [], level: 'off' } } }), on).mode, 'classic');
});

test("Classic's wait for the first words is 8 seconds unless the user set one (Koe answers at once)", async () => {
  const { callRole, Bench } = await import('../../src/core/llm/fallback.js');
  /** @type {number[]} */
  const waits = [];
  /** @param {number} [firstOutputSeconds] */
  const config = (firstOutputSeconds) => /** @type {any} */ ({
    providers: { p: { id: 'p', plugin: 'x', template: null, user: { name: 'P', baseUrl: 'https://p.test', abilities: { chat: { kind: 'chat', type: 't' } } }, created: 0 } },
    models: { k: { id: 'k', provider: 'p', ability: 'chat', template: null, user: { providerId: 'fast' }, created: 0 } },
    roles: { [KOE_CLASSIC]: { models: ['k'], level: 'off', ...(firstOutputSeconds ? { firstOutputSeconds } : {}) } },
  });
  const type = { type: 't', name: 'T', pluginId: 'x', async* run() { yield { type: 'text', text: 'hi' }; } };
  const types = new Map([['t', /** @type {any} */ (type)]]);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = /** @type {any} */ ((/** @type {any} */ fn, /** @type {number} */ ms) => { waits.push(ms); return realSetTimeout(fn, 2 ** 30).unref(); });
  try {
    await callRole({ role: KOE_CLASSIC, request: { messages: [] }, config: config(), types, keyFor: async () => null, bench: new Bench() });
    await callRole({ role: KOE_CLASSIC, request: { messages: [] }, config: config(3), types, keyFor: async () => null, bench: new Bench() });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(waits[0], 8000);
  assert.ok(waits.includes(3000), 'its own setting');
});

test('adding a provider never fills Koe; "Use the recommended models" fills Realtime and Classic, and chooses Realtime when its live model is on', async () => {
  const src = withLive();
  src.provider.roles = { recommended: { main: ['big'], [KOE_REALTIME]: ['live-1'], [KOE_CLASSIC]: ['small:free'] } };
  assert.deepEqual(checkProviderDesc(src.provider), []);
  assert.deepEqual(checkProviderDesc({ ...src.provider, roles: { recommended: { [KOE_REALTIME]: ['big'] } } }), [`$.roles.recommended.${KOE_REALTIME}: big isn't a realtime model of this provider`]);
  assert.deepEqual(checkProviderDesc({ ...src.provider, roles: { recommended: { koe2: ['big'] } } }), [], "a role this annai doesn't know (a later one, or renamed) is skipped, never a reason to refuse the description");
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const id = await addProvider({ ws, store }, src, { key: 'sk-r', roles: 'recommended' });
  let cfg = await readConfig(ws);
  const name = (/** @type {string} */ role) => cfg.roles[role].models.map((m) => modelOf(cfg.models[m]).name);
  assert.deepEqual([name('main'), name(KOE_REALTIME), name(KOE_CLASSIC)], [['Big'], [], []], 'the split is opt-in: adding a provider never turns it on');
  await saveKoeMode(ws, 'classic');
  await useSuggestion({ ws }, id, src, 'recommended');
  cfg = await readConfig(ws);
  assert.deepEqual([name(KOE_REALTIME), name(KOE_CLASSIC), cfg.koeMode], [['Live One'], ['Small (free)'], 'realtime']);
  // Tapped again after Classic was chosen: the tap asks for the recommended way, Realtime.
  await saveKoeMode(ws, 'classic');
  await useSuggestion({ ws }, id, src, 'recommended');
  assert.equal((await readConfig(ws)).koeMode, 'realtime');
});

test("Use the recommended models with Live voice switched off: nothing goes into Realtime (models come from abilities switched on), and the mode stays as chosen", async () => {
  const src = withLive();
  /** @type {any} */ (src.provider.abilities).live.on = false;
  src.provider.roles = { recommended: { main: ['big'], [KOE_REALTIME]: ['live-1'], [KOE_CLASSIC]: ['small:free'] } };
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const id = await addProvider({ ws, store }, src, { key: 'sk-r', roles: null });
  await saveKoeMode(ws, 'classic');
  await useSuggestion({ ws }, id, src, 'recommended');
  const cfg = await readConfig(ws);
  assert.equal(cfg.roles[KOE_REALTIME].models.length, 0, "picked only from abilities switched on, as every role is");
  assert.equal(cfg.koeMode, 'classic');
});

test("an older description that recommends the one Koe list: its realtime models go into Realtime, its chat models into Classic; the names from before 2026-10-19 are ignored", async () => {
  const src = withLive();
  src.provider.roles = { recommended: { main: ['big'], koe: ['live-1', 'small:free'], 'koe-talk': ['big'], 'koe-type': ['big'], 'koe-later': ['big'] } };
  assert.deepEqual(checkProviderDesc(src.provider), [], 'an older description still checks');
  assert.deepEqual(checkProviderDesc({ ...src.provider, roles: { recommended: { koe: ['free-voice'] } } }), ["$.roles.recommended.koe: free-voice isn't a chat or realtime model of this provider"]);
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const id = await addProvider({ ws, store }, src, { key: 'sk-r', roles: null });
  await useSuggestion({ ws }, id, src, 'recommended');
  const cfg = await readConfig(ws);
  const name = (/** @type {string} */ role) => cfg.roles[role].models.map((m) => modelOf(cfg.models[m]).name);
  assert.deepEqual([name(KOE_REALTIME), name(KOE_CLASSIC), cfg.koeMode], [['Live One'], ['Small (free)'], 'realtime']);
  const file = await ws.readJSON(SYS_SETTINGS, '/llm/roles.json');
  assert.ok(!('koe' in file) && !('koe-talk' in file) && !('koe-type' in file) && !('koe-later' in file), 'an unknown role is skipped');
});

test("the split is written once, at start-up (splitOldKoe): the mode an old list implied stays when the Live ability changes later; a file with nothing old is left alone", async () => {
  const { ws, pid, big, small, live } = await setup();
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { koe: { models: [live, small], level: 'medium' }, main: { models: [big], level: 'medium' } }, { author: 'user' });
  assert.equal(await splitOldKoe(ws), true);
  const file = await ws.readJSON(SYS_SETTINGS, '/llm/roles.json');
  assert.deepEqual([file['koe-mode'], file[KOE_REALTIME].models, file[KOE_CLASSIC].models, 'koe' in file], ['realtime', [live], [small], false]);
  // Live switched off afterwards: still the mode the old list implied, not one worked out again.
  const rec = (await readConfig(ws)).providers[pid];
  await ws.write(SYS_SETTINGS, `/llm/providers/${pid}.json`, { ...rec, user: { ...rec.user, abilities: { live: { on: false } } } }, { author: 'user' });
  assert.equal((await readConfig(ws)).koeMode, 'realtime');
  assert.equal(await splitOldKoe(ws), false, 'nothing old: nothing written');
  await ws.write(SYS_SETTINGS, '/llm/roles.json', { 'koe-talk': { models: [small], level: 'off' } }, { author: 'user' });
  assert.equal(await splitOldKoe(ws), true, 'the lists from before 2026-10-19 too');
  assert.ok(!('koe-talk' in (await ws.readJSON(SYS_SETTINGS, '/llm/roles.json'))));
});

test("an old list left beside the two new ones: its ids not in either list join them by kind, at the end; none is dropped or doubled", async () => {
  const { ws, big, small, live } = await setup();
  await ws.write(SYS_SETTINGS, '/llm/roles.json', {
    [KOE_REALTIME]: { models: [], level: 'off' }, [KOE_CLASSIC]: { models: [small], level: 'low' }, 'koe-mode': 'classic',
    koe: { models: [live, small, big], level: 'medium' },
  }, { author: 'user' });
  const cfg = await readConfig(ws);
  assert.deepEqual([cfg.roles[KOE_REALTIME].models, cfg.roles[KOE_CLASSIC].models, cfg.roles[KOE_CLASSIC].level, cfg.koeMode], [[live], [small, big], 'low', 'classic'], "the new lists' own settings stay");
});

test("removing a provider keeps the chosen mode", async () => {
  const { ws, store, pid, small, live } = await setup();
  await saveRoles(ws, { ...(await readConfig(ws)).roles, [KOE_REALTIME]: { models: [live], level: 'off' }, [KOE_CLASSIC]: { models: [small], level: 'low' } });
  await saveKoeMode(ws, 'classic');
  await removeProviderRecords(ws, store, pid);
  const file = await ws.readJSON(SYS_SETTINGS, '/llm/roles.json');
  assert.deepEqual([file['koe-mode'], file[KOE_REALTIME].models, file[KOE_CLASSIC].models], ['classic', [], []]);
  assert.equal((await readConfig(ws)).koeMode, 'classic');
});

test("the voice chip's words for Koe: the list that talks, why Classic stands in, Koe down, and Classic chosen but empty; nothing with voice off, no Koe model, or a way still from voice off", () => {
  /** @param {any} w */
  const way = (w) => ({ mode: 'realtime', using: 'classic', why: '', koe: true, split: true, path: 'text', ...w });
  assert.deepEqual(koeWords(way({ using: 'realtime', path: 'live' }), true), { text: ' · Realtime', note: '' });
  assert.deepEqual(koeWords(way({ mode: 'classic' }), true), { text: ' · Classic', note: '' });
  assert.deepEqual(koeWords(way({ why: 'resting' }), true), { text: ' · Classic', reason: '(Realtime resting)', note: "Realtime is resting after a failure. Classic talks until it can." });
  assert.deepEqual(koeWords(way({ why: 'off' }), true), { text: ' · Classic', reason: '(Realtime off)', note: "Realtime's live voice is switched off, or its plugin isn't running. Classic talks meanwhile." });
  assert.deepEqual(koeWords(way({ why: 'none' }), true), { text: ' · Classic', reason: '(no Realtime model)', note: 'Realtime has no model: add one under Koe · Realtime in Settings → Models. Classic talks meanwhile.' });
  // Koe down: Realtime wanted, nothing in Classic that can answer: never "Classic".
  assert.deepEqual(koeWords(way({ why: 'resting', path: null }), true), { text: ' · Realtime resting', note: 'Shiori answers directly until it can.' });
  assert.deepEqual(koeWords(way({ why: 'off', path: null }), true), { text: ' · Realtime off', note: 'Shiori answers directly until it can.' });
  assert.deepEqual(koeWords(way({ mode: 'classic', path: null }), true), { text: ' · Classic unavailable', note: "Koe · Classic can't answer now. Shiori answers directly until it can." });
  // Classic chosen with nothing in it: Shiori is one half.
  assert.deepEqual(koeWords(way({ mode: 'classic', split: false, path: null }), true), { text: ' · Classic', reason: '(no model)', note: 'Koe · Classic has no model, so Shiori answers as one. Add one in Settings → Models.' });
  assert.deepEqual(koeWords(way({ using: 'realtime' }), false), { text: '', note: '' }, 'voice off: as before');
  assert.deepEqual(koeWords(way({ koe: false }), true), { text: '', note: '' });
  assert.deepEqual(koeWords(way({ why: 'voice off' }), true), { text: '', note: '' }, 'voice just came on: nothing until Koe has worked out its way');
  assert.deepEqual(koeWords(null, true), { text: '', note: '' });
});
