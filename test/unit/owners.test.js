import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, NAMED } from '../../src/core/registry.js';

/** Ranks as the host gives them: built-ins 0, official 1, third-party 2, then install time, then id. */
const RANKS = { web: [0, 0, 'web'], weather: [1, 10, 'weather'], early: [2, 20, 'early'], late: [2, 30, 'late'] };
/** @param {Record<string, string>} [chosen] by "<kind>:<name>" @param {Record<string, 'only' | 'own'>} [reserved] by "<kind>:<name>" */
const rules = (chosen = {}, reserved = {}) => ({
  rank: (/** @type {string} */ id) => /** @type {any} */ (RANKS)[id] ?? [2, 99, id],
  choice: (/** @type {string} */ kind, /** @type {string} */ name) => chosen[`${kind}:${name}`],
  reserved: (/** @type {string} */ kind, /** @type {string} */ name) => reserved[`${kind}:${name}`] ?? null,
});
const tool = (/** @type {string} */ name, /** @type {string} */ by) => ({ name, by });
const owners = (/** @type {Registry} */ r, /** @type {string} */ kind) => r.entries(kind).map((e) => `${e.pluginId}:${e.item.name ?? e.item.type ?? e.item.id}`);

test('a name has one owner: the lowest rank (built-in, official, third-party by install time), whatever order they started in', () => {
  for (const order of [['late', 'early', 'weather', 'web'], ['web', 'weather', 'early', 'late'], ['early', 'late', 'web', 'weather']]) {
    const r = new Registry();
    r.setRules(rules());
    for (const id of order) r.add(id, 'tool', tool('forecast', id));
    r.add('late', 'tool', tool('tides', 'late'));
    r.add('early', 'tool', tool('tides', 'early'));
    assert.deepEqual(owners(r, 'tool').sort(), ['early:tides', 'web:forecast'], order.join(' '));
    assert.deepEqual(r.list('tool').map((t) => t.by).sort(), ['early', 'web']);
    assert.deepEqual(r.owner('tool', 'forecast'), { pluginId: 'web', chosen: false });
    assert.equal(r.owner('tool', 'nothing'), null);
    // all: every contribution, used or not.
    assert.equal(r.entries('tool', { all: true }).length, 6);
  }
});

test('before rules are set, the first to register owns a name, as before (unit tests elsewhere)', () => {
  const r = new Registry();
  r.add('b', 'endpoint-type', { type: 'chat' });
  r.add('a', 'endpoint-type', { type: 'chat' });
  r.add('a', 'endpoint-type', { type: 'speech' });
  assert.deepEqual(owners(r, 'endpoint-type'), ['b:chat', 'a:speech']);
});

test("the user's choice owns the name while that plugin runs and registers it; switched off, the next by rank owns it", () => {
  const chosen = { 'tool:forecast': 'late', 'skill:tides': 'late', 'ui:component:avatar': 'gone' };
  const r = new Registry();
  r.setRules(rules(chosen));
  r.add('web', 'tool', tool('forecast', 'web'));
  r.add('late', 'tool', tool('forecast', 'late'));
  r.add('early', 'skill', { name: 'tides' });
  r.add('late', 'skill', { name: 'tides' });
  assert.deepEqual(r.owner('tool', 'forecast'), { pluginId: 'late', chosen: true });
  assert.deepEqual(owners(r, 'tool'), ['late:forecast']);
  assert.deepEqual(owners(r, 'skill'), ['late:tides']);
  // Switched off after errors: its choice waits, and the next by rank answers.
  r.disable('late', { kind: 'failed', count: 3 }, 'broke');
  assert.deepEqual(r.owner('tool', 'forecast'), { pluginId: 'web', chosen: false });
  assert.deepEqual(owners(r, 'skill'), ['early:tides']);
  r.enable('late');
  assert.deepEqual(owners(r, 'tool'), ['late:forecast']);
  // Stopped (turned off, or removed): it registers nothing, so the next by rank owns the name.
  r.removePlugin('late');
  assert.deepEqual(owners(r, 'tool'), ['web:forecast']);
  // A choice of a plugin that doesn't register the name changes nothing.
  r.add('early', 'ui:component', { name: 'avatar' });
  assert.deepEqual(r.owner('ui:component', 'avatar'), { pluginId: 'early', chosen: false });
});

test('rules that change are told to listeners, so screens draw again', () => {
  const r = new Registry();
  let told = 0;
  r.onChange(() => { told += 1; });
  r.setRules(rules());
  assert.equal(told, 1);
});

test("a reserved name (the loop's own tools, annai's components) belongs to annai, and no plugin owns it", () => {
  const reserved = /** @type {const} */ ({ 'tool:speak': 'only', 'ui:component:avatar': 'own', 'skill:plan-a-trip': 'own' });
  const r = new Registry();
  r.setRules(rules({ 'tool:speak': 'late', 'ui:component:dock': 'late' }, reserved));
  r.add('late', 'tool', tool('speak', 'late'));
  r.add('late', 'ui:component', { name: 'avatar' });
  r.add('early', 'skill', { name: 'plan-a-trip' });
  // Only: nothing replaces it, the user's choice neither.
  assert.deepEqual(r.owner('tool', 'speak'), { pluginId: 'annai', chosen: false });
  assert.deepEqual(r.list('tool'), []);
  // Own: annai's, with no entry of its own, until the user chooses a plugin's.
  assert.deepEqual(r.owner('ui:component', 'avatar'), { pluginId: 'annai', chosen: false });
  assert.deepEqual(r.list('ui:component'), []);
  assert.deepEqual(r.list('skill'), []);
  r.setRules(rules({ 'ui:component:avatar': 'late' }, reserved));
  assert.deepEqual(r.owner('ui:component', 'avatar'), { pluginId: 'late', chosen: true });
  assert.deepEqual(owners(r, 'ui:component'), ['late:avatar']);
  // A built-in's own entry is annai's.
  r.add('web', 'skill', { name: 'plan-a-trip' });
  assert.deepEqual(owners(r, 'skill'), ['web:plan-a-trip']);
});

