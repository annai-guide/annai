import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forGemini, fromGemini, toGeminiArgs, OBJECT_TEXT, TEXT_OR_OBJECT } from '../../plugins-official/gemini-api/schema.js';
import { toolSchema } from '../../plugins-official/gemini-api/steps.js';
import { activate as files } from '../../src/plugins/files/index.js';
import { activate as go } from '../../src/plugins/go/index.js';
import { callOnce } from '../../src/core/llm/call.js';
import { runTool } from '../../src/core/agent/tools.js';
import { ME } from '../../src/core/scopes.js';
import { readFile } from 'node:fs/promises';
import { loadGemini, spec, endpointOf, modelOf, KEY, tripFiles } from './gemini-kit.js';

// Measured 2026-10-22 on the Interactions API (gemini-3.5-flash-lite, and gemini-3.5-flash for keys): an object with no
// properties is filled only as {} (type: object, type: [string, object], anyOf alike), and an open one
// (additionalProperties: true) takes only identifier-like keys ("notes+" came back "notes__append", "Content-Type" as
// "Content"). Free-form objects go as JSON text, and a string-or-object union as a string. Only properties, items and
// prefixItems are walked: $ref, $defs, combinators and patternProperties go as they are.

const WRITE = { type: 'object', properties: { path: { type: 'string' }, content: { type: ['string', 'object'] } }, required: ['path', 'content'] };
const PATCH = { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'object' } }, required: ['path', 'changes'] };

test('a free-form object below the top goes as JSON text, keeping only its title and description; a string-or-object union goes as text', () => {
  assert.deepEqual(forGemini(PATCH), { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'string', description: OBJECT_TEXT } }, required: ['path', 'changes'] });
  assert.deepEqual(forGemini(WRITE).properties.content, { type: 'string', description: TEXT_OR_OBJECT });
  // Its own title and description stay, first; nothing else of it does.
  const f = { title: 'F', description: 'Any fields.', type: 'object', default: {}, minProperties: 1, $ref: '#/$defs/X', anyOf: [{ type: 'object' }], patternProperties: { '^x': {} } };
  assert.deepEqual(forGemini({ type: 'object', properties: { f } }).properties.f, { title: 'F', type: 'string', description: `Any fields. ${OBJECT_TEXT}` });
  // Free-form: typed object with no properties, or with extra keys let in by additionalProperties (true or a schema), beside
  // named ones too. A nullable one stays nullable. Named properties and nothing else said, or extra keys refused, are walked.
  assert.deepEqual(forGemini({ type: 'object', properties: {
    a: { type: ['object', 'null'] },
    b: { type: 'object', additionalProperties: { type: 'string' } },
    c: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: true },
    d: { type: 'object', properties: { x: { type: 'object' } }, additionalProperties: false },
    e: { type: 'object', properties: {} },
    u: { title: 'U', type: ['string', 'object', 'null'], description: 'Text or a record.' },
    untyped: { additionalProperties: true },
  } }).properties, {
    a: { type: ['string', 'null'], description: OBJECT_TEXT },
    b: { type: 'string', description: OBJECT_TEXT },
    c: { type: 'string', description: OBJECT_TEXT },
    d: { type: 'object', properties: { x: { type: 'string', description: OBJECT_TEXT } }, additionalProperties: false },
    e: { type: 'object', properties: {} },
    u: { title: 'U', type: ['string', 'null'], description: `Text or a record. ${TEXT_OR_OBJECT}` },
    untyped: { additionalProperties: true },
  });
});

