import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// A provider page's Fetch model list while the page changes (models-next; the Deferred entry "A model list fetched while the page changes"),
// and after its connection changes (model-list-a-next). The page keeps no copy of the list (model-list-next took one out): a list is what its
// part shows, and a Fetch's answer goes to the part on show for its ability when it lands, a part drawn since the tap too, unless what it was
// asked under (the connection) has changed since. A list on show stays when the connection changes, and its rows' Adds are refused in words.
// The filter box is made once a part; an answer draws only its rows. The screen never changes under the traveller's hands (the timeline spec).

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

const STALE = 'This list is from before the address or key changed. Fetch the model list again.';

test("a list fetched under the ability's old address stays where it stands when Its own address is saved as another, the page not drawn, and its Add is refused in words, adding nothing; a Fetch then lists the new server's by the filter's text (fails on 72a3607f5: the list was taken away; before it, the old server's model was added)", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one'), model('old-two')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await chat.getByLabel('Add a model by id').fill('typed-elsewhere');
    await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
    const filter = chat.getByLabel('Filter the list');
    await filter.fill('old-t');
    await filter.evaluate((el) => { el.dataset.mine = '1'; });
    await ownAddress(chat, b);
    // Nothing moves under the traveller's hands: the rows, the count, the box and its text are as they were.
    await expect(chat.getByText('2 models.')).toBeVisible();
    await expect(filter).toHaveAttribute('data-mine', '1');
    await expect(filter).toHaveValue('old-t');
    const add = chat.getByRole('button', { name: 'Add old-two' });
    await add.click();
    await expect(page.locator('.toasts .toast', { hasText: STALE })).toBeVisible();
    await expect(add, 'offered again').toBeEnabled();
    await expect(chat.getByRole('link', { name: /^old-two/ })).toHaveCount(0);
    await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
    await expect(chat.getByLabel('Add a model by id')).toHaveValue('typed-elsewhere');
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add old-two' })).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Add new-one' }), 'filtered by what the box says').toHaveCount(0);
    await filter.fill('');
    await chat.getByRole('button', { name: 'Add new-one' }).click();
    await expect(chat.getByRole('link', { name: /^new-one/ })).toBeVisible();
    await page.reload();
    await expect(chat.getByRole('link', { name: /^(old|new)-/ })).toHaveCount(1);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("Its own address typed, then a row's Add of the old list tapped straight away: the address is saved first, and the Add is refused in words (fails on 72a3607f5: the old server's model was added)", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await chat.getByLabel('Its own address').fill(`${b.origin}/v1`);
    await chat.getByRole('button', { name: 'Add old-one' }).click(); // the tap lets the field go: its save and the Add start together
    await expect(page.locator('.toasts .toast', { hasText: STALE })).toBeVisible();
    await expect(chat.locator('.saved', { hasText: 'Saved' })).toBeVisible();
    await page.reload();
    await expect(chat.getByLabel('Its own address')).toHaveValue(`${b.origin}/v1`);
    await expect(chat.getByRole('link', { name: /^old-one/ })).toHaveCount(0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("an Add model by id refusal's words stay when Its own address is saved as another (fails on 72a3607f5: the drop cleared them)", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    await chat.getByLabel('Add a model by id').fill('dup-one');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByRole('link', { name: /^dup-one/ })).toBeVisible();
    await chat.getByLabel('Add a model by id').fill('dup-one');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByText('"dup-one" is already added here.')).toBeVisible();
    await ownAddress(chat, b);
    await expect(chat.getByText('"dup-one" is already added here.')).toBeVisible();
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
    // The Fetch still asks: its words stay, and its button, greyed, says why until the old server answers.
    const fetchList = chat.getByRole('button', { name: 'Fetch model list' });
    await expect(chat.getByText('Asking for its models…')).toBeVisible();
    await expect(fetchList).toBeDisabled();
    release();
    await expect(fetchList).toBeEnabled(); // handled: the page gives the button back and tells the part in one block, which writes the count of a list that landed
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
    const asked = await chat.getByRole('button', { name: 'Fetch model list' }).elementHandle();
    await page.getByLabel('Address', { exact: true }).fill(`${b.origin}/v1`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue(`${b.origin}/v1`);
    await expect(chat.getByText('Asking for its models…'), 'the page was drawn').toHaveCount(0);
    release();
    // The answer was handled once the button it was asked from, in the part drawn away, is back: the page sets that and tells the part on
    // show in one block, which also writes the count of a list that landed, so the count checked next is already there if one did.
    await expect.poll(() => asked?.evaluate((b) => /** @type {HTMLButtonElement} */ (b).disabled)).toBe(false);
    await expect(chat.getByText(/^\d+ models?\.$/)).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Add old-one' })).toHaveCount(0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

/** The provider's key, headers or key header, or the ability's list path, changed in the store from a second store instance: no draw, as a plugin's sign-in changes a key. @param {import('@playwright/test').Page} page @param {string} changed */
const changeInStore = (page, changed) => page.evaluate(async (changed) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const { readConfig, saveProvider, setKey } = await import(/** @type {string} */ ('/src/core/llm/config.js'));
  const store = await createIdbStore();
  const ws = new Workspace(store);
  const [rec] = Object.values((await readConfig(ws)).providers);
  const user = /** @type {any} */ (rec.user ?? {});
  if (changed === 'key') await setKey(store, rec.id, 'sk-signed-in-again-0123');
  else if (changed === 'list path') await saveProvider(ws, { ...rec, user: { ...user, abilities: { ...user.abilities, chat: { ...user.abilities?.chat, tunables: { ...user.abilities?.chat?.tunables, listPath: '/other/models' } } } } });
  else if (changed === 'headers reordered') await saveProvider(ws, { ...rec, user: { ...user, headers: Object.fromEntries(Object.entries(user.headers).reverse()) } });
  else if (changed === 'headers changed') await saveProvider(ws, { ...rec, user: { ...user, headers: { ...user.headers, 'X-Two': '3' } } });
  else await saveProvider(ws, { ...rec, user: { ...user, ...(changed === 'headers' ? { headers: { 'X-Signed-In': 'again' } } : { keyHeader: 'X-Api-Key' }) } });
  store.close();
}, changed);

/** The Extra headers typed on the provider's page and saved; the Save draws the page, so no list is on show after it. @param {import('@playwright/test').Page} page @param {string} json */
async function saveHeaders(page, json) {
  const headers = page.getByLabel('Extra headers (JSON)');
  await headers.fill(json);
  await headers.evaluate((el) => { el.dataset.drawn = 'before'; });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(headers, 'the page was drawn').not.toHaveAttribute('data-drawn', 'before');
}

test("a Fetch asked before the Extra headers are saved with the same lines in another order lands, in the page the Save drew (fails on 15cd2ad98: the order made it another connection, and the list landed nowhere)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash')] });
  try {
    const chat = await addLlamaCpp(page, s);
    await saveHeaders(page, '{"X-One":"1","X-Two":"2"}');
    const release = s.holdList();
    await fetchHeld(chat, s);
    await saveHeaders(page, '{"X-Two":"2","X-One":"1"}');
    await expect(chat.getByText('Asking for its models…'), 'the page was drawn').toHaveCount(0);
    release();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await chat.getByRole('button', { name: 'Add qwen3.8-flash' }).click();
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toBeVisible();
  } finally {
    await s.stop();
  }
});

