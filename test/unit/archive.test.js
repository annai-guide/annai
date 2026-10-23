import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, StorageFullError } from '../../src/core/workspace.js';
import { sha256Hex } from '../../src/core/hash.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, setTripStatus, ME, SYS_SETTINGS, recordBackup, backupState, removeTrip } from '../../src/core/scopes.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, peekArchive, describeArchive, importArchive, archiveName, isFullBackup, PRESETS, ArchiveError, NeedsPassphraseError, MANIFEST_NAME } from '../../src/core/archive.js';
import { PassphraseError, decrypt } from '../../src/core/archive-crypto.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';
import { readFile } from 'node:fs/promises';
import { readPhotoMeta, sniffImageType } from '../../src/core/photo-meta.js';
import { PiecesOnly } from './pieces.js';

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
  const opened = await peekArchive(await bytesOf(blob));
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
  const r = await importArchive(b.store, await peekArchive(await bytesOf(blob)));
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
  assert.match(filename, /^annai-京都-in-spring-\d{4}-\d{2}-\d{2}\.annai$/);
  const bytes = await bytesOf(blob);
  await assert.rejects(peekArchive(bytes), NeedsPassphraseError);
  await assert.rejects(peekArchive(bytes, 'wrong'), PassphraseError);
  const opened = await peekArchive(bytes, 'pine needle');
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
  await assert.rejects(importArchive(b.store, await peekArchive(await bytesOf(z.finish()))), (e) => e instanceof ArchiveError && /damaged/.test(e.message) && /案内\.md/.test(e.message));
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
  await assert.rejects(peekArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /newer version of annai/.test(e.message));
});

test('something that is not an annai file is refused', async () => {
  await assert.rejects(peekArchive(utf8('hello')), ArchiveError);
  const z = new ZipWriter();
  await z.add('readme.txt', utf8('hi'));
  await assert.rejects(peekArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /isn't an annai file/.test(e.message));
});

test('"replace mine" archives the existing copy; "add as new" keeps both', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  const b = await device();
  const first = (await importArchive(b.store, await peekArchive(bytes))).trips[0];
  const opened = await peekArchive(bytes);
  const desc = await describeArchive(b.store, opened);
  assert.equal(desc.trips[0].existing, first);
  const r = await importArchive(b.store, opened, { trips: { [trip]: 'replace' } });
  assert.deepEqual(r.archived, [first]);
  const trips = await listTrips(b.store);
  assert.deepEqual(trips.active.map((s) => s.id), r.trips);
  assert.deepEqual(trips.archived.map((s) => s.id), [first]);
  const again = await importArchive(b.store, await peekArchive(bytes), { trips: { [trip]: 'new' } });
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
  const without = await importArchive(b.store, await peekArchive(bytes, 'p'));
  assert.equal(without.secrets, 0);
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), undefined);
  const withKeys = await importArchive(b.store, await peekArchive(bytes, 'p'), { secrets: true });
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
  const r = await importArchive(b.store, await peekArchive(await bytesOf(blob)));
  assert.deepEqual((await b.ws.read(r.trips[0], '/files/bixby.jpg'))?.bytes, photo);
});

test('Japanese names round-trip and file names stay readable', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: '京都' });
  await a.ws.write(trip, '/notes/伏見稲荷.md', '千本鳥居', { author: 'user' });
  const { blob, filename } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  assert.match(filename, /^annai-京都-/);
  const b = await device();
  const r = await importArchive(b.store, await peekArchive(await bytesOf(blob)));
  assert.equal(await b.ws.readText(r.trips[0], '/notes/伏見稲荷.md'), '千本鳥居');
  assert.equal(archiveName({ kind: 'trip', title: 'Big Sur · Thanksgiving', encrypted: false, now: Date.UTC(2026, 10, 30), tz: 'UTC' }), 'annai-big-sur-thanksgiving-2026-11-30.annai.zip');
});

test('settings are kept unless the user chooses to replace them', async () => {
  const a = await device();
  await updateAppSettings(a.ws, { units: 'imperial' });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  await updateAppSettings(b.ws, { units: 'metric' });
  await importArchive(b.store, await peekArchive(await bytesOf(blob)));
  assert.equal((await readAppSettings(b.ws)).units, 'metric');
  assert.equal((await b.ws.list(SYS_SETTINGS)).length, 1);
});

test('the languages you speak are in the settings a backup carries (phase 2)', async () => {
  const a = await device();
  await updateAppSettings(a.ws, { languages: { spoken: ['en', 'zh', 'ja'], answer: 'follow' } });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  await importArchive(b.store, await peekArchive(await bytesOf(blob)), { settings: 'replace' });
  assert.deepEqual((await readAppSettings(b.ws)).languages, { spoken: ['en', 'zh', 'ja'], answer: 'follow' });
});

