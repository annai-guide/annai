import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerJSON, answerBytes } from '../../src/core/answer.js';

test("a server's bad answer is a plain Error that names the server, never a SyntaxError", async () => {
  const plain = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.constructor === Error && re.test(e.message);
  await assert.rejects(answerJSON(new Response('<html>busy</html>'), 'overpass-api.de'), plain(/^overpass-api\.de sent an answer annai can't read\.$/));
  await assert.rejects(answerJSON(new Response('', { status: 504 }), 'overpass-api.de'), plain(/^overpass-api\.de answered 504\.$/));
  await assert.rejects(answerJSON(new Response('x'.repeat(20)), 'en.wikipedia.org', 10), plain(/^en\.wikipedia\.org sent more than annai reads/));
  assert.deepEqual(await answerJSON(new Response('{"a":1}'), 'x'), { a: 1 });
});

test('an answer cut off is said so; a stopped request stays stopped', async () => {
  const failing = (/** @type {Error} */ e) => new Response(new ReadableStream({ start(c) { c.error(e); } }));
  await assert.rejects(answerJSON(failing(new TypeError('network error')), 'en.wikipedia.org'), (/** @type {any} */ e) => e.constructor === Error && e.message === "en.wikipedia.org's answer was cut off.");
  await assert.rejects(answerJSON(failing(new DOMException('Stopped', 'AbortError')), 'x'), { name: 'AbortError' });
});

test('answerBytes: the bytes, or a plain error for a bad status, too much, or a cut-off answer', async () => {
  assert.deepEqual([...await answerBytes(new Response('abc'), 'trails.example')], [97, 98, 99]);
  await assert.rejects(answerBytes(new Response('x', { status: 404 }), 'trails.example'), /^Error: trails\.example answered 404\.$/);
  await assert.rejects(answerBytes(new Response('x'.repeat(20)), 'trails.example', 10), /sent more than annai reads/);
  const broken = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new TypeError('network')); } }));
  await assert.rejects(answerBytes(broken, 'trails.example'), (e) => !(e instanceof TypeError) && /answer was cut off/.test(/** @type {Error} */ (e).message));
});

test('answerJSON reads no further than its limit: an answer that never ends is stopped there, not read whole first', async () => {
  let pulled = 0;
  const endless = new Response(new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new TextEncoder().encode(`${' '.repeat(1023)}\n`));
    },
  }));
  await assert.rejects(answerJSON(endless, 'mcp.example', 10 * 1024), /^Error: mcp\.example sent more than annai reads/);
  assert.ok(pulled <= 12, `pulled ${pulled}`);
  // A length said up front that is past the limit isn't read at all.
  await assert.rejects(answerJSON(new Response('{}', { headers: { 'content-length': String(20 * 1024 * 1024) } }), 'mcp.example'), /sent more than annai reads/);
  assert.deepEqual(await answerJSON(new Response('{"ok":"é"}'), 'x'), { ok: 'é' });
});
