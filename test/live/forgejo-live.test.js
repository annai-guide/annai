import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/storage-forgejo/index.js';
import { TargetError, readAnswer } from '../../src/core/storage-types.js';
import { ZipReader, ZipWriter, readZip } from '../../src/core/zip.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { exportArchive, openArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { browserFetch } from '../fakes/browser-fetch.js';

// A real Forgejo or Gitea server. Opt-in, like the providers' live suite. Make a private repository
// for it first (it may hold earlier runs' backups, nothing else), and a token with Repository: Read and write:
//   ANNAI_FORGEJO_LIVE="https://git.example.com|owner|repository|token" npm run test:live
// With ANNAI_FORGEJO_ORIGIN set (https://annai.guide, say), every request goes as a browser on that
// page sends it, preflight and all, so the server's CORS settings are checked too. A throwaway server:
//   docker run -d --name annai-forgejo-live --memory 768m -p 127.0.0.1:13471:3000 -e FORGEJO__security__INSTALL_LOCK=true \
//     -e FORGEJO__cors__ENABLED=true -e FORGEJO__cors__ALLOW_DOMAIN=https://annai.guide -e FORGEJO__api__DEFAULT_GIT_TREES_PER_PAGE=7 \
//     codeberg.org/forgejo/forgejo:16.0.6-rootless
// then make a user, a token and a private repository (forgejo admin user create …; generate-access-token --scopes write:repository).
const LIVE = process.env.ANNAI_FORGEJO_LIVE;
const ORIGIN = process.env.ANNAI_FORGEJO_ORIGIN;

/** @param {number} n bytes that aren't text, made without getRandomValues' 64 KiB limit */
const binary = (n) => new Uint8Array(n).map((_, i) => (i === 0 ? 0 : (i * 7919 + n) % 251));

