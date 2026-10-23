import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startForgejo, TOKEN, READ_TOKEN, USER_TOKEN } from '../fakes/forgejo.js';

// The stand-in answers as Forgejo 16.0.6 did when probed (2026-10-18): the ids, messages and
// statuses below are the real server's.

const ORIGIN = 'https://annai.guide';

/** Requests to the stand-in as a browser would send them. @param {string} origin @param {string} [token] */
function api(origin, token = TOKEN) {
  return async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ body = undefined) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { authorization: `token ${token}`, origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    /** @type {any} */
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString('base64');
/** @param {string} origin @param {string} method @param {string} headers @param {string} [from] */
const preflight = (origin, method, headers, from = ORIGIN) => fetch(`${origin}/api/v1/repos/me/backup/contents`, {
  method: 'OPTIONS', headers: { origin: from, 'access-control-request-method': method, 'access-control-request-headers': headers },
});

test('the stand-in answers as Forgejo does: CORS, tokens, an empty repository, and the first commit', async () => {
  const fj = await startForgejo({ repos: { 'me/backup': {} }, cors: ORIGIN });
  try {
    const ok = await preflight(fj.origin, 'POST', 'authorization,content-type');
    assert.deepEqual([ok.status, ok.headers.get('access-control-allow-origin'), ok.headers.get('access-control-allow-headers')], [200, ORIGIN, 'authorization, content-type']);
    // A header the server doesn't allow, or another origin: an answer without CORS headers, which a browser refuses.
    for (const r of [await preflight(fj.origin, 'POST', 'authorization,x-custom'), await preflight(fj.origin, 'GET', 'authorization', 'https://evil.example')]) {
      assert.deepEqual([r.status, r.headers.get('access-control-allow-origin')], [200, null]);
    }
    const call = api(fj.origin);
    const bad = await api(fj.origin, 'f'.repeat(40))('GET', '/repos/me/backup');
    assert.equal(bad.status, 401);
    assert.match(bad.json.message, /access token does not exist/);
    assert.equal(bad.headers.get('access-control-allow-origin'), ORIGIN, 'errors carry CORS headers too');
    const missing = await call('GET', '/repos/me/nothing');
    assert.deepEqual([missing.status, missing.json.message], [404, "The target couldn't be found."]);
    const repo = await call('GET', '/repos/me/backup');
    assert.deepEqual([repo.json.full_name, repo.json.private, repo.json.empty, repo.json.default_branch, repo.json.object_format_name, repo.json.permissions.push],
      ['me/backup', true, true, 'main', 'sha1', true]);
    const branch = await call('GET', '/repos/me/backup/branches/main');
    assert.deepEqual([branch.status, branch.json.errors], [404, ['branch does not exist [name: main]']]);
    const commits = await call('GET', '/repos/me/backup/commits?sha=main&limit=50');
    assert.deepEqual([commits.status, commits.json.message], [409, 'Git Repository is empty.']);
    const first = await call('POST', '/repos/me/backup/contents', { branch: 'main', message: 'annai backup from iPhone\n\nDevice: phone-a\nannai test\n', files: [
      { operation: 'create', path: 'annai-archive.json', content: b64('{"v":1}') },
      { operation: 'create', path: 'trips/t1/notes/a.md', content: b64('hello\n') },
      { operation: 'create', path: 'trips/t1/notes/b.md', content: b64('b\n') },
      { operation: 'create', path: 'trips/t1/files/x', content: b64('x') },
    ] });
    assert.equal(first.status, 201);
    assert.equal(first.json.commit.tree.sha, '95f6b5b4c56b63023023db230f892f5f75398af4', "the tree Forgejo made of these files");
    assert.deepEqual(first.json.files.map((/** @type {any} */ f) => [f.path, f.sha, f.content]), [
      ['annai-archive.json', '5f8b795830acbab5961c1a28c76a7916c9631493', b64('{"v":1}')], ['trips/t1/notes/a.md', 'ce013625030ba8dba906f756967f9e9ca394464a', b64('hello\n')],
      ['trips/t1/notes/b.md', '61780798228d17af2d34fce4cfbdf35556832472', b64('b\n')], ['trips/t1/files/x', 'c1b0730e0133447badcfd47fd144e254807b06e1', b64('x')]]);
    assert.deepEqual([first.json.commit.message, first.json.commit.parents], ['annai backup from iPhone\n\nDevice: phone-a\nannai test\n', []]);
    assert.equal((await call('GET', '/repos/me/backup')).json.empty, false);
    const head = (await call('GET', '/repos/me/backup/branches/main')).json.commit;
    assert.deepEqual([head.id, head.message], [first.json.commit.sha, first.json.commit.message]);
    const read = await api(fj.origin, READ_TOKEN)('POST', '/repos/me/backup/contents', { files: [{ operation: 'create', path: 'q', content: 'eA==' }] });
    assert.deepEqual([read.status, read.json.message], [403, 'token does not have at least one of required scope(s): [write:repository]']);
  } finally {
    await fj.stop();
  }
});

test("the stand-in's trees page as Forgejo's do (every page says truncated), or as Gitea's", async () => {
  const files = { 'annai-archive.json': '{"v":1}', 'trips/t1/notes/a.md': 'hello\n', 'trips/t1/notes/b.md': 'b\n', 'trips/t1/files/x': 'x' };
  for (const flavor of /** @type {const} */ (['forgejo', 'gitea'])) {
    const fj = await startForgejo({ repos: { 'me/backup': { files } }, flavor });
    try {
      const call = api(fj.origin);
      const head = (await call('GET', '/repos/me/backup/branches/main')).json.commit.id;
      const pages = await Promise.all([1, 2, 3, 4].map((p) => call('GET', `/repos/me/backup/git/trees/${head}?recursive=true&per_page=3&page=${p}`)));
      assert.deepEqual(pages.map((p) => p.json.tree?.map((/** @type {any} */ e) => e.path) ?? null), [
        ['annai-archive.json', 'trips', 'trips/t1'], ['trips/t1/files', 'trips/t1/files/x', 'trips/t1/notes'], ['trips/t1/notes/a.md', 'trips/t1/notes/b.md'], null]);
      assert.deepEqual(pages.map((p) => [p.json.page, p.json.total_count, p.json.truncated]),
        flavor === 'forgejo' ? [[1, 8, true], [2, 8, true], [3, 8, true], [4, 8, false]] : [[1, 8, true], [2, 8, true], [3, 8, false], [4, 8, false]]);
      assert.equal(pages[0].json.tree[0].sha, '5f8b795830acbab5961c1a28c76a7916c9631493');
      assert.deepEqual([pages[0].json.tree[1].type, pages[0].json.tree[1].mode], ['tree', '040000']);
      const bad = await call('GET', `/repos/me/backup/git/trees/${'0'.repeat(40)}?recursive=true`);
      assert.deepEqual([bad.status, bad.json.message], [400, `sha not found [${'0'.repeat(40)}]`]);
    } finally {
      await fj.stop();
    }
  }
});

test('the stand-in refuses what Forgejo refuses, guards files by their ids, and plays another device, a quota and a proxy', async () => {
  const fj = await startForgejo({ repos: { 'me/backup': { files: { 'a.md': 'hello\n', 'files/x': 'x' } }, 'me/old': { archived: true }, 'me/gitea': { files: { 'a.md': 'x' } } }, maxBody: 4096 });
  try {
    const call = api(fj.origin);
    /** @param {any[]} files @param {string} [repo] */
    const change = (files, repo = 'me/backup') => call('POST', `/repos/${repo}/contents`, { branch: 'main', message: 'm', files });
    /** A file's id at the branch's head. @param {string} path @returns {Promise<string>} */
    const shaOf = async (path) => (await call('GET', `/repos/me/backup/git/trees/${fj.commits('me/backup')[0].sha}?recursive=true`)).json.tree.find((/** @type {any} */ e) => e.path === path).sha;
    const stale = await change([{ operation: 'update', path: 'a.md', sha: '1'.repeat(40), content: b64('new') }]);
    assert.deepEqual([stale.status, stale.json.message], [409, `sha does not match [given: ${'1'.repeat(40)}, expected: ce013625030ba8dba906f756967f9e9ca394464a]`]);
    assert.equal((await change([{ operation: 'update', path: 'a.md', content: b64('new') }])).status, 422);
    assert.match((await change([{ operation: 'create', path: 'a.md', content: b64('new') }])).json.message, /repository file already exists \[path: a\.md\]/);
    assert.equal((await change([{ operation: 'delete', path: 'nope.md', sha: '1'.repeat(40) }])).status, 500);
    const under = await change([{ operation: 'delete', path: 'files/x', sha: await shaOf('files/x') }, { operation: 'create', path: 'files/x/y', content: b64('y') }]);
    assert.deepEqual([under.status, under.json.message], [422, 'a file exists where you’re trying to create a subdirectory [path: files/x]']);
    assert.match((await change([{ operation: 'create', path: 'files', content: b64('y') }])).json.message, /a directory exists/);
    assert.match((await change([{ operation: 'create', path: 'a/.git/config', content: b64('y') }])).json.message, /malformed path component/);
    assert.deepEqual((await call('POST', '/repos/me/backup/contents', { branch: 'nope', files: [{ operation: 'create', path: 'q', content: 'eA==' }] })).json.message, 'branch does not exist [name: nope]');
    assert.deepEqual([(await change([{ operation: 'create', path: 'q', content: 'eA==' }], 'me/old')).status], [423]);
    // Gitea answers a stale id with 422 and a file that isn't there with 404, and takes an update without an id.
    const gitea = await startForgejo({ repos: { 'me/backup': { files: { 'a.md': 'x' } } }, flavor: 'gitea' });
    try {
      const g = api(gitea.origin);
      assert.equal((await g('POST', '/repos/me/backup/contents', { files: [{ operation: 'update', path: 'a.md', sha: '1'.repeat(40), content: 'eA==' }] })).status, 422);
      const missing = await g('POST', '/repos/me/backup/contents', { files: [{ operation: 'delete', path: 'gone.md', sha: '1'.repeat(40) }] });
      assert.deepEqual([missing.status, missing.json.message], [404, 'object does not exist [id: , rel_path: gone.md]']);
      assert.equal((await g('POST', '/repos/me/backup/contents', { files: [{ operation: 'update', path: 'a.md', content: 'eQ==' }] })).status, 201);
      const before = gitea.commits('me/backup')[0].sha;
      gitea.duringChange(() => gitea.commitAs('me/backup', { 'a.md': 'theirs' }, 'x'));
      const lost = await g('POST', '/repos/me/backup/contents', { files: [{ operation: 'create', path: 'b.md', content: 'eA==' }] });
      assert.deepEqual([lost.status, lost.json.message], [403, `cannot lock ref 'refs/heads/main': is at ${gitea.commits('me/backup')[0].sha} but expected ${before}`]);
    } finally {
      await gitea.stop();
    }
    // Another device's commit lands as this one starts: the file's id no longer matches.
    const id = await shaOf('a.md');
    fj.beforeChange(() => fj.commitAs('me/backup', { 'a.md': 'theirs' }, 'annai backup from Android phone\n\nDevice: phone-b\n'));
    assert.equal((await change([{ operation: 'update', path: 'a.md', sha: id, content: b64('mine') }])).status, 409);
    // Or between its checks and its push: the push is refused, with 403, as Forgejo 16.0.6 refused one of two at the same moment.
    const now = await shaOf('a.md');
    fj.duringChange(() => fj.commitAs('me/backup', { 'a.md': 'theirs again' }, 'x'));
    const pushed = await change([{ operation: 'update', path: 'a.md', sha: now, content: b64('mine') }]);
    assert.equal(pushed.status, 403);
    assert.match(pushed.json.message, /^PushRejected Error: .*! \[remote rejected\] [0-9a-f]{40} -> main \(incorrect old value provided\)/s);
    assert.equal(fj.files('me/backup').get('a.md')?.toString(), 'theirs again');
    // Over its quota, Forgejo refuses more; a proxy in front refuses a large request without CORS headers.
    fj.setQuota(1);
    const full = await change([{ operation: 'create', path: 'q', content: 'eA==' }]);
    assert.deepEqual([full.status, full.json.message, full.headers.get('access-control-allow-origin')], [413, 'quota exceeded', ORIGIN]);
    fj.setQuota(Infinity);
    const large = await change([{ operation: 'create', path: 'big', content: b64('x'.repeat(5000)) }]);
    assert.deepEqual([large.status, large.headers.get('access-control-allow-origin')], [413, null]);
    // Files come back raw at a commit, by path, whatever their letters; SHA-256 repositories use SHA-256 ids.
    assert.equal((await change([{ operation: 'create', path: 'trips/t1/notes/京都 x.md', content: b64('千本鳥居\n') }])).status, 201);
    const head = fj.commits('me/backup')[0].sha;
    const raw = await fetch(`${fj.origin}/api/v1/repos/me/backup/media/${['trips', 't1', 'notes', '京都 x.md'].map(encodeURIComponent).join('/')}?ref=${head}`, { headers: { authorization: `token ${TOKEN}` } });
    assert.deepEqual([raw.status, await raw.text()], [200, '千本鳥居\n']);
    assert.equal((await fetch(`${fj.origin}/api/v1/repos/me/backup/raw/nope?ref=${head}`, { headers: { authorization: `token ${TOKEN}` } })).status, 404);
  } finally {
    await fj.stop();
  }
  const sha256 = await startForgejo({ repos: { 'me/s': { format: 'sha256' } } });
  try {
    const r = await api(sha256.origin)('POST', '/repos/me/s/contents', { files: [{ operation: 'create', path: 'a.txt', content: b64('hello\n') }] });
    assert.equal(r.json.files[0].sha, '2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4', "Forgejo's SHA-256 id for this file");
  } finally {
    await sha256.stop();
  }
});

test("the stand-in's ChangeFiles leaves out files over 10 MiB as each server does, and an empty repository's first branch becomes its default", async () => {
  for (const [flavor, none] of /** @type {const} */ ([['forgejo', ''], ['gitea', null]])) {
    const fj = await startForgejo({ repos: { 'me/backup': {} }, flavor });
    try {
      const r = await api(fj.origin)('POST', '/repos/me/backup/contents', { branch: 'backups', files: [
        { operation: 'create', path: 'big', content: Buffer.alloc(11 * 1024 * 1024, 7).toString('base64') }, { operation: 'create', path: 'small', content: 'eA==' }] });
      assert.deepEqual(r.json.files.map((/** @type {any} */ f) => f.content), [none, 'eA=='], flavor);
      assert.equal((await api(fj.origin)('GET', '/repos/me/backup')).json.default_branch, 'backups', flavor);
    } finally {
      await fj.stop();
    }
  }
});

test('without [cors] ENABLED, a preflight gets 405 and no answer carries CORS headers', async () => {
  const fj = await startForgejo({ repos: { 'me/backup': {} }, cors: false });
  try {
    const pre = await preflight(fj.origin, 'GET', 'authorization');
    assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [405, null]);
    const get = await api(fj.origin)('GET', '/repos/me/backup');
    assert.deepEqual([get.status, get.headers.get('access-control-allow-origin')], [200, null]);
  } finally {
    await fj.stop();
  }
});

