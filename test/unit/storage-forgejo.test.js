import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { activate } from '../../plugins-official/storage-forgejo/index.js';
import { TargetError, readAnswer } from '../../src/core/storage-types.js';
import { ZipReader, ZipWriter, readZip } from '../../src/core/zip.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createBackups } from '../../src/core/backup.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { text } from '../../src/core/bytes.js';
import { startForgejo, READ_TOKEN, USER_TOKEN } from '../fakes/forgejo.js';
import { browserFetch as browserAt } from '../fakes/browser-fetch.js';
import { everything } from './backup-kit.js';

const REPO = 'me/annai-backup';
const ORIGIN = 'https://annai.guide';
const browserFetch = browserAt(ORIGIN);

/** The Forgejo type as annai's core sees it; sent: every request it made. @param {any} [mod] a fresh copy of the plugin */
function forgejo(mod = { activate }) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const sent = [];
  /** @type {any} */
  let type = null;
  mod.activate({
    helpers: { TargetError, readAnswer, zip: { ZipReader, ZipWriter } },
    net: { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => { sent.push({ url, init }); return browserFetch(url, init); } },
    storage: { register: (/** @type {any} */ t) => { type = t; return () => {}; } },
  });
  return { type, sent };
}

/** @param {any} fj @param {{ device?: string, label?: string, token?: string, owner?: string, repo?: string, server?: string, branch?: string }} [o] */
const ctx = (fj, o = {}) => ({
  config: { server: o.server ?? fj.origin, owner: o.owner ?? REPO.split('/')[0], repo: o.repo ?? REPO.split('/')[1], branch: o.branch ?? '' },
  secret: { token: o.token ?? fj.token },
  device: { id: o.device ?? 'phone-a', label: o.label ?? 'iPhone' }, app: 'test',
});
/** @param {Record<string, any>} [o] */
const opts = (o = {}) => ({ base: null, maxUpload: Infinity, onProgress: () => {}, ...o });
/** @param {string} kind @param {RegExp} [re] */
const refused = (kind, re = /./) => (/** @type {any} */ e) => e instanceof TargetError && e.kind === kind && re.test(e.message);
/** A photo's worth of bytes that isn't text. @param {number} n */
const binary = (n) => new Uint8Array([0, ...crypto.getRandomValues(new Uint8Array(n))]);
/** The ChangeFiles requests the stand-in got, as their bodies. @param {any} fj */
const changes = (fj) => fj.log.filter((/** @type {any} */ l) => l.method === 'POST' && l.path.endsWith('/contents') && l.status === 201).map((/** @type {any} */ l) => JSON.parse(l.body));
/** What a ChangeFiles body did, as "operation path" lines. @param {any} body */
const ops = (body) => body.files.map((/** @type {any} */ f) => `${f.operation} ${f.path.replace(/^trips\/[^/]+\//, '/')}`);
/** The same, for the trip's files (notes, photos) and the manifest only: a change also changes the trip's log and keeps its older version under blobs/. @param {any} body */
const fileOps = (body) => ops(body).filter((/** @type {string} */ o) => / (\/notes|\/files)\/|annai-archive\.json$/.test(o)).sort();

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
/** Opens a backup's archive on a fresh device, as the import screen does. @param {Blob} blob */
async function restored(blob) {
  const fresh = createMemoryStore();
  const ws = new Workspace(fresh, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  const { trips: [id] } = await importArchive(fresh, await openArchive(blob), { me: 'replace' });
  return { ws, id };
}

test("git.js is the GitHub place's, copied as it is: plugins are installed one by one, so one can't import another's", async () => {
  const [a, b] = await Promise.all(['storage-github', 'storage-forgejo'].map((p) => readFile(new URL(`../../plugins-official/${p}/git.js`, import.meta.url), 'utf8')));
  assert.equal(b, a);
});

test('the first backup to an empty repository: the archive as files, in one commit, with only a token and a content type sent (spec §12.4)', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, cors: ORIGIN });
  try {
    const { type, sent } = forgejo();
    assert.deepEqual([type.type, type.name, type.stores, type.fields.map((/** @type {any} */ f) => f.key), type.secret.map((/** @type {any} */ f) => f.key)],
      ['forgejo', 'Forgejo / Gitea', 'tree', ['server', 'owner', 'repo', 'branch'], ['token']]);
    assert.equal(type.fields.find((/** @type {any} */ f) => f.key === 'branch').advanced, true);
    assert.equal(type.where({ server: `${fj.origin}/`, owner: 'me', repo: 'annai-backup' }), `${new URL(fj.origin).host}/me/annai-backup`);
    assert.match((await type.check(ctx(fj))).note, new RegExp(`^Works: annai can reach me/annai-backup on ${new URL(fj.origin).host}, a private repository\\.$`));
    assert.deepEqual(await type.list(ctx(fj)), []);
    const d = await device();
    const a = await archive(d);
    /** @type {string[]} */
    const phases = [];
    const put = await type.put(ctx(fj), a, opts({ onProgress: (/** @type {any} */ p) => phases.push(p.phase) }));
    assert.match(put.id, /^[0-9a-f]{40}$/);
    assert.deepEqual([...new Set(phases)], ['checking', 'uploading']);
    const [backup, ...older] = fj.commits(REPO);
    assert.deepEqual([backup.sha, backup.parents, older.length], [put.id, [], 0], 'no first commit is needed');
    assert.equal(backup.message, 'annai backup from iPhone\n\nDevice: phone-a\nannai test\n');
    const files = fj.files(REPO);
    const entries = await readZip(a.blob);
    for (const [name, bytes] of entries) assert.deepEqual(new Uint8Array(files.get(name) ?? []), bytes, name);
    assert.deepEqual([...files.keys()].sort(), [...entries.keys()].sort());
    const [body] = changes(fj);
    assert.ok(body.files.every((/** @type {any} */ f) => f.operation === 'create'));
    assert.equal(body.files.at(-1).path, 'annai-archive.json', 'the manifest goes last');
    assert.ok(put.files === entries.size && put.uploaded > 3000);
    const listed = await type.list(ctx(fj));
    assert.deepEqual(listed.map((/** @type {any} */ b) => [b.id, b.device, b.label, b.at]), [[put.id, 'phone-a', 'iPhone', put.at]]);
    for (const s of sent) {
      const h = new Headers(s.init.headers);
      assert.equal(h.get('authorization'), `token ${fj.token}`);
      assert.deepEqual([...h.keys()].filter((k) => k !== 'authorization' && k !== 'content-type'), [], 'no other header: servers allow only a few');
      assert.ok(s.url.startsWith(`${fj.origin}/api/v1/repos/${REPO}`), s.url);
    }
  } finally {
    await fj.stop();
  }
});

