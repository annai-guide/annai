import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, fixtureFiles, zipOf, modelSetUp } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const file = (/** @type {Buffer} */ body, type = 'text/plain') => ({ status: 200, type, body });

/** What annai stores for a package: files and their history in sys:plugins. @param {any} page @param {string} id */
async function storedFor(page, id) {
  return page.evaluate(async (id) => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const store = await createIdbStore();
    const out = await store.tx(['files', 'events'], 'readonly', async (/** @type {any} */ t) => ({
      files: (await t.listFiles('sys:plugins', `/${id}/`)).length,
      history: (await t.listEvents('sys:plugins', { types: ['file.write', 'file.delete'] })).filter((/** @type {any} */ e) => String(e.data?.path).startsWith(`/${id}/`)).length,
    }));
    store.close();
    return out;
  }, id);
}

test('a skill from a zip: the install screen says what a skill is; Shiori sees only its name and description, loads it and one of its files; Remove removes it', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'skill', input: { name: 'tide-pools' } }])),
    sse(anthropicToolReply([{ name: 'skill', input: { name: 'tide-pools', file: 'references/safety.md' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Go an hour before low tide.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Install from a file').setInputFiles({ name: 'tide-pools.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('tide-pools'), 'tide-pools-main') });
    await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible();
    await expect(page.getByText('A skill is instructions for Shiori')).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toHaveCount(0);
    await expect(page.getByText('by Example Trails')).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('tide-pools 1.2')).toBeVisible();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Are the tide pools safe now?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Go an hour before low tide.');
    const [first, second, third] = llm.bodies('/b/v1/messages').map((b) => JSON.stringify(b));
    expect(first).toContain('tide-pools: When the user asks about tide pools - how to read a tide table, and when the pools are safe to visit.');
    expect(first).not.toContain('Pools are safest from an hour before low tide');
    expect(first).not.toContain('Example Trails');
    expect(first).not.toContain('CC-BY-4.0');
    expect(second).toContain('Pools are safest from an hour before low tide');
    expect(second).toContain('references/safety.md');
    expect(third).toContain('never turn your back on the ocean');
    await page.goto('/#/plugins');
    await page.locator('.card', { hasText: 'tide-pools 1.2' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Tap again to remove' }).click();
    await expect(page.getByText('tide-pools 1.2')).toHaveCount(0);
    expect(await storedFor(page, 'tide-pools')).toEqual({ files: 0, history: 0 });
  } finally {
    await llm.stop();
  }
});

