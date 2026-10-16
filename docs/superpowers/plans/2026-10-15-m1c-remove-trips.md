# Milestone 1c: Removing Trips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Removing a trip deletes it from the device and frees its space at once. annai asks once, and asks again only when the trip changed after its last Backup. Each trip records when it was last backed up, and its card shows it.

**Architecture:**
- **Store:** the store learns to list every blob's hash and size without reading any content. IndexedDB gets a `size` index on `blobs`, added in a version-2 migration.
- **`removeTrip` (core):** in one transaction, it deletes the trip's record, files and history, then every blob that no remaining file or event points at.
- **Backup tracking:**
  - A saved Backup with everything ticked notes `{ at, seq }` on each trip it held. `seq` is the last history entry the file holds.
  - A trip has "changed" when its log has a later entry other than archive or unarchive.
- **Import safety:** an import's last step checks that its content is still stored, so a removal running in the meantime fails the import cleanly.
- **UI:**
  - a Remove button with a `<dialog>` question
  - a backup line on trip cards
  - storage-full advice that works

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), the in-browser suites, and Playwright 1.63.0 (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. Milestone 1c is §20 row 1c: the Remove button and its two questions, the backup time on trips, freeing content nothing else uses, and the storage-full card's options (§4.9, §17, and the backup status on trip cards in §16.2). Done when, on both phones, removing a trip full of photos gives its space back, and the backup warning shows exactly when the trip changed after its last Backup.

## Global Constraints

- **Dependencies:** zero runtime dependencies. Dev dependencies stay TypeScript, Playwright and `@types/node`.
- **Modules and types:** native ES modules, no build step. JSDoc types are checked by `npm run typecheck` (three tsconfigs).
- **Platforms:** iOS (Safari) and Android (Chrome) are both required. Modern browsers only.
- **Security policy:** the Content Security Policy in `_headers` applies (`default-src 'self'; script-src 'self'; style-src 'self'; … object-src 'none'`).
  - No `innerHTML`.
  - Never set a `style` attribute: use classes or `el.style.setProperty`.
- **Writes:** every write is one transaction. Fingerprints are computed before the transaction opens. Inside a transaction, await only `Tx` calls.
- **Shipped files:**
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL`; a unit test checks this.
  - After any shipped file changes, run `npm run stamp` to re-stamp `sw.js`. `npm run check` and CI fail when the stamp is stale.
  - Shipped JS + CSS stays under 300 KiB (`npm run size`).
- **Copy:** plain words. Every error says what happened and what to do next.
- **Removal rules (spec §4.9):**
  - No recycle bin and no automatic clean-up: "Removing a trip deletes it from the device and frees its space at once."
  - Deleting a photo or file inside a trip still keeps its history (§4.2). Only removing a trip frees space.
- **Ports and WebKit:** the dev server and Playwright use port 8790. WebKit runs in Docker on hosts without its libraries:
  `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`.

## Review Focus

These are failure modes the spec implies but no feature test covers. Each line names the test that pins it.

1. **Content shared by two trips.** The same photo can be in two trips, for example a trip imported as a new copy, since content is stored once. Removing one trip must leave the other whole, including the older versions in its history.
   Pinned by Task 2: "removeTrip keeps content another trip uses, now or in its history".
2. **A removal while an import runs.** An import that found its content already stored skips storing it. If a trip removal then deletes that content, the import must fail cleanly and work when run again. It must never create files that point at missing content.
   Pinned by Task 4: "an import whose content is removed before it finishes imports nothing and can be run again".
3. **Backup edge cases.**
   - Archiving or unarchiving after a Backup is not a change.
   - A Backup built before an edit and saved after it doesn't cover the edit.
   - A Share, or a Backup with a box unticked, never counts.
   - A backup record never travels inside an archive.

   Pinned by Task 3: "a trip counts as backed up…", "a Backup built before a change…", "only a Backup with everything ticked counts", "a trip's backup record stays on the device that made it".
4. **Phones that already have data.** A version-1 database must gain the size index on first start, with every stored blob listed.
   Pinned by Task 1's browser test: "idb: a version-1 database gains the blob-size index and keeps its blobs".
   Related: a Backup saved while storage is full must still say it was saved. Pinned by Task 5 e2e: "a Backup saved while storage is full still says it was saved".
5. **Space actually coming back on the phone.** The e2e test proves the content is gone from the database (Task 6: "remove a trip: asks once, and again only when it changed after its last Backup"). Safari may give disk space back to the system later than Chrome. The device checklist (Task 7) measures it on both phones.

## Not in this milestone

- **"Delete trace bodies or cached photo copies" on the storage-full card** (§17). Neither exists until milestone 2.
- **A size per trip on its card.** It isn't in the spec. The toast after removing a trip says how much was freed.
- **Freeing space when a photo or file is deleted inside a trip.** By design (§4.9) it stays in the history, and its space comes back when the trip is removed.

## File structure

```
src/core/types.js            + ScopeRecord.backup; Tx.listBlobs
src/core/store-memory.js     + listBlobs
src/core/store-idb.js        DB_VERSION 2: blobs.size index; listBlobs
src/core/events.js           + blobsOf(event)
src/core/scopes.js           + removeTrip, recordBackup, backupState
src/core/archive.js          blobsOf in export; isFullBackup; exportArchive returns seqs, leaves backup
                             out of manifests; import drops backup; the import commit checks its content
src/core/errors.js           storage-full message
src/ui/ask.js                ask(): a modal question (new file; listed in sw.js SHELL)
src/ui/base.css              + dialog.ask
src/ui/format.js             + backupText
src/ui/export-panel.js       notes a saved Backup on its trips; a full device can't hide that the file saved
src/ui/storage-full.js       advice that frees space; Go to Trips
src/ui/screens/trips.js      backup status on trip cards
src/ui/screens/trip.js       Remove trip
sw.js                        SHELL + /src/ui/ask.js; BUILD re-stamped
test/contract/store-contract.js, test/browser/suites/store-idb.js, test/unit/scopes.test.js,
test/unit/archive.test.js, test/unit/ui-pure.test.js, test/e2e/trips.spec.js
docs/testing/device-checklist-m1c.md
```

---

### Task 1: Blob sizes without reading content

**Files:**
- Modify: `src/core/types.js` (the `Tx` typedef)
- Modify: `src/core/store-memory.js` (`makeTx`)
- Modify: `src/core/store-idb.js` (`DB_VERSION`, `openDatabase`, `upgrade`, `makeTx`)
- Test: `test/contract/store-contract.js`, `test/browser/suites/store-idb.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Tx.listBlobs(): Promise<{ hash: string, size: number }[]>`, which gives every blob's hash and size and never reads its content (any order). `DB_VERSION === 2`.

- [ ] **Step 1: Write the failing contract test**

Add to `test/contract/store-contract.js`, after the test `'blobs: put, has, get and delete'`:

```js
  test('blobs: listBlobs gives every hash and size, not the content', async () => {
    const s = await makeStore();
    await s.tx(['blobs'], 'readwrite', async (t) => {
      await t.putBlob({ hash: 'b', type: 'image/webp', size: 5, data: buf('hello') });
      await t.putBlob({ hash: 'a', type: 'text/plain', size: 2, data: buf('hi') });
    });
    const list = await s.tx(['blobs'], 'readonly', (t) => t.listBlobs());
    assert.deepEqual([...list].sort((x, y) => (x.hash < y.hash ? -1 : 1)), [{ hash: 'a', size: 2 }, { hash: 'b', size: 5 }]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/store-memory.test.js`
Expected: FAIL in "blobs: listBlobs gives every hash and size, not the content", with `t.listBlobs is not a function`.

- [ ] **Step 3: Implement it in the memory store and the type**

In `src/core/types.js`, add a line after the `deleteBlob` property:

```js
 * @property {() => Promise<{ hash: string, size: number }[]>} listBlobs  every blob's hash and size, without reading its content
```

In `src/core/store-memory.js`, add this to the `t` object after `deleteBlob`:

```js
    async listBlobs() { return [...use('blobs').values()].map((b) => ({ hash: b.hash, size: b.size })); },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/unit/store-memory.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing browser tests**

In `test/browser/suites/store-idb.js`, change the import to bring in `DB_VERSION`:

```js
import { createIdbStore, eraseDatabase, openDatabase, DB_VERSION } from '../../../src/core/store-idb.js';
```

Replace the body of `'idb: opening waits while another connection blocks an upgrade, instead of failing'`. Today's database is already at version 2, so the upgrade has to go one past it:

```js
  test('idb: opening waits while another connection blocks an upgrade, instead of failing', async () => {
    const name = `annai-test-blocked-${Date.now()}`;
    await eraseDatabase(name);
    const old = await openDatabase(name);
    // An old connection with no versionchange handler, like a service worker mid-read.
    setTimeout(() => old.close(), 100);
    const upgraded = await openDatabase(name, DB_VERSION + 1);
    assert.equal(upgraded.version, DB_VERSION + 1);
    upgraded.close();
    await eraseDatabase(name);
  });
```

Add a test at the end of the suite:

```js
  test('idb: a version-1 database gains the blob-size index and keeps its blobs', async () => {
    const name = `annai-test-v1-${Date.now()}`;
    await eraseDatabase(name);
    // Version 1 exactly as milestone 1 shipped it, holding one photo.
    const v1 = await /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        /** @type {[string, string | string[]][]} */
        const stores = [['blobs', 'hash'], ['files', ['scope', 'path']], ['events', ['scope', 'seq']], ['secrets', 'id'], ['scopes', 'id']];
        for (const [store, keyPath] of stores) r.result.createObjectStore(store, { keyPath });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
    await new Promise((resolve, reject) => {
      const tx = v1.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ hash: 'abc', type: 'image/webp', size: 3, data: new Uint8Array([1, 2, 3]).buffer });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    v1.close();
    const s = await createIdbStore(name);
    assert.deepEqual(await s.tx(['blobs'], 'readonly', (t) => t.listBlobs()), [{ hash: 'abc', size: 3 }]);
    s.close();
    await eraseDatabase(name);
  });
```

- [ ] **Step 6: Run the browser suite to verify it fails**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js -g store-idb`
Expected: FAIL in both engines. The contract's listBlobs test and the version-1 test fail with `t.listBlobs is not a function`.

- [ ] **Step 7: Implement the migration and listBlobs in IndexedDB**

In `src/core/store-idb.js`:

```js
export const DB_VERSION = 2;
```

In `openDatabase`, pass the versionchange transaction to `upgrade`:

```js
    req.onupgradeneeded = (e) => upgrade(req.result, /** @type {IDBTransaction} */ (req.transaction), e.oldVersion);
```

Replace `upgrade`:

```js
/**
 * Ordered migrations, each in the all-or-nothing versionchange transaction (spec §4.6).
 * @param {IDBDatabase} db @param {IDBTransaction} tx @param {number} from
 */
function upgrade(db, tx, from) {
  if (from < 1) {
    db.createObjectStore('blobs', { keyPath: 'hash' });
    db.createObjectStore('files', { keyPath: ['scope', 'path'] });
    db.createObjectStore('events', { keyPath: ['scope', 'seq'] });
    db.createObjectStore('secrets', { keyPath: 'id' });
    db.createObjectStore('scopes', { keyPath: 'id' });
  }
  // 2: blob sizes can be listed without reading any content (spec §4.9).
  if (from < 2) tx.objectStore('blobs').createIndex('size', 'size');
}
```

In `makeTx`, add this to the `tx` object after `deleteBlob`. A key cursor on the index yields the size as the key and the hash as the primary key, and never loads a value:

```js
    listBlobs: () => new Promise((res, rej) => {
      /** @type {{ hash: string, size: number }[]} */
      const out = [];
      const r = os('blobs').index('size').openKeyCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) {
          res(out);
          return;
        }
        out.push({ hash: /** @type {string} */ (c.primaryKey), size: /** @type {number} */ (c.key) });
        c.continue();
      };
      r.onerror = () => rej(r.error);
    }),
```

- [ ] **Step 8: Run the browser suite to verify it passes**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js -g store-idb`
Expected: PASS, 2 tests (Chromium and WebKit).

- [ ] **Step 9: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: typecheck clean, all unit tests pass, size under budget, stamp current.

```bash
git add src/core/types.js src/core/store-memory.js src/core/store-idb.js sw.js test/contract/store-contract.js test/browser/suites/store-idb.js
git commit -m "The store lists blob sizes without reading content (IndexedDB version 2)"
```

---

### Task 2: removeTrip frees what nothing else uses

**Files:**
- Modify: `src/core/events.js` (add `blobsOf`)
- Modify: `src/core/archive.js` (the export's history loop uses `blobsOf`)
- Modify: `src/core/scopes.js` (add `removeTrip`)
- Test: `test/unit/scopes.test.js`

**Interfaces:**
- Consumes: `Tx.listBlobs()` from Task 1.
- Produces:
  - `blobsOf(event: { data?: any, refs?: string[] }): string[]` (events.js). It lists the content an event points at: `data.old` and `data.new` when they are strings, then each string in `refs`.
  - `removeTrip(store: Store, id: string, now?: number): Promise<{ title: string, bytes: number }>` (scopes.js). In one transaction it:
    - deletes the trip's record, files and events;
    - deletes every blob that no remaining scope's file or event points at;
    - appends `trip.remove { title, bytes }` to `SYS`.

    It rejects with `Error("trip <id> doesn't exist")` for an unknown id or a scope that isn't a trip.

- [ ] **Step 1: Write the failing tests**

In `test/unit/scopes.test.js`, extend the imports:

```js
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, kindOf, newId, ensureBaseScopes, createTrip, listTrips, setTripStatus, syncTripTitles, removeTrip } from '../../src/core/scopes.js';
import { logEvent, blobsOf } from '../../src/core/events.js';
```

Remove the old `import { logEvent } from '../../src/core/events.js';` line. Then add at the end of the file:

```js
/** @typedef {import('../../src/core/types.js').Store} Store */

/** Every stored blob, hash → size. @param {Store} store */
const storedBlobs = async (store) => new Map((await store.tx(['blobs'], 'readonly', (t) => t.listBlobs())).map((b) => [b.hash, b.size]));

test('blobsOf lists the content an event points at', () => {
  assert.deepEqual(blobsOf({ data: { path: '/a', old: 'h1', new: 'h2' }, refs: ['h3'] }), ['h1', 'h2', 'h3']);
  assert.deepEqual(blobsOf({ data: { old: null, new: 7 } }), []);
  assert.deepEqual(blobsOf({}), []);
});

test('removeTrip removes the trip, its files and history, and frees the content only it used', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const before = await storedBlobs(store);
  const id = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(id, '/files/a.webp', new Uint8Array(3000).fill(7), { author: 'user' });
  await ws.write(id, '/notes/day1.md', 'first', { author: 'user' });
  await ws.write(id, '/notes/day1.md', 'second', { author: 'user' }); // "first" is an older version now
  await ws.write(id, '/files/b.webp', new Uint8Array(2000).fill(8), { author: 'user' });
  await ws.delete(id, '/files/b.webp', { author: 'user' }); // a deleted file, kept by its history until now
  const added = [...(await storedBlobs(store))].filter(([hash]) => !before.has(hash));
  assert.ok(added.length >= 6);
  const result = await removeTrip(store, id);
  assert.deepEqual(result, { title: 'Big Sur', bytes: added.reduce((n, [, size]) => n + size, 0) });
  assert.deepEqual([...(await storedBlobs(store)).keys()].sort(), [...before.keys()].sort());
  const left = await store.tx(['scopes', 'files', 'events'], 'readonly', async (t) => ({
    scope: await t.getScope(id), files: await t.listFiles(id, '/'), events: await t.listEvents(id),
    log: await t.listEvents(SYS, { types: ['trip.remove'] }),
  }));
  assert.equal(left.scope, undefined);
  assert.deepEqual(left.files, []);
  assert.deepEqual(left.events, []);
  assert.deepEqual(left.log.map((e) => e.data), [{ title: 'Big Sur', bytes: result.bytes }]);
});

test('removeTrip keeps content another trip uses, now or in its history', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const photo = new Uint8Array(3000).fill(7);
  const a = await createTrip(ws, { title: 'A' });
  const b = await createTrip(ws, { title: 'B' });
  await ws.write(a, '/files/p.webp', photo, { author: 'user' });
  await ws.write(b, '/files/same.webp', photo, { author: 'user' }); // the same photo, stored once
  await ws.write(a, '/notes/n.md', 'old', { author: 'user' });
  await ws.write(b, '/notes/n.md', 'old', { author: 'user' });
  await ws.write(b, '/notes/n.md', 'new', { author: 'user' }); // in B, "old" is history now
  const [first] = await ws.history(b, '/notes/n.md');
  await removeTrip(store, a);
  assert.deepEqual((await ws.read(b, '/files/same.webp'))?.bytes, photo);
  await ws.restore(b, '/notes/n.md', /** @type {string} */ (first.new), { author: 'user' });
  assert.equal(await ws.readText(b, '/notes/n.md'), 'old');
});

test('removeTrip also frees content nothing refers to, and keeps what any log points at', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const id = await createTrip(ws, { title: 'Big Sur' });
  const orphan = 'a'.repeat(64); // left behind by an interrupted restore
  const traced = 'b'.repeat(64); // a body the system log points at
  await store.tx(['blobs'], 'readwrite', async (t) => {
    for (const hash of [orphan, traced]) await t.putBlob({ hash, type: 'application/octet-stream', size: 4, data: new Uint8Array(4).buffer });
  });
  await logEvent(store, SYS, { type: 'net.request', refs: [traced] });
  await removeTrip(store, id);
  const left = await storedBlobs(store);
  assert.equal(left.has(orphan), false);
  assert.equal(left.has(traced), true);
});

test('removeTrip removes only trips', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  await assert.rejects(removeTrip(store, ME), /doesn't exist/);
  await assert.rejects(removeTrip(store, 'trip-missing'), /doesn't exist/);
  assert.ok(await store.tx(['scopes'], 'readonly', (t) => t.getScope(ME)));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/scopes.test.js`
Expected: FAIL. The module doesn't load, because `events.js` provides no export named `blobsOf`.

- [ ] **Step 3: Implement blobsOf and use it in the export**

Add to `src/core/events.js`:

```js
/**
 * Every blob an event points at: a file version's old and new content, then its refs (spec §4.5).
 * @param {{ data?: any, refs?: string[] }} e @returns {string[]}
 */
export function blobsOf(e) {
  /** @type {string[]} */
  const out = [];
  for (const h of [e.data?.old, e.data?.new]) if (typeof h === 'string') out.push(h);
  for (const r of e.refs ?? []) if (typeof r === 'string') out.push(r);
  return out;
}
```

In `src/core/archive.js`, import it:

```js
import { blobsOf } from './events.js';
```

Replace the history loop in `exportArchive`. Today it reads:

```js
      for (const e of events) {
        for (const h of [e.data?.old, e.data?.new]) if (typeof h === 'string') historic.add(h);
        for (const r of e.refs ?? []) historic.add(r);
      }
```

Replace it with:

```js
      for (const e of events) for (const h of blobsOf(e)) historic.add(h);
```

- [ ] **Step 4: Implement removeTrip**

In `src/core/scopes.js`, add the import:

```js
import { blobsOf } from './events.js';
```

Then add after `setTripStatus`:

```js
/**
 * Removes a trip from this device for good: its record, files and history, and every stored
 * content nothing else uses, so its space comes back at once (spec §4.9). One transaction:
 * all of it goes, or none of it.
 * @param {Store} store @param {string} id @param {number} [now]
 * @returns {Promise<{ title: string, bytes: number }>} bytes: the size of the content removed
 */
export async function removeTrip(store, id, now = Date.now()) {
  return store.tx(['scopes', 'files', 'events', 'blobs'], 'readwrite', async (t) => {
    const rec = await t.getScope(id);
    if (!rec || rec.kind !== 'trip') throw new Error(`trip ${id} doesn't exist`);
    await t.deleteScope(id);
    /** @type {Set<string>} */
    const used = new Set();
    for (const s of await t.listScopes()) {
      for (const f of await t.listFiles(s.id, '/')) used.add(f.hash);
      for (const e of await t.listEvents(s.id)) for (const h of blobsOf(e)) used.add(h);
    }
    let bytes = 0;
    for (const b of await t.listBlobs()) {
      if (used.has(b.hash)) continue;
      await t.deleteBlob(b.hash);
      bytes += b.size;
    }
    await t.appendEvent(SYS, { ts: now, type: 'trip.remove', actor: 'user', data: { title: rec.title, bytes } });
    return { title: rec.title, bytes };
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/scopes.test.js test/unit/archive.test.js`
Expected: PASS, all tests. The archive tests show the export's history loop still works.

- [ ] **Step 6: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/events.js src/core/archive.js src/core/scopes.js sw.js test/unit/scopes.test.js
git commit -m "removeTrip: a trip's record, files and history go, with all content nothing else uses"
```

---

### Task 3: Each trip knows when it was last backed up

**Files:**
- Modify: `src/core/types.js` (the `ScopeRecord` typedef)
- Modify: `src/core/scopes.js` (add `recordBackup`, `backupState`)
- Modify: `src/core/archive.js` (`isFullBackup`; `exportArchive` returns `seqs` and leaves `backup` out of the manifest; `commitImport` drops `backup`)
- Test: `test/unit/scopes.test.js`, `test/unit/archive.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ScopeRecord.backup?: { at: number, seq: number }`: the last saved Backup that held this trip. `at` is when it was saved; `seq` is the last history entry it holds.
  - `recordBackup(store: Store, seqs: Map<string, number>, at: number): Promise<void>` (scopes.js). It sets `backup` on each trip in `seqs`. It skips scopes that aren't trips, trips that are gone, and Backups older than the one already recorded.
  - `backupState(store: Store, id: string): Promise<{ at: number | null, changed: boolean }>` (scopes.js). `changed` is true when the trip was never backed up, or when its log has a later entry that isn't `scope.archive` or `scope.unarchive`.
  - `isFullBackup(include: Include, share: boolean): boolean` (archive.js). It is true only for a non-Share export with history, memory and photos all ticked.
  - `exportArchive(...)` also returns `seqs: Map<string, number>`: scope id → the last history entry the archive holds. It is empty without history.

- [ ] **Step 1: Write the failing tests**

In `test/unit/scopes.test.js`, add `recordBackup` and `backupState` to the scopes import:

```js
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, kindOf, newId, ensureBaseScopes, createTrip, listTrips, setTripStatus, syncTripTitles, removeTrip, recordBackup, backupState } from '../../src/core/scopes.js';
```

Then add:

```js
/** The last history entry of a scope. @param {Store} store @param {string} id */
const lastSeq = (store, id) => store.tx(['events'], 'readonly', (t) => t.lastSeq(id));

test('a trip counts as backed up from a recorded Backup until it changes (spec §4.9)', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: 'Big Sur' });
  assert.deepEqual(await backupState(store, id), { at: null, changed: true });
  await recordBackup(store, new Map([[id, await lastSeq(store, id)]]), 5000);
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: false });
  await setTripStatus(store, id, 'archived');
  await setTripStatus(store, id, 'active');
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: false }, 'archiving changes nothing the Backup holds');
  await ws.write(id, '/notes/day1.md', 'Bixby Bridge', { author: 'user' });
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: true });
});

test('a Backup built before a change and saved after it does not cover the change', async () => {
  const { store, ws } = setup();
  const id = await createTrip(ws, { title: 'Big Sur' });
  const built = await lastSeq(store, id);
  await ws.write(id, '/notes/day1.md', 'written while the file was being built', { author: 'user' });
  await recordBackup(store, new Map([[id, built]]), 5000);
  assert.equal((await backupState(store, id)).changed, true);
});

test('recordBackup skips what is not a trip, trips that are gone, and older Backups', async () => {
  const { store, ws } = setup();
  await ensureBaseScopes(ws);
  const id = await createTrip(ws, { title: 'Big Sur' });
  const seq = await lastSeq(store, id);
  await recordBackup(store, new Map([[ME, 1], ['trip-gone', 1], [id, seq]]), 5000);
  assert.equal((await store.tx(['scopes'], 'readonly', (t) => t.getScope(ME)))?.backup, undefined);
  await recordBackup(store, new Map([[id, seq - 1]]), 9000);
  assert.deepEqual(await backupState(store, id), { at: 5000, changed: false });
});
```

In `test/unit/archive.test.js`, extend the imports:

```js
import { kindOf, ensureBaseScopes, createTrip, listTrips, ME, SYS_SETTINGS, recordBackup, backupState } from '../../src/core/scopes.js';
import { exportArchive, openArchive, describeArchive, importArchive, archiveName, isFullBackup, PRESETS, ArchiveError, NeedsPassphraseError, MANIFEST_NAME } from '../../src/core/archive.js';
```

Then add:

```js
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
  const opened = await openArchive(await bytesOf(blob));
  opened.manifest.scopes[0].record.backup = { at: 1, seq: 999 }; // as an older or hand-made file might say
  const [copy] = (await importArchive(b.store, opened)).trips;
  assert.deepEqual(await backupState(b.store, copy), { at: null, changed: true });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/unit/scopes.test.js test/unit/archive.test.js`
Expected: FAIL. The modules don't load, because `scopes.js` provides no export named `recordBackup` and `archive.js` none named `isFullBackup`.

- [ ] **Step 3: Implement the type and the scope functions**

In `src/core/types.js`, replace the `ScopeRecord` typedef with:

```js
 * @typedef {{ id: string, kind: 'me'|'trip'|'sys', title: string, status: 'active'|'archived',
 *   created: number, updated: number, format: number, tripId?: string, backup?: { at: number, seq: number } }} ScopeRecord
 *   backup: the last saved Backup that held this trip: when, and the last history entry it holds (spec §4.9).
```

In `src/core/scopes.js`, add after `removeTrip`:

```js
/** Changes to a trip's status, not to what it holds: a Backup made before them still has everything (spec §4.9). */
const STATUS_ONLY = new Set(['scope.archive', 'scope.unarchive']);

/**
 * Notes a saved Backup on each trip it held (spec §4.9). A scope that isn't a trip, a trip
 * that is gone, and a Backup older than the one already noted are left alone.
 * @param {Store} store @param {Map<string, number>} seqs scope id → the last history entry the Backup holds
 * @param {number} at when it was saved
 */
export async function recordBackup(store, seqs, at) {
  await store.tx(['scopes'], 'readwrite', async (t) => {
    for (const [id, seq] of seqs) {
      const rec = await t.getScope(id);
      if (rec?.kind !== 'trip' || (rec.backup && rec.backup.seq > seq)) continue;
      await t.putScope({ ...rec, backup: { at, seq } });
    }
  });
}

/**
 * When the trip was last backed up, and whether it changed after that (spec §4.9).
 * @param {Store} store @param {string} id
 * @returns {Promise<{ at: number | null, changed: boolean }>} at is null when it never was
 */
export async function backupState(store, id) {
  return store.tx(['scopes', 'events'], 'readonly', async (t) => {
    const backup = (await t.getScope(id))?.backup;
    if (!backup) return { at: null, changed: true };
    const later = await t.listEvents(id, { after: backup.seq });
    return { at: backup.at, changed: later.some((e) => !STATUS_ONLY.has(e.type)) };
  });
}
```

- [ ] **Step 4: Implement the archive side**

In `src/core/archive.js`, add after `PRESETS`:

```js
/**
 * Whether an export counts as backing its trips up: a Backup with everything ticked (spec §4.9).
 * A Share leaves out the conversation and the history.
 * @param {Include} include @param {boolean} share
 */
export function isFullBackup(include, share) {
  return !share && include.history && include.memory && include.photos;
}
```

In `exportArchive`:

1. Next to the `current` and `historic` sets, declare:

   ```js
     /** @type {Map<string, number>} */ const seqs = new Map();
   ```

2. Replace `const ms = { dir, record: scope };` (and the JSDoc line above it) with the following. A backup note belongs to the device that made it, so it stays out of the archive:

   ```js
       const { backup: _, ...record } = scope; // a backup note belongs to the device that made it
       /** @type {ManifestScope} */
       const ms = { dir, record };
   ```

3. Inside `if (events.length) {`, as its first line, add:

   ```js
         seqs.set(scope.id, events[events.length - 1].seq);
   ```

4. Change the return statement to include `seqs`:

   ```js
     return { blob, manifest, skipped, seqs, filename: archiveName({ kind: opts.kind, title, encrypted: Boolean(opts.passphrase), now }) };
   ```

5. Update the `@returns` line of `exportArchive`'s JSDoc to:

   ```js
    * @returns {Promise<{ blob: Blob, filename: string, manifest: Manifest, skipped: string[], seqs: Map<string, number> }>}
    *   skipped: photos left out of a Share because their location couldn't be removed;
    *   seqs: scope id → the last history entry the archive holds (empty without history)
   ```

In `commitImport`, replace the line

```js
      await t.putScope({ ...p.rec, id: p.target, kind, status: 'active', updated: now });
```

with:

```js
      const { backup: _b, ...rec } = p.rec; // this device hasn't backed it up
      await t.putScope({ ...rec, id: p.target, kind, status: 'active', updated: now });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/scopes.test.js test/unit/archive.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/types.js src/core/scopes.js src/core/archive.js sw.js test/unit/scopes.test.js test/unit/archive.test.js
git commit -m "Trips record their last Backup; any later change except archiving counts"
```

---

### Task 4: An import never points at content removed meanwhile

**Files:**
- Modify: `src/core/archive.js` (`importArchive` passes its content hashes to `commitImport`, which checks them)
- Test: `test/unit/archive.test.js`

**Interfaces:**
- Consumes: `removeTrip` from Task 2.
- Produces: `importArchive` rejects with `ArchiveError("Part of this file's content was removed from this device while it was importing, so nothing was imported. Import it again.")` when content it counted on is gone at its last step.

- [ ] **Step 1: Write the failing test**

In `test/unit/archive.test.js`, add `removeTrip` to the scopes import:

```js
import { kindOf, ensureBaseScopes, createTrip, listTrips, ME, SYS_SETTINGS, recordBackup, backupState, removeTrip } from '../../src/core/scopes.js';
```

Then add:

```js
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
  await assert.rejects(importArchive(racing, await openArchive(bytes)), (e) => e instanceof ArchiveError && /Import it again/.test(e.message));
  assert.deepEqual((await listTrips(a.store)).active, []);
  const [copy] = (await importArchive(a.store, await openArchive(bytes))).trips;
  assert.deepEqual((await a.ws.read(copy, '/files/photo.jpg'))?.bytes, photo);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/archive.test.js`
Expected: FAIL in "an import whose content is removed before it finishes…", with `Missing expected rejection`. Without the check, the import succeeds and its files point at content that is gone.

- [ ] **Step 3: Implement the check**

In `importArchive`, change the call to `commitImport` to pass the hashes:

```js
    await commitImport(store, { manifest, plan, overrides, secrets, now, result, hashes: [...content.keys()] });
```

In `commitImport`'s JSDoc, add `hashes: string[]` to the job type. The second line becomes:

```js
 *   overrides: Map<string, { bytes: Uint8Array, hash: string }>, secrets: { id: string, value: any }[], now: number, hashes: string[],
```

Destructure `hashes` in its signature:

```js
async function commitImport(store, { manifest, plan, overrides, secrets, now, result, hashes }) {
```

As the first statement inside its transaction callback, before `for (const p of plan) {`, add:

```js
    // Content stored earlier, or found already here, may have gone since: a trip removed meanwhile (spec §4.9).
    for (const h of hashes) {
      if (!(await t.hasBlob(h))) throw new ArchiveError("Part of this file's content was removed from this device while it was importing, so nothing was imported. Import it again.");
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/unit/archive.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Stamp, check, commit**

Run: `npm run stamp && npm run check`
Expected: all green.

```bash
git add src/core/archive.js sw.js test/unit/archive.test.js
git commit -m "An import fails cleanly when its content is removed while it runs"
```

---

### Task 5: Backups in the UI

**Files:**
- Modify: `src/ui/format.js` (add `backupText`)
- Modify: `src/ui/export-panel.js` (records a saved Backup; a full device can't hide that the file saved)
- Modify: `src/ui/screens/trips.js` (backup status on every trip card)
- Test: `test/unit/ui-pure.test.js`, `test/e2e/trips.spec.js`

**Interfaces:**
- Consumes: `recordBackup` and `backupState` (Task 3), `isFullBackup`, and `exportArchive(...).seqs` (Task 3).
- Produces: `backupText(state: { at: number | null, changed: boolean }, now?: number): string`. It returns `'not backed up'`, `'backed up <relTime>'`, or `'backed up <relTime>, changed since'`.

- [ ] **Step 1: Write the failing unit test**

In `test/unit/ui-pure.test.js`, add `backupText` to the format import:

```js
import { relTime, bytes, dateRange, takenText, backupText } from '../../src/ui/format.js';
```

Then add:

```js
test('backupText: never, up to date, and changed since (spec §4.9)', () => {
  const now = Date.UTC(2026, 10, 25);
  assert.equal(backupText({ at: null, changed: true }, now), 'not backed up');
  assert.match(backupText({ at: now - 2 * 86400_000, changed: false }, now), /^backed up 2 days ago$/);
  assert.match(backupText({ at: now - 2 * 86400_000, changed: true }, now), /^backed up 2 days ago, changed since$/);
});
```

- [ ] **Step 2: Write the failing e2e tests**

In `test/e2e/trips.spec.js`, import `buildAndSave`:

```js
import { openApp, buildAndSave } from './helpers.js';
```

Then add:

```js
test('a trip card says when the trip was last backed up, and when it changed since', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const card = page.getByRole('link', { name: /Big Sur/ });
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(card).toContainText('not backed up');
  await card.click();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(card).toContainText('backed up just now');
  await expect(card).not.toContainText('changed since');
  await card.click();
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(card).toContainText('changed since');
});

test('a Backup saved while storage is full still says it was saved', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByRole('button', { name: 'Export trip' }).click();
  await page.getByRole('button', { name: 'Build file' }).click();
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeVisible();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });
  const downloading = page.waitForEvent('download');
  await save.click();
  await downloading;
  await expect(page.getByText('Saved to your downloads.')).toBeVisible();
  await expect(page.getByText("annai's storage is full", { exact: true })).toBeVisible();
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL. The module doesn't load, because `format.js` provides no export named `backupText`.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/trips.spec.js`
Expected: FAIL in both engines.
- The card test fails waiting for `not backed up`.
- The storage-full test fails waiting for `Saved to your downloads.`: today the panel notes the export before it shows that, and on a full device the note throws.

- [ ] **Step 4: Implement backupText**

Add to `src/ui/format.js`:

```js
/**
 * A trip's backup status for its card (spec §4.9, §16.2).
 * @param {{ at: number | null, changed: boolean }} state @param {number} [now]
 */
export function backupText({ at, changed }, now = Date.now()) {
  if (at === null) return 'not backed up';
  return `backed up ${relTime(at, now)}${changed ? ', changed since' : ''}`;
}
```

- [ ] **Step 5: Record saved Backups in the export panel**

In `src/ui/export-panel.js`, change the imports:

```js
import { exportArchive, PRESETS, isFullBackup } from '../core/archive.js';
import { recordBackup } from '../core/scopes.js';
import { explainStorageFull } from './storage-full.js';
```

Replace the `built` declaration with:

```js
  /** @type {{ blob: Blob, filename: string, seqs: Map<string, number>, full: boolean } | null} */
  let built = null;
```

Replace the `saveBtn` `onclick` body with:

```js
    onclick: async () => {
      if (!built) return;
      const how = await saveFile(built.blob, built.filename);
      if (how === 'cancelled') return;
      status.textContent = how === 'shared' ? 'Shared.' : 'Saved to your downloads.';
      try {
        if (built.full) await recordBackup(ctx.store, built.seqs, Date.now());
        await updateAppSettings(ctx.ws, { lastExportAt: Date.now() });
      } catch (e) {
        // The file is saved either way; only annai's note of it failed (spec §17).
        if (!explainStorageFull(ctx, e)) throw e;
      }
    },
```

In the `build` button's `onclick`, replace the `exportArchive` call and `built = result;` with code that keeps what the file was built as. The ticks may change before Save is tapped:

```js
        const include = { history: history.input.checked, memory: memory.input.checked, photos: photos.input.checked };
        const result = await exportArchive(ctx.store, {
          kind: what.kind, scopes: what.scopes, include,
          secrets: keys?.input.checked ?? false, passphrase: pass1.value || undefined, app: ctx.version, share,
        });
        built = { ...result, full: isFullBackup(include, Boolean(share)) };
```

- [ ] **Step 6: Show the backup status on trip cards**

In `src/ui/screens/trips.js`, change the imports:

```js
import { listTrips, createTrip, backupState } from '../../core/scopes.js';
import { relTime, dateRange, backupText } from '../format.js';
```

In `renderTrips`, replace the `cards` line, and the archived list's `...archived.map((s) => tripCard(s, null))`, with versions that read each trip's backup state:

```js
  const cards = await Promise.all(active.map(async (s) => tripCard(s, await ctx.ws.readJSON(s.id, '/trip.json').catch(() => null), await backupState(ctx.store, s.id))));
  const archivedCards = await Promise.all(archived.map(async (s) => tripCard(s, null, await backupState(ctx.store, s.id))));
```

```js
      ? h('details', { class: 'archived' }, h('summary', { text: `Archived trips (${archived.length})` }), h('ul', { class: 'cards' }, ...archivedCards))
```

Replace `tripCard` with:

```js
/** @param {any} s @param {any} trip @param {{ at: number | null, changed: boolean }} backup */
function tripCard(s, trip, backup) {
  const when = trip?.start ? dateRange(trip.start, trip.end) : null;
  return h('li', {}, h('a', { class: 'card', href: `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'name', text: s.title }),
    h('span', { class: 'sub', text: [when, `updated ${relTime(s.updated)}`, backupText(backup)].filter(Boolean).join(' · ') })));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.

