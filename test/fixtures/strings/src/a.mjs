import { h, t, tc, plural } from './dom.js';

export const view = (n, who, where) => h('p', { class: 'x' },
  t`Hello ${who}.`,
  tc('verb')`Open`,
  t`Saved to ${where} for ${who}`,
  plural(n, '# stamp', '# stamps'));

export const fresh = () => t`Brand new`;
export const waiting = () => t`Not yet`;
