import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, isDeviceSecret } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS, MANIFEST_NAME } from '../../src/core/archive.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8, text } from '../../src/core/bytes.js';

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (/** @type {string} */ k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  return { store, ws };
}

test("the relay's cancel tokens never leave this device: not even an encrypted Backup with API keys holds them", async () => {
  const a = await device();
  await a.store.tx(['secrets'], 'readwrite', async (t) => {
    await t.putSecret('push:tokens', { 'x.y': 'cancel-token-never-exported-01' });
    await t.putSecret('endpoint:e', 'sk-model-key-0001');
  });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, secrets: true, passphrase: 'correct horse battery', app: 'test' });
  const b = await device();
  const result = await importArchive(b.store, await openArchive(blob, 'correct horse battery'), { secrets: true });
  assert.equal(result.secrets, 1);
  assert.deepEqual(await b.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['endpoint:e']);
  assert.equal(isDeviceSecret('push:tokens'), true);
  assert.equal(isDeviceSecret('backup:bt-1'), true);
  assert.equal(isDeviceSecret('endpoint:e'), false);
});

test("an archive that holds push tokens anyway (made elsewhere) doesn't bring them in", async () => {
  const a = await device();
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'test' });
  const entries = await readZip(blob);
  const manifest = JSON.parse(text(/** @type {Uint8Array} */ (entries.get(MANIFEST_NAME))));
  const body = utf8(JSON.stringify([{ id: 'push:tokens', value: { 'x.y': 'cancel-token-from-elsewhere-01' } }, { id: 'endpoint:y', value: 'sk-model-key-0002' }]));
  manifest.extras.push({ name: 'system/secrets.json', hash: await sha256Hex(body) });
  manifest.secrets = 'system/secrets.json';
  const zip = new ZipWriter();
  for (const [name, bytes] of entries) if (name !== MANIFEST_NAME) await zip.add(name, bytes);
  await zip.add('system/secrets.json', body);
  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest)));
  const b = await device();
  await importArchive(b.store, await openArchive(zip.finish()), { secrets: true });
  assert.deepEqual(await b.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['endpoint:y']);
});
