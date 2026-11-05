import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAwake } from '../../src/ui/wake-lock.js';
import { liveText, knownFix } from '../../src/ui/live-chip.js';
import { whereWords } from '../../src/ui/screens/now.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
/** Live mode as the wake lock sees it. @param {Record<string, any>} o */
function fakeLive(o) {
  /** @type {Set<() => void>} */
  const fns = new Set();
  return {
    on: true, shown: true, activity: 'unknown', ...o,
    onChange: (/** @type {() => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); },
    /** @param {Record<string, any>} c */
    set(c) {
      Object.assign(this, c);
      for (const fn of fns) fn();
    },
  };
}
/** A screen wake lock that counts, and can be let go as the browser does off screen. */
function fakeLock() {
  /** @type {any} */
  let current = null;
  const lock = {
    requests: 0, released: 0,
    async request(/** @type {string} */ type) {
      assert.equal(type, 'screen');
      lock.requests++;
      /** @type {Set<() => void>} */
      const fns = new Set();
      current = {
        addEventListener: (/** @type {string} */ _t, /** @type {() => void} */ fn) => fns.add(fn),
        release: async () => { lock.released++; for (const fn of fns) fn(); },
        browserRelease: () => { for (const fn of fns) fn(); },
      };
      return current;
    },
    browserRelease: () => current?.browserRelease(),
  };
  return lock;
}

test('the screen is kept on while GPS is on, by default, whatever the activity; let go off screen and asked for again; one setting turns it off (the second drive, item 3)', async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  // What older versions stored, per situation, is ignored.
  await updateAppSettings(ws, { live: { awake: { 'moving-fast': false, walking: false } } });
  const live = fakeLive({ activity: 'moving-fast' });
  const lock = fakeLock();
  const a = keepAwake({ live, ws, lock });
  await a.ready;
  assert.equal(a.available, true);
  assert.equal(a.chosen, true);
  assert.equal(a.held, true);
  assert.equal(lock.requests, 1);
  live.set({ activity: 'walking' });
  await tick();
  assert.equal(a.held, true);
  assert.equal(lock.requests, 1, 'the activity changes nothing');
  live.set({ shown: false });
  lock.browserRelease();
  await tick();
  assert.equal(a.held, false);
  live.set({ shown: true });
  await tick();
  assert.equal(a.held, true);
  assert.equal(lock.requests, 2);
  live.set({ on: false });
  await tick();
  assert.equal(a.held, false);
  live.set({ on: true });
  await tick();
  assert.equal(a.held, true);
  await a.choose(false);
  assert.equal(a.held, false);
  assert.equal(a.chosen, false);
  assert.equal((await readAppSettings(ws)).live.keepScreenOn, false);
  const again = keepAwake({ live: fakeLive({ activity: 'still' }), ws, lock: fakeLock() });
  await again.ready;
  assert.equal(again.held, false); // a later start remembers the choice
  await again.choose(true);
  assert.equal(again.held, true);
  const none = keepAwake({ live: fakeLive({ activity: 'moving-fast' }), ws, lock: null });
  await none.ready;
  assert.equal(none.available, false);
  assert.equal(none.held, false);
});

test('the live chip says how things stand, in a few words', () => {
  assert.equal(liveText({ on: false, gps: 'off', activity: 'unknown', fix: null }), 'GPS off');
  assert.equal(liveText({ on: true, gps: 'waiting', activity: 'unknown', fix: null }), 'GPS on · finding you');
  assert.equal(liveText({ on: true, gps: 'unavailable', activity: 'unknown', fix: null }), 'GPS on · no signal');
  assert.equal(liveText({ on: true, gps: 'denied', activity: 'unknown', fix: null }), 'GPS on · no location');
  const now = Date.now();
  assert.equal(liveText({ on: true, gps: 'denied', activity: 'unknown', fix: { lat: 1, lng: 2, at: now - 3_600_000, source: 'manual' } }), 'GPS on'); // a place the user set
  assert.equal(liveText({ on: true, gps: 'ok', activity: 'moving-fast', fix: { lat: 1, lng: 2, at: now, source: 'gps' } }), 'GPS on · moving fast');
  assert.equal(liveText({ on: true, gps: 'ok', activity: 'still', fix: { lat: 1, lng: 2, at: now, source: 'gps' } }), 'GPS on · stopped');
});

test('a GPS position from before the GPS was lost, or too old, is not shown as where you are (B1)', () => {
  const now = Date.now();
  const old = { lat: 36.3715, lng: -121.9017, at: now - 60_000, source: 'gps' };
  assert.equal(liveText({ on: true, gps: 'denied', activity: 'still', fix: old }), 'GPS on · no location');
  assert.equal(liveText({ on: true, gps: 'unavailable', activity: 'moving-fast', fix: old }), 'GPS on · no signal');
  assert.equal(liveText({ on: true, gps: 'ok', activity: 'still', fix: { ...old, at: now - 11 * 60_000 } }), 'GPS on · finding you');
  const live = (/** @type {any} */ o) => ({ on: true, activity: 'still', near: () => ({ name: 'Bixby Creek Bridge', m: 10 }), ...o });
  assert.equal(whereWords(live({ gps: 'denied', fix: old })), "Location isn't allowed for annai. Open Driving to say where you are.");
  assert.equal(whereWords(live({ gps: 'unavailable', fix: old })), 'No GPS signal right now. Open Driving to say where you are.');
  assert.equal(whereWords(live({ gps: 'ok', fix: { ...old, at: now - 11 * 60_000 } })), 'Finding where you are…');
  assert.equal(whereWords(live({ gps: 'ok', fix: { ...old, at: now } })), 'At Bixby Creek Bridge');
  assert.equal(whereWords(live({ gps: 'denied', fix: { ...old, source: 'manual' } })), 'At Bixby Creek Bridge');
  assert.equal(knownFix({ on: true, gps: 'ok', fix: { ...old, at: now } })?.lat, 36.3715);
  assert.equal(knownFix({ on: true, gps: 'denied', fix: old }), null);
});
