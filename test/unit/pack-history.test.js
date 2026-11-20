import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPack, readManifest, DIR, STALE_MS } from '../../src/core/pack/download.js';
import { loadPack } from '../../src/core/pack/read.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';
import { packTrip, services, overpass, STOPS } from './pack-kit.js';

// The offline pack keeps no history (spec §11.5): what nothing reads takes no space and rides along in no Backup (RULES principle 5).

const V = '9.9.9';
const EN = ['en'];
/** The trip's file history of the pack's paths. @param {any} store @param {string} trip */
const packHistory = async (store, trip) => (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['file.write', 'file.delete'] })))
  .filter((/** @type {any} */ e) => String(e.data?.path).startsWith(DIR));
/** @param {any} store @param {string} hash */
const stored = (store, hash) => store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.hasBlob(hash));
/** Overpass a month later: a new viewpoint in every part's answer, so each part downloaded again is a new version. @param {string} url @param {any} init */
const later = (url, init) => ({ elements: [...overpass(url, init).elements, { type: 'node', id: 9, lat: 36.3, lon: -121.85, tags: { name: 'New Vista', tourism: 'viewpoint' } }] });

/**
 * A trip with a file of the traveller's own in two versions, and a pack downloaded twice: a month apart, after Nepenthe moved, so the second
 * download writes every part again with new places, removes the parts around the old Nepenthe and adds the new ones.
 */
async function twoDownloads() {
  const t = await packTrip();
  let at = Date.parse('2026-11-01T08:00:00Z');
  const now = () => at;
  await t.ws.write(t.trip, '/notes/mine.md', 'first', { author: 'user' });
  await t.ws.write(t.trip, '/notes/mine.md', 'second', { author: 'user' });
  await downloadPack({ ws: t.ws, scope: t.trip, ...services(), version: V, editions: EN, gapMs: 0, now });
  const first = await t.ws.list(t.trip, DIR);
  at += STALE_MS + 1;
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { name: 'Nepenthe', lat: 36.1, lng: -121.65 } }, { author: 'user' });
  const m = await downloadPack({ ws: t.ws, scope: t.trip, ...services({ overpass: later }), version: V, editions: EN, gapMs: 0, now });
  const current = await t.ws.list(t.trip, DIR);
  const kept = new Set(current.map((f) => f.hash));
  return { ...t, m, current, older: first.filter((f) => !kept.has(f.hash)) };
}

test("two downloads that change the pack's parts leave none of its older versions, nor their content; its files, and the traveller's own file's history, stay", async () => {
  const { store, ws, trip, m, current, older } = await twoDownloads();
  assert.ok(older.filter((f) => f.path.includes('/osm/')).length >= 3, 'every OpenStreetMap part was replaced or removed');
  assert.deepEqual(await packHistory(store, trip), []);
  for (const f of older) assert.equal(await stored(store, f.hash), false, `${f.path}'s older version is freed`);
  // The pack is whole: its manifest, and every file it names, readable.
  assert.deepEqual(await readManifest(ws, trip), m);
  assert.deepEqual(current.map((f) => f.path).sort(), [...m.files.map((f) => f.path), '/offline/pack.json'].sort());
  for (const f of current) assert.equal(await stored(store, f.hash), true);
  const pack = await loadPack(ws, trip);
  assert.ok(pack?.places({ lat: 36.3, lng: -121.85 }, 1000, ['sights']).some((r) => r[0] === 'New Vista'), 'the newer places');
  // The traveller's own file keeps both versions, and the older one can be brought back.
  const mine = await ws.history(trip, '/notes/mine.md');
  assert.equal(mine.length, 2);
  await ws.restore(trip, '/notes/mine.md', /** @type {string} */ (mine[0].new), { author: 'user' });
  assert.equal(await ws.readText(trip, '/notes/mine.md'), 'first');
});

test("a Backup made after them carries the pack's files and no older version of them: its older content is the traveller's alone", async () => {
  const { store, ws, trip, m, older } = await twoDownloads();
  const { manifest } = await exportArchive(store, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: V });
  // The older versions of the traveller's own files (their note, the plan item Nepenthe moved in), by the history of their paths alone.
  const now = new Set((await ws.list(trip)).map((f) => f.hash));
  const theirs = new Set();
  for (const [path, versions] of await ws.histories(trip)) if (!path.startsWith(DIR)) for (const v of versions) for (const h of [v.old, v.new]) if (h && !now.has(h)) theirs.add(h);
  assert.ok(theirs.has(await sha256Hex(utf8('first'))));
  assert.deepEqual(manifest.blobs.map((b) => b.hash).sort(), [...theirs].sort());
  assert.ok(older.every((f) => !manifest.blobs.some((b) => b.hash === f.hash)));
  const packed = manifest.files.filter((f) => f.path.startsWith(DIR));
  assert.equal(packed.length, m.files.length + 1, 'with its manifest');
});

