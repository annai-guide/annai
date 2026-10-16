import { h } from '../dom.js';
import { renderCard } from '../cards.js';
import { costs } from '../../core/agent/budgets.js';
import { storedTexts } from '../../core/agent/log.js';
import { undoTuning } from '../../core/agent/personalities.js';
import { formatCost } from '../format.js';

const SHOWN = ['msg.user', 'out.speak', 'out.show', 'out.ask', 'tool.result', 'wake', 'compaction', 'error'];

/**
 * The conversation (spec §16.2): what the user wrote, what Shiori said and showed, her questions,
 * and system cards. Her private text and reasoning stay in the trace (§7.1).
 * @param {any} ctx
 */
export async function renderTalk(ctx) {
  const agent = ctx.agent;
  await agent.opening.catch(() => {}); // after a start or a trip change, the conversation is still being read
  const scope = agent.scope;
  const title = agent.trip ? (await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(agent.trip)))?.title ?? 'Trip' : 'No trip open';
  const list = h('ol', { class: 'convo', 'aria-live': 'polite' });
  const cost = h('p', { class: 'sub' });
  const showCost = async () => {
    const c = await costs(ctx.store, scope);
    cost.textContent = `${agent.trip ? 'This trip' : 'This conversation'} so far: ${formatCost(c.total)}`;
  };
  /** @type {Map<string, HTMLElement>} asks still open, by call id */
  const asks = new Map();
  /** @param {any} e */
  const item = async (e) => {
    const d = e.data ?? {};
    const texts = { ...d, ...(await storedTexts(ctx.store, e)) };
    if (e.type === 'msg.user') return h('li', { class: 'you' }, h('p', { text: texts.text ?? '' }));
    if (e.type === 'out.speak') return h('li', { class: 'shiori' }, h('span', { class: 'who', text: 'SHIORI' }), h('p', { text: texts.text ?? '' }));
    if (e.type === 'out.show') {
      const card = renderCard(d.card ?? {}, { ctx, onChoice: (o) => agent.send(o) });
      const undo = d.tune ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await undoTuning(ctx.ws, d.tune.name, d.tune.old); ctx.notices.toast('Undone. Her old personality applies at her next wake.'); } }, 'Undo') : null;
      return h('li', { class: 'shiori' }, h('span', { class: 'who', text: 'SHIORI' }), card, undo);
    }
    if (e.type === 'out.ask') {
      const buttons = (d.options ?? []).map((/** @type {string} */ o) => h('button', { class: 'btn', type: 'button', onclick: () => agent.answer(d.id, o) }, String(o)));
      const node = h('li', { class: 'shiori' }, h('span', { class: 'who', text: 'SHIORI' }), h('p', { text: String(d.question ?? '') }), h('div', { class: 'acts' }, ...buttons));
      asks.set(d.id, node);
      return node;
    }
    if (e.type === 'tool.result' && asks.has(d.id)) {
      for (const b of asks.get(d.id)?.querySelectorAll('button') ?? []) /** @type {HTMLButtonElement} */ (b).disabled = true;
      asks.delete(d.id);
      return null;
    }
    if (e.type === 'wake') {
      const others = (d.reasons ?? []).filter((/** @type {any} */ r) => r.kind !== 'user' && r.kind !== 'choice');
      return others.length ? h('li', { class: 'system-line', text: `Shiori woke: ${others.map((/** @type {any} */ r) => r.text).join('; ')}` }) : null;
    }
    if (e.type === 'compaction') return h('li', { class: 'system-line', text: 'Earlier conversation summarized. The full log is in Trace.' });
    if (e.type === 'error') return h('li', { class: 'system' }, h('strong', { text: d.kind === 'model' ? "Shiori couldn't reach her model" : d.kind === 'budget' ? 'A budget ended her turn' : 'Her turn ended' }), h('p', { text: String(d.message ?? '') }));
    return null;
  };
  const events = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: SHOWN, reverse: true, limit: 400 }));
  for (const e of events.reverse()) {
    const node = await item(e);
    if (node) list.append(node);
  }
  showCost();
  const off = agent.on('event', async (/** @type {any} */ e) => {
    if (!list.isConnected) {
      off();
      return;
    }
    if (!SHOWN.includes(e.type) || e.scope !== scope) return; // another conversation's, after a trip change
    const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    const node = await item(e);
    if (node) {
      list.append(node);
      if (near) node.scrollIntoView({ block: 'end' });
      if (e.actor === 'shiori') ctx.dock?.avatar.glance(0, 1.5);
    }
    showCost();
  });
  const screen = h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Conversation' }),
    h('p', { class: 'sub', text: agent.trip ? title : 'No trip is open. Open one from Trips, or talk here: Shiori can still use /me/.' }),
    cost,
    list.childElementCount ? list : h('p', { class: 'empty', text: 'Nothing yet. Tap Shiori or Type below to talk.' }),
    list.childElementCount ? null : list);
  requestAnimationFrame(() => list.lastElementChild?.scrollIntoView({ block: 'end' }));
  return screen;
}
