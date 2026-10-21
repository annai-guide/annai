import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn } from './push-helpers.js';

test('iPhone in a Safari tab: notifications need the Home Screen app, and the screen says how', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'the iPhone case');
  await openApp(page, '#/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText(/work only in the Home Screen app/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0);
});

test('Settings → Notifications: what the relay learns, the address, on, a test, and off', async ({ page }) => {
  const kit = await pushKit();
  try {
    await fakeSubscription(page, kit.sub);
    await openApp(page, '#/settings');
    await waitForServiceWorker(page);
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByLabel('Relay address')).toHaveValue('https://push.annai.guide');
    const learns = page.getByRole('region', { name: 'What the relay learns' });
    await expect(learns).toContainText("can't read it");
    await expect(learns).toContainText('how many are waiting');
    await expect(learns).toContainText('never leave the phone');
    await page.getByLabel('Relay address').fill('ftp://push.example');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByRole('alert')).toContainText('must start with https://');
    await notificationsOn(page, kit.relay.origin);
    await expect.poll(() => kit.pushed().length).toBe(1);
    expect(kit.pushed()[0]).toMatchObject({ title: 'annai', test: true });
    await page.getByRole('button', { name: 'Send a test notification' }).click();
    await expect(page.locator('.toast', { hasText: 'in about 15 seconds' })).toBeVisible();
    await kit.at(Date.now() + 16_000);
    expect(kit.pushed().at(-1)?.body).toMatch(/^A test/);
    await page.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Off: reminders show only while annai is open, and none reaches you while it is closed\.$/ })).toBeVisible();
    expect(await kit.waiting()).toEqual([]);
  } finally {
    await kit.stop();
  }
});
