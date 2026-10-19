import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Updates, SOON, DAILY } from '../../src/ui/updates.js';
import { fetchPackage } from '../../src/core/packages.js';
import { SKILL, hostKit } from './package-kit.js';

// When annai looks for updates (the user, 2026-10-18): an iPhone Home Screen app that comes back from the
// background only resumes, so the browser never checks; annai checks when it comes back to the screen.

const ADDR = 'https://trails.example/tide-pools/SKILL.md';
const tick = () => new Promise((r) => setTimeout(r, 0));

const fakeNotices = () => {
  /** @type {any[]} */
  const cards = [];
  /** @type {string[]} */
  const toasts = [];
  return {
    cards, toasts,
    card: (/** @type {any} */ c) => { cards.push(c); return () => { c.dismissed = true; }; },
    toast: (/** @type {string} */ t) => toasts.push(t),
  };
};

/**
 * annai with a skill installed from an address, a clock and a connection of the test's own, and counts of
 * what was asked: annai's service worker, its catalog, and the skill's address.
 */
async function kit({ limitMs = 45_000 } = {}) {
  const { host } = await hostKit();
  let served = SKILL;
  const asked = { app: 0, catalog: 0, address: 0 };
  /** @type {() => Promise<Response>} */
  let catalog = async () => new Response(JSON.stringify({ plugins: [] }));
  /** @type {() => Promise<Response>} */
  let address = async () => new Response(served);
  await host.install(await fetchPackage(ADDR, { fetch: () => address() }), { source: 'url', url: ADDR });
  const c = {
    host, asked, t: 1_000_000, on: true,
    serve: (/** @type {string} */ s) => { served = s; },
    /** @param {{ catalog?: () => Promise<Response>, address?: () => Promise<Response> }} o */
    answer: (o) => { catalog = o.catalog ?? catalog; address = o.address ?? address; },
    /** @type {() => Promise<void>} */
    appCheck: async () => {},
    notices: fakeNotices(),
  };
  const updates = new Updates({
    host,
    env: {
      fetch: async (url) => { if (String(url).endsWith('/catalog/plugins.json')) asked.catalog++; return catalog(); },
      addressFetch: async (url) => { if (url === ADDR) asked.address++; return address(); },
    },
    now: () => c.t,
    online: () => c.on,
    limitMs,
  });
  updates.app = { check: () => { asked.app++; return c.appCheck(); }, state: () => 'none' };
  updates.notices = c.notices;
  return Object.assign(c, { updates, counts: () => ({ ...asked }) });
}

test('coming back checks annai and its official plugins at most every 15 minutes, and plugins from an address at most once a day', async () => {
  const k = await kit();
  assert.equal(await k.updates.auto(), null, 'nothing before the check at start');
  assert.deepEqual(k.counts(), { app: 0, catalog: 0, address: 0 });
  await k.updates.start();
  // At start the browser checks annai itself, as it opens the page; annai checks its plugins, both kinds.
  assert.deepEqual(k.counts(), { app: 0, catalog: 1, address: 1 });
  k.t += SOON - 1;
  assert.equal(await k.updates.auto(), null);
  assert.deepEqual(k.counts(), { app: 0, catalog: 1, address: 1 });
  k.t += 1;
  await k.updates.auto();
  assert.deepEqual(k.counts(), { app: 1, catalog: 2, address: 1 }, '15 minutes on: annai and the catalog, not the address');
  k.t += SOON / 2;
  assert.equal(await k.updates.auto(), null);
  k.t = 1_000_000 + DAILY;
  await k.updates.auto();
  assert.deepEqual(k.counts(), { app: 2, catalog: 3, address: 2 }, 'a day on: the address too');
  assert.equal(k.updates.checkedAt, k.t);
});

test('nothing is checked while annai is offline, automatically or on Check now; online again, coming back checks', async () => {
  const k = await kit();
  k.on = false;
  await k.updates.start();
  k.t += DAILY;
  await k.updates.auto();
  assert.deepEqual(k.counts(), { app: 0, catalog: 0, address: 0 });
  const r = await k.updates.checkNow();
  assert.equal(r?.offline, true);
  assert.deepEqual(k.counts(), { app: 0, catalog: 0, address: 0 });
  assert.equal(k.updates.checkedAt, null);
  k.on = true;
  k.t += 1000;
  await k.updates.auto();
  assert.deepEqual(k.counts(), { app: 1, catalog: 1, address: 1 }, 'an offline moment is no check');
});

