import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, removeTrip, backupState, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { peekArchive, importArchive } from '../../src/core/archive.js';
import { TargetError } from '../../src/core/storage-types.js';
import { addTarget } from '../../src/core/backup-targets.js';
import { createBackups, retryDelay, holdWords } from '../../src/core/backup.js';
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
  const opened = await peekArchive(place.kept[0].blob);
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
  assert.deepEqual((await android.backups.get(b))?.hold, { kind: 'newer', remote: seen.newer, seen: true }, 'found by the user, on the place screen: no card');
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
  await importArchive(phone.store, await peekArchive(blob), {});
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
  assert.deepEqual(await hold(), { kind: 'error', message: 'The place had a problem.', said: null, at: d.now(), count: 1, retryAt: d.now() + 15 * 60_000, needsYou: false });
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
  await assert.rejects(running, (/** @type {any} */ e) => e?.name === 'AbortError');
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
    // Its files, its translations' folder too.
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { const name = relative(fileURLToPath(dir), join(e.parentPath, e.name)); files.set(name, new Uint8Array(await readFile(new URL(name, dir)))); }
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
    for (const [path, bytes] of gh.files('me/annai-backup')) assert.equal(bytes.toString('latin1').includes(gh.token), false, path);
    // A broken answer from GitHub is GitHub's answer: the plugin isn't blamed, and keeps running.
    gh.garbleNext({ method: 'GET', part: '/repos/me/annai-backup', body: '<html>Unicorn!</html>' });
    await assert.rejects(backups.check(id), (e) => e instanceof TargetError && e.kind === 'other' && /can't read/.test(e.message));
    assert.deepEqual(logged, []);
    assert.equal(registry.isDisabled('storage-github'), false);
  } finally {
    await gh.stop();
  }
});

test('a restore stops an automatic backup that is uploading; behind one the user started, it waits and says so', { timeout: 5000 }, async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  await d.backups.backUp(id);
  const release = place.pause();
  const auto = d.backups.backUp(id, { reason: 'auto' });
  await until(() => place.waiting() > 0);
  assert.deepEqual(d.backups.running().map((r) => [r.id, r.reason]), [[id, 'auto']]);
  const blob = await d.backups.download(id, 'b1');
  assert.ok(blob.size > 0);
  await assert.rejects(auto, (/** @type {any} */ e) => e?.name === 'AbortError');
  assert.equal((await d.backups.get(id))?.hold, null, 'no failure: it carries on later');
  // Behind a backup the user started, a restore waits for it.
  const mine = d.backups.backUp(id);
  await until(() => place.waiting() > 1);
  assert.deepEqual(d.backups.running().map((r) => r.reason), ['user']);
  let done = false;
  const later = d.backups.download(id, 'b1').then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false);
  release();
  await mine;
  await later;
  assert.equal(done, true);
});

test("how much a place uploads without asking, on a connection annai can't name, is the user's to choose", async () => {
  const d = await device(memoryPlace());
  const id = await placeOn(d);
  await d.backups.check(id);
  assert.equal((await d.backups.get(id))?.askAbove, undefined, "unset: annai's 25 MB");
  await d.backups.update(id, { askAbove: 100 * 1024 * 1024 });
  assert.equal((await d.backups.get(id))?.askAbove, 100 * 1024 * 1024);
  await d.backups.update(id, { askAbove: null });
  assert.equal((await d.backups.get(id))?.askAbove, null, 'no limit');
  assert.notEqual((await d.backups.get(id))?.checked, null, 'no new test needed');
  for (const bad of [-1, Number.NaN, Infinity]) await assert.rejects(d.backups.update(id, { askAbove: bad }), (e) => e instanceof TargetError && e.kind === 'setup');
});

test("fix pass R1 (minor 5): a git-like place keeps no record of devices seen; its own history and clock decide, so a backup older than the one taken in isn't newer", async () => {
  const place = memoryPlace();
  const [phone, android, ipad] = [await device(place, 'iPhone'), await device(place, 'Android phone'), await device(place, 'iPad')];
  const b = await placeOn(android);
  await android.backups.check(b);
  await android.backups.backUp(b);
  const c = await placeOn(ipad);
  await ipad.backups.check(c);
  await ipad.backups.backUp(c, { over: true });
  const a = await placeOn(phone);
  const seen = await phone.backups.check(a);
  assert.equal(seen.newer?.label, 'iPad');
  assert.equal(/** @type {any} */ ((await phone.backups.get(a))?.hold)?.known, undefined);
  await phone.backups.accept(a, /** @type {any} */ (seen.newer));
  assert.equal((await phone.backups.check(a)).newer, null, "the Android's backup, older than the iPad's, isn't newer");
  assert.equal((await phone.backups.get(a))?.last?.known, undefined);
  await phone.backups.backUp(a);
  assert.equal((await phone.backups.get(a))?.last?.known, undefined);
});