Run: `npm run stamp && docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/trips.spec.js test/e2e/roundtrip.spec.js`
Expected: PASS in both engines.

- [ ] **Step 8: Check, commit**

Run: `npm run check`
Expected: all green.

```bash
git add src/ui/format.js src/ui/export-panel.js src/ui/screens/trips.js sw.js test/unit/ui-pure.test.js test/e2e/trips.spec.js
git commit -m "Trip cards say when each trip was last backed up; saving a Backup records it"
```

---

### Task 6: Remove trip, with its two questions

**Files:**
- Create: `src/ui/ask.js`
- Modify: `src/ui/base.css` (add `dialog.ask` styles)
- Modify: `src/ui/screens/trip.js` (the Remove trip button and flow)
- Modify: `sw.js` (`SHELL` gains `/src/ui/ask.js`)
- Test: `test/e2e/trips.spec.js`

**Interfaces:**
- Consumes: `removeTrip` (Task 2), `backupState` (Task 3), and Task 5's backup recording, which the e2e test uses.
- Produces: `ask({ title, body, yes, no? }): Promise<boolean>` (`src/ui/ask.js`). It shows a modal `<dialog>` named by `title`. It resolves `true` only when `yes` is tapped; Cancel and Escape resolve `false`. Focus starts on Cancel.

