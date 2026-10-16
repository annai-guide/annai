import { h } from './dom.js';

let n = 0;

/**
 * A modal question with two answers (spec §4.9). Resolves true only for `yes`; Cancel and
 * Escape resolve false. Focus starts on Cancel, so a stray Enter never confirms.
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
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'yes');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
