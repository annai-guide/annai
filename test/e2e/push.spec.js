import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, writeRecords, filterTrace } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn, setUp, say, plus, sse, sleep } from './push-helpers.js';

test('a reminder Shiori sets waits at the relay, encrypted, reaches the push service at its time, and opening it starts a catch-up wake (spec §11.6, §20 row 6)', async ({ page }) => {
  const start = Date.now();
  const due = Date.parse(plus(start, 4 * 60_000));
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: plus(start, 4 * 60_000) }, fallback: 'Call Grandma.' } }, sleep])),
      sse(anthropicToolReply([sleep])),
    ],
  });
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    const trip = await setUp(page, llm.origin);
    await notificationsOn(page, kit.relay.origin);
    await page.goto('/#/now');
    await say(page, 'Remind me to call Grandma.');
    await expect.poll(async () => (await kit.waiting()).length).toBe(1);
    const [w] = await kit.waiting();
    expect(w.sendAt).toBe(due + 30_000);
    await kit.at(w.sendAt);
    const reminder = kit.pushed().at(-1);
    expect(reminder).toMatchObject({ title: 'Big Sur', body: 'Call Grandma.', scope: trip });
    expect(kit.service.received.at(-1)?.bytes).toBe(3174);
    // Opening it (no browser lets a test tap a notification): the tap as the service worker writes it down.
    await page.evaluate(async (r) => {
      const box = await caches.open('annai-push');
      await box.put(`/push-news/${Date.now()}-tap`, new Response(JSON.stringify({ kind: 'opened', key: r.key, scope: r.scope, watch: r.watch, at: r.at, title: r.title, body: r.body, t: Date.now() })));
    }, reminder);
    await page.reload();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const wake = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(wake).toContain('Catch-up: ');
    expect(wake).toContain('The user opened the reminder \\"Call Grandma.\\" from its notification at');
    // Every relay request is in the trace, and no token or key is anywhere in annai's records.
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('ol.trace .d', { hasText: /^push relay · POST http:\/\/127\.0\.0\.1:\d+\/v1\/schedule · 201/ }).first()).toBeVisible();
    const leaked = await page.evaluate(async (keys) => {
      const load = (/** @type {string} */ url) => import(url);
      const { createIdbStore } = await load('/src/core/store-idb.js');
      const store = await createIdbStore();
      const tokens = Object.values((await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('push:tokens'))) ?? {});
      let all = '';
      for (const s of await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.listScopes())) all += JSON.stringify(await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(s.id)));
      // Every stored content, every file's history included.
      await store.tx(['blobs'], 'readonly', async (/** @type {any} */ t) => {
        for (const b of await t.listBlobs()) all += new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0)));
      });
      store.close();
      return [...tokens, ...keys].filter((k) => all.includes(String(k)));
    }, [Buffer.from(kit.sub.p256dh).toString('base64url'), Buffer.from(kit.sub.auth).toString('base64url')]);
    expect(leaked).toEqual([]);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});

test('with annai open, a reminder that comes due is said on the phone and called off at the relay: no second one', async ({ page }) => {
  const start = Date.now();
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: plus(start, 45_000) }, fallback: 'Stretch.' } }, sleep])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Time to stretch.' } }, sleep])),
    ],
  });
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    await setUp(page, llm.origin);
    await notificationsOn(page, kit.relay.origin);
    await page.goto('/#/now');
    await say(page, 'Remind me to stretch.');
    await expect.poll(async () => (await kit.waiting()).length).toBe(1);
    await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 70_000 }).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Stretch.');
    await expect.poll(async () => (await kit.waiting()).length, { timeout: 15_000 }).toBe(0);
    await kit.at(Date.parse(plus(start, 45_000)) + 60_000);
    expect(kit.pushed().filter((p) => !p.test)).toEqual([]);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});

test("a plan item moved moves its reminder at the relay; removing the trip calls it off (spec §11.6, §4.9)", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': sse(anthropicToolReply([sleep])) });
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    const trip = await setUp(page, llm.origin);
    const start = Date.now();
    await writeRecords(page, trip, { write: { '/plan/tea.json': { id: 'tea', title: 'Tea at the inn', fixed: true, start: { at: plus(start, 60 * 60_000), tz: 'UTC' } } } });
    await page.reload();
    await notificationsOn(page, kit.relay.origin);
    await expect.poll(async () => (await kit.waiting()).map((x) => x.sendAt)).toEqual([Date.parse(plus(start, 45 * 60_000)) + 30_000]);
    await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
    await writeRecords(page, trip, { patch: { '/plan/tea.json': { start: { at: plus(start, 90 * 60_000), tz: 'UTC' } } } });
    await page.reload();
    await expect.poll(async () => (await kit.waiting()).map((x) => x.sendAt), { timeout: 15_000 }).toEqual([Date.parse(plus(start, 75 * 60_000)) + 30_000]);
    await page.getByRole('button', { name: 'Remove trip' }).click();
    await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
    await expect.poll(async () => (await kit.waiting()).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});

