import { takesTyping } from './tap-keeps-keyboard.js';

/** A press waits this long after its pointer is up for its click, then the dock comes back anyway (a drag sends none). */
const NO_CLICK_MS = 400;

/**
 * On a touch screen the dock steps aside while a text field outside it has focus and the keyboard is up, and comes back when focus
 * leaves or the keyboard goes (the user, 2026-10-22: on an iPhone it "pops in and out"). The page gets `typing-elsewhere`; shiori.css
 * makes the dock see-through and deaf to taps but keeps its box and its place in the accessibility tree. The dock's own text box
 * is no such field; a mouse has no keyboard, so nothing happens there.
 * @param {Document} [doc]
 */
export function dockHidesWhileTyping(doc = document) {
  const win = /** @type {Window} */ (doc.defaultView);
  const vv = win.visualViewport;
  /** A text field outside the dock has focus. */
  let field = false;
  /** The keyboard has been up since it took focus: Android's Back takes it down and leaves the focus, and the dock returns. */
  let seen = false;
  /** A press is on, and the dock's return was put off until its click, or a moment after it ends. */
  let pressed = false;
  let later = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const covered = () => Boolean(vv) && /** @type {VisualViewport} */ (vv).height < doc.documentElement.clientHeight * 0.8;
  const paint = () => doc.documentElement.classList.toggle('typing-elsewhere', field && !(seen && !covered()));
  /** @param {EventTarget | null} el */
  const update = (el) => {
    const on = win.matchMedia('(pointer: coarse)').matches && takesTyping(el) && !(/** @type {Element} */ (el)).closest('.dock:not(.seat)');
    // Pressing a button lets go of the field at the press: the dock coming back then would be under the finger for the release,
    // and the tap would land on it. It comes back with the press's click (capture), or soon after the press ends without one.
    if (!on && field && pressed) {
      later = true;
      return;
    }
    later = false;
    if (on && !field) seen = covered();
    field = Boolean(on);
    paint();
  };
  /** The press is over: its click came, or none did in time. */
  const settle = () => {
    clearTimeout(timer);
    pressed = false;
    if (later) update(doc.activeElement);
  };
  doc.addEventListener('focusin', (e) => update(e.target));
  doc.addEventListener('focusout', (e) => update(e.relatedTarget));
  // On a touch screen a tap is pointerup, mousedown (which lets go of the field), mouseup, click: a press lasts until its click.
  doc.addEventListener('pointerdown', () => { pressed = true; clearTimeout(timer); }, true);
  for (const type of ['pointerup', 'pointercancel']) {
    doc.addEventListener(type, () => { clearTimeout(timer); timer = setTimeout(settle, NO_CLICK_MS); }, true);
  }
  doc.addEventListener('click', settle, true);
  vv?.addEventListener('resize', () => {
    if (field && covered()) seen = true;
    paint();
  });
  // A field taken off the page while it has focus sends no focusout in every browser: look again after the page changes.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; update(doc.activeElement); });
  }).observe(doc.body, { childList: true, subtree: true });
}
