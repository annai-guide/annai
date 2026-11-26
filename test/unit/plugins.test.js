import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace, ValidationError, StorageFullError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError, isFetchFailure, isPluginBug, isBadAddress } from '../../src/core/registry.js';
import { AllFailedError } from '../../src/core/llm/fallback.js';
import { PluginHost, PLUGIN_MAX_BYTES } from '../../src/core/plugins.js';
import { utf8 } from '../../src/core/bytes.js';
import { messageOf } from '../../src/ui/dom.js';
import { CRASH_CODE, ANSWER_CODE, thrownBy } from './engine-throws.js';

/** @param {string} dir @param {string} [prefix] */
async function fixture(dir, prefix = '') {
  const root = new URL(`../fixtures/plugins/${dir}/`, import.meta.url);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const name of await readdir(root)) files.set(prefix + name, new Uint8Array(await readFile(new URL(name, root))));
  return files;
}

/** @param {{ store?: import("../../src/core/types.js").Store } & Record<string, any>} [opts] */
async function setup({ store = createMemoryStore(), ...hostOpts } = {}) {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: load installed plugin files from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule, ...hostOpts });
  /** A new launch of annai on the same storage. */
  const relaunch = () => new PluginHost({ registry: new Registry(), workspace: ws, importModule });
  return { store, ws, registry, host, logged, importModule, relaunch };
}

test('registry: add, list, remove one, remove a plugin, onChange', () => {
  const r = new Registry();
  let changes = 0;
  r.onChange(() => changes++);
  const off = r.add('a', 'tool', { name: 't1' });
  r.add('a', 'tool', { name: 't2' });
  r.add('b', 'tool', { name: 't3' });
  assert.deepEqual(r.list('tool').map((t) => t.name), ['t1', 't2', 't3']);
  off();
  r.removePlugin('b');
  assert.deepEqual(r.list('tool').map((t) => t.name), ['t2']);
  assert.equal(changes, 5);
});

test('registry: guard logs failures and switches a plugin off after three crashes in a row', async () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev) });
  r.add('flaky', 'tool', { name: 'x' });
  let fail = true;
  const fn = r.guard('flaky', 'tool x', async () => { if (fail) throw new TypeError('nope'); return 'ok'; });
  await assert.rejects(fn(), PluginError);
  fail = false;
  assert.equal(await fn(), 'ok'); // success resets the count
  fail = true;
  await assert.rejects(fn(), PluginError);
  assert.equal(logged.length, 1, 'the first crash after the success is count 1 again: the same line, not written twice (without the reset it would be count 2)');
  await assert.rejects(fn(), PluginError);
  assert.equal(r.isDisabled('flaky'), false, 'after a success, two crashes leave it on');
  await assert.rejects(fn(), PluginError);
  assert.equal(r.isDisabled('flaky'), true, 'the third switches it off');
  assert.deepEqual(r.list('tool'), []);
  // Four failures, three lines: the first crash after the success is the first line over again (count 1), written once (plugin-fails-next).
  assert.deepEqual(logged.map((e) => [e.type, e.data.count]), [['plugin.error', 1], ['plugin.error', 2], ['plugin.error', 3], ['plugin.disabled', undefined]]);
  await assert.rejects(fn(), /switched off/);
  r.enable('flaky');
  fail = false;
  assert.equal(await fn(), 'ok');
  assert.equal(r.list('tool').length, 1);
});

test("registry: a fetch the browser couldn't make is no failure of what guard wraps either (a hook here, a plugin's start in the tests below; spec §5.5, §17): the error reaches the caller and is logged, once while it repeats, nothing is counted, and a bug still is (fail-owner-next, round 2 item 3; logged since plugin-link-next; once since plugin-fails-next)", async () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev) });
  for (const message of ['Failed to fetch', 'Load failed', 'network error']) {
    const offline = r.guard('poster', 'hook', async () => { throw new TypeError(message); });
    for (let i = 0; i < 4; i++) await assert.rejects(offline(), (e) => e instanceof PluginError && e.cause instanceof TypeError && e.cause.message === message);
  }
  assert.equal(r.isDisabled('poster'), false, 'twelve offline posts: still on');
  assert.deepEqual(logged.map((e) => [e.type, e.data.message, 'count' in e.data]), ['Failed to fetch', 'Load failed', 'network error'].map((m) => ['plugin.error', m, false]), 'each kind logged once while it repeats, none counted');
  // The memory of a repeat is each plugin's own: another plugin's first error in the same words is its own line.
  const other = r.guard('poster-two', 'hook', async () => { throw new TypeError('network error'); });
  for (let i = 0; i < 2; i++) await assert.rejects(other(), PluginError);
  assert.deepEqual(logged.filter((e) => e.actor === 'plugin:poster-two').map((e) => e.data.message), ['network error']);
  const buggy = r.guard('buggy', 'hook', async () => { throw new TypeError('x is not a function'); });
  for (let i = 0; i < 3; i++) await assert.rejects(buggy(), PluginError);
  assert.equal(r.isDisabled('buggy'), true, 'its own bug is still counted: off at the third');
});

