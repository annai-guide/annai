// How annai decides a plugin has failed enough (plugin-fails-next): one counter, the registry's run per plugin, ended by any call of
// the plugin annai made that returned; a start's failure is that launch's, and nothing of it is kept (the user's U148, 2026-11-26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { utf8 } from '../../src/core/bytes.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError, isBadAddress, isPluginBug } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { openLive } from '../../src/core/realtime/open.js';
import { deliverHooks } from '../../src/core/hooks.js';
import { adjusted } from '../../src/core/llm/setup.js';
import { liveKit, at, MONTEREY } from './live-kit.js';
import { device, memoryPlace, TOKEN } from './backup-kit.js';

/** A one-file plugin package. @param {string} id @param {string} code */
const inline = (id, code) => new Map([
  ['annai-plugin.json', utf8(JSON.stringify({ id, name: id, version: '1.0.0', api: 1, entry: 'index.js' }))],
  ['index.js', utf8(code)],
]);

/**
 * Plugins installed on one storage, and each launch of annai on it: a new host with a new registry. Installed modules load from storage as data:
 * addresses (Node has no service worker); importing one listed in `fails` throws what it names, one in `hangs` never settles, and one in `slow`
 * comes after that many ms.
 * @param {{ fails?: Record<string, unknown>, hangs?: string[], slow?: Record<string, number>, startTimeout?: number }} [o]
 */
async function storage({ fails = {}, hangs = [], slow = {}, startTimeout } = {}) {
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(new Registry(), kindOf) });
  await ensureBaseScopes(ws);
  /** @type {Record<string, () => void>} */
  const done = {};
  /** Resolves when the slow import of each id in `slow` has ended: a test waits for it, not for a time. @type {Record<string, Promise<void>>} */
  const loaded = Object.fromEntries(Object.keys(slow).map((id) => [id, new Promise((r) => { done[id] = () => r(undefined); })]));
  const importModule = async (/** @type {string} */ url) => {
    const [, id, file] = /** @type {RegExpExecArray} */ (/^\/plugins\/([^/]+)\/(.+)$/.exec(url));
    if (id in fails) throw fails[id];
    if (hangs.includes(id)) return new Promise(() => {});
    if (id in slow) await new Promise((r) => setTimeout(r, slow[id]));
    const code = await ws.readText(SYS_PLUGINS, `/${id}/${file}`);
    const mod = await import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
    done[id]?.();
    return mod;
  };
  const host = () => new PluginHost({ registry: new Registry(), workspace: ws, importModule, ...(startTimeout ? { startTimeout } : {}) });
  return { ws, host, installer: host(), loaded };
}

/** Whether a promise settles within ms: its value, or 'still waiting'. @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('still waiting'), ms))]);
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a start that crashes, a module with a syntax error, one that throws as it loads and one whose top-level await fails as an offline fetch does: four launches on one storage, a failure at each, the record still on and nothing written of it (plugin-fails-next test 1; route b)', async () => {
  const s = await storage();
  const shapes = {
    'crash-start': 'export function activate() { return undefined.x; }',
    'syntax-error': 'export function activate( {',
    'throws-loading': "throw new Error('config', { cause: new TypeError('Failed to fetch') });\nexport function activate() {}",
    'offline-await': "await Promise.reject(new TypeError('Load failed'));\nexport function activate() {}",
  };
  for (const [id, code] of Object.entries(shapes)) await s.installer.install(inline(id, code));
  const ids = Object.keys(shapes).sort();
  const before = structuredClone(await s.installer.installed());
  for (let launch = 1; launch <= 4; launch++) {
    const failures = await s.host().startInstalled();
    assert.deepEqual(failures.map((f) => f.id).sort(), ids, `launch ${launch}: each tried, each failed`);
  }
  const kept = await s.installer.installed();
  assert.deepEqual(ids.map((id) => kept[id].enabled), ids.map(() => true), 'still on');
  assert.deepEqual(kept, before, 'nothing written of it: the whole record is as the installs left it');
});

test("an official plugin whose files don't load on four launches in a row stays on, in WebKit's words for a failed import and in Chromium's (plugin-fails-next test 2)", async () => {
  const words = {
    'official-webkit': new TypeError('Importing a module script failed.'),
    'official-chromium': new TypeError('Failed to fetch dynamically imported module: https://annai.guide/plugins/official-chromium/index.js'),
  };
  const s = await storage({ fails: words });
  for (const id of Object.keys(words)) await s.installer.install(inline(id, 'export function activate() {}'), { source: 'official' });
  const before = structuredClone(await s.installer.installed());
  for (let launch = 1; launch <= 4; launch++) assert.deepEqual((await s.host().startInstalled()).map((f) => f.id).sort(), Object.keys(words).sort(), `launch ${launch}`);
  const kept = await s.installer.installed();
  assert.deepEqual(Object.keys(words).map((id) => [kept[id].source, kept[id].enabled]), [['official', true], ['official', true]]);
  assert.deepEqual(kept, before, 'nothing written of it');
});

test('a module whose load never settles is given up on at the start limit, and the plugin after it starts (plugin-fails-next test 3)', async () => {
  const s = await storage({ hangs: ['a-hangs'], startTimeout: 50 });
  await s.installer.install(inline('a-hangs', 'export function activate() {}'));
  await s.installer.install(inline('b-after', 'export function activate() {}'));
  const host = s.host();
  const got = /** @type {any} */ (await within(host.startInstalled(), 2_000));
  assert.notEqual(got, 'still waiting', 'startInstalled came back');
  assert.deepEqual(got.map((/** @type {any} */ f) => f.id), ['a-hangs']);
  assert.match(String(got[0].error?.cause?.message), /didn't finish starting within 0\.1 seconds/);
  assert.equal(host.active.has('b-after'), true, 'the plugin after it is running');
});