test('a skill from an address, with the file it links to', async ({ page }) => {
  const skill = await fixtureFiles('tide-pools');
  const site = await startModelServer({ '/kits/tide-pools/SKILL.md': file(skill['SKILL.md'], 'text/markdown'), '/kits/tide-pools/references/safety.md': file(skill['references/safety.md'], 'text/markdown') });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tide-pools/SKILL.md`);
    await page.getByRole('button', { name: 'Get it' }).click();
    await expect(page.getByRole('heading', { name: 'Install tide-pools?' })).toBeVisible();
    await expect(page.getByText(`From 127.0.0.1:${new URL(site.origin).port}/kits/tide-pools/SKILL.md`)).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('tide-pools 1.2')).toBeVisible();
    expect(await storedFor(page, 'tide-pools')).toEqual({ files: 2, history: 0 });
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('a code plugin from a zip and from an address, behind the full-trust screen: Cancel installs nothing; installed, its tool and its status chip work and survive a reload', async ({ page }) => {
  const tides = await fixtureFiles('tides');
  const site = await startModelServer(Object.fromEntries(Object.entries(tides).map(([n, b]) => [`/kits/tides/${n}`, file(b, n.endsWith('.js') ? 'text/javascript' : 'application/json')])));
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'tide_times', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Install from a file').setInputFiles({ name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(tides) });
    await expect(page.getByRole('heading', { name: 'Install Tides?' })).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await expect(page.getByText('Code that runs in annai')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toHaveCount(0);
    const chips = page.getByRole('navigation', { name: 'Shiori' });
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
    // From a zip, installed: its status chip appears (spec §16.4); then removed.
    await page.getByLabel('Install from a file').setInputFiles({ name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(tides) });
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(chips.getByText('Tide 1.0.0')).toBeVisible();
    await page.locator('.card', { hasText: 'Tides 1.0.0' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('.card', { hasText: 'Tides 1.0.0' }).getByRole('button', { name: 'Tap again to remove' }).click();
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toHaveCount(0); // the list drawn again: its field is the new one
    // From an address: its code ran this session already, so it runs from the next start.
    await page.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tides/annai-plugin.json`);
    await page.getByRole('button', { name: 'Get it' }).click();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('Restart annai to run the new version of Tides.')).toBeVisible();
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toBeVisible();
    await page.reload();
    // Installed plugins start after the first screen; the Plugins screen redraws once they have.
    await expect(page.locator('.card', { hasText: 'Tides 1.0.0' }).getByText('On', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(chips.getByText('Tide 1.0.0')).toBeVisible();
    await page.goto('/#/tools');
    await expect(page.getByRole('checkbox', { name: 'tide_times', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Tides today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Tides 1.0.0: low 05:40, high 11:52');
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('an update from an address is offered after a reload and changes nothing until Update; then the new code runs after the restart', async ({ page }) => {
  const tides = await fixtureFiles('tides');
  /** @type {Record<string, any>} */
  const routes = Object.fromEntries(Object.entries(tides).map(([n, b]) => [`/kits/tides/${n}`, file(b, n.endsWith('.js') ? 'text/javascript' : 'application/json')]));
  const site = await startModelServer(routes);
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'tide_times', input: {} }])), sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Address of a plugin or skill').fill(`${site.origin}/kits/tides/annai-plugin.json`);
    await page.getByRole('button', { name: 'Get it' }).click();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toBeVisible();
    routes['/kits/tides/annai-plugin.json'] = file(Buffer.from(tides['annai-plugin.json'].toString().replace('"1.0.0"', '"1.1.0"')), 'application/json');
    routes['/kits/tides/lib.js'] = file(Buffer.from(tides['lib.js'].toString().replace("'1.0.0'", "'1.1.0'")), 'text/javascript');
    await page.reload();
    await expect(page.getByText('Plugin updates are ready')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Tides 1.0.0 → 1.1.0')).toBeVisible();
    // Offered on the card and on Plugins (where the page is); nothing has changed yet.
    const chips = page.getByRole('navigation', { name: 'Shiori' });
    await expect(chips.getByText('Tide 1.0.0')).toBeVisible();
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update to 1.1.0' })).toBeVisible();
    await page.getByRole('status').getByRole('button', { name: 'Update', exact: true }).first().click();
    await expect(page.getByText('Restart annai to use the new versions')).toBeVisible();
    await page.getByRole('status').getByRole('button', { name: 'Restart now' }).click();
    await expect(page.getByText('Tides 1.1.0', { exact: true })).toBeVisible();
    await expect(chips.getByText('Tide 1.1.0')).toBeVisible();
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Tides today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Tides 1.1.0: low 05:40');
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('a package without code brings a skill and a personality; Settings → Shiori offers the personality to add', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    await page.getByLabel('Install from a file').setInputFiles({ name: 'trail-kit.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('trail-kit')) });
    await expect(page.getByText('Skill "trail-safety": Before a hike - water, light, and telling someone where you go.')).toBeVisible();
    await expect(page.getByText('Personality "ranger"')).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('Trail kit 1.0.0', { exact: true })).toBeVisible();
    await page.goto('/#/shiori');
    await expect(page.getByText('ranger (from Trail kit)')).toBeVisible();
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('radio', { name: 'ranger' })).toBeVisible();
  } finally {
    await llm.stop();
  }
});
