import { test } from 'node:test';
import assert from 'node:assert/strict';

// A developer's English on a screen carries lang="en" (localization, decision 11): the mark is made at the source (`en` on an error) and
// read by the shared readers (englishOf, englishIn, showError, and the notice card through englishIn), never by a screen on its own.

// The least DOM that h, linkIn and showError touch.
class Node {}
class El extends Node {
  /** @param {string} tag */
  constructor(tag) {
    super();
    this.tag = tag;
    /** @type {Record<string, string>} */ this.attrs = {};
    /** @type {any[]} */ this.children = [];
    this.dataset = {};
    this.offsetHeight = 0;
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { height: 0 }; }
  remove() {}
  replaceWith() {}
  /** @param {string} k @param {string} v */
  setAttribute(k, v) { this.attrs[k] = v; }
  /** @param {...any} cs */
  append(...cs) { this.children.push(...cs); }
  /** @param {...any} cs */
  replaceChildren(...cs) { this.children = []; for (const c of cs) this.children.push(typeof c === 'string' ? { text: c } : c); }
  set textContent(v) { this.children = [{ text: v }]; }
  get textContent() { return this.children.map((c) => c.text ?? c.textContent).join(''); }
  addEventListener() {}
}
Object.assign(globalThis, { Node, addEventListener() {}, scrollY: 0, scrollTo() {}, document: { createElement: (/** @type {string} */ t) => new El(t), createTextNode: (/** @type {string} */ text) => ({ text }) } });

const { PluginError } = await import('../../src/core/registry.js');
const { EnglishError } = await import('../../src/core/l10n.js');
const { englishOf, englishIn, showError } = await import('../../src/ui/dom.js');
const { createNotices } = await import('../../src/ui/notices.js');
const { startCards } = await import('../../src/ui/plugin-cards.js');
const { inspectPackage } = await import('../../src/core/packages.js');
const { trackFrom } = await import('../../src/core/live/simulate.js');

/** What an element holds, as [text, lang] parts. @param {any} el */
const parts = (el) => el.children.map((/** @type {any} */ c) => (typeof c === 'string' ? { text: c } : c)).filter((/** @type {any} */ c) => (c.text ?? c.textContent) !== '').map((/** @type {any} */ c) => [c.text ?? c.textContent, c.attrs?.lang ?? null]);

test('a PluginError with no screen words and no cause is annai\'s English whole; with shown, or a plugin\'s own cause, it is not', () => {
  assert.equal(new PluginError('hello', 'its entry file x.js is missing').en, true);
  assert.equal(new PluginError('hello', 'needs a thing', { shown: 'is Japanese' }).en, false);
  assert.equal(new PluginError('hello', 'the tool t failed: their words', { cause: new Error('their words') }).en, false);
  assert.equal(new PluginError('hello', 'in English: why', { shown: 'is Japanese: why', en: 'why' }).en, 'why');
  assert.equal(new EnglishError('An itinerary needs a route').en, true);
});

test('englishOf: all of an annai-made error\'s words, the part an error names, a schema\'s refusals; never a provider\'s or a plugin\'s own', () => {
  assert.equal(englishOf(new PluginError('hello', 'its annai-plugin.json is not valid JSON')), 'its annai-plugin.json is not valid JSON');
  assert.equal(englishOf(new EnglishError('The file name "a b" isn\'t allowed.')), 'The file name "a b" isn\'t allowed.');
  assert.equal(englishOf(new PluginError('hello', 'is being removed', { shown: 'は削除中です' })), '');
  assert.equal(englishOf(new PluginError('hello', 'the tool failed: 失敗', { cause: new Error('失敗') })), '');
  assert.equal(englishOf(Object.assign(new Error('このファイルは開けません: this is not a zip archive'), { en: 'this is not a zip archive' })), 'this is not a zip archive');
  assert.equal(englishOf(Object.assign(new Error('x'), { errors: ['$.title: is required'] })), 'title is required');
  assert.equal(englishOf(Object.assign(new Error('x'), { errors: ['$.title: is required'], shown: 'お名前が必要です' })), '');
  assert.equal(englishOf(new Error('The server said no')), '');
  assert.equal(englishOf(Object.assign(new Error('x'), { name: 'ProviderError' })), '');
  assert.equal(englishOf(undefined), '');
});

