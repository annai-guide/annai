import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, fixtureFiles, zipOf, modelSetUp } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** Installs a package from a zip through Settings → Plugins and its install screen. @param {any} page @param {Buffer} zip @param {string} name */
export async function install(page, zip, name) {
  await page.goto('/#/plugins');
  await page.getByLabel('Install from a file').setInputFiles({ name: `${name}.zip`, mimeType: 'application/zip', buffer: zip });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('.card', { hasText: name }).getByText('On', { exact: true })).toBeVisible();
}

test("a plugin's slots, plan row, screen and theme appear, and go when it is turned off (spec §16.4)", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.evaluate(async (trip) => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const store = await createIdbStore();
      await new Workspace(store).write(trip, '/plan/falls.json', { id: 'falls', title: 'Pfeiffer Falls', kind: 'sight', fixed: false, priority: 1, start: { at: '2030-11-27T10:00:00-08:00', tz: 'America/Los_Angeles' } }, { author: 'user' });
      store.close();
    }, trip);
    await install(page, await zipOf(await fixtureFiles('trail-ui')), 'Trail UI');
    const dock = page.getByRole('navigation', { name: 'Shiori' });
    await expect(dock.getByText('Trail ok')).toBeVisible();
    await dock.getByRole('button', { name: 'Trail check' }).click();
    await expect(page.getByText('Trail checked')).toBeVisible();
    const main = page.getByRole('navigation', { name: 'Main' });
    await main.getByRole('link', { name: 'Hike' }).click();
    await expect(page.getByText('Hike screen')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ai').trim())).toBe('rgb(0, 128, 96)');
    await page.goto('/#/now');
    await expect(page.getByRole('region', { name: 'Trail' }).getByText('Trail section')).toBeVisible();
    await expect(page.getByText('Pfeiffer Falls (trail row)')).toBeVisible();
    await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
    await page.getByRole('link', { name: 'Trail log' }).click();
    await expect(page.getByText(`Trail log for ${trip}`)).toBeVisible();
    await page.goto('/#/settings');
    await page.getByRole('link', { name: /Trail settings/ }).click();
    await expect(page.getByText('Trail settings page')).toBeVisible();
    // A write the app makes (a tool switch) reaches the plugin's hook.
    await page.goto('/#/tools');
    await page.getByRole('checkbox', { name: 'fetch', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__trailWrites ?? 0)).toBeGreaterThan(0);
    await page.goto('/#/plugins');
    await page.locator('.card', { hasText: 'Trail UI' }).getByRole('button', { name: 'Turn off' }).click();
    await expect(dock.getByText('Trail ok')).toHaveCount(0);
    await expect(main.getByRole('link', { name: 'Hike' })).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ai').trim())).not.toBe('rgb(0, 128, 96)');
  } finally {
    await llm.stop();
  }
});

test("a plugin can replace the avatar, the Now card and the dock; turned off, annai's own come back", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await install(page, await zipOf(await fixtureFiles('trail-look')), 'Trail look');
    const dock = page.getByRole('navigation', { name: 'Shiori' });
    await expect(dock.getByRole('button', { name: 'Talk to Shiori' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Type' })).toHaveCount(0);
    await page.goto('/#/now');
    await expect(page.getByText('Trail Now card: Big Sur')).toBeVisible();
    await page.goto('/#/plugins');
    await page.locator('.card', { hasText: 'Trail look' }).getByRole('button', { name: 'Turn off' }).click();
    await expect(dock.getByRole('button', { name: 'Type' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Talk to Shiori' })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("a status chip that throws doesn't break the dock; it counts against its plugin", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    const broken = {
      'annai-plugin.json': Buffer.from(JSON.stringify({ id: 'chip-breaks', name: 'Chip breaks', version: '1.0.0', api: 1, entry: 'index.js' })),
      'index.js': Buffer.from("export function activate(annai) { return annai.ui.slot('status-chip', { id: 'boom', render: () => { throw new TypeError('chip broke'); } }); }"),
    };
    await install(page, await zipOf(broken), 'Chip breaks');
    await expect(page.getByRole('navigation', { name: 'Shiori' }).getByRole('button', { name: 'Type' })).toBeVisible();
    await page.goto('/#/trace?kind=Plugins');
    await expect(page.getByText(/chip broke/).first()).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test("Shiori shows a plugin's kind of card: the plugin draws it, and its label names the kind", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'show', input: { card: { type: 'trail', data: { name: 'Pfeiffer Falls' } } } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await install(page, await zipOf(await fixtureFiles('trail-ui')), 'Trail UI');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Show me the falls');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .trail-card')).toHaveText('Trail: Pfeiffer Falls');
    await expect(page.locator('.convo .who').last()).toHaveText('SHIORI · TRAIL');
  } finally {
    await llm.stop();
  }
});

test("a plugin's page saves the settings its schema asks for; a secret is kept as one and never shown", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await install(page, await zipOf(await fixtureFiles('trail-ui')), 'Trail UI');
    await page.getByRole('link', { name: 'Trail UI' }).click();
    await expect(page.getByRole('heading', { name: 'Trail UI' })).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await page.getByLabel('Trailhead').fill('Pfeiffer Big Sur');
    await page.getByLabel('Token').fill('trail-secret-123456');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Trailhead')).toHaveValue('Pfeiffer Big Sur');
    await expect(page.getByLabel('Token')).toHaveAttribute('placeholder', 'saved');
    expect(await page.content()).not.toContain('trail-secret-123456');
    const stored = await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const { Workspace } = await import(at('/src/core/workspace.js'));
      const store = await createIdbStore();
      const out = { file: await new Workspace(store).readText('sys:settings', '/plugin-settings/trail-ui.json'), secret: await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('plugin:trail-ui:token')) };
      store.close();
      return out;
    });
    expect(stored.file).toContain('Pfeiffer Big Sur');
    expect(stored.file).not.toContain('trail-secret-123456');
    expect(stored.secret).toBe('trail-secret-123456');
  } finally {
    await llm.stop();
  }
});
