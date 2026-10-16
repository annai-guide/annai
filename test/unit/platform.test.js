import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchForUpdates } from '../../src/ui/platform.js';

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
