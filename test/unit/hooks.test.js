import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { watchAppends, deliverHooks } from '../../src/core/hooks.js';
import { Registry } from '../../src/core/registry.js';
import { SYS } from '../../src/core/scopes.js';
import { files, hostKit } from './package-kit.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a watched store reports the entries a write appended, once it committed, and nothing for one that failed', async () => {
  /** @type {any[][]} */
  const seen = [];
  const store = watchAppends(createMemoryStore(), (evs) => seen.push(evs));
  await store.tx(['events'], 'readwrite', async (t) => {
    await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' });
    await t.appendEvent('a', { ts: 2, type: 'y', actor: 'user' });
  });
  await assert.rejects(store.tx(['events'], 'readwrite', async (t) => {
    await t.appendEvent('a', { ts: 3, type: 'z', actor: 'user' });
    throw new Error('no');
  }));
  await store.tx(['events'], 'readonly', (t) => t.listEvents('a'));
  assert.deepEqual(seen.map((evs) => evs.map((e) => [e.seq, e.type])), [[[1, 'x'], [2, 'y']]]);
});

test("hooks: a plugin's hook gets frozen copies of what is appended, of the types it asked for, never its own", async () => {
  const { host, ws, log } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'watcher', name: 'Watcher', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      globalThis.__seen = [];
      return annai.hooks.on(async (e) => {
        globalThis.__seen.push(e.type);
        try { e.data.path = 'changed'; } catch { globalThis.__seen.push('frozen'); }
        await annai.events.append('sys', 'watcher.saw', { type: e.type });
      }, { types: ['file.write', 'watcher.saw'] });
    }`,
  }));
  await host.start('watcher');
  await ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  await settle();
  await settle();
  const g = /** @type {any} */ (globalThis);
  assert.deepEqual(g.__seen, ['file.write', 'frozen']);
  assert.equal((await log()).filter((e) => e.type === 'watcher.saw').length, 1); // its own entry didn't come back to it
  const [write] = await ws.store.tx(['events'], 'readonly', (t) => t.listEvents('me', { types: ['file.write'], reverse: true, limit: 1 }));
  assert.equal(write.data.path, '/notes/a.md');
});

test('hooks: a hook that throws counts against its plugin, and the others still run', async () => {
  const registry = new Registry();
  /** @type {string[]} */
  const got = [];
  registry.add('bad', 'hook', { fn: () => { throw new TypeError('boom'); } });
  registry.add('good', 'hook', { fn: (/** @type {any} */ e) => { got.push(e.type); } });
  for (let i = 0; i < 3; i++) deliverHooks(registry, [{ scope: SYS, seq: i + 1, ts: 1, type: 'x', actor: 'system' }]);
  await settle();
  await settle();
  assert.deepEqual(got, ['x', 'x', 'x']);
  assert.equal(registry.isDisabled('bad'), true);
});
