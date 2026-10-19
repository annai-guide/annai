import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS, SYS_SETTINGS } from '../../src/core/scopes.js';
import { readConfig, saveRoles, newProvider, newModel, saveProvider, setKey } from '../../src/core/llm/config.js';
import { moveOver } from '../../src/core/llm/move-over.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}

/** What a device had before providers: two endpoints with their models, keys, uploads and the templates cache. @param {Workspace} ws @param {any} store */
async function oldSetup(ws, store) {
  await ws.write(SYS_SETTINGS, '/llm/endpoints/ep-a.json', { id: 'ep-a', type: 'chat-completions', template: { id: 'openrouter', version: 3, values: { name: 'OpenRouter' } }, user: {}, created: 1 }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/endpoints/ep-b.json', { id: 'ep-b', type: 'anthropic-messages', template: null, user: { name: 'My Claude', baseUrl: 'https://api.anthropic.com' }, created: 2 }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/models/m-a.json', { id: 'm-a', endpoint: 'ep-a', template: null, user: { providerId: 'a' }, created: 1 }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/models/m-b.json', { id: 'm-b', endpoint: 'ep-b', template: null, user: { providerId: 'b' }, created: 2 }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/catalog/templates.json', { format: 1, endpoints: [] }, { author: 'system' });
  await ws.write(SYS_SETTINGS, '/llm/uploads.json', { 'ep-b': { h: { id: 'file-1', expiresAt: 9e15 } } }, { author: 'system' });
  await saveRoles(ws, { main: { models: ['m-a', 'm-b'], level: 'medium' }, 'speech-out': { models: ['browser-voice'], level: 'off' } });
  await setKey(store, 'ep-a', 'sk-or-old-key-1234');
  await setKey(store, 'ep-b', 'sk-ant-old-key-5678');
}

/** Everything annai keeps in the settings scope, files and their history, as text. @param {any} store */
const kept = (store) => store.tx(['files', 'events', 'blobs'], 'readonly', async (/** @type {any} */ t) => {
  const out = [JSON.stringify(await t.listFiles(SYS_SETTINGS)), JSON.stringify(await t.listEvents(SYS_SETTINGS))];
  for (const b of await t.listBlobs()) out.push(new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
  return out.join('\n');
});

test('moving over: old endpoints, their models, keys, uploads, the templates cache and their history are gone; roles keep only the stand-ins; the card names them', async () => {
  const { store, ws } = await setup();
  await oldSetup(ws, store);
  // A provider set up already is no endpoint: it stays.
  const p = newProvider('provider-scripted', { user: { abilities: { chat: { kind: 'chat', type: 'scripted' } } } });
  const m = newModel(p.id, 'chat', { user: { providerId: 'scripted' } });
  await saveProvider(ws, p, [m]);
  await saveRoles(ws, { ...(await ws.readJSON(SYS_SETTINGS, '/llm/roles.json')), utility: { models: [m.id], level: 'low' } });
  await setKey(store, p.id, 'sk-new-key-0000');
  const r = await moveOver(ws, store);
  assert.deepEqual(r, { names: ['OpenRouter', 'My Claude'] });
  for (const path of ['/llm/endpoints/ep-a.json', '/llm/models/m-a.json', '/llm/models/m-b.json', '/llm/catalog/templates.json']) {
    assert.equal(await ws.readJSON(SYS_SETTINGS, path), undefined, path);
    assert.deepEqual(await ws.history(SYS_SETTINGS, path), [], `${path}: its history too`);
  }
  const text = await kept(store);
  for (const gone of ['ep-a', 'ep-b', 'My Claude', 'file-1']) assert.ok(!text.includes(gone), gone);
  assert.deepEqual(await store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [`llm:${p.id}`]);
  assert.deepEqual(await ws.readJSON(SYS_SETTINGS, '/llm/uploads.json'), {});
  const cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles.main.models, []);
  assert.deepEqual(cfg.roles.utility.models, [m.id]);
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice']);
  assert.deepEqual(Object.keys(cfg.providers), [p.id]);
  const [moved] = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['llm.moved'] }));
  assert.deepEqual(moved.data, { endpoints: 2, models: 2 }, 'counts, never names, in the log');
});

test('nothing old: nothing changes and no card', async () => {
  const { store, ws } = await setup();
  const before = await kept(store);
  assert.equal(await moveOver(ws, store), null);
  assert.equal(await kept(store), before);
  assert.deepEqual(await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['llm.moved'] })), []);
});

test('a backup from before the change, restored after it, is moved over again at the next start, its keys deleted (Review Focus 4)', async () => {
  const { store, ws } = await setup();
  await oldSetup(ws, store);
  await moveOver(ws, store);
  await oldSetup(ws, store); // what the restored backup brings back
  assert.deepEqual(await moveOver(ws, store), { names: ['OpenRouter', 'My Claude'] });
  assert.deepEqual(await store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), []);
  assert.equal(await moveOver(ws, store), null, 'once done, done');
});

test('fix pass: an endpoint file that names no id (a broken record, a truncated restore) still has its key removed: the old ids were the file names', async () => {
  const { store, ws } = await setup();
  await ws.write(SYS_SETTINGS, '/llm/endpoints/ep-good.json', { id: 'ep-good', type: 'chat-completions', template: null, user: { name: 'Good' }, created: 1 }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/endpoints/ep-odd.json', { user: { name: 'Odd' } }, { author: 'user' });
  await ws.write(SYS_SETTINGS, '/llm/endpoints/ep-broken.json', 'not json at all', { author: 'user', type: 'text/plain' });
  await store.tx(['secrets'], 'readwrite', async (t) => { for (const id of ['ep-good', 'ep-odd', 'ep-broken']) await t.putSecret(`llm:${id}`, `k-${id}-123456`); });
  const r = await moveOver(ws, store);
  assert.deepEqual(r?.names.sort(), ['Good', 'Odd', 'ep-broken'].sort());
  assert.deepEqual(await store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), []);
  assert.deepEqual(await ws.list(SYS_SETTINGS, '/llm/endpoints/'), []);
});
