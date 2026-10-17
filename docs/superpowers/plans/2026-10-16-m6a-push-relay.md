# Milestone 6a: The push relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The push relay of spec §11.6, built and tested without Cloudflare:
- **The page's encryption** (`src/core/push/webpush.js`): RFC 8291 `aes128gcm` on WebCrypto's ECDH, HKDF and AES-GCM, checked against RFC 8291's worked example byte for byte.
- **The relay** (`relay/`): a Cloudflare Worker with one Durable Object per push subscription. `GET /v1/vapid`, `POST /v1/schedule`, `DELETE /v1/schedule/:id` with the cancel token. It stores `{push endpoint, ciphertext, sendAt, id, cancel token}`, sends at `sendAt` (RFC 8030, VAPID per RFC 8292 with an ES256 JWT signed on WebCrypto), and deletes the record after sending or on expiry. Abuse limits: payloads up to 4 KB, 200 pending per subscription, 30 days ahead, a rate limit per IP. Zero dependencies.
- **A stand-in push service** (`test/fakes/push-service.js`) on port 0 that checks the VAPID token and decrypts with a test subscription's private key, with code of its own: the page's encryption → relay → push service → plaintext, end to end in Node.
- **A Node runner** (`relay/serve.mjs`): the same Worker code with in-memory storage, for a real locked-iPhone test over the tailnet before the user deploys.
- **Deploy instructions** (`relay/README.md`) for the user's own Cloudflare account.

Milestone 6b (`docs/superpowers/plans/2026-10-16-m6b-notifications.md`, its own plan) is annai's side: what is mirrored at the relay, the service worker's notifications, Settings → Notifications, and opening a notification starting a catch-up wake.

**Architecture:**
- `relay/src/relay.js` exports `makeRelay({ now, send })`, which returns `{ worker, PushRelay }`: the Worker's `fetch` (validation, CORS, rate limit, routing to the subscription's object) and the Durable Object class (storage, alarm, sending). `relay/src/index.js` is the Worker's entry for wrangler: Cloudflare's clock and fetch.
- `relay/src/vapid.js` makes and reads the VAPID key (a JWK) and signs tokens; `relay/src/b64.js` is base64url. The relay imports nothing from `src/`, so `relay/` can be deployed on its own.
- `relay/memory.js` holds Durable Objects in memory (a namespace, storage, alarms on timers or run by hand) and a rate limiter like Cloudflare's binding. The tests and `relay/serve.mjs` use it; Cloudflare doesn't.
- The relay is not shipped to the browser: it is not in `sw.js` `SHELL`, so `scripts/size.mjs` doesn't count it. `tsconfig.json` type-checks it.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies (the Workers runtime has WebCrypto and fetch; so has Node).
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26). No wrangler or miniflare in `package.json`; deploying uses `npx wrangler@4` from `relay/`.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`. This plan covers:
- §11.6 the relay: scope of what it stores, encryption, the API, abuse limits, deployment
- §2 principle 1 ("stores only encrypted, expiring messages"), §3 ("push relay (optional, separate service)")
- §19 hosting (`push.annai.guide`, a Cloudflare Worker) and the repository layout (`relay/`)
- §15 keys never in files: the VAPID private key is a Worker secret

Milestone 6 is done when "a reminder arrives on a locked iPhone and opens a catch-up wake" (§20 row 6). This plan's part: Task 4's end-to-end test (encryption → relay → push service → plaintext), and the runner the device test uses.

**Not in this plan:** everything on annai's side (milestone 6b).

## Choices this plan makes (please check them)

1. **One Durable Object per push subscription**, named by the SHA-256 of its endpoint (base64url). A reminder's id is that name, a dot, and 22 random base64url characters. So `DELETE /v1/schedule/:id` finds its object from the id alone.
   - **The page may choose the 22 characters.** annai writes the id down before sending, so a schedule cut off by a crash or a lost answer is sent again with the same id and token, and kept once. The relay makes one up when none is given.
2. **The cancel token is the page's**, 22 to 128 base64url characters, sent only as `Authorization: Bearer …`, on the schedule and on the cancel. It is never in a URL or a body, so annai's trace, which keeps the URL and status of each request, never holds it. The relay keeps it beside the reminder and compares it in constant time.
3. **The push services the relay sends to:** Google's (`fcm.googleapis.com`, `android.googleapis.com`: Chrome, Android, Samsung Internet, Edge on Android), Apple's (`*.push.apple.com`), Mozilla's (`*.push.services.mozilla.com`) and Microsoft's (`*.notify.windows.com`), over https only. Any other endpoint is refused, so nobody can use the relay to send requests to other servers.
   - The cost if wrong: a browser on another push service gets "the endpoint isn't the address of a push service this relay sends to". Adding its host is one line.
   - `EXTRA_PUSH_ORIGINS` adds exact origins, for the stand-in push service in tests.
   - **Each service's own path shape too** (the fix pass): `/fcm/send/…` or `/wp/…` at Google, `/gcm/send/…` on the old host, a non-empty path at Apple, `/wpush/vN/…` at Mozilla, `/w/?token=…` at Microsoft. And only a 201 confirms a subscription (RFC 8030 §5); another 2xx takes the reminder and confirms nothing.
4. **Every reminder is padded to the same size before it is encrypted** (milestone 6b sends 3,072 bytes of record, so 3,174 bytes on the wire). The relay can't tell a long reminder from a short one. The spec promises it learns only the endpoint, the timing and how many; RFC 8291 §7 warns that length leaks otherwise. The relay itself only checks the size: from 103 bytes (the smallest `aes128gcm` message) to 4,096.
5. **The abuse limits** (spec §11.6):
   - a reminder's encrypted payload: at most 4,096 bytes, the most push services must take (RFC 8030 §7.2), and Apple's limit;
   - 200 waiting per subscription;
   - `sendAt` from 5 minutes ago (sent at once) to 30 days ahead;
   - 60 requests a minute from one IP, an IPv6 address counted by its /64 (the review's fix pass lowered it from 300: one address stays under the Free plan's 100,000 requests a day). On Cloudflare this is the rate-limit binding, which counts per Cloudflare location and approximately; in Node, an exact counter. A preflight (`OPTIONS`) isn't counted;
   - a schedule request's body: at most 8 KB; an endpoint, at most 2,048 characters.
6. **Sending:**
   - **Headers:** `TTL` (the page's; by default an hour), `Urgency: high` (Apple: "to attempt to deliver the notification immediately, specify high"), `Content-Encoding: aes128gcm`.
   - **429, 5xx, or no connection:** tried again after 30 s, doubling to at most 10 minutes, until an hour after its time; then dropped ("on expiry").
   - **404 or 410:** the subscription is gone, so everything waiting for it is deleted.
   - **403:** once more with a new token.
   - **Any other refusal (400, 413):** dropped.
   - A reminder is deleted, token and all, as soon as the push service takes it.
7. **VAPID tokens** live 12 hours and are reused until an hour is left (Apple: "Don't refresh your JWT more frequently than once per hour"; RFC 8292: at most 24 hours). `sub` is `VAPID_SUBJECT`, by default `https://annai.guide`. Apple refuses a subject that is neither a URL nor `mailto:`, and has been seen refusing `mailto:…@localhost`.
8. **The VAPID key pair** is one Worker secret, `VAPID_KEY`: a P-256 JWK printed by `node relay/keys.mjs` and piped straight into `wrangler secret put`, so the private key is never written to a file. No test fixture holds a key either: the tests make throwaway keys as they run.
   - **Losing or replacing it costs nothing permanent.** The page sends the public key it subscribed with on every schedule, and the relay answers 409 when it differs; milestone 6b then subscribes again by itself.
