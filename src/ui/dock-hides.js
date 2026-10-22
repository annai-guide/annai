/** Input types that take no typing, so no keyboard. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

/** Whether focus on this element brings up a keyboard: a text box, a text area or an editable element. @param {EventTarget | null} el */
const takesTyping = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

/**
 * The dock hides while a text field outside it has focus, on every screen, and comes back when focus leaves (the user,
 * 2026-10-22: on his iPhone the dock "pops in and out" as the keyboard opens and closes). The page gets the class
 * `typing-elsewhere` and shiori.css hides the dock with visibility, which keeps its box: the page's room for it, and
 * so every scroll position, stays as it is while the keyboard comes and goes. The dock's own text box is no such field.
 * @param {Document} [doc]
 */
export function dockHidesWhileTyping(doc = document) {
  /** @param {EventTarget | null} el */
  const update = (el) => doc.documentElement.classList.toggle('typing-elsewhere', takesTyping(el) && !(/** @type {Element} */ (el)).closest('.dock:not(.seat)'));
  doc.addEventListener('focusin', (e) => update(e.target));
  doc.addEventListener('focusout', (e) => update(e.relatedTarget));
  // A field taken off the page while it has focus sends no focusout in every browser: look again after the page changes.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; update(doc.activeElement); });
  }).observe(doc.body, { childList: true, subtree: true });
}