test('properties, items and prefixItems are walked from the top down; the top stays an object, free-form or not; the input is not changed', () => {
  const input = {
    type: 'object', description: 'A booking.',
    properties: {
      title: { type: 'string', minLength: 1 }, kind: { enum: ['a', 'b'] },
      cost: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, extra: { type: 'object' } } },
      legs: { type: 'array', items: { type: 'object' } },
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'object' }], items: { type: 'object', properties: { m: { type: 'object' } } } },
      older: { type: 'array', items: [{ type: 'object' }, { type: 'number' }] },
    },
  };
  const before = structuredClone(input);
  const out = forGemini(input);
  assert.deepEqual(input, before);
  assert.deepEqual(out, {
    type: 'object', description: 'A booking.',
    properties: {
      title: { type: 'string', minLength: 1 }, kind: { enum: ['a', 'b'] },
      cost: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, extra: { type: 'string', description: OBJECT_TEXT } } },
      legs: { type: 'array', items: { type: 'string', description: OBJECT_TEXT } },
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string', description: OBJECT_TEXT }], items: { type: 'object', properties: { m: { type: 'string', description: OBJECT_TEXT } } } },
      older: { type: 'array', items: [{ type: 'string', description: OBJECT_TEXT }, { type: 'number' }] },
    },
  });
  // A tool with no parameters, or one whose MCP server's schema annai couldn't take ({ type: 'object' }), stays as it is;
  // a free-form top keeps its named properties, walked.
  assert.deepEqual(forGemini({ type: 'object' }), { type: 'object' });
  assert.deepEqual(forGemini({ type: 'object', properties: {} }), { type: 'object', properties: {} });
  assert.deepEqual(forGemini({ type: 'object', properties: { o: { type: 'object' } }, additionalProperties: true }), { type: 'object', properties: { o: { type: 'string', description: OBJECT_TEXT } }, additionalProperties: true });
  // Names under properties are names, never keywords.
  assert.deepEqual(forGemini({ type: 'object', properties: { properties: { type: 'object' }, items: { type: 'string' } } }).properties, { properties: { type: 'string', description: OBJECT_TEXT }, items: { type: 'string' } });
});

test('$ref, $defs, combinators, not, if/then/else and patternProperties are never followed or entered: they go as they are, and so do the values there', () => {
  const mcp = {
    type: 'object',
    properties: {
      filter: { $ref: '#/$defs/Filter' },
      either: { anyOf: [{ type: 'number' }, { type: 'object' }] },
      wrapped: { allOf: [{ $ref: '#/definitions/Extra' }], description: 'More.' },
      cond: { if: { type: 'object' }, then: { type: 'object' }, else: { type: 'object' }, not: { type: 'object' } },
      pat: { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^(a+)+$': { type: 'object' } } },
    },
    allOf: [{ properties: { c: { type: 'object' } } }],
    oneOf: [{ $ref: '#' }, { $ref: '#' }],
    $defs: { Filter: { type: 'object', additionalProperties: true } },
    definitions: { Extra: { type: 'object' } },
  };
  const out = forGemini(mcp);
  assert.deepEqual(out, mcp);
  for (const k of /** @type {const} */ (['allOf', 'oneOf', '$defs', 'definitions'])) assert.equal(out[k], mcp[k], `${k} is the same, not a copy`);
  assert.equal(out.properties.either.anyOf, mcp.properties.either.anyOf);
  assert.equal(out.properties.pat.patternProperties, mcp.properties.pat.patternProperties);
  // Their values come back as Gemini gave them, and go back as they came.
  const args = { filter: { a: 1 }, either: '{"a":1}', wrapped: '{"x":1}', cond: '{"y":1}', c: '{"d":1}', pat: { a: 'x', aaaa: '{"z":1}' } };
  assert.deepEqual(fromGemini(mcp, args), args);
  assert.deepEqual(toGeminiArgs(mcp, { ...args, filter: { a: 1 }, c: { d: 1 } }), { ...args, filter: { a: 1 }, c: { d: 1 } });
});

test('on the way back: JSON text that is an object becomes the object; any other text goes to the tool as it came, for it to refuse in words', () => {
  assert.deepEqual(fromGemini(PATCH, { path: '/trip/b.json', changes: '{"confirmation":"PRI-9000","end":null,"notes+":["late"]}' }), { path: '/trip/b.json', changes: { confirmation: 'PRI-9000', end: null, 'notes+': ['late'] } });
  for (const text of ['not json', '[1,2]', '"text"', '3', 'null', 'true', '']) assert.deepEqual(fromGemini(PATCH, { path: '/p', changes: text }).changes, text);
  // A union keeps the text it was given: a .md note's text that happens to be JSON stays text.
  assert.deepEqual(fromGemini(WRITE, { path: '/trip/n.md', content: '{"a":1}' }), { path: '/trip/n.md', content: '{"a":1}' });
  // Nested, in lists by place and by the rest; a value already an object (from a model that wrote one) stays it.
  const s = { type: 'object', properties: {
    cost: { type: 'object', properties: { extra: { type: 'object' } } },
    legs: { type: 'array', items: { type: 'object' } },
    pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'object' }] },
    byName: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: { type: 'object' } },
    o: { type: 'object' },
  } };
  assert.deepEqual(
    fromGemini(s, { cost: { extra: '{"a":1}', more: '{"b":1}' }, legs: ['{"a":1}', 'oops', '[]'], pair: ['{"s":1}', '{"b":2}', '{"c":3}'], byName: '{"x":"{}","y":{"b":2}}', o: { already: true } }),
    { cost: { extra: { a: 1 }, more: '{"b":1}' }, legs: [{ a: 1 }, 'oops', '[]'], pair: ['{"s":1}', { b: 2 }, '{"c":3}'], byName: { x: '{}', y: { b: 2 } }, o: { already: true } },
  );
  // Arguments that weren't JSON at all (kept as text) are left alone; the input isn't changed.
  assert.equal(fromGemini(PATCH, '{"path": "/p", "chan'), '{"path": "/p", "chan');
  const args = { path: '/p', changes: '{"a":1}' };
  fromGemini(PATCH, args);
  assert.deepEqual(args, { path: '/p', changes: '{"a":1}' });
});

