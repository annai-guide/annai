import { h, field } from '../dom.js';
import { formatCost } from '../format.js';

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
    list.replaceChildren(...(rows.length ? rows.map((e) => row(ctx, e, titles)) : [h('li', { class: 'empty', text: 'Nothing here yet.' })]));
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  select.addEventListener('change', load);
  filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
  await load();
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trace' }),
    h('p', { class: 'sub', text: 'Everything annai recorded: file changes, model calls, imports, plugin problems and errors. Newest first.' }),
    h('div', { class: 'row' }, field('Show', select), field('Type contains', filter)),
    list);
}

/** @param {any} ctx @param {any} e @param {Map<string, string>} titles */
function row(ctx, e, titles) {
  return h('li', {}, h('details', {},
    h('summary', {},
      h('span', { class: 'tm', text: new Date(e.ts).toLocaleString() }),
      h('span', { class: 'k', text: e.type }),
      h('span', { class: 'sub', text: `${titles.get(e.scope) ?? e.scope} · ${e.actor}` }),
      h('span', { class: 'd', text: summaryOf(e) })),
    h('pre', { text: JSON.stringify(e, null, 2) }),
    e.refs?.length ? storedText(ctx, e) : null));
}

/** One line about an event. @param {any} e */
function summaryOf(e) {
  const d = e.data ?? {};
  if (e.type.startsWith('file.')) return d.path ?? '';
  if (e.type === 'model.turn') {
    const n = (d.attempts ?? []).length;
    return `${d.role}: ${d.answeredBy ?? 'no answer'} · ${n} attempt${n === 1 ? '' : 's'}${d.cost !== undefined ? ` · ${formatCost(d.cost)}` : ''}`;
  }
  if (e.type === 'net.request') return `${d.model ?? ''} · ${d.outcome ?? ''}${d.status ? ` (${d.status})` : ''} · ${d.ms ?? '?'} ms`;
  return d.message ?? d.title ?? '';
}

/**
 * Shows the content an event names: a model's reply and its reasoning, say (spec §15: the trace
 * makes everything the agent read visible). Text is shown; anything else is described.
 * @param {any} ctx @param {any} e an event with refs; data.stored names them, when it is there
 */
function storedText(ctx, e) {
  const out = h('pre', { hidden: true });
  const btn = h('button', {
    class: 'btn ghost', type: 'button',
    onclick: async () => {
      /** @type {string[]} */
      const texts = [];
      for (const [i, hash] of e.refs.entries()) {
        const b = await ctx.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(hash));
        const body = !b ? '(no longer stored)'
          : /^text\/|json/.test(b.type) ? new TextDecoder().decode(new Uint8Array(b.data).subarray(0, 200_000))
            : `(${b.type}, ${b.size} bytes)`;
        const label = e.data?.stored?.[i];
        texts.push(label ? `${label}:\n${body}` : body);
      }
      out.textContent = texts.join('\n\n');
      out.hidden = false;
      btn.hidden = true;
    },
  }, 'Show what was stored');
  return h('div', {}, btn, out);
}
