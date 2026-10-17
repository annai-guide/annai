# Milestone 9a: Backups to GitHub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic backup and restore to GitHub works (spec §20 row 9):
- **Backup places are plugins** (spec §5.4 `storage`, §12.4): a storage type has archive-level `check`, `list`, `put` and `get` (and `delete`, for places that keep whole files; milestone 9b). annai builds the Backup (§12.2) and decides when; the type moves it.
- **GitHub, through its Git Data API:** a backup is the archive's files, unpacked, as one commit; a file GitHub already has isn't uploaded again (§12.4).
- **Automatic:** after changes or once a day, on Wi-Fi, while annai is open (§12.4). The trips a backup holds count as backed up (§4.9).
- **Single writer:** a newer backup from another device pauses this device's backups to that place and offers to import it as a copy (§12.4).
- **Restore:** any backup at a place opens on the usual import screen (§12.3).

Milestone 9b (its own plan) adds S3-compatible storage and WebDAV, which keep the archive file itself.

**Architecture:**
- **Pure core modules:**
  - `src/core/backup-targets.js`: where this device backs up to, and what it last did there. A file in a new scope, `sys:device` ("This device"), which no archive carries. Secrets are `backup:<id>`.
  - `src/core/storage-types.js`: the storage type contract, `TargetError`, the registry lookup.
  - `src/core/backup.js`: `createBackups`, the service: add, update, check, back up, list, download, accept.
  - `src/core/backup-auto.js`: when a place is due (`dueNow`), what changed (`changedSince`), and the runner (`startAutoBackup`).

  All are unit-tested in Node.
- **The GitHub plugin** is official and on demand (`plugins-official/storage-github/`), installed when the user first adds a GitHub place (§5.3). `git.js` computes git's object ids with WebCrypto's SHA-1.
- **A stand-in GitHub** (`test/fakes/github.js`) runs on its own port, for unit and end-to-end tests. It implements the part of the REST API the plugin uses, with GitHub's status codes, messages and CORS headers, and hashes git objects with its own code.
- **The UI:** Settings → Backups (`#/backups`) lists the places and adds one; each place has its own screen (`#/backups/place?id=…`). Cards ask the user when a place waits for them. The import screen takes a backup from a place.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), and Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. Milestone 9 is §20 row 9. It covers:
- §12.4 backup targets
- §4.9 the backup time on trips
- §5.3–5.4 plugins: storage, on-demand install
- §12.2–12.3 the Backup preset and the import preview
- §15 keys never in context, files or the trace

Done when: automatic backup and restore to GitHub works. Task 8's end-to-end tests prove it against the stand-in in both browsers. The device checklist (`docs/testing/device-checklist-m9.md`) is the real thing: the user's own private repository and token, on both phones.

**Not in this plan:**
- **S3-compatible storage and WebDAV** (§12.4 "first targets"): milestone 9b, with encryption for whole-file places, keeping the last few backups, and the CORS JSON to paste.
- **"Before a large migration, annai writes an automatic backup" (§4.6):** annai has no data-format migration yet (`FORMAT` is 1). The first one calls `backups.backUp` for each place first; this plan builds what it will call.
- **GitLab, Google Drive, Dropbox, the user's own git server** (§12.4 "later targets").

## Choices this plan makes (please check them)

1. **GitHub backups are not encrypted, and the repository must be private.** The spec says git places store the unpacked tree, so each file is readable on GitHub, by you. annai refuses a public repository, and says how to make it private.
   - **The alternative:** encrypting each file. Not in the spec, and it would cost the "only changed files are uploaded" property unless the encryption were deterministic.
2. **The repository holds annai's backups and nothing else.** It may be empty, or hold a README, LICENSE, .gitignore or .gitattributes, which are kept. A repository with anything else (code, say) is refused before anything is written, so annai can never wipe a project's files from its latest commit. annai uses the repository's default branch. An empty repository gets a README commit first, because GitHub's Git Data API doesn't work on an empty repository.
3. **Where this device backs up to is set up on this device and never travels in a backup.** It lives in a scope of its own, "This device", which exports leave out and imports skip. The token is a secret. So restoring on a new phone means entering the repository and token again, which you need anyway to reach the backup.
4. **Wi-Fi.** Chrome on Android says whether it's on Wi-Fi; Safari on iPhone can't.
   - On mobile data (or Data Saver), automatic backups wait for Wi-Fi.
   - Where annai can't tell (iPhone), an automatic backup uploads up to 25 MB without asking. A larger one waits, with a card: "Back up now".
   - The place's "Also over mobile data" switch lifts both limits.
5. **When:**
   - **"After changes"** (the default): two minutes after the last change, at most once an hour.
   - **"Once a day":** at most once a day.
   - Either way, nothing is backed up when nothing changed. The system log and this device's own scope don't count as changes, or a backup's own trace would call for the next one.
6. **Single writer.**
   - A place's newest backup that this device neither made nor took in pauses automatic backups there. That happens when another device backed up, or the first time this device sees a place that already has a backup.
   - A card offers two choices:
     - **"Import it as a copy":** the import preview, where each trip can be added as a copy or replace yours.
     - **"Back up this phone over it":** on GitHub, the other backup stays in the repository's history.
   - After importing it, this device builds on that backup.
   - Each commit carries this device's random id and its kind ("iPhone"), so annai tells its own backups from another device's.
7. **Restoring is opening a backup from the place on the usual import screen** (§12.3). On a device with no trips yet, the preview starts with "Replace my profile and memory" and "Replace my settings" ticked. Plugins stay unticked, since imported plugins arrive switched off.
8. **GitHub's rate limits.** annai uploads one file at a time. When GitHub asks it to wait, it waits, up to 5 minutes; a longer wait ends this backup and it carries on later. A file GitHub already has from an unfinished try isn't sent again: one cheap HEAD request per file checks first. GitHub documents 80 content-creating requests a minute and 500 an hour, without saying whether a blob counts.
9. **Text files travel inside the tree request**, many in one request; photos and other binary files are uploaded one by one. annai computes the tree's git id itself and refuses a tree GitHub stored differently, so a changed byte is caught before the commit.
10. **Files over 100 MB** (GitHub's limit) stop the backup with the file's name and what to do. A path git can't hold (a folder named `.git`; a file and a folder with the same name) does the same.
11. **Failures.**
    - Failures only you can fix show a card once: token refused, repository missing or public, missing permission.
    - Passing ones show only on the Backups screen and are tried again: offline, GitHub's errors, rate limits. The waits are 15 minutes, doubling up to 6 hours, or the time GitHub asked for.
12. **Deleting a backup isn't offered for GitHub.** Its backups are commits; the history is yours to manage on GitHub.
13. **No CSP change.** `connect-src` already allows `https:` and localhost. GitHub's API is https. A place's address must be https, or localhost for testing.
14. **The GitHub token is a fine-grained personal access token you paste in.** annai registers no OAuth app; the spec names none for GitHub.
15. **The size budget** goes from 740 KiB to 770 KiB in Task 1. You said to raise it as needed and list each raise; this is that list's entry. The GitHub plugin is on demand, so it doesn't count.
16. **Test timings.** The end-to-end tests shorten the timings through `localStorage['annai.backupTimings']`, the way `annai.forceDownload` already works.

## Global Constraints

- All of milestone 2b's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m2b-shiori.md`). In particular:
  - Model output never goes into `innerHTML`, and no `style` attribute is set.
  - Links open only `https:` and `http:` URLs.
  - Every write is one transaction; everything stored is named by a file or a log entry (§4.9).
  - Every file under `src/` and `assets/` is listed in `sw.js` `SHELL` (a unit test checks this). Run `npm run stamp` after any shipped file changes, and `npm run catalog` after `plugins-official/` changes.
- **"Keys … never in context, redacted from the trace, and excluded from exports by default" (§15).** For backups, that means:
  - GitHub tokens live only in `secrets` (`backup:<id>`).
  - Every request goes through the plugin's traced `net.fetch`, so the trace shows each one; tokens travel only in the `Authorization` header, which the trace doesn't keep.
  - Every error annai keeps or shows goes through `withoutSecrets`.
- **"Automatic backup: daily or after changes, while on Wi-Fi with the app open. It runs alongside the install nudge, not instead of it" (§12.4).** The install banner is untouched.
- **"Git targets store the unpacked tree, not a zip. One backup is one commit, and only changed files are uploaded" (§12.4).**
- **"Single writer. A newer remote backup from another device triggers a warning and an offer to import it as a copy" (§12.4).**
- **"Backed up means a Backup with everything ticked (§12.2) … was saved after the trip's last change" (§4.9).** A backup to a place is a Backup of everything; when the commit lands, its trips are noted with `recordBackup`.
- **"Choosing an unavailable type installs its plugin" (§5.3).** Adding a GitHub place installs `storage-github` from the catalog, on the user's tap. Automatic backups never install or switch on a plugin.
- **Copy:** plain words; every error says what happened and what to do next; system cards are never in Shiori's voice.
- **Tests:**
  - Playwright runs only in Docker: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`.
  - Stand-in servers listen on port 0. Never use host ports 8765, 8790, 8791 or 8792.
  - Delete any `core*` file WebKit leaves behind.
- **Before every commit:** `npm run stamp && npm run check && git commit …`, chained with `&&`.

## Verified facts (checked 2026-10-16)

- **CORS at api.github.com:**
  - The preflight answers `access-control-allow-origin: *`.
  - It allows `GET, POST, PATCH, PUT, DELETE`, and the headers `Authorization, Content-Type, …, X-GitHub-Api-Version`.
  - It exposes `ETag, Link, Location, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, …`.
- **Blobs:**
  - `HEAD /repos/{o}/{r}/git/blobs/{sha}` answers 200 when the blob exists and 404 when it doesn't.
  - `Accept: application/vnd.github.raw+json` returns the raw bytes, with `access-control-allow-origin: *`.
  - "Get a blob" supports blobs up to 100 MB. "Create a blob" takes `content` with `encoding` `utf-8` or `base64`, and answers 201 `{ sha, url }`.
- **Git's ids:** `git hash-object` of `Hello World!\n` is `980a0d5f19a64b4b30a87d4206aade58726b60e3`, the `sha` GitHub reports for that file.
- **A tree of these files has git id `8705553fc3213fec7f84cb10a01966f932a16f0d`** (git 2.x `write-tree`): `a.txt` = `hello\n`, `dir/b.txt` = `b\n`, `dir-x/c` = empty, `dir.y` = `d`, `trips/京都.md` = `千本鳥居\n`. The empty blob is `e69de29b…`, `hello\n` is `ce013625…`, and 300 zero bytes are `106bf3ff…`.
- **Create a tree:**
  - Entries take `path`, `mode` (`100644` for a file), `type` and either `sha` or `content`. With `content`, GitHub writes the blob itself.
  - Without `base_tree`, the tree is exactly the entries given.
  - The answer is 201 `{ sha, tree, truncated }`.
- **Get a tree with `recursive`:** at most 100,000 entries or 7 MB; beyond that, `truncated` is true.
- **Empty repositories:** "The REST API will return a 409 Conflict if the Git repository is empty". `PUT /repos/{o}/{r}/contents/{path}` creates the first commit.
- **A missing ref** (`GET /git/ref/heads/nope`) is 404 `{"message": "Not Found"}`.
- **Rate limits:**
  - Primary: 5,000 requests an hour with a personal access token.
  - Secondary: 100 concurrent requests, 900 points a minute (GET 1, POST/PATCH/PUT/DELETE 5), 80 content-generating requests a minute and 500 an hour.
  - Exceeding one gives 403 or 429. Honour `retry-after`; or, when `x-ratelimit-remaining` is 0, wait until `x-ratelimit-reset`; otherwise wait at least a minute.
- **Safari has no Network Information API** (`navigator.connection`). Chrome on Android gives `navigator.connection.type` (`wifi`, `cellular`, `ethernet`, `none`, …) and `saveData`. Desktop Chrome gives no `type`.
- **The CSP already allows these requests:** `_headers` `connect-src 'self' https: http://localhost:* http://127.0.0.1:*`.

## Review Focus

1. **Two devices backing up at the same moment.** The branch moves between annai reading it and updating it. Expected: annai's update is refused (not a fast forward), nothing is overwritten, and the place waits with "a newer backup". Pinned in Task 4.
2. **A first backup cut short** by a rate limit or the app closing. Expected:
   - Nothing counts as backed up until the commit lands.
   - The next try doesn't upload the same files again (in this session it remembers; in a new one, HEAD checks).

   Pinned in Task 4.
3. **A token in an error or the trace.** GitHub's error, a plugin's message, or a URL holds the token. Expected: blanked everywhere annai keeps or shows it; no event or file anywhere holds it. Pinned in Tasks 5 and 6.
4. **The wrong repository:** a code repository, a public one, one the token can't write, one that doesn't exist. Expected: refused with plain words and what to do, before anything is written. Pinned in Task 4.
5. **Changes during a backup.** A note written, or a trip removed, while a backup runs. Expected:
   - What changed after the archive was built counts as changed, so the next backup takes it.
   - A removed trip is never noted as backed up.

   Pinned in Tasks 5 and 6.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/scopes.js` | 1 | `SYS_DEVICE`, `ensureDeviceScope` |
| `src/core/archive.js` | 1 | exports leave out `sys:device` |
| `src/core/backup-targets.js` | 1 | places, this device's id, a place's secret |
| `scripts/size.mjs` | 1 | the budget: 770 KiB |
| `src/core/storage-types.js` | 2 | `TargetError`, `NEEDS_YOU`, `checkStorageType`, `storageTypes` |
| `src/core/plugins.js` | 2 | `annai.storage.register`; helpers `TargetError` and `zip`; `isPluginBug` |
| `src/core/llm/official.js` | 2 | `ensureProvided` (any kind), `offeredTypes` |
| `test/fakes/github.js` | 3 | the stand-in GitHub |
| `plugins-official/storage-github/{annai-plugin.json,git.js,index.js}`, `catalog/plugins.json` | 4 | the GitHub plugin |
| `src/core/backup.js` | 5 | `createBackups`, `retryDelay` |
| `src/core/backup-auto.js` | 6 | `TIMINGS`, `changedSince`, `dueNow`, `holdKey`, `startAutoBackup` |
| `src/ui/platform.js` | 7 | `connectionOf`, `deviceName` |
| `src/ui/format.js` | 7 | `placeStatus`, `newerText`, `withArticle`, `placeHref` |
| `src/ui/auto-backup.js` | 7 | `startBackups` (runner, cards, test timings), `restoreFrom` |
| `src/ui/screens/backups.js` | 7 | the Backups screen and a place's screen |
| `src/ui/import-state.js`, `src/ui/screens/import.js` | 7 | a backup from a place: pre-ticks on a new device, `accept` after importing |
| `src/ui/screens/settings.js`, `src/ui/screens/trips.js`, `src/ui/shell.js`, `src/app/main.js`, `sw.js` | 7 | wiring, links and lines |
| `test/e2e/backups.spec.js`, `test/e2e/helpers.js` | 8 | done |
| `docs/testing/device-checklist-m9.md`, `docs/plugins.md`, `README.md` | 8 | the checklist and the guides |

---
### Task 1: This device's own scope and its backup places

**Files:**
- Create: `src/core/backup-targets.js`
- Modify: `src/core/scopes.js` (`SYS_DEVICE`, `ensureDeviceScope`), `src/core/archive.js` (export leaves it out), `scripts/size.mjs` (the budget), `sw.js` (`SHELL`)
- Test: `test/unit/backup-targets.test.js`

**Interfaces:**
- Consumes: `Workspace` (`readJSON`, `write`, `now`, `store`), `newId`, `exportArchive`, `importArchive`.
- Produces:
  - `SYS_DEVICE = 'sys:device'`, `ensureDeviceScope(store, now?)` in `scopes.js`.
  - In `backup-targets.js`, the types `Auto = 'off'|'changes'|'daily'`, `RemoteBackup = { id, at, device?, label? }`, `Hold`, `LastBackup = { id, at, seqs: Record<string, number>, bytes }` and `Target = { id, type, name, config, auto, mobileData, created, checked: number|null, last: LastBackup|null, hold: Hold|null }`.
  - `Hold` is `{ kind: 'newer', remote }`, `{ kind: 'large', bytes, at }` or `{ kind: 'error', message, at, count, retryAt, needsYou }`.
  - `listTargets(ws): Promise<Target[]>` (oldest first), `getTarget(ws, id)`, `deviceId(ws): Promise<string>`.
  - `addTarget(ws, { type, name, config?, auto?, mobileData? }): Promise<string>`, `setTarget(ws, id, fields): Promise<Target>` (throws `NotFoundError`), `removeTarget(ws, id)`.
  - `secretId(id)`, `targetSecret(store, id): Promise<Record<string, string>>`, `setTargetSecret(store, id, values | null)` (an empty value removes that key).

- [ ] **Step 1: Write the failing test**

`test/unit/backup-targets.test.js`:

```js
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
import { listTargets, getTarget, addTarget, setTarget, removeTarget, deviceId, targetSecret, setTargetSecret, secretId } from '../../src/core/backup-targets.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/backup-targets.test.js`
Expected: FAIL: `SYS_DEVICE` is not exported by `scopes.js`, and `backup-targets.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

In `src/core/scopes.js`, after `export const SYS_PLUGINS = 'sys:plugins';`:

```js
/** This device's own scope: never exported, never imported (see ensureDeviceScope). */
export const SYS_DEVICE = 'sys:device';
```

and after `ensureBaseScopes`:

```js
/**
 * This device's own scope, made on first use: what annai keeps about this device alone, such as
 * where it backs up to (spec §12.4). Exports leave it out and imports skip it, so a restored backup
 * can never make two devices one.
 * @param {Store} store @param {number} [now]
 */
export async function ensureDeviceScope(store, now = Date.now()) {
  await store.tx(['scopes'], 'readwrite', async (t) => {
    if (!(await t.getScope(SYS_DEVICE))) {
      await t.putScope({ id: SYS_DEVICE, kind: 'sys', title: 'This device', status: 'active', created: now, updated: now, format: FORMAT });
    }
  });
}
```

In `src/core/archive.js`, import `SYS_DEVICE` with the other scope ids and change the scope filter of `exportArchive`:

```js
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, SYS_DEVICE, FORMAT, newId } from './scopes.js';
```

```js
  const scopes = opts.kind === 'trip'
    ? all.filter((s) => s.kind === 'trip' && (opts.scopes ?? []).includes(s.id))
    // This device's own scope never travels (spec §12.4); the system log goes only with history.
    : all.filter((s) => s.id !== SYS_DEVICE && (s.id !== SYS || opts.include.history));
```

and the comment on the import's skip:

```js
      continue; // kept, or the system log or this device's own scope, which belong to the device they came from
```

`src/core/backup-targets.js`:

```js
import { SYS_DEVICE, ensureDeviceScope, newId } from './scopes.js';
import { NotFoundError } from './workspace.js';

/**
 * Where this device backs up to (spec §12.4), and what it last did there: one file in this
 * device's own scope, which no archive carries, so a restored backup can't make two devices one.
 * What a place needs to sign in (a token, a key, a password) is a secret, backup:<id>.
 * @typedef {import('./workspace.js').Workspace} Workspace
 * @typedef {import('./types.js').Store} Store
 * @typedef {'off'|'changes'|'daily'} Auto
 * @typedef {{ id: string, at: number, device?: string, label?: string }} RemoteBackup
 *   a backup at a place: its id there, when it was made, and the device that made it, when known
 * @typedef {{ kind: 'newer', remote: RemoteBackup } | { kind: 'large', bytes: number, at: number }
 *   | { kind: 'error', message: string, at: number, count: number, retryAt: number, needsYou: boolean }} Hold
 *   why automatic backups to a place wait: a backup there this device hasn't taken in; an upload too
 *   large to make without asking; or a failure, tried again at retryAt (needsYou: only the user can fix it)
 * @typedef {{ id: string, at: number, seqs: Record<string, number>, bytes: number }} LastBackup
 *   the backup at the place this device builds on, one it made or took in; seqs: each scope's last log entry in it
 * @typedef {{ id: string, type: string, name: string, config: Record<string, string>, auto: Auto, mobileData: boolean,
 *   created: number, checked: number | null, last: LastBackup | null, hold: Hold | null }} Target
 *   checked: when it last passed a test; automatic backups wait for one
 * @typedef {{ device: string | null, targets: Record<string, Target> }} State
 */

const FILE = '/backups.json';

/** @param {Workspace} ws @returns {Promise<State>} */
async function read(ws) {
  /** @type {any} */
  const v = (await ws.readJSON(SYS_DEVICE, FILE).catch(() => null)) ?? {};
  const targets = v.targets && typeof v.targets === 'object' && !Array.isArray(v.targets) ? v.targets : {};
  return { device: typeof v.device === 'string' ? v.device : null, targets };
}

/** @type {Promise<unknown>} */
let turn = Promise.resolve();

/**
 * Changes the file one change at a time, so a screen saving a place and a backup noting its result
 * never undo each other. @template T
 * @param {Workspace} ws @param {(v: State) => T} fn changes v in place @returns {Promise<T>}
 */
function change(ws, fn) {
  const run = turn.then(async () => {
    await ensureDeviceScope(ws.store, ws.now());
    const v = await read(ws);
    const out = fn(v);
    await ws.write(SYS_DEVICE, FILE, v, { author: 'system' });
    return out;
  });
  turn = run.catch(() => {});
  return run;
}

/** Every place this device backs up to, oldest first. @param {Workspace} ws @returns {Promise<Target[]>} */
export async function listTargets(ws) {
  return Object.values((await read(ws)).targets).sort((a, b) => a.created - b.created);
}

/** @param {Workspace} ws @param {string} id @returns {Promise<Target | undefined>} */
export async function getTarget(ws, id) {
  return (await read(ws)).targets[id];
}

/** This device's id in the backups it makes: random, made once, kept only here. @param {Workspace} ws @returns {Promise<string>} */
export async function deviceId(ws) {
  const had = (await read(ws)).device;
  if (had) return had;
  return change(ws, (v) => (v.device ??= newId('d').slice(2)));
}

/**
 * @param {Workspace} ws @param {{ type: string, name: string, config?: Record<string, string>, auto?: Auto, mobileData?: boolean }} t
 * @returns {Promise<string>} the new place's id
 */
export async function addTarget(ws, { type, name, config = {}, auto = 'changes', mobileData = false }) {
  const id = newId('bt');
  await change(ws, (v) => {
    v.targets[id] = { id, type, name, config, auto, mobileData, created: ws.now(), checked: null, last: null, hold: null };
  });
  return id;
}

/**
 * Sets some of a place's fields, keeping the others. @param {Workspace} ws @param {string} id
 * @param {Partial<Omit<Target, 'id' | 'type' | 'created'>>} fields @returns {Promise<Target>}
 */
export function setTarget(ws, id, fields) {
  return change(ws, (v) => {
    const t = v.targets[id];
    if (!t) throw new NotFoundError(`backup place ${id}`);
    v.targets[id] = { ...t, ...fields };
    return v.targets[id];
  });
}

/** Forgets a place and its secret. What is stored at the place stays there. @param {Workspace} ws @param {string} id */
export async function removeTarget(ws, id) {
  await change(ws, (v) => { delete v.targets[id]; });
  await setTargetSecret(ws.store, id, null);
}

/** @param {string} id */
export const secretId = (id) => `backup:${id}`;

/** What a place needs to sign in, such as { token }. @param {Store} store @param {string} id @returns {Promise<Record<string, string>>} */
export async function targetSecret(store, id) {
  const v = await store.tx(['secrets'], 'readonly', (t) => t.getSecret(secretId(id)));
  return v && typeof v === 'object' ? { ...v } : {};
}

/**
 * Keeps the values given (an empty one removes that value); null removes the whole secret.
 * @param {Store} store @param {string} id @param {Record<string, string> | null} values
 */
export async function setTargetSecret(store, id, values) {
  await store.tx(['secrets'], 'readwrite', async (t) => {
    if (values === null) return t.deleteSecret(secretId(id));
    /** @type {Record<string, string>} */
    const next = { ...((await t.getSecret(secretId(id))) ?? {}) };
    for (const [k, v] of Object.entries(values)) {
      if (v) next[k] = v;
      else delete next[k];
    }
    return Object.keys(next).length ? t.putSecret(secretId(id), next) : t.deleteSecret(secretId(id));
  });
}
```

In `scripts/size.mjs`:

```js
const BUDGET = 770 * 1024; // bytes, uncompressed; raised from 740 KiB for milestone 9 (backups)
```

In `sw.js`, add `'/src/core/backup-targets.js',` to `SHELL` after `'/src/core/archive.js',`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/backup-targets.test.js test/unit/archive.test.js test/unit/scopes.test.js`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/backup-targets.js src/core/scopes.js src/core/archive.js scripts/size.mjs sw.js test/unit/backup-targets.test.js && git commit -m "This device's own scope keeps where it backs up to; no archive carries it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 2: Kinds of backup places come from plugins

