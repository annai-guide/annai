import { Registry } from '../../../src/core/registry.js';
import { renderExt } from '../../../src/ui/screens/ext.js';
import { mount, cleanUp, syncThemes, dockKey } from '../../../src/ui/slots.js';
import { renderCard } from '../../../src/ui/cards.js';

/** A tick, for drawings whose promise settles. */
const tick = () => new Promise((done) => setTimeout(done, 0));

/**
 * What annai draws of plugins' UI (spec §16.4), in a real DOM: the minors batch's fixes and the
 * test gaps milestone 8b's review found.
 * @param {any} test @param {any} assert
 */
export default function (test, assert) {
  /** A registry, its plugin.error entries, and a ctx with the plugin host's running plugins. @param {string[]} [on] */
  const kit = (on = ['tides']) => {
    /** @type {any[]} */
    const errors = [];
    const registry = new Registry({ log: (ev) => { if (ev.type === 'plugin.error') errors.push(ev); } });
    const ctx = { registry, plugins: { active: new Map(on.map((id) => [id, { manifest: { id, name: 'Tides' } }])) } };
    return { registry, errors, ctx };
  };

  test("minors 11: a plugin's page whose drawing fails says so, whether it throws or its promise fails, and the error counts against it", async () => {
    const { registry, errors, ctx } = kit();
    registry.add('tides', 'ui:screen', { id: 'now', title: 'Tides now', render: () => { throw new TypeError('broke'); } });
    registry.add('tides', 'ui:screen', { id: 'later', title: 'Tides later', render: async () => { throw new TypeError('broke later'); } });
    const now = await renderExt(ctx, { parts: ['ext', 'tides', 'now'] });
    assert.ok(now.textContent?.includes("This page couldn't be drawn; the plugin's error is in Trace."), String(now.textContent));
    assert.equal(now.querySelector('h1')?.textContent, 'Tides now');
    const later = await renderExt(ctx, { parts: ['ext', 'tides', 'later'] });
    await tick();
    assert.ok(later.textContent?.includes("This page couldn't be drawn; the plugin's error is in Trace."), String(later.textContent));
    assert.equal(errors.length, 2);
  });

  test("minors 11: a page that isn't there says whether its plugin is off or has no page by that name", async () => {
    const { ctx } = kit();
    const unknown = await renderExt(ctx, { parts: ['ext', 'tides', 'station'] });
    assert.ok(unknown.textContent?.includes('Tides is on, but it has no page called station.'), String(unknown.textContent));
    assert.ok(!unknown.textContent?.includes("isn't on"));
    const off = await renderExt(kit([]).ctx, { parts: ['ext', 'tides', 'station'] });
    assert.ok(off.textContent?.includes("This page belongs to a plugin that isn't on."), String(off.textContent));
  });

  test("8b gaps: mount's failure path: what throws, or whose promise fails, leaves its element empty and hidden, counts once, and runs onFail", async () => {
    const { registry, errors, ctx } = kit();
    const entry = { pluginId: 'tides', item: {} };
    let failed = 0;
    const el = document.createElement('div');
    el.append('annai drew this first');
    assert.equal(mount(ctx, entry, el, (ui) => { ui.h('p', {}, 'half'); throw new TypeError('broke'); }, { what: 'Now section tide', onFail: () => failed++ }), false);
    assert.deepEqual([el.childNodes.length, el.hidden, failed, errors.length, errors[0]?.data.name], [0, true, 1, 1, 'Now section tide']);
    const later = document.createElement('div');
    assert.equal(mount(ctx, entry, later, async () => { throw new TypeError('broke later'); }, { onFail: () => failed++ }), true, 'it failed later, not at once');
    await tick();
    assert.deepEqual([later.hidden, failed, errors.length], [true, 2, 2]);
    // A drawing that works: its cleanup runs when the screen is drawn again, once.
    let cleaned = 0;
    assert.equal(mount(ctx, entry, document.createElement('div'), () => () => { cleaned++; }), true);
    cleanUp('screen');
    cleanUp('screen');
    assert.equal(cleaned, 1);
    assert.equal(registry.isDisabled('tides'), false, 'the drawing that worked ended the run of failures');
  });

  test("8b gaps: syncThemes keeps one stylesheet link per plugin theme, adds new ones and removes those that went", async () => {
    const registry = new Registry();
    const head = document.createElement('div');
    const offA = registry.add('tides', 'ui:theme', { file: 'a.css', href: '/plugins/tides/a.css' });
    registry.add('trail', 'ui:theme', { file: 'b.css', href: '/plugins/trail/b.css' });
    syncThemes(registry, head);
    const links = () => [...head.querySelectorAll('link[data-plugin-theme]')].map((l) => /** @type {HTMLLinkElement} */ (l).getAttribute('href'));
    assert.deepEqual(links(), ['/plugins/tides/a.css', '/plugins/trail/b.css']);
    const kept = head.querySelector('link[href="/plugins/trail/b.css"]');
    offA();
    syncThemes(registry, head);
    assert.deepEqual(links(), ['/plugins/trail/b.css']);
    assert.equal(head.querySelector('link[href="/plugins/trail/b.css"]'), kept, 'a theme still there is left as it is');
    assert.equal(/** @type {HTMLLinkElement} */ (kept).rel, 'stylesheet');
  });

  test('8b gaps: dockKey changes only when the dock or the avatar a plugin replaces changes', () => {
    const registry = new Registry({ maxFailures: 1 });
    const ctx = { registry };
    const none = dockKey(ctx);
    registry.add('look', 'ui:component', { name: 'now-card', render: () => {} });
    assert.equal(dockKey(ctx), none);
    const off = registry.add('look', 'ui:component', { name: 'avatar', create: () => {} });
    const avatar = dockKey(ctx);
    assert.ok(avatar !== none);
    registry.add('look', 'ui:component', { name: 'dock', create: () => {} });
    assert.ok(dockKey(ctx) !== avatar);
    registry.fail('look', 'avatar', new Error('broke'));
    assert.equal(dockKey(ctx), none, "a plugin switched off gives annai's own back");
    registry.enable('look');
    off();
    assert.ok(dockKey(ctx) !== none && dockKey(ctx) !== avatar);
  });

  test("8b gaps: renderCard's typed branch: the plugin draws the data, annai the title as text; a failure leaves annai's frame and counts", async () => {
    const { registry, errors, ctx } = kit();
    /** @type {any[]} */
    const got = [];
    registry.add('tides', 'ui:card-type', { type: 'tides', name: 'Tides', description: 'x', render: (/** @type {any} */ data, /** @type {HTMLElement} */ el, /** @type {any} */ ui) => { got.push(data); el.append(ui.h('p', { class: 'tide' }, `Low at ${data.low ?? '?'}`)); } });
    registry.add('broken', 'ui:card-type', { type: 'broken', name: 'Broken', description: 'x', render: () => { throw new TypeError('card broke'); } });
    const card = renderCard({ type: 'tides', title: '<b>Tides</b>', data: { low: '5:40' } }, { ctx });
    assert.ok(card.classList.contains('card-typed'));
    assert.equal(card.querySelector('.card-title')?.textContent, '<b>Tides</b>');
    assert.equal(card.querySelector('b'), null);
    assert.equal(card.querySelector('.tide')?.textContent, 'Low at 5:40');
    renderCard({ type: 'tides', data: 'not an object' }, { ctx });
    assert.deepEqual(got, [{ low: '5:40' }, {}]);
    const broken = renderCard({ type: 'broken', title: 'Still here' }, { ctx });
    assert.equal(broken.querySelector('.card-title')?.textContent, 'Still here');
    assert.equal(/** @type {HTMLElement} */ (broken.querySelector('.card-body')).hidden, true);
    assert.equal(errors.at(-1)?.data.name, 'card type broken');
    const off = renderCard({ type: 'ferries', title: 'Ferries' }, { ctx });
    assert.ok(off.textContent?.includes("This card's kind (ferries) comes from a plugin that isn't on."));
  });
}
