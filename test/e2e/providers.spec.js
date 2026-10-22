import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, zipOf, savedBy, pickProvider, pickFile } from './helpers.js';

/** The version annai ships of an official plugin, read from its manifest. @param {string} id */
const shipped = async (id) => JSON.parse(await readFile(new URL(`../../plugins-official/${id}/annai-plugin.json`, import.meta.url), 'utf8')).version;

// Providers as plugins (milestone 1): a provider is one address and one key with several abilities;
// adding one installs its plugin and what it requires, from annai's catalog, with no question.

/** The ids of the secrets annai keeps, read through its own modules in the page. @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
const secretIds = (page) => page.evaluate(async () => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const ids = await store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.listSecretIds());
  store.close();
  return ids;
});
/** The plugins installed, by id. @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
const installedIds = (page) => page.evaluate(async () => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const store = await createIdbStore();
  const state = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
  store.close();
  return Object.keys(state ?? {}).sort();
});
/** Adds a provider from the Models screen, through the catalog, and waits for its page. @param {import('@playwright/test').Page} page @param {string} provider @param {string} [name] its page's title */
const add = (page, provider, name) => pickProvider(page, provider, name);
/** @param {import('@playwright/test').Page} page @param {string} heading */
const roleItems = (page, heading) => page.locator('.role', { has: page.getByRole('heading', { name: heading }) }).locator('.role-item > span');

