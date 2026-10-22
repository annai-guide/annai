import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCards, reloadCard } from '../../src/ui/plugin-cards.js';

const NAMES = /** @type {Record<string, string>} */ ({ hello: 'Hello checks', hola: 'Hola checks', old: 'Old tool' });
const name = (/** @type {string} */ id) => NAMES[id] ?? id;
const failed = (/** @type {string} */ id, disabled = false) => ({ id, error: new Error('Failed to fetch dynamically imported module.'), disabled });

test('plugins that did not start get a card each, by name; one turned off after failing to start says so', () => {
  const { cards, unloaded } = startCards([failed('hello'), failed('old', true)], { name, taken: true });
  assert.deepEqual(cards.map((c) => c.title), ['The plugin "Hello checks" didn\'t start', 'The plugin "Old tool" was turned off']);
  assert.match(cards[1].body, /^It didn't start the last few times annai opened: Failed to fetch/);
  assert.deepEqual(unloaded, []);
});

test('on a page no service worker controls, those that failed share the one reload card; one turned off keeps its own', () => {
  const { cards, unloaded } = startCards([failed('hello'), failed('hola'), failed('old', true)], { name, taken: false });
  assert.deepEqual(cards.map((c) => c.title), ['The plugin "Old tool" was turned off']);
  assert.deepEqual(unloaded, ['Hello checks', 'Hola checks']);
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
