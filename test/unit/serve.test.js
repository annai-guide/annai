import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
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

test('a release sends x.br or x.gz when the browser takes it, the file itself otherwise, and ranges of the file itself', async (t) => {
  // A release folder: serve.mjs and what it needs, a script with both forms beside it, one with only .gz, one with neither.
  const dir = await mkdtemp(join(tmpdir(), 'annai-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  for (const f of ['scripts/serve.mjs', 'scripts/headers.mjs', '_headers']) await copyFile(fileURLToPath(new URL(`../../${f}`, import.meta.url)), join(dir, f));
  const js = Buffer.from(`// a shipped script\n${'export const words = "Low tide is at 5:40.";\n'.repeat(40)}`);
  await writeFile(join(dir, 'app.js'), js);
  await writeFile(join(dir, 'app.js.br'), brotliCompressSync(js));
  await writeFile(join(dir, 'app.js.gz'), gzipSync(js));
  await writeFile(join(dir, 'only-gz.css'), js);
  await writeFile(join(dir, 'only-gz.css.gz'), gzipSync(js));
  await writeFile(join(dir, 'plain.json'), '{"a":1}');
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

  const gz = await get(url, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(Number(gz.headers['content-length']), gz.body.length);
  assert.equal((await get(url, { headers: { 'Accept-Encoding': 'br;q=0, gzip' } })).headers['content-encoding'], 'gzip');
  assert.equal((await get(url, { headers: { 'Accept-Encoding': '*' } })).headers['content-encoding'], 'br');

  for (const accept of [undefined, 'identity', 'br;q=0, gzip;q=0', 'deflate']) {
    const plain = await get(url, { headers: accept === undefined ? {} : { 'Accept-Encoding': accept } });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined, `Accept-Encoding: ${accept}`);
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    assert.deepEqual(plain.body, js);
    assert.equal(Number(plain.headers['content-length']), js.length);
  }

  // No .br beside it: the .gz, then the file.
  const fallback = await get(`${server.origin}/only-gz.css`, { headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(fallback.headers['content-encoding'], 'gzip');
  assert.equal(fallback.headers['content-type'], 'text/css; charset=utf-8');
  assert.deepEqual(fallback.body, gzipSync(js));
  const onlyBr = await get(`${server.origin}/only-gz.css`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(onlyBr.headers['content-encoding'], undefined);
  assert.deepEqual(onlyBr.body, js);
  const none = await get(`${server.origin}/plain.json`, { headers: { 'Accept-Encoding': 'br, gzip' } });
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

  // Range: the file's own bytes, never a compressed form.
  const part = await get(url, { headers: { 'Accept-Encoding': 'br, gzip', Range: 'bytes=3-8' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-encoding'], undefined);
  assert.equal(part.headers['content-range'], `bytes 3-8/${js.length}`);
  assert.equal(Number(part.headers['content-length']), 6);
  assert.deepEqual(part.body, js.subarray(3, 9));
  const tail = await get(url, { headers: { Range: 'bytes=-5' } });
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.body, js.subarray(js.length - 5));
  const rest = await get(url, { headers: { Range: `bytes=${js.length - 2}-` } });
  assert.deepEqual(rest.body, js.subarray(js.length - 2));
  const beyond = await get(url, { headers: { Range: `bytes=${js.length}-` } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers['content-range'], `bytes */${js.length}`);
  const headPart = await get(url, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.equal(headPart.status, 206);
  assert.equal(Number(headPart.headers['content-length']), 10);
  assert.equal(headPart.body.length, 0);
  // Ranges it doesn't serve (several, or not bytes) get the whole file, as HTTP allows.
  const several = await get(url, { headers: { Range: 'bytes=0-1,4-5' } });
  assert.equal(several.status, 200);
  assert.deepEqual(several.body, js);
  assert.equal((await get(url)).headers['accept-ranges'], 'bytes');

  assert.equal((await get(`${server.origin}/missing.js`, { headers: { 'Accept-Encoding': 'br' } })).status, 404);
});
