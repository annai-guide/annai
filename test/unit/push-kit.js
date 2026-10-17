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
 * Live mode (liveKit) with a mirror, against the relay's own code in memory, which sends to the
 * stand-in push service over HTTP. Everything runs on the live kit's clock.
 * @param {Parameters<typeof liveKit>[0]} [o]
 */
export async function pushKit(o) {
  const k = await liveKit(o);
  const service = await startPushService({ now: () => k.clock.now() });
  const { worker, PushRelay } = makeRelay({ now: () => k.clock.now(), send: (url, init) => fetch(url, init) });
  const jwk = await newVapidJwk();
  /** @type {any} */
  const env = { VAPID_KEY: jwk, ORIGINS: '', EXTRA_PUSH_ORIGINS: service.origin };
  env.RELAY = memoryNamespace(PushRelay, env, { now: () => k.clock.now(), timers: false });
  /** offline: every request fails; gate: schedules wait for it; calls: every request, in order */
  const net = { offline: false, gate: /** @type {Promise<unknown> | null} */ (null), calls: /** @type {{ method: string, url: string, auth: string | null }[]} */ ([]) };
  const relayFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    const req = new Request(url, init);
    net.calls.push({ method: req.method, url: req.url, auth: req.headers.get('Authorization') });
    if (req.method === 'POST' && net.gate) await net.gate;
    return worker.fetch(req, env);
  };
  const source = fakeSource(service);
  /** @type {any[]} */
  const notices = [];
  const mirror = new PushMirror({ store: k.store, ws: k.ws, live: k.live, source, fetch: tracedFetch(k.store, SYS_DEVICE, { tool: 'push relay' }, relayFetch), clock: k.clock, notice: (n) => notices.push(n) });
  await mirror.start();
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
        await mirror.settled();
        await k.settle();
        await mirror.settled();
        if (step >= end) break;
      }
      // News that came while settling set a half-second timer: one more short step meets it.
      await k.to(k.clock.now() + 600);
      await mirror.settled();
      await k.settle();
      await mirror.settled();
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
      mirror.dispose();
      k.live.dispose();
      await service.stop();
    },
  };
  return kit;
}
