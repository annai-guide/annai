import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:* wss: ws://localhost:* ws://127.0.0.1:*; img-src 'self' blob: data: https:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

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

test('the security policy allows wss: and ws: to localhost and 127.0.0.1, nothing more (K4: live sessions)', async () => {
  const rules = parseHeaders(await readFile(new URL('../../_headers', import.meta.url), 'utf8'));
  const csp = String(headersFor(rules, '/').get('Content-Security-Policy'));
  const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'))?.split(/\s+/).slice(1);
  assert.deepEqual(connect, ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*', 'wss:', 'ws://localhost:*', 'ws://127.0.0.1:*']);
  assert.ok(!/(^|\s)ws:(\s|;|$)/.test(csp), 'no plain ws: to any host');
});

test('as Cloudflare Pages does: a header two rules set is joined with ", ", and "! Name" detaches one an earlier rule set', () => {
  const rules = parseHeaders('/*\n  A: 1\n  B: 2\n/x\n  A: 3\n  ! B\n  B: 4\n/y\n  ! A\n');
  assert.deepEqual([...headersFor(rules, '/x').entries()], [['A', '1, 3'], ['B', '4']]);
  assert.deepEqual([...headersFor(rules, '/y').entries()], [['B', '2']]);
});

test("the frame Google's search suggestions are drawn in has exactly one policy, its own (G4): only its script, inline styles and inline images, framed only by annai; annai's own is unchanged", async () => {
  const rules = parseHeaders(await readFile(new URL('../../_headers', import.meta.url), 'utf8'));
  const frame = headersFor(rules, '/src/ui/grounding.html');
  assert.equal(frame.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'; frame-ancestors 'self'");
  assert.equal(frame.get('Referrer-Policy'), 'no-referrer');
  assert.equal(headersFor(rules, '/src/ui/grounding.js').get('Content-Security-Policy'), CSP);
  assert.equal(headersFor(rules, '/').get('Content-Security-Policy'), CSP);
  // Where _headers isn't served, the page carries the same policy itself (a meta policy can't say who may frame it).
  const page = await readFile(new URL('../../src/ui/grounding.html', import.meta.url), 'utf8');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)?.[1];
  assert.equal(meta, "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'");
  assert.ok(page.indexOf(meta) < page.indexOf('<style>') && page.indexOf(meta) < page.indexOf('<script'), 'before anything it governs');
});
