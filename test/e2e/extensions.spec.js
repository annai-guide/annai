import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { startModelServer, anthropicToolReply, fixtureFiles, zipOf, modelSetUp, pickFile, pickAddress, openApp, waitForServiceWorker, goToHash } from './helpers.js';
import { key } from '../../src/core/l10n.js';

/** The Japanese that ships. @type {Record<string, string>} */
const JA = JSON.parse(readFileSync(new URL('../../l10n/ja.json', import.meta.url), 'utf8'));

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
    await pickFile(page, { name: 'tide-pools.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('tide-pools'), 'tide-pools-main') });
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
    await pickAddress(page, `${site.origin}/kits/tide-pools/SKILL.md`);
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

test("8a-1: a key in a skill's address: the install screen shows «key», and nothing annai keeps holds the key", async ({ page }) => {
  const key = 'zap1a2b3c4d5e6f7g8h9';
  const skill = await fixtureFiles('tide-pools');
  const site = await startModelServer({ [`/s/${key}/tide-pools/SKILL.md`]: file(skill['SKILL.md'], 'text/markdown'), [`/s/${key}/tide-pools/references/safety.md`]: file(skill['references/safety.md'], 'text/markdown') });
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await pickAddress(page, `${site.origin}/s/${key}/tide-pools/SKILL.md`);
    await expect(page.getByText(`From 127.0.0.1:${new URL(site.origin).port}/s/«key»/tide-pools/SKILL.md`)).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('tide-pools 1.2')).toBeVisible();
    const kept = await page.evaluate(async () => {
      const at = (/** @type {string} */ p) => p;
      const { createIdbStore } = await import(at('/src/core/store-idb.js'));
      const store = await createIdbStore();
      const out = await store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
        const all = [];
        for (const s of await t.listScopes()) all.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
        for (const b of await t.listBlobs()) all.push(new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
        return all.join('\n');
      });
      store.close();
      return out;
    });
    expect(kept).toContain('tide-pools');
    expect(kept).not.toContain(key);
  } finally {
    await site.stop();
    await llm.stop();
  }
});

