import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginsMayLoad, reloadOnce, controllerReady, RELOADED } from '../../src/app/claim.js';

/** sessionStorage as a map; broken: it throws, or forgets what it is given. @param {'throws' | 'forgets'} [broken] */
function session(broken) {
  const m = new Map();
  return {
    m,
    getItem: (/** @type {string} */ k) => { if (broken === 'throws') throw new Error('storage blocked'); return m.get(k) ?? null; },
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { if (broken !== 'forgets') m.set(k, v); },
  };
}

/**
 * A page's navigator.serviceWorker: an active worker that takes the page when asked (takes), or doesn't (Chromium with a
 * page loaded past the worker before its registration was in memory); none at all on a first visit.
 * @param {{ controlled?: boolean, active?: boolean, takes?: boolean }} o
 */
function container({ controlled = false, active = true, takes = true }) {
  const sw = /** @type {any} */ (new EventTarget());
  sw.controller = controlled ? {} : null;
  sw.asked = 0;
  const worker = { postMessage: (/** @type {unknown} */ m) => {
    if (m !== 'claim') return;
    sw.asked++;
    if (takes) setTimeout(() => { sw.controller = worker; sw.dispatchEvent(new Event('controllerchange')); }, 5);
  } };
  sw.getRegistration = async () => (active ? { active: worker } : undefined);
  return sw;
}

/** Settles with the promise's value, or 'pending' when it hasn't settled within ms. @param {Promise<unknown>} p @param {number} ms */
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), ms))]);

test('a page loaded past an active worker asks to be taken, and plugins load once it is, with no reload', async () => {
  const sw = container({ takes: true });
  let reloads = 0;
  assert.equal(await pluginsMayLoad({ sw, session: () => session(), reload: () => { reloads++; }, wait: 200 }), true);
  assert.equal(sw.asked, 1);
  assert.equal(reloads, 0);
});

test('controlled, with no service worker, or with none active yet (a first visit), plugins load at once', async () => {
  for (const sw of [container({ controlled: true }), undefined, container({ active: false })]) {
    let reloads = 0;
    assert.equal(await pluginsMayLoad({ sw, session: () => session(), reload: () => { reloads++; }, wait: 200 }), true);
    assert.equal(reloads, 0);
  }
});

test('a page the worker does not take is reloaded once, noted with its time; the page after it is never reloaded again', async () => {
  const kept = session();
  let reloads = 0;
  const first = pluginsMayLoad({ sw: container({ takes: false }), session: () => kept, reload: () => { reloads++; }, now: () => 1234, wait: 50 });
  assert.equal(await within(first, 300), 'pending', 'the page goes: plugins never start in it');
  assert.equal(reloads, 1);
  assert.equal(kept.m.get(RELOADED), '1234');
  // The reload came up past the worker again: no second reload, and plugins can't load (one card says so).
  const sw = container({ takes: false });
  assert.equal(await pluginsMayLoad({ sw, session: () => kept, reload: () => { reloads++; }, wait: 50 }), false);
  assert.equal(sw.asked, 1, 'it asked to be taken first');
  assert.equal(reloads, 1);
});

test('no reload where sessionStorage is blocked or keeps nothing, so it can never loop', async () => {
  for (const broken of /** @type {const} */ (['throws', 'forgets'])) {
    let reloads = 0;
    assert.equal(await pluginsMayLoad({ sw: container({ takes: false }), session: () => session(broken), reload: () => { reloads++; }, wait: 50 }), false, broken);
    assert.equal(reloads, 0, broken);
    assert.equal(reloadOnce(() => session(broken)), false, broken);
  }
  assert.equal(reloadOnce(() => { throw new Error('SecurityError'); }), false);
});

test('controllerReady says whether a worker took the page in time', async () => {
  assert.equal(await controllerReady(container({ takes: true }), 500), true);
  assert.equal(await controllerReady(container({ takes: false }), 50), false);
  assert.equal(await controllerReady(undefined), true);
});
