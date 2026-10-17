import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushKit, RELAY, at, iso, LA } from './push-kit.js';
import { moves, plan, GRACE_MS, MAX_WAITING, PAD, FILE, TOKENS, MOVE_MS, NEAR_MS, CALM_MS } from '../../src/core/push/mirror.js';
import { relayAddress, relayClient, RelayError } from '../../src/core/push/relay-client.js';
import { SYS_DEVICE, ME } from '../../src/core/scopes.js';
import { toBase64Url } from '../../src/core/bytes.js';
import { newVapidJwk } from '../../relay/src/vapid.js';

const MIN = 60_000;
const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };

test('turning on: one notification at once, then each time reminder waits at the relay, encrypted, all one size, 30 s after its time (spec §11.6)', async () => {
  const k = await pushKit({ plan: { tea: TEA }, live: false });
  try {
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const [hello] = k.pushed();
    assert.equal(hello.title, 'annai');
    assert.match(hello.body, /^Notifications are on\./);
    assert.equal(hello.test, true);
    const waiting = (await k.waiting()).sort((a, b) => a.sendAt - b.sendAt);
    assert.deepEqual(waiting.map((x) => x.sendAt), [at('10:00') + GRACE_MS, at('15:45') + GRACE_MS]);
    assert.deepEqual((await k.payloads()).map((p) => p.length), [86 + PAD + 16, 86 + PAD + 16]);
    k.sensors.visible(false); // annai off screen: only the relay can say it
    await k.settle();
    await k.deliver(at('10:00') + GRACE_MS);
    const tea = k.pushed().at(-1);
    assert.deepEqual({ ...tea }, { v: 1, key: `${k.trip}|${w.id}`, title: 'Big Sur', body: 'Tea time.', at: at('10:00'), scope: k.trip, watch: w.id });
    assert.deepEqual(await k.mirror.status().then((s) => [s.on, s.relay, s.waiting]), [true, RELAY, 2], 'it waits as "sent" until annai hears');
  } finally {
    await k.stop();
  }
});

test('annai on screen says it at its time and calls off the relay\'s copy before the relay would send it: no second reminder', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 1);
    await k.to(at('10:00'));
    assert.equal(k.agent.wakes.length, 1, 'said on the phone');
    await k.flush();
    assert.deepEqual(await k.waiting(), [], 'called off, before its send');
    await k.deliver(at('10:01'));
    assert.equal(k.pushed().length, 1, 'only the turn-on notification ever came');
  } finally {
    await k.stop();
  }
});

test('a reminder said on screen while many are still being sent is called off first; the rest follow', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const soon = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('08:31') }, fallback: 'Soon.' });
    for (let h = 10; h < 20; h++) await k.live.setWatch(k.trip, { when: { type: 'time', at: iso(`${h}:00`) }, fallback: `At ${h}.` });
    /** @type {() => void} */
    let open = () => {};
    k.net.gate = new Promise((r) => { open = () => r(undefined); });
    const from = k.net.calls.length;
    await k.to(k.clock.now() + 600); // the sync starts
    for (let i = 0; i < 200 && k.net.calls.length === from; i++) await new Promise((r) => setTimeout(r, 5)); // the nearest is being sent, held at the gate (encrypting takes real time)
    assert.equal(k.net.calls.length, from + 1);
    await k.to(at('08:31')); // meanwhile annai, on screen, says it
    assert.equal(k.agent.wakes.length, 1);
    k.net.gate = null;
    open();
    await k.flush(2000);
    const calls = k.net.calls.slice(from).map((c) => c.method);
    assert.deepEqual(calls.slice(0, 2), ['POST', 'DELETE'], 'the one just said is called off before the others are sent');
    assert.equal(calls.filter((m) => m === 'POST').length, 11);
    const waiting = await k.waiting();
    assert.equal(waiting.length, 10);
    assert.ok(waiting.every((w) => w.sendAt > at('09:00')), `${soon.id} is not among them`);
  } finally {
    await k.stop();
  }
});

test('cancelling a watch calls it off; a new one is sent; a plan item moved later moves its reminder', async () => {
  const k = await pushKit({ plan: { tea: TEA }, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 2);
    await k.live.cancelWatch(k.trip, w.id);
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('15:45') + GRACE_MS]);
    await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA, start: { at: iso('17:00'), tz: LA } }, { author: 'user' });
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('16:45') + GRACE_MS]);
    const deletes = k.net.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 2);
  } finally {
    await k.stop();
  }
});