test("a launch and two setup taps that each fail to start, in WebKit's words for a failed import and as a crash, are three failed starts in one run of annai and leave the plugin on: a start is never counted (plugin-fails-fix1, item 1)", async () => {
  const s = await storage({ fails: { 'tap-webkit': new TypeError('Importing a module script failed.') } });
  await s.installer.install(inline('tap-webkit', 'export function activate() {}'), { source: 'official' });
  await s.installer.install(inline('tap-crash', 'export function activate() { return undefined.x; }'));
  const host = s.host();
  assert.deepEqual((await host.startInstalled()).map((f) => f.id).sort(), ['tap-crash', 'tap-webkit']);
  for (let tap = 0; tap < 2; tap++) for (const id of ['tap-webkit', 'tap-crash']) await assert.rejects(host.start(id), /Starting failed|starting failed/i);
  assert.deepEqual(['tap-webkit', 'tap-crash'].map((id) => host.registry.isDisabled(id)), [false, false]);
  assert.deepEqual(Object.values(await s.installer.installed()).map((r) => r.enabled), [true, true]);
});

test('a module whose load ends after the start limit runs no activate: the start failed at the limit, and the late module sets up nothing (plugin-fails-fix1, item 2)', async () => {
  const s = await storage({ slow: { 'a-slow': 150 }, startTimeout: 50 });
  await s.installer.install(inline('a-slow', "export function activate(annai) { globalThis.__slowRan = (globalThis.__slowRan ?? 0) + 1; annai.tools.register({ name: 'late-tool', description: 'x', input: { type: 'object' }, run() {} }); }"));
  const host = s.host();
  try {
    const got = await host.startInstalled();
    assert.deepEqual(got.map((f) => f.id), ['a-slow']);
    await s.loaded['a-slow']; // the late load has ended; its chain runs in the ticks that follow
    await tick();
    assert.deepEqual([globalThis.__slowRan ?? 0, host.registry.list('tool').length, host.active.has('a-slow')], [0, 0, false], 'activate never ran');
  } finally {
    delete (/** @type {any} */ (globalThis)).__slowRan;
  }
});

test('an activate() that began before the start limit and throws after it has what it set up taken down (plugin-fails-fix2, item 3)', async () => {
  // 50 ms: activate() is entered 0.03 to 1.1 ms after the start on the test host (measured 2026-11-26), so the limit leaves about 45 times that.
  const s = await storage({ startTimeout: 50 });
  await s.installer.install(inline('a-late', "export async function activate(annai) { globalThis.__began = true; await globalThis.__gate; annai.tools.register({ name: 'late-tool', description: 'x', input: { type: 'object' }, run() {} }); throw new Error('The tide table is gone.'); }"));
  let open = () => {};
  /** @type {any} */ (globalThis).__gate = new Promise((r) => { open = () => r(undefined); });
  const host = s.host();
  try {
    assert.deepEqual((await host.startInstalled()).map((f) => f.id), ['a-late'], 'given up at the limit');
    assert.equal(/** @type {any} */ (globalThis).__began, true, 'activate() began before the limit: this is a late activate, not a late load');
    assert.equal(host.registry.list('tool').length, 0);
    open(); // the activate() goes on: registers a tool, then throws
    await tick();
    assert.deepEqual([host.registry.list('tool').length, host.active.has('a-late')], [0, false], 'what it set up after the limit is taken down');
  } finally {
    delete (/** @type {any} */ (globalThis)).__gate;
    delete (/** @type {any} */ (globalThis)).__began;
  }
});

