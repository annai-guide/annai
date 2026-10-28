import { h, t, plural, otherLang, englishIn } from './dom.js';
import { num } from './format.js';

/** @typedef {{ el: HTMLElement, list: HTMLElement, count: HTMLElement, members: Set<HTMLElement>, said: HTMLElement, show: HTMLElement, all: HTMLElement }} Stack */

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
  /**
   * A card whose text is more than three lines shows three and a More, after the text, which opens it to its full height, and a
   * Less, which closes it (the user, 2026-10-22: a sign-in card stopped mid-sentence). Open, the box's cap is lifted; the buttons
   * stay at the card's foot, Dismiss in reach. Looked at once the card is drawn (one in a closed stack, when it opens) and when
   * the screen changes size: clamp the text, and see whether any of it is hidden.
   * @type {WeakMap<HTMLElement, () => void>}
   */
  const fitters = new WeakMap();
  /**
   * A card in the box shows its title and every button, and none of its words behind them (the second review of phone-fixes-1: a
   * choice that changes the user's data is never out of sight). Its words take fewer lines, down to one, while it is taller than the
   * box; then More joins the buttons if their row stays one row, and the words go behind More (hidden to the eye only, so a screen
   * reader still reads them); still too tall, the card grows past the quarter of the screen (cards scroll away with the page).
   * @param {HTMLElement} node @param {HTMLElement} more
   */
  const fit = (node, more) => () => {
    if (!node.offsetHeight || node.classList.contains('open')) return;
    const words = /** @type {HTMLElement[]} */ ([...node.querySelectorAll(':scope > p')]);
    const acts = /** @type {HTMLElement} */ (node.querySelector(':scope > .acts'));
    const focused = document.activeElement === more;
    node.style.removeProperty('--lines');
    node.classList.remove('brief', 'grow');
    const cut = () => words.some((p) => p.scrollHeight > p.clientHeight + 1);
    const over = () => node.scrollHeight > node.clientHeight + 1;
    if (words.length) {
      acts.before(more);
      more.hidden = true; // measured without it: it comes back only where the words need it
      node.classList.add('clamp');
      more.hidden = !cut();
      node.classList.toggle('clamp', !more.hidden);
      if (over()) {
        node.classList.add('clamp');
        for (let n = 2; n && over(); n--) {
          node.style.setProperty('--lines', String(n));
          more.hidden = !cut();
        }
      }
      if (over()) {
        more.hidden = false;
        const row = acts.offsetHeight;
        acts.append(more);
        if (acts.offsetHeight > row + 1) acts.before(more);
        node.classList.add('brief');
      }
    }
    if (over()) node.classList.add('grow');
    // More moved to measure: a keyboard's focus on it stays (the review of phone-fixes-1).
    if (focused && !more.hidden) more.focus({ preventScroll: true });
  };
  /** A folded stack shows its title and buttons: past the box's quarter of the screen if they need it. @param {HTMLElement} node */
  const fitStack = (node) => () => {
    node.classList.remove('grow');
    if (node.querySelector(':scope > .stack-list')?.hasAttribute('hidden') && node.offsetHeight > el.clientHeight - 16 + 1) node.classList.add('grow');
  };
  addEventListener('resize', () => { for (const n of el.querySelectorAll('.notice')) fitters.get(/** @type {HTMLElement} */ (n))?.(); });
  /** One kind of card: the same title and tone. Cards don't say which trip raised them, so that is not part of it. @param {string} title @param {string} tone */
  const kindOf = (title, tone) => `${tone}\n${title}`;
  /** The lone card of a kind, while there is only one. @type {Map<string, HTMLElement>} */
  const singles = new Map();