test('host: built-in core schemas take effect', async () => {
  const { ws, host } = await setup();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await assert.rejects(createTrip(ws, { title: 'Big Sur', start: 'not a date' }), ValidationError);
  const rows = await host.describe();
  assert.deepEqual(rows.map((r) => [r.id, r.builtin, r.active]), [['core-schemas', true, true]]);
});

test('host: install, start, turn off, turn on and uninstall a plugin', async () => {
  const { ws, host } = await setup();
  const manifest = await host.install(await fixture('hello'));
  assert.equal(manifest.id, 'hello');
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/hello/')).map((f) => f.path), ['/hello/annai-plugin.json', '/hello/index.js']);
  assert.equal((await host.installed()).hello.enabled, true);
  await host.start('hello');
  const trip = await createTrip(ws, { title: 'T' });
  await assert.rejects(ws.write(trip, '/hello/a.json', {}, { author: 'user' }), (e) => e instanceof ValidationError && /greeting/.test(e.message));
  await host.setEnabled('hello', false);
  await ws.write(trip, '/hello/a.json', {}, { author: 'user' });
  await host.setEnabled('hello', true);
  await assert.rejects(ws.write(trip, '/hello/b.json', {}, { author: 'user' }), ValidationError);
  await host.uninstall('hello');
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.equal((await host.installed()).hello, undefined);
  await ws.write(trip, '/hello/c.json', {}, { author: 'user' });
});

test('host: a package inside one folder installs too', async () => {
  const { host } = await setup();
  const m = await host.install(await fixture('hello', 'hello-1.0.0/'));
  assert.equal(m.id, 'hello');
});

test('host: refuses bad packages and writes nothing', async () => {
  const { ws, host } = await setup();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const good = await fixture('hello');
  const manifest = JSON.parse(new TextDecoder().decode(good.get('annai-plugin.json')));
  const variant = (/** @type {any} */ changes, /** @type {Record<string, string>} */ extra = {}) => {
    const files = new Map(good);
    files.set('annai-plugin.json', utf8(JSON.stringify({ ...manifest, ...changes })));
    for (const [k, v] of Object.entries(extra)) files.set(k, utf8(v));
    return files;
  };
  const cases = [
    new Map([['index.js', utf8('export {}')]]),
    new Map([['annai-plugin.json', utf8('{not json')]]),
    variant({ id: 'Hello World' }),
    variant({ api: 3 }),
    variant({ entry: 'missing.js' }),
    variant({ id: 'core-schemas' }),
    variant({}, { '../evil.js': 'export {}' }),
  ];
  for (const files of cases) await assert.rejects(host.install(files), PluginError);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.deepEqual(await host.installed(), {});
});

test('host: a plugin whose activate throws is not started and is logged', async () => {
  const { host, logged } = await setup();
  await host.install(await fixture('broken'));
  await assert.rejects(host.start('broken'), PluginError);
  assert.equal(host.active.has('broken'), false);
  assert.equal(logged.at(-1).type, 'plugin.error');
  const failures = await host.startInstalled();
  assert.deepEqual(failures.map((f) => f.id), ['broken']);
});

/** A one-file plugin package. @param {string} id @param {string} code @param {Record<string, any>} [extra] manifest fields */
function inline(id, code, extra = {}) {
  return new Map([
    ['annai-plugin.json', utf8(JSON.stringify({ id, name: id, version: '1.0.0', api: 1, entry: 'index.js', ...extra }))],
    ['index.js', utf8(code)],
  ]);
}

