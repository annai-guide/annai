import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp } from './helpers.js';
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
  await page.getByLabel('File path').fill(path);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill(content);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}

/** Builds the file, then saves it with a separate tap (the iOS share sheet needs a fresh tap). @param {import('@playwright/test').Page} page */
async function buildAndSave(page) {
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeHidden();
  await page.getByRole('button', { name: 'Build file' }).click();
  await expect(save).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await save.click();
  const download = await downloading;
  return /** @type {string} */ (await download.path());
}

test('everything survives export, erase and import', async ({ page }) => {
  await openApp(page);
  await startTrip(page, '京都 in spring');
  await writeNote(page, '/notes/伏見稲荷.md', '千本鳥居 at dawn');
  await page.getByLabel('Content').fill('千本鳥居 at dawn, before the crowds');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: '← Back to trip' }).click();
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Export everything' }).click();
  const file = await buildAndSave(page);

  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText('No trips yet.')).toBeVisible();

  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
  await page.getByLabel('Replace my profile and memory with the ones in this file').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('link', { name: 'Open 京都 in spring' }).click();
  await page.getByRole('link', { name: /伏見稲荷\.md/ }).click();
  await expect(page.getByLabel('Content')).toHaveValue('千本鳥居 at dawn, before the crowds');
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
  await page.getByRole('link', { name: '← Back to trip' }).click();
  await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
  await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
});

test('an encrypted trip opens only with its passphrase, and can replace the copy you have', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await writeNote(page, '/notes/bixby.md', 'Bixby Bridge, 1932');
  await page.getByRole('link', { name: '← Back to trip' }).click();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await page.getByLabel('Share: plan, bookings, files and notes').check();
  await page.getByLabel('Passphrase (optional)').fill('pine needle');
  await page.getByLabel('Repeat passphrase').fill('pine needle');
  const file = await buildAndSave(page);
  expect((await readFile(file)).subarray(0, 10).toString()).toBe('ANNAI-ENC2');

  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await page.getByLabel('Open a trip someone sent you').setInputFiles(file);
  await page.getByLabel('Passphrase').fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong passphrase');
  await page.getByLabel('Passphrase').fill('pine needle');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByLabel('Replace mine (yours moves to archived trips)').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('1 older copy moved to archived trips.')).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(page.getByText('Archived trips (1)')).toBeVisible();
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
    await expect(page.getByRole('link', { name: /bixby\.md/ })).toBeVisible();
  });
});