9. **Durable Objects with SQLite storage** (`new_sqlite_classes`): the kind the Workers Free plan has. The relay uses only the key-value API and the alarm, which SQLite-backed objects support.
10. **The relay keeps no logs.** `[observability] enabled = false`, and the code never logs an endpoint, an id or a payload.
11. **The Node runner keeps everything in memory.** Restarting it forgets the reminders waiting; it says so. Its VAPID key is a file only its owner can read (`~/.config/annai-relay/vapid.json` unless `--keys` says otherwise), so phones stay subscribed across restarts. It refuses ports 8765 and 8790–8792.
12. **`workers_dev = false` and a custom domain route** (`push.annai.guide`). That needs annai.guide's DNS on Cloudflare; `relay/README.md` says what to change when it isn't (the `workers.dev` address, set in annai's Settings).
13. **Until a subscription has had one push through the relay, it keeps only 3 reminders, due within 10 minutes** (added in the security pass, Task 5). Anyone can make up endpoints at a push service's host with the relay's public key, and each would get its own object with 200 reminders for 30 days; now a made-up one costs three small reminders, and only until its push service refuses the first send (404 or 410 deletes everything).
    - **A reminder due now is sent in the same request,** and the answer says whether the push service took it (`sent: true`, or 410 "gone"). Milestone 6b sends a "notifications are on" notification when the user turns them on, which confirms the subscription at once and shows the whole chain works.
    - **The confirmation is kept 60 days after the last push** (with the VAPID token, which Apple says to renew at most hourly), then forgotten; a 404 or 410 forgets it at once.
    - **The worst case,** stated in `relay/README.md`: from one address, about 3,000 made-up reminders (about 10 MB), each gone within 10 minutes, or an hour if the push services fail.
    - The cost if wrong: a phone's first reminders beyond three wait until its first notification has arrived, seconds after turning notifications on.
14. **The security pass also made** (Task 5):
    - **A request body is read piece by piece, and no further than 8 KB.** A chunked body without Content-Length can't fill the relay's memory.
    - **The rate limit per address is never missing.** Without Cloudflare's binding, the relay counts each address itself, per isolate. On Cloudflare the address is `CF-Connecting-IP`, which Cloudflare sets. `relay/serve.mjs` takes the last X-Forwarded-For entry when the connection comes from a proxy on the same machine (`tailscale serve`), and the connection's own address otherwise. A client can't choose its address; without one it shares the bucket `unknown`, which limits more, not less.
    - **One alarm sends at most 25 reminders,** and the next alarm goes straight on. Each send may take 15 seconds before it is tried again later. A long or killed alarm resumes rather than resends: each reminder is read again before it is sent, and deleted as soon as it is.
    - **Listing a subscription's reminders reads at most 200 small records,** without their payloads, which are kept apart (`p:<id>`).

## Global Constraints

- **Zero runtime dependencies** (spec §2 principle 3, §19). Dev dependencies stay TypeScript, Playwright and `@types/node`; no wrangler or miniflare in `package.json`.
- **The relay "stores only encrypted, expiring messages"** (§2) and "learns only the push endpoint, the timing, and how many reminders there are" (§11.6). It never decrypts, logs or keeps anything after sending.
- **"Abuse limits live on the relay: payloads up to 4 KB, at most 200 pending per subscription, at most 30 days ahead, and rate limits per IP"** (§11.6).
- **"Each push subscription gets its own Durable Object, which holds that subscription's pending messages and uses its alarm to fire at the next sendAt"** (§11.6).
- **API:** `GET /v1/vapid` (the public key), `POST /v1/schedule`, `DELETE /v1/schedule/:id` (requires the cancel token) (§11.6).
- **Keys never in files** (§15): the VAPID private key is a Worker secret; no fixture holds one.
- **Ports:** stand-in servers listen on port 0; never 8765, 8790, 8791 or 8792.
- **Copy:** every error says what happened and what to do next, in plain words: `{ error: <code>, message: <words> }`.
- **Before every commit:** `npm run stamp && npm run check && git commit …`, chained with `&&`. The relay isn't shipped, so `sw.js` doesn't change in this plan except for `src/core/push/webpush.js` and `src/core/bytes.js` (Task 1).

## Verified facts (checked 2026-10-16)

- **RFC 8291 Appendix A reproduces on WebCrypto in Node 26:** ECDH `deriveBits` gives `kyrL1jII…`, HKDF gives IKM `S4lYMb_L…`, CEK `oIhVW04M…`, nonce `4h_95klX…`, and the 144-byte body of §5 (`DGv6ra1n…a-fN`), record size 4096, delimiter 0x02 only.
- **RFC 8292 §2.4's example JWT verifies** with WebCrypto ECDSA P-256 SHA-256 over `header.claims` with the signature as r‖s (64 bytes): JWS ES256 is exactly WebCrypto's ECDSA output.
- **Apple** ("Sending web push notifications in web apps and browsers"):
  - Safari "doesn't support invisible push notifications… If you don't, Safari revokes the push notification permission for your site."
  - `TTL` must be a positive number (`BadTtl`); `Urgency` one of very-low, low, normal, high (`BadUrgency`); "To attempt to deliver the notification immediately, specify `high`."
  - `BadJwtToken` covers: a missing JWT, the wrong key, a subject "isn't a URL or `mailto:`", an audience that "isn't the origin of the push service", an expiry "more than one day into the future".
  - `VapidPkHashMismatch`: the key doesn't match the one given to `PushManager.subscribe`. `PayloadTooLarge`: "over the limit of 4 KB". 410: "The device token has expired."
  - "Don't refresh your JWT more frequently than once per hour." "allow access for `https://*.push.apple.com`."
- **WebKit's source** (`webpushd/WebPushDaemon.mm`, `Shared/WebPushDaemonConstants.h`): a push whose handler doesn't call `showNotification` within a timeout increments a stored silent-push count; at `maxSilentPushCount = 3` WebKit removes all the origin's subscriptions. The count is never reset, and there is no exception when the app is on screen. `PushMessageCrypto.cpp` strips RFC 8188 padding (0x02 then zeros).
- **Cloudflare:**
  - Durable Objects on the Free plan: "Only Durable Objects with SQLite storage backend are available"; 100,000 requests a day (alarms count), 5 GB stored.
  - SQLite-backed objects support the async key-value API (`get`, `put`, `delete`, `list({ prefix })`) and `getAlarm`, `setAlarm`, `deleteAlarm`.
  - One alarm per object, at least once, retried on exceptions with backoff (up to 6 times).
  - `[[migrations]] tag = "v1" new_sqlite_classes = [...]` is still accepted (a newer `exports` form exists; a Worker uses one or the other).
  - The rate-limit binding: `[[ratelimits]] name, namespace_id, simple = { limit, period }`, with the period 10 or 60 seconds; `env.X.limit({ key })` gives `{ success }`. It is "local to the Cloudflare location" and "permissive, eventually consistent". It needs Wrangler 4.36.0 or later.

## Review Focus

1. **A reminder cancelled while the alarm is sending it.** Cloudflare lets a request run while the alarm awaits its fetch. Expected: no crash, no reminder sent twice, nothing left behind. Pinned in Task 4: the alarm reads each reminder again after sending, and deletes by key.
2. **A schedule cut off after the relay stored it** (the answer lost). The page sends it again with the same id and token. Expected: kept once, sent once. Pinned in Task 3.
3. **An endpoint that isn't a push service** (`https://evil.example`, `http://`, a look-alike host, a userinfo URL). Expected: refused before anything is stored or sent. Pinned in Task 3.
4. **The push service gone for good (410) with many waiting.** Expected: all of them deleted at the first 410, no retries. Pinned in Task 4.
5. **A relay without its secret** (deployed before `VAPID_KEY` was put). Expected: 503 with words that say what to do, never a crash or a 500. Pinned in Task 3.

## File map

- Create `src/core/push/webpush.js`: `encryptPush`, `PLAINTEXT_MAX`.
- Modify `src/core/bytes.js`: `toBase64Url`, `fromBase64Url`.
- Create `relay/src/b64.js`, `relay/src/vapid.js`, `relay/src/relay.js`, `relay/src/index.js`.
- Create `relay/memory.js`, `relay/serve.mjs`, `relay/keys.mjs`, `relay/wrangler.toml`, `relay/README.md`.
- Create `test/fakes/push-service.js`: `testSubscription`, `decryptPush`, `verifyVapid`, `startPushService`.
- Create `test/unit/webpush.test.js`, `test/unit/vapid.test.js`, `test/unit/relay-kit.js`, `test/unit/relay.test.js`, `test/unit/relay-send.test.js`, `test/unit/relay-serve.test.js`.
- Modify `tsconfig.json` (include `relay/`), `sw.js` (`SHELL`: `/src/core/push/webpush.js`).

---

### Task 1: The page's encryption (RFC 8291)

**Files:**
- Create: `src/core/push/webpush.js`
- Create: `test/fakes/push-service.js` (its decryption and test subscriptions; the server comes in Task 2)
- Modify: `src/core/bytes.js`, `sw.js` (`SHELL`)
- Test: `test/unit/webpush.test.js`

**Interfaces:**
- Consumes: `utf8`, `concat`, `ownBuffer`, `toBase64`, `fromBase64` from `src/core/bytes.js`.
- Produces:
  - `encryptPush(to: { p256dh: Uint8Array, auth: Uint8Array }, plaintext: Uint8Array, o?: { pad?: number, salt?: Uint8Array, keys?: CryptoKeyPair }): Promise<Uint8Array>`: the `aes128gcm` body. `pad` is the record size every message is padded to (plaintext, delimiter, zeros). Throws plain Errors: "The subscription's key isn't a P-256 public key.", "The subscription's auth secret isn't 16 bytes.", "A push message holds at most N bytes."
  - `PLAINTEXT_MAX = 3993`.
  - `toBase64Url(b: Uint8Array): string` (no padding); `fromBase64Url(s: string): Uint8Array | null` (padding optional; null when it isn't base64url).
  - In the fake: `testSubscription(origin: string, serverKey?: string): Promise<TestSubscription>` (`{ endpoint, p256dh, auth, privateKey, serverKey? }`), `decryptPush(to, body): Promise<Uint8Array>`.

- [ ] **Step 1: Write the failing test**

`test/unit/webpush.test.js`:

```js
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
    publicKey: await crypto.subtle.importKey('raw', raw, P256, true, []),
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/webpush.test.js`
Expected: FAIL: `src/core/push/webpush.js` and `test/fakes/push-service.js` don't exist.

- [ ] **Step 3: Write the implementation**

Add to `src/core/bytes.js`:

```js
/** Base64url without padding (RFC 4648 §5), the way Web Push writes keys and messages. @param {Uint8Array} b */
export function toBase64Url(b) {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of base64url (padding optional), or null when s isn't base64url. @param {string} s @returns {Uint8Array | null} */
export function fromBase64Url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const t = s.replace(/=+$/, '');
  if (t.length % 4 === 1 || (t.length < s.length && s.length % 4 !== 0)) return null; // padding only to a multiple of 4
  return fromBase64(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4));
}
```

`src/core/push/webpush.js`:

```js
import { utf8, concat, ownBuffer } from '../bytes.js';

/**
 * Web Push encryption (RFC 8291: aes128gcm, RFC 8188) on WebCrypto's ECDH, HKDF and AES-GCM. The
 * page encrypts each reminder itself with the push subscription's keys, so the relay never sees it
 * (spec §11.6).
 */

/** The record size the header states (RFC 8291 §4: one record, larger than what it holds). */
const RS = 4096;
/** The most plaintext one push carries: 4096 bytes, less the 86-byte header, the delimiter and the 16-byte tag (RFC 8291 §4). */
export const PLAINTEXT_MAX = 3993;
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
const BAD_KEY = "The subscription's key isn't a P-256 public key.";

/** HKDF-SHA-256 (RFC 5869): len bytes. @param {Uint8Array} salt @param {Uint8Array} ikm @param {Uint8Array} info @param {number} len */
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ownBuffer(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ownBuffer(salt), info: ownBuffer(info) }, key, len * 8));
}

/**
 * The aes128gcm body of a push message for a subscription (RFC 8291 §3.4 and §4).
 * @param {{ p256dh: Uint8Array, auth: Uint8Array }} to the subscription's public key (65 bytes, uncompressed) and auth secret (16 bytes)
 * @param {Uint8Array} plaintext
 * @param {{ pad?: number, salt?: Uint8Array, keys?: CryptoKeyPair }} [o]
 *   pad: the size every record is padded to (plaintext, the delimiter and zeros), so a message's length says nothing
 *   about it; salt, keys: fixed ones, only for the RFC's example (otherwise new for every message)
 * @returns {Promise<Uint8Array>}
 */
export async function encryptPush(to, plaintext, { pad, salt = crypto.getRandomValues(new Uint8Array(16)), keys } = {}) {
  if (!(to?.p256dh instanceof Uint8Array) || to.p256dh.length !== 65 || to.p256dh[0] !== 4) throw new Error(BAD_KEY);
  if (!(to.auth instanceof Uint8Array) || to.auth.length !== 16) throw new Error("The subscription's auth secret isn't 16 bytes.");
  const room = Math.min(pad ?? PLAINTEXT_MAX + 1, PLAINTEXT_MAX + 1);
  if (plaintext.length + 1 > room) throw new Error(`A push message holds at most ${room - 1} bytes.`);
  /** @type {CryptoKey} */
  let ua;
  try {
    ua = await crypto.subtle.importKey('raw', ownBuffer(to.p256dh), P256, false, []); // refuses a point off the curve (RFC 8291 §7)
  } catch {
    throw new Error(BAD_KEY);
  }
  const pair = keys ?? /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(P256, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, pair.privateKey, 256));
  const ikm = await hkdf(to.auth, secret, concat([utf8('WebPush: info\0'), to.p256dh, asPublic]), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const record = new Uint8Array(pad ?? plaintext.length + 1);
  record.set(plaintext);
  record[plaintext.length] = 2; // the last record's delimiter; the zeros after it are padding (RFC 8188 §2)
  const key = await crypto.subtle.importKey('raw', ownBuffer(cek), 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ownBuffer(nonce) }, key, ownBuffer(record)));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RS);
  header[20] = asPublic.length;
  return concat([header, asPublic, sealed]);
}
```

`test/fakes/push-service.js` (this task: subscriptions and decryption; Task 2 adds the server):

```js
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

/** @param {Uint8Array} key @param {Uint8Array} data */
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
```

In `sw.js` `SHELL`, add `'/src/core/push/webpush.js',` after `'/src/core/plugins.js',`.

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/webpush.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/push/webpush.js src/core/bytes.js sw.js test/fakes/push-service.js test/unit/webpush.test.js && git commit -m "The page encrypts a push message itself (RFC 8291), padded to one size, checked against the RFC's example byte for byte

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: VAPID tokens, and a stand-in push service that checks them

**Files:**
- Create: `relay/src/b64.js`, `relay/src/vapid.js`
- Modify: `test/fakes/push-service.js` (`verifyVapid`, `startPushService`), `tsconfig.json` (include `relay/**/*.js`, `relay/**/*.mjs`)
- Test: `test/unit/vapid.test.js`

**Interfaces:**
- Consumes: `encryptPush` (Task 1), `testSubscription`, `decryptPush`.
- Produces:
  - `toB64u(b: Uint8Array): string`, `fromB64u(s: string): Uint8Array | null` (strict: no padding).
  - `newVapidJwk(): Promise<string>`: a P-256 key pair as one line of JWK JSON `{kty, crv, x, y, d}`.
  - `readVapidKey(text: string | undefined): Promise<VapidKey>` where `VapidKey = { sign: CryptoKey, publicKey: string }` (the uncompressed point, base64url). Throws Errors that name `VAPID_KEY`.
  - `vapidJwt(key: VapidKey, claims: { aud: string, exp: number, sub: string }): Promise<string>` (exp in seconds).
  - `vapidAuthorization(jwt: string, publicKey: string): string`: `vapid t=…, k=…`.
  - Fake: `verifyVapid(header: string | undefined, o: { aud: string, now: number, key?: string }): Promise<{ aud, exp, sub }>`, throwing `Error(reason)` with Apple's reasons; `startPushService(o?: { now?: () => number }): Promise<PushService>` where `PushService = { origin, received: Received[], subscribe(serverKey?): Promise<TestSubscription>, answer(...statuses: number[]), drop(endpoint), stop() }` and `Received = { path, headers, bytes, status, reason, claims, plaintext }`.

- [ ] **Step 1: Write the failing test**

`test/unit/vapid.test.js`:

```js
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
    const body = await encryptPush(sub, utf8('Leave soon.'), { pad: 3072 });
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
    assert.equal((await fetch(sub.endpoint, { method: 'POST', headers, body: new Uint8Array(4097) })).status, 413);
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/vapid.test.js`
Expected: FAIL: `relay/src/vapid.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`relay/src/b64.js`:

```js
/** base64url without padding (RFC 4648 §5), the way Web Push writes keys, tokens and messages. @param {Uint8Array} b */
export function toB64u(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of base64url without padding, or null when s isn't that. @param {string} s @returns {Uint8Array | null} */
export function fromB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

`relay/src/vapid.js`:

```js
import { toB64u, fromB64u } from './b64.js';

/**
 * The relay's VAPID key (RFC 8292): who it is to push services. One P-256 key pair, kept as the
 * Worker secret VAPID_KEY in JWK form (choice 8), and ES256 tokens signed with it on WebCrypto.
 * @typedef {{ sign: CryptoKey, publicKey: string }} VapidKey  publicKey: the uncompressed point, base64url, as browsers subscribe with it
 */

const te = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

/** A new key pair, as one line of JWK JSON: { kty, crv, x, y, d }. @returns {Promise<string>} */
export async function newVapidJwk() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']));
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return JSON.stringify({ kty, crv, x, y, d });
}

/** Reads the VAPID_KEY secret; throws a plain Error naming what is wrong with it. @param {string | undefined} text @returns {Promise<VapidKey>} */
export async function readVapidKey(text) {
  /** @type {any} */
  let jwk = null;
  try {
    jwk = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('VAPID_KEY is missing, or is not the JSON that relay/keys.mjs prints.');
  }
  const x = fromB64u(jwk?.x);
  const y = fromB64u(jwk?.y);
  const d = fromB64u(jwk?.d);
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || x?.length !== 32 || y?.length !== 32 || d?.length !== 32) {
    throw new Error('VAPID_KEY must be a P-256 private key in JWK form (kty EC, crv P-256, x, y and d), as relay/keys.mjs prints it.');
  }
  /** @type {CryptoKey} */
  let sign;
  try {
    sign = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, ECDSA, false, ['sign']);
  } catch {
    throw new Error("VAPID_KEY isn't a key WebCrypto can sign with. Make a new one with relay/keys.mjs.");
  }
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  return { sign, publicKey: toB64u(raw) };
}

/** An ES256 JWT for one push service (RFC 8292 §2). @param {VapidKey} key @param {{ aud: string, exp: number, sub: string }} claims exp in seconds */
export async function vapidJwt(key, { aud, exp, sub }) {
  const part = (/** @type {any} */ o) => toB64u(te.encode(JSON.stringify(o)));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp, sub })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.sign, te.encode(input)));
  return `${input}.${toB64u(sig)}`;
}

/** The Authorization header's value (RFC 8292 §3). @param {string} jwt @param {string} publicKey */
export const vapidAuthorization = (jwt, publicKey) => `vapid t=${jwt}, k=${publicKey}`;
```

Add to `test/fakes/push-service.js`:

```js
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
```

In `tsconfig.json`, `include` becomes `["src/**/*.js", "plugins-official/**/*.js", "scripts/**/*.mjs", "relay/**/*.js", "relay/**/*.mjs", "playwright.config.js"]`.

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/vapid.test.js test/unit/webpush.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add relay/src/b64.js relay/src/vapid.js test/fakes/push-service.js test/unit/vapid.test.js tsconfig.json && git commit -m "The relay's VAPID key and ES256 tokens, and a stand-in push service that checks them and opens the message as a phone would

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: The relay's API, one Durable Object per subscription, and its limits

**Files:**
- Create: `relay/src/relay.js`, `relay/src/index.js`, `relay/memory.js`
- Create: `test/unit/relay-kit.js`
- Test: `test/unit/relay.test.js`

**Interfaces:**
- Consumes: `toB64u`, `fromB64u`, `readVapidKey`, `vapidJwt`, `vapidAuthorization` (Task 2).
- Produces:
  - `makeRelay(o?: { now?: () => number, send?: (url: string, init: RequestInit) => Promise<Response> }): { worker: { fetch(req: Request, env: Env): Promise<Response> }, PushRelay: class }`.
  - `Env = { RELAY: Namespace, VAPID_KEY?: string, VAPID_SUBJECT?: string, ORIGINS?: string, EXTRA_PUSH_ORIGINS?: string, LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> } }`.
  - `LIMITS = { payload: 4096, pending: 200, ahead: 30 days, behind: 5 min, body: 8192, endpoint: 2048, ttl: 2419200 }`, `RETRY_FOR` (1 hour, ms), `subscriptionName(endpoint): Promise<string>`, `pushEndpointAllowed(endpoint, extra?: string[]): boolean`.
  - HTTP: `GET /v1/vapid` → 200 `{ key }`. `POST /v1/schedule` with `Authorization: Bearer <token>` and JSON `{ endpoint, key, sendAt, ttl?, urgency?, payload, id? }` → 201 `{ id, sendAt }`. `DELETE /v1/schedule/:id` with the token → 204. Errors: `{ error, message }` with codes `token` 401, `size` 413, `json` 400, `key` 409, `endpoint` 400, `sendAt` 400, `ttl` 400, `urgency` 400, `payload` 400/413, `id` 400/409, `full` 429, `rate` 429 (Retry-After 60), `missing` 404, `setup` 503, `route` 404, `method` 405, `relay` 500.
  - Stored, per object: `m:<id>` → `{ id, endpoint, sendAt, next, ttl, urgency, token, tries }`, `p:<id>` → the payload (base64url), `jwt` → `{ aud, key, exp, token }` (Task 4).
  - `memoryNamespace(Class, env, o?: { now?, timers? })` → `{ idFromName, get, objects: Map<string, { obj, storage: MemoryStorage }>, runDue(), waiting(), close() }`; `MemoryStorage` with `get, put, delete, list({ prefix }), getAlarm, setAlarm, deleteAlarm, keys()`, `alarm`; `memoryLimiter(o?: { limit?, period?, now? })`.
  - `relayKit(o?: { limit?, statuses?, send?, extraPushOrigins? })` (test kit) → `{ env, key, sent, call(method, path, o?), reminder(o?), now(), after(ms), waiting(), stored(endpoint?), alarm(endpoint?) }`.

- [ ] **Step 1: Write the failing test**

`test/unit/relay-kit.js`:

```js
import { makeRelay, subscriptionName } from '../../relay/src/relay.js';
import { memoryNamespace, memoryLimiter } from '../../relay/memory.js';
import { newVapidJwk, readVapidKey } from '../../relay/src/vapid.js';
import { toB64u } from '../../relay/src/b64.js';

export const APP = 'https://annai.guide';
export const ENDPOINT = 'https://web.push.apple.com/QGuQyavXutnMei7Ldr5a6zf_deadbeef';
export const T0 = Date.parse('2026-11-27T08:00:00Z');
export const MIN = 60_000;
/** A cancel token, as the page makes one. */
export const token = () => toB64u(crypto.getRandomValues(new Uint8Array(32)));
/** n random bytes, base64url. @param {number} n */
export const bytes = (n) => toB64u(crypto.getRandomValues(new Uint8Array(n)));

/**
 * A relay in memory on a clock the test moves. It sends to a recorder that answers 201, or the
 * statuses given in turn (0: no connection), unless send is given (the real fetch, to a stand-in).
 * @param {{ limit?: number, statuses?: number[], send?: (url: string, init: any) => Promise<Response>, extraPushOrigins?: string[], subject?: string }} [o]
 */
export async function relayKit({ limit = 300, statuses = [], send, extraPushOrigins = [], subject } = {}) {
  let t = T0;
  /** @type {{ url: string, init: any }[]} */
  const sent = [];
  const answers = [...statuses];
  const record = async (/** @type {string} */ url, /** @type {any} */ init) => {
    sent.push({ url, init });
    const s = answers.shift() ?? 201;
    if (s === 0) throw new TypeError('fetch failed');
    return new Response(null, { status: s });
  };
  const { worker, PushRelay } = makeRelay({ now: () => t, send: send ?? record });
  const jwk = await newVapidJwk();
  /** @type {any} */
  const env = { VAPID_KEY: jwk, ORIGINS: `${APP}, http://127.0.0.1:8790`, EXTRA_PUSH_ORIGINS: extraPushOrigins.join(','), LIMIT: memoryLimiter({ limit, now: () => t }), ...(subject ? { VAPID_SUBJECT: subject } : {}) };
  env.RELAY = memoryNamespace(PushRelay, env, { now: () => t, timers: false });
  const key = (await readVapidKey(jwk)).publicKey;
  /**
   * @param {string} method @param {string} path
   * @param {{ body?: any, token?: string, origin?: string, ip?: string, headers?: Record<string, string> }} [o]
   */
  const call = async (method, path, o = {}) => {
    const headers = new Headers(o.headers ?? {});
    if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
    if (o.origin) headers.set('Origin', o.origin);
    headers.set('CF-Connecting-IP', o.ip ?? '203.0.113.7');
    if (o.body !== undefined) headers.set('Content-Type', 'application/json');
    const body = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    const res = await worker.fetch(new Request(`https://push.annai.guide${path}`, { method, headers, body }), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const object = async (/** @type {string} */ endpoint) => env.RELAY.objects.get(await subscriptionName(endpoint));
  return {
    env, key, sent, call,
    /** A valid schedule request's body, changed by o. @param {Record<string, any>} [o] */
    reminder: (o = {}) => ({ endpoint: ENDPOINT, key, sendAt: t + 10 * MIN, ttl: 3600, payload: bytes(3174), ...o }),
    now: () => t,
    /** Moves the clock, and fires the alarms that came due. @param {number} ms */
    async after(ms) {
      t += ms;
      await env.RELAY.runDue();
    },
    /** @returns {Promise<any[]>} every reminder waiting, in every object */
    waiting: () => env.RELAY.waiting(),
    /** Every key stored in a subscription's object. */
    async stored(endpoint = ENDPOINT) {
      return (await object(endpoint))?.storage.keys() ?? [];
    },
    /** The object's alarm. */
    async alarm(endpoint = ENDPOINT) {
      return (await object(endpoint))?.storage.alarm ?? null;
    },
  };
}
```

`test/unit/relay.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, subscriptionName, pushEndpointAllowed } from '../../relay/src/relay.js';
import { relayKit, APP, ENDPOINT, MIN, token, bytes } from './relay-kit.js';

test('GET /v1/vapid gives the public key; CORS answers annai and not other sites', async () => {
  const k = await relayKit();
  const r = await k.call('GET', '/v1/vapid', { origin: APP });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { key: k.key });
  assert.equal(r.headers.get('access-control-allow-origin'), APP);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await k.call('GET', '/v1/vapid', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null);
  const pre = await k.call('OPTIONS', '/v1/schedule', { origin: APP, headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), APP);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, DELETE');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  const none = await k.call('GET', '/nothing', { origin: APP });
  assert.equal(none.status, 404);
  assert.equal(none.body.error, 'route');
  assert.equal(none.headers.get('access-control-allow-origin'), APP, 'errors carry CORS too, so the page can read them');
  assert.equal((await k.call('PUT', '/v1/schedule')).status, 405);
});

test("POST /v1/schedule keeps the reminder in its subscription's own object, with the alarm at its time (spec §11.6)", async () => {
  const k = await relayKit();
  const tok = token();
  const rem = k.reminder();
  const r = await k.call('POST', '/v1/schedule', { body: rem, token: tok, origin: APP });
  assert.equal(r.status, 201);
  const name = await subscriptionName(ENDPOINT);
  assert.equal(r.body.id.split('.')[0], name);
  assert.match(r.body.id.split('.')[1], /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.body.sendAt, rem.sendAt);
  const [w] = await k.waiting();
  assert.deepEqual({ ...w }, { id: r.body.id, endpoint: ENDPOINT, sendAt: rem.sendAt, next: rem.sendAt, ttl: 3600, urgency: 'high', token: tok, tries: 0 });
  assert.deepEqual(await k.stored(), [`m:${r.body.id}`, `p:${r.body.id}`]);
  assert.equal(await k.alarm(), rem.sendAt);
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: rem.sendAt + MIN }), token: token() })).status, 201);
  assert.equal(await k.alarm(), rem.sendAt, 'the alarm stays at the earliest');
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: rem.sendAt - MIN }), token: token() })).status, 201);
  assert.equal(await k.alarm(), rem.sendAt - MIN, 'an earlier one moves it');
  await k.call('POST', '/v1/schedule', { body: k.reminder({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def' }), token: token() });
  assert.equal(k.env.RELAY.objects.size, 2, 'one object per subscription');
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ ttl: undefined, urgency: undefined }), token: token() })).status, 201, 'ttl and urgency have defaults');
});