test('imported plugins arrive switched off, so running their code is always an explicit choice', async () => {
  const a = await device();
  await a.ws.write('sys:plugins', '/hello/index.js', 'export function activate() {}', { author: 'system' });
  await a.ws.write('sys:plugins', '/installed.json', { hello: { version: '1.0.0', name: 'Hello', enabled: true, installed: 1, source: 'x' } }, { author: 'system' });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  await importArchive(b.store, await peekArchive(await bytesOf(blob)), { plugins: 'replace' });
  assert.equal((await b.ws.readJSON('sys:plugins', '/installed.json')).hello.enabled, false);
  assert.equal(await b.ws.readText('sys:plugins', '/hello/index.js'), 'export function activate() {}');
});

test('imported API keys never replace keys already on this device', async () => {
  const a = await device();
  await a.store.tx(['secrets'], 'readwrite', async (t) => { await t.putSecret('openrouter', 'theirs'); await t.putSecret('groq', 'gk-1'); });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, secrets: true, passphrase: 'p', iterations: FAST, app: '0.1.0' });
  const b = await device();
  await b.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('openrouter', 'mine'));
  const r = await importArchive(b.store, await peekArchive(await bytesOf(blob), 'p'), { secrets: true });
  assert.equal(r.secrets, 1);
  assert.deepEqual(r.keptSecrets, ['openrouter']);
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('openrouter')), 'mine');
  assert.equal(await b.store.tx(['secrets'], 'readonly', (t) => t.getSecret('groq')), 'gk-1');
});

test('archives with unsafe file paths are refused', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const entries = await readZip(await bytesOf(blob));
  for (const bad of ['/.annai/events.jsonl', '/notes/../../me/profile.md', 'no-slash.md']) {
    const manifest = JSON.parse(text(entries.get(MANIFEST_NAME)));
    manifest.files[0].path = bad;
    const z = new ZipWriter();
    for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
    await assert.rejects(peekArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /unsafe file path/.test(e.message), bad);
  }
});

/**
 * Re-zips an archive after edit() changes its manifest or entries. Fingerprints are
 * recomputed, so the edit is the only thing wrong with the result.
 * @param {Blob} blob @param {(manifest: any, entries: Map<string, Uint8Array>) => void} edit
 */
async function rewrite(blob, edit) {
  const entries = await readZip(await bytesOf(blob));
  const manifest = JSON.parse(text(/** @type {Uint8Array} */ (entries.get(MANIFEST_NAME))));
  edit(manifest, entries);
  for (const x of [...manifest.files, ...manifest.blobs, ...manifest.extras]) {
    const b = entries.get(x.name);
    if (b) x.hash = await sha256Hex(b);
  }
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === MANIFEST_NAME ? utf8(JSON.stringify(manifest)) : bytes);
  return bytesOf(z.finish());
}

/** A store whose writes can be made to fail as if the device were full: now (full), or after room more blobs. */
function fillableDevice() {
  const inner = createMemoryStore();
  const state = { full: false, room: Infinity };
  /** @type {import('../../src/core/types.js').Store} */
  const store = {
    close() {},
    tx(stores, mode, fn) {
      return inner.tx(stores, mode, (t) => fn({ ...t, putBlob: async (rec) => {
        if (state.full || state.room-- <= 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return t.putBlob(rec);
      } }));
    },
  };
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  return { store, ws, state };
}

test('"replace mine" archives every active copy of the trip, not just the first', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  const b = await device();
  const one = (await importArchive(b.store, await peekArchive(bytes))).trips[0];
  const two = (await importArchive(b.store, await peekArchive(bytes))).trips[0];
  const r = await importArchive(b.store, await peekArchive(bytes), { trips: { [trip]: 'replace' } });
  assert.deepEqual(r.archived.slice().sort(), [one, two].sort());
  assert.deepEqual((await listTrips(b.store)).active.map((s) => s.id), r.trips);
});

test('an archive whose history log is damaged is refused before anything is imported', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const bad = [
    'not json',
    '{"seq":"one","ts":1,"type":"file.write","actor":"user"}',
    '{"seq":0,"ts":1,"type":"file.write","actor":"user"}',
    '{"seq":99,"type":"file.write","actor":"user"}',
    '{"seq":99,"ts":1,"actor":"user"}',
    '{"seq":1,"ts":1,"type":"file.write","actor":"user"}', // a second seq 1 would silently replace the first
  ];
  for (const line of bad) {
    const tampered = await rewrite(blob, (m, entries) => {
      const name = m.scopes[0].events;
      entries.set(name, utf8(text(/** @type {Uint8Array} */ (entries.get(name))) + line + '\n'));
    });
    await assert.rejects(importArchive((await device()).store, await peekArchive(tampered)), (e) => e instanceof ArchiveError && /damaged/.test(e.message), line);
  }
});