test('host: a plugin that never finishes starting is given up on, and annai carries on', async () => {
  const { host, logged } = await setup({ startTimeout: 50 });
  await host.install(await fixture('hang'));
  const failures = await host.startInstalled();
  assert.deepEqual(failures.map((f) => f.id), ['hang']);
  assert.match(String(/** @type {any} */ (failures[0].error)?.message), /didn't finish starting/);
  // What a screen shows is annai's own sentence, with its full stop, after the frame (words-next: it said "starting" twice, and had none).
  assert.equal(messageOf(failures[0].error), "Starting failed: It didn't finish within 0.1 seconds.");
  assert.equal(host.active.has('hang'), false);
  assert.equal(logged.at(-1).type, 'plugin.error');
});

test("host: a start given up on after one second says '1 second', in the screens' words and with its full stop", async () => {
  const { host } = await setup({ startTimeout: 1000 });
  await host.install(await fixture('hang'));
  const failures = await host.startInstalled();
  assert.equal(messageOf(failures[0].error), "Starting failed: It didn't finish within 1 second.");
});

test('host: what a plugin sets up after it timed out is taken down again', async () => {
  const { host, registry } = await setup({ startTimeout: 20 });
  await host.install(inline('late', `export async function activate(annai) {
    await new Promise((r) => setTimeout(r, 60));
    annai.register('thing', { from: 'late' });
    return () => { globalThis.lateDisposed = true; };
  }`));
  await assert.rejects(host.start('late'), /didn't finish starting/);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(registry.list('thing'), []);
  assert.equal(/** @type {any} */ (globalThis).lateDisposed, true);
});

test('host: a stored plugin is checked again before it starts', async () => {
  const { ws, host } = await setup();
  const put = (/** @type {string} */ path, /** @type {any} */ content) => ws.write(SYS_PLUGINS, path, content, { author: 'system' });
  await put('/evil/index.js', 'export function activate() {}');
  await put('/installed.json', { evil: { version: '1.0.0', name: 'Evil', enabled: true, installed: 1, source: 'x' } });
  /** @type {[any, RegExp][]} */
  const cases = [
    [{ id: 'evil', name: 'Evil', version: '1.0.0', api: 99, entry: 'index.js' }, /API 99/],
    [{ id: 'evil', name: 'Evil', version: '1.0.0', api: 1, entry: '../../whatever.js' }, /entry/],
    [{ id: 'other', name: 'Evil', version: '1.0.0', api: 1, entry: 'index.js' }, /folder/],
  ];
  for (const [manifest, why] of cases) {
    await put('/evil/annai-plugin.json', manifest);
    await assert.rejects(host.start('evil'), (e) => e instanceof PluginError && why.test(e.message), String(why));
    assert.equal(host.active.has('evil'), false);
    assert.match(String((await host.describe()).find((r) => r.id === 'evil')?.problem), why);
  }
});

test('host: reinstalling a plugin that already ran with other files asks for a restart instead of running old code; the same files need none', async () => {
  const { host, relaunch } = await setup();
  await host.install(await fixture('hello'));
  await host.install(await fixture('hello')); // never ran yet: nothing stale
  assert.equal(host.needsRestart('hello'), false);
  await host.start('hello');
  await host.install(await fixture('hello'));
  assert.equal(host.needsRestart('hello'), false, 'the same files again: the code that ran is theirs');
  const next101 = await fixture('hello');
  next101.set('annai-plugin.json', new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(next101.get('annai-plugin.json'))), version: '1.0.1' })));
  await host.stop('hello');
  await host.install(next101);
  assert.equal(host.needsRestart('hello'), true);
  await assert.rejects(host.start('hello'), /Restart annai/);
  assert.equal(host.active.has('hello'), false);
  assert.equal((await host.describe()).find((r) => r.id === 'hello')?.restart, true);
  const next = relaunch();
  await next.start('hello');
  assert.equal(next.active.has('hello'), true);
});

test('host: a plugin whose start crashes, and one whose start fails in its own words, each fail at every launch and stay on: annai never turns a plugin off for not starting (plugin-fails-next; before it, the crashing one was off at its third launch)', async () => {
  const { host, relaunch } = await setup();
  await host.install(inline('crashing', 'export function activate() { return undefined.x; }'));
  await host.install(await fixture('broken'));
  for (let launch = 1; launch <= 4; launch++) {
    const failures = await relaunch().startInstalled();
    // In no order: the failures come ranked by install time (a millisecond), then id, and the two installs can land in one.
    assert.deepEqual(failures.map((f) => f.id).sort(), ['broken', 'crashing'], `launch ${launch}`);
  }
  const kept = await host.installed();
  assert.deepEqual([kept.crashing.enabled, kept.broken.enabled, 'startFailures' in kept.crashing], [true, true, false]);
  await assert.rejects(host.setEnabled('crashing', true), PluginError); // turning it on is a fresh start
  assert.equal('startFailures' in (await host.installed()).crashing, false, 'nothing of a start is written');
});

test("host: a count an older annai kept is read as nothing: a plugin with startFailures 3 and on starts, one it turned off stays off until the traveller turns it on, and the stale field is left in the record (plugin-fails-next, U148: no migration)", async () => {
  const { ws, host, relaunch } = await setup();
  await host.install(inline('kept-on', 'export function activate() {}'));
  await host.install(inline('kept-off', 'export function activate() {}'));
  const record = await host.installed();
  await ws.write(SYS_PLUGINS, '/installed.json', { ...record, 'kept-on': { ...record['kept-on'], startFailures: 3 }, 'kept-off': { ...record['kept-off'], enabled: false, startFailures: 3 } }, { author: 'system' });
  const next = relaunch();
  assert.deepEqual(await next.startInstalled(), []);
  assert.deepEqual([next.active.has('kept-on'), next.active.has('kept-off')], [true, false]);
  await next.setEnabled('kept-off', true);
  assert.equal(next.active.has('kept-off'), true, 'turned on by the traveller, it starts');
  const after = await host.installed();
  const field = (/** @type {string} */ id) => /** @type {any} */ (after[id]).startFailures; // no longer a field of the type: an older annai's, left as it is
  assert.deepEqual([after['kept-on'].enabled, field('kept-on'), after['kept-off'].enabled, field('kept-off')], [true, 3, true, 3]);
});

