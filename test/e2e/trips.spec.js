import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, buildAndSave, writeEvent, writeRecords, startTrip as startNamed, allFiles, putFile, breakOpen, catchAgent, goToHash, modelSetUp, startModelServer, anthropicToolReply } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByText('Add dates (optional)').click();
  await page.getByLabel('Starts').fill('2026-11-25');
  await page.getByLabel('Ends').fill('2026-11-29');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
}

test('create a trip, edit a note, and restore an earlier version', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur · Thanksgiving');
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/trip\.json/ })).toBeVisible();
  await allFiles(page);
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByLabel('Content').fill('# Day 1\nMcWay Falls at sunset.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByLabel('Content').fill('# Day 1\nChanged my mind.');
  await page.getByRole('button', { name: 'Save' }).click();
  const restore = page.getByRole('button', { name: 'Restore this version' });
  await expect(restore).toHaveCount(2);
  await restore.first().click();
  await expect(page.getByLabel('Content')).toHaveValue('# Day 1\nMcWay Falls at sunset.');
});

test('records are checked against their format before saving', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await allFiles(page);
  await page.getByLabel('File path').fill('/plan/dinner.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill('{ "id": "dinner", "title": "Nepenthe" }');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('$.fixed: is required');
  await page.getByLabel('Content').fill('{ "id": "dinner", "title": "Nepenthe", "fixed": true }');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
});

test('upload a photo and see it', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await allFiles(page);
  await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
  await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
});

test('archive a trip, then bring it back', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Old trip');
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await page.getByText('Archived trips (1)').click();
  await page.getByRole('link', { name: /Old trip/ }).click();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('link', { name: /Old trip/ })).toBeVisible();
});

test('a bad trip name gets a plain explanation', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Trip name').fill('   ');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('alert')).toContainText('Give the trip a name');
});

test('a full device says what to do, and nothing is half-saved', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await allFiles(page);
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });
  await page.getByLabel('Content').fill('# Day 1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText("annai's storage is full", { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export a backup' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Content')).toHaveValue('# day1\n'); // still the version from before the failed save
});

test("a trip link can't open your profile or annai's own files", async ({ page }) => {
  await openApp(page, '#/trip/me/file?path=%2Fprofile.md'); // not a trip: it has no screen, and goes to Trips in its place
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(hashOf(page)).toBe('#/trips');
  await expect(page.getByRole('heading', { name: '/profile.md' })).toHaveCount(0);
});

test('a trip card says when the trip was last backed up, and when it changed since', async ({ page }) => {
  await openApp(page);
  const id = await startTrip(page, 'Big Sur');
  const card = page.getByRole('link', { name: /Big Sur/ });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(card).toContainText('not backed up');
  await goToHash(page, `#/trip/${id}`); // a card's tap opens its conversation (timeline stage 4)
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(card).toContainText('backed up just now');
  await expect(card).not.toContainText('changed since');
  await goToHash(page, `#/trip/${id}`); // a card's tap opens its conversation (timeline stage 4)
  await allFiles(page);
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(card).toContainText('changed since');
});

test('a Backup saved while storage is full still says it was saved', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByRole('button', { name: 'Export trip' }).click();
  await page.getByRole('button', { name: 'Build file' }).click();
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeVisible();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });
  const downloading = page.waitForEvent('download');
  await save.click();
  await downloading;
  await expect(page.getByText('Saved to your downloads.')).toBeVisible();
  await expect(page.getByText("annai's storage is full", { exact: true })).toBeVisible();
});

/** How many images annai has stored. @param {import('@playwright/test').Page} page @returns {Promise<number>} */
function storedImages(page) {
  return /** @type {Promise<number>} */ (page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const db = r.result;
      const all = db.transaction('blobs').objectStore('blobs').getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result.filter((b) => String(b.type).startsWith('image/')).length);
      };
      all.onerror = () => reject(all.error);
    };
    r.onerror = () => reject(r.error);
  })));
}

test('remove a trip: one question, which says so when something in it is not in a Backup', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
  expect(await storedImages(page)).toBe(1);
  const question = page.getByRole('dialog', { name: 'Big Sur' });

  // Escape is a no.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toContainText('This removes everything in this trip from this device');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Never backed up: the one question says so, and Cancel keeps the trip (there is no second question).
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toContainText("This removes everything in this trip from this device: its files, photos, notes and history. It hasn't been backed up since it last changed. Remove it?");
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  expect(await storedImages(page)).toBe(1);

  // Backed up and unchanged: the plain question, and its one Remove takes the trip and its photo away.
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toContainText('This removes everything in this trip from this device: its files, photos, notes and history. Remove it?');
  await expect(question).not.toContainText('backed up');
  await question.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/^Removed Big Sur\. .+ freed\.$/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(0);
  expect(await storedImages(page)).toBe(0);
});

test('remove a trip changed after its last Backup: the one question says so again, and one tap on Remove removes it', async ({ page }) => {
  await openApp(page);
  const id = await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  const question = page.getByRole('dialog', { name: 'Big Sur' });
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toContainText('This removes everything in this trip from this device');
  await expect(question).not.toContainText('backed up');
  await question.getByRole('button', { name: 'Cancel' }).click();
  // Something is added after the Backup: the trip changed, and it is what the question says.
  await putFile(page, id, '/files/later.txt', Buffer.from('Booked the second night.'), 'text/plain');
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toContainText("It hasn't been backed up since it last changed. Remove it?");
  await expect(question.getByRole('button')).toHaveText(['Cancel', 'Remove']);
  await question.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(0);
});

test('an archived trip can be removed too', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Old trip');
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await page.getByText('Archived trips (1)').click();
  await page.getByRole('link', { name: /Old trip/ }).click();
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Old trip' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText(/Archived trips/)).toHaveCount(0);
});

test('Remove trip runs once at a time', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const button = page.locator('button', { hasText: 'Remove trip' });
  await button.click();
  await expect(page.getByRole('dialog', { name: 'Big Sur' })).toBeVisible();
  await expect(button).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(button).toBeEnabled();
});

test('a log line written into a removed trip is gone after the next start', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  /** Puts one log line into the scope (a request that ignored Stop, finishing late), or counts its lines. */
  const events = (/** @type {'put' | 'count'} */ op) => page.evaluate(({ scope, op }) => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const tx = r.result.transaction('events', op === 'put' ? 'readwrite' : 'readonly');
      const os = tx.objectStore('events');
      /** @type {IDBRequest} */
      const q = op === 'put'
        ? os.put({ scope, seq: 7, ts: Date.now(), type: 'net.request', actor: 'system', data: { url: 'https://example.com/' } })
        : os.count(IDBKeyRange.bound([scope, -Infinity], [scope, Infinity]));
      tx.oncomplete = () => { r.result.close(); resolve(q.result); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  }), { scope: id, op });
  await events('put');
  expect(await events('count')).toBe(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  expect(await events('count')).toBe(0);
});

