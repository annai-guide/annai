import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate, corsRules } from '../../plugins-official/storage-s3/index.js';
import { TargetError, backupFileName, parseBackupFileName, readAnswer } from '../../src/core/storage-types.js';
import { xmlElements, xmlText } from '../../src/core/xml.js';
import { startS3, ACCESS, SECRET } from '../fakes/s3.js';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createBackups } from '../../src/core/backup.js';

/** The S3 type as annai's core sees it; sent: every request it made. */
function s3type() {
  /** @type {{ url: string, init: RequestInit }[]} */
  const sent = [];
  /** @type {any} */
  let type = null;
  activate({
    helpers: { TargetError, readAnswer, xml: { elements: xmlElements, text: xmlText }, backupFiles: { name: backupFileName, parse: parseBackupFileName } },
    net: { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => { sent.push({ url, init }); return fetch(url, init); } },
    storage: { register: (/** @type {any} */ t) => { type = t; return () => {}; } },
  });
  return { type, sent };
}

/** @param {any} s3 @param {Record<string, string>} [config] @param {Record<string, string>} [secret] */
const ctx = (s3, config = {}, secret = {}) => ({
  config: { endpoint: s3.origin, region: 'us-east-1', bucket: 'trips', ...config },
  secret: { accessKeyId: ACCESS, secretAccessKey: SECRET, ...secret }, device: { id: 'phone0000a', label: 'iPhone' }, app: 'test',
});
const opts = { base: null, maxUpload: Infinity, onProgress: () => {} };
/** @param {string} kind @param {RegExp} [re] */
const refused = (kind, re = /./) => (/** @type {any} */ e) => e instanceof TargetError && e.kind === kind && re.test(e.message);
/** @param {number} at @param {string} device */
const named = (at, device, label = 'iPhone') => backupFileName({ at, label, device, encrypted: false });

