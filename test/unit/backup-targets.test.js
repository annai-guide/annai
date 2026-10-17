import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, NotFoundError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS_DEVICE, FORMAT } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS, MANIFEST_NAME } from '../../src/core/archive.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8, text } from '../../src/core/bytes.js';
import { listTargets, getTarget, addTarget, setTarget, removeTarget, deviceId, targetSecret, setTargetSecret, secretId, BACKUP_SECRET_PREFIX } from '../../src/core/backup-targets.js';

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  return { store, ws };
}

test('where this device backs up lives in its own scope, which no export carries (spec §12.4)', async () => {
  const a = await device();
  await createTrip(a.ws, { title: 'Big Sur' });
  const id = await addTarget(a.ws, { type: 'github', name: 'GitHub', config: { repo: 'me/annai-backup' } });
  await setTargetSecret(a.store, id, { token: 'ghp_never_in_an_archive_0001' });
  const dev = await deviceId(a.ws);
  assert.match(dev, /^[0-9a-z]{10,}$/);
  assert.equal(await deviceId(a.ws), dev);
  assert.deepEqual((await listTargets(a.ws)).map((t) => [t.id, t.type, t.name, t.config.repo, t.auto, t.mobileData, t.checked, t.last, t.hold]),
    [[id, 'github', 'GitHub', 'me/annai-backup', 'changes', false, null, null, null]]);
  assert.equal((await a.store.tx(['scopes'], 'readonly', (t) => t.getScope(SYS_DEVICE)))?.title, 'This device');

  const { blob, manifest } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'test' });
  assert.equal(manifest.scopes.some((s) => s.record.id === SYS_DEVICE), false);
  assert.equal(manifest.files.some((f) => f.scope === SYS_DEVICE), false);
  for (const [name, bytes] of await readZip(blob)) {
    assert.equal(text(bytes).includes(dev), false, `${name} names this device`);
    assert.equal(text(bytes).includes('me/annai-backup'), false, `${name} names the place`);
    assert.equal(text(bytes).includes('ghp_never_in_an_archive_0001'), false, `${name} holds the token`);
  }
});

test("an archive that holds another device's own scope never brings it in", async () => {
  const a = await device();
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'test' });
  // What another device's own scope would look like in a hand-made archive.
  const entries = await readZip(blob);
  const manifest = JSON.parse(text(/** @type {Uint8Array} */ (entries.get(MANIFEST_NAME))));
  const body = utf8(JSON.stringify({ device: 'someone-else', targets: { 'bt-x': { id: 'bt-x', type: 'github' } } }));
  manifest.scopes.push({ dir: 'system/device', record: { id: SYS_DEVICE, kind: 'sys', title: 'This device', status: 'active', created: 1, updated: 1, format: FORMAT } });
  manifest.files.push({ name: 'system/device/backups.json', scope: SYS_DEVICE, path: '/backups.json', hash: await sha256Hex(body), size: body.byteLength, type: 'application/json', author: 'system', created: 1, modified: 1 });
  const zip = new ZipWriter();
  for (const [name, bytes] of entries) if (name !== MANIFEST_NAME) await zip.add(name, bytes);
  await zip.add('system/device/backups.json', body);
  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest)));

  const b = await device();
  await importArchive(b.store, await openArchive(zip.finish()), { me: 'replace', settings: 'replace', plugins: 'replace' });
  assert.equal(await b.store.tx(['scopes'], 'readonly', (t) => t.getScope(SYS_DEVICE)), undefined);
  assert.deepEqual(await listTargets(b.ws), []);
  assert.notEqual(await deviceId(b.ws), 'someone-else');
});

test('a place keeps its settings and its last backup apart, changed one at a time; removing it forgets its secret', async () => {
  const a = await device();
  const id = await addTarget(a.ws, { type: 'github', name: 'GitHub' });
  await Promise.all([
    setTarget(a.ws, id, { config: { repo: 'me/x' } }),
    setTarget(a.ws, id, { last: { id: 'c1', at: 5, seqs: { me: 3 }, bytes: 10 } }),
    setTarget(a.ws, id, { auto: 'daily' }),
  ]);
  const t = await getTarget(a.ws, id);
  assert.deepEqual([t?.config.repo, t?.last?.id, t?.auto], ['me/x', 'c1', 'daily']);
  await setTargetSecret(a.store, id, { token: 'abc12345678' });
  await setTargetSecret(a.store, id, { password: 'hunter22hunter' });
  assert.deepEqual(await targetSecret(a.store, id), { token: 'abc12345678', password: 'hunter22hunter' });
  await setTargetSecret(a.store, id, { password: '' });
  assert.deepEqual(await targetSecret(a.store, id), { token: 'abc12345678' });
  assert.equal(secretId(id), `backup:${id}`);
  await assert.rejects(setTarget(a.ws, 'bt-nope', { auto: 'off' }), NotFoundError);
  await removeTarget(a.ws, id);
  assert.equal(await getTarget(a.ws, id), undefined);
  assert.deepEqual(await targetSecret(a.store, id), {});
  assert.deepEqual(await a.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), []);
});

test("an archive's API keys never bring in a backup place's sign-in, even one an older annai put there", async () => {
  const a = await device();
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'test' });
  const entries = await readZip(blob);
  const manifest = JSON.parse(text(/** @type {Uint8Array} */ (entries.get(MANIFEST_NAME))));
  const body = utf8(JSON.stringify([{ id: 'backup:bt-old', value: { token: 'ghp_from_another_device_01' } }, { id: 'endpoint:y', value: 'sk-model-key-0002' }]));
  manifest.extras.push({ name: 'system/secrets.json', hash: await sha256Hex(body) });
  manifest.secrets = 'system/secrets.json';
  const zip = new ZipWriter();
  for (const [name, bytes] of entries) if (name !== MANIFEST_NAME) await zip.add(name, bytes);
  await zip.add('system/secrets.json', body);
  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest)));
  const b = await device();
  const result = await importArchive(b.store, await openArchive(zip.finish()), { secrets: true });
  assert.equal(result.secrets, 1);
  assert.deepEqual(await b.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), ['endpoint:y']);
  assert.equal(BACKUP_SECRET_PREFIX, 'backup:');
  assert.equal(secretId('bt-1'), 'backup:bt-1');
});