test('the next backup sends only what changed, deletes what is gone, and comes back whole (restore)', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { type } = forgejo();
    const d = await device();
    await d.ws.write(d.trip, '/notes/gone.md', 'Soon gone', { author: 'user' });
    const first = await type.put(ctx(fj), await archive(d), opts());
    await d.ws.write(d.trip, '/notes/bixby.md', 'Bixby Bridge, 1932, at dawn', { author: 'user' });
    await d.ws.delete(d.trip, '/notes/gone.md', { author: 'user' });
    const second = await type.put(ctx(fj), await archive(d), opts({ base: first.id }));
    assert.deepEqual(fj.commits(REPO)[0].parents, [first.id]);
    const body = changes(fj)[1];
    assert.equal(ops(body).includes('create /files/gate.jpg') || ops(body).includes('update /files/gate.jpg'), false, 'the photo is not sent again');
    assert.ok(ops(body).includes('update /notes/bixby.md'));
    assert.ok(ops(body).includes('delete /notes/gone.md'));
    assert.equal(ops(body).at(-1), 'update annai-archive.json');
    for (const f of body.files) if (f.operation !== 'create') assert.match(f.sha, /^[0-9a-f]{40}$/, 'an update or delete names the file it replaces');
    assert.equal(text(/** @type {Buffer} */ (fj.files(REPO).get(`trips/${d.trip}/notes/bixby.md`))), 'Bixby Bridge, 1932, at dawn');
    assert.equal(fj.files(REPO).has(`trips/${d.trip}/notes/gone.md`), false);
    assert.ok(second.files < first.files && second.uploaded < first.uploaded);

    const blob = await type.get(ctx(fj), second.id, { onProgress: () => {} });
    const { ws, id } = await restored(blob);
    assert.equal(await ws.readText(id, '/notes/bixby.md'), 'Bixby Bridge, 1932, at dawn');
    assert.equal((await ws.history(id, '/notes/bixby.md')).length, 2);
    assert.deepEqual((await ws.read(id, '/files/gate.jpg'))?.bytes, (await d.ws.read(d.trip, '/files/gate.jpg'))?.bytes);
    // An older backup comes back as it was.
    const old = await restored(await type.get(ctx(fj), first.id, { onProgress: () => {} }));
    assert.equal(await old.ws.readText(old.id, '/notes/bixby.md'), 'Bixby Bridge, 1932');
  } finally {
    await fj.stop();
  }
});

test("a large repository's tree is read page by page, whether the last page says truncated (Forgejo) or not (Gitea)", async () => {
  for (const flavor of /** @type {const} */ (['forgejo', 'gitea'])) {
    const fj = await startForgejo({ repos: { [REPO]: {} }, perPage: 4, flavor });
    try {
      const { type } = forgejo();
      const d = await device();
      for (let i = 0; i < 9; i++) await d.ws.write(d.trip, `/notes/n${i}.md`, `Note ${i}`, { author: 'user' });
      const first = await type.put(ctx(fj), await archive(d), opts());
      await d.ws.write(d.trip, '/notes/n3.md', 'Note 3, changed', { author: 'user' });
      const second = await type.put(ctx(fj), await archive(d), opts({ base: first.id }));
      assert.deepEqual(fileOps(changes(fj)[1]), ['update /notes/n3.md', 'update annai-archive.json'], flavor);
      const trees = fj.log.filter((/** @type {any} */ l) => l.path.includes('/git/trees/'));
      assert.ok(trees.length >= 4, `${flavor}: ${trees.length} pages`);
      const { ws, id } = await restored(await type.get(ctx(fj), second.id, { onProgress: () => {} }));
      assert.equal(await ws.readText(id, '/notes/n8.md'), 'Note 8');
    } finally {
      await fj.stop();
    }
  }
});

