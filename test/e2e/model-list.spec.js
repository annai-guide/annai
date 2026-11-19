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

test("a list fetched under the ability's old address goes, where it stands, when Its own address is saved as another; the filter box stays, with its text, and the page is not drawn, and a Fetch then lists the new server's by that text (fails on main: the old list stayed, its Add live)", async ({ page }) => {
  const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one'), model('old-two')] });
  const b = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('new-one')] });
  try {
    const chat = await addLlamaCpp(page, a);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
    const filter = chat.getByLabel('Filter the list');
    await filter.fill('old-t');
    await expect(chat.getByRole('button', { name: 'Add old-two' })).toBeVisible();
    await filter.evaluate((el) => { el.dataset.mine = '1'; });
    await ownAddress(chat, b);
    await expect(chat.getByRole('button', { name: 'Add old-two' })).toHaveCount(0);
    await expect(chat.getByText('2 models.')).toHaveCount(0);
    await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
    // The box is not taken from under the traveller's hands: the same element, its text still there, and the list empty.
    await expect(filter).toHaveAttribute('data-mine', '1');
    await expect(filter).toHaveValue('old-t');
    await expect(chat.locator('ul.listed li')).toHaveCount(0);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add new-one' }), 'filtered by what the box says').toHaveCount(0);
    await filter.fill('');
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

// What a Fetch asks under is the ability's address and the provider's headers, key header and key, as stored. A Save and Remove key draw the page; a
// plugin's sign-in changes the key and draws nothing, so the part on show is told only if what is stored when the answer comes is what it was asked under.
for (const what of ['key', 'headers', 'key header']) {
  test(`a Fetch asked before the provider's ${what} changes in the store, the page not drawn, lands nowhere (fails when what it was asked under leaves out the ${what})`, async ({ page }) => {
    const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('qwen3.8-flash')] });
    try {
      const chat = await addLlamaCpp(page, s);
      await chat.getByLabel('Add a model by id').evaluate((el) => { el.dataset.mine = '1'; });
      const release = s.holdList();
      await fetchHeld(chat, s);
      await page.evaluate(async (changed) => {
        const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
        const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
        const { readConfig, saveProvider, setKey } = await import(/** @type {string} */ ('/src/core/llm/config.js'));
        const store = await createIdbStore();
        const ws = new Workspace(store);
        const [rec] = Object.values((await readConfig(ws)).providers);
        if (changed === 'key') await setKey(store, rec.id, 'sk-signed-in-again-0123');
        else await saveProvider(ws, { ...rec, user: { ...rec.user, ...(changed === 'headers' ? { headers: { 'X-Signed-In': 'again' } } : { keyHeader: 'X-Api-Key' }) } });
        store.close();
      }, what);
      release();
      await expect(chat.getByRole('button', { name: 'Fetch model list' })).toBeEnabled(); // handled: the count of a list that landed is written with it
      await expect(chat.getByText(/^\d+ models?\.$/)).toHaveCount(0);
      await expect(chat.getByText('Asking for its models…')).toHaveCount(0);
      await expect(chat.getByLabel('Add a model by id'), 'the page was not drawn').toHaveAttribute('data-mine', '1');
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

// A list's own Add that fails after its list was dropped (a drop is the part told, as an own-address save tells it: `listed` with nothing) draws
// nothing back: the failure redraws the part's list as it is now. The tap and the drop come in one turn, so the Add, which waits for the store,
// ends after the drop; a refusal is made in the store first, from a second store instance, the page not drawn.
for (const [how, words] of [['the provider is gone', 'That provider no longer exists.'], ['another add took the model first', '"old-two" is already added here.']]) {
  test(`a listed Add that fails after its list was dropped puts no row back, ${how} (fails on 966026720: the old rows were drawn again)`, async ({ page }) => {
    const a = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one'), model('old-two')] });
    try {
      const chat = await addLlamaCpp(page, a);
      await chat.getByRole('button', { name: 'Fetch model list' }).click();
      await expect(chat.getByText('2 models.')).toBeVisible();
      await page.evaluate(async (gone) => {
        const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
        const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
        const { readConfig, removeProviderRecords } = await import(/** @type {string} */ ('/src/core/llm/config.js'));
        const { addModelById } = await import(/** @type {string} */ ('/src/core/llm/providers.js'));
        const store = await createIdbStore();
        const ws = new Workspace(store);
        const [rec] = Object.values((await readConfig(ws)).providers);
        if (gone) await removeProviderRecords(ws, store, rec.id);
        else await addModelById({ ws }, rec.id, 'chat', 'old-two');
        store.close();
      }, how === 'the provider is gone');
      await chat.getByRole('button', { name: 'Add old-two' }).evaluate((b) => {
        /** @type {HTMLElement} */ (b).click();
        b.closest('[data-models]')?.dispatchEvent(new CustomEvent('listed', { detail: null }));
      });
      await expect(page.locator('.toasts .toast', { hasText: words })).toBeVisible();
      await expect(chat.locator('ul.listed li')).toHaveCount(0);
      await expect(chat.getByRole('button', { name: /^Add old-/ })).toHaveCount(0);
    } finally {
      await a.stop();
    }
  });
}

test("a Fetch's answer is drawn where the part is told of it, with nothing waited for between: a drop told right after leaves no rows and no count (fails on 966026720: the draw waited for a read of the config, and came after the drop)", async ({ page }) => {
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY, models: [model('old-one'), model('old-two')] });
  try {
    const chat = await addLlamaCpp(page, s);
    const part = chat.locator('[data-models]');
    // A listener of the test's, after the part's own: it sees the part as it is the moment the part has handled the answer, and then drops the
    // list as an own-address save does.
    await part.evaluate((el) => {
      el.addEventListener('listed', (e) => {
        if (!(/** @type {CustomEvent} */ (e).detail?.listed)) return;
        /** @type {HTMLElement} */ (el).dataset.drawn = String(el.querySelectorAll('ul.listed li').length);
        el.dispatchEvent(new CustomEvent('listed', { detail: null }));
      });
    });
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByRole('button', { name: 'Fetch model list' })).toBeEnabled(); // handled: the button is given back and the part told in one block
    expect(await part.getAttribute('data-drawn'), 'both rows were drawn when the part had handled the answer').toBe('2');
    await expect(chat.locator('ul.listed li')).toHaveCount(0);
    await expect(chat.getByText(/^\d+ models?\.$/)).toHaveCount(0);
  } finally {
    await s.stop();
  }
});
