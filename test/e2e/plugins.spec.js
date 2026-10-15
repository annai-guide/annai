import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';

async function helloZip() {
  const z = new ZipWriter();
  for (const name of ['annai-plugin.json', 'index.js']) {
    await z.add(`hello/${name}`, new Uint8Array(await readFile(new URL(`../fixtures/plugins/hello/${name}`, import.meta.url))));
  }
  return Buffer.from(await z.finish().arrayBuffer());
}

test('install a plugin, see it work, turn it off, uninstall it', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await page.getByLabel('Trip name').fill('Plugin trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  const tripUrl = page.url();

  await page.goto('/#/plugins');
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  await expect(page.getByText('Trip record checks')).toBeVisible();
  await page.getByLabel('Install a plugin from a file').setInputFiles({ name: 'hello.zip', mimeType: 'application/zip', buffer: await helloZip() });
  await expect(page.getByText('Hello checks 1.0.0')).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  await page.goto(tripUrl);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert')).toContainText('greeting');

  await page.goto('/#/plugins');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await page.goto(tripUrl);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/hello/a.json' })).toBeVisible();

  await page.goto('/#/plugins');
  await page.getByRole('button', { name: 'Uninstall' }).click();
  await page.getByRole('button', { name: 'Tap again to uninstall' }).click();
  await expect(page.getByText('Hello checks 1.0.0')).toHaveCount(0);
});

test('a bad plugin file is refused with a reason', async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await page.getByLabel('Install a plugin from a file').setInputFiles({ name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(page.getByText("That plugin wasn't installed")).toBeVisible();
});