test("a call's arguments go back to Gemini as it fills them: its own, or another model's, free-form objects as JSON text; the round trip is exact", () => {
  const input = { path: '/trip/bookings/x.json', changes: { 'notes+': ['late'], end: null } };
  const sent = toGeminiArgs(PATCH, input);
  assert.deepEqual(sent, { path: '/trip/bookings/x.json', changes: '{"notes+":["late"],"end":null}' });
  assert.deepEqual(fromGemini(PATCH, sent), input);
  // A union takes text: another model's object goes as its JSON text, and text as it is.
  assert.deepEqual(toGeminiArgs(WRITE, { path: '/a.json', content: { id: 'x' } }), { path: '/a.json', content: '{"id":"x"}' });
  assert.deepEqual(toGeminiArgs(WRITE, { path: '/a.md', content: 'Hi' }), { path: '/a.md', content: 'Hi' });
  const s = { type: 'object', properties: { legs: { type: 'array', items: { type: 'object' } }, keep: { type: 'object', properties: { n: { type: 'number' }, meta: { type: 'object' } } } } };
  const value = { legs: [{ a: 1 }, 'text', [1]], keep: { n: 1, meta: { 'x.y': true } } };
  assert.deepEqual(toGeminiArgs(s, value), { legs: ['{"a":1}', 'text', [1]], keep: { n: 1, meta: '{"x.y":true}' } });
  assert.deepEqual(fromGemini(s, toGeminiArgs(s, value)), value);
});

test("annai's own tools as Gemini gets them: write, patch and search_link's params take JSON text, and nothing else of the files and go tools changes", () => {
  /** @type {any[]} */
  const tools = [];
  const annai = { tools: { register: (/** @type {any} */ t) => { tools.push(t); return () => {}; } }, files: {}, helpers: { tsv: {} } };
  files(/** @type {any} */ (annai));
  go(/** @type {any} */ (annai));
  /** @type {string[]} */
  const changed = [];
  for (const t of tools) {
    const sent = toolSchema(t).parameters;
    if (JSON.stringify(sent) !== JSON.stringify(t.input)) changed.push(t.name);
  }
  assert.deepEqual(changed.sort(), ['patch', 'search_link', 'write']);
  assert.deepEqual(toolSchema(tools.find((t) => t.name === 'search_link')).parameters.properties.params, { type: 'string', description: OBJECT_TEXT });
});

