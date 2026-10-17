import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, startTrip, writeRecords } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('Driving: Now hands over when moving fast; the road ahead, directions, big quick-ask buttons, the big dock, and voice Auto on (spec §16.2, §10.5)', async ({ page, context }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.60, longitude: -121.89, accuracy: 10 });
    await page.clock.install({ time: new Date() });
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    const lunch = new Date(Date.now() + 2 * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    await writeRecords(page, trip, { write: { '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: lunch, tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } } } });
    await page.goto('/#/now');
    await page.locator('.live-chip').click();
    await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1); // she was told live mode is on
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    for (let i = 1; i <= 10; i++) {
      await context.setGeolocation({ latitude: 36.60 - i * 0.0011, longitude: -121.89, accuracy: 10 }); // 122 m every 5 s: 88 km/h
      await page.clock.fastForward(5000);
    }
    await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · moving');
    await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
    const strip = page.getByRole('list', { name: 'The road ahead' });
    await expect(strip.locator('li').first()).toHaveText('You');
    await expect(strip).toContainText('Nepenthe');
    await expect(strip).toContainText(/≈ \d+ (mi|km) · about \d+ min/);
    await expect(page.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', /^https:\/\/maps\.apple\.com\/\?daddr=36\.2213%2C-121\.7567&dirflg=d&saddr=/);
    await expect(page.getByRole('link', { name: 'Google Maps' })).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\//);
    await page.getByRole('button', { name: 'Fuel' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Where is the next fuel station or charger?');
    await page.getByRole('link', { name: '← Now' }).click();
    await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/); // voice is still on: the dock stays big for it
  } finally {
    await llm.stop();
  }
});
