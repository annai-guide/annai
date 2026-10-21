import { test, expect } from '@playwright/test';
import http from 'node:http';
import { openApp, waitForServiceWorker, pickProvider, tapAdd, startTrip, writeRecords, savedBy } from './helpers.js';

/** What a screen says that is a literal "null": a missing value written out, or a null child put on the page. @param {import('@playwright/test').Page} page */
const nulls = (page) => page.evaluate(() => (document.body.innerText.match(/.{0,40}null.{0,40}/gi) ?? []).map((s) => s.replace(/\s+/g, ' ')));

/**
 * Waits until a screen has drawn what it draws after its first lines (lists, panels): nothing in it is busy, and its
 * words and parts have stopped changing for a moment (review m6: not a fixed wait). @param {import('@playwright/test').Page} page
 */
const drawn = (page) => page.evaluate(() => new Promise((resolve) => {
  const main = /** @type {Element} */ (document.querySelector('main.view'));
  /** @type {any} */
  let t;
  const quiet = () => { clearTimeout(t); t = setTimeout(() => { if (main.querySelector('[aria-busy="true"]')) quiet(); else { seen.disconnect(); resolve(undefined); } }, 250); };
  const seen = new MutationObserver(quiet);
  // Its words and parts, not attributes: Shiori's looks animate theirs for as long as they show.
  seen.observe(main, { childList: true, subtree: true, characterData: true });
  quiet();
}));

/** A screen, opened by its address, once it has drawn. @param {import('@playwright/test').Page} page @param {string} hash */
async function sweep(page, hash) {
  await page.evaluate((x) => { location.hash = x; }, hash);
  await expect(page.locator('main.view h1').first()).toBeVisible();
  await drawn(page);
  expect(await nulls(page), `${hash} shows "null"`).toEqual([]);
}

test('no screen says "null": providers, their abilities, Live voice, a look at a site that refuses web apps, Driving, and the rest (the emulator pass)', async ({ page }) => {
  // A site that answers but allows no web app to read it (no CORS headers), as example.com does.
  const site = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Example</p>'));
  await new Promise((resolve) => site.listen(0, '127.0.0.1', () => resolve(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (site.address()).port}`;
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);

    // Ollama's page, with its abilities.
    await pickProvider(page, 'Ollama');
    expect(await nulls(page)).toEqual([]);
    await page.getByRole('link', { name: '← Models' }).click();

    // Google Gemini's page, with Live voice switched on (its plugin installs).
    await pickProvider(page, 'Google Gemini');
    const live = page.getByLabel('Use Live voice');
    await live.check();
    await expect(savedBy(live)).toHaveText('Saved', { timeout: 30_000 });
    await drawn(page);
    expect(await nulls(page)).toEqual([]);
    await page.getByRole('link', { name: '← Models' }).click();

    // Another address's look at a site that refuses web apps: nothing to add.
    await tapAdd(page, 'Another address');
    await page.getByLabel('Address', { exact: true }).fill(`${origin}/v1`);
    await page.getByRole('button', { name: 'Look for what it offers' }).click();
    await expect(page.getByText(/doesn't allow web apps like annai to call it/)).toBeVisible({ timeout: 30_000 });
    expect(await nulls(page)).toEqual([]);

    // A trip with a place ahead on the plan, for Now, the plan and Driving.
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Big Sur');
    const lunch = new Date(Date.now() + 2 * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    await writeRecords(page, trip, { write: { '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: lunch, tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } } } });
    await page.evaluate(() => { location.hash = '#/drive'; });
    await expect(page.getByRole('list', { name: 'The road ahead' })).toContainText('Nepenthe');
    expect(await nulls(page)).toEqual([]);

    const t = encodeURIComponent(trip);
    for (const hash of ['#/trips', `#/trip/${t}`, '#/now', '#/plan', `#/trip/${t}/recap`, `#/trip/${t}/replay`, '#/talk', '#/settings', '#/models', '#/voice', '#/shiori',
      '#/tools', '#/mcp', '#/plugins', '#/add', '#/backups', '#/notifications', '#/simulate', '#/trace', '#/updates', '#/experimental', '#/about', '#/welcome']) await sweep(page, hash);
    await sweep(page, '#/models');
    const model = await page.evaluate(() => /** @type {HTMLAnchorElement | null} */ (document.querySelector('a[href^="#/models/model?id="]'))?.hash ?? null);
    if (model) await sweep(page, model);
  } finally {
    await new Promise((resolve) => { site.closeAllConnections?.(); site.close(() => resolve(undefined)); });
  }
});
