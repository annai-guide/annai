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
import { Registry, isBadAddress, isPluginBug } from '../../src/core/registry.js';
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
 * addresses (Node has no service worker); importing one listed in `fails` throws what it names, and one in `hangs` never settles.
 * @param {{ fails?: Record<string, unknown>, hangs?: string[], startTimeout?: number }} [o]
 */
async function storage({ fails = {}, hangs = [], startTimeout } = {}) {
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(new Registry(), kindOf) });
  await ensureBaseScopes(ws);
  const importModule = async (/** @type {string} */ url) => {
    const [, id, file] = /** @type {RegExpExecArray} */ (/^\/plugins\/([^/]+)\/(.+)$/.exec(url));
    if (id in fails) throw fails[id];
    if (hangs.includes(id)) return new Promise(() => {});
    const code = await ws.readText(SYS_PLUGINS, `/${id}/${file}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = () => new PluginHost({ registry: new Registry(), workspace: ws, importModule, ...(startTimeout ? { startTimeout } : {}) });
  return { ws, host, installer: host() };
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
  for (let launch = 1; launch <= 4; launch++) {
    const failures = await s.host().startInstalled();
    assert.deepEqual(failures.map((f) => f.id).sort(), ids, `launch ${launch}: each tried, each failed`);
  }
  const kept = await s.installer.installed();
  assert.deepEqual(ids.map((id) => [kept[id].enabled, 'startFailures' in kept[id]]), ids.map(() => [true, false]), 'still on, no count written');
});

test("an official plugin whose files don't load on four launches in a row stays on, in WebKit's words for a failed import and in Chromium's (plugin-fails-next test 2)", async () => {
  const words = {
    'official-webkit': new TypeError('Importing a module script failed.'),
    'official-chromium': new TypeError('Failed to fetch dynamically imported module: https://annai.guide/plugins/official-chromium/index.js'),
  };
  const s = await storage({ fails: words });
  for (const id of Object.keys(words)) await s.installer.install(inline(id, 'export function activate() {}'), { source: 'official' });
  for (let launch = 1; launch <= 4; launch++) assert.deepEqual((await s.host().startInstalled()).map((f) => f.id).sort(), Object.keys(words).sort(), `launch ${launch}`);
  const kept = await s.installer.installed();
  assert.deepEqual(Object.keys(words).map((id) => [kept[id].source, kept[id].enabled]), [['official', true], ['official', true]]);
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
  return { registry, lines: () => logged.filter((x) => x.type === 'plugin.error').map((x) => x.data.count ?? null) };
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

test("a call that works ends a plugin's run at each place that counts one: two crashes, the call working, two crashes leave it on, for a trigger's check, a backup place's call and a provider's headers and classify (plugin-fails-next test 11; its list and sign-in in provider-setup.test.js and returns.test.js)", async () => {
  /** @param {() => unknown} works @returns {() => unknown} two crashes, then works once, then two crashes, then works */
  const script = (works) => {
    const steps = ['crash', 'crash', 'works', 'crash', 'crash'];
    return () => {
      if (steps.shift() === 'crash') throw new TypeError("Cannot read properties of undefined (reading 'tide')");
      return works();
    };
  };
  /** @type {Record<string, boolean>} */
  const off = {};
  // A trigger's check, by live mode's own engine.
  const k = await liveKit();
  k.registry.add('tides', 'trigger', { type: 'tide', check: script(() => null) });
  await k.live.setWatch(k.trip, { when: { type: 'tide' }, fallback: 'Low tide.' });
  for (let i = 0; i < 6; i++) await k.fix(at('08:31') + i * 1000, MONTEREY);
  off.trigger = k.registry.isDisabled('tides');
  // A backup place's call.
  const place = memoryPlace();
  const d = await device(place);
  d.registry.add('memory-place', 'storage-type', { ...place.type, type: 'flaky', name: 'Flaky', check: script(() => ({ note: 'Fine.' })) });
  const id = await d.backups.add('flaky');
  await d.backups.update(id, { secret: { token: TOKEN } });
  for (let i = 0; i < 5; i++) await d.backups.check(id).catch(() => {});
  off.backup = d.registry.isDisabled('memory-place');
  // A provider's headers and its classify.
  for (const part of ['headers', 'classify']) {
    const registry = new Registry();
    registry.add('provider-acme', 'provider-setup', { [part]: script(() => (part === 'headers' ? { 'x-acme': '1' } : 'rate')) });
    for (let i = 0; i < 5; i++) {
      const got = adjusted(registry, 'provider-acme', /** @type {any} */ ({ type: 'type-h', classify: () => null }), /** @type {any} */ ({ ability: 'chat', headers: {} }));
      if (part === 'classify') got.type.classify?.(400, 'Your quota is used up.');
    }
    off[part] = registry.isDisabled('provider-acme');
  }
  assert.deepEqual(off, { trigger: false, backup: false, headers: false, classify: false });
});

test("isBadAddress and the tool path: a TypeError in WebKit's words for a fetch of an address with a name or password in it is an answer, not a crash (plugin-fails-next test 12)", () => {
  const e = new TypeError('URL is not valid or contains user credentials.');
  assert.equal(isBadAddress(e), true);
  assert.equal(isPluginBug(e), false);
});

test('every module that counts a plugin\'s failure also reports a call of it that worked (succeeded, settled or guard), bar the hooks\' loop guard, whose count is a limit of its own (plugin-fails-next test 13)', async () => {
  const root = new URL('../../src/', import.meta.url);
  /** @type {string[]} */
  const missing = [];
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith('.js') || name === 'core/registry.js' || name === 'core/hooks.js') continue;
    const code = await readFile(new URL(name, root), 'utf8');
    if (/registry\??\.(fail|threw)\(/.test(code) && !/registry\??\.(succeeded|settled|guard)\(|typeWorked\(/.test(code)) missing.push(name);
  }
  assert.deepEqual(missing, []);
});
