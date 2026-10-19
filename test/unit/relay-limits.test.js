import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayKit, ENDPOINT, MIN, token } from './relay-kit.js';
import { UNCONFIRMED, BATCH, KEEP_CONFIRMED, addressKey } from '../../relay/src/relay.js';
import { startRelay } from '../../relay/serve.mjs';
import { MemoryStorage } from '../../relay/memory.js';
import { newVapidJwk } from '../../relay/src/vapid.js';

const DAY = 86_400_000;

test('a body sent without its length is read only up to 8 KB, then refused; the rest is never read', async () => {
  const k = await relayKit();
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const body = new ReadableStream({
    pull(c) {
      if (pulled >= 50 * 1024 * 1024) {
        c.close();
        return;
      }
      pulled += chunk.length;
      c.enqueue(chunk);
    },
  });
  // Node needs duplex for a streamed body; the DOM's RequestInit type doesn't know it.
  /** @type {any} */
  const init = { method: 'POST', body, duplex: 'half', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' } };
  const res = await k.raw(new Request('https://push.annai.guide/v1/schedule', init));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'size');
  assert.ok(pulled <= 512 * 1024, `${pulled} bytes were read`);
});

test("without Cloudflare's rate-limit binding, the relay limits each address itself: never no limit (spec §11.6)", async () => {
  const k = await relayKit({ limit: null });
  for (let i = 0; i < 60; i++) assert.equal((await k.call('GET', '/v1/vapid', { ip: '198.51.100.1' })).status, 200);
  const r = await k.call('GET', '/v1/vapid', { ip: '198.51.100.1' });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'rate');
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '198.51.100.2' })).status, 200);
});

test('behind a proxy on the same machine (tailscale serve), the address is the one the proxy saw: a client cannot choose its own', async () => {
  const r = await startRelay({ jwk: await newVapidJwk(), limit: 2 });
  try {
    const get = (/** @type {string} */ xff) => fetch(`${r.origin}/v1/vapid`, { headers: { 'X-Forwarded-For': xff } }).then((x) => x.status);
    assert.equal(await get('10.0.0.1, 100.64.0.7'), 200);
    assert.equal(await get('10.0.0.2, 100.64.0.7'), 200);
    assert.equal(await get('10.0.0.3, 100.64.0.7'), 429, 'the last address is the one the proxy added');
    assert.equal(await get('100.64.0.8'), 200, 'another phone');
  } finally {
    await r.close();
  }
});

test('a subscription that never had a push through the relay keeps just 3 reminders, due within 10 minutes; once one is delivered, 200 (choice 13)', async () => {
  const k = await relayKit();
  const post = (/** @type {Record<string, any>} */ o) => k.call('POST', '/v1/schedule', { body: k.reminder(o), token: token() });
  const far = await post({ sendAt: k.now() + UNCONFIRMED.within + 1 });
  assert.equal(far.status, 429);
  assert.equal(far.body.error, 'unconfirmed');
  assert.match(far.body.message, /3 reminders, due within 10 minutes/);
  for (let i = 0; i < UNCONFIRMED.pending; i++) assert.equal((await post({ sendAt: k.now() + 5 * MIN })).status, 201);
  assert.equal((await post({ sendAt: k.now() + 5 * MIN })).body.error, 'unconfirmed');
  await k.after(5 * MIN);
  assert.equal(k.sent.length, 3);
  for (let i = 0; i < 20; i++) assert.equal((await post({ sendAt: k.now() + DAY })).status, 201, 'confirmed: a day ahead, and more than 3');
  assert.ok((await k.stored()).includes('confirmed'));
});

test("a reminder due now is sent at once, in the same request: annai learns whether the phone's push service took it", async () => {
  const k = await relayKit({ statuses: [201, 410] });
  const ok = await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() }), token: token() });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.sent, true);
  assert.equal(k.sent.length, 1);
  assert.deepEqual(await k.waiting(), []);
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + DAY }), token: token() })).status, 201, 'now confirmed');
  const gone = await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() }), token: token() });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error, 'gone');
  assert.deepEqual(await k.stored(), [], 'a gone subscription keeps nothing: not its other reminder, not its confirmation');
  const later = await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + 5 * MIN }), token: token() });
  assert.equal(later.body.sent, undefined, 'one not yet due waits for its time');
});

