import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formFields, readForm } from '../../src/ui/settings-form.js';

const SCHEMA = {
  type: 'object',
  properties: {
    station: { type: 'string', title: 'Tide station', description: 'The nearest one.', default: 'Monterey' },
    units: { type: 'string', enum: ['ft', 'm'] },
    days: { type: 'integer', minimum: 1, maximum: 7, title: 'Days ahead' },
    alerts: { type: 'boolean', title: 'Alert me' },
    key: { type: 'string', writeOnly: true, title: 'API key' },
    nested: { type: 'object', properties: {} },
  },
  required: ['station'],
};

test("a plugin's settings schema becomes fields: text, a choice, numbers, a switch, a secret; other kinds said plainly (spec §5.2)", () => {
  assert.deepEqual(formFields(SCHEMA).map((f) => [f.key, f.kind, f.label]), [
    ['station', 'text', 'Tide station'], ['units', 'select', 'units'], ['days', 'integer', 'Days ahead'],
    ['alerts', 'boolean', 'Alert me'], ['key', 'secret', 'API key'], ['nested', 'unsupported', 'nested'],
  ]);
  assert.deepEqual(formFields(SCHEMA)[1].options, ['ft', 'm']);
  assert.deepEqual([formFields(SCHEMA)[2].min, formFields(SCHEMA)[2].max], [1, 7]);
  assert.deepEqual(formFields({ type: 'object' }), []);
});

test('reading the form: values checked against the schema, secrets apart, empty fields cleared', () => {
  assert.deepEqual(readForm(SCHEMA, { station: 'Carmel', units: 'm', days: '3', alerts: true, key: 'tide-secret-123456' }),
    { values: { station: 'Carmel', units: 'm', days: 3, alerts: true }, secrets: { key: 'tide-secret-123456' }, errors: [] });
  assert.deepEqual(readForm(SCHEMA, { station: '', units: 'ft', days: '', alerts: false, key: '' }),
    { values: { station: null, units: 'ft', days: null, alerts: false }, secrets: {}, errors: [] });
  assert.match(readForm(SCHEMA, { station: 'x', units: 'ft', days: '9', alerts: false, key: '' }).errors.join(' '), /days/);
  assert.match(readForm(SCHEMA, { station: 'x', units: 'ft', days: 'two', alerts: false, key: '' }).errors.join(' '), /Days ahead is a whole number/);
});

test('8b-5: a writeOnly field is a secret only when it is a string; any other writeOnly field is one annai can\'t show, and never goes to a file', () => {
  const schema = { type: 'object', properties: {
    pin: { type: 'integer', writeOnly: true, title: 'PIN' },
    hush: { type: 'boolean', writeOnly: true },
    code: { type: 'string', enum: ['a', 'b'], writeOnly: true },
    note: { type: 'string' },
  } };
  assert.deepEqual(formFields(schema).map((f) => [f.key, f.kind]), [['pin', 'unsupported'], ['hush', 'unsupported'], ['code', 'secret'], ['note', 'text']]);
  assert.deepEqual(readForm(schema, { pin: '1234', hush: true, code: 'a', note: 'hi' }),
    { values: { note: 'hi' }, secrets: { code: 'a' }, errors: [] });
});
