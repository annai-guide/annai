import { VERSION, TABLE } from './lib.js';

/** A test plugin (milestone 8): a tool from two modules, so a relative import is part of the test. @param {any} annai */
export function activate(annai) {
  return annai.tools.register({
    name: 'tide_times',
    description: "Today's tides near the user.",
    input: { type: 'object', properties: {} },
    run: () => `Tides ${VERSION}: ${TABLE}`,
  });
}
