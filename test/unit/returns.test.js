import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectReturn, returnFor, finishReturn } from '../../src/ui/provider-setup.js';
import { Registry } from '../../src/core/registry.js';

// A sign-in coming back to annai's address goes to the plugin that started it (decision 16).

/** A Storage-like map. */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); }, m };
}

/**
 * annai's start as finishReturn sees it, with a plugin that may take returns.
 * @param {((params: URLSearchParams, ui: any) => Promise<void>) | null} returned
 */
function app(returned) {
  const registry = new Registry();
  /** @type {any[]} */
  const failures = [];
  registry.log = (/** @type {any} */ ev) => { failures.push(ev); };
  if (returned) registry.add('provider-acme', 'provider-setup', { returned, keyField: true });
  /** @type {any[]} */
  const cards = [];
  /** @type {string[]} what happened, in order */
  const drawn = [];
  /** @type {string[]} */
  const addresses = [];
  const ctx = {
    registry, store: null, go: () => {},
    plugins: { installed: async () => ({ 'provider-acme': { name: 'Acme' } }) },
    llm: { ready: Promise.resolve(), providers: () => [], config: async () => ({ providers: {} }) },
    notices: { card: (/** @type {any} */ c) => cards.push(c), toast: () => {} },
    render: () => drawn.push('drawn'),
  };
  /** @param {string} search @param {any} storage @param {number} [now] */
  const start = (search, storage, now = 2000) => finishReturn(ctx, {
    location: { search, pathname: '/', hash: '#/trips' },
    history: /** @type {any} */ ({ replaceState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ to) => addresses.push(to) }),
    storage, now,
  });
  return { ctx, cards, drawn, addresses, failures, start };
}

test('a return goes to the plugin that expected it, once, within 15 minutes; the query leaves the address, and Models says it is finishing', async () => {
  const storage = memoryStorage();
  expectReturn('provider-acme', { storage, now: 1000 });
  assert.deepEqual(JSON.parse(/** @type {string} */ (storage.getItem('annai.return'))), { plugin: 'provider-acme', at: 1000 });
  const got = returnFor('?code=abc&state=xyz', { storage, now: 1000 + 14 * 60_000 });
  assert.equal(got?.plugin, 'provider-acme');
  assert.equal(got?.params.get('code'), 'abc');
  assert.equal(returnFor('?code=abc&state=xyz', { storage, now: 1000 + 14 * 60_000 }), null, 'used once');

  /** @type {any[]} */
  const calls = [];
  const a = app(async (params, ui) => {
    a.drawn.push('returned');
    calls.push([params.get('code'), params.get('state'), typeof ui.add, typeof ui.keep]);
  });
  expectReturn('provider-acme', { storage, now: 1000 });
  assert.equal(await a.start('?code=abc&state=xyz', storage), true);
  assert.deepEqual(a.addresses, ['/#/models']);
  assert.deepEqual(a.drawn, ['drawn', 'returned'], 'Models drawn at once (saying whose sign-in is being finished), before the plugin takes it');
  assert.deepEqual(calls, [['abc', 'xyz', 'function', 'function']]);
  assert.deepEqual(a.cards, []);
});

test("a ?code= nobody expected, or one past 15 minutes, goes to no plugin, is removed, and is said on a card; a plugin's failure, or its absence, is said on a card", async () => {
  const storage = memoryStorage();
  assert.equal(returnFor('?code=abc', { storage }), null, 'no one expected it');
  assert.equal(returnFor('', { storage }), null);
  expectReturn('provider-acme', { storage, now: 0 });
  assert.equal(returnFor('?code=abc', { storage, now: 16 * 60_000 }), null, 'too late');
  assert.equal(storage.getItem('annai.return'), null);
  storage.setItem('annai.return', '{not json');
  assert.equal(returnFor('?code=abc', { storage }), null);

  let asked = 0;
  const a = app(async () => { asked++; });
  assert.equal(await a.start('?code=abc', storage), false);
  assert.deepEqual(a.addresses, ['/#/trips'], 'the query goes; the screen stays');
  assert.equal(asked, 0);
  assert.deepEqual(a.cards, [{ tone: 'warn', title: "A sign-in came back too late", body: 'A sign-in came back, but annai no longer expected it: more than 15 minutes passed, or it was finished already. Start it again from Settings → Models.' }]);
  // Too late (past 15 minutes): the same words.
  const late = app(async () => { asked++; });
  expectReturn('provider-acme', { storage, now: 0 });
  assert.equal(await late.start('?code=abc', storage, 16 * 60_000), false);
  assert.equal(asked, 0);
  assert.equal(late.cards.length, 1);
  assert.equal(await a.start('', storage), false);
  assert.equal(await a.start('?', storage), false);
  assert.deepEqual(a.addresses, ['/#/trips', '/#/trips'], 'no query: the address is left alone; an empty one goes, saying nothing');
  assert.equal(a.cards.length, 1);

  // The plugin's own words, on a card titled by its name.
  const refused = app(async () => { throw new Error("Acme didn't take the code."); });
  expectReturn('provider-acme', { storage, now: 1000 });
  await refused.start('?code=abc', storage);
  assert.deepEqual(refused.cards.map((c) => [c.tone, c.title, c.body]), [['warn', "Signing in with Acme didn't finish", "Acme didn't take the code."]]);
  assert.equal(refused.failures.length, 0, 'words are no bug');
  // A crash counts against its plugin.
  const crashed = app(async () => { throw new TypeError('x is not a function'); });
  expectReturn('provider-acme', { storage, now: 1000 });
  await crashed.start('?code=abc', storage);
  assert.equal(crashed.failures.filter((e) => e.type === 'plugin.error' && e.actor === 'plugin:provider-acme').length, 1);
  // Its plugin isn't running (removed, or turned off meanwhile).
  const gone = app(null);
  expectReturn('provider-acme', { storage, now: 1000 });
  assert.equal(await gone.start('?code=abc', storage), true);
  assert.match(gone.cards[0].body, /Acme isn't running/);
});
