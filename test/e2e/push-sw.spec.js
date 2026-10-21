import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, openApp, waitForServiceWorker } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn, setUp, say, away, plus, sse, sleep, APP } from './push-helpers.js';

// The phone's side of a push, which only Chromium's DevTools protocol can drive: it runs in the
// "chromium-notifications" project (playwright.config.js), Chromium's new headless mode, which shows
// notifications; the default headless shell refuses them.

test('a push for a reminder reaches the service worker while annai is away: a notification, and the catch-up says when it was shown', async ({ page, context }) => {
  const start = Date.now();
  const due = plus(start, 20_000);
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: due }, fallback: 'Call Grandma.' } }, { name: 'speak', input: { text: 'I will remind you.' } }, sleep])),
      sse(anthropicToolReply([sleep])),
    ],
  });
  const kit = await pushKit();
  try {
    await context.grantPermissions(['notifications'], { origin: APP });
    await fakeSubscription(page, kit.sub);
    const trip = await setUp(page, llm.origin);
    await notificationsOn(page, kit.relay.origin);
    await page.goto('/#/now');
    await say(page, 'Remind me to call Grandma.');
    await expect.poll(async () => (await kit.waiting()).length).toBe(1);
    await away(page, true);
    await kit.at((await kit.waiting())[0].sendAt);
    const reminder = kit.pushed().at(-1);
    expect(reminder).toMatchObject({ body: 'Call Grandma.', scope: trip });
    // What the push service would hand the phone: the service worker gets it.
    const cdp = await context.newCDPSession(page);
    const reg = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const r = e.registrations.find((x) => x.scopeURL === `${APP}/` && !x.isDeleted);
      if (r) resolve(r.registrationId);
    }));
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: APP, registrationId: /** @type {string} */ (await reg), data: JSON.stringify(reminder) });
    // The service worker writes down that it showed it once showNotification has resolved; then the notification is there.
    const news = () => page.evaluate(async () => {
      const box = await caches.open('annai-push');
      const kinds = [];
      for (const k of await box.keys()) kinds.push(JSON.parse(await (await box.match(k))?.text() ?? '{}').kind);
      return kinds;
    });
    await expect.poll(news, { timeout: 30_000 }).toContain('shown');
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}: ${n.body}`))).toContain('Big Sur: Call Grandma.');
    expect(llm.bodies('/b/v1/messages').length, 'nothing said while away').toBe(1);
    await page.waitForTimeout(Math.max(0, Date.parse(due) - Date.now() + 1000));
    await away(page, false);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const wake = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(wake).toContain('Catch-up: annai was off screen');
    expect(wake).toMatch(/fired: the time came: [^"]*\(its notification was shown at \d\d:\d\d\)/);
  } finally {
    await kit.stop();
    await llm.stop();
  }
});

// The emulator pass: a reminder annai had already given in its catch-up, held back by the phone, popped up 6 minutes later.
test('a push for a reminder annai already gave comes quietly, and annai on screen closes it; one still waiting stays', async ({ page, context }) => {
  await context.grantPermissions(['notifications'], { origin: APP });
  await openApp(page);
  await waitForServiceWorker(page);
  const trip = await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const id = await createTrip(ws, { title: 'Big Sur' });
    // /push.json as annai keeps it: "still" waits at the relay; annai gave "given" itself.
    await ws.write('sys:device', '/push.json', { on: true, items: { [`${id}|still`]: { id: 'x', due: 1, sendAt: 2, hash: 'h', scope: id } }, given: { [`${id}|given`]: Date.now() } }, { author: 'system' });
    store.close();
    return id;
  });
  const cdp = await context.newCDPSession(page);
  const reg = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    const r = e.registrations.find((x) => x.scopeURL === `${APP}/` && !x.isDeleted);
    if (r) resolve(r.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  const push = async (/** @type {string} */ watch) => cdp.send('ServiceWorker.deliverPushMessage', {
    origin: APP, registrationId: /** @type {string} */ (await reg), data: JSON.stringify({ v: 1, key: `${trip}|${watch}`, title: 'Big Sur', body: `Reminder ${watch}.`, at: 1, scope: trip, watch }),
  });
  const showing = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.body}${n.silent ? ' (quiet)' : ''}`).sort());
  /** What the service worker wrote down as shown, as "<watch> <stale>". */
  const news = () => page.evaluate(async () => {
    const box = await caches.open('annai-push');
    const out = [];
    for (const k of await box.keys()) {
      const n = JSON.parse(await (await box.match(k))?.text() ?? '{}');
      out.push(`${n.watch} ${n.stale === true}`);
    }
    return out.sort();
  });
  await away(page, true);
  await push('given');
  await expect.poll(news, { timeout: 30_000 }).toEqual(['given true']);
  await push('still');
  await expect.poll(news, { timeout: 30_000 }).toEqual(['given true', 'still false']);
  await expect.poll(showing, { timeout: 30_000 }).toEqual(['Reminder given. (quiet)', 'Reminder still.']);
  await away(page, false); // the catch-up reads what came, and closes the stale one
  await expect.poll(showing, { timeout: 30_000 }).toEqual(['Reminder still.']);
});
