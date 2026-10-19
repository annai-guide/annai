import { h, twoStep } from '../dom.js';
import { settingsForm, formFields } from '../settings-form.js';
import { sourceLine, FULL_ACCESS } from './plugin-install.js';
import { pluginActions, stateOf, updateFor, removalWords } from './plugins.js';
import { slotEntries } from '../slots.js';
import { explainStorageFull } from '../storage-full.js';

/** An http(s) address or null. @param {unknown} url */
function webAddress(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** What a Reset cleared, by plugin, said once on the page it draws again. @type {Map<string, string>} */
const notes = new Map();

/**
 * What a Reset cleared, in plain words, by the form's labels where it has them.
 * @param {{ file: boolean, keys: string[], secrets: string[] }} c @param {any} schema
 */
export function resetNote(c, schema) {
  const fields = formFields(schema);
  const named = (/** @type {string[]} */ keys) => keys.map((k) => fields.find((f) => f.key === k)?.label ?? k).join(', ');
  const parts = [c.file ? `its settings${c.keys.length ? ` (${named(c.keys)})` : ''}` : '', c.secrets.length ? `its secrets (${named(c.secrets)})` : ''].filter(Boolean);
  return parts.length ? `Cleared ${parts.join(' and ')}.` : 'Nothing was saved, so nothing changed.';
}

/** Reset, confirmed: what it cleared goes to the page's note, and a failure to a card, as Remove's does. @param {any} ctx @param {any} r */
export async function resetSettings(ctx, r) {
  try {
    notes.set(r.id, resetNote(await ctx.plugins.reset(r.id), r.settings));
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${r.name}'s settings weren't reset`, body: `${String(/** @type {any} */ (e)?.message ?? e)} Try again.` });
  }
  ctx.render();
}

/** Reset settings, with one confirmation as Remove has (the user's ask, 2026-10-18). @param {any} ctx @param {any} r */
function resetPart(ctx, r) {
  return h('div', {},
    h('p', { class: 'sub', text: 'Reset forgets the settings and keys this plugin keeps, with their history. The plugin stays, and so do its tool switches and what it wrote into trips.' }),
    h('div', { class: 'acts' }, twoStep('Reset settings', 'Tap again to reset', () => resetSettings(ctx, r))));
}

/**
 * A plugin's own page (milestone 8b, choice 11): what it is and where it came from, what it is doing,
 * its skills and tools, its settings form (spec §5.2) and settings pages, and what can be done with it.
 * @param {any} ctx @param {string} id
 */
export async function renderPlugin(ctx, id) {
  const back = h('p', { class: 'crumbs' }, h('a', { href: '#/plugins' }, '← Plugins'));
  const rows = await ctx.plugins.describe();
  const r = rows.find((/** @type {any} */ x) => x.id === id);
  if (!r) return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: 'Not here' }), h('p', { text: `There's no plugin called ${id} on this device.` }), h('p', {}, h('a', { href: '#/plugins' }, 'Back to Plugins')));
  const home = webAddress(r.homepage);
  const tools = ctx.registry.entries('tool', { all: true }).filter((/** @type {any} */ e) => e.pluginId === id).map((/** @type {any} */ e) => String(e.item?.name));
  const pages = slotEntries(ctx, 'ui:settings-page').filter((e) => e.pluginId === id);
  // Reset shows with a form, or with anything saved; never for the MCP client, whose secrets are its servers' (saved() is null).
  const saved = await ctx.plugins.saved(id);
  const reset = saved && (r.settings || saved.file || saved.secrets.length) ? resetPart(ctx, r) : null;
  const note = notes.get(id);
  notes.delete(id);
  const what = r.builtin ? 'Built into annai' : r.kind === 'skill' ? 'A skill' : r.provider ? `A model provider · ${r.code ? 'has code' : 'data only'}` : r.code ? 'A plugin' : 'A package without code';
  const line = [what, r.shownVersion ? `version ${r.shownVersion}` : null, r.author ? `by ${r.author}` : null].filter(Boolean).join(' · ');
  const told = (await removalWords(ctx, rows)).get(id);
  return h('div', { class: 'screen plugin-page' }, back,
    h('h1', { class: 'title', text: r.name }),
    h('p', { class: 'sub', text: line }),
    home ? h('p', {}, h('a', { href: home, target: '_blank', rel: 'noopener noreferrer', text: home })) : null,
    r.description ? h('p', { text: r.description }) : null,
    h('p', { class: 'sub', text: `${stateOf(r)}${r.builtin ? '' : ` · ${sourceLine(r)}`}` }),
    !r.builtin && r.code ? h('p', { class: 'risk-note', text: FULL_ACCESS }) : null,
    told?.providers.length ? h('section', { class: 'panel', 'aria-label': 'Providers' }, h('h2', { class: 'section', text: 'Providers' }),
      h('ul', { class: 'file-list' }, ...told.providers.map((p) => h('li', {}, h('a', { href: `#/models/provider?id=${encodeURIComponent(p.id)}`, text: p.name }))))) : null,
    r.requires?.length ? h('p', { class: 'sub', text: `It needs: ${r.requires.map((/** @type {any} */ q) => rows.find((/** @type {any} */ x) => x.id === q.id)?.name ?? q.id).join(', ')}.` }) : null,
    ...(told?.lines ?? []).filter((t) => !t.startsWith('Providers: ')).map((t) => h('p', { class: 'sub', text: t })),
    r.skills?.length ? h('section', { class: 'panel', 'aria-label': 'Skills' }, h('h2', { class: 'section', text: 'Skills' }), h('ul', { class: 'brings' }, ...r.skills.map((/** @type {string} */ s) => h('li', { text: s })))) : null,
    tools.length ? h('section', { class: 'panel', 'aria-label': 'Tools' }, h('h2', { class: 'section', text: 'Tools' }),
      h('p', { class: 'sub' }, 'Each can be switched off in ', h('a', { href: '#/tools' }, 'Settings → Tools'), '.'),
      h('ul', { class: 'brings' }, ...tools.map((t) => h('li', { text: t })))) : null,
    r.settings || reset || note ? h('section', { class: 'panel', 'aria-label': 'Settings' }, h('h2', { class: 'section', text: 'Settings' }),
      r.settings ? await settingsForm(ctx, id, r.settings) : null, reset, note ? h('p', { class: 'sub', role: 'status', text: note }) : null) : null,
    pages.length ? h('section', { class: 'panel', 'aria-label': 'Its pages' }, h('h2', { class: 'section', text: 'Its pages' }),
      h('ul', { class: 'file-list' }, ...pages.map((e) => h('li', {}, h('a', { href: `#/plugin-page/${encodeURIComponent(id)}/${encodeURIComponent(e.item.id)}`, text: String(e.item.title) }))))) : null,
    r.builtin ? null : pluginActions(ctx, r, await updateFor(ctx, id)));
}