test('an archive that describes its contents wrongly is refused', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  /** @type {((m: any) => void)[]} */
  const edits = [
    (m) => { delete m.scopes[0].record.title; },
    (m) => { m.scopes[0].record.kind = 'admin'; },
    (m) => { m.scopes[0].record.updated = 'yesterday'; },
    (m) => { m.files[0].size = 'big'; },
    (m) => { m.files[0].type = 7; },
    (m) => { m.files[0].created = null; },
  ];
  for (const edit of edits) {
    await assert.rejects(peekArchive(await rewrite(blob, edit)), (e) => e instanceof ArchiveError && /damaged/.test(e.message), String(edit));
  }
  await assert.rejects(peekArchive(await rewrite(blob, (m) => { m.scopes[0].record.format = 2; })), (e) => e instanceof ArchiveError && /newer version of annai/.test(e.message));
});

test('export file names keep titles in any script', () => {
  const now = Date.UTC(2026, 10, 30);
  const name = (/** @type {string} */ title) => archiveName({ kind: 'trip', title, encrypted: false, now, tz: 'UTC' });
  assert.equal(name('京都'), 'annai-京都-2026-11-30.annai.zip');
  assert.equal(name('北海道・冬'), 'annai-北海道-冬-2026-11-30.annai.zip');
  assert.equal(name('ながの'), 'annai-ながの-2026-11-30.annai.zip');
  assert.equal(name('Café Été'), 'annai-cafe-ete-2026-11-30.annai.zip');
  assert.equal(name('नई दिल्ली'), 'annai-नई-दिल्ली-2026-11-30.annai.zip');
  assert.equal(name('!!!'), 'annai-trip-2026-11-30.annai.zip');
  assert.equal(name('a'.repeat(200)).length, 'annai--2026-11-30.annai.zip'.length + 60);
});

test('importing onto a full device says storage is full and imports nothing', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const b = fillableDevice();
  await ensureBaseScopes(b.ws);
  b.state.full = true;
  await assert.rejects(importArchive(b.store, await peekArchive(await bytesOf(blob))), StorageFullError);
  b.state.full = false;
  assert.deepEqual((await listTrips(b.store)).active, []);
});

/** @param {number} n */
function noise(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
  return b;
}

test('opening and importing a backup reads the file in pieces, never whole (spec §12.1)', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Big Sur' });
  for (let i = 0; i < 4; i++) await a.ws.write(trip, `/files/p${i}.jpg`, noise(1024 * 1024), { author: 'user' });
  for (const passphrase of [undefined, 'p']) {
    const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', passphrase, iterations: FAST });
    const file = new PiecesOnly([blob]);
    const b = await device();
    const r = await importArchive(b.store, await peekArchive(file, passphrase));
    assert.deepEqual((await b.ws.read(r.trips[0], '/files/p3.jpg'))?.bytes, (await a.ws.read(trip, '/files/p3.jpg'))?.bytes);
    assert.ok(file.largest < 2 * 1024 * 1024, `read ${file.largest} of ${file.size} bytes at once`);
  }
});

test('an import that runs out of space partway leaves none of its content behind', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const b = fillableDevice();
  await ensureBaseScopes(b.ws);
  const has = (/** @type {string} */ h) => b.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(h));
  const hashes = [...new Set([...manifest.files, ...manifest.blobs].map((x) => x.hash))];
  const before = new Set((await Promise.all(hashes.map(async (h) => [h, await has(h)]))).filter(([, x]) => x).map(([h]) => h));
  b.state.room = 2;
  await assert.rejects(importArchive(b.store, await peekArchive(await bytesOf(blob))), StorageFullError);
  b.state.room = Infinity;
  for (const h of hashes) assert.equal(await has(h), before.has(h), h);
  assert.deepEqual((await listTrips(b.store)).active, []);
});

test('an import that is cancelled partway, or just before its last step, imports nothing and leaves none of its content behind', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const hashes = [...new Set([...manifest.files, ...manifest.blobs].map((x) => x.hash))];
  for (const stopAt of [2, hashes.length]) {
    const b = await device();
    const has = (/** @type {string} */ h) => b.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(h));
    const stop = new AbortController();
    await assert.rejects(importArchive(b.store, await peekArchive(await bytesOf(blob)), {
      signal: stop.signal,
      onProgress: (done) => { if (done === stopAt) stop.abort(); },
    }), (e) => /** @type {any} */ (e).name === 'AbortError');
    for (const h of hashes) assert.equal(await has(h), false, `after stopping at ${stopAt}: ${h} was removed`);
    assert.deepEqual((await listTrips(b.store)).active, []);
  }
});

