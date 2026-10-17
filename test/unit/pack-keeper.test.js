import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackKeeper } from '../../src/core/pack/keeper.js';
import { STALE_MS } from '../../src/core/pack/download.js';
import { packTrip, services, fakeAgent, STOPS } from './pack-kit.js';
import { packWords } from '../../src/ui/offline-pack.js';

/** @param {() => boolean | Promise<boolean>} ok */
async function until(ok, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** @param {{ connection?: string, visible?: boolean, now?: () => number }} [o] */
async function kit(o = {}) {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  let connection = o.connection ?? 'unknown';
  let visible = o.visible ?? true;
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, version: '1.2.3', connection: () => connection, visible: () => visible, fetch: net.fetch, quietMs: 20, pokeMs: 10, gapMs: 0, now: o.now });
  return { ...t, agent, net, keeper, set: (/** @type {{ connection?: string, visible?: boolean }} */ s) => { connection = s.connection ?? connection; visible = s.visible ?? visible; } };
}

test('status before any download: the stops, about how much it takes, nothing outdated', async () => {
  const { keeper, trip } = await kit();
  const s = await keeper.status(trip);
  assert.equal(s.stops, 2);
  assert.equal(s.manifest, null);
  assert.equal(s.why, null);
  assert.ok(s.estimate > 50 * 1024 && s.estimate < 200 * 1024, String(s.estimate));
  assert.equal(s.running, null);
  keeper.dispose();
});

test("one download at a time, with progress; then the pack is up to date, and the trip's log says so", async () => {
  const { keeper, trip, store } = await kit();
  /** @type {any[]} */
  const seen = [];
  keeper.onChange(() => seen.push(keeper.running && { ...keeper.running }));
  const a = keeper.download(trip);
  assert.equal(keeper.download(trip), a);
  const m = await a;
  assert.equal(m.files.length, 7);
  assert.ok(seen.some((r) => r?.total > 0 && r.label));
  assert.equal(seen.at(-1), null);
  const s = await keeper.status(trip);
  assert.equal(s.why, null);
  assert.ok(s.manifest);
  const log = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['pack.download'] }));
  assert.deepEqual(log.map((e) => e.data), [{ files: 7, bytes: m.bytes, guides: 2, failed: 0, stopped: false, full: false, auto: false }]);
  keeper.dispose();
});

test('why an update: the plan changed, parts are missing, or it is a month old', async () => {
  let now = Date.now();
  const { keeper, trip, ws } = await kit({ now: () => now });
  await keeper.download(trip);
  await ws.write(trip, '/plan/mcway.json', { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at: '2026-11-27T21:45:00Z' }, place: { name: 'McWay Falls', lat: 36.158, lng: -121.672 } }, { author: 'user' });
  const changed = await keeper.status(trip);
  assert.equal(changed.why, 'plan');
  assert.ok(changed.estimate > 0);
  await ws.delete(trip, '/plan/mcway.json', { author: 'user' });
  const m = /** @type {any} */ (await ws.readJSON(trip, '/offline/pack.json'));
  await ws.delete(trip, m.files[0].path, { author: 'user' });
  assert.equal((await keeper.status(trip)).why, 'missing');
  await keeper.download(trip);
  assert.equal((await keeper.status(trip)).why, null);
  now += STALE_MS + 1;
  assert.equal((await keeper.status(trip)).why, 'old');
  keeper.dispose();
});

test('stop() stops the download; what came stays', async () => {
  const { keeper, trip } = await kit();
  const off = keeper.onChange(() => { if ((keeper.running?.done ?? 0) >= 2) keeper.stop(); });
  const m = await keeper.download(trip);
  off();
  assert.equal(m.stopped, true);
  assert.equal((await keeper.status(trip)).why, 'missing');
  keeper.dispose();
});

test('opening another trip stops a running download (choice 10)', async () => {
  const { keeper, trip, agent } = await kit();
  const off = keeper.onChange(() => { if (keeper.running?.done === 1) agent.open(null); });
  const m = await keeper.download(trip);
  off();
  assert.equal(m.stopped, true);
  keeper.dispose();
});

