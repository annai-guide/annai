import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, buildAndSave, pastWelcome, allFiles } from './helpers.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { exportArchive, PRESETS } from '../../src/core/archive.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

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
  await page.getByRole('link', { name: 'Back to trip', exact: true }).click();
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Export everything' }).click();
  const file = await buildAndSave(page);

  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await pastWelcome(page);
  await expect(page.getByText('No trips yet.')).toBeVisible();

  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
  await page.getByLabel('Replace my profile and memory with the ones in this file').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('link', { name: 'Open 京都 in spring' }).click();
  await allFiles(page);
  await page.getByRole('link', { name: /伏見稲荷\.md/ }).click();
  await expect(page.getByLabel('Content')).toHaveValue('千本鳥居 at dawn, before the crowds');
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: 'Back to trip', exact: true }).click();
  await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
  await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
});

test('an encrypted trip opens only with its passphrase, and can replace the copy you have', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await writeNote(page, '/notes/bixby.md', 'Bixby Bridge, 1932');
  await page.getByRole('link', { name: 'Back to trip', exact: true }).click();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await page.getByLabel('Share: plan, bookings, files and notes').check();
  await page.getByLabel('Passphrase (optional)').fill('pine needle');
  await page.getByLabel('Repeat passphrase').fill('pine needle');
  const file = await buildAndSave(page);
  expect((await readFile(file)).subarray(0, 10).toString()).toBe('ANNAI-ENC2');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await page.getByLabel('Passphrase').fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong passphrase');
  await page.getByLabel('Passphrase').fill('pine needle');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByLabel('Replace mine (yours moves to archived trips)').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('1 older copy moved to archived trips.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByText('Archived trips (1)')).toBeVisible();
});

test('an opened file can be left without importing: Cancel, or the link back to Trips (the emulator pass)', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByRole('button', { name: 'Export trip' }).click();
  const file = await buildAndSave(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  for (const leave of ['Cancel', 'Trips']) {
    await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Export trip' }).click();
  const file = await buildAndSave(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  // Every read of the file takes a while, as on a slow phone.
  await page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () { await new Promise((r) => setTimeout(r, 1500)); return read.call(this); };
  });
  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await expect(page.getByRole('heading', { level: 1, name: 'Open a trip' })).toBeVisible();
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