test("recorded (gemini-3.5-flash-lite, 2026-10-22): Gemini writes Shiori's booking as JSON text, which annai stores as the record, and a merge patch with \"notes+\" reaches patch as the object", async () => {
  const type = loadGemini();
  const { ws, trip, tools, run } = await tripFiles();
  const offered = ['read', 'write', 'patch'].map((n) => ({ name: n, description: tools[n].description, input: tools[n].input }));
  const callIn = async (/** @type {string} */ name) => {
    const res = new Response(await readFile(new URL(`../fixtures/gemini/${name}`, import.meta.url), 'utf8'), { headers: { 'content-type': 'text/event-stream' } });
    for await (const e of type.read(res, spec(type, { request: { messages: [], tools: offered } }))) if (e.type === 'tool_call') return e;
    return undefined;
  };
  const write = await callIn('tools-write.sse');
  assert.equal(write?.name, 'write');
  assert.equal(typeof write.input.content, 'string');
  await run('write', write.input);
  const booking = await ws.readJSON(trip, '/bookings/post-ranch-inn.json');
  assert.deepEqual([booking.kind, booking.status, booking.confirmation, booking.start, booking.end.tz], ['lodging', 'unverified', 'PRI-4471', { at: '2026-11-03T15:00:00-08:00', tz: 'America/Los_Angeles' }, 'America/Los_Angeles']);
  const patch = await callIn('tools-patch.sse');
  assert.deepEqual(patch?.input, { path: '/trip/bookings/post-ranch-inn.json', changes: { confirmation: 'PRI-9000', 'notes+': ['late arrival'] } });
  await run('patch', patch.input);
  const changed = await ws.readJSON(trip, '/bookings/post-ranch-inn.json');
  assert.deepEqual([changed.confirmation, changed.notes, changed.kind], ['PRI-9000', ['late arrival'], 'lodging']);
});

test('__proto__, constructor and prototype stay keys, never the prototype: at the top, nested, in lists, in JSON text, and through callOnce and runTool', async () => {
  // The reviewer's: a write whose only key is __proto__ must not read as a write of /me/memory.md.
  const hostile = JSON.parse('{"__proto__":{"path":"/me/memory.md","content":"x"}}');
  for (const back of [/** @type {any} */ (fromGemini(WRITE, hostile)), /** @type {any} */ (toGeminiArgs(WRITE, hostile))]) {
    assert.equal(back.path, undefined);
    assert.equal(Object.getPrototypeOf(back), Object.prototype);
    assert.deepEqual(Object.keys(back), ['__proto__']);
  }
  const s = { type: 'object', properties: {
    o: { type: 'object', properties: { k: { type: 'string' }, inner: { type: 'object' } } },
    list: { type: 'array', items: { type: 'object', properties: { inner: { type: 'object' } } } },
  } };
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const args = JSON.parse(`{"${key}":{"path":"/x"},"o":{"${key}":{"k":"v"},"inner":"{\\"${key}\\":{\\"polluted\\":true}}"},"list":[{"${key}":1,"inner":"{}"}]}`);
    const back = /** @type {any} */ (fromGemini(s, args));
    for (const out of [back, /** @type {any} */ (toGeminiArgs(s, back))]) {
      for (const o of [out, out.o, out.list[0]]) {
        assert.equal(Object.getPrototypeOf(o), Object.prototype, key);
        assert.ok(Object.hasOwn(o, key), key);
      }
    }
    assert.equal(Object.getPrototypeOf(back.o.inner), Object.prototype, key);
    assert.equal(back.o.inner[key].polluted, true, `${key} in the JSON text is a key too`);
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
  }
  // Through a whole call: Gemini's, read by callOnce and run by runTool. write finds no path and refuses, and /me/memory.md is as it was.
  const type = loadGemini();
  const { ws, trip, tools } = await tripFiles();
  const before = await ws.readText(ME, '/memory.md').catch(() => null);
  const stream = [
    { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'call_1', name: 'write', arguments: {} } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"__proto__":{"path":"/me/memory.md","content":"x"}}' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
  ].map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const reply = await callOnce({
    type, endpoint: endpointOf(type), model: modelOf(), key: KEY,
    request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Note it.' }] }], tools: [{ name: 'write', description: tools.write.description, input: tools.write.input }] },
    fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const call = /** @type {any} */ (reply.parts.find((p) => p.type === 'tool_call'));
  assert.equal(call.input.path, undefined);
  assert.deepEqual(Object.keys(call.input), ['__proto__']);
  const { output } = await runTool(tools.write, call.input, /** @type {any} */ ({ id: call.id, scope: trip, trip, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori' }));
  assert.equal(output.isError, true);
  assert.equal(await ws.readText(ME, '/memory.md').catch(() => null), before);
});

/** A properties map of n keys, each the same schema. @param {number} n @param {any} each */
const many = (n, each) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, each]));
/** Schemas and values nested n deep, built without recursion. @param {number} n @param {any} leaf @param {(x: any) => any} wrap */
const nest = (n, leaf, wrap) => {
  let x = leaf;
  for (let i = 0; i < n; i++) x = wrap(x);
  return x;
};
/** $defs D0…Dn, each Di an allOf of two $refs to D(i-1): 2^n paths to D0, which Dn names. @param {number} n @param {any} d0 */
const dag = (n, d0) => Object.fromEntries([['D0', d0], ...Array.from({ length: n }, (_, i) => [`D${i + 1}`, { allOf: [{ $ref: `#/$defs/D${i}` }, { $ref: `#/$defs/D${i}` }] }])]);

