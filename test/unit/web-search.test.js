import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderSearch, normalizeRows, Cooldowns, restsOn, FREE_SERVICES, searchOffIn } from '../../src/core/web-search.js';

const p = (/** @type {string} */ id, /** @type {any} */ over = {}) => ({ id, name: id, search: async () => [], ...over });

test('the order: the user\'s list first, then keyed, free web and knowledge; switched-off ones are in the list but marked', () => {
  const list = [p('wiki', { kind: 'knowledge', always: true }), p('exa', { free: true }), p('jina'), p('tavily'), p('parallel', { free: true })];
  assert.deepEqual(orderSearch(list, {}).map((x) => x.id), ['jina', 'tavily', 'exa', 'parallel', 'wiki']);
  assert.deepEqual(orderSearch(list, { search: ['parallel', 'ghost', 'jina'] }).map((x) => x.id), ['parallel', 'jina', 'tavily', 'exa', 'wiki']);
  assert.deepEqual(orderSearch(list, { search: ['jina', 'jina'] }).map((x) => x.id), ['jina', 'tavily', 'exa', 'parallel', 'wiki']);
  assert.deepEqual(searchOffIn({ searchOff: ['exa', 'wiki', 7] }, list), ['exa']);
  assert.deepEqual(FREE_SERVICES.map((s) => s.id), ['exa', 'parallel', 'firecrawl']);
});

test('rows: tags and entities stripped, whitespace folded, tracking parameters dropped, duplicates (by host and path) once, at most 8 rows', () => {
  const rows = [
    { title: 'Nepenthe <b>Big Sur</b> &amp; more', url: 'https://www.nepenthe.com/hours/?utm_source=x&srsltid=abc&msockid=1&keep=1', snippet: 'Open\tdaily\n11:30 <span class="searchmatch">am</span>' },
    { title: 'Again', url: 'https://nepenthe.com/hours', snippet: 'a duplicate of the first by host and path' },
    { title: 'Not a link', url: 'javascript:alert(1)', snippet: 'x' },
    { title: 'Relative', url: '/hours', snippet: 'x' },
    ...Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, url: `https://site${i}.test/p`, snippet: `s${i}` })),
  ];
  const out = normalizeRows(rows, 'nepenthe hours');
  assert.equal(out.length, 8);
  assert.deepEqual(out[0], { title: 'Nepenthe Big Sur & more', url: 'https://www.nepenthe.com/hours/?keep=1', snippet: 'Open daily 11:30 am' });
  assert.ok(!out.some((r) => /javascript|Relative|Again/.test(r.title + r.url)));
  assert.equal(normalizeRows(rows, 'q', 3).length, 3);
  assert.deepEqual(normalizeRows(/** @type {any} */ ('nope'), 'q'), []);
});

test('rows: a long excerpt keeps the sentences that answer the query, not its first 400 characters', () => {
  const lead = 'A long lead about the history of the coast and its many bridges. '.repeat(12);
  const answer = 'Nepenthe is open daily 11:30am-10:00pm, with lunch until 4:30pm.';
  const [row] = normalizeRows([{ title: 'T', url: 'https://a.test/', snippet: `${lead}${answer} ${lead}` }], 'is nepenthe open today');
  assert.ok(row.snippet.length <= 400);
  assert.ok(row.snippet.includes(answer), row.snippet);
  // No sentence break to use: cut at the limit, with an ellipsis.
  const [flat] = normalizeRows([{ title: 'T', url: 'https://b.test/', snippet: 'word '.repeat(200) }], 'q');
  assert.ok(flat.snippet.length <= 400 && flat.snippet.endsWith('…'));
  assert.equal(normalizeRows([{ title: 'x'.repeat(300), url: 'https://c.test/', snippet: '' }], 'q')[0].title.length, 160);
});

test('a resting provider: a minute after the first failure, doubling to 30 minutes, cleared by a success', () => {
  let now = 1_000_000;
  const c = new Cooldowns(() => now);
  assert.equal(c.left('exa'), 0);
  c.rest('exa');
  assert.equal(c.left('exa'), 60_000);
  now += 30_000;
  assert.equal(c.left('exa'), 30_000);
  now += 40_000;
  assert.equal(c.left('exa'), 0);
  c.rest('exa');
  assert.equal(c.left('exa'), 120_000);
  for (let i = 0; i < 10; i++) c.rest('exa');
  assert.equal(c.left('exa'), 30 * 60_000);
  c.clear('exa');
  assert.equal(c.left('exa'), 0);
  c.rest('exa');
  assert.equal(c.left('exa'), 60_000);
});

test('what makes a provider rest: a 429, a 402, a 5xx, a timeout, a request the browser could not make; not a refused key or a bad answer', () => {
  const status = (/** @type {number} */ s) => Object.assign(new Error('x'), { status: s });
  assert.deepEqual([429, 402, 500, 503].map((s) => restsOn(status(s))), [true, true, true, true]);
  assert.deepEqual([400, 401, 403, 404].map((s) => restsOn(status(s))), [false, false, false, false]);
  assert.equal(restsOn(Object.assign(new Error('late'), { late: true })), true);
  assert.equal(restsOn(new TypeError('Failed to fetch')), true);
  assert.equal(restsOn(Object.assign(new Error('x'), { kind: 'cors' })), true);
  assert.equal(restsOn(new Error('plain')), false);
});

test('a device that is offline rests no provider: the failures are its own', () => {
  const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try {
    assert.equal(restsOn(new TypeError('Failed to fetch')), false);
    assert.equal(restsOn(Object.assign(new Error('x'), { status: 429 })), false);
  } finally {
    if (was) Object.defineProperty(globalThis, 'navigator', was);
    else delete (/** @type {any} */ (globalThis)).navigator;
  }
});