test("fix pass: adding a place never switches on a backup plugin the user turned off (it says so); the place's Turn it on, the user's own tap for it, does", async () => {
  /** @type {[string, boolean][]} */
  const asked = [];
  const d = await device(memoryPlace(), 'iPhone', async (type, o) => { asked.push([type, Boolean(o?.keepOff)]); });
  const id = await d.backups.add('memory');
  await d.backups.turnOn(id);
  assert.deepEqual(asked, [['memory', true], ['memory', false]]);
});

test('fix pass: with ensureProvided, a storage plugin the user turned off stays off when a place of its kind is added, in words', async () => {
  const { ensureProvided } = await import('../../src/core/llm/official.js');
  const { hostKit } = await import('./package-kit.js');
  const { readFile } = await import('node:fs/promises');
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  const fetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  await ensureProvided(k.host, 'storage-type', 'webdav', { fetch });
  await k.host.setEnabled('storage-webdav', false);
  await assert.rejects(ensureProvided(k.host, 'storage-type', 'webdav', { fetch, keepOff: true }), /WebDAV, which you turned off.*Turn it on in Settings → Plugins/s);
  assert.equal((await k.host.installed())['storage-webdav'].enabled, false);
  await ensureProvided(k.host, 'storage-type', 'webdav', { fetch });
  assert.equal((await k.host.installed())['storage-webdav'].enabled, true, 'Turn it on switches it on');
});

test("M6 fix: a backup place's bug counts against the plugin that registered its type, never a pluginId the type carries", async () => {
  const place = memoryPlace();
  const d = await device(place);
  // A type that says it is webdav's, registered by evil.
  d.registry.removePlugin('memory-place');
  d.registry.add('evil', 'storage-type', { ...place.type, pluginId: 'webdav', check: async () => { throw new TypeError('broke'); } });
  const id = await placeOn(d);
  await assert.rejects(d.backups.check(id));
  assert.deepEqual([...new Set(d.logged.filter((e) => e.type === 'plugin.error').map((e) => e.actor))], ['plugin:evil']);
});

// The emulator pass (m9 #35): Back up now in airplane mode blamed the server's browser access (CORS), and waited 15 minutes.
test("a backup that fails while this phone is offline says it is offline, not that the place may block web apps, and tries again once it's back", async () => {
  let online = true;
  const place = memoryPlace();
  const d = await device(place, 'iPhone', undefined, () => online);
  const id = await placeOn(d);
  await d.backups.check(id);
  online = false;
  place.failNext(new TypeError('Failed to fetch'));
  await assert.rejects(d.backups.backUp(id), /offline/);
  // Save and test says it too.
  await assert.rejects(d.backups.check(id), (/** @type {any} */ e) => e.shown === "This phone is offline, so annai couldn't reach this place." && e.message === 'This phone is offline.');
  const rec = (await d.backups.list()).find((t) => t.id === id);
  assert.equal(rec?.hold?.kind, 'error');
  const hold = /** @type {any} */ (rec?.hold);
  // Kept as data, its words made where it is shown (localization L5f); the log and the hold keep English.
  assert.equal(holdWords(hold), "This phone is offline, so annai couldn't reach this place. annai tries again once it's back online.");
  assert.equal(hold.message, 'This phone is offline.');
  assert.deepEqual([hold.said, hold.offline], [{ code: 'offline', noun: 'phone' }, true]);
  assert.equal(hold.needsYou, false);
  assert.equal(hold.retryAt, d.now(), 'no 15-minute wait: due again as soon as the connection is');
  // Review R12: failing offline again and again counts as no failure of the place's: the wait after a real one stays short.
  place.failNext(new TypeError('Failed to fetch'));
  await assert.rejects(d.backups.backUp(id), /offline/);
  assert.equal(/** @type {any} */ ((await d.backups.list()).find((t) => t.id === id)?.hold).count, 0);
  // Online, an error is the place's own words, and waits as after a first failure.
  online = true;
  place.failNext(new TypeError('Failed to fetch'));
  await assert.rejects(d.backups.backUp(id), /Failed to fetch/);
  const after = /** @type {any} */ ((await d.backups.list()).find((t) => t.id === id)?.hold);
  assert.equal(after.count, 1);
  assert.equal(after.retryAt, d.now() + 15 * 60_000);
});

test('a place that can peek tells what a backup holds from its manifest alone; one that cannot gets null (spec §12.4)', async () => {
  const plain = await device(memoryPlace());
  const plainId = await placeOn(plain);
  await plain.backups.backUp(plainId);
  assert.equal(await plain.backups.peek(plainId, 'b1'), null, 'a place without peek: the caller downloads, as before');

  const place = memoryPlace({ peek: true });
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  const manifest = await phone.backups.peek(id, 'b1');
  assert.equal(place.peeks(), 1);
  assert.deepEqual(manifest, (await peekArchive(place.kept[0].blob)).manifest);
  assert.deepEqual(phone.backups.running(), [], 'it is no download');
  await assert.rejects(phone.backups.peek(id, 'gone'), (e) => e instanceof TargetError && e.kind === 'missing');
});

