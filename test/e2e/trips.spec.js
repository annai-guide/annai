import { test, expect } from '@playwright/test';
import { openApp, buildAndSave, writeEvent, writeRecords, startTrip as startNamed } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByText('Add dates (optional)').click();
  await page.getByLabel('Starts').fill('2026-11-25');
  await page.getByLabel('Ends').fill('2026-11-29');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('create a trip, edit a note, and restore an earlier version', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur · Thanksgiving');
  await expect(page.getByRole('link', { name: /\/trip\.json/ })).toBeVisible();
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
  await openApp(page, '#/trip/me/file?path=%2Fprofile.md');
  await expect(page.getByRole('heading', { name: "This trip isn't on this device" })).toBeVisible();
});

test('a trip card says when the trip was last backed up, and when it changed since', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const card = page.getByRole('link', { name: /Big Sur/ });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(card).toContainText('not backed up');
  await card.click();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(card).toContainText('backed up just now');
  await expect(card).not.toContainText('changed since');
  await card.click();
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

test('remove a trip: asks once, and again only when it changed after its last Backup', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
  expect(await storedImages(page)).toBe(1);

  // Escape is a no.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(page.getByRole('dialog', { name: 'Big Sur' })).toContainText('This removes everything in this trip from this device');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Never backed up: a second question, and Cancel keeps the trip.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  const warning = page.getByRole('dialog', { name: 'Not backed up' });
  await expect(warning).toContainText("This trip hasn't been backed up since it last changed. Remove it anyway?");
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

  // Backed up and unchanged: one question, then the trip and its photo are gone.
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText(/^Removed Big Sur\. .+ freed\.$/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(0);
  expect(await storedImages(page)).toBe(0);
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
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
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
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
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
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
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
  await card.click();
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
  await page.getByRole('link', { name: /Big Sur on Highway 1/ }).click();
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

  // Two questions in a row, then the answer moves to Trips and stays there.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await question.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
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
  await page.getByRole('link', { name: 'Plan', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('annai.resume'))).toContain('#/plan'); // drawn, and noted
  await page.goto('/'); // a new launch from the Home Screen icon
  await expect.poll(() => page.url()).toMatch(/#\/plan$/);
  // A link that points at a screen is respected.
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // The trip's own page, then gone: removed, with the screen still noted as it was.
  await page.goto(`/#/trip/${id}`);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.evaluate((id) => localStorage.setItem('annai.resume', JSON.stringify({ hash: `#/trip/${id}/plan`, trip: id })), id);
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(page.url()).not.toContain('/trip/');
});

test('Start a trip needs only a name: the trip opens with no dates, and its card says none', async ({ page }) => {
  await openApp(page);
  await expect(page.getByLabel('Starts')).toBeHidden(); // folded under Add dates (optional)
  await startNamed(page, 'Somewhere north');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Trips', exact: true })).toBeVisible();
  const card = page.locator('.trip-card', { hasText: 'Somewhere north' });
  await expect(card.locator('.sub')).toHaveText(/^updated /);
});

test('files waiting with Shiori are listed on Trips: one opens, one is asked about (a chip in the type box), one is deleted', async ({ page }) => {
  await openApp(page);
  await writeRecords(page, 'sys:waiting', { text: { '/files/hotel.txt': 'Hotel Aurora Test, Nov 20–27', '/files/car.txt': 'Midnight Sun Rentals', '/files/note.txt': 'Not a booking' } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Waiting with Shiori' })).toBeVisible();
  const row = (/** @type {string} */ name) => page.locator('.waiting-file', { hasText: name });
  await row('hotel.txt').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'hotel.txt' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips' }).first().click();
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

test("a trip's card says when a file is waiting to be read", async ({ page }) => {
  await openApp(page);
  const trip = await startNamed(page, 'Kyoto');
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

test("the folded dates keep their disclosure marker, and their tap is a phone's size", async ({ page }) => {
  await openApp(page);
  const summary = page.locator('details.dates summary');
  expect(await summary.evaluate((el) => getComputedStyle(el).display)).toBe('list-item');
  expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});
