import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
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

test("8b-1: two plugins whose hooks answer every entry, in the log and over the network, can't feed each other: hooks never get what any plugin caused", async () => {
  const { host, ws, registry, log } = await hostKit();
  let fetches = 0;
  host.connect({ fetch: async () => { fetches++; return new Response('ok'); } });
  for (const id of ['ping', 'pong']) {
    await host.install(files({
      'annai-plugin.json': JSON.stringify({ id, name: id, version: '1.0.0', api: 1, entry: 'index.js' }),
      'index.js': `export function activate(annai) {
        globalThis.__${id} = 0;
        return annai.hooks.on(async (e) => {
          if (++globalThis.__${id} > 40) return; // the test's own brake
          await annai.net.fetch('https://${id}.example/log', { method: 'POST', body: String(e.seq) });
          await annai.events.append('sys', '${id}.saw', { seq: e.seq });
        });
      }`,
    }));
    await host.start(id);
  }
  for (let i = 0; i < 50; i++) await settle();
  // ping's hooks saw annai install and start pong; count from the user's write on.
  const g = /** @type {any} */ (globalThis);
  g.__ping = g.__pong = fetches = 0;
  const before = (await log()).filter((e) => e.type === 'ping.saw' || e.type === 'pong.saw').length;
  await ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  for (let i = 0; i < 200; i++) await settle();
  assert.deepEqual([g.__ping, g.__pong], [1, 1], "each saw the user's write, and nothing the other did");
  assert.equal(fetches, 2);
  assert.equal((await log()).filter((e) => e.type === 'ping.saw' || e.type === 'pong.saw').length - before, 2);
  assert.ok(!registry.isDisabled('ping') && !registry.isDisabled('pong'));
});
test("8b-1: a hook that feeds itself some way annai can't see (a file it writes as the user) is bounded: past the limit it counts as a failure and is switched off", async () => {
  const { host, ws, registry, log } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'echo', name: 'Echo', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      return annai.hooks.on((e) => annai.files.write('me', '/echo/' + (e.seq % 7) + '.md', String(e.seq), { author: 'user' }), { types: ['file.write'] });
    }`,
  }));
  await host.start('echo');
  await ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  for (let i = 0; i < 20000 && !registry.isDisabled('echo'); i++) await settle();
  assert.ok(registry.isDisabled('echo'), 'switched off');
  const n = (await log()).length;
  assert.ok(n <= HOOK_LIMIT + 50, `bounded: ${n}`);
  for (let i = 0; i < 100; i++) await settle();
  assert.equal((await log()).length, n, 'and it has stopped');
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
test("a hook that throws the browser's own fetch failure while the device is offline is not counted: it failing three times and more leaves its plugin on, each logged with no count; a hook with a bug is off at the third (fail-owner-next, round 2 item 3; logged since plugin-link-next)", async () => {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  let posts = 0;
  let bugs = 0;
  registry.add('poster', 'hook', { fn: () => { posts++; throw new TypeError('Failed to fetch'); } });
  registry.add('bugged', 'hook', { fn: () => { bugs++; throw new TypeError('x is not a function'); } });
  const ev = (/** @type {number} */ seq) => ({ scope: SYS, seq, ts: 1, type: 'x', actor: 'system' });
  deliverHooks(registry, [1, 2, 3, 4, 5].map(ev), () => 1_000);
  await settle();
  assert.equal(posts, 5, 'asked each time');
  assert.equal(registry.isDisabled('poster'), false, 'five offline posts: still on');
  assert.deepEqual(logged.filter((e) => e.actor === 'plugin:poster').map((e) => [e.type, 'count' in e.data]), Array(5).fill(['plugin.error', false]), 'each logged, none counted');
  assert.equal(registry.isDisabled('bugged'), true, "a hook's own bug: off");
  assert.equal(bugs, 3, 'at the third');
});
test("a hook that posts through annai.net.fetch while the device is offline is not counted either (the real tracedFetch's error, kind network): five entries leave the plugin on, each plugin.error with no count; the same hook with a bug is off at the third (fail-owner-next, round 3 item 1; logged since plugin-link-next)", async () => {
  /** @type {any[]} */
  const logged = [];
  const { host, ws, registry } = await hostKit({ log: (ev) => logged.push(ev) });
  host.connect({ fetch: async () => { throw new TypeError('Load failed'); } });
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'poster', name: 'Poster', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      globalThis.__posts = 0;
      return annai.hooks.on(async () => {
        globalThis.__posts++;
        await annai.net.fetch('https://poster.example/log', { method: 'POST', body: 'x' });
      }, { types: ['file.write'] });
    }`,
  }));
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'bugged', name: 'Bugged', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      globalThis.__bugs = 0;
      return annai.hooks.on(async () => {
        globalThis.__bugs++;
        await annai.net.fetch('https://poster.example/log').catch(() => {});
        return undefined.x;
      }, { types: ['file.write'] });
    }`,
  }));
  const g = /** @type {any} */ (globalThis);
  try {
    await host.start('poster');
    await host.start('bugged');
    for (let i = 0; i < 5; i++) {
      await ws.write('me', `/notes/${i}.md`, 'hi', { author: 'user' });
      for (let k = 0; k < 20; k++) await settle();
    }
    assert.equal(g.__posts, 5, 'asked each time');
    assert.equal(registry.isDisabled('poster'), false, 'five offline posts: still on');
    assert.deepEqual(logged.filter((e) => e.actor === 'plugin:poster').map((e) => [e.type, 'count' in e.data]), Array(5).fill(['plugin.error', false]), 'each logged, none counted');
    assert.equal(registry.isDisabled('bugged'), true, "a hook's own bug: off");
    assert.equal(g.__bugs, 3, 'at the third');
  } finally {
    delete g.__posts;
    delete g.__bugs;
  }
});
test("a hook that fails for want of a link (annai.llm's and annai.llm.decide's AllFailedError, its own AbortError on annai.net.fetch, a link failure it wrapped in its own Error) or in its own words is called for every entry, each failure logged with no count, and its plugin stays on (plugin-link-next, test 2)", async () => {
  /** @type {any[]} */
  const logged = [];
  const { host, ws, registry } = await hostKit({ log: (ev) => logged.push(ev) });
  const { AllFailedError } = await import('../../src/core/llm/fallback.js');
  const noModel = async () => { throw new AllFailedError([]); };
  host.connect({
    llm: { call: noModel, decide: noModel },
    // Offline at offline.example; elsewhere a link that is up but dead, which waits until its signal stops it.
    fetch: (/** @type {any} */ url, /** @type {RequestInit} */ init) => (String(url).includes('offline.example') ? Promise.reject(new TypeError('Load failed')) : new Promise((_, reject) => {
      const s = init?.signal;
      if (s?.aborted) reject(s.reason);
      s?.addEventListener('abort', () => reject(s.reason));
    })),
  });
  /** @type {Record<string, string>} */
  const hooks = {
    llm: "await annai.llm('main', { messages: [] });",
    decide: "await annai.llm.decide({ question: 'Now?', options: ['yes', 'no'] });",
    abort: "const c = new AbortController(); c.abort(); await annai.net.fetch('https://dead.example/log', { signal: c.signal });",
    words: "throw new Error('Choose a tide station in its settings first.');",
    wrapped: "try { await annai.net.fetch('https://offline.example/log'); } catch (e) { throw new Error('The note could not be sent: ' + e.message); }",
  };
  const g = /** @type {any} */ (globalThis);
  g.__hooked = Object.fromEntries(Object.keys(hooks).map((how) => [how, 0]));
  try {
    for (const [how, body] of Object.entries(hooks)) {
      await host.install(files({
        'annai-plugin.json': JSON.stringify({ id: `hook-${how}`, name: `Hook ${how}`, version: '1.0.0', api: 1, entry: 'index.js' }),
        // Only the notes written below: another plugin's install writes files too.
        'index.js': `export function activate(annai) { return annai.hooks.on(async (e) => { if (!String(e.data?.path).startsWith('/notes/')) return; globalThis.__hooked['${how}']++; ${body} }, { types: ['file.write'] }); }`,
      }));
      await host.start(`hook-${how}`);
    }
    for (let i = 0; i < 4; i++) {
      await ws.write('me', `/notes/${i}.md`, 'hi', { author: 'user' });
      for (let k = 0; k < 20; k++) await settle();
    }
    const seen = Object.fromEntries(Object.keys(hooks).map((how) => [how, [g.__hooked[how], registry.isDisabled(`hook-${how}`),
      logged.filter((e) => e.actor === `plugin:hook-${how}`).map((e) => [e.type, 'count' in e.data])]]));
    assert.deepEqual(seen, Object.fromEntries(Object.keys(hooks).map((how) => [how, [4, false, Array(4).fill(['plugin.error', false])]])), 'called four times, still on, four lines with no count');
  } finally {
    delete g.__hooked;
  }
});
test("a hook that throws a value that isn't an Error is a crash, as before: off at the third entry (plugin-link-next, test 5; a TypeError and one after a swallowed link failure are the two tests above)", async () => {
  const registry = new Registry();
  let calls = 0;
  registry.add('thrower', 'hook', { fn: () => { calls++; throw 'no'; } });
  const ev = (/** @type {number} */ seq) => ({ scope: SYS, seq, ts: 1, type: 'x', actor: 'system' });
  deliverHooks(registry, [1, 2, 3, 4].map(ev), () => 1_000);
  await settle();
  assert.equal(registry.isDisabled('thrower'), true);
  assert.equal(calls, 3);
});
test("a plugin switched off at the hooks' limit and turned on again starts with a window of its own, not the one that switched it off", async () => {
  const registry = new Registry();
  let got = 0;
  registry.add('busy', 'hook', { fn: () => { got++; } });
  const at = () => 1_000; // all within one window
  const ev = (/** @type {number} */ seq) => ({ scope: SYS, seq, ts: 1, type: 'x', actor: 'system' });
  deliverHooks(registry, Array.from({ length: HOOK_LIMIT + 1 }, (_, i) => ev(i + 1)), at);
  await settle();
  assert.equal(registry.isDisabled('busy'), true);
  assert.equal(got, HOOK_LIMIT);
  registry.enable('busy');
  deliverHooks(registry, [ev(5000)], at);
  await settle();
  assert.equal(got, HOOK_LIMIT + 1);
  assert.equal(registry.isDisabled('busy'), false);
});