test('the page may choose the id: the same schedule sent again is kept once; another token for it is refused', async () => {
  const k = await relayKit();
  const tok = token();
  const rem = k.reminder({ id: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const a = await k.call('POST', '/v1/schedule', { body: rem, token: tok });
  const b = await k.call('POST', '/v1/schedule', { body: rem, token: tok });
  assert.equal(a.status, 201);
  assert.deepEqual(b.body, a.body);
  assert.equal(a.body.id, `${await subscriptionName(ENDPOINT)}.AAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal((await k.waiting()).length, 1);
  const c = await k.call('POST', '/v1/schedule', { body: rem, token: token() });
  assert.equal(c.status, 409);
  assert.equal(c.body.error, 'id');
});

test('what the relay refuses, each in plain words (spec §11.6: abuse limits)', async () => {
  const k = await relayKit();
  const post = (/** @type {any} */ body, tok = token()) => k.call('POST', '/v1/schedule', { body, token: tok });
  const long = `https://web.push.apple.com/${'x'.repeat(LIMITS.endpoint)}`;
  /** @type {[any, number, string][]} */
  const cases = [
    [await k.call('POST', '/v1/schedule', { body: k.reminder() }), 401, 'token'],
    [await post(k.reminder(), 'short'), 401, 'token'],
    [await post('not json'), 400, 'json'],
    [await post([1]), 400, 'json'],
    [await post(k.reminder({ key: 'BOther' })), 409, 'key'],
    [await post(k.reminder({ endpoint: 'https://evil.example/push' })), 400, 'endpoint'],
    [await post(k.reminder({ endpoint: 'http://fcm.googleapis.com/fcm/send/x' })), 400, 'endpoint'],
    [await post(k.reminder({ endpoint: 'https://fcm.googleapis.com.evil.example/x' })), 400, 'endpoint'],
    [await post(k.reminder({ endpoint: 'https://me:pw@fcm.googleapis.com/x' })), 400, 'endpoint'],
    [await post(k.reminder({ endpoint: 'https://fcm.googleapis.com:8443/x' })), 400, 'endpoint'],
    [await post(k.reminder({ endpoint: 'not a url' })), 400, 'endpoint'],
    [await post(k.reminder({ endpoint: long })), 400, 'endpoint'],
    [await post(k.reminder({ sendAt: k.now() + LIMITS.ahead + 1 })), 400, 'sendAt'],
    [await post(k.reminder({ sendAt: k.now() - 6 * MIN })), 400, 'sendAt'],
    [await post(k.reminder({ sendAt: 'soon' })), 400, 'sendAt'],
    [await post(k.reminder({ ttl: -1 })), 400, 'ttl'],
    [await post(k.reminder({ ttl: 1.5 })), 400, 'ttl'],
    [await post(k.reminder({ urgency: 'now' })), 400, 'urgency'],
    [await post(k.reminder({ payload: bytes(LIMITS.payload + 1) })), 413, 'payload'],
    [await post(k.reminder({ payload: bytes(50) })), 400, 'payload'],
    [await post(k.reminder({ payload: 'not base64url!' })), 400, 'payload'],
    [await post(k.reminder({ id: 'short' })), 400, 'id'],
    [await post(JSON.stringify({ ...k.reminder(), more: 'x'.repeat(LIMITS.body) })), 413, 'size'],
  ];
  for (const [r, status, error] of cases) {
    assert.equal(r.status, status, error);
    assert.equal(r.body.error, error);
    assert.ok(typeof r.body.message === 'string' && r.body.message.length > 15, `${error}: ${r.body.message}`);
  }
  assert.deepEqual(await k.waiting(), [], 'nothing was kept');
  assert.equal(k.env.RELAY.objects.size, 0, 'no object was made for a refused request');
  assert.equal((await post(k.reminder({ sendAt: k.now() - 4 * MIN }))).status, 201, 'a few minutes ago is sent at once');
  assert.equal((await post(k.reminder({ payload: bytes(LIMITS.payload) }))).status, 201, '4096 bytes fit');
});

test('the push services it sends to (choice 3)', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://android.googleapis.com/gcm/send/x', 'https://web.push.apple.com/x', 'https://api.push.apple.com/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.equal(pushEndpointAllowed(ok), true, ok);
  for (const no of ['https://push.apple.com.evil.example/x', 'https://evilpush.apple.com/x', 'http://web.push.apple.com/x', 'https://storage.googleapis.com/x', 'ftp://fcm.googleapis.com/x']) assert.equal(pushEndpointAllowed(no), false, no);
  assert.equal(pushEndpointAllowed('http://127.0.0.1:4000/push/x', ['http://127.0.0.1:4000']), true, 'an origin the operator adds (tests)');
  assert.equal(pushEndpointAllowed('http://127.0.0.1:4001/push/x', ['http://127.0.0.1:4000']), false);
});

test('at most 200 waiting for one subscription; another has its own 200', async () => {
  const k = await relayKit({ limit: 1000 });
  for (let i = 0; i < LIMITS.pending; i++) assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ payload: bytes(200) }), token: token() })).status, 201);
  const full = await k.call('POST', '/v1/schedule', { body: k.reminder({ payload: bytes(200) }), token: token() });
  assert.equal(full.status, 429);
  assert.equal(full.body.error, 'full');
  assert.match(full.body.message, /200 reminders/);
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ endpoint: 'https://fcm.googleapis.com/fcm/send/other', payload: bytes(200) }), token: token() })).status, 201);
});

