import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFacts } from '../../src/core/catalog-facts.js';
import { addRows } from '../../src/ui/screens/add.js';

/** A catalog entry: facts and what it provides. @param {any} m */
const entry = (m) => ({ ...catalogFacts({ version: '1.0.0', ...m }, { size: 2048 }), provides: m.provides ?? {}, files: {} });
const chat = { baseUrl: 'https://api.example/v1', key: 'required', abilities: { chat: { kind: 'chat', type: 'chat-completions' } } };
const CATALOG = [
  entry({ id: 'provider-openai', name: 'OpenAI', provider: chat }),
  entry({ id: 'provider-openrouter', name: 'OpenRouter', provider: chat }),
  entry({ id: 'provider-another-address', name: 'Another address', provider: { ...chat, baseUrl: '' } }),
  entry({ id: 'storage-s3', name: 'S3-compatible storage', entry: 'index.js', provides: { 'storage-type': ['s3'] } }),
  entry({ id: 'remote-trace', name: 'Remote trace (for developers)', entry: 'index.js', category: 'developer' }),
  entry({ id: 'chat-completions', name: 'Chat Completions', entry: 'index.js', provides: { 'endpoint-type': ['chat-completions'] } }),
];
/** An installed plugin as the Plugins page describes it. @param {any} m @param {any} s */
const mine = (m, s) => ({ ...catalogFacts({ version: '1.0.0', ...m }, { size: 512 }), builtin: false, ...s });
const INSTALLED = [
  mine({ id: 'provider-openai', name: 'OpenAI', provider: chat }, { source: 'official' }),
  // A copy from elsewhere holding the id of annai's own (security review).
  mine({ id: 'provider-openrouter', name: 'OpenRouter', provider: chat }, { source: 'url', url: 'https://evil.example/p/annai-plugin.json' }),
  mine({ id: 'trail-kit', name: 'Trail LLM', provider: chat }, { source: 'file', file: 'trail-kit.zip' }),
  mine({ id: 'tide-pools', name: 'tide-pools', skills: ['.'] }, { source: 'url', url: 'https://kits.example/tide-pools/SKILL.md' }),
  mine({ id: 'remote-trace', name: 'Remote trace (for developers)', entry: 'index.js', category: 'developer' }, { source: 'official' }),
  { ...mine({ id: 'core-schemas', name: 'Trip record checks' }, { source: 'builtin' }), builtin: true },
];

/** @param {any[]} rows @param {string} id */
const find = (rows, id) => rows.find((r) => r.facts.id === id);

test('a provider already set up is Added, with Add another; an official entry wins over an installed copy of the same id; fixed rows are there', () => {
  const rows = addRows(CATALOG, INSTALLED, { 'provider-openai': 2, 'trail-kit': 0 });
  const pick = (/** @type {string} */ id) => {
    const r = find(rows, id);
    return r && { official: r.official, added: r.added, action: r.action, from: r.from, ...(r.href ? { href: r.href } : {}) };
  };
  assert.deepEqual(pick('provider-openai'), { official: true, added: 2, action: 'add-another', from: 'Official' });
  assert.deepEqual(pick('provider-another-address'), { official: true, added: 0, action: 'add', from: 'Official' });
  // annai's own entry is shown, never the copy from elsewhere; it can't be added until that copy is removed.
  const held = find(rows, 'provider-openrouter');
  assert.deepEqual([held.official, held.facts.size, held.action, held.href], [true, 2048, 'open', '#/plugins/provider-openrouter']);
  assert.match(held.note, /came from elsewhere.*annai won't use it.*Remove it/);
  assert.equal(rows.filter((r) => r.facts.id === 'provider-openrouter').length, 1);
  // A backup place is set up on Backups, its kind chosen; an installed plugin opens its page; one not installed installs.
  assert.deepEqual(pick('storage-s3'), { official: true, added: 0, action: 'set-up', from: 'Official', href: '#/backups?add=s3' });
  assert.deepEqual(pick('remote-trace'), { official: true, added: 0, action: 'open', from: 'Official', href: '#/plugins/remote-trace' });
  assert.deepEqual(pick('chat-completions'), { official: true, added: 0, action: 'install', from: 'Official' });
  // Installed third-party plugins join, as what they are; annai's built-in parts aren't something to add.
  assert.deepEqual(pick('trail-kit'), { official: false, added: 0, action: 'add', from: 'From a file' });
  assert.deepEqual(pick('tide-pools'), { official: false, added: 0, action: 'open', from: 'From kits.example', href: '#/plugins/tide-pools' });
  assert.equal(find(rows, 'tide-pools').facts.category, 'skills');
  assert.equal(find(rows, 'core-schemas'), undefined);
  // The fixed row: an MCP server, set up on its own screen.
  assert.deepEqual(pick('mcp'), { official: true, added: 0, action: 'set-up', from: 'Built into annai', href: '#/mcp' });
  assert.equal(find(rows, 'mcp').facts.category, 'tools');
});

test("offline, installed items still list: a copy from elsewhere is shown as what it is, and annai's own installed ones as official", () => {
  const rows = addRows(null, INSTALLED, { 'provider-openai': 1 });
  assert.deepEqual(rows.map((r) => r.facts.id).sort(), ['mcp', 'provider-openai', 'provider-openrouter', 'remote-trace', 'tide-pools', 'trail-kit']);
  const copy = find(rows, 'provider-openrouter');
  assert.deepEqual([copy.official, copy.from, copy.action, copy.note], [false, 'From evil.example', 'add', undefined]);
  assert.deepEqual([find(rows, 'provider-openai').official, find(rows, 'provider-openai').action], [true, 'add-another']);
});

test("a third-party manifest's featured counts nowhere: only annai's catalog marks one", () => {
  const rows = addRows(null, [mine({ id: 'loud', name: 'Loud', provider: chat }, { source: 'file', featured: 'Pick me first.' })], {});
  assert.equal(find(rows, 'loud').facts.featured, undefined);
});
