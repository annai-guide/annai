import { h } from '../dom.js';
import { mount, slotEntries } from '../slots.js';

/**
 * Pages plugins add (spec §16.4): whole screens (#/ext/<plugin>/<screen>), settings pages
 * (#/plugin-page/<plugin>/<page>) and trip tabs (#/trip/<trip>/ext/<plugin>/<tab>). The plugin draws
 * the body; annai draws the way back and the title, as text.
 */

/** @param {string} href @param {string} label */
const crumbs = (href, label) => h('p', { class: 'crumbs' }, h('a', { href }, label));

/** @param {string} href @param {string} label */
function missing(href, label) {
  return h('div', { class: 'screen' }, crumbs(href, label),
    h('h1', { class: 'title', text: "This page isn't here" }),
    h('p', {}, "This page belongs to a plugin that isn't on. Turn it on in ", h('a', { href: '#/plugins' }, 'Settings → Plugins'), '.'));
}

/**
 * A page a plugin draws.
 * @param {any} ctx @param {string} kind @param {string} pluginId @param {string} id @param {string} back @param {string} backLabel @param {any[]} [more]
 */
function page(ctx, kind, pluginId, id, back, backLabel, more = []) {
  const e = slotEntries(ctx, kind).find((x) => x.pluginId === pluginId && x.item?.id === id);
  if (!e) return missing(back, backLabel);
  const body = h('div', { class: 'ext-body' });
  mount(ctx, e, body, (ui) => e.item.render(body, ui, ...more), { what: `${kind.slice(3)} ${id}` });
  return h('div', { class: 'screen ext' }, crumbs(back, backLabel), h('h1', { class: 'title', text: String(e.item.title) }), body);
}

/** A whole screen a plugin adds (choice 5). @param {any} ctx @param {{ parts: string[] }} route */
export async function renderExt(ctx, route) {
  return page(ctx, 'ui:screen', route.parts[1], route.parts[2], '#/now', '← Now');
}

/** A settings page a plugin adds. @param {any} ctx @param {{ parts: string[] }} route */
export async function renderPluginPage(ctx, route) {
  return page(ctx, 'ui:settings-page', route.parts[1], route.parts[2], '#/settings', '← Settings');
}

/** A trip tab a plugin adds; its drawing gets the trip's id as a third argument. @param {any} ctx @param {{ parts: string[] }} route */
export async function renderTripTab(ctx, route) {
  const trip = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(trip)).catch(() => null);
  const label = scope ? `← ${scope.title}` : '← Trips';
  return page(ctx, 'ui:trip-tab', route.parts[3], route.parts[4], scope ? `#/trip/${encodeURIComponent(trip)}` : '#/trips', label, [{ trip }]);
}