test("a plugin the registry switches off at run time (three crashes of a tool) writes nothing to the record: it stays on there, and the next launch starts it again (plugin-fails-fix1; U148: annai never writes the switch)", async () => {
  const s = await storage();
  await s.installer.install(inline('tools', "export function activate(annai) { annai.tools.register({ name: 'bad', description: 'x', input: { type: 'object' }, run() { return undefined.x; } }); }"));
  const host = s.host();
  await host.startInstalled();
  const before = structuredClone(await s.installer.installed()); // as its start left it (it writes the tools it registered)
  const [tool] = host.registry.list('tool');
  for (let i = 0; i < 3; i++) await assert.rejects(tool.run({}), PluginError);
  await tick();
  assert.equal(host.registry.isDisabled('tools'), true, 'switched off for this run');
  assert.deepEqual(await s.installer.installed(), before, 'the record is as it was: still on');
  const next = s.host();
  assert.deepEqual(await next.startInstalled(), []);
  assert.deepEqual([next.active.has('tools'), next.registry.isDisabled('tools')], [true, false], 'the next launch starts it again');
});

/** A socket the test drives: it opens on the next tick, closes when asked, and the test says what the server sends and when it drops. */
class Sock {
  /** @type {Sock[]} */ static made = [];
  constructor() {
    /** @type {Record<string, ((e: any) => void)[]>} */
    this.on = {};
    /** @type {{ code: number } | null} */
    this.closedWith = null;
    Sock.made.push(this);
    setTimeout(() => this.emit('open', {}), 0);
  }
  /** @param {string} type @param {(e: any) => void} fn */
  addEventListener(type, fn) { (this.on[type] ??= []).push(fn); }
  /** @param {string} type @param {any} e */
  emit(type, e) { for (const fn of this.on[type] ?? []) fn(e); }
  send() {}
  close(code = 1005) {
    if (this.closedWith) return;
    this.closedWith = { code };
    setTimeout(() => this.emit('close', { code, reason: '' }), 0);
  }
  /** @param {string} m */
  receive(m) { this.emit('message', { data: m }); }
  /** @param {number} code @param {string} reason */
  drop(code, reason) {
    this.closedWith = { code };
    this.emit('close', { code, reason });
  }
}

/**
 * A live protocol of a third party's: ready on "ready"; "crash" throws a TypeError, "words" an Error in its own words, anything else works.
 * Its driver and handler can be replaced. @param {Record<string, any>} [driver] @param {((d: string) => unknown) | null} [handler]
 */
const protocol = (driver = {}, handler = null) => /** @type {any} */ ({
  type: 'tide-live', name: 'Tide live', realtime: true, pluginId: 'tide-live', audio: { in: [{ format: 'pcm16', rate: 16000 }], out: [{ format: 'pcm16', rate: 24000 }] },
  open: () => ({ url: 'wss://live.test/v1' }),
  attach(/** @type {any} */ io) {
    /** @type {() => void} */
    let ready = () => {};
    const up = new Promise((r) => { ready = () => r(undefined); });
    io.on(handler ?? ((/** @type {string} */ d) => {
      if (d === 'ready') return ready();
      if (d === 'crash') throw new TypeError("Cannot read properties of undefined (reading 'frame')");
      if (d === 'words') throw new Error('No room for that frame.');
      return undefined;
    }));
    if (handler) setTimeout(ready, 0);
    return { ready: up, audio() {}, activity() {}, text() {}, image() {}, answer() {}, close() {}, ...driver };
  },
});
const endpoint = /** @type {any} */ ({ id: 'pv/live', provider: 'pv', ability: 'live', type: 'tide-live', name: 'Tides', baseUrl: 'https://live.test', headers: {}, tunables: {}, extraBody: {} });
const model = /** @type {any} */ ({ id: 'm', provider: 'pv', ability: 'live', name: 'Live', providerId: 'live-1', input: ['text'], tools: true, prices: null, tunables: {}, extraBody: {} });
const SETUP = /** @type {any} */ ({ instructions: 'You are Koe.', context: '', tools: [] });

/** A real registry that keeps its plugin.error lines, as [count or null]. */
function watched() {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => { logged.push(ev); } });
  return { registry, lines: () => logged.filter((x) => x.type === 'plugin.error').map((x) => x.data.count ?? null), notes: () => logged.filter((x) => x.type === 'plugin.error').map((x) => x.data.message) };
}

/** A live session of the protocol, ready. @param {any} registry @param {any} [type] */
async function session(registry, type = protocol()) {
  const s = openLive({ type, endpoint, model, key: null, tunables: {}, setup: SETUP, trace: null, socket: () => new Sock(), registry });
  await tick();
  const ws = /** @type {Sock} */ (Sock.made.at(-1));
  ws.receive('ready');
  await s.ready;
  return { s, ws };
}