test("a newer backup from another device is refused, never overwritten; this device's own isn't newer", async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { type } = forgejo();
    const a = await archive(await device());
    const android = { device: 'phone-b', label: 'Android phone' };
    const first = await type.put(ctx(fj), a, opts());
    await assert.rejects(type.put(ctx(fj, android), a, opts()), (/** @type {any} */ e) =>
      refused('newer')(e) && e.remote.id === first.id && e.remote.device === 'phone-a' && e.remote.label === 'iPhone');
    const over = await type.put(ctx(fj, android), a, opts({ base: first.id }));
    assert.deepEqual(fj.commits(REPO)[0].parents, [first.id]);
    await assert.rejects(type.put(ctx(fj), a, opts({ base: first.id })), (/** @type {any} */ e) => refused('newer')(e) && e.remote.id === over.id && e.remote.label === 'Android phone');
    const own = await type.put(ctx(fj, android), a, opts({ base: null }));
    assert.equal(fj.commits(REPO)[0].sha, own.id);
    // A commit made by hand (a README edited on the server) is no device's backup: it builds on it, and keeps it.
    const hand = fj.commitAs(REPO, { ...Object.fromEntries(fj.files(REPO)), 'README.md': '# My trips\n' }, 'Add README.md');
    await type.put(ctx(fj, android), a, opts({ base: own.id }));
    assert.deepEqual([fj.commits(REPO)[0].parents, fj.files(REPO).get('README.md')?.toString()], [[hand], '# My trips\n']);
  } finally {
    await fj.stop();
  }
});

test('two devices at the same moment: whichever way the branch moves meanwhile, nothing is overwritten, and the one that lost is offered the other backup', async () => {
  // before: the other backup lands first, so a file's id no longer matches (409, or 422 on Gitea); during: it lands
  // between this request's checks and its push, which is refused with 403, as both real servers do.
  for (const [flavor, when] of /** @type {const} */ ([['forgejo', 'before'], ['gitea', 'before'], ['forgejo', 'during'], ['gitea', 'during']])) {
    const fj = await startForgejo({ repos: { [REPO]: {} }, flavor });
    try {
      const { type } = forgejo();
      const d = await device();
      const first = await type.put(ctx(fj), await archive(d), opts());
      await d.ws.write(d.trip, '/notes/more.md', 'More', { author: 'user' });
      const theirs = () => fj.commitAs(REPO, { ...Object.fromEntries(fj.files(REPO)), 'annai-archive.json': '{"theirs":true}' }, 'annai backup from Android phone\n\nDevice: phone-b\nannai test\n');
      if (when === 'before') fj.beforeChange(theirs);
      else fj.duringChange(theirs);
      await assert.rejects(type.put(ctx(fj), await archive(d), opts({ base: first.id })), (/** @type {any} */ e) =>
        refused('newer', /at the same moment/)(e) && e.remote.device === 'phone-b' && e.remote.id === fj.commits(REPO)[0].sha, `${flavor} ${when}`);
      assert.equal(fj.commits(REPO)[0].message.split('\n')[0], 'annai backup from Android phone');
      assert.equal(fj.files(REPO).get('annai-archive.json')?.toString(), '{"theirs":true}');
    } finally {
      await fj.stop();
    }
  }
});

test('on Gitea, another device that deleted the same file first is a newer backup too, not a missing repository (its 404)', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, flavor: 'gitea' });
  try {
    const { type } = forgejo();
    const d = await device();
    await d.ws.write(d.trip, '/notes/gone.md', 'Soon gone', { author: 'user' });
    const first = await type.put(ctx(fj), await archive(d), opts());
    await d.ws.delete(d.trip, '/notes/gone.md', { author: 'user' });
    const path = `trips/${d.trip}/notes/gone.md`;
    fj.beforeChange(() => {
      const files = Object.fromEntries(fj.files(REPO));
      delete files[path];
      fj.commitAs(REPO, { ...files, 'annai-archive.json': '{"theirs":true}' }, 'annai backup from Android phone\n\nDevice: phone-b\nannai test\n');
    });
    await assert.rejects(type.put(ctx(fj), await archive(d), opts({ base: first.id })), (/** @type {any} */ e) =>
      refused('newer', /at the same moment/)(e) && e.remote.device === 'phone-b');
    assert.ok(fj.log.some((/** @type {any} */ l) => l.method === 'POST' && l.status === 404), 'Gitea answered 404');
  } finally {
    await fj.stop();
  }
});

test('a backup cut off after more than 250 parts: the newest whole backup is still found beyond them, and a part is never restored', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { type } = forgejo();
    const a = await archive(await device());
    const theirs = await type.put(ctx(fj, { device: 'phone-b', label: 'Android phone' }), a, opts());
    for (let i = 0; i < 260; i++) fj.commitAs(REPO, Object.fromEntries(fj.files(REPO)), 'Part of an annai backup from Android phone\n\nDevice: phone-b\nannai test\n');
    const part = fj.commits(REPO)[0].sha;
    // Listed: the whole one, beyond the parts.
    assert.deepEqual((await type.list(ctx(fj))).map((/** @type {any} */ b) => b.id), [theirs.id]);
    // A phone that never took it in is offered that one, not a part of the cut-off backup.
    await assert.rejects(type.put(ctx(fj, { device: 'phone-c' }), a, opts()), (/** @type {any} */ e) => refused('newer')(e) && e.remote.id === theirs.id && e.remote.label === 'Android phone');
    // A part, opened as if it were a backup, is refused in plain words.
    await assert.rejects(type.get(ctx(fj), part, { onProgress: () => {} }), refused('missing', /only part of a backup that was cut off/));
    // A phone that took it in builds on it.
    const mine = await type.put(ctx(fj), a, opts({ base: theirs.id }));
    assert.deepEqual(fj.commits(REPO)[0].parents, [part]);
    assert.equal((await type.list(ctx(fj)))[0].id, mine.id);
  } finally {
    await fj.stop();
  }
});

