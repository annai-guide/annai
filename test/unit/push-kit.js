import { liveKit, at, iso, LA } from './live-kit.js';
import { makeRelay } from '../../relay/src/relay.js';
import { memoryNamespace } from '../../relay/memory.js';
import { newVapidJwk, readVapidKey } from '../../relay/src/vapid.js';
import { startPushService } from '../fakes/push-service.js';
import { PushMirror } from '../../src/core/push/mirror.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { SYS_DEVICE } from '../../src/core/scopes.js';

export { at, iso, LA };
export const RELAY = 'https://push.annai.guide';

/**
 * The phone's push subscription, as a test drives it: a subscription at the stand-in push service,
 * made with whatever key annai gives, and the permission the user gave.
 * @param {Awaited<ReturnType<typeof startPushService>>} service
 */
export function fakeSource(service) {
  const s = {
    allowed: 'granted',
    /** @type {any} */
    sub: null,
    made: 0,
    supported: () => /** @type {const} */ ('yes'),
    permission: () => s.allowed,
    ask: async () => s.allowed,
    get: async () => s.sub,
    /** @param {string} key */
    subscribe: async (key) => {
      if (s.allowed !== 'granted') throw new Error('not allowed');
      s.sub = await service.subscribe(key);
      s.made++;
      return s.sub;
    },
    unsubscribe: async () => {
      if (s.sub) service.drop(s.sub.endpoint);
      s.sub = null;
    },
  };
  return s;
}

/**
 * The relay's own code in memory on a clock of the test's, sending to the stand-in push service over
 * HTTP, and a fetch to it the test can break: offline, a host down, DELETEs failing, a gate.
 * @param {() => number} now
 */
export async function relayRig(now) {
  const jwk = await newVapidJwk();
  const service = await startPushService({ now });
  const { worker, PushRelay } = makeRelay({ now, send: (url, init) => fetch(url, init) });
  /** @type {any} */
  const env = { VAPID_KEY: jwk, ORIGINS: '', EXTRA_PUSH_ORIGINS: service.origin };
  env.RELAY = memoryNamespace(PushRelay, env, { now, timers: false });
  /**
   * offline: every request fails; down: hosts whose requests fail; failDeletes: DELETEs answer 503; online: what the
   * browser says of the connection; gate: schedules wait for it; calls: every request, in order
   */
  const net = { offline: false, down: new Set(), failDeletes: false, online: true, gate: /** @type {Promise<unknown> | null} */ (null), calls: /** @type {{ method: string, url: string, auth: string | null }[]} */ ([]) };
  const relayFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
    const req = new Request(url, init);
    if (net.offline || net.down.has(new URL(req.url).host)) throw new TypeError('Failed to fetch');
    net.calls.push({ method: req.method, url: req.url, auth: req.headers.get('Authorization') });
    if (req.method === 'DELETE' && net.failDeletes) return new Response(JSON.stringify({ error: 'relay', message: 'The relay is down.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    if (req.method === 'POST' && net.gate) await net.gate;
    return worker.fetch(req, env);
  };
  return { service, env, net, relayFetch };
}

/**
 * Live mode (liveKit) with a mirror, against the relay's own code in memory, which sends to the
 * stand-in push service over HTTP. Everything runs on the live kit's clock.
 * @param {Parameters<typeof liveKit>[0]} [o]
 */
export async function pushKit(o) {
  const k = await liveKit(o);
  const { service, env, net, relayFetch } = await relayRig(() => k.clock.now());
  const source = fakeSource(service);
  /** @type {any[]} */
  const notices = [];
  const make = () => new PushMirror({ store: k.store, ws: k.ws, live: k.live, source, fetch: tracedFetch(k.store, SYS_DEVICE, { tool: 'push relay' }, relayFetch), clock: k.clock, notice: (n) => notices.push(n), online: () => net.online });
  const mirror = make();
  await mirror.start().catch(async (e) => {
    await service.stop();
    throw e;
  });
  const kit = {
    ...k, service, env, net, source, mirror, notices,
    key: async () => (await readVapidKey(env.VAPID_KEY)).publicKey,
    /**
     * Lets the clock and the mirror catch up, 5 s at a time, each step's syncs done: a retry the mirror
     * sets during a sync is a timer the manual clock must still meet.
     */
    async flush(ms = 1000) {
      const end = k.clock.now() + ms;
      for (;;) {
        const step = Math.min(end, k.clock.now() + 5000);
        await k.to(step);
        await kit.mirror.settled();
        await k.settle();
        await kit.mirror.settled();
        if (step >= end) break;
      }
      // News that came while settling set a half-second timer: one more short step meets it.
      await k.to(k.clock.now() + 600);
      await kit.mirror.settled();
      await k.settle();
      await kit.mirror.settled();
    },
    /** The page reloads, mirror and all (restart is Live alone): both stop, and new ones start over the same store and relay. */
    async reopen() {
      kit.mirror.dispose();
      await k.restart();
      kit.live = k.live;
      kit.mirror = make();
      await kit.mirror.start();
      await kit.mirror.settled();
    },
    /** What waits at the relay, every subscription. @returns {Promise<any[]>} */
    waiting: () => env.RELAY.waiting(),
    /** The relay's payloads, in bytes. */
    async payloads() {
      const out = [];
      for (const o of env.RELAY.objects.values()) for (const [, p] of await o.storage.list({ prefix: 'p:' })) out.push(Buffer.from(p, 'base64url'));
      return out;
    },
    /** The clock to t, and what came due at the relay sent. @param {number} t */
    async deliver(t) {
      await k.to(t);
      await env.RELAY.runDue();
    },
    /** What the push service delivered, opened. */
    pushed: () => service.received.filter((r) => r.status === 201).map((r) => JSON.parse(String(r.plaintext))),
    async stop() {
      kit.mirror.dispose();
      k.live.dispose();
      await service.stop();
    },
  };
  return kit;
}

/**
 * Makes reads of the kit's store fail, as an aborted IndexedDB read does: a rejection. fails(op, key, path) decides for one read, of any call a
 * read-only transaction makes, with that call's name and arguments: 'getFile' (key: scope, path: file), 'listFiles' (key: scope, path: prefix),
 * 'getSecret', 'getScope', 'getBlob' (key: its id), 'listEvents' (key: scope), 'listScopes'. Writes pass.
 * The memory store's reads never fail, so a test that wants one breaks it here.
 * @param {{ store: import('../../src/core/types.js').Store }} k
 * @param {(op: string, key: string, path?: any) => boolean} fails
 * @returns {{ log: string[], heal: () => void }}
 */
export function breakReads(k, fails) {
  const real = k.store.tx.bind(k.store);
  /** @type {string[]} */
  const log = [];
  const abort = () => new DOMException('The transaction was aborted, so the request cannot be fulfilled.', 'AbortError');
  /** @type {any} */ (k.store).tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => real(stores, mode, mode !== 'readonly' ? fn : (/** @type {any} */ t) => fn(new Proxy(t, {
    get(o, name) {
      const v = o[name];
      if (typeof v !== 'function') return v;
      return async (/** @type {any[]} */ ...a) => {
        if (fails(String(name), a[0], a[1])) {
          log.push(`${String(name)} ${typeof a[1] === 'string' ? a[1] : a[0]}`);
          throw abort();
        }
        return v.apply(o, a);
      };
    },
  })));
  return { log, heal: () => { /** @type {any} */ (k.store).tx = real; } };
}