test("the stand-in's account and search, as both servers answered (2026-10-18): GET /user needs User: Read; the search lists what the user may see", async () => {
  const fj = await startForgejo({ repos: {
    'me/backup': {}, 'me/notes': { files: { 'a.md': 'a' } }, 'me/site': { private: false }, 'me/old': { archived: true },
    'other/readonly': { push: false }, 'team/shared': {}, 'me/copy': { mirror: true },
  } });
  try {
    // A token with only Repository: Read and write can't ask whose it is.
    const denied = await api(fj.origin)('GET', '/user');
    assert.deepEqual([denied.status, denied.json.message], [403, 'token does not have at least one of required scope(s): [read:user]']);
    const me = await api(fj.origin, USER_TOKEN)('GET', '/user');
    assert.deepEqual([me.status, me.json.login], [200, 'me']);
    assert.equal((await api(fj.origin, 'f'.repeat(40))('GET', '/user')).status, 401);
    // The search: the user's own and shared repositories, public and private; is_private and archived filter them.
    const all = await api(fj.origin)('GET', '/repos/search?limit=50');
    assert.equal(all.json.ok, true);
    assert.equal(all.headers.get('x-total-count'), '7');
    const found = await api(fj.origin)('GET', '/repos/search?is_private=true&archived=false&limit=50');
    assert.deepEqual(found.json.data.map((/** @type {any} */ r) => `${r.full_name} ${r.private} ${r.archived} ${r.mirror} ${r.permissions.push} ${r.owner.login}`), [
      'me/backup true false false true me', 'me/copy true false true true me', 'me/notes true false false true me',
      'other/readonly true false false false other', 'team/shared true false false true team',
    ]);
    // Push is the user's permission, not the token's: a read-only token sees the same.
    assert.deepEqual((await api(fj.origin, READ_TOKEN)('GET', '/repos/search?is_private=true&archived=false')).json.data.map((/** @type {any} */ r) => r.permissions.push), [true, true, true, false, true]);
    const named = await api(fj.origin)('GET', '/repos/search?is_private=true&archived=false&q=NOTES');
    assert.deepEqual(named.json.data.map((/** @type {any} */ r) => r.full_name), ['me/notes']);
    const paged = await api(fj.origin)('GET', '/repos/search?is_private=true&limit=2&page=3');
    assert.deepEqual([paged.headers.get('x-total-count'), paged.json.data.map((/** @type {any} */ r) => r.full_name)], ['6', ['other/readonly', 'team/shared']]);
    assert.equal((await api(fj.origin, 'f'.repeat(40))('GET', '/repos/search')).status, 401);
  } finally {
    await fj.stop();
  }
});

