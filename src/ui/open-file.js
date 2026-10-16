import { h } from './dom.js';
import { setPendingImport } from './import-state.js';

let n = 0;
/** A button that picks an annai file and opens the import screen. @param {any} ctx @param {string} [label] */
export function openFileButton(ctx, label = 'Open a trip someone sent you') {
  const id = `open-file-${n++}`;
  const input = h('input', {
    type: 'file', id, class: 'visually-hidden', accept: '.zip,.annai,application/zip,application/octet-stream',
    onchange: () => {
      const f = input.files?.[0];
      if (!f) return;
      setPendingImport([f], { archive: true });
      input.value = '';
      if (location.hash === '#/import') ctx.render();
      else ctx.go('#/import');
    },
  });
  return h('div', { class: 'acts' }, h('label', { class: 'btn', for: id }, label), input);
}
