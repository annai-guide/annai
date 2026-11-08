import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace, StorageFullError } from '../../src/core/workspace.js';
import { sha256Hex } from '../../src/core/hash.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, listTrips, setTripStatus, ME, SYS_SETTINGS, SYS_WAITING, recordBackup, backupState, removeTrip } from '../../src/core/scopes.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, withoutPoints, peekArchive, describeArchive, importArchive, archiveName, isFullBackup, PRESETS, ArchiveError, NeedsPassphraseError, MANIFEST_NAME } from '../../src/core/archive.js';
import { PassphraseError, decrypt } from '../../src/core/archive-crypto.js';
import { ZipWriter, readZip } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';
import { readFile } from 'node:fs/promises';
import { mapsUrl } from '../../src/ui/cards.js';
import { expandLink } from '../../src/core/links.js';
import { readPhotoMeta, sniffImageType } from '../../src/core/photo-meta.js';
import { PiecesOnly } from './pieces.js';
import { logEvent } from '../../src/core/events.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { record, INLINE_MAX } from '../../src/core/agent/log.js';

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
  // Each carries the time it was written, which the Trace orders by.
  assert.ok(evA.every((e) => typeof e.at === 'number'));
  assert.deepEqual(evB.slice(0, evA.length).map((e) => e.at), evA.map((e) => e.at));
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
    '{"seq":99,"ts":1,"at":"yesterday","type":"file.write","actor":"user"}',
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

test("an everything backup carries the waiting space; restoring it adds the waiting files this device lacks (by content), and never removes or replaces this device's; a trip backup leaves it out", async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  await a.ws.write(SYS_WAITING, '/files/flight.pdf', utf8('a flight'), { author: 'user', type: 'application/pdf' });
  await a.ws.write(SYS_WAITING, '/files/hotel.png', utf8('a hotel'), { author: 'user', type: 'image/png' });
  await a.ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  const all = await exportArchive(a.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  assert.ok(all.manifest.files.some((f) => f.name === 'system/waiting/files/flight.pdf'));
  const b = await device();
  await importArchive(b.store, await peekArchive(await bytesOf(all.blob)));
  assert.equal(await b.ws.readText(SYS_WAITING, '/files/flight.pdf'), 'a flight');
  assert.equal(await b.ws.readText(SYS_WAITING, '/files/hotel.png'), 'a hotel');
  // A device with waiting files of its own keeps them: one with the same content isn't added twice, one at the same path stays.
  const c = await device();
  await c.ws.write(SYS_WAITING, '/files/hotel copy.png', utf8('a hotel'), { author: 'user', type: 'image/png' });
  await c.ws.write(SYS_WAITING, '/files/flight.pdf', utf8('my own flight'), { author: 'user', type: 'application/pdf' });
  await c.ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'My flight' }, { author: 'shiori' });
  await importArchive(c.store, await peekArchive(await bytesOf(all.blob)), { me: 'replace' });
  assert.deepEqual((await c.ws.list(SYS_WAITING, '/files/')).map((f) => f.path), ['/files/flight (2).pdf', '/files/flight.pdf', '/files/hotel copy.png']);
  assert.equal(await c.ws.readText(SYS_WAITING, '/files/flight.pdf'), 'my own flight');
  assert.equal(await c.ws.readText(SYS_WAITING, '/files/flight (2).pdf'), 'a flight');
  assert.deepEqual(await c.ws.readJSON(SYS_WAITING, '/names.json'), { '/files/flight.pdf': 'My flight' });
  const one = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  assert.equal(one.manifest.files.some((f) => f.name.startsWith('system/')), false);
});

test("a deleted photo's kept details say where it was taken only when the archive may: not in a Share without locations (which has no History), not with Photos unticked", async () => {
  const { a, trip } = await photoTrip();
  await a.ws.delete(trip, '/files/kept.jpg', { author: 'user' });
  /** @param {any} opts @returns {Promise<any>} the file.delete entry of kept.jpg */
  const deleted = async (opts) => {
    const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], app: '0.1.0', ...opts });
    if (!manifest.scopes[0].events) return undefined;
    const lines = text((await readZip(await bytesOf(blob))).get(/** @type {string} */ (manifest.scopes[0].events))).trim().split('\n').map((l) => JSON.parse(l));
    return lines.find((e) => e.type === 'file.delete' && e.data.path === '/files/kept.jpg');
  };
  const history = { ...PRESETS.share, history: true };
  assert.deepEqual((await deleted({ include: history, share: { places: true, convert: shareConvert } })).data.meta.place, nepenthe);
  assert.deepEqual((await deleted({ include: PRESETS.backup })).data.meta.place, nepenthe);
  assert.equal(await deleted({ include: history, share: { places: false, convert: shareConvert } }), undefined); // no History to carry it
  assert.equal((await deleted({ include: { ...PRESETS.backup, photos: false } })).data.meta, undefined);
});