test('englishIn: the English stands in its own span, where its words are in the screens\'; none gives the text whole', () => {
  const e = new PluginError('hello', 'its annai-plugin.json is not valid JSON');
  assert.deepEqual(parts({ children: englishIn('hello を入れられません: its annai-plugin.json is not valid JSON. もう一度。', e) }),
    [['hello を入れられません: ', null], ['its annai-plugin.json is not valid JSON', 'en'], ['. もう一度。', null]]);
  assert.deepEqual(parts({ children: englishIn('そのまま', new Error('x'), new PluginError('p', 'is being removed', { shown: '削除中' })) }), [['そのまま', null]]);
  // Two errors, each where it stands.
  const two = englishIn('A: first words. B: second words.', new EnglishError('first words'), new EnglishError('second words'));
  assert.deepEqual(parts({ children: two }), [['A: ', null], ['first words', 'en'], ['. B: ', null], ['second words', 'en'], ['.', null]]);
});

test('showError: an annai-made error\'s words are an element marked lang="en"; a provider\'s are plain', () => {
  const el = /** @type {any} */ (new El('p'));
  showError(el, new PluginError('hello', 'its entry file x.js is missing'));
  assert.deepEqual(parts(el), [['its entry file x.js is missing', 'en']]);
  showError(el, new Error('The server said no'));
  assert.deepEqual(parts(el), [['The server said no', null]]);
  showError(el, Object.assign(new Error('x'), { errors: ['$.maxEdge: must be at least 16'] }));
  assert.deepEqual(parts(el), [['maxEdge must be at least 16', 'en']]);
});

test('the cards for plugins that did not start hold their errors, for the notice card to mark', () => {
  const error = new PluginError('hello', 'its module has no activate() function');
  const { cards } = startCards([{ id: 'hello', error, disabled: false }, { id: 'old', error, disabled: true }], { name: (id) => id, taken: true });
  assert.deepEqual(cards.map((c) => /** @type {any} */ (c).errors), [[error], [error]]);
});

test('the checks of a package and of an itinerary throw errors marked as annai\'s English', async () => {
  const bad = new TextEncoder().encode('{ not json');
  await assert.rejects(inspectPackage(new Map([['annai-plugin.json', bad]])), (/** @type {any} */ e) => e.en === true && englishOf(e) === 'its annai-plugin.json is not valid JSON');
  await assert.rejects(inspectPackage(new Map([['annai-plugin.json', new TextEncoder().encode('{"id":"hello"}')]])), (/** @type {any} */ e) => e.en === true && /^its annai-plugin.json is not valid: /.test(englishOf(e)));
  assert.throws(() => trackFrom(/** @type {any} */ ({ start: 'tomorrow', route: [] })), (/** @type {any} */ e) => englishOf(e).startsWith('An itinerary needs a start'));
  assert.throws(() => trackFrom(/** @type {any} */ ({ start: '2026-11-27T08:30:00-08:00', route: [{}] })), (/** @type {any} */ e) => englishOf(e) === 'An itinerary needs a route of at least two places.');
});

test('a package check that was in the screens\' words keeps its English for logs and a model, with the screens\' words as shown', async () => {
  const zip = new Map([['a/SKILL.md', new TextEncoder().encode('---\nname: aa\ndescription: x\n---\nhi')], ['b/SKILL.md', new TextEncoder().encode('---\nname: bb\ndescription: x\n---\nhi')]]);
  await assert.rejects(inspectPackage(zip), (/** @type {any} */ e) => e instanceof PluginError && /several skills/.test(e.message) && e.en === false && typeof e.shown === 'string');
});

test('the notice card marks an error\'s English where the body holds it, and a body with no errors is plain text', () => {
  const notices = createNotices();
  const error = new PluginError('hello', 'its entry file x.js is missing');
  notices.card({ title: 'Hello wasn\'t installed', body: 'Not installed: its entry file x.js is missing. Try again.', errors: [error] });
  notices.card({ title: 'Other', body: 'The server said no' });
  const [first, second] = notices.el.children;
  const [, body] = first.children;
  assert.deepEqual(parts(body), [['Not installed: ', null], ['its entry file x.js is missing', 'en'], ['. Try again.', null]]);
  assert.deepEqual(parts(second.children[1]), [['The server said no', null]]);
});