test('the wrong repository, token or address is refused in plain words, before anything is written', async () => {
  const fj = await startForgejo({ repos: {
    [REPO]: {}, 'me/code': { files: { 'src/index.js': 'x', 'package.json': '{}' } }, 'me/public': { private: false }, 'me/old': { archived: true },
    'me/readme': { files: { 'README.md': 'Mine', LICENSE: 'MIT', '.gitignore': 'x' } }, 'me/used': { files: { 'README.md': 'x' } },
  } });
  try {
    const { type } = forgejo();
    const a = await archive(await device());
    const host = new URL(fj.origin).host;
    await assert.rejects(type.check(ctx(fj, { repo: 'public' })), refused('refused', /me\/public on .* is public/));
    await assert.rejects(type.put(ctx(fj, { repo: 'public' }), a, opts()), refused('refused', /public/));
    await assert.rejects(type.check(ctx(fj, { repo: 'old' })), refused('refused', /archived/));
    await assert.rejects(type.put(ctx(fj, { repo: 'code' }), a, opts()), refused('refused', /holds other files \(package\.json, src\)/));
    await assert.rejects(type.check(ctx(fj, { token: 'f'.repeat(40) })), refused('auth', new RegExp(`${host} didn't accept the access token`)));
    await assert.rejects(type.check(ctx(fj, { repo: 'nothing' })), refused('missing', /Create a private repository named nothing/));
    await assert.rejects(type.put(ctx(fj, { token: READ_TOKEN }), a, opts()), refused('refused', /isn't allowed to change me\/annai-backup.*Read and write/));
    await assert.rejects(type.check(ctx(fj, { repo: 'used', branch: 'backups' })), refused('setup', /has no branch backups/));
    for (const [o, re] of /** @type {[any, RegExp][]} */ ([
      [{ owner: 'a b' }, /owner and the repository/], [{ repo: 'not a repo' }, /owner and the repository/], [{ token: '' }, /access token/],
      [{ server: 'http://example.com' }, /https/], [{ server: '' }, /https/], [{ branch: 'a b' }, /branch/],
    ])) await assert.rejects(type.check(ctx(fj, o)), refused('setup', re), JSON.stringify(o));
    // A README, a licence and a .gitignore stay as they are.
    await type.put(ctx(fj, { repo: 'readme' }), a, opts());
    const kept = fj.files('me/readme');
    assert.deepEqual([text(/** @type {Buffer} */ (kept.get('README.md'))), text(/** @type {Buffer} */ (kept.get('LICENSE'))), kept.has('.gitignore')], ['Mine', 'MIT', true]);
    assert.ok(fj.log.filter((/** @type {any} */ l) => l.method === 'POST').every((/** @type {any} */ l) => l.path === '/api/v1/repos/me/readme/contents' || l.status !== 201));
    // A pasted address with /api/v1, or "owner/name" in the repository, is understood.
    assert.match((await type.check(ctx(fj, { server: `${fj.origin}/api/v1/`, owner: '', repo: 'me/annai-backup' }))).note, /^Works/);
    // So is the repository's own address, pasted as the server's.
    assert.match((await type.check(ctx(fj, { server: `${fj.origin}/me/annai-backup`, owner: '', repo: '' }))).note, /^Works/);
    assert.match((await type.check(ctx(fj, { server: `${fj.origin}/me/annai-backup.git` }))).note, /^Works/);
    assert.equal(type.where({ server: `${fj.origin}/me/annai-backup/`, owner: '', repo: '' }), `${host}/me/annai-backup`);
  } finally {
    await fj.stop();
  }
});

// The user's ask (2026-10-18): an owner or a repository left empty is filled in. A token with only Repository: Read
// and write can't ask GET /user whose it is (both servers answer 403), so the repository search finds the private
// repositories it may change; with User: Read too, the token's own account comes first.

test('an owner and a repository left empty are found from the token: the one private repository it can change, never a public one', async () => {
  const fj = await startForgejo({ repos: {
    [REPO]: {}, 'me/site': { private: false }, 'me/old': { archived: true }, 'other/readonly': { push: false }, 'me/copy': { mirror: true },
  } });
  try {
    const { type, sent } = forgejo();
    const host = new URL(fj.origin).host;
    const found = await type.check(ctx(fj, { owner: '', repo: '' }));
    assert.deepEqual(found.config, { owner: 'me', repo: 'annai-backup' });
    assert.equal(found.note, `Works: annai can reach me/annai-backup on ${host}, a private repository. It is the only private repository this token can change, so annai filled it in.`);
    assert.equal(fj.count('GET', '/api/v1/user'), 1, 'it asks whose the token is, and is refused');
    assert.ok(sent.every((s) => new Headers(s.init.headers).get('authorization') === `token ${fj.token}`));
    // Only the owner left empty: the repository of that name the token can change.
    const owner = await type.check(ctx(fj, { owner: '', repo: 'annai-backup' }));
    assert.deepEqual([owner.config, owner.note], [{ owner: 'me', repo: 'annai-backup' }, `Works: annai can reach me/annai-backup on ${host}, a private repository. annai filled in its owner, me.`]);
    // Given values are kept: nothing is looked up.
    const before = fj.log.length;
    assert.equal((await type.check(ctx(fj))).config, undefined);
    assert.equal(fj.log.slice(before).some((/** @type {any} */ l) => l.path.endsWith('/search') || l.path.endsWith('/user')), false);
    // An owner given whose repositories the token can't change.
    await assert.rejects(type.check(ctx(fj, { owner: 'other', repo: '' })), refused('missing', new RegExp(`can't change any private repository of other on ${host}`)));
  } finally {
    await fj.stop();
  }
});

test("an empty repository with several private ones the token can change asks which, and with none says to create one; a public one is never offered", async () => {
  const fj = await startForgejo({ repos: {
    [REPO]: {}, 'me/notes': { files: { 'a.md': 'a' } }, 'team/backups': {}, 'me/site': { private: false }, 'other/readonly': { push: false },
  } });
  try {
    const { type } = forgejo();
    const host = new URL(fj.origin).host;
    const several = await type.check(ctx(fj, { owner: '', repo: '' })).then(() => null, (e) => e);
    assert.ok(several instanceof TargetError && several.kind === 'setup', String(several));
    assert.equal(several.message, `This token can change 3 private repositories on ${host}. Choose the one for annai's backups, or type its owner and name.`);
    assert.deepEqual(/** @type {any} */ (several).choices, [
      { label: 'me/annai-backup', config: { owner: 'me', repo: 'annai-backup' } },
      { label: 'me/notes', config: { owner: 'me', repo: 'notes' } },
      { label: 'team/backups', config: { owner: 'team', repo: 'backups' } },
    ]);
    // An owner given narrows it to theirs.
    assert.deepEqual((await type.check(ctx(fj, { owner: 'team', repo: '' }))).config, { owner: 'team', repo: 'backups' });
    // With User: Read, an empty owner is the token's own account: two of its repositories to choose from.
    const mine = await type.check(ctx(fj, { owner: '', repo: '', token: USER_TOKEN })).then(() => null, (e) => e);
    assert.deepEqual(mine?.choices?.map((/** @type {any} */ c) => c.label), ['me/annai-backup', 'me/notes']);
    // A repository named, under no owner the token can change: create it.
    await assert.rejects(type.check(ctx(fj, { owner: '', repo: 'trips' })), refused('missing',
      new RegExp(`^There is no private repository named trips on ${host} that this token can change\\. Create it there first \\(annai doesn't make one\\), or check the name\\.$`)));
    // A public repository is never offered, even when it is the only one.
    const lone = await startForgejo({ repos: { 'me/site': { private: false }, 'other/readonly': { push: false } } });
    try {
      await assert.rejects(type.check(ctx(lone, { owner: '', repo: '' })), refused('missing',
        new RegExp(`^This token can't change any private repository on ${new URL(lone.origin).host}\\. Create a private repository there first, named annai-backup for example \\(annai doesn't make one\\), then Save and test again\\.$`)));
    } finally {
      await lone.stop();
    }
    // A token the server doesn't know, asked before anything else.
    await assert.rejects(type.check(ctx(fj, { owner: '', repo: '', token: 'f'.repeat(40) })), refused('auth'));
  } finally {
    await fj.stop();
  }
});

test('the search is read page by page, and a repository found on a later page is still found', async () => {
  /** @type {Record<string, any>} */
  const repos = {};
  for (let i = 0; i < 120; i++) repos[`me/public-${String(i).padStart(3, '0')}`] = { private: false };
  for (let i = 0; i < 60; i++) repos[`me/a-readonly-${String(i).padStart(3, '0')}`] = { push: false };
  repos['me/z-backup'] = {};
  const fj = await startForgejo({ repos });
  try {
    const { type } = forgejo();
    assert.deepEqual((await type.check(ctx(fj, { owner: '', repo: '' }))).config, { owner: 'me', repo: 'z-backup' });
    assert.equal(fj.count('GET', '/repos/search'), 2, 'is_private leaves the public ones out; 61 private ones are two pages');
  } finally {
    await fj.stop();
  }
});

test("a server that doesn't let web apps use its API says so, and the place shows what to add to app.ini", async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, cors: false });
  try {
    const { type } = forgejo();
    const host = new URL(fj.origin).host;
    for (const step of [() => type.check(ctx(fj)), async () => type.put(ctx(fj), await archive(await device()), opts())]) {
      await assert.rejects(step(), refused('other', new RegExp(`couldn't reach ${host}.*Browser access`)));
    }
    const access = type.browserAccess(ORIGIN);
    assert.equal(access.code, `[cors]\nENABLED = true\nALLOW_DOMAIN = ${ORIGIN}`);
    assert.match(access.text, /app\.ini/);
  } finally {
    await fj.stop();
  }
});

