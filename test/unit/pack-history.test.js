import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPack, readManifest, DIR, MANIFEST, STALE_MS } from '../../src/core/pack/download.js';
import { loadPack } from '../../src/core/pack/read.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createMemoryStore, afterListing } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';
import { packTrip, services, overpass, STOPS } from './pack-kit.js';

// The offline pack keeps no history (spec §4.9): what the pack replaced takes no space and rides along in no Backup (RULES principle 5).

const V = '9.9.9';
/** Paths that only look like the pack's. */
const LOOKALIKES = ['/offline-list.md', '/notes/offline/road.md'];
const EN = ['en'];
/** The trip's file history of the pack's paths. @param {any} store @param {string} trip */
const packHistory = async (store, trip) => (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['file.write', 'file.delete'] })))
  .filter((/** @type {any} */ e) => String(e.data?.path).startsWith(DIR));
/** How the trip's log ends: its forget entries, and the number of its last entry. @param {any} store @param {string} trip */
const logEnd = async (store, trip) => {
  const all = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip));
  return { forgets: all.filter((/** @type {any} */ e) => e.type === 'forget'), top: all.at(-1)?.seq ?? 0 };
};
const isOsm = (/** @type {{ path: string }} */ f) => f.path.includes('/osm/');
/** The history of the trip's files that are not the pack's. @param {Workspace} ws @param {string} trip */
const theirHistories = async (ws, trip) => [...(await ws.histories(trip))].filter(([p]) => !p.startsWith(DIR));
/** @param {any} store @param {string} hash */
const stored = (store, hash) => store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.hasBlob(hash));
/** Overpass a month later: a new viewpoint in every answer, so each OpenStreetMap part downloaded again is a new version (a Wikipedia part or a guide downloaded again has the same bytes: no new version). @param {string} url @param {any} init */
const later = (url, init) => ({ elements: [...overpass(url, init).elements, { type: 'node', id: 9, lat: 36.3, lon: -121.85, tags: { name: 'New Vista', tourism: 'viewpoint' } }] });

/**
 * A trip with files of the traveller's own in two versions (two of them at paths that only look like the pack's), and a pack downloaded twice:
 * a month apart, after Nepenthe moved, so the second download writes the OpenStreetMap parts again with new places, removes the parts around
 * the old Nepenthe (OpenStreetMap's and Wikipedia's) and adds the new ones. Bixby's Wikipedia part and the guides keep their bytes.
 */
async function twoDownloads() {
  const t = await packTrip();
  let at = Date.parse('2026-11-01T08:00:00Z');
  const now = () => at;
  await t.ws.write(t.trip, '/notes/mine.md', 'first', { author: 'user' });
  await t.ws.write(t.trip, '/notes/mine.md', 'second', { author: 'user' });
  for (const p of LOOKALIKES) for (const v of ['one', 'two']) await t.ws.write(t.trip, p, `${p} ${v}`, { author: 'user' });
  /** How the trip's log ended before and after each download. @type {{ before: Awaited<ReturnType<typeof logEnd>>, after: Awaited<ReturnType<typeof logEnd>> }[]} */
  const ends = [];
  /** @param {Parameters<typeof services>[0]} [o] */
  const download = async (o) => {
    const before = await logEnd(t.store, t.trip);
    const m = await downloadPack({ ws: t.ws, scope: t.trip, ...services(o), version: V, editions: EN, gapMs: 0, now });
    ends.push({ before, after: await logEnd(t.store, t.trip) });
    return m;
  };
  await download();
  const first = await t.ws.list(t.trip, DIR);
  at += STALE_MS + 1;
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { name: 'Nepenthe', lat: 36.1, lng: -121.65 } }, { author: 'user' });
  const theirs = await theirHistories(t.ws, t.trip); // after the plan item's own write: that one is the traveller's, and stays
  const m = await download({ overpass: later });
  const current = await t.ws.list(t.trip, DIR);
  const kept = new Set(current.map((f) => f.hash));
  return { ...t, m, first, current, older: first.filter((f) => !kept.has(f.hash)), ends, theirs };
}