test("a Backup made before this change restores with the pack's older versions as it holds them, and the next download forgets them", async () => {
  const a = await packTrip();
  await a.ws.write(a.trip, '/notes/mine.md', 'first', { author: 'user' });
  await a.ws.write(a.trip, '/notes/mine.md', 'second', { author: 'user' });
  await downloadPack({ ws: a.ws, scope: a.trip, ...services(), version: V, editions: EN, gapMs: 0 });
  // An older annai's refresh: a part written again over an older version, which its history kept.
  const part = /** @type {import('../../src/core/types.js').FileEntry} */ ((await a.ws.list(a.trip, `${DIR}osm/`))[0]);
  const now = String(await a.ws.readText(a.trip, part.path));
  const was = JSON.stringify({ ...JSON.parse(now), rows: [] });
  await a.ws.write(a.trip, part.path, was, { author: 'system' });
  await a.ws.write(a.trip, part.path, now, { author: 'system' });
  const wasHash = await sha256Hex(utf8(was));
  const { blob, manifest } = await exportArchive(a.store, { kind: 'trip', scopes: [a.trip], include: PRESETS.backup, app: V });
  assert.ok(manifest.blobs.some((b) => b.hash === wasHash), 'the Backup holds the older version');

  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const [trip] = (await importArchive(store, await peekArchive(new Uint8Array(await blob.arrayBuffer())))).trips;
  assert.deepEqual(await readManifest(ws, trip), await readManifest(a.ws, a.trip));
  assert.ok(await loadPack(ws, trip));
  assert.deepEqual((await ws.history(trip, part.path)).map((v) => v.new), (await a.ws.history(a.trip, part.path)).map((v) => v.new), 'as the Backup held it');
  assert.equal(await stored(store, wasHash), true);
  assert.equal((await ws.history(trip, '/notes/mine.md')).length, 2);

  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0 });
  assert.deepEqual(await packHistory(store, trip), []);
  assert.equal(await stored(store, wasHash), false);
  assert.equal(await ws.readText(trip, part.path), now);
  assert.equal((await ws.history(trip, '/notes/mine.md')).length, 2);
});

test('a download that is stopped, or fails as the phone fills up, forgets too: what it wrote is the pack now', async () => {
  const { store, ws, trip } = await packTrip();
  let at = Date.parse('2026-11-01T08:00:00Z');
  const now = () => at;
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0, now });
  // Stopped after its first part, a month later.
  at += STALE_MS + 1;
  const abort = new AbortController();
  const m = await downloadPack({ ws, scope: trip, ...services({ overpass: later }), version: V, editions: EN, gapMs: 0, now, signal: abort.signal, onProgress: (p) => { if (p.done === 1) abort.abort(); } });
  assert.equal(m.stopped, true);
  assert.deepEqual(await packHistory(store, trip), []);
  // The phone full at its second part: the first is the new version, the second the old one, and nothing else names the first's old one.
  at += STALE_MS + 1;
  const before = new Map((await ws.list(trip, DIR)).map((f) => [f.path, f.hash]));
  const anyWs = /** @type {any} */ (ws);
  const write = anyWs.write.bind(ws);
  let parts = 0;
  anyWs.write = (/** @type {string} */ s, /** @type {string} */ p, /** @type {any[]} */ ...rest) => (p.startsWith(DIR) && ++parts === 2 ? Promise.reject(new StorageFullError()) : write(s, p, ...rest));
  const newer = (/** @type {string} */ url, /** @type {any} */ init) => ({ elements: [...later(url, init).elements, { type: 'node', id: 10, lat: 36.31, lon: -121.86, tags: { name: 'Newer Vista', tourism: 'viewpoint' } }] });
  await assert.rejects(downloadPack({ ws, scope: trip, ...services({ overpass: newer }), version: V, editions: EN, gapMs: 0, now }), StorageFullError);
  anyWs.write = write;
  const after = new Map((await ws.list(trip, DIR)).map((f) => [f.path, f.hash]));
  const changed = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p);
  assert.equal(changed.length, 1, 'its first part');
  assert.deepEqual(await packHistory(store, trip), []);
  assert.equal(await stored(store, /** @type {string} */ (before.get(changed[0]))), false);
});