test('DELETE with the cancel token removes it, and nothing of it stays; another token, or none, changes nothing', async () => {
  const k = await relayKit();
  const tok = token();
  const { body } = await k.call('POST', '/v1/schedule', { body: k.reminder(), token: tok });
  assert.equal((await k.call('DELETE', `/v1/schedule/${body.id}`)).status, 401);
  const wrong = await k.call('DELETE', `/v1/schedule/${body.id}`, { token: token() });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'token');
  assert.equal((await k.waiting()).length, 1);
  const gone = await k.call('DELETE', `/v1/schedule/${body.id}`, { token: tok, origin: APP });
  assert.equal(gone.status, 204);
  assert.equal(gone.headers.get('access-control-allow-origin'), APP);
  assert.deepEqual(await k.stored(), [], 'its token and payload are gone too');
  assert.equal(await k.alarm(), null);
  const again = await k.call('DELETE', `/v1/schedule/${body.id}`, { token: tok });
  assert.equal(again.status, 404);
  assert.equal(again.body.error, 'missing');
  assert.equal((await k.call('DELETE', '/v1/schedule/not-an-id', { token: tok })).status, 404);
  assert.equal((await k.call('DELETE', `/v1/schedule/${'A'.repeat(43)}.${'B'.repeat(22)}`, { token: tok })).status, 404);
});

test('a limit per address: 429 with Retry-After; another address goes on; a preflight is not counted', async () => {
  const k = await relayKit({ limit: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await k.call('GET', '/v1/vapid', { ip: '198.51.100.1' })).status, 200);
  assert.equal((await k.call('OPTIONS', '/v1/schedule', { ip: '198.51.100.1' })).status, 204);
  const r = await k.call('GET', '/v1/vapid', { ip: '198.51.100.1', origin: APP });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'rate');
  assert.equal(r.headers.get('retry-after'), '60');
  assert.equal(r.headers.get('access-control-allow-origin'), APP);
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '198.51.100.2' })).status, 200);
  await k.after(61_000);
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '198.51.100.1' })).status, 200, 'a minute later');
});

test('a relay without its VAPID key says what to do, and keeps nothing', async () => {
  const k = await relayKit();
  k.env.VAPID_KEY = '';
  const r = await k.call('GET', '/v1/vapid');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'setup');
  assert.match(r.body.message, /relay\/README\.md/);
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder(), token: token() })).status, 503);
  assert.deepEqual(await k.waiting(), []);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/relay.test.js`
Expected: FAIL: `relay/src/relay.js` doesn't exist.

- [ ] **Step 3: Write the implementation**

`relay/memory.js`:

```js
/**
 * Durable Objects in memory, for running the relay in Node (relay/serve.mjs) and for its tests: a
 * namespace whose objects keep their storage in a Map, and whose alarms fire on timers (or, with
 * timers off, when runDue is called by a test that moves its own clock). Values are copied in and
 * out, as Cloudflare's storage does. Not used on Cloudflare.
 */

/** The longest wait setTimeout holds; a longer one is waited in steps. */
const LONGEST = 2 ** 31 - 1;