test('removing a trip that is already gone says so', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.evaluate((scope) => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const tx = r.result.transaction('scopes', 'readwrite');
      tx.objectStore('scopes').delete(scope);
      tx.oncomplete = () => { r.result.close(); resolve(undefined); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  }), id);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('That trip was already removed.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});

test('a trip card shows the stamps its arrivals earned, and the trip page all of them (spec §13, §16.2)', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Kyoto in spring');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  for (const [name, lat, lng] of /** @type {const} */ ([['伏見稲荷大社', 34.967, 135.773], ['Arashiyama', 35.009, 135.667], ['Kiyomizu-dera', 34.995, 135.785]])) {
    await writeEvent(page, id, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name, lat, lng } } });
  }
  await page.goto('/#/trips');
  const card = page.getByRole('link', { name: /Kyoto in spring/ });
  await expect(card).toContainText('3 stamps');
  await expect(card.getByRole('img', { name: '3 stamps: 伏見稲荷大社, Arashiyama, Kiyomizu-dera' })).toBeVisible();
  await expect(card.locator('.stamp')).toHaveText(['伏見', 'Arashiya', 'Kiyomizu']); // a card's ring takes 8 characters at 7 px: a longer word shows its start
  // A screen reader hears the count once: the line's "3 stamps" is skipped, the marks say it with the names (the second emulator re-check).
  const name = await card.evaluate((el) => {
    const read = (/** @type {Node} */ n) => (n.nodeType === 3 ? n.textContent ?? '' : n instanceof HTMLElement && n.getAttribute('aria-hidden') === 'true' ? '' : n instanceof HTMLElement && n.getAttribute('role') === 'img' ? n.getAttribute('aria-label') ?? '' : [...n.childNodes].map(read).join(' '));
    return read(el);
  });
  expect(name.match(/3 stamps/g)?.length).toBe(1);
  await goToHash(page, `#/trip/${id}`); // a card's tap opens its conversation (timeline stage 4)
  await expect(page.getByRole('img', { name: /^3 stamps:/ })).toBeVisible();
  const facts = await page.locator('p.sub').filter({ hasText: 'files' }).first().evaluate((p) => [...p.querySelectorAll('[aria-hidden="true"]')].map((e) => e.textContent));
  expect(facts).toEqual(['3 stamps']);
});

test("each stamp shows its whole word inside its own ring, on a card on a phone 320 wide and on the trip's page (the emulator pass: \"Nepent\")", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await startTrip(page, 'Big Sur on Highway 1: Monterey to Cambria');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  const names = ['Nepenthe', 'Westminster Abbey', 'Bixby Creek Bridge', 'Arashiyama', 'Kiyomizu-dera', 'Yellowstone', '伏見稲荷大社', 'Hearst Castle'];
  for (const name of names) await writeEvent(page, id, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name, lat: 36, lng: -121 } } });
  /** Each mark: whether its word is wider than the inside of its ring, and whether the next mark covers it. @param {import('@playwright/test').Locator} marks */
  const fits = (marks) => marks.evaluate((box) => document.fonts.ready.then(() => [...box.querySelectorAll('.stamp')].map((m, i, all) => {
    const el = /** @type {HTMLElement} */ (m);
    const range = document.createRange();
    range.selectNodeContents(el);
    const turned = el.style.getPropertyValue('transform');
    el.style.setProperty('transform', 'none'); // measured upright
    const word = range.getBoundingClientRect().width;
    el.style.setProperty('transform', turned);
    const inside = el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight);
    const next = /** @type {HTMLElement | undefined} */ (all[i + 1]);
    const covered = next && next.offsetTop === el.offsetTop && next.offsetLeft < el.offsetLeft + el.offsetWidth;
    const small = parseFloat(getComputedStyle(el).fontSize) < 7 ? ` ${getComputedStyle(el).fontSize}` : ''; // review m1: never below 7 px
    return `${el.textContent}${word > inside + 0.5 ? ' cut' : ''}${covered ? ' covered' : ''}${small}`;
  })));
  await page.goto('/#/trips');
  const card = page.getByRole('link', { name: /Big Sur on Highway 1/ }).getByRole('img', { name: /^8 stamps:/ });
  await expect(card).toBeVisible();
  expect(await fits(card)).toEqual(['Nepenthe', 'Westmins', '+6']); // a long word: its start, at a type that still reads
  await goToHash(page, `#/trip/${id}`); // a card's tap opens its conversation (timeline stage 4)
  await expect(page.getByRole('heading', { level: 1, name: 'Big Sur on Highway 1: Monterey to Cambria' })).toBeVisible();
  const all = page.getByRole('img', { name: /^8 stamps:/ });
  await expect(all).toBeVisible();
  expect(await fits(all)).toEqual(['Nepenthe', 'Westminster', 'Bixby', 'Arashiyama', 'Kiyomizu', 'Yellowstone', '伏見', 'Hearst']);
});

test('Back closes a question as No, where the browser has no CloseWatcher (Chrome before 120, Safari), and its entry never undoes what an answer does', async ({ page }) => {
  await page.addInitScript(() => { delete (/** @type {any} */ (window)).CloseWatcher; });
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const trip = page.url();
  const question = page.getByRole('dialog', { name: 'Big Sur' });
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toBeVisible();
  await page.goBack(); // Android's Back
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(page.url()).toBe(trip);
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

  // Cancel takes its entry back too: the next Back leaves the trip, as it would have.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.annaiAsk ?? null)).toBe(null); // a few ms: no finger is that quick
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

  // The question, then the answer moves to Trips and stays there.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await question.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(0);
});

// Chrome 113 on Android swallowed the first Back for a modal <dialog> (the second emulator re-check), so where it can't use
// CloseWatcher the question is not modal: annai's own backdrop, the page behind inert, the focus kept in the question.
test('on Android with no CloseWatcher, the question is not a modal dialog: the page behind is inert, Tab stays in the question, Escape and Back close it as No', async ({ page }) => {
  await page.addInitScript(() => { delete (/** @type {any} */ (window)).CloseWatcher; });
  await openApp(page);
  test.skip(await page.evaluate(() => !/Android/.test(navigator.userAgent)), 'an iPhone keeps the modal, with its history entry: the first test above');
  await startTrip(page, 'Big Sur');
  const trip = page.url();
  const question = page.getByRole('dialog', { name: 'Big Sur' });
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toBeVisible();
  expect(await question.evaluate((d) => d.matches(':modal'))).toBe(false);
  await expect(question).toHaveAttribute('aria-modal', 'true');
  expect(await page.evaluate(() => [...document.body.children].filter((el) => !el.matches('dialog.ask, .ask-backdrop')).every((el) => /** @type {HTMLElement} */ (el).inert))).toBe(true);
  await expect(page.locator('.ask-backdrop')).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.textContent);
  expect(await focused()).toBe('Cancel'); // a stray Enter never confirms
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Remove');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Cancel');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('Remove');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.ask-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('[inert]')].length)).toBe(0);
  expect(page.url()).toBe(trip);
  // The first Back closes it, and the page works again.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(page.url()).toBe(trip);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(question).toBeVisible();
});

for (const iphone of [false, true]) {
  test(`a question open when the user moves to another screen closes as Cancel: a Forward, a tapped reminder${iphone ? ' (no CloseWatcher, as on an iPhone)' : ''}`, async ({ page }) => {
    if (iphone) await page.addInitScript(() => { delete (/** @type {any} */ (window)).CloseWatcher; });
    await openApp(page);
    const nara = await startNamed(page, 'Nara');
    await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
    const kyoto = await startNamed(page, 'Kyoto');
    const question = page.getByRole('dialog', { name: 'Kyoto' });
    if (!iphone && await page.evaluate(() => 'CloseWatcher' in window)) { // no entry of its own: Settings is still ahead
      await goToHash(page, '#/settings');
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await page.goBack();
      await page.getByRole('button', { name: 'Remove trip' }).click();
      await expect(question).toBeVisible();
      await page.goForward();
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await expect(question).toHaveCount(0);
      await page.goBack();
    }
    await page.getByRole('button', { name: 'Remove trip' }).click();
    await expect(question).toBeVisible();
    await page.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'annai.open', scope: id } })), nara);
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${nara}/talk`);
    await expect(question).toHaveCount(0);
    await page.goBack(); // over the question's entry, if it had one: Kyoto's Details, still there
    await expect(page.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
    expect(hashOf(page)).toBe(`#/trip/${kyoto}`);
  });
}

