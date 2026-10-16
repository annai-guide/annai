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
  const b = app.shiori?.budgets ?? {};
  const num = (/** @type {string} */ id, /** @type {any} */ value, /** @type {Record<string, any>} */ more = {}) => h('input', { id, type: 'number', inputmode: 'decimal', value: value ?? '', ...more });
  const steps = num('budget-steps', b.stepsPerWake, { min: 1, step: 1 });
  const spend = num('budget-spend', b.spendPerDay, { min: 0, step: 0.01 });
  const wakes = num('budget-wakes', b.wakesPerHour, { min: 1, step: 1 });
  const quietFrom = h('input', { id: 'quiet-from', type: 'time', value: b.quietHours?.from ?? '' });
  const quietTo = h('input', { id: 'quiet-to', type: 'time', value: b.quietHours?.to ?? '' });
  const val = (/** @type {HTMLInputElement} */ i) => (i.value.trim() === '' ? null : Number(i.value));
  const c = { threshold: 0.7, maxRequestMiB: 8, ...(app.shiori?.compaction ?? {}) };
  const threshold = num('compaction-threshold', Math.round(c.threshold * 100), { min: 50, max: 90, step: 5 });
  const maxMiB = num('compaction-max', c.maxRequestMiB, { min: 1, max: 64, step: 1 });
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
      askFirst.el),
    section('Budgets',
      h('p', { class: 'sub', text: 'None are set unless you set them. Hitting one ends her turn with a card.' }),
      field('Steps per wake', steps), field('Spend per day (USD)', spend), field('Wakes per hour, not counting yours', wakes),
      h('div', { class: 'row' }, field('Quiet from', quietFrom), field('Quiet until', quietTo)),
      h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: async () => {
        const quiet = quietFrom.value && quietTo.value ? { from: quietFrom.value, to: quietTo.value } : null;
        await updateAppSettings(ctx.ws, { shiori: { budgets: { stepsPerWake: val(steps), spendPerDay: val(spend), wakesPerHour: val(wakes), quietHours: quiet } } });
        ctx.notices.toast('Budgets saved.');
      } }, 'Save budgets'))),
    section('Housekeeping',
      h('p', { class: 'sub', text: 'When a conversation gets long, Shiori summarizes its older part. She does it when it reaches this share of her model\'s context, or when a request would get this big.' }),
      field('Summarize at (% of the context)', threshold), field('Largest request (MiB)', maxMiB),
      h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: async () => {
        const t = Math.min(90, Math.max(50, Number(threshold.value) || 70)) / 100;
        const m = Math.min(64, Math.max(1, Number(maxMiB.value) || 8));
        await updateAppSettings(ctx.ws, { shiori: { compaction: { threshold: t, maxRequestMiB: m } } });
        ctx.notices.toast('Saved.');
      } }, 'Save'))),
    section('Cache',
      h('p', { class: 'sub', text: 'Providers keep the start of the conversation for a while, so the next request costs less. An hour costs more to write than five minutes, and pays off when you talk less often.' }),
      h('fieldset', {}, h('legend', { text: 'Keep it for' }), ...[['5m', '5 minutes'], ['1h', '1 hour']].map(([v, label]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'cache-ttl', value: v, checked: (app.shiori?.cacheTtl ?? '5m') === v, onchange: () => updateAppSettings(ctx.ws, { shiori: { cacheTtl: v } }) }),
        h('span', { text: label }))))));
}
