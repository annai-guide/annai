import { h } from './dom.js';

let n = 0;
/** This page's own part of each question's id: an entry another page load left in the history is never taken for one of its (review m2). */
const page = Math.random().toString(36).slice(2, 8);

/**
 * A modal question with two answers (spec §4.9). Resolves true only for `yes`; Cancel, Escape and
 * Back resolve false. Focus starts on Cancel, so a stray Enter never confirms. Where the browser
 * closes a modal dialog on Back itself (CloseWatcher, Chrome 120+), it does; elsewhere (Chrome 113,
 * Safari) opening adds a history entry, as the photo viewer does, and Back takes it. There the dialog
 * is not modal: Chrome 113 on Android swallowed the first Back for a modal dialog, so it took two
 * (the second emulator re-check). annai draws its own backdrop, makes the rest of the page inert and
 * keeps the focus in the question and Escape closing it, as a modal does. An answer takes
 * that entry back before it resolves, so what the answer does next, such as a new screen, stays.
 * @param {{ title: string, body: string, yes: string, no?: string }} q
 * @returns {Promise<boolean>}
 */
export function ask({ title, body, yes, no = 'Cancel' }) {
  const id = `ask-${page}-${n++}`;
  return new Promise((resolve) => {
    /** @type {HTMLDialogElement} */
    const dialog = h('dialog', { class: 'ask', 'aria-labelledby': id },
      h('h2', { class: 'section', id, text: title }),
      h('p', { text: body }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('no') }, no),
        h('button', { class: 'btn danger', type: 'button', onclick: () => dialog.close('yes') }, yes)));
    const back = () => dialog.close('no');
    const modal = 'CloseWatcher' in window;
    /** What a non-modal question takes down when it closes. */
    let release = () => {};
    dialog.addEventListener('close', () => {
      release();
      dialog.remove();
      removeEventListener('popstate', back);
      const done = () => resolve(dialog.returnValue === 'yes');
      if (history.state?.annaiAsk !== id) return done();
      addEventListener('popstate', done, { once: true });
      history.back();
    });
    document.body.append(dialog);
    if (modal) dialog.showModal();
    else release = openPlain(dialog, back);
    if (modal) return;
    history.pushState({ annaiAsk: id }, '');
    addEventListener('popstate', back);
  });
}

/**
 * Shows a dialog the way a modal looks, without being one: its own backdrop, everything else inert, Tab kept
 * inside, Escape closing it (as `close`). Gives what puts the page back, focus included.
 * @param {HTMLDialogElement} dialog @param {() => void} close @returns {() => void}
 */
function openPlain(dialog, close) {
  const opener = document.activeElement;
  const backdrop = h('div', { class: 'ask-backdrop' });
  document.body.append(backdrop);
  /** The page's own parts that weren't inert already. */
  const behind = [...document.body.children].filter((el) => el !== dialog && el !== backdrop && !(/** @type {HTMLElement} */ (el)).inert);
  for (const el of behind) /** @type {HTMLElement} */ (el).inert = true;
  dialog.classList.add('plain');
  dialog.show();
  /** @param {KeyboardEvent} e */
  const keys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const stops = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('button')]);
      const at = stops.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const next = stops[(at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length];
      e.preventDefault();
      next?.focus();
    }
  };
  addEventListener('keydown', keys, true);
  dialog.querySelector('button')?.focus(); // Cancel
  return () => {
    removeEventListener('keydown', keys, true);
    backdrop.remove();
    for (const el of behind) /** @type {HTMLElement} */ (el).inert = false;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
}
