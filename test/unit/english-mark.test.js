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
    /** @type {El | null} */ this.parent = null;
    this.dataset = {};
    this.offsetHeight = 0;
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    /** @type {Record<string, unknown>} the box holds its height while a stack is measured (notices.js) */ this.style = { removeProperty() {} };
  }
  querySelector() { return null; }
  /** @param {string} sel tags, "a, b" @returns {any[]} */
  querySelectorAll(sel) {
    const tags = sel.split(',').map((x) => x.trim());
    return this.children.flatMap((c) => (c instanceof El ? [...(tags.includes(c.tag) ? [c] : []), ...c.querySelectorAll(sel)] : []));
  }
  cloneNode() {
    const c = new El(this.tag);
    c.attrs = { ...this.attrs };
    c.children = this.children.map((k) => (k instanceof El ? k.cloneNode() : { ...k }));
    return c;
  }
  getBoundingClientRect() { return { height: 0 }; }
  /** @param {string} sel only ':empty', for the notices box's keep() */
  matches(sel) { return sel === ':empty' && !this.children.length; }
  remove() {}
  /** @param {any} other */
  replaceWith(other) { const parent = this.parent; const at = parent?.children.indexOf(this) ?? -1; if (parent && at >= 0) { other.parent = parent; parent.children[at] = other; } }
  /** @param {string} k @param {string} v */
  setAttribute(k, v) { this.attrs[k] = v; }
  /** @param {...any} cs */
  append(...cs) { for (const c of cs) c.parent = this; this.children.push(...cs); }
  /** @param {...any} cs */
  replaceChildren(...cs) { this.children = []; for (const c of cs) this.children.push(typeof c === 'string' ? { text: c } : c); }
  set textContent(v) { this.children = [{ text: v }]; }
  get textContent() { return this.children.map((c) => c.text ?? c.textContent).join(''); }
  addEventListener() {}
}
Object.assign(globalThis, { Node, ResizeObserver: class { observe() {} }, addEventListener() {}, scrollY: 0, scrollTo() {}, getComputedStyle: () => ({ position: 'static', getPropertyValue: () => '' }), innerHeight: 800, document: { body: new El('body'), documentElement: new El('html'), createElement: (/** @type {string} */ t) => new El(t), createTextNode: (/** @type {string} */ text) => ({ text }) } });

const { PluginError } = await import('../../src/core/registry.js');
const { EnglishError } = await import('../../src/core/errors.js');
const { englishOf, englishIn, showError, messageOf } = await import('../../src/ui/dom.js');
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
  const { cards } = startCards([{ id: 'hello', error }, { id: 'old', error }], { name: (id) => id, taken: true });
  assert.deepEqual(cards.map((c) => /** @type {any} */ (c).errors), [[error], [error]]);
});

