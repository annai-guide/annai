import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrip, removeTrip, SYS } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
import { TIMINGS, dueNow, changedSince, holdKey, startAutoBackup } from '../../src/core/backup-auto.js';
import { memoryPlace, device, placeOn } from './backup-kit.js';

const H = 3_600_000;
/** A place as dueNow sees it. @param {Record<string, any>} [o] @returns {any} */
const place = (o = {}) => ({ id: 'bt-1', type: 'memory', name: 'Memory', config: {}, auto: 'changes', mobileData: false, created: 0, checked: 1,
  last: { id: 'b1', at: 0, seqs: {}, bytes: 0 }, hold: null, ...o });
/** @param {Record<string, any>} [o] @returns {any} */
const env = (o = {}) => ({ now: 10 * H, visible: true, connection: 'wifi', changed: true, lastChangeAt: 10 * H - 5 * 60_000, ...o });
/** @param {any} r */
const why = (r) => (r.run ? `run ${r.maxUpload}` : r.why);
/** @param {number} at */
const lastAt = (at) => ({ id: 'b1', at, seqs: {}, bytes: 0 });

/** Each scope's last log entry now. @param {any} store @returns {Promise<Record<string, number>>} */
async function seqsNow(store) {
  return store.tx(['scopes', 'events'], 'readonly', async (/** @type {any} */ t) => Object.fromEntries(
    await Promise.all((await t.listScopes()).map(async (/** @type {any} */ s) => [s.id, await t.lastSeq(s.id)]))));
}

test('dueNow: daily or after changes, on Wi-Fi, with annai open, and only when something changed (spec §12.4)', () => {
  assert.equal(why(dueNow(place(), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ last: null }), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ auto: 'off' }), 'tree', env())), 'off');
  assert.equal(why(dueNow(place({ checked: null }), 'tree', env())), 'not set up');
  assert.equal(why(dueNow(place(), 'tree', env({ visible: false }))), 'not open');
  assert.equal(why(dueNow(place(), 'tree', env({ connection: 'offline' }))), 'offline');
  assert.equal(why(dueNow(place(), 'tree', env({ changed: false }))), 'nothing changed');
  assert.equal(why(dueNow(place(), 'tree', env({ lastChangeAt: 10 * H - 60_000 }))), 'changes still coming');
  // Mobile data waits for Wi-Fi unless the place may use it; a connection annai can't name sends small backups only.
  assert.equal(why(dueNow(place(), 'tree', env({ connection: 'cellular' }))), 'waiting for Wi-Fi');
  assert.equal(why(dueNow(place({ mobileData: true }), 'tree', env({ connection: 'cellular' }))), 'run Infinity');
  assert.equal(why(dueNow(place(), 'tree', env({ connection: 'unknown' }))), `run ${TIMINGS.askAbove}`);
  assert.equal(why(dueNow(place({ mobileData: true }), 'tree', env({ connection: 'unknown' }))), 'run Infinity');
  // The place's own limit for an unnamed connection, chosen by the user: a number, or none at all.
  assert.equal(why(dueNow(place({ askAbove: 5 * 1024 * 1024 }), 'tree', env({ connection: 'unknown' }))), `run ${5 * 1024 * 1024}`);
  assert.equal(why(dueNow(place({ askAbove: 0 }), 'tree', env({ connection: 'unknown' }))), 'run 0');
  assert.equal(why(dueNow(place({ askAbove: null }), 'tree', env({ connection: 'unknown' }))), 'run Infinity');
  assert.equal(why(dueNow(place({ askAbove: 5 * 1024 * 1024 }), 'tree', env())), 'run Infinity', "on Wi-Fi the limit doesn't apply");
  // How often: after changes, at most hourly to a tree and every 6 hours to a whole file; daily, once a day.
  assert.equal(why(dueNow(place({ last: lastAt(9.5 * H) }), 'tree', env())), 'backed up recently');
  assert.equal(why(dueNow(place({ last: lastAt(8.9 * H) }), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ last: lastAt(5 * H) }), 'file', env())), 'backed up recently');
  assert.equal(why(dueNow(place({ last: lastAt(3.9 * H) }), 'file', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ auto: 'daily', last: lastAt(-13 * H) }), 'tree', env())), 'backed up recently');
  assert.equal(why(dueNow(place({ auto: 'daily', last: lastAt(-15 * H) }), 'tree', env())), 'run Infinity');
  // What a place waits on.
  assert.equal(why(dueNow(place({ hold: { kind: 'newer', remote: { id: 'b9', at: 0 } } }), 'tree', env())), 'a newer backup is there');
  const error = { kind: 'error', message: 'x', at: 0, count: 1, retryAt: 11 * H, needsYou: false };
  assert.equal(why(dueNow(place({ hold: error }), 'tree', env())), 'waiting to try again');
  assert.equal(why(dueNow(place({ hold: { ...error, retryAt: 9 * H } }), 'tree', env())), 'run Infinity');
  const large = { kind: 'large', bytes: 9e7, at: 10 * H - 2 * 60_000 };
  assert.equal(why(dueNow(place({ hold: large }), 'tree', env({ connection: 'unknown' }))), 'waiting for your OK');
  assert.equal(why(dueNow(place({ hold: large }), 'tree', env())), 'run Infinity');
  assert.equal(why(dueNow(place({ hold: { ...large, at: 10 * H - 10 * 60_000 } }), 'tree', env({ connection: 'unknown' }))), `run ${TIMINGS.askAbove}`, 'it changed since annai asked');
  assert.equal(holdKey(place()), null);
  assert.equal(holdKey(place({ hold: { kind: 'newer', remote: { id: 'b9', at: 0 } } })), 'bt-1 newer b9');
  assert.equal(holdKey(place({ hold: { kind: 'newer', remote: { id: 'b9', at: 0 }, seen: true } })), null, 'the user found it testing the place, on its screen');
  assert.equal(holdKey(place({ hold: large })), `bt-1 large ${large.at}`);
  assert.equal(holdKey(place({ hold: error })), null, 'a passing problem shows only on the Backups screen');
  assert.equal(holdKey(place({ hold: { ...error, needsYou: true } })), 'bt-1 error x');
});

