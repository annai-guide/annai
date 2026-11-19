import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, pickProvider } from './helpers.js';
import { startFakeServer } from '../fakes/model-server.js';

// A provider page's model adds, Add model (by its id) and a listed model's Add, are busy from the tap (model-names-next): a double tap adds
// once. Two clicks in the same instant are the closest a double tap comes; a later one finds the row already gone.

/**
 * Clicks a button twice in the same instant. @param {import('@playwright/test').Locator} button
 * @returns {Promise<boolean>} whether the first click left it disabled
 */
const doubleTap = (button) => button.evaluate((b) => {
  const btn = /** @type {HTMLButtonElement} */ (b);
  btn.click();
  const busy = btn.disabled;
  btn.click();
  return busy;
});

/**
 * A llama.cpp provider on the stand-in server, its page open. @param {import('@playwright/test').Page} page @param {{ origin: string }} s @param {string} key
 * @returns {Promise<import('@playwright/test').Locator>} the page's Chat part
 */
async function addLlamaCpp(page, s, key) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'llama.cpp');
  await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  return page.getByRole('region', { name: 'Chat', exact: true });
}

test("a double tap on a model's Add adds it once, by its id and from the list", async ({ page }) => {
  const key = 'sk-double-tap-stand-in-0123';
  const s = await startFakeServer({
    flavour: 'llamacpp', key,
    models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', object: 'model', owned_by: 'llamacpp' }],
  });
  try {
    const chat = await addLlamaCpp(page, s, key);
    // By its id.
    await chat.getByLabel('Add a model by id').fill('by-id-1');
    expect.soft(await doubleTap(chat.getByRole('button', { name: 'Add model' })), 'Add model is busy from the tap').toBe(true);
    await expect(chat.getByRole('link', { name: /^by-id-1/ })).toBeVisible();
    // From the list.
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    expect.soft(await doubleTap(chat.getByRole('button', { name: 'Add qwen3.8-flash' })), 'a listed Add is busy from the tap').toBe(true);
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toBeVisible();
    // One more add after them: where a second tap had landed, its add would have ended before this one shows (they went one at a time).
    await chat.getByLabel('Add a model by id').fill('by-id-2');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByRole('link', { name: /^by-id-2/ })).toBeVisible();
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ }), 'one model, not "qwen3.8-flash (2)" too').toHaveCount(1);
    await expect(chat.getByRole('link', { name: /^by-id-1/ })).toHaveCount(1);
    await expect(chat.getByText(/already used by another model/), 'no second add was refused').toHaveCount(0);
  } finally {
    await s.stop();
  }
});

// Fix round 2 of form-keep-next. A tap's own draw can wait for what the traveller types after the tap, and a later tap that draws nothing ends it
// without drawing: a screen that left its button busy for the draw to put right (the draw replaces the screen) is then left with it dead. A
// screen puts its button back when its own work ends.

/**
 * Taps the button and types in the field beside it in the same turn, as the traveller does while the work is under way: the work cannot have
 * ended, so what is typed comes after the tap, and the draw the work asks for waits for it. @param {import('@playwright/test').Locator} button @param {string} text
 */
const tapThenType = (button, text) => button.evaluate((b, typed) => {
  const input = /** @type {HTMLInputElement} */ (b.closest('.row')?.querySelector('input'));
  /** @type {HTMLElement} */ (b).click();
  input.value = typed;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, text);

test("Add model by id, with the next id typed before the add lands: its draw waits, Add model works again, and a tap that draws nothing does not leave it dead (fails on b9b40d958)", async ({ page }) => {
  const key = 'sk-by-id-next-stand-in-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    const add = chat.getByRole('button', { name: 'Add model' });
    await chat.getByLabel('Add a model by id').fill('by-id-1');
    await tapThenType(add, 'by-id-2');
    // The draw waits for the id typed after the tap; the button is back at once, as the add has ended.
    await page.waitForTimeout(1600);
    await expect(add).toBeEnabled();
    await expect(chat.getByLabel('Add a model by id')).toHaveValue('by-id-2');
    // A tap that draws nothing ends the draw that waited.
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('1 model.')).toBeVisible();
    await expect(add).toBeEnabled();
    // The next id is added from it, and its draw lists both.
    await add.click();
    await expect(chat.getByRole('link', { name: /^by-id-2/ })).toBeVisible();
    await expect(chat.getByRole('link', { name: /^by-id-1/ })).toBeVisible();
  } finally {
    await s.stop();
  }
});