test('three live sessions, each ready, each with one crashing message among working ones: the protocol stays on, one line (plugin-fails-next test 4; entry "A live protocol\'s crashes add up across sessions")', async () => {
  const { registry, lines } = watched();
  for (let i = 0; i < 3; i++) {
    const { s, ws } = await session(registry);
    for (const m of ['frame', 'crash', 'frame']) ws.receive(m);
    s.close();
    await s.closed;
  }
  assert.equal(registry.isDisabled('tide-live'), false);
  assert.deepEqual(lines(), [1], 'the same crash, each after a call that worked: one line');
});

test('one live session: three crashing messages in a row switch the protocol off, three counted lines; 47 more add one line, with no count (plugin-fails-next test 5)', async () => {
  const { registry, lines } = watched();
  const { ws } = await session(registry);
  for (let i = 0; i < 3; i++) ws.receive('crash');
  assert.equal(registry.isDisabled('tide-live'), true);
  assert.deepEqual(lines(), [1, 2, 3]);
  for (let i = 0; i < 47; i++) ws.receive('crash');
  assert.deepEqual(lines(), [1, 2, 3, null], 'switched off already: counted no more, and written once');
});

test('one live session: 50 times a crash then a working message stays on, one line; 50 frames that each throw the same words stay on, one line (plugin-fails-next test 6)', async () => {
  const one = watched();
  const { ws } = await session(one.registry);
  for (let i = 0; i < 50; i++) {
    ws.receive('crash');
    ws.receive('frame');
  }
  assert.equal(one.registry.isDisabled('tide-live'), false);
  assert.deepEqual(one.lines(), [1]);
  const two = watched();
  const again = await session(two.registry);
  for (let i = 0; i < 50; i++) again.ws.receive('words');
  assert.equal(two.registry.isDisabled('tide-live'), false);
  assert.deepEqual(two.lines(), [null]);
});

test("a driver whose close() throws in its own words: annai's close closes the socket and settles closed; the provider's close settles closed with its kind; nothing reaches the caller (plugin-fails-next test 7)", async () => {
  const type = protocol({ close() { throw new Error('The goodbye frame could not be sent.'); } });
  const { registry, lines } = watched();
  const ours = await session(registry, type);
  assert.doesNotThrow(() => ours.s.close());
  assert.equal(ours.ws.closedWith?.code, 1000, 'the socket is closed');
  assert.deepEqual(await within(ours.s.closed, 1_000), { code: 1000, reason: '', kind: null });
  const theirs = await session(registry, type);
  assert.doesNotThrow(() => theirs.ws.drop(1011, 'Internal error'));
  assert.equal(/** @type {any} */ (await within(theirs.s.closed, 1_000)).kind, 'server');
  assert.deepEqual(lines(), [null], 'kept in the Trace, once, uncounted');
});

test("a session that is ready, and a driver call that returns, each end the plugin's run: two crashes, then a new ready session or a driver call that returns, then two crashes leave it on (plugin-fails-fix1, Fable T1)", async () => {
  // Its handler takes every message, and the session is ready by itself (no message), so only `ready` and the driver call can end a run.
  const crashing = (/** @type {string} */ d) => { if (d === 'crash') throw new TypeError("Cannot read properties of undefined (reading 'frame')"); };
  const type = () => protocol({ close: undefined }, crashing); // no close(): a session's end reports no success of its own
  /** @param {any} registry */
  const open = async (registry) => {
    const s = openLive({ type: type(), endpoint, model, key: null, tunables: {}, setup: SETUP, trace: null, socket: () => new Sock(), registry });
    await tick();
    await s.ready;
    return { s, ws: /** @type {Sock} */ (Sock.made.at(-1)) };
  };
  const ready = watched();
  const first = await open(ready.registry);
  for (let i = 0; i < 2; i++) first.ws.receive('crash');
  first.ws.drop(1000, '');
  await first.s.closed;
  const second = await open(ready.registry);
  for (let i = 0; i < 2; i++) second.ws.receive('crash');
  assert.deepEqual([ready.registry.isDisabled('tide-live'), ready.lines()], [false, [1, 2, 1, 2]], 'ready began a new run');
  const call = watched();
  const one = await open(call.registry);
  for (let i = 0; i < 2; i++) one.ws.receive('crash');
  one.s.audio(new Uint8Array(320));
  for (let i = 0; i < 2; i++) one.ws.receive('crash');
  assert.deepEqual([call.registry.isDisabled('tide-live'), call.lines()], [false, [1, 2, 1, 2]], 'a driver call that returned ended the run');
});