test('when a reminder moves at the relay (6b choice 2)', () => {
  const now = at('09:00');
  assert.equal(moves(at('11:30'), at('11:30'), now), false);
  assert.equal(moves(at('11:30'), at('11:30') - MOVE_MS, now), true, '5 minutes earlier: a closed annai would be late');
  assert.equal(moves(at('11:30'), at('11:27'), now), false, 'a little earlier: annai on screen says it first anyway');
  assert.equal(moves(at('11:30'), at('11:40'), now), false, 'later, but the relay\'s time is far off: there is time');
  assert.equal(moves(at('09:08'), at('09:12'), now), true, 'later, and the relay\'s copy comes within 10 minutes: it would come first');
  assert.equal(moves(at('09:00') + NEAR_MS + 1, at('09:30'), now), false);
  const m = (/** @type {string} */ key, /** @type {number} */ due) => ({ m: { key, scope: 't', watch: key, due, text: '' }, sendAt: due + GRACE_MS, title: 'T', body: '', hash: 'h' });
  const items = { a: { id: 'x.a', due: at('10:00'), sendAt: at('10:00') + GRACE_MS, hash: 'h', scope: 't' }, b: { id: 'x.b', due: at('11:00'), sendAt: 0, hash: 'h', scope: 't' }, c: { id: 'x.c', due: at('12:00'), sendAt: 0, hash: 'h', scope: 't', sending: true } };
  const wanted = new Map([['a', m('a', at('10:00'))], ['b', { ...m('b', at('11:00')), hash: 'changed' }], ['c', m('c', at('12:00'))], ['d', m('d', at('13:00'))]]);
  const p = plan(items, wanted, now);
  assert.deepEqual(p.off, ['b']);
  assert.deepEqual(p.send.map((w) => [w.m.key, Boolean(w.reuse)]), [['b', false], ['c', true], ['d', false]]);
});

test('"leave soon" moves at the relay only when it matters, not at every fix', async () => {
  const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } };
  const k = await pushKit({ plan: { nepenthe: NEP } });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('11:30') + GRACE_MS]);
    await k.fix(at('09:00'), { lat: 36.6036, lng: -121.8916 }); // Monterey: much further than the plan said
    await k.flush(CALM_MS + 1000); // a new fix is calm news: looked at within 30 s
    const [far] = await k.waiting();
    assert.ok(far.sendAt < at('11:30'), 'moved earlier');
    const posts = k.net.calls.filter((c) => c.method === 'POST').length;
    const syncs = (await k.events(['push.sync'], SYS_DEVICE)).length;
    for (let i = 1; i <= 30; i++) await k.fix(at('09:00') + CALM_MS + i * 1000, { lat: 36.6036 - i * 0.00001, lng: -121.8916 }, { speed: 1 });
    await k.flush(CALM_MS + 1000);
    assert.equal(k.net.calls.filter((c) => c.method === 'POST').length, posts, 'a few meters changes nothing at the relay');
    assert.equal((await k.events(['push.sync'], SYS_DEVICE)).length, syncs, 'and thirty fixes a second apart are not thirty syncs that change something');
  } finally {
    await k.stop();
  }
});

test("removing a trip calls off its reminders at once (spec §4.9)", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.live.setWatch(ME, { when: { type: 'time', at: iso('11:00') }, fallback: 'Call home.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 2);
    k.agent.opened(null);
    await k.live.forget(k.trip);
    await k.flush();
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('11:00') + GRACE_MS]);
    const st = await k.ws.readJSON(SYS_DEVICE, FILE);
    assert.equal(JSON.stringify(st).includes(k.trip), false, "the trip's id is gone from this device's state");
  } finally {
    await k.stop();
  }
});

test('no connection: nothing is lost; what failed goes when it is back; a restart sends again what it began, kept once', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    k.net.offline = true;
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.deepEqual(await k.waiting(), []);
    const st = await k.mirror.status();
    assert.match(String(st.problem?.message), /couldn't reach the relay/);
    k.net.offline = false;
    await k.mirror.sync();
    assert.equal((await k.waiting()).length, 1);
    assert.equal((await k.mirror.status()).problem, null);
    await k.live.cancelWatch(k.trip, w.id);
    k.net.offline = true;
    await k.flush();
    assert.equal((await k.waiting()).length, 1, 'the cancel waits');
    k.net.offline = false;
    await k.flush(31 * MIN); // the retry
    assert.deepEqual(await k.waiting(), [], 'called off once the connection is back');
  } finally {
    await k.stop();
  }
});

