import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forGemini, fromGemini, toGeminiArgs, OBJECT_TEXT, TEXT_OR_OBJECT } from '../../plugins-official/gemini-api/schema.js';
import { toolSchema } from '../../plugins-official/gemini-api/steps.js';
import { activate as files } from '../../src/plugins/files/index.js';
import { activate as go } from '../../src/plugins/go/index.js';
import { readFile } from 'node:fs/promises';
import { loadGemini, spec, tripFiles } from './gemini-kit.js';

// Measured 2026-10-22 on the Interactions API (gemini-3.5-flash-lite, and gemini-3.5-flash for keys): an object with no
// properties is filled only as {} (type: object, type: [string, object], anyOf alike), and an open one
// (additionalProperties: true) takes only identifier-like keys ("notes+" came back "notes__append", "Content-Type" as
// "Content"). Free-form objects go as JSON text, and a string-or-object union as a string.

const WRITE = { type: 'object', properties: { path: { type: 'string' }, content: { type: ['string', 'object'] } }, required: ['path', 'content'] };
const PATCH = { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'object' } }, required: ['path', 'changes'] };

test('a free-form object goes as JSON text, its description saying so; a string-or-object union as text that may be an object as JSON text', () => {
  assert.deepEqual(forGemini(PATCH), { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'string', description: OBJECT_TEXT } }, required: ['path', 'changes'] });
  assert.deepEqual(forGemini(WRITE).properties.content, { type: 'string', description: TEXT_OR_OBJECT });
  // Its own description stays, first.
  assert.deepEqual(forGemini({ type: 'object', properties: { f: { type: 'object', description: 'Any fields.' } } }).properties.f, { type: 'string', description: `Any fields. ${OBJECT_TEXT}` });
  // An object that may be null stays nullable; one with an empty properties list is free-form too; additionalProperties of any kind is.
  assert.deepEqual(forGemini({ type: 'object', properties: { a: { type: ['object', 'null'] }, b: { type: 'object', properties: {} }, c: { type: 'object', additionalProperties: { type: ['string', 'number'] } } } }).properties,
    { a: { type: ['string', 'null'], description: OBJECT_TEXT }, b: { type: 'string', description: OBJECT_TEXT }, c: { type: 'string', description: OBJECT_TEXT } });
});

test("an object with properties stays an object, translated inside; the input as a whole always stays an object; nothing else changes, and the input isn't changed", () => {
  const input = {
    type: 'object', description: 'A booking.',
    properties: {
      title: { type: 'string', minLength: 1 }, kind: { enum: ['a', 'b'] },
      cost: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, extra: { type: 'object' } } },
      legs: { type: 'array', items: { type: 'object' } },
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'object' }] },
      either: { anyOf: [{ type: 'number' }, { type: 'object' }] },
      byName: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: { type: 'object' } },
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
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string', description: OBJECT_TEXT }] },
      either: { anyOf: [{ type: 'number' }, { type: 'string', description: OBJECT_TEXT }] },
      // Named properties and extra keys too (additionalProperties true or a schema): the extra keys could be any, so it goes whole as text.
      byName: { type: 'string', description: OBJECT_TEXT },
    },
  });
  // A tool with no parameters, or one whose MCP server's schema annai couldn't take ({ type: 'object' }), stays as it is.
  assert.deepEqual(forGemini({ type: 'object' }), { type: 'object' });
  assert.deepEqual(forGemini({ type: 'object', properties: {} }), { type: 'object', properties: {} });
});

