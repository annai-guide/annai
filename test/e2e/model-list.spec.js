import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// A provider page's Fetch model list while the page changes (models-next; the Deferred entry "A model list fetched while the page changes").
// The page keeps no copy of the list (model-list-next took one out): a list is what its part shows, and a Fetch's answer goes to the part on
// show for its ability when it lands, a part drawn since the tap too, unless the address or key it was asked under has changed since. The
// filter box is made once a part; an answer draws only its rows. The screen never changes under the traveller's hands (the timeline spec).

const KEY = 'sk-model-list-stand-in-0123';
/** @param {string} id */
const model = (id) => ({ id, object: 'model', owned_by: 'llamacpp' });

/**
 * A llama.cpp provider on the stand-in server, its page open. @param {import('@playwright/test').Page} page @param {{ origin: string }} s
 * @returns {Promise<import('@playwright/test').Locator>} the page's Chat part
 */
async function addLlamaCpp(page, s) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'llama.cpp');
  await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
  await page.getByLabel('API key').fill(KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  return page.getByRole('region', { name: 'Chat', exact: true });
}

/** Fetch model list tapped while the server holds its answer: it has been asked. @param {import('@playwright/test').Locator} chat @param {{ requests: { method: string, path: string }[] }} s */
async function fetchHeld(chat, s) {
  const asked = s.requests.filter((q) => q.method === 'GET' && q.path === '/v1/models').length;
  await chat.getByRole('button', { name: 'Fetch model list' }).click();
  await expect(chat.getByText('Asking for its models…')).toBeVisible();
  await expect.poll(() => s.requests.filter((q) => q.method === 'GET' && q.path === '/v1/models').length).toBe(asked + 1);
}

/** Its own address set to another server's, saved as it is let go. @param {import('@playwright/test').Locator} chat @param {{ origin: string }} s */
async function ownAddress(chat, s) {
  const own = chat.getByLabel('Its own address');
  await own.fill(`${s.origin}/v1`);
  await own.blur();
  await expect(chat.locator('.saved', { hasText: 'Saved' })).toBeVisible();
}

test("a list fetched under the ability's old address goes, where it stands, when Its own address is saved as another; the page is not drawn, and a Fetch then lists the new server's (fails on main: the old list stayed, its Add live)", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one'), model('old-two')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
    await ownAddress(chat, b);
    await expect(chat.getByRole('button', { name: 'Add old-one' })).toHaveCount(0);
    await expect(chat.getByText('2 models.')).toHaveCount(0);
    await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add new-one' })).toBeVisible();
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("a Fetch that answers after the page was drawn again shows its list in the page drawn, with what was added meanwhile left out (fails on main: no list and no count)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash'), model('gemma5-small')] });
  try {
    const chat = await addLlamaCpp(page, s);
    const release = s.holdList();
    await fetchHeld(chat, s);
    // The traveller's own Add model draws the page meanwhile: "Asking for its models…" goes with the part drawn away.
    await chat.getByLabel('Add a model by id').fill('gemma5-small');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByRole('link', { name: /^gemma5-small/ })).toBeVisible();
    await expect(chat.getByText('Asking for its models…')).toHaveCount(0);
    release();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' }), 'added since the tap, by id').toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Fetch model list' })).toBeEnabled();
  } finally {
    await s.stop();
  }
});

test("a Fetch asked under the ability's old address lands nowhere once Its own address is saved as another: no count, no rows, and Fetch works again (fails on main: the old server's list came)", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one'), model('old-two')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    const release = a.holdList();
    await fetchHeld(chat, a);
    await ownAddress(chat, b);
    release();
    const fetchList = chat.getByRole('button', { name: 'Fetch model list' });
    await expect(fetchList).toBeEnabled();
    await page.waitForTimeout(500); // the rows of an answer that landed would be drawn after one read of the settings
    await expect(chat.getByText(/^\d+ models?\.$/)).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Add old-one' })).toHaveCount(0);
    await expect(chat.getByText('Asking for its models…')).toHaveCount(0);
    await fetchList.click();
    await expect(chat.getByRole('button', { name: 'Add new-one' })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add old-one' })).toHaveCount(0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("Its own address typed, then Fetch model list tapped straight away: the address is saved first, and the list is the new server's", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    await chat.getByLabel('Its own address').fill(`${b.origin}/v1`);
    await chat.getByRole('button', { name: 'Fetch model list' }).click(); // the tap lets the field go: its save and the Fetch start together
    await expect(chat.getByRole('button', { name: 'Add new-one' })).toBeVisible();
    await expect(chat.getByText('1 model.')).toBeVisible();
    expect(a.requests.filter((q) => q.method === 'GET' && q.path === '/v1/models')).toHaveLength(0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("a Fetch asked before a Save of a new address lands nowhere in the page the Save drew", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    const release = a.holdList();
    await fetchHeld(chat, a);
    await page.getByLabel('Address', { exact: true }).fill(`${b.origin}/v1`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue(`${b.origin}/v1`);
    await expect(chat.getByText('Asking for its models…'), 'the page was drawn').toHaveCount(0);
    release();
    await page.waitForTimeout(1000);
    await expect(chat.getByText(/^\d+ models?\.$/)).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Add old-one' })).toHaveCount(0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("a Fetch's answer, landing while the filter is typed in: the box keeps its element, its text and its caret, its rows follow the text, and text typed elsewhere on the page stays (fails on main: the box was made again, empty)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash'), model('gemma5-small')] });
  try {
    const chat = await addLlamaCpp(page, s);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    const release = s.holdList();
    await fetchHeld(chat, s);
    await chat.getByLabel('Add a model by id').fill('typed-elsewhere');
    const filter = chat.getByLabel('Filter the list');
    await filter.focus();
    await filter.pressSequentially('qwen', { delay: 5 });
    await filter.evaluate((el) => { el.dataset.mine = '1'; });
    release();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' }), 'the rows follow the filter').toHaveCount(0);
    expect(await filter.evaluate((el) => [/** @type {HTMLInputElement} */ (el).dataset.mine, /** @type {HTMLInputElement} */ (el).value, document.activeElement === el])).toEqual(['1', 'qwen', true]);
    await expect(chat.getByLabel('Add a model by id')).toHaveValue('typed-elsewhere');
    await filter.fill('');
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' })).toBeVisible();
  } finally {
    await s.stop();
  }
});