test('where the browser closes a question on Back itself (CloseWatcher), annai adds no history entry of its own', async ({ page }) => {
  await openApp(page);
  test.skip(!(await page.evaluate(() => 'CloseWatcher' in window)), 'this browser has no CloseWatcher');
  await startTrip(page, 'Big Sur');
  const before = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(page.getByRole('dialog', { name: 'Big Sur' })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('"Tap again" comes where the first tap was, on a phone 320 wide, and waits 8 seconds for the second, the same everywhere (the emulator pass)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.clock.install();
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const archive = page.getByRole('button', { name: 'Archive trip' });
  const remove = page.getByRole('button', { name: 'Remove trip' });
  await archive.evaluate((el) => el.scrollIntoView({ block: 'center' })); // clear of the dock: the tap then doesn't scroll
  const was = [await archive.boundingBox(), await remove.boundingBox()];
  await archive.click();
  const again = page.getByRole('button', { name: 'Tap again to archive' });
  await expect(again).toBeVisible();
  expect([await again.boundingBox(), await remove.boundingBox()]).toEqual(was);
  await page.clock.fastForward(7_500);
  await expect(again).toBeVisible();
  await page.clock.fastForward(600);
  await expect(archive).toBeVisible();
  await expect(again).toHaveCount(0);
});

test("review m2: a question's history entry left from before a reload is never taken for a new question's: answering stays on the screen", async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const trip = page.url();
  // What a reload with a question open leaves: an entry of an earlier page's first question.
  await page.evaluate(() => history.replaceState({ ...history.state, annaiAsk: 'ask-0' }, ''));
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(page.url()).toBe(trip);
  await expect(page.getByRole('heading', { level: 1, name: 'Big Sur' })).toBeVisible();
});

// The user, 2026-10-21: "the trip you had open". A fresh start at "/" reopens the trip's screen that was open.
test('a fresh start reopens the trip screen that was open, and shows Trips when that trip is gone', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.evaluate(async () => { // the welcome has been seen on this device
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { updateAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { welcomedAt: Date.now() });
    store.close();
  });
  await page.getByRole('link', { name: 'Itinerary', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('annai.resume'))).toContain('/plan"'); // drawn at the trip's own address, and noted
  await page.goto('/'); // a new launch from the Home Screen icon
  await expect.poll(() => page.url()).toMatch(/\/plan$/);
  // A link that points at a screen is respected.
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // The trip's own page, then gone: removed, with the screen still noted as it was.
  await page.goto(`/#/trip/${id}`);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.evaluate((id) => localStorage.setItem('annai.resume', JSON.stringify({ hash: `#/trip/${id}/plan`, trip: id })), id);
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(page.url()).not.toContain('/trip/');
});

test('Start a trip needs only a name: the trip opens with no dates, and on Trips it is a conversation\'s line, not a card (timeline stage 4)', async ({ page }) => {
  await openApp(page);
  await expect(page.getByLabel('Starts')).toBeHidden(); // folded under Add dates (optional)
  await startNamed(page, 'Somewhere north');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  const card = page.locator('.trip-card', { hasText: 'Somewhere north' });
  await expect(card).toHaveClass(/\bline\b/);
  await expect(card.locator('.sub')).not.toHaveText(/^updated /); // a line says when it was last talked in, not a card's facts
});

test('files waiting with Shiori are listed on Trips: one opens, one is asked about (a chip in the type box), one is deleted', async ({ page }) => {
  await openApp(page);
  await writeRecords(page, 'sys:waiting', { text: { '/files/hotel.txt': 'Hotel Aurora Test, Nov 20–27', '/files/car.txt': 'Midnight Sun Rentals', '/files/note.txt': 'Not a booking' } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Waiting with Shiori' })).toBeVisible();
  const row = (/** @type {string} */ name) => page.locator('.waiting-file', { hasText: name });
  await row('hotel.txt').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'hotel.txt' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).first().click();
  await expect(page.getByRole('heading', { name: 'Waiting with Shiori' })).toBeVisible();
  await row('note.txt').getByRole('button', { name: 'Delete' }).click();
  await row('note.txt').getByRole('button', { name: 'Tap again to delete' }).click();
  await expect(page.getByText(/^Deleted note\.txt\./)).toBeVisible();
  await expect(row('note.txt')).toHaveCount(0);
  await row('car.txt').getByRole('button', { name: 'Ask Shiori about this' }).click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.type-sheet .attach-chip')).toHaveText(['car.txt×']);
  await expect(page.getByRole('button', { name: 'Remove car.txt' })).toBeVisible();
  await expect(page.getByLabel('Message to Shiori')).toBeFocused();
});

test("a Delete in Waiting with Shiori tapped once stays armed when home is drawn again: another file's Delete draws it again", async ({ page }) => {
  await openApp(page);
  await writeRecords(page, 'sys:waiting', { text: { '/files/hotel.txt': 'Hotel Aurora Test, Nov 20–27', '/files/note.txt': 'Not a booking' } });
  await page.reload();
  const row = (/** @type {string} */ name) => page.locator('.waiting-file', { hasText: name });
  await row('hotel.txt').getByRole('button', { name: 'Delete' }).click();
  await row('note.txt').getByRole('button', { name: 'Delete' }).click();
  await row('note.txt').getByRole('button', { name: 'Tap again to delete' }).click(); // deleted: home is drawn again
  await expect(row('note.txt')).toHaveCount(0);
  await expect(row('hotel.txt').getByRole('button', { name: 'Tap again to delete' })).toBeVisible(); // still armed: the next tap is the second
  await row('hotel.txt').getByRole('button', { name: 'Tap again to delete' }).click();
  await expect(page.getByText(/^Deleted hotel\.txt\./)).toBeVisible();
  await expect(row('hotel.txt')).toHaveCount(0);
});

test("a trip's card says when a file is waiting to be read", async ({ page }) => {
  await openApp(page);
  const trip = await startNamed(page, 'Kyoto', { start: '2026-12-01', end: '2026-12-05' }); // dated: a card, which says what waits to be read
  await writeRecords(page, trip, { text: { '/files/temple.txt': 'Temple tickets' } });
  await writeEvent(page, trip, { type: 'wake', data: { id: 'w-1', reasons: [{ kind: 'file', text: 'A file was moved here.', files: ['/files/temple.txt'] }] } });
  await page.goto('/#/trips');
  await expect(page.locator('.trip-card', { hasText: 'Kyoto' })).toContainText('1 file waiting to be read');
});

test('with a trip open, Trips has a way back to the conversation outside any trip', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('button', { name: /Shiori, no trip/ })).toHaveCount(0); // none open: the Conversation is that one already
  await startNamed(page, 'Kyoto');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await page.getByRole('button', { name: /Shiori, no trip/ }).click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.getByText(/No trip is open/)).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /Shiori, no trip/ })).toHaveCount(0);
});

test("the way back outside any trip that won't open says so, and Trips stays", async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await breakOpen(page);
  await page.getByRole('button', { name: /Shiori, no trip/ }).click();
  await expect(page.getByText("That conversation didn't open")).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
});

