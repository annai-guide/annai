import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../../relay/serve.mjs';
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
  const service = await startPushService();
  const r = await startRelay({ jwk: await newVapidJwk(), extraPushOrigins: [service.origin] });
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
    'simple = { limit = 300, period = 60 }', 'pattern = "push.annai.guide"', 'custom_domain = true', 'ORIGINS = "https://annai.guide"']) assert.ok(toml.includes(line), line);
  assert.doesNotMatch(toml, /VAPID_KEY\s*=/, 'the private key is a secret, never in the file');
  const mod = await import('../../relay/src/index.js');
  assert.equal(typeof mod.default.fetch, 'function');
  assert.equal(typeof mod.PushRelay.prototype.alarm, 'function');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@playwright/test', '@types/node', 'typescript'], 'no wrangler or miniflare');
  assert.equal(pkg.dependencies, undefined);
});