test('a backup larger than one request goes as several commits; only the last is a backup, and a cut-off one carries on', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    // From the failFrom-th POST on, requests fail without an answer, as a broken connection does.
    let posts = 0;
    let failFrom = Infinity;
    const net = { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => (init?.method === 'POST' && ++posts >= failFrom ? Promise.reject(new TypeError('Failed to fetch')) : browserFetch(url, init)) };
    /** @type {any} */
    let type = null;
    activate({ helpers: { TargetError, readAnswer, zip: { ZipReader, ZipWriter } }, net, storage: { register: (/** @type {any} */ t) => { type = t; return () => {}; } } });
    const d = await device();
    for (let i = 0; i < 4; i++) await d.ws.write(d.trip, `/files/p${i}.jpg`, binary(4000), { author: 'user' });
    const a = await archive(d);
    const part = { bytes: 9000, files: 3 };
    const put = await type.put(ctx(fj), a, opts({ part }));
    const commits = fj.commits(REPO);
    assert.ok(commits.length >= 3, `${commits.length} commits`);
    assert.deepEqual([commits[0].sha, commits[0].message], [put.id, 'annai backup from iPhone\n\nDevice: phone-a\nannai test\n']);
    for (const c of commits.slice(1)) assert.equal(c.message, 'Part of an annai backup from iPhone\n\nDevice: phone-a\nannai test\n');
    const posted = changes(fj);
    assert.ok(posted.every((/** @type {any} */ b) => b.files.length <= 3));
    assert.deepEqual(posted.flatMap((/** @type {any} */ b) => b.files).filter((/** @type {any} */ f) => f.path === 'annai-archive.json').length, 1, 'the manifest goes once, in the last');
    assert.equal(posted.at(-1).files.at(-1).path, 'annai-archive.json');
    assert.deepEqual((await type.list(ctx(fj))).map((/** @type {any} */ b) => b.id), [put.id], 'the parts are no backups');
    assert.deepEqual([...fj.files(REPO).keys()].sort(), [...(await readZip(a.blob)).keys()].sort());
    // Cut off half way: the parts sent stay, the backups listed stay whole, and the next try sends only what is still missing.
    await d.ws.write(d.trip, '/files/p8.jpg', binary(4000), { author: 'user' });
    await d.ws.write(d.trip, '/files/p9.jpg', binary(4000), { author: 'user' });
    const b2 = await archive(d);
    const before = changes(fj).length;
    posts = 0;
    failFrom = 2;
    await assert.rejects(type.put(ctx(fj), b2, opts({ base: put.id, part: { bytes: 4100, files: 3 } })), (e) => e instanceof TargetError);
    assert.match(fj.commits(REPO)[0].message, /^Part of an annai backup/);
    assert.deepEqual((await type.list(ctx(fj))).map((/** @type {any} */ b) => b.id), [put.id]);
    const landed = new Set(changes(fj).slice(before).flatMap((/** @type {any} */ b) => b.files.map((/** @type {any} */ f) => f.path)));
    assert.ok(landed.size > 0);
    const after = changes(fj).length;
    failFrom = Infinity;
    const next = await type.put(ctx(fj), b2, opts({ base: put.id, part: { bytes: 4100, files: 3 } }));
    const again = changes(fj).slice(after).flatMap((/** @type {any} */ b) => b.files.map((/** @type {any} */ f) => f.path)).filter((/** @type {string} */ p) => landed.has(p));
    assert.deepEqual(again, [], 'nothing that landed in the cut-off try is sent again');
    const { ws, id } = await restored(await type.get(ctx(fj), next.id, { onProgress: () => {} }));
    assert.deepEqual((await ws.read(id, '/files/p9.jpg'))?.bytes, (await d.ws.read(d.trip, '/files/p9.jpg'))?.bytes);
  } finally {
    await fj.stop();
  }
});

