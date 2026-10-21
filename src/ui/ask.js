import { h } from './dom.js';

let n = 0;

/**
 * A modal question with two answers (spec §4.9). Resolves true only for `yes`; Cancel, Escape and
 * Back resolve false. Focus starts on Cancel, so a stray Enter never confirms. Where the browser
 * closes a modal dialog on Back itself (CloseWatcher, Chrome 120+), it does; elsewhere (Chrome 113,
 * Safari) opening adds a history entry, as the photo viewer does, and Back takes it. An answer takes
 * that entry back before it resolves, so what the answer does next, such as a new screen, stays.
 * @param {{ title: string, body: string, yes: string, no?: string }} q
 * @returns {Promise<boolean>}
 */
export function ask({ title, body, yes, no = 'Cancel' }) {
  const id = `ask-${n++}`;
  return new Promise((resolve) => {
    /** @type {HTMLDialogElement} */
    const dialog = h('dialog', { class: 'ask', 'aria-labelledby': id },
      h('h2', { class: 'section', id, text: title }),
      h('p', { text: body }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('no') }, no),
        h('button', { class: 'btn danger', type: 'button', onclick: () => dialog.close('yes') }, yes)));
    const back = () => dialog.close('no');
    dialog.addEventListener('close', () => {
      dialog.remove();
      removeEventListener('popstate', back);
      const done = () => resolve(dialog.returnValue === 'yes');
      if (history.state?.annaiAsk !== id) return done();
      addEventListener('popstate', done, { once: true });
      history.back();
    });
    document.body.append(dialog);
    dialog.showModal();
    if ('CloseWatcher' in window) return;
    history.pushState({ annaiAsk: id }, '');
    addEventListener('popstate', back);
  });
}