/** In the plan's own JSON: kept as written, a regex would break the file. */
const PLAN_NOTE = 'meet at 40.40412, 50.50512';

/** Every form a recap or a note may quote a position in, and one line of prices that must stay. */
const RECAP = [
  'Friday began at Bixby Bridge.',
  '',
  '- unnamed, near 47.612, -122.335',
  '- the hotel (47.61234, -122.33456) and a pier at -33.857,151.215.',
  '- degrees 47.610°, -122.300° here',
  '- hemispheres 47.612° N, 122.335° W there',
  '- tight 47.612N 122.335W then',
  '- labelled lat 47.612, lng -122.335 and',
  '- long form latitude: 47.612, longitude: -122.335 too',
  '- two decimals near 47.61, -122.33 only after near',
  '- dinner was 12.50, 14.00 euros',
  '- Example Museum',
  '',
].join('\n');

/**
 * A trip whose log and files hold what live mode, Shiori and the user wrote, with synthetic positions: 10.1234, 20.5678, 10.2345,
 * 22.2222, 33.3333 and 11.1111 are sensed (47.612, -122.335 too, in the recap), 40.4040 is the plan's.
 */
async function drivenTrip() {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Road trip' });
  await a.ws.write(trip, '/plan/museum.json', { id: 'museum', title: 'Museum', fixed: false, place: { name: 'Example Museum', lat: 40.404, lng: 50.505 }, notes: PLAN_NOTE }, { author: 'user' });
  await a.ws.write(trip, '/watches/w9.json', { id: 'w9', owner: 'shiori', when: { type: 'enter', lat: 10.1234, lng: 20.5678, radius: 200 }, fallback: 'say so' }, { author: 'shiori' });
  await a.ws.write(trip, '/recap.md', RECAP, { author: 'shiori' });
  await a.ws.write(trip, '/notes/lookout.md', 'Lookout near 47.61234, -122.33456 at dusk.\n', { author: 'shiori' });
  await a.ws.write(trip, '/notes/parked.txt', 'Parked at 36.37150, -121.90170, level 2.\n', { author: 'user' });
  await a.ws.write(trip, '/notes/prices.md', 'Tickets 12.50, 14.00 and 47.61, -122.33 are not places; 1,234.567, 2.345 and 1.234, 6.789.1 neither.\n', { author: 'user' });
  await a.ws.write(trip, '/memory.md', 'Likes the lookout at 47.612°, -122.335°.\n', { author: 'shiori' });
  await a.ws.write(trip, '/notes/links.md', ANNAI_FORMS.join('\n') + '\n', { author: 'shiori' });
  await a.ws.write(trip, '/data/stops.csv', 'name,lat,lng\nLookout,36.37150,-121.90170\n', { author: 'user' });
  await a.ws.write(trip, '/data/page.html', '<p>Parked at 36.37150, -121.90170</p>\n', { author: 'user' });
  await a.ws.write(trip, '/data/stay.ics', 'BEGIN:VEVENT\nGEO:36.37150;-121.90170\nEND:VEVENT\n', { author: 'shiori' });
  const log = (/** @type {string} */ type, /** @type {string} */ actor, /** @type {any} */ data) => logEvent(a.store, trip, { type, actor, data });
  await log('msg.user', 'user', { text: 'we are driving to the museum' });
  await log('location', 'system', { lat: 10.1234, lng: 20.5678, accuracy: 8, speed: 20, source: 'gps' });
  await log('location', 'system', { lat: 10.2345, lng: 20.6789, accuracy: 9 });
  await log('trigger.fired', 'system', { watch: 'w1', type: 'arrived', owner: 'shiori', text: "you've stopped for 6 min somewhere new", place: { lat: 22.2222, lng: 33.3333, name: 'Cafe Example' } });
  await log('trigger.fired', 'system', { watch: 'plan:*:linger', type: 'plan', event: 'linger', owner: 'system', text: 'Off plan: stopped at (11.1111, 22.2222)', place: { lat: 11.1111, lng: 22.2222 } });
  await log('trigger.fired', 'system', { watch: 'plan:museum:arrived', type: 'plan', event: 'arrived', owner: 'system', text: 'Example Museum', place: { name: 'Example Museum', lat: 40.404, lng: 50.505 } });
  await log('trigger.fired', 'system', { watch: 'w2', type: 'enter', owner: 'shiori', text: 'you entered the harbour', place: { name: 'Harbour', lat: 41.414, lng: 51.515 } });
  await log('wake', 'system', { id: 'k1', reasons: [{ kind: 'trigger', text: "Off plan: the user has been stopped for 20 min at a place that isn't on the plan (11.1111, 22.2222); next on the plan: \"Museum\". The replanning skill says what to do." }] });
  await log('out.show', 'shiori', { text: 'Want to visit the Example Museum?', place: { name: 'Example Museum', lat: 40.404, lng: 50.505 } });
  // Shiori's own lookups at the live point: the model turn keeps its parts as a blob, the call names the point, the result is a stored text.
  /** @type {any} */
  const nearby = { type: 'tool_call', id: 'c1', name: 'nearby', input: { lat: 10.1234, lng: 20.5678, query: 'cafe' } };
  await modelTrace(a.store, trip).turn({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, wake: 'k1' }, '', '', [nearby]);
  await record(a.store, trip, { type: 'tool.call', actor: 'shiori', data: { id: 'c1', name: nearby.name, input: nearby.input, wake: 'k1' } });
  await record(a.store, trip, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'nearby', ok: true, ms: 5, wake: 'k1' }, texts: [['content', `Cafe Example, 40 m from 10.1234, 20.5678. ${'x'.repeat(INLINE_MAX)}`]] });
  return { a, trip };
}

