import { test, expect } from '@playwright/test';
import { openApp, startTrip, writeRecords } from './helpers.js';

// Playwright stands in for OpenStreetMap, Wikipedia and Wikivoyage. In WebKit it can't for a page a
// service worker controls, so the service worker is off here, as in the hosted-archive test.
test.use({ serviceWorkers: 'block' });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'api-user-agent', 'access-control-allow-methods': 'GET, POST' };
const at = (/** @type {number} */ h) => `2026-11-27T${String(h).padStart(2, '0')}:00:00Z`;
const STOPS = {
  '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: at(17), tz: 'America/Los_Angeles' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
  '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: at(20), tz: 'America/Los_Angeles' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
};

/** Stands in for the three services and notes what each was asked. @param {import('@playwright/test').Page} page */
async function services(page) {
  /** @type {{ host: string, url: string, body: string, agent: string }[]} */
  const asked = [];
  const json = (/** @type {any} */ v) => ({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(v) });
  await page.route(/^https:\/\/(overpass-api\.de|overpass\.private\.coffee|en\.wikipedia\.org|en\.wikivoyage\.org)\//, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    asked.push({ host: url.hostname, url: req.url(), body: decodeURIComponent(req.postData() ?? ''), agent: req.headers()['api-user-agent'] ?? '' });
    if (url.hostname.includes('overpass')) {
      return route.fulfill(json({ elements: [{ type: 'node', id: 1, lat: 36.3712, lon: -121.902, tags: { name: 'Bixby Bridge Vista Point', tourism: 'viewpoint' } }, { type: 'node', id: 2, lat: 36.2203, lon: -121.7612, tags: { name: 'Nepenthe', amenity: 'restaurant' } }] }));
    }
    if (url.hostname === 'en.wikipedia.org') return route.fulfill(json({ query: { pages: [{ title: 'Big Sur', coordinates: [{ lat: 36.2704, lon: -121.8081 }], extract: 'Big Sur is a rugged section of the Central Coast of California.' }] } }));
    if (url.searchParams.get('prop') === 'pageprops') {
      return route.fulfill(json({ query: { pages: (url.searchParams.get('titles') ?? '').split('|').map((t) => (t === 'Big Sur' ? { title: t } : { title: t, missing: true })) } }));
    }
    return route.fulfill(json({ query: { pages: [{ title: 'Big Sur', extract: 'Big Sur is a region.\n\n== Eat ==\nNepenthe.' }] } }));
  });
  return asked;
}

test('the offline pack: its size before downloading, then OpenStreetMap, Wikipedia and Wikivoyage into the trip (spec §11.5)', async ({ page }) => {
  const asked = await services(page);
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: STOPS });
  await page.reload();
  const panel = page.getByRole('region', { name: 'Offline pack' });
  await expect(panel).toContainText("For when there's no connection");
  const download = panel.getByRole('button', { name: /^Download \(about \d+(\.\d)? kB\)$/ });
  await expect(download).toBeVisible();
  expect(asked).toEqual([]); // nothing goes before the tap
  await download.click();
  await expect(panel).toContainText(/Downloaded now · [\d.]+ (byte|kB) · 2 places, 1 Wikipedia summary, 1 Wikivoyage guide\./, { timeout: 30_000 });
  await expect(panel).toContainText('Guides: Big Sur.');
  await expect(panel).not.toContainText('null'); // nothing left out shows as a word
  await expect(panel.getByRole('link', { name: 'OpenStreetMap contributors' })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  const overpass = asked.filter((a) => a.host === 'overpass-api.de').map((a) => a.body);
  expect(overpass.some((b) => b.includes('around:5000,36.3715,-121.9017'))).toBe(true);
  expect(overpass.some((b) => b.includes('around:3000,36.3715,-121.9017,36.2213,-121.7567'))).toBe(true);
  for (const a of asked.filter((x) => x.host.startsWith('en.'))) expect(a.agent).toMatch(/^annai\/\d+\.\d+\.\d+ \(https:\/\/annai\.guide\)$/);
  for (const a of asked.filter((x) => x.host === 'en.wikivoyage.org')) expect(a.url).not.toMatch(/coord|36\.\d|121\.\d/); // names, never a position (§11.7)
  await expect(page.getByRole('link', { name: /pack\.json|^o[0-9a-z]+\.json$/ })).toHaveCount(0); // the pack's files stay out of the file list
  await page.reload();
  await expect(panel).toContainText(/Downloaded .+ · /);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Now' }).click();
  await expect(page.locator('.pack-line')).toContainText('Offline pack: downloaded');
  await writeRecords(page, trip, { write: { '/plan/mcway.json': { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at: at(21), tz: 'America/Los_Angeles' }, place: { name: 'McWay Falls', lat: 36.158, lng: -121.672 } } } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await expect(panel).toContainText('The plan changed since.');
  await expect(panel.getByRole('button', { name: /^Update \(about \d+(\.\d)? kB\)$/ })).toBeVisible();
});

test('a trip with no places in its plan says how the pack works, and offers no download', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Somewhere');
  const panel = page.getByRole('region', { name: 'Offline pack' });
  await expect(panel).toContainText('The pack follows the plan: once the plan has places, it can be downloaded here.');
  await expect(panel.getByRole('button')).toHaveCount(0);
});