test("host: four starts given up at the limit, in one run of annai, leave the plugin on: the limit's error is each start's card, never a count (plugin-fails-fix1; the card read, plugin-fails-fix2; four starts, not four launches, plugin-fails-fix3)", async () => {
  const { host, registry, logged } = await setup({ startTimeout: 20 });
  await host.install(inline('stalled', 'export async function activate() { await new Promise(() => {}); }'));
  for (let i = 1; i <= 4; i++) {
    const failures = await host.startInstalled();
    assert.deepEqual(failures.map((f) => f.id), ['stalled'], `start ${i}: its card is listed`);
    assert.match(messageOf(failures[0].error), /^Starting failed: It didn't finish within/);
  }
  assert.equal(registry.isDisabled('stalled'), false);
  assert.deepEqual(logged.filter((e) => e.type === 'plugin.error').map((e) => 'count' in e.data), [false], 'one line, with no count');
});

test("host: a module that throws as it loads fails that launch alone, whatever it throws: its load is inside the guarded start (annai's frame), nothing is written to the switch, and in one run of annai a load that fails in a crash class (a syntax error, WebKit's failed import) is never counted (plugin-fails-next; before it, off at the third launch; plugin-fails-fix1: not counted in a run)", async () => {
  const { host, relaunch } = await setup();
  await host.install(inline('loading', "throw new Error('config', { cause: new TypeError('Failed to fetch') });"));
  for (let launch = 1; launch <= 4; launch++) {
    const failures = await relaunch().startInstalled();
    assert.deepEqual(failures.map((f) => f.id), ['loading'], `launch ${launch}`);
    assert.match(messageOf(failures[0].error), /^Starting failed: config/, "annai's frame of a start");
  }
  const kept = (await host.installed()).loading;
  assert.deepEqual([kept.enabled, 'startFailures' in kept], [true, false]);
  const run = await setup();
  await run.host.install(inline('syntax', 'export function activate( {'));
  await run.host.install(inline('plain', "throw 'no';")); // a value that is no Error, thrown as the module loads
  await run.host.install(inline('webkit', 'export function activate() {}'));
  const importWebKit = run.importModule;
  const webkit = new PluginHost({ registry: run.registry, workspace: run.ws, importModule: async (/** @type {string} */ url) => { if (url.includes('/webkit/')) throw new TypeError('Importing a module script failed.'); return importWebKit(url); } });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(run.host.start('syntax'), /Starting failed|starting failed/i);
    await assert.rejects(run.host.start('plain'), /Starting failed|starting failed/i);
    await assert.rejects(webkit.start('webkit'), /Importing a module script failed/);
  }
  assert.deepEqual([run.registry.isDisabled('syntax'), run.registry.isDisabled('plain'), run.registry.isDisabled('webkit')], [false, false, false]);
  assert.deepEqual(run.logged.filter((e) => e.type === 'plugin.error').map((e) => [e.actor, 'count' in e.data]), [['plugin:syntax', false], ['plugin:plain', false], ['plugin:webkit', false]]);
});

test('host: an install that runs out of space leaves nothing behind', async () => {
  const inner = createMemoryStore();
  let full = false;
  /** @type {import('../../src/core/types.js').Store} */
  const store = {
    close() {},
    tx(stores, mode, fn) {
      let blobs = 0;
      return inner.tx(stores, mode, (t) => fn({ ...t, putBlob: async (rec) => {
        if (full && ++blobs === 2) throw new DOMException('no space', 'QuotaExceededError');
        return t.putBlob(rec);
      } }));
    },
  };
  const { ws, host } = await setup({ store });
  full = true;
  await assert.rejects(host.install(await fixture('hello')), StorageFullError);
  full = false;
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.deepEqual(await host.installed(), {});
});

test('host: plugin packages are limited to 64 MB unpacked, through inspect', async () => {
  const { host } = await setup();
  const files = await fixture('hello');
  files.set('big.bin', new Uint8Array(PLUGIN_MAX_BYTES));
  await assert.rejects(host.inspect(files), /too large/);
  assert.equal((await host.inspect(await fixture('hello'))).id, 'hello');
});

test('host: a tool keeps its own "this" when annai runs it', async () => {
  const { host, registry } = await setup();
  await host.install(inline('tooly', `export function activate(annai) {
    annai.tools.register({ name: 'greet', description: 'Greets.', input: { type: 'object' }, prefix: 'hi ', run(x) { return this.prefix + x; } });
  }`));
  await host.start('tooly');
  // An installed plugin's result comes back as Shiori reads it: a result, its text blanked of every key annai keeps (plugin-words-next).
  assert.deepEqual(await registry.list('tool')[0].run('there'), { content: 'hi there' });
});

test("host: a plugin whose start fetches, offline, is not counted against it: four offline starts, one past the third that switches a plugin off, leave it on, each start's error reaches the caller and is logged, once while it repeats; a start with a bug is not counted either, and four of them leave it on (fail-owner-next, round 2 item 3; logged since plugin-link-next; once since plugin-fails-next; never counted since plugin-fails-fix1)", async () => {
  const { host, registry, logged } = await setup();
  await host.install(inline('fetcher', `export async function activate(annai) { throw new TypeError('Failed to fetch'); }`));
  for (let i = 0; i < 4; i++) await assert.rejects(host.start('fetcher'), /Failed to fetch/);
  assert.equal(registry.isDisabled('fetcher'), false);
  assert.deepEqual(logged.filter((e) => e.type === 'plugin.error').map((e) => 'count' in e.data), [false], 'logged once while it repeats, never counted');
  await host.install(inline('bugged', `export function activate(annai) { return undefined.x; }`));
  for (let i = 0; i < 4; i++) await assert.rejects(host.start('bugged'), (e) => e instanceof PluginError && e.cause instanceof TypeError);
  assert.equal(registry.isDisabled('bugged'), false, 'a start is that launch\'s: four crashing starts in one run leave it on');
  assert.deepEqual(logged.filter((e) => e.actor === 'plugin:bugged').map((e) => 'count' in e.data), [false], 'one line, with no count');
});