test('on Wi-Fi an outdated pack is brought up to date by itself once the plan is quiet; not on mobile data, not before a first download, not hidden', async () => {
  const { keeper, trip, ws, net, set } = await kit({ connection: 'cellular' });
  const plan = (/** @type {number} */ lat) => ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat } }, { author: 'user' });
  await plan(36.2);
  set({ connection: 'wifi' });
  keeper.poke();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, 0, 'no first download by itself');
  await keeper.download(trip);
  const asked = net.asked.length;
  set({ connection: 'cellular' });
  await plan(36.19);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, asked, 'not on mobile data');
  set({ connection: 'wifi', visible: false });
  keeper.poke();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, asked, 'not while annai is hidden');
  set({ visible: true });
  keeper.poke();
  await until(async () => (await keeper.status(trip)).why === null && net.asked.length > asked);
  const log = await keeper.o.store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['pack.download'] }));
  assert.equal(log.at(-1)?.data.auto, true);
  keeper.dispose();
});

test('by itself at most once an hour, even when parts keep failing', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  let fail = false;
  const net = services({ overpass: (url, init) => (fail ? new Response('', { status: 503 }) : { elements: [] }) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0 });
  await keeper.download(t.trip);
  fail = true;
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await until(async () => ((await keeper.status(t.trip)).manifest?.failed.length ?? 0) > 0); // the update by itself ran, and failed in part
  const asked = net.asked.length;
  keeper.poke();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(net.asked.length, asked);
  keeper.dispose();
});

test("live mode's names come from the open trip's pack", async () => {
  const { keeper, trip, agent } = await kit();
  const here = { lat: 36.3715, lng: -121.9017 };
  assert.equal(keeper.name(here), null);
  await keeper.download(trip);
  await until(() => keeper.name(here) !== null);
  assert.equal(keeper.name(here)?.name, 'Bixby Creek Bridge');
  agent.open(null);
  await until(() => keeper.name(here) === null);
  keeper.dispose();
});

test('a plan change while a download runs is kept: once it ends, annai brings the pack up to date by itself on Wi-Fi', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  /** @type {(v?: unknown) => void} */
  let open = () => {};
  const gate = new Promise((r) => { open = r; });
  let calls = 0;
  let waiting = false;
  const net = services({ overpass: async () => {
    if (++calls === 2) {
      waiting = true;
      await gate;
    }
    return { elements: [] };
  } });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0 });
  const running = keeper.download(t.trip);
  await until(() => waiting);
  // The plan changes while the second Overpass part waits for its answer.
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await new Promise((r) => setTimeout(r, 40)); // the plan is quiet: annai would update, but a download runs
  open();
  await running;
  await until(async () => (await keeper.status(t.trip)).why === null, 3000);
  const log = await t.store.tx(['events'], 'readonly', (x) => x.listEvents(t.trip, { types: ['pack.download'] }));
  assert.deepEqual(log.map((e) => e.data.auto), [false, true]);
  keeper.dispose();
});

test('a pack at its size limit is complete for its plan: no "Download the rest", and nothing asked again by itself every hour', async () => {
  let now = Date.now();
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0, now: () => now, maxBytes: 600 });
  const m = await keeper.download(t.trip);
  assert.equal(m.full, true);
  const s = await keeper.status(t.trip);
  assert.equal(s.why, null);
  assert.equal(packWords(s, 'wifi').button, null);
  assert.ok(packWords(s, 'wifi').lines.some((l) => /stopped at its .* limit/.test(l)));
  const asked = net.asked.length;
  now += 2 * 3_600_000;
  keeper.poke();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(net.asked.length, asked);
  keeper.dispose();
});

test('stop() can be awaited: once it settles, the download has ended and what came is written down', async () => {
  const t = await packTrip();
  let waiting = false;
  const net = services({ overpass: async (url, init) => {
    waiting = true;
    // Overpass takes its time; the stop cuts the wait short.
    await new Promise((r) => { init.signal.addEventListener('abort', r, { once: true }); });
    throw new DOMException('Stopped.', 'AbortError');
  } });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent: fakeAgent(t.trip), version: '1', connection: () => 'wifi', fetch: net.fetch, gapMs: 0 });
  const running = keeper.download(t.trip);
  await until(() => waiting);
  await keeper.stop();
  assert.equal(keeper.running, null);
  assert.equal((await keeper.status(t.trip)).manifest?.stopped, true);
  assert.equal((await running).stopped, true);
  await keeper.stop(); // nothing running: settles at once
  keeper.dispose();
});