test("enable (the plugin's turn-on) clears the repeat memory: a plugin.error line the registry wrote once is written again after it (plugin-fails-fix1, Fable T1)", () => {
  const { registry, lines } = watched();
  const e = new Error('The tide table is not downloaded yet.');
  registry.threw('tides', 'hook', e);
  registry.threw('tides', 'hook', e);
  assert.deepEqual(lines(), [null]);
  registry.enable('tides');
  registry.threw('tides', 'hook', e);
  assert.deepEqual(lines(), [null, null]);
});

test("a live protocol whose classifyClose throws is that plugin's crash: the session ends with annai's own reading, one line for a ready session the provider closes, and three sessions that close before they are ready switch the plugin off (plugin-fails-fix1, item 4)", async () => {
  const type = () => ({ ...protocol(), classifyClose: () => { throw new TypeError("Cannot read properties of undefined (reading 'code')"); } });
  const up = watched();
  const ready = await session(up.registry, type());
  ready.ws.drop(1011, 'Internal error');
  assert.equal(/** @type {any} */ (await within(ready.s.closed, 1_000)).kind, 'server', "annai's own reading of 1011");
  assert.deepEqual([up.lines(), up.registry.isDisabled('tide-live')], [[1], false]);
  const down = watched();
  for (let i = 0; i < 3; i++) {
    const s = openLive({ type: type(), endpoint, model, key: null, tunables: {}, setup: SETUP, trace: null, socket: () => new Sock(), registry: down.registry });
    await tick();
    /** @type {Sock} */ (Sock.made.at(-1)).drop(1011, 'Internal error');
    assert.equal(/** @type {any} */ (await within(s.closed, 1_000)).kind, 'server');
  }
  assert.deepEqual([down.lines(), down.registry.isDisabled('tide-live')], [[1, 2, 3], true]);
});

/** Counts the unhandled rejections while fn runs. @param {() => Promise<void>} fn */
async function rejections(fn) {
  let n = 0;
  const count = () => { n++; };
  process.on('unhandledRejection', count);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', count);
  }
  return n;
}

test('an async message handler, an async driver audio() and an async avatar setState, each crashing three times: off at the third, three counted lines, no unhandled rejection (plugin-fails-next test 8)', async () => {
  const crash = async () => { throw new TypeError("Cannot read properties of undefined (reading 'pcm')"); };
  /** @type {Record<string, any>} */
  const seen = {};
  const handler = watched();
  seen.handler = [await rejections(async () => {
    const { ws } = await session(handler.registry, protocol({}, (d) => (d === 'x' ? crash() : undefined)));
    for (let i = 0; i < 3; i++) ws.receive('x');
  }), handler.registry.isDisabled('tide-live'), handler.lines()];
  const audio = watched();
  seen.audio = [await rejections(async () => {
    const { s } = await session(audio.registry, protocol({ audio: crash }));
    for (let i = 0; i < 3; i++) s.audio(new Uint8Array(320));
  }), audio.registry.isDisabled('tide-live'), audio.lines()];
  const avatar = watched();
  const { dockAvatar } = await import('../../src/ui/dock.js');
  const had = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', { value: class {}, configurable: true, writable: true }); // the dock checks the avatar's el with instanceof Node
  try {
    avatar.registry.add('tide-live', 'ui:component', { name: 'avatar', create: () => ({ el: new (/** @type {any} */ (globalThis).Node)(), setState: crash, setLevel() {} }) });
    seen.avatar = [await rejections(async () => {
      const a = dockAvatar({ registry: avatar.registry });
      for (let i = 0; i < 3; i++) a.setState('thinking');
    }), avatar.registry.isDisabled('tide-live'), avatar.lines()];
  } finally {
    if (had) Object.defineProperty(globalThis, 'Node', had);
    else delete (/** @type {any} */ (globalThis)).Node;
  }
  assert.deepEqual(seen, { handler: [0, true, [1, 2, 3]], audio: [0, true, [1, 2, 3]], avatar: [0, true, [1, 2, 3]] });
});