/**
 * Every hostile case of both reviews of 6171fae (the verifier's and the second opinion's probes), as [name, schema, a
 * call's arguments, what should hold of them on the way back]. The old walk took seconds on most of these.
 * @returns {[string, any, any, (back: any, args: any) => void][]}
 */
const hostileCases = () => [
  ['allOf [#, #]', { type: 'object', properties: { a: { type: 'object' } }, allOf: [{ $ref: '#' }, { $ref: '#' }] }, { a: '{"x":1}' }, (b) => assert.deepEqual(b, { a: { x: 1 } })],
  ['$ref, allOf, anyOf and oneOf all to #', { type: 'object', properties: { a: { $ref: '#' } }, allOf: [{ $ref: '#' }, { $ref: '#' }, { $ref: '#' }], anyOf: [{ $ref: '#' }, { $ref: '#' }], oneOf: [{ $ref: '#' }] }, { a: '{"x":1}' }, (b, a) => assert.equal(b.a, a.a)],
  ['mutual $defs', { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { allOf: [{ $ref: '#/$defs/B' }, { $ref: '#/$defs/B' }] }, B: { allOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/A' }], anyOf: [{ $ref: '#/$defs/A' }] } } }, { a: '{"x":1}' }, (b, a) => assert.deepEqual(b, a)],
  ['self-reference through allOf', { type: 'object', properties: { a: { type: 'array', items: { $ref: '#' }, prefixItems: [{ $ref: '#' }, { $ref: '#/properties/a' }] } }, allOf: [{ $ref: '#/properties/a' }, { $ref: '#' }] }, { a: ['{"x":1}', '{"y":1}', '{"z":1}'] }, (b, a) => assert.deepEqual(b, a)],
  ['a $ref of 100,000 segments', { type: 'object', properties: { a: { $ref: `#/$defs/${'x/'.repeat(100_000)}` } }, $defs: { x: { x: {} } } }, { a: '{"x":1}' }, (b, a) => assert.deepEqual(b, a)],
  ['5,000 properties, each a $ref to a 100,000-key node', { type: 'object', properties: many(5_000, { $ref: '#/$defs/Big' }), $defs: { Big: { type: 'object', properties: many(100_000, { type: 'string' }), additionalProperties: true } } }, { k0: '{"x":1}', k1: { y: 1 } }, (b, a) => assert.deepEqual(b, a)],
  ['1,500 anyOf $refs to a 20,000-key object, at the top and in a property', { type: 'object', anyOf: Array(1_500).fill({ $ref: '#/$defs/O' }), properties: { a: { anyOf: Array(1_500).fill({ $ref: '#/$defs/O' }) } }, $defs: { O: { type: 'object', properties: many(20_000, { type: 'object' }), additionalProperties: true } } }, { a: '{"k0":"{}"}' }, (b, a) => assert.deepEqual(b, a)],
  ['an anyOf of unresolvable $refs', { type: 'object', properties: { a: { anyOf: Array.from({ length: 2_000 }, (_, i) => ({ $ref: `#/$defs/missing${i}/${'y'.repeat(100)}` })) } } }, { a: '{"x":1}' }, (b, a) => assert.deepEqual(b, a)],
  ['a 100,000-key properties map (over the budget: as it is)', { type: 'object', properties: many(100_000, { type: 'object' }) }, { k0: '{"x":1}' }, (b, a) => assert.equal(b, a)],
  ['properties 100,000 deep (over the depth: as it is)', nest(100_000, { type: 'object' }, (s) => ({ type: 'object', properties: { n: s } })), nest(100_000, '{"x":1}', (v) => ({ n: v })), (b, a) => assert.equal(b, a)],
  ['a DAG of allOf $refs 14 deep to a 40,000-key leaf', { type: 'object', allOf: [{ $ref: '#/$defs/D14' }], $defs: dag(14, { type: 'object', additionalProperties: true, ...many(40_000, 0) }) }, { k: '{"x":1}' }, (b, a) => assert.deepEqual(b, a)],
  ['a 5,000-key value at a DAG of 4,096 leaves', { type: 'object', properties: { a: { $ref: '#/$defs/D12' } }, $defs: dag(12, { type: 'object', properties: { k: { type: 'string' } } }) }, { a: many(5_000, 'v') }, (b, a) => assert.equal(Object.keys(b.a).length, Object.keys(a.a).length)],
  ['2,000 anyOf options reached 4,096 times', { type: 'object', properties: { a: { $ref: '#/$defs/D12' } }, $defs: { ...dag(12, { anyOf: Array(2_000).fill({ $ref: '#/$defs/Leaf' }) }), Leaf: { type: 'object', properties: { k: { type: 'object' } } } } }, { a: { k: '{"v":1}' } }, (b, a) => assert.deepEqual(b, a)],
  ['an unresolvable 300,000-character $ref at 4,096 leaves', { type: 'object', properties: { a: { $ref: '#/$defs/D12' } }, $defs: dag(12, { allOf: [{ $ref: `#/$defs/${'x'.repeat(300_000)}` }] }) }, { a: { k: 'v' } }, (b, a) => assert.deepEqual(b, a)],
  ['items 400 deep with a free-form object at the bottom (over the depth: as it is)', { type: 'object', properties: { d: nest(400, { type: 'object', additionalProperties: true }, (s) => ({ type: 'array', items: s })) } }, { d: nest(400, '{"k":1}', (v) => [v]) }, (b, a) => assert.equal(b, a)],
  ['items 90 deep with a free-form object at the bottom (within it)', { type: 'object', properties: { d: nest(90, { type: 'object', additionalProperties: true }, (s) => ({ type: 'array', items: s })) } }, { d: nest(90, '{"k":1}', (v) => [v]) }, (b) => assert.deepEqual(nest(90, b.d, (v) => v[0]), { k: 1 })],
  ['JSON text 20,000 deep in a free-form object', { type: 'object', properties: { f: { type: 'object' } } }, { f: `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}` }, (b) => assert.equal(typeof b.f, 'object')],
  ['an object 20,000 deep going back as JSON text', { type: 'object', properties: { f: { type: 'object' } } }, { f: nest(20_000, {}, (v) => ({ x: v })) }, (b) => assert.equal(typeof b.f, 'object')],
  ['7,000 records, each with a free-form meta (translated: linear in the arguments, and the schema is small)', { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, meta: { type: 'object' } } } } } },
    { items: Array.from({ length: 7_000 }, (_, i) => ({ id: `r${i}`, meta: `{"n":${i}}` })) }, (b) => assert.deepEqual(b.items[6_999], { id: 'r6999', meta: { n: 6_999 } })],
];