export class MemoryStorage {
  /** @type {Map<string, any>} */
  #data = new Map();
  /** @type {number | null} */
  alarm = null;
  #changed;
  /** @param {() => void} [changed] told when the alarm is set or deleted */
  constructor(changed = () => {}) {
    this.#changed = changed;
  }
  /** @param {string} key */
  async get(key) {
    return structuredClone(this.#data.get(key));
  }
  /** @param {string | Record<string, any>} key @param {any} [value] */
  async put(key, value) {
    if (typeof key === 'string') this.#data.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.#data.set(k, structuredClone(v));
  }
  /** @param {string | string[]} key */
  async delete(key) {
    if (!Array.isArray(key)) return this.#data.delete(key);
    let n = 0;
    for (const k of key) if (this.#data.delete(k)) n++;
    return n;
  }
  /** @param {{ prefix?: string }} [o] @returns {Promise<Map<string, any>>} */
  async list({ prefix = '' } = {}) {
    const keys = [...this.#data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.#data.get(k))]));
  }
  async getAlarm() {
    return this.alarm;
  }
  /** @param {number | Date} t */
  async setAlarm(t) {
    this.alarm = Number(t);
    this.#changed();
  }
  async deleteAlarm() {
    this.alarm = null;
    this.#changed();
  }
  /** Every key stored, sorted (tests). */
  keys() {
    return [...this.#data.keys()].sort();
  }
}

/**
 * @param {any} Class a Durable Object class: new Class({ storage }, env), with fetch(req) and alarm()
 * @param {any} env @param {{ now?: () => number, timers?: boolean }} [o]
 */
export function memoryNamespace(Class, env, { now = () => Date.now(), timers = true } = {}) {
  /** @typedef {{ obj: any, storage: MemoryStorage, timer: ReturnType<typeof setTimeout> | null }} Entry */
  /** @type {Map<string, Entry>} */
  const objects = new Map();
  /** @param {Entry} o */
  const arm = (o) => {
    if (!timers) return;
    if (o.timer) clearTimeout(o.timer);
    o.timer = null;
    if (o.storage.alarm === null) return;
    const step = () => {
      const left = /** @type {number} */ (o.storage.alarm) - now();
      if (left > 0) {
        o.timer = setTimeout(step, Math.min(left, LONGEST));
        return;
      }
      o.timer = null;
      o.storage.alarm = null;
      Promise.resolve(o.obj.alarm()).catch((/** @type {unknown} */ e) => console.warn('the relay alarm failed', e));
    };
    step();
  };
  /** @param {string} name @returns {Entry} */
  const object = (name) => {
    const had = objects.get(name);
    if (had) return had;
    /** @type {Entry} */
    const o = { obj: null, storage: /** @type {any} */ (null), timer: null };
    o.storage = new MemoryStorage(() => arm(o));
    o.obj = new Class({ storage: o.storage }, env);
    objects.set(name, o);
    return o;
  };
  return {
    /** @param {string} name */
    idFromName: (name) => ({ name, toString: () => name }),
    /** @param {{ name: string }} id */
    get: (id) => {
      const o = object(id.name);
      return { fetch: (/** @type {Request} */ req) => o.obj.fetch(req) };
    },
    objects,
    /** Fires every alarm due by now (a test that moves its own clock). */
    async runDue() {
      for (const o of objects.values()) {
        if (o.storage.alarm !== null && o.storage.alarm <= now()) {
          o.storage.alarm = null;
          await o.obj.alarm();
        }
      }
    },
    /** Every reminder waiting, in every object (tests). @returns {Promise<any[]>} */
    async waiting() {
      const out = [];
      for (const o of objects.values()) out.push(...(await o.storage.list({ prefix: 'm:' })).values());
      return out;
    },
    /** Stops the timers (a runner closing). */
    close() {
      for (const o of objects.values()) if (o.timer) clearTimeout(o.timer);
    },
  };
}

/**
 * A limit per key like Cloudflare's rate-limit binding: at most limit calls in each period (ms).
 * @param {{ limit?: number, period?: number, now?: () => number }} [o]
 */
export function memoryLimiter({ limit = 300, period = 60_000, now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  return {
    /** @param {{ key: string }} o */
    async limit({ key }) {
      const t = now();
      const recent = (seen.get(key) ?? []).filter((x) => x > t - period);
      const success = recent.length < limit;
      if (success) recent.push(t);
      seen.set(key, recent);
      return { success };
    },
  };
}
```

`relay/src/relay.js`:

```js
import { toB64u, fromB64u } from './b64.js';
import { readVapidKey, vapidJwt, vapidAuthorization } from './vapid.js';

/**
 * The push relay (spec §11.6): it keeps reminders the page encrypted, and sends each to its push
 * service at its time. A Cloudflare Worker with one Durable Object per push subscription, whose
 * alarm fires at the next sendAt. It never decrypts, logs or keeps anything after sending. No
 * dependencies: the Workers runtime has fetch and WebCrypto, and so has Node, where relay/serve.mjs
 * runs the same code.
 * @typedef {{ get: (key: string) => Promise<any>, put: (key: string | Record<string, any>, value?: any) => Promise<void>,
 *   delete: (key: string | string[]) => Promise<any>, list: (o?: { prefix?: string }) => Promise<Map<string, any>>,
 *   getAlarm: () => Promise<number | null>, setAlarm: (t: number) => Promise<void>, deleteAlarm: () => Promise<void> }} Storage
 * @typedef {{ storage: Storage }} State  a Durable Object's state, as the relay uses it
 * @typedef {{ idFromName: (name: string) => any, get: (id: any) => { fetch: (req: Request) => Promise<Response> } }} Namespace
 * @typedef {{ RELAY: Namespace, VAPID_KEY?: string, VAPID_SUBJECT?: string, ORIGINS?: string, EXTRA_PUSH_ORIGINS?: string,
 *   LIMIT?: { limit: (o: { key: string }) => Promise<{ success: boolean }> } }} Env
 * @typedef {{ id: string, endpoint: string, sendAt: number, next: number, ttl: number, urgency: string, token: string, tries: number }} Waiting
 *   a reminder waiting: next is when it is tried (sendAt, or later after a failure); tries, the failures so far
 */

const MIN = 60_000;
const DAY = 86_400_000;
/** The abuse limits (spec §11.6, choice 5). */
export const LIMITS = Object.freeze({ payload: 4096, pending: 200, ahead: 30 * DAY, behind: 5 * MIN, body: 8192, endpoint: 2048, ttl: 28 * 86_400 });
/** A reminder its push service won't take is tried again until this long after its time, then dropped (choice 6). */
export const RETRY_FOR = 60 * MIN;
/** A VAPID token lives 12 hours and is used until an hour is left (choice 7). */
const JWT_LIFE_S = 12 * 3600;
const JWT_RENEW_MS = 60 * MIN;
/** The smallest aes128gcm body: the 86-byte header, a delimiter and the 16-byte tag. */
const SMALLEST = 103;
const URGENCY = ['very-low', 'low', 'normal', 'high'];
const RAND = /^[A-Za-z0-9_-]{22}$/;
const ID = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{22,128})$/;
/** The push services browsers use (choice 3): Google's, Apple's, Mozilla's and Microsoft's. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(?:^|\.)push\.apple\.com$/, /(?:^|\.)push\.services\.mozilla\.com$/, /(?:^|\.)notify\.windows\.com$/];
const MISSING = 'There is no such reminder at the relay: it was sent, or cancelled.';

/**
 * Whether the relay sends to this endpoint: https on the standard port at a push service browsers
 * use, or an origin the operator added (EXTRA_PUSH_ORIGINS: the tests' stand-in).
 * @param {string} endpoint @param {string[]} [extra]
 */
export function pushEndpointAllowed(endpoint, extra = []) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (extra.includes(u.origin)) return true;
  return u.protocol === 'https:' && u.port === '' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** The name of a subscription's object: the SHA-256 of its endpoint, base64url (choice 1). @param {string} endpoint */
export async function subscriptionName(endpoint) {
  return toB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))));
}