test('a send cut off before its answer is sent again with the same id and token, and kept once', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    const st = await k.ws.readJSON(SYS_DEVICE, FILE);
    const [key] = Object.keys(st.items);
    await k.ws.write(SYS_DEVICE, FILE, { ...st, items: { [key]: { ...st.items[key], sending: true } } }, { author: 'system' }); // as if the answer never came
    await k.mirror.sync();
    assert.equal((await k.waiting()).length, 1);
    assert.equal((await k.ws.readJSON(SYS_DEVICE, FILE)).items[key].sending, undefined);
  } finally {
    await k.stop();
  }
});

test('turning off calls everything off and unsubscribes; turning on again sends again', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    await k.mirror.turnOff();
    assert.deepEqual(await k.waiting(), []);
    assert.equal(k.source.sub, null);
    assert.deepEqual(await k.mirror.status().then((s) => [s.on, s.waiting]), [false, 0]);
    assert.deepEqual(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret(TOKENS)), undefined, 'no token left');
    await k.mirror.turnOn(RELAY);
    await k.flush();
    assert.equal((await k.waiting()).length, 1);
    assert.equal(k.pushed().filter((p) => p.test).length, 2, 'a new subscription: a new "notifications are on"');
  } finally {
    await k.stop();
  }
});

test("the relay's key changed: annai subscribes again by itself, says so once, and sends everything again", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.env.VAPID_KEY = await newVapidJwk();
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
    await k.flush();
    await k.flush();
    assert.equal(k.source.made, 2);
    assert.equal(k.source.sub.serverKey, await k.key());
    const mine = (await k.waiting()).filter((x) => x.endpoint === k.source.sub.endpoint);
    assert.equal(mine.length, 2);
    assert.match(k.pushed().at(-1).body, /on again/);
  } finally {
    await k.stop();
  }
});

test('the relay forgot this phone (unconfirmed): "on again", then the rest', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    for (const o of k.env.RELAY.objects.values()) await o.storage.delete('confirmed'); // a relay restart
    for (let h = 10; h < 15; h++) await k.live.setWatch(k.trip, { when: { type: 'time', at: iso(`${h}:00`) }, fallback: `At ${h}.` });
    await k.flush();
    await k.flush(2 * MIN);
    assert.equal((await k.waiting()).length, 5);
    assert.match(k.pushed().at(-1).body, /on again/);
  } finally {
    await k.stop();
  }
});

test('the phone dropped the subscription: with permission, annai subscribes again by itself; without, one notice', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.source.sub = null;
    await k.mirror.sync();
    await k.flush();
    assert.equal(k.source.made, 2);
    assert.equal((await k.waiting()).filter((x) => x.endpoint === k.source.sub.endpoint).length, 1);
    k.source.sub = null;
    k.source.allowed = 'denied';
    await k.mirror.sync();
    await k.mirror.sync();
    assert.equal(k.notices.length, 1);
    assert.match(k.notices[0].body, /Settings → Notifications/);
    const st = await k.mirror.status();
    assert.equal(st.problem?.needsYou, true);
  } finally {
    await k.stop();
  }
});

test('the nearest 150, within 29 days, wait at the relay', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    for (let i = 0; i < 160; i++) {
      const t = new Date(at('10:00') + i * 3 * 3_600_000);
      await k.live.setWatch(k.trip, { when: { type: 'time', at: t.toISOString().replace('.000Z', 'Z') }, fallback: `No. ${i}` });
    }
    await k.live.setWatch(k.trip, { when: { type: 'time', at: new Date(at('10:00') + 31 * 86_400_000).toISOString().replace('.000Z', 'Z') }, fallback: 'Too far.' });
    await k.flush(5 * MIN);
    const waiting = await k.waiting();
    assert.equal(waiting.length, MAX_WAITING);
    assert.ok(Math.max(...waiting.map((x) => x.sendAt)) < at('10:00') + 150 * 3 * 3_600_000);
  } finally {
    await k.stop();
  }
});

test('keys never show: no cancel token, p256dh or auth in any event or file; every relay request is in the trace', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    await k.live.cancelWatch(k.trip, w.id);
    await k.flush();
    const tokens = k.net.calls.map((c) => c.auth?.replace('Bearer ', '')).filter((x) => typeof x === 'string' && x.length > 20);
    assert.ok(tokens.length >= 2);
    const secrets = [...tokens, toBase64Url(k.source.sub.p256dh), toBase64Url(k.source.sub.auth)];
    const scopes = await k.store.tx(['scopes'], 'readonly', (t) => t.listScopes());
    let everything = '';
    for (const s of scopes) everything += JSON.stringify(await k.store.tx(['events'], 'readonly', (t) => t.listEvents(s.id)));
    // Every stored content, every file's history included.
    await k.store.tx(['blobs'], 'readonly', async (t) => {
      for (const b of await t.listBlobs()) everything += new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0)));
    });
    for (const s of secrets) assert.equal(everything.includes(s), false, 'a key in an event or a file');
    const traced = (await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS_DEVICE, { types: ['net.request'] }))).map((e) => `${e.data.tool} ${e.data.method} ${new URL(e.data.url).pathname}`);
    assert.equal(traced.length, k.net.calls.length, 'every relay request');
    assert.ok(traced.includes('push relay GET /v1/vapid'));
    assert.ok(traced.includes('push relay POST /v1/schedule'));
    assert.ok(traced.some((x) => /^push relay DELETE \/v1\/schedule\/[\w-]+\.[\w-]+$/.test(x)));
    assert.ok((await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS_DEVICE, { types: ['push.sync'] }))).length >= 2);
  } finally {
    await k.stop();
  }
});

