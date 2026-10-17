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
