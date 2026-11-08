import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, syncTripTitles, backfillTrips } from '../../src/core/scopes.js';
import { ensureDraft } from '../../src/core/chats.js';
import { record } from '../../src/core/agent/log.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { fakeAgent, fakeSensors, memoryKeep, at, iso, LA } from './live-kit.js';

/** Counts the store's transactions, and the read-write ones, from now. @param {any} store */
function counting(store) {
  const real = store.tx.bind(store);
  const n = { all: 0, rw: 0 };
  store.tx = (/** @type {any} */ names, /** @type {any} */ mode, /** @type {any} */ fn) => {
    n.all++;
    if (mode === 'readwrite') n.rw++;
    return real(names, mode, fn);
  };
  return { n, reset: () => { n.all = 0; n.rw = 0; } };
}

/** 500 undated chats over a year, six lines each would be the fixture's; here one line each, 3 dated trips, one with a watch. */
async function fiveHundred() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  syncTripTitles(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await updateAppSettings(ws, { live: { on: true } });
  /** @type {string[]} */
  const chats = [];
  for (let i = 0; i < 500; i++) {
    const id = await createTrip(ws, { title: `Chat ${i}` });
    await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', `Line ${i}`]], now: at('09:00') - i * 17 * 3_600_000 });
    chats.push(id);
  }
  const trips = [];
  for (const [title, start, end] of [['Testville', '2026-11-27', '2026-11-28'], ['Laterton', '2026-12-10', '2026-12-12'], ['Earlier', '2026-10-01', '2026-10-03']]) trips.push(await createTrip(ws, { title, start, end }));
  await ws.write(trips[0], '/watches/tea.json', { id: 'tea', owner: 'shiori', when: { type: 'time', at: iso('16:00') }, fallback: 'Tea.', created: iso('08:00') }, { author: 'shiori' });
  await ensureDraft(ws);
  return { registry, store, ws, chats, trips };
}

test('500 chats: transactions do not follow chats', async (t) => {
  const { registry, store, ws, chats, trips } = await fiveHundred();
  const count = counting(store);
  // A start, from before backfillTrips (src/app/main.js) through live.start().
  await backfillTrips(ws);
  assert.equal(count.n.rw, 0, 'nothing to mirror: no read-write transaction');
  assert.ok(count.n.all <= 3, `backfill: ${count.n.all} transactions`);
  t.diagnostic(`backfill: ${count.n.all} transactions, ${count.n.rw} read-write`);
  const agent = fakeAgent(trips[0]);
  fakeSensors(registry);
  const live = new Live({ store, ws, registry, agent, clock: new ManualClock(at('08:30')), keep: memoryKeep(), timeZone: () => LA });
  count.reset();
  await live.start();
  await live.settled();
  const scoped = 4; // the trips with watches, the dated trips and me
  assert.ok(count.n.all <= 5 + 8 * scoped, `live start: ${count.n.all} transactions`);
  t.diagnostic(`live start: ${count.n.all} transactions`);
  assert.equal(live.play, trips[0]);
  // Opening a chat: a constant, whatever the number of chats.
  count.reset();
  agent.opened(chats[3]);
  await live.settled();
  assert.ok(count.n.all <= 3, `an open: ${count.n.all} transactions`);
  t.diagnostic(`an open: ${count.n.all} transactions`);
  live.dispose();
});

test('a trip whose record differs is mirrored at the start, and only it', async () => {
  const { store, ws, trips } = await fiveHundred();
  // A date edit whose mirror failed: the record still has the old dates.
  await store.tx(['scopes'], 'readwrite', async (t) => {
    const rec = /** @type {any} */ (await t.getScope(trips[1]));
    await t.putScope({ ...rec, start: '2026-12-01' });
  });
  const count = counting(store);
  await backfillTrips(ws);
  assert.equal(count.n.rw, 1);
  assert.equal((await store.tx(['scopes'], 'readonly', (t) => t.getScope(trips[1])))?.start, '2026-12-10');
});
