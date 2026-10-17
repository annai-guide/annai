import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn, setUp, say, away, plus, sse, sleep, APP } from './push-helpers.js';

// The phone's side of a push, which only Chromium's DevTools protocol can drive: it runs in the
// "chromium-notifications" project (playwright.config.js), Chromium's new headless mode, which shows
// notifications; the default headless shell refuses them.

test('a push for a reminder reaches the service worker while annai is away: a notification, and the catch-up says when it was shown', async ({ page, context }) => {
  const start = Date.now();
  const due = plus(start, 20_000);
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: due }, fallback: 'Call Grandma.' } }, sleep])),
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
    await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}: ${n.body}`))).toContain('Big Sur: Call Grandma.');
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