let stacked = 0;
let lone = 0;
  /** Cards of one kind, folded into one (the user, 2026-10-21: "stack them"). @type {Map<string, Stack>} */
  const stacks = new Map();
  /** @param {string} kind @param {string} title */
  function makeStack(kind, title) {
    const id = `stack-${++stacked}`;
    const list = h('div', { class: 'stack-list', id, hidden: true });
    const count = h('strong', {});
    // What joins a stack is announced here by its own words, as a card in the page would be.
    const said = h('span', { class: 'visually-hidden', role: 'status' });
    const show = h('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': id, onclick: () => {
      const open = list.hidden;
      list.hidden = !open;
      show.textContent = open ? t`Hide` : t`Show`;
      show.setAttribute('aria-expanded', String(open));
      recount(stack);
      if (open) for (const m of stack.members) fitters.get(m)?.();
    } }, t`Show`);
    const all = h('button', { class: 'btn ghost', type: 'button', onclick: () => keep(() => { for (const m of [...stack.members]) leave(kind, m); }) }, t`Dismiss all`);
    const el = h('section', { class: 'notice notice-stack' }, count, said, h('div', { class: 'acts' }, show, all), list);
    /** @type {Stack} */
    const stack = { el, list, count, members: new Set(), said, show, all };
    fitters.set(el, fitStack(el));
    stack.count.dataset.title = title;
    return stack;
  }
  /** @param {Stack} st */
  const recount = (st) => {
    const title = st.count.dataset.title;
    const n = st.members.size;
    st.count.textContent = t`${title} (${num(n)})`;
    st.el.setAttribute('aria-label', plural(n, '{0}, # card', '{0}, # cards', title));
    st.show.setAttribute('aria-label', st.list.hidden ? plural(n, 'Show the # card: {0}', 'Show the # cards: {0}', title) : plural(n, 'Hide the # card: {0}', 'Hide the # cards: {0}', title));
    st.all.setAttribute('aria-label', plural(n, 'Dismiss the # card: {0}', 'Dismiss all # cards: {0}', title));
    fitters.get(st.el)?.();
  };
  /** What joins a stack is read out from its title and words, copied so their lang stays (not the buttons). @param {Stack} st @param {HTMLElement} node */
  const announce = (st, node) => st.said.replaceChildren(...[...node.querySelectorAll('strong, p')].map((n) => n.cloneNode(true)));
  /** A card joins its kind: alone, or in a stack with the others. @param {string} kind @param {string} title @param {HTMLElement} node */
  function place(kind, title, node) {
    const stack = stacks.get(kind);
    const lone = singles.get(kind);
    if (stack) {
      stack.members.add(node);
      stack.list.append(node);
      recount(stack);
      announce(stack, node);
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
      announce(made, node);
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
      fitters.get(only)?.(); // a card again, in the box: fitted as one
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
   * @param {{ title: string, body?: string, en?: string, tone?: 'info'|'ok'|'warn'|'risk', actions?: { label: string, run: () => void, primary?: boolean }[], toast?: boolean, lang?: string, errors?: unknown[] }} n
   *   en: English kept from before the screens spoke other languages, a line of its own marked so; lang: the language of a plugin's
   *   title and body, marked when it isn't the screens'; errors: those whose messageOf the body holds, so a developer's English in them
   *   is marked lang="en" where it stands (englishIn)
   * toast: said briefly, as a toast, with no card to dismiss
   * @returns {() => void} dismiss
   */
  function card({ title, body, en, tone = 'info', actions = [], toast: brief, lang, errors = [] }) {
    if (brief) {
      toast(title, { lang });
      return () => {};
    }
    // A card with anything to do but Dismiss (Try again, Open Trace, Install) is never folded away.
    const kind = actions.length ? `${kindOf(title, tone)}\n${++lone}` : kindOf(title, tone);
    const more = h('button', { class: 'btn ghost more', type: 'button', hidden: true, 'aria-expanded': 'false', onclick: () => keep(() => {
      const open = node.classList.toggle('open');
      if (!open) fitters.get(node)?.(); // closed again, it fits the screen as it is now (it may have turned meanwhile)
      more.textContent = open ? t`Less` : t`More`;
      more.setAttribute('aria-expanded', String(open));
    }) }, t`More`);
    const node = h('section', { class: ['notice', `notice-${tone}`] },
      h('strong', { text: title, lang: otherLang(lang) }),
      body ? h('p', { lang: otherLang(lang) }, ...englishIn(body, ...errors)) : null,
      en ? h('p', { lang: 'en', text: en }) : null,
      body ? more : null,
      h('div', { class: 'acts' },
        ...actions.map((a) => h('button', { class: ['btn', a.primary && 'pri'], type: 'button', onclick: () => { a.run(); dismiss(); } }, a.label)),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dismiss() }, t`Dismiss`)));
    fitters.set(node, fit(node, more));
    const dismiss = () => { if (node.isConnected) keep(() => leave(kind, node)); };
    // Fitted inside keep(): what it changes of the card's height is kept off what the user sees (scrolled down, the screen stays put).
    keep(() => {
      place(kind, title, node);
      fitters.get(node)?.();
    });
    return dismiss;
  }
  /** @param {string} text @param {{ lang?: string }} [o] lang: a plugin's words' language, marked when it isn't the screens' */
  function toast(text, { lang } = {}) {
    const shown = h('div', { class: 'toast', text, lang: otherLang(lang) });
    toasts.append(shown);
    setTimeout(() => shown.remove(), 3500);
  }
  return { el, toasts, card, toast };
}
