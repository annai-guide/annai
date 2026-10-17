import { signV4, uriEncode, amzDate, EMPTY_SHA256 } from './sigv4.js';

/**
 * S3-compatible storage as a place for annai's backups (spec §12.4): AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO and the like. Each backup is one archive file in a folder of the bucket.
 * The bucket must allow browser access (CORS); the place's screen shows the exact rules to paste.
 * @typedef {{ endpoint: string, region: string, bucket: string, prefix: string, key: string, secret: string,
 *   TargetError: any, xml: { elements: (x: string, n: string) => string[], text: (x: string, n: string) => string | null },
 *   backupFiles: { parse: (name: string) => any }, read: (res: Response, how: string, where: string) => Promise<any>,
 *   net: (url: string, init?: RequestInit) => Promise<Response> }} S
 *   read: annai's reader of a server's answer: whatever is wrong with an answer is the bucket's doing, never a bug here
 */

const PREFIX = 'annai/';

/** The CORS rules a bucket needs for annai at this origin, as the AWS and Cloudflare consoles take them. @param {string} origin */
export function corsRules(origin) {
  return JSON.stringify([{
    AllowedOrigins: [origin],
    AllowedMethods: ['GET', 'PUT', 'DELETE'],
    AllowedHeaders: ['authorization', 'content-type', 'x-amz-content-sha256', 'x-amz-date'],
    MaxAgeSeconds: 3600,
  }], null, 2);
}

/** The folder in the bucket: "annai/" unless the user named another; always ending in "/". @param {any} config */
const prefixOf = (config) => {
  const p = String(config.prefix || PREFIX).trim().replace(/^\/+/, '');
  return p.endsWith('/') ? p : `${p}/`;
};

/** @param {any} annai */
export function activate(annai) {
  const { TargetError, xml, backupFiles, readAnswer } = annai.helpers;
  /** @param {any} c @returns {S} */
  const client = (c) => ({
    endpoint: String(c.config.endpoint ?? '').trim().replace(/\/+$/, ''),
    region: String(c.config.region ?? '').trim() || 'us-east-1',
    bucket: String(c.config.bucket ?? '').trim(),
    prefix: prefixOf(c.config),
    key: String(c.secret.accessKeyId ?? '').trim(),
    secret: String(c.secret.secretAccessKey ?? '').trim(),
    TargetError, xml, backupFiles, read: readAnswer, net: annai.net.fetch,
  });
  return annai.storage.register({
    type: 's3',
    name: 'S3-compatible storage',
    stores: 'file',
    fields: [
      { key: 'endpoint', label: 'S3 address', placeholder: 'https://s3.us-east-1.amazonaws.com' },
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      { key: 'bucket', label: 'Bucket', placeholder: 'my-annai-backups' },
      { key: 'prefix', label: 'Folder in the bucket', placeholder: PREFIX, advanced: true },
    ],
    secret: [{ key: 'accessKeyId', label: 'Access key ID' }, { key: 'secretAccessKey', label: 'Secret access key' }],
    help: "Use a bucket of its own for annai's backups, and an access key that may only list, read, write and delete in it. The bucket must allow browser access: paste the rules below into its CORS settings.",
    where: (/** @type {any} */ config) => `${String(config.bucket || 'bucket')}/${prefixOf(config)}`,
    browserAccess: (/** @type {string} */ origin) => ({
      text: "Paste these rules into the bucket's CORS settings. On AWS: the bucket → Permissions → Cross-origin resource sharing (CORS) → Edit. On Cloudflare R2: the bucket → Settings → CORS policy → Edit.",
      code: corsRules(origin),
    }),
    check: (/** @type {any} */ c) => check(client(c)),
    list: (/** @type {any} */ c) => list(client(c)),
    put: (/** @type {any} */ c, /** @type {any} */ a, /** @type {any} */ o) => put(client(c), a, o),
    get: (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ o) => get(client(c), id, o),
    delete: (/** @type {any} */ c, /** @type {string} */ id) => remove(client(c), id),
  });
}