test('a peek is not queued behind a backup under way, and leaves an automatic one alone', async () => {
  const place = memoryPlace({ peek: true });
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  const release = place.pause();
  const running = phone.backups.backUp(id, { reason: 'auto' });
  await until(() => place.waiting() > 0);
  const manifest = await phone.backups.peek(id, 'b1');
  assert.ok(manifest.files, 'answered while the backup is still in flight');
  assert.deepEqual(phone.backups.running().map((r) => r.reason), ['auto'], 'and the backup is still the only thing running');
  release();
  await running;
  assert.equal(place.kept.length, 2, 'the automatic backup finished: the peek did not stop it');
});

test("a peeked manifest the place sends badly is refused in plain words, with the details in the trace only", async () => {
  const place = memoryPlace({ peek: true });
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  const manifest = await phone.backups.peek(id, 'b1');
  const real = place.type.peek;
  /** @param {unknown} m */
  const sends = (m) => { place.type.peek = /** @type {any} */ (async () => m); };
  sends({ ...manifest, format: 99 });
  await assert.rejects(phone.backups.peek(id, 'b1'), (e) => e instanceof TargetError && e.message === 'This backup was made by a newer annai: update annai first.');
  sends({ files: 'no' });
  await assert.rejects(phone.backups.peek(id, 'b1'), (e) => e instanceof TargetError && e.message === 'This backup is damaged.');
  sends({ ...manifest, files: manifest.files.map((/** @type {any} */ f, /** @type {number} */ i) => (i ? f : { ...f, path: '/../../escape' })) });
  await assert.rejects(phone.backups.peek(id, 'b1'), (e) => e instanceof TargetError && e.message === 'This backup is damaged.', 'an unsafe path');
  place.type.peek = real;
  const traced = await phone.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.peek'] }));
  assert.equal(traced.length, 3);
  assert.match(JSON.stringify(traced[0].data), /newer version of annai/);
  assert.match(JSON.stringify(traced[2].data), /unsafe file path/);
});

test('only a place that stores the unpacked tree is peeked: a whole-file place gets its download as before', async () => {
  const place = memoryPlace({ peek: true });
  place.type.stores = /** @type {any} */ ('file');
  const phone = await device(place);
  const id = await placeOn(phone);
  assert.equal(await phone.backups.peek(id, 'b1'), null);
  assert.equal(place.peeks(), 0);
});

test('a download that is stopped while it waits its turn never reaches the place', async () => {
  const place = memoryPlace();
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  const release = place.pause();
  const running = phone.backups.backUp(id);
  await until(() => place.waiting() > 0);
  const stop = new AbortController();
  const queued = phone.backups.download(id, 'b1', { signal: stop.signal });
  stop.abort();
  release();
  await running;
  await assert.rejects(queued, (e) => /** @type {any} */ (e).name === 'AbortError');
  assert.equal(place.gets(), 0, 'get never ran');
  assert.deepEqual(phone.backups.running(), []);
});

test('a download that is stopped while it runs stops the place, and nothing is left running', async () => {
  const place = memoryPlace();
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  place.pauseGets();
  const stop = new AbortController();
  const running = phone.backups.download(id, 'b1', { signal: stop.signal });
  await until(() => place.gets() > 0);
  assert.deepEqual(phone.backups.running().map((r) => r.reason), ['download']);
  stop.abort();
  await assert.rejects(running, (e) => /** @type {any} */ (e).name === 'AbortError');
  assert.deepEqual(phone.backups.running(), []);
  // The one before it left nothing behind: the next download works.
  await assert.rejects(phone.backups.download(id, 'b1', { signal: AbortSignal.abort() }), (e) => /** @type {any} */ (e).name === 'AbortError');
});

test('a cancel that lands while the place is being read stops the download before it asks for any file', async () => {
  const place = memoryPlace();
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  const stop = new AbortController();
  // The user cancels at the moment the backup place's record is read, after the download's first look at the signal.
  const read = /** @type {(...a: any[]) => Promise<any>} */ (phone.ws.readJSON.bind(phone.ws));
  let armed = true;
  phone.ws.readJSON = /** @type {any} */ (async (/** @type {any[]} */ ...args) => {
    if (armed) { armed = false; stop.abort(); }
    return read(...args);
  });
  await assert.rejects(phone.backups.download(id, 'b1', { signal: stop.signal }), (e) => /** @type {any} */ (e).name === 'AbortError');
  assert.equal(place.gets(), 0, 'get never ran');
  assert.deepEqual(phone.backups.running(), []);
});

test('a cancel that lands as the download ends throws the backup away, and the trace says it was stopped', async () => {
  const place = memoryPlace();
  const phone = await device(place);
  const id = await placeOn(phone);
  await phone.backups.backUp(id);
  const stop = new AbortController();
  const get = /** @type {(...a: any[]) => Promise<Blob>} */ (place.type.get);
  place.type.get = /** @type {any} */ (async (/** @type {any} */ ...args) => {
    const blob = await get(...args);
    stop.abort();
    return blob;
  });
  await assert.rejects(phone.backups.download(id, 'b1', { signal: stop.signal }), (e) => /** @type {any} */ (e).name === 'AbortError');
  const [line] = await phone.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.download'] }));
  assert.deepEqual([line.data.backup, line.data.stopped, line.data.bytes > 0], ['b1', true, true]);
});