- [ ] **Step 1: Write the failing e2e tests**

Add to `test/e2e/trips.spec.js`:

```js
/** How many images annai has stored. @param {import('@playwright/test').Page} page @returns {Promise<number>} */
function storedImages(page) {
  return /** @type {Promise<number>} */ (page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const db = r.result;
      const all = db.transaction('blobs').objectStore('blobs').getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result.filter((b) => String(b.type).startsWith('image/')).length);
      };
      all.onerror = () => reject(all.error);
    };
    r.onerror = () => reject(r.error);
  })));
}

test('remove a trip: asks once, and again only when it changed after its last Backup', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
  expect(await storedImages(page)).toBe(1);

  // Escape is a no.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(page.getByRole('dialog', { name: 'Big Sur' })).toContainText('This removes everything in this trip from this device');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Never backed up: a second question, and Cancel keeps the trip.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  const warning = page.getByRole('dialog', { name: 'Not backed up' });
  await expect(warning).toContainText("This trip hasn't been backed up since it last changed. Remove it anyway?");
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

  // Backed up and unchanged: one question, then the trip and its photo are gone.
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText(/^Removed Big Sur\. .+ freed\.$/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(0);
  expect(await storedImages(page)).toBe(0);
});

test('an archived trip can be removed too', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Old trip');
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await page.getByText('Archived trips (1)').click();
  await page.getByRole('link', { name: /Old trip/ }).click();
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Old trip' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText(/Archived trips/)).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/trips.spec.js -g "remove|removed"`
Expected: FAIL in both engines, waiting for the button named `Remove trip`.

