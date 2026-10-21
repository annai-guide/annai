import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/storage-github/index.js';
import { blobId, treeId, nest, GitPathError } from '../../plugins-official/storage-github/git.js';
import { TargetError, readAnswer } from '../../src/core/storage-types.js';
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
    helpers: { TargetError, readAnswer, zip: { ZipReader, ZipWriter } },
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
    // Save and test says what Back up now will (the second emulator re-check).
    await assert.rejects(type.check(ctx(gh, { repo: 'me/code' })), refused('refused', /holds other files \(package\.json, src\)/));
    assert.match((await type.check(ctx(gh, { repo: 'me/readme' }))).note, /^Works/);
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

test("a broken or hostile answer from GitHub is GitHub's answer, never a crash in the plugin (spec §5.5)", async () => {
  const gh = await startGitHub({ repos: { [REPO]: { files: { 'README.md': 'x' } } } });
  try {
    const { type } = github();
    const a = await archive(await device());
    /** @type {[string, string, string][]} method, a part of the path, the answer */
    const cases = [
      ['GET', `/repos/${REPO}`, '<html>Unicorn!</html>'],
      ['GET', `/repos/${REPO}`, 'null'],
      ['GET', '/git/ref/heads/main', '{}'],
      ['GET', '/git/ref/heads/main', '{"object":5}'],
      ['GET', '/git/commits/', '{"tree":5}'],
      ['GET', '/git/trees/', '{"tree":"x","truncated":false}'],
      ['POST', '/git/trees', '[]'],
      ['POST', '/git/commits', '{}'],
    ];
    for (const [method, part, body] of cases) {
      gh.garbleNext({ method, part, body });
      await assert.rejects(type.put(ctx(gh), a, opts()), (/** @type {any} */ e) => e instanceof TargetError && e.kind === 'other', `${method} ${part} ${body}`);
    }
    gh.garbleNext({ method: 'GET', part: '/commits', body: '{"not":"a list"}' });
    await assert.rejects(type.list(ctx(gh)), refused('other', /can't read/));
    const put = await type.put(ctx(gh), a, opts());
    gh.garbleNext({ method: 'GET', part: '/git/trees/', body: '{"tree":[null,5,"x"]}' });
    await assert.rejects(type.get(ctx(gh), put.id, { onProgress: () => {} }), refused('missing', /isn't an annai backup/));
    gh.garbleNext({ method: 'GET', part: '/git/blobs/', body: '<html>Unicorn!</html>' });
    await assert.rejects(type.get(ctx(gh), put.id, { onProgress: () => {} }), refused('other', /damaged/));
    assert.ok((await type.get(ctx(gh), put.id, { onProgress: () => {} })).size > 0, 'and the next answer is read as usual');
  } finally {
    await gh.stop();
  }
});

test("a GitHub API address that is no web address is a setup problem in plain words, never a bug in the plugin", async () => {
  const { type } = github();
  for (const api of ['https://api .github.com', 'https://api.github.com (enterprise)', 'https://', 'https://ex\u0000ample.com', 'https://[::1']) {
    const c = ctx({ origin: api, token: 'ghp_x' });
    for (const step of [() => type.check(c), () => type.list(c), () => type.get(c, '0'.repeat(40), { onProgress: () => {} })]) {
      await assert.rejects(step(), refused('setup', /address/), api);
    }
  }
});

test('what GitHub sends is read only up to a limit: an error, a manifest, a file (a hostile repository mustn\'t freeze the page)', { timeout: 20_000 }, async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const put = await type.put(ctx(gh), await archive(await device()), opts());
    // An error body far larger than any GitHub sends, which says "rate limit" only at its end: not read that far.
    gh.garbleNext({ method: 'GET', part: `/repos/${REPO}`, status: 403, body: `{"message":"${'x'.repeat(100_000)} rate limit"}` });
    const started = Date.now();
    await assert.rejects(type.check(ctx(gh)), refused('refused'));
    assert.ok(Date.now() - started < 5000, 'no minute-long wait for a "rate limit" past the limit');
    // A manifest larger than annai reads.
    gh.garbleNext({ method: 'GET', part: '/git/blobs/', body: `{"files":"${'x'.repeat(9 * 1024 * 1024)}"}` });
    await assert.rejects(type.get(ctx(gh), put.id, { onProgress: () => {} }), refused('other', /larger than annai reads/));
  } finally {
    await gh.stop();
  }
});

test("minors 24: a commit made by hand is no other device's backup: what counts is the newest backup before it", async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const a = await archive(await device());
    const first = await type.put(ctx(gh), a, opts());
    /** Someone edits the README on github.com: the backup's files stay, one commit on top. @param {string} readme */
    const byHand = (readme) => gh.commitAs(REPO, { ...Object.fromEntries(gh.files(REPO)), 'README.md': readme }, 'Update README.md');
    const hand = byHand('# My trips\n');
    const next = await type.put(ctx(gh), a, opts({ base: first.id }));
    assert.deepEqual(gh.commits(REPO)[0].parents, [hand], 'it builds on the hand-made commit');
    assert.equal(gh.files(REPO).get('README.md')?.toString(), '# My trips\n', 'which it keeps');
    // Another device's backup, then a hand-made commit: the other device's backup is the newer one.
    const android = { device: 'phone-b', label: 'Android phone' };
    const theirs = await type.put(ctx(gh, android), a, opts({ base: next.id }));
    byHand('# Ours\n');
    await assert.rejects(type.put(ctx(gh), a, opts({ base: next.id })), (/** @type {any} */ e) => refused('newer')(e) && e.remote.id === theirs.id && e.remote.label === 'Android phone');
  } finally {
    await gh.stop();
  }
});

// Review R14: opening a backup of 650 files took 2.5 minutes, one file at a time.
test('opening a backup reads its files six at a time, and the archive keeps the order the manifest gives', async () => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    const { type } = github();
    const d = await device();
    for (let i = 0; i < 30; i++) await d.ws.write(d.trip, `/notes/n${i}.md`, `Note ${i}`, { author: 'user' });
    const made = await archive(d);
    const put = await type.put(ctx(gh), made, opts());
    let open = 0;
    let most = 0;
    const slow = github({ activate: (/** @type {any} */ annai) => activate({ ...annai, net: { fetch: async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      if (!url.includes('/git/blobs/')) return annai.net.fetch(url, init);
      most = Math.max(most, ++open);
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await annai.net.fetch(url, init);
      } finally {
        open--;
      }
    } } }) });
    const blob = await slow.type.get(ctx(gh), put.id, { onProgress: () => {} });
    assert.equal(most, 6);
    const names = [...made.manifest.files, ...made.manifest.blobs, ...made.manifest.extras].map((x) => x.name).filter((n) => n !== 'annai-archive.json');
    assert.deepEqual((await ZipReader.open(blob)).names().filter((n) => n !== 'annai-archive.json'), [...new Set(names)]);
    await openArchive(blob);
  } finally {
    await gh.stop();
  }
});
