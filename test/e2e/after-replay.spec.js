import { test, expect } from '@playwright/test';
import { openApp, startTrip, watchConsole } from './helpers.js';
import { seedMorning, at } from './after-kit.js';

test('the replay: the timeline, the route on a flat map and in words, scrubbing and playback (spec §13, §16.5)', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await seedMorning(page, trip);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await page.getByRole('link', { name: 'Replay' }).click();
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByRole('button')).toHaveText([
    /^\d\d:\d\dDrove \d+\.\d km · 30 min$/, /Bixby Creek Bridge · 20 min · stamp/, /^09:35Shiori: Bixby Creek Bridge$/,
    /^09:36You: Sam wants to see the sea lions\.$/, /^09:45Photo 2026-11-27-0945\.jpg$/, /^\d\d:\d\dDrove .*partly unseen/, /^16:40–18:15Hearst Castle · 1 h 35 min$/,
  ]);
  await expect(timeline.locator('li.card')).toHaveCount(0); // a card entry isn't drawn as a card box
  const map = page.getByRole('img', { name: /^The route: \d+\.\d km on the road, from Bixby Creek Bridge to Hearst Castle, with 2 stops and 1 stamp\.$/ });
  await expect(map).toBeVisible();
  expect((await page.locator('svg.route-map polyline.route-all').first().getAttribute('points'))?.split(' ').length).toBeGreaterThan(100);
  await expect(page.locator('svg.route-map line.route-jump')).toHaveCount(1);
  const scrub = page.getByLabel('Time in the trip');
  await scrub.fill(String(at('09:40')));
  await expect(page.locator('.replay-where')).toHaveText('At Bixby Creek Bridge');
  await expect(page.locator('.replay-shown')).toContainText('Sam wants to see the sea lions.');
  await expect(scrub).toHaveAttribute('aria-valuetext', /09:40, At Bixby Creek Bridge$/);
  await timeline.getByRole('button', { name: /Photo 2026-11-27-0945\.jpg/ }).click();
  await expect(page.locator('.replay-shown img')).toHaveAttribute('src', /^blob:/);
  await timeline.getByRole('button', { name: /Shiori: Bixby Creek Bridge/ }).click();
  await expect(page.locator('.replay-shown .card-title')).toHaveText('Bixby Creek Bridge'); // the card, through the card renderer
  await expect(page.locator('.replay-shown .md strong')).toHaveText('1932');
  await page.getByLabel('Speed').selectOption({ label: '1 hour a second' });
  const time = page.locator('.replay-time');
  const was = await time.textContent();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(time).not.toHaveText(/** @type {string} */ (was));
  await expect(page.locator('.replay-where')).toHaveText('At Hearst Castle', { timeout: 20_000 }); // it plays to the end and stops there
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.getByRole('button', { name: 'Play' }).click(); // at the end: it starts again
  await page.goto('/#/trips'); // leaving while it plays
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('a trip with nothing recorded has nothing to replay, and says why', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Not yet');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/replay`);
  await expect(page.getByText(/^Nothing to replay yet\./)).toBeVisible();
});

test("leaving the replay while it is paused on a photo lets the photo's memory go", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await seedMorning(page, trip);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/replay`);
  await page.getByRole('list', { name: 'Timeline' }).getByRole('button', { name: /Photo 2026-11-27-0945\.jpg/ }).click();
  const img = page.locator('.replay-shown img');
  await expect(img).toHaveAttribute('src', /^blob:/);
  const url = /** @type {string} */ (await img.getAttribute('src'));
  /** Whether the photo at a blob: address can still be loaded. @param {string} u */
  const loads = (u) => page.evaluate((src) => new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve('kept');
    i.onerror = () => resolve('gone');
    i.src = src;
  }), u);
  expect(await loads(url)).toBe('kept');
  await page.goto('/#/trips'); // paused: no playback loop to notice
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect.poll(() => loads(url)).toBe('gone');
});