- [ ] **Step 3: Write ask()**

Create `src/ui/ask.js`:

```js
import { h } from './dom.js';

let n = 0;

/**
 * A modal question with two answers (spec §4.9). Resolves true only for `yes`; Cancel and
 * Escape resolve false. Focus starts on Cancel, so a stray Enter never confirms.
 * @param {{ title: string, body: string, yes: string, no?: string }} q
 * @returns {Promise<boolean>}
 */
export function ask({ title, body, yes, no = 'Cancel' }) {
  const id = `ask-${n++}`;
  return new Promise((resolve) => {
    /** @type {HTMLDialogElement} */
    const dialog = h('dialog', { class: 'ask', 'aria-labelledby': id },
      h('h2', { class: 'section', id, text: title }),
      h('p', { text: body }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('no') }, no),
        h('button', { class: 'btn danger', type: 'button', onclick: () => dialog.close('yes') }, yes)));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'yes');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
```

Add to `src/ui/base.css`, after the `.panel` rule:

```css
dialog.ask { width: min(100% - 32px, 420px); padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); color: var(--ink); }
dialog.ask::backdrop { background: rgb(0 0 0 / 0.45); }
dialog.ask .acts { justify-content: flex-end; }
```

In `sw.js`, add the new file to `SHELL` right after `'/src/ui/add-files.js',`:

