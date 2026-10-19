import { test, expect } from '@playwright/test';
import { openApp, filterTrace, pastWelcome } from './helpers.js';
import { startForgejo } from '../fakes/forgejo.js';

const REPO = 'me/annai-backup';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Automatic backups on a short clock: a look every 300 ms, 300 ms after the last change, no gap between backups. @param {import('@playwright/test').Page} page */
async function fastBackups(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('annai.backupTimings', JSON.stringify({ tickMs: 300, quietMs: 300, gapMs: 0 }));
    } catch {
      // storage blocked
    }
  });
}

/** Settings → Automatic backups → Forgejo / Gitea, filled in; then Save and test. @param {import('@playwright/test').Page} page @param {any} fj */
async function addForgejo(page, fj) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Automatic backups' }).click();
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
  await page.getByLabel('Add a place to back up to').selectOption({ label: 'Forgejo / Gitea' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forgejo / Gitea', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Server address').fill(fj.origin);
  await page.getByLabel('Owner').fill('me');
  await page.getByLabel('Repository').fill('annai-backup');
  await page.getByLabel('Access token').fill(fj.token);
  await page.getByRole('button', { name: 'Save and test' }).click();
}

test('backups go to a Forgejo server, only what changed is sent, and a wiped phone gets everything back (spec §12.4)', async ({ page, baseURL }) => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, cors: new URL(String(baseURL)).origin });
  const host = new URL(fj.origin).host;
  try {
    await fastBackups(page);
    await openApp(page);
    await page.getByLabel('Trip name').fill('Big Sur');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await page.getByLabel('File path').fill('/notes/bixby.md');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByLabel('Content').fill('Bixby Bridge, 1932');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '← Back to trip' }).click();
    await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
    await addForgejo(page, fj);
    await expect(page.getByText(`Works: annai can reach ${REPO} on ${host}, a private repository.`)).toBeVisible();

    // The backup goes up by itself, as files, in one commit.
    await expect(page.getByText(/^Last backup/)).toBeVisible({ timeout: 30_000 });
    expect(fj.commits(REPO).map((c) => c.message.split('\n')[0])).toEqual([expect.stringMatching(/^annai backup from /)]);
    const files = fj.files(REPO);
    const note = /** @type {string} */ ([...files.keys()].find((p) => /^trips\/[^/]+\/notes\/bixby\.md$/.test(p)));
    expect(files.get(note)?.toString()).toBe('Bixby Bridge, 1932');
    const photo = /** @type {string} */ ([...files.keys()].find((p) => /^trips\/[^/]+\/files\/gate\.(webp|jpg)$/.test(p)));
    expect(files.has('annai-archive.json')).toBe(true);

    // A change goes up by itself too, and the photo isn't sent again.
    await page.getByRole('link', { name: 'Trips', exact: true }).click();
    await page.getByRole('link', { name: /Big Sur/ }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await page.getByLabel('Content').fill('Bixby Bridge, 1932, at dawn');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => fj.files(REPO).get(note)?.toString(), { timeout: 30_000 }).toBe('Bixby Bridge, 1932, at dawn');
    const posted = fj.log.filter((l) => l.method === 'POST' && l.status === 201).map((l) => JSON.parse(l.body).files.map((/** @type {any} */ f) => f.path));
    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(posted.slice(1).flat()).not.toContain(photo);

    // The trace shows each request annai sent to the server.
    await page.getByRole('link', { name: 'Trace' }).click();
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('.trace li', { hasText: 'plugin:storage-forgejo · POST' }).first()).toBeVisible();

    // This phone is wiped. The same place, set up again, brings everything back.
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await pastWelcome(page);
    await expect(page.getByText('No trips yet.')).toBeVisible();
    await addForgejo(page, fj);
    await expect(page.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
    await expect(page.getByText(new RegExp(`^An? (iPhone|Android phone|computer) backed up to ${host.replace(/[.]/g, '\\.')}/me/annai-backup`))).toBeVisible();
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText("annai's next backup to that place builds on this one.")).toBeVisible();
    await page.getByRole('link', { name: 'Open Big Sur' }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await expect(page.getByLabel('Content')).toHaveValue('Bixby Bridge, 1932, at dawn');
    await page.getByRole('link', { name: '← Back to trip' }).click();
    await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
    await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();

    // The restored phone builds on that backup: its next one goes on top, with no warning.
    await expect.poll(() => fj.commits(REPO).length, { timeout: 30_000 }).toBe(3);
    const [restored, before] = fj.commits(REPO);
    expect(restored.parents).toEqual([before.sha]);
  } finally {
    await fj.stop();
  }
});

test("a server that doesn't let web apps use its API says so, and shows the lines for its app.ini", async ({ page, baseURL }) => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, cors: false });
  try {
    await openApp(page);
    await addForgejo(page, fj);
    await expect(page.getByText(`annai couldn't reach ${new URL(fj.origin).host}.`, { exact: false })).toBeVisible();
    const access = page.getByRole('region', { name: 'Browser access' });
    await expect(access.getByText(`ALLOW_DOMAIN = ${new URL(String(baseURL)).origin}`, { exact: false })).toBeVisible();
    await expect(access.getByText('[cors]', { exact: false })).toBeVisible();
    // The browser may still send the request (WebKit does), but the page can't read the answer, and nothing is written.
    expect(fj.log.filter((l) => l.method === 'POST')).toEqual([]);
  } finally {
    await fj.stop();
  }
});
