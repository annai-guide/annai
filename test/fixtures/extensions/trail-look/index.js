/**
 * A test plugin (milestone 8b): replaces three named components.
 * @param {any} annai
 */
export function activate(annai) {
  const offs = [
    annai.ui.component('avatar', {
      create: () => {
        const el = document.createElement('span');
        el.className = 'trail-avatar';
        el.textContent = '⛰';
        return { el, setState() {}, setLevel() {}, glance() {}, blink() {} };
      },
    }),
    annai.ui.component('now-card', { render: (/** @type {HTMLElement} */ el, /** @type {any} */ ui, /** @type {{ title: string }} */ now) => { el.append(ui.h('p', { text: `Trail Now card: ${now.title}` })); } }),
    annai.ui.component('dock', {
      create: (/** @type {any} */ ui) => ({ el: ui.h('nav', { class: 'dock', 'aria-label': 'Shiori' }, ui.h('button', { class: 'btn', type: 'button', onclick: () => ui.shiori.tap() }, 'Talk to Shiori')) }),
    }),
  ];
  return () => offs.forEach((off) => off());
}