test("the dock's avatar, with the default limit of three: a setState that crashes while setLevel works (crash, crash, level, crash) keeps its place and its plugin on; one of which every call crashes is off at the third; a setLevel that throws its own words 50 times is on, with one line (plugin-fails-next test 9)", async () => {
  const { dockAvatar } = await import('../../src/ui/dock.js');
  const had = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', { value: class {}, configurable: true, writable: true });
  const bug = () => { throw new TypeError("Cannot read properties of undefined (reading 'face')"); };
  try {
    /** @param {Record<string, any>} calls */
    const avatarOf = (calls) => {
      const w = watched();
      const el = new (/** @type {any} */ (globalThis).Node)();
      w.registry.add('look', 'ui:component', { name: 'avatar', create: () => ({ el, setState() {}, setLevel() {}, ...calls }) });
      return { ...w, el, a: dockAvatar({ registry: w.registry }) };
    };
    const half = avatarOf({ setState: bug });
    half.a.setState('thinking');
    half.a.setState('speaking');
    half.a.setLevel(0.5);
    half.a.setState('listening');
    assert.deepEqual([half.registry.isDisabled('look'), half.a.el === half.el, half.lines()], [false, true, [1, 2, 1]], 'on, its avatar in place');
    const none = avatarOf({ setState: bug, setLevel: bug, glance: bug });
    none.a.setState('thinking');
    none.a.glance(0, 1);
    none.a.setLevel(0.2);
    assert.deepEqual([none.registry.isDisabled('look'), none.lines()], [true, [1, 2, 3]], 'off at the third');
    const words = avatarOf({ setLevel() { throw new Error('No mouth to move.'); } });
    for (let i = 0; i < 50; i++) words.a.setLevel(i / 50);
    assert.deepEqual([words.registry.isDisabled('look'), words.a.el === words.el, words.lines()], [false, true, [null]]);
  } finally {
    if (had) Object.defineProperty(globalThis, 'Node', had);
    else delete (/** @type {any} */ (globalThis)).Node;
  }
});

test("a hook that throws the same words on 50 entries is called 50 times, stays on, and writes one line; the same words after another error of that plugin's write a line again (plugin-fails-next test 10)", async () => {
  const { registry, lines } = watched();
  let calls = 0;
  let words = 'The tide table is not downloaded yet.';
  registry.add('tides', 'hook', { fn: () => { calls++; throw new Error(words); } });
  const ev = (/** @type {number} */ seq) => ({ scope: SYS, seq, ts: 1, type: 'x', actor: 'system' });
  deliverHooks(registry, Array.from({ length: 50 }, (_, i) => ev(i + 1)), () => 1_000);
  await tick();
  assert.deepEqual([calls, registry.isDisabled('tides'), lines()], [50, false, [null]]);
  words = 'The station is closed.';
  deliverHooks(registry, [ev(51)], () => 1_000);
  await tick();
  words = 'The tide table is not downloaded yet.';
  deliverHooks(registry, [ev(52), ev(53)], () => 1_000);
  await tick();
  assert.deepEqual(lines(), [null, null, null], 'another error between: written again, once');
});

test("a call that works ends a plugin's run: two crashes, the call working, two crashes leave it on, for a trigger's check, a backup place's call and a provider's headers and classify; with no call working between, the third crash switches each off (plugin-fails-next test 11, its control plugin-fails-fix3; a tool and a hook just below, a list and a sign-in in provider-setup.test.js and returns.test.js)", async () => {
  /** @param {() => unknown} works @param {string[]} steps what each call does, in turn (after them, works) @returns {() => unknown} */
  const script = (works, steps) => () => {
    if (steps.shift() === 'crash') throw new TypeError("Cannot read properties of undefined (reading 'tide')");
    return works();
  };
  /** Whether each of the four plugins is switched off after calls that go as `steps` says. @param {string[]} steps */
  const switchedOff = async (steps) => {
    /** @type {Record<string, boolean>} */
    const off = {};
    // A trigger's check, by live mode's own engine.
    const k = await liveKit();
    k.registry.add('tides', 'trigger', { type: 'tide', check: script(() => null, [...steps]) });
    await k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' });
    for (let i = 0; i < 6; i++) await k.fix(at('08:31') + i * 1000, MONTEREY);
    off.trigger = k.registry.isDisabled('tides');
    // A backup place's call.
    const place = memoryPlace();
    const d = await device(place);
    d.registry.add('memory-place', 'storage-type', { ...place.type, type: 'flaky', name: 'Flaky', check: script(() => ({ note: 'Fine.' }), [...steps]) });
    const id = await d.backups.add('flaky');
    await d.backups.update(id, { secret: { token: TOKEN } });
    for (let i = 0; i < 5; i++) await d.backups.check(id).catch(() => {});
    off.backup = d.registry.isDisabled('memory-place');
    // A provider's headers and its classify.
    for (const part of ['headers', 'classify']) {
      const registry = new Registry();
      registry.add('provider-acme', 'provider-setup', { [part]: script(() => (part === 'headers' ? { 'x-acme': '1' } : 'rate'), [...steps]) });
      for (let i = 0; i < 5; i++) {
        const got = adjusted(registry, 'provider-acme', /** @type {any} */ ({ type: 'type-h', classify: () => null }), /** @type {any} */ ({ ability: 'chat', headers: {} }));
        if (part === 'classify') got.type.classify?.(400, 'Your quota is used up.');
      }
      off[part] = registry.isDisabled('provider-acme');
    }
    return off;
  };
  assert.deepEqual(await switchedOff(['crash', 'crash', 'works', 'crash', 'crash']), { trigger: false, backup: false, headers: false, classify: false });
  // The control: each of them counts a crash, so three in a row with nothing working between are off at the third.
  assert.deepEqual(await switchedOff(['crash', 'crash', 'crash']), { trigger: true, backup: true, headers: true, classify: true });
});