```js
  '/src/ui/ask.js',
```

- [ ] **Step 4: Add Remove trip to the trip screen**

In `src/ui/screens/trip.js`, change the imports:

```js
import { setTripStatus, removeTrip, backupState } from '../../core/scopes.js';
import { ask } from '../ask.js';
```

In `renderTrip`, add the button to the `acts` row, after the Archive/Unarchive button:

```js
    h('div', { class: 'acts' },
      ...tripActions(ctx, id, scope, extra),
      archived
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setTripStatus(ctx.store, id, 'active'); ctx.render(); } }, 'Unarchive')
        : twoStep('Archive trip', 'Tap again to archive', async () => { await setTripStatus(ctx.store, id, 'archived'); ctx.go('#/trips'); }),
      h('button', { class: 'btn danger', type: 'button', onclick: () => removeFlow(ctx, id, scope) }, 'Remove trip')),
```

Add the flow after `tripActions`:

```js
/**
 * Remove trip (spec §4.9): asks once, and again only when the trip changed after its last Backup.
 * Then the trip is gone from this device and its space is free.
 * @param {any} ctx @param {string} id @param {any} scope
 */
async function removeFlow(ctx, id, scope) {
  const sure = await ask({ title: scope.title, body: 'This removes everything in this trip from this device: its files, photos, notes and history. Remove it?', yes: 'Remove' });
  if (!sure) return;
  if ((await backupState(ctx.store, id)).changed) {
    const anyway = await ask({ title: 'Not backed up', body: "This trip hasn't been backed up since it last changed. Remove it anyway?", yes: 'Remove anyway' });
    if (!anyway) return;
  }
  try {
    const { bytes: freed } = await removeTrip(ctx.store, id);
    ctx.notices.toast(`Removed ${scope.title}. ${bytes(freed)} freed.`);
    ctx.go('#/trips');
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: "That trip wasn't removed", body: `${/** @type {any} */ (e)?.message ?? e} Nothing was removed; try again.` });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run stamp && docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/trips.spec.js`
Expected: PASS in both engines.

