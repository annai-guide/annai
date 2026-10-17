import { VERSION, TABLE } from './lib.js';

/**
 * A test plugin (milestone 8): a tool and a status chip from two modules, so a relative import is
 * part of the test, and the chip says which version runs.
 * @param {any} annai
 */
export function activate(annai) {
  const offs = [
    annai.tools.register({
      name: 'tide_times',
      description: "Today's tides near the user.",
      input: { type: 'object', properties: {} },
      run: () => `Tides ${VERSION}: ${TABLE}`,
    }),
    annai.ui.slot('status-chip', { id: 'tide', render: (/** @type {HTMLElement} */ el) => { el.textContent = `Tide ${VERSION}`; } }),
  ];
  return () => offs.forEach((off) => off());
}
