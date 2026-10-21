/** Input types that take no typing, so no keyboard. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

/**
 * A tap on a button in a screen, while a field is being typed in, no longer takes the focus off the field first.
 * The second emulator re-check: after typing a key, the first tap on Save only focused it and the second saved.
 * Taking the focus lets the keyboard go down, the screen is laid out again, and the tap that began on the
 * button is lost with it (as seen on Chrome 113). Kept in the field until the click is handled, nothing moves
 * under the finger; the field is let go of right after, and then the keyboard goes down. The dock's own
 * buttons (Send) are left alone: they are not in a screen, and typing goes on there.
 * @param {Document} [doc]
 */
export function tapKeepsKeyboard(doc = document) {
  /** The field being typed in, when the target is a screen's button. @param {Event} e */
  const typingFor = (e) => {
    const a = doc.activeElement;
    const typing = a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && !NOT_TEXT.has(a.type)) ? a : null;
    const button = e.target instanceof Element ? e.target.closest('main button, main a.btn') : null;
    return typing && button && !button.contains(typing) ? typing : null;
  };
  doc.addEventListener('mousedown', (e) => {
    if (typingFor(e)) e.preventDefault();
  });
  doc.addEventListener('click', (e) => {
    const typing = typingFor(e);
    if (typing) setTimeout(() => { if (doc.activeElement === typing) typing.blur(); }, 0);
  });
}