test("changedSince: what a backup holds changed after it; the system log and this device's own scope never count", async () => {
  const d = await device(memoryPlace());
  assert.equal((await changedSince(d.store, null)).changed, true);
  const seqs = await seqsNow(d.store);
  assert.deepEqual(await changedSince(d.store, seqs), { changed: false, lastChangeAt: null });
  await logEvent(d.store, SYS, { type: 'net.request', data: {} });
  await d.backups.add('memory'); // writes this device's own scope
  assert.equal((await changedSince(d.store, seqs)).changed, false);
  const before = Date.now();
  await d.ws.write(d.trip, '/notes/new.md', 'x', { author: 'user' });
  const after = await changedSince(d.store, seqs);
  assert.equal(after.changed, true);
  assert.ok((after.lastChangeAt ?? 0) >= before);
  const other = await createTrip(d.ws, { title: 'Kyoto' });
  const withOther = await seqsNow(d.store);
  await removeTrip(d.store, other);
  assert.equal((await changedSince(d.store, withOther)).changed, true, 'a trip removed since');
});

test('startAutoBackup backs up what is due, and tells of each new hold once', async () => {
  const shared = memoryPlace();
  const d = await device(shared);
  const id = await placeOn(d);
  await d.backups.check(id);
  /** @type {string[]} */
  const told = [];
  let ahead = 0;
  let visible = true;
  const auto = startAutoBackup({
    backups: d.backups, store: d.store, timings: { ...TIMINGS, tickMs: 24 * H }, now: () => Date.now() + ahead,
    env: () => ({ visible, connection: 'wifi' }), onHold: (t) => told.push(String(t.hold?.kind)),
  });
  try {
    await auto.tick();
    assert.equal(shared.kept.length, 0, 'changes are still coming: the trip was just made');
    ahead += TIMINGS.quietMs + 1000;
    await auto.tick();
    assert.equal(shared.kept.length, 1);
    await auto.tick();
    assert.equal(shared.kept.length, 1, 'nothing changed');
    await d.ws.write(d.trip, '/notes/x.md', 'x', { author: 'user' });
    await auto.tick();
    assert.equal(shared.kept.length, 2);
    visible = false;
    await d.ws.write(d.trip, '/notes/y.md', 'y', { author: 'user' });
    await auto.tick();
    assert.equal(shared.kept.length, 2, 'annai is not on screen');
    visible = true;
    // Another device backs up over this one's: this device waits, and says so once.
    const other = await device(shared, 'Android phone');
    const b = await placeOn(other);
    await other.backups.check(b);
    await other.backups.backUp(b, { over: true });
    await auto.tick();
    await auto.tick();
    assert.deepEqual(told, ['newer']);
    assert.equal(shared.kept.length, 3);
  } finally {
    auto.stop();
  }
});