test("a listed model's Add, with its draw waiting for what is typed after the tap: busy while it waits; once a tap ends the draw, its row says Added, and has no Add to add it again as \"name (2)\" (fails on b9b40d958)", async ({ page }) => {
  const key = 'sk-listed-next-stand-in-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    const row = chat.locator('li.acts', { hasText: 'qwen3.8-flash' });
    // Typed in the id box, never in the filter, which would move the list.
    await chat.getByRole('button', { name: 'Add qwen3.8-flash' }).evaluate((b) => {
      const input = /** @type {HTMLInputElement} */ (b.closest('section')?.querySelector('[id^="model-id-"]'));
      /** @type {HTMLElement} */ (b).click();
      input.value = 'typed-after';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1600);
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' }), 'busy while its draw waits: a second tap would add "qwen3.8-flash (2)"').toBeDisabled();
    // A tap that draws nothing: the first tap on Remove provider only arms it.
    await page.getByRole('button', { name: 'Remove provider' }).click();
    await expect(row.getByText('Added', { exact: true })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toHaveCount(0);
    await expect(chat.getByLabel('Add a model by id')).toHaveValue('typed-after');
  } finally {
    await s.stop();
  }
});

// Fix touch of form-keep-next. What the list says of a model stays true after it is added: the list's own record of what is owned is kept up
// to date by the add, and by what the list is asked for, so a row drawn again (the filter typed) never offers a live Add for a model that is added.

test("a listed model's Add, with the filter typed before the add lands and again after: no Add for that model comes back, and when the screen is drawn there is one model, not \"name (2)\" too (fails on 799dd44a4)", async ({ page }) => {
  const key = 'sk-listed-filter-stand-in-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    const filter = chat.getByLabel('Filter the list');
    // The tap, and the filter typed in the same turn, before the add can have landed: the rows are drawn again by the filter. The caret in the
    // filter, entered after the tap, holds the draw the add asks for.
    await chat.getByRole('button', { name: 'Add qwen3.8-flash' }).evaluate((b) => {
      const filterBox = /** @type {HTMLInputElement} */ (b.closest('section')?.querySelector('[id^="model-filter-"]'));
      /** @type {HTMLElement} */ (b).click();
      filterBox.focus();
      filterBox.value = 'qwen';
      filterBox.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1600); // the add has ended; the draw it asked for waits for the caret
    await filter.fill('qwen3');
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' }), 'the model is added: the list does not offer it again').toHaveCount(0);
    await filter.blur();
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toHaveCount(1);
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toHaveCount(0);
  } finally {
    await s.stop();
  }
});

test("Add model by id whose draw was dropped, then Fetch model list: a listed model it added by another name has no Add (fails on 799dd44a4)", async ({ page }) => {
  const key = 'sk-by-id-listed-stand-in-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', name: 'Gemma 5', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    // The id of a listed model, added by id (so its name is its id, not the list's "Gemma 5"); what is typed after the tap holds the draw.
    await chat.getByLabel('Add a model by id').fill('gemma5-small');
    await tapThenType(chat.getByRole('button', { name: 'Add model' }), 'typed-after');
    await page.waitForTimeout(1600);
    // A tap that draws nothing ends the draw that waited, and asks for the list: it is read as the provider is now.
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' }), 'added already, by its id').toHaveCount(0);
  } finally {
    await s.stop();
  }
});

// One model for each provider model id on a provider's ability (touch 2 of form-keep-next): an add is refused when the provider has one, so a list
// drawn before an add by id, or an add by id of what a list added under its name, never makes a second model of one id ("qwen3.8-flash (2)").

