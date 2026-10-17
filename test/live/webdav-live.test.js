import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/storage-webdav/index.js';
import { TargetError, backupFileName, parseBackupFileName, readAnswer } from '../../src/core/storage-types.js';
import { xmlElements, xmlText } from '../../src/core/xml.js';

// A real WebDAV server. Opt-in, like the providers' live suite:
//   docker run -d --name annai-dav -p 127.0.0.1::8080 rclone/rclone:1.71 serve webdav /tmp --addr :8080 --user annai --pass livepassword0001
//   ANNAI_WEBDAV_LIVE="http://127.0.0.1:<port>/annai|annai|livepassword0001" npm run test:live
const LIVE = process.env.ANNAI_WEBDAV_LIVE;

test('a real WebDAV server: the folder made, a backup put, listed, fetched and deleted', { skip: !LIVE && 'set ANNAI_WEBDAV_LIVE to run' }, async () => {
  const [url, user, password] = String(LIVE).split('|');
  /** @type {any} */
  let type = null;
  activate({
    helpers: { TargetError, readAnswer, xml: { elements: xmlElements, text: xmlText }, backupFiles: { name: backupFileName, parse: parseBackupFileName } },
    net: { fetch: (/** @type {string} */ u, /** @type {RequestInit} */ init) => fetch(u, init) },
    storage: { register: (/** @type {any} */ t) => { type = t; } },
  });
  const c = { config: { url: `${url}-${Date.now().toString(36)}`, user }, secret: { password }, device: { id: 'live0000a', label: 'computer' }, app: 'live' };
  const o = { base: null, maxUpload: Infinity, onProgress: () => {} };
  assert.match((await type.check(c)).note, /made the folder/);
  const name = backupFileName({ at: Date.now(), label: 'computer', device: 'live0000a', encrypted: true });
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251); // getRandomValues takes at most 64 KiB
  await type.put(c, { blob: new Blob([bytes]), name, manifest: {} }, o);
  assert.deepEqual((await type.list(c)).map((/** @type {any} */ b) => [b.id, b.encrypted]), [[name, true]]);
  assert.deepEqual(new Uint8Array(await (await type.get(c, name, o)).arrayBuffer()), bytes);
  await type.delete(c, name);
  assert.deepEqual(await type.list(c), []);
  await assert.rejects(type.check({ ...c, secret: { password: 'wrong-password-00' } }), (e) => e instanceof TargetError && e.kind === 'auth');
});
