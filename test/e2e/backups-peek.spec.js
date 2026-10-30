import { test, expect } from '@playwright/test';
import { openApp, pastWelcome, startTrip, allFiles } from './helpers.js';
import { startForgejo } from '../fakes/forgejo.js';

// A git backup opens from its manifest alone, and its files come on Import (spec §12.3, §12.4).
const REPO = 'me/annai-backup';

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

/**
 * A phone that backed a trip up to the stand-in, then was wiped and set up with the same place: on the place's screen,
 * a backup is already there. @param {import('@playwright/test').Page} page @param {any} fj
 */
async function wipedPhone(page, fj) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('annai.backupTimings', JSON.stringify({ tickMs: 300, quietMs: 300, gapMs: 0 }));
    } catch { /* storage blocked */ }
  });
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await allFiles(page);
  await page.getByLabel('File path').fill('/notes/bixby.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill('Bixby Bridge, 1932');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await addForgejo(page, fj);
  await expect(page.getByText(/^Last backup/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await pastWelcome(page);
  await expect(page.getByText('No trips yet.')).toBeVisible();
  await addForgejo(page, fj);
  await expect(page.getByRole('heading', { name: 'A backup is already here' })).toBeVisible();
}

/** The requests for the backup's files (not its manifest) the stand-in has had. @param {any} fj */
const fileReads = (fj) => fj.log.filter((/** @type {any} */ l) => l.method === 'GET' && l.path.includes('/media/') && !l.path.endsWith('/media/annai-archive.json')).length;

/** The manifest the stand-in holds. @param {any} fj */
const manifestOf = (fj) => JSON.parse(String(fj.files(REPO).get('annai-archive.json')));

test('Import says how far the files are, and a manifest swapped between the preview and Import is refused', async ({ page, baseURL }) => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, cors: new URL(String(baseURL)).origin });
  try {
    await wipedPhone(page, fj);
    await page.getByRole('button', { name: 'Import it as a copy' }).click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Big Sur', { exact: true })).toBeVisible();
    // The files come with Import, and the screen says how many.
    await page.evaluate(() => {
      /** @type {any} */ (window).said = [];
      new MutationObserver(() => {
        for (const s of document.querySelectorAll('[role=status]')) if (s.textContent) /** @type {any} */ (window).said.push(s.textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('Imported.')).toBeVisible();
    const said = await page.evaluate(() => /** @type {any} */ (window).said);
    expect(said.filter((/** @type {string} */ s) => /^Getting files: \d+ of \d+$/.test(s)).length).toBeGreaterThan(0);

    // Another phone: the preview shows the backup as it was, then the server hands over another manifest with the files.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
    await page.getByRole('link', { name: /Big Sur/ }).first().click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Automatic backups' }).click();
    await page.getByRole('link', { name: /Forgejo/ }).first().click();
    await page.getByRole('button', { name: 'Show the backups here' }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
    // The manifest of the backup that was opened, with the trip renamed: made from the one the stand-in gives for the request, which is
    // the backup's at the ref asked for. Not from the repository's latest, which a backup this phone made meanwhile (of the trip it
    // imported above) has moved on, with files the opened one has not.
    fj.answerNext('GET', '/media/annai-archive.json', (own) => {
      const swapped = JSON.parse(String(own.raw));
      swapped.scopes = swapped.scopes.map((/** @type {any} */ s) => (s.record.kind === 'trip' ? { ...s, record: { ...s.record, title: 'Somewhere else' } } : s));
      return { status: 200, raw: Buffer.from(JSON.stringify(swapped)) };
    });
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText(/This backup changed on the server/)).toBeVisible();
    await expect(page.getByText('Imported.')).toHaveCount(0);
  } finally {
    await fj.stop();
  }
});

for (const way of ['Cancel', 'the crumb']) {
  test(`${way} while the files are coming stops the download, and no trip is imported`, async ({ page, baseURL }) => {
    const fj = await startForgejo({ repos: { [REPO]: {} }, cors: new URL(String(baseURL)).origin });
    try {
      await wipedPhone(page, fj);
      await page.getByRole('button', { name: 'Import it as a copy' }).click();
      await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible({ timeout: 30_000 });
      const release = fj.holdFiles();
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: /^Getting / })).toBeVisible();
      await expect.poll(() => fj.waiting()).toBeGreaterThan(0);
      const before = fileReads(fj);
      if (way === 'Cancel') await page.getByRole('link', { name: 'Cancel' }).click();
      else await page.locator('.crumbs a').click(); // the back link
      await expect(page.getByRole('heading', { name: 'Forgejo / Gitea', exact: true })).toBeVisible();
      const inFlight = fj.waiting();
      expect(inFlight).toBeLessThanOrEqual(6);
      release();
      // Nothing carries on in the background: the files already asked for arrive, no more are asked for, and no trip appears.
      await page.waitForTimeout(1500);
      expect(fileReads(fj) - before).toBe(inFlight);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
      await expect(page.getByText('No trips yet.')).toBeVisible();
    } finally {
      await fj.stop();
    }
  });
}

test('a backup whose manifest is damaged or unsafe says so in plain words on the Backups screen, without its files', async ({ page, baseURL }) => {
  const fj = await startForgejo({ repos: { [REPO]: {} }, cors: new URL(String(baseURL)).origin });
  try {
    await wipedPhone(page, fj);
    await page.getByRole('button', { name: 'Show the backups here' }).click();
    const bad = manifestOf(fj);
    bad.files[0].path = '/../../escape';
    fj.answerNext('GET', '/media/annai-archive.json', { status: 200, raw: Buffer.from(JSON.stringify(bad)) });
    await page.getByRole('button', { name: 'Open', exact: true }).first().click();
    await expect(page.getByText('This backup is damaged.', { exact: true })).toBeVisible();
    await expect(page.getByText(/\$\.|unsafe/)).toHaveCount(0);
    expect(fileReads(fj)).toBe(0);
    await expect(page.getByRole('heading', { name: 'Forgejo / Gitea', exact: true })).toBeVisible();
  } finally {
    await fj.stop();
  }
});
