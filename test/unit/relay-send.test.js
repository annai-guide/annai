import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayKit, ENDPOINT, MIN, token } from './relay-kit.js';
import { KEEP_CONFIRMED } from '../../relay/src/relay.js';
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
  assert.deepEqual(await k.stored(), ['confirmed', 'jwt'], 'not its payload, not its token: only that a push reached the phone, and the VAPID token');
  assert.equal(await k.alarm(), k.now() + KEEP_CONFIRMED, 'and that only for 60 days');
});

test('several reminders, each at its own time; the alarm moves on to the next', async () => {
  const k = await relayKit();
  await k.confirm();
  for (const m of [30, 10, 20]) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + m * MIN, payload: toB64u(new Uint8Array(200).fill(m)) }), token: token() });
  await k.after(10 * MIN);
  assert.deepEqual(k.sent.map((s) => s.init.body[0]), [10]);
  assert.equal(await k.alarm(), k.now() + 10 * MIN);
  await k.after(10 * MIN);
  await k.after(10 * MIN);
  assert.deepEqual(k.sent.map((s) => s.init.body[0]), [10, 20, 30]);
  assert.deepEqual(await k.stored(), ['confirmed', 'jwt']);
});

test('a subscription that is gone (410 or 404): everything waiting for it goes at once, however many (Cloudflare takes 128 keys a call), and nothing is tried again', async () => {
  for (const status of [410, 404]) {
    const k = await relayKit({ statuses: [status] });
    await k.confirm();
    await k.confirm('https://fcm.googleapis.com/fcm/send/other');
    for (let i = 0; i < 70; i++) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + 10 * MIN + i * 1000, payload: toB64u(new Uint8Array(200)) }), token: token() });
    await k.call('POST', '/v1/schedule', { body: k.reminder({ endpoint: 'https://fcm.googleapis.com/fcm/send/other', sendAt: k.now() + 11 * MIN }), token: token() });
    await k.after(10 * MIN);
    assert.equal(k.sent.length, 1, String(status));
    assert.deepEqual(await k.stored(), [], 'all 70 of its reminders deleted, and its confirmation');
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
  await k.confirm();
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
  await k.confirm();
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

test('a reminder due now for a gone subscription with many waiting: 410 in plain words, never a 500, and nothing left', async () => {
  const k = await relayKit({ statuses: [201, 410] });
  await k.confirm();
  for (let i = 0; i < 70; i++) await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + 10 * MIN + i * 1000, payload: toB64u(new Uint8Array(200)) }), token: token() });
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() }), token: token() })).status, 201);
  const gone = await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() }), token: token() });
  assert.equal(gone.status, 410);
  assert.deepEqual(await k.stored(), []);
  assert.equal(await k.alarm(), null);
});

test("the relay's own failure in an alarm: tried again a minute later, then two, four… at most an hour apart, and calm again once it works", async () => {
  const k = await relayKit();
  await k.confirm();
  await k.call('POST', '/v1/schedule', { body: k.reminder(), token: token() });
  const o = /** @type {any} */ (await k.object(ENDPOINT));
  const list = o.storage.list.bind(o.storage);
  let broken = true;
  o.storage.list = async (/** @type {any} */ x) => { if (broken) throw new Error('storage is down'); return list(x); };
  /** @type {number[]} */
  const waits = [];
  await k.after(10 * MIN);
  for (let i = 0; i < 9; i++) {
    waits.push((await k.alarm()) - k.now());
    await k.after(/** @type {number} */ (await k.alarm()) - k.now());
  }
  assert.deepEqual(waits.map((w) => w / MIN), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  broken = false;
  await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + MIN }), token: token() });
  await k.after(MIN);
  assert.equal(k.sent.length, 1, 'once the relay works again, a reminder goes (the first expired meanwhile, and was dropped)');
  assert.deepEqual(await k.waiting(), []);
  assert.equal((await k.stored()).includes('fails'), false, 'the count of failures is forgotten');
});
