import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderSearch, normalizeRows, Cooldowns, restsOn, FREE_SERVICES, searchOffIn, trusted, cut, wellFormed } from '../../src/core/web-search.js';

const p = (/** @type {string} */ id, /** @type {any} */ over = {}) => ({ id, name: id, search: async () => [], ...over });

test('the order: the user\'s list first, then keyed, free web and knowledge; switched-off ones stay in the list (the screen ticks them)', () => {
  const list = [p('wiki', { kind: 'knowledge', always: true }), p('exa', { free: true }), p('jina'), p('tavily'), p('parallel', { free: true })];
  assert.deepEqual(orderSearch(list, {}).map((x) => x.id), ['jina', 'tavily', 'exa', 'parallel', 'wiki']);
  assert.deepEqual(orderSearch(list, { search: ['parallel', 'ghost', 'jina'] }).map((x) => x.id), ['tavily', 'parallel', 'jina', 'exa', 'wiki']);
  assert.deepEqual(orderSearch(list, { search: ['jina', 'jina'] }).map((x) => x.id), ['jina', 'tavily', 'exa', 'parallel', 'wiki']);
  assert.deepEqual(searchOffIn({ searchOff: ['exa', 'wiki', 7] }, list), ['exa']);
  assert.deepEqual(FREE_SERVICES.map((s) => s.id), ['exa', 'parallel', 'firecrawl']);
});