test("the folded dates keep their disclosure marker, and their tap is a phone's size", async ({ page }) => {
  await openApp(page);
  const summary = page.locator('details.dates summary');
  expect(await summary.evaluate((el) => getComputedStyle(el).display)).toBe('list-item');
  expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("a trip's Files: each file's short name and what it is; opening one; adding one by hand", async ({ page }) => {
  await openApp(page);
  const trip = await startNamed(page, 'Anchorage');
  await putFile(page, trip, '/files/flight.pdf', await readFile('test/fixtures/bookings/flight.pdf'), 'application/pdf');
  await putFile(page, trip, '/files/new.pdf', Buffer.from('%PDF-1.4 new'), 'application/pdf');
  await putFile(page, trip, '/files/view.png', PNG, 'image/png');
  await writeRecords(page, trip, { write: {
    '/bookings/flight.json': { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', unsure: [] },
    '/names.json': { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' },
  } });
  await page.reload();
  const files = page.getByRole('region', { name: 'Files', exact: true });
  await expect(files.locator('.trip-file')).toHaveCount(2); // the trip photo is among its photos, not here
  const flight = files.locator('.trip-file').first();
  await expect(flight.locator('.name')).toHaveText('ANNAI AIR flight · Nov 20');
  await expect(flight.locator('.became')).toHaveText('Flight');
  await expect(files.locator('.trip-file').nth(1)).toContainText('new.pdf');
  await expect(files.locator('.trip-file').nth(1).locator('.became')).toHaveText('Nothing yet');
  // One tap target: the row's single link opens the file's details.
  await expect(flight.getByRole('link')).toHaveAttribute('href', /\/booking\?path=/);
  // Adding one by hand.
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'ferry.txt', mimeType: 'text/plain', buffer: Buffer.from('Ferry TESTQ1 at 09:00') });
  await expect(files.locator('.trip-file', { hasText: 'ferry.txt' })).toBeVisible();
});

test('All files is folded below Files, and still has notes, memory, the raw records and the box that adds a file by path', async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Anchorage');
  const fold = page.locator('details.all-files');
  await expect(fold).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('File path')).toBeHidden();
  // Below Files.
  expect(await fold.evaluate((el) => Boolean(/** @type {Node} */ (document.querySelector('.trip-files')).compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await allFiles(page);
  await expect(page.getByRole('link', { name: /^\/trip\.json/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^\/memory\.md/ })).toBeVisible();
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Back to trip' }).click();
  // The fold stays open while annai runs.
  await expect(page.getByRole('link', { name: /^\/notes\/day1\.md/ })).toBeVisible();
});

// Timeline stage 3: each conversation has its own address, #/trip/<id>/talk, and only a move there opens it.
const hashOf = (/** @type {import('@playwright/test').Page} */ page) => new URL(page.url()).hash;
/** The conversation on screen. @param {import('@playwright/test').Page} page */
const convo = (page) => page.locator('main .screen:has(.convo)');
/** What Shiori said in a scope's log, as the page's store has it. @param {import('@playwright/test').Page} page @param {string} scope */
const herLines = (page, scope) => page.evaluate(async (scope) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const lines = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['out.speak'] }));
  store.close();
  return lines.map((/** @type {any} */ e) => String(e.data?.text ?? ''));
}, scope);
/** Counts the conversations opened from now on, as window.opens. @param {import('@playwright/test').Page} page */
const countOpens = (page) => page.evaluate(async () => {
  const { Halves } = await import(/** @type {string} */ ('/src/core/agent/halves.js'));
  const open = Halves.prototype.open;
  /** @type {any} */ (window).opens = [];
  Halves.prototype.open = function (/** @type {any[]} */ ...a) {
    /** @type {any} */ (window).opens.push(a[0]);
    return open.apply(this, a);
  };
});

test('Back from a conversation reached by #/talk goes to where you came from', async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await goToHash(page, '#/talk'); // a link to the plain address (the top bar's tabs go straight to the trip's own)
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
  await expect(page.getByRole('link', { name: 'Conversation', exact: true }).first()).toHaveAttribute('aria-current', 'page'); // its tab stays lit
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // #/plan the same way.
  await goToHash(page, '#/plan');
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/plan`);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/settings');
});

test('an address whose trip is gone goes home, and Back does not return to it', async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  for (const gone of ['#/trip/trip-gone1/talk', '#/trip/trip-gone1/plan', '#/trip/trip-gone1', '#/trip/me/talk']) {
    await goToHash(page, gone);
    await expect.poll(() => hashOf(page)).toBe('#/trips');
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await page.goBack();
    await expect.poll(() => hashOf(page)).toBe('#/settings');
  }
});

test('opening #/trip/<b>/talk with a turn running in a stops it; a redraw of a trip screen after Shiori moved on opens nothing', async ({ page }) => {
  const speak = anthropicToolReply([{ name: 'speak', input: { text: 'From the slow turn.' } }, { name: 'sleep', input: {} }]);
  const llm = await startModelServer({ '/b/v1/messages': { status: 200, type: 'text/event-stream', body: speak, delayMs: 4000 } });
  try {
    await modelSetUp(page, llm.origin, 'Kyoto');
    const a = decodeURIComponent(hashOf(page).split('/')[2]);
    await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
    const b = await startNamed(page, 'Osaka');
    await goToHash(page, `#/trip/${a}/talk`);
    await expect(convo(page)).toContainText('Kyoto');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Where is the temple?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0); // her turn is waiting on the model
    await countOpens(page);
    await goToHash(page, `#/trip/${b}/talk`);
    await expect(convo(page)).toContainText('Osaka');
    await page.waitForTimeout(5000); // past the model's reply
    expect(await herLines(page, a)).toEqual([]); // stopped: its reply wrote nothing
    expect(await page.evaluate(() => /** @type {any} */ (window).opens)).toEqual([b]);
    // Shiori moves the conversation to Kyoto (a hand-over's openWhenDone): the screen goes there, and nothing opens Osaka again.
    await catchAgent(page);
    await goToHash(page, `#/trip/${a}`);
    await goToHash(page, `#/trip/${b}/talk`);
    await expect(convo(page)).toContainText('Osaka');
    await page.evaluate(async () => { /** @type {any} */ (window).opens = []; });
    await page.evaluate((a) => /** @type {any} */ (window).agent.openWhenDone(a), a);
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${a}/talk`);
    await expect(convo(page)).toContainText('Kyoto');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => /** @type {any} */ (window).opens)).toEqual([a]); // hers only
    // The move replaced the old entry: Back goes to Kyoto's Details, not to Osaka's conversation.
    await page.goBack();
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${a}`);
  } finally {
    await llm.stop();
  }
});

test('a reload on #/trip/<id>/talk shows that conversation, not the last one active', async ({ page }) => {
  await openApp(page);
  const a = await startNamed(page, 'Kyoto');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const b = await startNamed(page, 'Osaka');
  await writeEvent(page, a, { type: 'out.speak', data: { id: 's1', text: 'A line in Kyoto.' } });
  await writeEvent(page, b, { type: 'out.speak', data: { id: 's2', text: 'A line in Osaka.' } });
  await goToHash(page, `#/trip/${a}`); // Kyoto is the active trip now
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
  await page.goto(`/#/trip/${b}/talk`);
  await page.reload();
  await expect(page.locator('.convo')).toContainText('A line in Osaka.');
  await expect(page.locator('.convo')).not.toContainText('A line in Kyoto.');
  expect(hashOf(page)).toBe(`#/trip/${b}/talk`);
});

// Timeline stage 3: Details is the trip's page: its name and dates change here; Recap and Replay once dated; what it has cost.
/** The trip's trip.json, as stored. @param {import('@playwright/test').Page} page @param {string} trip */
const tripJson = (page, trip) => page.evaluate(async (trip) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const store = await createIdbStore();
  const v = await new Workspace(store).readJSON(trip, '/trip.json');
  store.close();
  return v;
}, trip);

test('Details changes the name and the dates; a cleared date goes, a backward range and a blank name say why', async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const form = page.locator('form.trip-edit');
  await form.getByLabel('Name', { exact: true }).fill('Kyoto in spring');
  await form.getByLabel('Starts').fill('2027-04-01');
  await form.getByLabel('Ends').fill('2027-04-05');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto in spring' })).toBeVisible();
  expect(await tripJson(page, id)).toMatchObject({ title: 'Kyoto in spring', start: '2027-04-01', end: '2027-04-05' });
  // A cleared date goes from the file: a blank is never written (the schema refuses '').
  await form.getByLabel('Ends').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => 'end' in (await tripJson(page, id))).toBe(false);
  expect((await tripJson(page, id)).start).toBe('2027-04-01');
  // Backward: said, and nothing is written. (The form holds its fields while it saves, so this fill waits for the form drawn again.)
  await form.getByLabel('Ends').fill('2027-03-30');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert')).toHaveText("The trip can't end before it starts.");
  expect('end' in (await tripJson(page, id))).toBe(false);
  // A blank name: said, and nothing is written.
  await form.getByLabel('Ends').fill('');
  await form.getByLabel('Name', { exact: true }).fill('  ');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert')).toHaveText('Give the trip a name.');
  expect((await tripJson(page, id)).title).toBe('Kyoto in spring');
  // Both dates cleared: an undated trip again.
  await form.getByLabel('Name', { exact: true }).fill('Kyoto in spring');
  await form.getByLabel('Starts').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => 'start' in (await tripJson(page, id))).toBe(false);
  // Shown on Trips by its new name.
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.locator('.trip-card', { hasText: 'Kyoto in spring' })).toBeVisible();
});

