import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_USAGE, mergeUsage, addUsage, costOf, addCost } from '../../src/core/llm/cost.js';
import { LEVELS, ROLE_LEVELS, nearestLevel, levelPatch } from '../../src/core/llm/reasoning.js';

/** @param {number | undefined} a @param {number} b */
const close = (a, b) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('cost is usage × prices per million tokens, by kind of token (spec §9.9)', () => {
  const prices = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 };
  const usage = { ...NO_USAGE, input: 1000, cacheRead: 10_000, cacheWrite: 2000, cacheWrite1h: 1000, output: 500, reasoning: 200 };
  close(costOf(usage, prices), (1000 * 2 + 10_000 * 0.1 + 2000 * 2.5 + 1000 * 4 + 500 * 10) / 1e6);
});

test('a long prompt is priced by its tier', () => {
  const prices = { input: 0.1, output: 0.5, cacheRead: 0.01, tiers: [{ above: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05 }] };
  close(costOf({ ...NO_USAGE, input: 50_000, output: 1000 }, prices), (50_000 * 0.1 + 1000 * 0.5) / 1e6);
  close(costOf({ ...NO_USAGE, input: 90_000, cacheRead: 60_000, output: 1000 }, prices), (90_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
});

test('missing cache prices fall back to the input price; a reported cost wins; no prices is unknown', () => {
  close(costOf({ ...NO_USAGE, cacheRead: 1000, cacheWrite: 1000, cacheWrite1h: 1000 }, { input: 1, output: 1 }), 3000 / 1e6);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.5 }, { input: 1, output: 1 }), 0.5);
  assert.equal(costOf({ ...NO_USAGE, input: 1000 }, null), undefined);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.25 }, null), 0.25);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, output: 10 }, { input: 0, output: 0 }), 0);
});

test('mergeUsage keeps the latest number of each kind; addUsage and addCost sum calls', () => {
  const a = mergeUsage(mergeUsage({ ...NO_USAGE }, { input: 50, cacheRead: 8000, output: 1 }), { output: 7 });
  assert.deepEqual(a, { ...NO_USAGE, input: 50, cacheRead: 8000, output: 7 });
  assert.equal(mergeUsage(a, { cost: 0.01 }).cost, 0.01);
  assert.deepEqual(addUsage(a, { ...NO_USAGE, input: 1, output: 1, reasoning: 2 }), { ...NO_USAGE, input: 51, cacheRead: 8000, output: 8, reasoning: 2 });
  assert.equal(addCost(undefined, undefined), undefined);
  assert.equal(addCost(undefined, 0.5), 0.5);
  close(addCost(0.25, 0.5), 0.75);
});

test("reasoning levels: the model's own, else the nearest, the cheaper on a tie (spec §9.3)", () => {
  assert.deepEqual(LEVELS, ['off', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(ROLE_LEVELS, { main: 'medium', utility: 'low', decide: 'off', 'koe-talk': 'off', 'koe-type': 'off' });
  const map = { low: { e: 'low' }, high: { e: 'high' } };
  assert.equal(nearestLevel(map, 'low'), 'low');
  assert.equal(nearestLevel(map, 'medium'), 'low', 'a tie goes to the cheaper level');
  assert.equal(nearestLevel(map, 'max'), 'high');
  assert.equal(nearestLevel(map, 'off'), 'low');
  assert.equal(nearestLevel({}, 'medium'), null);
  assert.equal(nearestLevel(undefined, 'medium'), null);
  assert.deepEqual(levelPatch(map, 'max'), { e: 'high' });
  assert.equal(levelPatch({}, 'high'), null);
});