test("two downloads that change the pack's parts leave none of its older versions, nor their content; its files, and the traveller's own file's history, stay", async () => {
  const { store, ws, trip, m, first, current, older, ends, theirs } = await twoDownloads();
  // Every OpenStreetMap part was replaced or removed (as many as the pack had); Bixby's Wikipedia part and the guides came back with the same bytes.
  assert.ok(first.filter(isOsm).length > 0);
  assert.deepEqual(older.filter(isOsm), first.filter(isOsm));
  assert.deepEqual(first.filter((f) => !older.includes(f)).map((f) => f.path.split('/')[2]).sort(), ['wikipedia', 'wikivoyage', 'wikivoyage']);
  assert.deepEqual(await packHistory(store, trip), []);
  // Each download leaves one forget entry, the newest of the log, numbered above what was there.
  for (const { before, after } of ends) {
    assert.equal(after.forgets.length, 1);
    assert.ok(after.forgets[0].seq > before.top);
    assert.equal(after.forgets[0].seq, after.top);
  }
  assert.ok(ends[1].after.forgets[0].seq > ends[0].after.forgets[0].seq);
  // No other file's history changed: the paths that only look like the pack's, the plan, the trip's own files.
  assert.deepEqual(await theirHistories(ws, trip), theirs);
  for (const p of LOOKALIKES) assert.equal((await ws.history(trip, p)).length, 2, p);
  for (const f of older) assert.equal(await stored(store, f.hash), false, `${f.path}'s older version is freed`);
  // The pack is whole: its manifest, and every file it names, readable.
  assert.deepEqual(await readManifest(ws, trip), m);
  assert.deepEqual(current.map((f) => f.path).sort(), [...m.files.map((f) => f.path), MANIFEST].sort());
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
  assert.ok(packed.some((f) => f.path === MANIFEST));
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
  const first = new Map((await ws.list(trip, DIR)).map((f) => [f.path, f.hash]));
  const abort = new AbortController();
  const m = await downloadPack({ ws, scope: trip, ...services({ overpass: later }), version: V, editions: EN, gapMs: 0, now, signal: abort.signal, onProgress: (p) => { if (p.done === 1) abort.abort(); } });
  assert.equal(m.stopped, true);
  assert.deepEqual(await packHistory(store, trip), []);
  const written = [...(await ws.list(trip, DIR))].filter((f) => first.get(f.path) !== f.hash).map((f) => f.path).sort();
  assert.equal(written.length, 2, 'its first part, and the manifest saying it stopped');
  for (const p of written) assert.equal(await stored(store, /** @type {string} */ (first.get(p))), false, `${p}'s older version is freed`);
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

test("a forget that fails, as the phone has no room for it, leaves the download's own result; the history waits for the next download, which forgets it", async () => {
  const { store, ws, trip } = await packTrip();
  let at = Date.parse('2026-11-01T08:00:00Z');
  const now = () => at;
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0, now });
  at += STALE_MS + 1;
  const before = new Map((await ws.list(trip, DIR)).map((f) => [f.path, f.hash]));
  // The transaction after the download's manifest is written, the forget's, is refused.
  const anyWs = /** @type {any} */ (ws);
  const anyStore = /** @type {any} */ (store);
  const writeMany = anyWs.writeMany.bind(ws);
  const tx = anyStore.tx.bind(store);
  let wrote = false;
  let refused = 0;
  anyWs.writeMany = async (/** @type {any[]} */ ...a) => { const r = await writeMany(...a); wrote = true; return r; };
  anyStore.tx = (/** @type {any} */ stores, /** @type {string} */ mode, /** @type {any} */ fn) => (wrote && mode === 'readwrite' && !refused++ ? Promise.reject(new StorageFullError()) : tx(stores, mode, fn));
  const m = await downloadPack({ ws, scope: trip, ...services({ overpass: later }), version: V, editions: EN, gapMs: 0, now });
  anyWs.writeMany = writeMany;
  anyStore.tx = tx;
  assert.equal(refused, 1, 'the forget was tried, and refused');
  assert.deepEqual(await readManifest(ws, trip), m, "the download's own result stands");
  assert.ok((await packHistory(store, trip)).length > 0, 'its history waits');
  const kept = new Map((await ws.list(trip, DIR)).map((f) => [f.path, f.hash]));
  const waiting = [...before].filter(([p, h]) => kept.get(p) !== h).map(([, h]) => h);
  assert.ok(waiting.length > 0);
  for (const h of waiting) assert.equal(await stored(store, h), true, 'its content still stored');
  // The next download forgets it.
  at += 1000;
  await downloadPack({ ws, scope: trip, ...services({ overpass: later }), version: V, editions: EN, gapMs: 0, now });
  assert.deepEqual(await packHistory(store, trip), []);
  for (const h of waiting) assert.equal(await stored(store, h), false, 'its content freed');
});

test("a Backup that overlaps the end of a download makes what the pack is by then: the parts the download replaced are read again, the parts it removed are left out", async () => {
  const { store, ws, trip } = await packTrip();
  let at = Date.parse('2026-11-01T08:00:00Z');
  const now = () => at;
  await downloadPack({ ws, scope: trip, ...services(), version: V, editions: EN, gapMs: 0, now });
  const listed = await ws.list(trip, DIR);
  at += STALE_MS + 1;
  // The download ends right after the Backup listed the trip's files: its forget frees the older versions the listing names.
  await ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { name: 'Nepenthe', lat: 36.1, lng: -121.65 } }, { author: 'user' });
  const racing = afterListing(store, () => downloadPack({ ws, scope: trip, ...services({ overpass: later }), version: V, editions: EN, gapMs: 0, now }));
  const { manifest } = await exportArchive(racing, { kind: 'trip', scopes: [trip], include: PRESETS.backup, app: V });
  const now_ = new Map((await ws.list(trip, DIR)).map((f) => [f.path, f.hash]));
  assert.ok(listed.some((f) => !now_.has(f.path)), 'the download removed parts the listing named');
  assert.ok(listed.some((f) => now_.has(f.path) && now_.get(f.path) !== f.hash), 'and replaced others');
  const packed = manifest.files.filter((f) => f.path.startsWith(DIR));
  assert.ok(packed.length > 0);
  for (const f of packed) assert.equal(f.hash, now_.get(f.path), `${f.path} as it is now`);
  assert.deepEqual(packed.map((f) => f.path).sort(), listed.map((f) => f.path).filter((p) => now_.has(p)).sort(), 'what the listing named and is still there');
});
