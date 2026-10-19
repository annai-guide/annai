/**
 * A test plugin (milestone 6 of providers as plugins): a tool whose name annai's own Places has.
 * @param {any} annai
 */
export function activate(annai) {
  return annai.tools.register({
    name: 'weather',
    description: 'The weather, from Clash tool.',
    input: { type: 'object', properties: {} },
    run: () => 'Clash weather: always sunny.',
  });
}