test("a listed Add for a model that Add model by id has added since the list was drawn is refused with words: its row says Already added, nothing else on the page changes (text typed elsewhere stays), and there is one model (fails on 8326b247e, and on 6463fbc42 for the page drawn)", async ({ page }) => {
  const key = 'sk-stale-list-stand-in-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    // Added by id, with something typed after the tap, so the draw waits and the list on show is the one drawn before the add.
    await chat.getByLabel('Add a model by id').fill('qwen3.8-flash');
    await tapThenType(chat.getByRole('button', { name: 'Add model' }), 'typed-after');
    await page.waitForTimeout(1600);
    const stale = chat.getByRole('button', { name: 'Add qwen3.8-flash' });
    await expect(stale, 'the list still offers it: it was drawn before the add').toBeEnabled();
    const row = chat.locator('li.acts', { hasText: 'qwen3.8-flash' });
    await stale.click();
    await expect(page.locator('.toasts .toast', { hasText: '"qwen3.8-flash" is already added here.' })).toBeVisible();
    // The refusal speaks in its row, as a model already added does in the list, and has no Add to tap again.
    await expect(row.getByText(/^Already added, on /)).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add qwen3.8-flash' })).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'Add gemma5-small' }), 'the rest of the list is as it was').toBeEnabled();
    // The page was not drawn: what was typed elsewhere is still in its field (a draw of the page would take it).
    await expect(chat.getByLabel('Add a model by id')).toHaveValue('typed-after');
    // One model, as the page is drawn from what is stored.
    await page.reload();
    await expect(chat.getByRole('link', { name: /^qwen3\.8-flash/ })).toHaveCount(1);
  } finally {
    await s.stop();
  }
});

test("Add model by id of a model a list added under another name is refused with words, and there is one model (fails on 8326b247e)", async ({ page }) => {
  const key = 'sk-by-id-after-list-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', name: 'Gemma 5', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await chat.getByRole('button', { name: 'Add gemma5-small' }).click();
    // Named by the list ("Gemma 5"); its id is the sub line of its card.
    await expect(chat.getByRole('link', { name: /^Gemma 5/ })).toBeVisible();
    await chat.getByLabel('Add a model by id').fill('gemma5-small');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByText('"gemma5-small" is already added here.')).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Add model' })).toBeEnabled();
    await page.reload();
    await expect(chat.getByRole('link', { name: /^Gemma 5/ })).toBeVisible();
    await expect(chat.getByRole('link', { name: /gemma5-small/ })).toHaveCount(1);
  } finally {
    await s.stop();
  }
});

// One rule, the provider model id (models-next; the Deferred entry "A model the traveller added can be added again under its id or its name"):
// a name another model has refuses nothing, from the list or by id: the add takes a free one, "name (2)", as names stay unique.

test("a listed model whose name another model has is offered, and added under a free name, \"Gemma 5 (2)\" (fails on main: \"Already added, on llama.cpp\" and no Add, though its id was not added)", async ({ page }) => {
  const key = 'sk-listed-name-held-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', name: 'Gemma 5', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    // A model whose id is "Gemma 5", named by it: the listed gemma5-small has its name, not its id.
    await chat.getByLabel('Add a model by id').fill('Gemma 5');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByRole('link', { name: /^Gemma 5/ })).toBeVisible();
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(chat.getByText('2 models.')).toBeVisible();
    await expect(chat.getByText(/^Already added/)).toHaveCount(0);
    await chat.getByRole('button', { name: 'Add gemma5-small' }).click();
    await expect(chat.getByRole('link', { name: /^Gemma 5 \(2\)/ })).toBeVisible();
    await expect(chat.getByRole('link', { name: /^Gemma 5/ })).toHaveCount(2);
  } finally {
    await s.stop();
  }
});

test("Add model by id whose name another model has takes a free name, \"Gemma 5 (2)\", and says so in a toast (fails on main: refused, \"already used by another model\")", async ({ page }) => {
  const key = 'sk-by-id-name-held-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'gemma5-small', name: 'Gemma 5', object: 'model', owned_by: 'llamacpp' }] });
  try {
    const chat = await addLlamaCpp(page, s, key);
    await chat.getByRole('button', { name: 'Fetch model list' }).click();
    await chat.getByRole('button', { name: 'Add gemma5-small' }).click();
    await expect(chat.getByRole('link', { name: /^Gemma 5/ })).toBeVisible();
    await chat.getByLabel('Add a model by id').fill('Gemma 5');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(page.locator('.toasts .toast', { hasText: 'Added as "Gemma 5 (2)": "Gemma 5" is already used by another model.' })).toBeVisible();
    await expect(chat.getByRole('link', { name: /^Gemma 5 \(2\)/ })).toBeVisible();
    await expect(chat.getByText(/already used by another model/), 'nothing refused in the models\' status line').toHaveCount(0);
    // An id it has is still refused: one model for each provider model id.
    await chat.getByLabel('Add a model by id').fill('Gemma 5');
    await chat.getByRole('button', { name: 'Add model' }).click();
    await expect(chat.getByText('"Gemma 5" is already added here.')).toBeVisible();
    await page.reload();
    await expect(chat.getByRole('link', { name: /^Gemma 5/ })).toHaveCount(2);
  } finally {
    await s.stop();
  }
});