test('a request too large for the server, or a proxy in front, goes again in halves; a file too large alone says what to raise', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, maxBody: 12_000 });
  try {
    const { type } = forgejo();
    const d = await device();
    await d.ws.write(d.trip, '/files/second.jpg', binary(3000), { author: 'user' });
    // Each photo fits alone; the backup goes in several commits, whole.
    const put = await type.put(ctx(fj), await archive(d), opts());
    assert.ok(fj.log.some((/** @type {any} */ l) => l.status === 413));
    assert.ok(fj.commits(REPO).length >= 2);
    assert.equal(fj.commits(REPO)[0].sha, put.id);
    // A photo too large for any request stops the backup with its name and size; what was there stays.
    await d.ws.write(d.trip, '/files/huge.jpg', binary(20_000), { author: 'user' });
    await assert.rejects(type.put(ctx(fj), await archive(d), opts({ base: put.id })), refused('refused', /didn't take \/files\/huge\.jpg \(20 KB\).*client_max_body_size/));
    assert.equal((await type.list(ctx(fj)))[0].id, put.id);
  } finally {
    await fj.stop();
  }
});

test('a full account (413 quota), an archived repository (423), a busy server (429) and broken answers, in plain words', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { type } = forgejo();
    const d = await device();
    const a = await archive(d);
    fj.setQuota(0);
    fj.commitAs(REPO, { 'README.md': 'x' }, 'Add README.md');
    await assert.rejects(type.put(ctx(fj), a, opts()), refused('refused', /out of space/));
    fj.setQuota(Infinity);
    fj.answerNext('POST', '/contents', { status: 423, json: { message: '<Repository 1:me/annai-backup> is archived' } });
    await assert.rejects(type.put(ctx(fj), a, opts()), refused('refused', /archived/));
    fj.answerNext('GET', `/repos/${REPO}`, { status: 429, headers: { 'retry-after': '120' }, json: { message: 'slow down' } });
    await assert.rejects(type.check(ctx(fj)), (/** @type {any} */ e) => refused('rate')(e) && e.retryAt > Date.now() + 100_000);
    /** @type {[string, string, string, number][]} */
    const cases = [['GET', `/repos/${REPO}`, '<html>Bad gateway</html>', 200], ['GET', `/repos/${REPO}`, 'null', 200], ['GET', '/branches/', '{"commit":5}', 200],
      ['GET', '/git/trees/', '{"tree":"x"}', 200], ['POST', '/contents', '{"commit":{}}', 201], ['POST', '/contents', '[]', 201]];
    for (const [method, part, body, status] of cases) {
      fj.answerNext(method, part, { status, raw: Buffer.from(body) });
      await assert.rejects(type.put(ctx(fj), a, opts()), (/** @type {any} */ e) => e instanceof TargetError && e.kind === 'other', `${method} ${part} ${body}`);
    }
    fj.answerNext('GET', '/commits', { status: 200, raw: Buffer.from('{"not":"a list"}') });
    await assert.rejects(type.list(ctx(fj)), refused('other', /can't read/));
    fj.answerNext('POST', '/contents', { status: 502, raw: Buffer.from('<html>Bad gateway</html>') });
    await assert.rejects(type.put(ctx(fj), a, opts()), refused('other', /had a problem \(HTTP 502\)/));
    const put = await type.put(ctx(fj), a, opts());
    fj.answerNext('GET', '/git/trees/', { status: 200, raw: Buffer.from('{"tree":[null,5,"x"],"total_count":3}') });
    await assert.rejects(type.get(ctx(fj), put.id, { onProgress: () => {} }), refused('missing', /isn't an annai backup/));
    fj.answerNext('GET', '/media/annai-archive.json', { status: 200, raw: Buffer.from('<html>Unicorn!</html>') });
    await assert.rejects(type.get(ctx(fj), put.id, { onProgress: () => {} }), refused('other', /damaged/));
    fj.answerNext('GET', '/media/annai-archive.json', { status: 200, raw: Buffer.from(`{"files":"${'x'.repeat(9 * 1024 * 1024)}"}`) });
    await assert.rejects(type.get(ctx(fj), put.id, { onProgress: () => {} }), refused('other', /larger than annai reads/));
    await assert.rejects(type.get(ctx(fj), 'not-a-commit', { onProgress: () => {} }), refused('missing'));
    assert.ok((await type.get(ctx(fj), put.id, { onProgress: () => {} })).size > 0, 'and the next answer is read as usual');
  } finally {
    await fj.stop();
  }
});

test("what git can't hold, or the place won't take, stops the backup with its name before anything is sent", async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { type } = forgejo();
    const d = await device();
    await assert.rejects(type.put(ctx(fj), await archive(d), opts({ maxFile: 1000 })), refused('refused', /\/files\/gate\.jpg is 3 KB/));
    await assert.rejects(type.put(ctx(fj), await archive(d), opts({ maxUpload: 10 })), (/** @type {any} */ e) => refused('large')(e) && e.bytes > 3000);
    await d.ws.write(d.trip, '/notes/.git/config', 'x', { author: 'user' });
    await assert.rejects(type.put(ctx(fj), await archive(d), opts()), refused('refused', /\.git.*Rename it in annai/));
    assert.equal(fj.count('POST', '/contents'), 0);
  } finally {
    await fj.stop();
  }
});