/** Whether text is a web address annai may use: https, or http on this computer (for testing). @param {string} u */
function webAddress(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

/** What can be told without asking the bucket. @param {S} s */
function ready(s) {
  const E = s.TargetError;
  if (!webAddress(s.endpoint)) throw new E('setup', 'Check the S3 address: it must be a web address that starts with https://.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s.bucket)) throw new E('setup', "Check the bucket's name: lowercase letters, digits, dots and dashes.");
  if (!s.key || !s.secret) throw new E('setup', 'Paste the access key ID and the secret access key, then save.');
}

/** Where a key of the bucket is: AWS addresses take the bucket in the host name, unless its name has a dot. @param {S} s @param {string} key */
function where(s, key) {
  const u = new URL(s.endpoint);
  const virtual = /\.amazonaws\.com$/.test(u.hostname) && !s.bucket.includes('.');
  return virtual
    ? { origin: `${u.protocol}//${s.bucket}.${u.host}`, host: `${s.bucket}.${u.host}`, path: `/${key}` }
    : { origin: u.origin, host: u.host, path: `/${s.bucket}${key ? `/${key}` : ''}` };
}

/**
 * One signed request (Signature Version 4). A body goes as UNSIGNED-PAYLOAD: hashing a whole archive
 * would need all of it in memory.
 * @param {S} s @param {string} method @param {string} key @param {{ query?: [string, string][], body?: Blob, signal?: AbortSignal }} [o]
 */
async function call(s, method, key, { query = [], body, signal } = {}) {
  const t = where(s, key);
  const date = amzDate(new Date());
  const payloadHash = body === undefined ? EMPTY_SHA256 : 'UNSIGNED-PAYLOAD';
  const headers = { host: t.host, 'x-amz-date': date, 'x-amz-content-sha256': payloadHash };
  const { authorization } = await signV4({ method, path: t.path, query, headers, payloadHash, region: s.region, service: 's3', accessKeyId: s.key, secretAccessKey: s.secret, date });
  const qs = query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  const { host: _, ...sent } = headers; // the browser sends Host itself
  return s.net(`${t.origin}${uriEncode(t.path, false)}${qs ? `?${qs}` : ''}`, {
    method, signal,
    headers: { ...sent, authorization, ...(body === undefined ? {} : { 'content-type': 'application/octet-stream' }) },
    ...(body === undefined ? {} : { body }),
  });
}

/** A refusal from the bucket in plain words. @param {S} s @param {Response} res */
async function failure(s, res) {
  const body = await s.read(res, 'text', s.bucket).catch(() => '');
  const code = s.xml.text(body, 'Code') ?? '';
  const E = s.TargetError;
  if (code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') return new E('auth', `${s.bucket} didn't accept the access key. Check the key ID and the secret, then save.`);
  if (code === 'AuthorizationHeaderMalformed' || code === 'PermanentRedirect' || code === 'IllegalLocationConstraintException') {
    const region = s.xml.text(body, 'Region');
    return new E('setup', region ? `${s.bucket} is in the region ${region}. Set Region to ${region}, then save.` : `${s.bucket} is in another region. Set Region to the bucket's region, then save.`);
  }
  if (code === 'RequestTimeTooSkewed') return new E('setup', "This device's clock is more than 15 minutes off, so the bucket refused it. Set the clock to the network's time, then try again.");
  if (code === 'NoSuchBucket') return new E('missing', `There is no bucket ${s.bucket} at ${new URL(s.endpoint).host}. Check the name and the address.`);
  if (code === 'NoSuchKey') return new E('missing', 'That backup is no longer in the bucket.');
  if (code === 'AccessDenied' || res.status === 403) return new E('refused', `The access key isn't allowed to do this in ${s.bucket}. Give it permission to list, read, write and delete objects there.`);
  if (code === 'SlowDown' || res.status === 503) return new E('rate', 'The bucket asked annai to slow down. annai tries again in a few minutes.', { retryAt: Date.now() + 5 * 60_000 });
  return new E('other', `The bucket refused this (HTTP ${res.status}${code ? `: ${code}` : ''}). annai tries again later.`);
}

/** @param {S} s */
async function check(s) {
  ready(s);
  /** @type {Response} */
  let res;
  try {
    res = await call(s, 'GET', '', { query: [['list-type', '2'], ['max-keys', '1'], ['prefix', s.prefix]] });
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError' || e instanceof s.TargetError) throw e;
    // To a web page, a bucket without CORS rules looks like no answer at all.
    throw new s.TargetError('setup', `annai couldn't reach ${s.bucket}. If this device is online, the bucket doesn't allow browser access yet: paste the rules below into its CORS settings, then test again.`);
  }
  if (!res.ok) throw await failure(s, res);
  return { note: `Works: annai can reach ${s.bucket} and keep its backups in ${s.prefix}.` };
}

/** The backups in the folder, newest first; other files are left alone. @param {S} s */
async function list(s) {
  ready(s);
  /** @type {any[]} */
  const out = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    /** @type {[string, string][]} */
    const query = [['list-type', '2'], ['prefix', s.prefix], ...(token ? /** @type {[string, string][]} */ ([['continuation-token', token]]) : [])];
    const res = await call(s, 'GET', '', { query });
    if (!res.ok) throw await failure(s, res);
    const body = await s.read(res, 'text', s.bucket);
    for (const c of s.xml.elements(body, 'Contents')) {
      const name = (s.xml.text(c, 'Key') ?? '').slice(s.prefix.length);
      const b = name.includes('/') ? null : s.backupFiles.parse(name);
      if (b) out.push(b);
    }
    token = s.xml.text(body, 'IsTruncated') === 'true' ? s.xml.text(body, 'NextContinuationToken') ?? '' : '';
    if (!token) break;
  }
  return out.sort((a, b) => b.at - a.at);
}

/** @param {S} s @param {{ blob: Blob, name: string }} archive @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o] */
async function put(s, archive, { onProgress = () => {}, signal } = {}) {
  ready(s);
  onProgress({ phase: 'uploading', done: 0, total: 1 });
  const res = await call(s, 'PUT', s.prefix + archive.name, { body: archive.blob, signal });
  if (!res.ok) throw await failure(s, res);
  onProgress({ phase: 'uploading', done: 1, total: 1 });
  return { id: archive.name, at: s.backupFiles.parse(archive.name)?.at ?? Date.now(), uploaded: archive.blob.size, files: 1 };
}

/** @param {S} s @param {string} id @param {{ onProgress?: (p: any) => void, signal?: AbortSignal }} [o] */
async function get(s, id, { onProgress = () => {}, signal } = {}) {
  ready(s);
  onProgress({ phase: 'downloading', done: 0, total: 1 });
  const res = await call(s, 'GET', s.prefix + id, { signal });
  if (!res.ok) throw await failure(s, res);
  const blob = await s.read(res, 'blob', s.bucket);
  onProgress({ phase: 'downloading', done: 1, total: 1 });
  return blob;
}

/** Deletes one backup; one that is already gone is no error. @param {S} s @param {string} id */
async function remove(s, id) {
  ready(s);
  const res = await call(s, 'DELETE', s.prefix + id);
  if (!res.ok && res.status !== 404) throw await failure(s, res);
}
