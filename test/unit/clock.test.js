import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useClock } from './clock.js';

test('timers fire in the order of their time, however they were set, and Date.now() reads the time of the one that fired', async (t) => {
  useClock(t);
  const start = Date.now();
  /** @type {[string, number][]} */
  const fired = [];
  const mark = (/** @type {string} */ name) => fired.push([name, Date.now() - start]);
  setTimeout(() => mark('late'), 500);
  setTimeout(() => mark('early'), 20);
  setTimeout(() => mark('middle'), 20 + 1);
  setTimeout(() => mark('same, set after early'), 20);
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(fired, [['early', 20], ['same, set after early', 20], ['middle', 21], ['late', 500]]);
  assert.equal(Date.now() - start, 600);
});

test('a long wait costs no real time, and what is waited for first is done first', async (t) => {
  const real = performance.now();
  useClock(t);
  const order = [];
  const p = Promise.resolve().then(() => order.push('promise'));
  await new Promise((r) => setTimeout(() => { order.push('20 seconds'); r(undefined); }, 20_000));
  await p;
  assert.deepEqual(order, ['promise', '20 seconds']);
  assert.ok(performance.now() - real < 2000, 'twenty seconds of the clock took less than two of the real one');
});

test('an interval repeats every period, and clearInterval ends it', async (t) => {
  useClock(t);
  const start = Date.now();
  /** @type {number[]} */
  const at = [];
  const every = setInterval(() => { at.push(Date.now() - start); if (at.length === 3) clearInterval(every); }, 100);
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(at, [100, 200, 300]);
});

test('clearTimeout stops a timer', async (t) => {
  useClock(t);
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 10);
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, false);
});

test('a timer does not overtake a request to the runtime that is in flight (a hash, here): the clock only moves when nothing else can happen', async (t) => {
  useClock(t);
  /** @type {string[]} */
  const order = [];
  // A real asynchronous request, answered in a later turn of the event loop.
  const hashed = crypto.subtle.digest('SHA-256', new Uint8Array(1 << 20)).then(() => order.push('digest'));
  setTimeout(() => order.push('timer'), 1);
  await hashed;
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['digest', 'timer']);
  assert.equal(createHash('sha256').update('').digest('hex').length, 64);
});

test('the real clock is back when the test is over', async (t) => {
  const realNow = Date.now;
  const realSetTimeout = setTimeout;
  await t.test('inside', (s) => {
    useClock(s);
    assert.notEqual(setTimeout, realSetTimeout);
  });
  assert.equal(setTimeout, realSetTimeout);
  assert.equal(Date.now, realNow);
  const before = performance.now();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(performance.now() - before >= 25, 'a real 30 ms');
});

test('a timer waits for a chain of setImmediate a few turns deep to finish (the header says how deep, and what is not waited for)', async (t) => {
  useClock(t);
  /** @type {string[]} */
  const order = [];
  setTimeout(() => order.push('timer'), 20_000);
  await new Promise((resolve) => {
    let n = 8;
    const hop = () => (--n ? setImmediate(hop) : resolve(undefined));
    setImmediate(hop);
  });
  order.push('chain of 8');
  await new Promise((r) => setTimeout(r, 25_000));
  assert.deepEqual(order, ['chain of 8', 'timer']);
});

test("refresh() starts a timer's time again from now, as Node's does", async (t) => {
  useClock(t);
  const start = Date.now();
  /** @type {number[]} */
  const fired = [];
  const timer = setTimeout(() => fired.push(Date.now() - start), 100);
  setTimeout(() => timer.refresh(), 60); // at 60 ms: the 100 ms begin again, so it fires at 160
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fired, [160]);
});

test('what the clock does not replace stays on real time (documented): new Date(), performance.now', async (t) => {
  useClock(t);
  const realBefore = performance.now();
  const dateBefore = new Date().getTime();
  const fake = Date.now();
  await new Promise((r) => setTimeout(r, 60_000));
  assert.equal(Date.now() - fake, 60_000, 'Date.now() moved a minute');
  assert.ok(performance.now() - realBefore < 5000, 'performance.now() did not');
  assert.ok(new Date().getTime() - dateBefore < 5000, 'nor did new Date()');
});

test('the idle turns are counted afresh for a timer set after the last one was cleared: it too waits sixteen turns, whatever the clock had counted for the one before', async (t) => {
  useClock(t);
  /** @param {number} depth */
  const chain = (depth) => new Promise((resolve) => {
    let n = depth;
    const hop = () => (--n ? setImmediate(hop) : resolve(undefined));
    setImmediate(hop);
  });
  /** @type {string[]} */
  const order = [];
  const first = setTimeout(() => order.push('first'), 10_000);
  await chain(12); // twelve idle turns counted for the first timer
  clearTimeout(first);
  await chain(2); // the clock sees the list empty
  setTimeout(() => order.push('timer'), 20_000);
  await chain(12);
  order.push('chain of 12');
  await new Promise((r) => setTimeout(r, 25_000));
  assert.deepEqual(order, ['chain of 12', 'timer']);
});