test('Recap and Replay show once dated', async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await expect(page.getByRole('main').getByRole('link', { name: 'Itinerary', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Recap', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: 'Replay', exact: true })).toHaveCount(0);
  const form = page.locator('form.trip-edit');
  await form.getByLabel('Starts').fill('2027-04-01');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('main').getByRole('link', { name: 'Recap', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Replay', exact: true })).toBeVisible();
});

test('an undated trip with a recap shows Recap, and never Replay; one with neither shows neither', async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const link = (/** @type {string} */ name) => page.getByRole('main').getByRole('link', { name, exact: true });
  await expect(link('Itinerary')).toBeVisible();
  await expect(link('Recap')).toHaveCount(0); // undated, no recap
  await expect(link('Replay')).toHaveCount(0);
  await writeRecords(page, id, { text: { '/recap.md': '# Kyoto\nTea.' } });
  await page.reload();
  await expect(link('Recap')).toBeVisible(); // undated, with its recap
  await expect(link('Replay')).toHaveCount(0);
  await expect(link('Recap')).toHaveAttribute('href', `#/trip/${id}/recap`);
});

test('Details shows what the trip has cost', async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await writeEvent(page, id, { type: 'model.turn', data: { cost: 0.42 } });
  await page.reload();
  await expect(page.getByRole('main')).toContainText('This trip so far: $0.42');
});

test('the crumb goes back to the conversation', async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const crumb = page.getByRole('main').locator('.crumbs a');
  await expect(crumb).toContainText('Conversation');
  await crumb.click();
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
});

test('a tab tapped again on its own screen adds nothing for Back to show again', async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto'); // on its Details
  const tab = (/** @type {string} */ name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
  for (const [name, sub] of [['Conversation', 'talk'], ['Itinerary', 'plan']]) {
    await tab(name).click();
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/${sub}`);
    await tab(name).click();
    await page.waitForTimeout(300);
    await page.goBack();
    await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}`);
  }
});

test("Save in Details writes only what was changed there, so dates Shiori wrote meanwhile stay", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto'); // Details, undated
  await writeRecords(page, id, { patch: { '/trip.json': { start: '2027-04-01', end: '2027-04-05' } } }); // her patch, with Details still drawn
  const form = page.locator('form.trip-edit');
  await form.getByLabel('Name', { exact: true }).fill('Kyoto in spring');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto in spring' })).toBeVisible();
  expect(await tripJson(page, id)).toMatchObject({ title: 'Kyoto in spring', start: '2027-04-01', end: '2027-04-05' });
  // And the other way: a date changed here leaves a name she wrote.
  await writeRecords(page, id, { patch: { '/trip.json': { title: 'Kyoto and Nara' } } });
  await form.getByLabel('Ends').fill('2027-04-06');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await tripJson(page, id)).end).toBe('2027-04-06');
  expect((await tripJson(page, id)).title).toBe('Kyoto and Nara');
});

test("Details' Save doesn't write a backward range when the dates changed since it was drawn", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const form = page.locator('form.trip-edit');
  await form.getByLabel('Starts').fill('2027-06-15'); // only Starts, on an undated trip; the focus keeps the screen from being drawn again
  await writeRecords(page, id, { patch: { '/trip.json': { start: '2027-06-10', end: '2027-06-12' } } }); // Shiori dated the trip meanwhile
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert')).toHaveText("The trip can't end before it starts.");
  expect(await tripJson(page, id)).toMatchObject({ start: '2027-06-10', end: '2027-06-12' });
  await expect(form.getByLabel('Starts')).toBeEditable(); // let go again, to be put right
});

// Back and Forward over a removed trip's entries (timeline stage 3 fix pass): they go on to the screen on the other side, never
// stopping on Trips once for each entry. The shell numbers its history entries (history.state.annaiIdx); the tests wait on that number.
/** Which entry of the shell's history this is. @param {import('@playwright/test').Page} page */
const idxOf = (page) => page.evaluate(() => history.state?.annaiIdx ?? null);
/** Whether Forward goes anywhere (a hash-only move gives Playwright no response to tell by). @param {import('@playwright/test').Page} page */
const forwardMoves = (page) => page.evaluate(() => new Promise((resolve) => {
  addEventListener('popstate', () => resolve(true), { once: true });
  history.forward();
  setTimeout(() => resolve(false), 400);
}));
/** Whether Back stays in annai: false when it leaves for what came before annai in the tab. @param {import('@playwright/test').Page} page */
async function backStays(page) {
  await page.goBack();
  return page.url().startsWith('http://127.0.0.1:8790/');
}
/** On a trip's Details: Remove trip, asked and asked again. @param {import('@playwright/test').Page} page @param {string} title */
async function removeFromDetails(page, title) {
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Remove' }).click();
}
/** Settings, then Trips, a trip started and opened, its conversation, its name (Details again), then Remove trip: the app is on Trips. @returns {Promise<string>} the trip's id */
async function removedAfterVisits(/** @type {import('@playwright/test').Page} */ page) {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const id = await startNamed(page, 'Kyoto'); // its Details
  await page.getByRole('main').locator('.crumbs a').click(); // its conversation
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
  await page.locator('.talk-head .talk-name').click(); // its Details again
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}`);
  await removeFromDetails(page, 'Kyoto');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect.poll(() => hashOf(page)).toBe('#/trips');
  return id;
}

test("Remove trip leaves the way Back does: one Back shows the screen before the trip, and Forward shows Trips once, then nothing", async ({ page }) => {
  await removedAfterVisits(page);
  expect(await idxOf(page)).toBe(2); // Trips, Settings, then Trips pushed from Settings: the trip's entries and the Trips before it are gone
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await idxOf(page)).toBe(1);
  await page.goForward();
  await expect.poll(() => idxOf(page)).toBe(2);
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await forwardMoves(page)).toBe(false); // nothing is left ahead
});

test("Remove trip from a fresh start puts Trips at the first entry, with nothing behind it", async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await removeFromDetails(page, 'Kyoto');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect.poll(() => idxOf(page)).toBe(0);
  expect(await backStays(page)).toBe(false); // Back leaves annai: the tab's first entry is Trips
});

test("Remove trip after a start that resumed into the trip's conversation puts Trips at the first entry", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await page.evaluate(async (id) => { // the welcome has been seen, and the conversation is the screen that was open
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { updateAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { welcomedAt: Date.now() });
    store.close();
    localStorage.setItem('annai.resume', JSON.stringify({ hash: `#/trip/${id}/talk`, trip: id }));
  }, id);
  await page.goto('/'); // a new launch: it resumes into the conversation, the first entry
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await goToHash(page, `#/trip/${id}`);
  await removeFromDetails(page, 'Kyoto');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect.poll(() => idxOf(page)).toBe(0);
});

test("Remove trip on the first entry of the history shows Trips there, and goes nowhere", async ({ page, context }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await page.close(); // annai runs in one tab at a time
  const second = await context.newPage();
  await second.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await second.goto(`/#/trip/${id}`); // the trip's Details is the first entry
  await expect(second.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
  await removeFromDetails(second, 'Kyoto');
  await expect(second.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect.poll(() => hashOf(second)).toBe('#/trips');
  expect(await idxOf(second)).toBe(0);
  expect(second.url().startsWith('http://127.0.0.1:8790/')).toBe(true); // still annai
});

/** Marks the screen drawn now, so a later check can tell whether it was drawn again. @param {import('@playwright/test').Page} page */
const mark = (page) => page.evaluate(() => { document.querySelector('main .screen')?.setAttribute('data-drawn-once', 'yes'); });
/** Whether the screen is the one marked, and nothing newer replaced it. @param {import('@playwright/test').Page} page */
const stillMarked = (page) => page.locator('main .screen[data-drawn-once=yes]').count().then((n) => n === 1);

/** Marks Trips once it is drawn: the walk's number reads 0 a moment before its one drawing of Trips lands. @param {import('@playwright/test').Page} page */
const markTrips = async (page) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await mark(page);
};

test("Forward with nothing new ahead does nothing: after Remove trip from a fresh start, Trips stays the one drawn", async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await removeFromDetails(page, 'Kyoto');
  await expect.poll(() => idxOf(page)).toBe(0);
  await markTrips(page);
  await page.goForward(); // the removed trip's entry is ahead: nothing to show
  await page.waitForTimeout(500);
  expect(await idxOf(page)).toBe(0);
  expect(hashOf(page)).toBe('#/trips');
  expect(await stillMarked(page)).toBe(true);
});

