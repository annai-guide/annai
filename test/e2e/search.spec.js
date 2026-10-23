import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startModelServer, anthropicToolReply, modelSetUp, openApp } from './helpers.js';

// Search that works out of the box (the user, 2026-10-23): annai's free search, three services each ticked
// until unticked, the order web_search tries its providers in, and what a limit or an untick does to it.

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/search/${name}`, import.meta.url), 'utf8');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Accept, x-exa-source, Mcp-Session-Id, MCP-Protocol-Version', 'access-control-allow-methods': 'POST, OPTIONS' };

/** What /app.json in sys:settings says, through annai's own modules. @param {import('@playwright/test').Page} page */
const appSettings = (page) => page.evaluate(async () => {
  const load = (/** @type {string} */ url) => import(url);
  const { createIdbStore } = await load('/src/core/store-idb.js');
  const { Workspace } = await load('/src/core/workspace.js');
  const { readAppSettings } = await load('/src/core/settings.js');
  const store = await createIdbStore();
  try {
    return await readAppSettings(new Workspace(store));
  } finally {
    store.close();
  }
});
/** The names in the search order, top to bottom. @param {import('@playwright/test').Page} page */
const order = (page) => page.locator('#search-order li').evaluateAll((lis) => lis.map((li) => (li.querySelector('span')?.textContent ?? '').replace(/^\d+\. /, '').replace(/ \(.*$/, '')));

test('Settings → Tools → Search lists the providers in the order web_search tries them; a tick switches one off, a handle moves it (arrow keys, its menu, a drag), and all are saved', async ({ page, browserName }) => {
  await openApp(page, '#/tools');
  await expect(page.getByRole('heading', { name: 'Tools', level: 1 })).toBeVisible();
  await expect(page.locator('#search-order li').first()).toBeVisible();
  // Keyed ones first (Jina, with no key yet), the free services, and the floor last.
  expect(await order(page)).toEqual(['Jina Search', 'Exa', 'Parallel', 'Firecrawl', 'Wikivoyage, Wikipedia and Nominatim']);
  await expect(page.locator('#search-order li', { hasText: 'Jina Search' })).toContainText('needs a key');
  await expect(page.locator('#search-order li', { hasText: 'Exa' })).toContainText('free, no key');
  await expect(page.locator('#search-order li', { hasText: 'Wikivoyage' })).toContainText('always on');
  await expect(page.locator('#search-order li', { hasText: 'Wikivoyage' }).getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText("Free search sends your searches to Exa, Parallel or Firecrawl")).toBeVisible();
  await expect(page.getByText('Wikimedia (Wikivoyage and Wikipedia) and OpenStreetMap (Nominatim)')).toBeVisible();
  for (const n of ['Exa', 'Parallel', 'Firecrawl']) await expect(page.getByRole('checkbox', { name: `Use ${n}` })).toBeChecked();
  // Off by a tick.
  await page.getByRole('checkbox', { name: 'Use Parallel' }).uncheck();
  await expect.poll(async () => (await appSettings(page)).web?.searchOff).toEqual(['parallel']);
  // Moved by the handle's arrow keys; the list is drawn again from what is saved.
  await page.getByRole('button', { name: 'Reorder Firecrawl, 4 of 5' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await appSettings(page)).web?.search).toEqual(['jina', 'exa', 'firecrawl', 'parallel', 'wiki']);
  await expect.poll(() => order(page)).toEqual(['Jina Search', 'Exa', 'Firecrawl', 'Parallel', 'Wikivoyage, Wikipedia and Nominatim']);
  await expect(page.getByRole('checkbox', { name: 'Use Parallel' })).not.toBeChecked();
  // Moved by the handle's menu (a tap on it): Move up puts Parallel above Firecrawl again.
  await page.getByRole('button', { name: 'Reorder Parallel, 4 of 5' }).click();
  await page.getByRole('group', { name: 'Move Parallel' }).getByRole('button', { name: 'Move up' }).click();
  await expect.poll(async () => (await appSettings(page)).web?.search).toEqual(['jina', 'exa', 'parallel', 'firecrawl', 'wiki']);
  await expect.poll(() => order(page)).toEqual(['Jina Search', 'Exa', 'Parallel', 'Firecrawl', 'Wikivoyage, Wikipedia and Nominatim']);
  await expect(page.getByRole('checkbox', { name: 'Use Parallel' })).not.toBeChecked();
  // Dragged by the handle with a mouse (Chromium; WebKit's phone has no mouse): Firecrawl above Exa.
  if (browserName === 'chromium') {
    const grip = page.getByRole('button', { name: 'Reorder Firecrawl, 4 of 5' });
    const to = /** @type {{ x: number, y: number, height: number }} */ (await page.locator('#search-order li', { hasText: 'Exa' }).boundingBox());
    const from = /** @type {{ x: number, y: number, width: number, height: number }} */ (await grip.boundingBox());
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await appSettings(page)).web?.search).toEqual(['jina', 'firecrawl', 'exa', 'parallel', 'wiki']);
    await expect.poll(() => order(page)).toEqual(['Jina Search', 'Firecrawl', 'Exa', 'Parallel', 'Wikivoyage, Wikipedia and Nominatim']);
  }
  // Still so after a reload.
  const kept = await order(page);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(kept);
  await expect(page.getByRole('checkbox', { name: 'Use Parallel' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Use Exa' })).toBeChecked();
});

test('free search through Shiori: Exa at its limit hands on to Parallel and rests; Parallel unticked, Firecrawl answers and Parallel is never asked', async ({ page, browserName }) => {
  // WebKit doesn't let page.route stand in for a page's requests while a service worker controls it; the unit tests cover the chain.
  test.skip(browserName === 'webkit', "Playwright can't stand in for the search services in WebKit");
  const parallel = await fixture('parallel-search.json');
  const firecrawl = await fixture('firecrawl-search.sse');
  /** @type {Record<string, number>} */
  const asked = { exa: 0, parallel: 0, firecrawl: 0 };
  /** @param {string} name @param {(body: any) => { status: number, headers?: Record<string, string>, body: string }} answer */
  const service = (name, answer) => (/** @type {import('@playwright/test').Route} */ route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    asked[name]++;
    const a = answer(route.request().postDataJSON());
    return route.fulfill({ status: a.status, headers: { ...CORS, ...a.headers }, body: a.body });
  };
  await page.route('https://mcp.exa.ai/mcp', service('exa', () => ({ status: 429, body: 'rate limit' })));
  await page.route('https://search.parallel.ai/mcp', service('parallel', () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: parallel })));
  await page.route('https://mcp.firecrawl.dev/v2/mcp', service('firecrawl', () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: firecrawl })));
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'web_search', input: { query: 'Is Nepenthe open today' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'It is open daily.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'web_search', input: { query: 'Bixby Bridge viewpoint' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Castle Rock.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Is Nepenthe open today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('It is open daily.');
    expect(asked).toEqual({ exa: 1, parallel: 1, firecrawl: 0 });
    // What Shiori was handed: rows from Parallel, as TSV.
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('nepenthebigsur.com');
    // Parallel unticked on the Tools screen; Exa is resting from its 429, so Firecrawl answers.
    await page.goto('/#/tools');
    await page.getByRole('checkbox', { name: 'Use Parallel' }).uncheck();
    await expect.poll(async () => (await appSettings(page)).web?.searchOff).toEqual(['parallel']);
    await expect(page.locator('#search-order li', { hasText: 'Exa' })).toContainText('resting after a failure');
    await page.goto('/#/trips');
    await page.getByRole('button', { name: 'Big Sur' }).click().catch(() => {});
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where is the best Bixby Bridge viewpoint?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Castle Rock.');
    expect(asked).toEqual({ exa: 1, parallel: 1, firecrawl: 1 });
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[3])).toContain('facebook.com/nepenthebigsur/');
  } finally {
    await llm.stop();
  }
});