test('a protocol and a kind of backup place are handed keys: the owner is by rank alone, and no choice moves them', () => {
  const r = new Registry();
  r.setRules(rules({ 'endpoint-type:chat-completions': 'late', 'storage-type:webdav': 'late' }));
  r.add('weather', 'endpoint-type', { type: 'chat-completions' });
  r.add('late', 'endpoint-type', { type: 'chat-completions' });
  r.add('weather', 'storage-type', { type: 'webdav' });
  r.add('late', 'storage-type', { type: 'webdav' });
  assert.deepEqual(owners(r, 'endpoint-type'), ['weather:chat-completions']);
  assert.deepEqual(owners(r, 'storage-type'), ['weather:webdav']);
  assert.deepEqual(r.clashes('late').map((c) => [c.kind, c.owner, c.used, c.reserved, c.chosen]), [['endpoint-type', 'weather', false, true, false], ['storage-type', 'weather', false, true, false]]);
});

test('clashes lists what a plugin registers that it does not own, and who does; a plugin a choice put aside sees it too', () => {
  const r = new Registry();
  r.setRules(rules({ 'search:jina': 'late' }, { 'tool:speak': 'only', 'ui:component:avatar': 'own' }));
  r.add('web', 'tool', tool('forecast', 'web'));
  r.add('late', 'tool', tool('forecast', 'late'));
  r.add('late', 'tool', tool('speak', 'late'));
  r.add('late', 'tool', tool('only_mine', 'late'));
  r.add('late', 'ui:component', { name: 'avatar' });
  r.add('web', 'search', { id: 'jina' });
  r.add('late', 'search', { id: 'jina' });
  assert.deepEqual(r.clashes('late'), [
    { kind: 'tool', name: 'forecast', owner: 'web', used: false, reserved: false, chosen: false },
    { kind: 'tool', name: 'speak', owner: 'annai', used: false, reserved: true, chosen: false },
    { kind: 'ui:component', name: 'avatar', owner: 'annai', used: false, reserved: false, chosen: false },
    { kind: 'search', name: 'jina', owner: 'late', used: true, reserved: false, chosen: true },
  ]);
  assert.deepEqual(r.clashes('web'), [{ kind: 'search', name: 'jina', owner: 'late', used: false, reserved: false, chosen: true }]);
  assert.deepEqual(r.clashes('nobody'), []);
});

test('hooks and adding slots never clash', () => {
  const r = new Registry();
  r.setRules(rules());
  for (const kind of ['hook', 'ui:status-chip', 'ui:now-section', 'ui:dock-action', 'ui:trip-tab', 'ui:settings-page', 'ui:screen', 'ui:theme', 'sensor', 'trigger', 'schema']) {
    assert.equal(NAMED[kind], undefined, kind);
    r.add('late', kind, { id: 'same', name: 'same' });
    r.add('early', kind, { id: 'same', name: 'same' });
    assert.equal(r.list(kind).length, 2, kind);
  }
  assert.deepEqual(r.clashes('late'), []);
  assert.deepEqual(Object.keys(NAMED).sort(), ['endpoint-type', 'personality', 'search', 'skill', 'storage-type', 'tool', 'ui:card-type', 'ui:component']);
});

test("M6 fix: a protocol or a kind of backup place annai's official plugin provides never falls to a third party: while annai's isn't running, nobody owns it", () => {
  const ranks = /** @type {Record<string, any[]>} */ ({ 'chat-completions': [1, 10, 'chat-completions'], webdav: [1, 11, 'webdav'], evil: [2, 99, 'evil'] });
  const official = /** @type {Record<string, string>} */ ({ 'endpoint-type:chat-completions': 'chat-completions', 'storage-type:webdav': 'webdav' });
  const r = new Registry();
  r.setRules({ ...rules(), rank: (id) => ranks[id] ?? [2, 999, id], official: (kind, name) => official[`${kind}:${name}`] });
  r.add('chat-completions', 'endpoint-type', { type: 'chat-completions', by: 'official' });
  r.add('webdav', 'storage-type', { type: 'webdav', by: 'official' });
  r.add('evil', 'endpoint-type', { type: 'chat-completions', by: 'evil' });
  r.add('evil', 'storage-type', { type: 'webdav', by: 'evil' });
  r.add('evil', 'endpoint-type', { type: 'acme', by: 'evil' });
  const by = (/** @type {string} */ kind) => r.list(kind).map((t) => `${t.type}:${t.by}`);
  assert.deepEqual([by('endpoint-type'), by('storage-type')], [['chat-completions:official', 'acme:evil'], ['webdav:official']]);
  // Switched off after errors, or stopped: nobody owns the name, and the third party's is still not used.
  r.disable('chat-completions', { kind: 'failed', count: 3 });
  r.removePlugin('webdav');
  assert.deepEqual([by('endpoint-type'), by('storage-type')], [['acme:evil'], []]);
  assert.equal(r.owner('endpoint-type', 'chat-completions'), null);
  assert.equal(r.owner('storage-type', 'webdav'), null);
  assert.deepEqual(r.clashes('evil'), [
    { kind: 'endpoint-type', name: 'chat-completions', owner: 'chat-completions', used: false, reserved: true, chosen: false },
    { kind: 'storage-type', name: 'webdav', owner: 'webdav', used: false, reserved: true, chosen: false },
  ]);
});
