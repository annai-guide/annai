import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newVapidJwk, readVapidKey, vapidJwt, vapidAuthorization } from '../../relay/src/vapid.js';
import { toB64u, fromB64u } from '../../relay/src/b64.js';
import { verifyVapid, startPushService } from '../fakes/push-service.js';
import { encryptPush } from '../../src/core/push/webpush.js';
import { utf8 } from '../../src/core/bytes.js';

/** RFC 8292 §2.4, Figures 1 and 2. */
const RFC_JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA';
const RFC_K = 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs';
const RFC_EXP = 1453523768;
const AUD = 'https://push.example.net';

test("the stand-in push service takes RFC 8292's example token, and refuses it otherwise", async () => {
  const header = `vapid t=${RFC_JWT}, k=${RFC_K}`;
  const at = (RFC_EXP - 3600) * 1000;
  assert.deepEqual(await verifyVapid(header, { aud: AUD, now: at }), { aud: AUD, exp: RFC_EXP, sub: 'mailto:push@example.com' });
  await assert.rejects(verifyVapid(header, { aud: AUD, now: (RFC_EXP + 1) * 1000 }), /BadJwtToken/, 'expired');
  await assert.rejects(verifyVapid(header, { aud: 'https://other.example', now: at }), /BadJwtToken/, 'for another push service');
  await assert.rejects(verifyVapid(header.replace('.i3CYb7', '.i3CYb8'), { aud: AUD, now: at }), /BadJwtToken/, 'a changed signature');
  await assert.rejects(verifyVapid(header, { aud: AUD, now: at, key: 'BOther' }), /VapidPkHashMismatch/, 'not the key the subscription was made with');
  await assert.rejects(verifyVapid(`WebPush ${RFC_JWT}`, { aud: AUD, now: at }), /BadAuthorizationHeader/);
  await assert.rejects(verifyVapid(undefined, { aud: AUD, now: at }), /BadAuthorizationHeader/);
});

test("the relay's tokens: ES256, for the push service's origin, at most a day ahead, with a contact", async () => {
  const key = await readVapidKey(await newVapidJwk());
  const raw = fromB64u(key.publicKey);
  assert.equal(raw?.length, 65);
  assert.equal(raw?.[0], 4, 'the uncompressed point browsers subscribe with');
  const now = Date.parse('2026-11-27T08:00:00Z');
  const exp = now / 1000 + 12 * 3600;
  const jwt = await vapidJwt(key, { aud: 'https://web.push.apple.com', exp, sub: 'https://annai.guide' });
  const header = vapidAuthorization(jwt, key.publicKey);
  assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64u(jwt.split('.')[0]) ?? new Uint8Array())), { typ: 'JWT', alg: 'ES256' });
  assert.equal(fromB64u(jwt.split('.')[2])?.length, 64, 'r and s, 32 bytes each (JWS ES256)');
  assert.deepEqual(await verifyVapid(header, { aud: 'https://web.push.apple.com', now, key: key.publicKey }), { aud: 'https://web.push.apple.com', exp, sub: 'https://annai.guide' });
  const far = await vapidJwt(key, { aud: 'https://web.push.apple.com', exp: now / 1000 + 25 * 3600, sub: 'https://annai.guide' });
  await assert.rejects(verifyVapid(vapidAuthorization(far, key.publicKey), { aud: 'https://web.push.apple.com', now }), /BadJwtToken/, 'more than a day ahead: Apple refuses it');
  const bare = await vapidJwt(key, { aud: 'https://web.push.apple.com', exp, sub: 'annai' });
  await assert.rejects(verifyVapid(vapidAuthorization(bare, key.publicKey), { aud: 'https://web.push.apple.com', now }), /BadJwtToken/, 'a subject that is neither mailto: nor https:');
});

test('the VAPID secret: read as keys.mjs makes it; anything else refused, naming VAPID_KEY', async () => {
  const jwk = JSON.parse(await newVapidJwk());
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  const bad = ['', 'not json', '{"kty":"RSA"}', JSON.stringify({ ...jwk, d: undefined }), JSON.stringify({ ...jwk, x: 'short' }), JSON.stringify({ ...jwk, d: 'AAAA' })];
  for (const text of bad) await assert.rejects(readVapidKey(text), /VAPID_KEY/, text);
  await assert.rejects(readVapidKey(undefined), /VAPID_KEY/);
});

test('base64url both ways, strictly', () => {
  const bytes = Uint8Array.from([0, 255, 62, 63, 250, 251]);
  assert.equal(toB64u(bytes), 'AP8-P_r7');
  assert.deepEqual(fromB64u('AP8-P_r7'), bytes);
  assert.deepEqual(fromB64u('AP8'), Uint8Array.from([0, 255]));
  for (const bad of ['AP8=', 'AP8+', 'A', 'a b', 5]) assert.equal(fromB64u(/** @type {any} */ (bad)), null, String(bad));
});

test('the stand-in push service opens what a valid request brings, and refuses the rest as Apple does', async () => {
  const key = await readVapidKey(await newVapidJwk());
  const service = await startPushService();
  try {
    const sub = await service.subscribe(key.publicKey);
    const body = /** @type {any} */ (await encryptPush(sub, utf8('Leave soon.'), { pad: 3072 }));
    const jwt = await vapidJwt(key, { aud: service.origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: 'https://annai.guide' });
    const headers = { TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', Authorization: vapidAuthorization(jwt, key.publicKey) };
    const ok = await fetch(sub.endpoint, { method: 'POST', headers, body });
    assert.equal(ok.status, 201);
    const got = service.received.at(-1);
    assert.equal(got?.plaintext, 'Leave soon.');
    assert.equal(got?.bytes, 3174);
    assert.equal(got?.claims.aud, service.origin);
    /** @type {[Record<string, string>, number, string][]} */
    const cases = [
      [{ ...headers, TTL: 'soon' }, 400, 'BadTtl'],
      [{ ...headers, Urgency: 'now' }, 400, 'BadUrgency'],
      [{ ...headers, 'Content-Encoding': 'aesgcm' }, 400, 'BadWebPushRequest'],
      [{ ...headers, Authorization: 'Bearer abc' }, 403, 'BadAuthorizationHeader'],
    ];
    for (const [h, status, reason] of cases) {
      const res = await fetch(sub.endpoint, { method: 'POST', headers: h, body });
      assert.equal(res.status, status, reason);
      assert.equal((await res.json()).reason, reason);
    }
    assert.equal((await fetch(sub.endpoint, { method: 'POST', headers, body: /** @type {any} */ (new Uint8Array(4097)) })).status, 413);
    assert.equal((await fetch(`${service.origin}/push/nobody`, { method: 'POST', headers, body })).status, 404);
    service.answer(429, 500);
    assert.equal((await fetch(sub.endpoint, { method: 'POST', headers, body })).status, 429);
    assert.equal((await fetch(sub.endpoint, { method: 'POST', headers, body })).status, 500);
    service.drop(sub.endpoint);
    assert.equal((await fetch(sub.endpoint, { method: 'POST', headers, body })).status, 410);
  } finally {
    await service.stop();
  }
});
