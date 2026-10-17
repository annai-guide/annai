import { h } from '../dom.js';
import { settingsForm } from '../settings-form.js';
import { sourceLine, FULL_ACCESS } from './plugin-install.js';
import { pluginActions, stateOf, updateFor } from './plugins.js';
import { slotEntries } from '../slots.js';

/** An http(s) address or null. @param {unknown} url */
function webAddress(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * A plugin's own page (milestone 8b, choice 11): what it is and where it came from, what it is doing,
 * its skills and tools, its settings form (spec §5.2) and settings pages, and what can be done with it.
 * @param {any} ctx @param {string} id
 */
export async function renderPlugin(ctx, id) {
  const back = h('p', { class: 'crumbs' }, h('a', { href: '#/plugins' }, '← Plugins'));
  const r = (await ctx.plugins.describe()).find((/** @type {any} */ x) => x.id === id);
  if (!r) return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: 'Not here' }), h('p', { text: `There's no plugin called ${id} on this device.` }), h('p', {}, h('a', { href: '#/plugins' }, 'Back to Plugins')));
  const home = webAddress(r.homepage);
  const tools = ctx.registry.entries('tool', { all: true }).filter((/** @type {any} */ e) => e.pluginId === id).map((/** @type {any} */ e) => String(e.item?.name));
  const pages = slotEntries(ctx, 'ui:settings-page').filter((e) => e.pluginId === id);
  const line = [r.builtin ? 'Built into annai' : r.kind === 'skill' ? 'A skill' : r.code ? 'A plugin' : 'A package without code', r.shownVersion ? `version ${r.shownVersion}` : null, r.author ? `by ${r.author}` : null].filter(Boolean).join(' · ');
  return h('div', { class: 'screen plugin-page' }, back,
    h('h1', { class: 'title', text: r.name }),
    h('p', { class: 'sub', text: line }),
    home ? h('p', {}, h('a', { href: home, target: '_blank', rel: 'noopener noreferrer', text: home })) : null,
    r.description ? h('p', { text: r.description }) : null,
    h('p', { class: 'sub', text: `${stateOf(r)}${r.builtin ? '' : ` · ${sourceLine(r)}`}` }),
    !r.builtin && r.code ? h('p', { class: 'risk-note', text: FULL_ACCESS }) : null,
    r.skills?.length ? h('section', { class: 'panel', 'aria-label': 'Skills' }, h('h2', { class: 'section', text: 'Skills' }), h('ul', { class: 'brings' }, ...r.skills.map((/** @type {string} */ s) => h('li', { text: s })))) : null,
    tools.length ? h('section', { class: 'panel', 'aria-label': 'Tools' }, h('h2', { class: 'section', text: 'Tools' }),
      h('p', { class: 'sub' }, 'Each can be switched off in ', h('a', { href: '#/tools' }, 'Settings → Tools'), '.'),
      h('ul', { class: 'brings' }, ...tools.map((t) => h('li', { text: t })))) : null,
    r.settings ? h('section', { class: 'panel', 'aria-label': 'Settings' }, h('h2', { class: 'section', text: 'Settings' }), await settingsForm(ctx, id, r.settings)) : null,
    pages.length ? h('section', { class: 'panel', 'aria-label': 'Its pages' }, h('h2', { class: 'section', text: 'Its pages' }),
      h('ul', { class: 'file-list' }, ...pages.map((e) => h('li', {}, h('a', { href: `#/plugin-page/${encodeURIComponent(id)}/${encodeURIComponent(e.item.id)}`, text: String(e.item.title) }))))) : null,
    r.builtin ? null : pluginActions(ctx, r, await updateFor(ctx, id)));
}
