import { h } from '../dom.js';
import { listTrips } from '../../core/scopes.js';

/** @param {any} ctx */
export async function renderTrips(ctx) {
  const { active } = await listTrips(ctx.store);
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trips' }),
    active.length
      ? h('ul', { class: 'cards' }, ...active.map((s) => h('li', {}, h('a', { class: 'card', href: `#/trip/${encodeURIComponent(s.id)}` }, s.title))))
      : h('p', { class: 'empty', text: 'No trips yet.' }));
}
