import { h, field } from '../dom.js';

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderTrace(ctx, route) {
  const scopes = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.listScopes());
  const titles = new Map(scopes.map((/** @type {any} */ s) => [s.id, s.kind === 'sys' ? `System · ${s.title}` : s.title]));
  const select = h('select', { id: 'trace-scope' }, h('option', { value: '', text: 'Everything' }),
    ...scopes.map((/** @type {any} */ s) => h('option', { value: s.id, text: titles.get(s.id) })));
  select.value = route.params.scope ?? '';
  const filter = h('input', { id: 'trace-type', autocomplete: 'off', placeholder: 'file.write', value: route.params.type ?? '' });
  const list = h('ol', { class: 'trace' });
  let pending = 0;
  const load = async () => {
    const my = ++pending;
    const ids = select.value ? [select.value] : scopes.map((/** @type {any} */ s) => s.id);
    const all = (await Promise.all(ids.map((/** @type {string} */ id) => ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(id, { reverse: true, limit: 300 }))))).flat();
    if (my !== pending) return;
    const f = filter.value.trim();
    const rows = all.filter((e) => !f || e.type.includes(f)).sort((a, b) => b.ts - a.ts || b.seq - a.seq).slice(0, 300);
    list.replaceChildren(...(rows.length ? rows.map((e) => row(e, titles)) : [h('li', { class: 'empty', text: 'Nothing here yet.' })]));
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  select.addEventListener('change', load);
  filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
  await load();
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trace' }),
    h('p', { class: 'sub', text: 'Everything annai recorded: file changes, imports, plugin problems and errors. Newest first.' }),
    h('div', { class: 'row' }, field('Show', select), field('Type contains', filter)),
    list);
}

/** @param {any} e @param {Map<string, string>} titles */
function row(e, titles) {
  const summary = e.type.startsWith('file.') ? e.data?.path ?? '' : e.data?.message ?? e.data?.title ?? '';
  return h('li', {}, h('details', {},
    h('summary', {},
      h('span', { class: 'tm', text: new Date(e.ts).toLocaleString() }),
      h('span', { class: 'k', text: e.type }),
      h('span', { class: 'sub', text: `${titles.get(e.scope) ?? e.scope} · ${e.actor}` }),
      h('span', { class: 'd', text: summary })),
    h('pre', { text: JSON.stringify(e, null, 2) })));
}