test('a bucket takes backups as files in its folder, lists them newest first, and gives them back (spec §12.4)', async () => {
  const s3 = await startS3({ buckets: ['trips'], pageSize: 2 });
  try {
    const { type, sent } = s3type();
    assert.deepEqual([type.type, type.name, type.stores, type.fields.map((/** @type {any} */ f) => f.key), type.secret.map((/** @type {any} */ f) => f.key)],
      ['s3', 'S3-compatible storage', 'file', ['endpoint', 'region', 'bucket', 'prefix'], ['accessKeyId', 'secretAccessKey']]);
    assert.equal(type.where({ bucket: 'trips' }), 'trips/annai/');
    assert.match((await type.check(ctx(s3))).note, /trips/);
    const first = named(Date.UTC(2026, 9, 16, 10), 'phone0000a');
    const second = named(Date.UTC(2026, 9, 16, 11), 'droid0000b', 'Android phone');
    const third = named(Date.UTC(2026, 9, 16, 12), 'phone0000a');
    for (const name of [first, second, third]) {
      const got = await type.put(ctx(s3), { blob: new Blob([`bytes of ${name}`]), name, manifest: {} }, opts);
      assert.deepEqual([got.id, got.at], [name, parseBackupFileName(name)?.at]);
    }
    s3.putAs('trips', 'annai/notes.txt', 'not a backup');
    s3.putAs('trips', 'annai/old/annai-backup-x.annai.zip', 'in a folder below');
    s3.putAs('trips', 'elsewhere.annai.zip', 'outside the folder');
    const listed = await type.list(ctx(s3));
    assert.deepEqual(listed.map((/** @type {any} */ b) => [b.id, b.device, b.label]), [[third, 'phone0000a', 'iPhone'], [second, 'droid0000b', 'Android phone'], [first, 'phone0000a', 'iPhone']]);
    assert.equal(await (await type.get(ctx(s3), second, opts)).text(), `bytes of ${second}`);
    await type.delete(ctx(s3), first);
    await type.delete(ctx(s3), first); // already gone: no error
    assert.deepEqual([...s3.objects('trips').keys()].filter((k) => k.endsWith('.annai.zip') && k.startsWith('annai/annai-')).sort(), [second, third].map((n) => `annai/${n}`).sort());
    // Another folder; the folder given without its slash.
    await type.put(ctx(s3, { prefix: 'phones/mine' }), { blob: new Blob(['x']), name: first, manifest: {} }, opts);
    assert.ok(s3.objects('trips').has(`phones/mine/${first}`));
    for (const s of sent) {
      const headers = new Headers(s.init.headers);
      assert.match(headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=AKIASTANDIN000000001\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      assert.equal(s.url.includes(SECRET), false);
    }
    assert.equal(sent.filter((s) => s.init.method === 'PUT').every((s) => new Headers(s.init.headers).get('x-amz-content-sha256') === 'UNSIGNED-PAYLOAD'), true);
  } finally {
    await s3.stop();
  }
});

test('what a bucket refuses comes back in plain words, with what to do', async () => {
  const s3 = await startS3({ buckets: ['trips'] });
  try {
    const { type } = s3type();
    await assert.rejects(type.check(ctx(s3, {}, { secretAccessKey: 'wrong' })), refused('auth', /didn't accept the access key/));
    await assert.rejects(type.check(ctx(s3, {}, { accessKeyId: 'AKIAWRONG' })), refused('auth'));
    await assert.rejects(type.check(ctx(s3, { region: 'eu-west-1' })), refused('setup', /region us-east-1/));
    await assert.rejects(type.check(ctx(s3, { bucket: 'nothing' })), refused('missing', /no bucket nothing/));
    s3.denyNext('AccessDenied');
    await assert.rejects(type.check(ctx(s3)), refused('refused', /isn't allowed/));
    await assert.rejects(type.get(ctx(s3), named(1, 'phone0000a'), opts), refused('missing', /no longer in the bucket/));
    await assert.rejects(type.check(ctx(s3, { endpoint: 'http://example.com' })), refused('setup', /https/));
    await assert.rejects(type.check(ctx(s3, { bucket: 'Not A Bucket' })), refused('setup', /bucket's name/));
    await assert.rejects(type.check(ctx(s3, {}, { secretAccessKey: '' })), refused('setup', /secret access key/));
  } finally {
    await s3.stop();
  }
  // A bucket that doesn't answer browsers looks like no answer at all: the test says what to do.
  const nowhere = s3type().type;
  await assert.rejects(nowhere.check({ ...ctx({ origin: 'http://127.0.0.1:9' }) }), refused('setup', /CORS/));
});

test('the CORS rules annai shows are exact, with this page\'s origin (spec §12.4)', () => {
  assert.deepEqual(JSON.parse(corsRules('https://annai.guide')), [{
    AllowedOrigins: ['https://annai.guide'], AllowedMethods: ['GET', 'PUT', 'DELETE'],
    AllowedHeaders: ['authorization', 'content-type', 'x-amz-content-sha256', 'x-amz-date'], MaxAgeSeconds: 3600,
  }]);
  const { type } = s3type();
  const access = type.browserAccess('http://127.0.0.1:8790');
  assert.equal(access.code, corsRules('http://127.0.0.1:8790'));
  assert.match(access.text, /CORS/);
});

test('AWS addresses carry the bucket in the host name, unless its name has a dot; other services are path-style', async () => {
  /** @type {string[]} */
  const urls = [];
  /** @type {any} */
  let type = null;
  activate({
    helpers: { TargetError, readAnswer, xml: { elements: xmlElements, text: xmlText }, backupFiles: { name: backupFileName, parse: parseBackupFileName } },
    net: { fetch: async (/** @type {string} */ url) => { urls.push(url); return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'); } },
    storage: { register: (/** @type {any} */ t) => { type = t; } },
  });
  const secret = { accessKeyId: ACCESS, secretAccessKey: SECRET };
  for (const config of [
    { endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', bucket: 'my-trips' },
    { endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', bucket: 'my.trips' },
    { endpoint: 'https://abc123.r2.cloudflarestorage.com/', region: 'auto', bucket: 'my-trips' },
  ]) await type.list({ config, secret, device: { id: 'x', label: 'iPhone' }, app: 'test' });
  assert.deepEqual(urls.map((u) => u.split('?')[0]), [
    'https://my-trips.s3.eu-west-1.amazonaws.com/', 'https://s3.eu-west-1.amazonaws.com/my.trips', 'https://abc123.r2.cloudflarestorage.com/my-trips',
  ]);
  assert.match(urls[0], /\?list-type=2&prefix=annai%2F$/);
});

test("a broken or hostile answer from a bucket is the bucket's answer, never a crash in the plugin (spec §5.5)", async () => {
  const s3 = await startS3({ buckets: ['trips'] });
  try {
    const { type } = s3type();
    s3.garbleNext({ method: 'GET', body: `<ListBucketResult>${'<Contents><Key>'.repeat(200_000)}&#x110000;` });
    assert.deepEqual(await type.list(ctx(s3)), [], 'a list cut off holds no backups');
    s3.garbleNext({ method: 'GET', body: `<ListBucketResult>${'x'.repeat(9 * 1024 * 1024)}</ListBucketResult>` });
    await assert.rejects(type.list(ctx(s3)), refused('other', /larger than annai reads/));
    s3.garbleNext({ method: 'GET', status: 403, body: '<Error><Code>&#9999999999;</Code>' });
    await assert.rejects(type.check(ctx(s3)), refused('refused'));
    assert.match((await type.check(ctx(s3))).note, /trips/, 'and the next answer is read as usual');
  } finally {
    await s3.stop();
  }
});

test('S3 through annai: whole files kept and pruned, every request traced, no key anywhere annai keeps or sends', async () => {
  const s3 = await startS3({ buckets: ['trips'] });
  try {
    /** @type {any[]} */
    const logged = [];
    const registry = new Registry({ log: (ev) => { logged.push(ev); } });
    const store = createMemoryStore();
    const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
    await ensureBaseScopes(ws);
    const dir = new URL('../../plugins-official/storage-s3/', import.meta.url);
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    for (const name of await readdir(dir)) files.set(name, new Uint8Array(await readFile(new URL(name, dir))));
    const served = '/plugins/storage-s3/';
    const host = new PluginHost({ registry, workspace: ws, importModule: (url) => import(url.startsWith(served) ? new URL(url.slice(served.length), dir).href : url) });
    await host.install(files, { source: 'official' });
    await host.start('storage-s3');
    const backups = createBackups({ store, ws, registry, app: 'test', label: 'iPhone', noun: 'phone' });
    await createTrip(ws, { title: 'Big Sur' });
    const id = await backups.add('s3');
    await backups.update(id, { config: { endpoint: s3.origin, region: 'us-east-1', bucket: 'trips' }, secret: { accessKeyId: ACCESS, secretAccessKey: SECRET }, keep: 1 });
    await backups.check(id);
    await backups.backUp(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await backups.backUp(id);
    const kept = [...s3.objects('trips').keys()];
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^annai\/annai-backup-\d{8}T\d{9}Z-iphone-[0-9a-z]+\.annai\.zip$/);
    assert.equal((await backups.get(id))?.last?.id, kept[0].slice('annai/'.length));
    const events = await store.tx(['scopes', 'events'], 'readonly', async (t) => (await Promise.all((await t.listScopes()).map((s) => t.listEvents(s.id)))).flat());
    const traced = events.filter((e) => e.type === 'net.request');
    assert.equal(traced.length, s3.log.length);
    assert.ok(traced.every((e) => e.data.tool === 'plugin:storage-s3'));
    for (const secret of [SECRET, ACCESS]) {
      assert.equal(JSON.stringify(events).includes(secret), false, secret);
      for (const [key, bytes] of s3.objects('trips')) assert.equal(bytes.toString('latin1').includes(secret), false, key);
    }
    s3.garbleNext({ method: 'GET', body: `<ListBucketResult>${'x'.repeat(9 * 1024 * 1024)}` });
    await assert.rejects(backups.remote(id), (e) => e instanceof TargetError && e.kind === 'other' && /larger than annai reads/.test(e.message));
    assert.deepEqual(logged, []);
    assert.equal(registry.isDisabled('storage-s3'), false);
  } finally {
    await s3.stop();
  }
});

test('an S3 address that is no web address is a setup problem in plain words, never a bug in the plugin', async () => {
  const { type } = s3type();
  for (const endpoint of ['https://s3 .amazonaws.com', 'https://s3.us-east-1.amazonaws.com (us-east-1)', 'https://', 'https://ex\u0000ample.com', 'https://[::1']) {
    const c = ctx({ origin: endpoint });
    for (const step of [() => type.check(c), () => type.list(c), () => type.put(c, { blob: new Blob(['x']), name: named(1, 'phone0000a'), manifest: {} }, opts)]) {
      await assert.rejects(step(), refused('setup', /address/), endpoint);
    }
  }
});
