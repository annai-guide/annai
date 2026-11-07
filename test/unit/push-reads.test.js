import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushKit, breakReads, RELAY, at, iso, LA } from './push-kit.js';
import { FILE, TOKENS } from '../../src/core/push/mirror.js';
import { SYS_DEVICE } from '../../src/core/scopes.js';

// RULES.md: an absence counts as evidence only when the source was asked and answered. A read of /push.json or of the cancel tokens that
// failed is not "no state": the sync stops, and the file and the tokens stay as they were.

const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };

/** @typedef {Awaited<ReturnType<typeof pushKit>>} Kit */

const fileText = (/** @type {Kit} */ k) => k.ws.readText(SYS_DEVICE, FILE);
const tokens = (/** @type {Kit} */ k) => k.store.tx(['secrets'], 'readonly', (t) => t.getSecret(TOKENS));
const deletes = (/** @type {Kit} */ k) => k.net.calls.filter((c) => c.method === 'DELETE').length;

/** Notifications on with a copy waiting, and annai having said a reminder on screen this session (a `given` entry). @param {Record<string, any>} [plan] */
async function running(plan = { tea: TEA }) {
  const k = await pushKit({ plan, live: false });
  await k.mirror.turnOn(RELAY);
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.flush();
  await k.to(at('10:00'));
  await k.flush();
  assert.equal(k.agent.wakes.length, 1, 'said on the phone');
  assert.equal(k.live.given().length, 1, w.id);
  await k.mirror.sync(); // a sync that has seen it
  return k;
}

test('a read of /push.json that fails stops the sync: notifications stay on, the file keeps its items and its given', async () => {
  const k = await running();
  try {
    const before = await fileText(k);
    const off = deletes(k);
    const was = JSON.parse(String(before));
    assert.equal(was.on, true);
    assert.ok(Object.keys(was.items).length >= 1);
    assert.ok(Object.keys(was.given).length >= 1);
    let left = 1;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === SYS_DEVICE && path === FILE && left-- > 0);
    await assert.rejects(k.mirror.sync(), { name: 'AbortError' });
    b.heal();
    assert.deepEqual(b.log, [`getFile ${FILE}`]);
    assert.equal(await fileText(k), before, 'not one byte of it changed');
    assert.deepEqual(await k.mirror.status().then((s) => [s.on, s.relay, s.waiting]), [true, RELAY, Object.keys(was.items).length]);
    await k.mirror.sync();
    assert.equal(deletes(k), off, 'the copy at the relay was never called off');
    assert.deepEqual(Object.keys(JSON.parse(String(await fileText(k))).items), Object.keys(was.items));
  } finally {
    await k.stop();
  }
});

test('a read of the cancel tokens that fails stops the sync: a cancel is not dropped unsent, and the tokens stay', async () => {
  const k = await running();
  try {
    const kept = await tokens(k);
    const off = deletes(k);
    assert.ok(Object.keys(kept).length >= 1);
    // Tea moves, so its copy at the relay is to be called off in the next sync.
    await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA, start: { at: iso('17:00'), tz: LA } }, { author: 'user' });
    let left = 1;
    const b = breakReads(k, (op, id) => op === 'getSecret' && id === TOKENS && left-- > 0);
    await assert.rejects(k.mirror.sync(), { name: 'AbortError' });
    b.heal();
    assert.deepEqual(b.log, [`getSecret ${TOKENS}`]);
    assert.equal(deletes(k), off);
    assert.deepEqual(await tokens(k), kept, 'the tokens are as they were');
    await k.flush();
    assert.ok(deletes(k) > off, 'the next healthy sync calls the old copy off, with its token');
  } finally {
    await k.stop();
  }
});

test('a file that is not JSON is no state: the source answered. The file is replaced, as before', async () => {
  const k = await running();
  try {
    await k.ws.write(SYS_DEVICE, FILE, 'not json', { author: 'system', type: 'text/plain' });
    const st = await k.mirror.status();
    assert.equal(st.on, false);
    await k.mirror.sync();
    assert.equal(JSON.parse(String(await fileText(k))).on, false);
  } finally {
    await k.stop();
  }
});

test('a reminder firing on screen is not taken down by a push file that cannot be read, and the run is not left stuck', async () => {
  const k = await pushKit({ plan: { tea: TEA }, live: false });
  const warned = [];
  const warn = console.warn;
  console.warn = (/** @type {any[]} */ ...a) => { warned.push(a); };
  try {
    await k.mirror.turnOn(RELAY);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await k.flush();
    const before = await fileText(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === SYS_DEVICE && path === FILE);
    await k.to(at('10:00'));
    await k.flush(2000);
    assert.equal(k.agent.wakes.length, 1, 'said on the phone, whatever the mirror could read');
    assert.ok(warned.some((a) => String(a[0]).startsWith('push: a sync failed')), 'the failed sync is noted');
    b.heal();
    await k.mirror.sync(); // not stuck: the next one runs
    await k.mirror.settled();
    assert.equal(JSON.parse(String(await fileText(k))).on, true);
    assert.equal(JSON.parse(String(before)).on, true);
  } finally {
    console.warn = warn;
    await k.stop();
  }
});