/** The point of the links below: a plan place and the live fix, both synthetic. */
const SPOT = { name: 'Lookout', lat: 36.3715, lng: -121.9017 };
const LINK_CATALOG = JSON.parse(await readFile(new URL('../../catalog/links.json', import.meta.url), 'utf8'));

/**
 * Every link and line annai itself writes a position in, built the way the app builds them (mapsUrl in src/ui/cards.js, expandLink in
 * src/core/links.js with the catalog's own formats), plus the two that are written inline: the Files screen's OpenStreetMap link
 * (src/ui/screens/file.js) and the now block's position (src/core/live/live.js nowInfo).
 */
const ANNAI_FORMS = [
  mapsUrl(SPOT, 'android'),
  mapsUrl(SPOT, 'ios'),
  ...LINK_CATALOG.maps.map((/** @type {any} */ m) => expandLink(m.directions, { destination: `${SPOT.lat},${SPOT.lng}`, origin: `${SPOT.lat + 0.01},${SPOT.lng + 0.01}`, mode: m.modes.drive })),
  `https://www.openstreetmap.org/?mlat=${SPOT.lat}&mlon=${SPOT.lng}#map=16/${SPOT.lat}/${SPOT.lng}`,
  `near ${SPOT.name} (30 m) · ${SPOT.lat.toFixed(5)}, ${SPOT.lng.toFixed(5)} (±8 m, 3 min ago)`,
];

/** What the sensed points look like in a file. */
const SENSED = ['10.1234', '20.5678', '10.2345', '20.6789', '22.2222', '33.3333', '11.1111', 'Cafe Example', '47.612', '-122.335', '47.61234', '-122.33456', '151.215', '36.3715', '-121.9017', '47.610', '-122.300', '122.335'];

/**
 * Coordinate pairs in general, looser than archive.js's rule and written apart from it: two numbers of three decimals or more side by
 * side (not a thousands separator or a version number), or a latitude/longitude label, or two numbers after "near". Whatever the Share's scrub misses, this finds.
 */
const LOOKS_LIKE_A_POSITION = [
  /(?<![\d.]|\d,)-?\d{1,3}\.\d{3,}(?!\.?\d)\s*°?\s*[NSEW]?(?:\s*[,;/]\s*|\s+|%2C)-?\d{1,3}\.\d{3,}(?!\.?\d)/i,
  /\bm?(?:lat|lng|lon|long|latitude|longitude)\b\s*[:=]?\s*-?\d/i,
  /\bnear\s+\(?\s*-?\d{1,3}\.\d{2,}\s*°?\s*[NSEW]?\s*,\s*-?\d{1,3}\.\d{2,}/i,
];

/** @param {any} a @param {string} trip @param {any} share @param {any} [include] @returns {Promise<{ lines: any[], entries: Map<string, Uint8Array>, manifest: any, blob: Blob }>} */
async function shared(a, trip, share, include = { ...PRESETS.share, history: true, memory: true }) {
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include, app: '0.1.0', share });
  const entries = await readZip(await bytesOf(blob));
  const log = manifest.scopes[0].events;
  const lines = log ? text(/** @type {Uint8Array} */ (entries.get(log))).trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { lines, entries, manifest, blob };
}