test("a list on show when the Extra headers are changed in the store to the same lines in another order, the page not drawn, adds its model, and with a value changed refuses (fails on 15cd2ad98: the order alone refused the Add)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash'), model('gemma5-small')] });
  try {
    const chat = await addLlamaCpp(page, s);
    await saveHeaders(page, '{"X-One":"1","X-Two":"2"}');
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await changeInStore(page, 'headers reordered');
    await chat.getByRole('button', { name: 'Add qwen3.8-flash' }).click();
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toBeVisible();
    await chat.getByRole('button', { name: 'Fetch model list' }).click(); // an Add draws the part, and its list goes
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' })).toBeVisible();
    await changeInStore(page, 'headers changed');
    await chat.getByRole('button', { name: 'Add gemma5-small' }).click();
    await expect(page.locator('.toasts .toast', { hasText: STALE })).toBeVisible();
    await page.reload();
    await expect(chat.getByRole('link', { name: /^gemma5-small/ })).toHaveCount(0);
  } finally {
    await s.stop();
  }
});

// The control of the four below: the same hold and release with nothing changed lists, so each of them proves its own claim.
test("a Fetch asked and answered with nothing changed lists its models (the control of the Fetches that land nowhere when the key, headers, key header or list path change)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash')] });
  try {
    const chat = await addLlamaCpp(page, s);
    await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
    const release = s.holdList();
    await fetchHeld(chat, s);
    release();
    await expect(chat.getByRole('button', { name: 'Fetch model list' })).toBeEnabled();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toBeVisible();
    await expect(chat.getByText('Asking for its models…')).toHaveCount(0);
    await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
  } finally {
    await s.stop();
  }
});

