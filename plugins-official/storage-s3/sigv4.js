/**
 * AWS Signature Version 4 on WebCrypto: the Authorization header S3-compatible storage checks.
 * Checked against AWS's own test suite (test/unit/sigv4.test.js) and a real S3 gateway
 * (test/live/s3-live.test.js).
 */

const enc = new TextEncoder();

/** The SHA-256 of nothing, the payload hash of a request without a body. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** @param {ArrayBuffer} b */
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** @param {Uint8Array<ArrayBuffer>} bytes */
export async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** @param {Uint8Array<ArrayBuffer>} key @param {string} data @returns {Promise<Uint8Array<ArrayBuffer>>} */
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

/**
 * Percent-encoding as SigV4 wants it (RFC 3986): every byte but A–Z, a–z, 0–9, "-", ".", "_" and "~",
 * in upper-case hex. With encodeSlash false, "/" stays, as in an S3 object's path.
 * @param {string} s @param {boolean} [encodeSlash]
 */
export function uriEncode(s, encodeSlash = true) {
  let out = '';
  for (const b of enc.encode(s)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~]/.test(c) || (!encodeSlash && c === '/') ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** "20261016T180405Z", the form x-amz-date takes. @param {Date} d */
export function amzDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * Signs one request.
 * @param {{ method: string, path: string, query?: [string, string][], headers: Record<string, string>, payloadHash: string,
 *   region: string, service: string, accessKeyId: string, secretAccessKey: string, date: string }} r
 *   path and query as they are, not yet encoded; headers: all of them signed, host and x-amz-date among them
 * @returns {Promise<{ authorization: string, canonicalRequest: string, stringToSign: string, signature: string }>}
 */
export async function signV4(r) {
  /** @type {Record<string, string>} */
  const lower = {};
  for (const [k, v] of Object.entries(r.headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const query = (r.query ?? [])
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [r.method, uriEncode(r.path, false), query, names.map((n) => `${n}:${lower[n]}\n`).join(''), signedHeaders, r.payloadHash].join('\n');
  const day = r.date.slice(0, 8);
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', r.date, scope, await sha256Hex(enc.encode(canonicalRequest))].join('\n');
  let key = await hmac(enc.encode(`AWS4${r.secretAccessKey}`), day);
  for (const part of [r.region, r.service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex((await hmac(key, stringToSign)).buffer);
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest, stringToSign, signature,
  };
}