/** The Share's copy of a file, by its path in the trip. @param {{ entries: Map<string, Uint8Array>, manifest: any }} s @param {string} path */
function copyOf(s, path) {
  const f = s.manifest.files.find((/** @type {any} */ x) => x.path === path);
  assert.ok(f, `${path} is in the Share`);
  return { f, body: text(/** @type {Uint8Array} */ (s.entries.get(f.name))) };
}

test('a Share without places carries no History, whatever the History box says, and no watches: no sensed point is in any entry or blob of it', async () => {
  const { a, trip } = await drivenTrip();
  const { lines, entries, manifest, blob } = await shared(a, trip, { places: false });
  assert.equal(manifest.scopes[0].events, undefined);
  assert.equal(manifest.include.history, false);
  assert.deepEqual(lines, []);
  assert.equal([...entries.keys()].some((n) => n.endsWith('events.jsonl') || n.startsWith('blobs/')), false);
  assert.equal(manifest.files.some((/** @type {any} */ f) => f.path.startsWith('/watches/')), false);
  assert.equal([...entries.keys()].some((n) => n.includes('/watches/')), false);
  // The plan's own place and note, in the plan's JSON, and a calendar's GEO (an event's place) are kept by design.
  const plan = manifest.files.find((/** @type {any} */ f) => f.path === '/plan/museum.json');
  const calendar = manifest.files.find((/** @type {any} */ f) => f.path === '/data/stay.ics');
  const kept = new Set([plan.name, calendar.name]);
  for (const [name, bytes] of entries) if (!kept.has(name)) for (const point of SENSED) assert.equal(text(bytes).includes(point), false, `${point} is in ${name}`);
  // Coordinate pairs in general, in every entry and blob.
  for (const [name, bytes] of entries) {
    if (kept.has(name)) continue;
    for (const re of LOOKS_LIKE_A_POSITION) assert.doesNotMatch(text(bytes), re, `a position is in ${name}`);
  }
  assert.equal(text(/** @type {Uint8Array} */ (entries.get(calendar.name))), 'BEGIN:VEVENT\nGEO:36.37150;-121.90170\nEND:VEVENT\n');
  assert.equal(JSON.parse(text(/** @type {Uint8Array} */ (entries.get(plan.name)))).place.lat, 40.404);
  const b = await device();
  assert.equal((await importArchive(b.store, await peekArchive(await bytesOf(blob)))).trips.length, 1);
});

test("a Share without places keeps the recap without its coordinate pairs, in every form, and the user's own recap is unchanged", async () => {
  const { a, trip } = await drivenTrip();
  const own = await a.ws.readText(trip, '/recap.md');
  const s = await shared(a, trip, { places: false });
  const { f, body } = copyOf(s, '/recap.md');
  assert.equal(body, [
    'Friday began at Bixby Bridge.',
    '',
    '- unnamed',
    '- the hotel and a pier at.',
    '- degrees here',
    '- hemispheres there',
    '- tight then',
    '- labelled and',
    '- long form too',
    '- two decimals only after near',
    '- dinner was 12.50, 14.00 euros',
    '- Example Museum',
    '',
  ].join('\n'));
  assert.equal(f.hash, await sha256Hex(utf8(body)));
  assert.equal(f.size, utf8(body).byteLength);
  assert.equal(await a.ws.readText(trip, '/recap.md'), own);
  assert.match(own, /near 47\.612, -122\.335/);
  const b = await device();
  const imported = await importArchive(b.store, await peekArchive(await bytesOf(s.blob)));
  assert.equal(await b.ws.readText(imported.trips[0], '/recap.md'), body);
});