test('opening a file that says it unpacks to gigabytes is refused before anything is unpacked (zip bomb)', async () => {
  const z = new ZipWriter();
  await z.add('trips/x/files/zeros.bin', new Uint8Array(1024));
  const b = await bytesOf(z.finish());
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  v.setUint32(22, 1000 * 1024 * 1024, true); // the local header's uncompressed size
  const cd = v.getUint32(b.length - 22 + 16, true);
  v.setUint32(cd + 24, 1000 * 1024 * 1024, true); // and the index's
  const file = new PiecesOnly([b]);
  await assert.rejects(peekArchive(file), (e) => e instanceof ArchiveError && /zip bomb/.test(e.message));
});

/** @param {string} name */
const photoFixture = async (name) => new Uint8Array(await readFile(new URL(`../fixtures/photos/${name}`, import.meta.url)));
const nepenthe = { lat: 36.2219, lng: -121.7598 };

test('photos keep their metadata through a backup', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Big Sur' });
  const meta = { width: 48, height: 64, taken: '2026-11-26T19:04:12-08:00', place: nepenthe };
  await a.ws.write(trip, '/files/2026-11-26-1904.webp', await photoFixture('portrait.webp'), { author: 'user', type: 'image/webp', meta });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  const r = await importArchive(b.store, await peekArchive(blob));
  assert.deepEqual((await b.ws.read(r.trips[0], '/files/2026-11-26-1904.webp'))?.entry.meta, meta);
});

/**
 * A trip with four kinds of photo: a kept original JPEG, an ingest encoding, an old upload with
 * no metadata (and an older version that still has EXIF), and a kept HEIC original.
 */
async function photoTrip() {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Big Sur' });
  const taken = '2026-11-26T12:30:00-08:00';
  const put = (/** @type {string} */ path, /** @type {Uint8Array} */ bytes, /** @type {string} */ type, /** @type {any} */ meta) =>
    a.ws.write(trip, path, bytes, { author: 'user', type, ...(meta ? { meta } : {}) });
  await put('/files/kept.jpg', await photoFixture('upright.jpg'), 'image/jpeg', { width: 64, height: 48, taken, place: nepenthe, original: true });
  await put('/files/encoded.jpg', await photoFixture('plain.jpg'), 'image/jpeg', { width: 64, height: 48, taken, place: nepenthe });
  await put('/files/old.jpg', await photoFixture('upright.jpg'), 'image/jpeg', null);
  await put('/files/old.jpg', await photoFixture('upside-down.jpg'), 'image/jpeg', null);
  await put('/files/kept.heic', await photoFixture('portrait.heic'), 'image/heic', { width: 48, height: 64, taken, place: nepenthe, original: true });
  return { a, trip };
}

/** Encodes JPEG originals (to plain.jpg's bytes); can't read HEIC, like Chrome. */
const shareConvert = async (/** @type {{ type: string }} */ file) =>
  (file.type === 'image/jpeg' ? { bytes: await photoFixture('plain.jpg'), type: 'image/jpeg', width: 64, height: 48 } : null);

test('a Share without locations carries none: not in metadata, not in the photos, not in older versions', async () => {
  const { a, trip } = await photoTrip();
  const { blob, manifest, skipped } = await exportArchive(a.store, {
    kind: 'trip', scopes: [trip], include: { ...PRESETS.share, history: true }, app: '0.1.0',
    share: { places: false, convert: shareConvert },
  });
  assert.deepEqual(skipped, ['/files/kept.heic']); // can't be converted or stripped here, and it says where it was taken
  const entries = await readZip(await bytesOf(blob));
  const photos = manifest.files.filter((f) => f.type.startsWith('image/'));
  assert.deepEqual(photos.map((f) => f.path).sort(), ['/files/encoded.jpg', '/files/kept.jpg', '/files/old.jpg']);
  for (const f of photos) {
    assert.equal(f.meta?.place, undefined, f.path);
    assert.equal(f.meta?.original, undefined, f.path);
    assert.equal(readPhotoMeta(/** @type {Uint8Array} */ (entries.get(f.name))).place, undefined, f.path);
  }
  assert.ok(manifest.blobs.every((b) => !b.type.startsWith('image/')), 'older versions of photos are left out');
  const b = await device();
  assert.equal((await importArchive(b.store, await peekArchive(blob))).trips.length, 1);
});

