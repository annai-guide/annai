import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlot, checkCardType, checkComponent, checkScreen, checkTheme, cardSchema, SLOTS, COMPONENTS } from '../../src/core/ui-slots.js';
import { Registry } from '../../src/core/registry.js';
import { files, hostKit } from './package-kit.js';

const draw = () => {};

test('what each slot needs, and the reason when something is missing (spec §16.4)', () => {
  assert.deepEqual(SLOTS, ['status-chip', 'now-section', 'dock-action', 'trip-tab', 'settings-page']);
  assert.equal(checkSlot('status-chip', { id: 'tide', render: draw }), null);
  assert.equal(checkSlot('now-section', { id: 'tide', title: 'Tide', render: draw }), null);
  assert.equal(checkSlot('dock-action', { id: 'tide', label: 'Tides now', icon: '≈', run: draw }), null);
  assert.equal(checkSlot('trip-tab', { id: 'tides', title: 'Tides', render: draw }), null);
  assert.equal(checkSlot('settings-page', { id: 'station', title: 'Tide station', render: draw }), null);
  assert.match(String(checkSlot('status-chip', { id: 'Tide!', render: draw })), /id of lowercase letters, digits and dashes/);
  assert.match(String(checkSlot('dock-action', { id: 'tide', label: '', icon: '≈', run: draw })), /label of 1 to 40 characters/);
  assert.match(String(checkSlot('dock-action', { id: 'tide', label: 'Tides', icon: 'abc', run: draw })), /icon of 1 or 2 characters/);
  assert.match(String(checkSlot('now-section', { id: 'tide', render: draw })), /title of 1 to 40 characters/);
  assert.match(String(checkSlot('trip-tab', { id: 'tides', title: 'Tides' })), /render/);
  assert.match(String(checkSlot('banner', { id: 'x', render: draw })), /isn't a slot.*status-chip/);
});

test('card types, components, screens and themes: what each needs', () => {
  assert.equal(checkCardType({ type: 'tides', name: 'Tides', description: 'Low and high tides.', render: draw }), null);
  assert.match(String(checkCardType({ type: 'tides', name: 'Tides', description: 'x', render: draw, schema: 'no' })), /schema/);
  assert.deepEqual(COMPONENTS, ['avatar', 'now-card', 'dock', 'plan-row']);
  assert.equal(checkComponent('avatar', { create: draw }), null);
  assert.equal(checkComponent('plan-row', { render: draw }), null);
  assert.match(String(checkComponent('avatar', { render: draw })), /create/);
  assert.match(String(checkComponent('header', { render: draw })), /isn't a component annai lets plugins replace/);
  assert.equal(checkScreen({ id: 'hike', title: 'Hike', render: draw, tab: true, homeFor: 'walking' }), null);
  assert.match(String(checkScreen({ id: 'hike', title: 'Hike', render: draw, homeFor: 'hiking' })), /homeFor.*walking/);
  assert.equal(checkTheme('theme.css'), null);
  assert.match(String(checkTheme('../theme.css')), /\.css file in the package/);
  assert.match(String(checkTheme('theme.js')), /\.css file in the package/);
});

test("the show tool's card: the built-in parts, and type and data once a plugin adds a type", () => {
  assert.equal(cardSchema([]).properties.type, undefined);
  const s = cardSchema([{ type: 'tides', name: 'Tides', description: 'Low and high tides.' }]);
  assert.deepEqual(s.properties.type.enum, ['tides']);
  assert.match(s.properties.type.description, /tides: Low and high tides\./);
  assert.equal(s.properties.data.type, 'object');
  assert.ok(s.properties.title && s.properties.choice);
});

test("a plugin's UI parts are registered under its id, refused with the reason when wrong, and go when it stops", async () => {
  const { host, registry } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': `export function activate(annai) {
      const offs = [
        annai.ui.slot('status-chip', { id: 'tide', render: (el) => { el.textContent = 'Tide'; } }),
        annai.ui.cardType({ type: 'tides', name: 'Tides', description: 'Low and high tides.', render: () => {} }),
        annai.ui.component('plan-row', { render: () => {} }),
        annai.ui.screen({ id: 'tides', title: 'Tides', render: () => {}, tab: true }),
        annai.ui.theme('theme.css'),
      ];
      return () => offs.forEach((f) => f());
    }`,
    'theme.css': ':root { --ai: #0a7; }',
  }));
  await host.start('tides');
  assert.deepEqual(['ui:status-chip', 'ui:card-type', 'ui:component', 'ui:screen', 'ui:theme'].map((k) => registry.entries(k).map((e) => e.pluginId)), [['tides'], ['tides'], ['tides'], ['tides'], ['tides']]);
  assert.equal(registry.list('ui:theme')[0].href, '/plugins/tides/theme.css');
  await host.setEnabled('tides', false);
  assert.equal(registry.list('ui:status-chip').length, 0);
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'wrong', name: 'Wrong', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': "export function activate(annai) { annai.ui.slot('dock-action', { id: 'x', label: 'X', icon: '≈' }); }",
  }));
  await assert.rejects(host.start('wrong'), /the dock action x needs run/);
});

test('8b-4: a drawing, a dock action or a component that works ends its plugin\'s run of failures', async () => {
  const { mount, runAction, made } = await import('../../src/ui/slots.js');
  const registry = new Registry({ maxFailures: 3 });
  const ctx = { registry };
  const el = () => /** @type {any} */ ({ hidden: false, replaceChildren() {} });
  const entry = (/** @type {any} */ item) => ({ pluginId: 'flaky', item });
  const broke = () => { throw new Error('broke'); };
  const twoFailures = async () => {
    mount(ctx, entry({}), el(), broke);
    runAction(ctx, entry({ id: 'go', run: async () => broke() }));
    await new Promise((r) => setTimeout(r, 0));
  };
  /** Each way of working, between two failures before and two after, keeps the plugin on. @type {[string, () => unknown][]} */
  const works = [
    ['a drawing that returns', () => mount(ctx, entry({}), el(), () => undefined)],
    ['a drawing whose promise resolves', async () => { mount(ctx, entry({}), el(), async () => () => {}); await new Promise((r) => setTimeout(r, 0)); }],
    ['a dock action whose run returns', () => runAction(ctx, entry({ id: 'go', run: () => {} }))],
    ['a dock action whose promise resolves', async () => { runAction(ctx, entry({ id: 'go', run: async () => {} })); await new Promise((r) => setTimeout(r, 0)); }],
    ['an avatar or dock create that made something usable', () => assert.deepEqual(made(ctx, entry({}), 'avatar', () => ({ el: 1 }), (x) => (x.el ? null : 'no el')), { el: 1 })],
  ];
  for (const [how, work] of works) {
    await twoFailures();
    await work();
    await twoFailures();
    assert.equal(registry.isDisabled('flaky'), false, how);
    registry.enable('flaky');
  }
  // A create that made nothing usable is a failure, and annai's own is used instead.
  assert.equal(made(ctx, entry({}), 'dock', () => ({}), () => 'its dock create() must return { el }'), null);
  await twoFailures();
  assert.equal(registry.isDisabled('flaky'), true);
});

test("8b-6: the show tool's type is a string as well as one of the plugins' types", () => {
  const s = cardSchema([{ type: 'tides', name: 'Tides', description: 'Low and high tides.' }]);
  assert.equal(s.properties.type.type, 'string');
});

test("minors 15: a drawing's cleanup is tagged with its render: one that comes after its render was superseded runs at once, and the shown render's wait for the next", async () => {
  const { mount, cleanUp } = await import('../../src/ui/slots.js');
  const registry = new Registry();
  const el = () => /** @type {any} */ ({ hidden: false, replaceChildren() {} });
  const entry = { pluginId: 'tides', item: {} };
  /** @type {string[]} */
  const ran = [];
  cleanUp('screen', 1);
  /** @type {(fn: () => void) => void} */
  let late = () => {};
  mount({ registry, seq: 1 }, entry, el(), () => new Promise((done) => { late = done; }));
  mount({ registry, seq: 1 }, entry, el(), () => () => ran.push('first'));
  cleanUp('screen', 2);
  assert.deepEqual(ran, ['first']);
  // Render 1, superseded, still drawing: what it draws now is gone at once, and so is what comes later.
  mount({ registry, seq: 1 }, entry, el(), () => () => ran.push('first, drawn late'));
  late(() => ran.push('first, its promise late'));
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(ran, ['first', 'first, drawn late', 'first, its promise late']);
  mount({ registry, seq: 2 }, entry, el(), () => () => ran.push('second'));
  assert.equal(ran.includes('second'), false, "the shown render's cleanup waits");
  cleanUp('screen', 3);
  assert.equal(ran.at(-1), 'second');
});
