import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlot, checkCardType, checkComponent, checkScreen, checkTheme, cardSchema, SLOTS, COMPONENTS } from '../../src/core/ui-slots.js';
import { Registry } from '../../src/core/registry.js';
import { files, hostKit, codePlugin } from './package-kit.js';
import { CRASH_CODE, ANSWER_CODE, thrownBy, throwing } from './engine-throws.js';

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
  assert.deepEqual(['ui:status-chip', 'ui:card-type', 'ui:component', 'ui:screen', 'ui:theme'].map((k) => registry.entries(k, { all: true }).map((e) => e.pluginId)), [['tides'], ['tides'], ['tides'], ['tides'], ['tides']]);
  assert.deepEqual(registry.entries('ui:component'), [], "a component is used only once chosen: annai's own until then");
  assert.equal(registry.list('ui:theme')[0].href, '/plugins/tides/theme.css');
  await host.setEnabled('tides', false);
  assert.equal(registry.list('ui:status-chip').length, 0);
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'wrong', name: 'Wrong', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': "export function activate(annai) { annai.ui.slot('dock-action', { id: 'x', label: 'X', icon: '≈' }); }",
  }));
  await assert.rejects(host.start('wrong'), /the dock action x needs run/);
});

test("a component plugin is used only when chosen; annai's own avatar otherwise", async () => {
  const { component, dockKey } = await import('../../src/ui/slots.js');
  const { host, registry, relaunch } = await hostKit();
  await host.install(codePlugin('look', "return annai.ui.component('avatar', { create: () => ({ el: {} }) });"));
  await host.start('look');
  const ctx = { registry };
  const annais = dockKey(ctx);
  assert.equal(component(ctx, 'avatar'), null);
  assert.deepEqual(registry.clashes('look'), [{ kind: 'ui:component', name: 'avatar', owner: 'annai', used: false, reserved: false, chosen: false }]);
  await host.choose('ui:component', 'avatar', 'look');
  assert.equal(component(ctx, 'avatar')?.pluginId, 'look');
  assert.notEqual(dockKey(ctx), annais, 'the dock is made again with it');
  assert.deepEqual(registry.clashes('look'), [{ kind: 'ui:component', name: 'avatar', owner: 'look', used: true, reserved: false, chosen: true }]);
  // Stored: annai started again uses it at once.
  const next = relaunch();
  await next.startInstalled();
  assert.equal(component({ registry: next.registry }, 'avatar')?.pluginId, 'look');
  // Undone: annai's own again.
  await host.choose('ui:component', 'avatar', null);
  assert.equal(component(ctx, 'avatar'), null);
  assert.equal(dockKey(ctx), annais);
});