test('a file that becomes a folder: the file goes in a commit of its own first, since Forgejo checks against the branch', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { type } = forgejo();
    const d = await device();
    await d.ws.write(d.trip, '/notes/day1', 'A file for now', { author: 'user' });
    const first = await type.put(ctx(fj), await archive(d), opts());
    await d.ws.delete(d.trip, '/notes/day1', { author: 'user' });
    await d.ws.write(d.trip, '/notes/day1/morning.md', 'Now a folder', { author: 'user' });
    const second = await type.put(ctx(fj), await archive(d), opts({ base: first.id }));
    const [cleared, rest] = changes(fj).slice(1);
    assert.deepEqual(ops(cleared), ['delete /notes/day1']);
    assert.ok(ops(rest).includes('create /notes/day1/morning.md'));
    assert.equal(fj.commits(REPO)[0].sha, second.id);
    assert.equal(fj.files(REPO).get(`trips/${d.trip}/notes/day1/morning.md`)?.toString(), 'Now a folder');
  } finally {
    await fj.stop();
  }
});

test('a SHA-256 repository: files are compared by its own ids, so the photo still goes only once', async () => {
  const fj = await startForgejo({ repos: { [REPO]: { format: 'sha256' } } });
  try {
    const { type } = forgejo();
    const d = await device();
    const first = await type.put(ctx(fj), await archive(d), opts());
    await d.ws.write(d.trip, '/notes/bixby.md', 'Bixby Bridge, 1932, at dawn', { author: 'user' });
    const second = await type.put(ctx(fj), await archive(d), opts({ base: first.id }));
    assert.match(second.id, /^[0-9a-f]{64}$/);
    assert.deepEqual(fileOps(changes(fj)[1]), ['update /notes/bixby.md', 'update annai-archive.json']);
    const { ws, id } = await restored(await type.get(ctx(fj), second.id, { onProgress: () => {} }));
    assert.equal(await ws.readText(id, '/notes/bixby.md'), 'Bixby Bridge, 1932, at dawn');
  } finally {
    await fj.stop();
  }
});

