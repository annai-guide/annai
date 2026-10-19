import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, pickFile } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';

/** A test plugin from test/fixtures/plugins, as a zip. @param {string} [dir] */
/** A plugin fixture as a zip; with version, its manifest says that version. @param {string} [dir] @param {string} [version] */
async function fixtureZip(dir = 'hello', version) {
  const z = new ZipWriter();
  for (const name of ['annai-plugin.json', 'index.js']) {
    let bytes = new Uint8Array(await readFile(new URL(`../fixtures/plugins/${dir}/${name}`, import.meta.url)));
    if (version && name === 'annai-plugin.json') bytes = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), version }));
    await z.add(`${dir}/${name}`, bytes);
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
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  await expect(page.getByRole('heading', { name: 'Install Hello checks?' })).toBeVisible();
  await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
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
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Tap again to remove' }).click();
  await expect(page.getByText('Hello checks 1.0.0')).toHaveCount(0);
});

test('a bad plugin file is refused with a reason', async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(page.getByText("That file isn't something annai can install")).toBeVisible();
});

test("a plugin that never finishes starting doesn't keep annai from opening", async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const files = await Promise.all(['annai-plugin.json', 'index.js'].map(async (name) => [name, await readFile(new URL(`../fixtures/plugins/hang/${name}`, import.meta.url), 'utf8')]));
  await page.evaluate(async (files) => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (const [name, body] of files) await ws.write('sys:plugins', `/hang/${name}`, body, { author: 'system' });
    await ws.write('sys:plugins', '/installed.json', { hang: { version: '1.0.0', name: 'Never starts', enabled: true, installed: 1, source: 'test' } }, { author: 'system' });
    store.close();
  }, files);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(`The plugin "hang" didn't start`)).toBeVisible({ timeout: 15_000 });
});

test('reinstalling a plugin that is running asks for a restart, which runs the new version', async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  // A new version: its code differs from what ran (the same files again start at once, with no restart).
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip('hello', '1.0.1') });
  await expect(page.getByText('Version 1.0.0 is installed now. Installing replaces it.')).toBeVisible();
  await page.getByRole('button', { name: 'Install', exact: true }).click();

  await expect(page.getByText('Restart annai to run the new version of Hello checks.')).toBeVisible();
  await page.getByRole('status').getByRole('button', { name: 'Restart annai' }).click();
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
});

test("a plugin that installs but won't start says so, and stays installed", async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'broken.zip', mimeType: 'application/zip', buffer: await fixtureZip('broken') });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText("Broken was installed, but it didn't start")).toBeVisible();
  await expect(page.getByText('Broken 0.0.1')).toBeVisible();
});