/**
 * Holds the store's trip records for ms, as a slow phone's storage would, so a draw begun now is still in flight when the next move comes;
 * then two Forwards, gap ms apart. @param {import('@playwright/test').Page} page
 */
const forwardTwiceInOneDraw = (page, ms = 300, gap = 30) => page.evaluate(async ({ ms, gap }) => {
  const db = await new Promise((r) => { const q = indexedDB.open('annai'); q.onsuccess = () => r(q.result); });
  const scopes = /** @type {IDBDatabase} */ (db).transaction(['scopes'], 'readwrite').objectStore('scopes');
  const until = performance.now() + ms;
  const spin = () => { if (performance.now() < until) scopes.count().onsuccess = spin; };
  spin();
  history.forward();
  setTimeout(() => history.forward(), gap);
}, { ms, gap });

test("two Forwards inside Trips' draw, over a removed trip's entry at the end: Trips is drawn under its own address, not the screen before it", async ({ page }) => {
  await openApp(page, '#/settings');
  await goToHash(page, '#/trips');
  const id = await startNamed(page, 'Kyoto'); // Settings 0, Trips 1, Kyoto 2
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await removeBehind(page, id);
  await forwardTwiceInOneDraw(page); // the second lands on Kyoto's entry while Trips draws: back to Trips, which must still be drawn
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.waitForTimeout(500);
  expect([hashOf(page), await idxOf(page)]).toEqual(['#/trips', 1]);
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
});

test("two Forwards from Trips inside a trip's draw, over a removed trip's entry at the end: that trip is drawn under its own address, not Trips", async ({ page }) => {
  await openApp(page);
  const nara = await startNamed(page, 'Nara');
  await goToHash(page, '#/trips');
  const kyoto = await startNamed(page, 'Kyoto'); // Trips 0, Nara 1, Trips 2, Kyoto 3
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Nara' })).toBeVisible();
  await goToHash(page, `#/trip/${kyoto}`); // Trips 0, Nara 1, Kyoto 2: cuts the rest off
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Nara' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect.poll(() => idxOf(page)).toBe(0);
  await removeBehind(page, kyoto);
  await forwardTwiceInOneDraw(page); // the second lands on Kyoto's entry while Nara draws: back to Nara, which must still be drawn
  await expect(page.getByRole('heading', { level: 1, name: 'Nara' })).toBeVisible();
  await page.waitForTimeout(500);
  expect([hashOf(page), await idxOf(page)]).toEqual([`#/trip/${nara}`, 1]);
  await expect(page.getByRole('heading', { level: 1, name: 'Nara' })).toBeVisible();
});

test("Forward after Remove trip from a resumed start does nothing, twice", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await page.evaluate(async (id) => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { updateAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { welcomedAt: Date.now() });
    store.close();
    localStorage.setItem('annai.resume', JSON.stringify({ hash: `#/trip/${id}/talk`, trip: id }));
  }, id);
  await page.goto('/');
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await goToHash(page, `#/trip/${id}`);
  await removeFromDetails(page, 'Kyoto');
  await expect.poll(() => idxOf(page)).toBe(0);
  await markTrips(page);
  for (let i = 0; i < 2; i++) {
    await page.goForward();
    await page.waitForTimeout(500);
    expect(hashOf(page)).toBe('#/trips');
    expect(await stillMarked(page), `Forward ${i + 1}`).toBe(true);
  }
});

test("Forward over a trip removed some other way ends on the Trips it began on, and draws nothing new", async ({ page }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const id = await startNamed(page, 'Kyoto'); // Trips, Settings, Trips, Details
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await removeBehind(page, id);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/settings');
  await page.goForward(); // the Trips before the trip
  await expect.poll(() => idxOf(page)).toBe(2);
  await markTrips(page);
  await page.goForward(); // the trip's entry, then the Trips after it: the screen it left
  await page.waitForTimeout(500);
  expect(await idxOf(page)).toBe(2);
  expect(hashOf(page)).toBe('#/trips');
  expect(await stillMarked(page)).toBe(true);
});

test("Forward after the photo viewer is closed does nothing: its entry is passed, and nothing is drawn again", async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  const screen = await viewerOverFile(page);
  await page.goBack(); // closes the viewer: its entry waits ahead
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await expect.poll(() => idxOf(page)).toBe(screen);
  await mark(page);
  await page.goForward();
  await page.waitForTimeout(500);
  expect(await idxOf(page)).toBe(screen);
  expect(await stillMarked(page)).toBe(true);
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
});

test("Forward after the photo viewer is closed does nothing, also when a screen was visited ahead of its file before it opened", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const screen = await viewerOverFile(page);
  await page.goBack(); // closes the viewer
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await goToHash(page, '#/settings'); // a screen ahead of the file
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: 'Open the photo full size' }).click(); // its entry cuts Settings off
  await expect(page.getByRole('dialog', { name: /^Photo / })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await expect.poll(() => idxOf(page)).toBe(screen);
  await page.goForward(); // only the closed viewer's entry is ahead
  await expect.poll(() => idxOf(page)).toBe(screen);
  await page.goBack(); // a different screen, not the file again
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}`);
});

test("after a Forward that does nothing, Trips drawn again keeps its place", async ({ page }) => {
  await openApp(page);
  await writeRecords(page, 'sys:waiting', { text: Object.fromEntries([...Array(8).keys()].map((i) => [`/files/note-${i}.txt`, `note ${i}`])) });
  await startNamed(page, 'Kyoto');
  await removeFromDetails(page, 'Kyoto');
  await markTrips(page);
  await page.goForward(); // the removed trip's entry is ahead: nothing to show
  await page.waitForTimeout(500);
  expect(await stillMarked(page)).toBe(true);
  await page.locator('.waiting-file .two-step').last().scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  expect(y).toBeGreaterThan(200);
  await page.locator('.waiting-file .two-step').last().click();
  await page.locator('.waiting-file .two-step').last().click(); // Tap again to delete: Trips is drawn again
  await expect(page.locator('.waiting-file')).toHaveCount(7);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(y - 120); // not back where it was at the Forward
});

test("a reload while the photo viewer is open shows its file, and Back then goes on to the screen before", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const screen = await viewerOverFile(page);
  await page.reload(); // as an iPhone reloads an app it set aside
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await expect.poll(() => idxOf(page)).toBe(screen);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}`);
});

test("a reload while the photo viewer is open, after the screen ahead of its file was cut off: Forward does nothing, and Back goes on to the screen before", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  const screen = await viewerOverFile(page);
  await page.goBack(); // closes the viewer
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await goToHash(page, '#/settings'); // a screen ahead of the file
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: 'Open the photo full size' }).click(); // its entry cuts Settings off
  await expect(page.getByRole('dialog', { name: /^Photo / })).toBeVisible();
  await page.reload(); // as an iPhone reloads an app it set aside
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
  await expect.poll(() => idxOf(page)).toBe(screen);
  await page.goForward(); // only the closed viewer's entry is ahead
  await expect.poll(() => idxOf(page)).toBe(screen);
  await page.goBack(); // a different screen, not the file again
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}`);
});

test("Back past the entry a photo viewer left behind lands on its screen once, not twice", async ({ page }) => {
  await openApp(page);
  const nara = await startNamed(page, 'Nara');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const kyoto = await startNamed(page, 'Kyoto');
  const screen = await viewerOverFile(page);
  await page.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'annai.open', scope: id } })), nara);
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${nara}/talk`);
  await expect(convo(page)).toBeVisible(); // drawn: a Back inside the few ms before it is drawn is not one a person makes
  await page.goBack(); // over the viewer's entry, which nothing is open over now
  await expect.poll(() => idxOf(page)).toBe(screen);
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await page.goForward(); // over the viewer's entry again, on to Nara's conversation
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${nara}/talk`);
  await expect(convo(page)).toBeVisible();
  await page.goBack();
  await expect.poll(() => idxOf(page)).toBe(screen);
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
  await page.goBack(); // a different screen, not the file again
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${kyoto}`);
});

