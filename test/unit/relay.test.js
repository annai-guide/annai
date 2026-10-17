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
