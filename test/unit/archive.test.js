import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, StorageFullError } from '../../src/core/workspace.js';
import { sha256Hex } from '../../src/core/hash.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, ME, SYS_SETTINGS } from '../../src/core/scopes.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, describeArchive, importArchive, archiveName, PRESETS, ArchiveError, NeedsPassphraseError, MANIFEST_NAME } from '../../src/core/archive.js';
import { PassphraseError } from '../../src/core/archive-crypto.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';
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
  assert.match(filename, /^annai-京都-in-spring-\d{4}-\d{2}-\d{2}\.annai$/);
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
  assert.match(filename, /^annai-京都-/);
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

test('imported plugins arrive switched off, so running their code is always an explicit choice', async () => {
  const a = await device();
  await a.ws.write('sys:plugins', '/hello/index.js', 'export function activate() {}', { author: 'system' });
  await a.ws.write('sys:plugins', '/installed.json', { hello: { version: '1.0.0', name: 'Hello', enabled: true, installed: 1, source: 'x' } }, { author: 'system' });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const b = await device();
  await importArchive(b.store, await openArchive(await bytesOf(blob)), { plugins: 'replace' });
  assert.equal((await b.ws.readJSON('sys:plugins', '/installed.json')).hello.enabled, false);
  assert.equal(await b.ws.readText('sys:plugins', '/hello/index.js'), 'export function activate() {}');
});

test('imported API keys never replace keys already on this device', async () => {
  const a = await device();
  await a.store.tx(['secrets'], 'readwrite', async (t) => { await t.putSecret('openrouter', 'theirs'); await t.putSecret('groq', 'gk-1'); });
  const { blob } = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, secrets: true, passphrase: 'p', iterations: FAST, app: '0.1.0' });
  const b = await device();
  await b.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('openrouter', 'mine'));
  const r = await importArchive(b.store, await openArchive(await bytesOf(blob), 'p'), { secrets: true });
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
    await assert.rejects(openArchive(await bytesOf(z.finish())), (e) => e instanceof ArchiveError && /unsafe file path/.test(e.message), bad);
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
  const one = (await importArchive(b.store, await openArchive(bytes))).trips[0];
  const two = (await importArchive(b.store, await openArchive(bytes))).trips[0];
  const r = await importArchive(b.store, await openArchive(bytes), { trips: { [trip]: 'replace' } });
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
    await assert.rejects(openArchive(tampered), (e) => e instanceof ArchiveError && /damaged/.test(e.message), line);
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
    await assert.rejects(openArchive(await rewrite(blob, edit)), (e) => e instanceof ArchiveError && /damaged/.test(e.message), String(edit));
  }
  await assert.rejects(openArchive(await rewrite(blob, (m) => { m.scopes[0].record.format = 2; })), (e) => e instanceof ArchiveError && /newer version of annai/.test(e.message));
});

test('export file names keep titles in any script', () => {
  const now = Date.UTC(2026, 10, 30);
  const name = (/** @type {string} */ title) => archiveName({ kind: 'trip', title, encrypted: false, now });
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
  await assert.rejects(importArchive(b.store, await openArchive(await bytesOf(blob))), StorageFullError);
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
    const r = await importArchive(b.store, await openArchive(file, passphrase));
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
  await assert.rejects(importArchive(b.store, await openArchive(await bytesOf(blob))), StorageFullError);
  b.state.room = Infinity;
  for (const h of hashes) assert.equal(await has(h), before.has(h), h);
  assert.deepEqual((await listTrips(b.store)).active, []);
});
