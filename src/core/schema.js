import { matchPath } from './paths.js';

/**
 * A small JSON Schema validator for the subset annai's record schemas use:
 * type, enum, const, properties, required, additionalProperties, items,
 * minItems, maxItems, minLength, maxLength, pattern, minimum, maximum and
 * format (date, date-time). Unknown keywords are ignored.
 * @param {any} schema
 * @param {any} value
 * @returns {string[]} errors, empty when the value is valid
 */
export function validate(schema, value) {
  /** @type {string[]} */
  const errors = [];
  check(schema, value, '$', errors);
  return errors;
}

/**
 * @param {any} s @param {any} v @param {string} at @param {string[]} errors
 */
function check(s, v, at, errors) {
  if (!s || typeof s !== 'object') return;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((/** @type {string} */ t) => is(t, v))) {
      /* en */ errors.push(`${at}: expected ${types.join(' or ')}, got ${kind(v)}`);
      return;
    }
  }
  if (s.const !== undefined && !same(s.const, v)) /* en */ errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((/** @type {any} */ e) => same(e, v))) {
    /* en */ errors.push(`${at}: must be one of ${s.enum.map((/** @type {any} */ e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof v === 'string') {
    const length = [...v].length;
    if (s.minLength !== undefined && length < s.minLength) /* en */ errors.push(`${at}: must be at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && length > s.maxLength) /* en */ errors.push(`${at}: must be at most ${s.maxLength} characters`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) /* en */ errors.push(`${at}: does not match ${s.pattern}`);
    if (s.format === 'date' && !isDate(v)) /* en */ errors.push(`${at}: must be a date like 2026-11-26`);
    if (s.format === 'date-time' && !isDateTime(v)) /* en */ errors.push(`${at}: must be a date-time like 2026-11-26T14:05:00-08:00`);
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) /* en */ errors.push(`${at}: must be at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) /* en */ errors.push(`${at}: must be at most ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) /* en */ errors.push(`${at}: must have at least ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) /* en */ errors.push(`${at}: must have at most ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => check(s.items, item, `${at}[${i}]`, errors));
  }
  if (is('object', v)) {
    // Own properties only: inherited names like "constructor" must not count as present or declared.
    for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) /* en */ errors.push(`${at}.${r}: is required`);
    const props = s.properties ?? {};
    for (const [k, val] of Object.entries(v)) {
      if (Object.hasOwn(props, k)) check(props[k], val, `${at}.${k}`, errors);
      else if (s.additionalProperties === false) /* en */ errors.push(`${at}.${k}: is not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${at}.${k}`, errors);
    }
  }
}

/** @param {string} t @param {any} v */
function is(t, v) {
  switch (t) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
}

/** @param {any} v */
function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/** @param {any} a @param {any} b */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @param {string} s */
function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** @param {string} s */
function isDateTime(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && isDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));
}

/**
 * Builds the workspace's schema lookup from "schema" registrations of the form
 * { scope: 'trip'|'me'|'sys', pattern: '/plan/*.json', schema }. Later
 * registrations override earlier ones.
 * @param {{ list: (kind: string) => any[] }} registry
 * @param {(scope: string) => string} kindOf
 * @returns {(scope: string, path: string) => object | null}
 */
export function makeSchemaFor(registry, kindOf) {
  return (scope, path) => {
    const k = kindOf(scope);
    let found = null;
    for (const entry of registry.list('schema')) {
      if (entry.scope === k && matchPath(entry.pattern, path)) found = entry.schema;
    }
    return found;
  };
}