**Files:**
- Create: `src/core/storage-types.js`
- Modify: `src/core/plugins.js` (`annai.storage`, helpers, `isPluginBug`), `src/core/llm/official.js` (`ensureProvided`, `offeredTypes`), `sw.js` (`SHELL`)
- Test: `test/unit/storage-types.test.js`

**Interfaces:**
- Consumes: `Registry.add/list`, `PluginHost`, `officialPlugins`, `installOfficial`, `ZipReader`, `ZipWriter`.
- Produces:
  - `TargetError(kind, message, { remote?, bytes?, retryAt? })`, with `.kind`. The kind is one of `'newer'|'large'|'rate'|'auth'|'refused'|'missing'|'setup'|'other'`.
  - `NEEDS_YOU: Set<string>` (`auth`, `refused`, `missing`, `setup`).
  - `checkStorageType(t): string | null` and `storageTypes(registry): Map<string, StorageType>`.
  - The types `StorageType`, `TargetContext = { config, secret, device: { id, label }, app }`, `Progress = { phase: 'building'|'checking'|'uploading'|'downloading', done, total }`, `Archive = { blob, name, manifest }` and `PutOptions = { base, maxUpload, signal?, onProgress }`.
  - In plugins: `annai.storage.register(type)` adds registry kind `'storage-type'`, with `pluginId`. `annai.helpers.TargetError` and `annai.helpers.zip.{ ZipReader, ZipWriter }`.
  - `isPluginBug(e): boolean` in `plugins.js`.
  - `ensureProvided(host, kind, type, opts?)`, with `ensureType(host, type, opts)` unchanged for callers, and `offeredTypes(kind, opts?): Promise<{ type, name }[]>` in `official.js`.

- [ ] **Step 1: Write the failing test**

`test/unit/storage-types.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost, isPluginBug } from '../../src/core/plugins.js';
import { TargetError, NEEDS_YOU, storageTypes } from '../../src/core/storage-types.js';
import { ensureProvided, offeredTypes } from '../../src/core/llm/official.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: installed plugin files load from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  return { registry, ws, host: new PluginHost({ registry, workspace: ws, importModule }) };
}

/** @param {string} code */
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

/** A complete storage type, to break one part at a time. */
const good = () => ({
  type: 'probe-two', name: 'Probe', stores: 'tree', fields: [{ key: 'where', label: 'Where' }], secret: [{ key: 'token', label: 'Token' }],
  where: () => '', check: async () => ({ note: '' }), list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]),
});

test('a plugin adds a kind of backup place through annai.storage (spec §5.4)', async () => {
  const k = await setup();
  await k.host.addBuiltin(moduleUrl(`export const manifest = { id: 'probe-store', name: 'Probe', version: '1.0.0', api: 1 };
    export function activate(a) {
      globalThis.__probeStore = a;
      return a.storage.register({ type: 'probe', name: ' Probe ', stores: 'tree', where: (c) => c.where,
        check: async () => ({ note: 'ok' }), list: async () => [], put: async () => ({ id: '1', at: 1 }), get: async () => new Blob([]) });
    }`));
  const t = storageTypes(k.registry).get('probe');
  assert.deepEqual([t?.pluginId, t?.stores, t?.name, t?.fields, t?.secret], ['probe-store', 'tree', 'Probe', [], []]);
  const a = /** @type {any} */ (globalThis).__probeStore;
  assert.equal(a.helpers.TargetError, TargetError);
  assert.equal(typeof a.helpers.zip.ZipReader.open, 'function');
  assert.equal(typeof a.helpers.zip.ZipWriter, 'function');
  /** @type {[any, RegExp][]} */
  const bad = [
    [{ ...good(), type: 'Bad Type' }, /lowercase/],
    [{ ...good(), name: ' ' }, /needs a name/],
    [{ ...good(), stores: 'disk' }, /"tree".*"file"/],
    [{ ...good(), get: undefined }, /needs get\(\)/],
    [{ ...good(), delete: 'yes' }, /delete/],
    [{ ...good(), fields: [{ label: 'no key' }] }, /field/],
  ];
  for (const [type, why] of bad) assert.throws(() => a.storage.register(type), (e) => e instanceof PluginError && why.test(e.message));
  await k.host.stop('probe-store');
  assert.equal(storageTypes(k.registry).has('probe'), false);
});

test('TargetError carries what annai needs to act on it; a bug in a plugin is told apart from its answer', () => {
  const e = new TargetError('newer', 'A newer backup is there.', { remote: { id: 'c2', at: 5 } });
  assert.deepEqual([e.name, e.kind, e.message, e.remote?.id], ['TargetError', 'newer', 'A newer backup is there.', 'c2']);
  assert.equal(new TargetError('rate', 'Wait.', { retryAt: 9 }).retryAt, 9);
  assert.deepEqual([...NEEDS_YOU].sort(), ['auth', 'missing', 'refused', 'setup']);
  assert.equal(isPluginBug(new TypeError('x is not a function')), true);
  assert.equal(isPluginBug(new ReferenceError('y is not defined')), true);
  assert.equal(isPluginBug(new TypeError('Failed to fetch')), false);
  assert.equal(isPluginBug(new TypeError('Load failed')), false);
  assert.equal(isPluginBug(new TargetError('auth', 'no')), false);
  assert.equal(isPluginBug(new DOMException('stopped', 'AbortError')), false);
  assert.equal(isPluginBug('a string'), true);
});

test('choosing a kind of backup place installs the official plugin that provides it (spec §5.3)', async () => {
  const k = await setup();
  const code = utf8(`export function activate(a) {
    return a.storage.register({ type: 'probe', name: 'Probe', stores: 'file', where: () => '', check: async () => ({ note: '' }),
      list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]) });
  }`);
  const manifest = utf8(JSON.stringify({ id: 'storage-probe', name: 'Probe storage', version: '1.0.0', api: 1, entry: 'index.js', provides: { 'storage-type': ['probe'] } }));
  const catalog = { format: 1, plugins: [{ id: 'storage-probe', name: 'Probe storage', version: '1.0.0', provides: { 'storage-type': ['probe'] },
    files: { 'annai-plugin.json': await sha256Hex(manifest), 'index.js': await sha256Hex(code) } }] };
  /** @type {Record<string, Uint8Array>} */
  const served = { '/catalog/plugins.json': utf8(JSON.stringify(catalog)), '/plugins-official/storage-probe/annai-plugin.json': manifest, '/plugins-official/storage-probe/index.js': code };
  const get = async (/** @type {any} */ url) => {
    const body = served[new URL(String(url), 'http://annai.test').pathname];
    return body ? new Response(/** @type {any} */ (body)) : new Response('not found', { status: 404 });
  };
  assert.deepEqual(await offeredTypes('storage-type', { fetch: get }), [{ type: 'probe', name: 'Probe storage' }]);
  assert.deepEqual(await offeredTypes('endpoint-type', { fetch: get }), []);
  await Promise.all([ensureProvided(k.host, 'storage-type', 'probe', { fetch: get }), ensureProvided(k.host, 'storage-type', 'probe', { fetch: get })]);
  assert.equal(storageTypes(k.registry).get('probe')?.pluginId, 'storage-probe');
  assert.equal((await k.host.installed())['storage-probe']?.source, 'official');
  await assert.rejects(ensureProvided(k.host, 'storage-type', 'nope', { fetch: get }), /isn't a kind of backup place annai knows/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/storage-types.test.js`
Expected: FAIL: `src/core/storage-types.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`src/core/storage-types.js`:

```js
/**
 * Kinds of backup places are storage types that plugins add (spec §5.4 storage, §12.4):
 * archive-level check, list, put and get, and delete where a place keeps whole archive files.
 * annai builds each backup and decides when; a type only moves it. Its functions are called
 * without `this`.
 *
 * stores: "tree" keeps the archive's files (git: one backup is one commit, and only changed files
 * are uploaded); "file" keeps the archive file itself.
 * fields and secret: what the user fills in for a place; secret values live in secrets, never in files.
 * where(config): the place in a few words ("you/annai-backup").
 * put(c, archive, o) refuses with TargetError "newer" when the place's newest backup is neither
 * o.base nor one this device made (c.device.id), and with "large" before uploading anything when it
 * would send more than o.maxUpload bytes.
 *
 * @typedef {import('./backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {{ key: string, label: string, placeholder?: string, advanced?: boolean }} Field
 * @typedef {{ config: Record<string, string>, secret: Record<string, string>, device: { id: string, label: string }, app: string }} TargetContext
 * @typedef {{ phase: 'building'|'checking'|'uploading'|'downloading', done: number, total: number }} Progress
 * @typedef {{ blob: Blob, name: string, manifest: any }} Archive
 * @typedef {{ base: string | null, maxUpload: number, signal?: AbortSignal, onProgress: (p: Progress) => void }} PutOptions
 * @typedef {{ type: string, name: string, stores: 'tree' | 'file', fields: Field[], secret: Field[], help?: string, helpUrl?: string, helpLabel?: string,
 *   where: (config: Record<string, string>) => string,
 *   check: (c: TargetContext) => Promise<{ note: string }>,
 *   list: (c: TargetContext) => Promise<RemoteBackup[]>,
 *   put: (c: TargetContext, archive: Archive, o: PutOptions) => Promise<{ id: string, at: number, uploaded?: number, files?: number }>,
 *   get: (c: TargetContext, id: string, o: { signal?: AbortSignal, onProgress: (p: Progress) => void }) => Promise<Blob>,
 *   delete?: (c: TargetContext, id: string) => Promise<void>, pluginId: string }} StorageType
 */

/** Why a backup place said no, in plain words, with what annai needs to act on it. */
export class TargetError extends Error {
  /**
   * @param {'newer'|'large'|'rate'|'auth'|'refused'|'missing'|'setup'|'other'} kind
   * @param {string} message what happened and what to do next
   * @param {{ remote?: RemoteBackup, bytes?: number, retryAt?: number }} [extra]
   *   remote: the newer backup ("newer"); bytes: what the upload would be ("large"); retryAt: when to try again ("rate")
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'TargetError';
    this.kind = kind;
    this.remote = extra.remote;
    this.bytes = extra.bytes;
    this.retryAt = extra.retryAt;
  }
}

/** Failures only the user can fix, so a card says so (spec §17 rule 3). */
export const NEEDS_YOU = new Set(['auth', 'refused', 'missing', 'setup']);

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;

/** What is wrong with a storage type a plugin registers, or null. @param {any} t @returns {string | null} */
export function checkStorageType(t) {
  if (typeof t?.type !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.type)) {
    return 'a kind of backup place needs a "type" id of lowercase letters, digits and dashes';
  }
  const named = `the kind of backup place "${t.type}"`;
  if (typeof t.name !== 'string' || !t.name.trim()) return `${named} needs a name`;
  if (t.stores !== 'tree' && t.stores !== 'file') return `${named} must say whether it stores a "tree" of files or the archive "file"`;
  for (const f of ['where', 'check', 'list', 'put', 'get']) if (typeof t[f] !== 'function') return `${named} needs ${f}()`;
  if (t.delete !== undefined && typeof t.delete !== 'function') return `${named} has a delete that isn't a function`;
  for (const list of [t.fields ?? [], t.secret ?? []]) {
    if (!Array.isArray(list) || list.some((f) => !FIELD_KEY.test(f?.key ?? '') || typeof f.label !== 'string')) return `${named} has a field without a key or a label`;
  }
  return null;
}

/** The kinds of backup places running plugins provide, by type id (the first one wins). @param {import('./registry.js').Registry} registry @returns {Map<string, StorageType>} */
export function storageTypes(registry) {
  /** @type {Map<string, StorageType>} */
  const out = new Map();
  for (const t of registry.list('storage-type')) if (!out.has(t.type)) out.set(t.type, t);
  return out;
}
```

In `src/core/plugins.js`:

```js
import { readZip, ZipReader, ZipWriter } from './zip.js';
import { TargetError, checkStorageType } from './storage-types.js';
```

```js
const HELPERS = Object.freeze({ sse, parsePartialJSON, ProviderError, errorFromResponse, retry, tsv, mergePatch, TargetError, zip: Object.freeze({ ZipReader, ZipWriter }) });

/**
 * Whether an error is a bug in a plugin's code (spec §5.5) rather than its answer. A fetch the
 * browser couldn't make (offline: "Failed to fetch", Safari's "Load failed") is an answer (§17).
 * @param {unknown} e
 */
export function isPluginBug(e) {
  if (!(e instanceof Error)) return true;
  const offline = e instanceof TypeError && /fetch|load failed|network/i.test(e.message);
  return !offline && BUGS.some((B) => e instanceof B);
}
```

In the tools wrapper of `#api`, the two lines that decide whether an error is the tool's answer become one:

```js
                if (!isPluginBug(e)) throw e;
```

and after `providers` in the object `#api` returns:

```js
      storage: Object.freeze({
        /** A kind of place to back up to (spec §12.4); storage-types.js says what it must have. */
        register: (/** @type {any} */ type) => {
          const wrong = checkStorageType(type);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, 'storage-type', Object.freeze({ ...type, name: String(type.name).trim(), fields: type.fields ?? [], secret: type.secret ?? [], pluginId: id }));
        },
      }),
```

In `src/core/llm/official.js`, drop the `endpointTypes` import and replace `ensureType`, `inFlight` and `ensureNow` with:

```js
/** What each kind of thing a plugin provides is called, for messages. @type {Record<string, string>} */
const KINDS = { 'endpoint-type': 'an endpoint type', 'storage-type': 'a kind of backup place' };

/** The type ids of a kind that running plugins provide. @param {import('../registry.js').Registry} registry @param {string} kind */
const provided = (registry, kind) => new Set(registry.list(kind).map((/** @type {any} */ t) => t.type));

/** Makes an endpoint type available (see ensureProvided). @param {PluginHost} host @param {string} type @param {FetchOptions} [opts] */
export function ensureType(host, type, opts = {}) {
  return ensureProvided(host, 'endpoint-type', type, opts);
}

/**
 * Makes a type of a kind ("endpoint-type", "storage-type") available. Nothing to do when a running
 * plugin provides it. Otherwise it starts the installed official plugin that provides it, or
 * installs the catalog's version (spec §5.3).
 * @param {PluginHost} host @param {string} kind @param {string} type @param {FetchOptions} [opts]
 */
export function ensureProvided(host, kind, type, opts = {}) {
  if (provided(host.registry, kind).has(type)) return Promise.resolve();
  // Two callers at once share one install: a second install would stop the plugin the first one started.
  const running = inFlight.get(host) ?? new Map();
  inFlight.set(host, running);
  const key = `${kind} ${type}`;
  const had = running.get(key);
  if (had) return had;
  const work = ensureNow(host, kind, type, opts).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

/** Installs or starts what provides a type, once per host, kind and type at a time. @type {WeakMap<PluginHost, Map<string, Promise<void>>>} */
const inFlight = new WeakMap();

/** @param {PluginHost} host @param {string} kind @param {string} type @param {FetchOptions} opts */
async function ensureNow(host, kind, type, opts) {
  const what = KINDS[kind] ?? kind;
  const entry = (await officialPlugins(opts)).find((p) => p.provides?.[kind]?.includes(type));
  if (!entry) throw new PluginError(type, `isn't ${what} annai knows. Install a plugin that provides it.`);
  const state = (await host.installed())[entry.id];
  if (state && state.version === entry.version) {
    if (!state.enabled) await host.setEnabled(entry.id, true);
    else await host.start(entry.id);
  } else {
    await installOfficial(host, entry, opts);
  }
  if (!provided(host.registry, kind).has(type)) throw new PluginError(entry.id, `didn't provide ${what} ${type}`);
}

/**
 * The types of a kind annai's catalog offers, each with the name of the plugin that brings it.
 * @param {string} kind @param {FetchOptions} [opts] @returns {Promise<{ type: string, name: string }[]>}
 */
export async function offeredTypes(kind, opts = {}) {
  return (await officialPlugins(opts)).flatMap((p) => (p.provides?.[kind] ?? []).map((type) => ({ type, name: p.name })));
}
```

In `sw.js`, add `'/src/core/storage-types.js',` to `SHELL` after `'/src/core/store-idb.js',` (or where the `src/core` files sit alphabetically).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/storage-types.test.js test/unit/llm-plugins.test.js test/unit/plugin-api.test.js test/unit/plugins.test.js`
Expected: PASS, every test (the endpoint-type messages are unchanged).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/storage-types.js src/core/plugins.js src/core/llm/official.js sw.js test/unit/storage-types.test.js && git commit -m "Plugins add kinds of backup places; choosing one installs its plugin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 3: A stand-in GitHub

**Files:**
- Create: `test/fakes/github.js`
- Test: `test/unit/fake-github.test.js`

**Interfaces:**
- Consumes: nothing of annai's.
- Produces: `TOKEN` and `startGitHub({ token?, repos? })`. Each entry of `repos` is `{ private?, defaultBranch?, files? }`; a repository is empty unless `files` is given. It resolves to an object with:
  - `origin`, `token`, `log: { method, path, status }[]`, and `count(method, pathEnd)`.
  - `files(repo, branch?): Map<path, Buffer>` and `commits(repo, branch?): { sha, message, parents, tree }[]` (newest first).
  - `commitAs(repo, files, message): string`.
  - `limitBlobs({ after, retryAfter, times })`, `beforeRefUpdate(fn)`, `breakNextTree()`, `setPrivate(repo, value)`.
  - `stop()`.

- [ ] **Step 1: Write the failing test**

`test/unit/fake-github.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGitHub, TOKEN } from '../fakes/github.js';

/** Requests to the stand-in as a browser would send them. @param {string} origin @param {string} [token] */
function api(origin, token = TOKEN) {
  return async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ body = undefined, /** @type {Record<string, string>} */ headers = {}) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = method === 'HEAD' ? '' : await res.text();
    /** @type {any} */
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

test('the stand-in answers as GitHub does: CORS, bad tokens, unknown and empty repositories', async () => {
  const gh = await startGitHub({ repos: { 'me/backup': {} } });
  try {
    const pre = await fetch(`${gh.origin}/repos/me/backup/git/blobs`, { method: 'OPTIONS', headers: { origin: 'https://annai.guide', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-github-api-version' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /X-GitHub-Api-Version/);
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /PATCH/);
    const call = api(gh.origin);
    const bad = await api(gh.origin, 'ghp_wrong')('GET', '/repos/me/backup');
    assert.deepEqual([bad.status, bad.json.message], [401, 'Bad credentials']);
    assert.equal((await call('GET', '/repos/me/other')).status, 404);
    const repo = await call('GET', '/repos/me/backup');
    assert.deepEqual([repo.json.full_name, repo.json.private, repo.json.default_branch, repo.json.permissions.push], ['me/backup', true, 'main', true]);
    assert.match(repo.headers.get('access-control-expose-headers') ?? '', /Retry-After/);
    const empty = await Promise.all([
      call('GET', '/repos/me/backup/git/ref/heads/main'),
      call('POST', '/repos/me/backup/git/blobs', { content: 'eA==', encoding: 'base64' }),
      call('GET', '/repos/me/backup/commits'),
    ]);
    assert.deepEqual(empty.map((r) => [r.status, r.json.message]), Array(3).fill([409, 'Git Repository is empty.']));
    const first = await call('PUT', '/repos/me/backup/contents/README.md', { message: 'Start', content: Buffer.from('# hi\n').toString('base64') });
    assert.equal(first.status, 201);
    assert.equal((await call('GET', '/repos/me/backup/git/ref/heads/main')).json.object.sha, first.json.commit.sha);
    assert.equal(gh.files('me/backup').get('README.md')?.toString(), '# hi\n');
    assert.equal((await call('GET', '/repos/me/backup/git/ref/heads/nope')).status, 404);
  } finally {
    await gh.stop();
  }
});

test('the stand-in keeps git objects as git does, and refuses what GitHub refuses', async () => {
  const gh = await startGitHub({ repos: { 'me/backup': { files: { 'README.md': 'x' } } } });
  try {
    const call = api(gh.origin);
    const blob = await call('POST', '/repos/me/backup/git/blobs', { content: Buffer.from('hello\n').toString('base64'), encoding: 'base64' });
    assert.deepEqual([blob.status, blob.json.sha], [201, 'ce013625030ba8dba906f756967f9e9ca394464a']);
    assert.equal((await call('HEAD', `/repos/me/backup/git/blobs/${blob.json.sha}`)).status, 200);
    assert.equal((await call('HEAD', `/repos/me/backup/git/blobs/${'0'.repeat(40)}`)).status, 404);
    const raw = await fetch(`${gh.origin}/repos/me/backup/git/blobs/${blob.json.sha}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github.raw+json' } });
    assert.equal(await raw.text(), 'hello\n');
    const tree = await call('POST', '/repos/me/backup/git/trees', { tree: [
      { path: 'a.txt', mode: '100644', type: 'blob', sha: blob.json.sha },
      { path: 'dir/b.txt', mode: '100644', type: 'blob', content: 'b\n' },
      { path: 'dir-x/c', mode: '100644', type: 'blob', content: '' },
      { path: 'dir.y', mode: '100644', type: 'blob', content: 'd' },
      { path: 'trips/京都.md', mode: '100644', type: 'blob', content: '千本鳥居\n' },
    ] });
    assert.deepEqual([tree.status, tree.json.sha], [201, '8705553fc3213fec7f84cb10a01966f932a16f0d']); // git write-tree's id for these files
    for (const t of [[{ path: 'a/.git/x', content: 'x' }], [{ path: 'a//b', content: 'x' }], [{ path: 'n', content: 'x' }, { path: 'n/x', content: 'y' }], [{ path: 'a', sha: 'f'.repeat(40) }]]) {
      assert.equal((await call('POST', '/repos/me/backup/git/trees', { tree: t.map((e) => ({ mode: '100644', type: 'blob', ...e })) })).status, 422);
    }
    const head = (await call('GET', '/repos/me/backup/git/ref/heads/main')).json.object.sha;
    const one = await call('POST', '/repos/me/backup/git/commits', { message: 'one', tree: tree.json.sha, parents: [head] });
    assert.equal(one.status, 201);
    const side = await call('POST', '/repos/me/backup/git/commits', { message: 'side', tree: tree.json.sha, parents: [] });
    assert.equal((await call('PATCH', '/repos/me/backup/git/refs/heads/main', { sha: one.json.sha, force: false })).status, 200);
    const behind = await call('PATCH', '/repos/me/backup/git/refs/heads/main', { sha: side.json.sha, force: false });
    assert.deepEqual([behind.status, behind.json.message], [422, 'Update is not a fast forward']);
    assert.equal((await call('POST', '/repos/me/backup/git/refs', { ref: 'refs/heads/main', sha: one.json.sha })).status, 422);
    const listed = await call('GET', '/repos/me/backup/commits?sha=main&per_page=5');
    assert.deepEqual(listed.json.map((/** @type {any} */ c) => c.commit.message), ['one', 'Initial commit']);
    const got = await call('GET', `/repos/me/backup/git/trees/${tree.json.sha}?recursive=1`);
    assert.deepEqual(got.json.tree.filter((/** @type {any} */ e) => e.type === 'blob').map((/** @type {any} */ e) => e.path).sort(), ['a.txt', 'dir-x/c', 'dir.y', 'dir/b.txt', 'trips/京都.md']);
    assert.equal(gh.count('POST', '/git/blobs'), 1);
  } finally {
    await gh.stop();
  }
});