test("a tool that crashes twice, works, then crashes twice stays on; so does a hook that does the same, one entry to a delivery; a hook that crashes three times in a row is off at the third (plugin-fails-fix2, haiku-rr-tests-a F1: a tool's and a hook's call that works end the run; plugin-fails-fix3, haiku-r2-tests-a 2: the control)", async () => {
  const s = await storage();
  await s.installer.install(inline('flaky', `export function activate(annai) { annai.tools.register({ name: 'flaky', description: 'x', input: { type: 'object' }, run(input) { if (input.ok) return 'done'; throw new TypeError("Cannot read properties of undefined (reading 'x')"); } }); }`));
  const host = s.host();
  await host.start('flaky');
  const [tool] = host.registry.list('tool');
  for (let i = 0; i < 2; i++) await assert.rejects(tool.run({}), PluginError);
  assert.equal((await tool.run({ ok: true })).content, 'done');
  for (let i = 0; i < 2; i++) await assert.rejects(tool.run({}), PluginError);
  assert.equal(host.registry.isDisabled('flaky'), false, 'the tool');
  // One entry to a delivery, as a single write's entries come: a call that works ends the run before the next entry's call starts. A batch of
  // several entries in one delivery is the test below.
  const bug = () => new TypeError("Cannot read properties of undefined (reading 'x')");
  /** Five entries, one to a delivery. @param {Registry} registry */
  const deliverFive = async (registry) => {
    for (let seq = 1; seq <= 5; seq++) {
      deliverHooks(registry, [{ scope: SYS, seq, ts: 1, type: 'x', actor: 'system' }], () => seq * 1_000_000);
      await tick();
    }
  };
  const { registry } = watched();
  let calls = 0;
  registry.add('tides', 'hook', { fn: () => { if (++calls !== 3) throw bug(); } });
  await deliverFive(registry);
  assert.deepEqual([calls, registry.isDisabled('tides')], [5, false], 'the hook');
  // The control: a hook no call of which works is off at its third crash, so the one above stays on because its third call worked.
  const control = watched();
  let loops = 0;
  control.registry.add('stuck', 'hook', { fn: () => { loops++; throw bug(); } });
  await deliverFive(control.registry);
  assert.deepEqual([loops, control.registry.isDisabled('stuck'), control.lines()], [3, true, [1, 2, 3]], 'the control');
});

test("a hook handed crash, crash, works, crash in one delivery stays on when its calls return no promise (an async one, the same on main, beside it); crash, crash, crash in one delivery is off at the third (hook-batch-next: a call that returns no promise ends the run before the batch's next entry is called)", async () => {
  const bug = () => new TypeError("Cannot read properties of undefined (reading 'x')");
  const batch = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ scope: SYS, seq: i + 1, ts: 1, type: 'x', actor: 'system' }));
  const sync = watched();
  let calls = 0;
  sync.registry.add('tides', 'hook', { fn: () => { if (++calls !== 3) throw bug(); } });
  deliverHooks(sync.registry, batch(4), () => 1_000);
  await tick();
  assert.deepEqual([calls, sync.registry.isDisabled('tides'), sync.lines()], [4, false, [1, 2, 1]], 'a hook that returns no promise');
  const late = watched();
  let asyncCalls = 0;
  late.registry.add('ebb', 'hook', { fn: async () => { if (++asyncCalls !== 3) throw bug(); } });
  deliverHooks(late.registry, batch(4), () => 1_000);
  await tick();
  // An async hook's outcomes settle in the batch's order, so it stayed on before the fix too. A plain hook that returns a promise on some entries
  // and throws on others counts in the order its outcomes are known, a promise's when it settles, as every call of a plugin's does.
  assert.deepEqual([asyncCalls, late.registry.isDisabled('ebb'), late.lines()], [4, false, [1, 2, 1]], 'an async hook');
  // The control: no call of it works, so the batch's third crash switches it off and the fourth entry is not handed to it.
  const control = watched();
  let loops = 0;
  control.registry.add('stuck', 'hook', { fn: () => { loops++; throw bug(); } });
  deliverHooks(control.registry, batch(4), () => 1_000);
  await tick();
  assert.deepEqual([loops, control.registry.isDisabled('stuck'), control.lines()], [3, true, [1, 2, 3]], 'the control');
});

