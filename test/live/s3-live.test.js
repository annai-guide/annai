import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/storage-s3/index.js';
import { signV4, amzDate, EMPTY_SHA256 } from '../../plugins-official/storage-s3/sigv4.js';
import { TargetError, backupFileName, parseBackupFileName, readAnswer } from '../../src/core/storage-types.js';
import { xmlElements, xmlText } from '../../src/core/xml.js';

// A real S3-compatible server checks annai's signatures. Opt-in, like the providers' live suite:
//   docker run -d --name annai-s3 -p 127.0.0.1::7070 versity/versitygw:latest --access annaikey0001 --secret annaisecret00000001 posix /tmp
//   ANNAI_S3_LIVE="http://127.0.0.1:<port>|annaikey0001|annaisecret00000001|us-east-1" npm run test:live
const LIVE = process.env.ANNAI_S3_LIVE;

test('a real S3-compatible server takes annai\'s signed requests: make a bucket, back up, list, get, delete', { skip: !LIVE && 'set ANNAI_S3_LIVE to run' }, async () => {
  const [endpoint, accessKeyId, secretAccessKey, region] = String(LIVE).split('|');
  const bucket = `annai-live-${Date.now().toString(36)}`;
  // The bucket, made with the same signer.
  const date = amzDate(new Date());
  const host = new URL(endpoint).host;
  const headers = { host, 'x-amz-date': date, 'x-amz-content-sha256': EMPTY_SHA256 };
  const { authorization } = await signV4({ method: 'PUT', path: `/${bucket}`, headers, payloadHash: EMPTY_SHA256, region, service: 's3', accessKeyId, secretAccessKey, date });
  const { host: _, ...sent } = headers;
  const made = await fetch(`${endpoint}/${bucket}`, { method: 'PUT', headers: { ...sent, authorization } });
  assert.equal(made.status, 200, await made.text());
  /** @type {any} */
  let type = null;
  activate({
    helpers: { TargetError, readAnswer, xml: { elements: xmlElements, text: xmlText }, backupFiles: { name: backupFileName, parse: parseBackupFileName } },
    net: { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => fetch(url, init) },
    storage: { register: (/** @type {any} */ t) => { type = t; } },
  });
  const c = { config: { endpoint, region, bucket }, secret: { accessKeyId, secretAccessKey }, device: { id: 'live0000a', label: 'computer' }, app: 'live' };
  const o = { base: null, maxUpload: Infinity, onProgress: () => {} };
  assert.match((await type.check(c)).note, new RegExp(bucket));
  const name = backupFileName({ at: Date.now(), label: 'computer', device: 'live0000a', encrypted: false });
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251); // getRandomValues takes at most 64 KiB
  await type.put(c, { blob: new Blob([bytes]), name, manifest: {} }, o);
  assert.deepEqual((await type.list(c)).map((/** @type {any} */ b) => b.id), [name]);
  assert.deepEqual(new Uint8Array(await (await type.get(c, name, o)).arrayBuffer()), bytes);
  await type.delete(c, name);
  assert.deepEqual(await type.list(c), []);
  await assert.rejects(type.check({ ...c, secret: { accessKeyId, secretAccessKey: 'wrong-secret-0000' } }), (e) => e instanceof TargetError && e.kind === 'auth');
});
