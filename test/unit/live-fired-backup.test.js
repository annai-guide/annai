import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, iso, off, MONTEREY } from './live-kit.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';
import { readWatches, watchPath } from '../../src/core/live/watches.js';

/** A fired one-time reminder stays fired, across a backup and its import (the user, 2026-11-05): it rests on deletion: a fired one's file is gone, so a backup has none to fire. @param {any} k */
async function backup(k) {
  const { blob } = await exportArchive(k.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  return peekArchive(new Uint8Array(await blob.arrayBuffer()));
}
/**
 * The backup goes onto another annai: the page that imports it hears tripsChanged (the Import screen), or the engine starts over it (the next load).
 * @param {any} opened @param {number} now @param {'tripsChanged' | 'restart'} how @returns {Promise<{ k: any, copy: string }>}
 */
async function restored(opened, now, how) {
  const k = await liveKit({ start: now });
  const { trips: [copy] } = await importArchive(k.store, opened, { now });
  k.agent.target = copy; // the imported trip is the one open: every kind of watch is looked at
  if (how === 'restart') await k.restart();
  else await k.live.tripsChanged();
  await k.settle();
  await k.to(now + 120_000);
  return { k, copy };
}
/** @param {any} k @param {string} id */
const reminded = (k, id) => k.agent.wakes.filter((/** @type {any} */ w) => w.text.includes(id)).length;
/** @param {any} k @param {number} t0 @param {number} [y0] */
async function road(k, t0, y0 = 0) {
  let y = y0;
  for (let s = 0; s <= 60; s += 5) await k.fix(t0 + s * 1000, off(MONTEREY, 0, -(y += 70)), { speed: 14 });
}

for (const how of /** @type {const} */ (['tripsChanged', 'restart'])) {
  test(`a time reminder that fired and went: a backup taken after it, imported (${how}), does not fire it again`, async () => {
    const a = await liveKit({ start: at('09:00') });
    const w = await a.live.setWatch(a.trip, { when: { type: 'time', at: iso('09:10') }, fallback: 'Off to lunch.' });
    await a.to(at('09:11'));
    assert.equal(reminded(a, w.id), 1);
    const { k, copy } = await restored(await backup(a), at('09:20'), how);
    assert.equal(reminded(k, w.id), 0);
    assert.deepEqual((await readWatches(k.ws, copy)).watches, []);
  });

  test(`an activity reminder and a moved reminder that fired and went: the same (${how})`, async () => {
    const a = await liveKit({ start: at('09:00') });
    const going = await a.live.setWatch(a.trip, { when: { type: 'activity', activity: 'moving-fast' }, fallback: 'Off we go.' });
    const moved = await a.live.setWatch(a.trip, { when: { type: 'moved', km: 0.5 }, fallback: 'Half a kilometre.' });
    await road(a, at('09:00'));
    assert.equal(reminded(a, going.id), 1);
    assert.equal(reminded(a, moved.id), 1);
    const { k, copy } = await restored(await backup(a), at('09:20'), how);
    await road(k, at('09:22'));
    assert.equal(k.live.activity, 'moving-fast');
    assert.ok(k.live.odometer > 0.5, 'the road was driven');
    assert.equal(reminded(k, going.id), 0);
    assert.equal(reminded(k, moved.id), 0);
    assert.deepEqual((await readWatches(k.ws, copy)).watches, []);
  });

  test(`what repeats keeps firing, and an untriggered one fires on import, the user's call (${how})`, async () => {
    const a = await liveKit({ start: at('09:00') });
    const every = await a.live.setWatch(a.trip, { when: { type: 'every', minutes: 5 }, fallback: 'Stretch.' });
    const later = await a.live.setWatch(a.trip, { when: { type: 'time', at: iso('09:30') }, fallback: 'Coffee.' });
    await a.to(at('09:06'));
    assert.equal(reminded(a, every.id), 1);
    const { k, copy } = await restored(await backup(a), at('09:40'), how);
    assert.ok(reminded(k, every.id) >= 1, 'every goes on');
    assert.equal(reminded(k, later.id), 1, 'came due while the backup waited');
    assert.deepEqual((await readWatches(k.ws, copy)).watches.map((/** @type {any} */ w) => w.id), [every.id]);
  });
}

test('a repeating watch that has fired, rewritten as one-time under the same id through the file tools, still fires: no reminder is lost to its old firing', async () => {
  const k = await liveKit({ start: at('09:00') });
  const w = await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 5 }, fallback: 'Stretch.' });
  await k.to(at('09:06'));
  const was = await k.ws.readJSON(k.trip, watchPath(w.id));
  await k.ws.write(k.trip, watchPath(w.id), { ...was, repeat: false, when: { type: 'time', at: iso('09:30') } }, { author: 'shiori' });
  await k.settle();
  const before = reminded(k, w.id);
  await k.to(at('09:31'));
  assert.equal(reminded(k, w.id), before + 1);
  assert.equal(await k.ws.read(k.trip, watchPath(w.id)), undefined, 'and goes');
});