test('with locations included, a Share still encodes kept originals and keeps their place beside them', async () => {
  const { a, trip } = await photoTrip();
  const { blob, manifest, skipped } = await exportArchive(a.store, {
    kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: true, convert: shareConvert },
  });
  assert.deepEqual(skipped, []);
  const kept = manifest.files.find((f) => f.path === '/files/kept.jpg');
  assert.deepEqual(kept?.meta, { width: 64, height: 48, taken: '2026-11-26T12:30:00-08:00', place: nepenthe });
  const entries = await readZip(await bytesOf(blob));
  assert.deepEqual(entries.get(/** @type {string} */ (kept?.name)), await photoFixture('plain.jpg'));
  assert.equal(manifest.files.find((f) => f.path === '/files/kept.heic')?.meta?.original, true); // couldn't be encoded here, so it goes as taken
});

test('an archive with malformed photo metadata is refused', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  await a.ws.write(trip, '/files/p.webp', await photoFixture('portrait.webp'), { author: 'user', type: 'image/webp', meta: { width: 64, height: 48, place: nepenthe } });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  for (const edit of [(/** @type {any} */ m) => { m.files.find((/** @type {any} */ f) => f.meta).meta.place.lat = 200; }, (/** @type {any} */ m) => { m.files.find((/** @type {any} */ f) => f.meta).meta.script = 'x'; }]) {
    await assert.rejects(peekArchive(await rewrite(blob, edit)), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  }
});

test('a Share without locations leaves out a photo it can neither encode nor strip, even when no location shows', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  // An upload from before photos had metadata: a PNG, which can't be stripped, and this browser can't encode it.
  await a.ws.write(trip, '/files/old.png', await photoFixture('screenshot.png'), { author: 'user', type: 'image/png' });
  const { manifest, skipped } = await exportArchive(a.store, {
    kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: false, convert: async () => null },
  });
  assert.deepEqual(skipped, ['/files/old.png']);
  assert.equal(manifest.files.some((f) => f.path === '/files/old.png'), false);
});

test('a Share without locations trusts no metadata it was given: a photo is cleaned or left out', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  // A PNG with its location in XMP, which the reader doesn't know, and metadata (say, from someone's archive) that says nothing about being an original.
  const png = await photoFixture('screenshot.png');
  const xmp = utf8('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><exif:GPSLatitude>36,13.31N</exif:GPSLatitude></x:xmpmeta>');
  const chunk = new Uint8Array(12 + xmp.length);
  new DataView(chunk.buffer).setUint32(0, xmp.length);
  chunk.set(utf8('iTXt'), 4);
  chunk.set(xmp, 8);
  const tagged = new Uint8Array([...png.subarray(0, 33), ...chunk, ...png.subarray(33)]); // after IHDR (8 + 25 bytes)
  await a.ws.write(trip, '/files/map.png', tagged, { author: 'user', type: 'image/png', meta: { width: 64, height: 48 } });
  const encodeAll = async () => ({ bytes: await photoFixture('plain.jpg'), type: 'image/jpeg', width: 64, height: 48 });
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: false, convert: encodeAll } });
  const entries = await readZip(await bytesOf(blob));
  const map = manifest.files.find((f) => f.path === '/files/map.png');
  assert.ok(map);
  assert.ok(!Buffer.from(/** @type {Uint8Array} */ (entries.get(map.name))).toString('latin1').includes('GPSLatitude'));
});

test('a Share without locations knows a photo by its bytes, whatever type it was saved as', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  await a.ws.write(trip, '/files/photo.bin', await photoFixture('upright.jpg'), { author: 'user', type: 'application/octet-stream' });
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: false } });
  const entries = await readZip(await bytesOf(blob));
  const photo = manifest.files.find((f) => f.path === '/files/photo.bin');
  assert.ok(photo);
  assert.equal(readPhotoMeta(/** @type {Uint8Array} */ (entries.get(photo.name))).place, undefined);
});

test('a Backup always opens again, even when a photo has details that make no sense', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  const taken = '2026-11-26T12:30:00-08:00';
  await a.ws.write(trip, '/files/odd.jpg', await photoFixture('plain.jpg'), { author: 'user', type: 'image/jpeg', meta: { width: 0, height: 48, taken } });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  const r = await importArchive(b.store, await peekArchive(blob));
  assert.deepEqual((await b.ws.read(r.trips[0], '/files/odd.jpg'))?.entry.meta, { height: 48, taken });
});

