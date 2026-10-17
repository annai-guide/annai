import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sensors } from '../../src/plugins/sensors/index.js';
import { gpsProblem, tellGps } from '../../src/ui/live-help.js';

/** Enough of a browser for the sensors. @param {{ visible?: boolean, online?: boolean, geolocation?: boolean }} [o] */
function fakeBrowser({ visible = true, online = true, geolocation = true } = {}) {
  /** @param {Map<string, Function[]>} map */
  const target = (map) => ({
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { map.set(t, [...(map.get(t) ?? []), fn]); },
    removeEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => { map.set(t, (map.get(t) ?? []).filter((f) => f !== fn)); },
  });
  const docs = new Map();
  const wins = new Map();
  const doc = { visibilityState: visible ? 'visible' : 'hidden', ...target(docs) };
  const nav = { onLine: online };
  /** @type {Map<number, { ok: Function, err: Function, opts: any }>} */
  const watches = new Map();
  let next = 1;
  const geo = {
    watchPosition: (/** @type {Function} */ ok, /** @type {Function} */ err, /** @type {any} */ opts) => { watches.set(next, { ok, err, opts }); return next++; },
    clearWatch: (/** @type {number} */ id) => { watches.delete(id); },
  };
  /** @param {Map<string, Function[]>} map @param {string} type @param {any} [e] */
  const fire = (map, type, e = {}) => { for (const fn of map.get(type) ?? []) fn(e); };
  return {
    env: /** @type {any} */ ({ geolocation: geolocation ? geo : undefined, document: doc, window: target(wins), navigator: nav }),
    doc, nav, watches, docs, wins,
    docEvent: (/** @type {string} */ t, /** @type {any} */ e) => fire(docs, t, e),
    winEvent: (/** @type {string} */ t, /** @type {any} */ e) => fire(wins, t, e),
  };
}
/** @param {ReturnType<typeof fakeBrowser>} b */
const byKind = (b) => Object.fromEntries(sensors(b.env).map((s) => [s.kind, s]));

test('location: watched with high accuracy while started; positions, refusals and lost signals come in; stopping clears it (spec §11.2)', () => {
  const b = fakeBrowser();
  /** @type {any[]} */
  const got = [];
  const stop = byKind(b).location.start((/** @type {any} */ x) => got.push(x));
  assert.equal(b.watches.size, 1);
  const w = [...b.watches.values()][0];
  assert.deepEqual(w.opts, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  w.ok({ coords: { latitude: 36.37, longitude: -121.9, accuracy: 12, speed: 14.5, heading: 170 } });
  w.ok({ coords: { latitude: 36.37, longitude: -121.9, accuracy: 12, speed: null, heading: NaN } });
  w.err({ code: 1, message: 'User denied Geolocation' });
  w.err({ code: 2, message: 'Position unavailable' });
  w.err({ code: 3, message: 'Timeout expired' });
  assert.deepEqual(got, [
    { lat: 36.37, lng: -121.9, accuracy: 12, speed: 14.5, heading: 170 },
    { lat: 36.37, lng: -121.9, accuracy: 12, speed: null, heading: null },
    { error: 'denied', message: 'User denied Geolocation' },
    { error: 'unavailable', message: 'Position unavailable' },
    { error: 'unavailable', message: 'Timeout expired' },
  ]);
  stop?.();
  assert.equal(b.watches.size, 0);
  /** @type {any[]} */
  const none = [];
  byKind(fakeBrowser({ geolocation: false })).location.start((/** @type {any} */ x) => none.push(x));
  assert.deepEqual(none, [{ error: 'unavailable', message: "This browser can't tell where it is." }]);
});

test('visibility: what it is at the start, then each change; the back-forward cache is off screen and on again', () => {
  const b = fakeBrowser();
  /** @type {boolean[]} */
  const got = [];
  const stop = byKind(b).visibility.start((/** @type {boolean} */ v) => got.push(v));
  b.doc.visibilityState = 'hidden';
  b.docEvent('visibilitychange');
  b.doc.visibilityState = 'visible';
  b.docEvent('visibilitychange');
  b.winEvent('pagehide', { persisted: true });
  b.winEvent('pageshow', { persisted: true });
  assert.deepEqual(got, [true, false, true, false, true]);
  stop?.();
  b.docEvent('visibilitychange');
  assert.equal(got.length, 5);
});

test('connectivity: as it is at the start, then offline and online', () => {
  const b = fakeBrowser({ online: false });
  /** @type {boolean[]} */
  const got = [];
  const stop = byKind(b).connectivity.start((/** @type {boolean} */ v) => got.push(v));
  b.nav.onLine = true;
  b.winEvent('online');
  b.nav.onLine = false;
  b.winEvent('offline');
  assert.deepEqual(got, [false, true, false]);
  stop?.();
  b.winEvent('online');
  assert.equal(got.length, 3);
});

test('a refused location gets one card, with steps for this phone (spec §17 rule 3)', () => {
  assert.equal(gpsProblem('ios').title, "annai can't see where you are");
  assert.match(gpsProblem('ios').body, /Settings → Privacy & Security → Location Services/);
  assert.match(gpsProblem('android').body, /allow Location/);
  assert.match(gpsProblem('desktop').body, /site settings/);
  assert.match(gpsProblem('ios').body, /Live → Where are you/);
  /** @type {Set<() => void>} */
  const fns = new Set();
  const live = { on: true, gps: 'waiting', onChange: (/** @type {() => void} */ fn) => { fns.add(fn); return () => fns.delete(fn); } };
  /** @type {any[]} */
  const cards = [];
  tellGps({ live, notices: { card: (/** @type {any} */ c) => cards.push(c) }, where: 'android' });
  const tick = () => { for (const fn of fns) fn(); };
  live.gps = 'denied';
  tick();
  tick();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].tone, 'warn');
  live.gps = 'ok';
  tick();
  live.gps = 'denied';
  tick();
  assert.equal(cards.length, 2);
});
