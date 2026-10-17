import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { watchAppends, deliverHooks, causedBy, HOOK_LIMIT } from '../../src/core/hooks.js';
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

// Fix pass 8b-1: what a plugin causes through annai's APIs is its own; hooks are bounded.
test("8b-1: a hook never gets what its own plugin caused through annai's APIs: a fetch it makes, a model call, a wake", async () => {
  const { host, ws, log } = await hostKit();
  let fetches = 0;
  host.connect({ fetch: async () => { fetches++; return new Response('ok'); } });
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'mirror', name: 'Mirror', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      globalThis.__mirrorCalls = 0;
      return annai.hooks.on(async (e) => {
        if (++globalThis.__mirrorCalls > 40) return; // the test's own brake
        await annai.net.fetch('https://mirror.example/log', { method: 'POST', body: JSON.stringify(e) });
      });
    }`,
  }));
  await host.start('mirror');
  await ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  for (let i = 0; i < 100; i++) await settle();
  assert.equal(/** @type {any} */ (globalThis).__mirrorCalls, 1);
  assert.equal(fetches, 1);
  const net = (await log()).filter((e) => e.type === 'net.request');
  assert.equal(net.length, 1);
  assert.equal(causedBy(net[0]), 'mirror');
  assert.equal(causedBy({ scope: 'sys', seq: 1, ts: 1, type: 'model.turn', actor: 'system', data: { tag: 'plugin:mirror' } }), 'mirror');
  assert.equal(causedBy({ scope: 'sys', seq: 1, ts: 1, type: 'net.request', actor: 'system', data: { kind: 'model', tag: 'plugin:mirror' } }), 'mirror');
  assert.equal(causedBy({ scope: 'sys', seq: 1, ts: 1, type: 'decide', actor: 'system', data: { tag: 'plugin:mirror' } }), 'mirror');
  assert.equal(causedBy({ scope: 'sys', seq: 1, ts: 1, type: 'wake', actor: 'system', data: { reasons: [{ kind: 'plugin', plugin: 'mirror', text: 'x' }] } }), 'mirror');
  assert.equal(causedBy({ scope: 'sys', seq: 1, ts: 1, type: 'file.write', actor: 'user', data: {} }), null);
});

test("8b-1: two plugins whose hooks each log on every entry don't ping-pong without end: past the bound it counts as a failure, and they are switched off", async () => {
  const { host, ws, registry, log } = await hostKit();
  for (const id of ['ping', 'pong']) {
    await host.install(files({
      'annai-plugin.json': JSON.stringify({ id, name: id, version: '1.0.0', api: 1, entry: 'index.js' }),
      'index.js': `export function activate(annai) { return annai.hooks.on((e) => annai.events.append('sys', '${id}.saw', { seq: e.seq })); }`,
    }));
    await host.start(id);
  }
  await ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  for (let i = 0; i < 5000 && !registry.isDisabled('ping') && !registry.isDisabled('pong'); i++) await settle();
  assert.ok(registry.isDisabled('ping') || registry.isDisabled('pong'), 'one of them is switched off');
  const seen = (await log()).filter((e) => e.type === 'ping.saw' || e.type === 'pong.saw').length;
  assert.ok(seen <= 2 * HOOK_LIMIT + 10, `bounded: ${seen}`);
  const n = seen;
  for (let i = 0; i < 100; i++) await settle();
  assert.equal((await log()).filter((e) => e.type === 'ping.saw' || e.type === 'pong.saw').length, n, 'and it has stopped');
});

test('8b-1 (M1): a write the store tries again reports its entries once', async () => {
  const inner = createMemoryStore();
  let first = true;
  /** @type {import('../../src/core/types.js').Store} */
  const flaky = {
    close() {},
    tx(stores, mode, fn) {
      if (mode !== 'readwrite' || !first) return inner.tx(stores, mode, fn);
      first = false;
      // As the IndexedDB store does when the connection is lost: the same work again, on a new transaction.
      return inner.tx(stores, mode, async (t) => { await fn(t); throw new Error('connection lost'); }).catch(() => inner.tx(stores, mode, fn));
    },
  };
  /** @type {any[][]} */
  const seen = [];
  const store = watchAppends(flaky, (evs) => seen.push(evs));
  await store.tx(['events'], 'readwrite', async (t) => {
    await t.appendEvent('a', { ts: 1, type: 'x', actor: 'user' });
  });
  assert.deepEqual(seen.map((evs) => evs.map((e) => e.type)), [['x']]);
});