test('a GIF is no photo: a location-free Share carries it as it is', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  await a.ws.write(trip, '/files/wave.gif', gif, { author: 'user', type: 'image/gif' });
  const stillFrame = async () => ({ bytes: await photoFixture('plain.jpg'), type: 'image/jpeg', width: 64, height: 48 });
  const { blob, manifest, skipped } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: false, convert: stillFrame } });
  assert.deepEqual(skipped, []);
  const wave = manifest.files.find((f) => f.path === '/files/wave.gif');
  assert.equal(wave?.type, 'image/gif');
  assert.deepEqual((await readZip(await bytesOf(blob))).get(/** @type {string} */ (wave?.name)), gif);
});

test('older versions and the Photos tickbox know a photo by its bytes too', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  const put = async (/** @type {string} */ name) => a.ws.write(trip, '/files/photo.bin', await photoFixture(name), { author: 'user', type: 'application/octet-stream' });
  await put('upright.jpg'); // an older version, with its GPS
  await put('upside-down.jpg');
  const shared = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: { ...PRESETS.share, history: true }, app: '0.1.0', share: { places: false } });
  const entries = await readZip(await bytesOf(shared.blob));
  for (const b of shared.manifest.blobs) assert.equal(sniffImageType(/** @type {Uint8Array} */ (entries.get(b.name))), null, `${b.name} is a photo`);
  const noPhotos = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: { ...PRESETS.share, photos: false }, app: '0.1.0' });
  assert.equal(noPhotos.manifest.files.some((f) => f.path === '/files/photo.bin'), false);
});

test('a location-free Share cleans a GIF without stopping its animation, and leaves out an image it cannot clean', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  const xmp = utf8('<x:xmpmeta><exif:GPSLatitude>36,13.31N</exif:GPSLatitude></x:xmpmeta>');
  const tagged = new Uint8Array([...gif.subarray(0, 19), 0x21, 0xff, 11, ...utf8('NETSCAPE2.0'), 3, 1, 0, 0, 0, 0x21, 0xff, 11, ...utf8('XMP DataXMP'), xmp.length, ...xmp, 0, ...gif.subarray(19)]);
  await a.ws.write(trip, '/files/wave.gif', tagged, { author: 'user', type: 'image/gif' });
  await a.ws.write(trip, '/files/scan.tiff', utf8('II*\0 a TIFF, which can hold GPS too'), { author: 'user', type: 'image/tiff' });
  const { blob, manifest, skipped } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: false } });
  assert.deepEqual(skipped, ['/files/scan.tiff']);
  const wave = manifest.files.find((f) => f.path === '/files/wave.gif');
  const bytes = Buffer.from(/** @type {Uint8Array} */ ((await readZip(await bytesOf(blob))).get(/** @type {string} */ (wave?.name))));
  assert.ok(bytes.includes('NETSCAPE2.0'));
  assert.ok(!bytes.includes('GPSLatitude'));
  const withPlaces = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places: true } });
  assert.deepEqual(withPlaces.skipped, []);
});

test('a location-free Share leaves out raw photos and videos, whatever type they were saved as', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'T' });
  const octet = 'application/octet-stream';
  const qt = new Uint8Array([0, 0, 0, 20, ...utf8('ftypqt  '), 0, 0, 0, 0, ...utf8('qt  '), 0, 0, 0, 8, ...utf8('moov')]);
  await a.ws.write(trip, '/files/IMG_0001.DNG', utf8('II*\0 a ProRAW photo, GPS and all'), { author: 'user', type: octet });
  await a.ws.write(trip, '/files/IMG_0002.MOV', qt, { author: 'user', type: octet });
  await a.ws.write(trip, '/files/clip.mp4', utf8('not even sniffable'), { author: 'user', type: 'video/mp4' });
  const share = (/** @type {boolean} */ places) => exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0', share: { places } });
  assert.deepEqual((await share(false)).skipped.sort(), ['/files/IMG_0001.DNG', '/files/IMG_0002.MOV', '/files/clip.mp4']);
  assert.deepEqual((await share(true)).skipped, []);
});

test('an export reports the last history entry it holds for each scope, and only with history', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const last = await a.store.tx(['events'], 'readonly', (t) => t.lastSeq(trip));
  const full = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  assert.equal(full.seqs.get(trip), last);
  const bare = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: { ...PRESETS.backup, history: false }, app: '0.1.0' });
  assert.equal(bare.seqs.size, 0);
});

test('only a Backup with everything ticked counts as one (spec §4.9)', () => {
  assert.equal(isFullBackup(PRESETS.backup, false), true);
  assert.equal(isFullBackup(PRESETS.backup, true), false);
  assert.equal(isFullBackup(PRESETS.share, false), false);
  for (const k of ['history', 'memory', 'photos']) assert.equal(isFullBackup({ ...PRESETS.backup, [k]: false }, false), false);
});