test('adding OpenAI installs it and what it needs with no question; its page shows the key once, its abilities and their models; Remove takes the key, models, role entries, the plugin and the protocol plugins nothing else needs', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await add(page, 'OpenAI');
  // Nothing of OpenAI's is free, and it is the first provider: Main must not stay empty, so its recommended model goes in, and the page says it costs money.
  await expect(page.getByText(/^Main GPT-6\.1 Sol.*cost money/)).toBeVisible();
  expect(await installedIds(page)).toEqual(['openai-responses', 'provider-openai', 'speech-openai']);
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', 'not set');
  await expect(page.getByRole('link', { name: 'Get a key' })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  for (const [ability, on] of [['Chat (Responses)', true], ['Chat (Chat Completions)', false], ['Transcription', true], ['Voice', true]]) {
    const panel = page.getByRole('region', { name: /** @type {string} */ (ability), exact: true });
    await expect(panel.getByLabel(`Use ${ability}`)).toBeChecked({ checked: /** @type {boolean} */ (on) });
  }
  await expect(page.getByRole('region', { name: 'Chat (Responses)', exact: true }).getByRole('link', { name: /^GPT-6\.1 Sol/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Voice', exact: true }).getByRole('link', { name: /^OpenAI: GPT-4o mini TTS \(Marin\)/ })).toBeVisible();
  await page.getByLabel('API key').fill('sk-test-openai-123456');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  expect(await page.content()).not.toContain('sk-test-openai-123456');
  expect((await secretIds(page)).filter((s) => s.startsWith('llm:'))).toHaveLength(1);
  // Main has its model; its voice is behind the browser's, never ahead of it.
  await page.getByRole('link', { name: '← Models' }).click();
  await expect(page.getByText('1. GPT-6.1 Sol')).toBeVisible();
  await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(["1. Browser voice (the browser's own; some voices go online)", '2. OpenAI: GPT-4o mini TTS (Marin)']);
  // Remove: everything it brought goes.
  await page.locator('a.card', { hasText: 'OpenAI' }).click(); // the provider's card; the models in roles link too
  await expect(page.getByText('Removes its key, its models and their places in roles, and the OpenAI plugin, with OpenAI Responses and OpenAI-compatible speech, which nothing else needs.')).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove provider' });
  await remove.click();
  await page.getByRole('button', { name: 'Tap again to remove it' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page.getByText('No providers yet. Add one below.')).toBeVisible();
  await expect(page.getByText('No models yet. Add one.')).toBeVisible();
  await expect(roleItems(page, "Speech out: Shiori's voice")).toHaveText(["1. Browser voice (the browser's own; some voices go online)"]);
  // With no provider, Models offers the one-tap start again: only its provider's plugin, and what that needs, come back.
  await expect(page.getByRole('region', { name: 'Sign in' }).getByRole('button', { name: 'Sign in with OpenRouter' })).toBeVisible({ timeout: 30_000 });
  expect(await installedIds(page)).toEqual(['chat-completions', 'provider-openrouter', 'speech-openai']);
  expect((await secretIds(page)).filter((s) => s.startsWith('llm:'))).toEqual([]);
});

test('two OpenAI providers keep a key each; removing one keeps the other and the plugin', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  for (const [name, key] of [['OpenAI (work)', 'sk-test-work-1234567'], ['OpenAI (home)', 'sk-test-home-1234567']]) {
    await add(page, 'OpenAI');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await page.getByRole('link', { name: '← Models' }).click();
  }
  // The second one's models have names of their own.
  await page.getByRole('link', { name: /^OpenAI \(home\)/ }).click();
  await expect(page.getByRole('link', { name: /^GPT-6 Luna \(2\)/ })).toBeVisible();
  // It isn't the last of its plugin: the plugin stays.
  await expect(page.getByText('Removes its key, its models and their places in roles.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove provider' }).click();
  await page.getByRole('button', { name: 'Tap again to remove it' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Providers' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /^OpenAI \(work\)/ })).toBeVisible();
  expect(await installedIds(page)).toContain('provider-openai');
  expect((await secretIds(page)).filter((s) => s.startsWith('llm:'))).toHaveLength(1);
});

/** A third party's provider, data only, needing annai's Chat Completions, or a protocol of its own. @param {any[]} requires */
const kit = (requires) => zipOf({
  'annai-plugin.json': Buffer.from(JSON.stringify({
    id: 'trail-llm-kit', name: 'Trail LLM kit', version: '1.0.0', api: 1, description: 'A model provider for trails.', requires,
    provider: { baseUrl: 'https://llm.trails.example/v1', key: 'required', abilities: { chat: { kind: 'chat', type: 'chat-completions', models: [{ providerId: 'trail-1', name: 'Trail one' }] } } },
  })),
});

test("a third-party data-only provider from a file: the install screen says it can't run anything and where keys go, without the full-access words; one needing a third-party protocol that isn't installed can't be installed and names it", async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'trail-llm-kit.zip', mimeType: 'application/zip', buffer: await kit([{ id: 'acme-proto', version: '^2', homepage: 'https://acme.example/annai' }]) });
  await expect(page.getByRole('heading', { name: 'Install Trail LLM kit?' })).toBeVisible();
  await expect(page.getByText(/acme-proto, which isn't installed\. Install it from https:\/\/acme\.example\/annai first/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await pickFile(page, { name: 'trail-llm-kit.zip', mimeType: 'application/zip', buffer: await kit([{ id: 'chat-completions', version: '^0' }]) });
  await expect(page.getByText('A model provider · data only · version 1.0.0')).toBeVisible();
  await expect(page.getByText("It can't run anything: it is data that tells annai how to reach a model provider.")).toBeVisible();
  await expect(page.getByText('Keys you give this provider are sent to https://llm.trails.example.')).toBeVisible();
  await expect(page.getByText('It needs: Chat Completions (from annai, installed with it)')).toBeVisible();
  await expect(page.getByText('full access to your trips and API keys')).toHaveCount(0);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Trail LLM kit 1.0.0' })).toBeVisible({ timeout: 30_000 });
  expect(await installedIds(page)).toEqual(['chat-completions', 'trail-llm-kit']);
  await page.goto('/#/models');
  await add(page, 'Trail LLM kit');
  await expect(page.getByRole('link', { name: /^Trail one/ })).toBeVisible();
});

test('the Plugins page names the providers made from a provider plugin, and its Remove confirmation names them and what needs it', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  for (const name of ['OpenAI (work)', 'OpenAI (home)']) {
    await add(page, 'OpenAI');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Name', { exact: true }).blur();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await page.getByRole('link', { name: '← Models' }).click();
  }
  await page.goto('/#/plugins');
  // A provider plugin is under Model providers; protocol plugins are under Developer.
  await expect(page.getByRole('region', { name: 'Model providers' }).locator('.card')).toHaveCount(1);
  /** An installed plugin's row on Plugins, by the link its name is. @param {string} name */
  const installedRow = (name) => page.locator('.card', { has: page.getByRole('link', { name, exact: true }) });
  const row = installedRow(`OpenAI ${await shipped('provider-openai')}`);
  await expect(row).toContainText('Providers: OpenAI (work), OpenAI (home)');
  await expect(row).toContainText('Removing it removes OpenAI (work) and OpenAI (home), with their keys and models.');
  // A protocol plugin says what needs it.
  await expect(installedRow(`OpenAI Responses ${await shipped('openai-responses')}`)).toContainText('Needed by OpenAI.');
  await row.getByRole('button', { name: 'Remove' }).click();
  await row.getByRole('button', { name: 'Tap again to remove' }).click();
  await expect(installedRow(`OpenAI ${await shipped('provider-openai')}`)).toHaveCount(0);
  expect(await installedIds(page)).toEqual([]);
  await page.goto('/#/models');
  await expect(page.getByText('No providers yet. Add one below.')).toBeVisible();
  expect((await secretIds(page)).filter((s) => s.startsWith('llm:'))).toEqual([]);
});

test('moving over: endpoints from before providers, with their keys, are removed at the next start, and a card says so and opens Models', async ({ page }) => {
  await openApp(page, '#/trips');
  await waitForServiceWorker(page);
  // What a device had before: an endpoint with a model in main, and its key.
  await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:settings', '/llm/endpoints/ep-old.json', { id: 'ep-old', type: 'chat-completions', template: null, user: { name: 'My old router', baseUrl: 'https://router.example/v1' }, created: 1 }, { author: 'user' });
    await ws.write('sys:settings', '/llm/models/m-old.json', { id: 'm-old', endpoint: 'ep-old', template: null, user: { providerId: 'old-model' }, created: 1 }, { author: 'user' });
    await ws.write('sys:settings', '/llm/roles.json', { main: { models: ['m-old'], level: 'medium' } }, { author: 'user' });
    await store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('llm:ep-old', 'sk-old-endpoint-key-123'));
    store.close();
  });
  await page.reload();
  const card = page.locator('.notice', { hasText: 'Settings → Models changed' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Your endpoints (My old router) and their keys were removed. Add them again in Settings → Models.');
  await card.getByRole('button', { name: 'Open Models' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page.getByText('No providers yet. Add one below.')).toBeVisible();
  await expect(page.getByText('No models yet. Add one.')).toBeVisible();
  expect(await secretIds(page)).toEqual([]);
  // Once moved over, the next start says nothing.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page.locator('.notice', { hasText: 'Settings → Models changed' })).toHaveCount(0);
});

test("fix pass: an address typed without https:// isn't saved, on the provider and on an ability, and the words say what to type", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await add(page, 'Custom provider');
  await page.getByLabel('Address', { exact: true }).fill('llm.example.com/v1');
  await page.getByLabel('API key').fill('sk-test-typed-address-1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/llm\.example\.com\/v1 isn't a web address/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Address', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', 'not set');
  await page.getByLabel('Address', { exact: true }).fill('https://llm.example.com/v1');
  await page.getByLabel('API key').fill('sk-test-typed-address-1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  const voice = page.getByRole('region', { name: 'Voice', exact: true });
  await voice.getByLabel('Use Voice').check();
  await expect(savedBy(voice.getByLabel('Use Voice'))).toHaveText('Saved', { timeout: 30_000 });
  const own = voice.getByLabel('Its own address');
  await own.fill('http://192.168.1.5:8880/v1');
  await own.blur();
  await expect(voice.getByRole('alert')).toHaveText(/must start with https:\/\/ \(http:\/\/ only for localhost or 127\.0\.0\.1\)\. Browsers block plain http .* needs one\. Tailscale Serve can give it: tailscale serve --bg --https=8443 http:\/\/localhost:8880\. The server must also allow CORS from annai\.guide\./);
});

test("Add on a provider whose plugin the user turned off says so in words, with no plugin id in them (the emulator pass: \"provider-openrouter:\")", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await expect(page.getByRole('button', { name: 'Getting the sign-in ready…' })).toHaveCount(0, { timeout: 30_000 }); // OpenRouter's plugin, in the background
  await page.goto('/#/plugins/provider-openrouter');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await page.goto('/#/add?kind=providers&from=models');
  await page.getByLabel('Search the catalog').fill('OpenRouter');
  await page.getByRole('button', { name: /^Add (another )?OpenRouter$/ }).click();
  const card = page.locator('.notice', { hasText: "OpenRouter wasn't added" });
  await expect(card).toContainText('OpenRouter, which you turned off');
  await expect(card).not.toContainText('provider-openrouter');
});

test("a provider whose plugin is missing: annai's own is offered to install right there; another's is said plainly, with no plugin id (fixes-ui 16)", async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'llama.cpp');
  const providerUrl = page.url();
  /** Changes what annai keeps, through its own modules, then opens the provider's page again. @param {string} what */
  const change = async (what) => {
    await page.evaluate(async (what) => {
      const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
      const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
      const store = await createIdbStore();
      const ws = new Workspace(store);
      if (what === 'plugin') {
        const state = await ws.readJSON('sys:plugins', '/installed.json');
        delete state['provider-llamacpp'];
        delete state['chat-completions']; // its protocols too, as a restore leaves them
        delete state['speech-openai'];
        await ws.write('sys:plugins', '/installed.json', state, { author: 'system' });
      } else {
        for (const f of await ws.list('sys:settings', '/llm/providers/')) {
          const rec = await ws.readJSON('sys:settings', f.path);
          await ws.write('sys:settings', f.path, { ...rec, plugin: 'tide-pools-provider' }, { author: 'system' });
        }
      }
      store.close();
    }, what);
    await page.reload();
    await page.goto(providerUrl);
    await expect(page.getByRole('heading', { level: 1, name: 'llama.cpp' })).toBeVisible();
  };
  await change('plugin');
  const note = page.locator('.risk-note');
  await expect(note).toContainText("Its plugin, llama.cpp, isn't installed, so annai can't say what it offers.");
  await expect(note).not.toContainText('provider-llamacpp');
  // Nowhere on the page, either: the subtitle and each ability's protocol are named, never by plugin id (the second emulator re-check).
  const words = await page.locator('main').innerText();
  for (const id of ['provider-llamacpp', 'chat-completions', 'speech-openai', 'openai-transcription', 'openai-speech']) expect(words, id).not.toContain(id);
  await expect(page.getByText("This needs the Chat Completions plugin, which isn't running.")).toBeVisible();
  await page.getByRole('button', { name: 'Install it' }).first().click();
  await expect(page.locator('.risk-note')).toHaveCount(0, { timeout: 30_000 });
  await change('provider');
  await expect(note).toContainText("The plugin it was made from isn't on this device, and it isn't one of annai's own");
  await expect(note).not.toContainText('tide-pools-provider');
  await expect(page.getByRole('button', { name: 'Install it' })).toHaveCount(0);
});

