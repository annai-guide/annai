import { test, expect } from '@playwright/test';
import { openApp, pastWelcome } from './helpers.js';
import { startS3, ACCESS, SECRET } from '../fakes/s3.js';
import { startWebDAV, USER, PASSWORD } from '../fakes/webdav.js';

/** Automatic backups on a short clock. @param {import('@playwright/test').Page} page */
async function fastBackups(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('annai.backupTimings', JSON.stringify({ tickMs: 300, quietMs: 300, gapMs: 0 }));
    } catch {
      // storage blocked
    }
  });
}

/** @param {import('@playwright/test').Page} page @param {string} title @param {string} path @param {string} content */
async function tripWithNote(page, title, path, content) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByLabel('File path').fill(path);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill(content);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}

/**
 * Settings → Automatic backups → a kind of place, filled in. Save and test is left to the caller.
 * @param {import('@playwright/test').Page} page @param {string} kind @param {Record<string, string>} fields
 */
async function addPlace(page, kind, fields) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Automatic backups' }).click();
  await page.getByLabel('Add a place to back up to').selectOption({ label: kind });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: kind, exact: true })).toBeVisible({ timeout: 30_000 });
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value);
  // Nothing on the place's screen scrolls sideways, the browser-access rules included.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('S3: encrypted automatic backups, and a wiped phone restores one with its passphrase (spec §12.4)', async ({ page }) => {
  const s3 = await startS3({ buckets: ['trips'] });
  const fields = { 'S3 address': s3.origin, Region: 'us-east-1', Bucket: 'trips', 'Access key ID': ACCESS, 'Secret access key': SECRET };
  try {
    await fastBackups(page);
    await openApp(page);
    await tripWithNote(page, 'Big Sur', '/notes/bixby.md', 'Bixby Bridge, 1932');
    await addPlace(page, 'S3-compatible storage', fields);
    // The exact CORS rules to paste, with this page's origin.
    await expect(page.locator('pre', { hasText: '"AllowedOrigins"' })).toContainText(`"${new URL(page.url()).origin}"`);
    await page.getByLabel('Encrypt backups with a passphrase').check();
    await page.getByLabel('Passphrase', { exact: true }).fill('pine needle');
    await page.getByLabel('Repeat passphrase').fill('pine needle');
    await page.getByRole('button', { name: 'Save and test' }).click();
    await expect(page.getByText('Works: annai can reach trips and keep its backups in annai/.')).toBeVisible();
    await expect(page.getByText(/^Last backup/)).toBeVisible({ timeout: 30_000 });
    const [key, bytes] = [...s3.objects('trips')][0];
    expect(key).toMatch(/^annai\/annai-backup-\d{8}T\d{9}Z-(android-phone|iphone)-[0-9a-z]{8,}\.annai$/);
    expect(bytes.subarray(0, 10).toString()).toBe('ANNAI-ENC2');

    // This phone is wiped; the same bucket brings the trip back, with the passphrase.
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await pastWelcome(page);
    await expect(page.getByText('No trips yet.')).toBeVisible();
    await addPlace(page, 'S3-compatible storage', fields);
    await page.getByRole('button', { name: 'Save and test' }).click();
    await expect(page.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Passphrase').fill('pine needle');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('link', { name: 'Open Big Sur' }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await expect(page.getByLabel('Content')).toHaveValue('Bixby Bridge, 1932');
  } finally {
    await s3.stop();
  }
});

test('WebDAV: automatic backups go to a folder annai makes, and any of them opens again (spec §12.4)', async ({ page }) => {
  const dav = await startWebDAV({ folders: ['/dav/'] });
  try {
    await fastBackups(page);
    await openApp(page);
    await tripWithNote(page, 'Kyoto', '/notes/fushimi.md', 'Fushimi Inari at dawn');
    await addPlace(page, 'WebDAV', { 'Folder address': `${dav.origin}/dav/annai`, 'User name': USER, Password: PASSWORD });
    await expect(page.locator('pre', { hasText: 'Access-Control-Allow-Origin' })).toContainText(new URL(page.url()).origin);
    await page.getByRole('button', { name: 'Save and test' }).click();
    await expect(page.getByText(/^Works: annai made the folder 127\.0\.0\.1:\d+\/dav\/annai\/ and can keep its backups there\.$/)).toBeVisible();
    await expect(page.getByText(/^Last backup/)).toBeVisible({ timeout: 30_000 });
    expect([...dav.files().keys()].some((p) => /^\/dav\/annai\/annai-backup-.+\.annai\.zip$/.test(p))).toBe(true);
    await page.getByRole('button', { name: 'Show the backups here' }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('You already have "Kyoto"')).toBeVisible();
    // A way back to the place it came from, as well as Cancel.
    await expect(page.locator('.crumbs a')).toHaveAttribute('href', /^#\/backups\/place\?id=/);
    await expect(page.getByRole('link', { name: 'Cancel', exact: true })).toHaveAttribute('href', /^#\/backups\/place\?id=/);
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByRole('link', { name: 'Open Kyoto' })).toBeVisible();
  } finally {
    await dav.stop();
  }
});

test("the limit for connections annai can't name is yours: at 0 MB, each automatic backup waits for your OK", async ({ page }) => {
  const dav = await startWebDAV({ folders: ['/dav/'] });
  try {
    await fastBackups(page);
    await openApp(page);
    await tripWithNote(page, 'Kyoto', '/notes/fushimi.md', 'Fushimi Inari at dawn');
    await addPlace(page, 'WebDAV', { 'Folder address': `${dav.origin}/dav/annai`, 'User name': USER, Password: PASSWORD });
    const limit = page.getByLabel('Upload without asking up to, MB');
    await expect(limit).toHaveValue('25');
    await limit.fill('0');
    await limit.blur();
    await expect(page.getByText(/larger than 0 bytes wait for your OK/)).toBeVisible();
    await page.getByRole('button', { name: 'Save and test' }).click();
    await expect(page.getByText('A large backup is waiting')).toBeVisible({ timeout: 30_000 });
    expect(dav.files().size).toBe(0);
    await page.locator('.notices').getByRole('button', { name: 'Back up now' }).click();
    await expect.poll(() => dav.files().size, { timeout: 30_000 }).toBe(1);
  } finally {
    await dav.stop();
  }
});