// What a list is asked under is the ability's address and list path and the provider's headers, key header and key, as stored. A Save and Remove
// key draw the page; a plugin's sign-in changes the key and draws nothing. A Fetch's answer lands nowhere, and a list on show refuses its Adds
// in words, if what is stored by then is not what it was asked under.
for (const what of ['key', 'headers', 'key header', 'list path']) {
  test(`a Fetch asked before the ${what} changes in the store, the page not drawn, lands nowhere (fails when what it was asked under leaves out the ${what})`, async ({ page }) => {
    const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash')] });
    try {
      const chat = await addLlamaCpp(page, s);
      await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
      const release = s.holdList();
      await fetchHeld(chat, s);
      await changeInStore(page, what);
      release();
      await expect(chat.getByRole('button', { name: 'Fetch model list' })).toBeEnabled(); // handled: the count of a list that landed is written with it
      await expect(chat.getByText(/^\d+ models?\.$/)).toHaveCount(0);
      await expect(chat.getByText('Asking for its models…')).toHaveCount(0);
      await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
    } finally {
      await s.stop();
    }
  });

  test(`a list on show when the ${what} changes in the store, the page not drawn, refuses its Add in words and adds nothing (fails on 72a3607f5: the model was added)`, async ({ page }) => {
    const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash')] });
    try {
      const chat = await addLlamaCpp(page, s);
      await chat.getByRole('button', { name: 'Fetch model list' }).click();
      await expect(chat.getByText('1 model.')).toBeVisible();
      await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
      await changeInStore(page, what);
      await chat.getByRole('button', { name: 'Add qwen3.8-flash' }).click();
      await expect(page.locator('.toasts .toast', { hasText: STALE })).toBeVisible();
      await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
      await page.reload();
      await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toHaveCount(0);
    } finally {
      await s.stop();
    }
  });
}

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
    await filter.evaluate((el) => { el.dataset.mine = '1'; /** @type {HTMLInputElement} */ (el).setSelectionRange(2, 2); }); // the caret in the middle: "qw|en"
    release();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' }), 'the rows follow the filter').toHaveCount(0);
    expect(await filter.evaluate((el) => [/** @type {HTMLInputElement} */ (el).dataset.mine, /** @type {HTMLInputElement} */ (el).value, document.activeElement === el, /** @type {HTMLInputElement} */ (el).selectionStart])).toEqual(['1', 'qwen', true, 2]);
    await expect(chat.getByLabel('Add a model by id')).toHaveValue('typed-elsewhere');
    await filter.fill('');
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' })).toBeVisible();
  } finally {
    await s.stop();
  }
});

test("a Fetch whose reading of the connection fails still gives the button and the status back, and says why (fails on 3bc080fa8: stuck on \"Asking for its models…\", the button disabled; on main the button comes back, the list lands and no error shows)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash')] });
  try {
    const chat = await addLlamaCpp(page, s);
    const release = s.holdList();
    await fetchHeld(chat, s);
    // The key can't be read when the answer comes: the second reading of the connection fails.
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (stores, ...rest) {
        if ([].concat(stores).includes('secrets')) throw new Error('the key store is unreadable');
        return transaction.call(this, stores, ...rest);
      };
    });
    release();
    await expect(chat.getByRole('button', { name: 'Fetch model list' })).toBeEnabled();
    await expect(chat.getByText('Asking for its models…')).toHaveCount(0);
    await expect(chat.getByText('the key store is unreadable')).toBeVisible();
  } finally {
    await s.stop();
  }
});