test("a Share without places scrubs every .md, .txt, .csv and .html trip file, whoever wrote it, and never a JSON or .ics file; the user's own files are unchanged", async () => {
  const { a, trip } = await drivenTrip();
  const s = await shared(a, trip, { places: false });
  for (const [path, want] of [
    ['/notes/lookout.md', 'Lookout at dusk.\n'],
    ['/notes/parked.txt', 'Parked at, level 2.\n'],
    ['/memory.md', 'Likes the lookout at.\n'],
    ['/data/stops.csv', 'name,lat,lng\nLookout,\n'],
    ['/data/page.html', '<p>Parked at</p>\n'],
    ['/notes/prices.md', 'Tickets 12.50, 14.00 and 47.61, -122.33 are not places; 1,234.567, 2.345 and 1.234, 6.789.1 neither.\n'], // nothing to remove: bytes as they were
  ]) {
    const { f, body } = copyOf(s, path);
    assert.equal(body, want, path);
    assert.equal(f.hash, await sha256Hex(utf8(want)), `${path} hash`);
    assert.equal(f.size, utf8(want).byteLength, `${path} size`);
  }
  // JSON is kept as written: the plan's place and note are the plan's, and a pattern could break the file.
  const plan = copyOf(s, '/plan/museum.json');
  assert.equal(plan.body, await a.ws.readText(trip, '/plan/museum.json'));
  assert.equal(JSON.parse(plan.body).notes, PLAN_NOTE);
  assert.equal(plan.f.hash, (await a.store.tx(['files'], 'readonly', (t) => t.listFiles(trip, '/plan/')))[0].hash);
  // A calendar's GEO is an event's place, kept like the plan's.
  const ics = copyOf(s, '/data/stay.ics');
  assert.equal(ics.body, await a.ws.readText(trip, '/data/stay.ics'));
  assert.equal(ics.f.hash, (await a.store.tx(['files'], 'readonly', (t) => t.listFiles(trip, '/data/'))).find((x) => x.path === '/data/stay.ics')?.hash);
  // The user's own copies.
  assert.equal(await a.ws.readText(trip, '/notes/lookout.md'), 'Lookout near 47.61234, -122.33456 at dusk.\n');
  assert.equal(await a.ws.readText(trip, '/notes/parked.txt'), 'Parked at 36.37150, -121.90170, level 2.\n');
  assert.equal(await a.ws.readText(trip, '/memory.md'), 'Likes the lookout at 47.612°, -122.335°.\n');
  // With places on, nothing is removed anywhere.
  const on = await shared(a, trip, { places: true });
  assert.equal(copyOf(on, '/notes/lookout.md').body, 'Lookout near 47.61234, -122.33456 at dusk.\n');
  assert.equal(copyOf(on, '/notes/parked.txt').body, 'Parked at 36.37150, -121.90170, level 2.\n');
  assert.equal(copyOf(on, '/memory.md').body, 'Likes the lookout at 47.612°, -122.335°.\n');
  for (const path of ['/data/stops.csv', '/data/page.html', '/data/stay.ics', '/notes/links.md']) assert.equal(copyOf(on, path).body, await a.ws.readText(trip, path), path);
  assert.equal(copyOf(on, '/recap.md').body, await a.ws.readText(trip, '/recap.md'));
});

/** @param {string} s */
const scrub = (s) => text(withoutPoints(utf8(s)));

test('the scrub removes every form annai writes a position in, and the forms people label', () => {
  const [google, apple, ...rest] = ANNAI_FORMS;
  assert.equal(scrub(google), 'https://www.google.com/maps/search/?api=1&query=');
  assert.equal(scrub(apple), 'https://maps.apple.com/?q=Lookout&ll=');
  assert.equal(scrub(rest[0]), 'https://maps.apple.com/?daddr=&dirflg=d&saddr=');
  assert.equal(scrub(rest[1]), 'https://www.google.com/maps/dir/?api=1&destination=&travelmode=driving&origin=');
  assert.equal(scrub(rest[2]), 'https://www.openstreetmap.org/?#map=16/');
  assert.equal(scrub(rest[3]), 'near Lookout (30 m) · (±8 m, 3 min ago)');
  for (const [from, want] of [
    ['at 36.3715%2C-121.9017 now', 'at now'], // an encoded comma
    ['at 36.3715%2c-121.9017 now', 'at now'],
    ['at 47.612;-122.335 now', 'at now'],
    ['at 47.612; -122.335 now', 'at now'],
    ['at 47.612/-122.335 now', 'at now'],
    ['at 47.612 / -122.335 now', 'at now'],
    ['?mlat=47.612&mlon=-122.335#x', '?#x'], // OpenStreetMap's own labels
    ['?mlat=47&mlon=-122', '?'],
    ['mlat: 47.612, mlon: -122.335', ''],
    ['a (lat 47.612, lng -122.335) b', 'a b'],
    ['Lat 47.612 and Lon -122.335.', '.'],
    ['lat 47.612; lng -122.335', ''],
    ['lat=47.612&lng=-122.335&z=9', '&z=9'],
    ['at 47.612, -122.335 and 47.613, -122.336 too', 'at and too'],
    ['at 47.612° N, 122.335° W now', 'at now'],
    ['at 47.612N 122.335W now', 'at now'],
    ['at 47.612N122.335W now', 'at now'],
    ['at 47.61234°, -122.33456° now', 'at now'],
    ['stop, near 47.61, -122.33.', 'stop.'],
    ['stop near (47.61, -122.33) now', 'stop now'],
    ['stop near 47.61° N, 122.33° W now', 'stop now'],
    ['near 12.50, 14.00 euros', ' euros'], // not a position, removed all the same (a known limitation)
    ['a list 1.250, 3.500', 'a list'], // a European list, the same
  ]) assert.equal(scrub(from), want, from);
});

