import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCards, reloadCard, disabledCard } from '../../src/ui/plugin-cards.js';
import { PluginError, Registry } from '../../src/core/registry.js';

const NAMES = /** @type {Record<string, string>} */ ({ hello: 'Hello checks', hola: 'Hola checks', old: 'Old tool' });
const name = (/** @type {string} */ id) => NAMES[id] ?? id;
const failed = (/** @type {string} */ id) => ({ id, error: new Error('Failed to fetch dynamically imported module.') });

test('plugins that did not start get a card each, by name, at every launch they fail: none says it was turned off, as annai never turns one off for not starting; a stale `disabled` an older caller gave still reads "didn\'t start" (plugin-fails-next)', () => {
  const stale = { ...failed('old'), disabled: true }; // the spread avoids a literal excess-property check: no caller gives it any more
  const { cards, unloaded } = startCards([failed('hello'), stale], { name, taken: true });
  assert.deepEqual(cards.map((c) => c.title), ['The plugin "Hello checks" didn\'t start', 'The plugin "Old tool" didn\'t start']);
  assert.deepEqual(cards.map((c) => c.body), Array(2).fill('Failed to fetch dynamically imported module. You can turn it off in Settings → Plugins.'));
  assert.deepEqual(unloaded, []);
});

test("a start that ran out of its time: annai's frame and its reason come first, then how to turn it off, not nested after a colon (words-next)", () => {
  const error = new PluginError('slow', "starting failed: it didn't finish starting within 10 seconds", { shown: "Starting failed: It didn't finish within 10 seconds." });
  const { cards } = startCards([{ id: 'slow', error }], { name, taken: true });
  assert.equal(cards[0].body, "Starting failed: It didn't finish within 10 seconds. You can turn it off in Settings → Plugins.");
});

test('on a page no service worker controls, every one that failed shares the one reload card', () => {
  const { cards, unloaded } = startCards([failed('hello'), failed('hola'), failed('old')], { name, taken: false });
  assert.deepEqual(cards, []);
  assert.deepEqual(unloaded, ['Hello checks', 'Hola checks', 'Old tool']);
});

test('the reload card names the plugins, never their ids, and has Reload now; with none named, it says plugins can\'t start or be installed', () => {
  let reloads = 0;
  const card = reloadCard(['Hello checks', 'Hola checks'], () => { reloads++; });
  assert.equal(card.title, 'annai needs a reload');
  assert.equal(card.body, "It opened without its offline service, so these plugins can't start: Hello checks and Hola checks.");
  assert.deepEqual(card.actions.map((a) => [a.label, a.primary]), [['Reload now', true]]);
  card.actions[0].run();
  assert.equal(reloads, 1);
  assert.equal(reloadCard(['Hello checks'], () => {}).body, "It opened without its offline service, so this plugin can't start: Hello checks.");
  assert.equal(reloadCard([], () => {}).body, "It opened without its offline service, so plugins can't start or be installed.");
});

test("a start error that is a plugin's own words, with no stop of its own, is ended before the next sentence (the cards read \"boom You can turn it off\")", () => {
  const raw = (/** @type {string} */ message) => [{ id: 'hello', error: new Error(message) }];
  assert.equal(startCards(raw('boom'), { name, taken: true }).cards[0].body, 'boom. You can turn it off in Settings → Plugins.');
  // One that ends in a stop, a question or an ellipsis is left as it is.
  for (const message of ['boom.', 'Really?', 'wait…']) assert.equal(startCards(raw(message), { name, taken: true }).cards[0].body, `${message} You can turn it off in Settings → Plugins.`);
  // No words at all: no empty sentence.
  assert.equal(startCards(raw(''), { name, taken: true }).cards[0].body, 'You can turn it off in Settings → Plugins.');
});

test('the switched-off card leaves its last error out when there are no words for it, and ends one that ends in an ellipsis as it is', () => {
  const body = (/** @type {string} */ message) => disabledCard({ name: 'Tides', why: { kind: 'failed', count: 2 }, message }).body;
  assert.equal(body(''), 'It failed 2 times in a row. You can turn it back on in Settings → Plugins.');
  assert.equal(body(' \n'), 'It failed 2 times in a row. You can turn it back on in Settings → Plugins.');
  assert.equal(body('wait…'), 'It failed 2 times in a row. The last error: wait… You can turn it back on in Settings → Plugins.');
});

test("the \"installed, but it didn't start\" card ends the start error as a sentence: a plugin's own words (an import that failed) and annai's frame of a start that threw", async () => {
  const { installPending } = await import('../../src/ui/screens/plugin-install.js');
  const { setPendingPackage } = await import('../../src/ui/plugin-pending.js');
  /** @param {unknown} error */
  const bodyOf = async (error) => {
    /** @type {any[]} */
    const cards = [];
    setPendingPackage(/** @type {any} */ ({ files: new Map(), pkg: { id: 'hello', name: 'Hello checks' }, from: { source: 'official' } }));
    const ctx = { plugins: { install: async () => {}, installed: async () => ({ hello: { enabled: true } }), needsRestart: () => false, start: async () => { throw error; } }, notices: { card: (/** @type {any} */ c) => cards.push(c), toast() {} }, go() {} };
    await installPending(ctx, [], {});
    return cards[0].body;
  };
  const turnOff = 'You can turn it off or remove it in Settings → Plugins.';
  assert.equal(await bodyOf(new Error('Failed to fetch dynamically imported module')), `Failed to fetch dynamically imported module. ${turnOff}`);
  assert.equal(await bodyOf(new Error('boom.')), `boom. ${turnOff}`);
  assert.equal(await bodyOf(new Error('')), turnOff);
  assert.equal(await bodyOf(await new Registry().guard('hello', 'starting', () => { throw new Error('boom'); })().catch((e) => e)), `Starting failed: boom. ${turnOff}`);
});
