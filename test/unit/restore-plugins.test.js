import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SYS_SETTINGS } from '../../src/core/scopes.js';
import { createLlm } from '../../src/core/llm/service.js';
import { addProvider } from '../../src/core/llm/providers.js';
import { hostKit } from './package-kit.js';
import { ROUTER_SRC } from './provider-kit.js';

// The emulator pass (m9 #20): a restore brought the providers back with the settings, but not the plugins they
// need, and the providers' pages led to a dead end (shot 310).
const root = new URL('../../', import.meta.url);
/** annai's own catalog and plugins, from the repository. @param {any} url */
const fromRepo = async (url) => {
  try {
    return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
  } catch {
    return new Response('not found', { status: 404 });
  }
};

/** A device whose settings were restored from one with these providers, as an import that replaces settings leaves it. */
async function restored() {
  const a = await hostKit();
  const llmA = createLlm({ store: a.store, ws: a.ws, plugins: a.host, fetch: fromRepo });
  await llmA.addProvider('provider-openrouter', { key: 'sk-or-v1-stand-in', roles: 'free' });
  await llmA.addProvider('provider-gemini', { key: 'AIza-stand-in' });
  const b = await hostKit();
  for (const f of await a.ws.list(SYS_SETTINGS, '/')) {
    const got = await a.ws.read(SYS_SETTINGS, f.path);
    if (got) await b.ws.write(SYS_SETTINGS, f.path, got.bytes, { author: 'system', type: f.type });
  }
  return { a, b, llm: createLlm({ store: b.store, ws: b.ws, plugins: b.host, fetch: fromRepo }) };
}

test('a restore that brought providers installs, in one step, the plugins they and their abilities use', async () => {
  const { a, b, llm } = await restored();
  assert.deepEqual(Object.keys(await b.host.installed()), []);
  assert.deepEqual(llm.providers(), [], 'no provider is running before');
  const got = await llm.restorePlugins();
  assert.deepEqual(got.failed, []);
  assert.deepEqual(Object.keys(await b.host.installed()).sort(), Object.keys(await a.host.installed()).sort());
  assert.deepEqual(got.installed.slice().sort(), Object.values(await b.host.installed()).map((s) => s.name).sort());
  assert.deepEqual(llm.providers().map((p) => p.plugin).sort(), ['provider-gemini', 'provider-openrouter']);
  // Again, nothing more to do.
  assert.deepEqual(await llm.restorePlugins(), { installed: [], failed: [] });
});

test("a restored provider whose plugin isn't annai's own is named, with what to do, and the rest still come", async () => {
  const { b, llm } = await restored();
  await addProvider({ ws: b.ws, store: b.store }, structuredClone(ROUTER_SRC), { key: 'sk-r', roles: null });
  const got = await llm.restorePlugins();
  assert.equal(got.failed.length, 1);
  assert.match(got.failed[0], /^Router: its plugin isn't annai's own\./);
  assert.doesNotMatch(got.failed[0], /provider-router/, 'no internal id on screen');
  assert.ok(Object.keys(await b.host.installed()).includes('provider-openrouter'));
});

test('a restore offline says the providers whose plugins are missing, and a second try installs them', async () => {
  const { b } = await restored();
  let online = false;
  const llm = createLlm({ store: b.store, ws: b.ws, plugins: b.host, fetch: (/** @type {any} */ url) => (online ? fromRepo(url) : Promise.reject(new TypeError('Failed to fetch'))) });
  const first = await llm.restorePlugins();
  assert.equal(first.failed.length, 2);
  assert.match(first.failed.join(' '), /couldn't be loaded\. Check the connection and try again\./);
  assert.doesNotMatch(first.failed.join(' '), /catalog:/);
  online = true;
  const second = await llm.restorePlugins();
  assert.deepEqual(second.failed, []);
  assert.ok(second.installed.length >= 4);
});
