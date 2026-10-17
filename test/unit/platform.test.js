import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchForUpdates, connectionOf, deviceName } from '../../src/ui/platform.js';

/** A service worker as the page sees it. @param {string} state */
function worker(state) {
  return Object.assign(new EventTarget(), { state });
}

/** @param {{ controller?: any, waiting?: any }} [at] */
function setup({ controller = null, waiting = null } = {}) {
  const container = { controller };
  const reg = Object.assign(new EventTarget(), { installing: /** @type {any} */ (null), waiting, active: controller });
  let announced = 0;
  watchForUpdates(/** @type {any} */ (container), /** @type {any} */ (reg), () => { announced++; });
  /** The browser installs w; `before` runs before the page hears w installed. @param {any} w @param {() => void} [before] */
  const install = (w, before) => {
    reg.installing = w;
    reg.dispatchEvent(new Event('updatefound'));
    before?.();
    w.state = 'installed';
    w.dispatchEvent(new Event('statechange'));
  };
  return { container, install, announced: () => announced };
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
