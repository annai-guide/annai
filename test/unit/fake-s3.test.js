import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startS3, ACCESS, SECRET } from '../fakes/s3.js';
import { signV4, uriEncode, amzDate, sha256Hex, EMPTY_SHA256 } from '../../plugins-official/storage-s3/sigv4.js';

/**
 * A request to the stand-in, signed as annai signs.
 * @param {any} s3 @param {string} method @param {string} path @param {{ query?: [string, string][], body?: Uint8Array<ArrayBuffer>, secret?: string, key?: string, region?: string, signed?: string[], hash?: string }} [o]
 */
async function send(s3, method, path, o = {}) {
  const url = new URL(s3.origin);
  const date = amzDate(new Date());
  const hash = o.hash ?? (o.body ? await sha256Hex(Uint8Array.from(o.body)) : EMPTY_SHA256);
  const headers = { host: url.host, 'x-amz-date': date, 'x-amz-content-sha256': hash };
  const signedHeaders = o.signed ? Object.fromEntries(Object.entries(headers).filter(([k]) => /** @type {string[]} */ (o.signed).includes(k))) : headers;
  const { authorization } = await signV4({ method, path, query: o.query ?? [], headers: signedHeaders, payloadHash: hash, region: o.region ?? s3.region, service: 's3', accessKeyId: o.key ?? ACCESS, secretAccessKey: o.secret ?? SECRET, date });
  const qs = (o.query ?? []).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  const { host: _, ...sent } = headers;
  return fetch(`${s3.origin}${uriEncode(path, false)}${qs ? `?${qs}` : ''}`, { method, headers: { ...sent, authorization }, ...(o.body ? { body: o.body } : {}) });
}

test('the stand-in bucket takes only requests signed with its keys, and says why it refuses as S3 does', async () => {
  const s3 = await startS3({ buckets: ['trips'] });
  try {
    const put = await send(s3, 'PUT', '/trips/annai/a b+c.annai.zip', { body: new TextEncoder().encode('zip bytes'), hash: 'UNSIGNED-PAYLOAD' });
    assert.equal(put.status, 200);
    assert.equal(s3.objects('trips').get('annai/a b+c.annai.zip')?.toString(), 'zip bytes');
    const got = await send(s3, 'GET', '/trips/annai/a b+c.annai.zip');
    assert.deepEqual([got.status, await got.text()], [200, 'zip bytes']);
    const code = async (/** @type {Response} */ r) => /<Code>([^<]+)<\/Code>/.exec(await r.text())?.[1];
    assert.equal(await code(await send(s3, 'GET', '/trips/annai/x', { secret: 'wrong secret' })), 'SignatureDoesNotMatch');
    assert.equal(await code(await send(s3, 'GET', '/trips/annai/x', { key: 'AKIAWRONG' })), 'InvalidAccessKeyId');
    const region = await send(s3, 'GET', '/trips', { region: 'eu-west-1', query: [['list-type', '2']] });
    assert.match(await region.text(), /<Code>AuthorizationHeaderMalformed<\/Code>.*<Region>us-east-1<\/Region>/s);
    assert.equal(await code(await send(s3, 'PUT', '/trips/k', { body: new TextEncoder().encode('x'), hash: EMPTY_SHA256 })), 'XAmzContentSHA256Mismatch');
    assert.equal(await code(await send(s3, 'GET', '/trips/k', { signed: ['host', 'x-amz-date'] })), 'AccessDenied');
    assert.equal(await code(await send(s3, 'GET', '/nothing', { query: [['list-type', '2']] })), 'NoSuchBucket');
    assert.equal(await code(await send(s3, 'GET', '/trips/missing')), 'NoSuchKey');
    s3.denyNext('AccessDenied');
    assert.equal((await send(s3, 'GET', '/trips/annai/a b+c.annai.zip')).status, 403);
    const pre = await fetch(`${s3.origin}/trips/annai/x`, { method: 'OPTIONS', headers: { origin: 'https://annai.guide', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,x-amz-date,x-amz-content-sha256' } });
    assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [200, '*']);
  } finally {
    await s3.stop();
  }
});

test('the stand-in lists by prefix, a page at a time, and deletes', async () => {
  const s3 = await startS3({ buckets: ['trips'], pageSize: 2 });
  try {
    for (const k of ['annai/a', 'annai/b', 'annai/c', 'other/d']) s3.putAs('trips', k, 'x');
    /** @type {string[]} */
    const keys = [];
    let token = '';
    for (let i = 0; i < 5; i++) {
      const res = await send(s3, 'GET', '/trips', { query: [['list-type', '2'], ['prefix', 'annai/'], ...(token ? /** @type {[string, string][]} */ ([['continuation-token', token]]) : [])] });
      const body = await res.text();
      keys.push(...[...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]));
      if (!body.includes('<IsTruncated>true</IsTruncated>')) break;
      token = /<NextContinuationToken>([^<]+)</.exec(body)?.[1] ?? '';
    }
    assert.deepEqual(keys, ['annai/a', 'annai/b', 'annai/c']);
    assert.equal((await send(s3, 'DELETE', '/trips/annai/b')).status, 204);
    assert.deepEqual([...s3.objects('trips').keys()].sort(), ['annai/a', 'annai/c', 'other/d']);
  } finally {
    await s3.stop();
  }
});
