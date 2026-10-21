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
  // The same reason once, naming every provider it holds back (review R4).
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0], /^(OpenRouter, Google Gemini|Google Gemini, OpenRouter): annai's list of plugins couldn't be loaded\. Check the connection and try again\.$/);
  assert.doesNotMatch(first.failed.join(' '), /catalog:/);
  online = true;
  const second = await llm.restorePlugins();
  assert.deepEqual(second.failed, []);
  assert.ok(second.installed.length >= 4);
});

// Review R1: a restored record names the plugin it comes from, and a crafted archive may name any catalog plugin.
test("a restored record naming a plugin that isn't a model provider (remote-trace) installs nothing, and says so", async () => {
  const { b, llm } = await restored();
  await addProvider({ ws: b.ws, store: b.store }, { ...structuredClone(ROUTER_SRC), plugin: 'remote-trace', name: 'Trace' }, { key: 'sk-r', roles: null });
  const got = await llm.restorePlugins();
  assert.equal((await b.host.installed())['remote-trace'], undefined, 'remote-trace is never installed by a restore');
  assert.equal(got.failed.length, 1);
  assert.match(got.failed[0], /^Trace: /);
  assert.doesNotMatch(got.failed[0], /remote-trace/);
  assert.ok(Object.keys(await b.host.installed()).includes('provider-openrouter'), 'the real providers still come');
});

test('a plugin the restore installed that then provides no provider is removed again', async () => {
  const { b, llm } = await restored();
  // A record that names a real provider plugin, whose provider then doesn't come up (as a crafted record could arrange).
  const before = new Set(Object.keys(await b.host.installed()));
  const orig = b.host.start.bind(b.host);
  b.host.start = async (/** @type {string} */ id) => { if (id !== 'provider-gemini') await orig(id); };
  const got = await llm.restorePlugins();
  b.host.start = orig;
  const now = Object.keys(await b.host.installed());
  assert.ok(!now.includes('provider-gemini'), 'the plugin that brought no provider went');
  assert.ok(!got.installed.includes('Google Gemini'));
  assert.equal(got.failed.length, 1);
  assert.ok(before.size === 0 && now.includes('provider-openrouter'));
});

// Review R3: with "Replace my plugins" ticked, the import itself switched every plugin off, and says so.
test("plugins the import brought switched off are left as they came, with no line saying the user turned them off", async () => {
  const { a, b, llm } = await restored();
  const llmB = llm;
  for (const id of Object.keys(await a.host.installed())) {
    const files = new Map();
    for (const f of await a.ws.list('sys:plugins', `/${id}/`)) files.set(f.path.slice(id.length + 2), /** @type {any} */ (await a.ws.read('sys:plugins', f.path)).bytes);
    await b.host.install(files, { source: 'official' });
    await b.host.setEnabled(id, false);
  }
  const got = await llmB.restorePlugins({ imported: true });
  assert.deepEqual(got, { installed: [], failed: [] });
  assert.ok(Object.values(await b.host.installed()).every((x) => x.enabled === false), 'none switched on');
  // Not from this import, a plugin the user turned off is named, as before.
  const mine = await llmB.restorePlugins();
  assert.match(mine.failed.join(' '), /which you turned off/);
});