/** A browser's fetch with no connection, as each engine's own words: what annai.net.fetch (the real tracedFetch) is given. */
const offlineFetch = async () => { throw new TypeError('Failed to fetch'); };

test("host: a plugin whose start fails only for want of a link stays on through three launches of each kind with no link, whether its start throws the browser's own fetch failure or sends through annai.net.fetch; a bug at three launches in a row fails each and stays on too, nothing written (fail-owner-next, round 3 item 1; no launch count since plugin-fails-next)", async () => {
  const { ws, host, relaunch } = await setup();
  const start = `export async function activate(annai) {
    const how = globalThis.__startHow;
    if (how === 'browser') throw new TypeError('Load failed');
    if (how === 'net') await annai.net.fetch('https://plugin.example/data');
    if (how === 'bug') return undefined.x;
  }`;
  await host.install(inline('loader', start));
  /** @param {string} how */
  const launch = async (how) => {
    /** @type {any} */ (globalThis).__startHow = how;
    const next = relaunch();
    next.connect({ fetch: async () => { sent++; return offlineFetch(); } });
    return next.startInstalled();
  };
  let sent = 0;
  try {
    // Three launches of each kind with no link: the start fails each time, shows in the list (the card still says it didn't start), and counts nothing.
    for (const how of ['browser', 'net']) {
      for (let i = 1; i <= 3; i++) {
        const failures = await launch(how);
        assert.deepEqual(failures.map((f) => f.id), ['loader'], `${how}, launch ${i}`);
        assert.match(messageOf(failures[0].error), /Starting failed/);
        const cause = /** @type {any} */ (/** @type {any} */ (failures[0].error).cause);
        if (how === 'net') assert.deepEqual([/couldn't reach plugin\.example/.test(cause.message), cause.kind, sent], [true, 'network', i], 'annai.net.fetch was reached and named the link');
        else assert.deepEqual([cause.message, sent], ['Load failed', 0], "the browser's own failure: nothing was sent");
      }
      assert.equal((await host.installed()).loader.enabled, true, `${how}: still on after three launches`);
    }
    // A bug fails its launch alone: three in a row are three cards, the plugin still on, nothing written of them.
    for (let i = 1; i <= 3; i++) assert.deepEqual((await launch('bug')).map((f) => f.id), ['loader'], `bug, launch ${i}`);
    assert.deepEqual([(await host.installed()).loader.enabled, 'startFailures' in (await host.installed()).loader], [true, false]);
    assert.equal((await ws.list(SYS_PLUGINS, '/loader/')).length > 0, true);
  } finally {
    delete (/** @type {any} */ (globalThis)).__startHow;
  }
});

test("host: a start that sends through annai.net.fetch with no link is not counted in one session either: four starts, logged with no count, once while it repeats, the plugin on (fail-owner-next, round 3 item 1; logged since plugin-link-next; once since plugin-fails-next)", async () => {
  const { host, registry, logged } = await setup();
  host.connect({ fetch: offlineFetch });
  await host.install(inline('sender', `export async function activate(annai) { await annai.net.fetch('https://plugin.example/data'); }`));
  for (let i = 0; i < 4; i++) await assert.rejects(host.start('sender'), (e) => e instanceof PluginError && /couldn't reach plugin\.example/.test(/** @type {any} */ (e.cause).message) && /** @type {any} */ (e.cause).kind === 'network');
  assert.equal(registry.isDisabled('sender'), false);
  assert.deepEqual(logged.filter((e) => e.type === 'plugin.error').map((e) => 'count' in e.data), [false]);
});

/** annai.llm and annai.llm.decide with no model to reach: the AllFailedError callRole throws. */
const noModel = { call: async () => { throw new AllFailedError([]); }, decide: async () => { throw new AllFailedError([]); } };
/**
 * A browser's fetch on a link that is up but dead: it waits until its signal stops it (then rejects as an engine does, with the signal's reason);
 * at offline.example, the device is offline. @param {any} url @param {RequestInit} [init]
 */
const spottyFetch = (url, init) => (String(url).includes('offline.example') ? offlineFetch() : new Promise((_, reject) => {
  const s = init?.signal;
  if (s?.aborted) reject(s.reason);
  s?.addEventListener('abort', () => reject(s.reason));
}));
/** What starts and hooks throw for want of a link, or in their own words: none of them a crash (plugin-link-next). */
const ANSWERS = {
  llm: "await annai.llm('main', { messages: [] });",
  decide: "await annai.llm.decide({ question: 'Now?', options: ['yes', 'no'] });",
  abort: "const c = new AbortController(); setTimeout(() => c.abort(), 1); await annai.net.fetch('https://dead.example/data', { signal: c.signal });",
  words: "throw new Error('Choose a tide station in its settings first.');",
  wrapped: "try { await annai.net.fetch('https://offline.example/data'); } catch (e) { throw new Error('The tides could not be loaded: ' + e.message); }",
};

test("host: a start that fails for want of a link (annai.llm's and annai.llm.decide's AllFailedError, its own time limit's AbortError on annai.net.fetch, a link failure it wrapped in its own Error), in its own words, or by annai's start limit while it waits on a dead link, stays on through three launches, its card listed at each, nothing counted (plugin-link-next, test 1)", async () => {
  const { ws, host, importModule } = await setup();
  /** @type {Record<string, string>} */
  const starts = { ...ANSWERS, limit: "await annai.net.fetch('https://dead.example/data');" };
  for (const [how, body] of Object.entries(starts)) await host.install(inline(`start-${how}`, `export async function activate(annai) { ${body} }`));
  const ids = Object.keys(starts).map((how) => `start-${how}`);
  /** The reason each start gives, as its error carries it: not only that it failed, but for the reason its name says. @type {Record<string, (c: any) => boolean>} */
  const reasons = {
    llm: (c) => c instanceof AllFailedError,
    decide: (c) => c instanceof AllFailedError,
    abort: (c) => c?.name === 'AbortError',
    words: (c) => /^Choose a tide station in its settings first\.$/.test(c?.message),
    wrapped: (c) => /^The tides could not be loaded: annai couldn't reach offline\.example/.test(c?.message),
    limit: (c) => /^it didn't finish starting within 0\.1 seconds$/.test(c?.message),
  };
  /** @type {Record<string, any[]>} each launch: whether it failed (its card), for the reason it names, whether it wrote a line, and the line's count; then whether it is on, and whether a count was written */
  const seen = Object.fromEntries(ids.map((id) => [id, []]));
  for (let launch = 1; launch <= 3; launch++) {
    /** @type {any[]} */
    const logged = [];
    const next = new PluginHost({ registry: new Registry({ log: (ev) => logged.push(ev) }), workspace: ws, importModule, startTimeout: 50 });
    next.connect({ llm: noModel, fetch: spottyFetch });
    const failures = await next.startInstalled();
    for (const id of ids) {
      const f = failures.find((x) => x.id === id);
      const line = logged.find((e) => e.actor === `plugin:${id}`);
      seen[id].push([f !== undefined, reasons[id.slice('start-'.length)](/** @type {any} */ (f?.error)?.cause), line !== undefined, line?.data.count]);
    }
  }
  const kept = await host.installed();
  for (const id of ids) seen[id].push(kept[id].enabled, 'startFailures' in kept[id]);
  assert.deepEqual(seen, Object.fromEntries(ids.map((id) => [id, [[true, true, true, undefined], [true, true, true, undefined], [true, true, true, undefined], true, false]])), 'its card at each launch, for its own reason, a line with no count; still on, nothing written');
});

test("host: a start that crashes fails at each launch and stays on, whatever set the crash off: a TypeError, a thrown value that isn't an Error, a TypeError after a link failure it swallowed; each is a line with no count (plugin-link-next, test 5; plugin-fails-next: before it, off at the third launch; plugin-fails-fix1: never counted)", async () => {
  const { ws, host, importModule } = await setup();
  const starts = { type: 'return undefined.x;', thrown: "throw 'no';", swallowed: "const r = await annai.net.fetch('https://offline.example/data').catch(() => null); r.json();" };
  for (const [how, body] of Object.entries(starts)) await host.install(inline(`crash-${how}`, `export async function activate(annai) { ${body} }`));
  const ids = Object.keys(starts).map((how) => `crash-${how}`);
  /** @type {Record<string, any[]>} each launch: whether it failed, whether it threw what it was made to, whether it wrote a line, and the line's count; then whether it is on */
  const seen = Object.fromEntries(ids.map((id) => [id, []]));
  let reached = 0;
  /** What each start threw, as its card's error carries it: a TypeError of the engine, a value that is no Error, a TypeError after the swallowed link failure. @type {Record<string, (c: any) => boolean>} */
  const threw = { 'crash-type': (c) => c instanceof TypeError, 'crash-thrown': (c) => c === 'no', 'crash-swallowed': (c) => c instanceof TypeError };
  for (let launch = 1; launch <= 3; launch++) {
    /** @type {any[]} */
    const logged = [];
    const next = new PluginHost({ registry: new Registry({ log: (ev) => logged.push(ev) }), workspace: ws, importModule });
    next.connect({ fetch: (/** @type {any} */ url, /** @type {RequestInit} */ init) => { reached++; return spottyFetch(url, init); } });
    const failures = await next.startInstalled();
    for (const id of ids) {
      const line = logged.find((e) => e.actor === `plugin:${id}`);
      seen[id].push([failures.some((f) => f.id === id), threw[id](/** @type {any} */ (failures.find((f) => f.id === id)?.error)?.cause), line !== undefined, line?.data.count]);
    }
  }
  assert.equal(reached, 3, "the swallowed start's fetch was reached, once at each launch, and no other start sent anything");
  const kept = await host.installed();
  for (const id of ids) seen[id].push(kept[id].enabled);
  assert.deepEqual(seen, Object.fromEntries(ids.map((id) => [id, [[true, true, true, undefined], [true, true, true, undefined], [true, true, true, undefined], true]])));
});

test("host: a start that throws what the engine throws for a program that does something wrong (a DOMException by its name: SyntaxError, InvalidCharacterError, DataCloneError, HierarchyRequestError, IndexSizeError; a URIError) and one that throws AbortError, TimeoutError, NetworkError, QuotaExceededError, InvalidStateError or NotFoundError: each is a line with no count, fails at every launch and stays on (plugin-link-fix1; no launch count since plugin-fails-next; no count of a start at all since plugin-fails-fix1)", async () => {
  const { ws, host, importModule } = await setup();
  const starts = { ...Object.fromEntries(Object.entries(CRASH_CODE).map(([n, code]) => [`crash-${n}`, code])), ...Object.fromEntries(Object.entries(ANSWER_CODE).map(([n, code]) => [`answer-${n}`, code])) };
  for (const [id, body] of Object.entries(starts)) await host.install(inline(id.toLowerCase(), `export async function activate() { ${body} }`));
  /** @type {Record<string, any[]>} each launch: whether it failed, the name of what it threw, whether it wrote a line and whether the line was counted; then whether it is on, and whether a count was written */
  const seen = Object.fromEntries(Object.keys(starts).map((id) => [id.toLowerCase(), []]));
  for (let launch = 1; launch <= 3; launch++) {
    /** @type {any[]} */
    const logged = [];
    const failures = await new PluginHost({ registry: new Registry({ log: (ev) => logged.push(ev) }), workspace: ws, importModule }).startInstalled();
    for (const id of Object.keys(seen)) {
      const line = logged.find((e) => e.actor === `plugin:${id}`);
      seen[id].push([failures.some((f) => f.id === id), /** @type {any} */ (failures.find((f) => f.id === id)?.error)?.cause?.name, line !== undefined, 'count' in (line?.data ?? {})]);
    }
  }
  const kept = await host.installed();
  for (const id of Object.keys(seen)) seen[id].push(kept[id].enabled, 'startFailures' in kept[id]);
  assert.deepEqual(seen, Object.fromEntries(Object.keys(starts).map((id) => [id.toLowerCase(), [...Array(3).fill([true, id.split('-')[1], true, false]), true, false]])));
});

test("host: a tool that throws what the engine throws for a program doing something wrong is off at the third call, one that throws a link's, a stop's or a limit's DOMException stays on: the tool path takes the same rule (plugin-link-fix1)", async () => {
  const { host, registry } = await setup();
  const tools = { ...Object.fromEntries(Object.entries(CRASH_CODE).map(([n, code]) => [`crash-${n}`, code])), ...Object.fromEntries(Object.entries(ANSWER_CODE).map(([n, code]) => [`answer-${n}`, code])) };
  for (const [id, body] of Object.entries(tools)) {
    const name = id.toLowerCase();
    await host.install(inline(name, `export function activate(annai) { annai.tools.register({ name: '${name}', description: 'Throws.', input: { type: 'object' }, run() { ${body} } }); }`));
    await host.start(name);
  }
  /** @type {Record<string, boolean>} */
  const off = {};
  for (const id of Object.keys(tools)) {
    const name = id.toLowerCase();
    const tool = registry.list('tool').find((x) => x.name === name);
    for (let i = 0; i < 3; i++) await assert.rejects(tool.run({}));
    off[name] = registry.isDisabled(name);
  }
  assert.deepEqual(off, Object.fromEntries(Object.keys(tools).map((id) => [id.toLowerCase(), id.startsWith('crash-')])));
});

test("the rule counts the engine's crash classes by class and by DOMException name (each thrown for real where Node can, its name pinned), the other names stay answers (plugin-link-fix1)", () => {
  for (const [name, code] of Object.entries(CRASH_CODE)) {
    const e = thrownBy(code);
    assert.equal(e.name, name, `${name} is what its code throws`);
    assert.equal(isPluginBug(e), true, name);
  }
  for (const [name, code] of Object.entries(ANSWER_CODE)) {
    const e = thrownBy(code);
    assert.equal(e.name, name, `${name} is what its code throws`);
    assert.equal(isPluginBug(e), false, name);
  }
  assert.equal(isPluginBug(new URIError('URI malformed')), true);
});

test("registry: only a crash counts at the one door (threw): a bug, an answer, a bug, a bug is off at the third bug, the answer logged with no count and neither ending the run nor adding to it; a bug, a success, two bugs stays on (plugin-link-next, test 4)", async () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev) });
  const step = (/** @type {string} */ id, /** @type {string} */ how) => r.guard(id, 'hook', async () => {
    if (how === 'bug') throw new TypeError('x.go is not a function');
    if (how === 'answer') throw new Error('No tide station is set.');
  })().catch(() => {});
  for (const how of ['bug', 'answer', 'bug']) await step('p', how);
  assert.equal(r.isDisabled('p'), false, 'two bugs and an answer: still on');
  await step('p', 'bug');
  assert.equal(r.isDisabled('p'), true, 'off at the third bug');
  assert.deepEqual(logged.filter((e) => e.type === 'plugin.error').map((e) => e.data.count ?? null), [1, null, 2, 3]);
  for (const how of ['bug', 'ok', 'bug', 'bug']) await step('q', how);
  assert.equal(r.isDisabled('q'), false, 'a success ended the run');
});