test('made-up endpoints cost little, briefly: their push service refuses each at its first send, and nothing of them stays', async () => {
  const k = await relayKit({ statuses: Array(40).fill(404) });
  for (let i = 0; i < 10; i++) {
    const endpoint = `https://fcm.googleapis.com/fcm/send/made-up-${i}`;
    for (let j = 0; j < UNCONFIRMED.pending; j++) assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ endpoint, sendAt: k.now() + 10 * MIN }), token: token() })).status, 201);
    assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ endpoint, sendAt: k.now() + 30 * DAY }), token: token() })).body.error, 'unconfirmed', '30 days ahead: refused');
  }
  await k.after(10 * MIN);
  assert.equal(k.sent.length, 10, 'one try each: the first 404 deletes all three');
  for (const o of k.env.RELAY.objects.values()) assert.deepEqual(o.storage.keys(), []);
});

test('a confirmation is kept 60 days after the last push, then forgotten', async () => {
  const k = await relayKit();
  await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + MIN }), token: token() });
  await k.after(MIN);
  await k.after(5 * MIN); // its id and token are forgotten
  assert.deepEqual(await k.stored(), ['confirmed', 'jwt'], 'that it had a push, and the VAPID token (Apple: renew it at most once an hour)');
  assert.equal(await k.alarm(), k.now() - 5 * MIN + KEEP_CONFIRMED);
  await k.after(KEEP_CONFIRMED - 6 * MIN);
  assert.deepEqual(await k.stored(), ['confirmed', 'jwt']);
  await k.after(MIN);
  assert.deepEqual(await k.stored(), []);
  assert.equal(await k.alarm(), null);
});

test('many due at once: one alarm sends at most 25, then the next goes straight on; none is sent twice', async () => {
  const k = await relayKit();
  await k.confirm();
  for (let i = 0; i < 30; i++) {
    const payload = new Uint8Array(200);
    new DataView(payload.buffer).setUint32(0, i);
    await k.call('POST', '/v1/schedule', { body: k.reminder({ payload: Buffer.from(payload).toString('base64url') }), token: token() });
  }
  const o = await k.object(ENDPOINT);
  await k.after(9 * MIN);
  /** @type {any} */ (o).storage.alarm = null;
  await k.after(MIN); // the alarm was taken away: nothing runs
  assert.equal(k.sent.length, 0);
  await /** @type {any} */ (o).obj.alarm();
  assert.equal(k.sent.length, BATCH);
  assert.ok(/** @type {number} */ (await k.alarm()) <= k.now(), 'the rest are due straight away');
  await k.after(0);
  const ids = k.sent.map((s) => new DataView(s.init.body.buffer, s.init.body.byteOffset).getUint32(0));
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  assert.deepEqual(await k.waiting(), []);
});

test('a push service that never answers is given up on, and the reminder tried again later', async () => {
  /** @type {any[]} */
  const inits = [];
  const k = await relayKit({
    timeout: 50,
    send: (_url, init) => {
      inits.push(init);
      if (!(init.signal instanceof AbortSignal)) return Promise.reject(new Error('no time limit'));
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    },
  });
  await k.call('POST', '/v1/schedule', { body: k.reminder(), token: token() });
  await k.after(10 * MIN);
  assert.equal(inits.length, 1);
  assert.ok(inits[0].signal instanceof AbortSignal, 'each send has a time limit');
  assert.equal(inits[0].signal.aborted, true, 'and it ran out');
  const [w] = await k.waiting();
  assert.equal(w.tries, 1);
  assert.equal(w.next, k.now() + 30_000);
});

test("the in-memory storage takes at most 128 keys a call, as Cloudflare's does, so a test meets that limit too", async () => {
  const s = new MemoryStorage();
  const keys = Array.from({ length: 129 }, (_, i) => `k${i}`);
  await assert.rejects(s.put(Object.fromEntries(keys.map((k) => [k, 1]))), /128/);
  await assert.rejects(s.delete(keys), /128/);
  await s.put(Object.fromEntries(keys.slice(0, 128).map((k) => [k, 1])));
  assert.equal(await s.delete(keys.slice(0, 128)), 128);
  await s.put({ a: 1, b: 2 });
  await s.deleteAll();
  assert.deepEqual(s.keys(), []);
});

