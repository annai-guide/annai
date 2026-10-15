import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, makeSchemaFor } from '../../src/core/schema.js';

const S = {
  type: 'object',
  required: ['id', 'title'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', maxLength: 5 },
    kind: { enum: ['flight', 'lodging'] },
    n: { type: 'integer', minimum: 0, maximum: 3 },
    day: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 2 },
  },
};

test('valid value has no errors', () => {
  assert.deepEqual(validate(S, { id: 'x', title: 'Hi', kind: 'flight', n: 2, day: '2026-11-26', at: '2026-11-26T14:05:00-08:00', tags: ['a'] }), []);
});

test('reports type, required, enum, range and unknown keys with paths', () => {
  const errors = validate(S, { id: 1, kind: 'boat', n: 1.5, extra: true });
  assert.deepEqual(errors, [
    '$.title: is required',
    '$.id: expected string, got integer',
    '$.kind: must be one of "flight", "lodging"',
    '$.n: expected integer, got number',
    '$.extra: is not allowed',
  ]);
});

test('string length counts characters, not UTF-16 units', () => {
  assert.deepEqual(validate(S, { id: 'x', title: '🦊🦊🦊🦊🦊' }), []);
  assert.equal(validate(S, { id: 'x', title: '🦊🦊🦊🦊🦊🦊' }).length, 1);
});

test('dates must exist and date-times need an offset', () => {
  assert.equal(validate(S, { id: 'x', title: 'a', day: '2026-02-30' })[0], '$.day: must be a date like 2026-11-26');
  assert.equal(validate(S, { id: 'x', title: 'a', at: '2026-11-26T14:05:00' })[0], '$.at: must be a date-time like 2026-11-26T14:05:00-08:00');
  assert.deepEqual(validate(S, { id: 'x', title: 'a', at: '2026-11-26T22:05:00Z' }), []);
});

test('array items and limits', () => {
  assert.deepEqual(validate(S, { id: 'x', title: 'a', tags: ['ok', 'Bad', 'c'] }), [
    '$.tags: must have at most 2 items',
    '$.tags[1]: does not match ^[a-z]+$',
  ]);
});

test('makeSchemaFor picks the last matching registration for the scope kind', () => {
  const first = { type: 'object' };
  const second = { type: 'object', required: ['x'] };
  const registry = { list: () => [
    { scope: 'trip', pattern: '/plan/*.json', schema: first },
    { scope: 'trip', pattern: '/plan/*.json', schema: second },
    { scope: 'me', pattern: '/plan/*.json', schema: first },
  ] };
  const schemaFor = makeSchemaFor(registry, (scope) => (scope.startsWith('trip-') ? 'trip' : 'me'));
  assert.equal(schemaFor('trip-1', '/plan/a.json'), second);
  assert.equal(schemaFor('trip-1', '/notes/a.json'), null);
  assert.equal(schemaFor('me', '/plan/a.json'), first);
});
