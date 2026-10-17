import http from 'node:http';

/**
 * A stand-in push service (RFC 8030) for the relay's tests and the end-to-end ones. It checks each
 * request the way Apple documents it (TTL, Urgency, aes128gcm, at most 4096 bytes, a VAPID token for
 * this service signed with the key the subscription was made with) with code of its own (RFC 8292),
 * and decrypts the message with the subscription's private key (RFC 8291), as the phone would. Its
 * HKDF is built from HMAC, not the page's code. It keeps what it received.
 * @typedef {{ endpoint: string, p256dh: Uint8Array, auth: Uint8Array, privateKey: CryptoKey, serverKey?: string }} TestSubscription
 *   serverKey: the relay's VAPID public key it was made with
 */

const te = new TextEncoder();
const td = new TextDecoder();
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
/** @param {string} s */
const b64u = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
/** @param {Uint8Array} b */
const tob64u = (b) => Buffer.from(b).toString('base64url');

/** @param {any} key bytes @param {any} data bytes */
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF with one block of output, from HMAC (RFC 5869 §2.2, §2.3). @param {Uint8Array} salt @param {Uint8Array} ikm @param {Uint8Array} info @param {number} len */
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, Buffer.concat([info, Buffer.from([1])]))).slice(0, len);
}

/** A subscription as a browser makes one: a P-256 key pair and a 16-byte auth secret. @param {string} origin @param {string} [serverKey] @returns {Promise<TestSubscription>} */
export async function testSubscription(origin, serverKey) {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(P256, true, ['deriveBits']));
  return {
    endpoint: `${origin}/push/${tob64u(crypto.getRandomValues(new Uint8Array(12)))}`,
    p256dh: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    auth: crypto.getRandomValues(new Uint8Array(16)),
    privateKey: pair.privateKey,
    ...(serverKey ? { serverKey } : {}),
  };
}

/**
 * Opens an aes128gcm push message (RFC 8291 §3.4, RFC 8188 §2). Throws on anything else.
 * @param {{ privateKey: CryptoKey, p256dh: Uint8Array, auth: Uint8Array }} to @param {Uint8Array} body @returns {Promise<Uint8Array>}
 */
export async function decryptPush(to, body) {
  if (body.length < 21) throw new Error('too short for an aes128gcm header');
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  if (idlen !== 65 || sealed.length < 17 || sealed.length > rs) throw new Error('not one aes128gcm record with a P-256 key');
  const as = await crypto.subtle.importKey('raw', asPublic, P256, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, to.privateKey, 256));
  const ikm = await hkdf(to.auth, secret, Buffer.concat([te.encode('WebPush: info\0'), to.p256dh, asPublic]), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== 2) throw new Error('no last-record delimiter');
  return record.slice(0, end);
}

/**
 * Checks a VAPID Authorization header (RFC 8292) and returns its claims; throws Error(reason) with
 * Apple's reasons. key: the VAPID public key the subscription was made with.
 * @param {string | undefined} header @param {{ aud: string, now: number, key?: string }} o
 */
export async function verifyVapid(header, { aud, now, key }) {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), ?k=([\w-]+)$/.exec(String(header ?? ''));
  if (!m) throw new Error('BadAuthorizationHeader');
  if (key && m[2] !== key) throw new Error('VapidPkHashMismatch');
  /** @type {CryptoKey} */
  let pub;
  try {
    pub = await crypto.subtle.importKey('raw', b64u(m[2]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    throw new Error('BadVapidPublicKey');
  }
  const [h, c, s] = m[1].split('.');
  /** @type {any} */
  let head;
  /** @type {any} */
  let claims;
  try {
    head = JSON.parse(td.decode(b64u(h)));
    claims = JSON.parse(td.decode(b64u(c)));
  } catch {
    throw new Error('BadJwtToken');
  }
  if (head?.alg !== 'ES256') throw new Error('BadJwtToken');
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64u(s), te.encode(`${h}.${c}`)))) throw new Error('BadJwtToken');
  const t = now / 1000;
  if (claims?.aud !== aud || !(claims.exp > t) || claims.exp > t + 86_400 || !/^(?:mailto:|https:)/.test(String(claims.sub ?? ''))) throw new Error('BadJwtToken');
  return claims;
}

/**
 * @typedef {{ path: string, headers: import('node:http').IncomingHttpHeaders, bytes: number, status: number, reason: string | null, claims: any, plaintext: string | null }} Received
 * @param {{ now?: () => number }} [o] now: the clock tokens are checked against (a test's own)
 */
export async function startPushService({ now = () => Date.now() } = {}) {
  /** @type {Map<string, TestSubscription & { gone?: boolean }>} by path */
  const subs = new Map();
  /** @type {Received[]} */
  const received = [];
  /** @type {number[]} */
  const forced = [];
  let origin = '';
  /** @param {import('node:http').IncomingMessage} req @param {string} path @param {Uint8Array} body @param {Received} got @returns {Promise<[number, string | null]>} */
  async function check(req, path, body, got) {
    if (req.method !== 'POST') return [405, 'MethodNotAllowed'];
    const sub = subs.get(path);
    if (!sub) return [404, 'BadPath'];
    if (sub.gone) return [410, 'Unregistered'];
    const f = forced.shift();
    if (f) return [f, 'Forced'];
    if (!/^\d+$/.test(String(req.headers.ttl ?? ''))) return [400, 'BadTtl'];
    if (req.headers.urgency !== undefined && !['very-low', 'low', 'normal', 'high'].includes(String(req.headers.urgency))) return [400, 'BadUrgency'];
    if (req.headers['content-encoding'] !== 'aes128gcm') return [400, 'BadWebPushRequest'];
    if (body.length > 4096) return [413, 'PayloadTooLarge'];
    try {
      got.claims = await verifyVapid(req.headers.authorization, { aud: origin, now: now(), key: sub.serverKey });
    } catch (e) {
      return [403, String(/** @type {any} */ (e)?.message)];
    }
    try {
      got.plaintext = td.decode(await decryptPush(sub, body));
    } catch {
      return [400, 'BadWebPushRequest'];
    }
    return [201, null];
  }
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      /** @type {Received} */
      const got = { path, headers: req.headers, bytes: body.length, status: 0, reason: null, claims: null, plaintext: null };
      const [status, reason] = await check(req, path, body, got);
      got.status = status;
      got.reason = reason;
      received.push(got);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reason ? { reason } : {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return {
    origin,
    received,
    /** A new subscription at this service, made with the relay's VAPID public key. @param {string} [serverKey] */
    async subscribe(serverKey) {
      const s = await testSubscription(origin, serverKey);
      subs.set(new URL(s.endpoint).pathname, s);
      return s;
    },
    /** The next answers, whatever the request (429, 500…). @param {...number} statuses */
    answer: (...statuses) => { forced.push(...statuses); },
    /** The subscription is gone (the user turned notifications off): 410 from now on. @param {string} endpoint */
    drop: (endpoint) => {
      const s = subs.get(new URL(endpoint).pathname);
      if (s) s.gone = true;
    },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