test("host: a tool's own errors are answers Shiori sees, not crashes; a crash counts against the plugin (spec §5.5, §6.7)", async () => {
  const { host, registry } = await setup();
  await host.install(inline('picky', `export function activate(annai) {
    annai.tools.register({ name: 'picky', description: 'Refuses.', input: { type: 'object' }, run() { throw new Error('No such file: /trip/x.md'); } });
    annai.tools.register({ name: 'buggy', description: 'Crashes.', input: { type: 'object' }, run() { return undefined.x; } });
  }`));
  await host.start('picky');
  const [picky, buggy] = registry.list('tool');
  for (let i = 0; i < 5; i++) await assert.rejects(picky.run({}), /No such file/);
  assert.equal(registry.isDisabled('picky'), false);
  for (let i = 0; i < 3; i++) await assert.rejects(buggy.run({}), PluginError);
  assert.equal(registry.isDisabled('picky'), true);
});

test("host: a fetch that fails because the device is offline is the tool's answer, not a crash (spec §17)", async () => {
  const { host, registry } = await setup();
  await host.install(inline('online', `export function activate(annai) {
    annai.tools.register({ name: 'online', description: 'Needs the network.', input: { type: 'object' }, run() { throw new TypeError('Failed to fetch'); } });
    annai.tools.register({ name: 'safari', description: 'Needs the network.', input: { type: 'object' }, run() { throw new TypeError('Load failed'); } });
  }`));
  await host.start('online');
  const [chrome, safari] = registry.list('tool');
  for (let i = 0; i < 3; i++) {
    await assert.rejects(chrome.run({}), /Failed to fetch/);
    await assert.rejects(safari.run({}), /Load failed/);
  }
  assert.equal(registry.isDisabled('online'), false);
});

