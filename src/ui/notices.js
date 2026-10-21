import { h } from './dom.js';

/**
 * System cards and toasts. These are never in Shiori's voice (spec §16.1). Cards (el) sit in the page at its top,
 * under the top bar, and scroll away with it, so they never cover a screen's buttons; toasts float above the dock.
 */
export function createNotices() {
  const el = h('div', { class: 'notices', role: 'status', 'aria-live': 'polite' });
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let settle;
  /** A card comes or goes: scrolled down, what is seen stays put; at the top, what moved ignores taps a moment (.landed). @param {() => void} change */
  const keep = (change) => {
    const y = scrollY;
    const was = el.getBoundingClientRect().height;
    change();
    const by = el.getBoundingClientRect().height - was;
    if (by && y > 0) scrollTo(0, y + by);
    else if (by > 0) {
      el.classList.add('landed');
      clearTimeout(settle);
      settle = setTimeout(() => el.classList.remove('landed'), 400);
    }
  };
  /**
   * @param {{ title: string, body?: string, tone?: 'info'|'ok'|'warn'|'risk', actions?: { label: string, run: () => void, primary?: boolean }[] }} n
   * @returns {() => void} dismiss
   */
  function card({ title, body, tone = 'info', actions = [] }) {
    const node = h('section', { class: ['notice', `notice-${tone}`] },
      h('strong', { text: title }),
      body ? h('p', { text: body }) : null,
      h('div', { class: 'acts' },
        ...actions.map((a) => h('button', { class: a.primary ? 'btn pri' : 'btn', type: 'button', onclick: () => { a.run(); dismiss(); } }, a.label)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dismiss() }, 'Dismiss')));
    const dismiss = () => { if (node.isConnected) keep(() => node.remove()); };
    keep(() => el.append(node));
    return dismiss;
  }
  /** @param {string} text */
  function toast(text) {
    const t = h('div', { class: 'toast', text });
    toasts.append(t);
    setTimeout(() => t.remove(), 3500);
  }
  return { el, toasts, card, toast };
}