/** @param {number} status @param {any} body @param {Record<string, string>} [headers] */
function reply(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { 'Cache-Control': 'no-store', ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
}

/** An error the page can show: a code, and what happened and what to do, in plain words. @param {number} status @param {string} error @param {string} message @param {Record<string, string>} [headers] */
const fail = (status, error, message, headers = {}) => reply(status, { error, message }, headers);

const notSetUp = () => fail(503, 'setup', 'This relay has no VAPID key yet. Its operator puts one in with relay/keys.mjs (see relay/README.md).');

/** Constant-time equality of two tokens. @param {unknown} a @param {unknown} b */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** @param {string | undefined} list a comma-separated setting */
const listOf = (list) => String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** @param {Request} req */
const bearer = (req) => BEARER.exec(req.headers.get('Authorization') ?? '')?.[1] ?? null;

/** The body as text, or null when it is larger than max bytes. @param {Request} req @param {number} max */
async function readBody(req, max) {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > max ? null : new TextDecoder().decode(bytes);
}

/** The VAPID key, read once for each secret it is given. @type {Map<string, Promise<import('./vapid.js').VapidKey | null>>} */
const keys = new Map();
/** @param {Env} env */
function vapid(env) {
  const text = String(env.VAPID_KEY ?? '');
  let k = keys.get(text);
  if (!k) {
    k = readVapidKey(text).catch(() => null);
    keys.set(text, k);
  }
  return k;
}

/**
 * The relay, on a clock and a fetch of its own (tests and Node give theirs).
 * @param {{ now?: () => number, send?: (url: string, init: RequestInit) => Promise<Response> }} [o]
 */
export function makeRelay({ now = () => Date.now(), send = (url, init) => fetch(url, init) } = {}) {
  /** @param {Request} req @param {Env} env @returns {Promise<Response>} */
  async function route(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return reply(204, null, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
    }
    if (env.LIMIT) {
      const { success } = await env.LIMIT.limit({ key: `ip:${req.headers.get('CF-Connecting-IP') ?? 'unknown'}` });
      if (!success) return fail(429, 'rate', 'Too many requests from this address. annai tries again in a minute.', { 'Retry-After': '60' });
    }
    if (pathname === '/v1/vapid') {
      if (req.method !== 'GET') return fail(405, 'method', 'Ask for the key with GET.');
      const key = await vapid(env);
      return key ? reply(200, { key: key.publicKey }) : notSetUp();
    }
    if (pathname === '/v1/schedule') return req.method === 'POST' ? schedule(req, env) : fail(405, 'method', 'Schedule a reminder with POST.');
    const m = /^\/v1\/schedule\/([^/]*)$/.exec(pathname);
    if (m) return req.method === 'DELETE' ? cancel(req, env, m[1]) : fail(405, 'method', 'Cancel a reminder with DELETE.');
    return fail(404, 'route', 'There is nothing at this address of the relay. Check the relay address in annai.');
  }

  /** POST /v1/schedule. @param {Request} req @param {Env} env */
  async function schedule(req, env) {
    const token = bearer(req);
    if (!token) return fail(401, 'token', "A reminder needs its cancel token in the Authorization header: Bearer, then 22 to 128 base64url characters.");
    const text = await readBody(req, LIMITS.body);
    if (text === null) return fail(413, 'size', `The request is larger than the ${LIMITS.body} bytes the relay reads.`);
    /** @type {any} */
    let b = null;
    try {
      b = JSON.parse(text);
    } catch {
      b = null;
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'json', 'The request must be a JSON object: endpoint, key, sendAt and payload.');
    const key = await vapid(env);
    if (!key) return notSetUp();
    if (b.key !== key.publicKey) return fail(409, 'key', "This relay's key isn't the one the phone subscribed with. annai subscribes again by itself.");
    if (typeof b.endpoint !== 'string' || b.endpoint.length > LIMITS.endpoint || !pushEndpointAllowed(b.endpoint, listOf(env.EXTRA_PUSH_ORIGINS))) {
      return fail(400, 'endpoint', "The endpoint isn't the address of a push service this relay sends to (Apple's, Google's, Mozilla's or Microsoft's, over https).");
    }
    const t = now();
    if (!Number.isSafeInteger(b.sendAt) || b.sendAt < t - LIMITS.behind || b.sendAt > t + LIMITS.ahead) {
      return fail(400, 'sendAt', 'sendAt must be a time in milliseconds, from a few minutes ago to 30 days ahead.');
    }
    const ttl = b.ttl ?? 3600;
    if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > LIMITS.ttl) return fail(400, 'ttl', `ttl must be whole seconds, from 0 to ${LIMITS.ttl}.`);
    const urgency = b.urgency ?? 'high';
    if (!URGENCY.includes(urgency)) return fail(400, 'urgency', `urgency must be one of: ${URGENCY.join(', ')}.`);
    const payload = typeof b.payload === 'string' ? fromB64u(b.payload) : null;
    if (!payload || payload.length < SMALLEST) return fail(400, 'payload', 'payload must be an encrypted push message (aes128gcm), in base64url.');
    if (payload.length > LIMITS.payload) return fail(413, 'payload', `A reminder may be at most ${LIMITS.payload} bytes, encrypted.`);
    const rand = b.id ?? toB64u(crypto.getRandomValues(new Uint8Array(16)));
    if (typeof rand !== 'string' || !RAND.test(rand)) return fail(400, 'id', 'id, when given, must be 22 base64url characters.');
    const name = await subscriptionName(b.endpoint);
    return env.RELAY.get(env.RELAY.idFromName(name)).fetch(new Request('https://relay/schedule', {
      method: 'POST', body: JSON.stringify({ id: `${name}.${rand}`, endpoint: b.endpoint, sendAt: b.sendAt, ttl, urgency, payload: toB64u(payload), token }),
    }));
  }

  /** DELETE /v1/schedule/:id. @param {Request} req @param {Env} env @param {string} id */
  async function cancel(req, env, id) {
    const token = bearer(req);
    if (!token) return fail(401, 'token', "Cancelling a reminder needs its cancel token in the Authorization header.");
    const m = ID.exec(id);
    if (!m) return fail(404, 'missing', MISSING);
    return env.RELAY.get(env.RELAY.idFromName(m[1])).fetch(new Request(`https://relay/schedule/${id}`, { method: 'DELETE', headers: { 'X-Token': token } }));
  }

  /** One push subscription's reminders (spec §11.6): kept until sent, cancelled, or expired. */
  class PushRelay {
    /** @param {State} state @param {Env} env */
    constructor(state, env) {
      this.storage = state.storage;
      this.env = env;
    }

    /** @param {Request} req */
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === 'POST' && pathname === '/schedule') return this.schedule(await req.json());
      const m = /^\/schedule\/(.+)$/.exec(pathname);
      if (req.method === 'DELETE' && m) return this.cancel(m[1], req.headers.get('X-Token') ?? '');
      return fail(404, 'route', 'There is nothing at this address of the relay.');
    }

    /** @param {{ id: string, endpoint: string, sendAt: number, ttl: number, urgency: string, payload: string, token: string }} m */
    async schedule(m) {
      /** @type {Waiting | undefined} */
      const had = await this.storage.get(`m:${m.id}`);
      if (had) return same(had.token, m.token) ? reply(201, { id: m.id, sendAt: had.sendAt }) : fail(409, 'id', 'A reminder with that id is already waiting. annai picks another.');
      if ((await this.storage.list({ prefix: 'm:' })).size >= LIMITS.pending) {
        return fail(429, 'full', `This phone already has ${LIMITS.pending} reminders waiting at the relay. More can wait once some are sent.`);
      }
      /** @type {Waiting} */
      const w = { id: m.id, endpoint: m.endpoint, sendAt: m.sendAt, next: m.sendAt, ttl: m.ttl, urgency: m.urgency, token: m.token, tries: 0 };
      await this.storage.put({ [`m:${m.id}`]: w, [`p:${m.id}`]: m.payload });
      const alarm = await this.storage.getAlarm();
      if (alarm === null || m.sendAt < alarm) await this.storage.setAlarm(m.sendAt);
      return reply(201, { id: m.id, sendAt: m.sendAt });
    }

    /** @param {string} id @param {string} token */
    async cancel(id, token) {
      /** @type {Waiting | undefined} */
      const had = await this.storage.get(`m:${id}`);
      if (!had) return fail(404, 'missing', MISSING);
      if (!same(had.token, token)) return fail(403, 'token', "That isn't this reminder's cancel token.");
      await this.storage.delete([`m:${id}`, `p:${id}`]);
      await this.rewake();
      return reply(204, null);
    }

    /** The alarm: sends what is due (spec §11.6: "sends at sendAt"). Task 4. */
    async alarm() {
      await this.rewake();
    }

    /** The alarm at the next reminder's time; with none left, no alarm and nothing stored. */
    async rewake() {
      /** @type {Waiting[]} */
      const waiting = [...(await this.storage.list({ prefix: 'm:' })).values()];
      if (!waiting.length) {
        await this.storage.deleteAlarm();
        await this.storage.delete('jwt');
        return;
      }
      await this.storage.setAlarm(Math.min(...waiting.map((w) => w.next)));
    }
  }

  const worker = {
    /** @param {Request} req @param {Env} env @returns {Promise<Response>} */
    async fetch(req, env) {
      const origin = req.headers.get('Origin');
      /** @type {Response} */
      let res;
      try {
        res = await route(req, env);
      } catch {
        res = fail(500, 'relay', "The relay couldn't do that just now. annai tries again later.");
      }
      const out = new Response(res.body, res); // a Durable Object's answer has headers that can't be changed
      out.headers.set('Vary', 'Origin');
      if (origin !== null && listOf(env.ORIGINS).includes(origin)) out.headers.set('Access-Control-Allow-Origin', origin);
      return out;
    },
  };
  return { worker, PushRelay };
}
```

`relay/src/index.js`:

```js
// The Worker's entry (wrangler.toml main): the relay on Cloudflare's own clock and fetch.
import { makeRelay } from './relay.js';

const relay = makeRelay();

/** The Durable Object class wrangler.toml binds as RELAY: one object per push subscription. */
export class PushRelay extends relay.PushRelay {}

export default relay.worker;
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/relay.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add relay/src/relay.js relay/src/index.js relay/memory.js test/unit/relay-kit.js test/unit/relay.test.js && git commit -m "The relay keeps each subscription's reminders in its own Durable Object, behind its abuse limits: 4 KB, 200 waiting, 30 days, a rate per address, push services only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: Sending at sendAt, and the whole way in Node

**Files:**
- Modify: `relay/src/relay.js` (the alarm, sending, retries, the VAPID token kept)
- Test: `test/unit/relay-send.test.js`

**Interfaces:**
- Consumes: `relayKit` (Task 3), `startPushService`, `verifyVapid` (Task 2), `encryptPush` (Task 1).
- Produces: the alarm sends each due reminder: `POST <endpoint>` with `TTL`, `Urgency`, `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `Authorization: vapid t=…, k=…`, the payload as body. Results as in choice 6. `jwt` stored per object: `{ aud, key, exp, token }`.

- [ ] **Step 1: Write the failing test**

`test/unit/relay-send.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayKit, ENDPOINT, MIN, token } from './relay-kit.js';
import { toB64u } from '../../relay/src/b64.js';
import { verifyVapid, startPushService } from '../fakes/push-service.js';
import { encryptPush } from '../../src/core/push/webpush.js';
import { utf8 } from '../../src/core/bytes.js';

test('at its time the relay sends the reminder to its push service, signed, and keeps nothing of it (spec §11.6)', async () => {
  const k = await relayKit();
  const rem = k.reminder();
  await k.call('POST', '/v1/schedule', { body: rem, token: token() });
  await k.after(10 * MIN - 1000);
  assert.equal(k.sent.length, 0, 'not before its time');
  await k.after(1000);
  assert.equal(k.sent.length, 1);
  const { url, init } = k.sent[0];
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.TTL, '3600');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(toB64u(init.body), rem.payload);
  const claims = await verifyVapid(init.headers.Authorization, { aud: 'https://web.push.apple.com', now: k.now(), key: k.key });
  assert.equal(claims.sub, 'https://annai.guide');
  assert.equal(claims.exp, Math.floor(k.now() / 1000) + 12 * 3600);
  assert.deepEqual(await k.waiting(), []);
  assert.deepEqual(await k.stored(), [], 'not its payload, not its token, not the VAPID token');
  assert.equal(await k.alarm(), null);
});

test('several reminders, each at its own time; the alarm moves on to the next', async () => {
  const k = await relayKit();
  for (const m of [30, 10, 20]) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + m * MIN, payload: toB64u(new Uint8Array(200).fill(m)) }), token: token() });
  await k.after(10 * MIN);
  assert.deepEqual(k.sent.map((s) => s.init.body[0]), [10]);
  assert.equal(await k.alarm(), k.now() + 10 * MIN);
  await k.after(10 * MIN);
  await k.after(10 * MIN);
  assert.deepEqual(k.sent.map((s) => s.init.body[0]), [10, 20, 30]);
  assert.deepEqual(await k.stored(), []);
});

test('a subscription that is gone (410 or 404): everything waiting for it goes at once, and nothing is tried again', async () => {
  for (const status of [410, 404]) {
    const k = await relayKit({ statuses: [status] });
    for (const m of [10, 11, 12]) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + m * MIN }), token: token() });
    await k.call('POST', '/v1/schedule', { body: k.reminder({ endpoint: 'https://fcm.googleapis.com/fcm/send/other', sendAt: k.now() + 11 * MIN }), token: token() });
    await k.after(10 * MIN);
    assert.equal(k.sent.length, 1, String(status));
    assert.deepEqual(await k.stored(), [], 'all three of its reminders deleted');
    assert.equal(await k.alarm(), null);
    await k.after(2 * MIN);
    assert.equal(k.sent.length, 2, "another subscription's reminder still goes");
  }
});

test('busy or down (429, 5xx, no connection): tried again with growing waits, and dropped an hour after its time', async () => {
  const k = await relayKit({ statuses: [429, 503, 0] });
  await k.call('POST', '/v1/schedule', { body: k.reminder(), token: token() });
  await k.after(10 * MIN);
  assert.equal((await k.waiting())[0].next, k.now() + 30_000);
  await k.after(30_000);
  assert.equal((await k.waiting())[0].next, k.now() + 60_000);
  await k.after(60_000);
  assert.equal((await k.waiting())[0].next, k.now() + 120_000);
  await k.after(120_000);
  assert.equal(k.sent.length, 4);
  assert.deepEqual(await k.waiting(), [], 'sent at the fourth try');
  const g = await relayKit({ statuses: Array(40).fill(503) });
  await g.call('POST', '/v1/schedule', { body: g.reminder(), token: token() });
  for (let i = 0; i < 20; i++) await g.after(10 * MIN);
  assert.deepEqual(await g.waiting(), [], 'given up');
  assert.ok(g.sent.length >= 7 && g.sent.length <= 12, `${g.sent.length} tries in the hour`);
});

