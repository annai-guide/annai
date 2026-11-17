import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, waitForServiceWorker } from './helpers.js';
import { pushKit, fakeSubscription, notificationsOn } from './push-helpers.js';
import { key } from '../../src/core/l10n.js';

/** The Driving Focus line (src/ui/screens/notifications.js), as the code says it in English. */
const DRIVING = "While Driving Focus is on, iOS silences annai's reminders (it lets no app through): they come with no sound or banner until it ends.";
/** A shipped language's words. @param {string} tag @returns {Record<string, string>} */
const words = (tag) => JSON.parse(readFileSync(new URL(`../../l10n/${tag}.json`, import.meta.url), 'utf8'));

test('iPhone in a Safari tab: notifications need the Home Screen app, and the screen says how', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'the iPhone case');
  await openApp(page, '#/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText(/work only in the Home Screen app/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0);
  // Driving Focus matters once notifications can come: in the Home Screen app.
  await expect(page.getByText(/Driving Focus/)).toHaveCount(0);
});

test("the installed app on an iPhone says Driving Focus silences annai's reminders, in every language; an Android phone doesn't (the user's pick 2026-11-17)", async ({ page, browserName }) => {
  await fakeSubscription(page, { endpoint: 'https://push.example/s', p256dh: new Uint8Array(65).fill(4), auth: new Uint8Array(16).fill(1) });
  await openApp(page, '#/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toBeVisible();
  if (browserName !== 'webkit') {
    await expect(page.getByText(/Driving Focus/)).toHaveCount(0);
    return;
  }
  await expect(page.getByText(DRIVING)).toBeVisible();
  for (const tag of ['ja', 'zh-Hans', 'zh-Hant']) {
    const line = words(tag)[key(DRIVING)];
    expect(line, tag).toBeTruthy();
    await page.evaluate((v) => localStorage.setItem('annai.ui', v), tag);
    await page.reload();
    await expect(page.getByText(line)).toBeVisible();
  }
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