test('a code plugin from a zip and from an address, behind the full-trust screen: Cancel installs nothing; installed, its tool and its status chip work, again at once when the same files come back, and survive a reload', async ({ page }) => {
  const tides = await fixtureFiles('tides');
  const site = await startModelServer(Object.fromEntries(Object.entries(tides).map(([n, b]) => [`/kits/tides/${n}`, file(b, n.endsWith('.js') ? 'text/javascript' : 'application/json')])));
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'tide_times', input: {} }])),
    sse(anthropicToolReply([{ name: 'show', input: { card: { title: 'Tides', text: 'Low 05:40, high 11:52.' } } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await pickFile(page, { name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(tides) });
    await expect(page.getByRole('heading', { name: 'Install Tides?' })).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await expect(page.getByText('Code that runs in annai')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toHaveCount(0);
    const chips = page.getByRole('navigation', { name: 'Shiori' });
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
    // From a zip, installed: its status chip appears (spec §16.4); then removed.
    await pickFile(page, { name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(tides) });
    await page.getByRole('button', { name: 'Install anyway' }).click();
    await expect(chips.getByText('Tide 1.0.0')).toBeVisible();
    await page.locator('.card', { hasText: 'Tides 1.0.0' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('.card', { hasText: 'Tides 1.0.0' }).getByRole('button', { name: 'Tap again to remove' }).click();
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
    await expect(page.getByText('Tides 1.0.0', { exact: true })).toHaveCount(0); // the list drawn again: its field is the new one
    // From an address: the same files as the code that ran this session, so it starts at once (other files would wait for a restart).
    await pickAddress(page, `${site.origin}/kits/tides/annai-plugin.json`);
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
    await page.getByRole('button', { name: 'Install anyway' }).click();
    await expect(chips.getByText('Tide 1.0.0')).toBeVisible();
    await expect(page.getByText('Restart annai to run the new version of Tides.')).toHaveCount(0);
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
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'tide_times', input: {} }])), sse(anthropicToolReply([{ name: 'show', input: { card: { title: 'Tides', text: 'Low 05:40.' } } }, { name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await pickAddress(page, `${site.origin}/kits/tides/annai-plugin.json`);
    await page.getByRole('button', { name: 'Install anyway' }).click();
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

// Outside words end as sentences at the source (sentences-next): on Japanese screens the failed-updates card keeps the space a Latin end
// has before the next plugin's name ("…use it. rock-pools：…", not "it.rock-pools"). The words here are annai's own and end in "." already;
// the ending of words with no stop of their own is pinned by the unit tests (a browser can't make a plugin throw words of its own here).
for (const [locale, words] of /** @type {[string, Record<string, string> | null][]} */ ([['en-US', null], ['ja-JP', JA]])) {
  test.describe(`on ${locale} screens`, () => {
    test.use({ locale });
    test("two updates that fail share one card, and a Latin end keeps its space before the next plugin's name", async ({ page }) => {
      const say = (/** @type {string} */ en) => words?.[key(en)] ?? en;
      const skill = (await fixtureFiles('tide-pools'))['SKILL.md'].toString();
      const as = (/** @type {string} */ name, /** @type {string} */ version, described = true) => file(Buffer.from(skill.replace('name: tide-pools', `name: ${name}`)
        .replace('version: "1.2"', `version: "${version}"`).replace(/^description: .*\n/m, described ? '$&' : '').replace(/\[the safety notes\]\([^)]*\)/, 'the safety notes')), 'text/markdown');
      /** @type {Record<string, any>} */
      const routes = { '/kits/tide-pools/SKILL.md': as('tide-pools', '1.2'), '/kits/rock-pools/SKILL.md': as('rock-pools', '1.2') };
      const site = await startModelServer(routes);
      try {
        await openApp(page, '#/add');
        await waitForServiceWorker(page);
        for (const name of ['tide-pools', 'rock-pools']) {
          await goToHash(page, '#/add'); // as pickAddress does, in the screens' language
          await page.locator('#plugin-address').fill(`${site.origin}/kits/${name}/SKILL.md`);
          await page.locator('#plugin-address').press('Enter');
          await page.locator('.plugin-install .acts .btn.pri').click();
          await expect(page.getByText(`${name} 1.2`, { exact: true })).toBeVisible();
        }
        // A new version of each is offered; by the tap on Update, each address serves one annai can't read (no description).
        routes['/kits/tide-pools/SKILL.md'] = as('tide-pools', '1.3');
        routes['/kits/rock-pools/SKILL.md'] = as('rock-pools', '1.3');
        await page.reload();
        await expect(page.getByText(say('Plugin updates are ready'))).toBeVisible({ timeout: 30_000 });
        routes['/kits/tide-pools/SKILL.md'] = as('tide-pools', '1.3', false);
        routes['/kits/rock-pools/SKILL.md'] = as('rock-pools', '1.3', false);
        await page.getByRole('status').getByRole('button', { name: say('Update'), exact: true }).first().click();
        const body = page.locator('section.notice', { hasText: say("Some plugins weren't updated") }).locator('p').first();
        await expect(body).toBeVisible();
        const why = 'SKILL.md needs a description: what the skill is for and when to use it.';
        const colon = words ? '：' : ': ';
        await expect(body).toHaveText(`tide-pools${colon}${why} rock-pools${colon}${why}`);
      } finally {
        await site.stop();
      }
    });
  });
}

test('a package without code brings a skill and a personality; Settings → Shiori offers the personality to add', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await pickFile(page, { name: 'trail-kit.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('trail-kit')) });
    await expect(page.getByText('Skill "trail-safety": Before a hike - water, light, and telling someone where you go.')).toBeVisible();
    await expect(page.getByText('Personality "ranger"')).toBeVisible();
    await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('Trail kit 1.0.0', { exact: true })).toBeVisible();
    await page.goto('/#/shiori');
    await expect(page.getByText('ranger (from Trail kit)')).toBeVisible();
    // The Personality section's Add (the Languages section has its own).
    await page.getByRole('region', { name: 'Personality', exact: true }).getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('radio', { name: 'ranger' })).toBeVisible();
  } finally {
    await llm.stop();
  }
});

test("8a-5: a new version of a code plugin that is off stays off, and its code doesn't run", async ({ page }) => {
  const tides = await fixtureFiles('tides');
  const llm = await startModelServer({ '/b/v1/messages': [sse(anthropicToolReply([{ name: 'sleep', input: {} }]))] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/plugins');
    const chips = page.getByRole('navigation', { name: 'Shiori' });
    await pickFile(page, { name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(tides) });
    await page.getByRole('button', { name: 'Install anyway' }).click();
    await expect(chips.getByText('Tide 1.0.0')).toBeVisible();
    await page.locator('.card', { hasText: 'Tides 1.0.0' }).getByRole('button', { name: 'Turn off' }).click();
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
    await page.reload(); // its code hasn't run since
    await expect(page.locator('.card', { hasText: 'Tides 1.0.0' }).getByRole('button', { name: 'Turn on' })).toBeVisible();
    const next = { ...tides, 'annai-plugin.json': Buffer.from(JSON.stringify({ ...JSON.parse(tides['annai-plugin.json'].toString()), version: '1.0.1' })) };
    await pickFile(page, { name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf(next) });
    await page.getByRole('button', { name: 'Install anyway' }).click();
    await expect(page.locator('.card', { hasText: 'Tides 1.0.1' }).getByRole('button', { name: 'Turn on' })).toBeVisible();
    await expect(chips.getByText('Tide 1.0.0')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});