test('rows: tags and entities stripped, whitespace folded, tracking parameters dropped, duplicates (by host and path) once, at most 8 rows', () => {
  const rows = [
    { title: 'Nepenthe <b>Big Sur</b> &amp; more', url: 'https://www.nepenthe.com/hours/?utm_source=x&srsltid=abc&msockid=1&keep=1', snippet: 'Open\tdaily\n11:30 <span class="searchmatch">am</span>' },
    { title: 'Again', url: 'https://nepenthe.com/hours?keep=1', snippet: 'a duplicate of the first by host and path' },
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
  for (let i = 0; i < 10; i++) {
    now += 31 * 60_000;
    c.rest('exa');
  }
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
  assert.equal(restsOn(Object.assign(new Error('x'), { rest: true })), true);
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

test('M1: a search plugin installed after a reorder lands before the saved free services and the floor, not below them', () => {
  const saved = ['jina', 'parallel', 'exa', 'firecrawl', 'wiki'];
  const list = [{ id: 'jina' }, { id: 'exa', free: true }, { id: 'parallel', free: true }, { id: 'firecrawl', free: true }, { id: 'wiki', kind: 'knowledge' }, { id: 'tavily' }, { id: 'serper' }];
  assert.deepEqual(orderSearch(list, { search: saved }).map((p) => p.id), ['jina', 'tavily', 'serper', 'parallel', 'exa', 'firecrawl', 'wiki']);
  // A free one missing from the list goes before the saved knowledge, after the saved free ones; a knowledge one last.
  const more = [...list.filter((p) => p.id !== 'firecrawl'), { id: 'firecrawl', free: true }, { id: 'later', kind: 'knowledge' }];
  assert.deepEqual(orderSearch(more, { search: ['jina', 'exa', 'wiki'] }).map((p) => p.id), ['jina', 'tavily', 'serper', 'exa', 'parallel', 'firecrawl', 'wiki', 'later']);
  // A keyed one the user put below the free ones is respected for what is saved; a new keyed one goes before the first free.
  assert.deepEqual(orderSearch([{ id: 'exa', free: true }, { id: 'jina' }, { id: 'tavily' }], { search: ['exa', 'jina'] }).map((p) => p.id), ['tavily', 'exa', 'jina']);
});

test('rows are made in time: a megabyte of "<" or of unclosed links takes a fraction of a second, and each field is cut first', () => {
  const t = performance.now();
  for (const bad of ['<'.repeat(1_000_000), '[a]('.repeat(250_000), '['.repeat(1_000_000), `&#${'1'.repeat(1_000_000)};`]) {
    const [row] = normalizeRows([{ title: bad, url: 'https://a.test/', snippet: bad }], 'tokyo ramen hours');
    assert.ok(row.title.length <= 160 && row.snippet.length <= 400);
  }
  assert.ok(performance.now() - t < 1500, `took ${Math.round(performance.now() - t)} ms`);
  // A million junk rows are not all looked at.
  const t2 = performance.now();
  assert.deepEqual(normalizeRows(Array.from({ length: 1_000_000 }, () => ({ url: 'nope' })), 'q'), []);
  assert.ok(performance.now() - t2 < 1500);
});

test('S11: two videos on one page are two rows; the path\'s case counts; tracking parameters and their order do not', () => {
  const rows = normalizeRows([
    { title: 'A', url: 'https://www.youtube.com/watch?v=A', snippet: '' },
    { title: 'B', url: 'https://youtube.com/watch?v=B&utm_source=x', snippet: '' },
    { title: 'A again', url: 'https://youtube.com/watch?utm_medium=y&v=A', snippet: '' },
    { title: 'Case', url: 'https://x.test/Wiki/Page', snippet: '' },
    { title: 'Case 2', url: 'https://x.test/wiki/page', snippet: '' },
    { title: 'Order', url: 'https://x.test/s?a=1&b=2', snippet: '' },
    { title: 'Order 2', url: 'https://x.test/s?b=2&a=1', snippet: '' },
  ], 'q');
  assert.deepEqual(rows.map((r) => r.title), ['A', 'B', 'Case', 'Case 2', 'Order']);
});

test('text is cut at code points: no lone half of an emoji, and no entity makes one', () => {
  assert.equal(cut('ab😀cd', 3), 'ab');
  assert.equal(cut('ab😀cd', 4), 'ab😀');
  const [row] = normalizeRows([{ title: `${'a'.repeat(159)}😀`, url: 'https://a.test/', snippet: 'x &#xD800; y &#55357; z' }], 'q');
  assert.ok(!/[\uD800-\uDFFF]/.test(row.title + row.snippet), JSON.stringify(row));
  assert.equal(row.title.length, 159);
});

test('a rest is counted once: a second failure while the first still rests changes nothing; a rest that is not the provider\'s doing (a slow connection) does not climb', () => {
  let now = 0;
  const c = new Cooldowns(() => now);
  c.rest('exa');
  c.rest('exa');
  assert.equal(c.left('exa'), 60_000);
  now += 61_000;
  c.rest('exa', false);
  assert.equal(c.left('exa'), 60_000, 'not escalated: still the first level');
  now += 61_000;
  c.rest('exa');
  assert.equal(c.left('exa'), 120_000, 'a real failure after it climbs from there');
});

test('S2: only the built-in web plugin\'s providers may be always on, free or knowledge', () => {
  const mk = (/** @type {string} */ pluginId, /** @type {any} */ item) => ({ pluginId, item });
  const out = trusted([mk('web', { id: 'wiki', kind: 'knowledge', always: true }), mk('third', { id: 'sticky', kind: 'knowledge', always: true, free: true, name: 'S', search: async () => [] })]);
  assert.deepEqual(out.map((p) => [p.id, p.kind ?? 'web', Boolean(p.always), Boolean(p.free)]), [['wiki', 'knowledge', true, false], ['sticky', 'web', false, false]]);
  assert.equal(out[1].name, 'S');
  assert.deepEqual(searchOffIn({ searchOff: ['sticky', 'wiki'] }, out), ['sticky']);
});

test('a lone surrogate already in an answer is replaced with U+FFFD in every field, with and without String.prototype.toWellFormed', () => {
  const rows = [{ title: '\udc00 title \ud800x', url: 'https://a.test/', snippet: 'a\ud800 b \udc00c and 😀 whole' }];
  const check = () => {
    const [row] = normalizeRows(rows, 'q');
    assert.equal(row.title, '� title �x');
    assert.equal(row.snippet, 'a� b �c and 😀 whole');
    assert.equal(wellFormed('ok 😀'), 'ok 😀');
  };
  check();
  const proto = /** @type {any} */ (String.prototype);
  const native = proto.toWellFormed;
  try {
    delete proto.toWellFormed; // the fallback, as on a browser without it
    check();
  } finally {
    if (native) proto.toWellFormed = native;
  }
});
