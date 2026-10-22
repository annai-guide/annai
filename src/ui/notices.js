import { h } from './dom.js';

/**
 * System cards and toasts. These are never in Shiori's voice (spec §16.1). Cards of one kind fold into one. Cards (el) sit in the page at its top,
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
  /** One kind of card: the same title and tone. Cards don't say which trip raised them, so that is not part of it. @param {string} title @param {string} tone */
  const kindOf = (title, tone) => `${tone}\n${title}`;
  /** The lone card of a kind, while there is only one. @type {Map<string, HTMLElement>} */
  const singles = new Map();
  /** Cards of one kind, folded into one (the user, 2026-10-21: "stack them"). @type {Map<string, { el: HTMLElement, list: HTMLElement, count: HTMLElement, members: Set<HTMLElement> }>} */
  const stacks = new Map();
  /** @param {string} kind @param {string} title */
  function makeStack(kind, title) {
    const list = h('div', { class: 'stack-list', hidden: true });
    const count = h('strong', {});
    const show = h('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', onclick: () => {
      const open = list.hidden;
      list.hidden = !open;
      show.textContent = open ? 'Hide' : 'Show';
      show.setAttribute('aria-expanded', String(open));
    } }, 'Show');
    const all = h('button', { class: 'btn ghost', type: 'button', onclick: () => keep(() => { for (const m of [...stack.members]) leave(kind, m); }) }, 'Dismiss all');
    const el = h('section', { class: 'notice notice-stack' }, count, h('div', { class: 'acts' }, show, all), list);
    /** @type {{ el: HTMLElement, list: HTMLElement, count: HTMLElement, members: Set<HTMLElement> }} */
    const stack = { el, list, count, members: new Set() };
    stack.count.dataset.title = title;
    return stack;
  }
  /** @param {{ list: HTMLElement, count: HTMLElement, members: Set<HTMLElement> }} st */
  const recount = (st) => { st.count.textContent = `${st.count.dataset.title} (${st.members.size})`; };
  /** A card joins its kind: alone, or in a stack with the others. @param {string} kind @param {string} title @param {HTMLElement} node */
  function place(kind, title, node) {
    const stack = stacks.get(kind);
    const lone = singles.get(kind);
    if (stack) {
      stack.members.add(node);
      stack.list.append(node);
      recount(stack);
    } else if (lone) {
      const made = makeStack(kind, title);
      stacks.set(kind, made);
      singles.delete(kind);
      lone.replaceWith(made.el);
      for (const m of [lone, node]) {
        made.members.add(m);
        made.list.append(m);
      }
      recount(made);
    } else {
      singles.set(kind, node);
      el.append(node);
    }
  }
  /** A card goes; a stack of one becomes the card again, and an empty one goes. @param {string} kind @param {HTMLElement} node */
  function leave(kind, node) {
    const stack = stacks.get(kind);
    if (!stack) {
      if (singles.get(kind) === node) singles.delete(kind);
      node.remove();
      return;
    }
    stack.members.delete(node);
    node.remove();
    if (stack.members.size === 1) {
      const [only] = stack.members;
      stack.el.replaceWith(only);
      stacks.delete(kind);
      singles.set(kind, only);
    } else if (!stack.members.size) {
      stack.el.remove();
      stacks.delete(kind);
    } else recount(stack);
  }
  /**
   * Cards of one kind (the same title and tone) fold into one card, "Reminder (3)", that shows each when opened, with one
   * Dismiss all, and each can still be dismissed alone.
   * @param {{ title: string, body?: string, tone?: 'info'|'ok'|'warn'|'risk', actions?: { label: string, run: () => void, primary?: boolean }[] }} n
   * @returns {() => void} dismiss
   */
  function card({ title, body, tone = 'info', actions = [] }) {
    const kind = kindOf(title, tone);
    const node = h('section', { class: ['notice', `notice-${tone}`] },
      h('strong', { text: title }),
      body ? h('p', { text: body }) : null,
      h('div', { class: 'acts' },
        ...actions.map((a) => h('button', { class: a.primary ? 'btn pri' : 'btn', type: 'button', onclick: () => { a.run(); dismiss(); } }, a.label)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dismiss() }, 'Dismiss')));
    const dismiss = () => { if (node.isConnected) keep(() => leave(kind, node)); };
    keep(() => place(kind, title, node));
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
