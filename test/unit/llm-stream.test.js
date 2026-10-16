import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError } from '../../src/core/llm/contract.js';

/** A body that delivers these chunks one at a time. @param {(string | Uint8Array)[]} chunks */
function body(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) {
        const x = chunks[i++];
        c.enqueue(typeof x === 'string' ? enc.encode(x) : x);
      } else c.close();
    },
  });
}
/** @template T @param {AsyncIterable<T>} it */
async function all(it) {
  /** @type {T[]} */
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}

test('sse: events, data lines, comments and every line ending', async () => {
  const got = await all(sse(body([': OPENROUTER PROCESSING\n\n', 'event: ping\ndata: {}\n\n', 'data: a\r\ndata: b\r\n\r\n', 'data:no-space\r', '\n\r\n', 'data: last'])));
  assert.deepEqual(got, [
    { event: 'ping', data: '{}' },
    { event: 'message', data: 'a\nb' },
    { event: 'message', data: 'no-space' },
    { event: 'message', data: 'last' },
  ]);
});

test('sse: a character split between two chunks arrives whole', async () => {
  const bytes = new TextEncoder().encode('data: 案内\n\n');
  const got = await all(sse(body([bytes.slice(0, 8), bytes.slice(8)])));
  assert.deepEqual(got, [{ event: 'message', data: '案内' }]);
});

test('sse: stopping early cancels the body', async () => {
  let cancelled = false;
  const b = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n')); },
    cancel() { cancelled = true; },
  });
  for await (const e of sse(b)) {
    assert.equal(e.data, '1');
    break;
  }
  assert.equal(cancelled, true);
});

test('sse: a connection that drops mid-stream is a network error, after what arrived', async () => {
  let n = 0;
  const b = new ReadableStream({
    pull(c) {
      if (n++ === 0) c.enqueue(new TextEncoder().encode('data: 1\n\n'));
      else c.error(new TypeError('network error'));
    },
  });
  /** @type {string[]} */
  const got = [];
  await assert.rejects((async () => { for await (const e of sse(b)) got.push(e.data); })(), (e) => e instanceof ProviderError && e.kind === 'network');
  assert.deepEqual(got, ['1']);
});

test('parsePartialJSON reads JSON that is still arriving', () => {
  assert.deepEqual(parsePartialJSON('{"text": "Hello wor'), { text: 'Hello wor' });
  assert.deepEqual(parsePartialJSON('{"a": [1, 2, {"b": "c'), { a: [1, 2, { b: 'c' }] });
  assert.deepEqual(parsePartialJSON('{"text": "Hi", "mo'), { text: 'Hi' });
  assert.deepEqual(parsePartialJSON('{"text": "Hi",'), { text: 'Hi' });
  assert.deepEqual(parsePartialJSON('{"ok": tr'), {});
  assert.deepEqual(parsePartialJSON('{"say": "a \\"quote'), { say: 'a "quote' });
  assert.deepEqual(parsePartialJSON('{"say": "line\\'), { say: 'line' });
  assert.deepEqual(parsePartialJSON('{"say": "caf\\u00e'), { say: 'caf' });
  assert.deepEqual(parsePartialJSON('{"say": "案内'), { say: '案内' });
  assert.deepEqual(parsePartialJSON('{"a": 1}'), { a: 1 });
  assert.equal(parsePartialJSON(''), undefined);
  assert.equal(parsePartialJSON('nonsense'), undefined);
});

test('retry waits longer each time and gives up when told to', async () => {
  /** @type {number[]} */
  const waits = [];
  const sleep = async (/** @type {number} */ ms) => { waits.push(ms); };
  let n = 0;
  assert.equal(await retry(async () => { if (++n < 3) throw new Error('flaky'); return 'ok'; }, { sleep }), 'ok');
  assert.deepEqual(waits, [500, 1500]);
  await assert.rejects(retry(async () => { throw new Error('always'); }, { tries: 2, sleep }), /always/);
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('fatal'); }, { retryIf: () => false, sleep }), /fatal/);
  assert.equal(calls, 1);
});