test("the rule for whose failure an error is wherever a plugin's own code makes the request and reads the reply (the tool path, and the like; an endpoint type's call goes by position): the browser's own words for a request it couldn't make or finish are the link's, by whole words, so a plugin's own TypeError that only names an identifier is its bug (cut-send-fix2, 2)", () => {
  for (const message of ['Failed to fetch', 'Load failed', 'network error', 'NetworkError when attempting to fetch resource.', 'The network connection was lost.', 'Failed to fetch https://a.test/']) {
    assert.equal(isFetchFailure(new TypeError(message)), true, message);
    assert.equal(isPluginBug(new TypeError(message)), false, message);
  }
  for (const message of ['this.fetchModels is not a function', "Cannot read properties of undefined (reading 'networkState')", 'networks is not iterable', "Cannot read properties of undefined (reading 'fetchModels')"]) {
    assert.equal(isFetchFailure(new TypeError(message)), false, message);
    assert.equal(isPluginBug(new TypeError(message)), true, message);
  }
  assert.equal(isFetchFailure(new Error('Failed to fetch')), false, 'only a TypeError is the browser');
});

test("isBadAddress reads each engine's own words for a `new URL` that refused an address (measured in Playwright's Chromium, WebKit and Firefox builds, and Node), from a TypeError only; so does the tool path's rule (fail-owner-next, round 2 item 2)", () => {
  for (const message of ["Failed to construct 'URL': Invalid URL", '"not an address" cannot be parsed as a URL.', 'URL constructor: not an address is not a valid URL.', 'Invalid URL', 'Failed to parse URL from not an address']) {
    assert.equal(isBadAddress(new TypeError(message)), true, message);
    assert.equal(isPluginBug(new TypeError(message)), false, message);
  }
  for (const message of ["Cannot read properties of undefined (reading 'path')", 'Failed to fetch', 'this.url is not a function', 'is not a valid value']) {
    assert.equal(isBadAddress(new TypeError(message)), false, message);
  }
  assert.equal(isBadAddress(new Error('Invalid URL')), false, 'only a TypeError is the engine');
  assert.equal(isBadAddress('Invalid URL'), false);
});

