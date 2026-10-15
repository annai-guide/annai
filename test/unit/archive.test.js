import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, ME, SYS_SETTINGS } from '../../src/core/scopes.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, describeArchive, importArchive, archiveName, PRESETS, ArchiveError, NeedsPassphraseError, MANIFEST_NAME } from '../../src/core/archive.js';
import { PassphraseError } from '../../src/core/archive-crypto.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';

const FAST = 100_000;
const bytesOf = async (/** @type {Blob} */ b) => new Uint8Array(await b.arrayBuffer());

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  return { store, ws };
}

/** @param {Workspace} ws */
async function sampleTrip(ws) {
  const id = await createTrip(ws, { title: '京都 in spring', start: '2027-04-03', end: '2027-04-10' });
  await ws.write(id, '/notes/案内.md', 'first', { author: 'user' });
  await ws.write(id, '/notes/案内.md', 'second', { author: 'shiori' });
  await ws.write(id, '/plan/dinner.json', { id: 'dinner', title: 'Dinner', fixed: true }, { author: 'user' });
  await ws.write(id, '/files/photo.jpg', crypto.getRandomValues(new Uint8Array(4096)), { author: 'user' });
  return id;
}

/** @param {Workspace} ws @param {string} scope */
async function snapshot(ws, scope) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of await ws.list(scope)) out[f.path] = { type: f.type, author: f.author, hash: f.hash, created: f.created, modified: f.modified };
  return out;
}

test('a backup of everything restores onto an empty device, history included', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  await a.ws.write(ME, '/profile.md', '# Profile\n\n- What to call me: Yufei\n', { author: 'user' });
  await updateAppSettings(a.ws, { units: 'metric' });
  const { blob, manifest, filename } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  assert.match(filename, /^annai-backup-\d{4}-\d{2}-\d{2}\.annai\.zip$/);
  assert.equal(manifest.kind, 'everything');

  const b = await device();
  const opened = await openArchive(await bytesOf(blob));
  const desc = await describeArchive(b.store, opened);
  assert.deepEqual(desc.trips.map((t) => [t.title, t.existing]), [['京都 in spring', null]]);
  const result = await importArchive(b.store, opened, { me: 'replace', settings: 'replace' });
  assert.equal(result.trips.length, 1);
  const copy = result.trips[0];
  assert.deepEqual(await snapshot(b.ws, copy), await snapshot(a.ws, trip));
  assert.equal(await b.ws.readText(copy, '/notes/案内.md'), 'second');
  const history = await b.ws.history(copy, '/notes/案内.md');
  assert.equal(history.length, 2);
  await b.ws.restore(copy, '/notes/案内.md', history[0].new, { author: 'user' });
  assert.equal(await b.ws.readText(copy, '/notes/案内.md'), 'first');
  assert.match(await b.ws.readText(ME, '/profile.md'), /Yufei/);
  assert.equal((await readAppSettings(b.ws)).units, 'metric');
  const evA = await a.store.tx(['events'], 'readonly', (t) => t.listEvents(trip));
  const evB = await b.store.tx(['events'], 'readonly', (t) => t.listEvents(copy));
  // B's log: A's events with the same numbers, then the import, then the restore made above.
  assert.deepEqual(evB.slice(0, evA.length).map((e) => [e.seq, e.type, e.data]), evA.map((e) => [e.seq, e.type, e.data]));
  assert.deepEqual(evB.slice(evA.length).map((e) => e.type), ['import', 'file.write']);
});

test('the share preset leaves out memory and history', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['/files/photo.jpg', '/notes/案内.md', '/plan/dinner.json', '/trip.json']);
  assert.equal(manifest.blobs.length, 0);
  assert.equal(manifest.scopes[0].events, undefined);
  const b = await device();
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.equal(await b.ws.readText(r.trips[0], '/memory.md'), undefined);
  assert.deepEqual(await b.ws.history(r.trips[0], '/notes/案内.md'), []);
});

test('photos can be left out', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: { history: false, memory: true, photos: false }, app: '0.1.0' });
  assert.equal(manifest.files.some((f) => f.path === '/files/photo.jpg'), false);
});

