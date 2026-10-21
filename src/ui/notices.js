import { h } from './dom.js';

/**
 * System cards and toasts. These are never in Shiori's voice (spec §16.1). Cards (el) go at the top of the
 * screen, under the top bar, so they move the screen down rather than cover its buttons; toasts float above the dock.
 */
export function createNotices() {
  const el = h('div', { class: 'notices', role: 'status', 'aria-live': 'polite' });
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
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
    const dismiss = () => node.remove();
    el.append(node);
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
