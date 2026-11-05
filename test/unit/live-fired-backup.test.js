import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, iso, off, MONTEREY } from './live-kit.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { logEvent } from '../../src/core/events.js';
import { readWatches, watchPath } from '../../src/core/live/watches.js';

/** A fired one-time reminder stays fired, across a backup and its import (the user, 2026-11-05). @param {any} k */
async function backup(k) {
  const { blob } = await exportArchive(k.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  return peekArchive(new Uint8Array(await blob.arrayBuffer()));
}
/** The backup goes onto another annai, whose engine starts over what it imported. @param {any} opened @param {number} now @returns {Promise<{ k: any, copy: string }>} */
async function restored(opened, now) {
  const k = await liveKit({ start: now });
  const { trips: [copy] } = await importArchive(k.store, opened, { now });
  k.agent.target = copy; // the imported trip is the one open: every kind of watch is looked at
  await k.restart();
  await k.to(now + 120_000);
  return { k, copy };
}
const reminded = (/** @type {any} */ k, /** @type {string} */ id) => k.agent.wakes.filter((/** @type {any} */ w) => w.text.includes(id)).length;

test('a time reminder that fired and went: a backup taken after it, imported, does not fire it again', async () => {
  const a = await liveKit({ start: at('09:00') });
  const w = await a.live.setWatch(a.trip, { when: { type: 'time', at: iso('09:10') }, fallback: 'Off to lunch.' });
  await a.to(at('09:11'));
  assert.equal(reminded(a, w.id), 1);
  const { k, copy } = await restored(await backup(a), at('09:20'));
  assert.equal(reminded(k, w.id), 0);
  assert.deepEqual((await readWatches(k.ws, copy)).watches, []);
});

test('an activity reminder that fired and went: the same', async () => {
  const a = await liveKit({ start: at('09:00') });
  const w = await a.live.setWatch(a.trip, { when: { type: 'activity', activity: 'moving-fast' }, fallback: 'Off we go.' });
  let y = 0;
  for (let s = 0; s <= 60; s += 5) await a.fix(at('09:00') + s * 1000, off(MONTEREY, 0, -(y += 70)), { speed: 14 });
  assert.equal(reminded(a, w.id), 1);
  const { k, copy } = await restored(await backup(a), at('09:20'));
  let z = 0;
  for (let s = 0; s <= 60; s += 5) await k.fix(at('09:22') + s * 1000, off(MONTEREY, 0, -(z += 70)), { speed: 14 });
  assert.equal(k.live.activity, 'moving-fast');
  assert.equal(reminded(k, w.id), 0);
  assert.deepEqual((await readWatches(k.ws, copy)).watches, []);
});

test('a backup taken in the moment between the firing and the delete: its log says it fired, so the import does not fire it again, and its file goes without a word', async () => {
  for (const when of [{ type: 'time', at: iso('09:10') }, { type: 'activity', activity: 'moving-fast' }, { type: 'moved', km: 1 }]) {
    const a = await liveKit({ start: at('09:00') });
    const w = await a.live.setWatch(a.trip, { when, fallback: 'Remember this.' });
    await logEvent(a.store, a.trip, { type: 'trigger.fired', actor: 'system', data: { watch: w.id, type: when.type, owner: w.owner, text: 'it came due', fallback: w.fallback } }, at('09:00:30'));
    assert.equal((await readWatches(a.ws, a.trip)).watches.length, 1, 'not deleted yet');
    const { k, copy } = await restored(await backup(a), at('09:20'));
    let y = 0;
    for (let s = 0; s <= 60; s += 5) await k.fix(at('09:23') + s * 1000, off(MONTEREY, 0, -(y += 70)), { speed: 14 });
    assert.ok(k.live.odometer > 0.5, 'the road was driven');
    assert.equal(reminded(k, w.id), 0, when.type);
    assert.equal(await k.ws.read(copy, watchPath(w.id)), undefined, `${when.type}: its file is gone`);
  }
});

test('the same on the phone itself: killed between the firing and the delete, the next start does not fire it again', async () => {
  const k = await liveKit({ start: at('09:00') });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:10') }, fallback: 'Off to lunch.' });
  await logEvent(k.store, k.trip, { type: 'trigger.fired', actor: 'system', data: { watch: w.id, type: 'time', owner: w.owner, text: 'it came due', fallback: w.fallback } }, at('09:00:30'));
  await k.restart();
  await k.to(at('09:11'));
  assert.equal(reminded(k, w.id), 0);
});

test('what repeats keeps firing, and an untriggered one fires on import (accepted): only a one-time firing is spent', async () => {
  const a = await liveKit({ start: at('09:00') });
  const every = await a.live.setWatch(a.trip, { when: { type: 'every', minutes: 5 }, fallback: 'Stretch.' });
  const later = await a.live.setWatch(a.trip, { when: { type: 'time', at: iso('09:30') }, fallback: 'Coffee.' });
  await a.to(at('09:06'));
  assert.equal(reminded(a, every.id), 1);
  const { k } = await restored(await backup(a), at('09:40'));
  assert.ok(reminded(k, every.id) >= 1, 'every goes on');
  assert.equal(reminded(k, later.id), 1, 'came due while the backup waited');
});
