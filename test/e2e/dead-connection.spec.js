import { test, expect } from '@playwright/test';
import http from 'node:http';
import { FIRST_DRAW, waitForServiceWorker, startSettled } from './helpers.js';
import { QUIET_MS } from '../../src/core/llm/official.js';

// A connection that goes dead under a plugin's download (dl-limit-next): annai's site as the tests serve it, reached through a stand-in
// on this machine that never answers for one plugin's files, or stops after the headers and 1 KB. A stand-in, not a route: annai's
// downloads go through its service worker, and Playwright's WebKit doesn't route a service worker's requests (probed 2026-11-17).

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
