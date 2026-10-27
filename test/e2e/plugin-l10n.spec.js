import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';

// Plugins speak the screens' language (localization L7): a third party's plugin with Japanese shows its words in Japanese on Japanese
// screens; one without shows its own words, marked English. Its name is shown as written (decision 10).

/** A plugin fixture from test/fixtures/plugins as a zip, with its translations. @param {string} dir @param {string[]} names */
async function fixtureZip(dir, names) {
  const z = new ZipWriter();
  for (const name of names) await z.add(`${dir}/${name}`, new Uint8Array(await readFile(new URL(`../fixtures/plugins/${dir}/${name}`, import.meta.url))));
  return Buffer.from(await z.finish().arrayBuffer());
}

test.describe('on Japanese screens', () => {
  test.use({ locale: 'ja-JP' });

  test("a plugin with Japanese shows its description and settings in it; one without, its own words marked English", async ({ page }) => {
    await openApp(page, '#/add');
    await waitForServiceWorker(page);
    await expect(page.locator('html')).toHaveAttribute('lang', /^ja/);
    for (const [dir, names, words] of /** @type {[string, string[], string][]} */ ([
      ['tides', ['annai-plugin.json', 'index.js', 'l10n/ja.json'], '今いる海岸の潮汐表。'],
      ['hello', ['annai-plugin.json', 'index.js'], 'Test plugin: /hello/*.json files in a trip need a greeting.'],
    ])) {
      // Add's own heading: Plugins, the screen the install ends on, has a finder too.
      await expect(page.getByRole('heading', { level: 1, name: '追加' })).toBeVisible();
      await page.locator('#plugin-file').setInputFiles({ name: `${dir}.zip`, mimeType: 'application/zip', buffer: await fixtureZip(dir, names) });
      // The install screen: its name as written, its description in its words.
      await expect(page.locator('.plugin-install h1')).toContainText(dir === 'tides' ? 'Acme Tides' : 'Hello checks');
      const desc = page.locator('.plugin-install p', { hasText: words });
      await expect(desc).toBeVisible();
      expect(await desc.getAttribute('lang')).toBe(dir === 'tides' ? null : 'en');
      await page.locator('.plugin-install .acts .btn.pri').click();
      await expect(page).toHaveURL(/#\/plugins$/);
      await expect(page.getByRole('heading', { level: 1, name: 'プラグイン' })).toBeVisible();
      await page.goto('/#/add');
      await expect(page.getByRole('heading', { level: 1, name: '追加' })).toBeVisible();
    }
    // The Add screen: the translated description, searchable by its Japanese keyword; the other's English, marked.
    const tides = page.locator('li.card', { hasText: 'Acme Tides' });
    await expect(tides.locator('p.sub')).toHaveText('今いる海岸の潮汐表。');
    expect(await tides.locator('p.sub').getAttribute('lang')).toBeNull();
    await expect(page.locator('li.card', { hasText: 'Hello checks' }).locator('p.sub').first()).toHaveAttribute('lang', 'en');
    await page.locator('.finder input[type="search"]').fill('潮汐');
    await expect(page.locator('li.card', { hasText: 'Acme Tides' })).toBeVisible();
    await expect(page.locator('li.card', { hasText: 'Hello checks' })).toHaveCount(0);
    // Its page: settings in its words, a choice by its title; its own page's title and words from annai.l10n.
    await page.goto('/#/plugins/acme-tides');
    await expect(page.locator('.field-label', { hasText: '観測地点' })).toBeVisible();
    await expect(page.locator('select option', { hasText: '基本' })).toHaveAttribute('value', 'basic');
    await page.locator('a', { hasText: '潮汐表' }).click();
    await expect(page.locator('h1')).toHaveText('潮汐表');
    await expect(page.locator('.ext-body')).toHaveText('4:12に干潮。');
    await page.goto('/#/plugins/hello');
    await expect(page.locator('p[lang="en"]', { hasText: 'Test plugin' })).toBeVisible();
  });

  test("annai's own plugins on Add are in Japanese, their descriptive names too; a brand's name stays as written", async ({ page }) => {
    await openApp(page, '#/add');
    const custom = page.locator('li.card', { hasText: 'カスタムプロバイダー' });
    await expect(custom.locator('p.sub').first()).toContainText('そのほかのあらゆるサーバー');
    expect(await custom.locator('p.sub').first().getAttribute('lang')).toBeNull();
    await expect(page.locator('li.card', { hasText: 'Mistral' }).locator('p.sub').first()).toHaveText('Mistral のモデル。');
    // Its Japanese keywords find it too.
    await page.locator('.finder input[type="search"]').fill('セルフホスト');
    await expect(page.locator('li.card', { hasText: 'SearXNG 検索' })).toBeVisible();
    // Custom provider's own Add page names it in Japanese too (the ja draft review found its English name there).
    await waitForServiceWorker(page);
    await page.locator('.finder input[type="search"]').fill('');
    await custom.locator('.acts button').click();
    await expect(page.getByRole('heading', { level: 1, name: 'カスタムプロバイダー' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Custom provider')).toHaveCount(0);
  });

  test("OpenRouter's sign-in on Models speaks Japanese (the draft review found it in English)", async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Safari on an iPhone sets a model up in the Home Screen app');
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await expect(page.getByText('すると、1つのキーで多くのモデルを使えます。', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'OpenRouter でサインイン' })).toBeVisible();
  });
});
