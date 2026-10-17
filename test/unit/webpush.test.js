import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPush, PLAINTEXT_MAX } from '../../src/core/push/webpush.js';
import { toBase64Url, fromBase64Url, utf8, text } from '../../src/core/bytes.js';
import { decryptPush, testSubscription } from '../fakes/push-service.js';

/** @param {string} s */
const b = (s) => /** @type {Uint8Array} */ (fromBase64Url(s.replace(/\s+/g, '')));
/** RFC 8291 §5 and Appendix A. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};
const P256 = { name: 'ECDH', namedCurve: 'P-256' };

/** A P-256 key pair from the RFC's raw keys. @param {string} pub @param {string} priv */
async function pair(pub, priv) {
  const raw = b(pub);
  const jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(raw.slice(1, 33)), y: toBase64Url(raw.slice(33)), d: priv };
  return {
    publicKey: await crypto.subtle.importKey('raw', /** @type {any} */ (raw), P256, true, []),
    privateKey: await crypto.subtle.importKey('jwk', jwk, P256, false, ['deriveBits']),
  };
}

test("RFC 8291's example: the same keys and salt give the same message, byte for byte", async () => {
  const body = await encryptPush({ p256dh: b(RFC.uaPublic), auth: b(RFC.auth) }, utf8(RFC.plaintext), { salt: b(RFC.salt), keys: await pair(RFC.asPublic, RFC.asPrivate) });
  assert.equal(toBase64Url(body), RFC.body.replace(/\s+/g, ''));
});

test("the receiver's private key opens it: the RFC's message, and new ones padded to one size", async () => {
  const ua = await pair(RFC.uaPublic, RFC.uaPrivate);
  const to = { p256dh: b(RFC.uaPublic), auth: b(RFC.auth), privateKey: ua.privateKey };
  assert.equal(text(await decryptPush(to, b(RFC.body))), RFC.plaintext);
  const short = await encryptPush(to, utf8('Leave soon.'), { pad: 3072 });
  const long = await encryptPush(to, utf8('x'.repeat(3000)), { pad: 3072 });
  assert.equal(short.length, 86 + 3072 + 16);
  assert.equal(long.length, short.length, 'a long reminder and a short one are the same size');
  assert.equal(text(await decryptPush(to, short)), 'Leave soon.');
  assert.equal(text(await decryptPush(to, long)), 'x'.repeat(3000));
  const again = await encryptPush(to, utf8('Leave soon.'), { pad: 3072 });
  assert.notEqual(toBase64Url(again), toBase64Url(short), 'a new salt and key for every message');
});

test('a subscription made as a browser makes one', async () => {
  const sub = await testSubscription('https://push.example');
  assert.equal(sub.p256dh.length, 65);
  assert.equal(sub.auth.length, 16);
  const body = await encryptPush(sub, utf8('明日 8:00 出発'), { pad: 256 });
  assert.equal(text(await decryptPush(sub, body)), '明日 8:00 出発');
});

test('what it refuses, in plain words', async () => {
  const sub = await testSubscription('https://push.example');
  await assert.rejects(encryptPush({ ...sub, p256dh: sub.p256dh.slice(1) }, utf8('x')), /isn't a P-256 public key/);
  const off = sub.p256dh.slice();
  off[64] ^= 1;
  await assert.rejects(encryptPush({ ...sub, p256dh: off }, utf8('x')), /isn't a P-256 public key/, 'a point off the curve (RFC 8291 §7)');
  await assert.rejects(encryptPush({ ...sub, auth: sub.auth.slice(4) }, utf8('x')), /auth secret isn't 16 bytes/);
  await assert.rejects(encryptPush(sub, utf8('x'.repeat(100)), { pad: 64 }), /holds at most 63 bytes/);
  await assert.rejects(encryptPush(sub, new Uint8Array(PLAINTEXT_MAX + 1)), /holds at most 3993 bytes/);
  assert.equal((await encryptPush(sub, new Uint8Array(PLAINTEXT_MAX))).length, 4096, 'the largest fits the 4096 bytes push services take');
});

test('base64url both ways; what is not base64url is null', () => {
  const bytes = Uint8Array.from([0, 255, 62, 63, 250, 251]);
  assert.equal(toBase64Url(bytes), 'AP8-P_r7');
  assert.deepEqual(fromBase64Url('AP8-P_r7'), bytes);
  assert.deepEqual(fromBase64Url('AP8'), Uint8Array.from([0, 255]));
  assert.deepEqual(fromBase64Url('AP8='), Uint8Array.from([0, 255]), 'padding is allowed');
  for (const bad of ['AP8+', 'A', 'AP8/', 'a b', '==']) assert.equal(fromBase64Url(bad), null, bad);
});