test('a real Forgejo or Gitea server: backups in parts and whole, only changes sent, a restore, another device at the same moment', { skip: !LIVE && 'set ANNAI_FORGEJO_LIVE to run', timeout: 300_000 }, async () => {
  const [server, owner, repo, token] = String(LIVE).split('|');
  const get = ORIGIN ? browserFetch(ORIGIN) : (/** @type {string} */ u, /** @type {RequestInit} */ init) => fetch(u, init);
  /** @type {{ method: string, url: string, body: string }[]} */
  const sent = [];
  /** @type {(() => Promise<void>) | null} */
  let beforePost = null;
  /** @type {any} */
  let type = null;
  activate({
    helpers: { TargetError, readAnswer, zip: { ZipReader, ZipWriter } },
    net: {
      fetch: async (/** @type {string} */ u, /** @type {RequestInit} */ init) => {
        if (init?.method === 'POST' && beforePost) {
          const run = beforePost;
          beforePost = null;
          await run();
        }
        sent.push({ method: init?.method ?? 'GET', url: u, body: typeof init?.body === 'string' ? init.body : '' });
        return get(u, init);
      },
    },
    storage: { register: (/** @type {any} */ t) => { type = t; } },
  });
  const me = `live${Date.now().toString(36)}`;
  const c = { config: { server, owner, repo, branch: '' }, secret: { token }, device: { id: me, label: 'computer' }, app: 'live' };
  const o = (/** @type {Record<string, any>} */ x = {}) => ({ base: null, maxUpload: Infinity, onProgress: () => {}, ...x });
  assert.match((await type.check(c)).note, /^Works: annai can reach .*, a private repository\.$/);
  await assert.rejects(type.check({ ...c, secret: { token: 'f'.repeat(40) } }), (e) => e instanceof TargetError && e.kind === 'auth');
  await assert.rejects(type.check({ ...c, config: { ...c.config, repo: `${repo}-not-there-${me}` } }), (e) => e instanceof TargetError && e.kind === 'missing' && /Create a private repository/.test(e.message));
  const earlier = (await type.list(c))[0]?.id ?? null;

  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Kyoto' });
  await ws.write(trip, '/notes/京都 day 1.md', '千本鳥居\n', { author: 'user' });
  await ws.write(trip, '/notes/day2', 'A file for now', { author: 'user' });
  for (let i = 0; i < 5; i++) await ws.write(trip, `/files/photo${i}.jpg`, binary(30_000 + i), { author: 'user' });
  const archive = async () => {
    const r = await exportArchive(store, { kind: 'everything', include: { ...PRESETS.backup }, app: 'live' });
    return { blob: r.blob, name: r.filename, manifest: r.manifest };
  };

  // In parts: several commits, and only the last is listed.
  const first = await type.put(c, await archive(), o({ base: earlier, part: { bytes: 70_000, files: 4 } }));
  const listed = await type.list(c);
  assert.equal(listed[0].id, first.id);
  assert.equal(listed[0].device, me);
  const posts = sent.filter((s) => s.method === 'POST');
  assert.ok(posts.length >= 3, `${posts.length} requests`);
  for (const s of sent) assert.equal(s.body.includes(token) || s.url.includes(token), false);

  // Only what changed; a file that becomes a folder.
  await ws.write(trip, '/notes/京都 day 1.md', '千本鳥居, at dawn\n', { author: 'user' });
  await ws.delete(trip, '/notes/day2', { author: 'user' });
  await ws.write(trip, '/notes/day2/morning.md', 'Now a folder', { author: 'user' });
  const from = sent.length;
  const second = await type.put(c, await archive(), o({ base: first.id }));
  const bodies = sent.slice(from).filter((s) => s.method === 'POST').map((s) => JSON.parse(s.body));
  const paths = bodies.flatMap((b) => b.files.map((/** @type {any} */ f) => f.path));
  assert.equal(paths.some((p) => /photo\d\.jpg$/.test(p)), false, 'no photo is sent again');
  assert.ok(paths.some((p) => p.endsWith('/notes/day2/morning.md')));

  // A restore, whole.
  const blob = await type.get(c, second.id, { onProgress: () => {} });
  const fresh = createMemoryStore();
  const ws2 = new Workspace(fresh, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws2);
  const { trips: [id] } = await importArchive(fresh, await openArchive(blob), { me: 'replace' });
  assert.equal(await ws2.readText(id, '/notes/京都 day 1.md'), '千本鳥居, at dawn\n');
  assert.equal(await ws2.readText(id, '/notes/day2/morning.md'), 'Now a folder');
  assert.deepEqual((await ws2.read(id, '/files/photo4.jpg'))?.bytes, binary(30_004));
  assert.equal((await readZip(blob)).size > 8, true);

  // Another device's backup lands just before this one's: refused, nothing overwritten.
  await ws.write(trip, '/notes/more.md', 'More', { author: 'user' });
  const api = `${server.replace(/\/+$/, '')}/api/v1/repos/${owner}/${repo}`;
  beforePost = async () => {
    const tree = await (await fetch(`${api}/git/trees/${second.id}?recursive=true&per_page=1000`, { headers: { authorization: `token ${token}` } })).json();
    const m = tree.tree.find((/** @type {any} */ e) => e.path === 'annai-archive.json');
    const res = await fetch(`${api}/contents`, {
      method: 'POST', headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: `annai backup from Android phone\n\nDevice: ${me}other\nannai live\n`, files: [{ operation: 'update', path: 'annai-archive.json', sha: m.sha, content: btoa('{"theirs":true}') }] }),
    });
    assert.equal(res.status, 201);
  };
  await assert.rejects(type.put(c, await archive(), o({ base: second.id })), (/** @type {any} */ e) => e instanceof TargetError && e.kind === 'newer' && e.remote.device === `${me}other`);
  // Its user backs up over it: the repository is whole again.
  const theirs = (await type.list(c))[0];
  assert.equal(theirs.device, `${me}other`);
  const over = await type.put(c, await archive(), o({ base: theirs.id }));
  assert.equal((await type.list(c))[0].id, over.id);
});