test('the stand-in plays a secondary rate limit, another device, and a tree stored differently', async () => {
  const gh = await startGitHub({ repos: { 'me/backup': { files: { 'README.md': 'x' } } } });
  try {
    const call = api(gh.origin);
    gh.limitBlobs({ after: 1, retryAfter: 7, times: 1 });
    const post = () => call('POST', '/repos/me/backup/git/blobs', { content: 'eA==', encoding: 'base64' });
    assert.equal((await post()).status, 201);
    const limited = await post();
    assert.deepEqual([limited.status, limited.headers.get('retry-after')], [403, '7']);
    assert.match(limited.json.message, /secondary rate limit/);
    assert.equal((await post()).status, 201);
    const sha = gh.commitAs('me/backup', { 'annai-archive.json': '{}' }, 'annai backup from Android phone\n\nDevice: phone-b\n');
    assert.equal((await call('GET', '/repos/me/backup/git/ref/heads/main')).json.object.sha, sha);
    assert.deepEqual([...gh.files('me/backup').keys()], ['annai-archive.json']);
    assert.equal(gh.commits('me/backup')[0].message.split('\n')[0], 'annai backup from Android phone');
    const entries = { tree: [{ path: 'a', mode: '100644', type: 'blob', content: 'x' }] };
    const honest = (await call('POST', '/repos/me/backup/git/trees', entries)).json.sha;
    gh.breakNextTree();
    assert.notEqual((await call('POST', '/repos/me/backup/git/trees', entries)).json.sha, honest);
    let ran = false;
    gh.beforeRefUpdate(() => { ran = true; });
    await call('PATCH', '/repos/me/backup/git/refs/heads/main', { sha, force: false });
    assert.equal(ran, true);
    gh.setPrivate('me/backup', false);
    assert.equal((await call('GET', '/repos/me/backup')).json.private, false);
  } finally {
    await gh.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/fake-github.test.js`
Expected: FAIL: `test/fakes/github.js` doesn't exist.

- [ ] **Step 3: Write the stand-in**

`test/fakes/github.js`:

```js
import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A stand-in for the part of GitHub's REST API that annai's GitHub backups use: the repository,
 * refs, commits, trees and blobs of the Git Data API, the contents API for a first commit, and the
 * commit list. It answers with GitHub's status codes, messages and CORS headers (checked
 * 2026-10-16). It hashes git objects with code of its own (node:crypto), so annai's ids are checked
 * against an independent implementation. Tests and the end-to-end suite run it on a port of its own
 * (port 0): WebKit can't route requests from a page a service worker controls.
 * @typedef {{ type: 'blob', data: Buffer } | { type: 'tree', entries: { name: string, mode: string, sha: string }[] }
 *   | { type: 'commit', tree: string, parents: string[], message: string, date: string }} GitObject
 * @typedef {{ name: string, private: boolean, defaultBranch: string, objects: Map<string, GitObject>, refs: Map<string, string> }} Repo
 * @typedef {Map<string, { sha: string, mode: string }>} Files path → file
 * @typedef {{ files: Map<string, { sha: string, mode: string }>, dirs: Map<string, Dir> }} Dir
 * @typedef {{ status: number, json?: any, raw?: Buffer, headers?: Record<string, string> }} Answer
 */

export const TOKEN = 'ghp_standin_0123456789abcdefghijklmnopqr';

const ALLOW_HEADERS = 'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, X-GitHub-Api-Version';
const EXPOSE_HEADERS = 'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-Request-Id';
const DOCS = 'https://docs.github.com/rest';
/** @type {Answer} */
const NOT_FOUND = { status: 404, json: { message: 'Not Found', documentation_url: DOCS } };
/** @type {Answer} */
const EMPTY = { status: 409, json: { message: 'Git Repository is empty.', documentation_url: DOCS } };

/** @param {string} type @param {Buffer} body */
const gitId = (type, body) => createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');

/** Git sorts a folder as its name followed by "/". @param {{ name: string, mode: string }} e */
const sortKey = (e) => Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name);

/** @param {GitObject} o */
function idOf(o) {
  if (o.type === 'blob') return gitId('blob', o.data);
  if (o.type === 'tree') {
    const sorted = [...o.entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
    return gitId('tree', Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
  }
  const stamp = `${Math.floor(Date.parse(o.date) / 1000)} +0000`;
  const parents = o.parents.map((p) => `parent ${p}\n`).join('');
  const who = 'annai <annai@users.noreply.github.com>';
  return gitId('commit', Buffer.from(`tree ${o.tree}\n${parents}author ${who} ${stamp}\ncommitter ${who} ${stamp}\n\n${o.message}`));
}

/**
 * @param {{ token?: string, repos?: Record<string, { private?: boolean, defaultBranch?: string, files?: Record<string, string | Buffer> }> }} [opts]
 *   repos: each one empty, or with one commit holding files
 */
export async function startGitHub({ token = TOKEN, repos = {} } = {}) {
  /** @type {Map<string, Repo>} */
  const all = new Map();
  /** @type {{ method: string, path: string, status: number }[]} */
  const log = [];
  /** @type {{ after: number, retryAfter: number, times: number, seen: number } | null} */
  let limit = null;
  /** @type {(() => void) | null} */
  let beforeRef = null;
  let tamper = false;
  let origin = '';

  /** @param {Repo} repo @param {GitObject} o */
  const keep = (repo, o) => {
    const sha = idOf(o);
    repo.objects.set(sha, o);
    return sha;
  };
  /** @param {Repo} repo @param {Buffer} data */
  const blob = (repo, data) => keep(repo, { type: 'blob', data });
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** The tree of these files, or null when git can't hold one of their paths. @param {Repo} repo @param {Files} files */
  function build(repo, files) {
    /** @type {Dir} */
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, f] of files) {
      const parts = path.split('/');
      if (parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) return null;
      let d = root;
      for (const p of parts.slice(0, -1)) {
        if (d.files.has(p)) return null;
        if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
        d = d.dirs.get(p);
      }
      const name = parts.at(-1);
      if (d.dirs.has(name)) return null;
      d.files.set(name, f);
    }
    /** @param {Dir} d @returns {string} */
    const write = (d) => keep(repo, { type: 'tree', entries: [
      ...[...d.files].map(([name, f]) => ({ name, mode: f.mode, sha: f.sha })),
      ...[...d.dirs].map(([name, sub]) => ({ name, mode: '40000', sha: write(sub) })),
    ] });
    return write(root);
  }

  /** Every file under a tree, by path. @param {Repo} repo @param {string} sha @returns {Files} */
  function flatten(repo, sha, prefix = '', out = new Map()) {
    const t = repo.objects.get(sha);
    if (t?.type !== 'tree') return out;
    for (const e of t.entries) {
      if (e.mode === '40000') flatten(repo, e.sha, `${prefix}${e.name}/`, out);
      else out.set(`${prefix}${e.name}`, { sha: e.sha, mode: e.mode });
    }
    return out;
  }

  /** @param {Repo} repo @param {Files} files @param {string} message @param {string[]} parents */
  const commitOf = (repo, files, message, parents) => keep(repo, { type: 'commit', tree: build(repo, files), parents, message, date: now() });

  /** Whether sha has old among its ancestors (or is old). @param {Repo} repo @param {string} old @param {string} sha */
  function descends(repo, old, sha) {
    const seen = new Set();
    const todo = [sha];
    while (todo.length) {
      const s = todo.pop();
      if (s === old) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = repo.objects.get(s);
      if (c?.type === 'commit') todo.push(...c.parents);
    }
    return false;
  }

  /** @param {string} sha @param {any} c a commit */
  const commitJson = (sha, c) => {
    const who = { name: 'annai', email: 'annai@users.noreply.github.com', date: c.date };
    return { sha, tree: { sha: c.tree }, parents: c.parents.map((/** @type {string} */ p) => ({ sha: p })), message: c.message, author: who, committer: who };
  };

  /** @param {Repo} repo @param {string} sha @param {boolean} recursive @returns {any[]} */
  function treeJson(repo, sha, recursive, prefix = '') {
    const t = repo.objects.get(sha);
    if (t?.type !== 'tree') return [];
    return t.entries.flatMap((e) => {
      const path = `${prefix}${e.name}`;
      if (e.mode !== '40000') {
        const o = repo.objects.get(e.sha);
        return [{ path, mode: e.mode, type: 'blob', sha: e.sha, size: o?.type === 'blob' ? o.data.length : 0 }];
      }
      return [{ path, mode: '040000', type: 'tree', sha: e.sha }, ...(recursive ? treeJson(repo, e.sha, true, `${path}/`) : [])];
    });
  }

  for (const [name, r] of Object.entries(repos)) {
    /** @type {Repo} */
    const repo = { name, private: r.private ?? true, defaultBranch: r.defaultBranch ?? 'main', objects: new Map(), refs: new Map() };
    all.set(name, repo);
    if (r.files) {
      /** @type {Files} */
      const files = new Map(Object.entries(r.files).map(([p, c]) => [p, { sha: blob(repo, Buffer.from(c)), mode: '100644' }]));
      repo.refs.set(repo.defaultBranch, commitOf(repo, files, 'Initial commit', []));
    }
  }

  /**
   * @param {string} method @param {URL} url @param {import('node:http').IncomingHttpHeaders} headers @param {any} body
   * @returns {Answer}
   */
  function answer(method, url, headers, body) {
    if (method === 'OPTIONS') {
      return { status: 204, headers: { 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE', 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-max-age': '86400' } };
    }
    const auth = String(headers.authorization ?? '');
    if (auth !== `Bearer ${token}` && auth !== `token ${token}`) return { status: 401, json: { message: 'Bad credentials', documentation_url: DOCS } };
    const m = /^\/repos\/([^/]+\/[^/]+?)(\/.*)?$/.exec(url.pathname);
    const repo = m ? all.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !repo) return NOT_FOUND;
    const rest = m[2] ?? '';
    const empty = repo.refs.size === 0;
    /** @type {RegExpExecArray | null} */
    let r;
    if (method === 'GET' && rest === '') {
      return { status: 200, json: { full_name: repo.name, private: repo.private, visibility: repo.private ? 'private' : 'public', default_branch: repo.defaultBranch,
        permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } } };
    }
    if (method === 'GET' && (r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (empty) return EMPTY;
      const branch = decodeURIComponent(r[1]);
      const sha = repo.refs.get(branch);
      return sha ? { status: 200, json: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } } : NOT_FOUND;
    }
    if (method === 'GET' && (r = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = repo.objects.get(r[1]);
      return c?.type === 'commit' ? { status: 200, json: commitJson(r[1], c) } : NOT_FOUND;
    }
    if (method === 'GET' && (r = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      if (repo.objects.get(r[1])?.type !== 'tree') return NOT_FOUND;
      return { status: 200, json: { sha: r[1], tree: treeJson(repo, r[1], url.searchParams.has('recursive')), truncated: false } };
    }
    if ((method === 'GET' || method === 'HEAD') && (r = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
      const b = repo.objects.get(r[1]);
      if (b?.type !== 'blob') return NOT_FOUND;
      if (String(headers.accept ?? '').includes('raw')) return { status: 200, raw: b.data };
      return { status: 200, json: { sha: r[1], node_id: r[1], size: b.data.length, url: `${origin}${url.pathname}`, content: b.data.toString('base64'), encoding: 'base64' } };
    }
    if (method === 'POST' && rest === '/git/blobs') {
      if (empty) return EMPTY;
      if (limit && ++limit.seen > limit.after && limit.times > 0) {
        limit.times--;
        return { status: 403, headers: { 'retry-after': String(limit.retryAfter) }, json: {
          message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID.',
          documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits' } };
      }
      const data = body?.encoding === 'base64' ? Buffer.from(String(body.content), 'base64') : Buffer.from(String(body?.content ?? ''), 'utf8');
      const sha = blob(repo, data);
      return { status: 201, json: { sha, url: `${origin}/repos/${repo.name}/git/blobs/${sha}` } };
    }
    if (method === 'POST' && rest === '/git/trees') {
      if (empty) return EMPTY;
      /** @type {Files} */
      const files = body?.base_tree ? flatten(repo, body.base_tree) : new Map();
      for (const e of body?.tree ?? []) {
        if (e.sha !== undefined && e.content !== undefined) return { status: 422, json: { message: 'Must supply either tree.sha or tree.content, not both.' } };
        if (e.sha === null) {
          if (!files.delete(e.path)) return { status: 422, json: { message: 'Invalid tree info' } };
        } else if (e.content !== undefined) {
          files.set(e.path, { sha: blob(repo, Buffer.from(String(e.content), 'utf8')), mode: e.mode });
        } else if (repo.objects.get(e.sha)?.type === 'blob') {
          files.set(e.path, { sha: e.sha, mode: e.mode });
        } else {
          return { status: 422, json: { message: `tree.sha ${e.sha} is not a valid blob` } };
        }
      }
      if (tamper) {
        tamper = false;
        files.set('tampered.txt', { sha: blob(repo, Buffer.from('x')), mode: '100644' });
      }
      const sha = build(repo, files);
      if (!sha) return { status: 422, json: { message: 'tree.path contains a malformed path component' } };
      return { status: 201, json: { sha, url: `${origin}/repos/${repo.name}/git/trees/${sha}`, tree: treeJson(repo, sha, false), truncated: false } };
    }
    if (method === 'POST' && rest === '/git/commits') {
      if (empty) return EMPTY;
      const parents = body?.parents ?? [];
      if (repo.objects.get(body?.tree)?.type !== 'tree' || parents.some((/** @type {string} */ p) => repo.objects.get(p)?.type !== 'commit')) {
        return { status: 422, json: { message: 'Invalid request.' } };
      }
      const sha = keep(repo, { type: 'commit', tree: body.tree, parents, message: String(body.message ?? ''), date: now() });
      return { status: 201, json: commitJson(sha, repo.objects.get(sha)) };
    }
    if (method === 'PATCH' && (r = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const before = beforeRef;
      beforeRef = null;
      before?.();
      const branch = decodeURIComponent(r[1]);
      const old = repo.refs.get(branch);
      if (!old) return { status: 422, json: { message: 'Reference does not exist' } };
      if (repo.objects.get(body?.sha)?.type !== 'commit') return { status: 422, json: { message: 'Object does not exist' } };
      if (!body.force && !descends(repo, old, body.sha)) return { status: 422, json: { message: 'Update is not a fast forward' } };
      repo.refs.set(branch, body.sha);
      return { status: 200, json: { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } } };
    }
    if (method === 'POST' && rest === '/git/refs') {
      const branch = String(body?.ref ?? '').replace(/^refs\/heads\//, '');
      if (repo.refs.has(branch)) return { status: 422, json: { message: 'Reference already exists' } };
      if (repo.objects.get(body?.sha)?.type !== 'commit') return { status: 422, json: { message: 'Object does not exist' } };
      repo.refs.set(branch, body.sha);
      return { status: 201, json: { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } } };
    }
    if (method === 'PUT' && (r = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(r[1]);
      const branch = body?.branch ?? repo.defaultBranch;
      const parent = repo.refs.get(branch);
      if (!parent && !empty) return { status: 404, json: { message: `Branch ${branch} not found` } };
      const head = parent ? repo.objects.get(parent) : undefined;
      /** @type {Files} */
      const files = head?.type === 'commit' ? flatten(repo, head.tree) : new Map();
      if (files.has(path) && body?.sha !== files.get(path)?.sha) return { status: 422, json: { message: '"sha" wasn\'t supplied.' } };
      const sha = blob(repo, Buffer.from(String(body?.content ?? ''), 'base64'));
      files.set(path, { sha, mode: '100644' });
      const c = commitOf(repo, files, String(body?.message ?? ''), parent ? [parent] : []);
      repo.refs.set(branch, c);
      return { status: 201, json: { content: { name: path.split('/').pop(), path, sha }, commit: commitJson(c, repo.objects.get(c)) } };
    }
    if (method === 'GET' && rest === '/commits') {
      if (empty) return EMPTY;
      let sha = repo.refs.get(url.searchParams.get('sha') ?? repo.defaultBranch);
      if (!sha) return NOT_FOUND;
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const out = [];
      while (sha && out.length < per) {
        const j = commitJson(sha, repo.objects.get(sha));
        out.push({ sha, commit: { message: j.message, author: j.author, committer: j.committer, tree: j.tree }, parents: j.parents });
        sha = j.parents[0]?.sha;
      }
      return { status: 200, json: out };
    }
    return NOT_FOUND;
  }

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      /** @type {Answer} */
      let a;
      /** @type {any} */
      let body = null;
      try {
        const raw = Buffer.concat(chunks);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        a = answer(method, url, req.headers, body);
      } catch (e) {
        a = body === null && chunks.length ? { status: 400, json: { message: 'Problems parsing JSON' } } : { status: 500, json: { message: String(/** @type {any} */ (e)?.message ?? e) } };
      }
      log.push({ method, path: url.pathname, status: a.status });
      const payload = a.raw ?? (a.json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(a.json)));
      res.writeHead(a.status, {
        'access-control-allow-origin': '*', 'access-control-expose-headers': EXPOSE_HEADERS,
        ...(a.raw ? { 'content-type': 'application/octet-stream' } : a.json === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
        'content-length': String(payload.length), ...(a.headers ?? {}),
      });
      res.end(method === 'HEAD' ? undefined : payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

  /** @param {string} name */
  const repoOf = (name) => {
    const r = all.get(name);
    if (!r) throw new Error(`the stand-in has no repository ${name}`);
    return r;
  };
  return {
    origin, token, log,
    /** How many requests with this method went to a path ending so. @param {string} method @param {string} end */
    count: (method, end) => log.filter((l) => l.method === method && l.path.endsWith(end)).length,
    /** The files on a branch (the default one), by path. @param {string} name @param {string} [branch] @returns {Map<string, Buffer>} */
    files(name, branch) {
      const repo = repoOf(name);
      const c = repo.objects.get(repo.refs.get(branch ?? repo.defaultBranch) ?? '');
      /** @type {Map<string, Buffer>} */
      const out = new Map();
      if (c?.type !== 'commit') return out;
      for (const [path, f] of flatten(repo, c.tree)) {
        const b = repo.objects.get(f.sha);
        if (b?.type === 'blob') out.set(path, b.data);
      }
      return out;
    },
    /** The commits on a branch, newest first, by first parents. @param {string} name @param {string} [branch] */
    commits(name, branch) {
      const repo = repoOf(name);
      /** @type {{ sha: string, message: string, parents: string[], tree: string }[]} */
      const out = [];
      let sha = repo.refs.get(branch ?? repo.defaultBranch);
      while (sha) {
        const c = repo.objects.get(sha);
        if (c?.type !== 'commit') break;
        out.push({ sha, message: c.message, parents: c.parents, tree: c.tree });
        sha = c.parents[0];
      }
      return out;
    },
    /** Another device commits these files, as the whole tree, on the default branch. @param {string} name @param {Record<string, string | Buffer>} files @param {string} message */
    commitAs(name, files, message) {
      const repo = repoOf(name);
      const parent = repo.refs.get(repo.defaultBranch);
      /** @type {Files} */
      const tree = new Map(Object.entries(files).map(([p, c]) => [p, { sha: blob(repo, Buffer.from(c)), mode: '100644' }]));
      const sha = commitOf(repo, tree, message, parent ? [parent] : []);
      repo.refs.set(repo.defaultBranch, sha);
      return sha;
    },
    /** After `after` more blob uploads, the next `times` are refused as over a secondary rate limit, asking to wait retryAfter seconds. */
    limitBlobs({ after = 0, retryAfter = 1, times = 1 } = {}) {
      limit = { after, retryAfter, times, seen: 0 };
    },
    /** Runs fn just before the next branch update is handled, as another device moving the branch then would. @param {() => void} fn */
    beforeRefUpdate(fn) {
      beforeRef = fn;
    },
    /** The next tree made holds one file more than it was sent: a stored tree that differs. */
    breakNextTree() {
      tamper = true;
    },
    /** @param {string} name @param {boolean} value */
    setPrivate(name, value) {
      repoOf(name).private = value;
    },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/fake-github.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add test/fakes/github.js test/unit/fake-github.test.js && git commit -m "A stand-in GitHub for the backup tests: Git Data API, statuses, CORS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 4: The GitHub plugin

**Files:**
- Create: `plugins-official/storage-github/annai-plugin.json`, `plugins-official/storage-github/git.js`, `plugins-official/storage-github/index.js`
- Modify: `catalog/plugins.json` (`npm run catalog`)
- Test: `test/unit/storage-github.test.js`

**Interfaces:**
- Consumes:
  - From Task 2: `annai.storage.register`, `annai.helpers.TargetError`, `annai.helpers.zip`, and the `StorageType` contract.
  - `annai.net.fetch`, the traced fetch.
  - From Task 3: `startGitHub`.
- Produces:
  - `git.js`: `blobId(bytes): Promise<string>`, `treeId(files): Promise<string>`, `nest(files): Dir`, `GitPathError`.
  - The storage type `github`, with `stores: 'tree'`, fields `repo` and `api` (advanced), and secret `token`. Besides `PutOptions`, its `put` options take `maxFile`, for tests.
  - Its `list` gives `RemoteBackup`s with `device` and `label` parsed from commit messages of the form `annai backup from <label>\n\nDevice: <id>\nannai <app>\n`.

- [ ] **Step 1: Write the failing test**

`test/unit/storage-github.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/storage-github/index.js';
import { blobId, treeId, nest, GitPathError } from '../../plugins-official/storage-github/git.js';
import { TargetError } from '../../src/core/storage-types.js';
import { ZipReader, ZipWriter, readZip } from '../../src/core/zip.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { utf8, text } from '../../src/core/bytes.js';
import { startGitHub } from '../fakes/github.js';

const REPO = 'me/annai-backup';

/** The GitHub type as annai's core sees it; sent: every request it made. @param {any} [mod] a fresh copy of the plugin: a new session */
function github(mod = { activate }) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const sent = [];
  /** @type {any} */
  let type = null;
  mod.activate({
    helpers: { TargetError, zip: { ZipReader, ZipWriter } },
    net: { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => { sent.push({ url, init }); return fetch(url, init); } },
    storage: { register: (/** @type {any} */ t) => { type = t; return () => {}; } },
  });
  return { type, sent };
}

/** @param {any} gh @param {{ device?: string, label?: string, token?: string, repo?: string, api?: string }} [o] */
const ctx = (gh, o = {}) => ({
  config: { repo: o.repo ?? REPO, api: o.api ?? gh.origin }, secret: { token: o.token ?? gh.token },
  device: { id: o.device ?? 'phone-a', label: o.label ?? 'iPhone' }, app: 'test',
});
/** @param {Record<string, any>} [o] */
const opts = (o = {}) => ({ base: null, maxUpload: Infinity, onProgress: () => {}, ...o });
/** @param {string} kind @param {RegExp} [re] */
const refused = (kind, re = /./) => (/** @type {any} */ e) => e instanceof TargetError && e.kind === kind && re.test(e.message);
/** A photo's worth of bytes that isn't text. @param {number} n */
const binary = (n) => new Uint8Array([0, ...crypto.getRandomValues(new Uint8Array(n))]);

async function device() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(trip, '/notes/bixby.md', 'Bixby Bridge, 1932', { author: 'user' });
  await ws.write(trip, '/files/gate.jpg', binary(3000), { author: 'user' });
  return { store, ws, trip };
}
/** @param {{ store: any }} d */
async function archive(d) {
  const r = await exportArchive(d.store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'test' });
  return { blob: r.blob, name: r.filename, manifest: r.manifest };
}

test("git's own ids: blobs, and trees sorted as git sorts them", async () => {
  assert.equal(await blobId(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(await blobId(utf8('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(await blobId(new Uint8Array(300)), '106bf3ffedc65453d4c9249eb21f0cde1da4c0c1');
  const files = [['a.txt', 'hello\n'], ['dir/b.txt', 'b\n'], ['dir-x/c', ''], ['dir.y', 'd'], ['trips/京都.md', '千本鳥居\n']];
  const entries = await Promise.all(files.map(async ([path, t]) => ({ path, sha: await blobId(utf8(t)) })));
  assert.equal(await treeId(entries), '8705553fc3213fec7f84cb10a01966f932a16f0d'); // git write-tree's id
  assert.equal(await treeId([...entries].reverse()), '8705553fc3213fec7f84cb10a01966f932a16f0d');
  /** @type {[string[], RegExp][]} */
  const bad = [[['a/.git/config'], /\.git/], [['a/.GIT'], /\.git/], [['a//b'], /empty/], [['notes', 'notes/x.md'], /both a file and a folder/],
    [['notes/x.md', 'notes'], /both a file and a folder/], [['a', 'a'], /twice/]];
  for (const [paths, why] of bad) {
    assert.throws(() => nest(paths.map((path) => ({ path, sha: '0'.repeat(40) }))), (e) => e instanceof GitPathError && why.test(e.message));
  }
});

test('the first backup to an empty repository: a README, then the archive as files, in one commit (spec §12.4)', async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type, sent } = github();
    assert.deepEqual([type.type, type.name, type.stores, type.fields.map((/** @type {any} */ f) => f.key), type.secret.map((/** @type {any} */ f) => f.key)],
      ['github', 'GitHub', 'tree', ['repo', 'api'], ['token']]);
    assert.equal(type.where({ repo: REPO }), REPO);
    assert.match((await type.check(ctx(gh))).note, /me\/annai-backup, a private repository/);
    assert.deepEqual(await type.list(ctx(gh)), []);
    const d = await device();
    const a = await archive(d);
    /** @type {string[]} */
    const phases = [];
    const put = await type.put(ctx(gh), a, opts({ onProgress: (/** @type {any} */ p) => phases.push(p.phase) }));
    assert.match(put.id, /^[0-9a-f]{40}$/);
    assert.deepEqual([...new Set(phases)], ['checking', 'uploading']);
    const [backup, readme] = gh.commits(REPO);
    assert.deepEqual([backup.sha, backup.parents, readme.message], [put.id, [readme.sha], 'Start annai backups']);
    assert.equal(backup.message, 'annai backup from iPhone\n\nDevice: phone-a\nannai test\n');
    const files = gh.files(REPO);
    const entries = await readZip(a.blob);
    for (const [name, bytes] of entries) assert.deepEqual(new Uint8Array(files.get(name) ?? []), bytes, name);
    assert.deepEqual([...files.keys()].sort(), [...entries.keys(), 'README.md'].sort());
    assert.equal(gh.count('POST', '/git/blobs'), 1, 'the photo goes as a blob; text travels in the tree');
    assert.ok(put.files > 1 && put.uploaded > 3000);
    const listed = await type.list(ctx(gh));
    assert.deepEqual(listed.map((/** @type {any} */ b) => [b.id, b.device, b.label, b.at]), [[put.id, 'phone-a', 'iPhone', put.at]]);
    for (const s of sent) {
      assert.equal(new Headers(s.init.headers).get('authorization'), `Bearer ${gh.token}`);
      assert.equal(s.url.includes(gh.token), false);
      assert.ok(s.url.startsWith(`${gh.origin}/repos/${REPO}`), s.url);
    }
  } finally {
    await gh.stop();
  }
});

test('the next backup uploads only what changed, on top of the last; it comes back whole (restore)', async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const d = await device();
    const first = await type.put(ctx(gh), await archive(d), opts());
    const blobs = gh.count('POST', '/git/blobs');
    await d.ws.write(d.trip, '/notes/bixby.md', 'Bixby Bridge, 1932, at dawn', { author: 'user' });
    const second = await type.put(ctx(gh), await archive(d), opts({ base: first.id }));
    assert.equal(gh.count('POST', '/git/blobs'), blobs, 'the photo is not sent again');
    assert.deepEqual(gh.commits(REPO)[0].parents, [first.id]);
    assert.equal(text(/** @type {Buffer} */ (gh.files(REPO).get(`trips/${d.trip}/notes/bixby.md`))), 'Bixby Bridge, 1932, at dawn');
    assert.ok(second.files < first.files && second.uploaded < first.uploaded);

    const blob = await type.get(ctx(gh), second.id, { onProgress: () => {} });
    const fresh = createMemoryStore();
    const ws = new Workspace(fresh, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
    await ensureBaseScopes(ws);
    const { trips: [id] } = await importArchive(fresh, await openArchive(blob), { me: 'replace' });
    assert.equal(await ws.readText(id, '/notes/bixby.md'), 'Bixby Bridge, 1932, at dawn');
    assert.equal((await ws.history(id, '/notes/bixby.md')).length, 2);
    assert.deepEqual((await ws.read(id, '/files/gate.jpg'))?.bytes, (await d.ws.read(d.trip, '/files/gate.jpg'))?.bytes);
    await assert.rejects(type.get(ctx(gh), gh.commits(REPO).at(-1).sha, { onProgress: () => {} }), refused('missing', /isn't an annai backup/));
  } finally {
    await gh.stop();
  }
});

test("a newer backup from another device is refused, never overwritten; this device's own isn't newer", async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const a = await archive(await device());
    const android = { device: 'phone-b', label: 'Android phone' };
    const first = await type.put(ctx(gh), a, opts());
    // A phone that has never backed up here meets the first one's backup.
    await assert.rejects(type.put(ctx(gh, android), a, opts()), (/** @type {any} */ e) =>
      refused('newer')(e) && e.remote.id === first.id && e.remote.device === 'phone-a' && e.remote.label === 'iPhone');
    // Its user chose to back up over it: the first backup stays in the history.
    const over = await type.put(ctx(gh, android), a, opts({ base: first.id }));
    assert.deepEqual(gh.commits(REPO)[0].parents, [first.id]);
    // The first phone's next backup meets the other one's.
    await assert.rejects(type.put(ctx(gh), a, opts({ base: first.id })), (/** @type {any} */ e) => refused('newer')(e) && e.remote.id === over.id && e.remote.label === 'Android phone');
    // A backup this device made, even one it didn't get to note, is no one else's.
    const own = await type.put(ctx(gh, android), a, opts({ base: null }));
    assert.equal(gh.commits(REPO)[0].sha, own.id);
  } finally {
    await gh.stop();
  }
});

test('two devices at the same moment: the branch moved meanwhile, so nothing is overwritten', async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const d = await device();
    const first = await type.put(ctx(gh), await archive(d), opts());
    await d.ws.write(d.trip, '/notes/more.md', 'More', { author: 'user' });
    gh.beforeRefUpdate(() => gh.commitAs(REPO, { 'annai-archive.json': '{}', 'README.md': 'x' }, 'annai backup from Android phone\n\nDevice: phone-b\nannai test\n'));
    await assert.rejects(type.put(ctx(gh), await archive(d), opts({ base: first.id })), refused('newer'));
    assert.equal(gh.commits(REPO)[0].message.split('\n')[0], 'annai backup from Android phone');
  } finally {
    await gh.stop();
  }
});

test('the wrong repository is refused in plain words, before anything is written', async () => {
  const gh = await startGitHub({ repos: {
    [REPO]: {}, 'me/code': { files: { 'src/index.js': 'x', 'package.json': '{}' } }, 'me/public': { private: false },
    'me/readme': { files: { 'README.md': 'Mine', LICENSE: 'MIT', '.gitignore': 'x' } },
  } });
  try {
    const { type } = github();
    const a = await archive(await device());
    await assert.rejects(type.check(ctx(gh, { repo: 'me/public' })), refused('refused', /me\/public is public/));
    await assert.rejects(type.put(ctx(gh, { repo: 'me/public' }), a, opts()), refused('refused', /public/));
    await assert.rejects(type.put(ctx(gh, { repo: 'me/code' }), a, opts()), refused('refused', /holds other files \(package\.json, src\)/));
    await assert.rejects(type.check(ctx(gh, { token: 'ghp_wrong' })), refused('auth', /didn't accept the access token/));
    await assert.rejects(type.check(ctx(gh, { repo: 'me/nothing' })), refused('missing', /can't find me\/nothing/));
    await assert.rejects(type.check(ctx(gh, { repo: 'not a repo' })), refused('setup', /owner\/name/));
    await assert.rejects(type.check(ctx(gh, { token: '' })), refused('setup', /access token/));
    await assert.rejects(type.check(ctx(gh, { api: 'http://example.com' })), refused('setup', /https/));
    // A README, a licence and a .gitignore stay as they are.
    await type.put(ctx(gh, { repo: 'me/readme' }), a, opts());
    const kept = gh.files('me/readme');
    assert.deepEqual([text(/** @type {Buffer} */ (kept.get('README.md'))), text(/** @type {Buffer} */ (kept.get('LICENSE'))), kept.has('.gitignore')], ['Mine', 'MIT', true]);
    assert.ok(gh.log.filter((l) => l.method !== 'GET' && l.method !== 'HEAD').every((l) => l.path.startsWith('/repos/me/readme/')));
  } finally {
    await gh.stop();
  }
});

test('GitHub asks annai to wait: it waits, and a later try never sends the same file twice', async () => {
  const gh = await startGitHub({ repos: { [REPO]: {}, 'me/two': {}, 'me/three': {} } });
  try {
    const { type } = github();
    const d = await device();
    await d.ws.write(d.trip, '/files/second.jpg', binary(2000), { author: 'user' });
    const a = await archive(d);
    const posts = (/** @type {string} */ repo) => gh.log.filter((l) => l.method === 'POST' && l.path === `/repos/${repo}/git/blobs`);
    // A short wait is sat out.
    gh.limitBlobs({ after: 0, retryAfter: 1, times: 1 });
    const started = Date.now();
    await type.put(ctx(gh), a, opts());
    assert.ok(Date.now() - started >= 900);
    assert.deepEqual(posts(REPO).map((l) => l.status), [403, 201, 201]);
    // A long one ends the backup for now, and nothing counts until the commit lands.
    gh.limitBlobs({ after: 1, retryAfter: 600, times: 1 });
    await assert.rejects(type.put(ctx(gh, { repo: 'me/two' }), a, opts()), (/** @type {any} */ e) =>
      refused('rate', /carries on by itself/)(e) && e.retryAt > Date.now() + 500_000);
    assert.equal(gh.commits('me/two').length, 1);
    await type.put(ctx(gh, { repo: 'me/two' }), a, opts());
    assert.deepEqual(posts('me/two').map((l) => l.status), [201, 403, 201], 'the first photo was not sent again');
    // In a new session (a fresh copy of the plugin), a HEAD request finds what an unfinished try left.
    gh.limitBlobs({ after: 1, retryAfter: 600, times: 1 });
    await assert.rejects(type.put(ctx(gh, { repo: 'me/three' }), a, opts()), refused('rate'));
    const later = github(await import(new URL('../../plugins-official/storage-github/index.js?session=2', import.meta.url).href));
    await later.type.put(ctx(gh, { repo: 'me/three' }), a, opts());
    assert.deepEqual(posts('me/three').map((l) => l.status), [201, 403, 201]);
  } finally {
    await gh.stop();
  }
});

test("what GitHub can't hold stops the backup with its name; a backup too large to send without asking says how large", async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const d = await device();
    await assert.rejects(type.put(ctx(gh), await archive(d), opts({ maxFile: 1000 })), refused('refused', /over 1 KB, and \/files\/gate\.jpg is 3 KB/));
    await assert.rejects(type.put(ctx(gh), await archive(d), opts({ maxUpload: 10 })), (/** @type {any} */ e) => refused('large')(e) && e.bytes > 3000);
    assert.equal(gh.count('POST', '/git/blobs') + gh.count('POST', '/git/trees') + gh.count('POST', '/git/commits'), 0);
    await d.ws.write(d.trip, '/notes/.git/config', 'x', { author: 'user' });
    await assert.rejects(type.put(ctx(gh), await archive(d), opts()), refused('refused', /\.git/));
    // A tree GitHub stored differently from what annai sent is never committed.
    gh.breakNextTree();
    await assert.rejects(type.put(ctx(gh), await archive(await device()), opts()), refused('other', /differently/));
    assert.deepEqual(gh.commits(REPO).map((c) => c.message), ['Start annai backups']);
  } finally {
    await gh.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/storage-github.test.js`
Expected: FAIL: `plugins-official/storage-github/index.js` doesn't exist.

- [ ] **Step 3: Write the plugin**

`plugins-official/storage-github/annai-plugin.json`:

```json
{
  "id": "storage-github",
  "name": "GitHub",
  "version": "0.1.0",
  "api": 1,
  "entry": "index.js",
  "description": "Backs up everything to a private GitHub repository: each backup is a commit, and only changed files are uploaded.",
  "provides": { "storage-type": ["github"] }
}
```

`plugins-official/storage-github/git.js`:

```js
/**
 * Git's object ids, made in the browser with WebCrypto's SHA-1, so annai knows which files a
 * repository already has, and can check that GitHub stored exactly what it sent (spec §12.4: only
 * changed files are uploaded).
 * @typedef {{ path: string, sha: string, mode?: string }} TreeFile mode: "100644" unless given
 * @typedef {{ files: Map<string, { sha: string, mode: string }>, dirs: Map<string, Dir> }} Dir
 */

const enc = new TextEncoder();

/** A path git can't hold, in plain words. */
export class GitPathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GitPathError';
  }
}

/** @param {ArrayBuffer} b */
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** @param {string} s */
function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** @param {Uint8Array[]} parts */
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** @param {Uint8Array<ArrayBuffer>} bytes */
const sha1 = async (bytes) => hex(await crypto.subtle.digest('SHA-1', bytes));

/** The id git gives some content: the SHA-1 of "blob <size>\0" and the bytes. @param {Uint8Array} bytes */
export function blobId(bytes) {
  return sha1(join([enc.encode(`blob ${bytes.byteLength}\0`), bytes]));
}

/**
 * The files as folders, refusing what git can't hold: an empty, "." or ".." part, a part named
 * .git, a name that is both a file and a folder, and a file listed twice.
 * @param {TreeFile[]} files @returns {Dir}
 */
export function nest(files) {
  /** @type {Dir} */
  const root = { files: new Map(), dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new GitPathError(`git can't hold "${f.path}": it has an empty, "." or ".." part.`);
    if (parts.some((p) => p.toLowerCase() === '.git')) throw new GitPathError(`git can't hold "${f.path}": nothing in it may be called .git.`);
    let d = root;
    for (const [i, p] of parts.slice(0, -1).entries()) {
      if (d.files.has(p)) throw new GitPathError(`git can't hold both a file and a folder called "${parts.slice(0, i + 1).join('/')}".`);
      let next = d.dirs.get(p);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        d.dirs.set(p, next);
      }
      d = next;
    }
    const name = /** @type {string} */ (parts.at(-1));
    if (d.dirs.has(name)) throw new GitPathError(`git can't hold both a file and a folder called "${f.path}".`);
    if (d.files.has(name)) throw new GitPathError(`"${f.path}" is in the backup twice.`);
    d.files.set(name, { sha: f.sha, mode: f.mode ?? '100644' });
  }
  return root;
}

/** Compares bytes the way git sorts tree entries. @param {Uint8Array} a @param {Uint8Array} b */
function compare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** @param {Dir} d @returns {Promise<string>} */
async function hashDir(d) {
  /** @type {{ key: Uint8Array, head: Uint8Array, sha: string }[]} */
  const entries = [];
  for (const [name, f] of d.files) entries.push({ key: enc.encode(name), head: enc.encode(`${f.mode} ${name}\0`), sha: f.sha });
  for (const [name, sub] of d.dirs) entries.push({ key: enc.encode(`${name}/`), head: enc.encode(`40000 ${name}\0`), sha: await hashDir(sub) });
  entries.sort((a, b) => compare(a.key, b.key));
  const body = join(entries.flatMap((e) => [e.head, fromHex(e.sha)]));
  return sha1(join([enc.encode(`tree ${body.byteLength}\0`), body]));
}

/**
 * The id of the tree git makes of these files: folders become trees of their own, and entries sort
 * by their UTF-8 bytes, a folder as its name followed by "/". Rejects with GitPathError (see nest).
 * @param {TreeFile[]} files @returns {Promise<string>}
 */
export async function treeId(files) {
  return hashDir(nest(files));
}
```

`plugins-official/storage-github/index.js`:

```js
import { blobId, treeId, GitPathError } from './git.js';

/**
 * GitHub as a place for annai's backups (spec §12.4), through its Git Data API, which accepts
 * browser calls. A backup is the archive's files as one commit on the repository's default branch,
 * and a file GitHub already has isn't sent again. The repository must be private and hold nothing
 * but annai's backups (a README and the like stay). The token is a fine-grained personal access
 * token with Contents: Read and write for that repository.
 * @typedef {{ base: string, repo: string, token: string, device: { id: string, label: string }, app: string,
 *   TargetError: any, zip: any, net: (url: string, init?: RequestInit) => Promise<Response>, seen: Set<string> }} G
 *   seen: blob ids GitHub confirmed in this session, so a later try sends nothing twice
 * @typedef {{ sha: string, size: number, mode: string }} RemoteFile
 */

const API = 'https://api.github.com';
/** GitHub holds files up to 100 MB. */
const MAX_FILE = 100 * 1024 * 1024;
/** Text files up to this size travel inside the tree request, many in one request. */
const INLINE_MAX = 256 * 1024;
/** At most this much text in one tree request; the rest goes as blobs. */
const INLINE_TOTAL = 4 * 1024 * 1024;
/** The longest wait GitHub may ask for that annai sits out; a longer one ends this backup for now. */
const MAX_WAIT = 5 * 60_000;
const MANIFEST = 'annai-archive.json';
/** The top-level files and folders of annai's backups. */
const OURS = new Set([MANIFEST, 'me', 'trips', 'system', 'blobs']);
/** What else a backup repository may hold at its top; kept as it is. */
const EXTRAS = /^(readme|license|licence|copying|notice)(\.[\w-]+)?$|^\.(gitignore|gitattributes|github)$/i;
const README = '# annai backups\n\nThis private repository holds backups made by annai (https://annai.guide). Each commit is a backup of everything on one device. To restore one, open annai, then Settings → Backups.\n';
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
/** Blob ids GitHub confirmed in this session, by API address and repository. @type {Map<string, Set<string>>} */
const confirmed = new Map();

/** @param {any} annai */
export function activate(annai) {
  const { TargetError, zip } = annai.helpers;
  /** @param {any} c @returns {G} */
  const client = (c) => {
    const base = String(c.config.api || API).trim().replace(/\/+$/, '');
    const repo = String(c.config.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const key = `${base} ${repo}`;
    const seen = confirmed.get(key) ?? new Set();
    confirmed.set(key, seen);
    return { base, repo, token: String(c.secret.token ?? '').trim(), device: c.device, app: c.app, TargetError, zip, net: annai.net.fetch, seen };
  };
  return annai.storage.register({
    type: 'github',
    name: 'GitHub',
    stores: 'tree',
    fields: [
      { key: 'repo', label: 'Repository', placeholder: 'you/annai-backup' },
      { key: 'api', label: 'GitHub API address', placeholder: API, advanced: true },
    ],
    secret: [{ key: 'token', label: 'Access token' }],
    help: "Make a new private repository on GitHub for annai's backups. Then make a fine-grained access token for that repository only, with Contents: Read and write, and paste it here. The token stays on this device; it is never in a backup.",
    helpUrl: 'https://github.com/settings/personal-access-tokens/new',
    helpLabel: 'Make a token on GitHub',
    where: (/** @type {any} */ config) => String(config.repo || 'GitHub'),
    check: (/** @type {any} */ c) => check(client(c)),
    list: (/** @type {any} */ c) => list(client(c)),
    put: (/** @type {any} */ c, /** @type {any} */ archive, /** @type {any} */ o) => put(client(c), archive, o),
    get: (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ o) => get(client(c), id, o),
  });
}

/** @param {number} ms @param {AbortSignal} [signal] */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
/** @param {string} path */
const top = (path) => path.split('/')[0];
/** A path as the user knows it: a trip's file without the trip's id. @param {string} path */
const shown = (path) => path.replace(/^trips\/[^/]+\//, '/');
/** @param {number} n */
const size = (n) => (n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${Math.round(n / 1_000_000)} MB`);
/** @param {number} ms */
const minutes = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
};
/** @param {string} branch */
const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The bytes as text, when they are UTF-8 that travels unchanged inside JSON; otherwise null. @param {Uint8Array} bytes */
function asText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One request to the repository's API. A wait GitHub asks for is sat out (up to MAX_WAIT), then
 * the request goes again; a longer one ends the backup with TargetError "rate".
 * @param {G} g @param {string} method @param {string} path after /repos/<owner>/<name>
 * @param {{ body?: any, raw?: boolean, signal?: AbortSignal }} [o] @returns {Promise<Response>}
 */
async function call(g, method, path, { body, raw = false, signal } = {}) {
  for (let tries = 1; ; tries++) {
    const res = await g.net(`${g.base}/repos/${g.repo}${path}`, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${g.token}`,
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const wait = await rateWait(res);
    if (wait === null) return res;
    if (wait > MAX_WAIT || tries >= 6) {
      throw new g.TargetError('rate', `GitHub asked annai to slow down. The backup carries on by itself in about ${minutes(wait)}.`, { retryAt: Date.now() + wait });
    }
    await sleep(wait, signal);
  }
}

/** How long GitHub asks annai to wait, or null when this isn't a rate limit. @param {Response} res @returns {Promise<number | null>} */
async function rateWait(res) {
  if (res.status !== 403 && res.status !== 429) return null;
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') return Math.max(1000, Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now());
  if (res.status === 429) return 60_000;
  return /rate limit/i.test(await res.clone().text().catch(() => '')) ? 60_000 : null;
}

/** A failed answer from GitHub in plain words. @param {G} g @param {Response} res */
async function failure(g, res) {
  let said = '';
  try {
    said = String((await res.json())?.message ?? '');
  } catch {
    // not JSON
  }
  const E = g.TargetError;
  if (res.status === 401) return new E('auth', "GitHub didn't accept the access token. Make a new one, paste it here, and save.");
  if (res.status === 403) return new E('refused', `The access token isn't allowed to do this in ${g.repo}. Give it Contents: Read and write for this repository.`);
  if (res.status === 404) return new E('missing', `annai can't find ${g.repo} on GitHub. Check the name, and that the token has access to it.`);
  if (res.status >= 500) return new E('other', `GitHub had a problem (HTTP ${res.status}). annai tries again later.`);
  return new E('other', `GitHub refused this (HTTP ${res.status}${said ? `: ${said}` : ''}). annai tries again later.`);
}

/** A request whose answer must have one of the ok statuses; its JSON. @param {G} g @param {string} method @param {string} path @param {any} [body] @param {number[]} [ok] */
async function json(g, method, path, body, ok = [200]) {
  const res = await call(g, method, path, { body });
  if (!ok.includes(res.status)) throw await failure(g, res);
  return res.json();
}

/** What can be told without asking GitHub. @param {G} g */
function ready(g) {
  const E = g.TargetError;
  if (!/^https:\/\/[^/]|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(g.base)) throw new E('setup', "GitHub's API address must start with https://.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(g.repo)) throw new E('setup', 'Write the repository as owner/name, for example you/annai-backup.');
  if (!g.token) throw new E('setup', 'Paste an access token for the repository, then save.');
}

/** The repository, refused unless it is private and the token may change it. @param {G} g */
async function repoInfo(g) {
  ready(g);
  const E = g.TargetError;
  const r = await json(g, 'GET', '');
  if (!r.private) {
    throw new E('refused', `${r.full_name} is public, so anyone could read your trips there. Make it private on GitHub (the repository's Settings, then Change visibility), or choose a private repository.`);
  }
  if (r.permissions?.push === false) throw new E('refused', `The access token can read ${r.full_name} but not change it. Give it Contents: Read and write.`);
  return r;
}

/** @param {G} g */
async function check(g) {
  const r = await repoInfo(g);
  return { note: `Works: annai can reach ${r.full_name}, a private repository.` };
}

/** The branch's last commit: its id, null when there is no such branch, or "empty" for a repository with no commits. @param {G} g @param {string} branch */
async function headOf(g, branch) {
  const res = await call(g, 'GET', `/git/ref/heads/${refPath(branch)}`);
  if (res.status === 404) return null;
  if (res.status === 409) return 'empty';
  if (!res.ok) throw await failure(g, res);
  return /** @type {string} */ ((await res.json()).object.sha);
}

/** A commit and its files, by path. @param {G} g @param {string} sha */
async function snapshot(g, sha) {
  const commit = await json(g, 'GET', `/git/commits/${sha}`);
  const tree = await json(g, 'GET', `/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new g.TargetError('refused', `${g.repo} holds more files than GitHub lists at once, so annai can't use it. Choose a new private repository.`);
  /** @type {Map<string, RemoteFile>} */
  const files = new Map();
  for (const e of tree.tree) if (e.type === 'blob') files.set(e.path, { sha: e.sha, size: e.size ?? 0, mode: e.mode });
  return { commit, files };
}

/** A commit as a backup annai lists. @param {{ sha: string, message: string, author?: { date?: string }, committer?: { date?: string } }} c */
function describe(c) {
  const device = /^Device: (\S+)$/m.exec(c.message)?.[1];
  const label = /^annai backup from (.+)$/m.exec(c.message)?.[1];
  return { id: c.sha, at: Date.parse(c.author?.date ?? c.committer?.date ?? '') || 0, ...(device ? { device } : {}), ...(label ? { label } : {}) };
}

/** @param {G} g */
const message = (g) => `annai backup from ${g.device.label}\n\nDevice: ${g.device.id}\nannai ${g.app}\n`;

/** An empty repository's first commit: GitHub's Git Data API needs one. @param {G} g @returns {Promise<string>} */
async function start(g) {
  const res = await call(g, 'PUT', '/contents/README.md', { body: { message: 'Start annai backups', content: base64(enc.encode(README)) } });
  if (res.status !== 201 && res.status !== 200) throw await failure(g, res);
  return (await res.json()).commit.sha;
}

/**
 * Backs up the archive as one commit: its files, plus the README and the like the repository holds.
 * @param {G} g @param {{ blob: Blob }} archive
 * @param {{ base?: string | null, maxUpload?: number, onProgress?: (p: any) => void, signal?: AbortSignal, maxFile?: number }} [o]
 */
async function put(g, archive, { base = null, maxUpload = Infinity, onProgress = () => {}, signal, maxFile = MAX_FILE } = {}) {
  const E = g.TargetError;
  const repo = await repoInfo(g);
  const branch = repo.default_branch;
  let parent = await headOf(g, branch);
  if (parent === 'empty') parent = await start(g);
  /** @type {Map<string, RemoteFile>} */
  let old = new Map();
  if (parent) {
    const snap = await snapshot(g, parent);
    old = snap.files;
    const remote = describe(snap.commit);
    if (old.has(MANIFEST) && parent !== base && remote.device !== g.device.id) throw new E('newer', `There is a newer backup in ${g.repo}.`, { remote });
    const foreign = [...new Set([...old.keys()].map(top))].filter((t) => !OURS.has(t) && !EXTRAS.test(t));
    if (foreign.length) {
      throw new E('refused', `${g.repo} holds other files (${foreign.slice(0, 3).join(', ')}), so annai won't back up into it. Make a new private repository for annai's backups.`);
    }
  }
  // The backup's files, by git's ids.
  const zipped = await g.zip.ZipReader.open(archive.blob);
  /** @type {string[]} */
  const names = zipped.names();
  /** @type {{ path: string, sha: string, size: number }[]} */
  const entries = [];
  for (const [i, path] of names.entries()) {
    const n = zipped.size(path);
    if (n > maxFile) throw new E('refused', `GitHub can't hold files over ${size(maxFile)}, and ${shown(path)} is ${size(n)}. Remove it from annai, or back up to another kind of place.`);
    entries.push({ path, sha: await blobId(await zipped.read(path)), size: n });
    onProgress({ phase: 'checking', done: i + 1, total: names.length });
  }
  const extras = [...old].filter(([path]) => EXTRAS.test(top(path))).map(([path, f]) => ({ path, sha: f.sha, mode: f.mode }));
  /** @type {string} */
  let want;
  try {
    want = await treeId([...entries, ...extras]);
  } catch (e) {
    if (e instanceof GitPathError) throw new E('refused', `${e.message} Rename it in annai, then back up again.`);
    throw e;
  }
  // What GitHub doesn't have yet, each content once.
  const have = new Set([...old.values()].map((f) => f.sha));
  /** @type {typeof entries} */
  const send = [];
  for (const e of entries) if (!have.has(e.sha) && !send.some((s) => s.sha === e.sha)) send.push(e);
  const bytes = send.reduce((n, e) => n + e.size, 0);
  if (bytes > maxUpload) throw new E('large', `This backup would upload ${size(bytes)}.`, { bytes });
  /** @type {Map<string, string>} content id → text sent inside the tree request */
  const inline = new Map();
  let room = INLINE_TOTAL;
  for (const [i, e] of send.entries()) {
    const content = await zipped.read(e.path);
    const text = e.size <= INLINE_MAX && e.size <= room && !g.seen.has(e.sha) ? asText(content) : null;
    if (text !== null) {
      inline.set(e.sha, text);
      room -= e.size;
    } else {
      await upload(g, e, content, signal);
    }
    onProgress({ phase: 'uploading', done: i + 1, total: send.length });
  }
  const tree = [
    ...entries.map((e) => (inline.has(e.sha)
      ? { path: e.path, mode: '100644', type: 'blob', content: inline.get(e.sha) }
      : { path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
    ...extras.map((e) => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha })),
  ];
  const made = await json(g, 'POST', '/git/trees', { tree }, [201]);
  if (made.sha !== want) throw new E('other', "GitHub stored this backup differently from what annai sent, so annai didn't keep it. annai tries again later.");
  for (const sha of inline.keys()) g.seen.add(sha);
  const commit = await json(g, 'POST', '/git/commits', { message: message(g), tree: made.sha, parents: parent ? [parent] : [] }, [201]);
  const moved = parent
    ? await call(g, 'PATCH', `/git/refs/heads/${refPath(branch)}`, { body: { sha: commit.sha, force: false } })
    : await call(g, 'POST', '/git/refs', { body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  if (moved.status === 422) {
    const [remote] = await list(g).catch(() => []);
    throw new E('newer', `Another device backed up to ${g.repo} at the same moment.`, { remote: remote ?? { id: '', at: Date.now() } });
  }
  if (!moved.ok) throw await failure(g, moved);
  return { id: commit.sha, at: Date.parse(commit.author?.date ?? '') || Date.now(), uploaded: bytes, files: send.length };
}

/** Sends one file as a blob, unless GitHub has it already (an unfinished try may have left it). @param {G} g @param {{ path: string, sha: string }} e @param {Uint8Array} bytes @param {AbortSignal} [signal] */
async function upload(g, e, bytes, signal) {
  if (g.seen.has(e.sha)) return;
  const there = await call(g, 'HEAD', `/git/blobs/${e.sha}`, { signal });
  if (there.status !== 200) {
    const res = await call(g, 'POST', '/git/blobs', { body: { content: base64(bytes), encoding: 'base64' }, signal });
    if (res.status !== 201) throw await failure(g, res);
    if ((await res.json()).sha !== e.sha) throw new g.TargetError('other', `GitHub stored ${shown(e.path)} differently from what annai sent. annai tries again later.`);
  }
  g.seen.add(e.sha);
}

/** The backups on the default branch, newest first. @param {G} g */
async function list(g) {
  const r = await repoInfo(g);
  const res = await call(g, 'GET', `/commits?sha=${encodeURIComponent(r.default_branch)}&per_page=30`);
  if (res.status === 409) return [];
  if (!res.ok) throw await failure(g, res);
  /** @type {any[]} */
  const commits = await res.json();
  return commits.filter((c) => /^annai backup\b/.test(c.commit?.message ?? ''))
    .map((c) => describe({ sha: c.sha, message: c.commit.message, author: c.commit.author, committer: c.commit.committer }));
}

/**
 * One backup, as an archive file annai opens on its import screen: the files the backup's
 * annai-archive.json names, read from that commit.
 * @param {G} g @param {string} id @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o]
 */
async function get(g, id, { onProgress = () => {}, signal } = {}) {
  ready(g);
  const E = g.TargetError;
  const { files } = await snapshot(g, id);
  const m = files.get(MANIFEST);
  if (!m) throw new E('missing', "That commit isn't an annai backup.");
  const manifestBytes = await blob(g, m.sha, signal);
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new E('other', 'This backup is damaged: its annai-archive.json is not readable.');
  }
  const named = [...(manifest?.files ?? []), ...(manifest?.blobs ?? []), ...(manifest?.extras ?? [])].map((x) => x?.name);
  const names = [...new Set(named.filter((n) => typeof n === 'string' && n !== MANIFEST))];
  const out = new g.zip.ZipWriter();
  for (const [i, name] of names.entries()) {
    const f = files.get(name);
    if (!f) throw new E('missing', `This backup is damaged: ${shown(name)} is missing from GitHub.`);
    await out.add(name, await blob(g, f.sha, signal), { compress: false });
    onProgress({ phase: 'downloading', done: i + 1, total: names.length });
  }
  await out.add(MANIFEST, manifestBytes, { compress: false });
  return out.finish();
}

/** @param {G} g @param {string} sha @param {AbortSignal} [signal] */
async function blob(g, sha, signal) {
  const res = await call(g, 'GET', `/git/blobs/${sha}`, { raw: true, signal });
  if (!res.ok) throw await failure(g, res);
  return new Uint8Array(await res.arrayBuffer());
}
```

Then run `npm run catalog`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/storage-github.test.js`
Expected: PASS, 8 tests (one waits about a second, as GitHub asked).

- [ ] **Step 5: Commit**

```bash
npm run catalog && npm run stamp && npm run check && git add plugins-official/storage-github catalog/plugins.json test/unit/storage-github.test.js && git commit -m "GitHub backups: the archive's files as one commit, only changed files uploaded

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 5: The backup service

**Files:**
- Create: `src/core/backup.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/backup.test.js`, with `test/unit/backup-kit.js` (a place in memory and a device, shared with Task 6)

**Interfaces:**
- Consumes:
  - From Task 1: `backup-targets.js`.
  - From Task 2: `storageTypes`, `TargetError`, `NEEDS_YOU`, `isPluginBug`.
  - Existing: `exportArchive`, `PRESETS`, `recordBackup`, `withoutSecrets`, `logEvent`.
  - For its integration test: the plugin (Task 4) and the stand-in (Task 3).
- Produces: `retryDelay(count): number`, and `createBackups({ store, ws, registry, app, label, noun?, ensure?, now? })`, which returns `Backups`:
  - Fields: `label`, `noun`.
  - Places: `list(): Promise<Target[]>`, `get(id)`, `typeOf(type): StorageType | undefined`, `types(): StorageType[]`.
  - Setting up: `add(type): Promise<string>` (ensures the type's plugin), `update(id, { config?, secret?, auto?, mobileData? })` (a changed config or secret clears `checked`), `remove(id)`, `savedSecrets(id): Promise<string[]>`, `turnOn(id)`.
  - `check(id): Promise<{ note, newer: RemoteBackup | null }>`.
  - `backUp(id, { over?, maxUpload?, reason? }): Promise<{ id, at, uploaded?, files? }>`.
  - `remote(id): Promise<RemoteBackup[]>`, `download(id, backupId): Promise<Blob>`, `accept(id, remote)`.
  - Running: `stop(id)`, `progress(id): Progress | null`, `on(fn): () => void`.
  - Every error it throws is a `TargetError` whose message holds no secret; a stop throws the `AbortError`.
  - System log events: `backup { target, type, reason, backup, files, uploaded, ms }`, `backup.newer { target, type, remote }`, `backup.error { target, type, kind, message, bytes? }` and `backup.download { target, type, backup, bytes }`.

- [ ] **Step 1: Write the failing test**

`test/unit/backup-kit.js`:

```js
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { TargetError } from '../../src/core/storage-types.js';
import { createBackups } from '../../src/core/backup.js';

// Shared by the backup tests: a place in memory, and devices that back up to it.

export const TOKEN = 'sekrit-token-0001';

/** A place that keeps backups in memory for every device given it, as the storage type contract says. */
export function memoryPlace() {
  /** @type {{ id: string, at: number, device: string, label: string, blob: Blob }[]} */
  const kept = [];
  /** @type {unknown} */
  let fail = null;
  /** @type {((signal: AbortSignal) => Promise<unknown>) | null} */
  let hold = null;
  let waiting = 0;
  const type = {
    type: 'memory', name: 'Memory', stores: 'tree', pluginId: 'memory-place',
    fields: [{ key: 'where', label: 'Where' }], secret: [{ key: 'token', label: 'Token' }],
    where: (/** @type {any} */ config) => config.where,
    check: async (/** @type {any} */ c) => {
      if (c.secret.token !== TOKEN) throw new TargetError('auth', `The token ${c.secret.token} was refused.`);
      return { note: 'Works.' };
    },
    list: async () => kept.map(({ id, at, device, label }) => ({ id, at, device, label })).reverse(),
    put: async (/** @type {any} */ c, /** @type {any} */ a, /** @type {any} */ o) => {
      if (fail) {
        const e = fail;
        fail = null;
        throw e;
      }
      if (hold) {
        waiting++;
        await hold(o.signal);
      }
      const newest = kept.at(-1);
      if (newest && newest.id !== o.base && newest.device !== c.device.id) {
        throw new TargetError('newer', 'There is a newer backup.', { remote: { id: newest.id, at: newest.at, device: newest.device, label: newest.label } });
      }
      if (a.blob.size > o.maxUpload) throw new TargetError('large', 'Too large.', { bytes: a.blob.size });
      o.onProgress({ phase: 'uploading', done: 1, total: 1 });
      const b = { id: `b${kept.length + 1}`, at: 1_000_000 + kept.length, device: c.device.id, label: c.device.label, blob: a.blob };
      kept.push(b);
      return { id: b.id, at: b.at, uploaded: a.blob.size, files: 1 };
    },
    get: async (/** @type {any} */ _c, /** @type {string} */ id) => {
      const b = kept.find((x) => x.id === id);
      if (!b) throw new TargetError('missing', 'That backup is gone.');
      return b.blob;
    },
  };
  return {
    kept, type,
    waiting: () => waiting,
    /** The next put throws e. @param {unknown} e */
    failNext(e) { fail = e; },
    /** Puts wait until released, or until their signal aborts. @returns {() => void} release */
    pause() {
      /** @type {(v: unknown) => void} */
      let open = () => {};
      const gate = new Promise((resolve) => { open = resolve; });
      hold = (signal) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        gate.then(resolve);
      });
      return () => {
        hold = null;
        open(undefined);
      };
    },
  };
}

/** A device whose registry has the place's type. @param {ReturnType<typeof memoryPlace>} place @param {string} [label] */
export async function device(place, label = 'iPhone') {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => { logged.push(ev); } });
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  registry.add('memory-place', 'storage-type', place.type);
  let clock = 2_000_000;
  const backups = createBackups({ store, ws, registry, app: 'test', label, noun: 'phone', now: () => clock });
  const trip = await createTrip(ws, { title: 'Big Sur' });
  return { store, ws, registry, backups, trip, logged, now: () => clock, later: (/** @type {number} */ ms) => { clock += ms; } };
}

/** @param {Awaited<ReturnType<typeof device>>} d */
export async function placeOn(d) {
  const id = await d.backups.add('memory');
  await d.backups.update(id, { config: { where: 'here' }, secret: { token: TOKEN } });
  return id;
}

/** Everything a store keeps, as text: every log entry and every stored content. @param {any} store */
export function everything(store) {
  return store.tx(['scopes', 'events', 'blobs'], 'readonly', async (/** @type {any} */ t) => {
    const out = [];
    for (const s of await t.listScopes()) out.push(JSON.stringify(await t.listEvents(s.id)));
    for (const b of await t.listBlobs()) out.push(new TextDecoder().decode((await t.getBlob(b.hash))?.data));
    return out.join('\n');
  });
}

/** @param {() => boolean} ok */
export async function until(ok) {
  while (!ok()) await new Promise((resolve) => setTimeout(resolve, 1));
}

```

`test/unit/backup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, removeTrip, backupState, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { openArchive, importArchive } from '../../src/core/archive.js';
import { TargetError } from '../../src/core/storage-types.js';
import { addTarget } from '../../src/core/backup-targets.js';
import { createBackups, retryDelay } from '../../src/core/backup.js';
import { startGitHub } from '../fakes/github.js';
import { TOKEN, memoryPlace, device, placeOn, everything, until } from './backup-kit.js';

test('a backup of everything goes to the place, and the trips it holds count as backed up (spec §4.9, §12.4)', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await d.backups.add('memory');
  assert.deepEqual((await d.backups.list()).map((t) => [t.id, t.type, t.name, t.auto, t.checked]), [[id, 'memory', 'Memory', 'changes', null]]);
  await d.backups.update(id, { config: { where: 'here' }, secret: { token: TOKEN } });
  assert.deepEqual(await d.backups.savedSecrets(id), ['token']);
  assert.deepEqual(await d.backups.check(id), { note: 'Works.', newer: null });
  assert.equal((await d.backups.get(id))?.checked, d.now());
  let heard = 0;
  const off = d.backups.on(() => { heard++; });
  const result = await d.backups.backUp(id);
  off();
  assert.ok(heard >= 3, 'building, uploading, done');
  assert.equal(result.id, 'b1');
  assert.deepEqual(await backupState(d.store, d.trip), { at: 1_000_000, changed: false });
  const t = await d.backups.get(id);
  assert.deepEqual([t?.last?.id, t?.last?.at, t?.hold], ['b1', 1_000_000, null]);
  assert.ok((t?.last?.seqs[d.trip] ?? 0) > 0);
  const opened = await openArchive(place.kept[0].blob);
  assert.equal(opened.manifest.kind, 'everything');
  assert.ok(opened.manifest.scopes.some((s) => s.record.id === d.trip));
  const [logged] = await d.store.tx(['events'], 'readonly', (tx) => tx.listEvents(SYS, { types: ['backup'] }));
  assert.deepEqual([logged.data.target, logged.data.backup, logged.data.reason, logged.data.files], [id, 'b1', 'user', 1]);
  assert.equal(d.backups.progress(id), null);
  // A changed place must pass a test again before automatic backups use it.
  await d.backups.update(id, { config: { where: 'there' } });
  assert.equal((await d.backups.get(id))?.checked, null);
  await d.backups.update(id, { auto: 'daily', mobileData: true });
  assert.deepEqual([(await d.backups.get(id))?.auto, (await d.backups.get(id))?.mobileData, (await d.backups.get(id))?.config.where], ['daily', true, 'there']);
});

test("a place's token never reaches the trace, its record, or an error annai keeps (spec §15)", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await d.backups.add('memory');
  await d.backups.update(id, { secret: { token: 'ghp_wrong_but_secret_77' } });
  await assert.rejects(d.backups.check(id), (e) => e instanceof TargetError && e.kind === 'auth' && e.message === 'The token «key» was refused.');
  place.failNext(new Error('upload failed for ghp_wrong_but_secret_77'));
  await assert.rejects(d.backups.backUp(id), (e) => e instanceof TargetError && e.kind === 'other' && !e.message.includes('ghp_wrong'));
  assert.equal((await d.backups.get(id))?.hold?.kind, 'error');
  assert.equal((await everything(d.store)).includes('ghp_wrong_but_secret_77'), false);
});

test('single writer: a newer backup from another device pauses this one until the user chooses (spec §12.4)', async () => {
  const place = memoryPlace();
  const phone = await device(place, 'iPhone');
  const android = await device(place, 'Android phone');
  const a = await placeOn(phone);
  const b = await placeOn(android);
  await phone.backups.check(a);
  await phone.backups.backUp(a);
  // The other phone sees a backup it didn't make, and waits for its user.
  const seen = await android.backups.check(b);
  assert.deepEqual([seen.newer?.id, seen.newer?.label], ['b1', 'iPhone']);
  assert.equal((await android.backups.get(b))?.hold?.kind, 'newer');
  await assert.rejects(android.backups.backUp(b), (e) => e instanceof TargetError && e.kind === 'newer');
  assert.equal(place.kept.length, 1);
  // Its user backs it up over the other one: annai builds on the one the user saw.
  await android.backups.backUp(b, { over: true });
  assert.equal(place.kept.length, 2);
  assert.equal((await android.backups.get(b))?.hold, null);
  // The first phone meets the newer backup, imports it as a copy, then builds on it.
  await assert.rejects(phone.backups.backUp(a), (e) => e instanceof TargetError && e.kind === 'newer' && e.remote?.label === 'Android phone');
  const hold = /** @type {any} */ ((await phone.backups.get(a))?.hold);
  assert.equal(hold.kind, 'newer');
  const blob = await phone.backups.download(a, hold.remote.id);
  await importArchive(phone.store, await openArchive(blob), {});
  await phone.backups.accept(a, hold.remote);
  assert.deepEqual([(await phone.backups.get(a))?.last?.id, (await phone.backups.get(a))?.hold], ['b2', null]);
  await phone.backups.backUp(a);
  assert.equal(place.kept.length, 3);
  const [newer] = await phone.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.newer'] }));
  assert.equal(newer.data.remote.id, 'b2');
  const [download] = await phone.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.download'] }));
  assert.equal(download.data.backup, 'b2');
});

test('a failure waits longer each time; one only the user can fix says so; a success clears it', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  const hold = async () => /** @type {any} */ ((await d.backups.get(id))?.hold);
  place.failNext(new TargetError('other', 'The place had a problem.'));
  await assert.rejects(d.backups.backUp(id));
  assert.deepEqual(await hold(), { kind: 'error', message: 'The place had a problem.', at: d.now(), count: 1, retryAt: d.now() + 15 * 60_000, needsYou: false });
  place.failNext(new Error('offline'));
  await assert.rejects(d.backups.backUp(id));
  assert.deepEqual([(await hold()).count, (await hold()).retryAt - d.now()], [2, 30 * 60_000]);
  place.failNext(new TargetError('rate', 'Wait.', { retryAt: d.now() + 5000 }));
  await assert.rejects(d.backups.backUp(id));
  assert.deepEqual([(await hold()).count, (await hold()).retryAt], [3, d.now() + 5000]);
  place.failNext(new TargetError('auth', 'The token was refused.'));
  await assert.rejects(d.backups.backUp(id));
  assert.equal((await hold()).needsYou, true);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [15, 30, 60, 120, 240, 360].map((m) => m * 60_000));
  await d.backups.backUp(id);
  assert.equal(await hold(), null);
  const errors = await d.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.error'] }));
  assert.deepEqual(errors.map((e) => e.data.kind), ['other', 'other', 'rate', 'auth']);
});

test('a bug in a storage plugin counts against the plugin (spec §5.5)', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  place.failNext(new TypeError('x is not a function'));
  await assert.rejects(d.backups.backUp(id), (e) => e instanceof TargetError && e.kind === 'other');
  assert.deepEqual(d.logged.map((e) => [e.type, e.actor]), [['plugin.error', 'plugin:memory-place']]);
});

test('an upload over the limit waits for the user, who can send it anyway', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  await assert.rejects(d.backups.backUp(id, { maxUpload: 1, reason: 'auto' }), (e) => e instanceof TargetError && e.kind === 'large' && (e.bytes ?? 0) > 1);
  const h = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.deepEqual([h.kind, h.bytes > 1, h.at], ['large', true, d.now()]);
  await d.backups.backUp(id);
  assert.equal((await d.backups.get(id))?.hold, null);
});

