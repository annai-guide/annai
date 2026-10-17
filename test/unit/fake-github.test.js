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
