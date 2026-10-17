import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeNews } from '../../src/ui/push.js';
import { liveKit, at } from './live-kit.js';

/** A cache like the service worker's, slow enough that two readers could both see an entry before either deletes it. */
function slowCaches(entries) {
  const box = new Map(entries.map((e, i) => [`/push-news/${i}`, JSON.stringify(e)]));
  const later = () => new Promise((r) => setTimeout(r, 5));
  return {
    open: async () => ({
      keys: async () => { await later(); return [...box.keys()]; },
      match: async (/** @type {string} */ k) => { await later(); return box.has(k) ? new Response(box.get(k)) : undefined; },
      delete: async (/** @type {string} */ k) => { await later(); return box.delete(k); },
    }),
  };
}

test("the service worker's news is read once, however many ask at the same moment (fix pass N2)", async () => {
  const caches = /** @type {any} */ (slowCaches([{ kind: 'opened', key: 'k', t: 1 }]));
  const [a, b] = await Promise.all([takeNews(caches), takeNews(caches)]);
  assert.equal(a.length + b.length, 1);
});

test('a notification opened as annai comes forward: one "opened the reminder", however the news arrives (fix pass N2)', async () => {
  /** @type {any[]} */
  const inbox = [];
  const k = await liveKit({ live: false, news: async () => { const got = inbox.slice(); await new Promise((r) => setTimeout(r, 5)); inbox.length = 0; return got; } });
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('09:00'));
  inbox.push({ kind: 'opened', key: `${k.trip}|w-1`, scope: k.trip, watch: 'w-1', body: 'Tea time.', t: at('09:00') });
  k.sensors.visible(true); // the catch-up reads the news…
  await k.live.newsArrived(); // …and the service worker's message says so too
  await k.settle();
  assert.equal((await k.events(['push.opened'])).length, 1);
  assert.equal(k.agent.wakes.filter((w) => /opened the reminder/.test(w.text)).length, 1);
});