test('Check now checks annai and every plugin, address ones too, every time; coming back right after asks nothing again', async () => {
  const k = await kit();
  await k.updates.start();
  await k.updates.checkNow();
  k.t += 1000;
  await k.updates.checkNow();
  assert.deepEqual(k.counts(), { app: 2, catalog: 3, address: 3 });
  k.t += SOON - 1000;
  assert.equal(await k.updates.auto(), null);
  assert.deepEqual(k.counts(), { app: 2, catalog: 3, address: 3 });
});

test('a plugin from an address is checked at most once a day automatically, but always on Check now', async () => {
  const k = await kit();
  await k.updates.start();
  for (let i = 0; i < 4; i++) {
    k.t += SOON;
    await k.updates.auto();
  }
  assert.equal(k.counts().address, 1, 'an hour of coming back asked its site once, at start');
  await k.updates.checkNow();
  assert.equal(k.counts().address, 2);
  k.t += DAILY - 1;
  await k.updates.auto();
  assert.equal(k.counts().address, 2, 'Check now counts as its check of the day');
});

test('updates found when annai comes back are offered on one card, once each; Check now shows them without a card', async () => {
  const k = await kit();
  /** @type {boolean[]} */
  const changed = [];
  k.updates.changed = (waits) => { changed.push(waits); };
  await k.updates.start();
  assert.deepEqual(changed, [false, false], 'a check starts and ends; nothing waits, so Settings stays as drawn');
  assert.equal(k.notices.cards.length, 0);
  k.serve(SKILL.replace('version: "1.2"', 'version: "1.3"'));
  k.t += DAILY;
  const r = await k.updates.auto();
  assert.deepEqual(r?.found.map((u) => [u.id, u.available]), [['tide-pools', '1.3.0']]);
  assert.deepEqual(changed.slice(2), [false, true], 'found: Settings and Plugins are drawn again');
  assert.equal(k.notices.cards.length, 1);
  assert.equal(k.notices.cards[0].title, 'Plugin updates are ready');
  assert.match(k.notices.cards[0].body, /tide-pools 1\.2\.0 → 1\.3\.0/);
  k.t += DAILY;
  await k.updates.auto();
  assert.equal(k.notices.cards.length, 1, 'the same update is not offered again at every return');
  k.serve(SKILL.replace('version: "1.2"', 'version: "1.4"'));
  k.t += DAILY;
  await k.updates.auto();
  assert.equal(k.notices.cards.length, 2);
  assert.equal(k.notices.cards[0].dismissed, true, 'one card: the older one goes');
  assert.match(k.notices.cards[1].body, /1\.2\.0 → 1\.4\.0/);
  k.serve(SKILL.replace('version: "1.2"', 'version: "1.5"'));
  const now = await k.updates.checkNow();
  assert.deepEqual(now?.found.map((u) => u.available), ['1.5.0']);
  assert.equal(k.notices.cards.length, 2, 'Check now is on Settings → Updates, which lists them');
  assert.deepEqual((await k.updates.plugins()).map((u) => u.available), ['1.5.0']);
  changed.length = 0;
  k.notices.cards[1].actions[0].run(); // Update, on the card
  for (let i = 0; i < 100 && !changed.length; i++) await tick();
  assert.deepEqual(changed, [true], 'what waits changed: the screens showing it are drawn again');
  assert.deepEqual(await k.updates.plugins(), []);
});

test("Check now says what it couldn't check, in plain words", async () => {
  const k = await kit();
  await k.updates.start();
  k.appCheck = async () => { throw new TypeError('Failed to update a ServiceWorker: An unknown error occurred when fetching the script.'); };
  k.answer({ catalog: async () => new Response('', { status: 503 }), address: async () => { throw new TypeError('Failed to fetch'); } });
  const r = await k.updates.checkNow();
  assert.deepEqual(r?.failed, [
    "annai couldn't check for a new version of itself. Check the connection and try again.",
    "annai's list of plugins couldn't be loaded (HTTP 503). Try again later.",
    "tide-pools couldn't be checked: annai couldn't reach trails.example. Check the address, and that the site lets web apps read it.",
  ]);
  assert.equal(k.updates.last?.failed.length, 3);
  k.appCheck = async () => {};
  k.answer({ catalog: async () => new Response(JSON.stringify({ plugins: [] })), address: async () => new Response(SKILL) });
  assert.deepEqual((await k.updates.checkNow())?.failed, []);
});

