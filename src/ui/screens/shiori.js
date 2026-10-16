import { h, field, checkbox } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { ME } from '../../core/scopes.js';
import { PRESETS, PERSONALITY_MAX, resetPersonality, keepMine } from '../../core/agent/personalities.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** Settings → Shiori (spec §14.1, §6.6, §6.5). @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderShiori(ctx, route) {
  const app = await readAppSettings(ctx.ws);
  const active = app.shiori?.personality ?? 'shiori';
  const names = (await ctx.ws.list(ME, '/personalities/')).map((/** @type {any} */ f) => f.path.replace(/^\/personalities\/|\.md$/g, ''));
  const editing = route.params.edit ?? active;
  const text = h('textarea', { id: 'personality-text', rows: 12, maxlength: PERSONALITY_MAX, value: (await ctx.ws.readText(ME, `/personalities/${editing}.md`)) ?? '' });
  const compare = route.params.compare;
  const newName = h('input', { id: 'new-personality', autocomplete: 'off', spellcheck: 'false', placeholder: 'my-shiori' });
  const nameError = h('p', { class: 'error', role: 'alert', hidden: true });
  const askFirst = checkbox('Ask me before Shiori changes her personality', Boolean(app.shiori?.askBeforeTuning));
  askFirst.input.addEventListener('change', () => updateAppSettings(ctx.ws, { shiori: { askBeforeTuning: askFirst.input.checked } }));
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Shiori' }),
    section('Personality',
      h('p', { class: 'sub', text: 'How Shiori behaves. She can adjust it herself through a reviewed change, and you can always undo it.' }),
      h('ul', { class: 'file-list' }, ...names.map((n) => h('li', {},
        h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'personality', value: n, checked: n === active, onchange: async () => { await updateAppSettings(ctx.ws, { shiori: { personality: n } }); ctx.notices.toast(`Shiori is now "${n}". It applies at her next wake.`); ctx.render(); } }),
          h('span', { text: n })),
        h('a', { href: `#/shiori?edit=${encodeURIComponent(n)}`, text: 'Edit' })))),
      compare && ctx.presets?.[compare] ? h('div', { class: 'compare' },
        h('h3', { text: `The new original of "${compare}"` }), h('pre', { class: 'mono', text: ctx.presets[compare] }),
        h('div', { class: 'acts' },
          h('button', { class: 'btn', type: 'button', onclick: async () => { await keepMine(ctx.ws, compare, ctx.presets[compare]); ctx.go('#/shiori'); } }, 'Keep mine'),
          h('button', { class: 'btn', type: 'button', onclick: async () => { await resetPersonality(ctx.ws, compare, ctx.presets); ctx.go('#/shiori'); } }, 'Use the new original'))) : null,
      field(`"${editing}"`, text),
      h('div', { class: 'acts' },
        h('button', { class: 'btn pri', type: 'button', onclick: async () => { await ctx.ws.write(ME, `/personalities/${editing}.md`, text.value, { author: 'user' }); ctx.notices.toast('Saved. It applies at her next wake.'); } }, 'Save'),
        PRESETS.includes(editing) && ctx.presets ? h('button', { class: 'btn', type: 'button', onclick: async () => { await resetPersonality(ctx.ws, editing, ctx.presets); ctx.render(); } }, 'Reset to original') : null,
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const name = newName.value.trim();
          nameError.hidden = /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) && !names.includes(name);
          if (!nameError.hidden) {
            nameError.textContent = names.includes(name) ? `There is already a personality called "${name}".` : 'A name is lowercase letters, digits and dashes, like my-shiori.';
            return;
          }
          await ctx.ws.write(ME, `/personalities/${name}.md`, text.value, { author: 'user' });
          ctx.go(`#/shiori?edit=${encodeURIComponent(name)}`);
        } }, 'New from this one')),
      field('Name for a new one', newName),
      nameError,
      askFirst.el));
}
