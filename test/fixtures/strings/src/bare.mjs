import { h, t } from './dom.js';

export const screen = (who) => h('section', { 'aria-label': 'Trips' },
  h('h1', { text: 'Trips' }),
  h('p', {}, 'Nothing here yet.'),
  h('p', {}, t`Welcome ${who}.`),
  h('span', {}, '·'),
  h('b', { title: /* en */ 'annai' }),
  h('i', { text: who ? t`Yours` : 'Not yours' }));
