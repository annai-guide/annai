import { test, expect, devices } from '@playwright/test';
import { openApp } from './helpers.js';
import { startGitHub } from '../fakes/github.js';

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

/** Settings → Automatic backups → GitHub, filled in and tested. @param {import('@playwright/test').Page} page @param {any} gh */
async function addGitHub(page, gh) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Automatic backups' }).click();
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
  await page.getByLabel('Add a place to back up to').selectOption({ label: 'GitHub' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Repository').fill(REPO);
  await page.getByLabel('Access token').fill(gh.token);
  await page.getByText('More', { exact: true }).click();
  await page.getByLabel('GitHub API address').fill(gh.origin);
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByText(`Works: annai can reach ${REPO}, a private repository.`)).toBeVisible();
}

test('automatic backups go to GitHub, only what changed is sent, and a wiped phone gets everything back (spec §12.4)', async ({ page }) => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  try {
    await fastBackups(page);
    await openApp(page);
    await startTrip(page, 'Big Sur');
    await writeNote(page, '/notes/bixby.md', 'Bixby Bridge, 1932');
    await page.getByRole('link', { name: '← Back to trip' }).click();
    await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
    await addGitHub(page, gh);

    // Nothing more to do: the backup goes up by itself, as files.
    await expect(page.getByText(/^Last backup/)).toBeVisible({ timeout: 30_000 });
    expect(gh.commits(REPO).map((c) => c.message.split('\n')[0])).toEqual([expect.stringMatching(/^annai backup from /), 'Start annai backups']);
    const files = gh.files(REPO);
    const note = /** @type {string} */ ([...files.keys()].find((p) => /^trips\/[^/]+\/notes\/bixby\.md$/.test(p)));
    expect(files.get(note)?.toString()).toBe('Bixby Bridge, 1932');
    expect(files.has('annai-archive.json')).toBe(true);
    expect([...files.keys()].some((p) => /^trips\/[^/]+\/files\/gate\.(webp|jpg)$/.test(p))).toBe(true);
    expect(gh.count('POST', '/git/blobs')).toBe(1);
    await page.getByRole('link', { name: 'Trips', exact: true }).click();
    await expect(page.getByText(/backed up (just now|\d+ seconds? ago)/)).toBeVisible();

    // A change goes up by itself too, and the photo isn't sent again.
    await page.getByRole('link', { name: /Big Sur/ }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await page.getByLabel('Content').fill('Bixby Bridge, 1932, at dawn');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => gh.files(REPO).get(note)?.toString(), { timeout: 30_000 }).toBe('Bixby Bridge, 1932, at dawn');
    expect(gh.count('POST', '/git/blobs')).toBe(1);

    // The trace shows each request annai sent to GitHub.
    await page.getByRole('link', { name: 'Trace' }).click();
    await page.getByLabel('Kind').selectOption('Web');
    await expect(page.locator('.trace li', { hasText: 'plugin:storage-github · PATCH' }).first()).toBeVisible();
    await page.getByLabel('Kind').selectOption('Backups');
    await expect(page.locator('.trace li', { hasText: 'github · auto' }).first()).toBeVisible();

    // This phone is wiped. The same place, set up again, brings everything back.
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Erase now' }).click();
    await expect(page.getByText('No trips yet.')).toBeVisible();
    await addGitHub(page, gh);
    await expect(page.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
    await expect(page.getByText(/^An? (iPhone|Android phone|computer) backed up to me\/annai-backup/)).toBeVisible();
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Replace my profile and memory with the ones in this file')).toBeChecked();
    await expect(page.getByLabel('Replace my settings')).toBeChecked();
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText("annai's next backup to that place builds on this one.")).toBeVisible();
    await page.getByRole('link', { name: 'Open Big Sur' }).click();
    await page.getByRole('link', { name: /bixby\.md/ }).click();
    await expect(page.getByLabel('Content')).toHaveValue('Bixby Bridge, 1932, at dawn');
    await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(2);
    await page.getByRole('link', { name: '← Back to trip' }).click();
    await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
    await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();

    // The restored phone builds on that backup: its next one goes on top, with no warning.
    await expect.poll(() => gh.commits(REPO).length, { timeout: 30_000 }).toBe(4);
    const [restored, before] = gh.commits(REPO);
    expect(restored.parents).toEqual([before.sha]);
  } finally {
    await gh.stop();
  }
});

test('a newer backup from another phone pauses this one, and comes in as a copy (spec §12.4: single writer)', async ({ page, browser, baseURL }) => {
  const gh = await startGitHub({ repos: { [REPO]: {} } });
  const other = await browser.newContext({ ...devices[test.info().project.name === 'webkit' ? 'iPhone 15' : 'Pixel 7'], baseURL, acceptDownloads: true });
  try {
    await fastBackups(page);
    await openApp(page);
    await startTrip(page, 'Kyoto');
    await addGitHub(page, gh);
    await expect.poll(() => gh.commits(REPO).length, { timeout: 30_000 }).toBe(2);

    // The second phone finds that backup and takes it in as a copy, then backs up on top of it.
    const second = await other.newPage();
    await fastBackups(second);
    await openApp(second);
    await addGitHub(second, gh);
    await expect(second.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
    await second.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(second.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await second.getByRole('button', { name: 'Import' }).click();
    await second.getByRole('link', { name: 'Open Kyoto' }).click();
    await writeNote(second, '/notes/fushimi.md', 'Fushimi Inari at dawn');
    await expect.poll(() => [...gh.files(REPO).keys()].some((p) => p.endsWith('/notes/fushimi.md')), { timeout: 30_000 }).toBe(true);

    // The first phone's next backup meets it: a card, and nothing is overwritten.
    const commits = gh.commits(REPO).length;
    await page.getByRole('link', { name: 'Trips', exact: true }).click();
    await page.getByRole('link', { name: /Kyoto/ }).click();
    await writeNote(page, '/notes/kiyomizu.md', 'Kiyomizu-dera');
    await expect(page.getByText('A newer backup is on GitHub')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^An? (iPhone|Android phone) backed up to me\/annai-backup .*, after this phone's last backup\./)).toBeVisible();
    expect(gh.commits(REPO).length).toBe(commits);
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Replace mine (yours moves to archived trips)').check();
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('link', { name: 'Open Kyoto' }).click();
    await expect(page.getByRole('link', { name: /fushimi\.md/ })).toBeVisible();

    // From now on it builds on the other phone's backup.
    await expect.poll(() => gh.commits(REPO).length, { timeout: 30_000 }).toBe(commits + 1);
    expect(gh.commits(REPO)[0].parents).toEqual([gh.commits(REPO)[1].sha]);
  } finally {
    await other.close();
    await gh.stop();
  }
});