test("Back after Remove trip shows the screen before where it was left, not where Details was", async ({ page }) => {
  await openApp(page);
  await goToHash(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 120));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(120);
  await goToHash(page, '#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await startNamed(page, 'Kyoto');
  await page.getByRole('button', { name: 'Remove trip' }).scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 400));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(200); // Details is further down than Settings was
  await removeFromDetails(page, 'Kyoto');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(120);
});

test("a screen the user goes to while Remove trip runs is kept: the removal doesn't take them back", async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(page.getByRole('dialog', { name: 'Kyoto' })).toBeVisible();
  // "Remove", and in the same moment a tap on Settings: the removal ends after it.
  await page.evaluate(() => {
    /** @type {HTMLButtonElement} */ ([...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Remove')).click();
    /** @type {HTMLAnchorElement} */ (document.querySelector('nav.topnav a[href="#/settings"]')).click();
  });
  await expect(page.getByText(/^Removed Kyoto\./)).toBeVisible();
  await page.evaluate(() => new Promise((done) => setTimeout(done, 400))); // a walk back would be under way by now
  expect(hashOf(page)).toBe('#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test("Remove trip goes back over the Trips between, to the screen of the other trip before it", async ({ page }) => {
  await openApp(page);
  const a = await startNamed(page, 'Osaka'); // Trips, Osaka's Details
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const x = await startNamed(page, 'Kyoto'); // Trips again, Kyoto's Details
  await removeFromDetails(page, 'Kyoto');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(x).not.toBe(a);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${a}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Osaka' })).toBeVisible();
});

test("Back over a removed trip's entries also passes the Trips it left, which would show Trips again", async ({ page }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const id = await startNamed(page, 'Kyoto'); // Trips, Settings, Trips, Details
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await removeBehind(page, id);
  expect(await idxOf(page)).toBe(4);
  await page.goBack(); // Details (gone) and the Trips before it are passed
  await expect.poll(() => hashOf(page)).toBe('#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await idxOf(page)).toBe(1);
});

test("a removed trip's entry that is the newest, reached by Forward from another screen, becomes Trips: the screen is never blank", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto'); // Trips, then its Details
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await goToHash(page, `#/trip/${id}`); // Settings, then Details again: the newest entry
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}`);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/settings');
  const at = await idxOf(page);
  await removeBehind(page, id); // removed some other way than the button: its Details entry waits ahead
  await page.goForward();
  await expect.poll(() => hashOf(page)).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await idxOf(page)).toBe(/** @type {number} */ (at) + 1); // in the entry's place
});

test("a removed trip's entry that is the first, reached by Back, becomes Trips: Back never leaves annai from a blank screen", async ({ page, context }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await page.close(); // annai runs in one tab at a time
  const second = await context.newPage();
  await second.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await second.goto(`/#/trip/${id}`); // the trip's Details is the first entry
  await expect(second.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
  await second.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(second.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await second.evaluate(async (id) => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { removeTrip } = await import(/** @type {string} */ ('/src/core/scopes.js'));
    const store = await createIdbStore();
    await removeTrip(store, id);
    store.close();
  }, id);
  await second.goBack();
  await expect.poll(() => hashOf(second)).toBe('#/trips');
  await expect(second.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await idxOf(second)).toBe(0); // in the entry's place
});

test("a trip screen whose trip can't be read says what failed", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await page.evaluate((id) => { // the trip's record can't be read, as when WebKit loses its IndexedDB connection
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (/** @type {any} */ k) {
      if (this.name === 'scopes' && k === id) throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
      return get.call(this, k);
    };
  }, id);
  for (const to of [`#/trip/${id}`, `#/trip/${id}/talk`, `#/trip/${id}/recap`]) {
    await goToHash(page, '#/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await goToHash(page, to);
    await expect(page.getByRole('heading', { level: 1, name: "This screen couldn't open" })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Connection to Indexed Database server lost');
    expect(hashOf(page)).toBe(to); // not taken for gone
  }
});

test("a removed trip's address as the first entry is replaced by Trips, and keeps its place", async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await page.goto('/#/trip/trip-gone1/talk');
  await expect.poll(() => hashOf(page)).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await idxOf(page)).toBe(0);
});

/** Removes a trip some other way than its button, as an Undo or a second window does. @param {import('@playwright/test').Page} page @param {string} id */
const removeBehind = (page, id) => page.evaluate(async (id) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { removeTrip } = await import(/** @type {string} */ ('/src/core/scopes.js'));
  const store = await createIdbStore();
  await removeTrip(store, id);
  store.close();
}, id);
/** Every address that names a trip, as a link, a bookmark or the history can hold it. @param {string} id */
const addressesOf = (id) => [`#/trip/${id}`, `#/trip/${id}/talk`, `#/trip/${id}/plan`, `#/trip/${id}/file?path=%2Ftrip.json`, `#/trip/${id}/booking?path=%2Fbookings%2Fa.json`,
  `#/trip/${id}/item?path=%2Fplan%2Fa.json`, `#/trip/${id}/recap`, `#/trip/${id}/replay`, `#/trip/${id}/ext/some-plugin/some-tab`];

test("a removed trip's file, booking, item, Recap, Replay and plugin-tab entries are passed over by Back, and drawn by none", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto'); // Trips, then its Details
  for (const to of addressesOf(id)) {
    await goToHash(page, to);
    await expect.poll(() => hashOf(page)).toBe(to);
  }
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await removeBehind(page, id);
  await page.goBack();
  await expect.poll(() => idxOf(page)).toBe(0); // Trips, the first entry: nothing of the trip stopped it
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(page.getByText("This trip isn't on this device")).toHaveCount(0);
});

test("a link to a removed trip's file, booking, item, Recap, Replay or plugin tab goes to Trips in its place, saying nothing else", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await removeBehind(page, id);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  for (const to of addressesOf(id).slice(3)) {
    const at = await idxOf(page);
    await goToHash(page, to);
    await expect.poll(() => hashOf(page), to).toBe('#/trips');
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await expect(page.getByText("This trip isn't on this device")).toHaveCount(0);
    expect(await idxOf(page)).toBe(at + 1); // a new entry, drawn as Trips: it is not a second one
    await page.goBack();
    await expect.poll(() => hashOf(page)).toBe('#/settings');
  }
});

// An entry that other code pushes over a screen (the photo viewer; on an iPhone, a question) carries a number between its screen's and the
// next, and its screen's key, so Back over a removed trip's entries places it like the shell's own.
/** The photo viewer open over a file of the trip being looked at. Returns the file screen's entry number. @param {import('@playwright/test').Page} page */
async function viewerOverFile(page) {
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await allFiles(page);
  await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
  const screen = /** @type {number} */ (await idxOf(page));
  await page.getByRole('button', { name: 'Open the photo full size' }).click();
  await expect(page.getByRole('dialog', { name: /^Photo / })).toBeVisible();
  return screen;
}

