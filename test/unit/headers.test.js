import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' blob: data: https:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

test('parses rules and applies wildcard and exact paths', () => {
  const rules = parseHeaders('/*\n  A: 1\n  B: two words\n# comment\n/sw.js\n  C: 3\n');
  assert.deepEqual([...headersFor(rules, '/x').entries()], [['A', '1'], ['B', 'two words']]);
  assert.deepEqual([...headersFor(rules, '/sw.js').entries()], [['A', '1'], ['B', 'two words'], ['C', '3']]);
});

test('the real _headers carries the spec CSP on every path', async () => {
  const rules = parseHeaders(await readFile(new URL('../../_headers', import.meta.url), 'utf8'));
  assert.equal(headersFor(rules, '/index.html').get('Content-Security-Policy'), CSP);
  assert.equal(headersFor(rules, '/sw.js').get('Cache-Control'), 'no-cache');
});