test("a trip's backup record stays on the device that made it", async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const first = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  await recordBackup(a.store, first.seqs, 5000);
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  assert.equal('backup' in manifest.scopes[0].record, false);
  const b = await device();
  const opened = await peekArchive(await bytesOf(blob));
  opened.manifest.scopes[0].record.backup = { at: 1, seq: 999 }; // as an older or hand-made file might say
  const [copy] = (await importArchive(b.store, opened)).trips;
  assert.deepEqual(await backupState(b.store, copy), { at: null, changed: true });
});

/**
 * The store, except that `before` runs just ahead of an import's last transaction (the one that also writes keys).
 * @param {import('../../src/core/types.js').Store} store @param {() => Promise<unknown>} before
 * @returns {import('../../src/core/types.js').Store}
 */
function beforeCommit(store, before) {
  let done = false;
  return /** @type {any} */ ({
    close: () => store.close(),
    tx(/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) {
      if (done || mode !== 'readwrite' || !stores.includes('secrets')) return store.tx(stores, mode, fn);
      done = true;
      return before().then(() => store.tx(stores, mode, fn));
    },
  });
}

test('an import whose content is removed before it finishes imports nothing and can be run again', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const photo = (await a.ws.read(trip, '/files/photo.jpg'))?.bytes;
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const bytes = await bytesOf(blob);
  // Its content is already on this device, so the import stores none of it; then the trip holding it goes.
  const racing = beforeCommit(a.store, () => removeTrip(a.store, trip));
  await assert.rejects(importArchive(racing, await peekArchive(bytes)), (e) => e instanceof ArchiveError && /Import it again/.test(e.message));
  assert.deepEqual((await listTrips(a.store)).active, []);
  const [copy] = (await importArchive(a.store, await peekArchive(bytes))).trips;
  assert.deepEqual((await a.ws.read(copy, '/files/photo.jpg'))?.bytes, photo);
});

test('a failed import keeps content that history came to point at while it ran', async () => {
  const a = await device();
  const src = await sampleTrip(a.ws);
  const photo = /** @type {Uint8Array} */ ((await a.ws.read(src, '/files/photo.jpg'))?.bytes);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [src], include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  const trip = await createTrip(b.ws, { title: 'Here' });
  const failing = beforeCommit(b.store, async () => {
    // While the import runs, the same photo is written here and then replaced: only history points at it.
    await b.ws.write(trip, '/files/p.jpg', photo, { author: 'user' });
    await b.ws.write(trip, '/files/p.jpg', new Uint8Array([1]), { author: 'user' });
    throw new Error('the phone went to sleep');
  });
  await assert.rejects(importArchive(failing, await peekArchive(await bytesOf(blob))), /went to sleep/);
  const [first] = await b.ws.history(trip, '/files/p.jpg');
  await b.ws.restore(trip, '/files/p.jpg', /** @type {string} */ (first.new), { author: 'user' });
  assert.deepEqual((await b.ws.read(trip, '/files/p.jpg'))?.bytes, photo);
});

test('a Backup of everything records every trip it holds, archived ones too', async () => {
  const a = await device();
  const kept = await sampleTrip(a.ws);
  const old = await createTrip(a.ws, { title: 'Old trip' });
  await setTripStatus(a.store, old, 'archived');
  const { seqs } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  await recordBackup(a.store, seqs, 5000);
  assert.deepEqual(await backupState(a.store, kept), { at: 5000, changed: false });
  assert.deepEqual(await backupState(a.store, old), { at: 5000, changed: false });
});

// The emulator pass (m1c #5): an export at 17:10 on Oct 19 in California was named for Oct 20, the date in UTC.
test("an export's file name has the day where the phone is, not UTC's", () => {
  const at = Date.parse('2026-10-20T00:10:00Z'); // 17:10 on Oct 19 in California, 09:10 on Oct 20 in Tokyo
  assert.equal(archiveName({ kind: 'everything', encrypted: false, now: at, tz: 'America/Los_Angeles' }), 'annai-backup-2026-10-19.annai.zip');
  assert.equal(archiveName({ kind: 'trip', title: 'Big Sur', encrypted: true, now: at, tz: 'Asia/Tokyo' }), 'annai-big-sur-2026-10-20.annai');
});

test('peeking at an archive reads only its manifest, and the content is checked as it is imported', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const note = manifest.files.find((f) => f.path === '/notes/案内.md');
  assert.ok(note);
  // A changed note: the preview still draws, and the import refuses it without leaving anything behind.
  const entries = await readZip(await bytesOf(blob));
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, name === note.name ? utf8('changed') : bytes);
  const tampered = await bytesOf(z.finish());
  const peeked = await peekArchive(tampered);
  assert.equal((await describeArchive((await device()).store, peeked)).trips.length, 1);
  assert.equal(peeked.events.size, 0);
  const b = await device();
  await assert.rejects(importArchive(b.store, peeked), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  assert.equal((await listTrips(b.store)).active.length, 0);
  assert.equal((await b.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(note.hash))), false);
});