test('a running backup stops when asked, and that is no failure', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  place.pause();
  const running = d.backups.backUp(id);
  await until(() => place.waiting() > 0);
  assert.equal(d.backups.progress(id)?.phase, 'building');
  d.backups.stop(id);
  await assert.rejects(running, (e) => e?.name === 'AbortError');
  assert.equal((await d.backups.get(id))?.hold, null);
  assert.equal(d.backups.progress(id), null);
});

test('what changes while a backup runs still counts as changed; a trip removed meanwhile is never noted', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const other = await createTrip(d.ws, { title: 'Kyoto' });
  const id = await placeOn(d);
  const release = place.pause();
  const running = d.backups.backUp(id);
  await until(() => place.waiting() > 0);
  await d.ws.write(d.trip, '/notes/later.md', 'Written during the backup', { author: 'user' });
  await removeTrip(d.store, other);
  release();
  await running;
  assert.equal((await backupState(d.store, d.trip)).changed, true);
  assert.equal(await d.store.tx(['scopes'], 'readonly', (t) => t.getScope(other)), undefined);
});

test('removing a place forgets it and its secret; the backups there stay. A place whose plugin is off says so', async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  await d.backups.backUp(id);
  await d.backups.remove(id);
  assert.deepEqual(await d.backups.list(), []);
  assert.deepEqual(await d.backups.savedSecrets(id), []);
  assert.equal(place.kept.length, 1);
  const gone = await addTarget(d.ws, { type: 'gone', name: 'Gone' });
  await assert.rejects(d.backups.backUp(gone), (e) => e instanceof TargetError && e.kind === 'setup' && /plugin for Gone isn't running/.test(e.message));
  await assert.rejects(d.backups.add('nothing'), (e) => e instanceof TargetError && e.kind === 'setup');
  await assert.rejects(d.backups.backUp('bt-none'), (e) => e instanceof TargetError && e.kind === 'missing');
});