test('refused for good (400, 413): dropped; 403 once: a new VAPID token, and one more try', async () => {
  const k = await relayKit({ statuses: [400, 413, 403, 201, 403, 403] });
  for (const m of [10, 11, 12, 13]) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + m * MIN }), token: token() });
  await k.after(10 * MIN);
  await k.after(MIN);
  assert.equal((await k.waiting()).length, 2, '400 and 413: dropped');
  await k.after(MIN);
  assert.equal((await k.waiting()).length, 2, '403: kept for one more try');
  const first = k.sent[2].init.headers.Authorization;
  await k.after(30_000);
  assert.equal((await k.waiting()).length, 1);
  assert.notEqual(k.sent[3].init.headers.Authorization, first, 'with a new token');
  await k.after(MIN);
  await k.after(30_000);
  assert.deepEqual(await k.waiting(), [], 'a second 403 drops it');
});

test('one VAPID token for a while: used until an hour is left, then a new one; the subject is the operator\'s', async () => {
  const k = await relayKit({ subject: 'mailto:relay@example.org' });
  for (const m of [10, 11 * 60, 11 * 60 + 30]) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + m * MIN }), token: token() });
  await k.after(10 * MIN);
  await k.after((11 * 60 - 10) * MIN);
  await k.after(30 * MIN);
  const [a, b, c] = k.sent.map((s) => s.init.headers.Authorization);
  assert.equal(b, a, '10 h 50 min later: still 1 h 10 min left');
  assert.notEqual(c, a, '40 min left: renewed');
  const claims = await verifyVapid(c, { aud: 'https://web.push.apple.com', now: k.now(), key: k.key });
  assert.equal(claims.sub, 'mailto:relay@example.org');
});

test('cancelled while the relay sends it: no crash, sent at most once, nothing left', async () => {
  /** @type {() => void} */
  let release = () => {};
  let calls = 0;
  const k = await relayKit({ send: async () => { calls++; await new Promise((r) => { release = () => r(undefined); }); return new Response(null, { status: 503 }); } });
  const tok = token();
  const { body } = await k.call('POST', '/v1/schedule', { body: k.reminder(), token: tok });
  const sending = k.after(10 * MIN);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await k.call('DELETE', `/v1/schedule/${body.id}`, { token: tok })).status, 204);
  release();
  await sending;
  assert.equal(calls, 1, 'it was being sent when it was cancelled');
  assert.deepEqual(await k.stored(), [], 'its retry was not written back');
  assert.equal(await k.alarm(), null);
});