test('an import of a peeked archive brings the history in and reports how far it has read', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  /** @type {[number, number][]} */
  const seen = [];
  const r = await importArchive(b.store, await peekArchive(await bytesOf(blob)), { onProgress: (done, total) => seen.push([done, total]) });
  assert.equal(r.trips.length, 1);
  assert.ok(seen.length >= 2 && seen.at(-1)?.[0] === seen.at(-1)?.[1], JSON.stringify(seen));
  const same = await importArchive((await device()).store, await peekArchive(await bytesOf(blob)));
  assert.equal(same.trips.length, 1);
  const events = await b.store.tx(['events'], 'readonly', (t) => t.listEvents(r.trips[0]));
  assert.ok(events.some((e) => e.type === 'import') && events.length > 2);
});

/** An archive's entries with some changed, and the manifest's hashes left as they were: what a changed file looks like (valid CRC, stale hash). @param {Blob | Uint8Array} blob @param {(name: string, bytes: Uint8Array) => Uint8Array | null | undefined} edit */
async function rezip(blob, edit) {
  const entries = await readZip(blob instanceof Blob ? await bytesOf(blob) : blob);
  const z = new ZipWriter();
  for (const [name, bytes] of entries) await z.add(name, edit(name, bytes) ?? bytes);
  return bytesOf(z.finish());
}

test('an events log changed after export (a valid CRC, the manifest hash stale) is refused, and nothing is imported (review M1)', async () => {
  const a = await device();
  const id = await createTrip(a.ws, { title: 'T', start: '2027-04-03', end: '2027-04-10' });
  await a.ws.write(id, '/notes/a.md', 'first', { author: 'user' });
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [id], include: PRESETS.backup, app: '0.1.0' });
  const log = /** @type {any} */ (manifest.extras.find((x) => x.name.endsWith('events.jsonl')));
  const bad = await rezip(blob, (name, bytes) => (name === log.name ? utf8(`${text(bytes).split('\n').filter(Boolean).slice(0, 1).join('\n')}\n`) : null));
  const b = await device();
  await assert.rejects(importArchive(b.store, await peekArchive(bad)), (e) => e instanceof ArchiveError && /damaged/.test(e.message) && /events/.test(e.message));
  assert.deepEqual((await listTrips(b.store)).active, []);
});

test('a damaged installed.json is refused when the plugins are replaced, and the device keeps its plugin list; so is a changed keys file (review M1)', async () => {
  const a = await device();
  await a.ws.write('sys:plugins', '/installed.json', { hello: { version: '1.0.0', name: 'Hello', enabled: true, installed: 1, source: 'x' } }, { author: 'system' });
  const { blob, manifest } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const inst = /** @type {any} */ (manifest.files.find((f) => f.path === '/installed.json' && f.scope === 'sys:plugins'));
  const bad = await rezip(blob, (name, bytes) => (name === inst.name ? utf8(`${text(bytes)} `) : null));
  const b = await device();
  const mine = { mine: { version: '1.0.0', name: 'Mine', enabled: true, installed: 1, source: 'y' } };
  await b.ws.write('sys:plugins', '/installed.json', mine, { author: 'system' });
  await assert.rejects(importArchive(b.store, await peekArchive(bad), { plugins: 'replace' }), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  assert.deepEqual(await b.ws.readJSON('sys:plugins', '/installed.json'), mine);
  // A manifest that names a file of its own, damaged in the same way, is refused too: the hash is compared, not just the parse.
  const garbled = await rezip(blob, (name) => (name === inst.name ? utf8('not json') : null));
  await assert.rejects(importArchive(b.store, await peekArchive(garbled), { plugins: 'replace' }), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
  // Keys: the file changed after export.
  const c = await device();
  await c.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('llm:k', 'sk-1'));
  const withKeys = await exportArchive(c.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0', secrets: true, passphrase: 'pw', iterations: FAST });
  const opened = await peekArchive(withKeys.blob, 'pw');
  const key = /** @type {string} */ (withKeys.manifest.secrets);
  const keysBytes = await opened.zip.read(key);
  const plain = await rezip(await bytesOf(await decrypt(withKeys.blob, 'pw')), (name) => (name === key ? utf8(text(keysBytes).replace('sk-1', 'sk-2')) : null));
  const d = await device();
  await assert.rejects(importArchive(d.store, await peekArchive(plain), { secrets: true }), (e) => e instanceof ArchiveError && /damaged/.test(e.message));
});
