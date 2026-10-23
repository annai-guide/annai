import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../../relay/serve.mjs';
import { memoryNamespace } from '../../relay/memory.js';
import { newVapidJwk } from '../../relay/src/vapid.js';
import { toB64u } from '../../relay/src/b64.js';
import { startPushService } from '../fakes/push-service.js';
import { encryptPush } from '../../src/core/push/webpush.js';
import { utf8 } from '../../src/core/bytes.js';

const serve = fileURLToPath(new URL('../../relay/serve.mjs', import.meta.url));

test('the Node runner: the same relay over HTTP, its key in a file only its owner can read, kept across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-relay-'));
  try {
    const file = join(dir, 'config', 'vapid.json');
    const a = await startRelay({ origins: ['http://127.0.0.1:8790'], keys: file });
    try {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      const res = await fetch(`${a.origin}/v1/vapid`, { headers: { Origin: 'http://127.0.0.1:8790' } });
      assert.deepEqual(await res.json(), { key: a.key });
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8790');
    } finally {
      await a.close();
    }
    const b = await startRelay({ keys: file });
    try {
      assert.equal(b.key, a.key, 'the same key after a restart, so phones stay subscribed');
    } finally {
      await b.close();
    }
    assert.ok(JSON.parse(await readFile(file, 'utf8')).d, 'the private key is in that file and nowhere else');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('over HTTP, on real timers, a reminder reaches the push service at its time', async () => {
  const jwk = await newVapidJwk();
  const service = await startPushService();
  const r = await startRelay({ jwk, extraPushOrigins: [service.origin] }).catch(async (e) => {
    await service.stop();
    throw e;
  });
  try {
    const sub = await service.subscribe(r.key);
    const payload = await encryptPush(sub, utf8('Now.'), { pad: 3072 });
    const res = await fetch(`${r.origin}/v1/schedule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${toB64u(crypto.getRandomValues(new Uint8Array(32)))}` },
      body: JSON.stringify({ endpoint: sub.endpoint, key: r.key, sendAt: Date.now() + 300, payload: toB64u(payload) }),
    });
    assert.equal(res.status, 201);
    for (let i = 0; i < 50 && !service.received.length; i++) await new Promise((done) => setTimeout(done, 100));
    assert.equal(service.received[0]?.plaintext, 'Now.');
  } finally {
    await r.close();
    await service.stop();
  }
});

test("the runner keeps off annai's own ports, and asks for the app's address", () => {
  const taken = spawnSync(process.execPath, [serve, '--port', '8790', '--origin', 'https://x.example'], { encoding: 'utf8' });
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /annai's own/);
  const bare = spawnSync(process.execPath, [serve, '--port', '0'], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--origin/);
});

test('wrangler.toml: one SQLite-backed Durable Object class per subscription, the rate limit, the route, no key; index.js exports both', async () => {
  const toml = await readFile(new URL('../../relay/wrangler.toml', import.meta.url), 'utf8');
  for (const line of ['main = "src/index.js"', 'name = "RELAY"', 'class_name = "PushRelay"', 'new_sqlite_classes = ["PushRelay"]', 'name = "LIMIT"',
    'simple = { limit = 60, period = 60 }', 'pattern = "push.annai.guide"', 'custom_domain = true', 'ORIGINS = "https://annai.guide"']) assert.ok(toml.includes(line), line);
  assert.doesNotMatch(toml, /VAPID_KEY\s*=/, 'the private key is a secret, never in the file');
  const readme = await readFile(new URL('../../relay/README.md', import.meta.url), 'utf8');
  assert.match(readme, /100,000/, 'the Free plan\'s daily caps, in plain words');
  assert.match(readme, /Workers Paid plan/);
  assert.match(readme, /60 requests a minute/);
  const mod = await import('../../relay/src/index.js');
  assert.equal(typeof mod.default.fetch, 'function');
  assert.equal(typeof mod.PushRelay.prototype.alarm, 'function');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@playwright/test', '@types/node', 'typescript'], 'no wrangler or miniflare');
  assert.equal(pkg.dependencies, undefined);
});