test('registry: switching a plugin off after repeated errors is told once, with its last error (spec §5.5)', async () => {
  const r = new Registry();
  /** @type {any[]} */
  const told = [];
  r.onDisabled((d) => told.push(d));
  const f = r.guard('flaky', 'tool x', () => { throw new TypeError('boom 3'); });
  for (let i = 0; i < 4; i++) await f().catch(() => {});
  assert.deepEqual(told, [{ pluginId: 'flaky', why: { kind: 'failed', count: 3 }, message: 'boom 3' }]);
});

test("registry: the last error a card shows is annai's own sentence where the error carries one (shown), not its English log message", async () => {
  const r = new Registry();
  /** @type {any[]} */
  const told = [];
  r.onDisabled((d) => told.push(d));
  const slow = r.guard('slow', 'hook', () => { throw Object.assign(new TypeError('the table has no row'), { shown: 'The table has no row.' }); });
  for (let i = 0; i < 3; i++) await slow().catch(() => {});
  assert.deepEqual(told.map((d) => d.message), ['The table has no row.']);
  // An error counted from outside guard() is told the same way.
  r.fail('read', 'a stream', new Error('x'));
  r.fail('read', 'a stream', new Error('x'));
  r.fail('read', 'a stream', Object.assign(new Error('the stream broke'), { shown: 'The stream broke.' }));
  assert.deepEqual(told.map((d) => d.message), ['The table has no row.', 'The stream broke.']);
});
