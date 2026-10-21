import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { armUnlock, UNLOCK_EVENTS } from '../../src/ui/unlock.js';
import { agentKit } from './agent-kit.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

test("the first tap's unlock listens to what a phone counts as a tap: pointerup, touchend, click and keydown, not pointerdown (spec §10.1)", () => {
  assert.deepEqual([...UNLOCK_EVENTS].sort(), ['click', 'keydown', 'pointerup', 'touchend']);
});

test('an unlock that fails keeps listening, a later tap tries again, and one that works stops listening; it runs inside the tap', async () => {
  const target = new EventTarget();
  const works = [false, true];
  let calls = 0;
  armUnlock(target, async () => {
    calls++;
    return works.shift() ?? true;
  });
  target.dispatchEvent(new Event('pointerup'));
  assert.equal(calls, 1, 'called in the event itself, not after a wait');
  await tick();
  target.dispatchEvent(new Event('click'));
  assert.equal(calls, 2);
  await tick();
  for (const type of UNLOCK_EVENTS) target.dispatchEvent(new Event(type));
  target.dispatchEvent(new Event('pointerdown'));
  assert.equal(calls, 2, 'nothing listens once it worked');
});

test('an unlock that throws keeps listening', async () => {
  const target = new EventTarget();
  let calls = 0;
  armUnlock(target, () => {
    calls++;
    if (calls === 1) throw new Error('no sound here yet');
    return true;
  });
  target.dispatchEvent(new Event('touchend'));
  await tick();
  target.dispatchEvent(new Event('keydown'));
  await tick();
  target.dispatchEvent(new Event('click'));
  assert.equal(calls, 2);
});

test('the Voice unlocks once: a tap on Shiori and a choice on the chip unlock; once it worked the silent clip never plays again', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  const works = [false, true];
  k.platform.player.unlock = async () => {
    k.platform.log.push('unlock');
    return works.shift() ?? true;
  };
  k.agent.tap();
  assert.deepEqual(k.platform.log.filter((/** @type {string} */ l) => l === 'unlock'), ['unlock'], 'a tap on Shiori unlocks, inside the tap');
  await tick();
  const chose = k.voice.choose('on');
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'unlock').length, 2, 'a choice on the chip unlocks, inside the tap');
  await chose;
  assert.equal(await k.voice.unlock(), true);
  k.agent.tap();
  await tick();
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'unlock').length, 2);
});

// The Erase hang (2026-10-18): WebKit on Linux (Playwright's WebKit) can deadlock a page's process, and the
// service worker that shares it, when the page goes away while an audio clip starts. A tap's sound unlock
// starts one, so a tap that leaves the page waits for it first.

test('settled() waits while an unlock starts its silent clip, at once when none is starting, and for a limited time at most', async () => {
  const state = (/** @type {Promise<unknown>} */ p) => Promise.race([p.then(() => 'settled'), tick().then(() => 'waiting')]);
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  /** @type {(ok: boolean) => void} */
  let started = () => {};
  k.platform.player.unlock = () => new Promise((resolve) => { started = resolve; });
  assert.equal(await state(k.voice.settled()), 'settled', 'nothing is starting');
  k.voice.unlock();
  const waiting = k.voice.settled();
  assert.equal(await state(waiting), 'waiting');
  started(true);
  assert.equal(await state(waiting), 'settled');
  assert.equal(await state(k.voice.settled()), 'settled', 'unlocked: nothing starts again');

  const stuck = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  stuck.platform.player.unlock = () => new Promise(() => {}); // a clip that never starts
  stuck.voice.unlock();
  const t0 = Date.now();
  await stuck.voice.settled(30);
  assert.ok(Date.now() - t0 < 1000, 'it holds nothing up for long');
});

test("a voice platform whose unlock gives a plain boolean, not a promise, is taken at its word: nothing throws out of a tap on Shiori", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  k.platform.player.unlock = /** @type {any} */ (() => false);
  assert.equal(await k.voice.unlock(), false);
  k.platform.player.unlock = /** @type {any} */ (() => true);
  assert.doesNotThrow(() => k.agent.tap());
  await k.voice.settled(30);
  assert.equal(await k.voice.unlock(), true);
  k.platform.player.unlock = () => { throw new Error('not called again'); };
  assert.equal(await k.voice.unlock(), true, 'once it worked, it does nothing');
});

test("one unlock at a time: while one is still starting, a tap's other events, or a tap on Shiori, start no other, so the silent clip is never loaded again over itself (that wedges WebKit on Linux: the welcome's keyboard test); once it fails, the next tap tries; one that never starts is never loaded over", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  /** @type {((ok: boolean) => void)[]} */
  const pending = [];
  k.platform.player.unlock = () => new Promise((resolve) => pending.push(resolve));
  const target = new EventTarget();
  armUnlock(target, () => k.voice.unlock());
  for (const type of ['pointerup', 'touchend', 'click', 'keydown']) target.dispatchEvent(new Event(type));
  k.agent.tap();
  assert.equal(pending.length, 1, 'a tap is pointerup, touchend and click; Enter on a button is keydown and click');
  pending[0](false);
  await tick();
  target.dispatchEvent(new Event('click'));
  assert.equal(pending.length, 2, 'a failed unlock leaves the next tap to try');
  pending[1](true);
  await tick();
  target.dispatchEvent(new Event('click'));
  assert.equal(pending.length, 2);

  // Review m5: one that never starts is never loaded over, however long it takes: every later tap waits on it.
  const stuck = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  let tries = 0;
  stuck.platform.player.unlock = () => { tries++; return new Promise(() => {}); }; // a clip that never starts
  mock.timers.enable({ apis: ['setTimeout'] }); // a clock of the test's own: no real wait
  try {
    for (let i = 0; i < 5; i++) stuck.voice.unlock();
    mock.timers.tick(60_000);
    stuck.voice.unlock();
  } finally {
    mock.timers.reset();
  }
  assert.equal(tries, 1);
});