test('one address may make 60 requests a minute: under the Free plan\'s 100,000 a day, and still far more than annai needs', async () => {
  const k = await relayKit({ limit: null });
  let ok = 0;
  for (let i = 0; i < 61; i++) if ((await k.call('GET', '/v1/vapid', { ip: '198.51.100.9' })).status === 200) ok++;
  assert.equal(ok, 60);
  assert.ok(60 * 60 * 24 < 100_000);
});

test('an IPv6 address counts by its /64, the block one home or phone gets: per address means something there too', async () => {
  assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:0db8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.notEqual(addressKey('2001:db8:1:3::1'), addressKey('2001:db8:1:2::1'));
  assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey(''), 'unknown');
  const k = await relayKit({ limit: 2 });
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '2001:db8:1:2::a' })).status, 200);
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '2001:db8:1:2::b' })).status, 200);
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '2001:db8:1:2:ffff::c' })).status, 429, 'the same /64');
  assert.equal((await k.call('GET', '/v1/vapid', { ip: '2001:db8:1:3::a' })).status, 200, 'another /64');
});

test("endpoints must have each push service's own shape, not just its host: other paths there can't be used to confirm made-up ones", async () => {
  const { pushEndpointAllowed } = await import('../../relay/src/relay.js');
  for (const ok of ['https://fcm.googleapis.com/fcm/send/dXk3:APA91b', 'https://fcm.googleapis.com/wp/dXk3:APA91b', 'https://android.googleapis.com/gcm/send/abc',
    'https://web.push.apple.com/QGuQyavXutnMei7Ldr5a6zf', 'https://api.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA']) assert.equal(pushEndpointAllowed(ok), true, ok);
  for (const no of ['https://fcm.googleapis.com/', 'https://fcm.googleapis.com/v1/projects/p/messages:send', 'https://fcm.googleapis.com/fcm/send/', 'https://fcm.googleapis.com/fcm/other/x',
    'https://android.googleapis.com/x', 'https://web.push.apple.com/', 'https://updates.push.services.mozilla.com/other/x', 'https://wns2-par02p.notify.windows.com/x',
    'https://fcm.googleаpis.com/fcm/send/x' /* a Cyrillic а */, 'https://web.push.аpple.com/abc',
    // Apple asks servers to allow any *.push.apple.com host, but a web push endpoint is one token there: no deeper path (APNs's /3/device/…), no query.
    'https://api.push.apple.com/3/device/abc', 'https://web.push.apple.com/a/b', 'https://web.push.apple.com/abc?x=1',
    // WNS answers on one regional label, such as wns2-par02p.
    'https://a.b.notify.windows.com/w/?token=BQYAAA']) assert.equal(pushEndpointAllowed(no), false, no);
});

test('only a 201 confirms a subscription (RFC 8030 §5): another 2xx from its host takes the reminder, but confirms nothing', async () => {
  for (const status of [200, 202, 204]) {
    const k = await relayKit({ statuses: [status] });
    await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + MIN }), token: token() });
    await k.after(MIN);
    assert.deepEqual(await k.waiting(), [], `${status}: taken, and not tried again`);
    const far = await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + 60 * MIN }), token: token() });
    assert.equal(far.body.error, 'unconfirmed', `${status}: not confirmed`);
  }
  const k = await relayKit({ statuses: [201] });
  await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + MIN }), token: token() });
  await k.after(MIN);
  assert.equal((await k.call('POST', '/v1/schedule', { body: k.reminder({ sendAt: k.now() + 60 * MIN }), token: token() })).status, 201, '201: confirmed');
});

test("the in-memory storage lists as Cloudflare's does: by prefix, in key order, at most limit, from the end with reverse", async () => {
  const s = new MemoryStorage();
  await s.put({ 'm:c': 3, 'm:a': 1, 'm:b': 2, 'p:a': 'x' });
  assert.deepEqual([...(await s.list({ prefix: 'm:' })).keys()], ['m:a', 'm:b', 'm:c']);
  assert.deepEqual([...(await s.list({ prefix: 'm:', limit: 2 })).keys()], ['m:a', 'm:b']);
  assert.deepEqual([...(await s.list({ prefix: 'm:', limit: 2, reverse: true })).keys()], ['m:c', 'm:b']);
  assert.deepEqual([...(await s.list({ limit: 1 })).entries()], [['m:a', 1]]);
});