test('GitHub through annai: every request is in the trace, and the token is in nothing annai keeps', async () => {
  const gh = await startGitHub({ repos: { 'me/annai-backup': {} } });
  try {
    /** @type {any[]} */
    const logged = [];
    const registry = new Registry({ log: (ev) => { logged.push(ev); } });
    const store = createMemoryStore();
    const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
    await ensureBaseScopes(ws);
    const dir = new URL('../../plugins-official/storage-github/', import.meta.url);
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    for (const name of await readdir(dir)) files.set(name, new Uint8Array(await readFile(new URL(name, dir))));
    // Installed from its files; loaded from this repository, since Node has no service worker to serve them.
    const served = '/plugins/storage-github/';
    const host = new PluginHost({ registry, workspace: ws, importModule: (url) => import(url.startsWith(served) ? new URL(url.slice(served.length), dir).href : url) });
    await host.install(files, { source: 'official' });
    await host.start('storage-github');
    const backups = createBackups({ store, ws, registry, app: 'test', label: 'iPhone', noun: 'phone' });
    const trip = await createTrip(ws, { title: 'Big Sur' });
    await ws.write(trip, '/files/gate.jpg', new Uint8Array([0, 1, 2, 3]), { author: 'user' });
    const id = await backups.add('github');
    await backups.update(id, { config: { repo: 'me/annai-backup', api: gh.origin }, secret: { token: gh.token } });
    assert.match((await backups.check(id)).note, /private repository/);
    await backups.backUp(id);
    assert.equal(gh.commits('me/annai-backup').length, 2);
    const traced = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
    assert.ok(traced.every((e) => e.data.tool === 'plugin:storage-github'));
    assert.deepEqual(traced.map((e) => `${e.data.method} ${new URL(e.data.url).pathname} ${e.data.status}`), gh.log.map((l) => `${l.method} ${l.path} ${l.status}`));
    assert.equal((await everything(store)).includes(gh.token), false);
    assert.deepEqual(logged, []);
  } finally {
    await gh.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/backup.test.js`
Expected: FAIL: `src/core/backup.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`src/core/backup.js`:

```js
import { exportArchive, PRESETS } from './archive.js';
import { recordBackup, SYS } from './scopes.js';
import { logEvent } from './events.js';
import { withoutSecrets } from './agent/net.js';
import { isPluginBug } from './plugins.js';
import { storageTypes, TargetError, NEEDS_YOU } from './storage-types.js';
import { listTargets, getTarget, addTarget, setTarget, removeTarget, deviceId, targetSecret, setTargetSecret } from './backup-targets.js';

/**
 * Backups to the places this device backs up to (spec §12.4). annai builds a Backup of everything
 * (§12.2); a storage type moves it; the trips it holds count as backed up once it lands (§4.9).
 * Single writer: a place whose newest backup is neither the one this device builds on nor one it
 * made waits until the user chooses: import that backup as a copy, or back up over it.
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./workspace.js').Workspace} Workspace
 * @typedef {import('./registry.js').Registry} Registry
 * @typedef {import('./backup-targets.js').Target} Target
 * @typedef {import('./backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {import('./backup-targets.js').Hold} Hold
 * @typedef {import('./backup-targets.js').Auto} Auto
 * @typedef {import('./storage-types.js').StorageType} StorageType
 * @typedef {import('./storage-types.js').TargetContext} TargetContext
 * @typedef {import('./storage-types.js').Progress} Progress
 * @typedef {ReturnType<typeof createBackups>} Backups
 */

/** How long annai waits after the count-th failure in a row before trying a place again: 15 minutes, doubling up to 6 hours. @param {number} count */
export function retryDelay(count) {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, count - 1), 6 * 3_600_000);
}

/**
 * @param {{ store: Store, ws: Workspace, registry: Registry, app: string, label: string, noun?: string,
 *   ensure?: (type: string) => Promise<void>, now?: () => number }} deps
 *   label: what this device is called in its backups ("iPhone"); noun: what the user calls it ("phone");
 *   ensure: makes a kind of place available, installing its plugin (spec §5.3)
 */
export function createBackups({ store, ws, registry, app, label, noun = 'device', ensure = async () => {}, now = () => Date.now() }) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<string, Progress & { stop: AbortController }>} */
  const running = new Map();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a backup listener failed', e);
      }
    }
  };
  /** One backup or download at a time. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  /** @param {string} type @param {Record<string, any>} data */
  const log = (type, data) => logEvent(store, SYS, { type, actor: 'system', data }).catch(() => {});
  /** @param {string} type */
  const typeOf = (type) => storageTypes(registry).get(type);

  /** @param {string} id */
  async function target(id) {
    const rec = await getTarget(ws, id);
    if (!rec) throw new TargetError('missing', 'That backup place was removed.');
    return rec;
  }

  /** The error as annai shows and keeps it: a TargetError without any secret annai keeps (spec §9.9). @param {unknown} e @returns {Promise<TargetError>} */
  async function clean(e) {
    const t = e instanceof TargetError ? e : null;
    const message = await withoutSecrets(store, String(/** @type {any} */ (e)?.message ?? e));
    return new TargetError(t?.kind ?? 'other', message, { remote: t?.remote, bytes: t?.bytes, retryAt: t?.retryAt });
  }

  /** @param {unknown} e */
  const stopped = (e) => /** @type {any} */ (e)?.name === 'AbortError';

  /**
   * Calls a place's type. A bug in its code counts against its plugin (spec §5.5); every other
   * error comes back clean.
   * @template T @param {Target} rec @param {string} what @param {(t: StorageType, c: TargetContext) => Promise<T>} fn @returns {Promise<T>}
   */
  async function call(rec, what, fn) {
    const type = typeOf(rec.type);
    if (!type) throw new TargetError('setup', `The plugin for ${rec.name} isn't running. Open this backup place in Settings → Backups to turn it on.`);
    try {
      return await fn(type, { config: { ...rec.config }, secret: await targetSecret(store, rec.id), device: { id: await deviceId(ws), label }, app });
    } catch (e) {
      if (stopped(e)) throw e;
      if (isPluginBug(e)) registry.fail(type.pluginId, `backup ${what}`, e);
      throw await clean(e);
    }
  }

  /** Notes why automatic backups to a place now wait, and returns the error. @param {Target} rec @param {TargetError} e */
  async function hold(rec, e) {
    const at = now();
    /** @type {Hold} */
    let h;
    if (e.kind === 'newer') h = { kind: 'newer', remote: e.remote ?? { id: '', at } };
    else if (e.kind === 'large') h = { kind: 'large', bytes: e.bytes ?? 0, at };
    else {
      const count = rec.hold?.kind === 'error' ? rec.hold.count + 1 : 1;
      h = { kind: 'error', message: e.message, at, count, retryAt: e.retryAt ?? at + retryDelay(count), needsYou: NEEDS_YOU.has(e.kind) };
    }
    await setTarget(ws, rec.id, { hold: h }).catch(() => {});
    if (h.kind === 'newer') await log('backup.newer', { target: rec.id, type: rec.type, remote: h.remote });
    else await log('backup.error', { target: rec.id, type: rec.type, kind: e.kind, message: e.message, ...(h.kind === 'large' ? { bytes: h.bytes } : {}) });
    return e;
  }

  /** @param {string} id @param {{ over?: boolean, maxUpload?: number, reason?: 'auto' | 'user' }} o */
  async function backUpNow(id, { over = false, maxUpload = Infinity, reason = 'user' }) {
    const rec = await target(id);
    const stop = new AbortController();
    running.set(id, { phase: 'building', done: 0, total: 0, stop });
    emit();
    const started = now();
    try {
      const base = over && rec.hold?.kind === 'newer' ? rec.hold.remote.id : rec.last?.id ?? null;
      const built = await exportArchive(store, { kind: 'everything', include: { ...PRESETS.backup }, app, now: Date.now() });
      const result = await call(rec, 'put', (t, c) => t.put(c, { blob: built.blob, name: built.filename, manifest: built.manifest }, {
        base, maxUpload, signal: stop.signal,
        onProgress: (p) => {
          running.set(id, { ...p, stop });
          emit();
        },
      }));
      const at = Number.isFinite(result.at) ? result.at : now();
      await recordBackup(store, built.seqs, at);
      await setTarget(ws, id, { last: { id: result.id, at, seqs: Object.fromEntries(built.seqs), bytes: built.blob.size }, hold: null });
      await log('backup', { target: id, type: rec.type, reason, backup: result.id, files: result.files ?? null, uploaded: result.uploaded ?? built.blob.size, ms: now() - started });
      return result;
    } catch (e) {
      if (stopped(e)) throw e;
      throw await hold(rec, e instanceof TargetError ? e : await clean(e));
    } finally {
      running.delete(id);
      emit();
    }
  }

  return {
    label,
    noun,
    /** Every place this device backs up to, oldest first. */
    list: () => listTargets(ws),
    /** @param {string} id */
    get: (id) => getTarget(ws, id),
    typeOf,
    types: () => [...storageTypes(registry).values()],

    /** Adds a place of a kind, installing its plugin when needed (spec §5.3). @param {string} type @returns {Promise<string>} */
    async add(type) {
      try {
        await ensure(type);
      } catch (e) {
        throw await clean(e);
      }
      const t = typeOf(type);
      if (!t) throw new TargetError('setup', "annai couldn't start the plugin for this kind of backup place. Try again.");
      const id = await addTarget(ws, { type, name: t.name });
      emit();
      return id;
    },

    /**
     * Changes a place. Changing where it is or how it signs in means it must pass a test again
     * before automatic backups use it.
     * @param {string} id @param {{ config?: Record<string, string>, secret?: Record<string, string>, auto?: Auto, mobileData?: boolean }} c
     */
    async update(id, { config, secret, auto, mobileData }) {
      const rec = await target(id);
      const signIn = Boolean(secret && Object.keys(secret).length);
      if (signIn) await setTargetSecret(store, id, /** @type {Record<string, string>} */ (secret));
      await setTarget(ws, id, {
        ...(config ? { config: { ...rec.config, ...config } } : {}),
        ...(auto ? { auto } : {}),
        ...(mobileData === undefined ? {} : { mobileData }),
        ...(config || signIn ? { checked: null } : {}),
      });
      emit();
    },

    /** Forgets a place and its secret; the backups there stay. @param {string} id */
    async remove(id) {
      running.get(id)?.stop.abort();
      await removeTarget(ws, id);
      emit();
    },

    /** Which of a place's secret values are saved: their names, never the values. @param {string} id */
    savedSecrets: async (id) => Object.keys(await targetSecret(store, id)),

    /** Starts the plugin of a place's kind again, on the user's tap. @param {string} id */
    async turnOn(id) {
      try {
        await ensure((await target(id)).type);
      } catch (e) {
        throw await clean(e);
      }
      emit();
    },

    /**
     * Tests a place and looks at what is there. A backup this device hasn't taken in, made by
     * another device, waits for the user's choice (single writer).
     * @param {string} id @returns {Promise<{ note: string, newer: RemoteBackup | null }>}
     */
    async check(id) {
      const rec = await target(id);
      const { note } = await call(rec, 'check', (t, c) => t.check(c));
      const [remote] = await call(rec, 'list', (t, c) => t.list(c));
      const me = await deviceId(ws);
      const unseen = Boolean(remote) && remote.id !== rec.last?.id;
      const newer = unseen && remote.device !== me ? remote : null;
      await setTarget(ws, id, {
        checked: now(),
        // A backup this device made but didn't get to note is the one to build on.
        ...(unseen && !newer ? { last: { id: remote.id, at: remote.at, seqs: {}, bytes: 0 } } : {}),
        hold: newer ? { kind: 'newer', remote: newer } : rec.hold?.kind === 'large' ? rec.hold : null,
      });
      emit();
      return { note, newer };
    },

    /**
     * Backs up everything to a place now. over: the user chose to back up over the newer backup
     * there. maxUpload: bytes it may send without asking.
     * @param {string} id @param {{ over?: boolean, maxUpload?: number, reason?: 'auto' | 'user' }} [o]
     */
    backUp: (id, o = {}) => serial(() => backUpNow(id, o)),

    /** The backups at a place, newest first. @param {string} id */
    async remote(id) {
      const rec = await target(id);
      return call(rec, 'list', (t, c) => t.list(c));
    },

    /** Downloads one backup from a place, as an archive file for the import screen (spec §12.3). @param {string} id @param {string} backupId */
    download: (id, backupId) => serial(async () => {
      const rec = await target(id);
      const stop = new AbortController();
      running.set(id, { phase: 'downloading', done: 0, total: 0, stop });
      emit();
      try {
        const blob = await call(rec, 'get', (t, c) => t.get(c, backupId, {
          signal: stop.signal,
          onProgress: (p) => {
            running.set(id, { ...p, stop });
            emit();
          },
        }));
        await log('backup.download', { target: id, type: rec.type, backup: backupId, bytes: blob.size });
        return blob;
      } finally {
        running.delete(id);
        emit();
      }
    }),

    /** This device took in a backup from a place: its next backup there builds on that one. @param {string} id @param {RemoteBackup} remote */
    async accept(id, remote) {
      await setTarget(ws, id, { last: { id: remote.id, at: remote.at, seqs: {}, bytes: 0 }, hold: null });
      emit();
    },

    /** Stops the backup or download running for a place. @param {string} id */
    stop(id) {
      running.get(id)?.stop.abort();
    },

    /** @param {string} id @returns {Progress | null} */
    progress(id) {
      const p = running.get(id);
      return p ? { phase: p.phase, done: p.done, total: p.total } : null;
    },

    /** Calls fn whenever a place or its progress changes. @param {() => void} fn */
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

In `sw.js`, add `'/src/core/backup.js',` to `SHELL` after `'/src/core/archive.js',`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/backup.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/backup.js sw.js test/unit/backup.test.js test/unit/backup-kit.js && git commit -m "The backup service: a Backup of everything to a place, single writer, holds and retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 6: Automatic backups

**Files:**
- Create: `src/core/backup-auto.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/backup-auto.test.js`

**Interfaces:**
- Consumes: from Task 5, `Backups` (`list`, `typeOf`, `backUp`) and `test/unit/backup-kit.js`; `SYS`, `SYS_DEVICE`.
- Produces:
  - `TIMINGS: Timings = { tickMs, quietMs, askAbove, gapMs: { tree: { changes, daily }, file: { changes, daily } } }`, and the type `Connection = 'wifi'|'cellular'|'unknown'|'offline'`.
  - `changedSince(store, seqs | null): Promise<{ changed, lastChangeAt }>`.
  - `dueNow(target, stores, env, timings?)`, which gives `{ run: true, maxUpload }` or `{ run: false, why }`.
  - `holdKey(target): string | null`.
  - `startAutoBackup({ backups, store, env, onHold, timings?, now? })`, which gives `{ tick(): Promise<void>, stop() }`.

- [ ] **Step 1: Write the failing test**

`test/unit/backup-auto.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrip, removeTrip, SYS } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
import { TIMINGS, dueNow, changedSince, holdKey, startAutoBackup } from '../../src/core/backup-auto.js';
import { memoryPlace, device, placeOn } from './backup-kit.js';

const H = 3_600_000;
/** A place as dueNow sees it. @param {Record<string, any>} [o] @returns {any} */
const place = (o = {}) => ({ id: 'bt-1', type: 'memory', name: 'Memory', config: {}, auto: 'changes', mobileData: false, created: 0, checked: 1,
  last: { id: 'b1', at: 0, seqs: {}, bytes: 0 }, hold: null, ...o });
/** @param {Record<string, any>} [o] @returns {any} */
const env = (o = {}) => ({ now: 10 * H, visible: true, connection: 'wifi', changed: true, lastChangeAt: 10 * H - 5 * 60_000, ...o });
/** @param {any} r */
const why = (r) => (r.run ? `run ${r.maxUpload}` : r.why);
/** @param {number} at */
const lastAt = (at) => ({ id: 'b1', at, seqs: {}, bytes: 0 });

/** Each scope's last log entry now. @param {any} store @returns {Promise<Record<string, number>>} */
async function seqsNow(store) {
  return store.tx(['scopes', 'events'], 'readonly', async (/** @type {any} */ t) => Object.fromEntries(
    await Promise.all((await t.listScopes()).map(async (/** @type {any} */ s) => [s.id, await t.lastSeq(s.id)]))));
}

test('dueNow: daily or after changes, on Wi-Fi, with annai open, and only when something changed (spec §12.4)', () => {
  assert.equal(why(dueNow(place(), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ last: null }), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ auto: 'off' }), 'tree', env())), 'off');
  assert.equal(why(dueNow(place({ checked: null }), 'tree', env())), 'not set up');
  assert.equal(why(dueNow(place(), 'tree', env({ visible: false }))), 'not open');
  assert.equal(why(dueNow(place(), 'tree', env({ connection: 'offline' }))), 'offline');
  assert.equal(why(dueNow(place(), 'tree', env({ changed: false }))), 'nothing changed');
  assert.equal(why(dueNow(place(), 'tree', env({ lastChangeAt: 10 * H - 60_000 }))), 'changes still coming');
  // Mobile data waits for Wi-Fi unless the place may use it; a connection annai can't name sends small backups only.
  assert.equal(why(dueNow(place(), 'tree', env({ connection: 'cellular' }))), 'waiting for Wi-Fi');
  assert.equal(why(dueNow(place({ mobileData: true }), 'tree', env({ connection: 'cellular' }))), 'run Infinity');
  assert.equal(why(dueNow(place(), 'tree', env({ connection: 'unknown' }))), `run ${TIMINGS.askAbove}`);
  assert.equal(why(dueNow(place({ mobileData: true }), 'tree', env({ connection: 'unknown' }))), 'run Infinity');
  // How often: after changes, at most hourly to a tree and every 6 hours to a whole file; daily, once a day.
  assert.equal(why(dueNow(place({ last: lastAt(9.5 * H) }), 'tree', env())), 'backed up recently');
  assert.equal(why(dueNow(place({ last: lastAt(8.9 * H) }), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ last: lastAt(5 * H) }), 'file', env())), 'backed up recently');
  assert.equal(why(dueNow(place({ last: lastAt(3.9 * H) }), 'file', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ auto: 'daily', last: lastAt(-13 * H) }), 'tree', env())), 'backed up recently');
  assert.equal(why(dueNow(place({ auto: 'daily', last: lastAt(-15 * H) }), 'tree', env())), 'run Infinity');
  // What a place waits on.
  assert.equal(why(dueNow(place({ hold: { kind: 'newer', remote: { id: 'b9', at: 0 } } }), 'tree', env())), 'a newer backup is there');
  const error = { kind: 'error', message: 'x', at: 0, count: 1, retryAt: 11 * H, needsYou: false };
  assert.equal(why(dueNow(place({ hold: error }), 'tree', env())), 'waiting to try again');
  assert.equal(why(dueNow(place({ hold: { ...error, retryAt: 9 * H } }), 'tree', env())), 'run Infinity');
  const large = { kind: 'large', bytes: 9e7, at: 10 * H - 2 * 60_000 };
  assert.equal(why(dueNow(place({ hold: large }), 'tree', env({ connection: 'unknown' }))), 'waiting for your OK');
  assert.equal(why(dueNow(place({ hold: large }), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ hold: { ...large, at: 10 * H - 10 * 60_000 } }), 'tree', env({ connection: 'unknown' }))), `run ${TIMINGS.askAbove}`, 'it changed since annai asked');
  assert.equal(holdKey(place()), null);
  assert.equal(holdKey(place({ hold: { kind: 'newer', remote: { id: 'b9', at: 0 } } })), 'bt-1 newer b9');
  assert.equal(holdKey(place({ hold: large })), `bt-1 large ${large.at}`);
  assert.equal(holdKey(place({ hold: error })), null, 'a passing problem shows only on the Backups screen');
  assert.equal(holdKey(place({ hold: { ...error, needsYou: true } })), 'bt-1 error x');
});

test("changedSince: what a backup holds changed after it; the system log and this device's own scope never count", async () => {
  const d = await device(memoryPlace());
  assert.equal((await changedSince(d.store, null)).changed, true);
  const seqs = await seqsNow(d.store);
  assert.deepEqual(await changedSince(d.store, seqs), { changed: false, lastChangeAt: null });
  await logEvent(d.store, SYS, { type: 'net.request', data: {} });
  await d.backups.add('memory'); // writes this device's own scope
  assert.equal((await changedSince(d.store, seqs)).changed, false);
  const before = Date.now();
  await d.ws.write(d.trip, '/notes/new.md', 'x', { author: 'user' });
  const after = await changedSince(d.store, seqs);
  assert.equal(after.changed, true);
  assert.ok((after.lastChangeAt ?? 0) >= before);
  const other = await createTrip(d.ws, { title: 'Kyoto' });
  const withOther = await seqsNow(d.store);
  await removeTrip(d.store, other);
  assert.equal((await changedSince(d.store, withOther)).changed, true, 'a trip removed since');
});

test('startAutoBackup backs up what is due, and tells of each new hold once', async () => {
  const shared = memoryPlace();
  const d = await device(shared);
  const id = await placeOn(d);
  await d.backups.check(id);
  /** @type {string[]} */
  const told = [];
  let ahead = 0;
  let visible = true;
  const auto = startAutoBackup({
    backups: d.backups, store: d.store, timings: { ...TIMINGS, tickMs: 24 * H }, now: () => Date.now() + ahead,
    env: () => ({ visible, connection: 'wifi' }), onHold: (t) => told.push(String(t.hold?.kind)),
  });
  try {
    await auto.tick();
    assert.equal(shared.kept.length, 0, 'changes are still coming: the trip was just made');
    ahead += TIMINGS.quietMs + 1000;
    await auto.tick();
    assert.equal(shared.kept.length, 1);
    await auto.tick();
    assert.equal(shared.kept.length, 1, 'nothing changed');
    await d.ws.write(d.trip, '/notes/x.md', 'x', { author: 'user' });
    await auto.tick();
    assert.equal(shared.kept.length, 2);
    visible = false;
    await d.ws.write(d.trip, '/notes/y.md', 'y', { author: 'user' });
    await auto.tick();
    assert.equal(shared.kept.length, 2, 'annai is not on screen');
    visible = true;
    // Another device backs up over this one's: this device waits, and says so once.
    const other = await device(shared, 'Android phone');
    const b = await placeOn(other);
    await other.backups.check(b);
    await other.backups.backUp(b, { over: true });
    await auto.tick();
    await auto.tick();
    assert.deepEqual(told, ['newer']);
    assert.equal(shared.kept.length, 3);
  } finally {
    auto.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/backup-auto.test.js`
Expected: FAIL: `src/core/backup-auto.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`src/core/backup-auto.js`:

```js
import { SYS, SYS_DEVICE } from './scopes.js';

/**
 * Automatic backups (spec §12.4): daily or after changes, while on Wi-Fi with the app open. Only
 * when something changed; never while changes are still coming in; and on a connection the browser
 * doesn't name (Safari), only small ones without asking.
 * @typedef {import('./backup-targets.js').Target} Target
 * @typedef {import('./backup.js').Backups} Backups
 * @typedef {import('./types.js').Store} Store
 * @typedef {'wifi' | 'cellular' | 'unknown' | 'offline'} Connection
 *   wifi: Wi-Fi or a cable; cellular: mobile data, or the user asked to save data; unknown: the browser doesn't say
 * @typedef {{ tickMs: number, quietMs: number, askAbove: number,
 *   gapMs: { tree: { changes: number, daily: number }, file: { changes: number, daily: number } } }} Timings
 *   tickMs: how often annai looks; quietMs: how long after the last change it waits; askAbove: the bytes it
 *   sends on an unnamed connection without asking; gapMs: the least time between backups to a place
 */

const HOUR = 3_600_000;

/** @type {Timings} */
export const TIMINGS = Object.freeze({
  tickMs: 60_000,
  quietMs: 2 * 60_000,
  askAbove: 25 * 1024 * 1024,
  gapMs: Object.freeze({ tree: Object.freeze({ changes: HOUR, daily: 24 * HOUR }), file: Object.freeze({ changes: 6 * HOUR, daily: 24 * HOUR }) }),
});

/**
 * Whether anything a backup holds changed after the one whose log positions are seqs, and when the
 * latest change was. The system log and this device's own scope don't count: a backup's own trace
 * and its own notes would otherwise call for the next backup.
 * @param {Store} store @param {Record<string, number> | null} seqs null: never backed up
 * @returns {Promise<{ changed: boolean, lastChangeAt: number | null }>}
 */
export function changedSince(store, seqs) {
  return store.tx(['scopes', 'events'], 'readonly', async (t) => {
    const counted = (/** @type {string} */ id) => id !== SYS && id !== SYS_DEVICE;
    const scopes = (await t.listScopes()).filter((s) => counted(s.id));
    let changed = !seqs;
    /** @type {number | null} */
    let lastChangeAt = null;
    for (const s of scopes) {
      const [e] = await t.listEvents(s.id, { reverse: true, limit: 1 });
      if (e && e.seq > (seqs?.[s.id] ?? 0)) {
        changed = true;
        lastChangeAt = Math.max(lastChangeAt ?? 0, e.ts);
      }
    }
    const here = new Set(scopes.map((s) => s.id));
    if (seqs && Object.keys(seqs).some((id) => counted(id) && !here.has(id))) changed = true; // a trip removed since
    return { changed, lastChangeAt };
  });
}

/**
 * Whether a place is due for an automatic backup now, and how much it may upload without asking.
 * @param {Target} t @param {'tree' | 'file'} stores
 * @param {{ now: number, visible: boolean, connection: Connection, changed: boolean, lastChangeAt: number | null }} env
 * @param {Timings} [timings]
 * @returns {{ run: true, maxUpload: number } | { run: false, why: string }}
 */
export function dueNow(t, stores, env, timings = TIMINGS) {
  /** @param {string} why @returns {{ run: false, why: string }} */
  const no = (why) => ({ run: false, why });
  if (t.auto === 'off') return no('off');
  if (!t.checked) return no('not set up');
  if (!env.visible) return no('not open');
  if (env.connection === 'offline') return no('offline');
  const h = t.hold;
  if (h?.kind === 'newer') return no('a newer backup is there');
  if (h?.kind === 'error' && env.now < h.retryAt) return no('waiting to try again');
  const free = env.connection === 'wifi' || t.mobileData;
  const changedSinceAsked = h?.kind === 'large' && env.lastChangeAt !== null && env.lastChangeAt > h.at;
  if (h?.kind === 'large' && !free && !changedSinceAsked) return no('waiting for your OK');
  if (env.connection === 'cellular' && !t.mobileData) return no('waiting for Wi-Fi');
  if (!env.changed) return no('nothing changed');
  if (env.lastChangeAt !== null && env.now - env.lastChangeAt < timings.quietMs) return no('changes still coming');
  if (t.last && env.now - t.last.at < timings.gapMs[stores][t.auto === 'daily' ? 'daily' : 'changes']) return no('backed up recently');
  return { run: true, maxUpload: free ? Infinity : timings.askAbove };
}

/** What a place waits on that the user should hear of, as a key to tell it once by; null for nothing. @param {Target} t */
export function holdKey(t) {
  const h = t.hold;
  if (h?.kind === 'newer') return `${t.id} newer ${h.remote.id}`;
  if (h?.kind === 'large') return `${t.id} large ${h.at}`;
  if (h?.kind === 'error' && h.needsYou) return `${t.id} error ${h.message}`;
  return null;
}

/**
 * Runs automatic backups while annai is open: each tick, every place that is due is backed up,
 * one at a time. onHold hears of each new reason a place waits for the user, once.
 * @param {{ backups: Backups, store: Store, env: () => { visible: boolean, connection: Connection }, onHold: (t: Target) => void,
 *   timings?: Timings, now?: () => number }} o
 * @returns {{ tick: () => Promise<void>, stop: () => void }}
 */
export function startAutoBackup({ backups, store, env, onHold, timings = TIMINGS, now = () => Date.now() }) {
  let stopped = false;
  /** @type {Promise<void> | null} */
  let busy = null;
  /** @type {Set<string>} */
  const told = new Set();
  async function run() {
    for (const t of await backups.list()) {
      if (stopped) return;
      const type = backups.typeOf(t.type);
      if (!type) continue;
      const { changed, lastChangeAt } = await changedSince(store, t.last?.seqs ?? null);
      const due = dueNow(t, type.stores, { ...env(), now: now(), changed, lastChangeAt }, timings);
      if (due.run) await backups.backUp(t.id, { reason: 'auto', maxUpload: due.maxUpload }).catch(() => {});
    }
    for (const t of await backups.list()) {
      const key = holdKey(t);
      if (key && !told.has(key)) {
        told.add(key);
        onHold(t);
      }
    }
  }
  /** One look at a time; a second call while one runs waits for it. */
  const tick = () => (busy ??= run().finally(() => { busy = null; }));
  const timer = setInterval(() => { tick().catch(() => {}); }, timings.tickMs);
  tick().catch(() => {});
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
```

In `sw.js`, add `'/src/core/backup-auto.js',` to `SHELL` after `'/src/core/backup.js',`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/backup-auto.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/backup-auto.js sw.js test/unit/backup-auto.test.js && git commit -m "Automatic backups: after changes or daily, on Wi-Fi, while annai is open

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 7: Settings → Backups, the cards, and restoring

**Files:**
- Create: `src/ui/screens/backups.js`, `src/ui/auto-backup.js`
- Modify:
  - `src/ui/platform.js` (`connectionOf`, `deviceName`) and `src/ui/format.js` (`placeStatus`, `newerText`, `withArticle`, `placeHref`)
  - `src/ui/import-state.js` and `src/ui/screens/import.js` (`from`)
  - `src/ui/screens/settings.js`, `src/ui/screens/trips.js`, `src/ui/shell.js`, `src/app/main.js`, `sw.js`
  - `src/ui/screens/trace.js` (backup events: a Kind of their own and a line each)
- Test: `test/unit/ui-pure.test.js`, `test/unit/platform.test.js`. The screens themselves get their end-to-end test in Task 8.

**Interfaces:**
- Consumes: from Task 5, `createBackups` / `Backups`; from Task 6, `startAutoBackup`, `TIMINGS`, `Connection`; from Task 2, `offeredTypes` and `ensureProvided`.
- Produces:
  - `connectionOf(nav): Connection` and `deviceName(ua?, touch?): { label, noun }` in `platform.js`.
  - In `format.js`: `placeStatus(target, progress, now?)`, `newerText(target, { where, noun, tree }, now?)`, `withArticle(label)`, `placeHref(id)`.
  - In `auto-backup.js`: `startBackups({ backups, store, notices, go })`, `restoreFrom(ctx, target, remote, say)`, `whereOf(ctx, target)`.
  - `setPendingImport(files, { archive?, from? })`, where `from = { target, remote }`.
  - The routes `#/backups` and `#/backups/place?id=…` (screen `backups`), and `ctx.backups` on the shell context.

- [ ] **Step 1: Write the failing tests**

In `test/unit/platform.test.js`, import `connectionOf, deviceName` with `watchForUpdates`, and add:

```js
test('connectionOf: Wi-Fi only when the browser says so (spec §12.4)', () => {
  /** @type {[any, string][]} */
  const cases = [
    [{ onLine: false, connection: { type: 'wifi' } }, 'offline'],
    [{ onLine: true, connection: { type: 'none' } }, 'offline'],
    [{ onLine: true, connection: { type: 'wifi' } }, 'wifi'],
    [{ onLine: true, connection: { type: 'ethernet' } }, 'wifi'],
    [{ onLine: true, connection: { type: 'cellular' } }, 'cellular'],
    [{ onLine: true, connection: { type: 'wifi', saveData: true } }, 'cellular'],
    [{ onLine: true, connection: { effectiveType: '4g' } }, 'unknown'], // desktop Chrome names no type
    [{ onLine: true }, 'unknown'], // Safari has no navigator.connection
  ];
  for (const [nav, want] of cases) assert.equal(connectionOf(nav), want, JSON.stringify(nav));
});

test('deviceName: what this device is called in its backups', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const pixel = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  assert.deepEqual(deviceName(iphone, 5), { label: 'iPhone', noun: 'phone' });
  assert.deepEqual(deviceName(ipad, 5), { label: 'iPad', noun: 'iPad' });
  assert.deepEqual(deviceName(ipad, 0), { label: 'computer', noun: 'computer' });
  assert.deepEqual(deviceName(pixel, 5), { label: 'Android phone', noun: 'phone' });
});
```

In `test/unit/ui-pure.test.js`, import `placeStatus, newerText, withArticle, placeHref` from `format.js`, and add:

```js
test('a backup place in a few words, and the newer backup at it (spec §12.4)', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  /** @param {Record<string, any>} [o] @returns {any} */
  const t = (o = {}) => ({ id: 'bt-1', type: 'github', name: 'GitHub', config: {}, auto: 'changes', mobileData: false, created: 0, checked: 1, last: null, hold: null, ...o });
  const last = { id: 'c', at: now - 2 * 3_600_000, seqs: {}, bytes: 0 };
  assert.equal(placeStatus(t({ checked: null }), null, now), 'Not set up yet: fill it in, then Save and test');
  assert.equal(placeStatus(t(), null, now), 'Not backed up yet');
  assert.equal(placeStatus(t({ last }), null, now), 'Last backup 2 hours ago');
  assert.equal(placeStatus(t({ last, auto: 'off' }), null, now), 'Last backup 2 hours ago. Automatic backups are off');
  assert.equal(placeStatus(t({ hold: { kind: 'newer', remote: { id: 'x', at: now, label: 'Android phone' } } }), null, now), 'Paused: there is a newer backup from an Android phone');
  assert.equal(placeStatus(t({ hold: { kind: 'newer', remote: { id: 'x', at: now } } }), null, now), 'Paused: there is a newer backup from another device');
  assert.equal(placeStatus(t({ hold: { kind: 'large', bytes: 150 * 1024 * 1024, at: now } }), null, now), 'Not backed up yet. Waiting for your OK to upload 150 MB');
  assert.equal(placeStatus(t({ last, hold: { kind: 'error', message: 'GitHub had a problem.', at: now, count: 1, retryAt: now, needsYou: false } }), null, now),
    'Last backup 2 hours ago. The last try failed: GitHub had a problem.');
  assert.equal(placeStatus(t(), { phase: 'uploading', done: 3, total: 12 }, now), 'Uploading 3 of 12…');
  assert.equal(placeStatus(t(), { phase: 'checking', done: 1, total: 40 }, now), 'Comparing files 1 of 40…');
  assert.equal(placeStatus(t(), { phase: 'building', done: 0, total: 0 }, now), 'Getting the backup ready…');
  assert.deepEqual(['iPhone', 'iPad', 'Android phone', 'computer'].map(withArticle), ['an iPhone', 'an iPad', 'an Android phone', 'a computer']);
  assert.equal(placeHref('bt-1 2'), '#/backups/place?id=bt-1%202');
  const held = t({ last: { ...last, at: now - 86_400_000 }, hold: { kind: 'newer', remote: { id: 'x', at: now - 3_600_000, label: 'Android phone' } } });
  assert.equal(newerText(held, { where: 'me/annai-backup', noun: 'phone', tree: true }, now),
    "An Android phone backed up to me/annai-backup 1 hour ago, after this phone's last backup. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this phone over it (the other backup stays in its history).");
  assert.equal(newerText(t({ hold: { kind: 'newer', remote: { id: 'x', at: now } } }), { where: 'x', noun: 'computer', tree: false }, now),
    'Another device backed up to x just now. Automatic backups there are paused, so neither device overwrites the other. Import it as a copy to bring its trips here, or back up this computer over it.');
  assert.equal(newerText(t(), { where: 'x', noun: 'phone', tree: true }, now), '');
  assert.deepEqual(parseHash('#/backups/place?id=bt-1'), { name: 'backups', parts: ['backups', 'place'], params: { id: 'bt-1' } });
});

test('the trace says what each backup did (spec §15)', () => {
  assert.equal(traceSummary({ type: 'backup', data: { type: 'github', reason: 'auto', backup: 'c1', files: 3, uploaded: 2048, ms: 900 } }), 'github · auto · 3 files sent, 2.0 KB · 900 ms');
  assert.equal(traceSummary({ type: 'backup.newer', data: { type: 'github', remote: { id: 'c2', at: 0, label: 'Android phone' } } }), 'github · a newer backup from an Android phone is there');
  assert.equal(traceSummary({ type: 'backup.error', data: { type: 'github', kind: 'auth', message: 'GitHub refused the token.' } }), 'github · auth: GitHub refused the token.');
  assert.equal(traceSummary({ type: 'backup.download', data: { type: 'github', backup: 'c2', bytes: 4096 } }), 'github · downloaded c2, 4.0 KB');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/ui-pure.test.js test/unit/platform.test.js`
Expected: FAIL: `placeStatus` and `connectionOf` are not exported.

- [ ] **Step 3: Write the implementation**

In `src/ui/platform.js`, add:

```js
/**
 * The connection, as far as the browser says (spec §12.4: automatic backups on Wi-Fi). Chrome on
 * Android names it; Safari doesn't, which is "unknown". Data Saver counts as mobile data.
 * @param {{ onLine?: boolean, connection?: { type?: string, saveData?: boolean } }} nav
 * @returns {import('../core/backup-auto.js').Connection}
 */
export function connectionOf(nav) {
  if (nav.onLine === false) return 'offline';
  const c = nav.connection;
  if (c?.type === 'none') return 'offline';
  if (c?.saveData || c?.type === 'cellular' || c?.type === 'bluetooth' || c?.type === 'wimax') return 'cellular';
  if (c?.type === 'wifi' || c?.type === 'ethernet') return 'wifi';
  return 'unknown';
}

/**
 * What this device is called in the backups it makes ("iPhone"), and what the user calls it ("phone").
 * @param {string} [ua] @param {number} [touch] @returns {{ label: string, noun: string }}
 */
export function deviceName(ua = navigator.userAgent, touch = navigator.maxTouchPoints) {
  if (/iPad/.test(ua) || (ua.includes('Macintosh') && touch > 1)) return { label: 'iPad', noun: 'iPad' };
  if (/iPhone|iPod/.test(ua)) return { label: 'iPhone', noun: 'phone' };
  if (/Android/.test(ua)) return { label: 'Android phone', noun: 'phone' };
  return { label: 'computer', noun: 'computer' };
}
```

In `src/ui/format.js`, add:

```js
/** "an iPhone", "an Android phone", "a computer". @param {string} label */
export function withArticle(label) {
  return `${/^(?:[aeiou]|iP)/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** A backup place's own screen. @param {string} id */
export const placeHref = (id) => `#/backups/place?id=${encodeURIComponent(id)}`;

/** @type {Record<string, (of: string) => string>} */
const PHASES = {
  building: () => 'Getting the backup ready…',
  checking: (of) => `Comparing files${of}…`,
  uploading: (of) => `Uploading${of}…`,
  downloading: (of) => `Downloading${of}…`,
};

/**
 * A backup place's state in a few words, for its row and its screen (spec §12.4).
 * @param {import('../core/backup-targets.js').Target} t
 * @param {{ phase: string, done: number, total: number } | null} progress @param {number} [now]
 */
export function placeStatus(t, progress, now = Date.now()) {
  if (progress) return (PHASES[progress.phase] ?? (() => 'Working…'))(progress.total ? ` ${progress.done} of ${progress.total}` : '');
  const h = t.hold;
  const when = t.last ? `Last backup ${relTime(t.last.at, now)}` : 'Not backed up yet';
  if (h?.kind === 'newer') return `Paused: there is a newer backup from ${h.remote.label ? withArticle(h.remote.label) : 'another device'}`;
  if (h?.kind === 'large') return `${when}. Waiting for your OK to upload ${bytes(h.bytes)}`;
  if (h?.kind === 'error') return `${when}. The last try failed: ${h.message}`;
  if (!t.checked) return 'Not set up yet: fill it in, then Save and test';
  return t.auto === 'off' ? `${when}. Automatic backups are off` : when;
}

/**
 * What the newer backup at a place is, and the user's two choices (spec §12.4: single writer).
 * @param {import('../core/backup-targets.js').Target} t @param {{ where: string, noun: string, tree: boolean }} o @param {number} [now]
 */
export function newerText(t, { where, noun, tree }, now = Date.now()) {
  if (t.hold?.kind !== 'newer') return '';
  const r = t.hold.remote;
  const who = r.label ? withArticle(r.label) : 'another device';
  return `${who[0].toUpperCase()}${who.slice(1)} backed up to ${where} ${relTime(r.at, now)}${t.last ? `, after this ${noun}'s last backup` : ''}. `
    + 'Automatic backups there are paused, so neither device overwrites the other. '
    + `Import it as a copy to bring its trips here, or back up this ${noun} over it${tree ? ' (the other backup stays in its history)' : ''}.`;
}
```

`src/ui/auto-backup.js`:

```js
import { startAutoBackup, TIMINGS } from '../core/backup-auto.js';
import { connectionOf } from './platform.js';
import { setPendingImport } from './import-state.js';
import { newerText, placeHref, bytes } from './format.js';

/**
 * @typedef {import('../core/backup-targets.js').Target} Target
 * @typedef {import('../core/backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {{ backups: import('../core/backup.js').Backups, store: any, notices: any, go: (hash: string) => void }} Ctx
 */

/**
 * Automatic backups while annai is open (spec §12.4), and the system cards (never in Shiori's
 * voice, §16.1) that ask the user when a place waits for them. Tests shorten the timings through
 * localStorage "annai.backupTimings" ({ tickMs, quietMs, gapMs, askAbove }), as "annai.forceDownload"
 * works for saving files.
 * @param {Ctx} ctx
 */
export function startBackups(ctx) {
  const auto = startAutoBackup({
    backups: ctx.backups, store: ctx.store, timings: timings(),
    env: () => ({ visible: document.visibilityState === 'visible', connection: connectionOf(navigator) }),
    onHold: (t) => holdCard(ctx, t),
  });
  const look = () => { auto.tick().catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') look(); });
  addEventListener('online', look);
  return auto;
}

/** @returns {import('../core/backup-auto.js').Timings} */
function timings() {
  /** @type {any} */
  let o = null;
  try {
    o = JSON.parse(localStorage.getItem('annai.backupTimings') ?? 'null');
  } catch {
    // storage blocked, or not JSON: the usual timings
  }
  if (!o || typeof o !== 'object') return TIMINGS;
  const n = (/** @type {unknown} */ v, /** @type {number} */ usual) => (typeof v === 'number' && v >= 0 ? v : usual);
  const gap = typeof o.gapMs === 'number' ? { changes: o.gapMs, daily: o.gapMs } : null;
  return {
    tickMs: n(o.tickMs, TIMINGS.tickMs), quietMs: n(o.quietMs, TIMINGS.quietMs), askAbove: n(o.askAbove, TIMINGS.askAbove),
    gapMs: gap ? { tree: gap, file: gap } : TIMINGS.gapMs,
  };
}

/** Where a place is, in its kind's words. @param {Ctx} ctx @param {Target} t */
export function whereOf(ctx, t) {
  try {
    return String(ctx.backups.typeOf(t.type)?.where(t.config) || t.name);
  } catch {
    return t.name;
  }
}

/** The card for what a place waits on. @param {Ctx} ctx @param {Target} t */
function holdCard(ctx, t) {
  const h = t.hold;
  const noun = ctx.backups.noun;
  const open = { label: 'Open Backups', run: () => ctx.go(placeHref(t.id)) };
  if (h?.kind === 'newer') {
    const tree = ctx.backups.typeOf(t.type)?.stores === 'tree';
    // Progress lines stay on the Backups screen; a card's restore says only how it starts, or why it failed.
    const say = (/** @type {string} */ s) => { if (!/^Downloading \d/.test(s)) ctx.notices.toast(s); };
    ctx.notices.card({
      tone: 'warn', title: `A newer backup is on ${t.name}`, body: newerText(t, { where: whereOf(ctx, t), noun, tree }),
      actions: [
        { label: 'Import it as a copy', primary: true, run: () => { restoreFrom(ctx, t, h.remote, say); } },
        { label: `Back up this ${noun} over it`, run: () => { backUpFromCard(ctx, t.id, { over: true }); } },
      ],
    });
  } else if (h?.kind === 'large') {
    ctx.notices.card({
      title: 'A large backup is waiting',
      body: `This backup uploads ${bytes(h.bytes)} to ${t.name}. annai can't tell whether this ${noun} is on Wi-Fi, so larger backups wait for your OK.`,
      actions: [{ label: 'Back up now', primary: true, run: () => { backUpFromCard(ctx, t.id, {}); } }, open],
    });
  } else if (h?.kind === 'error') {
    ctx.notices.card({ tone: 'warn', title: `Backups to ${t.name} stopped`, body: `${h.message} Open Backups to fix it.`, actions: [open] });
  }
}

/** @param {Ctx} ctx @param {string} id @param {{ over?: boolean }} o */
function backUpFromCard(ctx, id, o) {
  ctx.notices.toast('Backing up…');
  ctx.backups.backUp(id, o).then(
    () => ctx.notices.toast('Backed up.'),
    (/** @type {any} */ e) => {
      if (e?.name !== 'AbortError') ctx.notices.card({ tone: 'warn', title: "The backup didn't finish", body: String(e?.message ?? e) });
    },
  );
}

/**
 * Opens a backup from a place on the import screen, where the user chooses what comes in (spec §12.3).
 * @param {Ctx} ctx @param {Target} t @param {RemoteBackup} remote @param {(status: string) => void} say
 */
export async function restoreFrom(ctx, t, remote, say) {
  say('Downloading the backup…');
  const off = ctx.backups.on(() => {
    const p = ctx.backups.progress(t.id);
    if (p?.phase === 'downloading' && p.total) say(`Downloading ${p.done} of ${p.total} files…`);
  });
  try {
    const blob = await ctx.backups.download(t.id, remote.id);
    const day = new Date(remote.at || Date.now()).toISOString().slice(0, 10);
    setPendingImport([new File([blob], `annai-backup-${day}.annai.zip`, { type: 'application/zip' })], { archive: true, from: { target: t.id, remote } });
    ctx.go('#/import');
  } catch (e) {
    say(String(/** @type {any} */ (e)?.message ?? e));
  } finally {
    off();
  }
}
```

`src/ui/screens/backups.js`:

```js
import { h, field, checkbox, radios, twoStep } from '../dom.js';
import { placeStatus, placeHref, newerText, withArticle, relTime, bytes } from '../format.js';
import { offeredTypes } from '../../core/llm/official.js';
import { TIMINGS } from '../../core/backup-auto.js';
import { connectionOf } from '../platform.js';
import { restoreFrom, whereOf } from '../auto-backup.js';

/** What a place's test said, shown once on its screen as it opens again. @type {Map<string, string>} */
const notes = new Map();

/**
 * Settings → Backups (spec §12.4, §16.2 "Storage & backup"): the places this device backs up to, or one place.
 * @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route
 */
export async function renderBackups(ctx, route) {
  if (route.parts[1] === 'place') return renderPlace(ctx, route.params.id ?? '');
  const places = await ctx.backups.list();
  const offered = await offeredTypes('storage-type').catch(() => []);
  /** @type {Map<string, string>} type → name */
  const kinds = new Map(offered.map((o) => [o.type, o.name]));
  for (const t of ctx.backups.types()) kinds.set(t.type, t.name);
  const pick = h('select', { id: 'add-place' }, ...[...kinds].map(([type, name]) => h('option', { value: type, text: name })));
  const status = h('p', { class: 'sub', role: 'status' });
  const add = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      add.disabled = true;
      status.textContent = 'Getting it ready…';
      try {
        ctx.go(placeHref(await ctx.backups.add(pick.value)));
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
        add.disabled = false;
      }
    },
  }, 'Add');
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Backups' }),
    h('p', { class: 'sub', text: 'annai backs up everything on this device to the places you add here: after changes or once a day, on Wi-Fi, while annai is open. Your API keys stay on this device.' }),
    places.length
      ? h('ul', { class: 'cards' }, ...places.map((/** @type {any} */ t) => h('li', {}, h('a', { class: 'card', href: placeHref(t.id) },
        h('span', { class: 'name', text: `${t.name} · ${whereOf(ctx, t)}` }),
        h('span', { class: 'sub', text: placeStatus(t, ctx.backups.progress(t.id)) })))))
      : h('p', { class: 'empty', text: 'No backup places yet.' }),
    kinds.size
      ? h('section', { class: 'panel', 'aria-label': 'Add a place' }, field('Add a place to back up to', pick), h('div', { class: 'acts' }, add), status)
      : h('p', { class: 'sub', text: "annai couldn't load the kinds of backup places. Check the connection, then open this screen again." }));
}

/** One place: where it is, when annai backs up to it, and what is there. @param {any} ctx @param {string} id */
async function renderPlace(ctx, id) {
  const t = await ctx.backups.get(id);
  if (!t) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'This backup place was removed' }), h('p', {}, h('a', { href: '#/backups' }, 'Back to Backups')));
  const type = ctx.backups.typeOf(t.type);
  const noun = ctx.backups.noun;
  const status = h('p', { class: 'sub', role: 'status', text: notes.get(id) ?? '' });
  notes.delete(id);
  const say = (/** @type {string} */ s) => { status.textContent = s; };
  const live = h('p', { class: 'sub', text: placeStatus(t, ctx.backups.progress(id)) });
  const stop = h('button', { class: 'btn', type: 'button', hidden: !ctx.backups.progress(id), onclick: () => ctx.backups.stop(id) }, 'Stop');
  const off = ctx.backups.on(async () => {
    if (!live.isConnected) {
      off();
      return;
    }
    const now = await ctx.backups.get(id);
    if (now) live.textContent = placeStatus(now, ctx.backups.progress(id));
    stop.hidden = !ctx.backups.progress(id);
  });
  const top = [
    h('p', { class: 'crumbs' }, h('a', { href: '#/backups' }, '← Backups')),
    h('h1', { class: 'title', text: t.name }),
    h('p', { class: 'sub', text: whereOf(ctx, t) }),
    live,
  ];
  if (!type) {
    const on = h('button', {
      class: 'btn pri', type: 'button',
      onclick: async () => {
        say('Turning it on…');
        try {
          await ctx.backups.turnOn(id);
          ctx.render();
        } catch (e) {
          say(String(/** @type {any} */ (e)?.message ?? e));
        }
      },
    }, 'Turn it on');
    return h('div', { class: 'screen' }, ...top,
      h('section', { class: 'panel', 'aria-label': 'Plugin' }, h('p', { text: `The plugin for ${t.name} isn't running, so annai can't back up here.` }), h('div', { class: 'acts' }, on), status),
      removeSection(ctx, id));
  }
  /** A backup the user asked for; its result shows when the screen opens again. @param {{ over?: boolean }} o */
  const backUpNow = async (o) => {
    say('');
    try {
      await ctx.backups.backUp(id, o);
      notes.set(id, 'Backed up.');
    } catch (e) {
      if (/** @type {any} */ (e)?.name !== 'AbortError') notes.set(id, String(/** @type {any} */ (e)?.message ?? e));
    }
    if (live.isConnected) ctx.render();
  };
  const saved = new Set(await ctx.backups.savedSecrets(id));
  const inputs = type.fields.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-${f.key}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: t.config[f.key] ?? '', placeholder: f.placeholder ?? '' }) }));
  const secrets = type.secret.map((/** @type {any} */ f) => ({ f, el: h('input', { id: `place-secret-${f.key}`, type: 'password', autocomplete: 'off', placeholder: saved.has(f.key) ? 'saved (type a new one to replace it)' : 'not set' }) }));
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      save.disabled = true;
      say('Testing…');
      try {
        await ctx.backups.update(id, {
          config: Object.fromEntries(inputs.map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
          secret: Object.fromEntries(secrets.filter((/** @type {any} */ i) => i.el.value.trim()).map((/** @type {any} */ i) => [i.f.key, i.el.value.trim()])),
        });
        notes.set(id, (await ctx.backups.check(id)).note);
        ctx.render();
      } catch (e) {
        say(String(/** @type {any} */ (e)?.message ?? e));
        save.disabled = false;
      }
    },
  }, 'Save and test');
  const hold = t.hold;
  const holdPanel = hold?.kind === 'newer'
    ? h('section', { class: 'panel', 'aria-label': 'A newer backup' },
      h('h2', { class: 'section', text: t.last ? 'A newer backup is here' : 'A backup is already here' }),
      h('p', { text: newerText(t, { where: whereOf(ctx, t), noun, tree: type.stores === 'tree' }) }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn pri', type: 'button', onclick: () => restoreFrom(ctx, t, hold.remote, say) }, 'Import it as a copy'),
        h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({ over: true }) }, `Back up this ${noun} over it`)))
    : hold?.kind === 'large'
      ? h('section', { class: 'panel', 'aria-label': 'A large backup' },
        h('p', { text: `This backup uploads ${bytes(hold.bytes)}. annai can't tell whether this ${noun} is on Wi-Fi, so larger backups wait for your OK.` }),
        h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => backUpNow({}) }, 'Back up now')))
      : null;
  const auto = radios('Back up automatically', [
    ['changes', type.stores === 'tree' ? 'After changes, within the hour' : 'After changes, at most every 6 hours'],
    ['daily', 'Once a day'],
    ['off', 'Off'],
  ], t.auto, async (v) => {
    await ctx.backups.update(id, { auto: /** @type {any} */ (v) });
    ctx.notices.toast('Saved');
  });
  const mobile = checkbox('Also over mobile data', t.mobileData);
  mobile.input.addEventListener('change', async () => {
    await ctx.backups.update(id, { mobileData: mobile.input.checked });
    ctx.notices.toast('Saved');
  });
  const list = h('ul', { class: 'cards' });
  const show = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      show.disabled = true;
      say('Looking…');
      try {
        const all = await ctx.backups.remote(id);
        say(all.length ? '' : 'There are no backups here yet.');
        list.replaceChildren(...all.slice(0, 10).map((/** @type {any} */ r) => h('li', { class: 'card' },
          h('span', { class: 'name', text: new Date(r.at).toLocaleString() }),
          h('span', { class: 'sub', text: [r.label ? `From ${withArticle(r.label)}` : null, relTime(r.at)].filter(Boolean).join(' · ') }),
          h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => restoreFrom(ctx, t, r, say) }, 'Open')))));
      } catch (e) {
        say(String(/** @type {any} */ (e)?.message ?? e));
      }
      show.disabled = false;
    },
  }, 'Show the backups here');
  const more = inputs.filter((/** @type {any} */ i) => i.f.advanced);
  const help = type.help
    ? h('p', { class: 'sub' }, type.help, /^https:\/\//.test(type.helpUrl ?? '') ? [' ', h('a', { href: type.helpUrl, target: '_blank', rel: 'noopener' }, type.helpLabel ?? 'How to set it up')] : null)
    : null;
  return h('div', { class: 'screen' }, ...top,
    holdPanel,
    h('section', { class: 'panel', 'aria-label': 'Where' },
      ...inputs.filter((/** @type {any} */ i) => !i.f.advanced).map((/** @type {any} */ i) => field(i.f.label, i.el)),
      ...secrets.map((/** @type {any} */ i) => field(i.f.label, i.el)),
      more.length ? h('details', {}, h('summary', { text: 'More' }), ...more.map((/** @type {any} */ i) => field(i.f.label, i.el))) : null,
      help,
      h('div', { class: 'acts' }, save),
      status),
    h('section', { class: 'panel', 'aria-label': 'When' },
      auto, mobile.el,
      connectionOf(navigator) === 'unknown'
        ? h('p', { class: 'sub', text: `This browser doesn't tell annai whether it is on Wi-Fi, so automatic backups larger than ${bytes(TIMINGS.askAbove)} wait for your OK, unless "Also over mobile data" is on.` })
        : null,
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => backUpNow({}) }, 'Back up now'), stop)),
    h('section', { class: 'panel', 'aria-label': 'Restore' },
      h('h2', { class: 'section', text: 'Restore' }),
      h('p', { class: 'sub', text: 'Open a backup from here on the import screen, where you choose what comes in.' }),
      h('div', { class: 'acts' }, show),
      list),
    removeSection(ctx, id));
}

