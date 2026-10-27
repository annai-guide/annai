import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate, headerLines } from '../../plugins-official/storage-webdav/index.js';
import { TargetError, backupFileName, parseBackupFileName, readAnswer } from '../../src/core/storage-types.js';
import { xmlElements, xmlText } from '../../src/core/xml.js';
import { startWebDAV, USER, PASSWORD } from '../fakes/webdav.js';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createBackups } from '../../src/core/backup.js';
import { pluginWords } from './l10n-kit.js';

/** The WebDAV type as annai's core sees it; sent: every request it made. */
function davType() {
  /** @type {{ url: string, init: RequestInit }[]} */
  const sent = [];
  /** @type {any} */
  let type = null;
  activate({
    l10n: pluginWords(),
    helpers: { TargetError, readAnswer, xml: { elements: xmlElements, text: xmlText }, backupFiles: { name: backupFileName, parse: parseBackupFileName } },
    net: { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => { sent.push({ url, init }); return fetch(url, init); } },
    storage: { register: (/** @type {any} */ t) => { type = t; return () => {}; } },
  });
  return { type, sent };
}

/** @param {any} dav @param {Record<string, string>} [config] @param {Record<string, string>} [secret] */
const ctx = (dav, config = {}, secret = {}) => ({
  config: { url: `${dav.origin}/dav/annai`, user: USER, ...config }, secret: { password: PASSWORD, ...secret },
  device: { id: 'phone0000a', label: 'iPhone' }, app: 'test',
});
const opts = { base: null, maxUpload: Infinity, onProgress: () => {} };
/** @param {string} kind @param {RegExp} [re] */
const refused = (kind, re = /./) => (/** @type {any} */ e) => e instanceof TargetError && e.kind === kind && re.test(e.message);
/** @param {number} at @param {string} device */
const named = (at, device, label = 'iPhone') => backupFileName({ at, label, device, encrypted: false });

test('a WebDAV folder (made when missing) takes backups as files, lists them newest first, gives them back (spec §12.4)', async () => {
  const dav = await startWebDAV({ folders: ['/dav/'] });
  try {
    const { type, sent } = davType();
    assert.deepEqual([type.type, type.name, type.stores, type.fields.map((/** @type {any} */ f) => f.key), type.secret.map((/** @type {any} */ f) => f.key)],
      ['webdav', 'WebDAV', 'file', ['url', 'user'], ['password']]);
    assert.match((await type.check(ctx(dav))).note, /^Works: annai made the folder 127\.0\.0\.1:\d+\/dav\/annai\/ and can keep its backups there\.$/);
    assert.match((await type.check(ctx(dav))).note, /^Works: annai can keep its backups in 127\.0\.0\.1:\d+\/dav\/annai\/\.$/);
    const first = named(Date.UTC(2026, 9, 16, 10), 'phone0000a');
    const second = named(Date.UTC(2026, 9, 16, 11), 'droid0000b', 'Android phone');
    for (const name of [first, second]) await type.put(ctx(dav), { blob: new Blob([`bytes of ${name}`]), name, manifest: {} }, opts);
    dav.putAs('/dav/annai/notes.txt', 'not a backup');
    const listed = await type.list(ctx(dav));
    assert.deepEqual(listed.map((/** @type {any} */ b) => [b.id, b.label]), [[second, 'Android phone'], [first, 'iPhone']]);
    assert.equal(await (await type.get(ctx(dav), first, opts)).text(), `bytes of ${first}`);
    await type.delete(ctx(dav), first);
    await type.delete(ctx(dav), first); // already gone: no error
    assert.deepEqual((await type.list(ctx(dav))).map((/** @type {any} */ b) => b.id), [second]);
    const basic = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
    for (const s of sent) {
      assert.equal(new Headers(s.init.headers).get('authorization'), basic);
      assert.equal(s.url.includes(PASSWORD), false);
    }
  } finally {
    await dav.stop();
  }
});

test('a folder that was removed is made again at the next backup', async () => {
  const dav = await startWebDAV({ folders: ['/dav/'] });
  try {
    const { type } = davType();
    assert.deepEqual(await type.list(ctx(dav)), [], 'no folder yet: no backups');
    await type.put(ctx(dav), { blob: new Blob(['x']), name: named(1_800_000_000_000, 'phone0000a'), manifest: {} }, opts);
    assert.ok(dav.dirs().has('/dav/annai/'));
  } finally {
    await dav.stop();
  }
});