test('the checks of a package and of an itinerary throw errors marked as annai\'s English', async () => {
  const bad = new TextEncoder().encode('{ not json');
  await assert.rejects(inspectPackage(new Map([['annai-plugin.json', bad]])), (/** @type {any} */ e) => e.en === true && englishOf(e) === 'Its annai-plugin.json is not valid JSON');
  await assert.rejects(inspectPackage(new Map([['annai-plugin.json', new TextEncoder().encode('{"id":"hello"}')]])), (/** @type {any} */ e) => e.en === true && /^Its annai-plugin.json is not valid: /.test(englishOf(e)));
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

test('englishIn: the same English twice is each marked where it stands, never added after; one inside another\'s is left out, not doubled', () => {
  const x = new EnglishError('its entry file x.js is missing');
  assert.deepEqual(parts({ children: englishIn('P1: its entry file x.js is missing. P2: its entry file x.js is missing.', x, x) }),
    [['P1: ', null], ['its entry file x.js is missing', 'en'], ['. P2: ', null], ['its entry file x.js is missing', 'en'], ['.', null]]);
  // The text holds it once: the second has no place, so it is not put anywhere.
  assert.deepEqual(parts({ children: englishIn('P1: its entry file x.js is missing.', x, x) }), [['P1: ', null], ['its entry file x.js is missing', 'en'], ['.', null]]);
  // One error's English inside another's: the first takes its place, the second finds none after it.
  const inner = new EnglishError('is missing');
  assert.deepEqual(parts({ children: englishIn('P1: its entry file x.js is missing.', x, inner) }), [['P1: ', null], ['its entry file x.js is missing', 'en'], ['.', null]]);
  const text = 'P1: its entry file x.js is missing. P2: is missing.';
  assert.deepEqual(parts({ children: englishIn(text, x, inner) }).map(([w]) => w).join(''), text);
  assert.equal(parts({ children: englishIn(text, x, inner) }).filter(([, lang]) => lang).length, 2);
});

test('guard: a start that failed is framed in annai\'s own words, a sentence on the screens: a plugin\'s words are never marked English, annai\'s own English is, and the log keeps annai\'s English', async () => {
  const { Registry } = await import('../../src/core/registry.js');
  const reg = new Registry();
  const own = await reg.guard('p', 'starting', () => { throw new Error('their words'); })().catch((e) => e);
  assert.equal(own.shown, 'Starting failed: their words.'); // ended as a sentence, so the next one is joined as after any other
  assert.equal(own.en, false);
  assert.equal(englishOf(own), '');
  assert.equal(own.message, 'p: starting failed: their words');
  const late = await reg.guard('p', 'starting', () => { throw Object.assign(new Error("it didn't finish starting within 10 seconds"), { shown: '10 秒以内に始まりませんでした。' }); })().catch((e) => e);
  assert.equal(late.shown, 'Starting failed: 10 秒以内に始まりませんでした。');
  assert.equal(englishOf(late), '');
  assert.equal(messageOf(late), 'Starting failed: 10 秒以内に始まりませんでした。');
  assert.equal(late.message, "p: starting failed: it didn't finish starting within 10 seconds");
  // annai's own check, in a developer's English, without its plugin's id in the middle: the frame is the screens' words, the check's is marked.
  const ours = await reg.guard('p', 'starting', () => { throw new PluginError('p', 'its module has no activate() function'); })().catch((e) => e);
  assert.equal(ours.shown, 'Starting failed: its module has no activate() function.');
  assert.equal(englishOf(ours), 'its module has no activate() function');
  assert.equal(messageOf(ours), ours.shown);
  // An English part annai named inside its words stays the one marked.
  const named = await new Registry().guard('p', 'starting', () => { throw new PluginError('p', 'x', { shown: 'Not valid: this is not a zip', en: 'this is not a zip' }); })().catch((e) => e);
  assert.equal(englishOf(named), 'this is not a zip');
  assert.equal(messageOf(named), 'Starting failed: Not valid: this is not a zip.');
  // A hook's error is counted and logged; no words of the screens' are made for it.
  const hook = await new Registry().guard('p', 'hook', () => { throw new Error('their words'); })().catch((e) => e);
  assert.equal(hook.shown, undefined);
  assert.equal(hook.message, 'p: hook failed: their words');
});

test('a plugin\'s card body that is not a string is shown as text, not thrown at the plugin', async () => {
  const { hostKit, codePlugin } = await import('./package-kit.js');
  const k = await hostKit();
  /** @type {any[]} */
  const seen = [];
  k.host.connect({ notices: { card: (/** @type {any} */ c) => seen.push(c), toast() {} } });
  await k.host.install(codePlugin('numbers', "annai.ui.card({ title: 'Count', body: 42 }); annai.ui.card({ title: 'None' });"));
  await k.host.start('numbers');
  assert.deepEqual(seen.map((c) => c.body), ['42', undefined]);
});

test('cards folded into a stack are announced from their title and words, copied with their lang, not as flat text with the buttons', () => {
  const notices = createNotices();
  const error = new PluginError('hello', 'its entry file x.js is missing');
  notices.card({ title: 'Hello wasn\'t installed', body: 'Not installed: its entry file x.js is missing.', errors: [error] });
  notices.card({ title: 'Hello wasn\'t installed', body: 'Not installed: its entry file x.js is missing.', errors: [error] });
  const stack = notices.el.children[0];
  const said = stack.children.find((/** @type {any} */ c) => c.className === 'visually-hidden');
  assert.deepEqual(parts(said.children[1]), [['Not installed: ', null], ['its entry file x.js is missing', 'en'], ['.', null]]);
  assert.ok(said.children.every((/** @type {any} */ c) => ['strong', 'p'].includes(c.tag)), 'no buttons');
});

// words-next (the Deferred entry "Some plugin errors still start in lower case with no subject"): a screen shows a plugin's error without the
// plugin's id (messageOf), as a card's body under a title that names the plugin, so its words are a sentence of their own: "It is being
// removed.", never "is being removed". The words a screen shows are the error's shown where it has one, else its message (annai's English,
// marked lang="en"); either starts with a capital, a quoted name, or annai's own name (annai, annai.register), which keeps its case.
// The sweep reads every `new PluginError`, and every `new Error` given a `shown` by Object.assign; the words are a literal, a template, a
// t`` or plural(), either side of a ?:, a name declared in the file (a shorthand `shown` too), and a template that starts with a substitution
// is read by what it starts with. Words made elsewhere (a call, a parameter) can't be read here, and are skipped.
test("every plugin error annai throws shows a sentence of its own: the words a screen shows start with a capital, never a fragment after the plugin's id", async () => {
  const ts = (await import('typescript')).default;
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../../', import.meta.url);
  /** @param {string} dir @returns {Promise<string[]>} */
  const files = async (dir) => (await readdir(new URL(dir, root), { recursive: true })).filter((f) => f.endsWith('.js') && !f.includes('vendor/')).map((f) => `${dir}${f}`);
  /** The words of a start: what a string, a template, a t`` or plural() begins with, each side of a ?:, a name's declaration in this file; null where it is made elsewhere. @param {any} n @param {any} sf @param {Set<string>} [seen] @returns {string[] | null} */
  const heads = (n, sf, seen = new Set()) => {
    if (!n) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
    if (ts.isTemplateExpression(n)) return n.head.text ? [n.head.text] : heads(n.templateSpans[0]?.expression, sf, seen);
    if (ts.isTaggedTemplateExpression(n)) return heads(n.template, sf, seen);
    if (ts.isConditionalExpression(n)) return [...(heads(n.whenTrue, sf, seen) ?? []), ...(heads(n.whenFalse, sf, seen) ?? [])];
    if (ts.isParenthesizedExpression(n)) return heads(n.expression, sf, seen);
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'sentences') return heads(n.arguments[0], sf, seen);
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'plural') return [...(heads(n.arguments[1], sf, seen) ?? []), ...(heads(n.arguments[2], sf, seen) ?? [])];
    if (ts.isIdentifier(n) && !seen.has(n.text)) {
      seen.add(n.text);
      /** @type {string[]} */
      const out = [];
      /** @param {any} x */
      const find = (x) => {
        if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === n.text) out.push(...(heads(x.initializer, sf, seen) ?? []));
        ts.forEachChild(x, find);
      };
      find(sf);
      return out.length ? out : null;
    }
    return null;
  };
  /** The value of an object literal's `name`, written out or as a shorthand. @param {any} o @param {any} sf @param {string} name */
  const prop = (o, sf, name) => {
    const p = o && ts.isObjectLiteralExpression(o) ? o.properties.find((/** @type {any} */ x) => x.name?.getText(sf) === name) : undefined;
    return p ? { words: ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) ? p.initializer : null } : null;
  };
  /** @type {string[]} */
  const wrong = [];
  let read = 0;
  for (const file of [...(await files('src/')), ...(await files('plugins-official/'))]) {
    const sf = ts.createSourceFile(file, await readFile(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    /** @param {any} n @param {string[] | null} words */
    const check = (n, words) => {
      for (const w of words ?? []) {
        read++;
        if (w && !/^["“]?[A-Z]/.test(w) && w !== '"' && !/^annai\b/.test(w)) wrong.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${w.slice(0, 50)}`);
      }
    };
    /** @param {any} n */
    const visit = (n) => {
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'PluginError' && n.arguments && n.arguments.length >= 2) {
        const shown = prop(n.arguments[2], sf, 'shown');
        check(n, heads(shown ? shown.words : n.arguments[1], sf));
      }
      // Object.assign(new Error(…), { shown }): the screens show the shown, whatever the message says.
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'Error' && ts.isCallExpression(n.parent) && n.parent.expression.getText(sf) === 'Object.assign' && n.parent.arguments[0] === n) {
        const shown = prop(n.parent.arguments[1], sf, 'shown');
        if (shown) check(n, heads(shown.words, sf));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(wrong, []);
  // A sweep that read nothing would pass on any code: it read 86 starts of words on this tree (2026-11-17), so one that reads under 70 has lost a shape.
  assert.ok(read >= 70, `the sweep read ${read} starts of words`);
});
