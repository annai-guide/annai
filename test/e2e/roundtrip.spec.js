import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, buildAndSave, leaveSaved, pastWelcome, allFiles, startTrip, goHome, goToHash, startModelServer, addProvider, anthropicToolReply, waitForServiceWorker } from './helpers.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME } from '../../src/core/scopes.js';
import { exportArchive, peekArchive, PRESETS } from '../../src/core/archive.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} path @param {string} content */
async function writeNote(page, path, content) {
  await allFiles(page);
  await page.getByLabel('File path').fill(path);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill(content);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}


test('everything survives export, erase and import', async ({ page }) => {
  await openApp(page);
  await startTrip(page, '京都 in spring');
  await writeNote(page, '/notes/伏見稲荷.md', '千本鳥居 at dawn');
  await page.getByLabel('Content').fill('千本鳥居 at dawn, before the crowds');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();

  await goToHash(page, '#/settings');
  await page.getByRole('button', { name: 'Export everything' }).click();
  const file = await buildAndSave(page);

  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await pastWelcome(page);
  await expect(page.getByText('Tap + to talk to Shiori.')).toBeVisible();

  await page.getByLabel('Open an annai file').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'Open an annai file' })).toBeVisible();
  await page.getByLabel('Replace my profile and memory with the ones in this file').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('link', { name: 'Open 京都 in spring' }).click();
  await allFiles(page);
  await page.getByRole('link', { name: /伏見稲荷\.md/ }).click();
  await expect(page.getByLabel('Content')).toHaveValue('千本鳥居 at dawn, before the crowds');
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
  await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
});

test("an import of my profile while a conversation is open reaches her next request, though its last writer was she on the old phone and the cache is warm (the snapshot review: F3)", async ({ page }) => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  await ws.write(ME, '/profile.md', '# Profile\n\n- Call me Mia\n', { author: 'shiori' });
  // The personality the app has seeded: a replaced "me" changes nothing else she reads, so the profile alone is what could refresh her snapshot.
  await ws.write(ME, '/personalities/shiori.md', await readFile(new URL('../../assets/personalities/shiori.md', import.meta.url), 'utf8'), { author: 'user' });
  const { blob } = await exportArchive(store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  const body = Buffer.from(await blob.arrayBuffer());
  const reply = { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Hello.' } }, { name: 'sleep', input: {} }]) };
  const llm = await startModelServer({ '/b/v1/messages': [reply, reply] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'Stand-in / b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    // A conversation the user named, so annai's naming of a draft can't be what refreshes her snapshot.
    const id = await startTrip(page, 'Big Sur');
    const say = async (/** @type {string} */ words, /** @type {number} */ n) => {
      if (!(await page.getByLabel('Message to Shiori').isVisible())) await page.getByRole('button', { name: 'Type', exact: true }).click();
      await page.getByLabel('Message to Shiori').fill(words);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.convo .shiori p')).toHaveCount(n, { timeout: 20_000 });
    };
    await say('Hi', 1);
    await goHome(page);
    await page.getByLabel('Open an annai file').setInputFiles({ name: 'me.annai.zip', mimeType: 'application/zip', buffer: body });
    await page.getByLabel('Replace my profile and memory with the ones in this file').check();
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText('Imported.')).toBeVisible();
    await goToHash(page, `#/trip/${encodeURIComponent(id)}`);
    await say('Hi again', 2);
    const [first, second] = llm.bodies('/b/v1/messages');
    expect(JSON.stringify(first.system)).not.toContain('Call me Mia');
    expect(JSON.stringify(second.system)).toContain('Call me Mia');
  } finally {
    await llm.stop();
  }
});

test('an encrypted trip opens only with its passphrase, and can replace the copy you have', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await writeNote(page, '/notes/bixby.md', 'Bixby Bridge, 1932');
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Share: itinerary, bookings, files and notes').check();
  await page.getByLabel('Passphrase (optional)').fill('pine needle');
  await page.getByLabel('Repeat passphrase').fill('pine needle');
  const file = await buildAndSave(page);
  expect((await readFile(file)).subarray(0, 10).toString()).toBe('ANNAI-ENC2');

  await goHome(page);
  await page.getByLabel('Open an annai file').setInputFiles(file);
  await page.getByLabel('Passphrase').fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong passphrase');
  await page.getByLabel('Passphrase').fill('pine needle');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByLabel('Replace mine (yours moves to Archived)').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('1 older copy moved to Archived.')).toBeVisible();
  await goHome(page);
  await expect(page.getByText('Archived (1)')).toBeVisible();
});