test('with a data file, the reminders waiting and their times survive a restart, in a file only its owner can read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-relay-'));
  const service = await startPushService();
  try {
    const jwk = await newVapidJwk();
    const data = join(dir, 'state', 'relay.json');
    const a = await startRelay({ jwk, data, extraPushOrigins: [service.origin] });
    try {
      const sub = await service.subscribe(a.key);
      const send = async (/** @type {string} */ origin, /** @type {string} */ text, /** @type {number} */ sendAt) => fetch(`${origin}/v1/schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${toB64u(crypto.getRandomValues(new Uint8Array(32)))}` },
        body: JSON.stringify({ endpoint: sub.endpoint, key: a.key, sendAt, payload: toB64u(await encryptPush(sub, utf8(text), { pad: 3072 })) }),
      });
      assert.equal((await send(a.origin, 'Hello.', Date.now())).status, 201, 'a reminder due now confirms the subscription');
      for (let i = 0; i < 50 && service.received.length < 1; i++) await new Promise((done) => setTimeout(done, 50));
      assert.equal((await send(a.origin, 'After the restart.', Date.now() + 1500)).status, 201);
    } finally {
      await a.close();
    }
    assert.equal((await stat(data)).mode & 0o777, 0o600);
    const b = await startRelay({ jwk, data, extraPushOrigins: [service.origin] });
    try {
      for (let i = 0; i < 60 && service.received.length < 2; i++) await new Promise((done) => setTimeout(done, 100));
      assert.deepEqual(service.received.map((m) => m.plaintext), ['Hello.', 'After the restart.']);
    } finally {
      await b.close();
    }
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a request larger than the relay reads is refused as soon as it is, without waiting for the rest', async () => {
  const r = await startRelay({ jwk: await newVapidJwk() });
  const { request } = await import('node:http');
  try {
    const url = new URL(`${r.origin}/v1/schedule`);
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => resolve(res.statusCode));
      req.on('error', (e) => (/** @type {any} */ (e).code === 'ECONNRESET' ? undefined : reject(e)));
      req.write(Buffer.alloc(9000, 0x20)); // chunked, and never ended: a body of any length
      setTimeout(() => resolve('no answer'), 2000);
    });
    assert.equal(status, 413);
  } finally {
    await r.close();
  }
});

test('closing waits for an alarm already running, and arms no timer after, so a restart neither sends twice nor keeps running', async () => {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((done) => { release = () => done(undefined); });
  let started = false;
  class Obj {
    /** @param {{ storage: any }} state */
    constructor(state) {
      this.storage = state.storage;
    }
    async fetch() {
      await this.storage.setAlarm(Date.now());
      return new Response('ok');
    }
    async alarm() {
      started = true;
      await gate;
      await this.storage.setAlarm(Date.now() + 60_000); // as a retry's back-off does
    }
  }
  const ns = memoryNamespace(Obj, {});
  await ns.get(ns.idFromName('x')).fetch(new Request('http://relay/'));
  for (let i = 0; i < 50 && !started; i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(started);
  let closed = false;
  const closing = Promise.resolve(ns.close()).then(() => { closed = true; });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(closed, false, 'it waits for the alarm that is running');
  release();
  await closing;
  const o = /** @type {any} */ (ns.objects.get('x'));
  assert.equal(o.timer, null, 'no timer left running');
  assert.ok(o.storage.alarm > Date.now(), 'the time it set is kept, for the next start');
});

test('the runner stops on SIGTERM (systemd stopping it) by closing, so a reminder being sent is written down first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-relay-'));
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [serve, '--port', '0', '--origin', 'https://x.example', '--keys', join(dir, 'vapid.json'), '--data', join(dir, 'relay.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
    await new Promise((done) => child.stdout.on('data', (b) => String(b).includes('annai push relay') && done(undefined)));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    assert.deepEqual(await exited, { code: 0, signal: null });
    clearTimeout(timer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the runner starts when it is run through a link, as a release behind a "current" link is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-relay-'));
  try {
    const { symlink } = await import('node:fs/promises');
    await symlink(fileURLToPath(new URL('../../relay', import.meta.url)), join(dir, 'current'));
    const run = spawnSync(process.execPath, [join(dir, 'current', 'serve.mjs'), '--port', '0', '--origin', 'https://x.example', '--keys', join(dir, 'vapid.json')], { encoding: 'utf8', timeout: 3000 });
    assert.match(run.stdout, /annai push relay/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