test('the whole way in Node: the page encrypts, the relay keeps it, and at its time the push service opens it (spec §11.6)', async () => {
  let t = Date.parse('2026-11-27T08:00:00Z');
  const service = await startPushService({ now: () => t });
  try {
    const k = await relayKit({ send: (url, init) => fetch(url, init), extraPushOrigins: [service.origin] });
    t = k.now();
    const sub = await service.subscribe(k.key);
    const reminder = { title: 'Big Sur', body: 'Leave soon: Lunch at Nepenthe at 12:00.' };
    const payload = await encryptPush(sub, utf8(JSON.stringify(reminder)), { pad: 3072 });
    const r = await k.call('POST', '/v1/schedule', { body: { endpoint: sub.endpoint, key: k.key, sendAt: k.now() + MIN, payload: toB64u(payload) }, token: token() });
    assert.equal(r.status, 201);
    t += MIN;
    await k.after(MIN);
    const [got] = service.received;
    assert.equal(got.status, 201, String(got.reason));
    assert.deepEqual(JSON.parse(String(got.plaintext)), reminder);
    assert.equal(got.claims.aud, service.origin);
    assert.equal(got.bytes, 3174, 'the size every reminder has');
    assert.deepEqual(await k.waiting(), []);
  } finally {
    await service.stop();
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/relay-send.test.js`
Expected: FAIL: nothing is sent (`k.sent.length` is 0).

- [ ] **Step 3: Write the implementation**

In `relay/src/relay.js`, replace the alarm with the sending one, and add `#deliver` and `#jwt`:

```js
    /** The alarm: sends what is due (spec §11.6: "sends at sendAt"), then waits for the next. */
    async alarm() {
      try {
        const t = now();
        /** @type {Waiting[]} */
        const due = [...(await this.storage.list({ prefix: 'm:' })).values()].filter((w) => w.next <= t).sort((a, b) => a.next - b.next);
        for (const w of due) {
          // Read again: while a send waits, Cloudflare lets other requests in, and one may have cancelled this.
          /** @type {Waiting | undefined} */
          const fresh = await this.storage.get(`m:${w.id}`);
          if (!fresh) continue;
          const r = await this.#deliver(fresh, t);
          if (r === 'gone') {
            /** @type {Waiting[]} */
            const all = [...(await this.storage.list({ prefix: 'm:' })).values()].filter((x) => x.endpoint === fresh.endpoint);
            await this.storage.delete(all.flatMap((x) => [`m:${x.id}`, `p:${x.id}`]));
          } else if (r === 'retry') {
            /** @type {Waiting | undefined} */
            const still = await this.storage.get(`m:${w.id}`);
            if (!still) continue;
            const tries = still.tries + 1;
            const next = t + Math.min(10 * MIN, 30_000 * 2 ** (tries - 1));
            if (next > still.sendAt + RETRY_FOR) await this.storage.delete([`m:${w.id}`, `p:${w.id}`]);
            else await this.storage.put(`m:${w.id}`, { ...still, tries, next });
          } else {
            await this.storage.delete([`m:${w.id}`, `p:${w.id}`]); // sent, or never will be
          }
        }
        await this.rewake();
      } catch {
        // The relay itself failed: look again in a minute rather than let Cloudflare retry at once.
        await this.storage.setAlarm(now() + MIN);
      }
    }

    /**
     * Sends one reminder to its push service (RFC 8030, VAPID per RFC 8292), choice 6.
     * @param {Waiting} w @param {number} t @returns {Promise<'sent' | 'gone' | 'retry' | 'drop'>}
     */
    async #deliver(w, t) {
      if (t > w.sendAt + RETRY_FOR) return 'drop'; // expired
      const key = await vapid(this.env);
      if (!key) return 'retry';
      const body = fromB64u((await this.storage.get(`p:${w.id}`)) ?? '');
      if (!body?.length) return 'drop';
      /** @type {Response} */
      let res;
      try {
        const jwt = await this.#jwt(key, new URL(w.endpoint).origin, t);
        res = await send(w.endpoint, {
          method: 'POST', body,
          headers: { TTL: String(w.ttl), Urgency: w.urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(jwt, key.publicKey) },
        });
      } catch {
        return 'retry';
      }
      await res.arrayBuffer().catch(() => null);
      if (res.ok) return 'sent';
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status === 403 && w.tries === 0) {
        await this.storage.delete('jwt');
        return 'retry';
      }
      if (res.status === 429 || res.status >= 500) return 'retry';
      return 'drop';
    }

    /** A VAPID token for one push service, kept until an hour is left (choice 7). @param {import('./vapid.js').VapidKey} key @param {string} aud @param {number} t */
    async #jwt(key, aud, t) {
      const had = await this.storage.get('jwt');
      if (had && had.aud === aud && had.key === key.publicKey && had.exp * 1000 - t > JWT_RENEW_MS) return String(had.token);
      const exp = Math.floor(t / 1000) + JWT_LIFE_S;
      const token = await vapidJwt(key, { aud, exp, sub: this.env.VAPID_SUBJECT || 'https://annai.guide' });
      await this.storage.put('jwt', { aud, key: key.publicKey, exp, token });
      return token;
    }
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/relay-send.test.js test/unit/relay.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add relay/src/relay.js test/unit/relay-send.test.js && git commit -m "The relay sends each reminder at its time, signed, retries a busy push service for an hour, and forgets a gone subscription at once; the whole way works in Node

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: The Node runner, the Worker's settings, and how to deploy

**Files:**
- Create: `relay/serve.mjs`, `relay/keys.mjs`, `relay/wrangler.toml`, `relay/README.md`
- Test: `test/unit/relay-serve.test.js`

**Interfaces:**
- Consumes: `makeRelay`, `memoryNamespace`, `memoryLimiter`, `newVapidJwk`, `readVapidKey`.
- Produces:
  - `startRelay(o?: { port?, host?, origins?: string[], jwk?: string, keys?: string, subject?: string, extraPushOrigins?: string[], now?: () => number, timers?: boolean, limit?: number, send? }): Promise<{ origin: string, key: string, env, close(): Promise<void> }>` (6b's end-to-end tests use it with `timers: false` and `env.RELAY.runDue()`).
  - `keyFile(file: string): Promise<string>`: the JWK in file, made there with mode 0600 the first time.
  - CLI: `node relay/serve.mjs --port 8796 --origin <annai's origin> [--origin …] [--keys FILE] [--subject URI] [--host 127.0.0.1]`.

- [ ] **Step 1: Write the failing test**

`test/unit/relay-serve.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../../relay/serve.mjs';
import { newVapidJwk } from '../../relay/src/vapid.js';
import { toB64u } from '../../relay/src/b64.js';
import { startPushService } from '../fakes/push-service.js';
import { encryptPush } from '../../src/core/push/webpush.js';
import { utf8 } from '../../src/core/bytes.js';

const serve = fileURLToPath(new URL('../../relay/serve.mjs', import.meta.url));

test('the Node runner: the same relay over HTTP, its key in a file only its owner can read, kept across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-relay-'));
  try {
    const file = join(dir, 'config', 'vapid.json');
    const a = await startRelay({ origins: ['http://127.0.0.1:8790'], keys: file });
    try {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      const res = await fetch(`${a.origin}/v1/vapid`, { headers: { Origin: 'http://127.0.0.1:8790' } });
      assert.deepEqual(await res.json(), { key: a.key });
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8790');
    } finally {
      await a.close();
    }
    const b = await startRelay({ keys: file });
    try {
      assert.equal(b.key, a.key, 'the same key after a restart, so phones stay subscribed');
    } finally {
      await b.close();
    }
    assert.ok(JSON.parse(await readFile(file, 'utf8')).d, 'the private key is in that file and nowhere else');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('over HTTP, on real timers, a reminder reaches the push service at its time', async () => {
  const service = await startPushService();
  const r = await startRelay({ jwk: await newVapidJwk(), extraPushOrigins: [service.origin] });
  try {
    const sub = await service.subscribe(r.key);
    const payload = await encryptPush(sub, utf8('Now.'), { pad: 3072 });
    const res = await fetch(`${r.origin}/v1/schedule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${toB64u(crypto.getRandomValues(new Uint8Array(32)))}` },
      body: JSON.stringify({ endpoint: sub.endpoint, key: r.key, sendAt: Date.now() + 300, payload: toB64u(payload) }),
    });
    assert.equal(res.status, 201);
    for (let i = 0; i < 50 && !service.received.length; i++) await new Promise((done) => setTimeout(done, 100));
    assert.equal(service.received[0]?.plaintext, 'Now.');
  } finally {
    await r.close();
    await service.stop();
  }
});

test("the runner keeps off annai's own ports, and asks for the app's address", () => {
  const taken = spawnSync(process.execPath, [serve, '--port', '8790', '--origin', 'https://x.example'], { encoding: 'utf8' });
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /annai's own/);
  const bare = spawnSync(process.execPath, [serve, '--port', '0'], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--origin/);
});

test('wrangler.toml: one SQLite-backed Durable Object class per subscription, the rate limit, the route, no key; index.js exports both', async () => {
  const toml = await readFile(new URL('../../relay/wrangler.toml', import.meta.url), 'utf8');
  for (const line of ['main = "src/index.js"', 'name = "RELAY"', 'class_name = "PushRelay"', 'new_sqlite_classes = ["PushRelay"]', 'name = "LIMIT"',
    'simple = { limit = 300, period = 60 }', 'pattern = "push.annai.guide"', 'custom_domain = true', 'ORIGINS = "https://annai.guide"']) assert.ok(toml.includes(line), line);
  assert.doesNotMatch(toml, /VAPID_KEY\s*=/, 'the private key is a secret, never in the file');
  const mod = await import('../../relay/src/index.js');
  assert.equal(typeof mod.default.fetch, 'function');
  assert.equal(typeof mod.PushRelay.prototype.alarm, 'function');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@playwright/test', '@types/node', 'typescript'], 'no wrangler or miniflare');
  assert.equal(pkg.dependencies, undefined);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/relay-serve.test.js`
Expected: FAIL: `relay/serve.mjs` doesn't exist.

- [ ] **Step 3: Write the implementation**

`relay/serve.mjs`:

```js
#!/usr/bin/env node
/**
 * The push relay in Node, for a device test on your own network before deploying (relay/README.md):
 * the same Worker code, with its Durable Objects in memory. A restart forgets the reminders waiting.
 * Not for production.
 *   node relay/serve.mjs --port 8796 --origin https://your-machine.your-tailnet.ts.net:8792 [--keys FILE] [--subject URI] [--host 127.0.0.1]
 */
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeRelay } from './src/relay.js';
import { newVapidJwk, readVapidKey } from './src/vapid.js';
import { memoryNamespace, memoryLimiter } from './memory.js';

/** Ports annai's own servers use on this machine: never the relay's. */
const TAKEN = [8765, 8790, 8791, 8792];

/** The VAPID key in file, made there (readable by its owner alone) the first time (choice 11). @param {string} file */
export async function keyFile(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
  }
  const jwk = await newVapidJwk();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, jwk, { mode: 0o600, flag: 'wx' });
  return jwk;
}

/**
 * Starts the relay on a port of this machine.
 * @param {{ port?: number, host?: string, origins?: string[], jwk?: string, keys?: string, subject?: string, extraPushOrigins?: string[],
 *   now?: () => number, timers?: boolean, limit?: number, send?: (url: string, init: RequestInit) => Promise<Response> }} [o]
 */
export async function startRelay({ port = 0, host = '127.0.0.1', origins = [], jwk, keys, subject, extraPushOrigins = [], now = () => Date.now(), timers = true, limit = 300, send } = {}) {
  const secret = jwk ?? (await keyFile(keys ?? join(homedir(), '.config', 'annai-relay', 'vapid.json')));
  const { publicKey } = await readVapidKey(secret);
  const { worker, PushRelay } = makeRelay({ now, ...(send ? { send } : {}) });
  /** @type {any} */
  const env = { VAPID_KEY: secret, VAPID_SUBJECT: subject ?? 'https://annai.guide', ORIGINS: origins.join(','), EXTRA_PUSH_ORIGINS: extraPushOrigins.join(','), LIMIT: memoryLimiter({ limit, now }) };
  env.RELAY = memoryNamespace(PushRelay, env, { now, timers });
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        // Behind `tailscale serve`, the phone's address comes as X-Forwarded-For.
        headers.set('CF-Connecting-IP', String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
        const answer = await worker.fetch(new Request(`http://${host}${req.url ?? '/'}`, { method: req.method, headers, body }), env);
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The relay failed to answer.');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const { port: bound } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://${host}:${bound}`,
    key: publicKey,
    env,
    close: () => new Promise((resolve) => {
      env.RELAY.close();
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const one = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const all = (/** @type {string} */ name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
  const port = Number(one('--port') ?? 8796);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be a port number, such as 8796.');
    process.exit(1);
  }
  if (TAKEN.includes(port)) {
    console.error(`Port ${port} is one of annai's own on this machine (8765, 8790 to 8792). Choose another, such as 8796.`);
    process.exit(1);
  }
  const origins = all('--origin');
  if (!origins.length) {
    console.error("Give the address annai is served from, so the relay answers it: --origin https://your-machine.your-tailnet.ts.net:8792");
    process.exit(1);
  }
  const r = await startRelay({ port, host: one('--host') ?? '127.0.0.1', origins, keys: one('--keys'), subject: one('--subject') });
  console.log(`annai push relay, in memory (a restart forgets what is waiting): ${r.origin}/ for ${origins.join(', ')}`);
  console.log(`VAPID public key: ${r.key}`);
}
```

`relay/keys.mjs`:

```js
#!/usr/bin/env node
// Makes the relay's VAPID key pair (spec §11.6) and prints it as one line of JSON, for
//   node keys.mjs | npx wrangler@4 secret put VAPID_KEY
// so the private key goes straight to Cloudflare and is never written to a file (choice 8).
import { newVapidJwk, readVapidKey } from './src/vapid.js';

const jwk = await newVapidJwk();
process.stdout.write(jwk);
console.error(`VAPID public key (phones subscribe with it): ${(await readVapidKey(jwk)).publicKey}`);
```

`relay/wrangler.toml`:

```toml
# The annai push relay (spec §11.6): a Cloudflare Worker with one Durable Object per push
# subscription. How to deploy it: README.md in this folder. The VAPID private key is the secret
# VAPID_KEY, never in this file.
name = "annai-push"
main = "src/index.js"
compatibility_date = "2026-10-01"
workers_dev = false
routes = [{ pattern = "push.annai.guide", custom_domain = true }]

[vars]
# The address annai is served from; more than one, comma-separated.
ORIGINS = "https://annai.guide"
# Who runs the relay, for the push services (a URL or a mailto: address).
VAPID_SUBJECT = "https://annai.guide"

[[durable_objects.bindings]]
name = "RELAY"
class_name = "PushRelay"

# SQLite-backed objects: the kind the Workers Free plan has.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["PushRelay"]

# 300 requests a minute from one address, counted at each Cloudflare location.
[[ratelimits]]
name = "LIMIT"
namespace_id = "6001"
simple = { limit = 300, period = 60 }

# The relay keeps no logs.
[observability]
enabled = false
```

`relay/README.md`:

````markdown
# annai's push relay

Reminders reach a closed annai as notifications through this relay (spec §11.6). annai encrypts
each reminder on the phone (RFC 8291) and pads it to one size; the relay keeps it until its time,
sends it to the phone's push service (Apple's, Google's, Mozilla's or Microsoft's) signed with its
VAPID key (RFC 8292), and deletes it. It learns only the phone's push endpoint, when each reminder
is due, and how many there are. It keeps no logs.

It is a Cloudflare Worker with one Durable Object per push subscription: the object keeps that
phone's reminders and wakes with its alarm at the next one's time. It has no dependencies.

- `GET /v1/vapid`: the relay's public key, which phones subscribe with.
- `POST /v1/schedule`: a reminder, `Authorization: Bearer <cancel token>` and JSON `{ endpoint, key, sendAt, ttl?, urgency?, payload, id? }`. Answers `201 { id, sendAt }`.
- `DELETE /v1/schedule/:id`, with the same `Authorization`. Answers 204.

Limits: an encrypted reminder up to 4 KB, 200 waiting per phone, 30 days ahead, 300 requests a
minute from one address. Errors are `{ error, message }`.

## Deploy it to your Cloudflare account

You need a Cloudflare account (the Free plan is enough) and Node 22 or later. These steps run
wrangler, Cloudflare's tool, with `npx`; it isn't one of annai's dependencies.

1. **Sign in**, from this folder (`relay/`):

   ```bash
   cd relay
   npx wrangler@4 login
   ```

2. **The address.** `wrangler.toml` puts the relay at `push.annai.guide` as a custom domain. That
   works when annai.guide's DNS is on Cloudflare (the domain added to your account, whatever the
   registrar). If it isn't:
   - delete the `routes = …` line, and set `workers_dev = true`. The relay is then at
     `https://annai-push.<your-subdomain>.workers.dev` (wrangler prints it);
   - in annai, Settings → Notifications → Relay address, enter that address.

3. **Deploy.** The first deploy also creates the Durable Object class (the `v1` migration):

   ```bash
   npx wrangler@4 deploy
   ```

4. **The VAPID key.** Make a key pair and give it to Cloudflare as a secret in one step, so the
   private key is never written to a file:

   ```bash
   node keys.mjs | npx wrangler@4 secret put VAPID_KEY
   ```

   It prints the public key. Until this step, the relay answers 503 "has no VAPID key yet".

5. **Check it:**

   ```bash
   curl https://push.annai.guide/v1/vapid
   ```

   It answers `{"key":"B…"}`, the public key from step 4.

6. **annai's address.** `ORIGINS` in `wrangler.toml` is `https://annai.guide`. If you serve annai
   from somewhere else, put that address there (comma-separated for several) and deploy again.

### Changing the key

Put a new one with step 4. Phones subscribed with the old key are told so the next time annai
sends them a reminder (409 "key"), and subscribe again by themselves. Nothing else is needed, so
there is no need to keep a copy of the key.

### Costs

On the Free plan, Durable Objects allow 100,000 requests a day. Each reminder costs about three
(sent, scheduled, and the alarm that sends it), and a cancelled one about three. One person's trips
use a few hundred a day at most.

### Self-hosting

Change `name`, the route and `ORIGINS`, and `VAPID_SUBJECT` to a URL or `mailto:` address of yours.
Apple refuses a subject that is neither, and has been seen refusing `mailto:` addresses at
`localhost`.

## A device test before deploying

`serve.mjs` runs the same code in Node, with the reminders in memory (a restart forgets them). Its
VAPID key is a file only you can read, by default `~/.config/annai-relay/vapid.json`, so phones stay
subscribed across restarts. Phones need it over https; on a tailnet, `tailscale serve` gives that:

```bash
node relay/serve.mjs --port 8796 --origin https://your-machine.your-tailnet.ts.net:8792
tailscale serve --bg --https=8797 http://127.0.0.1:8796
```

`--origin` is the address annai is served from (more than one `--origin` is fine). Then in annai on
the phone: Settings → Notifications → Relay address `https://your-machine.your-tailnet.ts.net:8797`,
Save, and turn notifications on. The machine must reach the internet: it sends to Apple's and
Google's push services. Ports 8765 and 8790–8792 are refused (annai's own).
````

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/unit/relay-serve.test.js && npm run typecheck`
Expected: PASS, 4 tests; the type check covers `relay/`.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add relay/serve.mjs relay/keys.mjs relay/wrangler.toml relay/README.md test/unit/relay-serve.test.js && git commit -m "The relay runs in Node for a device test, and relay/README.md says how to deploy it to your own Cloudflare account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

## Ledger

(Kept by the executor: one line per task as it completes, and a Ruling line for each call made while building.)