test('an opened file can be left without importing: Cancel, or the link back to Trips (the emulator pass)', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await buildAndSave(page);
  await goHome(page);
  for (const leave of ['Cancel', 'Trips']) {
    await page.getByLabel('Open an annai file').setInputFiles(file);
    await expect(page.getByRole('heading', { name: 'Open an annai file' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: leave, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(1); // nothing came in
  }
});

// The second emulator re-check: a 2.4 MB backup showed nothing for five minutes, not even "Reading…".
test('opening a file draws the screen at once, saying what it reads, and the preview needs only the manifest', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await buildAndSave(page);
  await goHome(page);
  // Every read of the file takes a while, as on a slow phone.
  await page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () { await new Promise((r) => setTimeout(r, 1500)); return read.call(this); };
  });
  await page.getByLabel('Open an annai file').setInputFiles(file);
  await expect(page.getByRole('heading', { level: 1, name: 'Open an annai file' })).toBeVisible();
  await expect(page.getByText(/^Reading .+…$/)).toBeVisible({ timeout: 1000 });
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible({ timeout: 30_000 });
});

test.describe('opening a hosted archive', () => {
  test.use({ serviceWorkers: 'block' });
  test('"#import=<url>" downloads and previews the archive', async ({ page }) => {
    const store = createMemoryStore();
    const ws = new Workspace(store);
    await ensureBaseScopes(ws);
    const id = await createTrip(ws, { title: 'Shared Big Sur' });
    await ws.write(id, '/notes/bixby.md', 'Bixby Bridge, 1932', { author: 'user' });
    const { blob } = await exportArchive(store, { kind: 'trip', scopes: [id], include: PRESETS.share, app: '0.1.0' });
    const body = Buffer.from(await blob.arrayBuffer());
    await page.route('https://files.example.test/big-sur.annai.zip', (route) =>
      route.fulfill({ body, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/zip' } }));
    await openApp(page, '#import=' + encodeURIComponent('https://files.example.test/big-sur.annai.zip'));
    await expect(page.getByText('Shared Big Sur')).toBeVisible();
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('link', { name: 'Open Shared Big Sur' }).click();
    await allFiles(page);
    await expect(page.getByRole('link', { name: /bixby\.md/ })).toBeVisible();
  });

  test('keys already on this device are kept on an import, and named as the screens name them, never by a key\'s id', async ({ page }) => {
    const store = createMemoryStore();
    const ws = new Workspace(store);
    await ensureBaseScopes(ws);
    await createTrip(ws, { title: 'Keyed Big Sur' });
    await store.tx(['secrets'], 'readwrite', async (t) => {
      await t.putSecret('plugin:mcp:Trail server', 'from-the-file');
      await t.putSecret('llm:pv-gone', 'from-the-file');
    });
    const { blob } = await exportArchive(store, { kind: 'everything', include: PRESETS.backup, secrets: true, passphrase: 'p', iterations: 100_000, app: '0.1.0' });
    const body = Buffer.from(await blob.arrayBuffer());
    await page.route('https://files.example.test/keys.annai.zip', (route) =>
      route.fulfill({ body, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/zip' } }));
    await openApp(page);
    await page.evaluate(async () => {
      const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
      const own = await createIdbStore();
      await own.tx(['secrets'], 'readwrite', async (/** @type {any} */ t) => {
        await t.putSecret('plugin:mcp:Trail server', 'mine');
        await t.putSecret('llm:pv-gone', 'mine');
      });
      own.close();
    });
    await page.goto('/#import=' + encodeURIComponent('https://files.example.test/keys.annai.zip'));
    await page.getByLabel('Passphrase').fill('p');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByLabel('Restore API keys (keys already on this device are kept)').check();
    await page.getByRole('button', { name: 'Import' }).click();
    // The provider's key has no provider here to name it: it is counted, and its id is never shown.
    await expect(page.getByText("Kept your own API keys for Trail server; the ones in the file weren't used.")).toBeVisible();
    await expect(page.getByText('pv-gone')).toHaveCount(0);
  });
});

/** A file's manifest record of its first trip, read as annai reads it. @param {string} file */
const recordIn = async (file) => (await peekArchive(new Uint8Array(await readFile(file)))).manifest.scopes[0].record;

/**
 * Builds the file and saves it, with what the panel said once it was built (Save file's tap replaces that): Build file hides Save file in its tap, so
 * its showing again is this build's. @param {import('@playwright/test').Page} page
 */
async function build(page) {
  await page.getByRole('button', { name: 'Build file' }).click();
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeVisible({ timeout: 60_000 });
  const said = await page.locator('section[aria-label="Export"] [role=status]').textContent();
  const downloading = page.waitForEvent('download');
  await save.click();
  return { said, file: /** @type {string} */ (await (await downloading).path()) };
}

test('a Share says who made it only when ticked, with the name Shiori calls you; its copy\'s row and Details say "From Mia", and the trip shared stays as it was (the timeline design, "Nickname and sharing")', async ({ page }) => {
  await openApp(page, '#/shiori');
  const name = page.getByLabel('What should Shiori call you?');
  await name.fill('Mia');
  await leaveSaved(name);
  const id = await startTrip(page, 'Kyoto', { start: '2027-04-03', end: '2027-04-10' });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const made = page.getByLabel('Show who made it');
  await expect(made).toBeHidden(); // a Backup's own record goes as it is
  await page.getByLabel('Share: itinerary, bookings, files and notes').check();
  await expect(made).not.toBeChecked();
  expect(await recordIn((await build(page)).file)).not.toHaveProperty('madeBy');
  await made.check();
  const { said, file: named } = await build(page);
  expect((await recordIn(named)).madeBy).toBe('Mia');
  expect(said).not.toContain("doesn't say who made it");
  // With no name, ticked, the file is built without one, and says so.
  await goToHash(page, '#/shiori');
  await name.fill('');
  await leaveSaved(name);
  await goToHash(page, `#/trip/${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Share: itinerary, bookings, files and notes').check();
  await made.check();
  const nameless = await build(page);
  expect(await recordIn(nameless.file)).not.toHaveProperty('madeBy');
  expect(nameless.said).toContain("It doesn't say who made it: Settings → Shiori has no name for you.");
  // The trip shared is as it was; its copy, brought in, says who made it on its row and in Details.
  await goHome(page);
  await expect(page.locator('main .from')).toHaveCount(0);
  await page.getByLabel('Open an annai file').setInputFiles(named);
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('link', { name: 'Open Kyoto' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
  await expect(page.locator('main .from')).toHaveText('From Mia');
  await goHome(page);
  await expect(page.locator('main .trip-card')).toHaveCount(2);
  await expect(page.locator('main .trip-card .from')).toHaveText(['From Mia']);
  await goToHash(page, `#/trip/${encodeURIComponent(id)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
  await expect(page.locator('main .from')).toHaveCount(0);
});

test('who made a shared trip is drawn as text, never as markup, and a long name is cut to its line, on a card, on a chat\'s line and in Details (RULES principle 9)', async ({ page }) => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Kyoto', start: '2027-04-03', end: '2027-04-10' });
  const chat = await createTrip(ws, { title: 'Ideas' });
  const madeBy = `<img src=x onerror="window.madeByRan=1"><b>Mia</b> ${'and a very long name '.repeat(300)}`;
  const { blob } = await exportArchive(store, { kind: 'trip', scopes: [trip, chat], include: PRESETS.share, app: '0.1.0', share: { places: true, madeBy } });
  await openApp(page);
  await page.getByLabel('Open an annai file').setInputFiles({ name: 'kyoto.annai.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await page.getByRole('button', { name: 'Import' }).click();
  const details = /** @type {string} */ (await page.getByRole('link', { name: 'Open Kyoto' }).getAttribute('href'));
  const shown = `From ${madeBy.replace(/\s+/g, ' ').trim()}`;
  /** Each "From" on the screen: its text, whether it holds anything but text, whether it is cut to its box, and whether it stays on the screen. */
  const froms = () => page.locator('main .from').evaluateAll((els) => els.map((el) => ({
    text: el.textContent, tags: [...el.querySelectorAll('*')].map((x) => x.tagName), cut: el.scrollWidth > el.clientWidth, inside: el.getBoundingClientRect().right <= innerWidth,
  })));
  await goHome(page);
  await expect(page.locator('main .from')).toHaveCount(2);
  expect(await froms()).toEqual([1, 2].map(() => ({ text: shown, tags: ['BDI'], cut: true, inside: true })));
  // The chat's own name and its time keep their place beside it.
  const line = page.locator('main .trip-card.line');
  expect(await line.locator('.name').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(30);
  await expect(line.locator('.sub:not(.from)')).toBeInViewport();
  await goToHash(page, details);
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto' })).toBeVisible();
  expect(await froms()).toEqual([{ text: shown, tags: ['BDI'], cut: true, inside: true }]);
  expect(await page.evaluate(() => [/** @type {any} */ (window).madeByRan, document.documentElement.scrollWidth <= innerWidth])).toEqual([undefined, true]);
});
