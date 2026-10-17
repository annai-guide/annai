import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

/**
 * A stand-in for an S3-compatible bucket, path-style (/bucket/key): ListObjectsV2, PUT, GET and
 * DELETE of objects, with S3's XML errors and CORS. Every request's Signature Version 4 is checked
 * by code of its own (node:crypto), from the request as it arrived, against the stand-in's keys.
 * Tests and the end-to-end suite run it on a port of its own (port 0).
 */

export const ACCESS = 'AKIASTANDIN000000001';
export const SECRET = 'standin/secret/key/0123456789abcdefghij';

/** RFC 3986 encoding, written apart from annai's own. @param {string} s */
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** @param {string} s */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** @param {string | Buffer} key @param {string} data */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
/** @param {string} s */
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{ buckets?: string[], region?: string, pageSize?: number, cors?: boolean }} [o]
 *   cors: whether it answers browsers (a bucket without CORS rules doesn't)
 */
export async function startS3({ buckets = ['trips'], region = 'us-east-1', pageSize = 1000, cors = true } = {}) {
  /** @type {Map<string, Map<string, { data: Buffer, modified: Date }>>} */
  const all = new Map(buckets.map((b) => [b, new Map()]));
  /** @type {{ method: string, path: string, status: number, code?: string }[]} */
  const log = [];
  /** @type {string | null} */
  let deny = null;
  /** @type {{ method: string, body: string, status?: number } | null} */
  let garble = null;

  /**
   * Why a request's signature doesn't hold, or null when it does.
   * @param {import('node:http').IncomingMessage} req @param {Buffer} body
   * @returns {{ code: string, message: string, region?: string } | null}
   */
  function refuse(req, body) {
    const auth = String(req.headers.authorization ?? '');
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) return { code: 'AccessDenied', message: 'The Authorization header is missing or malformed.' };
    const [, key, day, theirs, signedList, signature] = m;
    if (key !== ACCESS) return { code: 'InvalidAccessKeyId', message: 'The AWS Access Key Id you provided does not exist in our records.' };
    if (theirs !== region) return { code: 'AuthorizationHeaderMalformed', message: `The authorization header is malformed; the region '${theirs}' is wrong; expecting '${region}'`, region };
    const date = String(req.headers['x-amz-date'] ?? '');
    const when = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    if (date.slice(0, 8) !== day || !Number.isFinite(when)) return { code: 'AccessDenied', message: 'x-amz-date is missing or does not match the credential.' };
    if (Math.abs(when - Date.now()) > 15 * 60_000) return { code: 'RequestTimeTooSkewed', message: 'The difference between the request time and the current time is too large.' };
    const payload = String(req.headers['x-amz-content-sha256'] ?? '');
    if (!payload) return { code: 'InvalidRequest', message: 'Missing required header for this request: x-amz-content-sha256' };
    if (payload !== 'UNSIGNED-PAYLOAD' && payload !== createHash('sha256').update(body).digest('hex')) {
      return { code: 'XAmzContentSHA256Mismatch', message: "The provided 'x-amz-content-sha256' header does not match what was computed." };
    }
    const signed = signedList.split(';');
    if (!['host', 'x-amz-date', 'x-amz-content-sha256'].every((h) => signed.includes(h))) return { code: 'AccessDenied', message: 'host, x-amz-date and x-amz-content-sha256 must be signed.' };
    const raw = req.url ?? '/';
    const at = raw.indexOf('?');
    const path = at < 0 ? raw : raw.slice(0, at);
    const query = at < 0 ? '' : raw.slice(at + 1).split('&').filter(Boolean)
      .map((p) => p.split('=').map((x) => rfc3986(decodeURIComponent(x ?? ''))))
      .map(([k, v = '']) => [k, v]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    const headers = signed.map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonical = [req.method, path, query, headers, signedList, payload].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, `${day}/${theirs}/s3/aws4_request`, sha256(canonical)].join('\n');
    let k = hmac(`AWS4${SECRET}`, day);
    for (const part of [theirs, 's3', 'aws4_request']) k = hmac(k, part);
    return createHmac('sha256', k).update(toSign).digest('hex') === signature ? null
      : { code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided. Check your key and signing method.' };
  }

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const corsHeaders = cors ? { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } : {};
      /** @param {number} status @param {string | Buffer} out @param {Record<string, string>} [headers] @param {string} [code] */
      const reply = (status, out, headers = {}, code) => {
        log.push({ method: req.method ?? '', path: url.pathname, status, ...(code ? { code } : {}) });
        res.writeHead(status, { ...corsHeaders, ...headers });
        res.end(out);
      };
      /** @param {number} status @param {{ code: string, message: string, region?: string }} e */
      const error = (status, e) => reply(status, `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${e.code}</Code><Message>${xmlEscape(e.message)}</Message>${e.region ? `<Region>${e.region}</Region>` : ''}<RequestId>standin</RequestId></Error>`, { 'content-type': 'application/xml' }, e.code);
      if (req.method === 'OPTIONS') {
        if (!cors) return reply(403, '');
        return reply(200, '', { 'access-control-allow-methods': 'GET, PUT, DELETE, HEAD', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? ''), 'access-control-max-age': '3600' });
      }
      const why = refuse(req, body);
      if (why) return error(why.code === 'AuthorizationHeaderMalformed' || why.code === 'InvalidRequest' ? 400 : 403, why);
      if (garble && req.method === garble.method) {
        const g = garble;
        garble = null;
        return reply(g.status ?? 200, g.body, { 'content-type': 'application/xml' });
      }
      if (deny) {
        const code = deny;
        deny = null;
        return error(403, { code, message: 'Access Denied' });
      }
      const [, bucketName, ...rest] = decodeURIComponent(url.pathname).split('/');
      const bucket = all.get(bucketName);
      if (!bucket) return error(404, { code: 'NoSuchBucket', message: 'The specified bucket does not exist' });
      const key = rest.join('/');
      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') ?? '';
        const after = url.searchParams.get('continuation-token') ? Buffer.from(String(url.searchParams.get('continuation-token')), 'base64').toString() : '';
        const max = Math.min(pageSize, Number(url.searchParams.get('max-keys') ?? 1000));
        const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, max);
        const truncated = keys.length > page.length;
        const contents = page.map((k) => {
          const o = /** @type {{ data: Buffer, modified: Date }} */ (bucket.get(k));
          return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>"${createHash('md5').update(o.data).digest('hex')}"</ETag><Size>${o.data.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        }).join('');
        const next = truncated ? `<NextContinuationToken>${Buffer.from(page.at(-1) ?? '').toString('base64')}</NextContinuationToken>` : '';
        return reply(200, `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucketName}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`, { 'content-type': 'application/xml' });
      }
      if (req.method === 'PUT' && key) {
        bucket.set(key, { data: body, modified: new Date() });
        return reply(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
      }
      if (req.method === 'GET' && key) {
        const o = bucket.get(key);
        return o ? reply(200, o.data, { 'content-type': 'application/octet-stream' }) : error(404, { code: 'NoSuchKey', message: 'The specified key does not exist.' });
      }
      if (req.method === 'DELETE' && key) {
        bucket.delete(key);
        return reply(204, '');
      }
      return error(400, { code: 'InvalidRequest', message: 'The stand-in does not do that.' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return {
    origin, region, log,
    /** @param {string} bucket */
    objects: (bucket) => new Map([...(all.get(bucket) ?? new Map())].map(([k, o]) => [k, o.data])),
    /** Another device's file. @param {string} bucket @param {string} key @param {string | Buffer} data */
    putAs: (bucket, key, data) => { all.get(bucket)?.set(key, { data: Buffer.from(data), modified: new Date() }); },
    /** The next signed request with this method gets this answer instead: a broken or hostile server. @param {{ method: string, body: string, status?: number }} g */
    garbleNext: (g) => { garble = g; },
    /** The next signed request is refused with this code. @param {string} code */
    denyNext: (code) => { deny = code; },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