test('Check now before annai\'s offline service has started says so', async () => {
  const k = await kit();
  k.updates.app = null;
  await k.updates.start();
  const r = await k.updates.checkNow();
  assert.deepEqual(r?.failed, ["annai's offline service hasn't started yet, so annai itself wasn't checked. Try again in a moment."]);
});

test('Check now waits for the sound unlock a tap starts (the Erase hang), and two taps make one check at a time', async () => {
  const k = await kit();
  /** @type {() => void} */
  let unlocked = () => {};
  k.updates.voice = { settled: () => new Promise((r) => { unlocked = () => r(undefined); }) };
  await k.updates.start();
  const first = k.updates.checkNow();
  await tick();
  assert.equal(k.counts().app, 0, 'not while the unlock starts its clip');
  unlocked();
  await first;
  assert.equal(k.counts().app, 1);
  k.updates.voice = null;
  /** @type {() => void} */
  let go = () => {};
  k.appCheck = () => new Promise((r) => { go = () => r(undefined); });
  const a = k.updates.checkNow();
  await tick();
  assert.equal(k.updates.checking, true);
  const b = k.updates.checkNow();
  go();
  await a;
  await tick();
  go();
  await b;
  assert.equal(k.counts().app, 3, 'the second waits for the first, then checks');
  assert.equal(k.updates.checking, false);
});

test('Restart now waits while Shiori works, then for the sound unlock, then uses the waiting version; with none waiting it reloads', async () => {
  const { host } = await hostKit();
  /** @type {string[]} */
  const did = [];
  /** @type {() => void} */
  let free = () => {};
  const agent = { busy: true, idle: () => new Promise((r) => { free = () => { agent.busy = false; r(undefined); }; }) };
  /** @type {() => void} */
  let unlocked = () => {};
  const voice = { settled: () => new Promise((r) => { unlocked = () => r(undefined); }) };
  const notices = fakeNotices();
  const u = new Updates({ host, reload: () => did.push('reload') });
  Object.assign(u, { agent, voice, notices });
  /** @type {boolean[]} */
  const changed = [];
  u.changed = (waits) => { changed.push(waits); };
  u.ready(() => did.push('swap'));
  assert.equal(u.waiting, true);
  assert.deepEqual(changed, [true], 'Settings lists Updates first now');
  const done = u.restart();
  await tick();
  assert.deepEqual(did, []);
  assert.equal(notices.cards[0].title, 'annai restarts once Shiori has finished');
  assert.match(notices.cards[0].body, /never lands during her turn/);
  u.restart(); // a second tap waits with the first
  free();
  await tick();
  assert.deepEqual(did, [], 'then the sound unlock');
  unlocked();
  await done;
  await tick();
  assert.deepEqual(did, ['swap']);

  const plain = new Updates({ host, reload: () => did.push('reload') });
  await plain.restart();
  assert.deepEqual(did, ['swap', 'reload']);
});

test("Settings → Updates says plainly what the last check said: checking, offline, what failed, or up to date", async () => {
  const { statusWords } = await import('../../src/ui/screens/updates.js');
  const now = 5_000_000;
  const at = now - 3 * 60_000;
  assert.deepEqual(statusWords({ checking: true, last: null, checkedAt: null }, false, now), { said: 'Checking annai and its plugins…', failed: [] });
  assert.deepEqual(statusWords({ checking: false, last: null, checkedAt: null }, false, now), { said: "annai hasn't checked since it started.", failed: [] });
  assert.deepEqual(statusWords({ checking: false, last: { failed: [], found: [] }, checkedAt: at }, false, now), { said: 'Last checked 3 minutes ago. Everything is up to date.', failed: [] });
  assert.deepEqual(statusWords({ checking: false, last: { failed: [], found: [] }, checkedAt: at }, true, now), { said: 'Last checked 3 minutes ago.', failed: [] }, 'something waits: not "up to date"');
  assert.deepEqual(statusWords({ checking: false, last: { offline: true, failed: [], found: [] }, checkedAt: at }, false, now),
    { said: "annai is offline, so it couldn't check. It checks again when you come back to it with a connection. Last checked 3 minutes ago.", failed: [] });
  assert.deepEqual(statusWords({ checking: false, last: { offline: true, failed: [], found: [] }, checkedAt: null }, false, now).said,
    "annai is offline, so it couldn't check. It checks again when you come back to it with a connection.");
  assert.deepEqual(statusWords({ checking: false, last: { failed: ['tide-pools couldn\'t be checked: …'], found: [] }, checkedAt: at }, false, now),
    { said: 'Last checked 3 minutes ago. Not everything could be checked:', failed: ['tide-pools couldn\'t be checked: …'] });
});