test('the scrub leaves forms it does not catch as they were (a known limitation pins each)', () => {
  for (const kept of [
    '47°36′43″N 122°20′6″W', // degrees, minutes, seconds
    '47°36′43.2″ N, 122°20′6.1″ W',
    'N 47.612, W 122.335', // a hemisphere before the number
    'N47.612 W122.335',
    '47.612 -122.335', // only a space between
    '47.612  122.335',
    '47.61, -122.33', // a bare pair with two decimals
    '{"lat":36.3715,"lng":-121.9017}', // a label in quotes, in a note or a page
    'data-lat="47.612" data-lng="-122.335"',
    '47.612 North, 122.335 West', // a word, not a hemisphere letter
    '47.612 N, 122.335 East',
    '47.61/-122.33',
    'dinner was 12.50, 14.00 euros',
    '47.6, -122.3',
    'lat 47.612',
    'longitude -122.335',
    '(47612, -122335)',
    '1,234.567, 2.345',
  ]) assert.equal(scrub(kept), kept, kept);
});

test('the scrub keeps a line break, and takes only the spaces before a position on its own line', () => {
  assert.equal(scrub('## Stop\n47.612, -122.335 was quiet'), '## Stop\n was quiet');
  assert.equal(scrub('## Stop\r\n47.612, -122.335 was quiet'), '## Stop\r\n was quiet');
  assert.equal(scrub('one\n\n  47.612, -122.335\ntwo'), 'one\n\n\ntwo');
  assert.equal(scrub('one \n(47.612, -122.335)\ntwo'), 'one \n\ntwo');
  assert.equal(scrub('one near 47.61, -122.33 two'), 'one  two');
  assert.equal(scrub('a\t 47.612, -122.335\tb'), 'a\tb');
  assert.equal(scrub('lat 47.612,\nlng -122.335'), 'lat 47.612,\nlng -122.335'); // a pair split over two lines is two lines
  assert.equal(scrub('47.612,\n-122.335'), '47.612,\n-122.335');
});

test('the scrub runs in linear time on padded text', () => {
  const spaces = ' '.repeat(400_000);
  for (const [name, input] of [
    ['spaces', spaces],
    ['after a number', `12.345${spaces}`],
    ['after a label', `lat${spaces}`],
    ['after near', `near${spaces}`],
    ['after a comma', `,${spaces}`],
    ['after a number and a comma', `12.345,${spaces}`],
    ['between numbers', `12.345${spaces}12.345`],
    ['between a number and a hemisphere', `12.345${spaces}N`],
    ['tabs and spaces', '12.345 \t'.repeat(50_000)],
    ['many labels', 'lat '.repeat(100_000)],
    ['many numbers', '12.345 '.repeat(60_000)],
    ['many pairs', '12.345, '.repeat(60_000)],
    ['one long number', `1.${'1'.repeat(400_000)}`],
    ['line breaks', `lat${'\n '.repeat(100_000)}`],
  ]) {
    const bytes = utf8(input);
    const before = process.cpuUsage(); // CPU time: a clock on the wall also counts time the machine gave to something else
    withoutPoints(bytes);
    const { user, system } = process.cpuUsage(before);
    const ms = (user + system) / 1000;
    assert.ok(ms < 100, `${name}: ${Math.round(ms)} ms`);
  }
});

const latin1 = (/** @type {string} */ s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const SHIFT_JIS_WORD = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]; // 日本語