/** A note as it is in JSON text. @param {string} s */
const inJSON = (s) => JSON.stringify(s).slice(1, -1);

test("every hostile schema of both reviews costs under 50 ms a call, there and back, and none grows the request: nothing is followed, and a schema too big or deep goes as it is", (t) => {
  for (const [name, schema, args, holds] of hostileCases()) {
    /** @type {number[]} */
    const ms = [];
    /** @template T @param {() => T} fn @returns {T} */
    const timed = (fn) => {
      const started = performance.now();
      const out = fn();
      ms.push(performance.now() - started);
      return out;
    };
    const sent = timed(() => forGemini(schema));
    const back = timed(() => fromGemini(schema, args));
    timed(() => toGeminiArgs(schema, back));
    t.diagnostic(`${ms.map((x) => x.toFixed(1)).join(' + ')} ms: ${name}`);
    assert.ok(Math.max(...ms) < 50, `${ms.map((x) => x.toFixed(1)).join(', ')} ms for ${name}`);
    holds(back, args);
    // Never more than the input and each free-form object's note (with its "description" and "type"); a schema sent as
    // it is is the same object.
    if (sent === schema) continue;
    const json = JSON.stringify(sent);
    const notes = [OBJECT_TEXT, TEXT_OR_OBJECT].reduce((n, note) => n + json.split(inJSON(note)).length - 1, 0);
    assert.ok(json.length <= JSON.stringify(schema).length + notes * (inJSON(TEXT_OR_OBJECT).length + 20), `${name} grew`);
  }
});