test('review M1: a restored provider record naming a plugin of annai\'s that makes no model provider (Remote trace) offers no Install, and nothing is installed or sent', async ({ page, context }) => {
  /** @type {string[]} */
  const sent = [];
  await context.route('https://trace.evil.example/**', async (route) => {
    sent.push(route.request().url());
    await route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
  });
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'llama.cpp');
  const providerUrl = page.url();
  // What a crafted archive would restore: a provider record naming remote-trace, its settings and its token.
  await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (const f of await ws.list('sys:settings', '/llm/providers/')) {
      const rec = await ws.readJSON('sys:settings', f.path);
      await ws.write('sys:settings', f.path, { ...rec, plugin: 'remote-trace' }, { author: 'system' });
    }
    await ws.write('sys:settings', '/plugin-settings/remote-trace.json', { server: 'https://trace.evil.example/in', send: true, location: true }, { author: 'system' });
    await store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('plugin:remote-trace:token', 'attacker-token'));
    store.close();
  });
  await page.reload();
  await page.goto(providerUrl);
  await expect(page.locator('.risk-note')).toContainText("isn't one of annai's own providers");
  await expect(page.getByRole('button', { name: 'Install it' })).toHaveCount(0);
  const installed = await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const s = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
    store.close();
    return Object.keys(s ?? {});
  });
  expect(installed).not.toContain('remote-trace');
  expect(sent).toEqual([]);
});
