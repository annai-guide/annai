import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screensCards, screensAtStart, chosenUi, ownName, keepUiChoice, keepUiFrom, keepWords } from '../../src/ui/languages.js';

const offered = ['en', 'ja', 'zh-Hans'];
const restart = () => {};
/** @param {Partial<Parameters<typeof screensCards>[0]>} o */
const start = (o) => screensCards({ settings: '', kept: '', running: 'en', phone: ['en-US'], offered, shipped: offered, restart, ...o });

test('languages are named by their own', () => {
  assert.equal(ownName('ja'), '日本語');
  assert.equal(ownName('zh-Hans'), '简体中文');
  assert.equal(ownName('en'), 'English');
});

test('when the settings and the copy on this device agree there is nothing to say', () => {
  assert.deepEqual(start({}), { copy: null, cards: [] });
  assert.deepEqual(start({ settings: 'ja', kept: 'ja', running: 'ja' }), { copy: null, cards: [] });
});

test('a copy that is missing is written, and a card offers the restart that shows the language', () => {
  const got = start({ settings: 'ja', kept: '', running: 'en' });
  assert.equal(got.copy, 'ja');
  assert.equal(got.cards.length, 1);
  assert.match(got.cards[0].title, /^Restart to show annai in 日本語$/);
  assert.match(got.cards[0].body, /Your settings say annai's screens are in 日本語, but this device is showing something else\./);
  assert.deepEqual(got.cards[0].actions.map((a) => [a.label, a.primary]), [['Restart annai', true]]);
  assert.equal(got.cards[0].actions[0].run, restart);
});

test('a copy that differs but would show the same language is written quietly', () => {
  assert.deepEqual(start({ settings: 'ja', kept: '', running: 'ja', phone: ['ja-JP'] }), { copy: 'ja', cards: [] });
  assert.deepEqual(start({ settings: '', kept: 'ja', running: 'en' }), { copy: '', cards: [] }, 'as the phone is set, and the phone is English');
  assert.equal(start({ settings: '', kept: 'ja', running: 'ja', phone: ['en-US'] }).cards[0].title, 'Restart to show annai in English');
});

test('a language no longer offered is the phone\'s', () => {
  assert.deepEqual(start({ settings: 'ko', kept: '', running: 'ja', phone: ['ja-JP'] }), { copy: 'ko', cards: [] });
});

test('words that could not be loaded get a card that says why, and the restart is not asked for the same language again', () => {
  const got = start({ settings: 'ja', kept: 'ja', running: 'en', failed: 'ja' });
  assert.equal(got.copy, null);
  assert.equal(got.cards.length, 1);
  assert.equal(got.cards[0].title, '日本語 couldn\'t be loaded');
  assert.equal(got.cards[0].body, 'annai shows English until it is online.');
  assert.deepEqual(got.cards[0].actions.map((a) => a.label), ['Try again']);
  const both = start({ settings: 'ja', kept: '', running: 'en', failed: 'ja' });
  assert.equal(both.cards.length, 1, 'one card: restarting would only fail again');
  assert.equal(both.copy, 'ja');
});

/** A localStorage that holds what it is given. @param {Record<string, string>} [start] */
function fakeStorage(start = {}) {
  const held = new Map(Object.entries(start));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (/** @type {string} */ k) => held.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => held.set(k, v), removeItem: (/** @type {string} */ k) => held.delete(k) } });
  return held;
}

test('the copy on the device is written for a language and taken away for "as this phone is set"', () => {
  const held = fakeStorage({ other: 'x' });
  keepUiChoice('ja');
  assert.deepEqual([...held], [['other', 'x'], ['annai.ui', 'ja']]);
  keepUiChoice('');
  keepUiChoice(null);
  assert.deepEqual([...held], [['other', 'x']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  assert.doesNotThrow(() => keepUiChoice('ja'), 'blocked storage is no error');
});

test('a restore writes the copy from the settings that came in', async () => {
  const held = fakeStorage({ 'annai.ui': 'zh-Hans' });
  /** @param {unknown} app */
  const ws = (app) => ({ readJSON: async () => app });
  await keepUiFrom(ws({ languages: { ui: 'ja' } }));
  assert.equal(held.get('annai.ui'), 'ja');
  await keepUiFrom(ws({ languages: { spoken: ['en'] } }));
  assert.equal(held.has('annai.ui'), false, 'settings without a choice: as the phone is set');
  held.set('annai.ui', 'ja');
  await keepUiFrom(ws({}));
  assert.equal(held.has('annai.ui'), false);
});

test('keepWords asks the worker and waits for its answer; with no answer, or no worker, it says whether the words can be had', async () => {
  /** @param {unknown} reply */
  const worker = (reply) => /** @type {any} */ ({ postMessage: (/** @type {any} */ msg, /** @type {MessagePort[]} */ [port]) => { assert.deepEqual(msg, { type: 'cache-words', tag: 'ja' }); if (reply !== undefined) port.postMessage(reply); } });
  assert.equal(await keepWords('ja', { worker: worker({ ok: true }) }), true);
  assert.equal(await keepWords('ja', { worker: worker({ ok: false }) }), false);
  assert.equal(await keepWords('ja', { worker: worker(undefined), limitMs: 20 }), false, 'a worker that never answers');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => ({ ok: url === '/l10n/ja.json' }));
    assert.equal(await keepWords('ja', { worker: null }), true);
    assert.equal(await keepWords('zh-Hans', { worker: null }), false);
    globalThis.fetch = /** @type {any} */ (async () => { throw new TypeError('offline'); });
    assert.equal(await keepWords('ja', { worker: null }), false);
  } finally {
    globalThis.fetch = real;
  }
});

test('chosenUi reads the choice from the app settings: a tag, or nothing as the phone is set', () => {
  assert.equal(chosenUi({ languages: { ui: 'ja' } }), 'ja');
  assert.equal(chosenUi({ languages: { ui: 7 } }), '');
  assert.equal(chosenUi({ languages: {} }), '');
  assert.equal(chosenUi({}), '');
});

/** The page, the device and the cards at the start. @param {{ failed?: string, kept?: string, app?: unknown }} o */
async function atStart({ failed, kept, app }) {
  const held = fakeStorage(kept === undefined ? {} : { 'annai.ui': kept });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: failed ? { l10nFailed: failed } : {} } } });
  /** @type {any[]} */
  const cards = [];
  await screensAtStart({ ws: /** @type {any} */ ({ readJSON: async () => { if (app === undefined) throw new Error('storage'); return app; } }), notices: { card: (/** @type {any} */ c) => cards.push(c) }, restart: () => {} });
  return { held, cards };
}

test('the start writes the device\'s copy from the settings, or takes it away', async () => {
  assert.equal((await atStart({ app: { languages: { ui: 'ja' } }, kept: '' })).held.get('annai.ui'), 'ja');
  assert.deepEqual((await atStart({ app: {}, kept: 'ja' })).held.has('annai.ui'), false);
});

test('words that failed to load get their card even when the settings cannot be read', async () => {
  const got = await atStart({ failed: 'ja', kept: 'ja' });
  assert.equal(got.cards.length, 1);
  assert.equal(got.cards[0].title, '日本語 couldn\'t be loaded');
  assert.equal(got.held.get('annai.ui'), 'ja', 'and the copy is left as it is');
  assert.equal((await atStart({ kept: 'ja', app: {} })).cards.length, 0);
});