test("an MCP server's schema: $defs are translated and a $ref is followed on the way back; names under properties are names, never keywords", () => {
  const mcp = {
    type: 'object',
    properties: { filter: { $ref: '#/$defs/Filter' }, items: { type: 'array', items: { $ref: '#/definitions/Item' } }, properties: { type: 'object' } },
    $defs: { Filter: { type: 'object', additionalProperties: true } },
    definitions: { Item: { type: 'object', properties: { meta: { type: 'object' } } } },
  };
  const out = forGemini(mcp);
  // A $ref to a free-form object is one itself: it goes as text where it is used.
  assert.deepEqual(out.properties.filter, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(out.$defs.Filter, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(out.definitions.Item.properties.meta, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(out.properties.properties, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(fromGemini(mcp, { filter: '{"a-b":1}', items: [{ meta: '{"x.y":true}' }], properties: '{"k":2}' }), { filter: { 'a-b': 1 }, items: [{ meta: { 'x.y': true } }], properties: { k: 2 } });
  // A $ref that goes in a circle is followed only so far.
  const loop = { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { $ref: '#/$defs/A' } } };
  assert.deepEqual(fromGemini(loop, { a: '{"x":1}' }), { a: '{"x":1}' });
});

test('on the way back: JSON text that is an object becomes the object; any other text goes to the tool as it came, for it to refuse in words', () => {
  assert.deepEqual(fromGemini(PATCH, { path: '/trip/b.json', changes: '{"confirmation":"PRI-9000","end":null,"notes+":["late"]}' }), { path: '/trip/b.json', changes: { confirmation: 'PRI-9000', end: null, 'notes+': ['late'] } });
  for (const text of ['not json', '[1,2]', '"text"', '3', 'null', '']) assert.deepEqual(fromGemini(PATCH, { path: '/p', changes: text }).changes, text);
  // A string-or-object union keeps the text it was given: a .md file's text that happens to be JSON stays text.
  assert.deepEqual(fromGemini(WRITE, { path: '/trip/n.md', content: '{"a":1}' }), { path: '/trip/n.md', content: '{"a":1}' });
  // Nested, in arrays and under additionalProperties; a value already an object (from a model that wrote one) stays it.
  const s = { type: 'object', properties: { legs: { type: 'array', items: { type: 'object' } }, byName: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: { type: 'object' } }, o: { type: 'object' } } };
  assert.deepEqual(fromGemini(s, { legs: ['{"a":1}', 'oops'], byName: '{"x":"{}","y":{"b":2}}', o: { already: true } }), { legs: [{ a: 1 }, 'oops'], byName: { x: '{}', y: { b: 2 } }, o: { already: true } });
  // anyOf: text is parsed only when no branch takes text.
  assert.deepEqual(fromGemini({ type: 'object', properties: { e: { anyOf: [{ type: 'number' }, { type: 'object' }] }, f: { anyOf: [{ type: 'string' }, { type: 'object' }] } } }, { e: '{"a":1}', f: '{"a":1}' }), { e: { a: 1 }, f: '{"a":1}' });
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
  const s = { type: 'object', properties: { legs: { type: 'array', items: { type: 'object' } }, keep: { type: 'object', properties: { n: { type: 'number' } } } } };
  assert.deepEqual(toGeminiArgs(s, { legs: [{ a: 1 }, 'text'], keep: { n: 1 } }), { legs: ['{"a":1}', 'text'], keep: { n: 1 } });
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

/** How long fn takes, in ms. @param {() => unknown} fn */
const timed = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

test("a schema that refers to itself (an MCP server's, hostile or careless) costs little, however it loops: every walk has a budget, and stops at a schema already being walked for the same value", () => {
  const schemas = [
    { type: 'object', properties: { a: { type: 'object' } }, allOf: [{ $ref: '#' }, { $ref: '#' }] },
    { type: 'object', properties: { a: { $ref: '#' } }, allOf: [{ $ref: '#' }, { $ref: '#' }, { $ref: '#' }], anyOf: [{ $ref: '#' }, { $ref: '#' }], oneOf: [{ $ref: '#' }] },
    { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { allOf: [{ $ref: '#/$defs/B' }, { $ref: '#/$defs/B' }] }, B: { allOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/A' }], anyOf: [{ $ref: '#/$defs/A' }] } } },
    { type: 'object', properties: { a: { type: 'array', items: { $ref: '#' }, prefixItems: [{ $ref: '#' }, { $ref: '#/properties/a' }] } }, allOf: [{ $ref: '#/properties/a' }, { $ref: '#' }] },
  ];
  /** A value as deep as the schema lets it be. @type {any} */
  let deep = { a: '{"x":1}' };
  for (let i = 0; i < 200; i++) deep = { a: [deep, deep] };
  for (const schema of schemas) {
    const ms = timed(() => {
      forGemini(schema);
      fromGemini(schema, deep);
      toGeminiArgs(schema, deep);
      fromGemini(schema, { a: '{"b":1}' });
      toGeminiArgs(schema, { a: { b: 1 } });
    });
    assert.ok(ms < 50, `${ms.toFixed(1)} ms for ${JSON.stringify(schema).slice(0, 80)}`);
  }
});

test('a schema too big to walk is sent as it is and its calls come back as they came: never half-translated', () => {
  // Deeper than any budget: nested free-form objects 30,000 levels down.
  /** @type {any} */
  let schema = { type: 'object' };
  for (let i = 0; i < 30_000; i++) schema = { type: 'object', properties: { n: schema } };
  assert.equal(forGemini(schema), schema);
  /** @type {any} */
  let args = { n: '{"a":1}' };
  for (let i = 0; i < 30_000; i++) args = { n: args };
  assert.equal(fromGemini(schema, args), args);
  // A deep one within it is translated all the way down, and back.
  /** @type {any} */
  let fine = { type: 'object', properties: { leaf: { type: 'object' } } };
  for (let i = 0; i < 100; i++) fine = { type: 'object', properties: { n: fine } };
  let at = forGemini(fine);
  for (let i = 0; i < 100; i++) at = at.properties.n;
  assert.deepEqual(at.properties.leaf, { type: 'string', description: OBJECT_TEXT });
  /** @type {any} */
  let value = { leaf: '{"a":1}' };
  for (let i = 0; i < 100; i++) value = { n: value };
  let back = /** @type {any} */ (fromGemini(fine, value));
  for (let i = 0; i < 100; i++) back = back.n;
  assert.deepEqual(back.leaf, { a: 1 });
});

test('__proto__, constructor and prototype in the arguments are keys, never the prototype: at the top, nested, and through $defs', () => {
  const WRITE_ = { type: 'object', properties: { path: { type: 'string' }, content: { type: ['string', 'object'] } }, required: ['path', 'content'] };
  // The reviewer's: a write whose only key is __proto__ must not read as a write of /me/memory.md.
  const hostile = JSON.parse('{"__proto__":{"path":"/me/memory.md","content":"x"}}');
  const back = /** @type {any} */ (fromGemini(WRITE_, hostile));
  assert.equal(back.path, undefined);
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.deepEqual(Object.keys(back), ['__proto__']);
  const s = { type: 'object', properties: { o: { type: 'object', properties: { k: { type: 'string' }, inner: { type: 'object' } } }, d: { $ref: '#/$defs/D' } },
    $defs: { D: { type: 'object', properties: { inner: { type: 'object' } } } } };
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const args = JSON.parse(`{"${key}":{"path":"/x"},"o":{"${key}":{"k":"v"},"inner":"{\\"${key}\\":{\\"polluted\\":true}}"},"d":{"${key}":1,"inner":"{}"}}`);
    for (const out of [/** @type {any} */ (fromGemini(s, args)), /** @type {any} */ (toGeminiArgs(s, fromGemini(s, args)))]) {
      for (const o of [out, out.o, out.d]) {
        assert.equal(Object.getPrototypeOf(o), Object.prototype, key);
        assert.ok(Object.hasOwn(o, key), key);
      }
      assert.equal(/** @type {any} */ ({}).polluted, undefined);
    }
    assert.equal(/** @type {any} */ (fromGemini(s, args)).o.inner[key].polluted, true);
  }
  // A $ref to "__proto__" names nothing, not Object.prototype.
  const ref = { type: 'object', properties: { a: { $ref: '#/$defs/__proto__' }, b: { $ref: '#/$defs/constructor' } }, $defs: {} };
  assert.deepEqual(forGemini(ref).properties, ref.properties);
  assert.deepEqual(fromGemini(ref, { a: '{"x":1}', b: '{"x":1}' }), { a: '{"x":1}', b: '{"x":1}' });
});

test("a combinator's branches are part of the object they are in: beside named properties, or at the top, they stay objects; a branch-only object decides for itself", () => {
  const top = { type: 'object', properties: { x: { type: 'string' } }, oneOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['x'] }] };
  assert.deepEqual(forGemini(top), top);
  const allTop = { type: 'object', allOf: [{ type: 'object', required: ['a'] }] };
  assert.deepEqual(forGemini(allTop), allTop);
  assert.deepEqual(toGeminiArgs(allTop, { a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(fromGemini(allTop, { a: '{"b":1}' }), { a: '{"b":1}' });
  const nested = { type: 'object', properties: { q: { type: 'object', properties: { a: { type: 'string' } }, anyOf: [{ required: ['a'] }, { type: 'object' }] } } };
  assert.deepEqual(forGemini(nested), nested);
  assert.deepEqual(toGeminiArgs(nested, { q: { a: 'x' } }), { q: { a: 'x' } });
  // A branch's own properties are walked into, at the top too.
  const parts = { type: 'object', allOf: [{ properties: { c: { type: 'object' } } }] };
  assert.deepEqual(forGemini(parts).allOf[0].properties.c, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(fromGemini(parts, { c: '{"d":1}' }), { c: { d: 1 } });
  assert.deepEqual(toGeminiArgs(parts, { c: { d: 1 } }), { c: '{"d":1}' });
  // What goes as text keeps only its title and description: nothing that says object, or contradicts the string.
  const free = { title: 'F', description: 'Any.', type: 'object', additionalProperties: true, allOf: [{ type: 'object' }], anyOf: [{ type: 'object' }], oneOf: [{ type: 'object' }],
    not: { type: 'string' }, if: { type: 'object' }, then: {}, else: {}, items: {}, $ref: '#/$defs/X', default: {}, enum: [{}], const: {}, minProperties: 1 };
  assert.deepEqual(forGemini({ type: 'object', properties: { f: free } }).properties.f, { title: 'F', type: 'string', description: `Any. ${OBJECT_TEXT}` });
});

test('a free-form object wrapped as allOf: [{ $ref }] (pydantic v1) goes as text and comes back as the object; one with properties stays an object', () => {
  const s = {
    type: 'object',
    properties: { extra: { allOf: [{ $ref: '#/definitions/Extra' }], description: 'More.' }, item: { allOf: [{ $ref: '#/definitions/Item' }] } },
    definitions: { Extra: { type: 'object', additionalProperties: { type: 'string' } }, Item: { type: 'object', properties: { meta: { type: 'object' } } } },
  };
  const out = forGemini(s);
  assert.deepEqual(out.properties.extra, { type: 'string', description: `More. ${OBJECT_TEXT}` });
  assert.deepEqual(out.properties.item, { allOf: [{ $ref: '#/definitions/Item' }] });
  assert.deepEqual(out.definitions.Item.properties.meta, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(fromGemini(s, { extra: '{"a-b":"c"}', item: { meta: '{"m":1}' } }), { extra: { 'a-b': 'c' }, item: { meta: { m: 1 } } });
  assert.deepEqual(toGeminiArgs(s, { extra: { 'a-b': 'c' }, item: { meta: { m: 1 } } }), { extra: '{"a-b":"c"}', item: { meta: '{"m":1}' } });
});

test("patternProperties are never run: they're left as they are, and the object they're in goes as text, so a pattern built to be slow costs nothing", () => {
  const slow = { type: 'object', properties: { o: { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^(a+)+$': { type: 'object' } } } } };
  assert.deepEqual(forGemini(slow).properties.o, { type: 'string', description: OBJECT_TEXT });
  const top = { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^(a+)+$': { type: 'object' } } };
  assert.deepEqual(forGemini(top), top);
  const key = `${'a'.repeat(40)}!`;
  const ms = timed(() => {
    fromGemini(slow, { o: JSON.stringify({ [key]: { x: 1 } }) });
    fromGemini(top, { [key]: '{"x":1}' });
    toGeminiArgs(top, { [key]: { x: 1 } });
  });
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  assert.deepEqual(fromGemini(top, { [key]: '{"x":1}' }), { [key]: '{"x":1}' });
});

test('a $ref into a list ("#/prefixItems/0", "#/anyOf/1") is followed', () => {
  const s = { type: 'object', properties: { a: { $ref: '#/properties/b/prefixItems/1' }, b: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'object' }] }, c: { $ref: '#/properties/d/anyOf/1' }, d: { anyOf: [{ type: 'number' }, { type: 'object', properties: { e: { type: 'object' } } }] } } };
  assert.deepEqual(forGemini(s).properties.a, { type: 'string', description: OBJECT_TEXT });
  assert.deepEqual(fromGemini(s, { a: '{"x":1}', c: { e: '{"y":2}' } }), { a: { x: 1 }, c: { e: { y: 2 } } });
  assert.deepEqual(fromGemini(s, { a: 'x' }), { a: 'x' });
  for (const bad of ['#/properties/b/prefixItems/2', '#/properties/b/prefixItems/-1', '#/properties/b/prefixItems/01', '#/properties/b/prefixItems/length']) {
    assert.deepEqual(fromGemini({ ...s, properties: { ...s.properties, a: { $ref: bad } } }, { a: '{"x":1}' }), { a: '{"x":1}' }, bad);
  }
});
