import { h, crumb, t, twoStep, linkIn, messageOf } from '../dom.js';
import { list, sentences } from '../format.js';
import { settingsForm, formFields } from '../settings-form.js';
import { sourceLine, FULL_ACCESS, thingWords, ownerName, packageLine } from './plugin-install.js';
import { KEYED } from '../../core/registry.js';
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
  const named = (/** @type {string[]} */ keys) => list(keys.map((k) => fields.find((f) => f.key === k)?.label ?? k), 'plain');
  const [keys, secrets] = [named(c.keys), named(c.secrets)];
  if (c.file && c.secrets.length) return c.keys.length ? t`Cleared its settings (${keys}) and its secrets (${secrets}).` : t`Cleared its settings and its secrets (${secrets}).`;
  if (c.file) return c.keys.length ? t`Cleared its settings (${keys}).` : t`Cleared its settings.`;
  return c.secrets.length ? t`Cleared its secrets (${secrets}).` : t`Nothing was saved, so nothing changed.`;
}

/** Reset, confirmed: what it cleared goes to the page's note, and a failure to a card, as Remove's does. @param {any} ctx @param {any} r */
export async function resetSettings(ctx, r) {
  try {
    notes.set(r.id, resetNote(await ctx.plugins.reset(r.id), r.settings));
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: t`${r.name}'s settings weren't reset`, body: sentences(messageOf(e), t`Try again.`) });
  }
  ctx.render();
}

/** Reset settings, with one confirmation as Remove has (the user's ask, 2026-10-18). @param {any} ctx @param {any} r */
function resetPart(ctx, r) {
  return h('div', {},
    h('p', { class: 'sub', text: t`Reset forgets the settings and keys this plugin keeps, with their history. The plugin stays, and so do its tool switches and what it wrote into trips.` }),
    h('div', { class: 'acts' }, twoStep(t`Reset settings`, t`Tap again to reset`, () => resetSettings(ctx, r))));
}

/** A plugin's Names: Not used, with the switch; used by the user's choice, with Undo (on both pages). @param {any} ctx @param {string} id @param {any[]} rows */
function namesPart(ctx, id, rows) {
  const clashes = ctx.registry.clashes(id);
  if (!clashes.length) return null;
  const act = (/** @type {string} */ label, /** @type {any} */ c, /** @type {string | null} */ to) => h('button', { class: 'btn', type: 'button', onclick: async () => {
    await ctx.plugins.choose(c.kind, c.name, to).catch((/** @type {any} */ e) => ctx.notices.toast(messageOf(e)));
    ctx.render();
  } }, label);
  return h('section', { class: 'panel', 'aria-label': t`Names` }, h('h2', { class: 'section', text: t`Names` }),
    h('ul', { class: 'brings' }, ...clashes.map((/** @type {import('../../core/registry.js').Clash} */ c) => {
      const thing = thingWords(c.kind, c.name);
      const by = ownerName(rows, c.owner);
      const why = !c.reserved ? '' : KEYED.has(c.kind) ? t`It is handed the keys you give it, so it isn't switched: remove ${by} to use this one.` : t`annai keeps it for Shiori's own use.`;
      const text = c.chosen ? (c.used ? t`${thingWords(c.kind, c.name, true)}: this one is used (your choice).` : t`${thingWords(c.kind, c.name, true)}: the one from ${by} is used (your choice).`)
        : sentences(t`Not used: ${thing} is already provided by ${by}.`, why);
      const button = c.chosen ? act(t`Undo`, c, null) : c.reserved ? null : act(t`Use this one instead`, c, id);
      return h('li', {}, h('span', { text }), button ? ' ' : null, button);
    })));
}

/**
 * A plugin's own page (milestone 8b, choice 11): what it is and where it came from, what it is doing,
 * its skills and tools, its settings form (spec §5.2) and settings pages, and what can be done with it.
 * @param {any} ctx @param {string} id
 */
