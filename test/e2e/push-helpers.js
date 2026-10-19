import { expect } from '@playwright/test';
import { openApp, waitForServiceWorker, addProvider, startTrip } from './helpers.js';
import { startRelay } from '../../relay/serve.mjs';
import { newVapidJwk } from '../../relay/src/vapid.js';
import { startPushService } from '../fakes/push-service.js';

export const APP = 'http://127.0.0.1:8790';

/**
 * The relay (relay/serve.mjs, in memory) on a clock that runs with real time plus what the test
 * adds, sending to a stand-in push service; and a subscription there for the page.
 */
export async function pushKit() {
  const service = await startPushService();
  let ahead = 0;
  const relay = await startRelay({ origins: [APP], jwk: await newVapidJwk(), extraPushOrigins: [service.origin], now: () => Date.now() + ahead, timers: false });
  const sub = await service.subscribe(relay.key);
  return {
    service, relay, sub,
    /** Moves the relay's clock on to t (ms), and sends what came due. @param {number} t */
    async at(t) {
      ahead = Math.max(ahead, t - Date.now());
      await relay.env.RELAY.runDue();
    },
    /** @returns {Promise<any[]>} */
    waiting: () => relay.env.RELAY.waiting(),
    /** What the push service delivered, opened. */
    pushed: () => service.received.filter((r) => r.status === 201).map((r) => JSON.parse(String(r.plaintext))),
    async stop() {
      await relay.close();
      await service.stop();
    },
  };
}

/** The page uses the stand-in subscription (6b choice 16). @param {import('@playwright/test').Page} page @param {{ endpoint: string, p256dh: Uint8Array, auth: Uint8Array }} sub */
export async function fakeSubscription(page, sub) {
  const s = { endpoint: sub.endpoint, p256dh: Buffer.from(sub.p256dh).toString('base64url'), auth: Buffer.from(sub.auth).toString('base64url') };
  await page.addInitScript((v) => { try { localStorage.setItem('annai.pushSubscription', JSON.stringify(v)); } catch { /* storage blocked */ } }, s);
}

/** Settings → Notifications: the relay's address, then on. @param {import('@playwright/test').Page} page @param {string} relay */
export async function notificationsOn(page, relay) {
  await page.goto('/#/notifications');
  await page.getByLabel('Relay address').fill(relay);
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByLabel('Relay address')).toHaveValue(relay);
  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^On · / })).toBeVisible({ timeout: 20_000 });
}

export const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
export const sleep = { name: 'sleep', input: {} };
/** An ISO time ms after t, in UTC, to the second. @param {number} t @param {number} ms */
export const plus = (t, ms) => new Date(t + ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Shiori's model on a stand-in, and a trip. @param {any} page @param {string} origin */
export async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Another address', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  return startTrip(page, 'Big Sur');
}

/** Types to Shiori. @param {any} page @param {string} words */
export async function say(page, words) {
  await page.getByRole('button', { name: 'Type' }).click();
  await page.getByLabel('Message to Shiori').fill(words);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** The page as if the phone locked or annai went behind another app (true), or came back (false). @param {any} page @param {boolean} hidden */
export async function away(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