test("a provider's headers() that gives no object (nothing, null, a string, a number) adds no header and leaves its plugin on, however many model calls adjust it, and is a call that returned: only a throw of it is a crash (plugin-fails-fix2, item 1; plugin-fails-fix3, Opus X9)", () => {
  // `adjusted` runs at every model call and lookup, and a working request credits the endpoint type's owner, never the provider: a count here would
  // switch off a provider whose every request works, at its third call, for headers it has none of for an ability.
  for (const [wrong, said] of /** @type {[any, string][]} */ ([[undefined, 'undefined'], [null, 'null'], ['x-acme: 1', 'string'], [7, 'number']])) {
    const { registry, lines } = watched();
    registry.add('provider-acme', 'provider-setup', { headers: () => wrong });
    const crash = () => registry.threw('provider-acme', 'provider headers', new TypeError("Cannot read properties of undefined (reading 'x')"));
    crash();
    crash(); // two crashes of its run; the first call of headers() below returns, so it ends the run and the crash after the calls is its first again
    const made = [];
    for (let i = 0; i < 6; i++) made.push(adjusted(registry, 'provider-acme', /** @type {any} */ ({ type: 'type-h' }), /** @type {any} */ ({ ability: 'chat', headers: { a: 'b' } })).endpoint.headers);
    crash();
    assert.deepEqual([registry.isDisabled('provider-acme'), lines(), made.every((h) => h.a === 'b' && Object.keys(h).length === 1)], [false, [1, 2, 1], true], said + ': on, only the three crashes written');
  }
  // Nothing for one ability, a header for another: the natural `if (ability === 'image') return {...}`.
  const some = watched();
  some.registry.add('provider-acme', 'provider-setup', { headers: (/** @type {string} */ ability) => (ability === 'image' ? { 'x-acme-image': '1' } : undefined) });
  const reach = (/** @type {string} */ ability) => adjusted(some.registry, 'provider-acme', /** @type {any} */ ({ type: 'type-h' }), /** @type {any} */ ({ ability, headers: {} })).endpoint.headers;
  assert.deepEqual([reach('chat'), reach('chat'), reach('chat'), reach('chat'), reach('image')], [{}, {}, {}, {}, { 'x-acme-image': '1' }]);
  assert.deepEqual([some.registry.isDisabled('provider-acme'), some.lines()], [false, []]);
  // A throw is still a crash.
  const crash = watched();
  crash.registry.add('provider-acme', 'provider-setup', { headers: () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); } });
  for (let i = 0; i < 3; i++) adjusted(crash.registry, 'provider-acme', /** @type {any} */ ({ type: 'type-h' }), /** @type {any} */ ({ ability: 'chat', headers: {} }));
  assert.deepEqual([crash.registry.isDisabled('provider-acme'), crash.lines()], [true, [1, 2, 3]]);
});

test("isBadAddress and the tool path: a TypeError in WebKit's words for a fetch of an address with a name or password in it is an answer, not a crash: a tool that throws it fails each time with that error, and the plugin stays on (plugin-fails-next test 12)", async () => {
  const e = new TypeError('URL is not valid or contains user credentials.');
  assert.equal(isBadAddress(e), true);
  assert.equal(isPluginBug(e), false);
  const s = await storage();
  await s.installer.install(inline('walker', "export function activate(annai) { annai.tools.register({ name: 'walk', description: 'x', input: { type: 'object' }, run() { throw new TypeError('URL is not valid or contains user credentials.'); } }); }"));
  const host = s.host();
  await host.start('walker');
  const [tool] = host.registry.list('tool');
  for (let i = 0; i < 4; i++) await assert.rejects(tool.run({}), (err) => err instanceof TypeError && err.message === e.message);
  assert.equal(host.registry.isDisabled('walker'), false);
});

test('every module that counts a plugin\'s failure has a report of a call that worked somewhere in it (succeeded, settled or guard, or typeWorked called, not only defined): a new module with none is caught; which path reports is pinned by the tests above and in provider-setup.test.js and returns.test.js (plugin-fails-next test 13)', async () => {
  const root = new URL('../../src/', import.meta.url);
  /** @type {string[]} */
  const missing = [];
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith('.js') || name === 'core/registry.js') continue;
    // typeWorked's own definition (call.js) holds a `succeeded` call: it is no report that anything calls it
    const code = (await readFile(new URL(name, root), 'utf8')).replace(/export function typeWorked\([^)]*\) \{[\s\S]*?\n\}\n/, '');
    if (/registry\??\.(fail|threw)\(/.test(code) && !/registry\??\.(succeeded|settled|guard)\(|typeWorked\(/.test(code)) missing.push(name);
  }
  assert.deepEqual(missing, []);
});
