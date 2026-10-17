import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerJSON } from '../../src/core/answer.js';

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