test('the scrub keeps every other byte of a file that is not UTF-8, and a BOM', () => {
  // Latin-1: é is one byte (0xE9), ° is 0xB0, a no-break space is 0xA0.
  const l1 = latin1('caf\xe9 \xa0 47.612\xb0, -122.335\xb0 \xe9t\xe9\n');
  assert.deepEqual(withoutPoints(l1), latin1('caf\xe9 \xa0 \xe9t\xe9\n')); // a byte 0xA0 is no space here: it could be half of a letter
  // Shift-JIS: the word's bytes are not UTF-8.
  const sjis = Uint8Array.from([...SHIFT_JIS_WORD, 0x20, ...latin1('47.61234, -122.33456'), 0x20, ...SHIFT_JIS_WORD, 0x0a]);
  assert.deepEqual(withoutPoints(sjis), Uint8Array.from([...SHIFT_JIS_WORD, 0x20, ...SHIFT_JIS_WORD, 0x0a]));
  // A trail byte of 0xA0 or 0x20-like value in front of a position is not taken as a space.
  const gbk = Uint8Array.from([0xb0, 0xa0, ...latin1('47.61234, -122.33456'), 0x0a]);
  assert.deepEqual(withoutPoints(gbk), Uint8Array.from([0xb0, 0xa0, 0x0a]));
  // Nothing to remove: the same bytes, not a copy re-encoded.
  for (const bytes of [latin1('caf\xe9 12.50, 14.00\n'), Uint8Array.from([...SHIFT_JIS_WORD, 0x0a]), utf8('plain\n'), new Uint8Array(0)]) assert.equal(withoutPoints(bytes), bytes);
  // A BOM stays, with the text after it scrubbed.
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Stop 47.61234, -122.33456 ok\n')]);
  assert.deepEqual(withoutPoints(bom), Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Stop ok\n')]));
  const bomOnly = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Stop\n')]);
  assert.equal(withoutPoints(bomOnly), bomOnly);
  // UTF-8 with the multibyte text around the position.
  assert.equal(text(withoutPoints(utf8('東京 47.61234, -122.33456 カフェ\n'))), '東京 カフェ\n');
  // UTF-16 is not read: left as it was.
  const utf16 = Uint8Array.from([0xff, 0xfe, ...[...'47.61234, -122.33456'].flatMap((c) => [c.charCodeAt(0), 0])]);
  assert.equal(withoutPoints(utf16), utf16);
  // GB18030: a four-byte character's 2nd and 4th bytes are ASCII digits, so no number starts right after a byte above 0x7F; the
  // position written straight after one stays, and the character is never cut.
  const gb18030 = Uint8Array.from([0x95, 0x32, 0x82, 0x36, ...latin1('35.681,139.767 ok\n')]);
  assert.equal(withoutPoints(gb18030), gb18030);
  assert.deepEqual(withoutPoints(Uint8Array.from([0x95, 0x32, 0x82, 0x36, ...latin1(' 35.681,139.767 ok\n')])), Uint8Array.from([0x95, 0x32, 0x82, 0x36, ...latin1(' ok\n')]));
  // A BOM right before the position stays.
  const bomFirst = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('47.612, -122.335 is the lookout\n')]);
  assert.deepEqual(withoutPoints(bomFirst), Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(' is the lookout\n')]));
});

test("the scrub removes the encoded bar of annai's Wikipedia nearby search", () => {
  assert.equal(scrub('https://en.wikipedia.org/w/api.php?list=geosearch&gscoord=36.3715%7C-121.9017&gsradius=1000'), 'https://en.wikipedia.org/w/api.php?list=geosearch&gscoord=&gsradius=1000');
});

test('a Share without places keeps every other byte of a Shift-JIS, a Latin-1 and a BOM file', async () => {
  const a = await device();
  const trip = await createTrip(a.ws, { title: 'Road trip' });
  const sjis = Uint8Array.from([...SHIFT_JIS_WORD, 0x20, ...latin1('47.61234, -122.33456'), 0x20, ...SHIFT_JIS_WORD, 0x0a]);
  const l1 = latin1('caf\xe9 at 47.61234, -122.33456 \xe9t\xe9\n');
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Stop 47.61234, -122.33456 ok\n')]);
  const plainSjis = Uint8Array.from([...SHIFT_JIS_WORD, 0x0a]);
  /** @type {[string, Uint8Array][]} */
  const files = [['/notes/sjis.txt', sjis], ['/notes/latin1.txt', l1], ['/notes/bom.md', bom], ['/notes/plain-sjis.txt', plainSjis]];
  for (const [path, bytes] of files) await a.ws.write(trip, path, bytes, { author: 'user' });
  const s = await shared(a, trip, { places: false }, PRESETS.share);
  const body = (/** @type {string} */ path) => s.entries.get(copyOf(s, path).f.name);
  assert.deepEqual(body('/notes/sjis.txt'), Uint8Array.from([...SHIFT_JIS_WORD, 0x20, ...SHIFT_JIS_WORD, 0x0a]));
  assert.deepEqual(body('/notes/latin1.txt'), latin1('caf\xe9 at \xe9t\xe9\n'));
  assert.deepEqual(body('/notes/bom.md'), Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('Stop ok\n')]));
  assert.deepEqual(body('/notes/plain-sjis.txt'), plainSjis);
  for (const path of ['/notes/sjis.txt', '/notes/latin1.txt', '/notes/bom.md', '/notes/plain-sjis.txt']) {
    const { f } = copyOf(s, path);
    const got = /** @type {Uint8Array} */ (body(path));
    assert.equal(f.hash, await sha256Hex(got), `${path} hash`);
    assert.equal(f.size, got.byteLength, `${path} size`);
  }
  assert.equal(copyOf(s, '/notes/plain-sjis.txt').f.hash, (await a.store.tx(['files'], 'readonly', (t) => t.listFiles(trip, '/notes/'))).find((x) => x.path === '/notes/plain-sjis.txt')?.hash);
});