test('a check that hangs (a connection that stalls) ends after a time limit, in plain words, and Check now can be tapped again', async () => {
  const { host } = await hostKit();
  const updates = new Updates({ host, env: { fetch: async () => new Response(JSON.stringify({ plugins: [] })) }, online: () => true, limitMs: 20 });
  updates.app = { check: () => new Promise(() => {}), state: () => 'none' };
  await updates.start();
  const r = await updates.checkNow();
  assert.deepEqual(r?.failed, ["The check took too long. Check the connection, and try again."]);
  assert.equal(updates.checking, false);
  updates.app = { check: async () => {}, state: () => 'none' };
  assert.deepEqual((await updates.checkNow())?.failed, []);
});

test('a Restart now whose new version never takes over leaves later taps working', async () => {
  const { host } = await hostKit();
  let swaps = 0;
  const u = new Updates({ host, reload: () => {} });
  u.ready(() => { swaps++; });
  await u.restart();
  await u.restart();
  assert.equal(swaps, 2, 'the second tap asks again');
});

test("Don't restart, on the card a restart waiting for Shiori shows, calls it off; a later tap restarts", async () => {
  const { host } = await hostKit();
  /** @type {string[]} */
  const did = [];
  /** @type {() => void} */
  let free = () => {};
  const agent = { busy: true, idle: () => new Promise((r) => { free = () => { agent.busy = false; r(undefined); }; }) };
  const notices = fakeNotices();
  const u = new Updates({ host, reload: () => did.push('reload') });
  Object.assign(u, { agent, notices });
  /** @type {boolean[]} */
  const changed = [];
  u.changed = (waits) => { changed.push(waits); };
  u.ready(() => did.push('swap'));
  changed.length = 0;
  const first = u.restart();
  await tick();
  const [card] = notices.cards;
  assert.deepEqual(card.actions.map((/** @type {any} */ a) => a.label), ["Don't restart"]);
  card.actions[0].run();
  assert.deepEqual(changed, [false], 'Settings → Updates is drawn again: no "Restarting…"');
  free();
  await first;
  await tick();
  assert.deepEqual(did, [], 'called off: nothing restarts when she finishes');
  await u.restart();
  assert.deepEqual(did, ['swap']);
  assert.equal(notices.cards.length, 1, 'she was free: no card');
});

test('a check the time limit gave up on writes nothing when it answers late: no result, no time, no card, no updates', async () => {
  const k = await kit({ limitMs: 20 });
  await k.updates.start();
  /** @type {() => void} */
  let go = () => {};
  k.appCheck = () => new Promise((r) => { go = () => r(undefined); });
  k.t += DAILY;
  const given = await k.updates.auto();
  assert.deepEqual(given?.failed, ['The check took too long. Check the connection, and try again.']);
  k.appCheck = async () => {};
  k.t += 1000;
  await k.updates.checkNow();
  const at = k.updates.checkedAt;
  k.serve(SKILL.replace('version: "1.2"', 'version: "1.3"'));
  k.t += 1000;
  go(); // the stalled check answers now
  for (let i = 0; i < 50; i++) await tick();
  assert.deepEqual(k.updates.last?.failed, []);
  assert.equal(k.updates.checkedAt, at);
  assert.equal(k.notices.cards.length, 0);
  assert.deepEqual(await k.updates.plugins(), []);
});

test("a new version that didn't finish downloading is said, and Settings → Updates is drawn again", async () => {
  const k = await kit();
  await k.updates.start();
  /** @type {boolean[]} */
  const changed = [];
  k.updates.changed = (waits) => { changed.push(waits); };
  k.updates.downloadFailed();
  assert.deepEqual(k.updates.last?.failed, ["The download of the new version didn't finish. annai tries again the next time it checks."]);
  assert.deepEqual(changed, [false]);
});
