import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Starts scripts/serve.mjs on a free port, serving the folder above the script it runs. @param {string} script */
async function start(script) {
  const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      const m = /127\.0\.0\.1:(\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', () => reject(new Error('the dev server exited')));
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/**
 * A raw request, so nothing decodes the body or adds an Accept-Encoding of its own.
 * @param {string} url @param {{ method?: string, headers?: Record<string, string> }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer }>}
 */
const get = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  http.request(url, { method, headers }, (res) => {
    /** @type {Buffer[]} */
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject).end();
});

test('the dev server answers a malformed URL with 400 and keeps running', async () => {
  const server = await start(fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url)));
  try {
    assert.equal((await fetch(`${server.origin}/%E0`)).status, 400);
    assert.equal((await fetch(`${server.origin}/_headers`)).status, 200);
  } finally {
    server.stop();
  }
});

test('a release sends x.br when the browser takes brotli, and the file itself otherwise', async (t) => {
  // A release folder: serve.mjs and what it needs, a script with its .br beside it, a style sheet without one (a stray .gz is never sent).
  const dir = await mkdtemp(join(tmpdir(), 'annai-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  for (const f of ['scripts/serve.mjs', 'scripts/headers.mjs', '_headers']) await copyFile(fileURLToPath(new URL(`../../${f}`, import.meta.url)), join(dir, f));
  const js = Buffer.from(`// a shipped script\n${'export const words = "Low tide is at 5:40.";\n'.repeat(40)}`);
  await writeFile(join(dir, 'app.js'), js);
  await writeFile(join(dir, 'app.js.br'), brotliCompressSync(js));
  await writeFile(join(dir, 'no-br.css'), js);
  await writeFile(join(dir, 'no-br.css.gz'), 'not sent');
  await writeFile(join(dir, 'plain.json'), '{"a":1}');
  // A file edited after its .br was written (build-release run on a checkout): the .br is stale. A release's
  // files and their .br share one time (git archive stamps the commit's), and that is not stale.
  const when = new Date('2026-10-23T12:00:00Z');
  await writeFile(join(dir, 'edited.js'), js);
  await writeFile(join(dir, 'edited.js.br'), brotliCompressSync(Buffer.from('the old code')));
  await utimes(join(dir, 'edited.js.br'), when, when);
  await utimes(join(dir, 'edited.js'), new Date(when.getTime() + 1000), new Date(when.getTime() + 1000));
  await utimes(join(dir, 'app.js'), when, when);
  await utimes(join(dir, 'app.js.br'), when, when);
  const server = await start(join(dir, 'scripts/serve.mjs'));
  t.after(() => server.stop());
  const url = `${server.origin}/app.js`;

  const br = await get(url, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.ok(br.body.length < js.length);
  // The _headers rules apply to the compressed form too.
  assert.equal(br.headers['x-content-type-options'], 'nosniff');
  // What the browser decodes is the file's own bytes.
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), js);

  assert.equal((await get(url, { headers: { 'Accept-Encoding': 'BR;q=0.5' } })).headers['content-encoding'], 'br');
  assert.equal((await get(url, { headers: { 'Accept-Encoding': '*' } })).headers['content-encoding'], 'br');
  for (const accept of [undefined, 'identity', 'gzip, deflate', 'br;q=0, gzip', '*, br;q=0']) {
    const plain = await get(url, { headers: accept === undefined ? {} : { 'Accept-Encoding': accept } });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined, `Accept-Encoding: ${accept}`);
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    assert.deepEqual(plain.body, js);
    assert.equal(Number(plain.headers['content-length']), js.length);
  }

  // No .br beside it: the file itself.
  const noBr = await get(`${server.origin}/no-br.css`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(noBr.status, 200);
  assert.equal(noBr.headers['content-encoding'], undefined);
  assert.equal(noBr.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(noBr.headers.vary, undefined);
  assert.deepEqual(noBr.body, js);
  // A stale .br: the file itself, as if there were none.
  const edited = await get(`${server.origin}/edited.js`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(edited.headers['content-encoding'], undefined);
  assert.equal(edited.headers.vary, undefined);
  assert.deepEqual(edited.body, js);
  const none = await get(`${server.origin}/plain.json`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(none.headers['content-encoding'], undefined);
  assert.equal(none.headers.vary, undefined);
  assert.equal(none.body.toString(), '{"a":1}');

  // HEAD: the same headers, no body.
  const head = await get(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-encoding'], 'br');
  assert.equal(Number(head.headers['content-length']), br.body.length);
  assert.equal(head.body.length, 0);
  const headPlain = await get(url, { method: 'HEAD' });
  assert.equal(Number(headPlain.headers['content-length']), js.length);
  assert.equal(headPlain.body.length, 0);

  // Range is ignored, as HTTP allows: the same answer as without it.
  const ranged = await get(url, { headers: { 'Accept-Encoding': 'gzip, deflate, br', Range: 'bytes=3-8' } });
  assert.equal(ranged.status, 200);
  assert.equal(ranged.headers['content-encoding'], 'br');
  assert.deepEqual(ranged.body, br.body);
  assert.equal(ranged.headers['accept-ranges'], undefined);

  assert.equal((await get(`${server.origin}/missing.js`, { headers: { 'Accept-Encoding': 'br' } })).status, 404);
});

test("a file the browser already holds is answered 304 to its ETag: Chromium's service-worker update check asks so", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  for (const f of ['scripts/serve.mjs', 'scripts/headers.mjs', '_headers']) await copyFile(fileURLToPath(new URL(`../../${f}`, import.meta.url)), join(dir, f));
  const js = Buffer.from(`// the worker\n${'self.addEventListener("fetch", () => {});\n'.repeat(40)}`);
  const when = new Date('2026-10-23T12:00:00Z');
  await writeFile(join(dir, 'sw.js'), js);
  await writeFile(join(dir, 'sw.js.br'), brotliCompressSync(js));
  await utimes(join(dir, 'sw.js'), when, when);
  await utimes(join(dir, 'sw.js.br'), when, when);
  const server = await start(join(dir, 'scripts/serve.mjs'));
  t.after(() => server.stop());
  const url = `${server.origin}/sw.js`;
  const br = { 'Accept-Encoding': 'gzip, deflate, br' };

  const first = await get(url, { headers: br });
  const tag = /** @type {string} */ (first.headers.etag);
  assert.match(tag, /^"[^"]+"$/);
  const plainTag = (await get(url)).headers.etag;
  assert.ok(plainTag && plainTag !== tag, 'the brotli form and the file itself are told apart');

  for (const inm of [tag, `W/${tag}`, `"other", ${tag}`, '*']) {
    const again = await get(url, { headers: { ...br, 'If-None-Match': inm } });
    assert.equal(again.status, 304, `If-None-Match: ${inm}`);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers.etag, tag);
    assert.equal(again.headers['cache-control'], 'no-cache', 'the _headers rules hold');
  }
  assert.equal((await get(url, { method: 'HEAD', headers: { ...br, 'If-None-Match': tag } })).status, 304);
  assert.equal((await get(url, { headers: { ...br, 'If-None-Match': '"other"' } })).status, 200);
  assert.equal((await get(url, { headers: { 'If-None-Match': tag } })).status, 200, "the brotli form's tag doesn't stand for the file itself");

  // A new release: the file changes, and so does its tag.
  const next = Buffer.concat([js, Buffer.from('// next\n')]);
  await writeFile(join(dir, 'sw.js'), next);
  await writeFile(join(dir, 'sw.js.br'), brotliCompressSync(next));
  const later = new Date(when.getTime() + 60_000);
  await utimes(join(dir, 'sw.js'), later, later);
  await utimes(join(dir, 'sw.js.br'), later, later);
  const changed = await get(url, { headers: { ...br, 'If-None-Match': tag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, tag);
  assert.equal((await get(url, { headers: { ...br, 'If-None-Match': /** @type {string} */ (changed.headers.etag) } })).status, 304);
});