test('a notification shown means its copy left the relay: forgotten without a DELETE', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.mirror.delivered([{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:00:30') }]);
    await k.mirror.settled();
    assert.equal((await k.mirror.status()).waiting, 0);
  } finally {
    await k.stop();
  }
});

test('the test notification reaches the push service 15 s later', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    await k.mirror.test();
    await k.deliver(k.clock.now() + 15_000);
    assert.match(k.pushed().at(-1).body, /^A test/);
  } finally {
    await k.stop();
  }
});

test("errors in plain words: an address that isn't one; a relay that can't be reached; one reminder refused", async () => {
  const k = await pushKit({ live: false });
  try {
    await assert.rejects(k.mirror.turnOn('ftp://push.example'), /must start with https:\/\//);
    assert.equal(relayAddress('http://localhost:8796/'), 'http://localhost:8796');
    assert.equal(relayAddress('https://push.annai.guide/'), 'https://push.annai.guide');
    assert.equal(relayAddress('http://push.annai.guide'), null);
    k.net.offline = true;
    await assert.rejects(k.mirror.turnOn(RELAY), /couldn't reach the relay at push\.annai\.guide/);
    assert.equal((await k.mirror.status()).on, false, 'nothing turned on');
    k.net.offline = false;
    const client = relayClient({ base: RELAY, fetch: async () => new Response('<html>', { status: 502 }) });
    await assert.rejects(client.vapid(), (e) => e instanceof RelayError && e.code === 'relay' && /answered 502/.test(e.message));
    const odd = relayClient({ base: RELAY, fetch: async () => new Response('{"key":5}', { status: 200 }) });
    await assert.rejects(odd.vapid(), (e) => e instanceof RelayError && /a key annai can't use/.test(e.message));
  } finally {
    await k.stop();
  }
});

test("a relay's message holding a cancel token is blanked before annai keeps or shows it", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const real = k.env.RELAY.get;
    k.env.RELAY.get = (/** @type {any} */ id) => ({
      fetch: async (/** @type {Request} */ req) => {
        const t = JSON.parse(await req.clone().text()).token;
        return new Response(JSON.stringify({ error: 'nope', message: `I saw ${t}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.env.RELAY.get = real;
    const st = await k.mirror.status();
    assert.match(String(st.problem?.message), /refused/);
    assert.doesNotMatch(String(st.problem?.message), /[\w-]{40,}/, 'no token in it');
  } finally {
    await k.stop();
  }
});

test("the phone's subscription can't be read yet (annai's offline service is starting): no card, and tried again later", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const get = k.source.get;
    k.source.get = async () => { throw new Error("annai's offline service isn't running yet. Try again in a moment."); };
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    assert.equal(k.notices.length, 0, 'not "notifications are off"');
    const st = await k.mirror.status();
    assert.equal(st.problem?.needsYou, false);
    assert.match(String(st.problem?.message), /isn't running yet/);
    assert.equal(k.source.made, 1, 'not subscribed again');
    k.source.get = get;
    await k.flush(2 * MIN);
    assert.equal((await k.waiting()).length, 1);
  } finally {
    await k.stop();
  }
});

test('a new relay address, even one with the same key, gets everything, and the old one has it called off (choice 13)', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    const from = k.net.calls.length;
    await k.mirror.setRelay('https://relay.example');
    await k.flush();
    const calls = k.net.calls.slice(from).map((c) => `${c.method} ${new URL(c.url).host}`);
    assert.ok(calls.includes('DELETE push.annai.guide'), calls.join(', '));
    assert.ok(calls.includes('POST relay.example'), calls.join(', '));
    assert.equal((await k.mirror.status()).relay, 'https://relay.example');
    assert.equal((await k.waiting()).length, 1);
  } finally {
    await k.stop();
  }
});

test("a cancel at an old relay that can't be reached never holds up the new one, and is dropped once its time has passed (fix pass N1)", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.net.down.add('push.annai.guide'); // the old relay is off (a laptop relay after the test)
    await k.mirror.setRelay('https://relay.example');
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
    await k.flush();
    const posts = k.net.calls.filter((c) => c.method === 'POST' && new URL(c.url).host === 'relay.example');
    assert.equal(posts.length, 2, 'both reminders reach the new relay');
    const st = await k.mirror.status();
    assert.equal(st.waiting, 2);
    assert.match(String(st.problem?.message), /old relay/);
    assert.match(String(st.problem?.message), /push\.annai\.guide/);
    assert.equal(st.problem?.needsYou, false);
    k.sensors.visible(false); // off screen: nothing fires on the phone meanwhile
    await k.settle();
    await k.to(at('10:45'));
    await k.mirror.sync();
    const file = await k.ws.readJSON(SYS_DEVICE, FILE);
    assert.deepEqual(file.cancels, [], 'past its time, the old reminder is not called off any more: it was sent, or never will be');
  } finally {
    await k.stop();
  }
});

test('a DELETE the relay fails (5xx) holds up no other send; it is tried again until it goes', async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    k.net.failDeletes = true;
    await k.live.cancelWatch(k.trip, w.id);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
    await k.flush();
    assert.equal((await k.waiting()).length, 2, 'the new one is there; the old one still, until its DELETE goes');
    assert.ok(k.net.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/schedule')));
    k.net.failDeletes = false;
    await k.flush(3 * MIN);
    assert.deepEqual((await k.waiting()).map((x) => x.sendAt), [at('11:00') + GRACE_MS]);
  } finally {
    await k.stop();
  }
});

test('with no connection, annai waits for it to come back rather than trying every half minute (fix pass N4)', async () => {
  const k = await pushKit();
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    k.net.online = false;
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('12:00') }, fallback: 'Lunch.' });
    const from = k.net.calls.length;
    for (let i = 0; i < 30; i++) await k.fix(at('08:31') + i * 10_000, { lat: 36.6036, lng: -121.8916 }); // calm news, every 10 s for 5 min
    await k.flush(CALM_MS + 1000);
    assert.equal(k.net.calls.length, from, 'not one request without a connection');
    assert.match(String((await k.mirror.status()).problem?.message), /no connection/i);
    k.net.online = true;
    await k.mirror.sync(); // the browser's online event
    assert.equal((await k.waiting()).length, 1);
  } finally {
    await k.stop();
  }
});

test("a relay that can't be reached is tried again after 1, 2, 4… minutes: calm news meanwhile doesn't cut the wait short (fix pass N4)", async () => {
  const k = await pushKit();
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    k.net.offline = true; // the browser says online, but nothing gets through
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('12:00') }, fallback: 'Lunch.' });
    const failed = () => k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS_DEVICE, { types: ['net.request'] })).then((l) => l.filter((e) => e.data.status === 0).length);
    const before = await failed();
    for (let i = 0; i < 36; i++) { // 6 minutes of fixes, each looked at as it comes
      await k.fix(at('08:31') + i * 10_000, { lat: 36.6036, lng: -121.8916 });
      await k.mirror.settled();
    }
    await k.flush(1000);
    const tries = (await failed()) - before;
    assert.ok(tries >= 2 && tries <= 4, `${tries} failed requests in 6 minutes`);
  } finally {
    await k.stop();
  }
});

test('relay errors say what to do next (§17 rule 3): at turn-on, tap again; in the background, nothing to do; a wrong address, check it (fix pass N5)', async () => {
  const k = await pushKit({ live: false });
  try {
    k.net.offline = true;
    await assert.rejects(k.mirror.turnOn(RELAY), (/** @type {any} */ e) => /couldn't reach the relay at push\.annai\.guide/.test(e.message)
      && /Nothing was turned on/.test(e.message) && /tap Turn on notifications again/.test(e.message) && !/tries again by itself/.test(e.message));
    k.net.offline = false;
    await k.mirror.turnOn(RELAY);
    await k.flush();
    k.net.offline = true;
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    const bg = String((await k.mirror.status()).problem?.message);
    assert.match(bg, /couldn't reach the relay at push\.annai\.guide/);
    assert.match(bg, /annai tries again by itself/);
    const wrong = relayClient({ base: 'https://example.com', fetch: async () => new Response('<html>Not Found</html>', { status: 404 }) });
    await assert.rejects(wrong.vapid(), (e) => e instanceof RelayError && /no annai push relay at example\.com/.test(e.message) && /Check the relay address/.test(e.message));
  } finally {
    await k.stop();
  }
});
