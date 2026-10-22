import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginsMayLoad, mayReload, controllerReady, RELOADED, RELOAD_GAP } from '../../src/app/claim.js';

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
 * lookup: getRegistration() answers, fails, or never answers.
 * @param {{ controlled?: boolean, active?: boolean, takes?: boolean, lookup?: 'answers' | 'fails' | 'hangs' }} o
 */
function container({ controlled = false, active = true, takes = true, lookup = 'answers' }) {
  const sw = /** @type {any} */ (new EventTarget());
  sw.controller = controlled ? {} : null;
  sw.asked = 0;
  const worker = { postMessage: (/** @type {unknown} */ m) => {
    if (m !== 'claim') return;
    sw.asked++;
    if (takes) setTimeout(() => { sw.controller = worker; sw.dispatchEvent(new Event('controllerchange')); }, 5);
  } };
  sw.getRegistration = () => (lookup === 'fails' ? Promise.reject(new Error('InvalidStateError')) : lookup === 'hangs' ? new Promise(() => {})
    : Promise.resolve(active ? { active: worker } : undefined));
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

test('a page the worker does not take reloads, noted with its time; another within 2 minutes does not, nor one with a time ahead of now or unreadable', async () => {
  const kept = session();
  let reloads = 0;
  const load = (/** @type {number} */ at, sw = container({ takes: false })) => pluginsMayLoad({ sw, session: () => kept, reload: () => { reloads++; }, now: () => at, wait: 50 });
  assert.equal(await within(load(1_000_000), 300), 'pending', 'the page goes: plugins never start in it');
  assert.equal(reloads, 1);
  assert.equal(kept.m.get(RELOADED), '1000000');
  // The reload came up past the worker again, 30 s on: no reload, and plugins can't load (a card offers Reload now).
  const sw = container({ takes: false });
  assert.equal(await load(1_030_000, sw), false);
  assert.equal(sw.asked, 1, 'it asked to be taken first');
  assert.equal(reloads, 1);
  // A second failure 3 minutes after the reload is a new one: it reloads.
  assert.equal(await within(load(1_000_000 + 3 * 60_000), 300), 'pending');
  assert.equal(reloads, 2);
  assert.equal(kept.m.get(RELOADED), String(1_000_000 + 3 * 60_000));
  // A time ahead of now, or one that can't be read, counts as recent.
  for (const was of [String(5_000_000), '', 'soon', '12abc']) {
    kept.m.set(RELOADED, was);
    assert.equal(await load(2_000_000), false, JSON.stringify(was));
  }
  assert.equal(reloads, 2);
  assert.equal(RELOAD_GAP, 2 * 60_000);
});

test('no reload by itself once the user has done anything on the page: plugins wait for their Reload now', async () => {
  const kept = session();
  let reloads = 0;
  assert.equal(await pluginsMayLoad({ sw: container({ takes: false }), session: () => kept, reload: () => { reloads++; }, used: () => true, wait: 50 }), false);
  assert.equal(reloads, 0);
  assert.equal(kept.m.size, 0, 'no reload noted, so a later failure may still reload');
});

test('a registration lookup that fails or never answers is no first visit: no plugin is imported, and no reload by itself', async () => {
  for (const lookup of /** @type {const} */ (['fails', 'hangs'])) {
    let reloads = 0;
    assert.equal(await pluginsMayLoad({ sw: container({ lookup }), session: () => session(), reload: () => { reloads++; }, wait: 50, lookup: 50 }), false, lookup);
    assert.equal(reloads, 0, lookup);
  }
});

test('no reload where sessionStorage is blocked or keeps nothing, so it can never loop', async () => {
  for (const broken of /** @type {const} */ (['throws', 'forgets'])) {
    let reloads = 0;
    assert.equal(await pluginsMayLoad({ sw: container({ takes: false }), session: () => session(broken), reload: () => { reloads++; }, wait: 50 }), false, broken);
    assert.equal(reloads, 0, broken);
    assert.equal(mayReload(() => session(broken)), false, broken);
  }
  assert.equal(mayReload(() => { throw new Error('SecurityError'); }), false);
});

test('controllerReady says whether a worker took the page in time', async () => {
  assert.equal(await controllerReady(container({ takes: true }), 500), true);
  assert.equal(await controllerReady(container({ takes: false }), 50), false);
  assert.equal(await controllerReady(undefined), true);
});