/** @param {any} ctx @param {string} id */
function removeSection(ctx, id) {
  return h('section', { class: 'panel', 'aria-label': 'Remove' },
    h('p', { class: 'sub', text: 'annai stops backing up here. The backups already there stay.' }),
    h('div', { class: 'acts' }, twoStep('Remove this place', 'Tap again to remove it', async () => {
      await ctx.backups.remove(id);
      ctx.go('#/backups');
    })));
}
```

In `src/ui/import-state.js`:

```js
/**
 * Files picked or dropped on one screen and opened on the import screen (hash routes can't carry files).
 * @typedef {{ target: string, remote: import('../core/backup-targets.js').RemoteBackup }} From a backup opened from a backup place
 */
/** @type {{ files: File[], archive: boolean, from: From | null } | null} */
let pending = null;
/**
 * @param {File[]} files @param {{ archive?: boolean, from?: From | null }} [o]
 *   archive: picked as an annai file, so it is one whatever its name; from: the backup place it came from
 */
export function setPendingImport(files, { archive = false, from = null } = {}) { pending = files.length ? { files, archive, from } : null; }
```

In `src/ui/screens/import.js`:
- The `Source` typedef becomes `{ name: string, blob: Blob, from?: import('../import-state.js').From | null }`.
- In `renderImport`, after `source = await pickSource(...)`: `if (source && pending?.from) source = { ...source, from: pending.from };`.
- In `step`, the preview gets the source and whether this device has no trips yet:

```js
  const { active, archived } = await listTrips(ctx.store);
  body.replaceChildren(preview(ctx, body, opened, await describeArchive(ctx.store, opened), source.from ?? null, !active.length && !archived.length));