test("answerNext given a function: it changes the stand-in's own answer to that very request; a function that throws is answered with a 500, not left hanging", async () => {
  const fj = await startForgejo({ repos: { 'me/backup': { files: { 'annai-archive.json': '{"a":1}' } } }, cors: ORIGIN });
  try {
    const call = api(fj.origin);
    fj.answerNext('GET', '/media/annai-archive.json', (own) => ({ status: 200, raw: Buffer.from(`${String(own.raw)}!`) }));
    assert.deepEqual([(await call('GET', '/repos/me/backup/media/annai-archive.json')).status, (await call('GET', '/repos/me/backup/media/annai-archive.json')).text], [200, '{"a":1}'], 'taken once: the second request is the stand-in\'s own');
    fj.answerNext('GET', '/media/annai-archive.json', () => { throw new Error('the test\'s own mistake'); });
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let giveUp;
    const broken = await Promise.race([call('GET', '/repos/me/backup/media/annai-archive.json'), new Promise((r) => { giveUp = setTimeout(r, 5000, 'hung'); })]).finally(() => clearTimeout(giveUp));
    assert.notEqual(broken, 'hung', 'the request was answered');
    assert.equal(/** @type {any} */ (broken).status, 500);
    assert.match(/** @type {any} */ (broken).text, /the test's own mistake/);
  } finally {
    await fj.stop();
  }
});
