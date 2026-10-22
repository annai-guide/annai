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
      byName: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: { type: 'string', description: OBJECT_TEXT } },
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
  assert.deepEqual(out.properties.filter, { $ref: '#/$defs/Filter' });
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
  assert.deepEqual(fromGemini(s, { legs: ['{"a":1}', 'oops'], byName: { x: '{"not":"parsed"}', y: '{"b":2}' }, o: { already: true } }), { legs: [{ a: 1 }, 'oops'], byName: { x: '{"not":"parsed"}', y: { b: 2 } }, o: { already: true } });
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