/** annai with the Forgejo plugin installed and running, as on a phone; logged: what its registry logged. */
async function throughAnnai() {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => { logged.push(ev); } });
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const dir = new URL('../../plugins-official/storage-forgejo/', import.meta.url);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const name of await readdir(dir)) files.set(name, new Uint8Array(await readFile(new URL(name, dir))));
  const served = '/plugins/storage-forgejo/';
  const host = new PluginHost({ registry, workspace: ws, importModule: (url) => import(url.startsWith(served) ? new URL(url.slice(served.length), dir).href : url) });
  await host.install(files, { source: 'official' });
  await host.start('storage-forgejo');
  const backups = createBackups({ store, ws, registry, app: 'test', label: 'iPhone', noun: 'phone' });
  return { logged, registry, store, ws, backups };
}

test('Forgejo through annai: every request is in the trace, and the token is in nothing posted, traced or kept (spec §15)', async () => {
  const fj = await startForgejo({ repos: { [REPO]: {} } });
  try {
    const { logged, registry, store, ws, backups } = await throughAnnai();
    const trip = await createTrip(ws, { title: 'Big Sur' });
    await ws.write(trip, '/files/gate.jpg', new Uint8Array([0, 1, 2, 3]), { author: 'user' });
    const id = await backups.add('forgejo');
    await backups.update(id, { config: { server: fj.origin, owner: 'me', repo: 'annai-backup' }, secret: { token: fj.token } });
    assert.match((await backups.check(id)).note, /private repository/);
    await backups.backUp(id);
    await ws.write(trip, '/notes/x.md', 'x', { author: 'user' });
    await backups.backUp(id);
    assert.equal(fj.commits(REPO).length, 2);
    const traced = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
    assert.ok(traced.every((e) => e.data.tool === 'plugin:storage-forgejo'));
    assert.deepEqual(traced.map((e) => `${e.data.method} ${new URL(e.data.url).pathname} ${e.data.status}`), fj.log.map((l) => `${l.method} ${l.path} ${l.status}`));
    assert.equal((await everything(store)).includes(fj.token), false);
    for (const l of fj.log) assert.equal(l.body.includes(fj.token), false, `${l.method} ${l.path}`);
    for (const [path, bytes] of fj.files(REPO)) assert.equal(bytes.toString('latin1').includes(fj.token), false, path);
    // A broken answer is the server's: the plugin isn't blamed, and keeps running.
    fj.answerNext('GET', `/repos/${REPO}`, { status: 200, raw: Buffer.from('<html>Unicorn!</html>') });
    await assert.rejects(backups.check(id), (e) => e instanceof TargetError && e.kind === 'other' && /can't read/.test(e.message));
    assert.deepEqual(logged, []);
    assert.equal(registry.isDisabled('storage-forgejo'), false);
  } finally {
    await fj.stop();
  }
});

test("through annai, what Save and test filled in is kept as the place's settings, so backups don't look again; several to choose from come with the error", async () => {
  const fj = await startForgejo({ repos: { [REPO]: {}, 'me/site': { private: false } } });
  try {
    const { logged, ws, backups } = await throughAnnai();
    await createTrip(ws, { title: 'Big Sur' });
    const id = await backups.add('forgejo');
    await backups.update(id, { config: { server: fj.origin, owner: '', repo: '' }, secret: { token: fj.token } });
    assert.match((await backups.check(id)).note, /It is the only private repository this token can change, so annai filled it in\.$/);
    const kept = await backups.get(id);
    assert.deepEqual([kept.config.owner, kept.config.repo, kept.checked !== null], ['me', 'annai-backup', true]);
    const searched = fj.count('GET', '/repos/search');
    await backups.backUp(id);
    await backups.check(id);
    assert.equal(fj.count('GET', '/repos/search'), searched, 'no search once filled in');
    assert.equal(fj.commits(REPO).length, 1);
    // Several: the error carries them, each with the settings it fills in, and nothing is kept meanwhile.
    const more = await startForgejo({ repos: { [REPO]: {}, 'me/notes': {} } });
    try {
      const two = await backups.add('forgejo');
      await backups.update(two, { config: { server: more.origin, owner: '', repo: '' }, secret: { token: more.token } });
      const e = await backups.check(two).then(() => null, (x) => x);
      assert.ok(e instanceof TargetError && e.kind === 'setup');
      assert.deepEqual(/** @type {any} */ (e).choices, [{ label: 'me/annai-backup', config: { owner: 'me', repo: 'annai-backup' } }, { label: 'me/notes', config: { owner: 'me', repo: 'notes' } }]);
      assert.deepEqual([(await backups.get(two)).config.repo, (await backups.get(two)).checked], ['', null]);
    } finally {
      await more.stop();
    }
    assert.deepEqual(logged, [], 'nothing counted against the plugin');
  } finally {
    await fj.stop();
  }
});
