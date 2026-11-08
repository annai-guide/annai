import { h, t, overlayEntry } from './dom.js';
import { platform } from './platform.js';

let n = 0;
/** This page's own part of each question's id: an entry another page load left in the history is never taken for one of its. */
const page = Math.random().toString(36).slice(2, 8);

/**
 * A modal question with two answers (spec §4.9). Resolves true only for `yes`; Cancel, Escape and Back resolve false. Focus starts
 * on Cancel, so a stray Enter never confirms. Back closes it through CloseWatcher, else through a history entry, which an answer
 * takes back before it resolves. Without CloseWatcher on Android the dialog is not modal (openPlain): Chrome 113 swallows the first
 * Back for a modal dialog, so don't make it modal there.
 * @param {{ title: string, body: string, yes: string, no?: string }} q
 * @returns {Promise<boolean>}
 */
export function ask({ title, body, yes, no = t`Cancel` }) {
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
    const closeWatcher = 'CloseWatcher' in window;
    const modal = closeWatcher || platform() !== 'android';
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
    if (!closeWatcher) history.pushState(overlayEntry({ annaiAsk: id }), '');
    // Any move closes it, as Cancel, also with CloseWatcher: a Forward, a new address (which fires popstate too: a tapped reminder, Driving).
    addEventListener('popstate', back);
  });
}

/** The questions open without being modal, and the parts of the page they made inert. @type {{ n: number, behind: Element[] }} */
const open = { n: 0, behind: [] };

/**
 * Shows a dialog the way a modal looks, without being one: its own backdrop, everything else inert, Tab kept
 * inside, Escape closing it (as `close`). Gives what puts the page back, focus included.
 * @param {HTMLDialogElement} dialog @param {() => void} close @returns {() => void}
 */
function openPlain(dialog, close) {
  const opener = document.activeElement;
  const backdrop = h('div', { class: 'ask-backdrop' });
  document.body.append(backdrop);
  // The page is made inert by the first question open and given back by the last one closing.
  if (!open.n++) open.behind = [...document.body.children].filter((el) => el !== dialog && el !== backdrop && !(/** @type {HTMLElement} */ (el)).inert);
  for (const el of open.behind) /** @type {HTMLElement} */ (el).inert = true;
  dialog.classList.add('plain');
  dialog.setAttribute('aria-modal', 'true');
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
    if (!--open.n) for (const el of open.behind) /** @type {HTMLElement} */ (el).inert = false;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
}