/**
 * A llama.cpp provider with a 40-model list shown, then its records removed under the open list, so every Add is refused ("That provider
 * no longer exists."). The list shows up to 50 rows in a box of its own, 50vh tall, so a row can sit anywhere on the screen, behind the dock too.
 * @param {import('@playwright/test').Page} page @param {{ origin: string }} s @param {string} key
 * @returns {Promise<import('@playwright/test').Locator>} the page's Chat part
 */
async function refusedList(page, s, key) {
  const chat = await addLlamaCpp(page, s, key);
  await chat.getByRole('button', { name: 'Fetch model list' }).click();
  await expect(chat.getByText('40 models.')).toBeVisible();
  await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { readConfig, removeProviderRecords } = await import(/** @type {string} */ ('/src/core/llm/config.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (const id of Object.keys((await readConfig(ws)).providers)) await removeProviderRecords(ws, store, id);
    store.close();
  });
  // A toast lets taps through (pointer-events: none), so hit-testing skips it: let it take them, to see what is on top at its centre.
  await page.locator('.toasts').evaluate((el) => { el.style.pointerEvents = 'auto'; });
  return chat;
}

/** The refusal's words are in a toast the traveller can see (above the dock, on top), and nowhere in the page's Chat part. @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} chat */
async function expectRefusalToast(page, chat) {
  const words = 'That provider no longer exists.';
  const toast = page.locator('.toasts .toast', { hasText: words });
  await expect(toast).toBeInViewport({ ratio: 1 });
  expect(await toast.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), 'the toast is on top at its centre, not covered by the dock').toBe(true);
  await expect(chat.getByText(words), 'said in a toast, not in the models\' status line or a row').toHaveCount(0);
}

test("a listed Add that fails, on the last row of a long list, says why in a toast, and can be tapped again", async ({ page }) => {
  const key = 'sk-refused-stand-in-0123';
  const s = await startFakeServer({
    flavour: 'llamacpp', key,
    models: Array.from({ length: 40 }, (_, i) => ({ id: `long-list-${String(i).padStart(2, '0')}`, object: 'model', owned_by: 'llamacpp' })),
  });
  try {
    const chat = await refusedList(page, s, key);
    const last = chat.getByRole('button', { name: 'Add long-list-39' });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expectRefusalToast(page, chat);
    await expect(last).toBeEnabled();
  } finally {
    await s.stop();
  }
});

test("a listed Add that fails, on a row just above the dock, says why in a toast the dock does not cover", async ({ page }) => {
  const key = 'sk-refused-near-dock-0123';
  const s = await startFakeServer({
    flavour: 'llamacpp', key,
    models: Array.from({ length: 40 }, (_, i) => ({ id: `long-list-${String(i).padStart(2, '0')}`, object: 'model', owned_by: 'llamacpp' })),
  });
  try {
    const chat = await refusedList(page, s, key);
    const near = chat.getByRole('button', { name: 'Add long-list-05' });
    await near.scrollIntoViewIfNeeded();
    // The page scrolled so the button's bottom edge is 4 px above the dock's top: a line in the row, 8 px under it, would be behind the dock.
    const gap = await near.evaluate((b) => {
      const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)'));
      window.scrollBy(0, b.getBoundingClientRect().bottom - (dock.getBoundingClientRect().top - 4));
      return dock.getBoundingClientRect().top - b.getBoundingClientRect().bottom;
    });
    expect(gap, 'the row is set just above the dock').toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(8);
    // Tapped without Playwright's click, which moved the page here (measured: 194 px, Chromium) where a finger's tap moves nothing.
    await near.dispatchEvent('click');
    await expectRefusalToast(page, chat);
    await expect(near).toBeEnabled();
  } finally {
    await s.stop();
  }
});