test('a Share with places, and a backup, carry the log, the watches and the recap whole', async () => {
  const { a, trip } = await drivenTrip();
  const withPlaces = await shared(a, trip, { places: true });
  const { lines, entries, manifest } = withPlaces;
  assert.equal(lines.filter((e) => e.type === 'location').length, 2);
  assert.equal(lines.filter((e) => e.type === 'trigger.fired').length, 4);
  assert.match(lines.find((e) => e.type === 'wake').data.reasons[0].text, /\(11\.1111, 22\.2222\)/);
  assert.ok(lines.some((e) => e.type === 'model.turn' && e.refs?.length));
  assert.ok(lines.some((e) => e.type === 'tool.call' && e.data.input.lat === 10.1234));
  const blobs = [...entries].filter(([n]) => n.startsWith('blobs/')).map(([, bytes]) => text(bytes));
  assert.ok(blobs.some((b) => b.includes('"lat":10.1234')), 'the model turn parts are carried');
  assert.ok(blobs.some((b) => b.includes('Cafe Example, 40 m from 10.1234')), 'the tool result is carried');
  const watch = manifest.files.find((/** @type {any} */ f) => f.path === '/watches/w9.json');
  assert.equal(JSON.parse(text(/** @type {Uint8Array} */ (entries.get(watch.name)))).when.lat, 10.1234);
  const recap = manifest.files.find((/** @type {any} */ f) => f.path === '/recap.md');
  assert.equal(text(/** @type {Uint8Array} */ (entries.get(recap.name))), await a.ws.readText(trip, '/recap.md'));
  // A Share with places and no History ticked has none, as before.
  assert.equal((await shared(a, trip, { places: true }, PRESETS.share)).manifest.scopes[0].events, undefined);
  const backup = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const kept = text(/** @type {Uint8Array} */ ((await readZip(await bytesOf(backup.blob))).get(/** @type {string} */ (backup.manifest.scopes[0].events))));
  assert.equal(kept.trim().split('\n').filter((l) => JSON.parse(l).type === 'location').length, 2);
  assert.ok(backup.manifest.files.some((f) => f.path === '/watches/w9.json'));
});

test("an archive holds no mirror, lands mirrored from its own files and log, and what a record claims of itself doesn't count", async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  await record(a.store, trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: 5000 });
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: '0.1.0' });
  const made = /** @type {any} */ (manifest.scopes.find((s) => s.record.id === trip)).record;
  assert.deepEqual(['start' in made, 'end' in made, 'talked' in made], [false, false, false], "a released copy's archive looks the same");
  const bytes = await bytesOf(blob);
  for (const claims of [{}, { start: 'whenever', end: 7, talked: 'often' }, { start: '2020-01-01', end: '2020-01-02', talked: 1 }]) {
    const b = await device();
    const opened = await peekArchive(bytes);
    Object.assign(/** @type {any} */ (opened.manifest.scopes.find((s) => s.record.id === trip)).record, claims);
    const [id] = (await importArchive(b.store, opened)).trips;
    const r = /** @type {any} */ (await b.store.tx(['scopes'], 'readonly', (t) => t.getScope(id)));
    assert.deepEqual([r.start, r.end, r.talked], ['2027-04-03', '2027-04-10', 5000]);
  }
});

test('a Share without the conversation says nobody has talked', async () => {
  const a = await device();
  const trip = await sampleTrip(a.ws);
  await record(a.store, trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: 5000 });
  const { blob } = await exportArchive(a.store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  const b = await device();
  const [id] = (await importArchive(b.store, await peekArchive(await bytesOf(blob)))).trips;
  assert.equal(/** @type {any} */ (await b.store.tx(['scopes'], 'readonly', (t) => t.getScope(id))).talked, null);
});