```

- `preview(ctx, body, opened, desc, from, fresh)`:
  - Opened from a place on a device with no trips yet, the profile-and-memory and settings boxes start ticked: `checkbox('Replace my profile and memory with the ones in this file', Boolean(from) && fresh)`, and the same for `'Replace my settings'`.
  - After a successful `importArchive`, before showing "Imported.":

```js
        // This device has taken in that backup: its next backup there builds on it (spec §12.4).
        if (from) await ctx.backups?.accept(from.target, from.remote).catch(() => {});
```

  - The panel shown after importing adds `from ? h('p', { class: 'sub', text: "annai's next backup to that place builds on this one." }) : null`.

In `src/ui/screens/settings.js`, the Backup section shows the places and links to them:

```js
  const places = ctx.backups ? await ctx.backups.list() : [];
  const automatic = places.filter((/** @type {any} */ p) => p.auto !== 'off').map((/** @type {any} */ p) => p.name);
```

```js
    section('Backup',
      h('p', { class: 'sub', text: app.lastExportAt ? `Last export ${relTime(app.lastExportAt)}.` : 'No export yet. Export regularly: annai keeps everything on this device.' }),
      h('p', { class: 'sub', text: automatic.length ? `Backing up automatically to ${automatic.join(', ')}.` : 'No automatic backups yet. Add a place to back up to, such as a private GitHub repository.' }),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportSlot.replaceChildren(exportPanel(ctx, { kind: 'everything', title: 'everything' })),
      }, 'Export everything'), h('a', { class: 'btn', href: '#/backups' }, 'Automatic backups')),
      exportSlot),
