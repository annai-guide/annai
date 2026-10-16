import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { utf8 } from '../../src/core/bytes.js';

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @param {string} name @param {any} input @param {any} [model] */
  const run = (name, input, model = { input: ['text', 'image'] }) => tools[name].run(input, { scope: trip, trip, signal: new AbortController().signal, model, wake: 'w', author: 'shiori' });
  return { ws, trip, run, tools };
}

test('write, read, edit, patch and delete, as Shiori, in the open trip and in /me', async () => {
  const { ws, trip, run } = await setup();
  assert.match(await run('write', { path: '/trip/notes/dinner.md', content: '# Dinner\nNepenthe at 6:30\n' }), /Wrote \/trip\/notes\/dinner\.md/);
  assert.equal((await ws.read(trip, '/notes/dinner.md')).entry.author, 'shiori');
  assert.equal(await run('read', { path: '/trip/notes/dinner.md' }), '# Dinner\nNepenthe at 6:30\n');
  await run('edit', { path: '/trip/notes/dinner.md', old: '6:30', new: '7:00' });
  assert.match(await ws.readText(trip, '/notes/dinner.md'), /7:00/);
  await run('write', { path: '/trip/plan/dinner.json', content: { id: 'dinner', title: 'Dinner', fixed: true, tags: ['food'] } });
  await run('patch', { path: '/trip/plan/dinner.json', changes: { notes: 'Window table', 'tags+': ['view'] } });
  assert.deepEqual((await ws.readJSON(trip, '/plan/dinner.json')).tags, ['food', 'view']);
  await run('write', { path: '/me/memory.md', content: '# Memory\n- Likes ocean views\n' });
  assert.match(await ws.readText(ME, '/memory.md'), /ocean views/);
  await run('delete', { path: '/trip/notes/dinner.md' });
  assert.equal(await ws.read(trip, '/notes/dinner.md'), undefined);
});

test('errors are plain and say what to do', async () => {
  const { run } = await setup();
  await run('write', { path: '/trip/notes/a.md', content: 'one two one' });
  await assert.rejects(run('edit', { path: '/trip/notes/a.md', old: 'one', new: '1' }), /appears 2 times/);
  await assert.rejects(run('edit', { path: '/trip/notes/a.md', old: 'three', new: '3' }), /isn't in \/trip\/notes\/a\.md/);
  await assert.rejects(run('read', { path: '/trip/notes/none.md' }), /No file at \/trip\/notes\/none\.md/);
  await assert.rejects(run('write', { path: '/me/personalities/shiori.md', content: 'x' }), /tune_personality/);
  await assert.rejects(run('write', { path: '/trip/plan/bad.json', content: { title: 3 } }), /doesn't match its format/);
});

test('list and search answer in TSV with the paths Shiori uses', async () => {
  const { run } = await setup();
  await run('write', { path: '/trip/notes/a.md', content: 'Bixby Bridge at sunset\nthen dinner' });
  await run('write', { path: '/trip/notes/b.md', content: 'Nothing here' });
  const listing = await run('list', { path: '/trip/notes/' });
  assert.match(listing, /^path\ttype\tsize\tmodified\tauthor\n\/trip\/notes\/a\.md\ttext\/markdown/);
  const found = await run('search', { query: 'bixby' });
  assert.equal(found, 'path\tline\ttext\n/trip/notes/a.md\t1\tBixby Bridge at sunset');
});

test('read: long text in pieces; a photo as an image when the model takes images; a PDF as a document only when it takes PDFs', async () => {
  const { ws, trip, run } = await setup();
  await run('write', { path: '/trip/notes/long.md', content: 'x'.repeat(50_000) });
  const first = await run('read', { path: '/trip/notes/long.md' });
  assert.match(first, /read again with from: 40000/);
  assert.equal((await run('read', { path: '/trip/notes/long.md', from: 40_000 })).length, 10_000);
  const photo = await ws.write(trip, '/files/a.webp', utf8('webp-bytes'), { author: 'user', type: 'image/webp', meta: { width: 2048, height: 1536, taken: '2026-11-26T16:12:00-08:00' } });
  const seen = await run('read', { path: '/trip/files/a.webp' });
  assert.deepEqual(seen.images, [{ mediaType: 'image/webp', hash: photo.hash, path: '/trip/files/a.webp' }]);
  assert.match(seen.content, /2048×1536, taken 2026-11-26T16:12:00-08:00/);
  assert.match(await run('read', { path: '/trip/files/a.webp' }, { input: ['text'] }), /can't see photos/);
  await ws.write(trip, '/files/menu.pdf', utf8('%PDF-1.4'), { author: 'user', type: 'application/pdf' });
  assert.match(await run('read', { path: '/trip/files/menu.pdf' }), /Ask the user for a screenshot/);
  const doc = await run('read', { path: '/trip/files/menu.pdf' }, { input: ['text', 'pdf'] });
  assert.equal(doc.document.mediaType, 'application/pdf');
});

test('personalities are refused however the path is written (the check is on the path as resolved)', async () => {
  const { run } = await setup();
  for (const path of ['/me//personalities/shiori.md', '/me/personalities//shiori.md', '/me//personalities']) {
    await assert.rejects(run('write', { path, content: 'x' }), /tune_personality/, path);
  }
  await assert.rejects(run('patch', { path: '/me//personalities/x.json', changes: { a: 1 } }), /tune_personality/);
  await assert.rejects(run('delete', { path: '/me//personalities/shiori.md' }), /tune_personality/);
});
