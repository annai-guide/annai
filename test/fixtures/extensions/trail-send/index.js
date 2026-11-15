/**
 * A test plugin (timeline stage 7): a card type whose own button sends a line into the open conversation, as a plugin's card may. In `me`'s read-only lines it
 * must not be mounted, so that button can't talk.
 * @param {any} annai
 */
export function activate(annai) {
  const off = annai.ui.cardType({
    type: 'trail-send', name: 'Trail send', description: 'A trail card with a button that asks Shiori about it.',
    schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    render: (/** @type {any} */ data, /** @type {HTMLElement} */ el, /** @type {any} */ ui) => {
      el.append(ui.h('button', { class: 'btn', type: 'button', onclick: () => ui.shiori.send(`Tell me about ${data.name}`) }, `Ask about ${data.name}`));
    },
  });
  return () => off();
}
