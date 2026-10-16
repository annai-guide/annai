import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePatch, diffPatch } from '../../src/core/patch.js';

// RFC 7396, Appendix A.
const RFC = [
  [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
  [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
  [{ a: 'b' }, { a: null }, {}],
  [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
  [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
  [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
  [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
  [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
  [['a', 'b'], ['c', 'd'], ['c', 'd']],
  [{ a: 'b' }, ['c'], ['c']],
  [{ a: 'foo' }, null, null],
  [{ a: 'foo' }, 'bar', 'bar'],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }],
  [[1, 2], { a: 'b', c: null }, { a: 'b' }],
  [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];

for (const [i, [target, patch, expected]] of RFC.entries()) {
  test(`RFC 7396 example ${i + 1}`, () => {
    assert.deepEqual(mergePatch(target, patch), expected);
  });
}

test('does not mutate the target or the patch', () => {
  const target = { a: { b: 1 }, list: [1] };
  const patch = { a: { c: 2 }, list: [2] };
  const out = mergePatch(target, patch);
  assert.deepEqual(target, { a: { b: 1 }, list: [1] });
  assert.deepEqual(patch, { a: { c: 2 }, list: [2] });
  out.list.push(3);
  assert.deepEqual(patch.list, [2]);
});

test('append: "k+" appends to an existing array', () => {
  assert.deepEqual(mergePatch({ tools: [1] }, { 'tools+': [2, 3] }, { append: true }), { tools: [1, 2, 3] });
});

test('append: "k+" creates the array when missing and works when nested', () => {
  assert.deepEqual(mergePatch({}, { 'tools+': [{ type: 'web_search' }] }, { append: true }), { tools: [{ type: 'web_search' }] });
  assert.deepEqual(mergePatch({ a: { x: [1] } }, { a: { 'x+': [2] } }, { append: true }), { a: { x: [1, 2] } });
});

test('without the append option, "k+" is an ordinary key', () => {
  assert.deepEqual(mergePatch({ tools: [1] }, { 'tools+': [2] }), { tools: [1], 'tools+': [2] });
});

test('a "__proto__" key is plain data: it neither changes the prototype nor pollutes Object', () => {
  const patch = JSON.parse('{"__proto__": {"polluted": 1}, "ok": true}');
  const out = mergePatch({}, patch);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.hasOwn(out, '__proto__'), true);
  assert.equal(JSON.stringify(out), '{"__proto__":{"polluted":1},"ok":true}');
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  const nested = mergePatch({ a: {} }, JSON.parse('{"a": {"__proto__": {"x": 1}}}'));
  assert.equal(Object.getPrototypeOf(nested.a), Object.prototype);
});

test('diffPatch: the merge patch that turns one value into another, deletions included', () => {
  const base = { name: 'A', headers: { a: '1', b: '2' }, levels: { low: { x: 1 }, max: { x: 9 } }, list: [1, 2], same: { k: 1 } };
  const edited = { name: 'A', headers: { a: '1' }, levels: { low: { x: 2 } }, list: [1], same: { k: 1 }, extra: true };
  const patch = diffPatch(base, edited);
  assert.deepEqual(patch, { headers: { b: null }, levels: { low: { x: 2 }, max: null }, list: [1], extra: true });
  assert.deepEqual(mergePatch(base, patch), edited);
  assert.deepEqual(diffPatch(base, structuredClone(base)), {});
});