- [ ] **Step 6: Check, commit**

Run: `npm run check`
Expected: all green. The SHELL test passes with `/src/ui/ask.js` listed.

```bash
git add src/ui/ask.js src/ui/base.css src/ui/screens/trip.js sw.js test/e2e/trips.spec.js
git commit -m "Remove trip: one question, a second only when it isn't backed up, then the space is free"
```

---

### Task 7: Storage-full advice, and the device checklist

**Files:**
- Modify: `src/ui/storage-full.js`, `src/core/errors.js`
- Create: `docs/testing/device-checklist-m1c.md`
- Test: `test/unit/ui-pure.test.js` (replaces the storage-full test)

**Interfaces:**
- Consumes: Remove trip (Task 6).
- Produces: the storage-full card's actions are `['Export a backup', 'Go to Trips']`.

- [ ] **Step 1: Rewrite the storage-full test**

In `test/unit/ui-pure.test.js`, replace the test `'a full device gets advice that frees space: deleting inside annai keeps the old versions (spec §4.2)'` with:

```js
test('a full device gets advice that frees space: removing a trip does, deleting inside one does not (spec §4.9)', () => {
  /** @type {any[]} */
  const cards = [];
  assert.equal(explainStorageFull({ notices: { card: (/** @type {any} */ c) => cards.push(c) }, go: () => {} }, new StorageFullError()), true);
  assert.equal(cards.length, 1);
  for (const advice of [cards[0].body, new StorageFullError().message]) {
    assert.match(advice, /remove a trip you no longer need/i);
    assert.match(advice, /free up space on this device/);
    assert.doesNotMatch(advice, /delet/i);
  }
  assert.deepEqual(cards[0].actions.map((/** @type {any} */ a) => a.label), ['Export a backup', 'Go to Trips']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL in "a full device gets advice…". The body says "Deleting things in annai doesn't free space yet", which doesn't match `/remove a trip you no longer need/i`.

- [ ] **Step 3: Change the copy and the actions**

In `src/core/errors.js`, change the `StorageFullError` message:

```js
    super("annai's storage on this device is full. Remove a trip you no longer need (back it up first), or free up space on this device.", cause === undefined ? undefined : { cause });
