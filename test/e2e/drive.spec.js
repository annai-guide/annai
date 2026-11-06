import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, startTrip, writeRecords } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('Driving: Now hands over when moving fast; the road ahead, directions, big quick-ask buttons, the big dock, and voice Auto on (spec §16.2, §10.5)', async ({ page, context }) => {
  // Live mode coming on: she sleeps. A quick-ask is the user's: she answers it (a turn of theirs that says nothing is asked again, spec §7.1).
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }])), sse(anthropicToolReply([{ name: 'show', input: { card: { title: 'Fuel', text: 'A station in Big Sur village, 25 miles on.' } } }, { name: 'sleep', input: {} }]))] });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.60, longitude: -121.89, accuracy: 10 });
    await page.clock.install({ time: new Date() });
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    const lunch = new Date(Date.now() + 2 * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    await writeRecords(page, trip, { write: { '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: lunch, tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } } } });
    await page.goto('/#/now');
    await page.locator('.live-chip').click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1); // she was told live mode is on
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    for (let i = 1; i <= 10; i++) {
      await context.setGeolocation({ latitude: 36.60 - i * 0.0011, longitude: -121.89, accuracy: 10 }); // 122 m every 5 s: 88 km/h
      await page.clock.fastForward(5000);
    }
    await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · driving');
    await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
    const strip = page.getByRole('list', { name: 'The road ahead' });
    await expect(strip.locator('li').first()).toHaveText('You');
    await expect(strip).toContainText('Nepenthe');
    await expect(strip).toContainText(/≈ \d+ (mi|km) · about (\d+ hr, )?\d+ min/);
    await expect(page.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', /^https:\/\/maps\.apple\.com\/\?daddr=36\.2213%2C-121\.7567&dirflg=d&saddr=/);
    await expect(page.getByRole('link', { name: 'Google Maps' })).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\//);
    await page.getByRole('button', { name: 'Fuel' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Where is the next fuel station or charger?');
    await page.getByRole('main').getByRole('link', { name: 'Now', exact: true }).click();
    await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/); // voice is still on: the dock stays big for it
    // Back on Now while still moving fast: the next fixes keep Now on screen (B2).
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    for (let i = 11; i <= 13; i++) {
      await context.setGeolocation({ latitude: 36.60 - i * 0.0011, longitude: -121.89, accuracy: 10 });
      await page.clock.fastForward(5000);
    }
    await expect(page.locator('.live-chip')).toHaveText('GPS on');
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Driving' })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

/** A trip open and GPS on, standing at the start of the road. @param {any} page @param {any} context */
async function atTheStart(page, context) {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.60, longitude: -121.89, accuracy: 10 });
  await page.clock.install({ time: new Date() });
  await openApp(page);
  const trip = await startTrip(page, 'Testville');
  await page.locator('.live-chip').click();
  await expect(page.locator('.live-chip')).toHaveText(/^GPS on\b/);
  return trip;
}

/** Fixes `from` to `to` along the road: 122 m every 5 s, 88 km/h. @param {any} page @param {any} context @param {number} from @param {number} to */
async function roll(page, context, from, to) {
  for (let i = from; i <= to; i++) {
    await context.setGeolocation({ latitude: 36.60 - i * 0.0011, longitude: -121.89, accuracy: 10 });
    await page.clock.fastForward(5000);
  }
}

for (const [where, at] of [['home', '#/trips'], ['the conversation', '#/talk'], ['the Itinerary', '#/plan']]) {
  test(`moving fast begun on ${where}: Driving takes over once, ← returns there, and the next fixes leave you there`, async ({ page, context }) => {
    await atTheStart(page, context);
    await page.goto(`/${at}`);
    await roll(page, context, 1, 10);
    await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Driving' })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe(at);
    await roll(page, context, 11, 13);
    await expect(page.locator('.live-chip')).toHaveText('GPS on');
    await expect(page.getByRole('heading', { name: 'Driving' })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe(at);
  });
}

test("typing in the dock's box as moving fast begins: no take-over, the box keeps its words, and that drive doesn't take over later", async ({ page, context }) => {
  await atTheStart(page, context);
  await page.goto('/#/now');
  await page.getByRole('button', { name: 'Type' }).click();
  const box = page.getByLabel('Message to Shiori');
  await box.fill('Where should we');
  await roll(page, context, 1, 10);
  await expect(page.locator('.now .chips')).toContainText('GPS on · moving fast');
  await expect(page.getByRole('heading', { name: 'Driving' })).toHaveCount(0);
  await expect(box).toHaveValue('Where should we');
  await box.blur();
  await roll(page, context, 11, 13);
  await expect(page.getByRole('heading', { name: 'Driving' })).toHaveCount(0);
});

test("Driving's ← goes where it was entered from, not where an earlier take-over came from", async ({ page, context }) => {
  await atTheStart(page, context);
  await page.goto('/#/trips');
  await roll(page, context, 1, 10);
  await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
  await page.goto('/#/now');
  await page.getByRole('main').getByRole('link', { name: 'Driving' }).click();
  await page.getByRole('main').getByRole('link', { name: 'Now', exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/now');
});
