/** Input types that take no typing, so no keyboard. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

/** Whether focus on this element brings up a keyboard: a text box, a text area or an editable element. @param {EventTarget | null} el */
export const takesTyping = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

/**
 * A finger's tap on a screen's button, while a field is being typed in, no longer lets the keyboard go down before the click
 * lands. The second emulator re-check: after typing a key, the first tap on Save only focused it (the keyboard going down laid
 * the screen out again under the finger, and the tap was lost) and the second saved. The press leaves the field focused; the
 * click, first of all (capture), lets go of the field, which saves what changed in it, and then the button acts. So the order
 * is the same as with a mouse: change, then click. A mouse or a pen is left as it is. The dock's own buttons (Send) too.
 * @param {Document} [doc]
 */
export function tapKeepsKeyboard(doc = document) {
  let touch = false;
  /** The field being typed in and the button, when the target is a screen's button. @param {Event} e */
  const typingFor = (e) => {
    const a = doc.activeElement;
    const typing = takesTyping(a) ? /** @type {HTMLElement} */ (a) : null;
    const button = e.target instanceof Element ? e.target.closest('main button, main a.btn') : null;
    return touch && typing && button && !button.contains(typing) ? { typing, button } : null;
  };
  doc.addEventListener('pointerdown', (e) => { touch = e.pointerType === 'touch'; }, true);
  doc.addEventListener('mousedown', (e) => {
    if (typingFor(e)) e.preventDefault();
  });
  doc.addEventListener('click', (e) => {
    const tap = typingFor(e);
    if (tap) {
      tap.typing.blur();
      // The press never gave the button the focus: it takes it now, so a question or the photo viewer it opens gives the focus back to it.
      if (tap.button instanceof HTMLElement) tap.button.focus({ preventScroll: true });
    }
    touch = false;
  }, true);
}