test("Back after a trip is removed passes the entry its photo viewer left behind, and lands past the trip's entries", async ({ page }) => {
  await openApp(page);
  const nara = await startNamed(page, 'Nara'); // Trips, Nara's Details
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const kyoto = await startNamed(page, 'Kyoto'); // Trips again, Kyoto's Details
  const screen = await viewerOverFile(page); // Kyoto's file, and over it the viewer
  expect(await idxOf(page)).toBe(screen + 0.5); // between the file's entry and the next
  // A tapped reminder of Nara (the worker's message) opens Nara's conversation while the viewer is open: its entry stays behind.
  await page.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'annai.open', scope: id } })), nara);
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${nara}/talk`);
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await goToHash(page, `#/trip/${kyoto}`); // its row opens its conversation (timeline stage 4): Details by address, as a link would
  await removeFromDetails(page, 'Kyoto');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/settings');
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${nara}/talk`);
  const naraAt = await idxOf(page);
  await page.goBack(); // over the viewer's entry, Kyoto's file and Kyoto's Details: to the Trips before them
  await expect.poll(() => hashOf(page)).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await idxOf(page)).toBeLessThan(screen);
  expect(naraAt).toBeGreaterThan(screen);
});

test("Back closes the photo viewer without drawing its screen again", async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  const screen = await viewerOverFile(page);
  await page.evaluate(() => { document.querySelector('main .screen')?.setAttribute('data-drawn-once', 'yes'); });
  await page.goBack();
  await expect(page.getByRole('dialog', { name: /^Photo / })).toHaveCount(0);
  expect(await idxOf(page)).toBe(screen);
  await expect(page.locator('main .screen[data-drawn-once=yes]')).toHaveCount(1); // the same drawing
});

test("a question that pushes its own history entry carries a number between its screen's and the next", async ({ page }) => {
  await page.addInitScript(() => { delete /** @type {any} */ (window).CloseWatcher; }); // as on an iPhone: no CloseWatcher, so the question takes an entry
  await openApp(page);
  await startNamed(page, 'Kyoto');
  const screen = /** @type {number} */ (await idxOf(page));
  const key = await page.evaluate(() => history.state.annaiScroll);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kyoto' });
  await expect(dialog).toBeVisible();
  const state = await page.evaluate(() => history.state);
  expect(state.annaiAsk).toBeTruthy();
  expect(state.annaiIdx).toBe(screen + 0.5);
  expect(state.annaiScroll).toBe(key);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => idxOf(page)).toBe(screen); // its entry is taken back
});

// A reminder tapped while annai is open: the service worker says which trip (sw.js checks it is a trip's strict id); the page opens
// whatever string it is given safely, as an address that names no trip goes home.
test("a tapped reminder shows its trip's conversation; a hostile scope posted to the page opens nothing but Trips", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  /** @param {unknown} scope */
  const tapped = (scope) => page.evaluate((scope) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'annai.open', scope } })), scope);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.evaluate(() => { /** @type {any} */ (window).sameDocument = true; });
  await tapped(id);
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
  for (const scope of ['me', 'sys:waiting', 'trip-gone1', 'trip-../x', 'TRIP-A', 'trip-a/../..', 'trip-a?x=1', 'trip-a#/settings', '#/settings', '../..', '']) {
    await goToHash(page, '#/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await tapped(scope);
    await expect.poll(() => hashOf(page), scope).toBe('#/trips');
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  }
  // Anything that isn't a string is ignored.
  await goToHash(page, '#/settings');
  for (const scope of [7, null, { a: 1 }]) await tapped(scope);
  await page.waitForTimeout(300);
  expect(await hashOf(page)).toBe('#/settings');
  expect(await page.evaluate(() => /** @type {any} */ (window).sameDocument)).toBe(true); // nothing navigated away
});

test("a reminder tapped while annai's code is still loading isn't lost: the page listens from boot.js's first line", async ({ page }) => {
  await openApp(page);
  const id = await startNamed(page, 'Kyoto');
  await goToHash(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.addInitScript((id) => {
    /** @type {any} */ const w = window;
    w.listeners = 0;
    const add = ServiceWorkerContainer.prototype.addEventListener;
    ServiceWorkerContainer.prototype.addEventListener = function (/** @type {any} */ type, /** @type {any[]} */ ...a) { if (type === 'message') w.listeners++; return add.call(this, type, .../** @type {[any]} */ (a)); };
    // The worker's messages start with DOMContentLoaded, which does not wait for main.js (boot.js imports it after its language step).
    document.addEventListener('DOMContentLoaded', () => {
      w.listenersWhenTapped = w.listeners;
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'annai.open', scope: id } }));
    });
  }, id);
  await page.reload();
  await expect.poll(() => hashOf(page)).toBe(`#/trip/${id}/talk`);
  expect(await page.evaluate(() => /** @type {any} */ (window).listenersWhenTapped)).toBe(1); // only boot.js's was there: main.js had not listened yet
});

test("annai listens for a tapped reminder before it opens its storage, so a tap while the window is starting isn't lost", async ({ page }) => {
  await page.addInitScript(() => {
    /** @type {string[]} */
    const order = [];
    /** @type {any} */ (window).startOrder = order;
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (/** @type {any[]} */ ...a) { order.push('storage'); return open.apply(this, /** @type {any} */ (a)); };
    const add = ServiceWorkerContainer.prototype.addEventListener;
    ServiceWorkerContainer.prototype.addEventListener = function (/** @type {any} */ type, /** @type {any[]} */ ...a) { if (type === 'message') order.push('tap'); return add.call(this, type, .../** @type {[any]} */ (a)); };
  });
  await openApp(page);
  const order = await page.evaluate(() => /** @type {any} */ (window).startOrder);
  expect(order.indexOf('tap')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('tap')).toBeLessThan(order.indexOf('storage'));
});

test('Details holds its fields while it saves, so nothing typed then is drawn over; the form drawn again takes typing', async ({ page }) => {
  await openApp(page);
  await startNamed(page, 'Kyoto');
  await page.locator('form.trip-edit').getByLabel('Name', { exact: true }).fill('Kyoto in spring');
  // The tap and a look in the same moment: the submit runs up to its first wait at once.
  const held = await page.evaluate(() => {
    /** @type {HTMLButtonElement} */ (document.querySelector('form.trip-edit button[type=submit]')).click();
    return ['trip-edit-title', 'trip-edit-start', 'trip-edit-end'].map((i) => /** @type {HTMLInputElement} */ (document.getElementById(i)).readOnly);
  });
  expect(held).toEqual([true, true, true]);
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto in spring' })).toBeVisible();
  const ends = page.locator('form.trip-edit').getByLabel('Ends');
  await expect(ends).toBeEditable();
  await ends.fill('2027-04-06');
  await expect(ends).toHaveValue('2027-04-06');
});

test("annai opened again in the same tab, then Back into the older load and Forward over a trip removed meanwhile: the older load's numbers don't leave a screen under the trip's address", async ({ page }) => {
  await openApp(page, '#/settings'); // the first load: Settings, About, Trips
  await page.evaluate(() => { location.hash = '#/about'; });
  await expect.poll(() => idxOf(page)).toBe(1);
  await page.evaluate(() => { location.hash = '#/trips'; });
  await expect.poll(() => idxOf(page)).toBe(2);
  await page.goto('/index.html#/trips'); // opened again, by an address (a new page: the same address would only be a fragment move): Trips, then the trip
  await expect.poll(() => idxOf(page)).toBe(0);
  const id = await startNamed(page, 'Kyoto');
  await expect.poll(() => idxOf(page)).toBe(1);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe('#/trips');
  await page.goBack(); // into the first load's newest entry
  await expect.poll(() => hashOf(page)).toBe('#/trips');
  await expect.poll(() => idxOf(page)).toBe(2);
  // Each load drawn again from the start, as a phone does with a page it set aside (a browser's back-forward cache would keep each one's own
  // number in memory and hide the mix-up): the first load keeps its newest number for the tab, and the second reads it.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goForward(); // the second load's Trips
  await expect.poll(() => idxOf(page)).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await removeBehind(page, id);
  await markTrips(page);
  await page.goForward(); // the trip's entry, the newest of its load: Trips stays, under its own address
  await page.waitForTimeout(500);
  expect(hashOf(page)).toBe('#/trips');
  expect(await idxOf(page)).toBe(0);
  expect(await stillMarked(page)).toBe(true);
});