test('what a WebDAV server refuses comes back in plain words, with what to do', async () => {
  const dav = await startWebDAV({ folders: ['/dav/'] });
  try {
    const { type } = davType();
    await assert.rejects(type.check(ctx(dav, {}, { password: 'wrong' })), refused('auth', /didn't accept the user name and password/));
    await assert.rejects(type.check(ctx(dav, { url: `${dav.origin}/nowhere/deeper/annai` })), refused('missing', /doesn't exist on the server/));
    await assert.rejects(type.check(ctx(dav, { url: 'http://example.com/dav/' })), refused('setup', /https/));
    await assert.rejects(type.check(ctx(dav, { user: '' })), refused('setup', /user name/));
    await assert.rejects(type.get(ctx(dav), named(1, 'phone0000a'), opts), refused('missing', /no longer in the folder/));
  } finally {
    await dav.stop();
  }
  await assert.rejects(davType().type.check(ctx({ origin: 'http://127.0.0.1:9' })), refused('setup', /browser access/));
});

test('what a WebDAV server needs for browser access, with this page\'s origin', () => {
  const lines = headerLines('https://annai.guide');
  assert.match(lines, /^Header always set Access-Control-Allow-Origin "https:\/\/annai\.guide"$/m);
  assert.match(lines, /Access-Control-Allow-Methods "GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS"/);
  assert.match(lines, /Access-Control-Allow-Headers "Authorization, Content-Type, Depth"/);
  const { type } = davType();
  assert.equal(type.browserAccess('http://127.0.0.1:8790').code, headerLines('http://127.0.0.1:8790'));
  assert.match(type.browserAccess('http://127.0.0.1:8790').text, /OPTIONS requests without asking for a password/);
});

test("a broken or hostile answer from a WebDAV server is the server's answer, never a crash in the plugin (spec §5.5)", async () => {
  const dav = await startWebDAV({ folders: ['/dav/', '/dav/annai/'] });
  try {
    const { type } = davType();
    dav.garbleNext({ method: 'PROPFIND', status: 207, body: `<d:multistatus xmlns:d="DAV:">${'<d:response><d:href>'.repeat(200_000)}&#x110000;` });
    assert.deepEqual(await type.list(ctx(dav)), [], 'an answer cut off holds no backups');
    dav.garbleNext({ method: 'PROPFIND', status: 207, body: `<d:multistatus>${'x'.repeat(9 * 1024 * 1024)}</d:multistatus>` });
    await assert.rejects(type.list(ctx(dav)), refused('other', /larger than annai reads/));
    assert.deepEqual(await type.list(ctx(dav)), [], 'and the next answer is read as usual');
  } finally {
    await dav.stop();
  }
});

test('WebDAV through annai: whole files kept and pruned, every request traced, the password nowhere annai keeps or sends', async () => {
  const dav = await startWebDAV({ folders: ['/dav/'] });
  try {
    /** @type {any[]} */
    const logged = [];
    const registry = new Registry({ log: (ev) => { logged.push(ev); } });
    const store = createMemoryStore();
    const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
    await ensureBaseScopes(ws);
    const dir = new URL('../../plugins-official/storage-webdav/', import.meta.url);
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    // Its files, its translations' folder too.
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { const name = relative(fileURLToPath(dir), join(e.parentPath, e.name)); files.set(name, new Uint8Array(await readFile(new URL(name, dir)))); }
    const served = '/plugins/storage-webdav/';
    const host = new PluginHost({ registry, workspace: ws, importModule: (url) => import(url.startsWith(served) ? new URL(url.slice(served.length), dir).href : url) });
    await host.install(files, { source: 'official' });
    await host.start('storage-webdav');
    const backups = createBackups({ store, ws, registry, app: 'test', label: 'Android phone', noun: 'phone' });
    await createTrip(ws, { title: 'Kyoto' });
    const id = await backups.add('webdav');
    await backups.update(id, { config: { url: `${dav.origin}/dav/annai`, user: USER }, secret: { password: PASSWORD }, keep: 1 });
    assert.match((await backups.check(id)).note, /made the folder/);
    await backups.backUp(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await backups.backUp(id);
    const kept = [...dav.files().keys()];
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^\/dav\/annai\/annai-backup-\d{8}T\d{9}Z-android-phone-[0-9a-z]+\.annai\.zip$/);
    const events = await store.tx(['scopes', 'events'], 'readonly', async (t) => (await Promise.all((await t.listScopes()).map((s) => t.listEvents(s.id)))).flat());
    const traced = events.filter((e) => e.type === 'net.request');
    assert.equal(traced.length, dav.log.length);
    assert.ok(traced.every((e) => e.data.tool === 'plugin:storage-webdav'));
    assert.equal(JSON.stringify(events).includes(PASSWORD), false);
    const basic = Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
    assert.equal(JSON.stringify(events).includes(basic), false);
    for (const [path, bytes] of dav.files()) assert.equal(bytes.toString('latin1').includes(PASSWORD), false, path);
    dav.garbleNext({ method: 'PROPFIND', status: 207, body: `<d:multistatus>${'x'.repeat(9 * 1024 * 1024)}` });
    await assert.rejects(backups.remote(id), (e) => e instanceof TargetError && e.kind === 'other');
    assert.deepEqual(logged, []);
    assert.equal(registry.isDisabled('storage-webdav'), false);
  } finally {
    await dav.stop();
  }
});

test('a folder address that is no web address is a setup problem in plain words, never a bug in the plugin', async () => {
  const { type } = davType();
  for (const url of ['https://dav .example.com/annai/', 'https://dav.example.com (my folder)/annai/', 'https://', 'https://ex\u0000ample.com/', 'https://[::1/annai']) {
    const c = ctx({ origin: '' }, { url });
    for (const step of [() => type.check(c), () => type.list(c), () => type.get(c, 'x', opts)]) await assert.rejects(step(), refused('setup', /address/), url);
  }
});