test('8b-4: a drawing, a dock action or a component that works ends its plugin\'s run of failures', async () => {
  const { mount, runAction, made } = await import('../../src/ui/slots.js');
  const registry = new Registry({ maxFailures: 3 });
  const ctx = { registry };
  const el = () => /** @type {any} */ ({ hidden: false, replaceChildren() {} });
  const entry = (/** @type {any} */ item) => ({ pluginId: 'flaky', item });
  const broke = () => { throw new TypeError('broke'); };
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

/** A plugin's drawing, dock action and component, each run once with what its code throws (or rejects with), and what annai left of each. */
const PLACES = {
  drawing: async (/** @type {any} */ ctx, /** @type {() => any} */ fails) => {
    const { mount } = await import('../../src/ui/slots.js');
    const el = /** @type {any} */ ({ hidden: false, replaceChildren() {} });
    let failed = 0;
    mount(ctx, { pluginId: 'tides', item: {} }, el, async () => fails(), { onFail: () => failed++ });
    await new Promise((r) => setTimeout(r, 0));
    return el.hidden && failed === 1;
  },
  'dock action': async (/** @type {any} */ ctx, /** @type {() => any} */ fails) => {
    const { runAction } = await import('../../src/ui/slots.js');
    runAction(ctx, { pluginId: 'tides', item: { id: 'go', run: async () => fails() } });
    await new Promise((r) => setTimeout(r, 0));
    return true; // the drawing's column is whether its element was hidden; a dock action has no element, so nothing is checked in this column: the registry's state and log are
  },
  component: async (/** @type {any} */ ctx, /** @type {() => any} */ fails) => {
    const { made } = await import('../../src/ui/slots.js');
    return made(ctx, { pluginId: 'tides', item: {} }, 'avatar', fails, () => null) === null;
  },
};

test("a drawing, a dock action or a component that throws an answer leaves its plugin on: annai.net.fetch's error and the browser's own fetch failure (Chrome's words and Safari's) for want of a link, an AllFailedError, a DOMException that is no crash (a stop, a time limit, a full phone), or its own words; three in a row of each, the drawing hidden and its onFail run each time, each logged with no count (plugin-link-next, test 3)", async () => {
  const { tracedFetch } = await import('../../src/core/agent/net.js');
  const { AllFailedError } = await import('../../src/core/llm/fallback.js');
  const { createMemoryStore } = await import('../fakes/store-memory.js');
  const { SYS } = await import('../../src/core/scopes.js');
  // annai.net.fetch's own error with no link, from the real tracedFetch.
  const net = await tracedFetch(createMemoryStore(), SYS, { tool: 'plugin:tides' }, async () => { throw new TypeError('Load failed'); })('https://tides.example/now').catch((e) => e);
  assert.equal(net.kind, 'network');
  /** @type {Record<string, unknown>} */
  const answers = {
    'annai.net.fetch': net,
    'browser fetch, Chrome': new TypeError('Failed to fetch'),
    'browser fetch, Safari': new TypeError('Load failed'),
    'no model': new AllFailedError([]),
    words: new Error('Choose a tide station first.'),
    ...Object.fromEntries(Object.entries(ANSWER_CODE).map(([name, code]) => [`DOMException ${name}`, thrownBy(code)])),
  };
  /** @type {Record<string, any>} */
  const seen = {};
  for (const [place, run] of Object.entries(PLACES)) {
    for (const [what, e] of Object.entries(answers)) {
      /** @type {any[]} */
      const logged = [];
      const registry = new Registry({ log: (ev) => logged.push(ev) });
      const shown = [];
      for (let i = 0; i < 3; i++) shown.push(await run({ registry }, () => { throw e; }));
      seen[`${place}, ${what}`] = [shown, registry.isDisabled('tides'), logged.map((x) => [x.type, 'count' in x.data])];
    }
  }
  const want = Object.fromEntries(Object.keys(seen).map((k) => [k, [[true, true, true], false, Array(3).fill(['plugin.error', false])]]));
  assert.deepEqual(seen, want, "the drawing hidden with onFail each time (a dock action has no element to hide: true by construction), still on, three lines with no count");
});

test("the dock's plugin avatar: a setState that crashes counts against its plugin, one that throws a link's or its own words is logged and counts nothing (plugin-link-fix1; unit: the dock's own DOM is the e2e's)", async () => {
  const { dockAvatar } = await import('../../src/ui/dock.js');
  const had = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', { value: class {}, configurable: true, writable: true }); // the dock checks the avatar's el with instanceof Node
  try {
    /** @type {Record<string, [unknown, boolean, boolean]>} what setState throws: whether its plugin is off after two of them, and whether each is logged with a count */
    const throws = {
      crash: [new TypeError("Cannot read properties of undefined (reading 'go')"), true, true],
      'browser fetch': [new TypeError('Load failed'), false, false],
      'its own words': [new Error('Choose a tide station first.'), false, false],
    };
    for (const [what, [e, off, counted]] of Object.entries(throws)) {
      /** @type {any[]} */
      const logged = [];
      const registry = new Registry({ maxFailures: 2, log: (ev) => logged.push(ev) }); // two throws: annai's own avatar (it needs a DOM) is only made at three
      registry.add('look', 'ui:component', { name: 'avatar', create: () => ({ el: new (/** @type {any} */ (globalThis).Node)(), setState: () => { throw e; }, setLevel: () => {} }) });
      const avatar = dockAvatar({ registry });
      avatar.setState('thinking');
      avatar.setState('thinking');
      assert.equal(registry.isDisabled('look'), off, what);
      assert.deepEqual(logged.filter((x) => x.type === 'plugin.error').map((x) => 'count' in x.data), [counted, counted], `${what}: logged each time`);
    }
  } finally {
    if (had) Object.defineProperty(globalThis, 'Node', had);
    else delete (/** @type {any} */ (globalThis)).Node;
  }
});

test("the dock's plugin avatar: a call that works ends its plugin's run of failures, whichever call it is: a setState that crashes, a setLevel that works, a setState that crashes is still on (fix round 2)", async () => {
  const { dockAvatar } = await import('../../src/ui/dock.js');
  const had = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', { value: class {}, configurable: true, writable: true }); // the dock checks the avatar's el with instanceof Node
  try {
    // maxFailures 2, so the dock's own limit (any three throws, then annai's own avatar, which needs a DOM) is never reached.
    for (const [what, between, off] of /** @type {[string, ((a: any) => void) | null, boolean][]} */ ([
      ['a setLevel that works between them', (a) => a.setLevel(0.5), false],
      ['a glance the avatar has none of, between them (nothing was called, so nothing worked)', (a) => a.glance(), true],
      ['nothing between them', null, true],
    ])) {
      const registry = new Registry({ maxFailures: 2 });
      registry.add('look', 'ui:component', { name: 'avatar', create: () => ({ el: new (/** @type {any} */ (globalThis).Node)(), setState: () => { throw new TypeError("Cannot read properties of undefined (reading 'go')"); }, setLevel: () => {} }) });
      const avatar = dockAvatar({ registry });
      avatar.setState('thinking');
      between?.(avatar);
      avatar.setState('thinking');
      assert.equal(registry.isDisabled('look'), off, what);
    }
  } finally {
    if (had) Object.defineProperty(globalThis, 'Node', had);
    else delete (/** @type {any} */ (globalThis)).Node;
  }
});

test("a drawing, a dock action or a component that crashes still counts: off at the third, whatever set the crash off (a TypeError, a thrown value that isn't an Error, a TypeError after a link failure it swallowed, a URIError, a DOMException named for a program's mistake); so does a create() that returns the wrong thing (plugin-link-next, test 5: as before; the engine's classes plugin-link-fix1)", async () => {
  const { made } = await import('../../src/ui/slots.js');
  /** @type {Record<string, () => any>} */
  const crashes = {
    TypeError: () => { throw new TypeError("Cannot read properties of undefined (reading 'go')"); },
    'not an Error': () => { throw 'no'; },
    // Sync, as annai calls a component's create(); the drawing and the dock action run it inside an async function.
    'after a swallowed link failure': () => {
      /** @type {any} */
      const reply = null;
      try {
        throw new TypeError('Failed to fetch');
      } catch {
        // the plugin let it go
      }
      return reply.json();
    },
    ...throwing(CRASH_CODE),
  };
  /** @type {Record<string, boolean[]>} */
  const seen = {};
  for (const [place, run] of Object.entries(PLACES)) {
    for (const [what, crash] of Object.entries(crashes)) {
      const registry = new Registry();
      const off = [];
      for (let i = 0; i < 3; i++) {
        await run({ registry }, crash);
        off.push(registry.isDisabled('tides'));
      }
      seen[`${place}, ${what}`] = off;
    }
  }
  assert.deepEqual(seen, Object.fromEntries(Object.keys(seen).map((k) => [k, [false, false, true]])));
  const registry = new Registry();
  for (let i = 0; i < 3; i++) assert.equal(made({ registry }, { pluginId: 'tides', item: {} }, 'dock', () => ({}), () => 'its dock create() must return { el }'), null);
  assert.equal(registry.isDisabled('tides'), true, 'a create() that made nothing usable, three times: off');
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