test('encrypted exports need the passphrase', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, filename } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, passphrase: 'pine needle', iterations: FAST, app: '0.1.0' });
  assert.match(filename, /^annai-in-spring-\d{4}-\d{2}-\d{2}\.annai$/);
  const bytes = await bytesOf(blob);
  await assert.rejects(openArchive(bytes), NeedsPassphraseError);
  await assert.rejects(openArchive(bytes, 'wrong'), PassphraseError);
  const opened = await openArchive(bytes, 'pine needle');
  assert.equal(opened.manifest.encrypted, true);
});

test('a tampered entry is refused, and nothing is imported', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const entries = await readZip(await bytesOf(blob));
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name.endsWith('案内.md') ? utf8('evil') : bytes);
  const b = await device();
  await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /damaged/.test(e.message) && /案内\.md/.test(e.message));
  assert.deepEqual((await listTrips(b.store)).active, []);
});

test('an archive from a newer annai is refused', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const entries = await readZip(await bytesOf(blob));
  const manifest = JSON.parse(text(entries.get(MANIFEST_NAME)));
  manifest.format = 99;
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /newer version of annai/.test(e.message));
});

test('something that is not an annai file is refused', async () => {
  await assert.rejects(openArchive(utf8('hello')), ArchiveError);
  const z = new ZipWriter();
  await z.add('readme.txt', utf8('hi'));
  await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /isn't an annai file/.test(e.message));
});

test('"replace mine" archives the existing copy; "add as new" keeps both', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  const b = await device();
  const first = (await importArchive(b.store, await openArchive(bytes))).trips[0];
  const opened = await openArchive(bytes);
  const desc = await describeArchive(b.store, opened);
  assert.equal(desc.trips[0].existing, first);
  const r = await importArchive(b.store, opened, { trips: { [trip]: 'replace' } });
  assert.deepEqual(r.archived, [first]);
  const trips = await listTrips(b.store);
  assert.deepEqual(trips.active.map((s) => s.id), r.trips);
  assert.deepEqual(trips.archived.map((s) => s.id), [first]);
  const again = await importArchive(b.store, await openArchive(bytes), { trips: { [trip]: 'new' } });
  assert.equal((await listTrips(b.store)).active.length, 2);
  assert.equal(again.archived.length, 0);
});

test('API keys travel only in encrypted backups of everything, and only when chosen', async () => {
  const a = await device();
  await a.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('openrouter', 'sk-or-1'));
  await assert.rejects(exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, secrets: true, app: '0.1.0' }), ArchiveError);
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, secrets: true, passphrase: 'p', iterations: FAST, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  const b = await device();
  const without = await importArchive(b.store, await openArchive(bytes, 'p'));
  assert.equal(without.secrets, 0);
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), undefined);
  const withKeys = await importArchive(b.store, await openArchive(bytes, 'p'), { secrets: true });
  assert.equal(withKeys.secrets, 1);
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), 'sk-or-1');
});

test('a 5 MB photo round-trips byte for byte', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Big Sur' });
  const photo = new Uint8Array(5 * 1024 * 1024);
  for (let i = 0; i < photo.length; i += 65536) crypto.getRandomValues(photo.subarray(i, i + 65536));
  await a.ws.write(trip, '/files/bixby.jpg', photo, { author: 'user' });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const b = await device();
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.deepEqual((await b.ws.read(r.trips[0], '/files/bixby.jpg'))?.bytes, photo);
});

test('Japanese names round-trip and file names stay readable', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: '京都' });
  await a.ws.write(trip, '/notes/伏見稲荷.md', '千本鳥居', { author: 'user' });
  const { blob, filename } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  assert.match(filename, /^annai-trip-/);
  const b = await device();
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.equal(await b.ws.readText(r.trips[0], '/notes/伏見稲荷.md'), '千本鳥居');
  assert.equal(archiveName({ kind: 'trip', title: 'Big Sur · Thanksgiving', encrypted: false, now: Date.UTC(2026, 10, 30) }), 'annai-big-sur-thanksgiving-2026-11-30.annai.zip');
});

test('settings are kept unless the user chooses to replace them', async () => {
  const a = await device();
  await updateAppSettings(a.ws, { units: 'imperial' });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  await updateAppSettings(b.ws, { units: 'metric' });
  await importArchive(b.store, await openArchive(await bytesOf(blob)));
  assert.equal((await readAppSettings(b.ws)).units, 'metric');
  assert.equal((await b.ws.list(SYS_SETTINGS)).length, 1);
});