```

In `src/ui/storage-full.js`, replace the `card` call's comment, `body` and `actions`:

```js
    // Removing a trip frees its space; deleting inside a trip keeps its history (spec §4.9).
    body: 'Nothing was half-saved. To make room, remove a trip you no longer need (back it up first), or free up space on this device.',
    actions: [
      { label: 'Export a backup', primary: true, run: () => ctx.go('#/settings') },
      { label: 'Go to Trips', run: () => ctx.go('#/trips') },
    ],
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.

- [ ] **Step 5: Write the device checklist**

Create `docs/testing/device-checklist-m1c.md`:

```markdown
# Milestone 1c: device checklist (removing trips)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen, against a deployed preview or the dev server tunnelled over HTTPS.

## The questions
- [ ] Start a trip and add 30 photos. On Trips, its card says "not backed up".
- [ ] Open the trip and tap Remove trip. The first question names the trip. Cancel keeps it. Swipe or press Escape to dismiss it: the trip stays.
- [ ] Remove trip → Remove: "Not backed up" appears. Cancel keeps the trip.
- [ ] Export trip → Backup → Build file → Save file (Save to Files on the iPhone). On Trips, the card says "backed up just now".
- [ ] A Share export doesn't count: Export trip → Share → Save. The card still says when the last Backup was.
- [ ] Add a note to the trip: the card says "changed since". Archive and unarchive a backed-up, unchanged trip: the card doesn't.

## Space comes back
- [ ] In Settings, write down "Using X of about Y".
- [ ] Back up the trip with the 30 photos, then remove it. Only the first question appears. Trips shows "Removed <trip>. N MB freed.", and the card is gone.
- [ ] Settings shows usage lower by about N MB. If it hasn't dropped, close annai fully, reopen it, and look again. Write down what you saw on each phone: Safari's database may hand space back to the phone later than Chrome does, though annai reuses it either way.
- [ ] Import the Backup: the trip comes back with all 30 photos.

## Finish line
- [ ] Milestone 1c is done: on both phones, removing a trip full of photos gives its space back, and the backup warning shows exactly when the trip changed after its last Backup.
```

- [ ] **Step 6: Full verification and commit**

Run: `npm run stamp && npm run check`
Expected: all green.

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`
Expected: every test passes in both engines.

```bash
git add src/ui/storage-full.js src/core/errors.js sw.js test/unit/ui-pure.test.js docs/testing/device-checklist-m1c.md
git commit -m "Storage full suggests removing a trip; device checklist for milestone 1c"
```