test('a schema over the budget or the depth is sent as it is, and its calls come back and go back as they came: all or nothing, the same for the same schema', (t) => {
  // 60,000 property keys on the walked paths: over 50,000.
  const wide = { type: 'object', properties: { a: { type: 'object' }, b: { type: 'object', properties: many(60_000, { type: 'string' }) } } };
  assert.equal(forGemini(wide), wide);
  const args = { a: '{"x":1}', b: { k0: 'v' } };
  assert.equal(fromGemini(wide, args), args);
  const input = { a: { x: 1 } };
  assert.equal(toGeminiArgs(wide, input), input);
  // The same 60,000 keys in $defs, or in a free-form object (text, so not walked), cost nothing of it.
  const kept = { type: 'object', properties: { a: { type: 'object' }, b: { type: 'object', properties: many(60_000, { type: 'string' }), additionalProperties: true } }, $defs: { D: { properties: many(60_000, {}) } } };
  assert.deepEqual(forGemini(kept).properties, { a: { type: 'string', description: OBJECT_TEXT }, b: { type: 'string', description: OBJECT_TEXT } });
  // Just within it, 24,000 free-form properties are each made text once: the most a call can cost, linear in the schema.
  const near = { type: 'object', properties: many(24_000, { type: 'object' }) };
  const started = performance.now();
  const sent = forGemini(near);
  const ms = performance.now() - started;
  t.diagnostic(`${ms.toFixed(1)} ms: forGemini of 24,000 free-form properties`);
  assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
  assert.deepEqual(sent.properties.k23999, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(fromGemini(near, { k0: '{"x":1}', k23999: '[]' }), { k0: { x: 1 }, k23999: '[]' });
  // More than 100 levels deep: as it is; within it, translated all the way down and back.
  const deep = (/** @type {number} */ n) => nest(n, { type: 'object', properties: { leaf: { type: 'object' } } }, (s) => ({ type: 'object', properties: { n: s } }));
  const value = (/** @type {number} */ n) => nest(n, { leaf: '{"a":1}' }, (v) => ({ n: v }));
  const tooDeep = deep(120);
  assert.equal(forGemini(tooDeep), tooDeep);
  const tooDeepArgs = value(120);
  assert.equal(fromGemini(tooDeep, tooDeepArgs), tooDeepArgs);
  const fine = deep(90);
  assert.deepEqual(nest(90, forGemini(fine), (s) => s.properties.n).properties.leaf, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(nest(90, fromGemini(fine, value(90)), (v) => v.n).leaf, { a: 1 });
});

test('a real MCP schema of 400 $defs is far under the budget: its $defs are never walked, and its own properties are translated', () => {
  const defs = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`Model${i}`, { type: 'object', title: `Model${i}`, properties: { id: { type: 'string' }, meta: { type: 'object' }, next: { $ref: `#/$defs/Model${(i + 1) % 400}` } }, required: ['id'] }]));
  const schema = { type: 'object', properties: { query: { type: 'string' }, filters: { type: 'object', additionalProperties: true }, model: { $ref: '#/$defs/Model0' }, rows: { type: 'array', items: { type: 'object', properties: { meta: { type: 'object' } } } } }, $defs: defs };
  const out = forGemini(schema);
  assert.deepEqual(out.properties.filters, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(out.properties.rows.items.properties.meta, { type: 'string', description: OBJECT_TEXT });
  assert.equal(out.$defs, defs);
  assert.deepEqual(fromGemini(schema, { filters: '{"a-b":1}', model: { meta: '{"m":1}' }, rows: [{ meta: '{"r":1}' }] }), { filters: { 'a-b': 1 }, model: { meta: '{"m":1}' }, rows: [{ meta: { r: 1 } }] });
});