export async function renderPlugin(ctx, id) {
  const back = h('p', { class: 'crumbs' }, crumb('#/plugins', t`Plugins`));
  const rows = await ctx.plugins.describe();
  const r = rows.find((/** @type {any} */ x) => x.id === id);
  if (!r) return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: t`Not here` }), h('p', { text: t`There's no plugin called ${id} on this device.` }), h('p', {}, h('a', { href: '#/plugins' }, t`Back to Plugins`)));
  const home = webAddress(r.homepage);
  const tools = ctx.registry.entries('tool', { all: true }).filter((/** @type {any} */ e) => e.pluginId === id).map((/** @type {any} */ e) => String(e.item?.name));
  const pages = slotEntries(ctx, 'ui:settings-page').filter((e) => e.pluginId === id);
  // Reset shows with a form, or with anything saved; never for the MCP client, whose secrets are its servers' (saved() is null).
  const saved = await ctx.plugins.saved(id);
  const reset = saved && (r.settings || saved.file || saved.secrets.length) ? resetPart(ctx, r) : null;
  const note = notes.get(id);
  notes.delete(id);
  const line = packageLine(r);
  const told = (await removalWords(ctx, rows)).get(id);
  const toolsLink = t`Settings → Tools`;
  return h('div', { class: 'screen plugin-page' }, back,
    h('h1', { class: 'title', text: r.name }),
    h('p', { class: 'sub', text: line }),
    home ? h('p', {}, h('a', { href: home, target: '_blank', rel: 'noopener noreferrer', text: home })) : null,
    r.description ? h('p', { text: r.description }) : null,
    h('p', { class: 'sub', text: `${stateOf(r)}${r.builtin ? '' : ` · ${sourceLine(r)}`}` }),
    !r.builtin && r.code ? h('p', { class: 'risk-note', text: FULL_ACCESS }) : null,
    told?.providers.length ? h('section', { class: 'panel', 'aria-label': t`Providers` }, h('h2', { class: 'section', text: t`Providers` }),
      h('ul', { class: 'file-list' }, ...told.providers.map((p) => h('li', {}, h('a', { href: `#/models/provider?id=${encodeURIComponent(p.id)}`, text: p.name }))))) : null,
    r.requires?.length ? h('p', { class: 'sub', text: t`It needs: ${list(r.requires.map((/** @type {any} */ q) => rows.find((/** @type {any} */ x) => x.id === q.id)?.name ?? q.id), 'plain')}.` }) : null,
    ...(told?.lines ?? []).map((line) => h('p', { class: 'sub', text: line })),
    r.skills?.length ? h('section', { class: 'panel', 'aria-label': t`Skills` }, h('h2', { class: 'section', text: t`Skills` }), h('ul', { class: 'brings' }, ...r.skills.map((/** @type {string} */ s) => h('li', { text: s })))) : null,
    tools.length ? h('section', { class: 'panel', 'aria-label': t`Tools` }, h('h2', { class: 'section', text: t`Tools` }),
      h('p', { class: 'sub' }, ...linkIn(t`Each can be switched off in ${toolsLink}.`, h('a', { href: '#/tools', text: toolsLink }))),
      h('ul', { class: 'brings' }, ...tools.map((name) => h('li', { text: name })))) : null,
    namesPart(ctx, id, rows),
    r.settings || reset || note ? h('section', { class: 'panel', 'aria-label': t`Settings` }, h('h2', { class: 'section', text: t`Settings` }),
      r.settings ? await settingsForm(ctx, id, r.settings) : null, reset, note ? h('p', { class: 'sub', role: 'status', text: note }) : null) : null,
    pages.length ? h('section', { class: 'panel', 'aria-label': t`Its pages` }, h('h2', { class: 'section', text: t`Its pages` }),
      h('ul', { class: 'file-list' }, ...pages.map((e) => h('li', {}, h('a', { href: `#/plugin-page/${encodeURIComponent(id)}/${encodeURIComponent(e.item.id)}`, text: String(e.item.title) }))))) : null,
    r.builtin ? null : pluginActions(ctx, r, await updateFor(ctx, id)));
}
