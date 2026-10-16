import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, errorFromResponse, explain, portable, safeId } from '../../src/core/llm/contract.js';

const json = (/** @type {any} */ o) => JSON.stringify(o);

test('error responses become error kinds the fallback acts on (spec §9.9)', () => {
  const kind = (/** @type {number} */ status, body = '', /** @type {Record<string, string>} */ headers = {}) => errorFromResponse(status, body, new Headers(headers)).kind;
  assert.equal(kind(401, json({ error: { message: 'Invalid API key' } })), 'auth');
  assert.equal(kind(403), 'auth');
  assert.equal(kind(402, json({ error: { message: 'Insufficient credits' } })), 'credit');
  assert.equal(kind(404), 'not-found');
  assert.equal(kind(413), 'context');
  assert.equal(kind(429), 'rate');
  // OpenAI says "out of quota" with a 429: that is no reason to wait.
  assert.equal(kind(429, json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' } })), 'credit');
  assert.equal(kind(503), 'overloaded');
  assert.equal(kind(529, json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })), 'overloaded');
  assert.equal(kind(500), 'server');
  assert.equal(kind(504), 'server');
  assert.equal(kind(400, json({ error: { message: 'prompt is too long: 1048577 tokens > 1000000 maximum' } })), 'context');
  assert.equal(kind(400, json({ error: { message: "This model's maximum context length is 128000 tokens." } })), 'context');
  assert.equal(kind(400, json({ error: { message: 'Image exceeds 5 MB maximum' } })), 'image');
  assert.equal(kind(400, json({ error: { message: 'Unknown parameter: foo' } })), 'bad-request');
});

test('an error keeps its status, its message and how long the provider asked to wait', () => {
  const e = errorFromResponse(429, json({ error: { message: 'Slow down' } }), new Headers({ 'retry-after': '3' }));
  assert.ok(e instanceof ProviderError);
  assert.equal(e.status, 429);
  assert.equal(e.message, 'Slow down');
  assert.equal(e.retryAfter, 3000);
  assert.equal(errorFromResponse(429, '', new Headers({ 'retry-after-ms': '250' })).retryAfter, 250);
  const at = new Date(Date.now() + 5000).toUTCString();
  const r = errorFromResponse(429, '', new Headers({ 'retry-after': at })).retryAfter ?? 0;
  assert.ok(r > 3000 && r <= 5000, `a retry-after date gave ${r} ms`);
  assert.equal(errorFromResponse(500, 'Internal Server Error').message, 'Internal Server Error');
  assert.equal(errorFromResponse(502, '').message, 'HTTP 502');
  assert.equal(errorFromResponse(400, json({ message: 'top-level message' })).message, 'top-level message');
});

test('every kind has plain words', () => {
  for (const k of ['auth', 'credit', 'rate', 'overloaded', 'context', 'image', 'upload', 'blocked', 'unreachable', 'bad-request', 'not-found', 'server', 'network', 'timeout', 'cancelled', 'plugin']) {
    assert.match(explain(new ProviderError(/** @type {any} */ (k), 'x')), /^[A-Za-z].*\.$/, k);
  }
  assert.match(explain(new ProviderError('blocked', 'x')), /doesn't allow web apps/);
});

test('portable: reasoning signed by another model is dropped, and tool-call ids every provider accepts (spec §9.6)', () => {
  /** @type {import('../../src/core/llm/contract.js').Message[]} */
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    { role: 'assistant', parts: [
      { type: 'reasoning', text: 'mine', signature: 's1', model: 'model-a' },
      { type: 'reasoning', text: 'theirs', signature: 's2', model: 'model-b' },
      { type: 'reasoning', text: 'unsigned', model: 'model-b' },
      { type: 'tool_call', id: 'call:1/x', name: 'look', input: {} },
    ] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'call:1/x', content: 'ok' }] },
    { role: 'assistant', parts: [{ type: 'reasoning', text: '', redacted: 'opaque', model: 'model-b' }] },
  ];
  const out = portable(messages, 'model-a');
  assert.deepEqual(out[1].parts.map((p) => (p.type === 'reasoning' ? p.text : p.type)), ['mine', 'unsigned', 'tool_call']);
  const call = /** @type {any} */ (out[1].parts[2]);
  const result = /** @type {any} */ (out[2].parts[0]);
  assert.equal(call.id, 'call_1_x');
  assert.equal(result.id, call.id);
  assert.equal(out.length, 3, 'a message left empty is dropped');
  assert.equal(safeId(''), 'call');
  assert.equal(safeId('x'.repeat(100)).length, 64);
});
