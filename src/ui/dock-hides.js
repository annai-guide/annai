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
  /** A press is on, and the dock's return was put off until it ends. */
  let pressed = false;
  let later = false;
  /** @param {EventTarget | null} el */
  const update = (el) => {
    const on = takesTyping(el) && !(/** @type {Element} */ (el)).closest('.dock:not(.seat)');
    // Pressing a button lets go of the field at the press: the dock coming back then would cover a button under it, and the
    // release would miss. It comes back once the press is over (a tap on a phone keeps the field until the click, tap-keeps-keyboard.js).
    if (!on && pressed) {
      later = true;
      return;
    }
    later = false;
    doc.documentElement.classList.toggle('typing-elsewhere', Boolean(on));
  };
  doc.addEventListener('focusin', (e) => update(e.target));
  doc.addEventListener('focusout', (e) => update(e.relatedTarget));
  doc.addEventListener('pointerdown', () => { pressed = true; }, true);
  for (const type of ['pointerup', 'pointercancel']) {
    doc.addEventListener(type, () => {
      pressed = false;
      if (later) setTimeout(() => { if (later && !pressed) update(doc.activeElement); }, 0); // after the click
    }, true);
  }
  // A field taken off the page while it has focus sends no focusout in every browser: look again after the page changes.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; update(doc.activeElement); });
  }).observe(doc.body, { childList: true, subtree: true });
}