```

In `src/ui/screens/trips.js`, the line under the trips names the latest backup to a place, when there is one:

```js
  const places = ctx.backups ? await ctx.backups.list() : [];
  const latest = places.filter((/** @type {any} */ p) => p.last).sort((/** @type {any} */ a, /** @type {any} */ b) => b.last.at - a.last.at)[0];
```

```js
    h('p', { class: 'sub', text: latest ? `Last backup ${relTime(latest.last.at)}, to ${latest.name}.`
      : settings.lastExportAt ? `Last export ${relTime(settings.lastExportAt)}.` : 'No backup yet. Export everything from Settings, or set up automatic backups there.' }),
```

In `src/ui/screens/trace.js`, import `bytes` and `withArticle` from `../format.js`, add a Kind:

```js
  Backups: ['backup', 'backup.newer', 'backup.error', 'backup.download'],
```

and, in `traceSummary`, before the last line:

```js
  if (e.type === 'backup') return `${d.type} · ${d.reason} · ${d.files ?? '?'} files sent, ${bytes(d.uploaded ?? 0)} · ${d.ms ?? '?'} ms`;
  if (e.type === 'backup.newer') return `${d.type} · a newer backup from ${d.remote?.label ? withArticle(d.remote.label) : 'another device'} is there`;
  if (e.type === 'backup.error') return `${d.type} · ${d.kind}: ${cut(d.message)}`;
  if (e.type === 'backup.download') return `${d.type} · downloaded ${d.backup}, ${bytes(d.bytes ?? 0)}`;
```

In `src/ui/shell.js`, import `renderBackups` from `./screens/backups.js`, add `backups: renderBackups` to `SCREENS`, and add `backups?: any` to the `core` type of `startShell`.

In `src/app/main.js`:

```js
import { createBackups } from '../core/backup.js';
import { ensureProvided } from '../core/llm/official.js';
import { startBackups } from '../ui/auto-backup.js';
import { isStandalone, requestPersist, watchForUpdates, deviceName } from '../ui/platform.js';
```

before `startShell`:

```js
  // Backups to the places this device backs up to (spec §12.4). Choosing a kind of place installs its
  // plugin (§5.3), whose files load through the service worker.
  const device = deviceName();
  const backups = createBackups({
    store, ws, registry, app: VERSION, label: device.label, noun: device.noun,
    ensure: async (type) => {
      await controllerReady();
      await ensureProvided(plugins, 'storage-type', type);
    },
  });
  const shell = startShell(root, { store, ws, registry, plugins, llm, agent, presets, backups, version: VERSION });
```

and in the `startPlugins(…).finally` callback, after `loadLinks`:

```js
    // Automatic backups start once installed plugins have: a place's kind comes from its plugin.
    startBackups({ backups, store, notices: shell.notices, go: (hash) => { location.hash = hash; } });
```

In `sw.js`, add `'/src/ui/auto-backup.js',` and `'/src/ui/screens/backups.js',` to `SHELL`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/ui-pure.test.js test/unit/platform.test.js test/unit/sw-shell.test.js && npm run typecheck && npm run size`
Expected: PASS; typecheck clean; size under 770 KiB.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui src/app/main.js sw.js test/unit/ui-pure.test.js test/unit/platform.test.js && git commit -m "Settings → Backups: places, automatic backups, the newer-backup card, restore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 8: Done: automatic backup and restore to GitHub, end to end

**Files:**
- Create: `test/e2e/backups.spec.js`, `docs/testing/device-checklist-m9.md`
- Modify: `docs/plugins.md` (a section on backup places), `README.md` (what annai does now)

**Interfaces:**
- Consumes: everything above; `startGitHub` from Task 3; `openApp` from `test/e2e/helpers.js`.
- Produces: the done criterion, proven in Chromium (Pixel 7) and WebKit (iPhone 15), in Docker.

- [ ] **Step 1: Write the end-to-end test**

`test/e2e/backups.spec.js`:

```js
import { test, expect, devices } from '@playwright/test';
import { openApp } from './helpers.js';
import { startGitHub } from '../fakes/github.js';

const REPO = 'me/annai-backup';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Automatic backups on a short clock: a look every 300 ms, 300 ms after the last change, no gap between backups. @param {import('@playwright/test').Page} page */
async function fastBackups(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('annai.backupTimings', JSON.stringify({ tickMs: 300, quietMs: 300, gapMs: 0 }));
    } catch {
      // storage blocked
    }
  });
}

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {string} path @param {string} content */
async function writeNote(page, path, content) {
  await page.getByLabel('File path').fill(path);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill(content);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}

/** Settings → Automatic backups → GitHub, filled in and tested. @param {import('@playwright/test').Page} page @param {any} gh */
async function addGitHub(page, gh) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Automatic backups' }).click();
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
  await page.getByLabel('Add a place to back up to').selectOption({ label: 'GitHub' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Repository').fill(REPO);
  await page.getByLabel('Access token').fill(gh.token);
  await page.getByText('More', { exact: true }).click();
  await page.getByLabel('GitHub API address').fill(gh.origin);
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByText(`Works: annai can reach ${REPO}, a private repository.`)).toBeVisible();
}

test('automatic backups go to GitHub, only what changed is sent, and a wiped phone gets everything back (spec §12.4)', async ({ page }) => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    await fastBackups(page);
    await openApp(page);
    await startTrip(page, 'Big Sur');
    await writeNote(page, '/notes/bixby.md', 'Bixby Bridge, 1932');
    await page.getByRole('link', { name: '← Back to trip' }).click();
    await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
    await addGitHub(page, gh);

    // Nothing more to do: the backup goes up by itself, as files.
    await expect(page.getByText(/^Last backup/)).toBeVisible({ timeout: 30_000 });
    expect(gh.commits(REPO).map((c) => c.message.split('\n')[0])).toEqual([expect.stringMatching(/^annai backup from /), 'Start annai backups']);
    const files = gh.files(REPO);
    const note = /** @type {string} */ ([...files.keys()].find((p) => /^trips\/[^/]+\/notes\/bixby\.md$/.test(p)));
    expect(files.get(note)?.toString()).toBe('Bixby Bridge, 1932');
    expect(files.has('annai-archive.json')).toBe(true);
    expect([...files.keys()].some((p) => /^trips\/[^/]+\/files\/gate\.(webp|jpg)$/.test(p))).toBe(true);
    expect(gh.count('POST', '/git/blobs')).toBe(1);
    await page.getByRole('link', { name: 'Trips', exact: true }).click();
    await expect(page.getByText(/backed up (just now|\d+ seconds? ago)/)).toBeVisible();

    // A change goes up by itself too, and the photo isn't sent again.
    await page.getByRole('link', { name: /Big Sur/ }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await page.getByLabel('Content').fill('Bixby Bridge, 1932, at dawn');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => gh.files(REPO).get(note)?.toString(), { timeout: 30_000 }).toBe('Bixby Bridge, 1932, at dawn');
    expect(gh.count('POST', '/git/blobs')).toBe(1);

    // The trace shows each request annai sent to GitHub.
    await page.getByRole('link', { name: 'Trace' }).click();
    await page.getByLabel('Kind').selectOption('Web');
    await expect(page.locator('.trace li', { hasText: 'plugin:storage-github · PATCH' }).first()).toBeVisible();
    await page.getByLabel('Kind').selectOption('Backups');
    await expect(page.locator('.trace li', { hasText: 'github · auto' }).first()).toBeVisible();

    // This phone is wiped. The same place, set up again, brings everything back.
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await expect(page.getByText('No trips yet.')).toBeVisible();
    await addGitHub(page, gh);
    await expect(page.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
    await expect(page.getByText(/^An? (iPhone|Android phone|computer) backed up to me\/annai-backup/)).toBeVisible();
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Replace my profile and memory with the ones in this file')).toBeChecked();
    await expect(page.getByLabel('Replace my settings')).toBeChecked();
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText("annai's next backup to that place builds on this one.")).toBeVisible();
    await page.getByRole('link', { name: 'Open Big Sur' }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await expect(page.getByLabel('Content')).toHaveValue('Bixby Bridge, 1932, at dawn');
    await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
    await page.getByRole('link', { name: '← Back to trip' }).click();
    await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
    await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();

    // The restored phone builds on that backup: its next one goes on top, with no warning.
    await expect.poll(() => gh.commits(REPO).length, { timeout: 30_000 }).toBe(4);
    const [restored, before] = gh.commits(REPO);
    expect(restored.parents).toEqual([before.sha]);
  } finally {
    await gh.stop();
  }
});

test('a newer backup from another phone pauses this one, and comes in as a copy (spec §12.4: single writer)', async ({ page, browser, baseURL }) => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  const other = await browser.newContext({ ...devices[test.info().project.name === 'webkit' ? 'iPhone 15' : 'Pixel 7'], baseURL, acceptDownloads: true });
  try {
    await fastBackups(page);
    await openApp(page);
    await startTrip(page, 'Kyoto');
    await addGitHub(page, gh);
    await expect.poll(() => gh.commits(REPO).length, { timeout: 30_000 }).toBe(2);

    // The second phone finds that backup and takes it in as a copy, then backs up on top of it.
    const second = await other.newPage();
    await fastBackups(second);
    await openApp(second);
    await addGitHub(second, gh);
    await expect(second.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
    await second.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(second.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await second.getByRole('button', { name: 'Import' }).click();
    await second.getByRole('link', { name: 'Open Kyoto' }).click();
    await writeNote(second, '/notes/fushimi.md', 'Fushimi Inari at dawn');
    await expect.poll(() => [...gh.files(REPO).keys()].some((p) => p.endsWith('/notes/fushimi.md')), { timeout: 30_000 }).toBe(true);

    // The first phone's next backup meets it: a card, and nothing is overwritten.
    const commits = gh.commits(REPO).length;
    await page.getByRole('link', { name: 'Trips', exact: true }).click();
    await page.getByRole('link', { name: /Kyoto/ }).click();
    await writeNote(page, '/notes/kiyomizu.md', 'Kiyomizu-dera');
    await expect(page.getByText('A newer backup is on GitHub')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^An? (iPhone|Android phone) backed up to me\/annai-backup .*, after this phone's last backup\./)).toBeVisible();
    expect(gh.commits(REPO).length).toBe(commits);
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Replace mine (yours moves to archived trips)').check();
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('link', { name: 'Open Kyoto' }).click();
    await expect(page.getByRole('link', { name: /fushimi\.md/ })).toBeVisible();

    // From now on it builds on the other phone's backup.
    await expect.poll(() => gh.commits(REPO).length, { timeout: 30_000 }).toBe(commits + 1);
    expect(gh.commits(REPO)[0].parents).toEqual([gh.commits(REPO)[1].sha]);
  } finally {
    await other.close();
    await gh.stop();
  }
});
```

- [ ] **Step 2: Run it in both browsers, in Docker**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/backups.spec.js 2>&1 | tail -30`
Expected: 4 passed (2 tests × Chromium and WebKit). If WebKit left a `core*` file in the worktree, delete it.

- [ ] **Step 3: Run the whole end-to-end suite in Docker**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test 2>&1 | tail -30`
Expected: every test passes in both browsers. This also catches a duplicate function declaration, which tsc doesn't flag in a JS module.

- [ ] **Step 4: Write the device checklist and the guides**

`docs/testing/device-checklist-m9.md`:

```markdown
# Device checklist: milestone 9a (backups to GitHub)

The done criterion is that automatic backup and restore to GitHub work on an iPhone and an Android phone, in the app installed to the Home Screen, with your own private repository and tokens. Open annai over HTTPS at the address you will travel with: each address keeps its own data.

## Before you start, on github.com

- [ ] **New repository:** name it, for example, `annai-backup`; choose **Private**; a README is fine. Nothing else goes in it.
- [ ] **One token per phone,** so you can revoke one without the other: your picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
  - **Name:** "annai on iPhone". **Expiration:** your choice; when GitHub stops accepting it, annai shows a card.
  - **Repository access:** Only select repositories → `annai-backup`.
  - **Permissions** → Repository permissions → **Contents: Read and write** (Metadata: Read-only comes with it).
  - **Generate token**, and copy it.

## The first phone (iPhone)

- [ ] Settings → **Automatic backups** → "Add a place to back up to": **GitHub** → **Add**. The first time, this installs annai's GitHub plugin, which needs a connection.
- [ ] Repository `you/annai-backup`, the token, **Save and test**: "Works: annai can reach you/annai-backup, a private repository."
- [ ] Within a few minutes, on Wi-Fi with annai open: "Last backup just now". On github.com, the repository has a commit "annai backup from iPhone", with `annai-archive.json` and the folders `me`, `trips` and `system`. A trip's notes are readable there.
- [ ] Trips: each trip card says "backed up … ago".
- [ ] Add a note, then wait about an hour with annai open: a new commit. On GitHub, its changed files are the note, the logs and `annai-archive.json`; no photo was sent again.
- [ ] Add 10 or more photos away from Wi-Fi. Safari can't tell annai whether it is on Wi-Fi, so when the backup would upload more than 25 MB, a card says "A large backup is waiting". **Back up now** sends it.
- [ ] Trace → Kind **Web**: each request to GitHub is a line `plugin:storage-github · …`. Kind **Backups**: a line for each backup. Settings → **Copy diagnostics**, paste it into a note, and search for your token: it isn't there.

## The second phone (Android)

- [ ] The same steps with the second token. After **Save and test**: "A backup is already here. An iPhone backed up to you/annai-backup …". **Import it as a copy** → the import preview → **Import**: the iPhone's trips are here.
- [ ] Turn Wi-Fi off and change something: no new commit appears. Turn Wi-Fi on: one does, within a few minutes.
- [ ] Turn on **Also over mobile data** on the GitHub place: changes are backed up on mobile data too.

## Two phones, one repository

- [ ] On the Android phone, change something; a commit "annai backup from Android phone" appears.
- [ ] On the iPhone, change something. Within a few minutes, a card: "A newer backup is on GitHub. An Android phone backed up to you/annai-backup … after this phone's last backup." No commit from the iPhone appears.
- [ ] **Import it as a copy:** each trip you have shows "You already have …", with "Replace mine". After importing, the iPhone's next backup goes on top of the Android phone's.
- [ ] Or, the next time, **Back up this phone over it:** a commit from the iPhone, and the Android phone's commit is still in the repository's history.

## Restore onto a wiped phone

- [ ] First, Settings → **Export everything** (a second copy, just in case). Then Settings → Erase → type ERASE → **Erase now**.
- [ ] Settings → Automatic backups → GitHub → repository and token → **Save and test** → "A backup is already here" → **Import it as a copy**. "Replace my profile and memory" and "Replace my settings" are already ticked. **Import.**
- [ ] Every trip is back: notes with their history, photos, plan and bookings. The models are back too; type their API keys again, since keys are never in a backup.
- [ ] Restart annai, as the import screen asks. The next commit's parent is the one you restored from.
- [ ] Backups → GitHub → **Show the backups here** → an older one → **Open**: the import preview shows that day's trips.

## What should fail kindly

- [ ] A public repository: **Save and test** says it is public, and how to make it private.
- [ ] A wrong or expired token: "GitHub didn't accept the access token …", and a card once when an automatic backup meets it.
- [ ] A repository with code in it: "… holds other files (…), so annai won't back up into it."
- [ ] Airplane mode: no pile of cards. Backups show that the last try failed, and carry on by themselves later.
```

In `docs/plugins.md`, add a row to the table of what `annai` gives you:

```markdown
| `annai.storage.register(type)` | a kind of place to back up to (spec §12.4); see "Backup places" below |
```

add `TargetError` and `zip` (`ZipReader`, `ZipWriter`) to the `annai.helpers` row, and add this section before "Rules":

````markdown
## Backup places

A backup place keeps annai's backups somewhere else: a git repository, a bucket, a folder on a server. annai builds each backup (a Backup of everything, spec §12.2) and decides when; your type only moves it. annai's own GitHub type is a plugin too: see `plugins-official/storage-github/`.

```js
export function activate(annai) {
  const { TargetError } = annai.helpers;
  return annai.storage.register({
    type: 'my-place',                    // lowercase letters, digits and dashes
    name: 'My place',
    stores: 'file',                      // "tree": the archive's files, unpacked; "file": the archive file itself
    fields: [{ key: 'url', label: 'Address', placeholder: 'https://…' }],
    secret: [{ key: 'password', label: 'Password' }],
    where: (config) => config.url,
    async check(c) { return { note: 'Works.' }; },
    async list(c) { return [/* { id, at, device?, label? }, newest first */]; },
    async put(c, archive, o) { /* … */ return { id, at }; },
    async get(c, id, o) { /* … */ return blob; },
  });
}
```

- **`c`** is `{ config, secret, device: { id, label }, app }`. `secret` holds what the user typed in your `secret` fields. annai keeps it in its secrets store, never in files, backups or the trace.
- **`put(c, archive, o)`** gets `archive = { blob, name, manifest }` and `o = { base, maxUpload, signal, onProgress }`.
  - **Single writer:** refuse with `new TargetError('newer', words, { remote })` when the place's newest backup is neither `o.base` nor one this device made (`c.device.id`). annai then asks the user.
  - **Size:** refuse with `TargetError('large', words, { bytes })`, before uploading anything, when you would send more than `o.maxUpload` bytes.
  - **Progress:** call `o.onProgress({ phase: 'uploading', done, total })` as you go, and stop when `o.signal` aborts.
- **`get(c, id, o)`** returns the backup as an annai archive file (a `Blob`), which annai opens on its import screen.
- **`delete(c, id)`**, optional, removes one backup.
- **Errors are answers:** throw a `TargetError` with a kind and plain words:
  - `auth`, `refused`, `missing` and `setup` need the user, so annai shows a card once.
  - `rate` (with `retryAt`) and `other` are tried again later.
  - A `TypeError` and the like count as a bug in your plugin.
- **Send every request through `annai.net.fetch`,** so the trace shows it.
````

In `README.md`, add after the "Plan and bookings" section:

```markdown
## Backups

- Back up everything automatically to a private GitHub repository: after changes or once a day, on Wi-Fi, while annai is open. Each backup is one commit of your files, and only what changed is uploaded.
- Restore any backup onto a new or wiped phone from Settings → Automatic backups.
- A newer backup from your other phone is never overwritten: annai pauses, and offers to import it as a copy.
- Your API keys and the GitHub token stay on the device; they are never in a backup.
```

and in the status note, after the planning sentence: `Backups to GitHub (milestone 9) too.`

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add test/e2e/backups.spec.js docs/testing/device-checklist-m9.md docs/plugins.md README.md && git commit -m "Done: automatic backup and restore to GitHub, end to end; the device checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
