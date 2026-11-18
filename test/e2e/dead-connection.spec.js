import { test, expect } from '@playwright/test';
import http from 'node:http';
import { FIRST_DRAW, waitForServiceWorker, startSettled, openApp, goToHash, fixtureFiles } from './helpers.js';
import { QUIET_MS } from '../../src/core/answer.js';

// A connection that goes dead under a plugin's download (dl-limit-next): annai's site as the tests serve it, reached through a stand-in
// on this machine that never answers for one plugin's files, or stops after the headers and 1 KB. A stand-in, not a route: annai's
// downloads go through its service worker, and Playwright's WebKit doesn't route a service worker's requests (probed 2026-11-17).
// And an address's site that goes dead under Get it, an Update and Check now (addr-limit-next): a site of its own on this machine.

/** How long after the limit the screen may take to say so: the failed install's tidy-up, on a loaded host. */
const SAYS_MS = QUIET_MS + 15_000;
const FAILED_DOWNLOAD = "The plugin couldn't be downloaded. Check the connection and try again.";

/**
 * The tests' site, but for requests whose path starts with dead: never answered, or answered with the headers and 1 KB, then nothing.
 * @param {string} upstream the tests' server @param {{ dead: string, how: 'never' | 'headers' }} o
 */
async function standIn(upstream, { dead, how }) {
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith(dead)) {
      if (how === 'headers') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.write(' '.repeat(1024));
      }
      return;
    }
    const there = http.request({ host: up.hostname, port: up.port, path, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    there.on('error', () => res.destroy());
    req.pipe(there);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Opens Models on the stand-in, once its service worker has the page (plugins load through it). @param {import('@playwright/test').Page} page @param {string} url */
async function openModels(page, url) {
  await page.goto(`${url}/#/models`);
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await waitForServiceWorker(page);
}

test("a provider's Add whose plugin's file never comes ends after the limit, with a failed download's words and its button back; the next Add then goes through (it said \"Adding…\" until annai was restarted, and held every Add after it)", async ({ page, baseURL }) => {
  const site = await standIn(/** @type {string} */ (baseURL), { dead: '/plugins-official/provider-openai/', how: 'never' });
  try {
    await openModels(page, site.url);
    await startSettled(page);
    await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
    const openai = page.getByRole('button', { name: 'Add OpenAI', exact: true });
    await openai.click();
    await expect(openai).toHaveText('Adding…');
    await expect(page.locator('.notice', { hasText: "OpenAI wasn't added" })).toContainText(FAILED_DOWNLOAD, { timeout: SAYS_MS });
    await expect(openai).toHaveText('Add');
    await expect(openai).toBeEnabled();
    // The line went on: another provider's Add installs and opens its page.
    await page.getByRole('button', { name: 'Add Mistral', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mistral' })).toBeVisible({ timeout: 30_000 });
  } finally {
    site.close();
  }
});

test("the featured start whose plugin's file sends its headers and 1 KB and then nothing ends after the limit with a failed download's words, and an Add then goes through", async ({ page, baseURL }) => {
  const site = await standIn(/** @type {string} */ (baseURL), { dead: '/plugins-official/provider-openrouter/', how: 'headers' });
  try {
    await openModels(page, site.url);
    const start = page.getByRole('region', { name: 'Sign in' });
    await expect(start.getByRole('button', { name: 'Getting the sign-in ready…' })).toBeVisible();
    await expect(start).toContainText(FAILED_DOWNLOAD, { timeout: SAYS_MS });
    await expect(start.getByRole('button', { name: 'Getting the sign-in ready…' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Add a provider', exact: true }).click();
    await page.getByRole('button', { name: 'Add Mistral', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mistral' })).toBeVisible({ timeout: 30_000 });
  } finally {
    site.close();
  }
});

/**
 * A site packages are installed from, on this machine, which lets web apps read it (CORS): each path in routes answers its body; 'never'
 * takes the request and sends nothing, 'headers' sends the answer's headers and nothing more; { parts, gapMs } sends the headers and
 * each part gapMs after the one before, the first gapMs after the request; a number answers that status with no body. routes can change
 * as the test goes. host: as the words say it.
 * @param {Record<string, Buffer | number | 'never' | 'headers' | { parts: Buffer[], gapMs: number }>} routes
 */
async function addressSite(routes) {
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'text/markdown' };
  const server = http.createServer((req, res) => {
    const r = routes[new URL(req.url ?? '/', 'http://localhost').pathname];
    if (r === 'never') return;
    if (r === 'headers') {
      res.writeHead(200, cors);
      res.flushHeaders();
      return;
    }
    if (r === undefined) {
      res.writeHead(404, cors).end('not found');
      return;
    }
    if (typeof r === 'number') {
      res.writeHead(r, cors).end();
      return;
    }
    if (!Buffer.isBuffer(r)) {
      const { parts, gapMs } = r;
      const next = (/** @type {number} */ i) => setTimeout(() => {
        if (res.destroyed) return;
        if (i === 0) {
          res.writeHead(200, cors);
          res.flushHeaders();
        } else res.write(parts[i - 1]);
        if (i === parts.length) res.end();
        else next(i + 1);
      }, gapMs);
      next(0);
      return;
    }
    res.writeHead(200, cors).end(r);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** What annai says of an address's site that stopped answering. @param {{ host: string }} site */
const stopped = (site) => `${site.host} stopped answering. Check the connection and try again.`;
/** Add's place for installing from an address. @param {import('@playwright/test').Page} page */
const elsewhere = (page) => page.getByRole('region', { name: 'Install from an address or a file' });
/** Get it, whatever it says now. @param {import('@playwright/test').Page} page */
const getIt = (page) => elsewhere(page).getByRole('button', { name: /^Get(ting)? it/ });

for (const how of /** @type {const} */ (['never', 'headers'])) {
  test(`Get it on an address whose site ${how === 'never' ? 'takes the request and never answers' : 'sends its headers and nothing more'} ends after the limit, saying the site stopped answering, and Get it comes back: an address that answers then opens the install screen (it said "Getting it…" until the screen was left)`, async ({ page }) => {
    const skill = await fixtureFiles('tide-pools');
    const site = await addressSite({ '/kits/gone/SKILL.md': how, '/kits/tide-pools/SKILL.md': skill['SKILL.md'], '/kits/tide-pools/references/safety.md': skill['references/safety.md'] });
    try {
      await openApp(page, '#/add');
      await waitForServiceWorker(page);
      const address = elsewhere(page).getByLabel('Address of a plugin or skill');
      await address.fill(`${site.origin}/kits/gone/SKILL.md`);
      await getIt(page).click();
      await expect(getIt(page)).toHaveText('Getting it…');
      await expect(getIt(page)).toBeDisabled();
      await expect(elsewhere(page).getByRole('alert')).toHaveText(stopped(site), { timeout: SAYS_MS });
      await expect(getIt(page)).toHaveText('Get it');
      await expect(getIt(page)).toBeEnabled();
      await address.fill(`${site.origin}/kits/tide-pools/SKILL.md`);
      await getIt(page).click();
      await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible();
    } finally {
      site.stop();
    }
  });
}

// An answer the browser hands on with a body, though a Response can't be built with one for these statuses: annai's words, not the
// engine's own ("Response with null body status cannot have body", the first build of addr-limit-next).
for (const status of [204, 205, 304]) {
  test(`Get it on an address whose site answers ${status} says what annai says of that answer, never the browser's own error, and Get it comes back`, async ({ page }) => {
    const site = await addressSite({ '/kits/odd/SKILL.md': status });
    try {
      await openApp(page, '#/add');
      await waitForServiceWorker(page);
      await elsewhere(page).getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/odd/SKILL.md`);
      await getIt(page).click();
      const alert = elsewhere(page).getByRole('alert');
      // A 304 is an answer that isn't ok; a 204 and a 205 are ok and empty: a file with nothing in it, which the install says it can't read.
      if (status === 304) await expect(alert).toHaveText(`${site.host} answered 304.`);
      else await expect(alert).toContainText('SKILL.md starts with front matter');
      await expect(alert).not.toContainText(/Response|body/);
      await expect(getIt(page)).toHaveText('Get it');
      await expect(getIt(page)).toBeEnabled();
    } finally {
      site.stop();
    }
  });
}

test('Get it on an address whose site is slow but keeps sending installs: its answer and each part of the file come 12 s apart, 36 s in all and never 20 s with nothing (more than half the limit apart, so no two gaps fit in one limit)', async ({ page }) => {
  test.setTimeout(150_000);
  const skill = (await fixtureFiles('tide-pools'))['SKILL.md'];
  const site = await addressSite({ '/kits/tide-pools/SKILL.md': { parts: [skill.subarray(0, 40), skill.subarray(40)], gapMs: 12_000 } });
  try {
    await openApp(page, '#/add');
    await waitForServiceWorker(page);
    await elsewhere(page).getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tide-pools/SKILL.md`);
    const asked = Date.now();
    await getIt(page).click();
    await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible({ timeout: 36_000 + SAYS_MS });
    expect(Date.now() - asked, 'it took longer than the limit in all').toBeGreaterThan(QUIET_MS);
  } finally {
    site.stop();
  }
});

/**
 * Two skills installed from one address's site, tide-pools first (the order updates and checks take them), at version 1.2.
 * @param {import('@playwright/test').Page} page
 */
async function twoFromAnAddress(page) {
  const skill = (await fixtureFiles('tide-pools'))['SKILL.md'].toString();
  /** A skill by another name and version, without the link to a file of its own. @param {string} name @param {string} version */
  const as = (name, version) => Buffer.from(skill.replace('name: tide-pools', `name: ${name}`).replace('version: "1.2"', `version: "${version}"`).replace(/\[the safety notes\]\([^)]*\)/, 'the safety notes'));
  /** @type {Parameters<typeof addressSite>[0]} */
  const routes = { '/kits/tide-pools/SKILL.md': as('tide-pools', '1.2'), '/kits/rock-pools/SKILL.md': as('rock-pools', '1.2') };
  const site = await addressSite(routes);
  await openApp(page, '#/add');
  await waitForServiceWorker(page);
  for (const name of ['tide-pools', 'rock-pools']) {
    await goToHash(page, '#/add');
    await elsewhere(page).getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/${name}/SKILL.md`);
    await getIt(page).click();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText(`${name} 1.2`, { exact: true })).toBeVisible();
  }
  return { site, routes, as };
}

test("an Update whose address's site goes dead ends after the limit on the failed updates' card, saying the site stopped answering, and the update after it goes on (it waited until annai was restarted, and every update after it with it)", async ({ page }) => {
  test.setTimeout(150_000);
  const { site, routes, as } = await twoFromAnAddress(page);
  try {
    routes['/kits/tide-pools/SKILL.md'] = as('tide-pools', '1.3');
    routes['/kits/rock-pools/SKILL.md'] = as('rock-pools', '1.3');
    await page.reload();
    await expect(page.getByText('Plugin updates are ready')).toBeVisible({ timeout: 30_000 });
    // By the tap, tide-pools's site has gone dead.
    routes['/kits/tide-pools/SKILL.md'] = 'never';
    await page.getByRole('status').getByRole('button', { name: 'Update', exact: true }).first().click();
    const failed = page.locator('section.notice', { hasText: "Some plugins weren't updated" });
    await expect(failed).toContainText(`tide-pools: ${stopped(site)}`, { timeout: SAYS_MS });
    await goToHash(page, '#/plugins');
    await expect(page.getByText('rock-pools 1.3', { exact: true })).toBeVisible();
    await expect(page.getByText('tide-pools 1.2', { exact: true })).toBeVisible();
  } finally {
    site.stop();
  }
});

test("Check now with a plugin whose address's site goes dead ends after that site's limit on its silence, saying which plugin and why, and the address after it is checked (it ran to the check's own limit and asked nothing after it)", async ({ page }) => {
  test.setTimeout(150_000);
  const { site, routes, as } = await twoFromAnAddress(page);
  try {
    routes['/kits/tide-pools/SKILL.md'] = 'never';
    routes['/kits/rock-pools/SKILL.md'] = as('rock-pools', '1.3');
    await goToHash(page, '#/updates');
    await page.getByRole('button', { name: 'Check now' }).click();
    const checking = page.getByRole('region', { name: 'Checking for updates' });
    await expect(checking.getByRole('listitem')).toHaveText([`tide-pools couldn't be checked: ${stopped(site)}`], { timeout: SAYS_MS });
    await expect(page.getByRole('region', { name: 'Plugins' }).locator('.card .name')).toHaveText(['rock-pools 1.2.0 → 1.3.0']);
  } finally {
    site.stop();
  }
});
