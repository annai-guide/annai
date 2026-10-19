import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchForUpdates, restartInto, connectionOf, deviceName } from '../../src/ui/platform.js';

/** A service worker as the page sees it. @param {string} state */
function worker(state) {
  return Object.assign(new EventTarget(), { state });
}

/** @param {{ controller?: any, waiting?: any }} [at] */
function setup({ controller = null, waiting = null } = {}) {
  const container = { controller };
  const reg = Object.assign(new EventTarget(), { installing: /** @type {any} */ (null), waiting, active: controller });
  let announced = 0;
  let failed = 0;
  watchForUpdates(/** @type {any} */ (container), /** @type {any} */ (reg), () => { announced++; }, () => { failed++; });
  /** The browser starts installing w, which fails (a file of the new version didn't download). @param {any} w */
  const fail = (w) => {
    reg.installing = w;
    reg.dispatchEvent(new Event('updatefound'));
    reg.installing = null;
    w.state = 'redundant';
    w.dispatchEvent(new Event('statechange'));
  };
  /** The browser installs w; `before` runs before the page hears w installed. @param {any} w @param {() => void} [before] */
  const install = (w, before) => {
    reg.installing = w;
    reg.dispatchEvent(new Event('updatefound'));
    before?.();
    w.state = 'installed';
    w.dispatchEvent(new Event('statechange'));
  };
  return { container, install, fail, announced: () => announced, failed: () => failed };
}

test('a new version that installs behind the running one is announced', () => {
  const s = setup({ controller: worker('activated') });
  s.install(worker('installing'));
  assert.equal(s.announced(), 1);
});

test('a version already waiting when annai starts is announced', () => {
  const s = setup({ controller: worker('activated'), waiting: worker('installed') });
  assert.equal(s.announced(), 1);
});

test('the first install is not an update', () => {
  const s = setup();
  s.install(worker('installing'));
  assert.equal(s.announced(), 0);
});

test('the first install is not an update even when it takes over the page before the page hears it installed (WebKit)', () => {
  const s = setup();
  const w = worker('installing');
  s.install(w, () => { s.container.controller = w; });
  assert.equal(s.announced(), 0);
});

test("a new version whose download doesn't finish is said; not the first install's, nor a waiting version a newer one replaces", () => {
  const s = setup({ controller: worker('activated') });
  s.fail(worker('installing'));
  assert.deepEqual([s.announced(), s.failed()], [0, 1]);
  const w = worker('installing');
  s.install(w);
  w.state = 'redundant'; // a newer version took its place while it waited
  w.dispatchEvent(new Event('statechange'));
  assert.deepEqual([s.announced(), s.failed()], [1, 1]);
  const first = setup();
  first.fail(worker('installing'));
  assert.equal(first.failed(), 0);
});

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test('Restart now into a waiting version: annai reloads once it takes over, or after a few seconds if it never does (its activate failed, or it went redundant), and only once', async () => {
  /** @type {string[]} */
  const posted = [];
  const reg = { waiting: /** @type {any} */ ({ postMessage: (/** @type {string} */ m) => posted.push(m) }) };
  const container = new EventTarget();
  let reloads = 0;
  const swap = restartInto(/** @type {any} */ (container), /** @type {any} */ (reg), { reload: () => { reloads++; }, fallbackMs: 20 });
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(reloads, 0, 'a new controller nobody asked for (the first install) is no restart');
  swap();
  assert.deepEqual(posted, ['skip-waiting']);
  container.dispatchEvent(new Event('controllerchange'));
  assert.equal(reloads, 1);
  await wait(40);
  assert.equal(reloads, 1, 'the fallback never reloads a second time');

  const stuck = new EventTarget();
  let stuckReloads = 0;
  const never = restartInto(/** @type {any} */ (stuck), /** @type {any} */ (reg), { reload: () => { stuckReloads++; }, fallbackMs: 20 });
  never();
  never(); // a second tap
  await wait(10);
  assert.equal(stuckReloads, 0);
  await wait(40);
  assert.equal(stuckReloads, 1, 'it never took over: annai reloads anyway, once');
  stuck.dispatchEvent(new Event('controllerchange'));
  assert.equal(stuckReloads, 1, 'a late takeover reloads no second time');

  let goneReloads = 0;
  restartInto(/** @type {any} */ (new EventTarget()), /** @type {any} */ ({ waiting: null }), { reload: () => { goneReloads++; } })();
  assert.equal(goneReloads, 1, 'nothing waits any more: a plain reload at once');
});

test('connectionOf: Wi-Fi only when the browser says so (spec §12.4)', () => {
  /** @type {[any, string][]} */
  const cases = [
    [{ onLine: false, connection: { type: 'wifi' } }, 'offline'],
    [{ onLine: true, connection: { type: 'none' } }, 'offline'],
    [{ onLine: true, connection: { type: 'wifi' } }, 'wifi'],
    [{ onLine: true, connection: { type: 'ethernet' } }, 'wifi'],
    [{ onLine: true, connection: { type: 'cellular' } }, 'cellular'],
    [{ onLine: true, connection: { type: 'wifi', saveData: true } }, 'cellular'],
    [{ onLine: true, connection: { effectiveType: '4g' } }, 'unknown'], // desktop Chrome names no type
    [{ onLine: true }, 'unknown'], // Safari has no navigator.connection
  ];
  for (const [nav, want] of cases) assert.equal(connectionOf(nav), want, JSON.stringify(nav));
});

test('deviceName: what this device is called in its backups', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const pixel = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  assert.deepEqual(deviceName(iphone, 5), { label: 'iPhone', noun: 'phone' });
  assert.deepEqual(deviceName(ipad, 5), { label: 'iPad', noun: 'iPad' });
  assert.deepEqual(deviceName(ipad, 0), { label: 'computer', noun: 'computer' });
  assert.deepEqual(deviceName(pixel, 5), { label: 'Android phone', noun: 'phone' });
});
